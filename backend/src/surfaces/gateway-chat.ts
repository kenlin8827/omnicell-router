import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { dispatchSurface } from './dispatch.js';
import { chatSurface } from './chat.js';
import type { ModelAccessGate, TransportContext } from './types.js';
import type { GatewayChatSink } from '../plugins/types.js';
import { TIER_LADDER } from '../providers/virtual-meta.js';
import { loadConfig } from '../config/index.js';
import type { ApiKeyConfig } from '../config/types.js';
import { checkModelAccess, getModelAccessPolicy } from '../auth/model-access.js';
import { isApiKeyUsable } from '../auth/api-keys.js';
import { apiKeySubject, getRateLimiter } from '../ratelimit/rate-limiter.js';
import { recordRateLimitEvent } from '../ratelimit/event-log.js';

/**
 * In-process chat seam for client-gateway plugins (ADR-0017).
 *
 * `startForwardProxy` wires the services once with the live orchestrator; a
 * gateway then runs ONE canonical OpenAI-shaped completion through the SAME
 * `dispatchSurface` pipeline as /v1/chat/completions — model resolution,
 * tiers, breakers, captures all apply — and receives exactly the SSE frames
 * the /v1 wire would have written. The transport below is the third
 * implementation of the frozen TransportContext terminal-send discipline
 * (Fastify shim, node-http, now callback sink).
 *
 * Key binding (ADR-0017 §4): OCR-routed turns REQUIRE an identity — the
 * CONNECT credential of the tunnel, else the plugin's console-picked
 * `accountKeyId`. With neither, the turn is refused with 401: proxy admission
 * is transport, model usage is keyed. When a key is present its inbound
 * `apiKeys[].limits` are consumed, `modelAccess` gates the requested model, and
 * usage/capture attribute to it. Vendor-native requests are relayed
 * byte-verbatim and never enter this seam, so passthrough keeps working with
 * no key at all.
 *
 * Capture: gateway-driven completions have no client request object, so
 * `captureProcessContext()` returns only the bound key identity — the chat
 * pipeline records the turn with key attribution but no synthetic HTTP leg.
 */

export interface GatewayChatRunOptions {
  /** Console-picked `apiKeys[].id` the OCR-routed turn is charged to. */
  keyId?: string;
}

export interface GatewayChatServices {
  /** One canonical chat completion; terminal discipline via the sink. */
  run(
    body: Record<string, unknown>,
    sink: GatewayChatSink,
    signal: AbortSignal | undefined,
    opts?: GatewayChatRunOptions
  ): Promise<void>;
  /** Current routing surface for AvailableModels-style fabrication. */
  catalog(): { tiers: string[]; models: { id: string; label?: string }[] };
}

let services: GatewayChatServices | undefined;

/** Wired once by forward-proxy/index.ts (it holds the orchestrator). */
export function setGatewayChatServices(s: GatewayChatServices | undefined): void {
  services = s;
}

/** Lookup for the plugin-host SDK (undefined = core not booted yet). */
export function getGatewayChatServices(): GatewayChatServices | undefined {
  return services;
}

/** Resolve a console-bound `apiKeys[].id` to its live config. */
export type GatewayKeyResolver = (keyId: string) => ApiKeyConfig | undefined;

const lookupConfiguredKey: GatewayKeyResolver = (id) =>
  (loadConfig().apiKeys ?? []).find((k) => k.id === id);

/** Bound key config, or undefined when the id is absent/unknown/disabled/expired. */
export function resolveGatewayKey(
  keyId: string | undefined,
  lookup: GatewayKeyResolver = lookupConfiguredKey
): ApiKeyConfig | undefined {
  const id = keyId?.trim();
  if (!id) return undefined;
  const key = lookup(id);
  return key && isApiKeyUsable(key) ? key : undefined;
}

/** Build the services over an orchestrator: dispatch + callback transport. */
export function buildGatewayChatServices(
  orchestrator: PipelineOrchestrator,
  resolveKey: GatewayKeyResolver = lookupConfiguredKey
): GatewayChatServices {
  return {
    catalog: () => ({
      // Canonical display order: auto spans the TIER_LADDER escalation rungs.
      tiers: ['auto', ...TIER_LADDER],
      models: orchestrator
        .getRegistry()
        .getAllModels()
        .map((m) => ({ id: m.id, label: m.upstreamModel })),
    }),
    run: async (body, sink, signal, opts) => {
      const boundKeyId = opts?.keyId?.trim() ?? '';
      const key = resolveGatewayKey(boundKeyId, resolveKey);
      if (!key) {
        // No identity = no OCR routing. Vendor-native requests never reach this
        // seam, so passthrough keeps working without a key; only our own
        // inference is refused. This is the policy split: proxy admission is
        // transport, model usage is keyed.
        sink.onJson(401, {
          error: {
            message: boundKeyId
              ? `Bound API key '${boundKeyId}' is missing, disabled or expired — pick a valid key in Client Hub`
              : 'OCR routing requires an API key: send one as the forward-proxy credential or bind one in Client Hub',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        });
        return;
      }

      // Promise.withResolvers is unavailable on the backend tsconfig lib.
      let resume: (() => void) | undefined;
      const finished = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let terminaled = false;
      const subject = apiKeySubject(key.id);
      let tokenEstimate = 0;
      const releaseReservation = (): void => {
        if (subject && tokenEstimate > 0) getRateLimiter().releaseEstimate(subject, tokenEstimate);
      };
      const terminal = (fn: () => void): void => {
        if (terminaled) return;
        terminaled = true;
        releaseReservation();
        fn();
        resume?.();
      };

      // Inbound admission, the same contract the Fastify auth gate enforces
      // (apiKeys[].limits): ONE request slot per admitted turn, plus the
      // chars/4 token pre-reservation released at the terminal.
      {
        let estimate = 0;
        try {
          estimate = Math.ceil(JSON.stringify(body).length / 4);
        } catch {
          estimate = 0; // estimation must never gate a request by itself failing
        }
        const rl = getRateLimiter();
        const verdict =
          estimate > 0 ? rl.tryDispatchWithEstimate(subject, estimate) : rl.tryDispatch(subject);
        if (!verdict.allowed) {
          const retryAfterSec = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
          recordRateLimitEvent({
            direction: 'inbound',
            kind: 'denied',
            subject,
            rule: verdict.rule,
            limitedBy: verdict.limitedBy,
            retryAfterMs: verdict.retryAfterMs,
            apiKeyName: key.name,
            note: 'gateway-routed turn',
          });
          sink.onJson(
            429,
            {
              error: {
                message: `Rate limit exceeded (${verdict.rule}); retry after ${retryAfterSec}s`,
                type: 'rate_limit_error',
                code: 'rate_limit_exceeded',
                param: verdict.limitedBy,
              },
            },
            {
              'retry-after': String(retryAfterSec),
              'ratelimit-limit': String(verdict.limit),
              'ratelimit-remaining': '0',
              'ratelimit-reset': String(retryAfterSec),
            }
          );
          return;
        }
        tokenEstimate = estimate;
      }

      const access: ModelAccessGate = {
        kind: 'key',
        keyName: key.name,
        policy: getModelAccessPolicy(key),
        enforce: (requestedModel: string) => {
          const verdict = checkModelAccess(orchestrator.getRegistry(), key, requestedModel);
          if (verdict.ok) return true;
          terminal(() =>
            sink.onJson(403, {
              error: {
                message: verdict.message,
                type: 'invalid_request_error',
                code: 'model_not_allowed',
              },
            })
          );
          return false;
        },
      };

      const t: TransportContext = {
        method: 'POST',
        url: '/gateway-chat',
        headers: {},
        clientIp: undefined,
        access,
        captureProcessContext: () => (key ? { clientKey: { id: key.id, name: key.name } } : {}),
        sendJson: (status, payload, headers) =>
          terminal(() => {
            try {
              sink.onJson(status, payload, headers);
            } catch {
              // A gateway sinking the terminal answer must not break the pipeline.
            }
          }),
        // Verbatim origin relay (the `direct` unresolved-model executor): keep
        // the bytes protocol-faithful for the gateway — SSE bodies flow through
        // the chunk path unchanged, anything else surfaces as a JSON terminal.
        relayUpstream: (up) => {
          const isSse = String(up.headers['content-type'] ?? '').includes('text/event-stream');
          if (!isSse) {
            const chunks: Buffer[] = [];
            up.stream.on('data', (c: Buffer) => chunks.push(c));
            up.stream.on('end', () =>
              terminal(() => {
                try {
                  sink.onJson(up.statusCode, { gatewayRelayBody: Buffer.concat(chunks).toString('utf8') });
                } catch {}
              })
            );
            up.stream.on('error', () => terminal(() => sink.onJson(502, { error: { message: 'Upstream relay failed' } })));
            return;
          }
          up.stream.on('data', (c: Buffer) => {
            try {
              sink.onChunk(c.toString('utf8'));
            } catch {}
          });
          up.stream.on('end', () => terminal(() => sink.onEnd()));
          up.stream.on('error', () => terminal(() => sink.onEnd()));
        },
        beginSse: () => {
          // Gateway sink owns the wire; headers are a no-op here.
        },
        writeSseChunk: (chunk) => {
          try {
            sink.onChunk(chunk);
          } catch {}
        },
        endSse: () => terminal(() => sink.onEnd()),
        isClientGone: () => signal?.aborted === true,
        logError: (err, message) => {
          console.error(`[OCR] gateway-chat: ${message}`, err instanceof Error ? err.message : String(err));
        },
      };
      // dispatchSurface never throws past terminal sends (pipeline's own catch);
      // a pre-terminal throw lands here → single JSON error terminal.
      try {
        await dispatchSurface(t, chatSurface, orchestrator, body);
      } catch {
        terminal(() => sink.onJson(500, { error: { message: 'Internal Router Error', type: 'api_error' } }));
      }
      return finished;
    },
  };
}

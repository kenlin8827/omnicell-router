import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { dispatchSurface } from './dispatch.js';
import { chatSurface } from './chat.js';
import type { TransportContext } from './types.js';
import type { GatewayChatSink } from '../plugins/types.js';
import { TIER_LADDER } from '../providers/virtual-meta.js';

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
 * Capture: gateway-driven completions have no client request object, so
 * `captureProcessContext()` answers {} (the chat pipeline treats that as
 * capture-disabled, same as capture=false surfaces).
 */

export interface GatewayChatServices {
  /** One canonical chat completion; terminal discipline via the sink. */
  run(body: Record<string, unknown>, sink: GatewayChatSink, signal: AbortSignal | undefined): Promise<void>;
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

/** Build the services over an orchestrator: dispatch + callback transport. */
export function buildGatewayChatServices(orchestrator: PipelineOrchestrator): GatewayChatServices {
  return {
    catalog: () => ({
      // Canonical display order: auto spans the TIER_LADDER escalation rungs.
      tiers: ['auto', ...TIER_LADDER],
      models: orchestrator
        .getRegistry()
        .getAllModels()
        .map((m) => ({ id: m.id, label: m.upstreamModel })),
    }),
    run: async (body, sink, signal) => {
      // Promise.withResolvers is unavailable on the backend tsconfig lib.
      let resume: (() => void) | undefined;
      const finished = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let terminaled = false;
      const terminal = (fn: () => void): void => {
        if (terminaled) return;
        terminaled = true;
        fn();
        resume?.();
      };
      const t: TransportContext = {
        method: 'POST',
        url: '/gateway-chat',
        headers: {},
        clientIp: undefined,
        access: { kind: 'exempt', keyName: '', policy: undefined, enforce: () => true },
        captureProcessContext: () => ({}),
        sendJson: (status, payload) =>
          terminal(() => {
            try {
              sink.onJson(status, payload);
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
          console.error(`[OCR] gateway-chat: ${message}`, err instanceof Error ? err.message : err);
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

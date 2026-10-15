import type { ModelAccessConfig } from '../config/types.js';
import type { ProcessContext } from '../pipeline/orchestrator.js';
import type { ChatCompletionRequest } from '../types/openai.js';
import type { ExecutionResult } from '../types/router.js';

/**
 * Frozen protocol-surface type contract (architect deliverable, 2026-10-12).
 * This file defines the SHARED vocabulary of the surfaces/ domain; the step
 * sequence implements against it without re-deriving it. If a step needs a
 * shape not described here, that is a contract conflict — stop and report it,
 * do not widen the types locally.
 */

/**
 * Per-transport model-access gate. Discriminated union on `kind`:
 * - 'key'     — authenticated entry (Fastify routes): `enforce` is
 *               makeModelAccessGuard(registry)(req, reply, model); a denial
 *               has ALREADY been written as a 403 by the guard, callers only
 *               check the boolean and must NOT send another response.
 * - 'exempt'  — POLICY EXEMPTION (MITM forward-proxy leg): the tunnel peer is
 *               authenticated by the CONNECT/TLS layer, not an API key, so
 *               every model passes and the capture's inbound request headers
 *               carry no key identity. `keyName`/`policy` pin the empty view
 *               as LITERAL types so consumers can never accidentally get a
 *               writable string/optional.
 * NOTE: 'exempt' entered the union together with the frozen 'key' member —
 * the union was defined whole up front precisely so the node-http (MITM)
 * transport never re-derives a divergent exemption shape.
 */
export type ModelAccessGate =
  | {
      kind: 'key';
      keyName: string;
      policy: ModelAccessConfig | undefined;
      enforce(requestedModel: string): boolean;
    }
  | {
      kind: 'exempt';
      keyName: '';
      policy: undefined;
      enforce(requestedModel: string): true;
    };

/**
 * Transport-facing request/response context shared by every protocol
 * surface. The pipeline talks ONLY to this interface — Fastify reply and
 * node-http req/res are two implementations of the same terminal discipline.
 *
 * TERMINAL-SEND DISCIPLINE: exactly one sendJson OR one
 * beginSse → writeSseChunk* → endSse per request. Inside both terminal
 * points the adapter: (1) stashes the body into the capture exchange (when
 * one exists), (2) synchronously finalizes the gateway-response event —
 * live socket = real status code, isClientGone() = synthetic 499 (nginx
 * convention), behind the isEnabled gate + `responded` dedup. BOTH adapters
 * use the explicit finalize-inside-the-terminal form — the early Fastify
 * facade (stash/finalize living in server-level capture hooks) was replaced.
 */
export interface TransportContext {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly clientIp: string | undefined;
  readonly access: ModelAccessGate;
  /** Capture-only ProcessContext fields (node-http transport answers {} for capture=false surfaces). */
  captureProcessContext(): Pick<ProcessContext, 'fastifyRequest' | 'clientRequest' | 'onClientExchange'>;
  sendJson(status: number, payload: unknown, headers?: Record<string, string>): void;
  beginSse(headers: Record<string, string>): void;
  writeSseChunk(chunk: string): void;
  endSse(): void;
  /**
   * Client-abort detection. Bun never fires req 'res''close'/'aborted'
   * reliably after the body is read (forward-proxy.test.ts:360 documents the
   * verified runtime behavior) — adapters combine their own close-flag with
   * the socket's destroyed state; the pipeline uses this only as a fallback
   * signal, the terminal send itself is what finalizes capture.
   */
  isClientGone(): boolean;
  logError(err: unknown, message: string): void;
}

/** Parse outcome: exactly one of `request` (valid) or `error` (400 message) is set. */
export interface SurfaceParseResult {
  request?: ChatCompletionRequest;
  error?: string;
  state?: unknown;
}

/**
 * Inference-protocol surface (chat / anthropic / responses wires). `capture`
 * is a PROTOCOL-LEVEL POLICY encoded as a literal type, not a runtime flag:
 * surfaces that carry no client-request capture path make it structurally
 * impossible to hand the orchestrator a FastifyRequest-shaped context.
 */
export interface ChatSurface {
  readonly wire: 'chat' | 'anthropic' | 'responses';
  readonly exec: 'chat-pipeline';
  readonly capture: true;
  readonly routePath: string;
  readonly detectSuffix: string;
  /** The `model` field stays client-sent verbatim — resolution authority is the orchestrator's fork. */
  parse(body: unknown): SurfaceParseResult;
  encodeJson(result: ExecutionResult, state: unknown): unknown;
  encodeStream(result: ExecutionResult, state: unknown): string[];
  /** Runs BEFORE the first response byte (responses wire: RespStore.append). */
  afterResult?(result: ExecutionResult, state: unknown): void;
  errorBody(status: number, message: string, code?: string): unknown;
  executionError(err: unknown): { status: number; body: unknown };
}

/**
 * Decision-protocol surface (/v1/systemone): single-shot JSON, capture
 * configurable. `capture: 'configurable'` keeps the
 * protocol-level literal encoding — the pipeline only emits when
 * `requestCapture.enabled` AND `requestCapture.systemone.enabled` (the
 * System One surface master — off silences BOTH legs) are
 * true (master default OFF), and emission lives after
 * every gate. A captured surface request is FULL-CHAIN: client exchange
 * plus the upstream leg (native passthrough / synthesized conversion call,
 * no purpose tag — unambiguous within its own turn). FinOps/trace stay
 * excluded; the default-off path is
 * pinned zero-event by forward-proxy-systemone.test.ts.
 */
export interface DecisionSurface {
  readonly wire: 'systemone';
  readonly exec: 'decision-pipeline';
  readonly capture: 'configurable';
  readonly routePath: '/v1/systemone';
  /** Wider than routePath on purpose — MITM path detection stays tiered. */
  readonly detectSuffix: '/systemone';
  errorBody(status: number, message: string, code?: string): unknown;
}

export type ProtocolSurface = ChatSurface | DecisionSurface;

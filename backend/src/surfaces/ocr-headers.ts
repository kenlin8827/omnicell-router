import type { ExecutionResult } from '../types/router.js';
import { buildOcrSummaryFrame } from '../utils/chat-sse.js';
import type { StreamRoutingFacts } from '../utils/stream-relay.js';

/**
 * Single sink for the X-OCR response headers on every protocol surface.
 *
 * Before this existed, each surface hand-built its own header block: the
 * Fastify chat/anthropic legs staged ~15 headers, the responses leg only 6,
 * and the MITM interceptor 5 — a drift that let the observability contract
 * silently diverge per wire. These two builders are the one authority; the
 * header SET is uniform, transports decide only how a record reaches the
 * wire (staged reply.header loop for non-stream, writeHead spread for SSE).
 *
 * NOTE on the `?? / ||` defaults: they are FROZEN contract, not style.
 * Test stubs (forward-proxy.test.ts and friends) return partial
 * ExecutionResults, and the builder must apply safe defaults instead of
 * throwing on missing optionals (contract §1.4, risk R-4).
 */

/**
 * The 14 base X-OCR headers plus conditionals for a chat-shaped execution
 * result (chat / anthropic / responses wires share this exact set). ADR-0021:
 * `X-OCR-Request-ID` names THIS request (the console row); the caller's own
 * correlation value is never echoed back. `X-OCR-Protocol` names the OUTBOUND
 * protocol id the served attempt spoke (the inbound surface is the URL the
 * client called — a converted turn carries two different values).
 *
 * Conditional additions:
 * - X-OCR-TTFT-MS / X-OCR-Gen-MS: only when the committed attempt streamed.
 *   They expose the gateway-measured TTFT (process start → first forwarded
 *   chunk) and decode window (first chunk → stream end) so a client can
 *   compute the same decode-TPS the console shows. Buffered turns omit both.
 * - X-OCR-Thinking-{Requested,Actual,Degraded}: only when the client asked
 *   for reasoning effort (`requestedEffort` set and not 'none'). Lets the
 *   caller verify whether they got the level requested or were silently
 *   downgraded. The same record goes to non-stream and SSE wires, so the
 *   Thinking-* headers reach the stream too (unlike the pre-builder code,
 *   where the SSE spread omitted them).
 * - X-OCR-Thinking-Source (ADR-0012): alongside the Thinking-* block when
 *   the ask's author is known — 'client' or a gateway decision.
 * - X-OCR-Upstream-Stream: always present (`sse` | `buffered`) — the provider
 *   leg's transport, the OUTBOUND stream tag. The inbound tag is the response
 *   shape itself (SSE vs JSON); the console reads both from the trace/capture
 *   planes.
 * - X-OCR-Variant: only when a sibling / `#variant` id was resolved.
 * - X-OCR-Tool-Markup-Leak (ADR-0034): markup that remained text because it was
 *   outside the scoped recovery path or failed its completeness/schema gates.
 * - X-OCR-Recovered-Tool-Calls: complete calls recovered by the scoped repair.
 *
 * @param fallbackModel gate model of the surface (requested model name), used
 *   when the orchestrator reported no `modelUsed` (C-4: modelUsed || gate || 'auto').
 */
export function buildChatOcrHeaders(result: ExecutionResult, fallbackModel: string): Record<string, string> {
  const headers: Record<string, string> = {
    'X-OCR-Tier': `${result.tierUsed ?? ''}${result.fallbackOccurred ? '-escalated' : ''}`,
    'X-OCR-Layer': result.layerUsed || 'layer0',
    'X-OCR-Model': result.modelUsed || fallbackModel || 'auto',
    'X-OCR-Protocol': result.protocolUsed || '',
    'X-OCR-Failover': result.failoverOccurred ? 'true' : 'false',
    'X-OCR-Failover-Attempts': (result.failoverAttempts || 1).toString(),
    'X-OCR-Failover-Path': result.failoverPath?.join(' -> ') || '',
    'X-OCR-InPlace-Retries': (result.inplaceRetries || 0).toString(),
    'X-OCR-Breaker-State': result.breakerState || 'CLOSED',
    'X-OCR-Session-ID': result.sessionId || '',
    'X-OCR-Session-Ratchet': result.sessionRatchetApplied ? 'true' : 'false',
    'X-OCR-Session-Lookup': result.sessionLookupType || '',
    'X-OCR-Request-ID': result.requestId || '',
    'X-OCR-Latency-MS': (result.latencyMs ?? 0).toString(),
    // Stream tags (ADR-0008 §1). OUTBOUND: which transport the provider leg
    // actually used. 'sse' next to a JSON body IS the answer to "why is a
    // non-streaming request slow?" — the gateway drained a stream and the
    // client's latency is the whole generation either way.
    'X-OCR-Upstream-Stream': result.upstreamStream ?? 'buffered',
  };
  // TTFT/TPS split: emitted ONLY when the committed attempt actually streamed.
  // A buffered turn has no decode window, so both keys stay absent and a client
  // (the playground, a capture tool) renders '—' instead of a synthetic rate.
  if (result.ttftMs !== undefined) headers['X-OCR-TTFT-MS'] = result.ttftMs.toString();
  if (result.genMs !== undefined) headers['X-OCR-Gen-MS'] = result.genMs.toString();
  if (result.requestedEffort && result.requestedEffort !== 'none') {
    headers['X-OCR-Thinking-Requested'] = result.requestedEffort;
    headers['X-OCR-Thinking-Actual'] = result.actualEffort ?? result.requestedEffort;
    headers['X-OCR-Thinking-Degraded'] = result.reasoningDegraded ? 'true' : 'false';
    // ADR-0012: WHO authored the ask — 'client' or a gateway decision
    // (decision layer / entry / @ocr directive / default). Emitted only when known;
    // pre-ADR executions simply omit it.
    if (result.effortSource) headers['X-OCR-Thinking-Source'] = result.effortSource;
  }
  if (result.variantUsed) {
    headers['X-OCR-Variant'] = result.variantUsed;
  }
  // Recovery and residual leakage are separate facts: a repaired call is
  // visible, and malformed/unscoped markup still names the broken endpoint.
  const leaked = result.response?.toolMarkupLeak;
  if (leaked) headers['X-OCR-Tool-Markup-Leak'] = leaked.calls.toString();
  const recovered = result.response?.toolTextRecovery;
  if (recovered) headers['X-OCR-Recovered-Tool-Calls'] = recovered.calls.toString();
  return headers;
}

/**
 * Routing-time X-OCR header block for a streamed turn — see
 * `StreamRoutingFacts` in utils/stream-relay (every field is decidable before a
 * single upstream byte exists).
 *
 * Deliberately NOT `buildChatOcrHeaders` with defaults: SSE headers flush with
 * the first byte, while failover counts, in-place retries, breaker state, total
 * latency and the served thinking level describe a turn that has not finished.
 * Sending their buffered-path defaults (`Latency-MS: 0`, `Failover: false`)
 * would assert facts the gateway does not have yet, so those keys are simply
 * absent here and ride the trailing `ocr-summary` frame instead.
 */
export function buildChatOcrRoutingHeaders(
  facts: StreamRoutingFacts,
  fallbackModel: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-OCR-Tier': facts.tierUsed ?? '',
    'X-OCR-Layer': facts.layerUsed || 'layer0',
    'X-OCR-Model': facts.modelUsed || fallbackModel || 'auto',
    'X-OCR-Protocol': facts.protocolUsed || '',
    'X-OCR-Session-ID': facts.sessionId || '',
    'X-OCR-Session-Ratchet': facts.sessionRatchetApplied ? 'true' : 'false',
    'X-OCR-Session-Lookup': facts.sessionLookupType || '',
    'X-OCR-Request-ID': facts.requestId || '',
  };
  if (facts.requestedEffort && facts.requestedEffort !== 'none') {
    // The REQUEST half of the thinking pair is a client fact (known now); the
    // ACTUAL / DEGRADED half belongs to the completion summary.
    headers['X-OCR-Thinking-Requested'] = facts.requestedEffort;
  }
  if (facts.variantUsed) headers['X-OCR-Variant'] = facts.variantUsed;
  return headers;
}

/**
 * Completion-time X-OCR facts for a streamed turn, carried in a trailing SSE
 * comment frame (HTTP trailers are not readable by browser/`fetch` clients, and
 * inventing a `data:` frame would break strict chunk parsers).
 *
 * Same names as the buffered headers, so a client that wants them can parse the
 * `ocr-summary` comment; the buffered path keeps sending them as headers.
 */
export function buildChatOcrCompletionFacts(result: ExecutionResult): Record<string, string> {
  const all = buildChatOcrHeaders(result, result.modelUsed || 'auto');
  const routing = buildChatOcrRoutingHeaders(result, result.modelUsed || 'auto');
  const completion: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (!(k in routing) || routing[k] !== v) completion[k] = v;
  }
  return completion;
}

/** The one trailing comment every chat-shaped stream owes its client.
 *  Chat places it before `[DONE]`; Anthropic and Responses place it after
 *  their own terminal event. A comment is not an event, so strict parsers
 *  still stop on `message_stop` / `response.completed`, while a reader that
 *  drains the body (the playground) can compute tok/s from `X-OCR-Gen-MS`. */
export function buildChatOcrSummaryFrame(result: ExecutionResult): string {
  return buildOcrSummaryFrame(buildChatOcrCompletionFacts(result));
}

/**
 * The decision-surface (/v1/systemone) header set: exactly three headers.
 * Kept as its own builder on purpose — the decision wire has no session,
 * failover, or cost semantics to report, and widening it would be a
 * behavior change, not a refactor.
 */
export function buildSystemoneOcrHeaders(
  modelId: string,
  /** Which limb served: 'native' (wire 'systemone' passthrough) or 'converted'. */
  upstreamKind: 'converted' | 'native',
  latencyMs: number
): Record<string, string> {
  return {
    'X-OCR-Model': modelId,
    'X-OCR-Systemone-Upstream': upstreamKind,
    'X-OCR-Latency-MS': latencyMs.toString(),
  };
}

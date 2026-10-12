import type { ExecutionResult } from '../types/router.js';

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
 * The 13 base X-OCR headers plus conditionals for a chat-shaped execution
 * result (chat / anthropic / responses wires share this exact set).
 *
 * Conditional additions:
 * - X-OCR-Thinking-{Requested,Actual,Degraded}: only when the client asked
 *   for reasoning effort (`requestedEffort` set and not 'none'). Lets the
 *   caller verify whether they got the level requested or were silently
 *   downgraded. The same record goes to non-stream and SSE wires, so the
 *   Thinking-* headers reach the stream too (unlike the pre-builder code,
 *   where the SSE spread omitted them).
 * - X-OCR-Variant: only when a sibling / `#variant` id was resolved.
 *
 * @param fallbackModel gate model of the surface (requested model name), used
 *   when the orchestrator reported no `modelUsed` (C-4: modelUsed || gate || 'auto').
 */
export function buildChatOcrHeaders(result: ExecutionResult, fallbackModel: string): Record<string, string> {
  const headers: Record<string, string> = {
    'X-OCR-Tier': `${result.tierUsed ?? ''}${result.fallbackOccurred ? '-escalated' : ''}`,
    'X-OCR-Layer': result.layerUsed || 'layer0',
    'X-OCR-Model': result.modelUsed || fallbackModel || 'auto',
    'X-OCR-Failover': result.failoverOccurred ? 'true' : 'false',
    'X-OCR-Failover-Attempts': (result.failoverAttempts || 1).toString(),
    'X-OCR-Failover-Path': result.failoverPath?.join(' -> ') || '',
    'X-OCR-InPlace-Retries': (result.inplaceRetries || 0).toString(),
    'X-OCR-Breaker-State': result.breakerState || 'CLOSED',
    'X-OCR-Session-ID': result.sessionId || '',
    'X-OCR-Session-Ratchet': result.sessionRatchetApplied ? 'true' : 'false',
    'X-OCR-Session-Lookup': result.sessionLookupType || '',
    'X-OCR-Trace-ID': result.traceId || '',
    'X-OCR-Latency-MS': (result.latencyMs ?? 0).toString(),
  };
  if (result.requestedEffort && result.requestedEffort !== 'none') {
    headers['X-OCR-Thinking-Requested'] = result.requestedEffort;
    headers['X-OCR-Thinking-Actual'] = result.actualEffort ?? result.requestedEffort;
    headers['X-OCR-Thinking-Degraded'] = result.reasoningDegraded ? 'true' : 'false';
  }
  if (result.variantUsed) {
    headers['X-OCR-Variant'] = result.variantUsed;
  }
  return headers;
}

/**
 * The decision-surface (/v1/systemone) header set: exactly three headers.
 * Kept as its own builder on purpose — the decision wire has no session,
 * failover, or cost semantics to report, and widening it would be a
 * behavior change, not a refactor.
 */
export function buildSystemoneOcrHeaders(
  modelId: string,
  upstreamKind: 'native' | 'converted',
  latencyMs: number
): Record<string, string> {
  return {
    'X-OCR-Model': modelId,
    'X-OCR-Systemone-Upstream': upstreamKind,
    'X-OCR-Latency-MS': latencyMs.toString(),
  };
}

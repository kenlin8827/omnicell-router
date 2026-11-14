import type { CaptureKeyIdentity, CaptureRecorder, CaptureEvent } from '../capture/recorder.js';
import { emitUpstreamRequest, emitUpstreamResponse } from './http-exchange.js';
import type { TurnIdentity } from '../capture/turn-boundary.js';

/**
 * Event-stream upstream context shared by the provider adapters. The shape
 * is intentionally minimal — the orchestrator fills it once, and the
 * adapter passes it to every `emitUpstreamRequest` / `emitUpstreamResponse`
 * call. Centralizing the field names here keeps the 5 provider adapters
 * from each spelling out the same boilerplate.
 */
export interface UpstreamEventContext {
  sessionId: string;
  /** Caller correlation value, when it sent one (see CaptureEvent). */
  clientRequestId?: string;
  /** Gateway turn id (ADR-0021) — the capture turn-join key. */
  requestId: string;
  model: string;
  recorder: CaptureRecorder;
  /**
   * Client API-key identity of the owning turn, forwarded onto every event
   * emitted through this context so the upstream leg is attributable to the
   * same application as the client leg. Undefined for key-less legs (MITM
   * tunnel, master-key access) — events then simply omit the field.
   */
  apiKey?: CaptureKeyIdentity;
  /**
   * Deterministic conversation key of the owning turn (content-addressed,
   * see CaptureEvent.conversationKey) forwarded onto every event emitted
   * through this context.
   */
  conversationKey?: string;
  /**
   * Non-default call label forwarded onto every event emitted through this
   * context. The Layer 2 decision layer's decision-model leg carries 'l2-decision' so
   * the archive can tell it apart from candidate-execution events sharing the
   * SAME requestId/sessionId (the outer request's identity).
   */
  purpose?: CaptureEvent['purpose'];
  /** Write-time turn identity, allocated once at the admission gate and
   *  copied onto every event of this request. */
  turn?: TurnIdentity;
}

/** Returns the exchangeId minted by `emitUpstreamRequest`, or undefined when the context is absent (capture off / mock mode / tests). */
export function emitUpstreamRequestOnce(
  ctx: UpstreamEventContext | undefined,
  args: {
    url: string;
    method: string;
    requestHeaders: Record<string, string>;
    requestBody: string;
    /** Actual upstream model on the wire (defaults to ctx.model = the client-requested model). */
    model?: string;
    /** Raw proxy URL when routed via proxy (redacted to origin at emit). */
    proxy?: string;
  }
): string | undefined {
  if (!ctx) return undefined;
  return emitUpstreamRequest({
    recorder: ctx.recorder,
    url: args.url,
    method: args.method,
    requestHeaders: args.requestHeaders,
    requestBody: args.requestBody,
    sessionId: ctx.sessionId,
    clientRequestId: ctx.clientRequestId,
    requestId: ctx.requestId,
    model: args.model ?? ctx.model,
    proxy: args.proxy,
    purpose: ctx.purpose,
    turn: ctx.turn,
    apiKey: ctx.apiKey,
    conversationKey: ctx.conversationKey,
  });
}

/** Emit a SUCCESS upstream response event. */
export function emitUpstreamResponseOnce(
  ctx: UpstreamEventContext | undefined,
  args: {
    exchangeId: string | undefined;
    url: string;
    method: string;
    status: number;
    statusText: string;
    responseHeaders: Headers;
    responseBody: string;
    /** Epoch ms of the first streamed body chunk (streamed exchanges only). */
    firstByteTs?: number;
    model?: string;
  }
): void {
  if (!ctx || !args.exchangeId) return;
  emitUpstreamResponse({
    recorder: ctx.recorder,
    url: args.url,
    method: args.method,
    status: args.status,
    statusText: args.statusText,
    responseHeaders: args.responseHeaders,
    responseBody: args.responseBody,
    firstByteTs: args.firstByteTs,
    sessionId: ctx.sessionId,
    clientRequestId: ctx.clientRequestId,
    requestId: ctx.requestId,
    model: args.model ?? ctx.model,
    exchangeId: args.exchangeId,
    purpose: ctx.purpose,
    turn: ctx.turn,
    apiKey: ctx.apiKey,
    conversationKey: ctx.conversationKey,
  });
}

/**
 * Emit an upstream FAILURE response event. Always pairs with the request
 * event fired earlier so console readers don't see dangling request
 * events that never resolve. Status is reported as the upstream's HTTP
 * status when known, else `0` (network / DNS / TLS / timeout).
 */
export function emitUpstreamFailureOnce(
  ctx: UpstreamEventContext | undefined,
  args: {
    exchangeId: string | undefined;
    url: string;
    method: string;
    status: number;
    statusText: string;
    responseHeaders?: Headers;
    responseBody?: string;
    /** Epoch ms of the first streamed body chunk (a stream that died mid-body still carries it). */
    firstByteTs?: number;
    error: string;
    model?: string;
  }
): void {
  if (!ctx || !args.exchangeId) return;
  emitUpstreamResponse({
    recorder: ctx.recorder,
    url: args.url,
    method: args.method,
    status: args.status,
    statusText: args.statusText,
    responseHeaders: args.responseHeaders ?? new Headers(),
    responseBody: args.responseBody ?? '',
    firstByteTs: args.firstByteTs,
    sessionId: ctx.sessionId,
    clientRequestId: ctx.clientRequestId,
    requestId: ctx.requestId,
    model: args.model ?? ctx.model,
    exchangeId: args.exchangeId,
    error: args.error,
    purpose: ctx.purpose,
    turn: ctx.turn,
    apiKey: ctx.apiKey,
    conversationKey: ctx.conversationKey,
  });
}

/**
 * Wrap a provider fetch+parse in a try/catch that guarantees a response
 * event fires for every request event, even when the fetch itself throws
 * (DNS failure, TLS handshake, TCP reset, abort). The thrown error is
 * re-thrown after emitting so the orchestrator's retry / failover logic
 * still runs unchanged — only the capture pipeline is given a complete
 * req/resp pair.
 */
export async function withUpstreamFailureGuard<T>(
  ctx: UpstreamEventContext | undefined,
  exchangeId: string | undefined,
  url: string,
  method: string,
  fn: () => Promise<T>,
  model?: string
): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const status = typeof err?.status === 'number' ? err.status : 0;
    emitUpstreamFailureOnce(ctx, {
      exchangeId,
      url,
      method,
      status,
      statusText: typeof err?.statusText === 'string' ? err.statusText : (status === 0 ? 'NETWORK_ERROR' : ''),
      error: typeof err?.message === 'string' ? err.message : String(err),
      model,
    });
    throw err;
  }
}
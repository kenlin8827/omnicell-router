import type { CaptureKeyIdentity, CaptureRecorder, CaptureEvent } from '../capture/recorder.js';
import { emitUpstreamRequest, emitUpstreamResponse } from './http-exchange.js';
import type { TurnIdentity } from '../capture/turn-boundary.js';

/**
 * Archive handle for one recorded upstream call. Built only while request
 * capture is on. The conversation id lives in `#sessionId` and is copied
 * onto archive lines by the methods below. It is not a field. A value that
 * is not an instance of this class writes nothing. Executors that need the
 * live conversation take it as their own argument.
 */
export class UpstreamEventContext {
  readonly #sessionId: string;
  /** Caller correlation value, when it sent one (see CaptureEvent). */
  readonly clientRequestId?: string;
  /** Gateway turn id (ADR-0021) — the capture turn-join key. */
  readonly requestId: string;
  readonly model: string;
  readonly recorder: CaptureRecorder;
  /**
   * Client API-key identity of the owning turn, forwarded onto every event
   * emitted through this context so the upstream leg is attributable to the
   * same application as the client leg. Undefined for key-less legs (MITM
   * tunnel, master-key access) — events then simply omit the field.
   */
  readonly apiKey?: CaptureKeyIdentity;
  /**
   * Deterministic conversation key of the owning turn (content-addressed,
   * see CaptureEvent.conversationKey) forwarded onto every event emitted
   * through this context.
   */
  readonly conversationKey?: string;
  /**
   * Non-default call label. The Layer 2 decision leg carries 'l2-decision'
   * so the archive can tell it apart from candidate-execution events that
   * share this request.
   */
  readonly purpose?: CaptureEvent['purpose'];
  /** Write-time turn identity, allocated once at the admission gate. */
  readonly turn?: TurnIdentity;

  constructor(init: {
    sessionId: string;
    clientRequestId?: string;
    requestId: string;
    model: string;
    recorder: CaptureRecorder;
    apiKey?: CaptureKeyIdentity;
    conversationKey?: string;
    purpose?: CaptureEvent['purpose'];
    turn?: TurnIdentity;
  }) {
    this.#sessionId = init.sessionId;
    this.clientRequestId = init.clientRequestId;
    this.requestId = init.requestId;
    this.model = init.model;
    this.recorder = init.recorder;
    this.apiKey = init.apiKey;
    this.conversationKey = init.conversationKey;
    this.purpose = init.purpose;
    this.turn = init.turn;
  }

  /** Same sealed conversation, different archive label. */
  withPurpose(purpose: CaptureEvent['purpose']): UpstreamEventContext {
    return new UpstreamEventContext({
      sessionId: this.#sessionId,
      clientRequestId: this.clientRequestId,
      requestId: this.requestId,
      model: this.model,
      recorder: this.recorder,
      apiKey: this.apiKey,
      conversationKey: this.conversationKey,
      purpose,
      turn: this.turn,
    });
  }

  /** Returns the exchangeId minted for this upstream request. */
  emitRequest(args: {
    url: string;
    method: string;
    requestHeaders: Record<string, string>;
    requestBody: string;
    /** Actual upstream model on the wire (defaults to this.model). */
    model?: string;
    /** Raw proxy URL when routed via proxy (redacted to origin at emit). */
    proxy?: string;
  }): string | undefined {
    return emitUpstreamRequest({
      recorder: this.recorder,
      url: args.url,
      method: args.method,
      requestHeaders: args.requestHeaders,
      requestBody: args.requestBody,
      sessionId: this.#sessionId,
      clientRequestId: this.clientRequestId,
      requestId: this.requestId,
      model: args.model ?? this.model,
      proxy: args.proxy,
      purpose: this.purpose,
      turn: this.turn,
      apiKey: this.apiKey,
      conversationKey: this.conversationKey,
    });
  }

  /** Emit a SUCCESS upstream response event. */
  emitResponse(args: {
    exchangeId: string;
    url: string;
    method: string;
    status: number;
    statusText: string;
    responseHeaders: Headers;
    responseBody: string;
    /** Epoch ms of the first streamed body chunk (streamed exchanges only). */
    firstByteTs?: number;
    model?: string;
  }): void {
    emitUpstreamResponse({
      recorder: this.recorder,
      url: args.url,
      method: args.method,
      status: args.status,
      statusText: args.statusText,
      responseHeaders: args.responseHeaders,
      responseBody: args.responseBody,
      firstByteTs: args.firstByteTs,
      sessionId: this.#sessionId,
      clientRequestId: this.clientRequestId,
      requestId: this.requestId,
      model: args.model ?? this.model,
      exchangeId: args.exchangeId,
      purpose: this.purpose,
      turn: this.turn,
      apiKey: this.apiKey,
      conversationKey: this.conversationKey,
    });
  }

  /**
   * Emit an upstream FAILURE response event. Pairs with the request event
   * fired earlier. Status is the upstream HTTP status when known, else `0`.
   */
  emitFailure(args: {
    exchangeId: string;
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
  }): void {
    emitUpstreamResponse({
      recorder: this.recorder,
      url: args.url,
      method: args.method,
      status: args.status,
      statusText: args.statusText,
      responseHeaders: args.responseHeaders ?? new Headers(),
      responseBody: args.responseBody ?? '',
      firstByteTs: args.firstByteTs,
      sessionId: this.#sessionId,
      clientRequestId: this.clientRequestId,
      requestId: this.requestId,
      model: args.model ?? this.model,
      exchangeId: args.exchangeId,
      error: args.error,
      purpose: this.purpose,
      turn: this.turn,
      apiKey: this.apiKey,
      conversationKey: this.conversationKey,
    });
  }
}

function captureOf(ctx: UpstreamEventContext | undefined): UpstreamEventContext | undefined {
  return ctx instanceof UpstreamEventContext ? ctx : undefined;
}

/** Returns the exchangeId minted by `emitUpstreamRequest`, or undefined when capture is off or the handle is not a real context. */
export function emitUpstreamRequestOnce(
  ctx: UpstreamEventContext | undefined,
  args: Parameters<UpstreamEventContext['emitRequest']>[0],
): string | undefined {
  return captureOf(ctx)?.emitRequest(args);
}

type ResponseEmit = Parameters<UpstreamEventContext['emitResponse']>[0];
type FailureEmit = Parameters<UpstreamEventContext['emitFailure']>[0];

/** Emit a SUCCESS upstream response event. No exchangeId, or a non-instance, writes nothing. */
export function emitUpstreamResponseOnce(
  ctx: UpstreamEventContext | undefined,
  args: Omit<ResponseEmit, 'exchangeId'> & { exchangeId: string | undefined },
): void {
  const real = captureOf(ctx);
  if (!real || !args.exchangeId) return;
  real.emitResponse({ ...args, exchangeId: args.exchangeId });
}

/** Emit an upstream FAILURE response event. No exchangeId, or a non-instance, writes nothing. */
export function emitUpstreamFailureOnce(
  ctx: UpstreamEventContext | undefined,
  args: Omit<FailureEmit, 'exchangeId'> & { exchangeId: string | undefined },
): void {
  const real = captureOf(ctx);
  if (!real || !args.exchangeId) return;
  real.emitFailure({ ...args, exchangeId: args.exchangeId });
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
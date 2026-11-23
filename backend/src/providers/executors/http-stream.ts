import type { ModelRegistration } from '../../config/types.js';
import type { CanonicalResponse, StreamEvent } from '../../ir/types.js';
import { canonicalResponseToEvents } from '../../ir/stream.js';
import { UpstreamError } from '../../resilience/error-classifier.js';
import { proxiedFetch, resolveProxyUrl } from '../../utils/proxy.js';
import { redactUpstreamBody } from '../../observability/upstream-body-redaction.js';
import {
  emitUpstreamRequestOnce,
  emitUpstreamResponseOnce,
  emitUpstreamFailureOnce,
  withUpstreamFailureGuard,
  type UpstreamEventContext,
} from '../../observability/upstream-events.js';

/** Raw-wire capture is bounded independently of the semantic event stream. */
export const STREAM_CAPTURE_CAP = 256 * 1024;
/** A single unterminated SSE frame must not bypass the accumulator's memory bound. */
export const STREAM_SSE_FRAME_MAX_CHARS = 32 * 1024 * 1024;

export interface ProviderStreamDecoder {
  /** Decode one complete SSE JSON data frame. */
  push(payload: unknown): StreamEvent[];
  /** Close item lifecycles and emit the single canonical terminal event. */
  finish(): StreamEvent[];
  /** Whether the native wire carried a semantic terminator (not just TCP EOF). */
  readonly terminated: boolean;
}

interface SseFrame {
  data: string;
}

/** Incremental WHATWG SSE parser: CRLF, comments and multi-line data included. */
export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private dataChars = 0;

  public push(text: string): SseFrame[] {
    this.buffer += text;
    const frames: SseFrame[] = [];
    // Linear scan: walk newlines by index instead of repeatedly slicing the
    // remaining buffer (that was O(N²) copies for a chunk with N short frames).
    let start = 0;
    while (true) {
      const newline = this.buffer.indexOf('\n', start);
      if (newline < 0) break;
      let line = this.buffer.slice(start, newline);
      start = newline + 1;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const frame = this.line(line);
      if (frame) frames.push(frame);
    }
    this.buffer = start > 0 ? this.buffer.slice(start) : this.buffer;
    // Bound one unterminated line, not the aggregate size of a network chunk
    // that may already contain thousands of complete, small frames.
    if (this.buffer.length > STREAM_SSE_FRAME_MAX_CHARS) {
      throw new Error(`Upstream SSE frame exceeded ${STREAM_SSE_FRAME_MAX_CHARS} characters.`);
    }
    return frames;
  }

  public finish(): SseFrame[] {
    const frames: SseFrame[] = [];
    if (this.buffer) {
      const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = '';
      const frame = this.line(line);
      if (frame) frames.push(frame);
    }
    const frame = this.dispatch();
    if (frame) frames.push(frame);
    return frames;
  }

  private line(line: string): SseFrame | undefined {
    if (!line) return this.dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.dataChars += value.length + 1;
      if (this.dataChars > STREAM_SSE_FRAME_MAX_CHARS) {
        throw new Error(`Upstream SSE frame exceeded ${STREAM_SSE_FRAME_MAX_CHARS} characters.`);
      }
      this.data.push(value);
    }
    return undefined;
  }

  private dispatch(): SseFrame | undefined {
    if (!this.data.length) return undefined;
    const data = this.data.join('\n');
    this.data = [];
    this.dataChars = 0;
    return { data };
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  return Number.isNaN(seconds) ? undefined : seconds;
}

/**
 * Read up to `maxBytes` of a response body as UTF-8 text, cancelling the
 * stream once the cap is reached so a runaway error response cannot exhaust
 * memory. When `race` is supplied, every chunk read is bounded by it.
 */
export async function readBoundedBodyText(
  res: Response,
  maxBytes: number,
  race?: <T>(pending: Promise<T>) => Promise<T>,
): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const readPromise = reader.read();
      const { done, value } = race ? await race(readPromise) : await readPromise;
      if (done) {
        completed = true;
        break;
      }
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) {
        const room = maxBytes - total;
        if (room > 0) chunks.push(value.subarray(0, room));
        total = maxBytes;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (!completed) {
      try { await reader.cancel(); } catch { /* The peer may already be gone. */ }
    }
    try { reader.releaseLock(); } catch { /* Still settling. */ }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

/**
 * One streamed HTTP exchange with shared capture, timeout, SSE and fallback
 * semantics. Provider modules own only request shaping and protocol decoding.
 */
export async function postProviderStream(options: {
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  model: ModelRegistration;
  provider: string;
  label: string;
  timeoutMs: number;
  idleTimeoutMs: number;
  ttftTimeoutMs?: number;
  upstreamEventContext?: UpstreamEventContext;
  createDecoder: () => ProviderStreamDecoder;
  parseBuffered: (body: unknown) => CanonicalResponse;
}): Promise<AsyncIterable<StreamEvent>> {
  const {
    url, headers, payload, model, provider, label, upstreamEventContext,
  } = options;
  const body = JSON.stringify(payload);
  const exchangeId = emitUpstreamRequestOnce(upstreamEventContext, {
    url,
    method: 'POST',
    requestHeaders: headers,
    requestBody: body,
    model: model.upstreamModel,
    proxy: resolveProxyUrl(url, { provider, model: model.id }),
  });
  const controller = new AbortController();
  let totalTripped = false;
  let idleTripped = false;
  let ttftTripped = false;
  let consumed = false;
  let res: Response | undefined;
  const totalTimer = setTimeout(() => {
    totalTripped = true;
    controller.abort();
    if (!consumed) {
      try { void res?.body?.cancel().catch(() => {}); } catch { /* ignore */ }
    }
  }, options.timeoutMs);
  const ttftMs = typeof options.ttftTimeoutMs === 'number'
    && Number.isFinite(options.ttftTimeoutMs)
    && options.ttftTimeoutMs > 0
    ? options.ttftTimeoutMs
    : undefined;
  let ttftSettled = ttftMs === undefined;
  let ttftTimer: ReturnType<typeof setTimeout> | undefined;
  const ttftMessage = (): string => `Upstream ${provider} stream TTFT exceeded ${ttftMs}ms — aborted`;
  const disarmTtft = (): void => {
    ttftSettled = true;
    if (ttftTimer !== undefined) {
      clearTimeout(ttftTimer);
      ttftTimer = undefined;
    }
  };
  if (ttftMs !== undefined) {
    ttftTimer = setTimeout(() => {
      if (ttftSettled) return;
      ttftTripped = true;
      controller.abort();
      if (!consumed) {
        try { void res?.body?.cancel().catch(() => {}); } catch { /* ignore */ }
      }
    }, ttftMs);
  }
  const idleMessage = (): string => `Upstream ${provider} stream idle for ${options.idleTimeoutMs}ms — aborted`;
  /**
   * One I/O wait, bounded by the idle budget. The deadline is a RACE, not just
   * an `abort()`: abort settles a pending body read (verified on the Bun
   * runtime) but it interrupts I/O, not a suspended caller — and it cannot be
   * armed before the response head exists. Racing gives the provider leg one
   * mechanism for "no bytes for an idle budget", covering the head wait (which
   * otherwise had no deadline until the total timeout), the SSE body loop and
   * the buffered-body loop.
   */
  const raceIdle = async <T>(pending: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        idleTripped = true;
        controller.abort();
        reject(new Error(idleMessage()));
      }, options.idleTimeoutMs);
      // Ref'd on purpose: under Bun an unref'd deadline with no other ref handle
      // never fires, leaving the head wait / SSE body loop parked forever.
      // `finally { clearTimeout(timer) }` below keeps its lifetime bounded.
    });
    try {
      return await Promise.race([pending, deadline]);
    } catch (err) {
      // `controller.abort()` above settles the pending read SYNCHRONOUSLY, so the
      // abort rejection can win this race against `deadline`'s own reject — the
      // caller then sees "The operation was aborted." instead of the idle
      // diagnostic. Re-label here, at the one place that knows an idle deadline
      // fired, so EVERY caller (head wait, SSE loop, non-2xx error body) reports
      // the real cause. `cause` keeps the transport error. Non-idle failures
      // (a genuine upstream abort) propagate untouched.
      if (idleTripped) throw new Error(idleMessage(), { cause: err });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    res = await withUpstreamFailureGuard(
      upstreamEventContext,
      exchangeId,
      url,
      'POST',
      () => raceIdle(proxiedFetch(url, {
        method: 'POST', headers, body, signal: controller.signal, redirect: 'manual',
      }, { provider, model: model.id })),
      model.upstreamModel,
    );
    if (!res.ok || !res.body) {
      let errorText: string;
      try {
        errorText = await readBoundedBodyText(res, STREAM_CAPTURE_CAP, raceIdle);
      } catch (err: any) {
        emitUpstreamFailureOnce(upstreamEventContext, {
          model: model.upstreamModel, exchangeId, url, method: 'POST',
          status: res.status, statusText: res.statusText,
          error: `Streaming error body read failed: ${err?.message ?? err}`,
        });
        throw err;
      }
      const safe = redactUpstreamBody(errorText, headers);
      emitUpstreamFailureOnce(upstreamEventContext, {
        model: model.upstreamModel, exchangeId, url, method: 'POST',
        status: res.status, statusText: res.statusText,
        responseHeaders: res.headers, responseBody: safe,
        error: `Upstream ${res.status}`,
      });
      throw new UpstreamError({
        message: `Upstream ${provider} [${label}] returned status ${res.status}: ${safe}`,
        status: res.status,
        errorBody: safe,
        provider,
        modelId: model.id,
        retryAfterSeconds: parseRetryAfter(res.headers.get('retry-after')),
      });
    }
  } catch (err) {
    clearTimeout(totalTimer);
    disarmTtft();
    if (ttftTripped) throw new Error(ttftMessage(), { cause: err });
    throw err;
  }

  const response = res;
  const responseBody = response.body!;
  return {
    async *[Symbol.asyncIterator]() {
      consumed = true;
      const reader = responseBody.getReader();
      // One body read under the idle deadline; `armIdle` used to re-arm a timer
      // that only aborted — this both arms it and guarantees the wait itself ends.
      const readIdle = (): Promise<Awaited<ReturnType<typeof reader.read>>> => raceIdle(reader.read());
      const bytes = new TextDecoder('utf-8');
      const parser = new SseParser();
      const decoder = options.createDecoder();
      const rawParts: string[] = [];
      let rawBytes = 0;
      let rawCapped = false;
      let captured = false;
      let firstByteTs: number | undefined;
      let finished = false;
      let reachedEof = false;
      const appendRaw = (piece: string): void => {
        if (piece.length && firstByteTs === undefined) firstByteTs = Date.now();
        if (!piece || rawCapped) return;
        const pieceBytes = Buffer.byteLength(piece, 'utf8');
        if (rawBytes + pieceBytes > STREAM_CAPTURE_CAP) {
          const combined = rawParts.join('') + piece;
          rawParts.length = 0;
          rawParts.push(`${Buffer.from(combined, 'utf8').subarray(0, STREAM_CAPTURE_CAP).toString('utf8')}...[TRUNCATED]`);
          rawBytes = STREAM_CAPTURE_CAP;
          rawCapped = true;
          return;
        }
        rawParts.push(piece);
        rawBytes += pieceBytes;
      };
      const capture = (error?: string): void => {
        if (captured || !exchangeId) return;
        captured = true;
        const event = {
          exchangeId, url, method: 'POST', status: response.status, statusText: response.statusText,
          responseHeaders: response.headers, responseBody: rawParts.join(''), firstByteTs, model: model.upstreamModel,
        };
        if (error) emitUpstreamFailureOnce(upstreamEventContext, { ...event, error: redactUpstreamBody(error, headers) });
        else emitUpstreamResponseOnce(upstreamEventContext, event);
      };
      const sanitizeStreamEvent = (ev: StreamEvent): StreamEvent => {
        if (ev.type === 'error') {
          return { ...ev, message: redactUpstreamBody(ev.message, headers) };
        }
        if (ev.type === 'response.failed') {
          return {
            ...ev,
            ...(ev.reason ? { reason: redactUpstreamBody(ev.reason, headers) } : {}),
            ...(ev.error ? { error: { ...ev.error, message: redactUpstreamBody(ev.error.message, headers) } } : {}),
          };
        }
        return ev;
      };
      const decodeFrame = function* (data: string): Generator<StreamEvent, boolean> {
        if (data.trim() === '[DONE]') {
          for (const ev of decoder.finish()) {
            disarmTtft();
            yield sanitizeStreamEvent(ev);
          }
          finished = true;
          return true;
        }
        if (!data.trim()) return false;
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          throw new Error(`Upstream ${provider} sent malformed JSON in an SSE data frame.`);
        }
        for (const ev of decoder.push(payload)) {
          if (!ttftSettled && ev.type !== 'response.created' && ev.type !== 'response.usage') {
            disarmTtft();
          }
          yield sanitizeStreamEvent(ev);
        }
        return false;
      };
      try {
        if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
          // Non-SSE replies deliver the full JSON body at once, so TTFT has no
          // incremental meaning here — hand off to total/idle timeouts.
          disarmTtft();
          let json = '';
          const appendJson = (chunk: string): void => {
            json += chunk;
            if (json.length > STREAM_SSE_FRAME_MAX_CHARS) {
              throw new Error(`Upstream non-SSE body exceeded ${STREAM_SSE_FRAME_MAX_CHARS} characters.`);
            }
          };
          while (true) {
            const { done, value } = await readIdle();
            if (done) {
              reachedEof = true;
              break;
            }
            const decoded = bytes.decode(value, { stream: true });
            appendRaw(decoded);
            appendJson(decoded);
          }
          const tail = bytes.decode();
          appendRaw(tail);
          appendJson(tail);
          let completion: unknown;
          try {
            completion = JSON.parse(json);
          } catch {
            throw new Error(`Upstream ${provider} answered a non-SSE body that is not valid JSON.`);
          }
          yield* canonicalResponseToEvents(options.parseBuffered(completion));
          finished = true;
          return;
        }
        let sawDone = false;
        reachedEof = false;
        while (!sawDone) {
          const { done, value } = await readIdle();
          if (done) {
            reachedEof = true;
            break;
          }
          const decoded = bytes.decode(value, { stream: true });
          appendRaw(decoded);
          for (const frame of parser.push(decoded)) {
            // A native terminal need not be the last byte: usage/message_stop
            // can follow it, so only EOF or [DONE] ends the IO loop.
            yield* decodeFrame(frame.data);
            if (frame.data.trim() === '[DONE]') {
              sawDone = true;
              break;
            }
          }
        }
        if (!sawDone) {
          appendRaw(bytes.decode());
          for (const frame of parser.finish()) {
            const stop = yield* decodeFrame(frame.data);
            if (stop) sawDone = true;
          }
        }
        if (!sawDone && !decoder.terminated) {
          throw new Error(`Upstream ${provider} stream ended before completion.`);
        }
        if (!finished) yield* decoder.finish();
        finished = true;
      } catch (err: any) {
        if (ttftTripped) {
          const message = ttftMessage();
          capture(message);
          throw new Error(message, { cause: err });
        }
        if (idleTripped) {
          // `raceIdle` already re-labelled this as the idle message (it is the
          // only place that knows an idle deadline fired); just record it.
          capture(idleMessage());
          throw err;
        }
        if (totalTripped) {
          const message = `Upstream ${provider} stream exceeded the total timeout of ${options.timeoutMs}ms — aborted`;
          capture(message);
          throw new Error(message, { cause: err });
        }
        capture(`Stream aborted: ${err?.message ?? err}`);
        throw err;
      } finally {
        clearTimeout(totalTimer);
        disarmTtft();
        if (!finished) {
          controller.abort();
        }
        if (!finished || !reachedEof) {
          try { await reader.cancel(); } catch { /* The peer may already be gone. */ }
        }
        // A deadline that won the race leaves its read request in flight until
        // the abort above settles it; releasing a still-locked reader throws.
        try { reader.releaseLock(); } catch { /* Still settling — the abort owns it. */ }
        capture();
      }
    },
  };
}

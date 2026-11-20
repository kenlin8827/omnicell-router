import type http from 'node:http';
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../config/defaults.js';

/**
 * Write one SSE frame without buffering ahead of a slow client. Errors keep the
 * existing close-the-stream policy; callers decide whether to drain upstream
 * for terminal usage after the peer is gone.
 *
 * `drain` is the only signal that the peer actually took the bytes; `close` /
 * `error` say it is gone. A peer that sends NEITHER — the Bun runtime keeps a
 * dead socket writable and silent (see the 'close' note in
 * `transport-fastify.ts`), and a half-open dev-proxy hop behaves the same — used
 * to suspend this promise forever, and with it the whole relay: the generator
 * stays parked at its `yield`, the upstream idle abort has nobody to interrupt,
 * and the capture finalize never runs (the console shows a turn pending
 * forever). The deadline is the same idle budget the upstream leg uses, so a
 * client that takes bytes slower than an upstream may stay silent is already
 * outside the gateway's contract; on expiry the leg is declared gone and the
 * socket is destroyed so every later write fails loudly instead of queueing
 * behind another deadline.
 */
export function writeWithBackpressure(
  response: http.ServerResponse,
  chunk: string,
  logError: (err: unknown) => void,
  idleTimeoutMs: number = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
): void | Promise<void> {
  // On a destroyed or already-ended ServerResponse, response.write() returns
  // false without throwing and never emits drain/close/error. Bail out
  // immediately instead of stalling for idleTimeoutMs on every remaining chunk.
  if (response.destroyed || response.writableEnded) return;
  try {
    if (response.write(chunk)) return;
  } catch (err) {
    logError(err);
    return;
  }
  // `response.write()` may synchronously destroy/end the response and emit
  // `close` before listeners below are attached.
  if (response.destroyed || response.writableEnded) return;
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown): void => {
      cleanup();
      logError(err);
      resolve();
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
    timer = setTimeout(() => {
      cleanup();
      logError(new Error(`Client leg did not drain within ${idleTimeoutMs}ms — declaring it gone`));
      try {
        response.destroy();
      } catch {
        // Already destroyed: the socket is the thing we wanted gone.
      }
      resolve();
    }, idleTimeoutMs);
    // Deliberately ref'd. Under Bun an unref'd timer with no other ref handle
    // neither fires nor lets the process exit, so a stalled client leg would
    // park the relay forever (and hang isolated test / shutdown processes).
    // The timer only exists while a write is pending and is cleared on all
    // four exit paths, so it never becomes a permanent keep-alive.
  });
}

/** Handle on one client leg's stall deadline (see `createClientLegWatchdog`). */
export interface ClientLegWatchdog {
  /** A frame reached the wire: push the deadline out. */
  progress(): void;
  /** The leg finished (or the socket closed): disarm. */
  stop(): void;
}

/**
 * Stall deadline for ONE client leg, independent of the relay coroutine.
 *
 * `writeWithBackpressure` can only bound a write it is actually awaiting. When
 * the exchange is parked somewhere else entirely (a yield inside the relay, a
 * converted-chunk callback, any await that never settles) no timer inside the
 * provider stream can unwind it, because `AbortController.abort()` interrupts
 * I/O, not a suspended generator — and the terminal capture finalize lives
 * behind that suspension. This watchdog is a plain event-loop timer owned by
 * the transport: it can always fire, so the exchange always gets a terminal
 * record (and its socket closed) instead of a permanent "pending" row.
 *
 * It fires only on total silence longer than the upstream idle budget, i.e.
 * strictly outside anything the gateway already accepts as a live stream.
 */
export function createClientLegWatchdog(options: {
  onStall: (idleTimeoutMs: number) => void;
  idleTimeoutMs?: number;
}): ClientLegWatchdog {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopped) return;
      stopped = true;
      options.onStall(idleTimeoutMs);
    }, idleTimeoutMs);
    // Ref'd on purpose: this must still fire when it is the ONLY handle left
    // (graceful shutdown with a pending write, single-shot CLI / test process).
    // `stop()` clears it, so it cannot hold the process open past a live leg.
  };
  arm();
  return {
    progress: () => {
      if (!stopped) arm();
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

import { useCallback, useEffect, useRef } from 'react';

/**
 * One `AbortController` per live managed transfer, plus the call that makes the
 * cancellation real on the server (ADR-0022).
 *
 * Two failures this exists to prevent, both reported by operators:
 * - One controller shared by every download button meant starting geo sync
 *   silently cancelled a running core install, and the engine's reasonless
 *   `AbortError` surfaced as a generic "operation failed" toast carrying
 *   `signal is aborted without reason`.
 * - Aborting only the FETCH does not stop the gateway's download under this
 *   runtime: probes (`tmp/probe-client-gone.ts`) showed a hijacked streaming
 *   reply gets no `close`, no `aborted`, and no error when the client vanishes
 *   mid-stream, and Fastify's `onResponse` only fires when the handler returns —
 *   so a walk-away left the engine transferring bytes to nobody, holding the
 *   per-asset lock, and the next click queued behind a transfer already abandoned.
 *   Cancelling is therefore an EXPLICIT call: `cancelTransfer(key)` posts the
 *   leg's gateway key to the admin endpoint, which aborts the running engine and
 *   keeps the staged bytes.
 *
 * `begin(leg, serverKey)` hands out the signal for one leg, superseding only
 * that leg's live transfer and telling the gateway its key first; `cancel(leg)`
 * stops the leg because the operator asked it to; `settle(leg, signal)` removes
 * a run that ended on its own; unmount cancels everything still live. The
 * notifier may return a promise, and a follow-up `begin` on the same leg waits
 * for that ack - starting a new transfer before the gateway has released the old
 * one's asset lock just makes the new click queue behind the run it replaced,
 * which reads as a frozen button. The wait is bounded, so an ack that never
 * comes costs a short overlap, never a dead button.
 *
 * Keys are the gateway's vocabulary (`core`, `geo:<target>`), so a leg with
 * several targets (geo machine vs node) can be cancelled on its own. Every
 * `abort()` carries a reason, so a cancel is a named outcome, never the
 * reasonless error.
 */
export type TransferLeg = 'core' | 'geo';

/** A cancellation is not a failure: it arrives as an AbortError, a DOMException
 *  with `AbortError`, an `ABORT_ERR` code, or the engine's own aborted message. */
export function isAbortError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const e = err as { name?: string; message?: string; code?: string };
    if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return true;
    if (typeof e.message === 'string' && e.message.includes('aborted')) return true;
  }
  if (typeof err === 'string') return err.includes('aborted');
  return false;
}

/** How long a superseding click waits for the gateway to take the cancel it
 *  replaces (an admin POST on loopback). Past that the click proceeds: a brief
 *  overlap on one asset lock beats a button that looks frozen. */
const ACK_WAIT_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** What the operator did, in the words the engine and the log both understand. */
function abortReason(key: string, cause: 'superseded' | 'cancelled' | 'close'): Error {
  const what = cause === 'superseded'
    ? `replaced by a new ${key} download`
    : cause === 'cancelled'
      ? `${key} download cancelled by the operator`
      : `page closed during the ${key} download`;
  return new DOMException(what, 'AbortError');
}

export function useTransferAbort(
  cancelTransfer?: (serverKey: string) => void | Promise<unknown>,
): {
  begin: (leg: TransferLeg, serverKey: string) => Promise<AbortSignal>;
  cancel: (leg: TransferLeg) => void;
  settle: (leg: TransferLeg, signal: AbortSignal) => void;
} {
  /** Live transfers by gateway key, so a cancel names the leg it stops. */
  const liveRef = useRef(new Map<string, { controller: AbortController; settled: Promise<void> }>());
  const notifier = useRef(cancelTransfer);
  notifier.current = cancelTransfer;

  useEffect(() => () => {
    const live = liveRef.current;
    for (const key of [...live.keys()]) {
      const run = live.get(key);
      if (!run) continue;
      live.delete(key);
      // Walking away stops the download too — it does not keep running for a
      // page that no longer exists. The ack is fire-and-forget by definition:
      // the component is gone, so nothing may await it.
      run.controller.abort(abortReason(key, 'close'));
      try {
        void notifier.current?.(key);
      } catch {
        // A dead transfer has nobody left to tell.
      }
    }
  }, []);

  /** Abort one run and tell the gateway, never throwing into the caller's
   *  teardown path: a cancel that fails to reach the server is still a cancel
   *  locally, and the next click will not be blocked by it. */
  const stop = useCallback((run: { controller: AbortController; settled: Promise<void> }, key: string): void => {
    run.controller.abort(abortReason(key, 'cancelled'));
    try {
      // A notifier that never settles (a hung request) must not hold the next
      // click hostage: `begin` races this with ACK_WAIT_MS.
      run.settled = Promise.resolve(notifier.current?.(key)).then(() => undefined, () => undefined);
    } catch {
      // An ack that throws is an ack that failed: record nothing, keep going.
    }
  }, []);

  const begin = useCallback(async (leg: TransferLeg, serverKey: string): Promise<AbortSignal> => {
    const live = liveRef.current;
    const old = live.get(serverKey);
    if (old) {
      live.delete(serverKey);
      stop(old, serverKey);
      // Hand the new signal to the caller only once the gateway has taken the
      // cancel, so the two transfers never overlap on one asset lock.
      await Promise.race([old.settled, sleep(ACK_WAIT_MS)]);
    }
    const controller = new AbortController();
    const settled = new Promise<void>((resolve) => {
      if (controller.signal.aborted) resolve();
      else controller.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    live.set(serverKey, { controller, settled });
    return controller.signal;
  }, [stop]);

  /** Stop a leg because the operator pressed Cancel: whichever run of that leg
   *  is live, and nothing else. */
  const cancel = useCallback((leg: TransferLeg): void => {
    const live = liveRef.current;
    for (const key of [...live.keys()]) {
      if (key !== leg && !key.startsWith(`${leg}:`)) continue;
      const run = live.get(key);
      if (!run) continue;
      live.delete(key);
      stop(run, key);
    }
  }, [stop]);

  /** Forget a transfer that finished on its own, so leaving the page after it
   *  does not cancel a download that already completed. Identity matters: a
   *  stale settle from a superseded run must not remove the live one. */
  const settle = useCallback((leg: TransferLeg, signal: AbortSignal): void => {
    for (const [key, run] of liveRef.current) {
      if ((key === leg || key.startsWith(`${leg}:`)) && run.controller.signal === signal) {
        liveRef.current.delete(key);
        return;
      }
    }
  }, []);

  return { begin, cancel, settle };
}

/**
 * Module-level registry of live local-model transfers (GGUF downloads, leg
 * `model:<repo>/<path>`; engine installs, leg `engine:<id>:<target>`).
 *
 * This deliberately lives OUTSIDE React. The previous wiring kept the download
 * loop and its AbortController inside the page component, and the unmount
 * cleanup of `useTransferAbort` treated a route change the same as closing the
 * app: walking away from the marketplace mid-download aborted the stream AND
 * posted the gateway cancel, so coming back showed no progress bar and the
 * operator had to click Download again to resume. A download is measured in
 * gigabytes and minutes — a route switch must not touch it.
 *
 * Ownership after this change:
 * - Route navigation (component unmount): the transfer keeps running at module
 *   scope; the page re-subscribes on mount and the progress bar reappears with
 *   live numbers.
 * - Closing the app (`pagehide`): every live leg is aborted and the gateway
 *   cancel endpoint is posted with `keepalive` — a dead window must not leave
 *   the engine streaming bytes to nobody while holding the per-asset lock
 *   (the original ADR-0022 failure this all exists to prevent).
 * - The operator's Cancel button: `cancelTransfer(leg)`, same as before.
 *
 * View state is exposed as a plain snapshot for `useSyncExternalStore`; final
 * entries self-clear after a short delay so the Download button comes back.
 */
import { api } from './api';
import type { LocalInstallProgress } from './api';

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

export type TransferStage = NonNullable<LocalInstallProgress['stage']>;

/** Live progress readout for one leg (same fields the NDJSON stream reports). */
export interface TransferView {
  stage: TransferStage;
  asset: string;
  downloaded: number;
  total: number;
  /** Position in a multi-asset install (1-based); 1/1 for single assets. */
  assetIndex: number;
  assetTotal: number;
}

export type TransferPhase = 'active' | 'ok' | 'cancelled' | 'error';

export interface TransferEntry {
  phase: TransferPhase;
  run?: TransferView;
  error?: string;
}

/** How long a finished row lingers before the download button returns. */
const FINAL_LINGER_MS = 4000;

/** How long a superseding click waits for the gateway to take the cancel it
 *  replaces (an admin POST on loopback). Same bound as `useTransferAbort`. */
const ACK_WAIT_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** What the operator did, in words the log understands. */
function abortReason(key: string, cause: 'superseded' | 'cancelled' | 'close'): Error {
  const what = cause === 'superseded'
    ? `replaced by a new ${key} download`
    : cause === 'cancelled'
      ? `${key} download cancelled by the operator`
      : `page closed during the ${key} download`;
  return new DOMException(what, 'AbortError');
}

const entries = new Map<string, TransferEntry>();
/** Live runs, with the remote-cancel channel each leg was started with —
 *  local-model legs post `cancelLocalTransfer`, mihomo legs their own
 *  endpoint; pagehide and the Cancel button must use the right one. */
const live = new Map<string, { controller: AbortController; settled: Promise<void>; cancelRemote: () => Promise<unknown> }>();
let snapshot: Record<string, TransferEntry> = {};
const listeners = new Set<() => void>();

function commit(): void {
  snapshot = Object.fromEntries(entries);
  for (const fn of listeners) fn();
}

/** Clear a finished entry so the page's action button comes back. */
function scheduleClear(leg: string): void {
  setTimeout(() => {
    const entry = entries.get(leg);
    if (entry && entry.phase !== 'active') {
      entries.delete(leg);
      commit();
    }
  }, FINAL_LINGER_MS);
}

export function subscribeTransfers(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getTransferSnapshot(): Record<string, TransferEntry> {
  return snapshot;
}

/** Abort one leg because the operator asked; the gateway is told first-class
 *  (aborting only the fetch does not stop its download — see the hook doc). */
export function cancelTransfer(leg: string): void {
  for (const [key, run] of [...live]) {
    if (key !== leg && !key.startsWith(`${leg}:`)) continue;
    live.delete(key);
    run.controller.abort(abortReason(key, 'cancelled'));
    run.settled = Promise.resolve(run.cancelRemote()).then(() => undefined, () => undefined);
  }
}

/**
 * Run one transfer to completion at module scope. `request` performs the
 * actual streaming call; the handlers fire from wherever the loop happens to
 * be — including after the page that started it has unmounted (toasts stay
 * alive because the toast provider sits at the app root).
 */
export async function startTransfer<T>(
  leg: string,
  opts: {
    initial?: TransferView;
    request: (signal: AbortSignal, onEvent: (event: LocalInstallProgress) => void) => Promise<T>;
    /** Gateway cancel endpoint for this leg; defaults to `cancelLocalTransfer`. */
    cancelRemote?: () => Promise<unknown>;
    onOk?: (result: T) => void;
    onCancelled?: () => void;
    onError?: (message: string) => void;
  },
): Promise<void> {
  const cancelRemote = opts.cancelRemote ?? (() => api.cancelLocalTransfer(leg));
  // Supersede a live run of the same leg: abort, tell the gateway, and hand
  // the new signal over only once the old asset lock is released (bounded —
  // a lost ack costs a short overlap, never a dead button).
  const old = live.get(leg);
  if (old) {
    live.delete(leg);
    old.controller.abort(abortReason(leg, 'superseded'));
    old.settled = Promise.resolve(old.cancelRemote()).then(() => undefined, () => undefined);
    await Promise.race([old.settled, sleep(ACK_WAIT_MS)]);
  }

  const controller = new AbortController();
  const settled = new Promise<void>((resolve) => {
    if (controller.signal.aborted) resolve();
    else controller.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  live.set(leg, { controller, settled, cancelRemote });

  entries.set(leg, { phase: 'active', ...(opts.initial ? { run: opts.initial } : {}) });
  commit();

  const patch = (view: Partial<TransferView>): void => {
    const entry = entries.get(leg);
    if (!entry || entry.phase !== 'active') return;
    const prev = entry.run;
    entry.run = {
      stage: view.stage ?? prev?.stage ?? 'download',
      asset: view.asset ?? prev?.asset ?? '',
      downloaded: view.downloaded ?? prev?.downloaded ?? 0,
      total: view.total ?? prev?.total ?? 0,
      assetIndex: view.assetIndex ?? prev?.assetIndex ?? 1,
      assetTotal: view.assetTotal ?? prev?.assetTotal ?? 1,
    };
    commit();
  };

  try {
    const result = await opts.request(controller.signal, (event) => {
      patch({ stage: event.stage, asset: event.asset, downloaded: event.downloaded, total: event.total, assetIndex: event.assetIndex, assetTotal: event.assetTotal });
    });
    entries.set(leg, { phase: 'ok', run: entries.get(leg)?.run });
    commit();
    opts.onOk?.(result);
  } catch (err) {
    if (isAbortError(err)) {
      entries.set(leg, { phase: 'cancelled', run: entries.get(leg)?.run });
      commit();
      opts.onCancelled?.();
    } else {
      const message = err instanceof Error ? err.message : String(err);
      entries.set(leg, { phase: 'error', error: message, run: entries.get(leg)?.run });
      commit();
      opts.onError?.(message);
    }
  } finally {
    // Identity check: a superseded run's settle must not drop the live one.
    const run = live.get(leg);
    if (run && run.controller === controller) live.delete(leg);
    scheduleClear(leg);
  }
}

// Closing the window stops every live transfer: abort locally, then post the
// gateway cancel with `keepalive` so the request survives page teardown.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const [key, run] of [...live]) {
      live.delete(key);
      run.controller.abort(abortReason(key, 'close'));
      try {
        void run.cancelRemote();
      } catch {
        // A dead transfer has nobody left to tell.
      }
    }
  });
}

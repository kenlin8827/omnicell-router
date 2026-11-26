/**
 * Behavior tests for `lib/transferStore` — the module-scope transfer registry
 * that keeps local-model downloads alive across route changes.
 *
 * Runs in the plain node environment (no jsdom needed): the store only touches
 * React via useSyncExternalStore on the page side; here we exercise the raw
 * subscribe/snapshot/start/cancel contract.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  cancelTransfer,
  getTransferSnapshot,
  startTransfer,
  subscribeTransfers,
} from './transferStore';

const LEG = 'model:test/repo/file.gguf';

/** Wait until `pred()` holds (the store settles asynchronously). */
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('transferStore', () => {
  it('runs a transfer to completion and exposes progress via the snapshot', async () => {
    let released!: (v: { status: string }) => void;
    const gate = new Promise<{ status: string }>((r) => { released = r; });
    void startTransfer(LEG, {
      initial: { stage: 'download', asset: 'file.gguf', downloaded: 0, total: 100, assetIndex: 1, assetTotal: 1 },
      request: async (_signal, onEvent) => {
        onEvent({ stage: 'download', downloaded: 40, total: 100 });
        return gate;
      },
    });
    await until(() => getTransferSnapshot()[LEG]?.phase === 'active');
    expect(getTransferSnapshot()[LEG].run?.downloaded).toBe(40);
    released({ status: 'ok' });
    await until(() => getTransferSnapshot()[LEG]?.phase === 'ok');
    // The finished entry self-clears so the download button comes back.
    await until(() => getTransferSnapshot()[LEG] === undefined, 6000);
  });

  it('cancelTransfer aborts the stream and reports the leg to the gateway', async () => {
    const abortSpy = vi.fn();
    void startTransfer(LEG, {
      request: (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => abortSpy(signal.reason?.message ?? ''), { once: true });
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
      onCancelled: () => undefined,
    });
    await until(() => getTransferSnapshot()[LEG]?.phase === 'active');
    cancelTransfer(LEG);
    await until(() => getTransferSnapshot()[LEG]?.phase === 'cancelled');
    expect(abortSpy).toHaveBeenCalled();
    expect(String(abortSpy.mock.calls[0][0])).toContain('cancelled by the operator');
  });

  it('keeps subscribers informed on every transition', async () => {
    const seen: string[] = [];
    const unsub = subscribeTransfers(() => {
      seen.push(getTransferSnapshot()[LEG]?.phase ?? 'gone');
    });
    void startTransfer(LEG, {
      request: async () => ({ status: 'ok' }),
    });
    await until(() => seen.includes('ok') || seen.includes('gone'), 3000);
    unsub();
    expect(seen.length).toBeGreaterThan(0);
  });
});

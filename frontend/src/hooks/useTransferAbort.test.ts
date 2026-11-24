import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { isAbortError, useTransferAbort } from './useTransferAbort';

/**
 * The contract these tests hold: a cancel is an OUTCOME, it belongs to ONE leg,
 * and it reaches the GATEWAY. A shared controller made "sync geo" kill a running
 * core install and report the engine's reasonless abort as a failed operation; a
 * client-side-only cancel left the download running server-side, because this
 * runtime fires no event when a client walks away (ADR-0022).
 */
describe('useTransferAbort', () => {
  it('supersedes only that leg, locally and on the gateway', async () => {
    const notified: string[] = [];
    const { result } = renderHook(() => useTransferAbort((key) => { notified.push(key); }));
    const core = await result.current.begin('core', 'core');
    const geo = await result.current.begin('geo', 'geo:machine');

    await result.current.begin('core', 'core');
    await waitFor(() => expect(core.aborted).toBe(true));
    expect(geo.aborted).toBe(false);
    // The geo transfer keeps running, and the gateway is told about one leg only.
    expect(notified).toEqual(['core']);
  });

  it('aborts with a reason, so a cancel is never the reasonless engine error', async () => {
    const { result } = renderHook(() => useTransferAbort());
    const core = await result.current.begin('core', 'core');
    await result.current.begin('core', 'core');
    await waitFor(() => expect(core.aborted).toBe(true));
    // `abort()` with no argument is what produces "signal is aborted without
    // reason"; the reason here is ours, and it names the leg.
    expect(String(core.reason)).toContain('core');
    expect(isAbortError(core.reason)).toBe(true);
  });

  it("cancel(leg) stops that leg's live run and reports its gateway key", async () => {
    const notified: string[] = [];
    const { result } = renderHook(() => useTransferAbort((key) => { notified.push(key); }));
    const core = await result.current.begin('core', 'core');
    const geo = await result.current.begin('geo', 'geo:node');

    // The button says "cancel the download"; the run is keyed by sub-leg, so
    // one call must find `geo:node` and leave the core install alone.
    result.current.cancel('geo');
    expect(geo.aborted).toBe(true);
    expect(core.aborted).toBe(false);
    expect(notified).toEqual(['geo:node']);
    expect(isAbortError(geo.reason)).toBe(true);

    result.current.cancel('geo');   // nothing live: no phantom cancel sent
    expect(notified).toEqual(['geo:node']);
  });

  it('waits for the gateway to take the cancel before starting the next run', async () => {
    // Same-leg overlap means two transfers on one asset lock: the newer click
    // would wait behind the run it replaced and read as a frozen button.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const notified: string[] = [];
    const { result } = renderHook(() => useTransferAbort(() => gate.then(() => { notified.push('core'); })));
    await result.current.begin('core', 'core');

    let handedOff = false;
    const next = result.current.begin('core', 'core').then((signal) => { handedOff = true; return signal; });
    await Promise.resolve();
    await Promise.resolve();
    expect(handedOff).toBe(false);
    expect(notified).toEqual([]);

    release();
    await next;
    expect(handedOff).toBe(true);
    expect(notified).toEqual(['core']);
  });

  it('settles a finished transfer without cancelling it, and never a newer run', async () => {
    const notified: string[] = [];
    const { result, unmount } = renderHook(() => useTransferAbort((key) => { notified.push(key); }));
    const core = await result.current.begin('core', 'core');
    result.current.settle('core', core);
    expect(core.aborted).toBe(false);

    unmount();
    // A transfer that already ended is not a live one: nothing to stop, nothing
    // to tell the gateway.
    expect(notified).toEqual([]);
  });

  it('ignores a stale settle so a slow finally cannot hide the live run', async () => {
    const notified: string[] = [];
    const { result, unmount } = renderHook(() => useTransferAbort((key) => { notified.push(key); }));
    const first = await result.current.begin('core', 'core');
    const second = await result.current.begin('core', 'core');
    result.current.settle('core', first);   // belongs to the superseded run
    unmount();
    expect(second.aborted).toBe(true);
    expect(notified).toEqual(['core', 'core']);   // supersede, then the live run
  });

  it('cancels every live leg when the page unmounts', async () => {
    const notified: string[] = [];
    const { result, unmount } = renderHook(() => useTransferAbort((key) => { notified.push(key); }));
    const core = await result.current.begin('core', 'core');
    const geo = await result.current.begin('geo', 'geo:node');
    unmount();
    await waitFor(() => expect(core.aborted && geo.aborted).toBe(true));
    expect(notified.sort()).toEqual(['core', 'geo:node']);
    expect(isAbortError(core.reason)).toBe(true);
  });
});

describe('isAbortError', () => {
  it('recognises the shapes a cancel arrives in', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbortError(Object.assign(new Error('boom'), { code: 'ABORT_ERR' }))).toBe(true);
    expect(isAbortError(new Error('signal is aborted without reason'))).toBe(true);
  });

  it('does not swallow a real failure', () => {
    expect(isAbortError(new Error('HTTP 502'))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError('boom')).toBe(false);
  });
});

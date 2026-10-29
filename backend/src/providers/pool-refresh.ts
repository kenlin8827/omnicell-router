/**
 * Pool-refresh hook — the back-channel that lets background producers
 * (catalog auto-pull sweep) trigger the same hot pool sync the console
 * mutation seams run, WITHOUT importing the registry/boot builder into the
 * catalog layer (import-cycle break; the catalog must stay registry-agnostic).
 *
 * Set once at boot (`index.ts`) via `setPoolRefreshHook`; background sweeps
 * call `requestPoolRefresh()` after a mutation. Fail-open: a missing hook or
 * a failing refresh never propagates — the next mutation or restart resyncs.
 */
type PoolRefreshFn = () => Promise<unknown>;

let hook: PoolRefreshFn | undefined;

export function setPoolRefreshHook(fn: PoolRefreshFn | undefined): void {
  hook = fn;
}

export function requestPoolRefresh(): void {
  if (!hook) return;
  void Promise.resolve()
    .then(() => hook!())
    .catch((err) => {
      console.warn(`[pool] background resync failed (registry may drift until next sync): ${(err as Error).message}`);
    });
}

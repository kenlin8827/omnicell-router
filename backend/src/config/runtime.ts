import type { RouterConfig } from './types.js';

/**
 * The live config object registered by createServer.
 *
 * Kept in a leaf module so per-request readers (the gateway plugin host, the
 * forward proxy) can consult strict runtime flags WITHOUT importing
 * `config/index.ts` — that module pulls in the pipeline and rate-limiter
 * graphs, and importing it from the plugin host creates a load-order cycle
 * whose partial module hides these exports.
 */
let runtimeConfigRef: RouterConfig | undefined;

/**
 * Point the live snapshot at `cfg`. Called once by createServer so config saves
 * can refresh the boot snapshot; tests pass `undefined` to drop it again.
 */
export function registerRuntimeConfigRef(cfg: RouterConfig | undefined): void {
  runtimeConfigRef = cfg;
}

/**
 * Live config snapshot (createServer's object, hot-synced by saveConfig for
 * the fields the running gateway reads per request: apiKeys, webAuth).
 * Console-auth endpoints prefer it over a disk re-read so the gate and the
 * credential checks can never disagree.
 */
export function getRuntimeConfigRef(): RouterConfig | undefined {
  return runtimeConfigRef;
}

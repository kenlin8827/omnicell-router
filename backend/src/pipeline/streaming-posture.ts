import { loadConfig } from '../config/index.js';
import type {
  StreamingClientMode,
  StreamingConfig,
  StreamingUpstreamMode,
} from '../config/types.js';

/**
 * Live streaming posture — the two independent axes of `streaming:`
 * (ADR-0008 §1), read per request by the chat pipeline (client shape) and the
 * orchestrator (provider transport).
 *
 * Why a gate rather than `this.config` at the call site: the pipeline entry
 * (`runChatSurface`) has no orchestrator instance to read from (tests hand it
 * a `Pick<…,'process'>` stub, transports own different instances), and the
 * posture is a per-request contract — one snapshot per request, never a
 * second spelling of the defaults in two call sites.
 *
 * Scope: HOT-applied. Both axes are read per request, so a console save
 * re-seeds the gate (`routes/console.ts` calls `applyStreamingPosture` beside
 * `applyDirectivesConfig`) and the next request follows — no restart. Only the
 * WIRE capability (which providers implement `createStream`) is boot-fixed.
 */
export interface EffectiveStreamingPosture {
  /** Response shape written to the caller. */
  client: StreamingClientMode;
  /** Provider-leg transport. */
  upstream: StreamingUpstreamMode;
}

const CLIENT_MODES: readonly StreamingClientMode[] = ['allow', 'deny', 'always'];
const UPSTREAM_MODES: readonly StreamingUpstreamMode[] = ['follow', 'stream', 'buffered'];

let live: EffectiveStreamingPosture | null = null;

/** Normalize a config node (or nothing) into the effective posture. */
export function applyStreamingPosture(cfg?: StreamingConfig): EffectiveStreamingPosture {
  const base = loadConfig().streaming;
  const clientMode = cfg?.client?.mode ?? base?.client?.mode;
  const upstreamMode = cfg?.upstream?.mode ?? base?.upstream?.mode;
  live = {
    client: CLIENT_MODES.includes(clientMode as StreamingClientMode)
      ? (clientMode as StreamingClientMode)
      : 'allow',
    upstream: UPSTREAM_MODES.includes(upstreamMode as StreamingUpstreamMode)
      ? (upstreamMode as StreamingUpstreamMode)
      : 'follow',
  };
  return live;
}

/** Current posture snapshot (pipeline + orchestrator read through this). */
export function streamingPosture(): EffectiveStreamingPosture {
  return live ?? applyStreamingPosture();
}

/** Test seam. */
export function resetStreamingPostureForTests(): void {
  live = null;
}

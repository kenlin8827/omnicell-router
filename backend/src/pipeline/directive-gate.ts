import { loadConfig } from '../config/index.js';
import type { DirectivesConfig } from '../config/types.js';
import { DEFAULT_DIRECTIVE_PREFIX } from '../config/defaults.js';
import { resolveDirectivePrefix } from './directives.js';

/**
 * Live directive gate — the console-hot-applied view of `directives:`
 * (`enabled`, `prefix`). Same shape as the experience-table gate
 * (`applyRouteEntriesConfig`): a config save calls `applyDirectivesConfig`,
 * the orchestrator reads `directivesGate()` per request, and the first read
 * seeds from disk so a boot never needs an explicit apply.
 *
 * Why a gate rather than reading `this.config` in the orchestrator: the
 * orchestrator instance can outlive a config save (the console mutates the
 * config tree in place), and the prefix is a per-request scrub contract —
 * reading a stale copy would silently stop scrubbing a namespace the operator
 * just changed.
 */
export interface EffectiveDirectivesConfig {
  enabled: boolean;
  prefix: string;
}

let live: EffectiveDirectivesConfig | null = null;

/** Seed from disk config until a console save hot-applies a fresher node. */
export function applyDirectivesConfig(cfg?: DirectivesConfig): EffectiveDirectivesConfig {
  const base = loadConfig().directives;
  const merged = { ...base, ...cfg };
  live = {
    enabled: merged?.enabled !== false,
    prefix: resolveDirectivePrefix(merged?.prefix ?? DEFAULT_DIRECTIVE_PREFIX),
  };
  return live;
}

/** Current gate snapshot (orchestrator + console read through this). */
export function directivesGate(): EffectiveDirectivesConfig {
  return live ?? applyDirectivesConfig();
}

/** Test seam. */
export function resetDirectivesGateForTests(): void {
  live = null;
}

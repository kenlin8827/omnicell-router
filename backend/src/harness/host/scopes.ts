import type { HarnessScope } from '../types.js';

/**
 * The scopes this build ACCEPTS — the single seam for project-level support (ADR-0015 §D2 "Scope",
 * "Deferred").
 *
 * Project discovery and install are **deferred, not deleted**: every adapter still DECLARES its
 * project landing (`SkillsSpec.project`, `configProject`, `looseDir.project`), the writers still take a
 * `scope`, and the removal guard still recognises project roots — so re-enabling project support is
 * this list plus the console's selector, not a re-spelling of thirteen adapters.
 *
 * Until then the PRODUCT boundary refuses `project`:
 *   · the install route answers `unsupported_scope` (the orchestrator keeps the parameter as the seam);
 *   · `scanInventory` never reads or scans a project root, so nothing project-local is discovered;
 *   · the console offers no scope choice and always sends `global`.
 *
 * Adding a scope here without the other three is a half-open door: installs would land where discovery
 * cannot see them.
 */
export const ENABLED_SCOPES: readonly HarnessScope[] = ['global'];

/** True when a wire value names a scope this build accepts. */
export function isEnabledScope(value: unknown): value is HarnessScope {
  return typeof value === 'string' && (ENABLED_SCOPES as readonly string[]).includes(value);
}

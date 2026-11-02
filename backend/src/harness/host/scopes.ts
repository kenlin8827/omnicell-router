import type { HarnessScope } from '../types.js';

/**
 * The scopes this build ACCEPTS (ADR-0015 §D2 "Scope").
 *
 * Both global and project scopes are active:
 *   · Global scope materializes artifacts in user-level configuration directories;
 *   · Project scope materializes artifacts in target project roots (.agents/skills, .claude, etc.).
 */
export const ENABLED_SCOPES: readonly HarnessScope[] = ['global', 'project'];

/** True when a wire value names a scope this build accepts. */
export function isEnabledScope(value: unknown): value is HarnessScope {
  return typeof value === 'string' && (ENABLED_SCOPES as readonly string[]).includes(value);
}

import crypto from 'node:crypto';
import type { CallCredential } from '../providers/base.js';
import type { CircuitBreakerManager } from '../resilience/circuit-breaker-manager.js';
import type { ModelRegistration } from '../config/types.js';
import type { ConversationSession } from '../session/session-manager.js';

/**
 * ADR-0019 Decision 7 — per-request account selection with session affinity.
 *
 *   switching is FORCED FAILOVER, never balancing
 *
 * Pure over (session binding, pair breaker state, suspect flags): it decides which
 * credential of a provider chain should serve one (session x model) call and
 * which affinity mutation the caller must PERSIST after a success. Persistence
 * lives with the caller (the orchestrator) precisely so a speculative move is
 * never written when the chosen account then fails.
 *
 *   bound present & healthy            -> keep   (no rebalance, ever)
 *   bound present & pair breaker OPEN/suspect  -> next healthy in chain order, FORCED rebind
 *   bound absent/expired/stale         -> deterministic hash(sessionId) spread (new-session rule)
 *   chain length <= 1 / no chain       -> undefined = legacy no-prefix path (byte-identical)
 *   every prefix out                   -> undefined + 'all-unhealthy' (caller keeps the
 *                                        last-candidate force: today's gate semantics)
 *
 * No switch-back logic exists anywhere: a binding only moves while its breaker is
 * out, and the moved-to value then holds while it is healthy — recovery of the
 * old account cannot pull traffic back (correct by construction).
 */

/** Anthropic's default prompt-cache TTL (5 min, 2026-03-06) — the affinity window. */
export const DEFAULT_ACCOUNT_AFFINITY_CACHE_TTL_MS = 300_000;

/** Why no credential was selected (never an error — each maps to a caller rule). */
export type AccountSelectionReason =
  /** Provider has no registered chain (config.yaml/mock boot shape) — baked key path. */
  | 'no-chain'
  /**
   * Single-credential chain — today's byte-identical no-prefix path. NOT returned
   * when that one credential is operator-disabled: the no-prefix path would serve
   * the boot-baked key and route traffic the operator took down, so the takedown
   * outranks the degeneracy and 'all-disabled' is returned instead.
   */
  | 'single-credential'
  /** Every prefix is pair-OPEN or account-SUSPECT — caller forces without attribution. */
  | 'all-unhealthy'
  /**
   * Every credential of this chain is operator-DISABLED. Unlike 'all-unhealthy'
   * this is NEVER forced: a takedown is a decision, not a guess about health, so
   * the caller must move on to another candidate even at the last position.
   */
  | 'all-disabled';

export interface AccountSelection {
  /** Credential to pass to `registry.execute`; undefined = no prefix (legacy path). */
  credential?: CallCredential;
  /** Set only when this turn produced NO credential; explains which degeneracy applies. */
  reason?: AccountSelectionReason;
  /**
   * Affinity mutation to persist AFTER the call succeeds:
   * forced=false -> first-write-wins bind; forced=true -> rebind (the bound
   * account moved, or its stored prefix is stale/expired).
   */
  bind?: { keyHashPrefix: string; forced: boolean };
  /** True when this selection moved the session off its previously bound account. */
  forcedMove: boolean;
}

export interface AccountSelectionCtx {
  /** Session id the deterministic spread hashes over (conversation identity). */
  sessionId: string;
  /** Affinity window; default `DEFAULT_ACCOUNT_AFFINITY_CACHE_TTL_MS`. */
  affinityWindowMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
}

/**
 * Deterministic new-session spread index: sha256(sessionId) % count. Stable
 * across restarts and across callers; cold prefixes have nothing to lose, so
 * spreading new sessions is free (Decision 7). Exported so tests assert the
 * same function the resolver uses instead of duplicating the hash.
 */
export function accountSpreadIndex(sessionId: string, count: number): number {
  if (count <= 1) return 0;
  const hex = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
  return parseInt(hex, 16) % count;
}

export function selectAccount(
  session: ConversationSession | undefined,
  model: ModelRegistration,
  chain: readonly CallCredential[] | undefined,
  cb: CircuitBreakerManager,
  ctx: AccountSelectionCtx
): AccountSelection {
  if (!chain || chain.length === 0) return { forcedMove: false, reason: 'no-chain' };
  // A takedown outranks every degeneracy: the no-prefix paths (single-credential,
  // and 'all-unhealthy' below) fall back to the boot-baked head key, which would
  // route through a credential the operator explicitly parked.
  const allDisabled = chain.every((c) => cb.isDisabled(model.id, c.keyHashPrefix));
  if (allDisabled) return { forcedMove: false, reason: 'all-disabled' };
  if (chain.length === 1) {
    // Single-credential degeneracy: no prefix is ever passed, so no pair breakers are
    // created and every downstream path is exactly pre-P3 behavior.
    return { forcedMove: false, reason: 'single-credential' };
  }

  const healthy = chain.filter((c) => !cb.isPairOut(model.id, c.keyHashPrefix));

  const bound = session?.boundKeyHashPrefix;
  const now = (ctx.now ?? Date.now)();
  const windowMs = ctx.affinityWindowMs ?? DEFAULT_ACCOUNT_AFFINITY_CACHE_TTL_MS;
  // Lazy TTL expiry: idle past the cache window the prefix is re-billed anyway,
  // so the binding is treated as ABSENT and the session re-spreads like new.
  const boundLive = bound !== undefined && now - (session?.lastActiveAt ?? 0) <= windowMs;

  if (bound !== undefined && boundLive) {
    const kept = healthy.find((c) => c.keyHashPrefix === bound);
    if (kept) return { credential: kept, forcedMove: false };
    if (chain.some((c) => c.keyHashPrefix === bound)) {
      // FORCED failover — the bound account is known-bad for this model.
      if (healthy.length === 0) return { forcedMove: false, reason: 'all-unhealthy' };
      const next = healthy[0]; // chain order = selection priority (active head first)
      return {
        credential: next,
        bind: { keyHashPrefix: next.keyHashPrefix, forced: true },
        forcedMove: true,
      };
    }
    // else: stale binding (keyHash gone from this boot's chain) — fall through
    // to the spread below; registry.execute would throw on the unknown prefix,
    // so recovery happens HERE, at the selection boundary, never as a 500.
  }

  // New-session spread — also the landing for expired and stale bindings.
  if (healthy.length === 0) return { forcedMove: false, reason: 'all-unhealthy' };
  const pick = healthy[accountSpreadIndex(ctx.sessionId, healthy.length)];
  return {
    credential: pick,
    forcedMove: false,
    // forced=true overwrites an expired/stale stored value; a genuinely unset
    // binding uses the first-write-wins path.
    bind: { keyHashPrefix: pick.keyHashPrefix, forced: bound !== undefined },
  };
}

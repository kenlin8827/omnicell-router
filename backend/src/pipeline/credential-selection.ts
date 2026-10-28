import crypto from 'node:crypto';
import type { CallCredential } from '../providers/base.js';
import type { CircuitBreakerManager } from '../resilience/circuit-breaker-manager.js';
import type { ModelRegistration } from '../config/types.js';
import type { ConversationSession } from '../session/session-manager.js';

/**
 * Per-request credential selection with session affinity.
 *
 *   switching is FORCED FAILOVER, never balancing
 *
 * Pure over (session binding, pair breaker state, suspect flags): it decides which
 * credential of a provider chain should serve one (session x model) call and
 * which affinity mutation the caller must PERSIST after a success. Persistence
 * lives with the caller (the orchestrator) precisely so a speculative move is
 * never written when the chosen credential then fails.
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
 * old credential cannot pull traffic back (correct by construction).
 */

/** Anthropic's default prompt-cache TTL (5 min, 2026-03-06) — the affinity window. */
export const DEFAULT_CREDENTIAL_AFFINITY_CACHE_TTL_MS = 300_000;

/** Why no credential was selected (never an error — each maps to a caller rule). */
export type CredentialSelectionReason =
  /** Provider has no registered chain (config.yaml/mock boot shape) — baked key path. */
  | 'no-chain'
  /**
   * Single-credential chain — today's byte-identical no-prefix path. NOT returned
   * when that one credential is operator-disabled: the no-prefix path would serve
   * the boot-baked key and route traffic the operator took down, so the takedown
   * outranks the degeneracy and 'all-disabled' is returned instead.
   */
  | 'single-credential'
  /** Every prefix is pair-OPEN or credential-SUSPECT — caller forces without attribution. */
  | 'all-unhealthy'
  /**
   * Every credential of this chain is operator-DISABLED. Unlike 'all-unhealthy'
   * this is NEVER forced: a takedown is a decision, not a guess about health, so
   * the caller must move on to another candidate even at the last position.
   */
  | 'all-disabled';

export interface CredentialSelection {
  /** Credential to pass to `registry.execute`; undefined = no prefix (legacy path). */
  credential?: CallCredential;
  /** Set only when this turn produced NO credential; explains which degeneracy applies. */
  reason?: CredentialSelectionReason;
  /**
   * Affinity mutation to persist AFTER the call succeeds:
   * forced=false -> first-write-wins bind; forced=true -> rebind (the bound
   * credential moved, or its stored prefix is stale/expired).
   */
  bind?: { keyHashPrefix: string; forced: boolean };
  /** True when this selection moved the session off its previously bound credential. */
  forcedMove: boolean;
}

export interface CredentialSelectionCtx {
  /** Session id the deterministic spread hashes over (conversation identity). */
  sessionId: string;
  /** Affinity window; default `DEFAULT_CREDENTIAL_AFFINITY_CACHE_TTL_MS`. */
  affinityWindowMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
  /**
   * Rate-limit shaping predicate: true = this credential is currently at a
   * local window cap (`credentials:` overlay). Applied ONLY to the new-session
   * spread and the forced-failover landing — NEVER to a kept binding, which a
   * local cap must not move (iron law: rebinding burns the prompt cache; the
   * provider's own 429, not a local hint, is what a bound session should
   * react to). When EVERY healthy credential is capped the filter opens again —
   * shaping never starves a provider that has no slack.
   * PURE READ: call sites peek without consuming; use `onSpreadCapped` (not a
   * side effect in this predicate) to observe a cap that actually shaped a
   * placement — the filter is consulted before the keep branch and must not
   * report a kept binding as steered-around.
   */
  spreadCapped?: (keyHashPrefix: string) => boolean;
  /**
   * Notifier for the shape that LANDED: called once per capped member that the
   * slack filter actually excluded from the spread pool (new-session spread and
   * forced-failover landing only; never when the all-capped filter re-opens,
   * never for a kept binding). Purely observational.
   */
  onSpreadCapped?: (keyHashPrefix: string) => void;
}

/**
 * Deterministic new-session spread index: sha256(sessionId) % count. Stable
 * across restarts and across callers; cold prefixes have nothing to lose, so
 * spreading new sessions is free (Decision 7). Exported so tests assert the
 * same function the resolver uses instead of duplicating the hash.
 *
 * With every weight equal to 1 this and weightedSpreadIndex below agree
 * exactly (total === count), so single-credential and unweighted chains keep
 * the pre-weight landing slots.
 */
export function credentialSpreadIndex(sessionId: string, count: number): number {
  if (count <= 1) return 0;
  const hex = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
  return parseInt(hex, 16) % count;
}

/**
 * Weighted twin of credentialSpreadIndex: the same hash draws a slot in
 * [0, Σweights), then walks the weight prefix sums. A credential weighing w
 * occupies w consecutive slots, so new-session traffic splits in proportion
 * to the weights while staying deterministic per sessionId. Callers pass
 * sanitized weights (integers >= 1) — every entry occupies at least one slot,
 * so the walk always terminates and the last index is the fallback.
 */
export function weightedSpreadIndex(sessionId: string, weights: readonly number[]): number {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 1) return 0;
  const hex = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
  const slot = parseInt(hex, 16) % total;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (slot < acc) return i;
  }
  return weights.length - 1;
}

export function selectCredential(
  session: ConversationSession | undefined,
  model: ModelRegistration,
  chain: readonly CallCredential[] | undefined,
  cb: CircuitBreakerManager,
  ctx: CredentialSelectionCtx
): CredentialSelection {
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

  // Rate-limit shaping: when a predicate exists, NEW placements (spread and
  // the forced-failover landing) prefer credentials with window slack; a kept
  // binding below never consults it (iron law). All-capped chain = filter
  // opens again — local shaping must never starve a provider of its own key.
  const spreadCapped = ctx.spreadCapped;
  const cappedSet = spreadCapped
    ? new Set(healthy.filter((c) => spreadCapped(c.keyHashPrefix)).map((c) => c.keyHashPrefix))
    : undefined;
  const withSlack = cappedSet
    ? healthy.filter((c) => !cappedSet.has(c.keyHashPrefix))
    : healthy;
  const spreadPool = withSlack.length > 0 ? withSlack : healthy;
  // The slack filter only SHAPED the landing when it actually excluded someone
  // (withSlack non-empty); the all-capped re-open is a no-op for the ledger.
  const notifyShaped = () => {
    if (!cappedSet || cappedSet.size === 0 || withSlack.length === 0) return;
    for (const c of healthy) if (cappedSet.has(c.keyHashPrefix)) ctx.onSpreadCapped?.(c.keyHashPrefix);
  };

  const bound = session?.boundKeyHashPrefix;
  const now = (ctx.now ?? Date.now)();
  const windowMs = ctx.affinityWindowMs ?? DEFAULT_CREDENTIAL_AFFINITY_CACHE_TTL_MS;
  // Lazy TTL expiry: idle past the cache window the prefix is re-billed anyway,
  // so the binding is treated as ABSENT and the session re-spreads like new.
  const boundLive = bound !== undefined && now - (session?.lastActiveAt ?? 0) <= windowMs;

  if (bound !== undefined && boundLive) {
    const kept = healthy.find((c) => c.keyHashPrefix === bound);
    if (kept) return { credential: kept, forcedMove: false };
    if (chain.some((c) => c.keyHashPrefix === bound)) {
      // FORCED failover — the bound credential is known-bad for this model.
      if (healthy.length === 0) return { forcedMove: false, reason: 'all-unhealthy' };
      const next = spreadPool[0]; // chain order = selection priority (active head first)
      notifyShaped();
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
  // Weights shape ONLY this placement; the forced-failover landing above
  // stays chain-order priority (ADR-0002).
  if (healthy.length === 0) return { forcedMove: false, reason: 'all-unhealthy' };
  const pick = spreadPool[weightedSpreadIndex(ctx.sessionId, spreadPool.map((c) => c.weight ?? 1))];
  notifyShaped();
  return {
    credential: pick,
    forcedMove: false,
    // forced=true overwrites an expired/stale stored value; a genuinely unset
    // binding uses the first-write-wins path.
    bind: { keyHashPrefix: pick.keyHashPrefix, forced: bound !== undefined },
  };
}

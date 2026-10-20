import { EFFORT_LADDER, ReasoningEffort, TierLevel, TIER_RANK } from '../types/router.js';
import { ReasonParams } from '../types/router.js';

/**
 * Retry detection + escalation planning (ADR-0011). A repeated prompt is the
 * user's "this answer wasn't good enough" signal; the planner turns it into a
 * monotonic quality step. Pure functions — all state lives on the
 * ConversationSession (`retry` block), all effects flow through the normal
 * ratchet/effort machinery. Nothing here touches a model or the network.
 *
 * Detection — ALL THREE conditions must hold (any miss = fresh question):
 *   1. the previous completed turn's response SUCCEEDED (a failed turn leaves
 *      no retry-state trace, so a technical resend never counts),
 *   2. the prompt is ≥ 20 normalized chars (single-word re-sends are noise),
 *   3. the normalized prompt hash equals the previous turn's.
 *
 * Ladder (frozen design; counts from what ACTUALLY served last turn):
 *   attempt 1 → same tier, effort + 1 (written into the request's
 *               reasoning_effort; the existing effort machinery translates
 *               and clamps it — never above what the model can serve);
 *   attempt 2+ → tier + 1, effort falls back to default;
 *   ceiling → ultra tier, then no further proposals.
 *
 * Capability ceiling (decision A3): when a pinned model cannot serve the
 * next effort level, the +1 step would clamp to a no-op — so the planner
 * JUMPS STRAIGHT to tier + 1 ("if thinking harder is impossible, get a
 * stronger thinker"). The pin itself is never broken for an effort step.
 */

/** Minimum normalized prompt length for the repeat to count as a retry. */
export const RETRY_MIN_PROMPT_CHARS = 20;

/** Per-session retry bookkeeping (stored on ConversationSession.retry). */
export interface SessionRetryState {
  /** Normalized-prompt hash of the last COMPLETED turn. */
  lastPromptHash?: string;
  /** Whether that turn's response completed successfully. */
  lastOutcomeOk?: boolean;
  /** What actually served: tier (post-failover truth) and effective effort. */
  lastTierUsed?: TierLevel;
  lastEffortUsed?: ReasoningEffort;
  /** Consecutive same-prompt attempts observed so far (0 = not a retry). */
  retryCount?: number;
  /** Whether THAT turn applied an escalation (feeds correction write-back). */
  escalated?: boolean;
}

export interface RetryDetection {
  isRetry: boolean;
  /** 1-based attempt number when isRetry, else 0. */
  attempt: number;
}

/** Pure three-condition check against the previous turn's recorded state. */
export function detectRetry(
  prev: SessionRetryState | undefined,
  currentHash: string | undefined
): RetryDetection {
  if (!currentHash || !prev?.lastPromptHash || prev.lastOutcomeOk !== true) {
    return { isRetry: false, attempt: 0 };
  }
  if (currentHash !== prev.lastPromptHash) {
    return { isRetry: false, attempt: 0 };
  }
  const attempt = (prev.retryCount ?? 0) + 1;
  return { isRetry: true, attempt };
}

/** Next rung up the effort ladder; undefined at the ceiling ('max'). */
export function nextEffort(effort: ReasoningEffort | undefined): ReasoningEffort | undefined {
  const idx = EFFORT_LADDER.indexOf(effort ?? 'none');
  if (idx < 0 || idx >= EFFORT_LADDER.length - 1) return undefined;
  return EFFORT_LADDER[idx + 1];
}

/** Next tier up; undefined at the 'ultra' ceiling. */
export function nextTier(tier: TierLevel): TierLevel | undefined {
  const rank = TIER_RANK[tier] ?? 2;
  const next = (Object.keys(TIER_RANK) as TierLevel[]).find((t) => (TIER_RANK[t] ?? 2) === rank + 1);
  return next;
}

export interface EscalationPlan {
  action: 'none' | 'effort' | 'tier';
  /** action='tier': the proposed (already ceiling-capped) tier. */
  tier?: TierLevel;
  /** action='effort': the requested effort to write into the request. */
  effort?: ReasoningEffort;
  reason: string;
  reasonCode: 'retry.effort' | 'retry.tier';
  reasonParams: ReasonParams;
}

export interface PlanInput {
  attempt: number;
  /** What actually served last turn (post-failover truth). */
  lastTierUsed: TierLevel;
  lastEffortUsed?: ReasoningEffort;
  /**
   * Effort levels the pinned model can serve (undefined = unknown — the
   * planner then assumes servable and lets the executor's clamp decide).
   */
  pinnedSupportedEfforts?: readonly ReasoningEffort[];
}

/**
 * One escalation step for the given attempt. Never proposes below the last
 * served tier, never past 'ultra'. The A3 capability jump lives here: an
 * effort level the pin cannot serve becomes a tier step instead.
 */
export function planEscalation(input: PlanInput): EscalationPlan {
  const { attempt, lastTierUsed, lastEffortUsed } = input;
  const params: ReasonParams = { attempt };

  if (attempt <= 1) {
    const candidate = nextEffort(lastEffortUsed);
    const servable =
      candidate !== undefined &&
      (!input.pinnedSupportedEfforts || input.pinnedSupportedEfforts.includes(candidate));
    if (servable && candidate) {
      return {
        action: 'effort',
        effort: candidate,
        reason: `Repeated prompt — raising reasoning effort to '${candidate}' on ${lastTierUsed}`,
        reasonCode: 'retry.effort',
        reasonParams: { ...params, tier: lastTierUsed, effort: candidate },
      };
    }
    // No next effort (ceiling) or the pin cannot serve it (A3 jump).
    const tier = nextTier(lastTierUsed);
    if (!tier) {
      return { action: 'none', reason: 'Repeated prompt — already at the ultra ceiling', reasonCode: 'retry.tier', reasonParams: params };
    }
    return {
      action: 'tier',
      tier,
      reason: `Repeated prompt — effort ceiling reached on ${lastTierUsed}, escalating tier to ${tier}`,
      reasonCode: 'retry.tier',
      reasonParams: { ...params, from: lastTierUsed, to: tier, cause: 'effort_ceiling' },
    };
  }

  // attempt >= 2: tier + 1, effort falls back to default.
  const tier = nextTier(lastTierUsed);
  if (!tier) {
    return { action: 'none', reason: 'Repeated prompt — already at the ultra ceiling', reasonCode: 'retry.tier', reasonParams: params };
  }
  return {
    action: 'tier',
    tier,
    reason: `Repeated prompt (attempt ${attempt}) — escalating tier ${lastTierUsed} → ${tier}`,
    reasonCode: 'retry.tier',
    reasonParams: { ...params, from: lastTierUsed, to: tier },
  };
}

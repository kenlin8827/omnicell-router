/**
 * Console session-row contract — the wire shape of `GET /api/admin/sessions`
 * and `GET /api/admin/sessions/:id` (ADR-0002 §3 "Console surface").
 *
 * Live rows (session entity + traces) and trace-reconstructed rows (after a
 * gateway restart: traces alone) both target this one shape, so the console can
 * never show two different vocabularies for the same table — and the frontend
 * `SessionRecord` mirrors it 1:1 by this name.
 *
 * WHY A WHITELIST, NEVER `...session`: `ConversationSession` is gateway-internal
 * routing state. `pinnedModel`/`pinnedProvider` are the session's ANCHOR — which
 * is NOT the model that last served it (a failover landing is) — and
 * `origin.clientIp` is a client fingerprint that no console surface asks for.
 * Spreading the entity published both; projecting field by field makes the next
 * internal field invisible by default instead of leaking on the next edit.
 */
import type { ConversationSession } from './session-manager.js';
import type { ExecutionTrace, TraceTracker } from '../trace/tracker.js';
import type { CaptureKeyIdentity } from '../capture/recorder.js';

/**
 * How the client addressed a session's turns, derived from persisted traces
 * (observability reconstruction — never routing state):
 * - 'auto'    : every turn named an auto alias (bare auto or a tier-forced
 *               lite/plus/pro/ultra) — the ratchet owns the tier.
 * - 'explicit': every turn named a concrete registered model — the client owns
 *               the choice, the tier column has no lock to show.
 * - 'combo'   : every turn went through a combo — the composition IS the
 *               decision; the executed member's tier is not a session ceiling.
 * - 'mixed'   : the conversation switched entry modes across turns.
 */
export type SessionEntryMode = 'auto' | 'explicit' | 'combo' | 'mixed';

/** Classify a session from its traces (chronological order irrelevant). */
export function deriveSessionEntryMode(traces: ExecutionTrace[]): SessionEntryMode {
  // Virtual auto aliases: bare auto plus the four tier-forced aliases
  // (lite/plus/pro/ultra). Routing runs these through the ratchet path (the
  // tier aliases rewrite force_tier before routing), so a tier-forced session
  // owns a tier lock — classifying it as explicit would strip the tier badge.
  const AUTO_ALIAS_MODELS = new Set(['auto', 'lite', 'plus', 'pro', 'ultra']);
  let sawAuto = false;
  let sawExplicit = false;
  let sawCombo = false;
  for (const t of traces) {
    // Combo turns are the only ones carrying this reasonCode (the orchestrator
    // sets it on the bypass decision and the trace copies it verbatim).
    if (t.routing?.reasonCode === 'combo') sawCombo = true;
    else {
      // Routing-name matching trims once while request.model is stored
      // verbatim (surface contract) — reconstruct the routing view, not the
      // bytes: a padded alias routed as the alias must classify as the alias.
      const requested = (t.request?.model ?? '').trim();
      if (!requested || AUTO_ALIAS_MODELS.has(requested)) sawAuto = true;
      else sawExplicit = true;
    }
  }
  if (Number(sawAuto) + Number(sawExplicit) + Number(sawCombo) !== 1) return 'mixed';
  return sawCombo ? 'combo' : sawExplicit ? 'explicit' : 'auto';
}

/**
 * The trace-derived half of a row, reused verbatim by both builders so a live
 * row and a reconstructed row can never aggregate differently.
 */
type SessionAggregates = ReturnType<TraceTracker['getSessionAggregates']>;

/**
 * The entity-only half of a row — the ONLY fields a live session entity may
 * contribute. `Pick` + an explicit literal makes the compiler reject both a
 * dropped field and a field that is not on the list, so the whitelist cannot
 * silently rot: adding an internal field to `ConversationSession` does not
 * publish it, and deleting one of these is a compile error, not a `undefined`
 * cell in the console.
 */
type SessionEntityView = Pick<
  ConversationSession,
  | 'id'
  | 'maxTier'
  | 'createdAt'
  | 'lastActiveAt'
  | 'turnCount'
  | 'historyTiers'
  | 'firstUserMessage'
  | 'boundKeyHashPrefix'
  | 'boundAt'
>;

/** Whitelist projection of a live session entity. Never spread the entity. */
export function projectSessionEntity(s: ConversationSession): SessionEntityView {
  return {
    id: s.id,
    maxTier: s.maxTier,
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
    turnCount: s.turnCount,
    historyTiers: s.historyTiers,
    firstUserMessage: s.firstUserMessage,
    boundKeyHashPrefix: s.boundKeyHashPrefix,
    boundAt: s.boundAt,
  };
}

/**
 * Execution view of a session: the model that actually served its LAST turn —
 * the registered id exactly as registered (`provider/model` for
 * catalog/tier-derived models, a bare id for hand-configured ones) — plus the
 * provider that served it, which is authoritative for both shapes. Deliberately
 * NOT the routing pin (ADR-0002 §3): a failover landing is not the session's
 * anchor, and a reconstructed row has no anchor at all. Both `null` when the
 * session has no trace yet (a session entity exists from birth, but only a
 * served turn produces a trace).
 */
interface CurrentModelView {
  currentModel: string | null;
  currentProvider: string | null;
}

/** Single source of the execution-view derivation (live + reconstructed). */
export function currentModelOf(traces: ExecutionTrace[]): CurrentModelView {
  const last = traces[traces.length - 1];
  return {
    currentModel: last?.execution.modelUsed ?? null,
    currentProvider: last?.execution.provider ?? null,
  };
}

/**
 * User-prompt turn count — the console "Turns" column. One per trace carrying
 * a NEW user prompt; the orchestrator blanks `userPromptSummary` on
 * tool-result continuations (lastUserIdx < prevMessageCount, orchestrator.ts),
 * so this never counts an agent tool loop's follow-up requests. The session
 * entity's own `turnCount` counts EVERY request — never display that number
 * next to `traceCount`, the two would always be equal.
 */
export function promptTurnsOf(traces: ExecutionTrace[]): number {
  return traces.reduce((n, t) => (t.request.userPromptSummary ? n + 1 : n), 0);
}

/**
 * Session title — the FIRST user prompt of the conversation, rendered under
 * the session id. One derivation for both row shapes: the traces carry it
 * (`request.firstUserSummary`, derived at birth and re-stamped on every later
 * turn), so a row rebuilt from traces alone (after a restart, or for a
 * combo/stateless session that never minted an entity) keeps its name instead
 * of rendering untitled. Traces written before the field existed fall back to
 * the opening turn's `userPromptSummary` — for a fresh conversation that IS
 * the first prompt; only a client replaying pre-existing history differs, and
 * there the replayed tail is the closest surviving value.
 */
export function sessionTitleOf(traces: ExecutionTrace[]): string | undefined {
  const first = traces[0];
  if (!first) return undefined;
  return first.request.firstUserSummary || first.request.userPromptSummary || undefined;
}

/** One console session row. */
export interface SessionRow extends SessionEntityView, SessionAggregates {
  /** Gateway-internal loopback row — derived from the id, never stored. */
  internal: boolean;
  entryMode: SessionEntryMode;
  currentModel: string | null;
  currentProvider: string | null;
  /** Distinct client API-key identities, write order (first = display anchor). */
  apiKeys?: CaptureKeyIdentity[];
  /** Distinct client User-Agents, write order (console display only). */
  clients?: string[];
}

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
import type { CallCredential } from '../opencode/credentials/types.js';
import type { ClientConversationRef, ConversationSession } from './session-manager.js';
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

/**
 * Who MINTED a session's id — the other half of "why does this id look like
 * that". The gateway only mints at cold start (`sess_` + 16 hex); every
 * earlier identity layer adopts a value the CLIENT chose (explicit session
 * header, an embedded metadata.user_id UUID, the OpenAI `user` field, or a
 * vendor `x-<app>-session-id` header). Without this marker an operator cannot
 * tell a gateway id from a client id in the session table — the ids
 * themselves carry no reliable shape (a vendor header may be any string, and
 * older gateway ids keep resolving by design).
 */
export type SessionIdSource = 'gateway' | 'client';

/**
 * Identity layers that adopt a client-minted value as the session id. Every
 * other layer (`cold_start`, the content anchors, `conversation_key`, the
 * `client_ref` alias) resolves an id the GATEWAY minted — the alias binds a
 * gateway session, it does not rename one. Keep this set in sync with
 * `SessionLookupType` (types/router.ts) and the resolver's layer comments.
 */
const CLIENT_NAMED_LOOKUP_TYPES: ReadonlySet<string> = new Set([
  'explicit_header',   // 1. x-session-id / x-conversation-id / router_options.session_id
  'embedded_user_id',  // 2. Claude Code metadata.user_id → cc_<uuid>
  'request_user',      // 3. bare OpenAI request.user
  'header_fallback',   // 9. vendor x-<app>-session-id rename of a fresh mint
]);

/**
 * Derive the id's minting side from the BIRTH lookup type (the entity's
 * `origin.lookupType` when live, else the earliest trace's
 * `routing.sessionLookupType`). Birth is the right turn: later turns re-resolve
 * the same id through content anchors, so reading the last turn would report
 * `prefix_chain` for a session the client actually named. `undefined` when no
 * turn ever recorded a lookup type (traces replayed from before the field
 * existed) — the console then prints no marker rather than a guess.
 */
export function sessionIdSourceOf(
  traces: ExecutionTrace[],
  birthLookupType?: string
): SessionIdSource | undefined {
  const lookup = birthLookupType || traces[0]?.routing?.sessionLookupType;
  if (!lookup) return undefined;
  return CLIENT_NAMED_LOOKUP_TYPES.has(lookup) ? 'client' : 'gateway';
}

/** One console session row. */
export interface SessionRow extends SessionEntityView, SessionAggregates {
  /** Gateway-internal loopback row — derived from the id, never stored. */
  internal: boolean;
  entryMode: SessionEntryMode;
  /**
   * Which side minted `id` (see SessionIdSource). Both row shapes derive it the
   * same way, so a restart cannot flip the marker. Null when no trace carries a
   * lookup type — the console then renders the id alone.
   */
  idSource: SessionIdSource | null;
  currentModel: string | null;
  currentProvider: string | null;
  /**
   * Operator-set label of the credential `boundKeyHashPrefix` names. The
   * session entity stores only the display-safe prefix — labels are
   * credential-store metadata — so the route resolves this against the LIVE
   * registry chain at serialization time. Absent means unnamed or no longer
   * in that provider's chain; the console then falls back to the prefix.
   */
  boundCredentialLabel?: string;
  /** Distinct client API-key identities, write order (first = display anchor). */
  apiKeys?: CaptureKeyIdentity[];
  /** Distinct client User-Agents, write order (console display only). */
  clients?: string[];
  /**
   * Client-minted conversation ids seen on this session's turns (write order,
   * first = display anchor), derived from the traces' `request.clientRef`. The
   * session id above stays the gateway id: this is the OTHER side of the
   * mapping, shown beside it so an operator can correlate the two namespaces
   * (and search by either). Absent when the client never sent one.
   */
  clientRefs?: ClientConversationRef[];
}

/**
 * Operator label for a bound credential, matched against the serving
 * provider's LIVE registry chain at serialization time. The session entity
 * persists only the display-safe `boundKeyHashPrefix` (ADR-0002 §3); labels
 * are credential-store metadata that can be renamed without touching any
 * session, so the join happens on read. `undefined` = unnamed credential, no
 * chain (mock/stub or provider gone), or the credential left the chain — the
 * console then falls back to the prefix.
 */
export function boundCredentialLabelOf(
  chain: readonly CallCredential[] | undefined,
  keyHashPrefix: string | undefined
): string | undefined {
  if (!keyHashPrefix) return undefined;
  const label = chain?.find(c => c.keyHashPrefix === keyHashPrefix)?.label?.trim();
  return label || undefined;
}

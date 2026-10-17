import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ChatCompletionRequest } from '../types/openai.js';
import { RoutingDecision, SessionLookupType, TierLevel, TierModelConfig, TIER_RANK } from '../types/router.js';
import { SessionConfig } from '../config/types.js';

export interface ConversationSession {
  id: string;
  maxTier: TierLevel;
  pinnedModel: string;
  pinnedProvider: string;
  createdAt: number;
  lastActiveAt: number;
  turnCount: number;
  historyTiers: TierLevel[];
  /** Birth metadata — attached once on the first turn, immutable afterwards. */
  origin?: {
    wire?: string;
    lookupType?: SessionLookupType;
    clientIp?: string;
  };
  /** First ~200 chars of the first user message (UI identification aid). */
  firstUserMessage?: string;
  /**
   * Session↔account affinity binding (sha256 key-hash
   * prefix, Decision 5 identity; display-safe, never key material). Written
   * once by the first successful routed turn, overwritten only by a FORCED
   * failover (bound pair breaker OPEN / account SUSPECT / stale prefix). A binding
   * older than the affinity window (circuitBreaker.accountAffinity.cacheTtlMs,
   * read against lastActiveAt) is treated ABSENT at selection — lazy expiry,
   * no timer, and independent of the session ttlSeconds machinery.
   */
  boundKeyHashPrefix?: string;
  /** Epoch ms of the bind/rebind (observability; expiry reads lastActiveAt). */
  boundAt?: number;
}

export interface SessionResolveResult {
  sessionId: string;
  lookupType: SessionLookupType;
}

/**
 * Client identity inputs for zero-header resolution. Deliberately NOT the
 * transport IP: on a local gateway every conversation shares `127.0.0.1`/`::1`
 * (the address adds no discrimination, and IPv4/IPv6 flapping actively broke
 * re-anchoring). The API-key identity (`sk-ocr-*` entry id) is the stable
 * per-application anchor; key-less legs (MITM tunnel, master key) pass no
 * `keyId` and their conversation keys simply scope to '' (content-only).
 */
export interface SessionIdentity {
  keyId?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * The assistant echo registered after a completed turn. The orchestrator
 * passes the served response message (content + tool_calls); a bare string is
 * accepted for content-only registrations (tests, legacy callers).
 */
export interface AssistantEcho {
  content?: unknown;
  tool_calls?: unknown;
}

// Memory/safety bounds — intentionally NOT config-exposed: they tune memory,
// not product behavior.
const TAIL_WINDOW = 8;             // messages per registered tail window
const MAX_CHAIN_PROBES = 32;       // assistant boundaries examined per resolve
const MAX_TAIL_PROBES = 256;       // window probes examined per resolve
const MAX_CHAIN_ENTRIES = 200_000; // global FIFO caps
const MAX_TAIL_ENTRIES = 100_000;
const MAX_CONVKEY_ENTRIES = 50_000;
const CANDIDATE_CAP = 3;           // sessions a single conversation key may claim
const ANCHOR_HEX = 20;             // anchor digest length
const CONVERSATION_KEY_HEX = 24;   // conversation-key digest length
const PERSIST_SAVE_DEBOUNCE_MS = 2_000;

/**
 * Session Monotonic Ratchet Manager
 *
 * Core Objectives:
 * 1. Eliminate mid-conversation model downgrades caused by short follow-up questions
 *    ("thanks", "fix this line") to prevent intellectual degradation.
 * 2. Protect upstream Provider KV Prompt Caching from being invalidated due to model thrashing,
 *    maximizing FinOps cost savings (80%-95%).
 * 3. Support zero-header session tracking for standard clients via layered
 *    identity resolution (see resolveSessionId).
 *
 * Zero-header identity resolution (in priority order):
 *   1. Explicit header / router_options.session_id.
 *   2. Embedded client session UUID — Claude Code sends metadata.user_id as
 *      either the legacy string "user_{hash}_account_{uuid}_session_{uuid}"
 *      or the 2.x JSON payload {"device_id":...,"account_uuid":...,
 *      "session_id":"<uuid>"}; the inner UUID is a client-minted conversation
 *      id that survives gateway restarts for free. Both shapes share the cc_
 *      prefix (same conversation-uuid namespace).
 *   3. Raw request.user (OpenAI end-user field; NOTE: user-scoped, not
 *      conversation-scoped — kept for backward compatibility).
 *   4. Chain anchors — exact hash of the current history's head prefixes that
 *      end at an assistant message (turn 2+ fast path; also matches branched /
 *      regenerated histories sharing the head). Serialized in CANONICAL form
 *      (see serializeMessage): clients rewrite assistant bytes on resend
 *      (drop `type`, re-compact tool-call argument JSON), so raw-object hashing
 *      missed every tool-call boundary — a whole agent tool loop re-minted a
 *      fresh session every turn.
 *   5. Tail anchors — hashes of trailing windows (length 3..TAIL_WINDOW, always
 *      ending at an assistant message) of completed chains (clients that
 *      truncate old turns to fit their context window resend a registered
 *      suffix; the 3-message minimum keeps generic short exchanges from
 *      cross-matching unrelated conversations — see probeTailAnchors).
 *   6. Conversation key (turn 2+ only) — sha256(apiKey identity + FULL first
 *      user message). Reaches ONLY after the byte-exact anchors miss (a
 *      regenerated assistant rewrite), and rejoins its session ONLY when the
 *      key has exactly one candidate (unambiguous). Two live sessions sharing a
 *      byte-identical first message make the key ambiguous → it splits (cold
 *      start) rather than false-merge. False split self-heals (the branches get
 *      their own anchors); false merge never does — so the split stays safe.
 *      This is keyed on the API-key identity (not the transport IP, which flaps
 *      between `127.0.0.1`/`::1` and adds nothing on a local gateway) and keeps
 *      a bounded newest-first candidate list instead of poisoning an ambiguous
 *      key. The earlier first-message-root-map design short-circuited turn-1
 *      shapes straight to mint and tombstoned the key on the first same-opening
 *      resend; combined with tool-call byte drift (below) every later turn fell
 *      through to the poisoned key and minted a fresh id — cascading one
 *      conversation into dozens of session ids. The full history is in
 *      ADR-0002.
 *   7. Cold start — mint `sess_<24 random hex>` and claim the conversation key.
 *      A turn-1-shaped resend (retry / harness re-fork, no assistant yet) ALWAYS
 *      mints a distinct id (preserving the no-false-merge guarantee); it
 *      self-heals from turn 2 when the branches get their own anchors.
 *      Deterministic birth ids are rejected: they collide across conversations
 *      sharing boilerplate openings on a local gateway.
 *
 * Anchors and conversation keys persist to disk when a `persistPath` is wired
 * (per-environment data dir): a gateway restart no longer splits non-
 * cooperating clients. Session objects themselves (ratchet tier, pins,
 * affinity bindings) stay in-memory — after restart the conversation
 * re-joins its id but state rebuilds fresh. Full summarization rewrites match
 * nothing and intentionally start a new session.
 */
export class SessionManager {
  private config: SessionConfig;
  private sessions = new Map<string, ConversationSession>();
  private chainAnchors = new Map<string, string>();  // 'C'-salted head-prefix hash -> sessionId
  private tailAnchors = new Map<string, string>();   // 'T'-salted trailing-window hash -> sessionId
  private convKeys = new Map<string, string[]>();    // conversation key -> candidate session ids, newest first
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly persistPath?: string;
  private dirty = false;
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(config?: SessionConfig, persistPath?: string) {
    this.config = {
      enabled: config?.enabled ?? true,
      strategy: config?.strategy ?? 'monotonic',
      ttlSeconds: config?.ttlSeconds ?? 3600,
      maxSessions: config?.maxSessions ?? 10000,
    };
    this.ttlMs = (this.config.ttlSeconds || 3600) * 1000;
    this.maxSessions = this.config.maxSessions || 10000;
    this.persistPath = persistPath;
    if (persistPath) this.loadPersisted();
  }

  /**
   * Canonical per-message serialization. MUST stay byte-stable: anchor keys
   * are only ever compared against keys produced by this same function.
   *
   * CANONICAL — not raw-object — fidelity, on purpose. Tool results, ids and
   * names are still fully hashed (a pure tool-call assistant turn must never
   * serialize identically to a different one — lossy hashing gives two
   * distinct conversations identical anchor keys, the false-merge direction),
   * but the encoding of each field is normalized to what survives a client
   * round-trip:
   *   - `content`: null/undefined/'' collapse to ''; text parts join; other
   *     parts hash verbatim as JSON.
   *   - `tool_calls`: only (id, function.name, function.arguments) enter the
   *     key, and `arguments` is JSON-parsed then re-stringified compact —
   *     real harnesses strip `"type":"function"` and re-compact pretty JSON
   *     arguments on resend, so raw JSON.stringify of the whole object would
   *     miss every tool-call boundary on the next turn.
   */
  private static serializeMessage(m: any): string {
    const role = m.role || 'user';
    let extra = '';
    if (m.name) extra += `|name:${m.name}`;
    if (m.tool_call_id) extra += `|tcid:${m.tool_call_id}`;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      extra += `|tcs:${SessionManager.toolCallsText(m.tool_calls)}`;
    }
    return `${role}:${SessionManager.contentText(m.content)}${extra}`;
  }

  /** Normalized text form of a message content field (string / parts / null). */
  private static contentText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (content === null || content === undefined) return '';
    if (Array.isArray(content)) {
      return content.map((p: any) => {
        if (p && typeof p === 'object') {
          return typeof p.text === 'string'
            ? `text:${p.text}`
            : `${p.type || 'part'}:${JSON.stringify(p)}`;
        }
        return String(p ?? '');
      }).join(' ');
    }
    return JSON.stringify(content);
  }

  private static toolCallsText(toolCalls: any[]): string {
    return toolCalls
      .map(tc => {
        const fn = tc?.function ?? {};
        return `${String(tc?.id ?? '')}\u0000${String(fn.name ?? '')}\u0000${SessionManager.canonicalToolArgs(fn.arguments)}`;
      })
      .join('\u0001');
  }

  /** Re-compact a JSON arguments string; non-JSON strings trim, others stringify. */
  private static canonicalToolArgs(a: unknown): string {
    if (typeof a === 'string') {
      try {
        return JSON.stringify(JSON.parse(a));
      } catch {
        return a.trim();
      }
    }
    if (a && typeof a === 'object') return JSON.stringify(a);
    return '';
  }

  /**
   * Salted hash of a message window. Salt isolates the anchor families from
   * each other so the same message slice can never cross-match.
   */
  public static hashWindow(messages: any[], salt: string): string {
    const h = crypto.createHash('sha256');
    h.update(salt);
    for (const m of messages) {
      h.update(SessionManager.serializeMessage(m));
      h.update('\n---\n');
    }
    return h.digest('hex').slice(0, ANCHOR_HEX);
  }

  /**
   * Deterministic conversation key: apiKey identity (or '' for key-less legs)
   * + FULL first user message (no truncation — prefix cuts of boilerplate
   * first messages were a collision source). No transport IP: it adds nothing
   * on a local gateway and IPv4/IPv6 flapping actively broke re-anchoring.
   * Returns null when the history carries no first user text (nothing to key
   * on — resolution then rides the anchors / mint path alone).
   */
  public static conversationKey(messages: any[], keyId?: string): string | null {
    const firstUser = (messages || []).find((m: any) => m?.role === 'user');
    if (!firstUser) return null;
    const text = SessionManager.contentText(firstUser.content).trim();
    if (!text) return null;
    return crypto
      .createHash('sha256')
      .update(`K\u0000${keyId ?? ''}\u0000${text}`)
      .digest('hex')
      .slice(0, CONVERSATION_KEY_HEX);
  }

  private static assistantIndices(messages: any[]): number[] {
    const idx: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.role === 'assistant') idx.push(i);
    }
    return idx;
  }

  /**
   * Extract a client-embedded conversation id from a user identifier string.
   * Recognizes both Claude Code identity payload shapes (metadata.user_id):
   *   1. Legacy convention — `user_{hex hash}_account_{uuid}_session_{uuid}`
   *      (the same extraction peer gateways perform for observability tooling).
   *   2. Claude Code 2.x JSON payload — `{"device_id":"<hex>","account_uuid":
   *      "<uuid or empty>","session_id":"<uuid>"}` (observed on
   *      claude-cli/2.1.211). The inner session_id lives in the SAME
   *      conversation-uuid namespace, so both shapes map onto the shared
   *      `cc_` prefix and one conversation keeps a single session id across
   *      client builds. Recognition mirrors the console's formatSessionId:
   *      any JSON object carrying a non-empty string session_id — an
   *      ordinary user-level id cannot accidentally look like that.
   * The whole shape must match: a loose "_session_" suffix match would
   * promote ordinary user-level ids that merely contain that marker to
   * session level, falsely merging every conversation of that user. False
   * exclusion is the safe direction — such ids fall through to the
   * user-level layer and the chain anchors re-acquire the conversation from
   * turn 2 (self-healing false split).
   */
  private static extractEmbeddedSessionId(user?: unknown): string | null {
    if (!user || typeof user !== 'string') return null;
    const trimmed = user.trim();
    const m = /^user_[0-9a-f]{8,64}_account_[0-9a-f-]{8,64}_session_([0-9a-f-]{8,64})$/i.exec(trimmed);
    if (m) return `cc_${m[1]}`;
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as { session_id?: unknown };
        if (parsed && typeof parsed === 'object' && typeof parsed.session_id === 'string' && parsed.session_id) {
          return `cc_${parsed.session_id}`;
        }
      } catch {
        /* not JSON — fall through to the user-level layers */
      }
    }
    return null;
  }

  /**
   * Seamless Session Resolver — see the class doc for the full priority list.
   */
  public resolveSessionId(
    request: ChatCompletionRequest,
    identity?: SessionIdentity
  ): SessionResolveResult {
    // 1. Explicit Header Probe
    const explicitHeader =
      identity?.headers?.['x-session-id'] ||
      identity?.headers?.['x-conversation-id'] ||
      identity?.headers?.['session-id'] ||
      identity?.headers?.['conversation-id'];

    if (explicitHeader) {
      const id = Array.isArray(explicitHeader) ? explicitHeader[0] : explicitHeader;
      return { sessionId: id.trim(), lookupType: 'explicit_header' };
    }

    // 2. Explicit router_options.session_id
    if (request.router_options?.session_id) {
      return { sessionId: request.router_options.session_id.trim(), lookupType: 'explicit_header' };
    }

    // 3. Embedded client session UUID (Claude Code metadata.user_id)
    const embedded = SessionManager.extractEmbeddedSessionId(request.user);
    if (embedded) {
      return { sessionId: embedded, lookupType: 'embedded_user_id' };
    }

    // 4. OpenAI Native request.user Probe
    if (request.user && typeof request.user === 'string' && request.user.trim()) {
      return { sessionId: request.user.trim(), lookupType: 'request_user' };
    }

    const messages = request.messages || [];
    const priorHistory = messages.slice(0, -1);
    const key = SessionManager.conversationKey(messages, identity?.keyId);

    // Cold start: nothing to anchor on — either a literal turn 1 (single
    // message) or harness turn 1 ([system, user]: no completed exchange yet).
    // A turn-1-shaped resend ALWAYS mints a distinct id (two conversations
    // sharing a byte-identical first message must not false-merge — the split
    // self-heals from turn 2 when the branches get their own anchors).
    if (messages.length < 2 || !priorHistory.some(m => m?.role === 'assistant')) {
      return this.mintColdStart(key);
    }

    // 5/6. Byte-exact anchor evidence (turn 2+ fast paths). Anchors carry the
    // strongest evidence, so they run first on resends that contain a completed
    // exchange and disambiguate conversations sharing a conversation key.
    const anchor = this.probeChainAnchors(priorHistory) ?? this.probeTailAnchors(priorHistory);
    if (anchor) {
      // Keep the conversation-key claim in sync: a client whose history is
      // truncated NEXT turn (first message gone) re-anchors through this fresh
      // key against the same session even if the window probes miss.
      if (key) this.claimConvKey(key, anchor.sessionId);
      return anchor;
    }

    // 7. Conversation key (turn 2+, anchors already missed — e.g. regenerated
    // assistant bytes). Rejoin ONLY when the key is unambiguous (single
    // candidate). Two live sessions under one key = an ambiguous opening:
    // split (fresh mint) rather than risk a false merge.
    if (key) {
      const candidates = this.convKeys.get(key);
      if (candidates && candidates.length === 1) {
        return { sessionId: candidates[0], lookupType: 'conversation_key' };
      }
    }

    // 8. Nothing to anchor on: fresh mint + claim.
    return this.mintColdStart(key);
  }

  private probeChainAnchors(priorHistory: any[]): SessionResolveResult | null {
    const boundaries = SessionManager.assistantIndices(priorHistory);
    let probes = 0;
    for (let b = boundaries.length - 1; b >= 0 && probes < MAX_CHAIN_PROBES; b--, probes++) {
      const hash = SessionManager.hashWindow(priorHistory.slice(0, boundaries[b] + 1), 'C');
      const hit = this.chainAnchors.get(hash);
      if (hit) return { sessionId: hit, lookupType: 'prefix_chain' };
    }
    return null;
  }

  private probeTailAnchors(priorHistory: any[]): SessionResolveResult | null {
    const boundaries = SessionManager.assistantIndices(priorHistory);
    let probes = 0;
    for (let b = boundaries.length - 1; b >= 0 && probes < MAX_TAIL_PROBES; b--) {
      const end = boundaries[b];
      const startMin = Math.max(0, end - TAIL_WINDOW + 1);
      // Windows are length >= 3 and always end at the boundary, so a probe
      // key always carries an assistant message PLUS a distinguishing third
      // message. Length-2 windows ([user, assistant]) are location-free keys
      // whose content can be byte-identical across conversations of the same
      // harness (generic exchanges like "continue" / "ok") — a false-merge
      // vector. The extra message flips that failure into a conversation-key
      // continuation (same-app same-opening merge is the accepted policy).
      for (let s = end - 2; s >= startMin && probes < MAX_TAIL_PROBES; s--, probes++) {
        const hash = SessionManager.hashWindow(priorHistory.slice(s, end + 1), 'T');
        const hit = this.tailAnchors.get(hash);
        if (hit) return { sessionId: hit, lookupType: 'tail_anchor' };
      }
    }
    return null;
  }

  /**
   * Mint a fresh session id with random entropy (collision-free by
   * construction) and claim the conversation key so later turns re-anchor
   * through content alone (retries, regenerated assistant bytes).
   */
  private mintColdStart(key: string | null): SessionResolveResult {
    const sessionId = 'sess_' + crypto.randomBytes(12).toString('hex');
    if (key) this.claimConvKey(key, sessionId);
    return { sessionId, lookupType: 'cold_start' };
  }

  /**
   * Claim a conversation key for a session: newest-first, bounded to
   * CANDIDATE_CAP entries, deduped. No tombstone semantics — ambiguity keeps
   * a small candidate list instead of poisoning the key, because the
   * byte-exact anchors disambiguate live and a poisoned key cascaded whole
   * tool loops into per-turn mints.
   */
  private claimConvKey(key: string, sessionId: string): void {
    if (!this.config.enabled || this.config.strategy === 'stateless') return;
    const list = this.convKeys.get(key);
    if (list && list[0] === sessionId) return; // already the head claim — no churn
    const next = [sessionId, ...(list ?? []).filter(s => s !== sessionId)].slice(0, CANDIDATE_CAP);
    this.setBounded(this.convKeys, key, next, MAX_CONVKEY_ENTRIES);
    this.markDirty();
  }

  /** FIFO-bounded map set (Map preserves insertion order). */
  private setBounded<V>(map: Map<string, V>, key: string, value: V, cap: number): void {
    if (map.has(key)) map.delete(key); // refresh insertion order
    map.set(key, value);
    while (map.size > cap) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /**
   * Applies the Monotonic Session Ratchet policy.
   *
   * - Upgrade (T_proposed > T_session): Allowed. Upgrades tier and pins new model instance.
   * - Downgrade (T_proposed <= T_session): Blocked. Enforces historical peak tier and reuses pinned model.
   */
  public applyRatchet(
    sessionId: string,
    proposedDecision: RoutingDecision,
    resolveModelForTier: (tier: TierLevel) => TierModelConfig,
    opts?: { allowIntercept?: boolean }
  ): {
    finalDecision: RoutingDecision;
    session: ConversationSession;
    ratchetApplied: boolean;
  } {
    this.cleanupExpiredSessions();

    if (!this.config.enabled || this.config.strategy === 'stateless') {
      const dummyModel = resolveModelForTier(proposedDecision.targetTier);
      return {
        finalDecision: proposedDecision,
        session: {
          id: sessionId,
          maxTier: proposedDecision.targetTier,
          pinnedModel: dummyModel.id,
          pinnedProvider: dummyModel.provider,
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          turnCount: 1,
          historyTiers: [proposedDecision.targetTier],
        },
        ratchetApplied: false,
      };
    }

    const now = Date.now();
    let session = this.sessions.get(sessionId);

    // 1. Initialize new session
    if (!session) {
      const initialModel = resolveModelForTier(proposedDecision.targetTier);
      session = {
        id: sessionId,
        maxTier: proposedDecision.targetTier,
        pinnedModel: initialModel.id,
        pinnedProvider: initialModel.provider,
        createdAt: now,
        lastActiveAt: now,
        turnCount: 1,
        historyTiers: [proposedDecision.targetTier],
      };
      this.sessions.set(sessionId, session);

      return {
        finalDecision: proposedDecision,
        session,
        ratchetApplied: false,
      };
    }

    // 2. Existing session handling
    const currentMaxRank = TIER_RANK[session.maxTier] || 2;
    const proposedRank = TIER_RANK[proposedDecision.targetTier] || 2;

    // Explicit-user-choice mode (allowIntercept=false): the turn is recorded
    // and a higher proposed tier still escalates the ceiling, but the session
    // NEVER rewrites the proposed tier (no sticky lock, no downgrade
    // interception) — the client named exactly what to run.
    const intercept = opts?.allowIntercept !== false;

    if (this.config.strategy === 'sticky') {
      session.turnCount++;
      session.lastActiveAt = now;
      session.historyTiers.push(session.maxTier);

      if (!intercept) {
        return { finalDecision: proposedDecision, session, ratchetApplied: false };
      }

      return {
        finalDecision: {
          ...proposedDecision,
          targetTier: session.maxTier,
          reason: `[Session Sticky] Kept this conversation at ${session.maxTier} (model: ${session.pinnedModel})`,
          // Session rewrites overwrite code+params so post-rewrite traces
          // carry the session.* vocabulary, not the pre-rewrite layer code.
          reasonCode: 'session.sticky',
          reasonParams: { tier: session.maxTier, model: session.pinnedModel },
        },
        session,
        ratchetApplied: proposedDecision.targetTier !== session.maxTier,
      };
    }

    // 3. Monotonic Ratchet strategy
    if (proposedRank > currentMaxRank) {
      // 3A. Escalation triggered (e.g. lite -> plus or plus -> pro)
      const oldTier = session.maxTier;
      session.maxTier = proposedDecision.targetTier;
      const upgradedModel = resolveModelForTier(session.maxTier);
      session.pinnedModel = upgradedModel.id;
      session.pinnedProvider = upgradedModel.provider;
      session.turnCount++;
      session.lastActiveAt = now;
      session.historyTiers.push(session.maxTier);

      return {
        finalDecision: {
          ...proposedDecision,
          reason: `[Session Escalated: ${oldTier} -> ${session.maxTier}] ${proposedDecision.reason}`,
          reasonCode: 'session.escalated',
          reasonParams: { from: oldTier, to: session.maxTier },
        },
        session,
        ratchetApplied: true,
      };
    } else {
      // 3B. Downgrade intercepted
      const isDowngradeAttempt = proposedRank < currentMaxRank;
      session.turnCount++;
      session.lastActiveAt = now;
      session.historyTiers.push(session.maxTier);

      if (!intercept) {
        return { finalDecision: proposedDecision, session, ratchetApplied: false };
      }

      const ratchetReason = isDowngradeAttempt
        ? `[Session Monotonic Ratchet] Kept this conversation at its peak ${session.maxTier} (model: ${session.pinnedModel}); this turn asked for ${proposedDecision.targetTier}`
        : `[Session Preserved] Kept this conversation at ${session.maxTier} (model: ${session.pinnedModel})`;

      return {
        finalDecision: {
          ...proposedDecision,
          targetTier: session.maxTier,
          reason: ratchetReason,
          reasonCode: isDowngradeAttempt ? 'session.ratchet' : 'session.preserved',
          reasonParams: isDowngradeAttempt
            ? { from: session.maxTier, to: proposedDecision.targetTier }
            : { tier: session.maxTier },
        },
        session,
        ratchetApplied: isDowngradeAttempt,
      };
    }
  }

  /**
   * Post-turn registration. Builds two anchor families over the completed
   * chain (requestMessages + the served assistant echo; the orchestrator
   * passes the PRE-compression fingerprint so keys are derived from original
   * client bytes — see orchestrator step 2B):
   *
   * - Chain anchors: hash of every head prefix ending at an assistant
   *   message. One chained-hashing pass (copy() per boundary).
   * - Tail anchors: every length-2..TAIL_WINDOW window of the trailing
   *   TAIL_WINDOW messages that ends at an assistant message. These are what
   *   let a truncated history (client dropped old turns) find its way back.
   *
   * The assistant echo keeps tool_calls (in canonical serialization) —
   * dropping them made every tool-call boundary of an agent loop unmatchable.
   */
  public registerCompletedTurn(
    sessionId: string,
    requestMessages: any[],
    assistant: string | AssistantEcho | null | undefined
  ): void {
    if (!this.config.enabled || this.config.strategy === 'stateless') return;

    try {
      const echo: any =
        typeof assistant === 'string' || assistant == null
          ? { role: 'assistant', content: assistant ?? '' }
          : { role: 'assistant', content: assistant.content ?? '', tool_calls: assistant.tool_calls };
      const chain = [...(requestMessages || []), echo];

      // Chain anchors — single pass with per-boundary copy().
      const hasher = crypto.createHash('sha256');
      hasher.update('C');
      for (let i = 0; i < chain.length; i++) {
        hasher.update(SessionManager.serializeMessage(chain[i]));
        hasher.update('\n---\n');
        if (chain[i]?.role === 'assistant') {
          const digest = hasher.copy().digest('hex').slice(0, ANCHOR_HEX);
          this.setBounded(this.chainAnchors, digest, sessionId, MAX_CHAIN_ENTRIES);
        }
      }

      // Tail anchors — suffix windows (length 3..TAIL_WINDOW, always ending
      // at an assistant boundary) of the trailing TAIL_WINDOW messages.
      const tail = chain.slice(-TAIL_WINDOW);
      for (const end of SessionManager.assistantIndices(tail)) {
        const startMin = Math.max(0, end - TAIL_WINDOW + 1);
        for (let s = end - 2; s >= startMin; s--) {
          const hash = SessionManager.hashWindow(tail.slice(s, end + 1), 'T');
          this.setBounded(this.tailAnchors, hash, sessionId, MAX_TAIL_ENTRIES);
        }
      }

      this.markDirty();
      const session = this.sessions.get(sessionId);
      if (session) {
        session.lastActiveAt = Date.now();
      }
    } catch {
      // Graceful error handling: session tracking must never break routing.
    }
  }

  /**
   * Attach birth metadata to a session. First write wins — origin is
   * immutable, exactly like the session id it describes. Later calls with
   * different values are ignored (no metadata drift).
   */
  public attachOrigin(
    sessionId: string,
    origin: { wire?: string; lookupType?: SessionLookupType },
    clientIp?: string,
    firstUserMessage?: string
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.origin) return;
    session.origin = { ...origin, ...(clientIp ? { clientIp } : {}) };
    if (firstUserMessage && !session.firstUserMessage) {
      session.firstUserMessage = firstUserMessage.slice(0, 200);
    }
  }

  /**
   * Bind a session to one credential account.
   * First-write-wins (like attachOrigin): selection NEVER re-balances a live
   * binding; only `rebindAccount` (forced failover) may overwrite it. Expired
   * bindings are overwritten by a forced rebind too (the stale value must not
   * outlive the account it names).
   * @returns true when this call created the binding.
   */
  public bindAccount(sessionId: string, keyHashPrefix: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.boundKeyHashPrefix) return false;
    session.boundKeyHashPrefix = keyHashPrefix;
    session.boundAt = Date.now();
    return true;
  }

  /**
   * FORCED account move (bound pair breaker OPEN / account SUSPECT / stale prefix).
   * Never called for balancing — the caller only rebinds after the new
   * account actually served (switching is forced failover).
   */
  public rebindAccount(sessionId: string, keyHashPrefix: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.boundKeyHashPrefix = keyHashPrefix;
    session.boundAt = Date.now();
    return true;
  }

  public getSession(sessionId: string): ConversationSession | undefined {
    return this.sessions.get(sessionId);
  }

  public getAllSessions(): ConversationSession[] {
    return Array.from(this.sessions.values());
  }

  public deleteSession(sessionId: string): boolean {
    const existed = this.sessions.delete(sessionId);
    // Purge anchor keys pointing at the deleted session. Scans are O(map) but
    // deletes are rare (manual UI delete / eviction at maxSessions capacity).
    for (const map of [this.chainAnchors, this.tailAnchors]) {
      for (const [hash, sessId] of map.entries()) {
        if (sessId === sessionId) map.delete(hash);
      }
    }
    for (const [key, list] of this.convKeys.entries()) {
      const kept = list.filter(s => s !== sessionId);
      if (kept.length === 0) this.convKeys.delete(key);
      else if (kept.length !== list.length) this.convKeys.set(key, kept);
    }
    this.markDirty();
    return existed;
  }

  /**
   * Dynamically re-pins a session onto a replacement model instance when the
   * pinned model is evicted (Session-Pin Eviction: circuit-breaker outage or
   * config removal — see the orchestrator 4B seam).
   */
  public repinModel(sessionId: string, newModel: TierModelConfig): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.pinnedModel = newModel.id;
    session.pinnedProvider = newModel.provider;
    return true;
  }

  public clear(): void {
    this.sessions.clear();
    this.chainAnchors.clear();
    this.tailAnchors.clear();
    this.convKeys.clear();
    this.markDirty();
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    if (this.sessions.size < this.maxSessions) return;

    // 1. Evict expired sessions
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActiveAt > this.ttlMs) {
        this.deleteSession(id);
      }
    }

    // 2. If still at or exceeding capacity, evict oldest by lastActiveAt (LRU)
    if (this.sessions.size >= this.maxSessions) {
      const sorted = Array.from(this.sessions.values()).sort(
        (a, b) => a.lastActiveAt - b.lastActiveAt
      );
      const overflowCount = this.sessions.size - this.maxSessions + 1;
      const toRemove = sorted.slice(0, Math.max(1, overflowCount));
      for (const s of toRemove) {
        this.deleteSession(s.id);
      }
    }
  }

  /* ------------------------------------------------------------ persist */

  /**
   * Load anchors + conversation keys written by a previous run (per-environment
   * JSON snapshot). Fail-open: a broken/missing file starts empty; a capture
   * or persistence problem must never break routing.
   */
  private loadPersisted(): void {
    if (!this.persistPath) return;
    try {
      const raw = fs.readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw);
      if (data?.v !== 1) return;
      if (data.chainAnchors && typeof data.chainAnchors === 'object') {
        for (const [k, v] of Object.entries(data.chainAnchors)) {
          if (typeof k === 'string' && typeof v === 'string') this.setBounded(this.chainAnchors, k, v, MAX_CHAIN_ENTRIES);
        }
      }
      if (data.tailAnchors && typeof data.tailAnchors === 'object') {
        for (const [k, v] of Object.entries(data.tailAnchors)) {
          if (typeof k === 'string' && typeof v === 'string') this.setBounded(this.tailAnchors, k, v, MAX_TAIL_ENTRIES);
        }
      }
      if (data.convKeys && typeof data.convKeys === 'object') {
        for (const [k, v] of Object.entries(data.convKeys)) {
          if (typeof k === 'string' && Array.isArray(v)) {
            const list = v.filter((s: unknown) => typeof s === 'string').slice(0, CANDIDATE_CAP);
            if (list.length) this.setBounded(this.convKeys, k, list, MAX_CONVKEY_ENTRIES);
          }
        }
      }
    } catch {
      // Missing / corrupt snapshot — start empty.
    }
  }

  private markDirty(): void {
    if (!this.persistPath) return;
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flushPersist();
    }, PERSIST_SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /**
   * Write the snapshot synchronously (atomic tmp+rename). Debounced by
   * markDirty; wired to the process shutdown/exit hooks and exposed for
   * deterministic tests. Never throws — disk failure is fail-open by contract.
   *
   * Scale ceiling (documented, not yet a problem at local-gateway volume): the
   * write is a FULL synchronous serialization of the three anchor/key maps,
   * which are FIFO-capped at 350k combined entries; anchor keys are pruned only
   * on `deleteSession`, and TTL eviction runs only at session capacity, so under
   * sustained heavy agent traffic the maps grow toward their caps and each
   * debounced flush costs more (sub-second at the cap). Upgrade path when that
   * is reached: prune anchors for sessions absent past the TTL inside flush, or
   * switch to `fs.promises` async tmp+rename.
   */
  public flushPersist(): void {
    if (!this.persistPath || !this.dirty) return;
    this.dirty = false;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    try {
      const data = {
        v: 1,
        savedAt: Date.now(),
        chainAnchors: Object.fromEntries(this.chainAnchors),
        tailAnchors: Object.fromEntries(this.tailAnchors),
        convKeys: Object.fromEntries(this.convKeys),
      };
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, this.persistPath);
    } catch {
      // Fail-open: persistence is best-effort continuity, never a hot-path error.
    }
  }
}

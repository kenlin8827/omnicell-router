import crypto from 'node:crypto';
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
}

export interface SessionResolveResult {
  sessionId: string;
  lookupType: SessionLookupType;
}

// Memory/safety bounds — intentionally NOT config-exposed: they tune memory,
// not product behavior.
const TAIL_WINDOW = 8;             // messages per registered tail window
const MAX_CHAIN_PROBES = 32;       // assistant boundaries examined per resolve
const MAX_TAIL_PROBES = 256;       // window probes examined per resolve
const MAX_CHAIN_ENTRIES = 200_000; // global FIFO caps
const MAX_TAIL_ENTRIES = 100_000;
const MAX_ROOT_ENTRIES = 50_000;
const ANCHOR_HEX = 20;             // anchor digest length

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
 *   1. Explicit header / router_options.session_id
 *   2. Embedded client session UUID — Claude Code sends
 *      metadata.user_id = "user_{hash}_account_{uuid}_session_{uuid}";
 *      the trailing UUID is a client-minted conversation id that survives
 *      gateway restarts for free.
 *   3. Raw request.user (OpenAI end-user field; NOTE: user-scoped, not
 *      conversation-scoped — kept for backward compatibility).
 *   4. Chain anchors — exact hash of the current history's head prefixes that
 *      end at an assistant message (turn 2+ fast path; also matches branched /
 *      regenerated histories sharing the head).
 *   5. Tail anchors — hashes of trailing windows (length 3..TAIL_WINDOW, always
 *      ending at an assistant message) of completed chains (clients that
 *      truncate old turns to fit their context window resend a registered
 *      suffix; the 3-message minimum keeps generic short exchanges from
 *      cross-matching unrelated conversations — see probeTailAnchors).
 *   6. Root anchor — deterministic hash of clientIp + FULL first user message;
 *      re-anchors chains whose assistant bytes were rewritten in place.
 *   7. Cold start — mint `sess_<24 random hex>`. Deterministic IDs would
 *      collide across conversations that share a first message (a local
 *      gateway sees 127.0.0.1 for everyone), so fresh entropy is minted once
 *      and continuity is carried by the anchor maps instead.
 *
 * Known limits (documented, by design):
 * - All anchor maps are in-memory: after a gateway restart, non-cooperating
 *   clients get a fresh session (state was lost anyway; only trace grouping
 *   splits). Clients sending embedded/explicit IDs are restart-proof.
 * - Full summarization rewrites (compact replacing history with a summary
 *   string) match no anchor — they intentionally start a new session.
 */
export class SessionManager {
  private config: SessionConfig;
  private sessions = new Map<string, ConversationSession>();
  private chainAnchors = new Map<string, string>();  // 'C'-salted head-prefix hash -> sessionId
  private tailAnchors = new Map<string, string>();   // 'T'-salted trailing-window hash -> sessionId
  private rootToSession = new Map<string, string>(); // 'R'-salted first-user-message hash -> sessionId
  private readonly ttlMs: number;
  private readonly maxSessions: number;

  constructor(config?: SessionConfig) {
    this.config = {
      enabled: config?.enabled ?? true,
      strategy: config?.strategy ?? 'monotonic',
      ttlSeconds: config?.ttlSeconds ?? 3600,
      maxSessions: config?.maxSessions ?? 10000,
    };
    this.ttlMs = (this.config.ttlSeconds || 3600) * 1000;
    this.maxSessions = this.config.maxSessions || 10000;
  }

  /**
   * Canonical per-message serialization. MUST stay byte-stable: anchor keys
   * are only ever compared against keys produced by this same function.
   *
   * FULL-FIDELITY on purpose: tool_calls, tool_call_id, name and non-text
   * content parts are all hashed. A pure tool-call assistant turn (content
   * null) must never serialize identically to a different one — lossy
   * hashing here would give two distinct conversations identical anchor
   * keys (false merge, the unrecoverable failure direction).
   */
  private static serializeMessage(m: any): string {
    const role = m.role || 'user';
    const content = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p: any) => {
            if (p && typeof p === 'object') {
              return typeof p.text === 'string'
                ? `text:${p.text}`
                : `${p.type || 'part'}:${JSON.stringify(p)}`;
            }
            return String(p ?? '');
          }).join(' ')
        : JSON.stringify(m.content ?? '');
    let extra = '';
    if (m.name) extra += `|name:${m.name}`;
    if (m.tool_call_id) extra += `|tcid:${m.tool_call_id}`;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      extra += `|tcs:${JSON.stringify(m.tool_calls)}`;
    }
    return `${role}:${content}${extra}`;
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

  private static assistantIndices(messages: any[]): number[] {
    const idx: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.role === 'assistant') idx.push(i);
    }
    return idx;
  }

  /**
   * Deterministic root key: clientIp + FULL first user message (no truncation
   * — 500-char prefixes of boilerplate first messages were the old collision
   * source). clientIp adds nothing on a local gateway but is harmless.
   */
  private static rootHash(clientIp: string, messages: any[]): string {
    const firstUser = messages.find(m => m?.role === 'user');
    const content = firstUser ? SessionManager.serializeMessage(firstUser) : 'empty_root';
    return crypto.createHash('sha256').update(`R\x00${clientIp}:${content}`).digest('hex').slice(0, 24);
  }

  /**
   * Extract a client-embedded conversation id from a user identifier string.
   * Recognizes the FULL Claude Code convention
   *   user_{hex hash}_account_{uuid}_session_{uuid}
   * (the same extraction peer gateways perform for observability tooling).
   * The whole shape must match: a loose "_session_" suffix match would
   * promote ordinary user-level ids that merely contain that marker to
   * session level, falsely merging every conversation of that user. False
   * exclusion is the safe direction — such ids fall through to the
   * user-level layer and the chain anchors re-acquire the conversation from
   * turn 2 (self-healing false split).
   */
  private static extractEmbeddedSessionId(user?: unknown): string | null {
    if (!user || typeof user !== 'string') return null;
    const m = /^user_[0-9a-f]{8,64}_account_[0-9a-f-]{8,64}_session_([0-9a-f-]{8,64})$/i.exec(user.trim());
    if (!m) return null;
    return `cc_${m[1]}`;
  }

  /**
   * Seamless Session Resolver — see the class doc for the full priority list.
   */
  public resolveSessionId(
    request: ChatCompletionRequest,
    clientIp = '127.0.0.1',
    headers?: Record<string, string | string[] | undefined>
  ): SessionResolveResult {
    // 1. Explicit Header Probe
    const explicitHeader =
      headers?.['x-session-id'] ||
      headers?.['x-conversation-id'] ||
      headers?.['session-id'] ||
      headers?.['conversation-id'];

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

    // Cold start: nothing to anchor on — either a literal turn 1 (single
    // message) or harness turn 1 ([system, user]: no completed exchange yet).
    const priorHistory = messages.slice(0, -1);
    if (messages.length < 2 || !priorHistory.some(m => m?.role === 'assistant')) {
      return this.mintColdStart(clientIp, messages);
    }

    // 5. Chain anchors (turn 2+ fast path; newest boundary first, so a live
    // conversation hits on the first probe).
    const chainHit = this.probeChainAnchors(priorHistory);
    if (chainHit) return { sessionId: chainHit, lookupType: 'prefix_chain' };

    // 6. Tail anchors (history truncated to fit a context window).
    const tailHit = this.probeTailAnchors(priorHistory);
    if (tailHit) return { sessionId: tailHit, lookupType: 'tail_anchor' };

    // 7. Root anchor (first user message intact, assistant bytes rewritten).
    // A tombstoned key ('' — two different sessions claimed the same first
    // message) is falsy here and safely falls through to a fresh mint.
    const rooted = this.rootToSession.get(SessionManager.rootHash(clientIp, messages));
    if (rooted) {
      return { sessionId: rooted, lookupType: 'root_anchor' };
    }

    // 8. Unknown / fully rewritten history: new session.
    return this.mintColdStart(clientIp, messages);
  }

  private probeChainAnchors(priorHistory: any[]): string | null {
    const boundaries = SessionManager.assistantIndices(priorHistory);
    let probes = 0;
    for (let b = boundaries.length - 1; b >= 0 && probes < MAX_CHAIN_PROBES; b--, probes++) {
      const hash = SessionManager.hashWindow(priorHistory.slice(0, boundaries[b] + 1), 'C');
      const hit = this.chainAnchors.get(hash);
      if (hit) return hit;
    }
    return null;
  }

  private probeTailAnchors(priorHistory: any[]): string | null {
    const boundaries = SessionManager.assistantIndices(priorHistory);
    let probes = 0;
    for (let b = boundaries.length - 1; b >= 0 && probes < MAX_TAIL_PROBES; b--) {
      const end = boundaries[b];
      const startMin = Math.max(0, end - TAIL_WINDOW + 1);
      // Windows are length >= 3 and always end at the boundary, so a probe
      // key always carries an assistant message PLUS a distinguishing third
      // message. Length-2 windows ([user, assistant]) are location-free keys
      // whose content can be byte-identical across conversations of the same
      // harness (generic exchanges like "continue" / "ok") — a false-merge vector.
      // The extra message flips that failure into a self-healing false split.
      for (let s = end - 2; s >= startMin && probes < MAX_TAIL_PROBES; s--, probes++) {
        const hash = SessionManager.hashWindow(priorHistory.slice(s, end + 1), 'T');
        const hit = this.tailAnchors.get(hash);
        if (hit) return hit;
      }
    }
    return null;
  }

  /**
   * Mint a fresh session id with random entropy (collision-free by
   * construction) and register its deterministic root key so later turns
   * whose chain was rewritten in place can still re-anchor to it.
   */
  private mintColdStart(clientIp: string, messages: any[]): SessionResolveResult {
    const sessionId = 'sess_' + crypto.randomBytes(12).toString('hex');
    if (this.config.enabled && this.config.strategy !== 'stateless') {
      this.registerRoot(SessionManager.rootHash(clientIp, messages), sessionId);
    }
    return { sessionId, lookupType: 'cold_start' };
  }

  /**
   * Register a root key → sessionId claim. If a DIFFERENT session already
   * claims the same first message, the key is ambiguous (two live
   * conversations share it) and gets tombstoned to '': no session may
   * re-anchor through it, because attaching to the wrong one would be a
   * false merge — the exact failure class this design exists to prevent.
   * Single-claim keys keep working normally.
   */
  private registerRoot(key: string, sessionId: string): void {
    const existing = this.rootToSession.get(key);
    if (existing === undefined) {
      this.setBounded(this.rootToSession, key, sessionId, MAX_ROOT_ENTRIES);
    } else if (existing !== sessionId && existing !== '') {
      this.rootToSession.set(key, '');
    }
  }

  /** FIFO-bounded map set (Map preserves insertion order). */
  private setBounded(map: Map<string, string>, key: string, value: string, cap: number): void {
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
   * chain (requestMessages + assistant response; the orchestrator passes the
   * PRE-compression fingerprint so keys are derived from original client
   * bytes — see orchestrator step 2B):
   *
   * - Chain anchors: hash of every head prefix ending at an assistant
   *   message. One chained-hashing pass (copy() per boundary).
   * - Tail anchors: every length-2..TAIL_WINDOW window of the trailing
   *   TAIL_WINDOW messages that ends at an assistant message. These are what
   *   let a truncated history (client dropped old turns) find its way back.
   *
   * Also refreshes the deterministic root key (covers sessions born from
   * explicit headers, whose cold start never minted one).
   */
  public registerCompletedTurn(
    sessionId: string,
    requestMessages: any[],
    assistantResponseContent: string,
    clientIp = '127.0.0.1'
  ): void {
    if (!this.config.enabled || this.config.strategy === 'stateless') return;

    try {
      const chain = [
        ...(requestMessages || []),
        { role: 'assistant', content: assistantResponseContent },
      ];

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

      // Root key refresh (ambiguity-guarded: see registerRoot).
      this.registerRoot(SessionManager.rootHash(clientIp, requestMessages || []), sessionId);

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
    for (const map of [this.chainAnchors, this.tailAnchors, this.rootToSession]) {
      for (const [hash, sessId] of map.entries()) {
        if (sessId === sessionId) map.delete(hash);
      }
    }
    return existed;
  }

  /**
   * Dynamically re-pins a session to a healthy model instance when the previous
   * pinned model has been tripped by circuit breaker (Session Self-Healing).
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
    this.rootToSession.clear();
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
}

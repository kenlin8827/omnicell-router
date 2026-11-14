import { createHash } from 'node:crypto';
import type { ChatMessage } from '../../../types/openai.js';
import {
  NO_TURN,
  classifyTurnBoundary,
  type TurnDecision,
  type TurnIdentity,
} from '../../turn-boundary.js';
import { CaptureArchiveMigrator } from '../migrator.js';
import type {
  CaptureMigratorFilePlan,
  CaptureMigratorLineContext,
  CaptureMigratorVerdict,
} from '../migrator.js';

/** The request/exchange/turn identity this step will stamp on one line. */
interface PlannedLine {
  requestId: string;
  exchangeId: string;
  attempt: number;
}

/** A request reconstructed from the file, before its turn is decided. */
interface DraftRequest {
  requestId: string;
  sessionId: string;
  /** Span of the client request that opened it; unset for an orphan. */
  clientSpan?: string;
  /** Exchange ordinals per leg — `attempt` is read out of these. */
  legs: Map<string, Map<string, number>>;
  /** The inbound chat body, when the archive still carries it. */
  body?: readonly ChatMessage[];
  /** The structural prompt pair the schema-1 writer recorded. */
  pair?: RecordedPair;
  /** True once a client REQUEST line for this id was seen. */
  hasPrompt: boolean;
}

/**
 * V1 → V2: the cutover that introduced the WRITE-TIME turn identity and the
 * gateway request/exchange ids (ADR-0021, ADR-0024).
 *
 * Schema 1 is the unmarked baseline: a schema-1 line has no `schema` field,
 * no `attempt`, no `turnIndex` / `isPromptStart` / `turnDecision`. Every
 * input it needs is already in the archive, so this step REBUILDS the
 * identity structurally instead of guessing from display text — there are two
 * historical shapes, and both are represented:
 *
 * 1. LINES THAT CARRY THE GATEWAY IDS (`requestId` + `exchangeId`, ADR-0021
 *    onwards). Taken as-is; `attempt` is the ordinal of the exchange within
 *    `(requestId, leg)` in file order.
 * 2. LINES THAT PREDATE THEM (schema 1 proper: `traceId` + `spanId` only).
 *    Here `traceId` is a CONNECTION-scope correlation — one trace can hold
 *    several sequential client requests — while `spanId` is the exchange
 *    identity: a `client request` opens a request, the `upstream` spans it
 *    causes belong to it, and the matching `client response` closes it. So
 *    the request boundary is read off the event sequence, not inferred:
 *    requestId is minted deterministically from `(sessionId, spanId, ts)`
 *    (a re-run mints the same id, so the pass is idempotent), exchangeId is
 *    the span that already identifies the exchange, and `attempt` is the
 *    1-based ordinal of that upstream span inside the request.
 *
 * THIS STEP NEVER REFUSES A LINE, and no file is ever handed to a side
 * channel. An upgrade must leave the operator able to READ the history it
 * already wrote, so a sequence that does not close cleanly is repaired into
 * the nearest truth-bearing shape instead of being set aside:
 *
 * - an `upstream` exchange with no open client request becomes an ORPHAN
 *   REQUEST of its own (`turnIndex: null`, `NO_TURN`): visible, honestly
 *   marked as belonging to no prompt, never folded into a neighbouring turn;
 * - a client request that opens while the previous one is still open simply
 *   opens the next request — the abandoned one keeps its exchanges and its
 *   turn, and merely has no response half;
 * - a client response that matches no open request is attached to the request
 *   its span opened earlier in the file, or becomes an orphan;
 * - a file that ends mid-request keeps the request; only its response half is
 *   missing;
 * - a line whose `direction`/`phase` is outside the vocabulary is carried as
 *   the neutral upstream/request leg — the reader accepts nothing else, and
 *   unreadable is worse than approximate;
 * - a line missing `id`/`ts`/`sessionId` gets a deterministic value, so the
 *   row still validates at the archive boundary.
 *
 * Turn identity in both shapes comes from the SAME structural rule the live
 * admission gate uses (`classifyTurnBoundary`, capture/turn-boundary.ts),
 * replayed over the inbound body the archive recorded, in file order, with
 * the previous request's message count threaded per session. When the body
 * is no longer readable (truncated at `maxBodyBytes`, or not a chat body),
 * the structural pair the old writer recorded (`promptMessageCount` /
 * `promptLastUserIdx`) drives the same rule minus the two content checks
 * that need message parts.
 *
 * The legacy vocabulary is DROPPED, not carried: `spanId` became the
 * exchangeId, `traceId` is connection scope that the request identity
 * supersedes, and `promptMessageCount` / `promptLastUserIdx` were the
 * read-time heuristic ADR-0024 deleted. `promptSummary` survives — schema 2
 * still writes it, display only. The engine stamps `migratedFrom: 1`, so a
 * reconstructed identity is never mistaken for an admission-gate stamp.
 */
export class V1ToV2Migrate extends CaptureArchiveMigrator {
  readonly from = 1;
  readonly to = 2;

  /** Per-line plan, keyed by the line's index inside the file plan. */
  private planned = new Map<number, PlannedLine>();
  /** Turn identity per rebuilt requestId, decided once for the whole file. */
  private turns = new Map<string, TurnIdentity>();

  begin(plan: CaptureMigratorFilePlan): void {
    this.planned = new Map();
    this.turns = new Map();

    const { order, requests } = this.planIdentity(plan.lines);
    this.assignTurns(order, requests);
  }

  migrate(line: Record<string, unknown>, ctx: CaptureMigratorLineContext): CaptureMigratorVerdict {
    if (line.eventType !== 'http-exchange') return { ok: true, line };

    const plan = this.planned.get(ctx.index);
    if (!plan) {
      // Unreachable: every exchange line is planned in `begin()`. Total
      // function rather than a throw, so one surprise shape cannot cost the
      // whole file.
      return { ok: true, line: { ...line, ...readableShape(line, ctx.index) } };
    }
    const turn = this.turns.get(plan.requestId) ?? NO_TURN;

    const next: Record<string, unknown> = {
      ...line,
      ...readableShape(line, ctx.index),
      requestId: plan.requestId,
      exchangeId: plan.exchangeId,
      attempt: plan.attempt,
      turnIndex: turn.turnIndex,
      isPromptStart: turn.isPromptStart,
      turnDecision: turn.turnDecision,
    };
    delete next.spanId;
    delete next.traceId;
    delete next.promptMessageCount;
    delete next.promptLastUserIdx;
    return { ok: true, line: next };
  }

  /**
   * Decide request / exchange / attempt for every line, returning the
   * requestIds in the order they first appear. One pass, one output shape:
   * lines that already carry gateway ids keep them, lines that predate them
   * are rebuilt from the span sequence.
   */
  private planIdentity(lines: readonly Record<string, unknown>[]): {
    order: string[];
    requests: Map<string, DraftRequest>;
  } {
    const order: string[] = [];
    const requests = new Map<string, DraftRequest>();
    /** Span that opened a client request, so a late response can find it. */
    const clientSpanOwner = new Map<string, string>();
    let openId: string | null = null;

    const open = (requestId: string, line: Record<string, unknown>, clientSpan?: string): DraftRequest => {
      let req = requests.get(requestId);
      if (!req) {
        req = { requestId, sessionId: sessionOf(line), legs: new Map(), hasPrompt: false };
        requests.set(requestId, req);
        order.push(requestId);
      }
      if (clientSpan !== undefined) req.clientSpan = clientSpan;
      return req;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.eventType !== 'http-exchange') continue;

      // A line with no span still has an exchange position: the file index is
      // stable across re-runs, so a derived id stays deterministic.
      const span = nonEmpty(line.spanId) ?? `at:${i}`;
      const direction = line.direction === 'client' ? 'client' : 'upstream';
      const phase = line.phase === 'response' ? 'response' : 'request';
      const ownRequestId = nonEmpty(line.requestId);
      const ownExchangeId = nonEmpty(line.exchangeId);

      let requestId: string;
      if (direction === 'client' && phase === 'request') {
        requestId = ownRequestId ?? legacyRequestId(line, span);
        const req = open(requestId, line, span);
        req.hasPrompt = true;
        req.sessionId = sessionOf(line);
        const body = parseChatMessages(line);
        if (body) req.body = body;
        const pair = readRecordedPair(line);
        if (pair) req.pair = pair;
        clientSpanOwner.set(span, requestId);
        openId = requestId;
      } else if (direction === 'client' && phase === 'response') {
        const current = openId === null ? undefined : requests.get(openId);
        if (current && current.clientSpan !== undefined && current.clientSpan === span) {
          requestId = current.requestId;
        } else if (clientSpanOwner.has(span)) {
          requestId = clientSpanOwner.get(span) as string;
        } else {
          // The response half of an exchange whose request half this file no
          // longer holds. It stands on its own rather than being dropped.
          requestId = ownRequestId ?? legacyRequestId(line, span);
          open(requestId, line);
          clientSpanOwner.set(span, requestId);
        }
        // The client round-trip is over either way; the next upstream leg
        // must not be attributed to the request that just answered.
        openId = null;
      } else {
        // An upstream leg belongs to the request that is open. With none open
        // it becomes an orphan request — a line naming its own request id
        // wins over both.
        requestId = ownRequestId ?? openId ?? legacyRequestId(line, span);
        open(requestId, line);
        openId = requestId;
      }

      const req = requests.get(requestId) as DraftRequest;
      const exchangeId = ownExchangeId ?? rebuiltExchangeId(line, span, direction);
      this.planned.set(i, { requestId, exchangeId, attempt: nextAttempt(req, direction, exchangeId) });
    }
    return { order, requests };
  }

  /**
   * One turn decision per request, in the order the requests appear. A
   * request with no client-request line (an orphan) carries no prompt
   * evidence at all, so it gets `NO_TURN` — a first-class value, not a gap.
   */
  private assignTurns(order: readonly string[], requests: Map<string, DraftRequest>): void {
    const prevMessageCount = new Map<string, number>();
    const openTurn = new Map<string, number>();
    const turnCount = new Map<string, number>();

    for (const requestId of order) {
      const req = requests.get(requestId);
      if (!req || !req.hasPrompt) {
        this.turns.set(requestId, NO_TURN);
        continue;
      }
      const sessionId = req.sessionId;
      const decision = req.body
        ? classifyTurnBoundary(req.body, prevMessageCount.get(sessionId))
        : classifyRecordedPair(req.pair, prevMessageCount.get(sessionId));
      if (decision.messageCount !== undefined) {
        prevMessageCount.set(sessionId, decision.messageCount);
      }
      let turnIndex: number | null;
      if (decision.isPromptStart) {
        turnIndex = (turnCount.get(sessionId) ?? 0) + 1;
        turnCount.set(sessionId, turnIndex);
        openTurn.set(sessionId, turnIndex);
      } else {
        // A continuation before any prompt of this session belongs to no
        // turn — `null` is the first-class "no turn" value, not a fallback.
        turnIndex = openTurn.get(sessionId) ?? null;
      }
      this.turns.set(requestId, {
        turnIndex,
        isPromptStart: decision.isPromptStart,
        turnDecision: decision.turnDecision,
      });
    }
  }
}

/**
 * The fields the archive boundary validates, defaulted only when the line
 * cannot supply them. Nothing here is invented about the REQUEST — these are
 * shape guarantees so a legacy row stays readable, not interpretation.
 */
function readableShape(line: Record<string, unknown>, index: number): Record<string, unknown> {
  const shape: Record<string, unknown> = {};
  if (typeof line.id !== 'string' || line.id === '') shape.id = `evt_at_${index}`;
  if (typeof line.ts !== 'number') shape.ts = 0;
  if (typeof line.sessionId !== 'string') shape.sessionId = '';
  if (line.direction !== 'client' && line.direction !== 'upstream') shape.direction = 'upstream';
  if (line.phase !== 'request' && line.phase !== 'response') shape.phase = 'request';
  return shape;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function sessionOf(line: Record<string, unknown>): string {
  return typeof line.sessionId === 'string' ? line.sessionId : '';
}

function stampOf(line: Record<string, unknown>): number {
  return typeof line.ts === 'number' ? line.ts : 0;
}

/** Ordinal of one exchange inside its leg of the request. */
function nextAttempt(req: DraftRequest, direction: string, exchangeId: string): number {
  let leg = req.legs.get(direction);
  if (!leg) {
    leg = new Map();
    req.legs.set(direction, leg);
  }
  let attempt = leg.get(exchangeId);
  if (attempt === undefined) {
    attempt = leg.size + 1;
    leg.set(exchangeId, attempt);
  }
  return attempt;
}

/**
 * Deterministic request id for a rebuilt request: derived from the client
 * span that opened it plus the session and its timestamp, so a second pass
 * over the same file mints the same id and the migration stays idempotent.
 * The `req_` prefix plus 24 hex mirrors the shape the gateway mints.
 */
function legacyRequestId(line: Record<string, unknown>, span: string): string {
  const digest = createHash('sha1')
    .update(`${sessionOf(line)}|${span}|${stampOf(line)}`)
    .digest('hex');
  return `req_${digest.slice(0, 24)}`;
}

/**
 * Deterministic exchange id for a rebuilt exchange. The span identifies the
 * exchange in every pre-request-layer archive we hold — its request and
 * response share it — but the input also carries the LEG, so an archive
 * where a client span were reused on an upstream hop still gets two distinct
 * exchanges instead of one id spanning both legs. No timestamp: the two
 * halves of one exchange must resolve to the same id.
 */
function rebuiltExchangeId(
  line: Record<string, unknown>,
  span: string,
  direction: string,
): string {
  const digest = createHash('sha1')
    .update(`${sessionOf(line)}|${span}|${direction}`)
    .digest('hex');
  return `exc_${digest.slice(0, 24)}`;
}

/** The inbound chat body of a client-request line, when it is still readable. */
function parseChatMessages(line: Record<string, unknown>): readonly ChatMessage[] | undefined {
  const wire = line.wire;
  if (wire === null || typeof wire !== 'object') return undefined;
  const raw = (wire as { requestBody?: unknown }).requestBody;
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw) as { messages?: unknown };
    return Array.isArray(parsed.messages) ? (parsed.messages as ChatMessage[]) : undefined;
  } catch {
    // Truncated or media-scrubbed body — the recorded pair takes over.
    return undefined;
  }
}

interface RecordedPair {
  messageCount: number;
  lastUserIdx: number;
}

/** The structural prompt pair the schema-1 writer recorded on client requests. */
function readRecordedPair(line: Record<string, unknown>): RecordedPair | undefined {
  const messageCount = line.promptMessageCount;
  const lastUserIdx = line.promptLastUserIdx;
  if (typeof messageCount !== 'number' || typeof lastUserIdx !== 'number') return undefined;
  return { messageCount, lastUserIdx };
}

/**
 * `classifyTurnBoundary` over the recorded pair instead of the body. It is
 * the same rule minus the two content checks that need the message parts
 * (tool-result-only user message, trailing `role: 'tool'`): those bodies are
 * no longer readable, and the recorded pair still proves where the last user
 * message sat relative to the previous request's history.
 */
function classifyRecordedPair(
  pair: RecordedPair | undefined,
  prevMessageCount: number | undefined,
): { isPromptStart: boolean; turnDecision: TurnDecision; messageCount?: number } {
  // No body and no recorded pair: the archive holds no prompt evidence at
  // all, so the request belongs to no turn.
  if (!pair) return { isPromptStart: NO_TURN.isPromptStart, turnDecision: NO_TURN.turnDecision };
  const { messageCount, lastUserIdx } = pair;
  if (lastUserIdx < 0) return { isPromptStart: false, turnDecision: 'no_prompt', messageCount };
  if (prevMessageCount !== undefined) {
    if (messageCount < prevMessageCount) {
      return { isPromptStart: true, turnDecision: 'ambiguous_compaction', messageCount };
    }
    if (lastUserIdx < prevMessageCount) {
      return { isPromptStart: false, turnDecision: 'continuation', messageCount };
    }
  }
  return { isPromptStart: true, turnDecision: 'new_prompt', messageCount };
}

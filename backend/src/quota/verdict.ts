import type { LastProbeCapture, QuotaFailureVerdict, QuotaProbeEntry, QuotaProbeFailureReason } from './types.js';

/**
 * Failure verdict assignment — the ONE place an account-level conclusion is
 * derived from a failed probe.
 *
 * The rule this module exists to enforce: a verdict is assigned from a
 * STRUCTURED signal the upstream stated in machine-readable form — an HTTP
 * status, an envelope field (`success: false`, MiniMax `base_resp.status_code`),
 * or a declaration-table `refusalIf` predicate over the parsed body. It is
 * NEVER derived from pattern-matching a human sentence: quota endpoints answer
 * in prose (and in every vendor's own language), so a wording rule would have
 * to be written once per vendor per language — unmaintainable by construction,
 * and it silently rots the moment a vendor rephrases.
 *
 * So the sentence travels as EVIDENCE (`QuotaProbeFailure.message`, rendered
 * verbatim) while the verdict travels as a closed code the console translates
 * once into eight languages.
 */

/** Envelope keys that state a verdict as a boolean or a zero-is-success code. */
const SUCCESS_FLAGS = ['success', 'ok'] as const;
const CODE_PATHS = [
  ['code'],
  ['error', 'code'],
  ['base_resp', 'status_code'],
  ['baseResp', 'statusCode'],
] as const;

function readPath(body: unknown, path: readonly string[]): unknown {
  let cur: any = body;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * The upstream's own code, when the body states one (`code`, `error.code`,
 * MiniMax's `base_resp.status_code`). Evidence for the console, never a gate.
 */
export function upstreamCode(body: unknown): string | number | undefined {
  for (const path of CODE_PATHS) {
    const v = readPath(body, path);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/**
 * True when a status-OK body says, in a machine-readable field, that the call
 * FAILED. Two shapes carry that: an explicit boolean refusal (`success: false`,
 * `ok: false`) and a non-zero envelope code. Both are statements the vendor
 * makes structurally — Zhipu's `{"code":500,"success":false}` on HTTP 200 is
 * the motivating case: the transport succeeded and the ACCOUNT was refused.
 */
export function bodyStatesRefusal(body: unknown): boolean {
  for (const flag of SUCCESS_FLAGS) {
    const v = readPath(body, [flag]);
    if (v === false) return true;
  }
  const code = upstreamCode(body);
  if (typeof code === 'number') return code !== 0;
  if (typeof code === 'string') {
    // A textual code is only a refusal when it is a code, not a sentence: a
    // numeric-looking string ('2062') counts, an error NAME ('invalid_key')
    // also states refusal, while an arbitrary message does not.
    return /^\d+$/.test(code) ? Number(code) !== 0 : true;
  }
  return false;
}

/** What the caller knows about the attempt, beyond the raw capture. */
export interface VerdictContext {
  reason: QuotaProbeFailureReason;
  status?: number;
  /** Parsed response body (absent when the body was not JSON). */
  body: unknown;
  /** The effective entry — its `refusalIf` is a declaration-table predicate. */
  entry?: QuotaProbeEntry;
  /** Set by a code adapter that already knows the conclusion (MiniMax envelope,
   *  credential-rejected codes). Wins over everything derived from the body. */
  stated?: QuotaFailureVerdict;
}

/**
 * Assign the closed verdict for one failed attempt. Precedence: an adapter's
 * stated conclusion, then the declaration's `refusalIf`, then HTTP status, then
 * the transport reason. Status before shape is deliberate: a 404 IS
 * `endpoint-gone` even though the 404 body also fails to parse.
 */
export function resolveVerdict(ctx: VerdictContext): QuotaFailureVerdict {
  if (ctx.stated) return ctx.stated;
  // The declaration-table half of the decision. Evaluated over the WHOLE
  // document (no item binding), with exactly the predicate grammar the rest of
  // the table uses — `dsl/evalWhere` binds to a window ITEM, so it cannot be
  // reused here.
  if (ctx.entry?.refusalIf && evalWhereOverDocument(ctx.entry.refusalIf.where, ctx.body)) return 'plan-inactive';
  const status = ctx.status;
  if (status === 401 || status === 403) return 'credential-rejected';
  if (status === 404) return 'endpoint-gone';
  if (status === 429) return 'rate-limited';
  if (status !== undefined && (status < 200 || status >= 300)) return 'upstream-error';
  if (ctx.reason === 'timeout') return 'timeout';
  if (ctx.reason === 'network') return 'unreachable';
  if (ctx.reason === 'auth') return 'credential-rejected';
  // A status-OK answer that still failed: the body refused in a structured
  // field (non-zero envelope code / `success: false`) or the probe could not
  // read it into windows. A stated refusal is an account statement, not a
  // parser fault, so it is `plan-inactive`; everything else is `unreadable`.
  if (bodyStatesRefusal(ctx.body)) return 'plan-inactive';
  return 'unreadable';
}

/** Minimal gate evaluation over a whole document (no item binding). */
function evalWhereOverDocument(where: { path: string; exists?: boolean; truthy?: boolean; eq?: unknown; in?: unknown[] }, body: unknown): boolean {
  const v = readPath(body, where.path.split('.'));
  if (where.truthy) return v === true;
  if (where.exists !== undefined) return where.exists ? v !== undefined && v !== null : v === undefined || v === null;
  if (where.eq !== undefined) {
    if (typeof where.eq === 'boolean') return v === where.eq;
    if (typeof where.eq === 'number') return Number(v) === where.eq;
    return String(v) === String(where.eq);
  }
  if (where.in !== undefined) return where.in.some((c) => String(c) === String(v));
  return false;
}

/** Pull the parsed body out of a memory-only capture (best effort). */
export function captureBody(http: LastProbeCapture | undefined): unknown {
  const body = http?.body;
  if (body === undefined) return undefined;
  return body;
}
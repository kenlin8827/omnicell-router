/**
 * Upstream error bodies often ECHO the request (validation errors repeating
 * the Authorization value, Ark/OpenAI "invalid api key: sk-…", etc.). The
 * gateway holds every upstream key, so an unretracted body leaks live secrets
 * into the client error envelope, pino logs, capture archives and the failure
 * ledger. Probe already redacts; the shared HTTP helpers must do the same.
 */

const REDACT_MIN_LEN = 6;
const BODY_CAP = 600;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._\-+/]+=*/gi;
const BASIC_RE = /Basic\s+[A-Za-z0-9._\-+/]+=*/gi;
const SECRET_HEADER_RE = /authorization|api[-_]?key|apikey|-key|token|secret|x-goog|cookie|password|credential|x-auth|proxy-auth|signature/i;

/** Pull credential-shaped values out of the outbound request headers. */
export function secretsFromHeaders(headers?: Record<string, string> | null): string[] {
  if (!headers) return [];
  const out: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!SECRET_HEADER_RE.test(name) || typeof value !== 'string') continue;
    const trimmed = value.replace(/^(?:Bearer|Basic)\s+/i, '').trim();
    if (trimmed.length >= REDACT_MIN_LEN) out.push(trimmed);
    if (value.length >= REDACT_MIN_LEN && value !== trimmed) out.push(value);
  }
  return out;
}

export interface RedactUpstreamBodyOptions {
  headers?: Record<string, string> | null;
  extraSecrets?: readonly string[];
  /** Soft cap after redaction (default 600 for error/ledger paths). Pass 0 to skip. */
  maxChars?: number;
  /** Collapse whitespace (default true for error paths; false for capture archives). */
  collapseWhitespace?: boolean;
}

/**
 * Distinguish RedactUpstreamBodyOptions from a plain `Record<string, string>`
 * header map by value types (a header map has string values, never numbers,
 * booleans, arrays, or nested header objects).
 */
function isRedactOptions(value: unknown): value is RedactUpstreamBodyOptions {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    (Object.hasOwn(o, 'headers') && (o.headers === null || o.headers === undefined || typeof o.headers === 'object')) ||
    (Object.hasOwn(o, 'maxChars') && typeof o.maxChars === 'number') ||
    (Object.hasOwn(o, 'extraSecrets') && Array.isArray(o.extraSecrets)) ||
    (Object.hasOwn(o, 'collapseWhitespace') && typeof o.collapseWhitespace === 'boolean')
  );
}

/**
 * Redact known secrets and generic Bearer/Basic tokens from an upstream body.
 * Error/ledger callers keep the default 600-char cap; capture passes
 * `{ maxChars: 0, collapseWhitespace: false }` so only secrets are touched.
 */
export function redactUpstreamBody(
  body: string,
  headersOrOpts?: Record<string, string> | null | RedactUpstreamBodyOptions,
  extraSecrets: readonly string[] = [],
): string {
  const opts: RedactUpstreamBodyOptions = isRedactOptions(headersOrOpts)
    ? headersOrOpts
    : { headers: headersOrOpts as Record<string, string> | null | undefined, extraSecrets };
  const headers = opts.headers;
  const secretsIn = opts.extraSecrets ?? extraSecrets;
  const maxChars = opts.maxChars === undefined ? BODY_CAP : opts.maxChars;
  const collapse = opts.collapseWhitespace !== false;

  let out = body ?? '';
  const secrets = [...secretsFromHeaders(headers), ...secretsIn]
    .filter((s) => typeof s === 'string' && s.length >= REDACT_MIN_LEN)
    // Longer first so a prefix of another secret cannot leave a residue.
    .sort((a, b) => b.length - a.length);
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join('[REDACTED]');
  }
  out = out.replace(BEARER_RE, 'Bearer [REDACTED]');
  out = out.replace(BASIC_RE, 'Basic [REDACTED]');
  if (collapse) out = out.replace(/\s+/g, ' ').trim();
  if (maxChars > 0 && out.length > maxChars) return `${out.slice(0, maxChars)}…`;
  return out;
}

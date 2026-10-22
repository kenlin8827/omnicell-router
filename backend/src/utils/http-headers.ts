/**
 * Header sanitization for operator-authored header maps (provider defs
 * `headers` / `options.headers`). Leaf module — no repo imports (it sits on
 * the boot-direct -> provider-defs -> user-config cycle path and must not
 * deepen it).
 */

/**
 * Header field-name token (RFC 9110): the charset a valid HTTP header name
 * may use. Anything else in a defs file is a typo, not a header.
 */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Hop-by-hop / transport-owned headers a def may never override. */
const FORBIDDEN_HEADER_NAMES = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Validate defs-file `headers` / `options.headers` at the trust boundary.
 * The defs file is operator-authored JSON(C): values typed as YAML/JSON
 * numbers or booleans are coerced to their wire spelling, objects/arrays and
 * empty names are dropped, transport-owned headers are stripped (the runtime
 * owns framing). Returns undefined when nothing valid remains, so callers
 * keep their "absent" semantics instead of persisting `{}`.
 */
export function sanitizeExtraHeaders(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!HEADER_NAME_RE.test(name) || FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) continue;
    if (typeof rawValue === 'string') out[name] = rawValue;
    else if (typeof rawValue === 'number' || typeof rawValue === 'boolean') out[name] = String(rawValue);
    // objects/arrays/null/undefined: not a header value — drop silently
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

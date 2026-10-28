/**
 * Build a replayable POSIX cURL command from a captured request event's wire
 * dump (request line + headers + body). Used by the capture wire drawer —
 * both the client-request leg (replayed against this gateway) and the
 * upstream-request leg (replayed against the provider) share the same shape:
 * `METHOD target HTTP/1.1` + header block + body.
 */
import type { HttpExchangeEvent, ReplaySpec } from './api';

/** Extract `METHOD <target>` from a captured request line; null when absent. */
const parseRequestLine = (requestLine: string): { method: string; target: string } | null => {
  const m = /^([A-Z]+) (\S+) HTTP\//.exec(requestLine);
  return m ? { method: m[1], target: m[2] } : null;
};

/**
 * cURL for one captured request event; null when the event carries no
 * reconstructible request (response-side event, missing request line, or a
 * hex-encoded body — binary bodies are not replayable as text).
 *
 * Target resolution:
 *  - client-request leg: the captured target is origin-form against THIS
 *    gateway → prefix the console's own origin so the command replays here.
 *  - upstream-request leg: the captured target is already absolute-form
 *    (scheme + provider host visible) → used verbatim.
 */
export function buildCurl(event: HttpExchangeEvent): string | null {
  const spec = buildReplaySpec(event);
  return spec ? buildCurlPosix(spec) : null;
}

/**
 * Replay spec for one captured request event; null when the event carries no
 * reconstructible request (same rules as buildCurl: request phase only,
 * parseable request line, UTF-8 body). The caller passes the spec verbatim to
 * the backend — hop-by-hop header dropping happens server-side too, so the
 * spec mirrors exactly what the wire block displays.
 */
export function buildReplaySpec(event: HttpExchangeEvent): ReplaySpec | null {
  if (event.phase !== 'request') return null;
  const parsed = parseRequestLine(event.wire.requestLine || '');
  if (!parsed) return null;
  if (event.wire.requestBody && typeof event.wire.requestBody !== 'string') return null;
  let target = parsed.target;
  if (event.direction === 'client' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    target = `${window.location.origin}${target}`;
  }
  return {
    url: target,
    method: parsed.method,
    headers: event.wire.requestHeaders || {},
    ...(event.wire.requestBody ? { body: event.wire.requestBody } : {}),
    ...(event.routing?.provider ? { provider: event.routing.provider } : {}),
    ...(event.model ? { model: event.model } : {}),
  };
}

/** POSIX-safe single-quote shell escaping: `'` → `'\''`. */
const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Standard cURL command for a replay spec (POSIX shell flavor). */
export const buildCurlPosix = (spec: ReplaySpec): string => {
  const parts = [`curl -X ${shellQuote(spec.method)} ${shellQuote(spec.url)}`];
  for (const [name, value] of Object.entries(spec.headers)) {
    // hop-by-hop / recomputed-by-curl headers: replaying them verbatim
    // corrupts the request (stale length, wrong authority).
    const lc = name.toLowerCase();
    if (lc === 'host' || lc === 'content-length' || lc === 'connection') continue;
    parts.push(`-H ${shellQuote(`${name}: ${value}`)}`);
  }
  if (spec.body !== undefined) parts.push(`--data-raw ${shellQuote(spec.body)}`);
  return parts.join(' \\\n  ');
};


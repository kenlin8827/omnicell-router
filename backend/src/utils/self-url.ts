/**
 * Self-reference detection for provider defs: a baseURL that points back at
 * THIS gateway's own listen endpoint.
 *
 * The criterion is the URL, never the provider id — `onecast-router` pointing
 * at a different instance (another port / another machine) is a legitimate
 * federation upstream, while any id pointing at the gateway's own port is a
 * self-loop. Callers decide the consequence (boot exclusion, pull refusal,
 * create rejection) — this module only answers "is this URL us?".
 */

/** Hostnames that can only ever mean this machine. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

export function isSelfBaseURL(baseURL: string | undefined | null, ownPort: number): boolean {
  if (!baseURL) return false;
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return false; // not a parseable URL — not a self-reference (unroutable is another plane's problem)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return false;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return port === ownPort;
}

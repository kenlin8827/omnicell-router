/**
 * Self-reference detection for provider defs: a baseURL that points back at
 * THIS gateway's own listen endpoint.
 *
 * The criterion is the URL, never the provider id — `omnicell-router` pointing
 * at a different instance (another port / another machine) is a legitimate
 * federation upstream, while any id pointing at the gateway's own port is a
 * self-loop. Callers decide the consequence (boot exclusion, pull refusal,
 * create rejection) — this module only answers "is this URL us?".
 */

/** Hostnames that can only ever mean this machine. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);
const V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Strip brackets, lowercase, and drop trailing DNS root dots. */
export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

/** Parse a dotted-quad IPv4 literal into four octets, or null. */
export function parseIpv4Octets(hostname: string): [number, number, number, number] | null {
  const m = V4_RE.exec(hostname);
  if (!m) return null;
  const octets = m.slice(1).map(Number) as [number, number, number, number];
  if (octets.some((n) => n > 255)) return null;
  return octets;
}

/** Parse an unbracketed lowercase IPv6 literal into 8 16-bit groups, or null. */
export function parseIpv6Groups(unbracketedLower: string): number[] | null {
  if (!unbracketedLower.includes(':')) return null;
  // Handle embedded dotted-quad IPv4 tail (e.g. ::ffff:127.0.0.1).
  let input = unbracketedLower;
  const lastColon = input.lastIndexOf(':');
  if (lastColon >= 0 && input.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4Octets(input.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    input = `${input.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const parsePart = (part: string): number[] | null => {
    if (!part) return [];
    const tokens = part.split(':');
    const nums: number[] = [];
    for (const t of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(t)) return null;
      nums.push(parseInt(t, 16));
    }
    return nums;
  };
  const left = parsePart(halves[0]!);
  const right = halves.length === 2 ? parsePart(halves[1]!) : null;
  if (!left || (halves.length === 2 && !right)) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - (left.length + right!.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right!];
}

/**
 * Extract IPv4 octets embedded in an IPv6 literal:
 * - IPv4-mapped (::ffff:0:0/96)
 * - IPv4-compatible (::/96, excluding :: and ::1)
 * - NAT64 well-known (64:ff9b::/96, RFC 6052) and local-use (64:ff9b:1::/48, RFC 8215)
 */
export function extractEmbeddedIpv4(unbracketedLower: string): [number, number, number, number] | null {
  const g = parseIpv6Groups(unbracketedLower);
  if (!g) return null;
  const isMapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff;
  const isCompatible = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && (g[6]! !== 0 || g[7]! > 1);
  const isNat64WellKnown = g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  const isNat64Local = g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0x0001;
  if (!isMapped && !isCompatible && !isNat64WellKnown && !isNat64Local) return null;
  const hi = g[6]!;
  const lo = g[7]!;
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

function isLocalHost(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (LOOPBACK_HOSTS.has(h)) return true;
  const v6 = parseIpv6Groups(h);
  if (v6 && v6.slice(0, 7).every((n) => n === 0) && (v6[7] === 0 || v6[7] === 1)) return true;
  const v4 = parseIpv4Octets(h) ?? extractEmbeddedIpv4(h);
  if (!v4) return false;
  return v4[0] === 127 || v4[0] === 0;
}

export function isSelfBaseURL(baseURL: string | undefined | null, ownPort: number): boolean {
  if (!baseURL) return false;
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return false; // not a parseable URL — not a self-reference (unroutable is another plane's problem)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!isLocalHost(url.hostname)) return false;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return port === ownPort;
}

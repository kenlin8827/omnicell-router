/**
 * Outbound upstream URL admission for console probes, auto-pull and def
 * writes. Complements isSelfBaseURL (same-port self-loop): this gate refuses
 * cloud-metadata / link-local targets and requires https for public hosts
 * while still allowing http to loopback and RFC1918 LAN (local LLMs).
 */

import {
  extractEmbeddedIpv4,
  isSelfBaseURL,
  normalizeHostname,
  parseIpv4Octets,
  parseIpv6Groups,
} from './self-url.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** Hostnames / literals that must never receive a credentialed probe. */
const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

function isLoopbackHost(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (LOOPBACK_HOSTS.has(h) || h === '::') return true;
  const v6 = parseIpv6Groups(h);
  if (v6 && v6.slice(0, 7).every((n) => n === 0) && (v6[7] === 0 || v6[7] === 1)) return true;
  const v4 = parseIpv4Octets(h) ?? extractEmbeddedIpv4(h);
  return Boolean(v4 && (v4[0] === 127 || v4[0] === 0));
}

/** Link-local + cloud metadata well-known addresses (IPv4 + IPv6). */
function isMetadataOrLinkLocal(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (METADATA_HOSTS.has(h)) return true;
  if (h === '169.254.169.254' || h === '100.100.100.200' || h === 'fd00:ec2::254') return true;
  const v4 = parseIpv4Octets(h) ?? extractEmbeddedIpv4(h);
  if (v4 && ((v4[0] === 169 && v4[1] === 254) || (v4[0] === 100 && v4[1] === 100 && v4[2] === 100 && v4[3] === 200))) {
    return true;
  }
  const v6 = parseIpv6Groups(h);
  if (v6) {
    // IPv6 link-local fe80::/10.
    if ((v6[0]! & 0xffc0) === 0xfe80) return true;
    // AWS IMDSv2 IPv6 endpoint fd00:ec2::254 in any compressed/expanded spelling.
    if (
      v6[0] === 0xfd00 && v6[1] === 0x0ec2 &&
      v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0 && v6[6] === 0 &&
      v6[7] === 0x0254
    ) return true;
  }
  return false;
}

function isPrivateOrLoopbackHttpOk(hostname: string): boolean {
  if (isLoopbackHost(hostname)) return true;
  const h = normalizeHostname(hostname);
  const v4 = parseIpv4Octets(h) ?? extractEmbeddedIpv4(h);
  if (v4) {
    if (v4[0] === 10) return true;
    if (v4[0] === 192 && v4[1] === 168) return true;
    if (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) return true;
    return false;
  }
  const v6 = parseIpv6Groups(h);
  // RFC 4193 IPv6 Unique Local Addresses (fc00::/7); fd00:ec2::254 is already
  // rejected by isMetadataOrLinkLocal before this helper runs.
  if (v6 && (v6[0]! & 0xfe00) === 0xfc00) return true;
  return false;
}

export class UpstreamUrlError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = 'UpstreamUrlError';
    this.reasonCode = reasonCode;
  }
}

/**
 * Parse + admit an upstream base URL. Throws UpstreamUrlError on refusal.
 * `ownPort` is the gateway listen port used by the self-loop check.
 */
export function assertAllowedUpstream(raw: string, ownPort: number): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UpstreamUrlError('invalid_upstream_url', 'Upstream URL is not parseable');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UpstreamUrlError('invalid_upstream_scheme', `Upstream URL scheme must be http(s), got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new UpstreamUrlError(
      'userinfo_not_allowed',
      'Upstream URL must not contain embedded credentials (userinfo)',
    );
  }
  const host = url.hostname;
  if (isMetadataOrLinkLocal(host)) {
    throw new UpstreamUrlError('metadata_target_refused', `Upstream URL targets metadata/link-local host '${host}'`);
  }
  if (url.protocol === 'http:' && !isPrivateOrLoopbackHttpOk(host)) {
    throw new UpstreamUrlError(
      'insecure_public_upstream',
      `Public upstream URL must use https (got http://${host})`,
    );
  }
  if (isSelfBaseURL(url.toString(), ownPort)) {
    throw new UpstreamUrlError(
      'self_upstream_refused',
      `Upstream URL points at this gateway itself (${url.origin})`,
    );
  }
  return url;
}

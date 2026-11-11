import fs from 'node:fs';
import tls from 'node:tls';
import type { ForwardProxyConfig } from '../config/types.js';

/**
 * Upstream TLS trust for the proxy's ORIGIN legs (ADR-0019).
 *
 * The forward proxy validates the REAL target certificate on every origin leg
 * it originates (h1 direct, h1 through the outbound proxy, the h2 relay and the
 * Upgrade relay) — that is the whole point of not stripping verification. The
 * consequence is that an origin signed by a PRIVATE CA is unreachable: a
 * corporate TLS-inspection chain, an internal service, a staging box with a
 * self-signed cert. `forwardProxy.upstreamTls.caFile` appends that CA to the
 * system trust store (never replaces it); `insecure` disables verification
 * entirely and exists only as an operator escape hatch.
 *
 * Two properties this module is responsible for:
 *  - HOT APPLY. The options are resolved per request off the live config ref,
 *    so a console save takes effect without a restart. The CA bundle is cached
 *    and re-stat'ed on a short TTL, so rotating the file on disk is picked up
 *    too (the TTL is a syscall budget, not a correctness knob).
 *  - SESSION SAFETY. `key` is a discriminator for the h2 session pool: a trust
 *    change must never reuse a session established under the old policy.
 *
 * A missing/unreadable `caFile` warns ONCE per path and falls back to the system
 * trust store — it does NOT silently disable verification. Fail closed, loudly.
 */

type UpstreamTlsConfig = NonNullable<ForwardProxyConfig['upstreamTls']>;

/** The resolved options + the pool-key discriminator, as one value. */
export interface UpstreamTlsOptions {
  /** `undefined` = system trust store (the historical behaviour). */
  opts?: tls.ConnectionOptions;
  /** Pool-key discriminator: `explicit` (test seam) / `sys` / `verify|<ca>@<mtime>` / `insecure`. */
  key: string;
}

let reader: (() => UpstreamTlsConfig | undefined) | undefined;

/** Wire the live `forwardProxy.upstreamTls` reader (index.ts is the only writer). */
export function setUpstreamTlsReader(next: (() => UpstreamTlsConfig | undefined) | undefined): void {
  reader = next;
}

interface CachedBundle {
  mtimeMs: number;
  size: number;
  /** System roots + the operator's bundle, as one list (see loadCaBundle). */
  ca: string[];
  readAt: number;
}

const bundles = new Map<string, CachedBundle>();
/** Re-stat budget: picks up a rotated CA file without a stat per request. */
const CA_RESTAT_MS = 5_000;
const warned = new Set<string>();

function warnOnce(caFile: string, err: unknown): void {
  const key = `${caFile}:${String((err as { code?: string })?.code ?? '')}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    `[ForwardProxy] upstreamTls.caFile "${caFile}" could not be read (${(err as Error)?.message || err}) — ` +
      'falling back to the system trust store. Upstream certificates will NOT be trusted from that CA.'
  );
}

/**
 * Read + cache the trust list: the SYSTEM roots followed by the operator's PEM.
 *
 * `ca` is not additive in `tls.connect` — passing it REPLACES the default root
 * store (Node and Bun alike), so a bundle set here would otherwise make every
 * publicly-signed origin untrusted, the exact opposite of "append". The roots
 * are therefore spelled out explicitly. `tls.rootCertificates` is available on
 * Bun 1.3.14 (145 roots, verified).
 *
 * `NODE_EXTRA_CA_CERTS` is NOT part of `tls.rootCertificates`, so an install
 * that relies on it should name that file here instead.
 *
 * Returns `undefined` when the file is unreadable (the system store stays).
 */
function loadCaBundle(caFile: string): string[] | undefined {
  try {
    const st = fs.statSync(caFile);
    const hit = bundles.get(caFile);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && Date.now() - hit.readAt < CA_RESTAT_MS) {
      return hit.ca;
    }
    const pem = fs.readFileSync(caFile, 'utf8');
    const roots = tls.rootCertificates;
    if (!roots?.length) {
      // No readable default store: the bundle would silently REPLACE trust.
      warnOnce(caFile, new Error('the runtime exposes no system root certificates'));
      return undefined;
    }
    const ca = [...roots, pem];
    bundles.set(caFile, { mtimeMs: st.mtimeMs, size: st.size, ca, readAt: Date.now() });
    return ca;
  } catch (err) {
    warnOnce(caFile, err);
    return undefined;
  }
}

/**
 * The TLS options for one origin leg, from the LIVE config.
 *
 * `explicit` is the test seam (`ForwardProxyDeps.upstreamTls`). It is MERGED
 * over the live options field by field, so a test can inject a `lookup` (the
 * only way to reach a fake origin without inventing DNS entries) while still
 * exercising the real `caFile` / `insecure` resolution. Production never sets
 * it, so the live reader is the only path there.
 */
export function resolveUpstreamTls(explicit?: tls.ConnectionOptions): UpstreamTlsOptions {
  const live = liveUpstreamTls();
  if (!explicit) return live;
  return { opts: { ...(live.opts || {}), ...explicit }, key: `${live.key}+explicit` };
}

/** The config-only resolution (no test seam). */
function liveUpstreamTls(): UpstreamTlsOptions {
  const cfg = reader?.();
  const caFile = cfg?.caFile?.trim();
  const insecure = cfg?.insecure === true;
  if (!caFile && !insecure) return { key: 'sys' };
  const opts: tls.ConnectionOptions = {};
  const parts: string[] = [];
  if (insecure) {
    opts.rejectUnauthorized = false;
    parts.push('insecure');
    // A trust list is pointless (and costs a full CA parse per connection) when
    // verification is off, so `insecure` wins over `caFile` — but the key keeps
    // the path so flipping the flag back re-keys the pool.
    if (caFile) parts.push(`${caFile}@insecure`);
  } else {
    parts.push('verify');
  }
  if (caFile && !insecure) {
    const ca = loadCaBundle(caFile);
    if (ca) {
      opts.ca = ca;
      const stamp = bundles.get(caFile)?.mtimeMs ?? 'unloaded';
      parts.push(`${caFile}@${stamp}`);
    } else {
      parts.push(`${caFile}@unreadable`);
    }
  }
  return { opts: Object.keys(opts).length ? opts : undefined, key: parts.join('|') };
}

/**
 * Geo databases for `GEOIP` / `GEOSITE` rules (ADR-0022).
 *
 * mihomo evaluates both types from data files in its work directory and
 * downloads them itself while parsing its config — but a failed download
 * (offline machine, blocked GitHub host) makes the core exit fatally, and the
 * core is exactly the thing this gateway needs for its own outbound traffic.
 * The gateway therefore installs the two files as an EXPLICIT action and both
 * the rule save and the core start refuse a geo-rule config while they are
 * missing, so the failure is a clear console message instead of a dead core.
 * Once installed the files are used offline; mihomo never re-fetches them
 * (the generated config leaves `geo-auto-update` off). Refreshing is an
 * operator action with two egress legs: the machine's own network (OS system
 * proxy when one is enabled, bypass list honoured) or the Clash node itself.
 * Each asset streams through the shared resumable downloader
 * (`proxy/asset-download.ts`), so an interrupted 8 MB database continues on the
 * next click instead of starting from zero.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MihomoCustomRule } from '../config/types.js';
import { MIHOMO_GEO_STALE_DAYS } from '../config/defaults.js';
import type { OsProxyEndpoint } from '../forward-proxy/system-proxy.js';
import { osProxyBypasses, readOsProxyEndpoint } from '../forward-proxy/system-proxy.js';
import { renameWithRetry } from '../utils/atomic-write.js';
import { fetchViaProxy } from '../utils/proxy.js';
import { assetPartPaths, cleanupAssetPart, downloadAssetToFile, parseAssetDigest, withAssetLock } from './asset-download.js';

/** Release host shared with the binary installer (MetaCubeX publishes both). */
const GEO_DOWNLOAD_BASE = 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest';
const MAX_GEO_BYTES = 64 * 1024 * 1024;
const USER_AGENT = 'omnicell-router';

/** MetaDB/GeoSite release host: `…/latest/geoip.metadb.sha256sum` is a
 * ~70-byte text file beside each database. The published digest comes from the
 * same host as the database itself, so verification costs no API quota and
 * stays as fresh as the asset. */
const SHA256SUM_SUFFIX = '.sha256sum';

export const MIHOMO_GEO_ASSETS = [
  // mihomo's default `geoip.metadb` (mmdb mode) — what `GEOIP` reads.
  { key: 'geoip', file: 'geoip.metadb', url: `${GEO_DOWNLOAD_BASE}/geoip.metadb` },
  // Saved under the capitalized name mihomo looks for in its work dir.
  { key: 'geosite', file: 'GeoSite.dat', url: `${GEO_DOWNLOAD_BASE}/geosite.dat` },
] as const;

export type MihomoGeoKey = typeof MIHOMO_GEO_ASSETS[number]['key'];

export interface MihomoGeoFileInfo {
  key: MihomoGeoKey;
  file: string;
  exists: boolean;
  size: number;
  /** mtime (epoch ms) of the installed copy; absent while the file does not. */
  updatedAt?: number;
  /** Installed but older than `MIHOMO_GEO_STALE_DAYS` — advisory only. */
  stale: boolean;
}

export interface MihomoGeoReport {
  /** Both files exist and are non-empty — everything a geo rule needs. */
  present: boolean;
  files: MihomoGeoFileInfo[];
}

/** True when any row needs the geo databases. */
export function rulesNeedGeo(rules: MihomoCustomRule[] | undefined): boolean {
  return (rules ?? []).some((rule) => rule.type === 'GEOIP' || rule.type === 'GEOSITE');
}

function fileInfo(dir: string, asset: typeof MIHOMO_GEO_ASSETS[number]): MihomoGeoFileInfo {
  try {
    const stat = fs.statSync(path.join(dir, asset.file));
    const exists = stat.isFile() && stat.size > 0;
    const stale = exists && Date.now() - stat.mtimeMs > MIHOMO_GEO_STALE_DAYS * 86_400_000;
    return {
      key: asset.key,
      file: asset.file,
      exists,
      size: stat.size,
      ...(exists ? { updatedAt: stat.mtimeMs } : {}),
      stale,
    };
  } catch {
    return { key: asset.key, file: asset.file, exists: false, size: 0, stale: false };
  }
}

export function geoReport(dir: string): MihomoGeoReport {
  const files = MIHOMO_GEO_ASSETS.map((asset) => fileInfo(dir, asset));
  return { present: files.every((file) => file.exists), files };
}

export function geoAssetsPresent(dir: string): boolean {
  return geoReport(dir).present;
}

/** Which egress the download takes (ADR-0022): the machine's own network or
 *  the Clash core's selected node. */
export type MihomoGeoLeg = 'machine' | 'node';

export interface GeoLegFetchOptions {
  /** `node` leg only: the core's mixed port — the exit it already listens on. */
  mixedPort?: number;
  /** Test seam — a CI box's own OS settings are not the fixture. */
  osProxyReader?: () => Promise<OsProxyEndpoint | undefined>;
}

/**
 * The proxy URL the machine leg should dial for `url`: the OS system proxy
 * unless the host sits on its bypass list. `undefined` means connect directly.
 */
export function machineLegProxy(endpoint: OsProxyEndpoint | undefined, url: string): string | undefined {
  if (!endpoint) return undefined;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return undefined;
  }
  if (osProxyBypasses(host, endpoint.bypass)) return undefined;
  const server = endpoint.server.trim();
  if (!server) return undefined;
  return /^https?:\/\//i.test(server) ? server : `http://${server}`;
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * The fetch implementation the geo download runs on.
 *
 * - `machine` — the way this box's other applications leave: through the OS
 *   system proxy when one is enabled (bypass list honoured), directly when
 *   none is. Needs no running core. The check runs per request, so the
 *   redirect to `objects.githubusercontent.com` is judged on its own host.
 * - `node` — through the core's mixed port, i.e. the operator's selected
 *   node. The caller must refuse this leg while the core is down; by the time
 *   a request lands here the core is expected to be listening.
 */
export async function geoFetchForLeg(leg: MihomoGeoLeg, opts: GeoLegFetchOptions = {}): Promise<typeof fetch> {
  if (leg === 'node') {
    const port = opts.mixedPort;
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
      throw new Error('mixed port unavailable for the node leg');
    }
    const proxy = `http://127.0.0.1:${port}`;
    return (input, init) => fetchViaProxy(inputUrl(input), init ?? {}, proxy);
  }
  const endpoint = await (opts.osProxyReader ?? readOsProxyEndpoint)();
  return (input, init) => {
    const url = inputUrl(input);
    const proxy = machineLegProxy(endpoint, url);
    return proxy ? fetchViaProxy(url, init ?? {}, proxy) : fetch(input, init);
  };
}

export interface DownloadMihomoGeoOptions {
  /** Test seam — suites never touch GitHub. */
  fetchImpl?: typeof fetch;
  /** Re-fetch files that already exist (the console's "sync" action). Without
   *  it a present file is kept, so a retry after a partial failure only
   *  fetches the missing one. */
  refresh?: boolean;
  /** Per-file byte progress of the WHOLE asset (resumed prefix included);
   *  `total` is 0 when the host sends no Content-Length. */
  onProgress?: (file: MihomoGeoKey, downloaded: number, total: number) => void;
  /** Cancels the transfer. The bytes written so far are kept for the next
   *  attempt, so closing the console tab pauses a geo sync rather than
   *  discarding it. */
  signal?: AbortSignal;
}

export interface DownloadMihomoGeoResult {
  ok: boolean;
  present: boolean;
  files: MihomoGeoFileInfo[];
  error?: string;
  code?: string;
}

/**
 * The digest MetaCubeX publishes for one asset, or undefined when the host
 * would not give one. Best-effort by design: a refused `.sha256sum` costs the
 * verification, never the download — the operator still gets the database, and
 * the transfer is still resumable from the recorded ETag.
 */
async function resolveAssetDigest(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${url}${SHA256SUM_SUFFIX}`, { headers, ...(signal ? { signal } : {}) });
    if (!res.ok) return undefined;
    return parseAssetDigest((await res.text()).trim().split(/\s+/)[0]);
  } catch {
    return undefined;
  }
}

async function fetchAsset(
  asset: typeof MIHOMO_GEO_ASSETS[number],
  dir: string,
  fetchImpl: typeof fetch,
  onProgress?: DownloadMihomoGeoOptions['onProgress'],
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; code: string; error: string }> {
  const dest = path.join(dir, asset.file);
  const { partPath } = assetPartPaths(dest);
  const headers = { 'User-Agent': USER_AGENT, Accept: 'text/plain' };
  const digest = await resolveAssetDigest(fetchImpl, asset.url, headers, signal);
  const downloaded = await downloadAssetToFile({
    url: asset.url,
    partPath,
    fetchImpl,
    maxBytes: MAX_GEO_BYTES,
    ...(digest ? { sha256: digest } : {}),
    headers: { 'User-Agent': USER_AGENT },
    ...(signal ? { signal } : {}),
    ...(onProgress ? { onProgress: (bytes, total) => onProgress(asset.key, bytes, total) } : {}),
  });
  if (!downloaded.ok) {
    if (downloaded.code === 'download-too-large') {
      return { ok: false, code: 'geo-download-too-large', error: 'geo data download exceeded 64MB' };
    }
    if (downloaded.code === 'write-failed') {
      const message = downloaded.error.includes('(') ? downloaded.error : `(${downloaded.error})`;
      return { ok: false, code: 'geo-download-failed', error: `could not write ${asset.file} ${message}` };
    }
    if (downloaded.code === 'checksum-failed') {
      // Distinct from a network failure: the host served a file that is not the
      // published database, so retrying cannot help until upstream is fixed.
      return { ok: false, code: 'checksum-failed', error: `${asset.file} did not match the published digest` };
    }
    // A cancelled or truncated transfer keeps its `.part`: the next sync picks up
    // where this one stopped. Every other failure already destroyed the part.
    return { ok: false, code: 'geo-download-failed', error: downloaded.error };
  }

  // The verified bytes already sit in the staging file, so the install is the
  // rename alone: they are never copied back through memory, and the database
  // mihomo parses is never a half-written one.
  try {
    if (fs.statSync(partPath).size === 0) {
      cleanupAssetPart(partPath);
      return { ok: false, code: 'geo-download-failed', error: `geo data download was empty (${asset.file})` };
    }
    renameWithRetry(partPath, dest);
  } catch (err) {
    cleanupAssetPart(partPath);
    const message = err instanceof Error ? err.message : 'write failed';
    return { ok: false, code: 'geo-download-failed', error: `could not install ${asset.file} (${message})` };
  }
  // The part is gone with the rename; this clears its sidecar.
  cleanupAssetPart(partPath);
  return { ok: true };
}

/**
 * Install the geo databases into the core's work directory. Existing non-empty
 * files are kept unless `refresh` asks for replacement (a retry after a partial
 * failure only fetches the missing one); a file that fails to download or write
 * never replaces a working copy. Each asset is one critical section (ADR-0022):
 * a second click waits instead of writing the same part file underneath it.
 */
export async function downloadMihomoGeoAssets(
  dir: string,
  opts: DownloadMihomoGeoOptions = {},
): Promise<DownloadMihomoGeoResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  fs.mkdirSync(dir, { recursive: true });
  for (const asset of MIHOMO_GEO_ASSETS) {
    if (!opts.refresh && fileInfo(dir, asset).exists) continue;
    const outcome = await withAssetLock(path.join(dir, asset.file), () => fetchAsset(asset, dir, fetchImpl, opts.onProgress, opts.signal));
    if (!outcome.ok) {
      return { ok: false, present: geoAssetsPresent(dir), files: geoReport(dir).files, code: outcome.code, error: outcome.error };
    }
  }
  const report = geoReport(dir);
  return { ok: true, present: report.present, files: report.files };
}
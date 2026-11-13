/**
 * Locate or download the mihomo binary (ADR-0022).
 *
 * Search order when `binaryPath` is empty:
 *   1. `<ocrHome>/bin/mihomo` (`.exe` on Windows) — where the installer writes
 *   2. PATH
 * A configured `binaryPath` that does not exist is a miss: the operator named
 * a file, so a different binary must not be substituted.
 *
 * The downloader fetches a MetaCubeX/mihomo GitHub release asset that matches
 * OS/arch, unpacks gzip (unix) or zip (windows), and installs it under
 * `<ocrHome>/bin`. `fetchImpl` is injectable so tests never touch the network.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { unzipSync } from 'fflate';
import { getOcrHomeDir } from '../cli/paths.js';
import { renameWithRetry } from '../utils/atomic-write.js';

export type MihomoBinarySource = 'configured' | 'home' | 'path';

const RELEASE_API = 'https://api.github.com/repos/MetaCubeX/mihomo/releases';
const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024;
const USER_AGENT = 'omnicell-router';

/** Test seam: the route installer uses this when a suite must not touch GitHub. */
let fetchOverride: typeof fetch | undefined;

export function setMihomoDownloadFetchForTests(impl?: typeof fetch): void {
  fetchOverride = impl;
}

export function mihomoExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'mihomo.exe' : 'mihomo';
}

export function defaultMihomoBinaryPath(platform: NodeJS.Platform = process.platform): string {
  return path.join(getOcrHomeDir(), 'bin', mihomoExecutableName(platform));
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** First PATH entry that contains `name` (Windows also tries `name.exe`). */
export function findOnPath(name: string, pathEnv: string = process.env.PATH || ''): string | null {
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of pathEnv.split(sep)) {
    if (!dir.trim()) continue;
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
    if (process.platform === 'win32' && !name.toLowerCase().endsWith('.exe')) {
      const exe = `${candidate}.exe`;
      if (isFile(exe)) return exe;
    }
  }
  return null;
}

export function resolveMihomoBinary(
  binaryPath?: string,
  pathEnv?: string,
): { path: string | null; source: MihomoBinarySource | null } {
  const configured = (binaryPath || '').trim();
  if (configured) {
    const abs = path.resolve(configured);
    return isFile(abs) ? { path: abs, source: 'configured' } : { path: null, source: null };
  }
  const home = defaultMihomoBinaryPath();
  if (isFile(home)) return { path: home, source: 'home' };
  const found = findOnPath(mihomoExecutableName(), pathEnv);
  return found ? { path: found, source: 'path' } : { path: null, source: null };
}

export interface MihomoAsset {
  name: string;
  gzip: boolean;
}

/**
 * Release asset filename for this OS/arch. `tag` is the GitHub tag
 * (`v1.19.15`). Null when mihomo publishes no build for the pair.
 */
export function mihomoAssetName(platform: NodeJS.Platform, arch: string, tag: string): MihomoAsset | null {
  const goos = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
  const goarch =
    arch === 'x64' ? 'amd64' :
    arch === 'arm64' ? 'arm64' :
    arch === 'ia32' ? '386' :
    arch === 'arm' ? 'armv7' :
    null;
  if (!goos || !goarch || !tag) return null;
  const gzip = goos !== 'windows';
  return { name: `mihomo-${goos}-${goarch}-${tag}.${gzip ? 'gz' : 'zip'}`, gzip };
}

export interface InstallMihomoOptions {
  /** Install destination. Default `<ocrHome>/bin/mihomo`. */
  destPath?: string;
  /** Tag (`v1.19.15` or `1.19.15`). Absent = the GitHub `latest` release. */
  version?: string;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
}

export interface InstallMihomoResult {
  ok: boolean;
  path?: string;
  version?: string;
  error?: string;
  code?: string;
}

function unpack(buf: Buffer, gzip: boolean): Buffer {
  if (gzip) return zlib.gunzipSync(buf);
  const entries = unzipSync(new Uint8Array(buf));
  const names = Object.keys(entries);
  const preferred = names.find((name) => /(^|\/)mihomo\.exe$/i.test(name))
    ?? names.find((name) => /(^|\/)mihomo$/i.test(name))
    ?? names.find((name) => name.toLowerCase().endsWith('.exe'))
    ?? names.find((name) => !name.endsWith('/'));
  if (!preferred) throw new Error('zip contained no executable');
  return Buffer.from(entries[preferred]);
}

export async function installMihomoBinary(opts: InstallMihomoOptions = {}): Promise<InstallMihomoResult> {
  const fetchImpl = opts.fetchImpl ?? fetchOverride ?? fetch;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const requested = (opts.version || '').trim();
  const tag = requested ? (requested.startsWith('v') ? requested : `v${requested}`) : '';
  const api = tag ? `${RELEASE_API}/tags/${encodeURIComponent(tag)}` : `${RELEASE_API}/latest`;
  let release: { tag_name?: unknown; assets?: unknown };
  try {
    const res = await fetchImpl(api, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      return { ok: false, code: 'release-lookup-failed', error: `mihomo release lookup failed (${res.status})` };
    }
    release = (await res.json()) as { tag_name?: unknown; assets?: unknown };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network error';
    return { ok: false, code: 'release-lookup-failed', error: `mihomo release lookup failed (${message})` };
  }
  const version = typeof release.tag_name === 'string' && release.tag_name.trim() ? release.tag_name.trim() : tag;
  if (!version) return { ok: false, code: 'release-lookup-failed', error: 'mihomo release has no tag' };
  const wanted = mihomoAssetName(platform, arch, version);
  if (!wanted) {
    return { ok: false, code: 'unsupported-platform', error: `no mihomo build for ${platform}/${arch}` };
  }
  const assets = Array.isArray(release.assets) ? release.assets as Array<{ name?: unknown; browser_download_url?: unknown }> : [];
  const asset = assets.find((item) => item.name === wanted.name);
  const downloadUrl = asset && typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '';
  if (!downloadUrl) {
    return { ok: false, code: 'asset-missing', error: `release ${version} has no ${wanted.name}` };
  }
  let packed: Buffer;
  try {
    const res = await fetchImpl(downloadUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' },
    });
    if (!res.ok) return { ok: false, code: 'download-failed', error: `mihomo download failed (${res.status})` };
    packed = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network error';
    return { ok: false, code: 'download-failed', error: `mihomo download failed (${message})` };
  }
  if (packed.length > MAX_DOWNLOAD_BYTES) {
    return { ok: false, code: 'download-too-large', error: 'mihomo download exceeded 80MB' };
  }
  let bytes: Buffer;
  try {
    bytes = unpack(packed, wanted.gzip);
  } catch {
    return { ok: false, code: 'unpack-failed', error: 'mihomo archive could not be unpacked' };
  }
  if (bytes.length === 0) return { ok: false, code: 'unpack-failed', error: 'mihomo archive was empty' };
  const dest = opts.destPath ?? defaultMihomoBinaryPath(platform);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.download`;
    fs.writeFileSync(tmp, bytes);
    if (platform !== 'win32') fs.chmodSync(tmp, 0o755);
    renameWithRetry(tmp, dest);
    if (platform !== 'win32') fs.chmodSync(dest, 0o755);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'write failed';
    return { ok: false, code: 'install-failed', error: `could not install mihomo (${message})` };
  }
  return { ok: true, path: dest, version };
}

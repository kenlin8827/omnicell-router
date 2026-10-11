import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { proxiedFetch } from '../../utils/proxy.js';

/**
 * Local disk cache + HTTP proxy for remote catalog logos (models.dev, OpenRouter).
 *
 * Catalog records carry REMOTE logo URLs; handing them straight to the browser
 * means every page render re-fetches from the origin — and fails offline. The
 * console exposes GET /api/admin/catalog/logo?url=... which serves a cached
 * copy from ~/.cache/opencode-router/logos/ and only hits the network on a
 * miss (or after the soft TTL), falling back to an even-stale copy on error.
 */

/** Logos are static assets; refresh at most weekly (stale copies still serve offline). */
const LOGO_TTL_MS = 7 * 24 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 8000;
/** Hard cap — a logo is an icon; anything larger is abuse or a wrong payload. */
const MAX_LOGO_BYTES = 512 * 1024;

/** Only these hosts may be proxied (SSRF guard — the console API is unauthenticated). */
const ALLOWED_LOGO_HOSTS = new Set(['models.dev', 'openrouter.ai']);

export const LOGO_PROXY_PATH = '/api/admin/catalog/logo';

export function isAllowedLogoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_LOGO_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Rewrite a remote logo URL to the cached console proxy path (passthrough if not allow-listed). */
export function localLogoApiPath(url?: string): string | undefined {
  if (!url || !isAllowedLogoUrl(url)) return url;
  return `${LOGO_PROXY_PATH}?url=${encodeURIComponent(url)}`;
}

interface LogoCacheState {
  fetchedAt: number;
  contentType: string;
  base64: string;
}

function logoCacheFile(url: string): string {
  const dir = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
  return path.join(dir, 'opencode-router', 'logos', `${hash}.json`);
}

export function readLogoCache(url: string): LogoCacheState | null {
  try {
    const file = logoCacheFile(url);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LogoCacheState;
    if (!parsed || typeof parsed.fetchedAt !== 'number' || typeof parsed.base64 !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeLogoCache(url: string, state: LogoCacheState): void {
  try {
    const file = logoCacheFile(url);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // best effort
  }
}

/** One network attempt per URL at a time (concurrent <img> renders share the fetch). */
const inflight = new Map<string, Promise<LogoCacheState | null>>();

async function fetchLogo(url: string): Promise<LogoCacheState | null> {
  try {
    const res = await proxiedFetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'OpenCode-Router/1.0' },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_LOGO_BYTES) return null;
    const state: LogoCacheState = {
      fetchedAt: Date.now(),
      contentType: res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/svg+xml',
      base64: buf.toString('base64'),
    };
    writeLogoCache(url, state);
    return state;
  } catch {
    return null;
  }
}

/**
 * Cached logo fetch: fresh cache → serve; else fetch-and-store; on network
 * failure serve the even-stale copy; nothing at all → null (caller sends 404).
 */
export async function getLogoCached(url?: string): Promise<{ contentType: string; body: Buffer } | null> {
  if (!url || !isAllowedLogoUrl(url)) return null;
  const cached = readLogoCache(url);
  if (cached && Date.now() - cached.fetchedAt < LOGO_TTL_MS) {
    return { contentType: cached.contentType, body: Buffer.from(cached.base64, 'base64') };
  }
  let pending = inflight.get(url);
  if (!pending) {
    pending = fetchLogo(url).finally(() => inflight.delete(url));
    inflight.set(url, pending);
  }
  const fresh = await pending;
  if (fresh) return { contentType: fresh.contentType, body: Buffer.from(fresh.base64, 'base64') };
  if (cached) return { contentType: cached.contentType, body: Buffer.from(cached.base64, 'base64') };
  return null;
}

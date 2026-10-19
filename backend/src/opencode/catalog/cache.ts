import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CatalogSourceState } from './types.js';

/**
 * Per-source disk cache under ~/.cache/onecast-router/ (XDG_CACHE_HOME aware).
 * Reads return even-stale payloads so callers can degrade gracefully offline.
 */

function getCacheDir(): string {
  const xdgCache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(xdgCache, 'onecast-router');
}

export function readCacheFile<T>(name: string): CatalogSourceState<T> | null {
  try {
    const file = path.join(getCacheDir(), `${name}.json`);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as CatalogSourceState<T>;
    if (!parsed || typeof parsed.fetchedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeCacheFile<T>(name: string, data: T): void {
  try {
    const file = path.join(getCacheDir(), `${name}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: Date.now(), data }), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // best effort
  }
}

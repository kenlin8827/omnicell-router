import fs from 'node:fs';
import path from 'node:path';
import { getOcrHomeDir } from '../cli/paths.js';
import { renameWithRetry } from '../utils/atomic-write.js';

/**
 * The LIVE view's tombstone overlay — the storage half of "clear the live view".
 *
 * Live and history are SCOPES over the same rows (the proxy ring, the plugin day
 * JSONL), not separate stores. A live clear must therefore not touch the feeds:
 * it drops the rows from the ring and hides plugin rows behind this overlay, so
 * the 4 s refresh cannot read them back. History ignores the overlay entirely —
 * the same row stays visible and deletable there (ADR-0017 §5).
 *
 * Keys are the row identity both sides agree on (`id`, else the feed `ts` for
 * rows written before ids existed). Entries expire with the same order of
 * magnitude as the feed retention so the file stays bounded.
 */

export interface LiveHiddenKey {
  key: string;
  ts: number;
}

interface LiveHiddenStore {
  proxy: Record<string, number>;
  plugins: Record<string, Record<string, number>>;
}

const HIDDEN_TTL_MS = 30 * 86_400_000;
const MAX_HIDDEN_KEYS = 10_000;

const storePath = (): string => path.join(getOcrHomeDir(), 'plugins', 'traffic', 'live-hidden.json');

/** Keep finite, unexpired entries; newest `MAX_HIDDEN_KEYS` win. */
function prune(value: unknown, cutoff: number): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  // JSON boundary: a non-array object; every entry is validated by the loop.
  const source = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [key, ts] of Object.entries(source)) {
    if (typeof ts === 'number' && Number.isFinite(ts) && ts >= cutoff) out[key] = ts;
  }
  const entries = Object.entries(out);
  if (entries.length <= MAX_HIDDEN_KEYS) return out;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, MAX_HIDDEN_KEYS));
}

function load(): LiveHiddenStore {
  const empty: LiveHiddenStore = { proxy: {}, plugins: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
  // JSON boundary: a non-array object; the two known sections are validated below.
  const source = parsed as Record<string, unknown>;
  const cutoff = Date.now() - HIDDEN_TTL_MS;
  const store: LiveHiddenStore = { proxy: prune(source.proxy, cutoff), plugins: {} };
  if (source.plugins && typeof source.plugins === 'object' && !Array.isArray(source.plugins)) {
    for (const [decoder, keys] of Object.entries(source.plugins as Record<string, unknown>)) {
      store.plugins[decoder] = prune(keys, cutoff);
    }
  }
  return store;
}

function save(store: LiveHiddenStore): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store));
  renameWithRetry(tmp, file);
}

const normalize = (keys: LiveHiddenKey[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const { key, ts } of keys) {
    if (typeof key === 'string' && key.length > 0 && Number.isFinite(ts)) out[key] = ts;
  }
  return out;
};

/** Hide rows from the live view only. Returns how many keys were recorded. */
export function hideLiveEvents(
  proxy: LiveHiddenKey[],
  plugins: Record<string, LiveHiddenKey[]>
): { proxy: number; plugins: Record<string, number> } {
  const store = load();
  const proxyAdd = normalize(proxy);
  Object.assign(store.proxy, proxyAdd);
  const counts: Record<string, number> = {};
  for (const [decoder, keys] of Object.entries(plugins)) {
    const add = normalize(keys);
    const target = (store.plugins[decoder] ??= {});
    Object.assign(target, add);
    counts[decoder] = Object.keys(add).length;
  }
  save(store);
  return { proxy: Object.keys(proxyAdd).length, plugins: counts };
}

export function liveHiddenProxyIds(): Set<string> {
  return new Set(Object.keys(load().proxy));
}

export function liveHiddenPluginKeys(decoderId: string): Set<string> {
  return new Set(Object.keys(load().plugins[decoderId] ?? {}));
}

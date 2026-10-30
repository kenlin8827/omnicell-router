import fs from 'node:fs';
import path from 'node:path';
import { getOcrHomeDir } from '../../cli/paths.js';
import { latestSnapshot, listMarketplaceEntries, marketplaceSourceId } from '../common/market.js';
import { HOSTS } from '../host/hosts.js';
import type { HarnessHostId } from '../types.js';
import type { CatalogRow, CatalogPage, CatalogSort, CatalogSource } from './types.js';

/**
 * The index tier of the plugin catalog (ADR-0015 §D10): bounded sources harvested into one local
 * store per harness, `<ocrHome>/harness/catalog/<harness>/index.jsonl`.
 *
 * Harvest sources today: operator git marketplaces (their snapshots already exist — the harvest is
 * a read, never a network call). Operator git sources join as federated-tier live sources
 * until a bounded harvest for them is warranted. The store is REPLACED wholesale on each harvest:
 * rows carry their `sourceId`, a disabled/removed source simply disappears on the next harvest.
 *
 * Bounds: `INDEX_ROWS_MAX` per harness. Over cap, rows are dropped source-by-source in reverse
 * registration order — the operator's oldest sources are the most valuable, and the deficit is
 * reported in query notes rather than silently truncated mid-source.
 *
 * One JSON object per line (JSONL) so a torn write loses a tail, not the file.
 */

const INDEX_ROWS_MAX = 2000;

function catalogDir(harness: string): string {
  return path.join(getOcrHomeDir(), 'harness', 'catalog', harness);
}

function indexFile(harness: string): string {
  return path.join(catalogDir(harness), 'index.jsonl');
}

/** Re-harvest EVERY host's index after a store mutation: the marketplace store is GLOBAL (one
 *  marketplaces.json, mp- ids shared), so a stale sibling index would teach a per-harness model the
 *  store does not have. The harvest is a local read over snapshots — cheap by construction. */
export function harvestAll(): void {
  for (const host of HOSTS) harvestIndex(host.id);
}

/** Rebuild one harness's index from every marketplace snapshot that carries plugin rows. */
export function harvestIndex(harness: string): { rows: number; sources: string[] } {
  const perSource: { source: CatalogSource; rows: CatalogRow[] }[] = [];
  for (const entry of listMarketplaceEntries(harness as HarnessHostId)) {
    const snapshot = latestSnapshot(entry.slug, harness as HarnessHostId);
    if (!snapshot || !entry.enabled) continue;
    const sourceId = marketplaceSourceId(entry.slug);
    let rows: CatalogRow[];
    if (entry.type === 'npm') {
      // An npm source's packages ARE the plugin rows; identity is the package (`npm:<pkg>`), so a
      // row registered here and the same package browsed elsewhere join one installed state.
      rows = (snapshot.plugins ?? []).map((p) => ({
        key: `npm:${p.name}`,
        name: p.name,
        summary: p.description,
        stars: null,
        updatedAt: null,
        sourceId,
        surfaces: [sourceId],
        // Package-manager installs are runtime-agnostic; no host claim is invented.
        hosts: [],
        repo: null,
        marketplace: null,
      }));
    } else {
      // SUPPORT IS DETECTED per repository (§D9 amendment): a harness's catalog only carries a
      // source whose snapshot recorded THAT harness's form. Snapshots written before detection
      // existed fall back to the legacy per-harness pin / manifest claim.
      const supported = snapshot.hosts ?? [];
      if (supported.length > 0) {
        if (!supported.includes(harness as HarnessHostId)) continue;
      } else if (entry.harness && entry.harness !== harness) {
        continue;
      }
      // Snapshots written before the `plugins` field existed have no array — read tolerantly.
      rows = (snapshot.plugins ?? []).map((p) => ({
        key: `${sourceId}:${entry.repo}#${p.source}`,
        name: p.name,
        summary: p.description,
        // The snapshot's repo-level stars annotate every row from that repo — a real GitHub count.
        stars: snapshot.stars,
        updatedAt: snapshot.pushedAt ? Date.parse(snapshot.pushedAt) || null : null,
        sourceId,
        surfaces: [sourceId],
        hosts:
          supported.length > 0
            ? dedupeHosts(supported)
            : entry.harness
              ? [entry.harness]
              : dedupeHosts(['claude', ...snapshot.authorAdapters.filter(isKnownHost)]),
        repo: entry.repo,
        // The runtime's install command needs `<plugin>@<marketplace>`; the manifest's own name.
        marketplace: snapshot.marketplace ?? entry.repo.split('/').pop() ?? null,
      }));
    }
    if (rows.length > 0) {
      perSource.push({
        source: {
          id: sourceId,
          label: entry.repo,
          tier: 'index',
          // An npm source has no stars; `name` order is a local sort over its package list.
          sorts: ['name', 'updated', ...(snapshot.stars !== null ? (['stars'] as const) : [])],
          counts: true,
        },
        rows,
      });
    }
  }

  // Enforce the harness cap by dropping newest sources first, whole sources at a time.
  while (perSource.length > 0 && perSource.reduce((n, s) => n + s.rows.length, 0) > INDEX_ROWS_MAX) {
    perSource.pop();
  }
  const rows = perSource.flatMap((s) => s.rows);
  const file = indexFile(harness);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, file);
  return { rows: rows.length, sources: perSource.map((s) => s.source.id) };
}

function isKnownHost(label: string): label is HarnessHostId {
  return label === 'opencode' || label === 'pi' || label === 'claude';
}

function dedupeHosts(xs: HarnessHostId[]): HarnessHostId[] {
  return [...new Set(xs)];
}

/** Read the whole index tier for one harness (a small local file — parse cost is negligible). */
export function readIndex(harness: string): CatalogRow[] {
  try {
    const text = fs.readFileSync(indexFile(harness), 'utf8');
    const rows: CatalogRow[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as CatalogRow);
      } catch {
        // a torn tail line is skipped, never fatal — the next harvest replaces the file
      }
    }
    return rows;
  } catch {
    return [];
  }
}

/** The index-tier source declarations for one harness (only sources that contributed rows). */
export function indexSources(harness: string): CatalogSource[] {
  const rows = readIndex(harness);
  const bySource = new Map<string, CatalogRow[]>();
  for (const row of rows) {
    const list = bySource.get(row.sourceId) ?? [];
    list.push(row);
    bySource.set(row.sourceId, list);
  }
  return [...bySource.entries()].map(([id, rs]) => ({
    id,
    label: id,
    tier: 'index' as const,
    sorts: rs.some((r) => r.stars !== null) ? (['name', 'updated', 'stars'] as const) : (['name', 'updated'] as const),
    counts: true,
  }));
}

export interface IndexQueryResult {
  rows: CatalogRow[];
  total: number;
}

/** Query the index tier: substring match, sort, page — all local. */
export function queryIndex(
  harness: string,
  q: string,
  opts: { page: number; pageSize: number; sort: CatalogSort },
): IndexQueryResult {
  const needle = q.trim().toLowerCase();
  const matched = readIndex(harness).filter(
    (r) => !needle || r.name.toLowerCase().includes(needle) || (r.summary ?? '').toLowerCase().includes(needle),
  );
  sortRows(matched, opts.sort);
  const start = (opts.page - 1) * opts.pageSize;
  return { rows: matched.slice(start, start + opts.pageSize), total: matched.length };
}

/** Deterministic order: the key, then (name, sourceId) as tiebreak — stable across pages. */
export function sortRows(rows: CatalogRow[], sort: CatalogSort): void {
  rows.sort((a, b) => {
    if (sort === 'stars') {
      // `null` sorts last: "never said" is not "zero".
      const sa = a.stars ?? -1;
      const sb = b.stars ?? -1;
      if (sa !== sb) return sb - sa;
    }
    if (sort === 'updated') {
      const ua = a.updatedAt ?? -1;
      const ub = b.updatedAt ?? -1;
      if (ua !== ub) return ub - ua;
    }
    return a.name.localeCompare(b.name) || a.sourceId.localeCompare(b.sourceId);
  });
}

/** Merge dedup: index-tier rows win; a federated hit for the same key only widens `surfaces`. */
export function mergeRow(existing: CatalogRow, incoming: CatalogRow): CatalogRow {
  if (existing.surfaces.includes(incoming.sourceId)) return existing;
  return { ...existing, surfaces: [...existing.surfaces, incoming.sourceId] };
}

export type { CatalogPage };

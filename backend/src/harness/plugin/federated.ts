import { browseSource } from '../market/browse.js';
import type { MarketItem } from '../market/browse.js';
import { SOURCES_VIEW_LOOKUP } from '../market/source-views.js';
import type { CatalogRow, CatalogSection } from './types.js';
import type { HarnessHostId, HarnessSourceView } from '../types.js';

/**
 * The federated tier of the plugin catalog (ADR-0015 §D10): unbounded live directories (pi.dev,
 * queried at request time, NEVER materialized.
 *
 * Co-ordering honesty: a merged global sort across heterogeneous sources is only honest when every
 * participant serves the SAME key. pi.dev ranks by downloads
 * catalog order — none can serve `name`/`stars`/`updated` pages without a full-catalog local sort,
 * which is exactly the unbounded work this tier refuses. So the facade's sorted `rows` stay
 * index-tier-only, and each federated source's answer travels as its own labeled
 * `CatalogSection` in the source's native order with its own total. Nothing is interleaved that
 * cannot be co-ordered; nothing is counted that the source did not state.
 */

/** Per-source latency ceiling — the facade owns the page's worst-case wait. */
const SECTION_TIMEOUT_MS = 8_000;
/** Which source views CAN feed the plugin catalog's federated tier (plugin-kind, browsable). */
const FEDERATED_SOURCE_IDS = ['pi-dev'];

export function federatedSourceViews(): HarnessSourceView[] {
  return FEDERATED_SOURCE_IDS.map((id) => SOURCES_VIEW_LOOKUP[id]).filter(Boolean);
}

/** The federated sources an adapter asks by default: those whose declared hosts cover the harness
 *  (a view with no `hosts` covers every harness). Adapters override per harness — the claude
 *  catalog has no federated plugin directory today, so its adapter narrows to none. */
export function federatedIdsFor(harness: HarnessHostId): string[] {
  return federatedSourceViews()
    .filter((v) => !v.hosts || v.hosts.includes(harness))
    .map((v) => v.id);
}

/** Ask the given federated sources; failures and timeouts degrade to a labeled note, never a throw. */
export async function federatedSections(
  harness: HarnessHostId,
  q: string,
  opts: { page: number; pageSize: number },
  fetchImpl: typeof fetch = fetch,
  sourceIds: string[] = federatedIdsFor(harness),
): Promise<CatalogSection[]> {
  const jobs = sourceIds.map((id) => SOURCES_VIEW_LOOKUP[id]).filter(Boolean).map(async (view): Promise<CatalogSection> => {
    try {
      const result = await withTimeout(
        browseSource(view, q, opts.pageSize, { harness, page: opts.page, kind: 'plugin', fetchImpl }),
        SECTION_TIMEOUT_MS,
        `${view.label} did not answer within ${SECTION_TIMEOUT_MS / 1000}s`,
      );
      if (!result.ok) {
        return { sourceId: view.id, label: view.label, rows: [], note: result.message };
      }
      return {
        sourceId: view.id,
        label: view.label,
        rows: result.items.filter((i) => i.installKind === 'plugin').map(toCatalogRow),
        ...(result.total !== undefined
          ? { total: result.total, totalExact: result.totalScope !== 'window' }
          : {}),
      };
    } catch (e) {
      return {
        sourceId: view.id,
        label: view.label,
        rows: [],
        note: e instanceof Error ? e.message : `${view.label} failed`,
      };
    }
  });
  return Promise.all(jobs);
}

function toCatalogRow(item: MarketItem): CatalogRow {
  return {
    // The MarketItem key IS the portable install handle (`npm:<pkg>`); it doubles as the merge key.
    key: item.key,
    name: item.name,
    summary: item.description,
    stars: item.stars,
    updatedAt: item.updatedAt ? Date.parse(item.updatedAt) || null : null,
    sourceId: item.sourceId,
    surfaces: [item.sourceId],
    hosts: viewHosts(item.sourceId),
    repo: item.repo ?? null,
  };
}

/** The source view's own harness binding (`hosts`), or `[]` when the source is harness-agnostic. */
function viewHosts(sourceId: string): HarnessHostId[] {
  return SOURCES_VIEW_LOOKUP[sourceId]?.hosts ?? [];
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

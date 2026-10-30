import type { HarnessHostId } from '../types.js';
import type { InstallResult } from '../host/install.js';

/**
 * The plugin catalog vocabulary (ADR-0015 §D10 — two-tier catalog, one directory per harness).
 *
 * The catalog is a MERGE of heterogeneous sources, and honesty rules decide what may participate:
 *
 *   - **index tier** — bounded sources (operator git marketplaces, curated static registries)
 *     harvested into a local store (`index.jsonl` per harness). Browse/search/sort/paginate hit
 *     local bytes: no upstream request, no network dependency, snapshot-backed with history.
 *   - **federated tier** — unbounded live directories (npm, pi.dev, ClawHub, GitHub search). Rows
 *     are NEVER materialized; each source adapter declares its capabilities and answers queries.
 *
 * The sorting contract (§D10): the ADAPTER owns the order — it returns pages strictly sorted by
 * the requested key; the facade performs a SAME-KEY k-way merge and never re-sorts federated
 * pages (re-sorting merged page windows yields a wrong global order and broken pagination).
 * `stars` sorting only includes sources whose stars are a real GitHub count; sources without a
 * trustworthy star are excluded from that merge and the exclusion is reported, never papered over.
 */

export type CatalogTier = 'index' | 'federated';

export type CatalogSort = 'name' | 'stars' | 'updated';

/** What one contributing source declares about itself. */
export interface CatalogSource {
  /** Source id as it appears in row keys (`mp-ponytail`, `npm`, `pi-dev`, …). */
  id: string;
  label: string;
  tier: CatalogTier;
  /** Sort keys this source can honestly serve. Stars require a real GitHub count. */
  sorts: CatalogSort[];
  /** `total` is only known when the upstream states it; `null` = the facade reports a lower bound. */
  counts: boolean;
}

/** One plugin row in a harness catalog. Plugin-kind ONLY — skills and MCP rows live elsewhere. */
export interface CatalogRow {
  /** Merge/dedup identity: `npm:<pkg>` for npm-backed rows, `github:<owner/repo>#<detail>` for git rows. */
  key: string;
  name: string;
  summary: string | null;
  /** Real GitHub star count, or `null` — "the catalog never said" stays apart from "nobody starred it". */
  stars: number | null;
  /** Upstream update timestamp (ms epoch), when the source states one. */
  updatedAt: number | null;
  /** The source this row was harvested/answered from. */
  sourceId: string;
  /** Every surface the same plugin was seen on (dedup merges multi-source hits). */
  surfaces: string[];
  /** Harnesses the source declares this plugin installable into; drives per-harness dimming. */
  hosts: HarnessHostId[];
  /** Repo slug `owner/repo` when the row is GitHub-backed — the star-sort and probe anchor. */
  repo: string | null;
}

export interface CatalogPage {
  rows: CatalogRow[];
  page: number;
  pageSize: number;
  /** True when more rows exist beyond this page (across the merged set). */
  hasMore: boolean;
  /** Exact total only when every contributing source states one; otherwise `null`. */
  total: number | null;
  /** Honest footnotes: degraded sources, star-sort exclusions, snapshot ages. */
  notes: string[];
  /**
   * Federated-tier answers, per source, in the SOURCE's own native order. The console never
   * interleaves rows it cannot co-order: the sorted `rows` above are the index tier (global order,
   * honestly sortable); each federated source's query answer travels as its own labeled section
   * with its own total. Absent section = the source did not answer (see `notes`).
   */
  sections?: CatalogSection[];
}

export interface CatalogSection {
  sourceId: string;
  label: string;
  rows: CatalogRow[];
  total?: number;
  /** false = the source's total is a reachable window, not the population. */
  totalExact?: boolean;
  /** Present when the section is missing/short — the source timed out or degraded. */
  note?: string;
}

/** The per-harness facade over the shared catalog machinery (one implementation per harness). */
export interface PluginAdapter {
  readonly harness: HarnessHostId;
  /** Contributing sources with their capability declarations. */
  sources(): CatalogSource[];
  /** Merged search. Only plugin rows; skills/MCP live on their own axes. */
  search(q: string, opts: { page?: number; pageSize?: number; sort?: CatalogSort }): Promise<CatalogPage>;
  /** Probe a source URL: does it fit this harness's catalog, and what shapes does it carry? */
  checkSource(url: string): Promise<{ ok: boolean; skills: number; mcps: number; plugins: number; message?: string }>;
  registerSource(url: string, opts?: { rescan?: { enabled?: boolean; intervalMs?: number } }): Promise<{ ok: boolean; message?: string }>;
  unregisterSource(slug: string): boolean;
  /**
   * Install one catalog row into THIS harness. A plugin takes exactly one host (the harness is
   * part of its identity, §D5); `row.key` is the portable install handle, `row.surfaces` travel
   * as `listedOn`. Delegates to the ordinary install orchestrator — resolve, payload, writer,
   * manifest — nothing here bypasses the gates.
   */
  install(row: CatalogRow, opts: { scope?: 'global' | 'project' }): Promise<InstallResult>;
}

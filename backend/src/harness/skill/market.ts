import { browseSource } from '../market/browse.js';
import type { MarketItem } from '../market/browse.js';
import { SOURCES_VIEW_LOOKUP } from '../market/source-views.js';
import { getHostAdapter } from '../host/index.js';
import type { InstallChannel } from '../host/request.js';
import type { HarnessHostId } from '../types.js';
import type { InstallResult } from '../host/install.js';

/**
 * The two skill market adapters that ship (ADR-0015 §D11): skills.sh and ClawHub. A market adapter
 * owns DISCOVERY only — browse/search over its source view, rows in the source's own order with the
 * source's own count — and delegates every write to the HOST axis (`getHostAdapter(harness)`),
 * translating the row into a host install request. No other per-harness skill adapters exist: a
 * host without a dedicated class does not have one.
 */

/** A market row as the host axis receives it. */
export interface SkillMarketRow {
  key: string;
  name: string;
  /** Where the row was browsed — travels to the manifest as provenance (§D9 listedOn). */
  sourceId: string;
}

/** Shared machinery: one source view, browse → rows, install → host adapter. */
abstract class BaseSkillMarketAdapter {
  protected constructor(
    readonly harness: HarnessHostId,
    private readonly sourceId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The browse query for this market. Both adapters are catalog-style: an empty query lands on
   *  the source's own default board, a non-empty one goes to its search. */
  async search(
    q: string,
    opts: { page?: number; pageSize?: number; sort?: string } = {},
  ): Promise<{ ok: boolean; rows: MarketItem[]; total?: number; message?: string }> {
    const view = SOURCES_VIEW_LOOKUP[this.sourceId];
    if (!view) return { ok: false, rows: [], message: `source view '${this.sourceId}' unavailable` };
    const result = await browseSource(view, q, opts.pageSize ?? 24, {
      harness: this.harness,
      page: Math.max(1, opts.page ?? 1),
      sort: opts.sort,
      kind: 'skill',
      fetchImpl: this.fetchImpl,
    });
    if (!result.ok) return { ok: false, rows: [], message: result.message };
    return {
      ok: true,
      rows: result.items.filter((i) => i.installKind === 'skill'),
      ...(result.total !== undefined ? { total: result.total } : {}),
    };
  }

  async install(row: SkillMarketRow, opts: { scope?: 'global' | 'project' } = {}): Promise<InstallResult> {
    return getHostAdapter(this.harness).installSkill({
      kind: 'skill',
      channel: channelOf(row.key),
      key: row.key,
      scope: opts.scope,
      listedOn: [row.sourceId],
      fetchImpl: this.fetchImpl,
    });
  }
}

/** skills.sh — the leaderboard whose row IS a skill directory (`github:<owner/repo>#<dir>`). */
export class SkillShMarketAdapter extends BaseSkillMarketAdapter {
  constructor(harness: HarnessHostId, fetchImpl?: typeof fetch) {
    super(harness, 'skills-sh', fetchImpl);
  }
}

/** ClawHub — the OpenClaw registry whose rows are slugs (`clawhub:<slug>`) served as its own
 *  registry download, not a GitHub ref. */
export class ClawhubSkillMarketAdapter extends BaseSkillMarketAdapter {
  constructor(harness: HarnessHostId, fetchImpl?: typeof fetch) {
    super(harness, 'clawhub', fetchImpl);
  }
}

function channelOf(key: string): InstallChannel {
  if (key.startsWith('npm:')) return 'npm';
  if (key.startsWith('clawhub:')) return 'registry';
  return 'github';
}

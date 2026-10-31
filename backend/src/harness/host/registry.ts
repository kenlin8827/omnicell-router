import { clawhubAdapter } from './resolvers/clawhub.js';
import { githubAdapter } from './resolvers/github.js';
import { npmAdapter } from './resolvers/npm.js';
import { gitMarketplaceAdapter } from './resolvers/git-marketplace.js';
import { getMarketplaceEntry } from '../common/market.js';
import type { SourceAdapter } from '../spi.js';

/**
 * Source adapter registry (ADR-0015 §8).
 *
 * Onboarding a marketplace = one adapter file + one entry here — never a route or page edit. Sources
 * declared in the console's SOURCES view but absent here answer install requests with
 * `unsupported_source` instead of pretending.
 */

const ADAPTERS: SourceAdapter[] = [

  clawhubAdapter,
  githubAdapter,

  npmAdapter,


];

export function getAdapter(sourceId: string): SourceAdapter | undefined {
  // Operator git marketplaces are per-slug adapters (`mp-<slug>`), materialized on demand from the
  // marketplace store — one entry in the store, not one row in this table.
  if (sourceId.startsWith('mp-')) {
    const entry = getMarketplaceEntry(sourceId.slice(3));
    return entry && entry.enabled !== false ? gitMarketplaceAdapter(entry) : undefined;
  }
  return ADAPTERS.find((a) => a.id === sourceId);
}

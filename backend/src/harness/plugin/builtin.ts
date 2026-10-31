import type { HarnessHostId, HarnessSourceView } from '../types.js';
import { getBrowseView } from '../common/market.js';

/**
 * Default PLUGIN marketplace views per harness — the plugin slice of the PER-HARNESS tier (the
 * console route pairs this with `MCP_DEFAULT_VIEWS` for the MCP axis).
 *
 * Skill sources are GLOBAL and live in `common/source-views.ts` (`SKILL_VIEWS`): a skill registry
 * is not a harness's private market, so it never appears in this table. A plugin default exists
 * only where a harness natively ships a remote registry (Pi's pi.dev); the rest are empty by
 * default and filled by operator-synced sources.
 */
export function getDefaultViewsForHarness(harness: HarnessHostId): HarnessSourceView[] {
  if (harness === 'pi') {
    const pi = getBrowseView('pi-dev');
    if (pi) return [pi];
    try {
      const { createRequire } = require('node:module');
      const r = createRequire(import.meta.url);
      const mod = (r('./adapters/pi-dev.js') || r('./pi-dev.js')) as { PI_DEV_VIEW?: HarnessSourceView };
      if (mod?.PI_DEV_VIEW) return [mod.PI_DEV_VIEW];
    } catch {
      // ignore
    }
  }
  // No native plugin registry for this harness.
  return [];
}

/** Backward-compatible alias for getDefaultViewsForHarness */
export const getBuiltinViewsForHarness = getDefaultViewsForHarness;

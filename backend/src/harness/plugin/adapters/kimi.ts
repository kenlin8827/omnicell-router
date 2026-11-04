import { BasePluginMarketAdapter } from './base.js';
import type { ProbeOptions } from '../../common/market.js';

/**
 * Kimi Code's market (ADR-0015 §D10). The vendor's canonical manifest is a ROOT
 * `kimi.plugin.json` (`name`, `description`, …) — the layout the vendor docs' own example
 * plugin ships (no `.kimi-plugin/` directory involved). It is read for the row's
 * name/description and installs from the whole repository. When a `.kimi-plugin/` directory
 * ALSO exists, the root manifest still wins (the vendor's documented precedence), which the
 * probe engine already guarantees by checking the declared manifest before the directory
 * fallback. A repo carrying only the directory keeps the directory-as-plugin answer: the
 * vendor JSON inside it is not parsed.
 *
 * `name` is validated against the vendor's id grammar
 * (`[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*(@[A-Za-z0-9_-]+)?`): a manifest whose id could never
 * install is not a manifest.
 */
const KIMI_ID_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*(@[A-Za-z0-9_-]+)?$/;

export const KIMI_PROBE_OPTIONS: ProbeOptions = {
  manifest: {
    file: 'kimi.plugin.json',
    atRoot: true,
    base: 'repo',
    read: (manifest) => {
      const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
      if (!name || !KIMI_ID_RE.test(name)) return null;
      return { name, description: typeof manifest.description === 'string' ? manifest.description : null };
    },
  },
  directoryPlugin: { base: 'repo' },
};

export class KimiPluginMarketAdapter extends BasePluginMarketAdapter {
  protected probeOptions(): ProbeOptions {
    return KIMI_PROBE_OPTIONS;
  }
}

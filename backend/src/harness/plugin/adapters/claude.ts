import { BasePluginMarketAdapter } from './base.js';
import type { CatalogReader, MarketplacePluginRow, ParsedManifest, ProbeOptions } from '../../common/market.js';

/**
 * Claude Code's market (ADR-0015 §D10): operator git marketplaces only. No federated plugin
 * directory serves claude today, so the federated tier is empty — search answers from the index
 * store alone.
 *
 * This file OWNS the converged marketplace FORMAT (`plugins[].source` are REPO-RELATIVE paths —
 * exactly the shape `openai/codex-plugin-cc` publishes, `source: "./plugins/codex"`). Claude's own
 * form is `.claude-plugin/marketplace.json`; the grok / Copilot / AGENTS clones are the SAME format
 * under their own directories, claimed by their own adapters (`grok.ts`, `copilot.ts`,
 * `universal.ts`) which reuse this parser. The shared probe executes only the hooks it is given.
 */
export const CLAUDE_MANIFEST_PATHS = ['.claude-plugin/marketplace.json'];

/**
 * Read a Claude-shaped marketplace manifest. `parsed` is false when the file is not JSON at all —
 * an unparseable manifest is NOT a manifest, and the probe falls back to a whole-tree scan rather
 * than trusting an empty scope. Only REPO-RELATIVE `./…` sources become rows; external sources
 * (`git-subdir`, `url`, `npm`, …) are reported as present but never guessed at.
 */
export function parseClaudeMarketplace(manifestText: string): ParsedManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    return { ok: false };
  }
  const root = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const name = typeof root.name === 'string' ? root.name : null;
  const description = typeof root.description === 'string' ? root.description : null;
  const plugins = Array.isArray(root.plugins) ? root.plugins : [];
  const dirs: string[] = [];
  const pluginRows: MarketplacePluginRow[] = [];
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== 'object') continue;
    const p = plugin as Record<string, unknown>;
    if (typeof p.source === 'string' && p.source.startsWith('./') && !p.source.includes('..')) {
      const dir = p.source.replace(/^\.\//, '');
      dirs.push(dir);
      if (typeof p.name === 'string' && p.name) {
        pluginRows.push({
          name: p.name,
          source: dir,
          description: typeof p.description === 'string' ? p.description : null,
        });
      }
    }
  }
  return { ok: true, dirs: [...new Set(dirs)], plugins: pluginRows, name, description };
}

export const CLAUDE_CATALOG: CatalogReader = {
  paths: (layer) => (layer ? [`${layer}/marketplace.json`] : CLAUDE_MANIFEST_PATHS),
  parse: parseClaudeMarketplace,
};

/** Claude's own standard form is the `.claude-plugin/marketplace.json` catalog; that catalog is
 *  the probe. A directory without one is not a Claude marketplace, whatever else it carries. */
export const CLAUDE_PROBE_OPTIONS: ProbeOptions = { catalog: CLAUDE_CATALOG };

export class ClaudePluginMarketAdapter extends BasePluginMarketAdapter {
  protected probeOptions(): ProbeOptions {
    return CLAUDE_PROBE_OPTIONS;
  }
}

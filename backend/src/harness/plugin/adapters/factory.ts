import { BasePluginMarketAdapter } from './base.js';
import { parseClaudeMarketplace } from './claude.js';
import type { ProbeOptions } from '../../common/market.js';

/**
 * Factory Droid's market (ADR-0015 §D10). `droid plugin marketplace add <url>` reads
 * `.factory-plugin/marketplace.json` (the converged catalog) and the directory also carries a
 * single-plugin `plugin.json`; the catalog is tried first, the manifest answers when it is absent.
 */
export const FACTORY_PROBE_OPTIONS: ProbeOptions = {
  catalog: {
    paths: (layer) => (layer ? [`${layer}/marketplace.json`] : ['.factory-plugin/marketplace.json']),
    parse: parseClaudeMarketplace,
  },
  directoryPlugin: { base: 'repo' },
};

export class FactoryPluginMarketAdapter extends BasePluginMarketAdapter {
  protected probeOptions(): ProbeOptions {
    return FACTORY_PROBE_OPTIONS;
  }
}

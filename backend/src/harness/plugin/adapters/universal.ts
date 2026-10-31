import { BasePluginMarketAdapter } from './base.js';
import { parseClaudeMarketplace } from './claude.js';
import type { ProbeOptions } from '../../common/market.js';

/**
 * The Universal host (ADR-0015 §D10): the AGENTS-convention consumer, which reads
 * `.agents/plugins/marketplace.json` — the Goose-style clone of the same converged format. The
 * READER is Claude's (the format owner); this file claims only the DIRECTORY.
 */
export const UNIVERSAL_PROBE_OPTIONS: ProbeOptions = {
  catalog: {
    paths: (layer) => (layer ? [`${layer}/marketplace.json`] : ['.agents/plugins/marketplace.json']),
    parse: parseClaudeMarketplace,
  },
};

export class UniversalPluginMarketAdapter extends BasePluginMarketAdapter {
  protected probeOptions(): ProbeOptions {
    return UNIVERSAL_PROBE_OPTIONS;
  }
}

import { BasePluginMarketAdapter } from './base.js';
import { parseClaudeMarketplace } from './claude.js';
import type { ProbeOptions } from '../../common/market.js';

/**
 * Grok CLI's market (ADR-0015 §D10). Its per-harness form lives in `.grok-plugin/` and uses the
 * converged marketplace format — grok ships no format of its own. The READER is Claude's (the
 * format owner, `claude.ts`); this file claims only the DIRECTORY and the harness identity.
 *
 * Grok is a served host for skills only (no verified plugin landing), so the plugin page never
 * opens on it; the shape is declared here so enabling the plugin landing needs no market change,
 * and so a source registered for `grok` is probed with its own layer.
 */
export const GROK_PROBE_OPTIONS: ProbeOptions = {
  catalog: {
    paths: (layer) => (layer ? [`${layer}/marketplace.json`] : ['.grok-plugin/marketplace.json']),
    parse: parseClaudeMarketplace,
  },
  directoryPlugin: { base: 'repo' },
};

export class GrokPluginMarketAdapter extends BasePluginMarketAdapter {
  protected probeOptions(): ProbeOptions {
    return GROK_PROBE_OPTIONS;
  }
}

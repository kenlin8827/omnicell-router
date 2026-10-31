import { BasePluginMarketAdapter } from './base.js';
import { parseClaudeMarketplace } from './claude.js';
import type { ProbeOptions } from '../../common/market.js';

/**
 * GitHub Copilot / VS Code's market (ADR-0015 §D10). Its per-harness form lives in
 * `.github/plugin/` and uses the converged marketplace format; the READER is Claude's (the format
 * owner), this file claims only the DIRECTORY and the harness identity.
 */
export const COPILOT_PROBE_OPTIONS: ProbeOptions = {
  catalog: {
    paths: (layer) => (layer ? [`${layer}/marketplace.json`] : ['.github/plugin/marketplace.json']),
    parse: parseClaudeMarketplace,
  },
  // The catalog is the standard form; a repository that ships only its own
  // `.github/plugin/` directory (no catalog) is still one Copilot plugin — the DIRECTORY is the
  // signal, and its vendor JSON is never parsed by a shared schema.
  directoryPlugin: { base: 'repo' },
};

export class CopilotPluginMarketAdapter extends BasePluginMarketAdapter {
  protected probeOptions(): ProbeOptions {
    return COPILOT_PROBE_OPTIONS;
  }
}

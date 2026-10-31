import { BasePluginMarketAdapter } from './base.js';
import type { ProbeOptions } from '../../common/market.js';

/**
 * Codex's market (ADR-0015 §D10). Codex plugins are published in a `.codex-plugin/` directory at
 * the repository root (`codex plugin marketplace add <repo>` reads that directory — ponytail,
 * postman-plugin and codex-plugin-cc all ship it). The DIRECTORY is the probe: its existence makes
 * the repository one Codex plugin, and the scan stays on the repository's own skill tree. Codex's
 * manifest file inside the directory is vendor-specific and is not parsed through a shared schema.
 */
export const CODEX_PROBE_OPTIONS: ProbeOptions = {
  directoryPlugin: { base: 'repo' },
};

export class CodexPluginMarketAdapter extends BasePluginMarketAdapter {
  protected probeOptions(): ProbeOptions {
    return CODEX_PROBE_OPTIONS;
  }
}

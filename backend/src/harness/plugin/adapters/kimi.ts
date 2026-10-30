import { BasePluginMarketAdapter } from './base.js';
import type { ProbeOptions } from '../../common/market.js';

/**
 * Kimi Code's market (ADR-0015 §D10). `/plugins install <repo-url>` reads the repository's
 * `.kimi-plugin/` directory. Kimi's manifest file is vendor-specific and not a shared schema, so
 * the DIRECTORY is the signal: its existence makes the repository one Kimi plugin. No JSON is
 * guessed at.
 */
export const KIMI_PROBE_OPTIONS: ProbeOptions = {
  directoryPlugin: { base: 'repo' },
};

export class KimiPluginMarketAdapter extends BasePluginMarketAdapter {
  protected probeOptions(): ProbeOptions {
    return KIMI_PROBE_OPTIONS;
  }
}

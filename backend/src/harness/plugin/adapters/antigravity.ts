import { BasePluginMarketAdapter } from './base.js';
import type { ProbeOptions } from '../../common/market.js';

/**
 * Antigravity's market (ADR-0015 §D10). `agy plugin install <url>` reads the repository's
 * `.antigravity-plugin/` directory. The manifest inside is vendor-specific, so the DIRECTORY's
 * existence is the plugin signal — no shared manifest schema is assumed.
 */
export const ANTIGRAVITY_PROBE_OPTIONS: ProbeOptions = {
  directoryPlugin: { base: 'repo' },
};

export class AntigravityPluginMarketAdapter extends BasePluginMarketAdapter {
  protected probeOptions(): ProbeOptions {
    return ANTIGRAVITY_PROBE_OPTIONS;
  }
}

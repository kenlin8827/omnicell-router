import { BasePluginMarketAdapter } from './base.js';
import type { ProbeOptions } from '../../common/market.js';

/**
 * Gemini CLI's market (ADR-0015 §D10). Its form is a ROOT manifest, `gemini-extension.json`
 * (`name`, `description`, `contextFileName`), installed from the whole repository — the same shape
 * `gemini extensions install <repo>` reads. No extension directory is involved, so this adapter
 * supplies a root-level manifest reader only.
 */
export const GEMINI_PROBE_OPTIONS: ProbeOptions = {
  manifest: {
    file: 'gemini-extension.json',
    atRoot: true,
    base: 'repo',
    read: (manifest) =>
      typeof manifest.name === 'string' && manifest.name.trim()
        ? { name: manifest.name.trim(), description: typeof manifest.description === 'string' ? manifest.description : null }
        : null,
  },
};

export class GeminiPluginMarketAdapter extends BasePluginMarketAdapter {
  protected probeOptions(): ProbeOptions {
    return GEMINI_PROBE_OPTIONS;
  }
}

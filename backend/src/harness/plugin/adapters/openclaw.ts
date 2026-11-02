import { BasePluginMarketAdapter } from './base.js';
import type { ProbeOptions } from '../../common/market.js';

/**
 * OpenClaw's market (ADR-0015 §D10). The native manifest is a ROOT `openclaw.plugin.json`
 * whose required field is `id` (string, vendor plugin reference) — it is read for the row's
 * name/description and installs from the whole repository. ClawHub (the vendor's federated
 * directory) has no public search API; the federated tier is empty and search answers from the
 * index store alone.
 *
 * OpenClaw also auto-discovers loose plugin/bundle directories under `.openclaw/extensions`
 * (host adapter `host/adapters/openclaw.ts`), but that is an INSTALL landing, not a published
 * form: the probe claims the root manifest alone and never guesses a directory-keyed answer.
 * ClawHub (`https://clawhub.ai`) is the vendor's federated plugin directory — it serves a public
 * `GET /api/v1/plugins` catalog, but no federated browse tier is built for it (pi.dev remains the
 * only federated plugin source); search answers from the index store alone.
 */
export const OPENCLAW_PROBE_OPTIONS: ProbeOptions = {
  manifest: {
    file: 'openclaw.plugin.json',
    atRoot: true,
    base: 'repo',
    read: (manifest) => {
      const name = typeof manifest.id === 'string' ? manifest.id.trim() : '';
      if (!name) return null;
      return {
        name,
        description: typeof manifest.description === 'string' ? manifest.description : null,
      };
    },
  },
};

export class OpenClawPluginMarketAdapter extends BasePluginMarketAdapter {
  protected probeOptions(): ProbeOptions {
    return OPENCLAW_PROBE_OPTIONS;
  }
}

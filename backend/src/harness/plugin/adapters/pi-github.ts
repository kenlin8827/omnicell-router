import { PiPluginMarketAdapter } from './pi-dev.js';
import type { ProbeOptions } from '../../common/market.js';

/**
 * Pi, operator git sources (ADR-0015 §D10). The counterpart of `pi.ts`: this file owns everything
 * a shared git repository can carry for pi, while `pi.ts` owns the official pi.dev surface.
 *
 * Pi's writable git-source probe: only pi's own form is recognized — the pinned layer is an npm
 * package (`pi-extension/package.json`). Claude's `marketplace.json` is not pi's format and is not
 * read here; a repo without a package layer answers from its `SKILL.md` tree.
 *
 * The layer is a DEFAULT, not a rule: the console pre-fills `pi-extension` from the host adapter,
 * but the operator may point the source at any repo-relative directory when registering it.
 */
export const PI_PROBE_OPTIONS: ProbeOptions = {
  manifest: {
    file: 'package.json',
    base: 'layer',
    read: (manifest) =>
      typeof manifest.name === 'string' && manifest.name.trim()
        ? { name: manifest.name.trim(), description: typeof manifest.description === 'string' ? manifest.description : null }
        : null,
  },
};

/** pi, operator git sources: git marketplaces (index tier) + the official pi.dev catalog. */
export class PiGithubPluginMarketAdapter extends PiPluginMarketAdapter {
  protected probeOptions(): ProbeOptions {
    return PI_PROBE_OPTIONS;
  }
}

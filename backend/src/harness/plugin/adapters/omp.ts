import { BasePluginMarketAdapter } from './base.js';
import { parseClaudeMarketplace } from './claude.js';
import type { ProbeOptions } from '../../common/market.js';

/**
 * OMP (oh-my-pi)'s plugin market (ADR-0015 §D10).
 *
 * The vendor's own authoring guide (`docs/skills/authoring-marketplaces.md`) defines the form as a
 * CATALOG at `.omp-plugin/marketplace.json`, falling back to Claude Code's
 * `.claude-plugin/marketplace.json` — the converged shape, read by the same parser. Users install a
 * row with `omp plugin marketplace add <repo>` followed by
 * `omp plugin install <plugin>@<marketplace>` (the `omp` host adapter's `extSpec`).
 *
 * The Claude fallback is a PROBE too, not only a catalog path: `allHostProbes()` emits a second omp
 * probe pinned to `.claude-plugin` so a repository that ships only the Claude layout is detected for
 * omp, exactly as the vendor's fallback reads it.
 */
export const OMP_PROBE_OPTIONS: ProbeOptions = {
  catalog: {
    paths: (layer) =>
      layer ? [`${layer}/marketplace.json`] : ['.omp-plugin/marketplace.json', '.claude-plugin/marketplace.json'],
    parse: parseClaudeMarketplace,
  },
};

export class OmpPluginMarketAdapter extends BasePluginMarketAdapter {
  protected probeOptions(): ProbeOptions {
    return OMP_PROBE_OPTIONS;
  }
}

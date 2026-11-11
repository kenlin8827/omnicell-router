import { BasePluginMarketAdapter } from './base.js';
import type { ProbeOptions } from '../../common/market.js';

/**
 * DeepSeek Harness's plugin market (ADR-0015 §D10).
 *
 * A DSH plugin is a BUNDLE: a package whose `package.json` declares `dsh.bundle` — the patch DSH
 * applies to its own `cordis.patch.yml` when the bundle is selected — and `dsh plugin add <spec>`
 * mounts exactly that. No directory convention is involved, so the form is a ROOT manifest.
 *
 * Every JavaScript repository ships a `package.json`, so presence alone proves nothing: `detect`
 * keeps DSH support only for a document that really declares a bundle. That is the same rule the
 * vendor's own market enforces when it lists a version ("every listed version declares
 * `dsh.bundle`"), and the same one `plugin_manager.install_bundle` applies at install time.
 */

/** The `dsh.bundle` declaration a package publishes, or null when it is not a DSH bundle. */
export function dshBundleOf(manifest: unknown): { patch: string } | null {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const dsh = (manifest as Record<string, unknown>).dsh;
  if (!dsh || typeof dsh !== 'object' || Array.isArray(dsh)) return null;
  const bundle = (dsh as Record<string, unknown>).bundle;
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return null;
  const patch = (bundle as Record<string, unknown>).patch;
  return typeof patch === 'string' && patch.trim() ? { patch: patch.trim() } : null;
}

export const DSH_PROBE_OPTIONS: ProbeOptions = {
  manifest: {
    file: 'package.json',
    atRoot: true,
    base: 'repo',
    detect: (manifest) => dshBundleOf(manifest) !== null,
    read: (manifest) => {
      if (!dshBundleOf(manifest)) return null;
      const name = manifest.name;
      if (typeof name !== 'string' || !name.trim()) return null;
      return {
        name: name.trim(),
        description: typeof manifest.description === 'string' ? manifest.description : null,
      };
    },
  },
};

export class DshPluginMarketAdapter extends BasePluginMarketAdapter {
  protected probeOptions(): ProbeOptions {
    return DSH_PROBE_OPTIONS;
  }
}

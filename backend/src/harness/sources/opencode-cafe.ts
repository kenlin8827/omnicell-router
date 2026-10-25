import { resolveCatalogPackage } from '../catalog-npm.js';
import { fetchCafeExtensions } from '../opencode-cafe.js';
import type { ResolveOptions, ResolveOutcome, SourceAdapter } from '../spi.js';

/**
 * opencode.cafe install adapter (ADR-0015 §D6).
 *
 * Same shape as the other catalog adapter, with one extra guard the catalog itself demands: its rows
 * are typed, and only `type: 'plugin'` is an extension. `mcp-server`, `slash-command`, `theme`,
 * `web-view`, `tool` and `fork` rows would install the wrong thing — an MCP server belongs to the MCP
 * market, a slash command is a markdown template, a web view is an app. A market that offers them
 * under "extensions" is lying about what the click does.
 */
export const opencodeCafeAdapter: SourceAdapter = {
  id: 'opencode-cafe',
  kinds: ['extension'],
  trust: 'community',
  hosts: ['opencode'],

  async resolve(ref: string, kind: 'skill' | 'mcp' | 'extension', opts: ResolveOptions = {}): Promise<ResolveOutcome> {
    if (kind !== 'extension') {
      return {
        ok: false,
        code: 'unsupported_kind',
        message: `source 'opencode-cafe' resolves extension packages only (kind '${kind}' has no reader here)`,
      };
    }
    const fetchImpl = opts.fetchImpl ?? fetch;
    const registry = await fetchCafeExtensions(fetchImpl);
    if (!registry.ok) return { ok: false, code: registry.code, message: registry.message };

    // The catalog declares mcp-server / slash-command / hook / theme / web-view / plugin / fork /
    // tool rows; only `plugin` is an installable extension here.
    const entry = registry.entries.find((e) => e.type === 'plugin' && e.productId === ref);
    if (!entry) {
      return {
        ok: false,
        code: 'no_artifact',
        message: `'${ref}' is not a plugin entry in the opencode.cafe catalog`,
      };
    }
    return resolveCatalogPackage(entry, kind, { fetchImpl });
  },
};

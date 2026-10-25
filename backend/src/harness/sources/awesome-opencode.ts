import { fetchAwesomeRegistry } from '../awesome-opencode.js';
import { resolveCatalogPackage } from '../catalog-npm.js';
import type { ResolveOptions, ResolveOutcome, SourceAdapter } from '../spi.js';

/**
 * awesome-opencode install adapter (ADR-0015 §D6).
 *
 * The community registry names no npm package, so browsing is not enough to install: the entry has to
 * be turned into a package spec at install time. The earning rules are shared with every other catalog
 * (`catalog-npm.ts`); this adapter only reads the registry and guards the row's category — `themes`,
 * `agents`, `projects` and `resources` are not extensions, and listing one in an extension market
 * would be a category error.
 */
export const awesomeAdapter: SourceAdapter = {
  id: 'awesome-opencode',
  kinds: ['extension'],
  trust: 'community',
  hosts: ['opencode'],

  async resolve(ref: string, kind: 'skill' | 'mcp' | 'extension', opts: ResolveOptions = {}): Promise<ResolveOutcome> {
    if (kind !== 'extension') {
      return {
        ok: false,
        code: 'unsupported_kind',
        message: `source 'awesome-opencode' resolves extension packages only (kind '${kind}' has no reader here)`,
      };
    }
    const fetchImpl = opts.fetchImpl ?? fetch;
    const registry = await fetchAwesomeRegistry(fetchImpl);
    if (!registry.ok) return { ok: false, code: registry.code, message: registry.message };

    const entry = registry.entries.find((e) => e.type === 'plugins' && e.productId === ref);
    if (!entry) {
      return {
        ok: false,
        code: 'no_artifact',
        message: `'${ref}' is not a plugin in the awesome-opencode registry`,
      };
    }
    return resolveCatalogPackage(entry, kind, { fetchImpl });
  },
};

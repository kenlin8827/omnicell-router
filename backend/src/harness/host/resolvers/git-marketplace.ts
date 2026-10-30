import { githubAdapter } from './github.js';
import type { MarketplaceEntry } from '../../market/marketplaces.js';
import { marketplaceSourceId } from '../../market/marketplaces.js';
import type { ResolveOutcome, SourceAdapter } from '../../spi.js';

/**
 * Operator git-marketplace source (ADR-0015 §D6 "git-repo source type").
 *
 * One adapter instance per configured marketplace (`mp-<slug>`); the resolve itself is DELEGATED to
 * the github adapter — the ref grammar (`owner/repo#dir`), the tarball pull, the caps and the pin
 * are that adapter's already-audited contract. This factory exists to keep two things true:
 *
 *   · provenance — the resolved canonicalKey is rewritten to `mp-<slug>:…` so the manifest records
 *     WHERE the operator browsed the row, never a `github:` key that would weld every marketplace's
 *     installs onto the built-in source's identity;
 *   · containment — only the CONFIGURED repo resolves under this source id. A key naming another
 *     repository would install third-party content under a provenance it did not come from.
 */

export function gitMarketplaceAdapter(entry: MarketplaceEntry): SourceAdapter {
  const sourceId = marketplaceSourceId(entry.slug);
  return {
    id: sourceId,
    kinds: ['skill'],
    trust: 'community',

    async resolve(ref, kind, opts): Promise<ResolveOutcome> {
      if (kind !== 'skill') {
        return { ok: false, code: 'unsupported_kind', message: `source '${sourceId}' cannot resolve kind '${kind}'` };
      }
      const [repoPath, pinnedDir] = ref.split('#');
      if (repoPath !== entry.repo) {
        return {
          ok: false,
          code: 'no_artifact',
          message: `source '${sourceId}' only serves its configured repository '${entry.repo}'`,
        };
      }
      if (!pinnedDir) {
        // The browse rows carry explicit `#dir` pins; a bare repo ref would guess. Point at the
        // market instead of ambiguously resolving whatever SKILL.md comes first.
        return {
          ok: false,
          code: 'no_artifact',
          message: `source '${sourceId}' requires a '#<skill-dir>' pin — browse its rows for one`,
        };
      }
      const resolved = await githubAdapter.resolve(ref, kind, opts);
      if (!resolved.ok) return resolved;
      return {
        ...resolved,
        canonicalKey: `${sourceId}:${ref}`,
        storeKey: `${sourceId}__${resolved.storeKey ?? resolved.payload.name}`,
      };
    },
  };
}

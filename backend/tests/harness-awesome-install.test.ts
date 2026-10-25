import { describe, expect, it } from 'bun:test';
import { awesomeAdapter } from '../src/harness/sources/awesome-opencode.js';

/**
 * awesome-opencode install adapter: the registry names no package, so `resolve` must EARN a package
 * name — either the entry declares one, or a probed candidate's own `repository` field points back at
 * the same project. Existence alone is never accepted (supply-chain rule).
 */

const REGISTRY = [
  {
    productId: 'declared',
    type: 'plugins',
    displayName: 'Declared Plugin',
    repoUrl: 'https://github.com/acme/declared-plugin',
    homepageUrl: 'https://www.npmjs.com/package/@acme/opencode-declared',
    description: 'Declares its package on the homepage.',
  },
  {
    productId: 'probing',
    type: 'plugins',
    displayName: 'Probing Plugin',
    repoUrl: 'https://github.com/acme/opencode-probing',
    description: 'Names no package; the repo name is the package.',
  },
  {
    productId: 'squatted',
    type: 'plugins',
    displayName: 'Squatted',
    repoUrl: 'https://github.com/victim/opencode-squatted',
    description: 'A same-named package exists but belongs to somebody else.',
  },
  {
    productId: 'no-package',
    type: 'plugins',
    displayName: 'No Package',
    repoUrl: 'https://github.com/nobody/opencode-no-package',
    description: 'Nothing on npm points back at this repo.',
  },
  {
    productId: 'a-theme',
    type: 'themes',
    displayName: 'A Theme',
    repoUrl: 'https://github.com/acme/theme',
    description: 'Not an extension.',
  },
];

interface Pkg {
  version: string;
  /** What the package claims in its own `repository` field. */
  repository?: string;
}

const NPM: Record<string, Pkg> = {
  '@acme/opencode-declared': { version: '1.2.3', repository: 'git+https://github.com/acme/declared-plugin.git' },
  'opencode-probing': { version: '0.4.0', repository: 'git+https://github.com/acme/opencode-probing.git' },
  // Exists, but points somewhere else — must never be adopted for `victim/opencode-squatted`.
  'opencode-squatted': { version: '9.9.9', repository: 'git+https://github.com/attacker/opencode-squatted.git' },
};

/** Minimal registry stand-in: `/latest`, packument, and a concrete version document. */
function stubFetch(seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith('/registry.json')) {
      return new Response(JSON.stringify(REGISTRY), { status: 200 });
    }
    const m = /^https:\/\/registry\.npmjs\.org\/(.+)$/.exec(url);
    if (!m) return new Response('not found', { status: 404 });
    const path = decodeURIComponent(m[1]!);
    const lastSlash = path.lastIndexOf('/');
    const head = path.slice(0, lastSlash);
    const tail = path.slice(lastSlash + 1);
    const scoped = path.startsWith('@') && !NPM[path];

    // `/pkg/latest`
    if (tail === 'latest' && NPM[head]) {
      const p = NPM[head]!;
      return new Response(JSON.stringify({ name: head, version: p.version, repository: p.repository }), { status: 200 });
    }
    // `/pkg` (packument)
    if (!scoped && NPM[path]) {
      return new Response(JSON.stringify({ name: path, 'dist-tags': { latest: NPM[path]!.version } }), { status: 200 });
    }
    // scoped packument: `@scope/name`
    if (path.startsWith('@') && NPM[path]) {
      return new Response(JSON.stringify({ name: path, 'dist-tags': { latest: NPM[path]!.version } }), { status: 200 });
    }
    // `/pkg/<semver>`
    for (const [name, p] of Object.entries(NPM)) {
      if (path === `${name}/${p.version}`) {
        return new Response(
          JSON.stringify({ name, version: p.version, description: 'stub', dist: { integrity: 'sha512-stub' } }),
          { status: 200 }
        );
      }
    }
    return new Response('{"error":"Not found"}', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('awesomeAdapter.resolve', () => {
  it('adopts a package name the entry declares, and answers the npm identity', async () => {
    const result = await awesomeAdapter.resolve('declared', 'extension', { fetchImpl: stubFetch() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // One artifact, one key: the identity belongs to the PACKAGE, not to the discovery source.
    expect(result.canonicalKey).toBe('npm:@acme/opencode-declared');
    expect(result.payload.kind).toBe('extension');
    if (result.payload.kind !== 'extension') return;
    expect(result.payload.spec).toBe('@acme/opencode-declared@1.2.3');
    expect(result.pin).toEqual({ npm: { integrity: 'sha512-stub' } });
  });

  it('probes the repo name and accepts it only when the package points back at the repo', async () => {
    const result = await awesomeAdapter.resolve('probing', 'extension', { fetchImpl: stubFetch() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canonicalKey).toBe('npm:opencode-probing');
    if (result.payload.kind !== 'extension') return;
    expect(result.payload.spec).toBe('opencode-probing@0.4.0');
  });

  it('refuses a same-named package whose repository points at another project', async () => {
    const seen: string[] = [];
    const result = await awesomeAdapter.resolve('squatted', 'extension', { fetchImpl: stubFetch(seen) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no_artifact');
    expect(result.message).toContain('verified');
    // It did look — and rejected on identity, not on absence.
    expect(seen.some((u) => u.includes('opencode-squatted/latest'))).toBe(true);
  });

  it('answers no_artifact when nothing on npm belongs to the entry', async () => {
    const result = await awesomeAdapter.resolve('no-package', 'extension', { fetchImpl: stubFetch() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no_artifact');
    expect(result.message).toContain('github.com/nobody/opencode-no-package');
  });

  it('refuses a catalog entry that is not a plugin', async () => {
    const result = await awesomeAdapter.resolve('a-theme', 'extension', { fetchImpl: stubFetch() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no_artifact');
    expect(result.message).toContain('not a plugin');
  });

  it('refuses a kind it cannot produce a payload for', async () => {
    const result = await awesomeAdapter.resolve('probing', 'skill', { fetchImpl: stubFetch() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unsupported_kind');
  });
});

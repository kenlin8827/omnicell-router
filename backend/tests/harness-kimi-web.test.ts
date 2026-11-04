import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installViaKimiWeb, type KimiWebChild } from '../src/harness/host/writers/kimi-web.js';
import { applyPlugin, planPlugin } from '../src/harness/host/writers/plugin.js';
import { allHostProbes } from '../src/harness/plugin/adapters/index.js';
import { addMarketplaceEntry, getMarketplaceEntry, probeMarketplace } from '../src/harness/common/market.js';

/**
 * Kimi Code's web-API install (ADR-0015 §D9 amendment, 2026-11-01). The vendor ships NO
 * non-interactive CLI plugin verb (`kimi -p` treats slash commands as prompt text — proven by
 * experiment), but `kimi web` (kap-server) exposes the SAME PluginManager over loopback REST:
 *
 *     GET  /api/v1/healthz   (unauthenticated readiness)
 *     POST /api/v1/plugins   {source} → vendor download/manifest/managed-copy/install
 *     POST /api/v1/shutdown
 *
 * These tests script that surface with a fake spawn + fake fetch — no vendor binary is started.
 * The writer plan/apply tests use harness 'kimi' through the real adapter (which now declares the
 * webApi landing instead of the retired interactive `/plugins install` chain).
 */

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-kimi-web-'));
}


interface FakeChild extends KimiWebChild {
  argv: string[];
  env: NodeJS.ProcessEnv;
  killed: boolean;
}

/** A fake spawned server: kill() resolves `exited` (what a SIGTERM-clean vendor child does). */
function fakeChild(argv: string[], env: NodeJS.ProcessEnv): FakeChild {
  let resolveExited!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => (resolveExited = resolve));
  const child: FakeChild = {
    argv,
    env,
    killed: false,
    exited,
    kill: () => {
      child.killed = true;
      resolveExited(0);
    },
  };
  return child;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A fake kap-server: healthz optional, one install response (envelope or raw), shutdown swallowed. */
function fakeFetch(handlers: { healthzOk?: boolean; installBody?: unknown; installRaw?: string; installStatus?: number }): {
  fetchImpl: typeof fetch;
  calls: { url: string; method: string; auth?: string | null; body?: string }[];
} {
  const calls: { url: string; method: string; auth?: string | null; body?: string }[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      auth: typeof init?.headers === 'object' && init.headers !== null
        ? ((init.headers as Record<string, string>).authorization ?? null)
        : null,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    if (url.endsWith('/api/v1/healthz')) {
      return handlers.healthzOk === false ? new Response('down', { status: 503 }) : json({ ok: true });
    }
    if (url.endsWith('/api/v1/plugins')) {
      if (handlers.installRaw !== undefined) return new Response(handlers.installRaw, { status: handlers.installStatus ?? 200 });
      return json(handlers.installBody ?? { code: 0, msg: 'success' }, handlers.installStatus ?? 200);
    }
    if (url.endsWith('/api/v1/shutdown')) return json({ ok: true });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('installViaKimiWeb', () => {
  it('boots a transient kimi web, posts the source with the home token, and tears down', async () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, 'server.token'), 'test-token\n');
    const child = fakeChild([], {});
    const { fetchImpl, calls } = fakeFetch({
      installBody: { code: 0, msg: 'success', data: { id: 'kimi-finance', displayName: 'Kimi Finance', version: '1.0.0' } },
    });
    const outcome = await installViaKimiWeb('https://github.com/acme/kimi-finance', {
      homeDir: home,
      teardownGraceMs: 50,
      spawnImpl: (argv, env) => {
        const c = fakeChild(argv, env);
        Object.assign(child, c);
        return c;
      },
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.plugin.id).toBe('kimi-finance');
      expect(outcome.plugin.version).toBe('1.0.0');
    }
    // Boot argv: the vendor server, loopback-only, no browser, ephemeral port, explicit home.
    expect(child.argv[0]).toBe('kimi');
    expect(child.argv.slice(1, 3)).toEqual(['web', '--no-open']);
    expect(child.argv[child.argv.length - 2]).toBe('--port');
    expect(Number(child.argv[child.argv.length - 1])).toBeGreaterThan(0);
    expect(child.env.KIMI_CODE_HOME).toBe(home);
    // The install POST carries the source and the bearer token read from server.token.
    const post = calls.find((c) => c.url.endsWith('/api/v1/plugins'));
    expect(post?.method).toBe('POST');
    expect(post?.auth).toBe('Bearer test-token');
    expect(post?.body).toBe(JSON.stringify({ source: 'https://github.com/acme/kimi-finance' }));
    // Teardown: the transient server is shut down, and the child is released.
    expect(calls.some((c) => c.url.endsWith('/api/v1/shutdown'))).toBe(true);
    expect(child.killed || (await child.exited) !== null).toBe(true);
  });

  it('maps a vendor refusal envelope to an honest failure', async () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, 'server.token'), 'test-token\n');
    const { fetchImpl } = fakeFetch({
      installBody: { code: 40409, msg: 'Plugin root does not exist: /x', data: null },
    });
    const outcome = await installViaKimiWeb('/x', {
      homeDir: home,
      teardownGraceMs: 50,
      spawnImpl: (_argv, env) => fakeChild(_argv, env),
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toContain('40409');
      expect(outcome.message).toContain('Plugin root does not exist');
    }
  });

  it('fails honestly when the server never answers healthz', async () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, 'server.token'), 'test-token\n');
    const { fetchImpl } = fakeFetch({ healthzOk: false });
    const outcome = await installViaKimiWeb('https://github.com/acme/p', {
      homeDir: home,
      bootTimeoutMs: 600,
      teardownGraceMs: 50,
      spawnImpl: (argv, env) => fakeChild(argv, env),
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('healthz');
  });

  it('fails honestly on a non-JSON install response', async () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, 'server.token'), 'test-token\n');
    const { fetchImpl } = fakeFetch({ installRaw: '<html>gateway error</html>' });
    const outcome = await installViaKimiWeb('https://github.com/acme/p', {
      homeDir: home,
      teardownGraceMs: 50,
      spawnImpl: (argv, env) => fakeChild(argv, env),
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('non-JSON');
  });
});

describe('plugin writer — kimi webapi target', () => {
  it('plans a git-backed row as a webapi POST of the repository URL', () => {
    const plan = planPlugin({
      sourceId: 'github',
      canonicalKey: 'github:acme/kimi-finance',
      spec: 'github:acme/kimi-finance',
      trust: 'community',
      harness: 'kimi',
      scope: 'global',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.targets).toHaveLength(1);
    const target = plan.targets[0]!;
    expect(target.op).toBe('webapi');
    expect(target.source).toBe('https://github.com/acme/kimi-finance');
    expect(target.echo).toContain('POST /api/v1/plugins');
    expect(target.added).toBe(true);
  });

  it('drops the marketplace layer pin — the vendor resolves the plugin root from its manifest', () => {
    const plan = planPlugin({
      sourceId: 'mp-pony',
      canonicalKey: 'mp-pony:acme/kimi-finance#skills/using-finance',
      spec: 'acme/kimi-finance',
      trust: 'community',
      harness: 'kimi',
      scope: 'global',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.targets[0]!.op).toBe('webapi');
    expect(plan.targets[0]!.source).toBe('https://github.com/acme/kimi-finance');
  });

  it('a git-backed row carrying marketplace identity still plans to the webapi — no CLI chain exists', () => {
    const plan = planPlugin({
      sourceId: 'mp-pony',
      canonicalKey: 'mp-pony:acme/kimi-finance#skills/using-finance',
      spec: 'kimi-finance',
      trust: 'community',
      harness: 'kimi',
      scope: 'global',
      marketplace: { repo: 'acme/kimi-finance', plugin: 'kimi-finance', name: 'pony' },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.targets).toHaveLength(1);
    const target = plan.targets[0]!;
    expect(target.op).toBe('webapi');
    // A marketplace row stages a local clone — the vendor's GitHub resolver 404s on
    // marketplace-form repositories; its local-path branch installs cleanly.
    expect(target.cloneRepo).toBe('acme/kimi-finance');
    expect(target.echo).toContain('git clone --depth 1 https://github.com/acme/kimi-finance.git');
    expect(target.echo).toContain('POST /api/v1/plugins');
  });

  it('refuses a non-github key instead of guessing a source', () => {
    const plan = planPlugin({
      sourceId: 'npm',
      canonicalKey: 'npm:@scope/some-plugin',
      spec: '@scope/some-plugin',
      trust: 'community',
      harness: 'kimi',
      scope: 'global',
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.message).toContain('github repository key');
  });

  it('apply posts the source and records an external vendor-store copy', async () => {
    // The isolated runner already sandboxes OCR_HOME for the manifest write; no override here.
    const home = tmpHome();
    fs.writeFileSync(path.join(home, 'server.token'), 'test-token\n');
    const { fetchImpl, calls } = fakeFetch({
      installBody: { code: 0, msg: 'success', data: { id: 'kimi-finance' } },
    });
    const applied = await applyPlugin({
      sourceId: 'github',
      canonicalKey: 'github:acme/kimi-finance',
      spec: 'github:acme/kimi-finance',
      trust: 'community',
      harness: 'kimi',
      scope: 'global',
      fetchImpl,
      webApiDeps: { homeDir: home, teardownGraceMs: 50, spawnImpl: (argv, env) => fakeChild(argv, env) },
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.copies).toEqual([{ host: 'kimi', path: 'github:acme/kimi-finance#kimi', external: true }]);
    expect(applied.runs).toHaveLength(1);
    expect(applied.runs[0]!.code).toBe(0);
    expect(applied.runs[0]!.command).toContain('POST /api/v1/plugins');
    const post = calls.find((c) => c.url.endsWith('/api/v1/plugins'));
    expect(post?.body).toBe(JSON.stringify({ source: 'https://github.com/acme/kimi-finance' }));
  });

  it('apply maps a vendor refusal to an upstream failure with no manifest copy', async () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, 'server.token'), 'test-token\n');
    const { fetchImpl } = fakeFetch({
      installBody: { code: 40409, msg: 'Plugin root does not exist: /x', data: null },
    });
    const applied = await applyPlugin({
      sourceId: 'github',
      canonicalKey: 'github:acme/gone',
      spec: 'github:acme/gone',
      trust: 'community',
      harness: 'kimi',
      scope: 'global',
      fetchImpl,
      webApiDeps: { homeDir: home, teardownGraceMs: 50, spawnImpl: (argv, env) => fakeChild(argv, env) },
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.code).toBe('upstream');
    expect(applied.message).toContain('40409');
    expect(applied.copies ?? []).toHaveLength(0);
  });
});

describe('plugin writer — kimi webapi support gate', () => {
  let stagedRoot: string | undefined;
  const SHA = 'c'.repeat(40);

  /** Minimal GitHub fake: repo meta, HEAD sha, one tree, then blob contents by path keyword. */
  function ghFetch(opts: { tree: { path: string; type: string }[]; marketplace?: string; kimiJson?: string }): typeof fetch {
    return (async (input: unknown) => {
      const url = String(input);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.endsWith('/repos/owner/repo')) return json({ default_branch: 'main', stargazers_count: 29, pushed_at: '2026-01-01T00:00:00Z' });
      if (url.endsWith('/repos/owner/repo/commits/main')) return json({ sha: SHA });
      if (url.includes('/git/trees/')) return json({ tree: opts.tree });
      if (url.includes('marketplace.json')) return new Response(opts.marketplace ?? 'not json', { status: 200 });
      if (url.includes('kimi.plugin.json') && opts.kimiJson) return new Response(opts.kimiJson, { status: 200 });
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  }

  const CLAUDE_ONLY_TREE = [{ path: '.claude-plugin/marketplace.json', type: 'blob' }];
  const KIMI_TREE = [{ path: 'kimi.plugin.json', type: 'blob' }];
  const MP_KEY = 'mp-postman:owner/repo#postman';

  async function probedPlan(tree: { path: string; type: string }[], kimiJson?: string) {
    const prev = process.env.OCR_HOME;
    process.env.OCR_HOME = tmpHome();
    try {
      addMarketplaceEntry({ slug: 'postman', repo: 'owner/repo' });
      const entry = getMarketplaceEntry('postman')!;
      const probe = await probeMarketplace(entry, ghFetch({ tree, kimiJson }), { hosts: allHostProbes() });
      expect(probe.ok).toBe(true);
      return planPlugin({
        sourceId: 'mp-postman',
        canonicalKey: MP_KEY,
        spec: 'postman',
        trust: 'community',
        harness: 'kimi',
        scope: 'global',
        marketplace: { repo: 'owner/repo', plugin: 'postman', name: 'postman' },
      });
    } finally {
      if (prev === undefined) delete process.env.OCR_HOME;
      else process.env.OCR_HOME = prev;
    }
  }

  it("refuses a claude-only marketplace repo (the postmanlabs/postman-plugin shape) at plan time — no vendor 40001", async () => {
    const plan = await probedPlan(CLAUDE_ONLY_TREE);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]!.added).toBe(false);
    expect(plan.targets[0]!.refused).toContain("no 'kimi' plugin form");
    expect(plan.targets[0]!.refused).toContain('claude');
  });

  it('plans the webapi POST when the repository declares a kimi form', async () => {
    const plan = await probedPlan(KIMI_TREE, JSON.stringify({ name: 'kimi-finance', description: 'finance' }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]!.op).toBe('webapi');
    expect(plan.targets[0]!.source).toBe('https://github.com/owner/repo');
  });

  it('apply stages a local clone for a marketplace row, posts its path, and cleans up', async () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, 'server.token'), 'test-token\n');
    const { fetchImpl, calls } = fakeFetch({
      installBody: { code: 0, msg: 'success', data: { id: 'postman', displayName: 'Postman', version: '2.2.0' } },
    });
    const applied = await applyPlugin({
      sourceId: 'mp-postman',
      canonicalKey: 'mp-postman:postmanlabs/postman-plugin#',
      spec: 'postman',
      trust: 'community',
      harness: 'kimi',
      scope: 'global',
      marketplace: { repo: 'postmanlabs/postman-plugin', plugin: 'postman', name: 'postman' },
      fetchImpl,
      webApiDeps: {
        homeDir: home,
        teardownGraceMs: 50,
        spawnImpl: (argv, env) => fakeChild(argv, env),
        gitImpl: async (repo, root) => {
          // The staging root must sit under the OS temp dir with the ocr-kimi- prefix — the
          // vendor stat()s the absolute path it is POSTed.
          if (!root.includes('ocr-kimi-')) return { code: 1, stderr: 'no staging dir' };
          fs.mkdirSync(root, { recursive: true });
          stagedRoot = root;
          return { code: 0, stderr: '' };
        },
      },
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(stagedRoot).toBeTruthy();
    const post = calls.find((c) => c.url.endsWith('/api/v1/plugins'));
    const body = JSON.parse(post!.body!) as { source: string };
    // The vendor's local-path branch: the POSTed source is the staging clone, not a GitHub URL.
    expect(body.source).toBe(stagedRoot);
    expect(fs.existsSync(stagedRoot)).toBe(false);
  });
});

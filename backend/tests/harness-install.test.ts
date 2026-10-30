import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import fastify from 'fastify';
import { skillDirs } from '../src/harness/tree.js';
import { normalizeName } from '../src/harness/spi.js';
import { githubAdapter } from '../src/harness/host/resolvers/github.js';
import { applySkill } from '../src/harness/host/writers/skill.js';
import { installArtifact } from '../src/harness/host/install.js';
import { scanInventory } from '../src/harness/host/inventory.js';
import { claimPath, readManifest } from '../src/harness/host/manifest.js';
import { registerHarnessRoutes } from '../src/routes/harness.js';

/**
 * Harness install path (ADR-0015 §8) — resolve (network, injected fetch) and write (disk, sandboxed
 * by the isolated runner's OCR_HOME / project-scope tmp root) tested separately, plus the
 * orchestrator's dispatch, the ambiguity contract for multi-skill repositories and the install
 * route's boundary validation.
 */

const SHA = 'a'.repeat(40);

/** Minimal ustar entry + data, padded — exactly what readTarball needs, nothing exotic. */
function tarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name.slice(0, 100), 0, 'utf8');
  header.write('0000644', 100, 'utf8');
  header.write('0000000', 108, 'utf8');
  header.write('0000000', 116, 'utf8');
  header.write(data.length.toString(8).padStart(11, '0') + ' ', 124, 'utf8');
  header.write('00000000000', 136, 'utf8');
  header.write('        ', 148, 'utf8');
  header.write('0', 156, 'utf8');
  header.write('ustar\0', 257, 'ascii');
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([header, data, pad]);
}

function buildTar(entries: { name: string; data: Buffer }[]): Buffer {
  const body = Buffer.concat([...entries.map((e) => tarEntry(e.name, e.data)), Buffer.alloc(1024, 0)]);
  return zlib.gzipSync(body);
}

function fakeGithubFetch(tree: { path: string; type: string }[], tarball?: Buffer): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url === 'https://api.github.com/repos/owner/repo') return json({ default_branch: 'main' });
    if (url === 'https://api.github.com/repos/owner/repo/commits/main') return json({ sha: SHA });
    if (url.startsWith('https://api.github.com/repos/owner/repo/git/trees/')) return json({ tree });
    if (url.startsWith('https://api.github.com/repos/owner/repo/tarball/')) {
      return tarball ? new Response(new Uint8Array(tarball)) : new Response('no tarball', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-harness-'));
}

describe('skillDirs', () => {
  it('finds nothing in a tree without SKILL.md', () => {
    expect(skillDirs([{ path: 'README.md', type: 'blob' }, { path: 'src', type: 'tree' }])).toEqual([]);
  });

  it('reports the root as an empty directory name', () => {
    expect(skillDirs([{ path: 'SKILL.md', type: 'blob' }])).toEqual(['']);
  });

  it('sorts several candidates shortest-first, then lexically', () => {
    const dirs = skillDirs([
      { path: 'docs/deep/nested/SKILL.md', type: 'blob' },
      { path: 'beta/SKILL.md', type: 'blob' },
      { path: 'alpha/SKILL.md', type: 'blob' },
    ]);
    expect(dirs).toEqual(['beta', 'alpha', 'docs/deep/nested']);
  });
});

describe('normalizeName', () => {
  it('lowercases and dash-separates', () => {
    expect(normalizeName('My Cool_Skill!')).toBe('my-cool-skill');
  });
  it('trims leading/trailing dashes and caps length', () => {
    expect(normalizeName('--ok--')).toBe('ok');
    expect(normalizeName('x'.repeat(100))).toHaveLength(64);
  });
});

describe('github adapter resolve', () => {
  it('refuses non-skill kinds without touching the network', async () => {
    const outcome = await githubAdapter.resolve('owner/repo', 'mcp', {
      fetchImpl: (() => Promise.reject(new Error('must not fetch'))) as unknown as typeof fetch,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('unsupported_kind');
  });

  it('answers ambiguous with sorted candidates for a multi-skill repo', async () => {
    const outcome = await githubAdapter.resolve(
      'owner/repo',
      'skill',
      { fetchImpl: fakeGithubFetch([{ path: 'beta/SKILL.md', type: 'blob' }, { path: 'alpha/SKILL.md', type: 'blob' }]) }
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('ambiguous');
      expect(outcome.candidates).toEqual(['beta', 'alpha']);
    }
  });

  it('refuses a repo without SKILL.md', async () => {
    const outcome = await githubAdapter.resolve(
      'owner/repo',
      'skill',
      { fetchImpl: fakeGithubFetch([{ path: 'README.md', type: 'blob' }]) }
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('no_artifact');
  });

  it('resolves a pinned directory to artifact-rooted files', async () => {
    const tarball = buildTar([
      { name: `repo-${SHA}/docs/SKILL.md`, data: Buffer.from('---\nname: docs\n---\nhello') },
      { name: `repo-${SHA}/docs/help.txt`, data: Buffer.from('help') },
      { name: `repo-${SHA}/other/SKILL.md`, data: Buffer.from('ignored') },
    ]);
    const outcome = await githubAdapter.resolve(
      'owner/repo#docs',
      'skill',
      {
        fetchImpl: fakeGithubFetch(
          [{ path: 'docs/SKILL.md', type: 'blob' }, { path: 'docs/help.txt', type: 'blob' }, { path: 'other/SKILL.md', type: 'blob' }],
          tarball
        ),
      }
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.canonicalKey).toBe('github:owner/repo#docs');
      expect(outcome.payload.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'help.txt']);
      expect(outcome.pin).toEqual({ git: { commitSha: SHA } });
      expect(outcome.storeKey).toBe(`owner__repo@${SHA.slice(0, 7)}__docs`);
    }
  });
});

describe('applySkill', () => {
  const files = [{ path: 'SKILL.md', data: Buffer.from('# demo') }, { path: 'a.txt', data: Buffer.from('x') }];
  const base = {
    sourceId: 'github',
    canonicalKey: 'github:owner/repo#demo',
    rawName: 'Demo Skill',
    storeKey: `owner__repo@${SHA.slice(0, 7)}__demo`,
    files,
    pin: { git: { commitSha: SHA } },
    trust: 'community' as const,
    scope: 'project' as const,
  };

  it('materializes one store entry and one copy per distinct host directory', () => {
    const root = tmpProject();
    const result = applySkill({ ...base, hosts: ['universal', 'claude'], projectRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe('demo-skill');
    expect(result.copies.map((c) => c.host).sort()).toEqual(['claude', 'universal']);
    for (const copy of result.copies) {
      expect(fs.existsSync(path.join(copy.path, 'SKILL.md'))).toBe(true);
    }
    const manifest = readManifest();
    const artifact = manifest.artifacts.find((a) => a.id === 'skill:github:owner/repo#demo');
    expect(artifact?.copies).toHaveLength(2);
    expect(fs.existsSync(result.storeRef)).toBe(true);
  });

  it('collapses alias hosts reading the same directory into ONE owner-labeled copy', () => {
    const root = tmpProject();
    const result = applySkill({ ...base, hosts: ['universal', 'opencode'], projectRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.copies).toEqual([{ host: 'universal', path: path.join(root, '.agents', 'skills', 'demo-skill') }]);
  });

  it('refuses an occupied path and fails with exists when nothing else is installable', () => {
    const root = tmpProject();
    fs.mkdirSync(path.join(root, '.agents', 'skills', 'demo-skill'), { recursive: true });
    const result = applySkill({ ...base, hosts: ['universal'], projectRoot: root });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('exists');
  });

  it('refuses a path claimed by another environment', () => {
    const root = tmpProject();
    const target = path.join(root, '.agents', 'skills', 'demo-skill');
    claimPath(target, 'skill:github:someone/else', 'another-env');
    const result = applySkill({ ...base, hosts: ['universal'], projectRoot: root });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('foreign');
  });
});

describe('installArtifact orchestration', () => {
  it('refuses unknown sources and unsupported kinds', async () => {
    const noSource = await installArtifact({ key: 'nosuch:thing', hosts: ['universal'], scope: 'project', projectRoot: os.tmpdir() });
    expect(noSource.ok).toBe(false);
    if (!noSource.ok) expect(noSource.code).toBe('unsupported_source');

    const noKind = await installArtifact({ key: 'github:owner/repo', kind: 'mcp', hosts: ['universal'], scope: 'project', projectRoot: os.tmpdir() });
    expect(noKind.ok).toBe(false);
    if (!noKind.ok) expect(noKind.code).toBe('unsupported_kind');
  });

  it('surfaces the ambiguity contract end-to-end', async () => {
    const result = await installArtifact({
      repo: 'owner/repo',
      hosts: ['universal'],
      scope: 'project',
      fetchImpl: fakeGithubFetch([{ path: 'a/SKILL.md', type: 'blob' }, { path: 'b/SKILL.md', type: 'blob' }]),
      projectRoot: tmpProject(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ambiguous');
      expect(result.candidates).toEqual(['a', 'b']);
    }
  });

  it('installs a pinned skill through the full SPI pipeline', async () => {
    const root = tmpProject();
    const tarball = buildTar([{ name: `repo-${SHA}/demo/SKILL.md`, data: Buffer.from('# pinned') }]);
    const result = await installArtifact({
      repo: 'owner/repo',
      skillDir: 'demo',
      hosts: ['universal'],
      scope: 'project',
      fetchImpl: fakeGithubFetch([{ path: 'demo/SKILL.md', type: 'blob' }], tarball),
      projectRoot: root,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifactId).toBe('skill:github:owner/repo#demo');
    expect(result.commitSha).toBe(SHA);
    expect(fs.existsSync(path.join(root, '.agents', 'skills', 'demo', 'SKILL.md'))).toBe(true);
    expect(readManifest().artifacts).toHaveLength(1);
  });

  // The console's source chips count installed rows per surface, and a browse-only catalog's row
  // installs with the WRITER's key (`npm:<pkg>`): without this facet the Pi catalog could never
  // account for the packages it surfaced (ADR-0015 §D8.6).
  it('records the surfaces the row was browsed on, writer source first', async () => {
    const root = tmpProject();
    const tarball = buildTar([{ name: `repo-${SHA}/demo/SKILL.md`, data: Buffer.from('# pinned') }]);
    const result = await installArtifact({
      repo: 'owner/repo',
      skillDir: 'demo',
      hosts: ['universal'],
      scope: 'project',
      listedOn: ['npm', 'github', 'not a source', 'npm'],
      fetchImpl: fakeGithubFetch([{ path: 'demo/SKILL.md', type: 'blob' }], tarball),
      projectRoot: root,
    });
    expect(result.ok).toBe(true);
    // Writer first and never displaced, duplicates collapsed, a string that is not an id dropped.
    const record = readManifest().artifacts.find((a) => a.id === 'skill:github:owner/repo#demo');
    expect(record?.listedOn).toEqual(['github', 'npm']);
    // The view carries the same facet: that is what the chips and their counts read.
    const view = scanInventory(root).artifacts.find((a) => a.id === 'skill:github:owner/repo#demo');
    expect(view?.listedOn).toEqual(['github', 'npm']);
  });
});

describe('install route (host validation at the boundary)', () => {
  const app = fastify({ logger: false });
  registerHarnessRoutes(app);

  it('refuses an unknown host id before any writer runs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/harness/install',
      payload: { manualSpec: '@x/unknown-host-ext', kind: 'plugin', confirm: true, hosts: ['nosuchhost'], scope: 'global' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ status: 'error', code: 'bad_request', message: "unknown host 'nosuchhost'" });
    // The refusal happened at the boundary: nothing was recorded for this spec.
    expect(readManifest().artifacts.find((a) => a.name === '@x/unknown-host-ext')).toBeUndefined();
  });

  // Project-level install is deferred (ADR-0015 §D2 "Scope"): the boundary owns the refusal, so a
  // request can never reach a writer that would happily land inside the repo.
  it('answers unsupported_scope for project scope, and writes nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/harness/install',
      payload: { manualSpec: '@x/project-ext', kind: 'plugin', confirm: true, hosts: ['opencode'], scope: 'project' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { status: string; code: string; message: string };
    expect(body.status).toBe('error');
    expect(body.code).toBe('unsupported_scope');
    expect(body.message).toContain('global');
    expect(readManifest().artifacts.find((a) => a.name === '@x/project-ext')).toBeUndefined();
  });
});

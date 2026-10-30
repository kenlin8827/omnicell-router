import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installArtifact } from '../src/harness/host/install.js';
import { applyPlugin, planPlugin, type ExecImpl } from '../src/harness/host/writers/plugin.js';
import { manifestPath, readManifest, writeManifest } from '../src/harness/host/manifest.js';
import { probeArtifact } from '../src/harness/host/probe.js';
import { scanInventory } from '../src/harness/host/inventory.js';
import { npmAdapter } from '../src/harness/host/resolvers/npm.js';
import type { ArtifactRecord, HarnessHostId, ManifestFile } from '../src/harness/types.js';

/**
 * Plugin writer (ADR-0015 §D8/§D2) — `plugin[]` array edit (opencode) and package-manager
 * subprocess (pi), both behind the plan → confirm → apply gate. Gate 3: the subprocess command is
 * echoed verbatim, never `-y`/`--yes`, output captured.
 *
 * The harness is part of the artifact IDENTITY here (`plugin:<harness>:<canonicalKey>`), not a
 * landing choice: the same package installed into two runtimes is two artifacts, because each is
 * code against a different plugin API.
 */

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-ext-'));
}

const SPEC = '@opencode-ai/plugin-example';

describe('plugin config merge (opencode plugin[])', () => {
  it('appends the spec into plugin[] and preserves siblings', async () => {
    const root = tmpProject();
    const file = path.join(root, 'opencode.json');
    fs.writeFileSync(file, JSON.stringify({ plugin: ['@other/pkg'], model: 'kimi' }, null, 2));
    const result = await applyPlugin({
      sourceId: 'manual',
      canonicalKey: `manual:${SPEC}`,
      spec: SPEC,
      trust: 'manual',
      harness: 'opencode',
      scope: 'project',
      projectRoot: root,
    });
    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(config.model).toBe('kimi');
    expect(config.plugin).toEqual(['@other/pkg', SPEC]);
  });

  it('records the harness on the artifact and in the id, with no hash-based path guessing', async () => {
    const root = tmpProject();
    const result = await applyPlugin({
      sourceId: 'manual',
      canonicalKey: `manual:${SPEC}`,
      spec: SPEC,
      trust: 'manual',
      harness: 'opencode',
      scope: 'project',
      projectRoot: root,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifactId).toBe(`plugin:opencode:manual:${SPEC}`);
    const record = readManifest().artifacts.find((a) => a.id === result.artifactId);
    expect(record?.harness).toBe('opencode');
    // A config copy is a real file we own — never marked external.
    expect(record?.copies[0]?.external).toBeUndefined();
  });

  it('echoes the exact pi subprocess command in the plan — gate 3 verbatim discipline', () => {
    const plan = planPlugin({
      sourceId: 'manual',
      canonicalKey: `manual:${SPEC}`,
      spec: SPEC,
      trust: 'manual',
      harness: 'pi',
      scope: 'project',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.targets[0]!.echo).toBe(`pi install npm:${SPEC}`);
  });

  it('runs the subprocess through the injected runner and refuses shell-shaped specs', async () => {
    const root = tmpProject();
    const runs: string[] = [];
    const execImpl: ExecImpl = async (command, args) => {
      runs.push([command, ...args].join(' '));
      return { code: 0, stdout: 'ok', stderr: '' };
    };
    const result = await applyPlugin({
      sourceId: 'manual',
      canonicalKey: `manual:${SPEC}`,
      spec: SPEC,
      trust: 'manual',
      harness: 'pi',
      scope: 'project',
      projectRoot: root,
      execImpl,
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    expect(runs).toEqual([`pi install npm:${SPEC}`]);
    expect(runs[0]).not.toContain('-y');
    if (result.ok) {
      const record = readManifest().artifacts.find((a) => a.id === result.artifactId);
      // The package-manager-owned copy carries a token path plus the external marker — no fake path.
      expect(record?.copies[0]?.external).toBe(true);
      expect(record?.copies[0]?.path).toBe(`manual:${SPEC}#pi`);
    }

    const bad = planPlugin({
      sourceId: 'manual',
      canonicalKey: 'manual:x;rm',
      spec: 'x;rm',
      trust: 'manual',
      harness: 'pi',
      scope: 'project',
    });
    expect(bad.ok).toBe(false);
  });

  it('does NOT mint a manifest entry when every subprocess run fails', async () => {
    const root = tmpProject();
    // An earlier test in this file installed the same canonicalKey — capture its state and assert
    // the failed apply leaves it untouched (no new/refreshed entry for a zero-copy outcome).
    const artifactId = `plugin:pi:manual:${SPEC}`;
    const before = readManifest().artifacts.find((a) => a.id === artifactId);
    const result = await applyPlugin({
      sourceId: 'manual',
      canonicalKey: `manual:${SPEC}`,
      spec: SPEC,
      trust: 'manual',
      harness: 'pi',
      scope: 'project',
      projectRoot: root,
      execImpl: async () => ({ code: 1, stdout: '', stderr: 'boom' }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('upstream');
      expect(result.runs?.[0]!.code).toBe(1);
    }
    const after = readManifest().artifacts.find((a) => a.id === artifactId);
    expect(after).toEqual(before);
  });

  it('refuses a host without a verified plugin landing', () => {
    const plan = planPlugin({
      sourceId: 'manual',
      canonicalKey: `manual:${SPEC}`,
      spec: SPEC,
      trust: 'manual',
      harness: 'universal',
      scope: 'project',
    });
    expect(plan.ok && plan.targets[0]!.refused).toContain('no verified plugin landing');
  });
});

describe('installArtifact plugin orchestration', () => {
  it('answers confirm_required with the command echo and writes NOTHING without confirm', async () => {
    const root = tmpProject();
    const result = await installArtifact({
      manualSpec: SPEC,
      kind: 'plugin',
      hosts: ['pi'],
      scope: 'project',
      projectRoot: root,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('confirm_required');
      expect(result.plan?.[0] && 'echo' in result.plan[0] && result.plan[0].echo).toBe(`pi install npm:${SPEC}`);
    }
    expect(fs.existsSync(path.join(root, 'opencode.json'))).toBe(false);
  });

  it('applies after confirm and records an plugin manifest entry', async () => {
    const root = tmpProject();
    const result = await installArtifact({
      manualSpec: SPEC,
      kind: 'plugin',
      confirm: true,
      hosts: ['opencode'],
      scope: 'project',
      projectRoot: root,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifactId).toBe(`plugin:opencode:manual:${SPEC}`);
    const artifact = readManifest().artifacts.find((a) => a.id === `plugin:opencode:manual:${SPEC}`);
    expect(artifact?.kind).toBe('plugin');
    expect(artifact?.harness).toBe('opencode');
    // A manual spec carries no upstream provenance: the record says so instead of inventing a pin.
    expect(artifact?.pin).toEqual({ adopted: true });
  });

  it('gives the same package two artifact ids when installed into two harnesses', async () => {
    const root = tmpProject();
    const spec = '@pi/two-harness-ext';
    const opencode = await installArtifact({
      manualSpec: spec,
      kind: 'plugin',
      confirm: true,
      hosts: ['opencode'],
      scope: 'project',
      projectRoot: root,
    });
    const pi = await installArtifact({
      manualSpec: spec,
      kind: 'plugin',
      confirm: true,
      hosts: ['pi'],
      scope: 'project',
      projectRoot: root,
      execImpl: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    expect(opencode.ok && pi.ok).toBe(true);
    if (!opencode.ok || !pi.ok) return;
    expect(opencode.artifactId).toBe(`plugin:opencode:manual:${spec}`);
    expect(pi.artifactId).toBe(`plugin:pi:manual:${spec}`);
    expect(opencode.artifactId).not.toBe(pi.artifactId);
    const records = readManifest().artifacts.filter((a) => a.canonicalKey === `manual:${spec}`);
    expect(records.map((r) => r.harness).sort()).toEqual(['opencode', 'pi']);
  });

  it('refuses an plugin install that names more than one harness', async () => {
    const result = await installArtifact({
      manualSpec: SPEC,
      kind: 'plugin',
      confirm: true,
      hosts: ['opencode', 'pi'],
      scope: 'project',
      projectRoot: tmpProject(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('bad_request');
      expect(result.message).toBe('plugin installs target exactly one harness');
    }
  });

  it('installs an npm-sourced plugin end-to-end through the adapter and writer', async () => {
    const root = tmpProject();
    const spec = '@x/npm-sourced-ext';
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url === 'https://registry.npmjs.org/@x%2Fnpm-sourced-ext') {
        return new Response(JSON.stringify({ 'dist-tags': { latest: '0.4.0' } }), { status: 200 });
      }
      if (url === 'https://registry.npmjs.org/@x%2Fnpm-sourced-ext/0.4.0') {
        return new Response(
          JSON.stringify({ name: spec, version: '0.4.0', description: 'A demo plugin one-liner', dist: { integrity: 'sha512-xyz' } }),
          { status: 200 }
        );
      }
      return new Response('nf', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await installArtifact({
      key: `npm:${spec}`,
      kind: 'plugin',
      confirm: true,
      hosts: ['opencode'],
      scope: 'project',
      projectRoot: root,
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifactId).toBe(`plugin:opencode:npm:${spec}`);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8')) as { plugin?: string[] };
    expect(config.plugin).toEqual([`${spec}@0.4.0`]);
    // Provenance survives the writer: the adapter's integrity pin reaches the manifest.
    const record = readManifest().artifacts.find((a) => a.id === result.artifactId);
    expect(record?.pin).toEqual({ npm: { integrity: 'sha512-xyz' } });
    // The source's prose survives too: an installed row must not be a nameless entry, and an
    // `external` copy has no file of ours to read it from later.
    expect(record?.description).toBe('A demo plugin one-liner');
    const view = scanInventory(root).artifacts.find((a) => a.id === result.artifactId);
    expect(view?.description).toBe('A demo plugin one-liner');
  });
});

describe('external (package-manager-owned) copies', () => {
  it('reports inventory state clean and probe verified without touching a path', async () => {
    const root = tmpProject();
    const spec = '@pi/external-copy-ext';
    const result = await installArtifact({
      manualSpec: spec,
      kind: 'plugin',
      confirm: true,
      hosts: ['pi'],
      scope: 'project',
      projectRoot: root,
      execImpl: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const view = scanInventory(root).artifacts.find((a) => a.id === result.artifactId);
    expect(view?.harness).toBe('pi');
    // A token path would always stat as missing; `external` short-circuits to clean instead.
    expect(view?.copies[0]?.state).toBe('clean');
    expect(view?.rollup).toBe('clean');

    expect(probeArtifact(result.artifactId)?.allVerified).toBe(true);
  });
});

describe('post-apply probe placement (three states)', () => {
  const installedAt = new Date().toISOString();

  /** Snapshot/restore the manifest so a probe write cannot leak into sibling suites. */
  function withManifest<T>(fn: () => T): T {
    const file = manifestPath();
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    try {
      return fn();
    } finally {
      if (previous === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, previous);
    }
  }

  /** Seed one plugin record straight into the manifest — the copy shape an apply would leave. */
  function seed(record: { id: string; canonicalKey: string; name: string; harness: HarnessHostId; copyPath: string }): void {
    const manifest = readManifest();
    manifest.artifacts = [
      ...manifest.artifacts.filter((a) => a.id !== record.id),
      {
        id: record.id,
        canonicalKey: record.canonicalKey,
        kind: 'plugin',
        harness: record.harness,
        name: record.name,
        sourceId: 'npm',
        pin: { npm: { integrity: 'sha512-seed' } },
        contentHash: 'seeded',
        listedOn: ['npm'],
        trust: 'community',
        copies: [
          {
            scope: 'project',
            host: record.harness,
            rootId: 'default',
            path: record.copyPath,
            contentHash: 'seeded',
            placement: 'materialized',
            installedAt,
          },
        ],
      },
    ];
    writeManifest(manifest);
  }

  it('leaves placement untouched when the host has no plugin landing to inspect', () => {
    withManifest(() => {
      const file = path.join(tmpProject(), 'config.json');
      fs.writeFileSync(file, JSON.stringify({ plugin: ['@x/undecidable@1.0.0'] }));
      // `claude` lands through a package-manager subprocess (no in-file container exists), so the
      // probe cannot judge this copy, and "cannot judge" must never be written down as `unverified`.
      const id = 'plugin:claude:npm:@x/undecidable';
      seed({ id, canonicalKey: 'npm:@x/undecidable', name: '@x/undecidable@1.0.0', harness: 'claude', copyPath: file });

      const result = probeArtifact(id);
      expect(result?.copies[0]?.placement).toBeNull();
      expect(result?.allVerified).toBe(false);
      expect(readManifest().artifacts.find((a) => a.id === id)?.copies[0]?.placement).toBe('materialized');
    });
  });

  it('compares the spec the writer recorded, not the package name', () => {
    withManifest(() => {
      const file = path.join(tmpProject(), 'opencode.json');
      // The writer pushes `req.spec` verbatim and records `name = req.spec`; a probe that fell back
      // to the bare package name would "verify" the second record against a different entry.
      fs.writeFileSync(file, JSON.stringify({ plugin: ['@x/pinned@1.2.3', '@x/bare'] }));

      const pinned = 'plugin:opencode:npm:@x/pinned';
      const bare = 'plugin:opencode:npm:@x/bare';
      seed({ id: pinned, canonicalKey: 'npm:@x/pinned', name: '@x/pinned@1.2.3', harness: 'opencode', copyPath: file });
      seed({ id: bare, canonicalKey: 'npm:@x/bare', name: '@x/bare@1.2.3', harness: 'opencode', copyPath: file });

      expect(probeArtifact(pinned)?.copies[0]?.placement).toBe('verified');
      expect(readManifest().artifacts.find((a) => a.id === pinned)?.copies[0]?.placement).toBe('verified');
      expect(probeArtifact(bare)?.copies[0]?.placement).toBe('unverified');
      expect(readManifest().artifacts.find((a) => a.id === bare)?.copies[0]?.placement).toBe('unverified');
    });
  });
});

describe('npm source resolution', () => {
  it('resolves a scoped package to a pinned spec through the injected fetch', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url === 'https://registry.npmjs.org/@scope%2Fpkg') {
        return json({ name: '@scope/pkg', 'dist-tags': { latest: '1.2.3' }, versions: {} });
      }
      if (url === 'https://registry.npmjs.org/@scope%2Fpkg/1.2.3') {
        return json({ name: '@scope/pkg', version: '1.2.3', dist: { integrity: 'sha512-abc' } });
      }
      return new Response('nf', { status: 404 });
    }) as unknown as typeof fetch;

    const outcome = await npmAdapter.resolve('@scope/pkg', 'plugin', { fetchImpl });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.canonicalKey).toBe('npm:@scope/pkg');
    expect(outcome.payload).toEqual({ kind: 'plugin', name: '@scope/pkg', pm: 'npm', spec: '@scope/pkg@1.2.3' });
    expect(outcome.pin).toEqual({ npm: { integrity: 'sha512-abc' } });
    // A version document with no `description` claims none — never an empty string in the manifest.
    expect(outcome.description).toBeNull();
    expect(seen).toEqual([
      'https://registry.npmjs.org/@scope%2Fpkg',
      'https://registry.npmjs.org/@scope%2Fpkg/1.2.3',
    ]);
  });

  it('maps a missing package to no_artifact and a registry failure to unavailable', async () => {
    const missing = await npmAdapter.resolve('@scope/nope', 'plugin', {
      fetchImpl: (async () => new Response('nf', { status: 404 })) as unknown as typeof fetch,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('no_artifact');

    const down = await npmAdapter.resolve('@scope/pkg', 'plugin', {
      fetchImpl: (async () => new Response('boom', { status: 503 })) as unknown as typeof fetch,
    });
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.code).toBe('unavailable');
  });

  it('resolves a dist-tag through the packument instead of requesting it as a version', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url === 'https://registry.npmjs.org/foo') {
        return json({ name: 'foo', 'dist-tags': { latest: '1.0.0', beta: '2.0.0-beta.1' } });
      }
      if (url === 'https://registry.npmjs.org/foo/2.0.0-beta.1') {
        return json({ name: 'foo', version: '2.0.0-beta.1', dist: { integrity: 'sha512-beta' } });
      }
      return new Response('nf', { status: 404 });
    }) as unknown as typeof fetch;

    const outcome = await npmAdapter.resolve('foo@beta', 'plugin', { fetchImpl });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The spec is always pinned to the concrete version the tag pointed at, with its integrity.
    expect(outcome.payload).toEqual({ kind: 'plugin', name: 'foo', pm: 'npm', spec: 'foo@2.0.0-beta.1' });
    expect(outcome.pin).toEqual({ npm: { integrity: 'sha512-beta' } });
    // `beta` is never requested as a version document — that request could only ever 404.
    expect(seen).toEqual(['https://registry.npmjs.org/foo', 'https://registry.npmjs.org/foo/2.0.0-beta.1']);
  });

  it('answers no_artifact naming the tag when the tag (or range) does not exist', async () => {
    const fetchImpl = (async (input: unknown) => {
      if (String(input) === 'https://registry.npmjs.org/foo') {
        return new Response(JSON.stringify({ 'dist-tags': { latest: '1.0.0' } }), { status: 200 });
      }
      return new Response('nf', { status: 404 });
    }) as unknown as typeof fetch;

    for (const [ref, tag] of [['foo@canary', 'canary'], ['foo@1.x', '1.x']] as const) {
      const outcome = await npmAdapter.resolve(ref, 'plugin', { fetchImpl });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.code).toBe('no_artifact');
      // "no such version number" would be a false statement about the package.
      expect(outcome.message).toContain(`has no dist-tag '${tag}'`);
    }
  });
});

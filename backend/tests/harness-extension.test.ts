import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installArtifact } from '../src/harness/install.js';
import { applyExtension, planExtension, type ExecImpl } from '../src/harness/writers/extension.js';
import { manifestPath, orphansPath, readManifest, writeManifest } from '../src/harness/manifest.js';
import { probeArtifact } from '../src/harness/probe.js';
import { scanInventory } from '../src/harness/inventory.js';
import { npmAdapter } from '../src/harness/sources/npm.js';
import type { ArtifactRecord, HarnessHostId, ManifestFile } from '../src/harness/types.js';

/**
 * Extension writer (ADR-0015 §D8/§D2) — `plugin[]` array edit (opencode) and package-manager
 * subprocess (pi), both behind the plan → confirm → apply gate. Gate 3: the subprocess command is
 * echoed verbatim, never `-y`/`--yes`, output captured.
 *
 * The harness is part of the artifact IDENTITY here (`extension:<harness>:<canonicalKey>`), not a
 * landing choice: the same package installed into two runtimes is two artifacts, because each is
 * code against a different plugin API.
 */

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-ext-'));
}

const SPEC = '@opencode-ai/plugin-example';

describe('extension config merge (opencode plugin[])', () => {
  it('appends the spec into plugin[] and preserves siblings', async () => {
    const root = tmpProject();
    const file = path.join(root, 'opencode.json');
    fs.writeFileSync(file, JSON.stringify({ plugin: ['@other/pkg'], model: 'kimi' }, null, 2));
    const result = await applyExtension({
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
    const result = await applyExtension({
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
    expect(result.artifactId).toBe(`extension:opencode:manual:${SPEC}`);
    const record = readManifest().artifacts.find((a) => a.id === result.artifactId);
    expect(record?.harness).toBe('opencode');
    // A config copy is a real file we own — never marked external.
    expect(record?.copies[0]?.external).toBeUndefined();
  });

  it('echoes the exact pi subprocess command in the plan — gate 3 verbatim discipline', () => {
    const plan = planExtension({
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
    const result = await applyExtension({
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

    const bad = planExtension({
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
    const artifactId = `extension:pi:manual:${SPEC}`;
    const before = readManifest().artifacts.find((a) => a.id === artifactId);
    const result = await applyExtension({
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

  it('refuses a host without a verified extension landing', () => {
    const plan = planExtension({
      sourceId: 'manual',
      canonicalKey: `manual:${SPEC}`,
      spec: SPEC,
      trust: 'manual',
      harness: 'universal',
      scope: 'project',
    });
    expect(plan.ok && plan.targets[0]!.refused).toContain('no verified extension landing');
  });
});

describe('installArtifact extension orchestration', () => {
  it('answers confirm_required with the command echo and writes NOTHING without confirm', async () => {
    const root = tmpProject();
    const result = await installArtifact({
      manualSpec: SPEC,
      kind: 'extension',
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

  it('applies after confirm and records an extension manifest entry', async () => {
    const root = tmpProject();
    const result = await installArtifact({
      manualSpec: SPEC,
      kind: 'extension',
      confirm: true,
      hosts: ['opencode'],
      scope: 'project',
      projectRoot: root,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifactId).toBe(`extension:opencode:manual:${SPEC}`);
    const artifact = readManifest().artifacts.find((a) => a.id === `extension:opencode:manual:${SPEC}`);
    expect(artifact?.kind).toBe('extension');
    expect(artifact?.harness).toBe('opencode');
    // A manual spec carries no upstream provenance: the record says so instead of inventing a pin.
    expect(artifact?.pin).toEqual({ adopted: true });
  });

  it('gives the same package two artifact ids when installed into two harnesses', async () => {
    const root = tmpProject();
    const spec = '@pi/two-harness-ext';
    const opencode = await installArtifact({
      manualSpec: spec,
      kind: 'extension',
      confirm: true,
      hosts: ['opencode'],
      scope: 'project',
      projectRoot: root,
    });
    const pi = await installArtifact({
      manualSpec: spec,
      kind: 'extension',
      confirm: true,
      hosts: ['pi'],
      scope: 'project',
      projectRoot: root,
      execImpl: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    expect(opencode.ok && pi.ok).toBe(true);
    if (!opencode.ok || !pi.ok) return;
    expect(opencode.artifactId).toBe(`extension:opencode:manual:${spec}`);
    expect(pi.artifactId).toBe(`extension:pi:manual:${spec}`);
    expect(opencode.artifactId).not.toBe(pi.artifactId);
    const records = readManifest().artifacts.filter((a) => a.canonicalKey === `manual:${spec}`);
    expect(records.map((r) => r.harness).sort()).toEqual(['opencode', 'pi']);
  });

  it('refuses an extension install that names more than one harness', async () => {
    const result = await installArtifact({
      manualSpec: SPEC,
      kind: 'extension',
      confirm: true,
      hosts: ['opencode', 'pi'],
      scope: 'project',
      projectRoot: tmpProject(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('bad_request');
      expect(result.message).toBe('extension installs target exactly one harness');
    }
  });

  it('installs an npm-sourced extension end-to-end through the adapter and writer', async () => {
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
      kind: 'extension',
      confirm: true,
      hosts: ['opencode'],
      scope: 'project',
      projectRoot: root,
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifactId).toBe(`extension:opencode:npm:${spec}`);
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
      kind: 'extension',
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

  /** Seed one extension record straight into the manifest — the copy shape an apply would leave. */
  function seed(record: { id: string; canonicalKey: string; name: string; harness: HarnessHostId; copyPath: string }): void {
    const manifest = readManifest();
    manifest.artifacts = [
      ...manifest.artifacts.filter((a) => a.id !== record.id),
      {
        id: record.id,
        canonicalKey: record.canonicalKey,
        kind: 'extension',
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

  it('leaves placement untouched when the host has no extension landing to inspect', () => {
    withManifest(() => {
      const file = path.join(tmpProject(), 'config.json');
      fs.writeFileSync(file, JSON.stringify({ plugin: ['@x/undecidable@1.0.0'] }));
      // `claude` has no verified extension landing, so no container exists to read: the probe cannot
      // judge this copy, and "cannot judge" must never be written down as `unverified`.
      const id = 'extension:claude:npm:@x/undecidable';
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

      const pinned = 'extension:opencode:npm:@x/pinned';
      const bare = 'extension:opencode:npm:@x/bare';
      seed({ id: pinned, canonicalKey: 'npm:@x/pinned', name: '@x/pinned@1.2.3', harness: 'opencode', copyPath: file });
      seed({ id: bare, canonicalKey: 'npm:@x/bare', name: '@x/bare@1.2.3', harness: 'opencode', copyPath: file });

      expect(probeArtifact(pinned)?.copies[0]?.placement).toBe('verified');
      expect(readManifest().artifacts.find((a) => a.id === pinned)?.copies[0]?.placement).toBe('verified');
      expect(probeArtifact(bare)?.copies[0]?.placement).toBe('unverified');
      expect(readManifest().artifacts.find((a) => a.id === bare)?.copies[0]?.placement).toBe('unverified');
    });
  });
});

describe('manifest v1 → v2 migration', () => {
  it('splits a multi-host legacy extension record into one record per harness', () => {
    const file = manifestPath();
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const installedAt = new Date().toISOString();
    const copy = (host: 'opencode' | 'pi', p: string, extra: Partial<ArtifactRecord['copies'][number]> = {}) => ({
      scope: 'project' as const,
      host,
      rootId: 'default',
      path: p,
      contentHash: 'h1',
      placement: 'materialized' as const,
      installedAt,
      ...extra,
    });
    const v1: ManifestFile = {
      version: 1,
      artifacts: [
        {
          id: 'extension:manual:@x/legacy',
          canonicalKey: 'manual:@x/legacy',
          kind: 'extension',
          name: '@x/legacy',
          sourceId: 'manual',
          pin: { adopted: true },
          contentHash: 'subprocess:opencode@0,pi@0',
          listedOn: ['manual'],
          trust: 'manual',
          // Real v1 shape: the subprocess branch wrote a placeholder token and NO `external` marker.
          copies: [copy('opencode', '/tmp/legacy/opencode.json'), copy('pi', 'manual:@x/legacy#pi')],
        },
        {
          id: 'skill:github:owner/repo#demo',
          canonicalKey: 'github:owner/repo#demo',
          kind: 'skill',
          name: 'demo',
          sourceId: 'github',
          pin: { git: { commitSha: 'a'.repeat(40) } },
          contentHash: 'h2',
          listedOn: ['github'],
          trust: 'community',
          copies: [copy('universal', '/tmp/legacy/.agents/skills/demo')],
        },
      ],
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(v1, null, 2));
    try {
      const migrated = readManifest();
      expect(migrated.version).toBe(2);
      const extensions = migrated.artifacts.filter((a) => a.kind === 'extension');
      expect(extensions.map((a) => a.id).sort()).toEqual([
        'extension:opencode:manual:@x/legacy',
        'extension:pi:manual:@x/legacy',
      ]);
      const opencode = extensions.find((a) => a.harness === 'opencode');
      const pi = extensions.find((a) => a.harness === 'pi');
      expect(opencode?.copies.map((c) => c.host)).toEqual(['opencode']);
      expect(pi?.copies.map((c) => c.host)).toEqual(['pi']);
      // The legacy placeholder token is re-marked `external`, so the migrated copy will not be
      // stat'ed as a path (the old "pi extension always missing" bug).
      expect(pi?.copies[0]?.external).toBe(true);
      expect(opencode?.copies[0]?.external).toBeUndefined();
      // Non-extension kinds are untouched — a skill's host is a landing, never an identity.
      const skill = migrated.artifacts.find((a) => a.kind === 'skill');
      expect(skill?.id).toBe('skill:github:owner/repo#demo');
      expect(skill?.harness).toBeUndefined();

      // A read never rewrites manifest.json: the on-disk file still carries the v1 header until
      // something writes.
      expect((JSON.parse(fs.readFileSync(file, 'utf8')) as ManifestFile).version).toBe(1);
      writeManifest(migrated);
      expect((JSON.parse(fs.readFileSync(file, 'utf8')) as ManifestFile).version).toBe(2);
    } finally {
      if (previous === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, previous);
    }
  });

  it('retires a host-less legacy extension record to the orphans file, never silently', () => {
    const file = manifestPath();
    const orphanFile = orphansPath();
    const previousManifest = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const previousOrphans = fs.existsSync(orphanFile) ? fs.readFileSync(orphanFile, 'utf8') : null;
    // No copies ⇒ no host ⇒ v2 cannot name this artifact: keeping it would mint an
    // `extension:<canonicalKey>` row that no harness page can show or remove (a ghost).
    const v1: ManifestFile = {
      version: 1,
      artifacts: [
        {
          id: 'extension:manual:@x/ghost',
          canonicalKey: 'manual:@x/ghost',
          kind: 'extension',
          name: '@x/ghost',
          sourceId: 'manual',
          pin: { adopted: true },
          contentHash: 'subprocess:',
          listedOn: ['manual'],
          trust: 'manual',
          copies: [],
        },
      ],
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(v1, null, 2));
    const readOrphans = () =>
      JSON.parse(fs.readFileSync(orphanFile, 'utf8')) as { migratedAt: string; record: ArtifactRecord }[];
    try {
      const migrated = readManifest();
      expect(migrated.artifacts).toHaveLength(0);

      const rows = readOrphans().filter((row) => row.record.id === 'extension:manual:@x/ghost');
      expect(rows).toHaveLength(1);
      expect(typeof rows[0]!.migratedAt).toBe('string');
      expect(rows[0]!.record.copies).toEqual([]);

      // Append-only but idempotent: re-reading the same v1 file must not duplicate the row.
      readManifest();
      expect(readOrphans().filter((row) => row.record.id === 'extension:manual:@x/ghost')).toHaveLength(1);
    } finally {
      if (previousManifest === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, previousManifest);
      if (previousOrphans === null) fs.rmSync(orphanFile, { force: true });
      else fs.writeFileSync(orphanFile, previousOrphans);
    }
  });
});

describe('npm source adapter', () => {
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

    const outcome = await npmAdapter.resolve('@scope/pkg', 'extension', { fetchImpl });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.canonicalKey).toBe('npm:@scope/pkg');
    expect(outcome.payload).toEqual({ kind: 'extension', name: '@scope/pkg', pm: 'npm', spec: '@scope/pkg@1.2.3' });
    expect(outcome.pin).toEqual({ npm: { integrity: 'sha512-abc' } });
    // A version document with no `description` claims none — never an empty string in the manifest.
    expect(outcome.description).toBeNull();
    expect(seen).toEqual([
      'https://registry.npmjs.org/@scope%2Fpkg',
      'https://registry.npmjs.org/@scope%2Fpkg/1.2.3',
    ]);
  });

  it('maps a missing package to no_artifact and a registry failure to unavailable', async () => {
    const missing = await npmAdapter.resolve('@scope/nope', 'extension', {
      fetchImpl: (async () => new Response('nf', { status: 404 })) as unknown as typeof fetch,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('no_artifact');

    const down = await npmAdapter.resolve('@scope/pkg', 'extension', {
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

    const outcome = await npmAdapter.resolve('foo@beta', 'extension', { fetchImpl });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The spec is always pinned to the concrete version the tag pointed at, with its integrity.
    expect(outcome.payload).toEqual({ kind: 'extension', name: 'foo', pm: 'npm', spec: 'foo@2.0.0-beta.1' });
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
      const outcome = await npmAdapter.resolve(ref, 'extension', { fetchImpl });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.code).toBe('no_artifact');
      // "no such version number" would be a false statement about the package.
      expect(outcome.message).toContain(`has no dist-tag '${tag}'`);
    }
  });
});

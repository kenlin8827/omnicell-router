import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverPlugins, type ExtSource } from '../src/harness/host/discover.js';
import { applyRemove, planRemove } from '../src/harness/host/maintenance.js';
import { findArtifact } from '../src/harness/host/manifest.js';
import { applyPlugin } from '../src/harness/host/writers/plugin.js';

/**
 * Removal ops (ADR-0015 §D5 / §D8.9 / §D8.10).
 *
 * The rule under test is the one the whole domain turns on: the op follows the artifact's LANDING
 * SHAPE, not its provenance. A config landing holds the runtime's whole configuration, so removing
 * one member must never move that file to the trash; a discovered row is removable through the same
 * shapes, because the scan hands the console the inverse of the record it read.
 *
 * All IO is a temp directory plus the isolated runner's sandboxed OCR_HOME.
 */

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-harness-rm-'));
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('tracked config-landed copy', () => {
  it('drops the plugin[] entry and leaves the rest of the runtime config untouched', async () => {
    const root = tmp();
    const config = path.join(root, 'opencode.json');
    // A hand-written config: another plugin and an unrelated key must survive our removal.
    fs.writeFileSync(config, JSON.stringify({ theme: 'keep-me', plugin: ['other-plugin'] }, null, 2));

    const applied = await applyPlugin({
      sourceId: 'manual',
      canonicalKey: 'manual:my-plugin',
      spec: 'my-plugin',
      trust: 'manual',
      harness: 'opencode',
      scope: 'project',
      projectRoot: root,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const copy = findArtifact(applied.artifactId)!.copies[0]!;
    expect(copy.path).toBe(config);

    const plan = planRemove([
      { artifactId: applied.artifactId, copies: [{ scope: 'project', host: 'opencode', path: copy.path }] },
    ]);
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.actions[0]!.op).toBe('drop-entry');
    expect(plan.actions[0]!.entry).toBe('my-plugin');
    expect(plan.actions[0]!.container).toBe('plugin');

    const removed = await applyRemove(plan.planId)
    expect(removed.ok).toBe(true);
    expect(fs.existsSync(config)).toBe(true);
    const after = readJson(config);
    expect(after['theme']).toBe('keep-me');
    expect(after['plugin']).toEqual(['other-plugin']);
    expect(findArtifact(applied.artifactId)).toBeUndefined();
  });

  it('prunes the record without touching the file when the entry already left the array', async () => {
    const root = tmp();
    const config = path.join(root, 'opencode.json');
    fs.writeFileSync(config, JSON.stringify({ plugin: [] }, null, 2));

    const applied = await applyPlugin({
      sourceId: 'manual',
      canonicalKey: 'manual:forgotten',
      spec: 'forgotten',
      trust: 'manual',
      harness: 'opencode',
      scope: 'project',
      projectRoot: root,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    // The runtime (or a human) dropped the entry while our record kept it.
    fs.writeFileSync(config, JSON.stringify({ plugin: [] }, null, 2));

    const plan = planRemove([
      {
        artifactId: applied.artifactId,
        copies: [{ scope: 'project', host: 'opencode', path: config }],
      },
    ]);
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.actions[0]!.op).toBe('prune-only');
    expect(plan.actions[0]!.exists).toBe(false);

    expect((await applyRemove(plan.planId)).ok).toBe(true);
    // A prune performs no filesystem op: the config file must still be there, byte-for-byte shape.
    expect(fs.existsSync(config)).toBe(true);
    expect(readJson(config)).toEqual({ plugin: [] });
    expect(findArtifact(applied.artifactId)).toBeUndefined();
  });
});

describe('discovered row descriptor', () => {
  it('removes a plugin[] row through the descriptor the scan produced', async () => {
    const root = tmp();
    const file = path.join(root, 'opencode.json');
    fs.writeFileSync(file, JSON.stringify({ mcp: { keep: { type: 'local' } }, plugin: ['ghost', 'stay'] }, null, 2));

    const source: ExtSource = {
      host: 'opencode',
      scope: 'project',
      origin: 'config-array',
      kind: 'config-array',
      path: file,
      key: 'plugin',
    };
    const row = discoverPlugins([source]).find((r) => r.name === 'ghost')!;
    expect(row.removal).toEqual({ op: 'drop-entry', file, container: 'plugin', entry: 'ghost' });

    const plan = planRemove([{ artifactId: null, copies: row.copies, removal: row.removal }], {
      projectRoot: root,
    });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.actions[0]!.op).toBe('drop-entry');

    expect((await applyRemove(plan.planId)).ok).toBe(true);
    const after = readJson(file);
    expect(after['plugin']).toEqual(['stay']);
    expect(after['mcp']).toEqual({ keep: { type: 'local' } });
  });

  it('describes a loose plugin file as a trash path, not a config entry', () => {
    const dir = path.join(tmp(), 'extensions');
    const source: ExtSource = { host: 'pi', scope: 'global', origin: 'local-file', kind: 'loose-dir', path: dir };
    const rows = discoverPlugins([source], {
      deps: {
        exists: () => true,
        readJson: () => ({}),
        readDir: () => ['extra.ts'],
      },
    });
    const row = rows.find((r) => r.name === 'extra')!;
    expect(row.removal).toEqual({ op: 'trash-path', path: path.join(dir, 'extra.ts') });
  });

  it('reports a descriptor whose entry already left the array instead of inventing a write', () => {
    const file = path.join(tmp(), 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ packages: [] }));

    const plan = planRemove([
      {
        artifactId: null,
        copies: [{ scope: 'global', host: 'pi', path: `${path.dirname(file)}#pi` }],
        removal: { op: 'drop-entry', file, container: 'packages', entry: 'npm:gone' },
      },
    ]);
    expect('error' in plan).toBe(true);
  });

  it('refuses a trash-path descriptor outside the known artifact roots', () => {
    const dir = path.join(tmp(), 'not-a-root');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'evil.ts');
    fs.writeFileSync(file, 'export default {}');

    const plan = planRemove([
      {
        artifactId: null,
        copies: [{ scope: 'global', host: 'pi', path: file }],
        removal: { op: 'trash-path', path: file },
      },
    ]);
    expect('error' in plan).toBe(true);
    // Nothing was moved: the containment guard refuses before any write is planned.
    expect(fs.existsSync(file)).toBe(true);
  });

  it('refuses a drop-entry whose file is not a declared landing of the row host', () => {
    const file = path.join(tmp(), 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ packages: [] }));

    // The descriptor names pi but points at an unrelated file: the remove plan must never edit a
    // file the host's own adapters did not declare.
    const plan = planRemove([
      {
        artifactId: null,
        copies: [{ scope: 'global', host: 'pi', path: `${path.dirname(file)}#pi` }],
        removal: { op: 'drop-entry', file, container: 'packages', entry: 'npm:gone' },
      },
    ]);
    expect('error' in plan).toBe(true);
    if ('error' in plan) expect(plan.error).toContain('not a config landing');
    expect(readJson(file)).toEqual({ packages: [] });
  });

  it('drops a DSH bundle from the nested profile list it was read from', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-harness-dsh-'));
    const profile = path.join(home, 'profiles', 'web', 'package.json');
    fs.mkdirSync(path.dirname(profile), { recursive: true });
    fs.writeFileSync(
      profile,
      JSON.stringify(
        {
          dependencies: { 'dsh-hello-plugin': '^0.1.0', 'keep-plugin': '^2.0.0' },
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-hello-plugin', 'keep-plugin'] } },
        },
        null,
        2
      )
    );
    const previous = process.env.DSH_HOME;
    const previousCli = process.env.DSH_CLI;
    process.env.DSH_HOME = home;
    process.env.DSH_CLI = 'dsh';
    try {
      const plan = planRemove([
        {
          artifactId: null,
          copies: [{ scope: 'global', host: 'dsh', path: 'npm:dsh-hello-plugin#dsh' }],
          removal: { op: 'drop-entry', file: profile, container: 'dsh.profile.bundles', entry: 'dsh-hello-plugin' },
        },
      ]);
      if ('error' in plan) throw new Error(plan.error);
      // `removeBundle` deselects the bundle AND runs `pnpm remove`; the plan must not duplicate the
      // declaration edit before the vendor command.
      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0]).toMatchObject({
        op: 'cli-remove',
        entry: 'dsh-hello-plugin',
        cli: { runs: [{ command: 'dsh', args: ['plugin', '--profile', 'web', 'remove', 'dsh-hello-plugin'] }] },
      });
      const calls: { command: string; args: string[] }[] = [];
      const removed = await applyRemove(plan.planId, {
        execImpl: async (command, args) => {
          calls.push({ command, args });
          return { code: 0, stdout: '', stderr: '' };
        },
      });
      expect(removed.ok).toBe(true);
      expect(calls).toEqual([{ command: 'dsh', args: ['plugin', '--profile', 'web', 'remove', 'dsh-hello-plugin'] }]);
      const after = readJson(profile) as { dsh: { profile: { bundles: string[] } }; dependencies: Record<string, string> };
      // The stub records the argv but does not run pnpm, so the file keeps both records here; the
      // real vendor command (smoke-tested) rewrites the dependency and bundle list together.
      expect(after.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-hello-plugin', 'keep-plugin']);
      expect(after.dependencies).toEqual({ 'dsh-hello-plugin': '^0.1.0', 'keep-plugin': '^2.0.0' });
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      if (previousCli === undefined) delete process.env.DSH_CLI;
      else process.env.DSH_CLI = previousCli;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('removes a tracked DSH dependency through the vendor CLI as well as the bundle list', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-harness-dsh-tracked-'));
    const profile = path.join(home, 'profiles', 'web', 'package.json');
    fs.mkdirSync(path.dirname(profile), { recursive: true });
    fs.writeFileSync(
      profile,
      JSON.stringify(
        {
          dependencies: { 'dsh-hello-plugin': '^0.1.0' },
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-hello-plugin'] } },
        },
        null,
        2
      )
    );
    const previous = process.env.DSH_HOME;
    const previousCli = process.env.DSH_CLI;
    process.env.DSH_HOME = home;
    process.env.DSH_CLI = 'dsh';
    try {
      const installed = await applyPlugin({
        sourceId: 'manual',
        canonicalKey: 'manual:dsh-hello-plugin',
        spec: 'dsh-hello-plugin',
        trust: 'manual',
        harness: 'dsh',
        scope: 'global',
        profile: 'web',
        execImpl: async () => ({ code: 0, stdout: '', stderr: '' }),
      });
      expect(installed.ok).toBe(true);
      if (!installed.ok) return;
      const copy = findArtifact(installed.artifactId)!.copies[0]!;
      expect(copy.external).toBe(true);
      expect(copy.profile).toBe('web');

      const plan = planRemove([
        {
          artifactId: installed.artifactId,
          copies: [{ scope: 'global', host: 'dsh', path: copy.path, profile: 'web' }],
        },
      ]);
      if ('error' in plan) throw new Error(plan.error);
      expect(plan.actions.map((action) => action.op)).toEqual(['cli-remove']);

      const calls: { command: string; args: string[] }[] = [];
      const removed = await applyRemove(plan.planId, {
        execImpl: async (command, args) => {
          calls.push({ command, args });
          return { code: 0, stdout: '', stderr: '' };
        },
      });
      expect(removed.ok).toBe(true);
      expect(calls).toEqual([{ command: 'dsh', args: ['plugin', '--profile', 'web', 'remove', 'dsh-hello-plugin'] }]);
      const after = readJson(profile) as { dsh: { profile: { bundles: string[] } } };
      expect(after.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-hello-plugin']);
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      if (previousCli === undefined) delete process.env.DSH_CLI;
      else process.env.DSH_CLI = previousCli;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('removes an installed-but-disabled DSH bundle through the vendor CLI', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-harness-dsh-disabled-'));
    const profile = path.join(home, 'profiles', 'web', 'package.json');
    fs.mkdirSync(path.dirname(profile), { recursive: true });
    fs.writeFileSync(
      profile,
      JSON.stringify(
        {
          dependencies: { 'dsh-sleeping-plugin': '^1.0.0', 'keep-plugin': '^2.0.0' },
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'keep-plugin'] } },
        },
        null,
        2
      )
    );
    const previous = process.env.DSH_HOME;
    const previousCli = process.env.DSH_CLI;
    process.env.DSH_HOME = home;
    process.env.DSH_CLI = 'dsh';
    try {
      const item = {
        artifactId: null as string | null,
        copies: [{ scope: 'global' as const, host: 'dsh', path: 'npm:dsh-sleeping-plugin#dsh@web', profile: 'web' }],
        removal: { op: 'plugin-remove' as const, host: 'dsh' as const, entry: 'dsh-sleeping-plugin', profile: 'web' },
      };
      const plan = planRemove([item]);
      if ('error' in plan) throw new Error(plan.error);
      expect(plan.blocked).toEqual([]);
      expect(plan.actions[0]).toMatchObject({
        op: 'cli-remove',
        entry: 'dsh-sleeping-plugin',
        cli: { runs: [{ command: 'dsh', args: ['plugin', '--profile', 'web', 'remove', 'dsh-sleeping-plugin'] }] },
      });
      const calls: { command: string; args: string[] }[] = [];
      const removed = await applyRemove(plan.planId, {
        execImpl: async (command, args) => {
          calls.push({ command, args });
          return { code: 0, stdout: '', stderr: '' };
        },
      });
      expect(removed.ok).toBe(true);
      expect(calls).toEqual([{ command: 'dsh', args: ['plugin', '--profile', 'web', 'remove', 'dsh-sleeping-plugin'] }]);

      const forged = planRemove([{ ...item, removal: { ...item.removal, entry: 'not-installed' } }]);
      expect('error' in forged).toBe(true);
      if ('error' in forged) expect(forged.error).toContain('not a dependency');
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      if (previousCli === undefined) delete process.env.DSH_CLI;
      else process.env.DSH_CLI = previousCli;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

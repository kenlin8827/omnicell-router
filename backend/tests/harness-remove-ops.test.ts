import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverExtensions, type ExtSource } from '../src/harness/discover.js';
import { applyRemove, planRemove } from '../src/harness/maintenance.js';
import { findArtifact } from '../src/harness/manifest.js';
import { applyExtension } from '../src/harness/writers/extension.js';

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

    const applied = await applyExtension({
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

    const removed = applyRemove(plan.planId);
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

    const applied = await applyExtension({
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

    expect(applyRemove(plan.planId).ok).toBe(true);
    // A prune performs no filesystem op: the config file must still be there, byte-for-byte shape.
    expect(fs.existsSync(config)).toBe(true);
    expect(readJson(config)).toEqual({ plugin: [] });
    expect(findArtifact(applied.artifactId)).toBeUndefined();
  });
});

describe('discovered row descriptor', () => {  it('removes a plugin[] row through the descriptor the scan produced', () => {
    const root = tmp();
    const file = path.join(root, 'opencode.json');
    fs.writeFileSync(file, JSON.stringify({ mcp: { keep: { type: 'local' } }, plugin: ['ghost', 'stay'] }, null, 2));

    const source: ExtSource = {
      host: 'opencode',
      scope: 'global',
      origin: 'config-array',
      kind: 'config-array',
      path: file,
      key: 'plugin',
    };
    const row = discoverExtensions([source]).find((r) => r.name === 'ghost')!;
    expect(row.removal).toEqual({ op: 'drop-entry', file, container: 'plugin', entry: 'ghost' });

    const plan = planRemove([{ artifactId: null, copies: row.copies, removal: row.removal }]);
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.actions[0]!.op).toBe('drop-entry');

    expect(applyRemove(plan.planId).ok).toBe(true);
    const after = readJson(file);
    expect(after['plugin']).toEqual(['stay']);
    expect(after['mcp']).toEqual({ keep: { type: 'local' } });
  });

  it('describes a loose extension file as a trash path, not a config entry', () => {
    const dir = path.join(tmp(), 'extensions');
    const source: ExtSource = { host: 'pi', scope: 'global', origin: 'local-file', kind: 'loose-dir', path: dir };
    const rows = discoverExtensions([source], {
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
});

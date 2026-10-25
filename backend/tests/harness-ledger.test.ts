import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installArtifact } from '../src/harness/install.js';
import { applySkill } from '../src/harness/writers/skill.js';
import { applyRemove, planRemove } from '../src/harness/maintenance.js';
import { recentApplies, type HarnessApplyEvent } from '../src/harness/ledger.js';
import { findArtifact } from '../src/harness/manifest.js';
import { scanInventory } from '../src/harness/inventory.js';

/**
 * Apply ledger + post-apply probe (ADR-0015): every WRITER-level apply appends one observation row
 * (plan/confirm rounds append nothing), and the probe upgrades copy placement only on PROOF.
 *
 * Removal is audited the same way: `prune-record` touches nothing on disk, so the ledger row is the
 * only evidence the operator ever removed it. Removal also reconciles content drift per copy SHAPE
 * (a skill tree vs a single config file), which is what decides whether the operator must confirm.
 */

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-ledger-'));
}

describe('apply ledger', () => {
  it('records ok/partial/failed writer applies, never confirm_required plans', async () => {
    const root = tmpProject();
    const ok = await installArtifact({
      manualPayload: { name: 'brave', launch: { command: 'npx', args: ['-y', 'brave'], envKeys: ['KEY'] } },
      kind: 'mcp',
      confirm: true,
      hosts: ['opencode'],
      scope: 'project',
      projectRoot: root,
    });
    expect(ok.ok).toBe(true);

    const failed = await installArtifact({
      manualPayload: { name: 'brave', launch: { command: 'npx', args: [] } },
      kind: 'mcp',
      confirm: true,
      hosts: ['universal'], // no verified MCP landing → no viable target → writer failure
      scope: 'project',
      projectRoot: tmpProject(),
    });
    expect(failed.ok).toBe(false);

    const planned = await installArtifact({
      manualPayload: { name: 'planned', launch: { command: 'x' } },
      kind: 'mcp',
      hosts: ['opencode'],
      scope: 'project',
      projectRoot: tmpProject(),
    });
    expect(planned.ok).toBe(false); // confirm_required — no row

    const rows = recentApplies(50) as HarnessApplyEvent[];
    const mine = rows.filter((r) => r.kind === 'mcp');
    expect(mine).toHaveLength(2);
    expect(mine[0]!.outcome).toBe('failed');
    expect(mine[1]!.outcome).toBe('ok');
    expect(mine[1]!.hosts).toBe('opencode');
  });

  it('records the exact subprocess command for extension installs (gate 3)', async () => {
    const root = tmpProject();
    const result = await installArtifact({
      manualSpec: '@x/pkg',
      kind: 'extension',
      confirm: true,
      hosts: ['pi'],
      scope: 'project',
      projectRoot: root,
      execImpl: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    expect(result.ok).toBe(true);
    const row = recentApplies(10)[0]!;
    expect(row.kind).toBe('extension');
    expect(row.command).toBe('pi install npm:@x/pkg');
    expect(row.outcome).toBe('ok');
  });
});

describe('remove plan + apply (audit)', () => {
  /** Install one package-manager-owned (external) extension and return its artifact id + token. */
  async function seedExternal(spec: string): Promise<{ artifactId: string; token: string }> {
    const installed = await installArtifact({
      manualSpec: spec,
      kind: 'extension',
      confirm: true,
      hosts: ['pi'],
      scope: 'project',
      projectRoot: tmpProject(),
      execImpl: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) throw new Error('external install failed');
    const copy = findArtifact(installed.artifactId)!.copies[0]!;
    expect(copy.external).toBe(true);
    expect(copy.path).toBe(`manual:${spec}#pi`);
    return { artifactId: installed.artifactId, token: copy.path };
  }

  it('prunes an external copy from any cwd and never sends it to trash', async () => {
    const { artifactId, token } = await seedExternal('@pi/cwd-token-ext');
    const before = process.cwd();
    try {
      // The token is `<canonicalKey>#<harness>`, not a location: resolving it makes the plan answer
      // differently per directory. From an unrelated cwd the plan must still be a clean prune.
      process.chdir(tmpProject());
      const plan = planRemove([{ artifactId, copies: [{ scope: 'project', host: 'pi', path: token }] }]);
      if ('error' in plan) throw new Error(plan.error);
      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0]!.op).toBe('prune-record');
      expect(plan.actions[0]!.path).toBe(token);
      expect(plan.external).toEqual([{ path: token, host: 'pi' }]);

      const applied = applyRemove(plan.planId);
      expect(applied.ok).toBe(true);
      if (!applied.ok) return;
      // Nothing of ours exists on disk for this copy, so no trash directory is created.
      expect(applied.trashDir).toBeNull();
      expect(applied.prunedArtifacts).toEqual([artifactId]);
      expect(applied.message).toContain('package-manager-owned');
      expect(findArtifact(artifactId)).toBeUndefined();
    } finally {
      process.chdir(before);
    }
  });

  it('records a remove row for a prune that leaves no trace on disk', async () => {
    const { artifactId, token } = await seedExternal('@pi/ledger-ext');
    const plan = planRemove([{ artifactId, copies: [{ scope: 'project', host: 'pi', path: token }] }]);
    if ('error' in plan) throw new Error(plan.error);
    expect(applyRemove(plan.planId).ok).toBe(true);

    const row = recentApplies(50).find((r) => r.action === 'remove' && r.artifactId === artifactId);
    expect(row).toBeDefined();
    expect(row?.kind).toBe('extension');
    expect(row?.name).toBe('@pi/ledger-ext');
    expect(row?.hosts).toBe('pi');
    expect(row?.outcome).toBe('ok');
    expect(row?.message).toContain('package-manager-owned');
  });

  it('records a remove row for a copy that was actually moved to trash', async () => {
    const root = tmpProject();
    const applied = applySkill({
      sourceId: 'github',
      canonicalKey: 'github:owner/repo#ledger-skill',
      rawName: 'Ledger Skill',
      storeKey: 'owner__repo@abc1234__ledger-skill',
      files: [{ path: 'SKILL.md', data: Buffer.from('# ledger') }],
      pin: { git: { commitSha: 'c'.repeat(40) } },
      trust: 'community',
      hosts: ['universal'],
      scope: 'project',
      projectRoot: root,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const copy = findArtifact(applied.artifactId)!.copies[0]!;

    const plan = planRemove([
      { artifactId: applied.artifactId, copies: [{ scope: 'project', host: copy.host, path: copy.path }] },
    ]);
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.actions[0]!.op).toBe('move-to-trash');
    const removed = applyRemove(plan.planId);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(fs.existsSync(copy.path)).toBe(false);

    const row = recentApplies(50).find((r) => r.action === 'remove' && r.artifactId === applied.artifactId);
    expect(row?.kind).toBe('skill');
    expect(row?.message).toBe('removed 1 copy record(s)');
  });
});

describe('copy drift per shape (skill directory regression)', () => {
  /** Materialize one skill copy and return its artifact id + directory. */
  function installSkill(root: string, name: string) {
    const applied = applySkill({
      sourceId: 'github',
      canonicalKey: `github:owner/repo#${name}`,
      rawName: name,
      storeKey: `owner__repo@abc1234__${name}`,
      files: [{ path: 'SKILL.md', data: Buffer.from(`# ${name}`) }],
      pin: { git: { commitSha: 'd'.repeat(40) } },
      trust: 'community',
      hosts: ['universal'],
      scope: 'project',
      projectRoot: root,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error('skill apply failed');
    return { artifactId: applied.artifactId, copy: applied.copies[0]! };
  }

  function planFor(artifactId: string, copy: { host: string; path: string }) {
    const plan = planRemove([{ artifactId, copies: [{ scope: 'project', host: copy.host, path: copy.path }] }]);
    if ('error' in plan) throw new Error(plan.error);
    return plan;
  }

  it('keeps an untouched skill tree clean and removable without a discard flag', () => {
    const root = tmpProject();
    const { artifactId, copy } = installSkill(root, 'drift-skill-clean');

    // Directory copies keep the tree hash on both sides — this is the uncontaminated baseline.
    expect(scanInventory(root).artifacts.find((a) => a.id === artifactId)?.copies[0]?.state).toBe('clean');
    const plan = planFor(artifactId, copy);
    expect(plan.actions[0]!.dirty).toBe(false);
    expect(plan.warnings).toEqual([]);
    expect(applyRemove(plan.planId).ok).toBe(true);
  });

  it('reports an edited skill tree dirty and demands the discard flag', () => {
    const root = tmpProject();
    const { artifactId, copy } = installSkill(root, 'drift-skill-edited');
    fs.writeFileSync(path.join(copy.path, 'NOTES.md'), 'hand edit');

    expect(scanInventory(root).artifacts.find((a) => a.id === artifactId)?.copies[0]?.state).toBe('dirty');
    const plan = planFor(artifactId, copy);
    expect(plan.actions[0]!.dirty).toBe(true);
    expect(plan.warnings.map((w) => w.code)).toEqual(['dirty-copy']);

    const refused = applyRemove(plan.planId);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe('dirty_copy');
    expect(applyRemove(plan.planId, { discardLocalEdits: true }).ok).toBe(true);
  });
});

describe('post-apply probe', () => {
  it('upgrades skill copies to verified only when SKILL.md exists', async () => {
    const root = tmpProject();
    const SHA = 'b'.repeat(40);
    // minimal ustar + gzip, same builder style as harness-install.test.ts
    const header = (name: string, size: number) => {
      const h = Buffer.alloc(512, 0);
      h.write(name, 0, 'utf8');
      h.write(size.toString(8).padStart(11, '0') + ' ', 124, 'utf8');
      h.write('        ', 148, 'utf8');
      h.write('0', 156, 'utf8');
      let sum = 0;
      for (const b of h) sum += b;
      h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
      return h;
    };
    const body = Buffer.from('# demo');
    const zlib = await import('node:zlib');
    const tarball = zlib.gzipSync(
      Buffer.concat([header(`repo-${SHA}/demo/SKILL.md`, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512, 0), Buffer.alloc(1024, 0)])
    );
    const result = await installArtifact({
      repo: 'owner/repo',
      skillDir: 'demo',
      hosts: ['universal'],
      scope: 'project',
      fetchImpl: (async (input: unknown) => {
        const url = String(input);
        const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
        if (url.endsWith('/repos/owner/repo')) return json({ default_branch: 'main' });
        if (url.includes('/commits/')) return json({ sha: SHA });
        if (url.includes('/git/trees/')) return json({ tree: [{ path: 'demo/SKILL.md', type: 'blob' }] });
        if (url.includes('/tarball/')) return new Response(new Uint8Array(tarball));
        return new Response('nf', { status: 404 });
      }) as unknown as typeof fetch,
      projectRoot: root,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe?.allVerified).toBe(true);
    const copy = findArtifact(result.artifactId)!.copies[0]!;
    expect(copy.placement).toBe('verified');
  });

  it('marks mcp copies verified when the config carries the server key', async () => {
    const root = tmpProject();
    const result = await installArtifact({
      manualPayload: { name: 'brave', launch: { command: 'npx', args: [] } },
      kind: 'mcp',
      confirm: true,
      hosts: ['opencode'],
      scope: 'project',
      projectRoot: root,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe?.allVerified).toBe(true);
    expect(findArtifact(result.artifactId)!.copies[0]!.placement).toBe('verified');
  });
});

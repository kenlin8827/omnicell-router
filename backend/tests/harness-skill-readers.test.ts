import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skillOwner, skillReaders } from '../src/harness/host/adapters/index.js';
import { applySkill } from '../src/harness/host/writers/skill.js';
import { scanInventory } from '../src/harness/host/inventory.js';

/**
 * Skills readership (ADR-0015 §D2) — the second answer a skills directory has.
 *
 * OWNERSHIP (`skillOwner`) is one host per directory: it decides the install target, the claim and
 * the removal. READERSHIP (`skillReaders`) is every runtime whose skills roots resolve to that
 * directory — the cross-agent `.agents/skills` tree is loaded by ten of them. The skills page's
 * harness rail selects by readership, so these cases pin the two answers apart: a shared tree must
 * list every reader (owner first) and a vendor-private directory must list only its own host.
 */
const SHA = 'a'.repeat(40);

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-skill-readers-'));
}

describe('skillReaders', () => {
  it('lists every runtime that loads the shared .agents/skills tree, owner first', () => {
    const root = tmpProject();
    const shared = path.join(root, '.agents', 'skills');
    const readers = skillReaders(shared, 'project', root);

    expect(readers[0]).toBe(skillOwner(shared, 'project', root));
    expect(readers[0]).toBe('universal');
    // Ten hosts read the cross-agent project root: universal plus the nine vendors that spell it.
    expect(readers.length).toBeGreaterThan(1);
    expect(readers).toContain('opencode');
    expect(readers).toContain('pi');
    expect(readers).toContain('omp');
    expect(readers).toContain('cursor');
    expect(readers).toContain('zed');
    // A vendor-private directory is not a reader of the shared tree.
    expect(readers).not.toContain('claude');
    expect(readers).not.toContain('windsurf');
  });

  it('answers one reader for a vendor-private directory, and never the shared tree', () => {
    const root = tmpProject();
    const claude = path.join(root, '.claude', 'skills');
    expect(skillReaders(claude, 'project', root)).toEqual(['claude']);
    expect(skillReaders(claude, 'project', root)).not.toContain('universal');
    // omp reads the shared tree too, but its own `.omp/skills` directory is private to it.
    const omp = path.join(root, '.omp', 'skills');
    expect(skillReaders(omp, 'project', root)).toEqual(['omp']);
    expect(skillOwner(omp, 'project', root)).toBe('omp');
  });

  it('answers no reader for a directory no adapter resolves', () => {
    const root = tmpProject();
    expect(skillReaders(path.join(root, 'nowhere', 'skills'), 'project', root)).toEqual([]);
  });

  it('keeps the owner rule intact: the first reader in registry order is the owner', () => {
    const root = tmpProject();
    const shared = path.join(root, '.agents', 'skills');
    for (const scope of ['project'] as const) {
      expect(skillReaders(shared, scope, root)[0]).toBe(skillOwner(shared, scope, root));
    }
  });
});

describe('inventory carries readership on skill copies', () => {
  const files = [{ path: 'SKILL.md', data: Buffer.from('---\nname: demo\n---\n# demo') }];
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

  it('reports the readers of a TRACKED copy, not only the host it is recorded under', () => {
    const root = tmpProject();
    const result = applySkill({ ...base, hosts: ['universal'], projectRoot: root });
    expect(result.ok).toBe(true);

    const view = scanInventory(root).artifacts.find((a) => a.id === 'skill:github:owner/repo#demo');
    const copy = view?.copies[0];
    expect(copy?.host).toBe('universal');
    // The recorded host answers ownership; the readers answer "who can load it". A rail built on the
    // first would show this skill under one entry and hide it under the other eight.
    expect(copy?.readers?.[0]).toBe('universal');
    expect(copy?.readers).toContain('opencode');
    expect(copy?.readers).not.toContain('claude');
  });

  it('does not discover a project skills directory (project discovery is deferred)', () => {
    const root = tmpProject();
    const dir = path.join(root, '.agents', 'skills', 'loose');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: loose\n---\n# loose');

    // ADR-0015 §D2 "Scope": the scan reads global roots only, so the project declaration in the
    // adapters is a seam rather than a discovery surface. A project directory must not surface as a
    // row — the console would offer to remove something this build never installs.
    const row = scanInventory(root).discovered.find((d) => d.kind === 'skill' && d.name === 'loose');
    expect(row).toBeUndefined();
  });
});

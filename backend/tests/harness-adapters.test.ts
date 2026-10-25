import { describe, expect, it } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import {
  HOST_ADAPTERS,
  adapterFor,
  isExtensionHost,
  isMcpHost,
  isSkillsHost,
  skillLocationRoots,
  skillOwner,
} from '../src/harness/adapters/index.js';
import { opencodeAdapter } from '../src/harness/adapters/opencode.js';
import { HOSTS } from '../src/harness/hosts.js';

/**
 * Host adapter capabilities (ADR-0015 §D2/§D3 R3).
 *
 * The point of the capability split is that ABSENCE is a type fact: a host either implements
 * `SkillsHost` / `McpHost` / `ExtensionHost` or it does not. These cases pin the matrix, so a new host
 * cannot quietly claim a landing the vendor has not verified — and a shared skills directory cannot
 * end up with two owners.
 */

const ids = (guard: (adapter: unknown) => boolean): string[] =>
  HOST_ADAPTERS.filter((adapter) => guard(adapter)).map((adapter) => adapter.id);

describe('capability matrix — who can do what', () => {
  it('every catalog host has exactly one adapter, in catalog order', () => {
    expect(HOST_ADAPTERS.map((a) => a.id)).toEqual(HOSTS.map((h) => h.id));
  });

  it('twelve hosts land skills; only opencode lands MCP; only opencode and pi land extensions', () => {
    expect(ids((a) => isSkillsHost(a as never))).toEqual([
      'universal',
      'opencode',
      'claude',
      'codex',
      'pi',
      'cursor',
      'github-copilot',
      'gemini-cli',
      'cline',
      'amp',
      'windsurf',
      'zed',
    ]);
    expect(ids((a) => isMcpHost(a as never))).toEqual(['opencode']);
    expect(ids((a) => isExtensionHost(a as never))).toEqual(['opencode', 'pi']);
  });

  it('DSH is identity only — no skills location, so no SkillsHost', () => {
    expect(isSkillsHost(adapterFor('dsh'))).toBe(false);
    expect(isMcpHost(adapterFor('dsh'))).toBe(false);
    expect(isExtensionHost(adapterFor('dsh'))).toBe(false);
  });
});

describe('shared skills directories — one owner, many readers', () => {
  it('the cross-agent directory is owned by universal, not by each of its readers', () => {
    const shared = path.join(os.homedir(), '.agents', 'skills');
    expect(skillOwner(shared, 'global')).toBe('universal');
    // Project scope resolves the same relative spelling against the project root — still ONE owner.
    expect(skillOwner(path.resolve(process.cwd(), '.agents', 'skills'), 'project')).toBe('universal');
  });

  it('a vendor directory is owned by its own host', () => {
    expect(skillOwner(path.join(os.homedir(), '.claude', 'skills'), 'global')).toBe('claude');
    // Windsurf is one of the few hosts with its OWN project directory (cursor reads `.agents`).
    expect(skillOwner(path.resolve(process.cwd(), '.windsurf', 'skills'), 'project')).toBe('windsurf');
    expect(skillOwner(path.resolve(process.cwd(), '.cursor', 'skills'), 'project')).toBeNull();
  });

  it('enumeration lists each physical directory once', () => {
    const roots = skillLocationRoots(process.cwd());
    const paths = roots.map((r) => r.root);
    expect(new Set(paths).size).toBe(paths.length);
    // Twelve hosts × two scopes collapses to far fewer rows because `.agents/skills` is shared.
    expect(roots.filter((r) => r.root === path.join(os.homedir(), '.agents', 'skills'))).toHaveLength(1);
  });
});

describe('skills target — the refusal rules still bind', () => {
  it('lands a valid name under the host root', () => {
    const ctx = { projectRoot: process.cwd() };
    const target = opencodeAdapter.skillTarget(ctx, 'project', 'my-skill');
    expect(target.ok && target.path).toBe(path.resolve(process.cwd(), '.agents', 'skills', 'my-skill'));
  });

  it('refuses path-shaped names', () => {
    const ctx = { projectRoot: process.cwd() };
    expect(opencodeAdapter.skillTarget(ctx, 'global', '../escape').ok).toBe(false);
    expect(opencodeAdapter.skillTarget(ctx, 'global', 'Not_A_Name').ok).toBe(false);
  });
});

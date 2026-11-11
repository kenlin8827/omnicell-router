import { describe, expect, it } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import {
  HOST_ADAPTERS,
  adapterFor,
  hostDetected,
  isPluginHost,
  isMcpHost,
  isSkillsHost,
  skillLocationRoots,
  skillOwner,
} from '../src/harness/host/adapters/index.js';
import { opencodeAdapter } from '../src/harness/host/adapters/opencode.js';
import { HOSTS } from '../src/harness/host/hosts.js';
import { getAllClientAdapters } from '../src/cli/clients/index.js';
import { POPULARITY_UNRANKED, popularityRank } from '../src/utils/popularity.js';

/**
 * Host adapter capabilities (ADR-0015 §D2/§D3 R3).
 *
 * The point of the capability split is that ABSENCE is a type fact: a host either implements
 * `SkillsHost` / `McpHost` / `PluginHost` or it does not. These cases pin the matrix, so a new host
 * cannot quietly claim a landing the vendor has not verified — and a shared skills directory cannot
 * end up with two owners.
 */

const ids = (guard: (adapter: unknown) => boolean): string[] =>
  HOST_ADAPTERS.filter((adapter) => guard(adapter)).map((adapter) => adapter.id);

describe('capability matrix — who can do what', () => {
  it('every catalog host has exactly one adapter, in catalog order', () => {
    expect(HOST_ADAPTERS.map((a) => a.id)).toEqual(HOSTS.map((h) => h.id));
  });

  it('sixteen hosts land skills; every host with a declared MCP write path lands MCP; every host with a declared plugin write path lands plugins', () => {
    expect(ids((a) => isSkillsHost(a as never))).toEqual([
      'universal',
      'opencode',
      'claude',
      'codex',
      'pi',
      'dsh',
      'omp',
      'cursor',
      'gemini-cli',
      'kimi',
      'cline',
      'amp',
      'windsurf',
      'zed',
      'grok',
      'openclaw',
    ]);
    expect(ids(isMcpHost)).toEqual(['opencode', 'claude', 'codex', 'pi', 'omp', 'kimi', 'grok', 'openclaw']);
    // A verified landing = any declared write path (config / declared store / loose dir /
    // subprocess / marketplace chain, ADR-0015 §D2 + §D9). Catalog order.
    expect(ids(isPluginHost)).toEqual([
      'opencode',
      'claude',
      'codex',
      'pi',
      'dsh',
      'omp',
      'cursor',
      'antigravity',
      'factory',
      'kimi',
      'grok',
      'openclaw',
    ]);
  });

  it('DSH lands skills and plugins per profile, with no MCP surface', () => {
    expect(isSkillsHost(adapterFor('dsh'))).toBe(true);
    expect(isMcpHost(adapterFor('dsh'))).toBe(false);
    expect(isPluginHost(adapterFor('dsh'))).toBe(true);
  });

  it('supportedScopes — project landings follow the declared write grammar (ADR-0015 §D2)', () => {
    // Skills: every landing host takes both scopes; a host with no skillsSpec takes none.
    for (const a of HOST_ADAPTERS) {
      expect(a.supportedScopes('skill')).toEqual(isSkillsHost(a as never) ? ['global', 'project'] : []);
    }
    // MCP: every MCP host takes both scopes EXCEPT the global-only set — codex ships a project
    // config.toml for READ observation but `codex mcp add` has no project-scope grammar, and
    // openclaw stores servers centrally in `~/.openclaw/openclaw.json` with no project landing
    // (explicit spec overrides).
    const globalOnlyMcp = new Set(['codex', 'openclaw']);
    for (const a of HOST_ADAPTERS) {
      if (!isMcpHost(a as never)) {
        expect(a.supportedScopes('mcp')).toEqual([]);
        continue;
      }
      expect(a.supportedScopes('mcp')).toEqual(globalOnlyMcp.has(a.id) ? ['global'] : ['global', 'project']);
    }
    // Plugins: project only where the adapter DECLARES a project landing (configProject+container,
    // declared.project, looseDir.project, a marketplace `{scope}` token, or scope-aware argv).
    const projectPlugin = ['opencode', 'claude', 'pi', 'omp', 'factory'];
    const globalOnlyPlugin = ['codex', 'cursor', 'antigravity', 'kimi', 'grok', 'openclaw', 'dsh'];
    for (const id of projectPlugin) {
      expect(adapterFor(id)!.supportedScopes('plugin'), `${id} must land project plugins`).toEqual(['global', 'project']);
    }
    for (const id of globalOnlyPlugin) {
      expect(adapterFor(id)!.supportedScopes('plugin'), `${id} must be global-only for plugins`).toEqual(['global']);
    }
    // A host with no plugin landing at all answers no scope.
    expect(adapterFor('universal')!.supportedScopes('plugin')).toEqual([]);
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
    expect(skillOwner(path.join(os.homedir(), '.omp', 'skills'), 'global')).toBe('omp');
    expect(skillOwner(path.join(os.homedir(), '.kimi-code', 'skills'), 'global')).toBe('kimi');
    // Measured 2026-12 vendor dirs: cline owns `~/.cline/skills` + `.cline/skills`
    // (cline/cline skill-directories.ts), codex owns project `.codex/skills` (its user
    // `~/.codex/skills` is deprecated — the shared tree stays codex's global landing).
    expect(skillOwner(path.join(os.homedir(), '.cline', 'skills'), 'global')).toBe('cline');
    expect(skillOwner(path.resolve(process.cwd(), '.cline', 'skills'), 'project')).toBe('cline');
    expect(skillOwner(path.resolve(process.cwd(), '.codex', 'skills'), 'project')).toBe('codex');
    expect(skillOwner(path.resolve(process.cwd(), '.codex', 'skills'), 'global')).toBeNull();
    // gemini-cli owns its project tree (`.gemini/skills`) while its global stays vendor-private
    // (`~/.gemini/skills`).
    expect(skillOwner(path.resolve(process.cwd(), '.gemini', 'skills'), 'project')).toBe('gemini-cli');
    // Windsurf is one of the hosts with its OWN project directory (cursor reads `.agents`).
    expect(skillOwner(path.resolve(process.cwd(), '.windsurf', 'skills'), 'project')).toBe('windsurf');
    expect(skillOwner(path.resolve(process.cwd(), '.omp', 'skills'), 'project')).toBe('omp');
    expect(skillOwner(path.resolve(process.cwd(), '.cursor', 'skills'), 'project')).toBeNull();
  });
  it('enumeration lists each physical directory once', () => {
    const roots = skillLocationRoots(process.cwd());
    const paths = roots.map((r) => r.root);
    expect(new Set(paths).size).toBe(paths.length);
    // Sixteen hosts × two scopes collapses to far fewer rows because `.agents/skills` is shared.
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

describe('install presence — the rail hides hosts that are not on this machine', () => {
  it('every non-universal host declares at least one presence marker', () => {
    for (const adapter of HOST_ADAPTERS) {
      if (adapter.id === 'universal') continue;
      expect(adapter.presence?.command || adapter.presence?.dir, adapter.id).toBeTruthy();
    }
  });

  it('universal is always detected; a skills host is detected once its global root exists', () => {
    expect(hostDetected(adapterFor('universal')!)).toBe(true);
    // This dev machine may or may not carry a given runtime — the assertion that must hold
    // everywhere is: detection is a pure measurement, never a throw.
    for (const adapter of HOST_ADAPTERS) {
      expect(typeof hostDetected(adapter)).toBe('boolean');
    }
  });

  it('a made-up runtime with no markers and no skills is not detected', () => {
    expect(hostDetected({ id: 'dsh', presence: { command: 'definitely-not-a-real-binary-xyz' } })).toBe(false);
  });
});

describe('popularity order — one rank for both surfaces', () => {
  it('ranks every catalog host (except universal) and every client target', () => {
    for (const host of HOSTS) {
      if (host.id === 'universal') continue;
      expect(popularityRank(host.id), host.id).toBeLessThan(POPULARITY_UNRANKED);
    }
    for (const adapter of getAllClientAdapters()) {
      expect(popularityRank(adapter.name), adapter.name).toBeLessThan(POPULARITY_UNRANKED);
    }
  });

  it('returns the one-click roster in rank order', () => {
    const ranks = getAllClientAdapters().map((adapter) => popularityRank(adapter.name));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

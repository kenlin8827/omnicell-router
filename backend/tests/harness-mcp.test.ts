import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { npmAdapter } from '../src/harness/host/resolvers/npm.js';
import { MARKET_RETRY } from '../src/harness/net.js';
import { installArtifact } from '../src/harness/host/install.js';
import { applyMcp, planMcp } from '../src/harness/host/writers/mcp.js';
import { applyRemove, planRemove } from '../src/harness/host/maintenance.js';
import { claimPath, readManifest } from '../src/harness/host/manifest.js';
import { scanInventory } from '../src/harness/host/inventory.js';
import { registerHarnessRoutes } from '../src/routes/harness.js';

/**
 * MCP merge writer + official-registry adapter (ADR-0015 §D2/§D6, gate 2/4).
 *
 * Gate 2: plan → confirm → apply, with the exact added/changed keys surfaced. Gate 4: env/header
 * values NEVER appear in written configs — only `{env:KEY}` references. A config copy is one FILE,
 * so its drift is measured with `hashFile` (never `hashTree`: a tree hash of a file is the empty
 * digest, which would report every merged server as locally edited).
 */

const LAUNCH = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], envKeys: ['BRAVE_API_KEY'] } as const;

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mcp-'));
}

function baseReq(root: string, name = 'brave') {
  return {
    sourceId: 'manual',
    canonicalKey: `manual:${name}`,
    name,
    launch: LAUNCH,
    trust: 'manual' as const,
    hosts: ['opencode'] as never[],
    scope: 'project' as never,
    projectRoot: root,
  };
}

describe('applyMcp', () => {
  it('merges into a fresh config with env KEY NAMES only, never values', () => {
    const root = tmpProject();
    const result = applyMcp(baseReq(root));
    expect(result.ok).toBe(true);
    const file = path.join(root, 'opencode.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8')) as any;
    expect(config.mcp.brave.type).toBe('local');
    expect(config.mcp.brave.command).toEqual(['npx', '-y', '@modelcontextprotocol/server-brave-search']);
    expect(config.mcp.brave.enabled).toBe(true);
    expect(config.mcp.brave.environment.BRAVE_API_KEY).toBe('{env:BRAVE_API_KEY}');
    expect(JSON.stringify(config)).not.toContain('sk-');
    const artifact = readManifest().artifacts.find((a) => a.id === 'mcp:manual:brave');
    expect(artifact?.kind).toBe('mcp');
    expect(artifact?.copies[0]!.path).toBe(file);
  });

  it('records the source description on the artifact so an installed row can show it', () => {
    const root = tmpProject();
    const result = applyMcp({ ...baseReq(root, 'described'), description: 'Brave search for MCP' });
    expect(result.ok).toBe(true);
    // An MCP copy is one config entry — there is no file of ours to read prose from later, so the
    // description the source claimed at resolve time is the only copy the console will ever have.
    const artifact = readManifest().artifacts.find((a) => a.id === 'mcp:manual:described');
    expect(artifact?.description).toBe('Brave search for MCP');
    const view = scanInventory(root).artifacts.find((a) => a.id === 'mcp:manual:described');
    expect(view?.description).toBe('Brave search for MCP');
  });

  it('preserves unrelated keys and sibling servers on merge', () => {
    const root = tmpProject();
    const file = path.join(root, 'opencode.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ $schema: 'x', model: 'kimi', mcp: { other: { type: 'remote', url: 'https://x' } } }, null, 2)
    );
    const result = applyMcp(baseReq(root));
    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(file, 'utf8')) as any;
    expect(config.$schema).toBe('x');
    expect(config.model).toBe('kimi');
    expect(config.mcp.other.url).toBe('https://x');
    expect(config.mcp.brave).toBeDefined();
  });

  it('reports changed keys when an existing server entry differs, and no changes when identical', () => {
    const root = tmpProject();
    applyMcp(baseReq(root));
    const plan1 = planMcp({ ...baseReq(root), launch: { command: 'other', args: [] } });
    expect(plan1.ok && plan1.targets[0]!.changedKeys).toEqual(['brave']);
    const plan2 = planMcp(baseReq(root));
    expect(plan2.ok && plan2.targets[0]!.addedKeys).toEqual([]);
    expect(plan2.ok && plan2.targets[0]!.changedKeys).toEqual([]);
  });

  it('refuses a JSONC file byte-identically — a JSON rewrite would drop comments', () => {
    const root = tmpProject();
    const file = path.join(root, 'opencode.json');
    const original = `{\n  // my hand-written note\n  "model": "kimi"\n}\n`;
    fs.writeFileSync(file, original);
    const result = applyMcp(baseReq(root));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('bad_request');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('refuses a path claimed by another environment', () => {
    const root = tmpProject();
    claimPath(path.join(root, 'opencode.json'), 'mcp:manual:someone', 'another-env');
    const result = applyMcp(baseReq(root));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('foreign');
  });

  it('refuses hosts without a verified MCP landing', () => {
    const root = tmpProject();
    const plan = planMcp({ ...baseReq(root), hosts: ['universal'] as never[] });
    expect(plan.ok && plan.targets[0]!.refused).toContain('no verified MCP landing');
  });
});

describe('config-copy drift (file fingerprint, not a tree)', () => {
  /** Merge one MCP server into `<root>/opencode.json` and return the recorded copy. */
  function installMcp(root: string, name: string) {
    const applied = applyMcp(baseReq(root, name));
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error('mcp apply failed');
    return { artifactId: applied.artifactId, copy: applied.copies[0]! };
  }

  it('reports a config copy clean, plans it with no dirty warning and removes it without discard', () => {
    const root = tmpProject();
    const { artifactId, copy } = installMcp(root, 'drift-clean');

    // A config copy is ONE file; the writer hashed it with `hashFile`. Hashing it as a tree returns
    // the empty-tree digest, so this assertion is the regression guard for the "every MCP copy is
    // dirty" lie.
    const view = scanInventory(root).artifacts.find((a) => a.id === artifactId);
    expect(view?.copies[0]?.state).toBe('clean');
    expect(view?.rollup).toBe('clean');

    const plan = planRemove([{ artifactId, copies: [{ scope: 'project', host: copy.host, path: copy.path }] }]);
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.actions[0]!.dirty).toBe(false);
    expect(plan.warnings).toEqual([]);
    // A config copy is removed MEMBER by member: the file is the runtime's whole config, so trashing
    // it would take every other server in it along (the data-loss class this op exists for).
    expect(plan.actions[0]!.op).toBe('drop-server');
    expect(plan.actions[0]!.entry).toBe('drift-clean');

    // No discard flag: the operator is asked to confirm edits only when edits exist.
    const applied = applyRemove(plan.planId);
    expect(applied.ok).toBe(true);
    expect(fs.existsSync(copy.path)).toBe(true);
    const after = JSON.parse(fs.readFileSync(copy.path, 'utf8')) as { mcp?: Record<string, unknown> };
    expect(after.mcp?.['drift-clean']).toBeUndefined();
  });

  it('keeps a hand-edited config intact and removes only our server entry', () => {
    const root = tmpProject();
    const { artifactId, copy } = installMcp(root, 'drift-edited');
    expect(scanInventory(root).artifacts.find((a) => a.id === artifactId)?.copies[0]?.state).toBe('clean');

    // An unrelated top-level key is exactly how a human edit looks: the recorded hash no longer
    // matches, even though our own server entry is untouched.
    const config = JSON.parse(fs.readFileSync(copy.path, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(copy.path, JSON.stringify({ ...config, handWritten: true }, null, 2));

    expect(scanInventory(root).artifacts.find((a) => a.id === artifactId)?.copies[0]?.state).toBe('dirty');

    const plan = planRemove([{ artifactId, copies: [{ scope: 'project', host: copy.host, path: copy.path }] }]);
    if ('error' in plan) throw new Error(plan.error);
    // The hand edit is not our content and is not destroyed by removing our member, so there is
    // nothing to discard and no warning to raise.
    expect(plan.actions[0]!.op).toBe('drop-server');
    expect(plan.warnings).toEqual([]);

    expect(applyRemove(plan.planId).ok).toBe(true);
    const after = JSON.parse(fs.readFileSync(copy.path, 'utf8')) as { handWritten?: boolean; mcp?: Record<string, unknown> };
    expect(after.handWritten).toBe(true);
    expect(after.mcp?.['drift-edited']).toBeUndefined();
  });
});

describe('installArtifact mcp orchestration', () => {
  it('answers confirm_required with the plan and writes NOTHING without confirm', async () => {
    const root = tmpProject();
    const result = await installArtifact({
      manualPayload: { name: 'brave', launch: LAUNCH },
      kind: 'mcp',
      hosts: ['opencode'],
      scope: 'project',
      projectRoot: root,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('confirm_required');
      expect(result.plan?.[0]!.addedKeys).toEqual(['brave']);
    }
    expect(fs.existsSync(path.join(root, 'opencode.json'))).toBe(false);
  });

  it('applies after confirm through the manual escape hatch', async () => {
    const root = tmpProject();
    const result = await installArtifact({
      manualPayload: { name: 'brave', launch: LAUNCH },
      kind: 'mcp',
      confirm: true,
      hosts: ['opencode'],
      scope: 'project',
      projectRoot: root,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifactId).toBe('mcp:manual:brave');
    expect(fs.existsSync(path.join(root, 'opencode.json'))).toBe(true);
  });
});

describe('hosts route (capability flags)', () => {
  const app = fastify({ logger: false });
  registerHarnessRoutes(app);

  it('reports hasMcp alongside hasSkills/hasExt, from the catalog and never guessed', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/harness/hosts' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      hosts: { id: string; hasSkills: boolean; hasMcp: boolean; hasExt: boolean }[];
    };
    // Only a VERIFIED landing is wired, so exactly one host may claim MCP capability today.
    expect(body.hosts.filter((host) => host.hasMcp).map((host) => host.id)).toEqual(['opencode']);
    const byId = new Map(body.hosts.map((host) => [host.id, host]));
    expect(byId.get('opencode')).toMatchObject({ hasSkills: true, hasMcp: true, hasExt: true });
    // A host with no MCP landing answers `false` — the flag is a capability, not a path guess.
    expect(byId.get('claude')).toMatchObject({ hasSkills: true, hasMcp: false, hasExt: true });
    expect(byId.get('universal')).toMatchObject({ hasSkills: true, hasMcp: false, hasExt: false });
    // Grok is served for skills only: the `.grok-plugin` market form is declared, the landing is not.
    expect(byId.get('grok')).toMatchObject({ hasSkills: true, hasMcp: false, hasExt: false });
  });
});

/**
 * npm as an MCP source (ADR-0015 §8): the registry answers the package spec and its integrity hash;
 * the launch is the minimal non-interactive npx invocation of the PINNED version, because no author
 * runtime arguments exist off-registry. Identity stays `npm:<pkg>` — one package, one key, whatever
 * kind installed it.
 */
describe('npm adapter (mcp kind)', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const PACKUMENT = { name: 'x-mcp', 'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': {} } };
  const VERSION_DOC = { name: 'x-mcp', version: '1.2.3', description: 'x mcp server', dist: { integrity: 'sha512-xyz' } };
  const fakeFetch = (): typeof fetch =>
    (async (input: unknown) => {
      const url = String(input);
      if (url === 'https://registry.npmjs.org/x-mcp/1.2.3') return json(VERSION_DOC);
      if (url === 'https://registry.npmjs.org/x-mcp') return json(PACKUMENT);
      return new Response('nf', { status: 404 });
    }) as typeof fetch;

  it('resolves a bare package name to a pinned npx launch', async () => {
    const outcome = await npmAdapter.resolve('x-mcp', 'mcp', { fetchImpl: fakeFetch() });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    if (outcome.payload.kind !== 'mcp') return expect.unreachable();
    expect(outcome.canonicalKey).toBe('npm:x-mcp');
    expect(outcome.payload.launch).toEqual({ command: 'npx', args: ['-y', 'x-mcp@1.2.3'] });
    expect(outcome.pin).toEqual({ npm: { integrity: 'sha512-xyz' } });
    expect(outcome.description).toBe('x mcp server');
  });

  it('keeps the typed unsupported_kind for skill — the tarball reader still does not exist', async () => {
    const outcome = await npmAdapter.resolve('x-mcp', 'skill', { fetchImpl: fakeFetch() });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('unsupported_kind');
  });

  it('installs through the orchestrator: confirm gate first, then the pinned spec lands in the host config', async () => {
    const root = tmpProject();
    const planned = await installArtifact({
      key: 'npm:x-mcp',
      kind: 'mcp',
      hosts: ['opencode'],
      scope: 'project',
      projectRoot: root,
      fetchImpl: fakeFetch(),
    });
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.code).toBe('confirm_required');
    expect(fs.existsSync(path.join(root, 'opencode.json'))).toBe(false);

    const applied = await installArtifact({
      key: 'npm:x-mcp',
      kind: 'mcp',
      confirm: true,
      hosts: ['opencode'],
      scope: 'project',
      projectRoot: root,
      fetchImpl: fakeFetch(),
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.artifactId).toBe('mcp:npm:x-mcp');
    const config = JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8')) as any;
    expect(config.mcp['x-mcp'].command).toEqual(['npx', '-y', 'x-mcp@1.2.3']);
    const artifact = readManifest().artifacts.find((a) => a.id === 'mcp:npm:x-mcp');
    expect(artifact?.pin).toEqual({ npm: { integrity: 'sha512-xyz' } });
  });
});

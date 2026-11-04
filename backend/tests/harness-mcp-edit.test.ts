import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMcp } from '../src/harness/host/writers/mcp.js';
import { editMcpServer, readMcpEntry } from '../src/harness/host/mcp-edit.js';
import { claimPath, readManifest } from '../src/harness/host/manifest.js';
import { scanInventory } from '../src/harness/host/inventory.js';

/**
 * MCP entry read + edit (ADR-0015 §D8 amendment).
 *
 * The edit path rewrites ONE member of the runtime's config through gate 2, preserves every other
 * member and unknown field, and never lets an env/header VALUE travel back to the console. A tracked
 * copy keeps its manifest hash in sync so an edit does not surface as a dirty copy afterwards.
 */

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mcp-edit-'));
}

function configFile(root: string): string {
  return path.join(root, 'opencode.json');
}

function writeConfig(root: string, config: unknown): void {
  fs.writeFileSync(configFile(root), JSON.stringify(config, null, 2));
}

function readConfig(root: string): any {
  return JSON.parse(fs.readFileSync(configFile(root), 'utf8'));
}

const LITERAL_KEY = 'sk-live-secret-do-not-leak';

describe('readMcpEntry', () => {
  it('reads a local entry back as command/args/env KEY NAMES only', async () => { const root = tmpProject();
  writeConfig(root, {
    model: 'kimi',
    mcp: {
      brave: {
        type: 'local',
        command: ['npx', '-y', 'pkg@2'],
        environment: { BRAVE_API_KEY: LITERAL_KEY },
      },
    },
  });
  
  const result = readMcpEntry({ host: 'opencode', scope: 'project', name: 'brave', projectRoot: root });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.launch).toEqual({ command: 'npx', args: ['-y', 'pkg@2'], envKeys: ['BRAVE_API_KEY'] });
  // Gate 4: the literal value stays in the file, never in the answer.
  expect(JSON.stringify(result)).not.toContain(LITERAL_KEY); });

  it('reads a remote entry as a url launch with header KEY NAMES only', async () => { const root = tmpProject();
  writeConfig(root, {
    mcp: { remote: { type: 'remote', url: 'https://example.test/sse', headers: { Authorization: 'Bearer t' } } },
  });
  
  const result = readMcpEntry({ host: 'opencode', scope: 'project', name: 'remote', projectRoot: root });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.launch).toEqual({ url: 'https://example.test/sse', transport: 'sse', headerKeys: ['Authorization'] });
  expect(result.setKeys).toEqual(['Authorization']);
  expect(JSON.stringify(result)).not.toContain('Bearer t'); });

  it('reports which keys already hold a value without echoing any of them', async () => { const root = tmpProject();
  writeConfig(root, {
    mcp: {
      mixed: {
        type: 'local',
        command: ['npx', '-y', 'pkg'],
        environment: {
          LITERAL: LITERAL_KEY,
          REFERENCE: '{env:REFERENCE}',
          FROM_FILE: '{file:./secret.txt}',
        },
      },
    },
  });
  
  const result = readMcpEntry({ host: 'opencode', scope: 'project', name: 'mixed', projectRoot: root });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // A bare `{env:KEY}` is the operator's own name, not a stored value; a literal and a file
  // reference both resolve without the process environment, so both read as set.
  expect(result.setKeys).toEqual(['LITERAL', 'FROM_FILE']);
  expect(JSON.stringify(result)).not.toContain(LITERAL_KEY);
  expect(JSON.stringify(result)).not.toContain('secret.txt'); });

  it('answers not_found for a missing file, container, or server key', async () => { const root = tmpProject();
  expect(readMcpEntry({ host: 'opencode', scope: 'project', name: 'x', projectRoot: root })).toMatchObject({
    ok: false,
    code: 'not_found',
  });
  
  writeConfig(root, { mcp: { present: { type: 'local', command: ['x'] } } });
  expect(readMcpEntry({ host: 'opencode', scope: 'project', name: 'absent', projectRoot: root })).toMatchObject({
    ok: false,
    code: 'not_found',
  }); });

  it('refuses a host without a verified MCP landing', async () => { const root = tmpProject();
  expect(readMcpEntry({ host: 'universal', scope: 'project', name: 'x', projectRoot: root })).toMatchObject({
    ok: false,
    code: 'bad_request',
  }); });

  it('reads an existing name that predates the install grammar', async () => { // The install grammar guards a NEW object key; an existing key is whatever the runtime stored.
  const root = tmpProject();
  writeConfig(root, { mcp: { 'my server': { type: 'local', command: ['npx', 'pkg'] } } });
  const result = readMcpEntry({ host: 'opencode', scope: 'project', name: 'my server', projectRoot: root });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.launch).toEqual({ command: 'npx', args: ['pkg'] }); });
});

describe('editMcpServer', () => {
  it('answers confirm_required and writes nothing without confirm', async () => { const root = tmpProject();
  writeConfig(root, { mcp: { brave: { type: 'local', command: ['npx', 'old'] } } });
  const before = fs.readFileSync(configFile(root), 'utf8');
  
  const result = await editMcpServer({
    host: 'opencode',
    scope: 'project',
    name: 'brave',
    launch: { command: 'npx', args: ['new'] },
    projectRoot: root,
  })
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe('confirm_required');
  expect(result.plan?.[0]).toMatchObject({ container: 'mcp', addedKeys: [], changedKeys: ['brave'] });
  expect(fs.readFileSync(configFile(root), 'utf8')).toBe(before); });

  it('rewrites one member, preserving a same-key literal value and every unrelated field', async () => { const root = tmpProject();
  writeConfig(root, {
    $schema: 'x',
    model: 'kimi',
    mcp: {
      other: { type: 'remote', url: 'https://other.test' },
      brave: {
        type: 'local',
        command: ['npx', 'old'],
        enabled: false,
        timeout: 42,
        environment: { BRAVE_API_KEY: LITERAL_KEY, DROPPED_KEY: 'retired' },
      },
    },
  });
  
  const result = await editMcpServer({
    host: 'opencode',
    scope: 'project',
    name: 'brave',
    launch: { command: 'npx', args: ['new@2'], envKeys: ['BRAVE_API_KEY', 'NEW_KEY'] },
    confirm: true,
    projectRoot: root,
  })
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.changed).toBe(true);
  
  const config = readConfig(root);
  expect(config.$schema).toBe('x');
  expect(config.model).toBe('kimi');
  expect(config.mcp.other.url).toBe('https://other.test');
  expect(config.mcp.brave.command).toEqual(['npx', 'new@2']);
  // The operator's literal survives: rewriting it to `{env:KEY}` would change what the runtime loads.
  expect(config.mcp.brave.environment.BRAVE_API_KEY).toBe(LITERAL_KEY);
  expect(config.mcp.brave.environment.NEW_KEY).toBe('{env:NEW_KEY}');
  // The form's key list is authoritative: a key the operator removed leaves the entry.
  expect(config.mcp.brave.environment.DROPPED_KEY).toBeUndefined();
  // Unknown fields and the disabled flag belong to the entry, not to the launch.
  expect(config.mcp.brave.timeout).toBe(42);
  expect(config.mcp.brave.enabled).toBe(false); });

  it('writes a typed value verbatim and keeps an untouched stored value', async () => { const root = tmpProject();
  writeConfig(root, {
    mcp: {
      brave: {
        type: 'local',
        command: ['npx', 'old'],
        environment: { BRAVE_API_KEY: LITERAL_KEY, KEPT: 'keep-me' },
      },
    },
  });
  
  const result = await editMcpServer({
    host: 'opencode',
    scope: 'project',
    name: 'brave',
    launch: { command: 'npx', args: ['new'], envKeys: ['BRAVE_API_KEY', 'KEPT'], envValues: { BRAVE_API_KEY: 'typed' } },
    confirm: true,
    projectRoot: root,
  })
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.changed).toBe(true);
  
  const environment = readConfig(root).mcp.brave.environment;
  expect(environment.BRAVE_API_KEY).toBe('typed');
  // The form did not touch KEPT: its stored value survives instead of becoming a reference.
  expect(environment.KEPT).toBe('keep-me'); });

  it('materializes {env:KEY} for a named key with no typed value', async () => { const root = tmpProject();
  writeConfig(root, { mcp: { x: { type: 'local', command: ['npx', 'pkg'] } } });
  
  const result = await editMcpServer({
    host: 'opencode',
    scope: 'project',
    name: 'x',
    launch: { command: 'npx', args: ['pkg'], envKeys: ['FRESH'], envValues: { FRESH: '' } },
    confirm: true,
    projectRoot: root,
  })
  expect(result.ok).toBe(true);
  expect(readConfig(root).mcp.x.environment).toEqual({ FRESH: '{env:FRESH}' }); });

  it('writes typed header values and keeps an untouched stored header', async () => { const root = tmpProject();
  writeConfig(root, {
    mcp: {
      remote: {
        type: 'remote',
        url: 'https://example.test/sse',
        headers: { Authorization: LITERAL_KEY, KEPT: 'keep-me' },
      },
    },
  });
  
  const result = await editMcpServer({
    host: 'opencode',
    scope: 'project',
    name: 'remote',
    launch: {
      url: 'https://example.test/sse',
      transport: 'sse',
      headerKeys: ['Authorization', 'KEPT', 'X-Fresh'],
      headerValues: { Authorization: 'Bearer typed' },
    },
    confirm: true,
    projectRoot: root,
  })
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.changed).toBe(true);
  
  const headers = readConfig(root).mcp.remote.headers;
  // The operator typed this one: written verbatim.
  expect(headers.Authorization).toBe('Bearer typed');
  // The form left this field blank: the stored literal survives instead of becoming a reference.
  expect(headers.KEPT).toBe('keep-me');
  // A newly named key has nothing stored: the host's own reference is materialized.
  expect(headers['X-Fresh']).toBe('{env:X-Fresh}'); });

  it('re-submitting a remote entry unchanged is a no-op write', async () => { const root = tmpProject();
  writeConfig(root, {
    mcp: { remote: { type: 'remote', url: 'https://example.test/sse', headers: { Authorization: '{env:Authorization}' } } },
  });
  const before = fs.readFileSync(configFile(root), 'utf8');
  
  const result = await editMcpServer({
    host: 'opencode',
    scope: 'project',
    name: 'remote',
    launch: { url: 'https://example.test/sse', transport: 'sse', headerKeys: ['Authorization'] },
    confirm: true,
    projectRoot: root,
  })
  expect(result.ok && result.changed).toBe(false);
  expect(fs.readFileSync(configFile(root), 'utf8')).toBe(before); });

  it('rejects a value map that is not plain bounded strings', async () => { const root = tmpProject();
  writeConfig(root, { mcp: { x: { type: 'local', command: ['npx'] } } });
  
  const result = await editMcpServer({
    host: 'opencode',
    scope: 'project',
    name: 'x',
    launch: { command: 'npx', envKeys: ['A'], envValues: { A: 42 as unknown as string } },
    confirm: true,
    projectRoot: root,
  })
  expect(result).toMatchObject({ ok: false, code: 'bad_request' }); });

  it('switches stdio → remote without leaving a stale command or environment', async () => { const root = tmpProject();
  writeConfig(root, {
    mcp: { x: { type: 'local', command: ['npx', 'pkg'], environment: { OLD: '{env:OLD}' } } },
  });
  
  const result = await editMcpServer({
    host: 'opencode',
    scope: 'project',
    name: 'x',
    launch: { url: 'https://example.test/sse', transport: 'sse', headerKeys: ['Authorization'] },
    confirm: true,
    projectRoot: root,
  })
  expect(result.ok).toBe(true);
  
  const entry = readConfig(root).mcp.x;
  expect(entry.type).toBe('remote');
  expect(entry.url).toBe('https://example.test/sse');
  expect(entry.headers).toEqual({ Authorization: '{env:Authorization}' });
  expect(entry.command).toBeUndefined();
  expect(entry.environment).toBeUndefined(); });

  it('is a no-op when the composed entry is identical', async () => { const root = tmpProject();
  writeConfig(root, { mcp: { x: { type: 'local', command: ['npx', 'pkg'] } } });
  const before = fs.readFileSync(configFile(root), 'utf8');
  
  const result = await editMcpServer({
    host: 'opencode',
    scope: 'project',
    name: 'x',
    launch: { command: 'npx', args: ['pkg'] },
    confirm: true,
    projectRoot: root,
  })
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.changed).toBe(false);
  expect(fs.readFileSync(configFile(root), 'utf8')).toBe(before); });

  it('refuses an edited launch that asks for a network transport', async () => { const root = tmpProject();
  writeConfig(root, { mcp: { brave: { type: 'local', command: ['npx', 'old'] } } });
  const before = fs.readFileSync(configFile(root), 'utf8');
  
  const result = await editMcpServer({
    host: 'opencode',
    scope: 'project',
    name: 'brave',
    // The entry lands in a host that reads it over stdio; `--transport http` starts an HTTP
    // server instead and can only time out.
    launch: {
      command: 'npx',
      args: ['-y', '@bytebase/dbhub', '--transport', 'http', '--dsn', 'sqlite::memory:'],
    },
    confirm: true,
    projectRoot: root,
  })
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe('bad_request');
  expect(result.message).toContain('--transport http');
  expect(fs.readFileSync(configFile(root), 'utf8')).toBe(before); });

  it('leaves a custom command launch alone — its --transport is not the MCP wire transport', async () => { const root = tmpProject();
  writeConfig(root, { mcp: { wrapped: { type: 'local', command: ['my-mcp-wrapper'] } } });
  
  const result = await editMcpServer({
    host: 'opencode',
    scope: 'project',
    name: 'wrapped',
    launch: { command: 'my-mcp-wrapper', args: ['--transport', 'http'] },
    confirm: true,
    projectRoot: root,
  })
  expect(result.ok).toBe(true);
  expect(readConfig(root).mcp.wrapped.command).toEqual(['my-mcp-wrapper', '--transport', 'http']); });

  it('refuses a JSONC file byte-identically', async () => { const root = tmpProject();
  const original = '{\n  // hand-written\n  "mcp": { "x": { "type": "local", "command": ["npx"] } }\n}\n';
  fs.writeFileSync(configFile(root), original);
  
  const result = await editMcpServer({
    host: 'opencode',
    scope: 'project',
    name: 'x',
    launch: { command: 'npx', args: ['other'] },
    confirm: true,
    projectRoot: root,
  })
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe('bad_request');
  expect(fs.readFileSync(configFile(root), 'utf8')).toBe(original); });

  it('refuses a config file claimed by another environment', async () => { const root = tmpProject();
  writeConfig(root, { mcp: { x: { type: 'local', command: ['npx'] } } });
  claimPath(configFile(root), 'mcp:manual:x', 'another-env');
  
  const result = await editMcpServer({
    host: 'opencode',
    scope: 'project',
    name: 'x',
    launch: { command: 'npx', args: ['other'] },
    confirm: true,
    projectRoot: root,
  })
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe('foreign'); });

  it('keeps a tracked copy clean by updating its manifest hash, and leaves a discovered row record-free', async () => { const root = tmpProject();
  const applied = await applyMcp({
    sourceId: 'manual',
    canonicalKey: 'manual:tracked-edit',
    name: 'tracked-edit',
    launch: { command: 'npx', args: ['pkg'] },
    trust: 'manual',
    hosts: ['opencode'] as never[],
    scope: 'project' as never,
    projectRoot: root,
  })
  expect(applied.ok).toBe(true);
  if (!applied.ok) return;
  
  const edited = await editMcpServer({
    host: 'opencode',
    scope: 'project',
    name: 'tracked-edit',
    launch: { command: 'npx', args: ['pkg@2'] },
    artifactId: applied.artifactId,
    confirm: true,
    projectRoot: root,
  })
  expect(edited.ok).toBe(true);
  const view = scanInventory(root).artifacts.find((artifact) => artifact.id === applied.artifactId);
  expect(view?.copies[0]?.state).toBe('clean');
  
  // A discovered entry (no manifest record) is editable too — and the manifest must not grow one.
  const before = readManifest().artifacts.length;
  writeConfig(root, {
    ...readConfig(root),
    mcp: { ...readConfig(root).mcp, discovered: { type: 'local', command: ['npx', 'runtime'] } },
  });
  const discovered = await editMcpServer({
    host: 'opencode',
    scope: 'project',
    name: 'discovered',
    launch: { command: 'npx', args: ['runtime@2'] },
    confirm: true,
    projectRoot: root,
  })
  expect(discovered.ok).toBe(true);
  if (!discovered.ok) return;
  expect(discovered.artifactId).toBeNull();
  expect(readManifest().artifacts.length).toBe(before);
  expect(readConfig(root).mcp.discovered.command).toEqual(['npx', 'runtime@2']); });

  it('rejects an artifactId that does not name this server copy', async () => { const root = tmpProject();
  writeConfig(root, { mcp: { x: { type: 'local', command: ['npx'] } } });
  
  const result = await editMcpServer({
    host: 'opencode',
    scope: 'project',
    name: 'x',
    launch: { command: 'npx', args: ['other'] },
    artifactId: 'mcp:manual:something-else',
    confirm: true,
    projectRoot: root,
  })
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe('bad_request'); });
});

describe('per-host entry shape', () => {
  /** A pi project config, whose `mcpServers` spelling differs from opencode's in every field. */
  function piFile(root: string): string {
    return path.join(root, '.pi', 'mcp.json');
  }

  function writePi(root: string, entry: unknown): void {
    fs.mkdirSync(path.join(root, '.pi'), { recursive: true });
    fs.writeFileSync(piFile(root), JSON.stringify({ mcpServers: { brave: entry } }, null, 2));
  }

  it('composes the `mcpServers` spelling and keeps a field it does not own', async () => { const root = tmpProject();
  writePi(root, {
    command: 'npx',
    args: ['-y', 'old'],
    cwd: '/tmp/work',
    env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' },
  });
  
  const result = await editMcpServer({
    host: 'pi',
    scope: 'project',
    name: 'brave',
    launch: { command: 'npx', args: ['-y', 'new'], envKeys: ['BRAVE_API_KEY', 'EXTRA'] },
    confirm: true,
    projectRoot: root,
  })
  expect(result.ok).toBe(true);
  
  const config = JSON.parse(fs.readFileSync(piFile(root), 'utf8')) as any;
  expect(config.mcpServers.brave).toEqual({
    command: 'npx',
    args: ['-y', 'new'],
    cwd: '/tmp/work',
    // The `${KEY}` reference the runtime expands survives; the newly named key becomes one too.
    env: { BRAVE_API_KEY: '${BRAVE_API_KEY}', EXTRA: '${EXTRA}' },
  });
  // No opencode-only vocabulary was grafted on.
  expect(config.mcpServers.brave.type).toBeUndefined();
  expect(config.mcpServers.brave.environment).toBeUndefined(); });

  it('composes the `mcpServers` remote shape with `${KEY}` references and a typed value', async () => { const root = tmpProject();
  writePi(root, { url: 'https://example.test/mcp', headers: { Authorization: '${AUTH}' } });
  
  const result = await editMcpServer({
    host: 'pi',
    scope: 'project',
    name: 'brave',
    launch: {
      url: 'https://example.test/mcp',
      transport: 'sse',
      headerKeys: ['Authorization', 'X-Fresh'],
      headerValues: { Authorization: 'Bearer typed' },
    },
    confirm: true,
    projectRoot: root,
  })
  expect(result.ok).toBe(true);
  
  const config = JSON.parse(fs.readFileSync(piFile(root), 'utf8')) as any;
  expect(config.mcpServers.brave).toEqual({
    url: 'https://example.test/mcp',
    headers: { Authorization: 'Bearer typed', 'X-Fresh': '${X-Fresh}' },
  });
  expect(config.mcpServers.brave.type).toBeUndefined(); });

  it('reads a `${KEY}` reference back as an unset key, never as a stored value', async () => { const root = tmpProject();
  writePi(root, { command: 'npx', args: ['-y', 'pkg'], env: { BRAVE_API_KEY: '${BRAVE_API_KEY}', LITERAL: LITERAL_KEY } });
  
  const result = readMcpEntry({ host: 'pi', scope: 'project', name: 'brave', projectRoot: root });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.launch).toEqual({ command: 'npx', args: ['-y', 'pkg'], envKeys: ['BRAVE_API_KEY', 'LITERAL'] });
  // Only the hand-typed literal is "already set"; the reference is not a value at all.
  expect(result.setKeys).toEqual(['LITERAL']);
  expect(JSON.stringify(result)).not.toContain(LITERAL_KEY); });

  it('re-submitting a pi entry unchanged is a no-op write', async () => { const root = tmpProject();
  writePi(root, { command: 'npx', args: ['-y', 'pkg'], env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' } });
  const before = fs.readFileSync(piFile(root), 'utf8');
  
  const result = await editMcpServer({
    host: 'pi',
    scope: 'project',
    name: 'brave',
    launch: { command: 'npx', args: ['-y', 'pkg'], envKeys: ['BRAVE_API_KEY'] },
    confirm: true,
    projectRoot: root,
  })
  expect(result.ok && result.changed).toBe(false);
  expect(fs.readFileSync(piFile(root), 'utf8')).toBe(before); });
});

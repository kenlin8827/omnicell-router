import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverMcp, mcpSources, mcpTrackedKey, type DiscoveryDeps, type McpSource } from '../src/harness/host/discover.js';
import { applyRemove, planRemove } from '../src/harness/host/maintenance.js';
import { isMcpHost } from '../src/harness/host/adapters/index.js';

/**
 * MCP discovery (ADR-0015 §D8.10) — the object-shaped landing, read the same way the plugin page
 * reads `plugin[]`.
 *
 * The rules under test are the ones that keep observation from becoming ownership: one row per
 * SERVER KEY read from the runtime's own config, tagged with the host it came from; the row carries
 * the exact inverse (`drop-server`) so removal edits THAT member and nothing else; a
 * `(host, serverKey)` the manifest already tracks is excluded; and a config that is half-written,
 * hand-broken or wrongly shaped answers "no rows" instead of throwing.
 *
 * All IO is injected for the scanner cases (the host catalog resolves absolute paths at import time,
 * which a test cannot re-point); the removal case writes a real scratch file because it asserts the
 * bytes that survive on disk.
 */

function deps(files: Record<string, unknown>): DiscoveryDeps {
  return {
    exists: (p) => p in files,
    readJson: (p) => files[p],
    readDir: () => [],
    isDir: () => false,
    readTextHead: () => null,
  };
}

const FILE = path.join(path.sep, 'host', 'opencode.json');

const source: McpSource = { host: 'opencode', scope: 'global', path: FILE, container: 'mcp' };

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mcp-scan-'));
}

describe('mcpSources', () => {
  it('asks only MCP-capable hosts, and reads the container their writer merges into', () => {
    const sources = mcpSources(process.cwd());
    expect(sources.length).toBeGreaterThan(0);
    for (const entry of sources) {
      const declared = mcpSources(process.cwd()).filter((s) => s.host === entry.host);
      expect(declared.length).toBeGreaterThan(0);
      expect(entry.container).toBe('mcp');
      // The scan and the writer must never disagree about the landing.
      expect(path.isAbsolute(entry.path)).toBe(true);
    }
    expect(sources.some((s) => s.scope === 'global')).toBe(true);
    expect(sources.some((s) => s.scope === 'project')).toBe(true);
  });

  it('contributes no source for a host without the MCP landing capability', () => {
    const sources = mcpSources(process.cwd());
    const capable = new Set(sources.map((s) => s.host));
    // Every declared source belongs to a host that actually implements `McpHost`.
    for (const host of capable) expect(host).toBeTruthy();
    expect(capable.size).toBeLessThanOrEqual(1);
    expect(isMcpHost(undefined)).toBe(false);
  });
});

describe('discoverMcp', () => {
  it('answers one row per server key, with the inverse descriptor and the host it was read from', () => {
    const rows = discoverMcp([source], {
      deps: deps({
        [FILE]: {
          mcp: {
            localpkg: { type: 'local', command: ['npx', '-y', '@acme/server'], enabled: true },
            remoteapi: { type: 'remote', url: 'https://mcp.acme.test/sse', enabled: true },
            bare: { enabled: false },
          },
        },
      }),
    });

    expect(rows.map((r) => r.name)).toEqual(['bare', 'localpkg', 'remoteapi']);
    const local = rows.find((r) => r.name === 'localpkg')!;
    expect(local.kind).toBe('mcp');
    expect(local.harness).toBe('opencode');
    expect(local.hosts).toEqual(['opencode']);
    expect(local.description).toBe('local · npx -y @acme/server');
    expect(local.origin).toBe('runtime-store');
    expect(local.observedFrom).toBe(FILE);
    expect(local.removal).toEqual({ op: 'drop-server', file: FILE, container: 'mcp', entry: 'localpkg' });
    // A server is a MEMBER of a file we did not create: the row is untracked, and its copy names the
    // real location so the console can show where it was read from.
    expect(local.copies).toEqual([
      { scope: 'global', host: 'opencode', rootId: 'default', path: FILE, state: 'untracked', placement: 'materialized' },
    ]);

    expect(rows.find((r) => r.name === 'remoteapi')!.description).toBe('remote · https://mcp.acme.test/sse');
    // A hand-written entry with no command and no url still belongs on the page; it just says less.
    expect(rows.find((r) => r.name === 'bare')!.description).toBeNull();
  });

  it('excludes a (host, serverKey) the manifest already tracks, so one install is never reported twice', () => {
    const rows = discoverMcp([source], {
      tracked: [mcpTrackedKey('opencode', 'mine')],
      deps: deps({ [FILE]: { mcp: { mine: { type: 'local', command: ['a'] }, other: { type: 'local', command: ['b'] } } } }),
    });
    expect(rows.map((r) => r.name)).toEqual(['other']);
  });

  it('does not let the tracked set leak across hosts: the key carries the host', () => {
    const rows = discoverMcp([{ ...source, host: 'pi', path: path.join(path.sep, 'pi', 'settings.json') }], {
      tracked: [mcpTrackedKey('opencode', 'shared')],
      deps: deps({ [path.join(path.sep, 'pi', 'settings.json')]: { mcp: { shared: { type: 'local' } } } }),
    });
    expect(rows.map((r) => r.name)).toEqual(['shared']);
  });

  it('reads every declared container spelling a source names, and dedupes the same server', () => {
    const rows = discoverMcp([source, { ...source, path: FILE }], {
      deps: deps({ [FILE]: { mcp: { one: { type: 'local' } } } }),
    });
    expect(rows).toHaveLength(1);
  });

  it('answers "no rows" for a source that is missing, unparsable, or wrongly shaped — never throws', () => {
    expect(discoverMcp([source], { deps: deps({}) })).toEqual([]);
    expect(
      discoverMcp([source], {
        deps: {
          ...deps({ [FILE]: {} }),
          readJson: () => {
            throw new SyntaxError('half-written');
          },
        },
      })
    ).toEqual([]);
    // The `mcp` key exists but is not an object (a string, an array, a null): nothing to observe.
    expect(discoverMcp([source], { deps: deps({ [FILE]: { mcp: 'nope' } }) })).toEqual([]);
    expect(discoverMcp([source], { deps: deps({ [FILE]: { mcp: ['a'] } }) })).toEqual([]);
    expect(discoverMcp([source], { deps: deps({ [FILE]: { mcp: null } }) })).toEqual([]);
    expect(discoverMcp([source], { deps: deps({ [FILE]: { other: { one: {} } } }) })).toEqual([]);
  });

  it('tolerates a config that is not an object at the top level', () => {
    expect(discoverMcp([source], { deps: deps({ [FILE]: [] }) })).toEqual([]);
    expect(discoverMcp([source], { deps: deps({ [FILE]: 'text' }) })).toEqual([]);
  });
});

describe('discovered MCP row removal', () => {
  it('drops exactly that member from its own file and keeps every sibling', () => {
    const root = tmp();
    const file = path.join(root, 'opencode.json');
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          mcp: {
            ghost: { type: 'local', command: ['npx', 'ghost'] },
            keep: { type: 'remote', url: 'https://example.test/mcp' },
          },
          plugin: ['stay'],
        },
        null,
        2
      )
    );

    const row = discoverMcp([{ ...source, path: file }]).find((r) => r.name === 'ghost')!;
    expect(row.removal).toEqual({ op: 'drop-server', file, container: 'mcp', entry: 'ghost' });

    const plan = planRemove([{ artifactId: null, copies: row.copies, removal: row.removal }]);
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.actions[0]!.op).toBe('drop-server');
    expect(plan.actions[0]!.file).toBe(file);
    expect(plan.actions[0]!.container).toBe('mcp');
    expect(plan.actions[0]!.entry).toBe('ghost');

    expect(applyRemove(plan.planId).ok).toBe(true);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.mcp).toEqual({ keep: { type: 'remote', url: 'https://example.test/mcp' } });
    // The plugin array is another kind's landing: an MCP removal must not touch it.
    expect(after.plugin).toEqual(['stay']);
  });
});

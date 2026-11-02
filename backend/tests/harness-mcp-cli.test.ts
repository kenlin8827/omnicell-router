import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { applyMcp, planMcp, redactSecrets } from '../src/harness/host/writers/mcp.js';
import { planRemove } from '../src/harness/host/maintenance.js';
import { readManifest } from '../src/harness/host/manifest.js';
import { readMcpLandingFile, mcpContainerAt } from '../src/harness/host/mcp-entry.js';
import { discoverMcp } from '../src/harness/host/discover.js';
import { probeGrokMcpRuntime } from '../src/harness/host/grok-mcp-runtime.js';
import { probeClaudeMcpRuntime } from '../src/harness/host/claude-mcp-runtime.js';
import { probeKimiMcpRuntime } from '../src/harness/host/kimi-mcp-runtime.js';
/**
 * CLI-materialized MCP landings (ADR-0015 §D8.13): claude, codex, grok and openclaw (plus kimi's
 * file-merge contrast case).
 *
 * The landing READS the runtime's own config file (claude `~/.claude.json` / project `.mcp.json`
 * `mcpServers`; codex `config.toml` `[mcp_servers.<name>]`; grok `~/.grok/config.toml`; openclaw
 * `~/.openclaw/openclaw.json` `mcp.servers` — comment-carrying JSON5, so only its own CLI writes)
 * but never reserializes it — the plan composes the runtime's own add command (echoed for gate
 * 2/3), apply runs it through the exec seam, and the copy is recorded `external` because the
 * runtime's store, not a file hash, is the truth. The inverse removal plans the runtime's own
 * remove verb; the apply for it spawns the real CLI (no exec seam on `applyRemove`), so it is
 * asserted at PLAN level here.
 */

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mcp-cli-'));
}

type Exec = { code: number; stdout: string; stderr: string };
function recordingExec(log: { calls: { command: string; args: string[] }[] }, result: Exec = { code: 0, stdout: '', stderr: '' }) {
  return async (command: string, args: string[]) => {
    log.calls.push({ command, args });
    return result;
  };
}

const STDIO = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], envKeys: ['BRAVE_API_KEY'] } as const;

function req(root: string, host: 'claude' | 'codex', name = 'brave') {
  return {
    sourceId: 'manual',
    canonicalKey: `manual:${name}`,
    name,
    launch: STDIO,
    trust: 'manual' as const,
    hosts: [host] as never[],
    scope: 'project' as never,
    projectRoot: root,
  };
}

describe('redactSecrets', () => {
  it('replaces every typed secret VALUE, leaving key names and the command intact', () => {
    const echo = 'npx -y pkg --env BRAVE_API_KEY=sk-live --header Authorization=Bearer tok';
    expect(
      redactSecrets(echo, { command: 'npx', args: ['-y', 'pkg'], envKeys: ['BRAVE_API_KEY'], envValues: { BRAVE_API_KEY: 'sk-live' } })
    ).toBe('npx -y pkg --env BRAVE_API_KEY=*** --header Authorization=Bearer tok');
    expect(
      redactSecrets(echo, {
        url: 'https://mcp.acme.test/sse',
        transport: 'sse',
        headerKeys: ['Authorization'],
        headerValues: { Authorization: 'Bearer tok' },
      })
    ).toBe('npx -y pkg --env BRAVE_API_KEY=sk-live --header Authorization=***');
  });

  it('leaves an echo that carries only ${KEY} references untouched', () => {
    const echo = 'npx -y pkg --env BRAVE_API_KEY=${BRAVE_API_KEY}';
    expect(redactSecrets(echo, { command: 'npx', envKeys: ['BRAVE_API_KEY'] })).toBe(echo);
  });
});

describe('claude CLI-materialized landing', () => {
  it('plans the runtime\'s own add-json command with ${KEY} secret references, gate 2 echoes it', () => {
    const root = tmpProject();
    const plan = planMcp(req(root, 'claude'));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const target = plan.targets[0]!;
    expect(target.refused).toBeUndefined();
    expect(target.addedKeys).toEqual(['brave']);
    expect(target.echo).toBe(
      `claude mcp add-json brave '{"command":"npx","args":["-y","@modelcontextprotocol/server-brave-search"],"env":{"BRAVE_API_KEY":"\${BRAVE_API_KEY}"}}' --scope project`
    );
  });

  it('apply runs the echoed argv verbatim and records an external copy, never touching the file', async () => {
    const root = tmpProject();
    const file = path.join(root, '.mcp.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {}, other: 'state' }));
    const log: { calls: { command: string; args: string[] }[] } = { calls: [] };
    const applied = await applyMcp({ ...req(root, 'claude'), execImpl: recordingExec(log) });
    expect(applied.ok).toBe(true);
    // The file is read-only observation: nothing was written into it, and the unrelated state stays.
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown>; other?: string };
    expect(onDisk.other).toBe('state');
    expect(onDisk.mcpServers?.brave).toBeUndefined();
    // The run log is the audit trail; the copy is the runtime's own store, recorded `external`.
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.command).toBe('claude');
    expect(log.calls[0]!.args[0]).toBe('mcp');
    expect(log.calls[0]!.args[1]).toBe('add-json');
    const artifact = readManifest().artifacts.find((a) => a.id === 'mcp:manual:brave');
    expect(artifact?.copies[0]).toMatchObject({ host: 'claude', external: true, path: 'manual:brave#claude' });
  });

  it('plans changedKeys when the file already carries a different entry for the same name', () => {
    const root = tmpProject();
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { brave: { command: 'old' } } }));
    const plan = planMcp(req(root, 'claude'));
    expect(plan.ok && plan.targets[0]!.changedKeys).toEqual(['brave']);
    expect(plan.ok && plan.targets[0]!.addedKeys).toEqual([]);
  });

  it('refuses a remote launch through add-json only via the host\'s http shape, with typed headers verbatim', () => {
    const root = tmpProject();
    const plan = planMcp({
      ...req(root, 'claude', 'remote'),
      launch: { url: 'https://example.com/mcp', headerKeys: ['AUTH'], headerValues: { AUTH: 'tok' } },
    } as never);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const args = plan.targets[0]!.cli!.runs[0]!.args;
    const entry = JSON.parse(args[3]!) as { type: string; url: string; headers: Record<string, string> };
    expect(entry).toEqual({ type: 'http', url: 'https://example.com/mcp', headers: { AUTH: 'tok' } });
  });

  it('plans the runtime\'s own remove verb for a tracked external copy', async () => {
    const root = tmpProject();
    const log: { calls: { command: string; args: string[] }[] } = { calls: [] };
    const applied = await applyMcp({ ...req(root, 'claude'), execImpl: recordingExec(log) });
    expect(applied.ok).toBe(true);
    const plan = planRemove([
      { artifactId: 'mcp:manual:brave', copies: [{ scope: 'project', host: 'claude', path: 'manual:brave#claude' }] },
    ]);
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.actions[0]!.op).toBe('cli-remove');
    expect(plan.actions[0]!.cli!.echo).toBe('claude mcp remove brave --scope project');
  });
});

describe('codex CLI-materialized landing (TOML)', () => {
  it('reads the comment-carrying TOML landing without reserializing it', () => {
    const root = tmpProject();
    const file = path.join(root, 'config.toml');
    fs.writeFileSync(file, '# hand comment\n[mcp_servers.brave]\ncommand = "npx"\nargs = ["-y", "pkg"]\n');
    const parsed = readMcpLandingFile(file, 'toml');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const container = parsed.config.mcp_servers as Record<string, unknown>;
    expect((container.brave as { command: string }).command).toBe('npx');
    // The comment stays on disk — a TOML parse never writes the file back.
    expect(fs.readFileSync(file, 'utf8')).toContain('# hand comment');
  });

  it('refuses project scope — codex declares no project MCP landing (`codex mcp add` has no project grammar)', () => {
    const root = tmpProject();
    // The capability gate (ADR-0015 §D2) refuses before the CLI grammar is even consulted: codex
    // SHIPS a project config.toml for read observation, but its `mcp add` verb cannot write it.
    const plan = planMcp(req(root, 'codex'));
    expect(plan.ok && plan.targets[0]!.refused).toContain("host 'codex' declares no project-scope MCP landing");
  });

  it('plans `codex mcp add` with literal env values and refuses an unnamed secret', () => {
    const root = tmpProject();
    // codex refuses project scope outright, so the env grammar runs at global scope — the check
    // itself is scope-independent.
    const refused = planMcp({ ...req(root, 'codex'), scope: 'global' } as never);
    expect(refused.ok && refused.targets[0]!.refused).toContain('codex env values are literal');
    const typed = planMcp({
      ...req(root, 'codex'),
      scope: 'global',
      launch: { command: 'npx', args: ['-y', 'pkg'], envKeys: ['KEY'], envValues: { KEY: 'lit' } },
    } as never);
    expect(typed.ok).toBe(true);
    if (!typed.ok) return;
    const target = typed.targets[0]!;
    expect(target.refused).toBeUndefined();
    expect(target.cli!.runs[0]!.args).toEqual(['mcp', 'add', 'brave', '--env', 'KEY=lit', '--', 'npx', '-y', 'pkg']);
  });

  it('refuses headers on a remote launch — codex carries no custom header field', () => {
    const root = tmpProject();
    const plan = planMcp({
      ...req(root, 'codex', 'remote'),
      scope: 'global',
      launch: { url: 'https://example.com/mcp', headerKeys: ['AUTH'] },
    } as never);
    expect(plan.ok && plan.targets[0]!.refused).toContain('no custom headers');
  });

  it('discovers rows from the TOML container with the cli-remove inverse', () => {
    const root = tmpProject();
    const file = path.join(root, 'config.toml');
    fs.writeFileSync(file, '[mcp_servers.brave]\ncommand = "npx"\nargs = ["-y", "pkg"]\n');
    const rows = discoverMcp([
      { host: 'codex', scope: 'global', path: file, container: 'mcp_servers', format: 'toml', cli: { command: 'codex' } },
    ]);
    expect(rows[0]!.removal).toMatchObject({ op: 'cli-remove', host: 'codex', entry: 'brave' });
  });
});

describe('openclaw CLI-materialized landing (JSON5, nested container)', () => {
  it('reads the comment-carrying JSON5 landing without reserializing it', () => {
    const root = tmpProject();
    const file = path.join(root, 'openclaw.json');
    fs.writeFileSync(file, '// hand comment\n{\n  mcp: {\n    // nested container\n    servers: { brave: { command: "npx" } },\n  },\n}\n');
    const parsed = readMcpLandingFile(file, 'json5');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const container = mcpContainerAt(parsed.config, 'mcp.servers');
    expect((container?.brave as { command: string }).command).toBe('npx');
    // The comment stays on disk — a JSON5 parse never writes the file back.
    expect(fs.readFileSync(file, 'utf8')).toContain('// hand comment');
  });

  it('refuses project scope — openclaw declares no project MCP landing (central config only)', () => {
    const root = tmpProject();
    const plan = planMcp(req(root, 'openclaw' as never));
    expect(plan.ok && plan.targets[0]!.refused).toContain('openclaw stores MCP servers centrally');
  });

  it('plans `openclaw mcp add` with ${KEY} references and --no-probe at global scope', () => {
    const root = tmpProject();
    const plan = planMcp({ ...req(root, 'openclaw' as never), scope: 'global' } as never);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const target = plan.targets[0]!;
    expect(target.refused).toBeUndefined();
    expect(target.cli!.runs[0]!.args).toEqual([
      'mcp', 'add', 'brave', '--command', 'npx',
      '--arg', '-y', '--arg', '@modelcontextprotocol/server-brave-search',
      '--env', 'BRAVE_API_KEY=${BRAVE_API_KEY}',
      '--no-probe',
    ]);
  });

  it('plans a remote add with typed headers through --url/--transport', () => {
    const root = tmpProject();
    const plan = planMcp({
      ...req(root, 'openclaw' as never, 'remote'),
      scope: 'global',
      launch: { url: 'https://example.com/mcp', headerKeys: ['AUTH'], headerValues: { AUTH: 'tok' } },
    } as never);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.targets[0]!.cli!.runs[0]!.args).toEqual([
      'mcp', 'add', 'remote', '--url', 'https://example.com/mcp', '--transport', 'streamable-http',
      '--header', 'AUTH=tok',
      '--no-probe',
    ]);
  });

  it('apply runs the echoed argv verbatim and records an external copy', async () => {
    const root = tmpProject();
    const log: { calls: { command: string; args: string[] }[] } = { calls: [] };
    const applied = await applyMcp({ ...req(root, 'openclaw' as never), scope: 'global', execImpl: recordingExec(log) } as never);
    expect(applied.ok).toBe(true);
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.command).toBe('openclaw');
    expect(log.calls[0]!.args).toContain('--no-probe');
    const artifact = readManifest().artifacts.find((a) => a.id === 'mcp:manual:brave');
    expect(artifact?.copies.some((c) => c.host === 'openclaw' && c.external)).toBe(true);
  });

  it('plans the runtime\'s own unset verb for a tracked external copy', async () => {
    const root = tmpProject();
    const log: { calls: { command: string; args: string[] }[] } = { calls: [] };
    const applied = await applyMcp({ ...req(root, 'openclaw' as never), scope: 'global', execImpl: recordingExec(log) } as never);
    expect(applied.ok).toBe(true);
    const plan = planRemove([
      { artifactId: 'mcp:manual:brave', copies: [{ scope: 'global', host: 'openclaw', path: 'manual:brave#openclaw' }] },
    ]);
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.actions[0]!.op).toBe('cli-remove');
    expect(plan.actions[0]!.cli!.echo).toBe('openclaw mcp unset brave');
  });

  it('discovers rows from the nested mcp.servers container with the cli-remove inverse', () => {
    const root = tmpProject();
    const file = path.join(root, 'openclaw.json');
    fs.writeFileSync(file, '{ "mcp": { "servers": { "brave": { "command": "npx", "args": ["-y", "pkg"] } } } }\n');
    const rows = discoverMcp([
      { host: 'openclaw', scope: 'global', path: file, container: 'mcp.servers', format: 'json5', cli: { command: 'openclaw' } },
    ]);
    expect(rows[0]!.name).toBe('brave');
    expect(rows[0]!.removal).toMatchObject({ op: 'cli-remove', host: 'openclaw', entry: 'brave' });
  });
});

describe('kimi file-merge landing (dedicated mcp.json)', () => {
  it('plans a config merge with typed env values and refuses an unnamed secret', () => {
    const root = tmpProject();
    const refused = planMcp(req(root, 'kimi' as never));
    expect(refused.ok && refused.targets[0]!.refused).toContain('kimi env/header values are literal');
    const typed = planMcp({
      ...req(root, 'kimi' as never),
      launch: { command: 'npx', args: ['-y', 'pkg'], envKeys: ['KEY'], envValues: { KEY: 'lit' } },
    } as never);
    expect(typed.ok).toBe(true);
    if (!typed.ok) return;
    const target = typed.targets[0]!;
    expect(target.refused).toBeUndefined();
    expect(target.cli).toBeUndefined();
    expect(target.addedKeys).toEqual(['brave']);
    expect(target.file).toContain('mcp.json');
  });

  it('apply merges the standard mcpServers entry into the dedicated file', async () => {
    const root = tmpProject();
    const applied = await applyMcp({
      ...req(root, 'kimi' as never),
      launch: { command: 'npx', args: ['-y', 'pkg'], envKeys: ['KEY'], envValues: { KEY: 'lit' } },
    } as never);
    expect(applied.ok).toBe(true);
    const file = applied.ok ? applied.copies[0]!.path : '';
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: Record<string, { command: string; env: Record<string, string> }> };
    expect(onDisk.mcpServers.brave).toEqual({ command: 'npx', args: ['-y', 'pkg'], env: { KEY: 'lit' } });
  });
});

describe('grok CLI-materialized landing (TOML)', () => {
  it('plans `grok mcp add` with the scope flag before `--` and refuses an unnamed secret', () => {
    const root = tmpProject();
    const refused = planMcp(req(root, 'grok' as never));
    expect(refused.ok && refused.targets[0]!.refused).toContain('grok env/header values are literal');
    const typed = planMcp({
      ...req(root, 'grok' as never),
      launch: { command: 'npx', args: ['-y', 'pkg'], envKeys: ['KEY'], envValues: { KEY: 'lit' } },
    } as never);
    expect(typed.ok).toBe(true);
    if (!typed.ok) return;
    const target = typed.targets[0]!;
    expect(target.refused).toBeUndefined();
    // The scope flag must precede `--`: everything after it belongs to the server command.
    expect(target.cli!.runs[0]!.args).toEqual(['mcp', 'add', 'brave', '-e', 'KEY=lit', '-s', 'project', '--', 'npx', '-y', 'pkg']);
  });

  it('plans a remote add with typed headers — grok supports them, unlike codex', () => {
    const root = tmpProject();
    const plan = planMcp({
      ...req(root, 'grok' as never, 'remote'),
      launch: { url: 'https://example.com/mcp', headerKeys: ['AUTH'], headerValues: { AUTH: 'tok' } },
    } as never);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.targets[0]!.cli!.runs[0]!.args).toEqual([
      'mcp', 'add', '--transport', 'http', 'remote', 'https://example.com/mcp', '--header', 'AUTH: tok', '-s', 'project',
    ]);
  });

  it('plans the runtime remove verb with an explicit scope for a tracked external copy', async () => {
    const root = tmpProject();
    const log: { calls: { command: string; args: string[] }[] } = { calls: [] };
    const applied = await applyMcp({
      ...req(root, 'grok' as never),
      launch: { command: 'npx', args: ['-y', 'pkg'], envKeys: ['KEY'], envValues: { KEY: 'lit' } },
      execImpl: recordingExec(log),
    } as never);
    expect(applied.ok).toBe(true);
    const plan = planRemove([
      { artifactId: 'mcp:manual:brave', copies: [{ scope: 'project', host: 'grok', path: 'manual:brave#grok' }] },
    ]);
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.actions[0]!.op).toBe('cli-remove');
    expect(plan.actions[0]!.cli!.echo).toBe('grok mcp remove brave -s project');
  });
});

describe('grok live runtime status (doctor)', () => {
  const doctorJson = (servers: unknown[]) => JSON.stringify({ config_sources: [], servers, failing_count: servers.length });

  it('maps the doctor verdicts: healthy → connected, failed checks → failed with the labels', async () => {
    const report = await probeGrokMcpRuntime(async () => ({
      code: 1, // exit 1 = some server failed; the JSON still arrives
      stdout: doctorJson([
        { name: 'ok', transport: 'stdio', target: 'npx', source: 'user', healthy: true, checks: [] },
        { name: 'down', transport: 'stdio', target: 'npx', source: 'user', healthy: false, checks: [{ label: 'launch', passed: false, detail: 'ENOENT' }, { label: 'initialize', passed: true }] },
      ]),
      stderr: '',
    }));
    expect(report.reachable).toBe(true);
    expect(report.servers).toEqual([
      { name: 'ok', status: 'connected' },
      { name: 'down', status: 'failed', error: 'failed: launch' },
    ]);
  });

  it('answers "no live claim" for an unparsable or crashed doctor, never a server verdict', async () => {
    const crashed = await probeGrokMcpRuntime(async () => ({ code: 101, stdout: '', stderr: 'panic' }));
    expect(crashed.reachable).toBe(false);
    expect(crashed.servers).toEqual([]);
    const garbage = await probeGrokMcpRuntime(async () => ({ code: 0, stdout: 'not json', stderr: '' }));
    expect(garbage.reachable).toBe(false);
    const wrongShape = await probeGrokMcpRuntime(async () => ({ code: 0, stdout: '{"servers": "all"}', stderr: '' }));
    expect(wrongShape.reachable).toBe(false);
  });
});

describe('claude live runtime status (mcp list)', () => {
  const LIST = [
    'Checking MCP server health...',
    'brave: npx -y server-brave - ✔ Connected',
    'linear: npx -y server-linear - ! Needs authentication',
    'down: npx -y server-down - ✘ Failed to connect',
    '',
  ].join('\n');

  it('maps the vendor verdicts and ignores every other line', async () => {
    const report = await probeClaudeMcpRuntime(async () => ({ code: 0, stdout: LIST, stderr: '' }));
    expect(report.reachable).toBe(true);
    expect(report.servers).toEqual([
      { name: 'brave', status: 'connected' },
      { name: 'linear', status: 'needs_auth' },
      { name: 'down', status: 'failed', error: 'claude reports: failed to connect' },
    ]);
  });

  it('answers "no live claim" when no verdict line matches', async () => {
    const empty = await probeClaudeMcpRuntime(async () => ({ code: 0, stdout: 'No servers configured', stderr: '' }));
    expect(empty.reachable).toBe(false);
    const blank = await probeClaudeMcpRuntime(async () => ({ code: 1, stdout: '', stderr: 'boom' }));
    expect(blank.reachable).toBe(false);
  });
});

describe('kimi live runtime status (per-server test)', () => {
  it('tests every configured server through the exec seam and maps exit codes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-kimi-rt-'));
    process.env.KIMI_CODE_HOME = root;
    try {
      writeFileSync(path.join(root, 'mcp.json'), JSON.stringify({ mcpServers: { good: { command: 'x' }, bad: { command: 'y' } } }));
      const calls: string[] = [];
      const report = await probeKimiMcpRuntime(async (_command, args) => {
        calls.push(args.join(' '));
        return args[2] === 'good'
          ? { code: 0, stdout: '2 tools', stderr: '' }
          : { code: 1, stdout: '', stderr: 'connect ECONNREFUSED' };
      });
      expect(calls.sort()).toEqual(['mcp test bad', 'mcp test good']);
      expect(report.reachable).toBe(true);
      expect(report.servers.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: 'bad', status: 'failed', error: 'connect ECONNREFUSED' },
        { name: 'good', status: 'connected' },
      ]);
    } finally {
      delete process.env.KIMI_CODE_HOME;
    }
  });

  it('keeps a live claim when the FIRST server test fails for a real reason (only "unknown command" means no mcp support)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-kimi-rt-'));
    process.env.KIMI_CODE_HOME = root;
    try {
      writeFileSync(path.join(root, 'mcp.json'), JSON.stringify({ mcpServers: { first: { command: 'x' }, second: { command: 'y' } } }));
      const calls: string[] = [];
      const report = await probeKimiMcpRuntime(async (_command, args) => {
        calls.push(args.join(' '));
        return { code: 1, stdout: '', stderr: 'connect ECONNREFUSED' };
      });
      // First test failed with a REAL error (not "unknown command") → mcp exists, so the probe
      // stays reachable and reports both servers verbatim — never a false "no live claim".
      expect(calls).toEqual(['mcp test first', 'mcp test second']);
      expect(report.reachable).toBe(true);
      expect(report.servers.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: 'first', status: 'failed', error: 'connect ECONNREFUSED' },
        { name: 'second', status: 'failed', error: 'connect ECONNREFUSED' },
      ]);
    } finally {
      delete process.env.KIMI_CODE_HOME;
    }
  });

  it('reads a missing config root as "no servers" (reachable, empty, no verdicts)', async () => {
    process.env.KIMI_CODE_HOME = path.join(os.tmpdir(), 'ocr-kimi-missing-zz');
    try {
      const report = await probeKimiMcpRuntime(async () => ({ code: 0, stdout: '', stderr: '' }));
      // A missing mcp.json reads as "no servers" — reachable with an empty list, still no verdicts.
      expect(report).toEqual({ reachable: true, servers: [] });
    } finally {
      delete process.env.KIMI_CODE_HOME;
    }
  });

  it('answers "no live claim" after ONE spawn when the binary has no mcp subcommand (shipped v2.4.1)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-kimi-rt-nocmd-'));
    process.env.KIMI_CODE_HOME = root;
    try {
      writeFileSync(path.join(root, 'mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }));
      let calls = 0;
      const report = await probeKimiMcpRuntime(async () => {
        calls += 1;
        return { code: 1, stdout: '', stderr: "error: unknown command 'mcp'" };
      });
      expect(calls).toBe(1);
      expect(report.reachable).toBe(false);
      expect(report.servers).toEqual([]);
      expect(report.message).toContain("unknown command 'mcp'");
    } finally {
      delete process.env.KIMI_CODE_HOME;
    }
  });

  it('answers "no live claim" when kimi cannot be spawned at all', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-kimi-rt-nokimi-'));
    process.env.KIMI_CODE_HOME = root;
    try {
      writeFileSync(path.join(root, 'mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'x' } } }));
      const report = await probeKimiMcpRuntime(async () => {
        throw new Error('spawn kimi ENOENT');
      });
      expect(report.reachable).toBe(false);
      expect(report.servers).toEqual([]);
      expect(report.message).toContain('kimi mcp test is not runnable');
    } finally {
      delete process.env.KIMI_CODE_HOME;
    }
  });
});

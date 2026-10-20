import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../src/server.js';
import { buildGatewayChildEnv, buildWindowsEnvSets, RESTART_PARENT_ENV } from '../src/cli/daemon.js';
import { OpenCodeClientAdapter } from '../src/cli/clients/opencode.js';
import { listOpenCodeAgents, listOpenCodeAgentsLive } from '../src/opencode/agents.js';
import { ClaudeClientAdapter } from '../src/cli/clients/claude.js';
import { CodexClientAdapter } from '../src/cli/clients/codex.js';
import { PiClientAdapter } from '../src/cli/clients/pi.js';
import { DshClientAdapter } from '../src/cli/clients/dsh.js';
import { parse as parseYaml } from 'yaml';

describe('CLI Client Setup & Teardown Adapters', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('OpenCode adapter should safely setup and teardown with backup restoration', async () => {
    const configPath = path.join(tmpDir, 'opencode.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ $schema: 'https://opencode.ai/config.json', providers: {}, model: 'anthropic/claude-sonnet-4' }, null, 2)
    );

    const adapter = new OpenCodeClientAdapter();
    adapter.getConfigPath = () => configPath;

    // Initial status
    let status = await adapter.getStatus();
    expect(status.exists).toBe(true);
    expect(status.hooked).toBe(false);

    // Setup
    const setupRes = await adapter.setup({ port: 4000 });
    expect(setupRes.success).toBe(true);
    expect(fs.existsSync(`${configPath}.bak.ocr`)).toBe(true);

    status = await adapter.getStatus();
    expect(status.hooked).toBe(true);

    const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // opencode v2's native slot + shape: plural `providers`, `package`/`settings`
    expect(updated.providers['onecast-router'].settings.baseURL).toBe('http://127.0.0.1:4000/v1');
    expect(updated.providers['onecast-router'].package).toBe('@opencode/ai/providers/openai-compatible');
    expect(updated.provider).toBeUndefined(); // no legacy-slot twin is ever created
    expect(updated.model).toBe('onecast-router/auto');

    // Teardown
    const teardownRes = await adapter.teardown();
    expect(teardownRes.success).toBe(true);

    status = await adapter.getStatus();
    expect(status.hooked).toBe(false);

    const restored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(restored.model).toBe('anthropic/claude-sonnet-4');
    expect(restored.providers['onecast-router']).toBeUndefined();
  });

  it('OpenCode adapter must preserve JSONC comments on setup', async () => {
    const configPath = path.join(tmpDir, 'opencode.jsonc');
    fs.writeFileSync(
      configPath,
      [
        '{',
        '  // My personal OpenCode settings — do not reformat!',
        '  "model": "zhipuai-coding-plan/glm-5.3-flash",',
        '  "provider": {',
        '    // self-hosted gateway',
        '    "home-lab": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "http://192.168.1.10/v1" } }',
        '  }',
        '}',
      ].join('\n'),
      'utf8'
    );

    const adapter = new OpenCodeClientAdapter();
    adapter.getConfigPath = () => configPath;

    const setupRes = await adapter.setup({ port: 4000 });
    expect(setupRes.success).toBe(true);

    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('// My personal OpenCode settings');
    expect(raw).toContain('// self-hosted gateway');

    const parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
    // The user's own legacy-slot node survives untouched — OCR never rewrites content
    // it did not author, and opencode v2 still migrates it on read.
    expect(parsed.provider['home-lab'].options.baseURL).toBe('http://192.168.1.10/v1');
    // The router node itself goes to the native slot.
    expect(parsed.providers['onecast-router'].settings.baseURL).toBe('http://127.0.0.1:4000/v1');
    expect(parsed.provider['onecast-router']).toBeUndefined();
  });

  it('OpenCode adapter applies a model profile: per-agent overrides, exposed refs, sidecar echo, un-apply sweep', async () => {
    const configPath = path.join(tmpDir, 'opencode.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'anthropic/claude-sonnet-4' }, null, 2)
    );

    const adapter = new OpenCodeClientAdapter();
    adapter.getConfigPath = () => configPath;

    const setupRes = await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      agentModels: { general: 'auto-lite', explore: 'deepseek-v4-flash', build: 'auto', 'bad name': 'auto-lite' },
      profile: { id: 'prof1', bindings: { general: 'flash', explore: 'max', build: 'flash' } },
    });
    expect(setupRes.success).toBe(true);
    expect(setupRes.message).toContain('profile: prof1');

    // Fresh file (no agent node) → v2-native PLURAL `agents` home.
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(cfg.agents.general.model).toBe('onecast-router/auto-lite');
    expect(cfg.agents.explore.model).toBe('onecast-router/deepseek-v4-flash');
    // 'auto' refs inherit the default model (no override); invalid names are skipped.
    expect(cfg.agents.build?.model).toBeUndefined();
    expect(cfg.agents['bad name']).toBeUndefined();
    // Profile refs must be exposed in the provider model map — opencode validates
    // agent.<name>.model against it.
    expect(cfg.providers['onecast-router'].models['deepseek-v4-flash']).toBeDefined();

    let status = await adapter.getStatus();
    expect(status.profile?.id).toBe('prof1');
    expect(status.profile?.bindings.explore).toBe('max');

    // Un-apply (id ''): sweep router-owned overrides + clear the sidecar echo.
    const unapplyRes = await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      agentModels: {},
      profile: { id: '', bindings: {} },
    });
    expect(unapplyRes.success).toBe(true);

    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(after.agents.general.model).toBeUndefined();
    expect(after.agents.explore.model).toBeUndefined();
    expect(after.providers['onecast-router']).toBeDefined(); // still hooked

    status = await adapter.getStatus();
    expect(status.profile).toBeUndefined();
  });

  it('OpenCode agent writes always land in the v2 agents home; the singular ghost node is swept', async () => {
    const configPath = path.join(tmpDir, 'opencode.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          model: 'anthropic/claude-sonnet-4',
          // v2 file: plural home exists and wins…
          agents: { scout: { mode: 'subagent', model: 'anthropic/claude-haiku' } },
          // …while the retired singular node keeps a router-owned ghost (an older
          // build wrote it) plus the user's own non-router entry.
          agent: {
            general: { model: 'onecast-router/auto-lite' },
            keeper: { model: 'zhipuai/glm-5.3' },
          },
        },
        null,
        2
      )
    );

    const adapter = new OpenCodeClientAdapter();
    adapter.getConfigPath = () => configPath;

    const res = await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      agentModels: { scout: 'auto-lite' },
      profile: { id: 'p', bindings: { scout: 'flash' } },
    });
    expect(res.success).toBe(true);

    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // New binding goes to the plural home…
    expect(cfg.agents.scout.model).toBe('onecast-router/auto-lite');
    // …the legacy ghost is swept, and user-owned non-router values survive.
    expect(cfg.agent.general.model).toBeUndefined();
    expect(cfg.agent.keeper.model).toBe('zhipuai/glm-5.3');
  });

  it('OpenCode writes to the v2 agents home even when the config only has the singular v1 node', async () => {
    const configPath = path.join(tmpDir, 'opencode.json');
    // Legacy-only file: singular `agent` node, no plural home at all.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ model: 'anthropic/claude-sonnet-4', agent: { keeper: { model: 'zhipuai/glm-5.3' } } }, null, 2),
      'utf8'
    );
    const adapter = new OpenCodeClientAdapter();
    adapter.getConfigPath = () => configPath;

    const res = await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      agentModels: { scout: 'auto-lite' },
    });
    expect(res.success).toBe(true);

    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // The binding lands in the v2 home (never forks into the singular node)…
    expect(cfg.agents.scout.model).toBe('onecast-router/auto-lite');
    // …and the user's own singular-node entry survives untouched.
    expect(cfg.agent.keeper.model).toBe('zhipuai/glm-5.3');
  });

  it('OpenCode teardown sweeps every profile binding (no-backup surgical path) and clears the sidecar', async () => {
    const configPath = path.join(tmpDir, 'opencode.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'anthropic/claude-sonnet-4' }, null, 2)
    );

    const adapter = new OpenCodeClientAdapter();
    adapter.getConfigPath = () => configPath;

    await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      agentModels: { general: 'auto-lite', explore: 'glm-5.3' },
      profile: { id: 'prof1', bindings: { general: 'flash', explore: 'max' } },
    });
    // Force the surgical fallback path: drop the rolling backup.
    fs.rmSync(`${configPath}.bak.ocr`, { force: true });

    const teardownRes = await adapter.teardown();
    expect(teardownRes.success).toBe(true);

    const restored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(restored.providers['onecast-router']).toBeUndefined();
    expect(restored.agents?.general?.model).toBeUndefined();
    expect(restored.agents?.explore?.model).toBeUndefined();
    expect(restored.model).toBe('anthropic/claude-sonnet-4');

    const status = await adapter.getStatus();
    expect(status.profile).toBeUndefined();
  });

  it('OpenCode agent bindings apply standalone (no profile payload); the retired subagent slot is ignored', async () => {
    const configPath = path.join(tmpDir, 'opencode.json');
    fs.writeFileSync(configPath, JSON.stringify({ model: 'anthropic/claude-sonnet-4' }, null, 2));
    const adapter = new OpenCodeClientAdapter();
    adapter.getConfigPath = () => configPath;

    // Manual agent bindings without any profile payload — the agent node is
    // still swept + written (the console form is engaged). The retired
    // `models.subagent` key must NOT write anything.
    const res = await adapter.setup({
      port: 4000,
      models: { main: 'auto', subagent: 'auto-pro' },
      agentModels: { general: 'auto-lite' },
    });
    expect(res.success).toBe(true);
    let cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(cfg.agents.general.model).toBe('onecast-router/auto-lite');
    expect(Object.keys(cfg.agents)).toEqual(['general']); // retired subagent slot wrote nothing

    // Engaged-but-empty agent bindings ({}): sweep router-owned overrides only.
    await adapter.setup({ port: 4000, models: { main: 'auto' }, agentModels: {} });
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(cfg.agents?.general?.model).toBeUndefined();

    // Bare setup (CLI shape — no agent payloads) never touches the agent node.
    fs.writeFileSync(configPath, JSON.stringify({ model: 'x', agents: { keeper: { model: 'onecast-router/auto-plus' } } }, null, 2));
    await adapter.setup({ port: 4000, models: { main: 'auto' } });
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(cfg.agents.keeper.model).toBe('onecast-router/auto-plus');
  });

  it('refreshProfileBindings rewrites linked agents on profile change without a full setup', async () => {
    const configPath = path.join(tmpDir, 'opencode.json');
    fs.writeFileSync(configPath, JSON.stringify({ model: 'anthropic/claude-sonnet-4' }, null, 2));
    const adapter = new OpenCodeClientAdapter();
    adapter.getConfigPath = () => configPath;

    // Hook + link via a normal setup (sidecar echo records the slot tags).
    await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      agentModels: { scout: 'auto-lite' },
      profile: { id: 'p1', bindings: { scout: 'flash' } },
    });

    // The profile's 'flash' slot re-points → write-through updates the agent node.
    const res = await adapter.refreshProfileBindings('p1', { scout: 'flash' }, { flash: 'glm-5.3' });
    expect(res.success).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(cfg.agents.scout.model).toBe('onecast-router/glm-5.3');
    // The new ref is exposed in the provider models map — opencode validates
    // agent.<name>.model against it.
    expect(cfg.providers['onecast-router'].models['glm-5.3']).toBeDefined();
    expect((await adapter.getStatus()).profile?.bindings).toEqual({ scout: 'flash' });

    // A no-diff refresh writes nothing new (still hooked, values identical).
    const again = await adapter.refreshProfileBindings('p1', { scout: 'flash' }, { flash: 'glm-5.3' });
    expect(again.message).toContain('already up to date');

    // Slot removed from the profile → override swept (inherit the default model).
    const dropped = await adapter.refreshProfileBindings('p1', { scout: 'flash' }, {});
    expect(dropped.success).toBe(true);
    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(after.agents.scout.model).toBeUndefined();

    // Un-hooked config → refused, nothing written.
    fs.writeFileSync(configPath, JSON.stringify({ model: 'anthropic/claude-sonnet-4' }, null, 2));
    const unhooked = await adapter.refreshProfileBindings('p1', { scout: 'flash' }, { flash: 'glm-5.3' });
    expect(unhooked.success).toBe(false);
  });

  it('teardown restores the ORIGINAL model even after re-setup with a different main', async () => {
    const configPath = path.join(tmpDir, 'opencode.json');
    fs.writeFileSync(configPath, JSON.stringify({ model: 'anthropic/claude-sonnet-4' }, null, 2));
    const adapter = new OpenCodeClientAdapter();
    adapter.getConfigPath = () => configPath;

    await adapter.setup({ port: 4000, models: { main: 'auto' } });
    await adapter.setup({ port: 4000, models: { main: 'auto-pro' } }); // router value must not poison previousModel
    fs.rmSync(`${configPath}.bak.ocr`, { force: true }); // force the surgical path

    const res = await adapter.teardown();
    expect(res.success).toBe(true);
    const restored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(restored.model).toBe('anthropic/claude-sonnet-4'); // not router/auto-pro, not a zombie
  });

  it('listOpenCodeAgents merges built-ins, agent/*.md and the config node (config wins)', async () => {
    const configPath = path.join(tmpDir, 'opencode.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          agent: {
            scout: { mode: 'subagent', model: 'onecast-router/auto-lite' },
            build: { mode: 'primary' },
          },
        },
        null,
        2
      )
    );
    const agentDir = path.join(tmpDir, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'reviewer.md'),
      ['---', 'description: deep review', 'mode: subagent', 'model: anthropic/claude-opus', '---', '# body'].join('\n'),
      'utf8'
    );

    const agents = listOpenCodeAgents({ configPath, agentDir });
    const byName = Object.fromEntries(agents.map(a => [a.name, a]));

    expect(byName.general).toMatchObject({ mode: 'subagent', source: 'builtin' });
    expect(byName.reviewer).toMatchObject({ mode: 'subagent', source: 'file', model: 'anthropic/claude-opus' });
    expect(byName.scout).toMatchObject({ mode: 'subagent', source: 'config', model: 'auto-lite' }); // router prefix stripped
    expect(byName.build).toMatchObject({ mode: 'primary', source: 'config' });
  });

  it('listOpenCodeAgentsLive prefers the service roster and filters hidden internals', async () => {
    const stub = {
      isAvailable: () => true,
      getAgents: async () => [
        { id: 'build', name: 'Build', mode: 'primary', model: { providerID: 'alibaba', id: 'x' } }, // display name must NOT leak into the write key
        { id: 'explore', name: 'explore', mode: 'subagent', model: { providerID: 'onecast-router', id: 'auto-lite' } },
        { id: 'tech-writer', mode: 'subagent', model: { providerID: 'anthropic', id: 'claude-x' } },
        { id: 'compaction', mode: 'primary', hidden: true },
      ],
    };
    const agents = await listOpenCodeAgentsLive({ connector: stub as any, agentDir: path.join(tmpDir, 'missing'), configPath: path.join(tmpDir, 'missing.json') });
    expect(agents.map(a => a.name)).toEqual(['build', 'explore', 'tech-writer']);
    expect(agents[0]).toMatchObject({ mode: 'primary', source: 'service', model: 'alibaba/x' });
    expect(agents[1]).toMatchObject({ mode: 'subagent', source: 'service', model: 'auto-lite' }); // router prefix stripped
    expect(agents[2]!.model).toBe('anthropic/claude-x'); // native id reported verbatim
  });

  it('listOpenCodeAgentsLive falls back to the file scan when the service errors', async () => {
    const configPath = path.join(tmpDir, 'opencode.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ agents: { scout2: { mode: 'subagent', model: 'onecast-router/auto-pro' } } }, null, 2)
    );
    const stub = {
      isAvailable: () => true,
      getAgents: async () => {
        throw new Error('OpenCode agent fetch failed [401]');
      },
    };
    const agents = await listOpenCodeAgentsLive({ connector: stub as any, configPath, agentDir: path.join(tmpDir, 'missing') });
    expect(agents.find(a => a.name === 'scout2')).toMatchObject({ mode: 'subagent', source: 'config', model: 'auto-pro' });
    expect(agents.find(a => a.name === 'general')).toMatchObject({ source: 'builtin' });
  });

  it('Claude adapter should safely inject ANTHROPIC_BASE_URL and restore', async () => {
    const configPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(configPath, JSON.stringify({ env: { SOME_KEY: 'test' } }, null, 2));

    const adapter = new ClaudeClientAdapter();
    adapter.getConfigPath = () => configPath;

    let status = await adapter.getStatus();
    expect(status.hooked).toBe(false);

    // Setup
    const setupRes = await adapter.setup({ port: 4000 });
    expect(setupRes.success).toBe(true);
    expect(fs.existsSync(`${configPath}.bak.ocr`)).toBe(true);

    status = await adapter.getStatus();
    expect(status.hooked).toBe(true);

    const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(updated.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4000');

    // Teardown
    const teardownRes = await adapter.teardown();
    expect(teardownRes.success).toBe(true);

    status = await adapter.getStatus();
    expect(status.hooked).toBe(false);

    const restored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(restored.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(restored.env.SOME_KEY).toBe('test');
  });

  it('Codex adapter should safely redirect baseUrl and revert', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' }, null, 2));

    const adapter = new CodexClientAdapter();
    adapter.getConfigPath = () => configPath;

    let status = await adapter.getStatus();
    expect(status.hooked).toBe(false);

    const setupRes = await adapter.setup({ port: 4000 });
    expect(setupRes.success).toBe(true);

    status = await adapter.getStatus();
    expect(status.hooked).toBe(true);

    const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(updated.baseUrl).toBe('http://127.0.0.1:4000/v1');

    const teardownRes = await adapter.teardown();
    expect(teardownRes.success).toBe(true);

    status = await adapter.getStatus();
    expect(status.hooked).toBe(false);

    const restored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(restored.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('Pi adapter should inject its provider, preserve user providers, and revert', async () => {
    const configPath = path.join(tmpDir, 'models.json');
    fs.writeFileSync(configPath, JSON.stringify({ providers: { ollama: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', models: [{ id: 'llama3.1:8b' }] } } }, null, 2));

    const adapter = new PiClientAdapter();
    adapter.getConfigPath = () => configPath;

    let status = await adapter.getStatus();
    expect(status.hooked).toBe(false);

    const setupRes = await adapter.setup({ port: 4000, models: { main: 'auto-pro' }, apiKey: 'sk-test', extraModels: ['gpt-4o'] });
    expect(setupRes.success).toBe(true);
    expect(fs.existsSync(`${configPath}.bak.ocr`)).toBe(true);

    status = await adapter.getStatus();
    expect(status.hooked).toBe(true);
    expect(status.modelSlots[0].value).toBe('auto-pro');
    expect(status.extraModels).toEqual(['gpt-4o']);

    const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(updated.providers['onecast-router'].baseUrl).toBe('http://127.0.0.1:4000/v1');
    expect(updated.providers['onecast-router'].api).toBe('openai-completions');
    expect(updated.providers['onecast-router'].apiKey).toBe('sk-test');
    // The user's own providers must survive the hook.
    expect(updated.providers.ollama.baseUrl).toBe('http://localhost:11434/v1');

    const teardownRes = await adapter.teardown();
    expect(teardownRes.success).toBe(true);

    status = await adapter.getStatus();
    expect(status.hooked).toBe(false);

    const restored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(restored.providers['onecast-router']).toBeUndefined();
    expect(restored.providers.ollama.models[0].id).toBe('llama3.1:8b');
  });

  it('Pi adapter teardown after double-setup must leave the client fully unhooked (restore-then-strip)', async () => {
    const configPath = path.join(tmpDir, 'redouble.json');
    fs.writeFileSync(configPath, JSON.stringify({ providers: { ollama: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', models: [{ id: 'x' }] } } }, null, 2));

    const adapter = new PiClientAdapter();
    adapter.getConfigPath = () => configPath;

    await adapter.setup({ port: 4000, models: { main: 'auto' } });
    await adapter.setup({ port: 8000, models: { main: 'auto' } }); // e.g. port-change re-apply → backup now contains a hooked file

    const res = await adapter.teardown();
    expect(res.success).toBe(true);

    const status = await adapter.getStatus();
    expect(status.hooked).toBe(false);
    const restored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(restored.providers['onecast-router']).toBeUndefined();
    expect(restored.providers.ollama).toBeDefined();
  });

  it('Pi adapter should treat a LAN/manual hook entry as hooked (host-agnostic marker)', async () => {
    const configPath = path.join(tmpDir, 'lan.json');
    fs.writeFileSync(configPath, JSON.stringify({ providers: { 'onecast-router': { baseUrl: 'http://192.168.1.20:4000/v1', api: 'openai-completions', apiKey: 'sk-lan', models: [{ id: 'auto' }] } } }, null, 2));

    const adapter = new PiClientAdapter();
    adapter.getConfigPath = () => configPath;

    const status = await adapter.getStatus();
    expect(status.hooked).toBe(true);
    expect(status.modelSlots[0].value).toBe('auto');
  });

  it('Pi adapter teardown fallback should surgically remove only the OCR provider when no backup exists', async () => {
    const configPath = path.join(tmpDir, 'nobackup.json');
    fs.writeFileSync(configPath, JSON.stringify({ providers: { ollama: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', models: [{ id: 'x' }] }, mine: { baseUrl: 'https://api.mine.dev/v1', api: 'openai-completions', apiKey: 'k', models: [{ id: 'm' }] } } }, null, 2));

    const adapter = new PiClientAdapter();
    adapter.getConfigPath = () => configPath;

    await adapter.setup({ port: 4000 });
    fs.unlinkSync(`${configPath}.bak.ocr`); // simulate lost backup

    const res = await adapter.teardown();
    expect(res.success).toBe(true);

    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(data.providers['onecast-router']).toBeUndefined();
    expect(data.providers.ollama).toBeDefined();
    expect(data.providers.mine).toBeDefined();
    expect(await adapter.getStatus()).toMatchObject({ hooked: false });
  });

  it('Pi adapter should refuse setup on an unparseable models.json (no data loss)', async () => {
    const configPath = path.join(tmpDir, 'broken-models.json');
    fs.writeFileSync(configPath, '{ not json !');

    const adapter = new PiClientAdapter();
    adapter.getConfigPath = () => configPath;

    const res = await adapter.setup({ port: 4000 });
    expect(res.success).toBe(false);
    // The unreadable file must be left byte-for-byte intact.
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{ not json !');
  });

  it('Pi adapter should pin subagent tier overrides into settings.json and strip only its own on teardown', async () => {
    const configPath = path.join(tmpDir, 'models.json');
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(configPath, JSON.stringify({ providers: { ollama: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', models: [{ id: 'x' }] } } }, null, 2));
    fs.writeFileSync(settingsPath, JSON.stringify({
      theme: 'nvim-dark',
      subagents: { agentOverrides: { worker: { thinking: 'high' }, reviewer: { model: 'anthropic/claude-x' } } },
    }, null, 2));

    const adapter = new PiClientAdapter();
    adapter.getConfigPath = () => configPath; // settings.json derives from the same dir

    const setupRes = await adapter.setup({ port: 4000 });
    expect(setupRes.success).toBe(true);
    expect(setupRes.message).toContain('subagent');
    expect(fs.existsSync(`${settingsPath}.bak.ocr`)).toBe(true);

    const hooked = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(hooked.theme).toBe('nvim-dark'); // unrelated settings keys survive
    expect(hooked.subagents.agentOverrides.worker).toEqual({ thinking: 'high', model: 'onecast-router/auto-pro' });
    expect(hooked.subagents.agentOverrides.scout.model).toBe('onecast-router/auto-lite');
    expect(hooked.subagents.agentOverrides.oracle.model).toBe('onecast-router/auto-ultra');
    expect(hooked.subagents.agentOverrides.reviewer).toEqual({ model: 'anthropic/claude-x' }); // user-owned override untouched

    const status = await adapter.getStatus();
    expect(status.details).toContain('subagent role(s) pinned');

    const teardownRes = await adapter.teardown();
    expect(teardownRes.success).toBe(true);
    // Single-setup backup is the pristine original → restore alone returns the
    // pre-hook state; no router-owned residue to strip (contaminated-backup
    // stripping is covered by the fresh-install test below).
    expect(fs.existsSync(`${settingsPath}.bak.ocr`)).toBe(false);

    const restored = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(restored.theme).toBe('nvim-dark');
    expect(restored.subagents.agentOverrides.worker).toEqual({ thinking: 'high' }); // router model stripped, user field kept
    expect(restored.subagents.agentOverrides.reviewer).toEqual({ model: 'anthropic/claude-x' });
    expect(restored.subagents.agentOverrides.oracle).toBeUndefined(); // router-only role pruned
  });

  it('Pi adapter subagent overrides survive re-setup and vanish fully on teardown (fresh install)', async () => {
    const configPath = path.join(tmpDir, 'fresh.json');
    const settingsPath = path.join(tmpDir, 'settings.json'); // does not exist yet
    const adapter = new PiClientAdapter();
    adapter.getConfigPath = () => configPath;

    await adapter.setup({ port: 4000 });
    await adapter.setup({ port: 8000 }); // re-setup: the backup now contains pinned overrides

    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).subagents.agentOverrides.oracle.model).toBe('onecast-router/auto-ultra');

    const res = await adapter.teardown();
    expect(res.success).toBe(true);
    // Fresh-install settings file ends up empty → removed outright.
    expect(fs.existsSync(settingsPath)).toBe(false);
    expect((await adapter.getStatus()).details).not.toContain('subagent');
  });

  it('Pi adapter should skip the subagent mapping (and say so) when settings.json is unparseable', async () => {
    const configPath = path.join(tmpDir, 'models.json');
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(configPath, JSON.stringify({ providers: {} }, null, 2));
    fs.writeFileSync(settingsPath, '{ not json !');

    const adapter = new PiClientAdapter();
    adapter.getConfigPath = () => configPath;

    const res = await adapter.setup({ port: 4000 });
    expect(res.success).toBe(true); // models.json hook still applies
    expect(res.message).toContain('subagent tier mapping skipped');
    // The unreadable settings file must be left byte-for-byte intact.
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ not json !');
  });

  it('Pi adapter should apply explicit subagent slot picks and echo them back as model slots', async () => {
    const configPath = path.join(tmpDir, 'models.json');
    const settingsPath = path.join(tmpDir, 'settings.json');
    const adapter = new PiClientAdapter();
    adapter.getConfigPath = () => configPath;
    // Pre-existing manual pin on reviewer (non-router namespace).
    fs.writeFileSync(settingsPath, JSON.stringify({ subagents: { agentOverrides: { reviewer: { model: 'anthropic/claude-x' } } } }, null, 2));

    const res = await adapter.setup({
      port: 4000,
      models: { main: 'auto', scout: 'auto', oracle: 'glm-5.3', worker: 'my-worker', reviewer: 'anthropic/claude-x' },
    });
    expect(res.success).toBe(true);

    const hooked = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(hooked.subagents.agentOverrides.scout.model).toBe('onecast-router/auto'); // bare pick → qualified
    expect(hooked.subagents.agentOverrides.oracle.model).toBe('onecast-router/glm-5.3');
    expect(hooked.subagents.agentOverrides.worker.model).toBe('onecast-router/my-worker');
    // Unchanged echo of a manual non-router pin is left byte-identical.
    expect(hooked.subagents.agentOverrides.reviewer.model).toBe('anthropic/claude-x');
    // Roles absent from the payload get the router preset (fill-only-absent).
    expect(hooked.subagents.agentOverrides.researcher.model).toBe('onecast-router/auto-lite');

    const status = await adapter.getStatus();
    const byKey = Object.fromEntries(status.modelSlots.map(s => [s.key, s]));
    expect(byKey.main).toBeDefined();
    expect(byKey.scout).toMatchObject({ value: 'auto', default: 'auto-lite' });
    expect(byKey.oracle).toMatchObject({ value: 'glm-5.3', default: 'auto-ultra' });
    expect(byKey.researcher).toMatchObject({ value: 'auto-lite' });
    expect(byKey.reviewer).toMatchObject({ value: 'anthropic/claude-x' }); // foreign pin echoed verbatim

    // Payload-less re-setup: explicit concrete picks survive; preset-vocabulary
    // alias picks normalize to the current tier table.
    await adapter.setup({ port: 4000, models: { main: 'auto' } });
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).subagents.agentOverrides;
    expect(after.oracle.model).toBe('onecast-router/glm-5.3');
    expect(after.worker.model).toBe('onecast-router/my-worker');
    expect(after.reviewer.model).toBe('anthropic/claude-x');
    expect(after.researcher.model).toBe('onecast-router/auto-lite');
    expect(after.scout.model).toBe('onecast-router/auto-lite'); // alias pick normalized
  });

  it('Pi adapter should discover the subagent roster dynamically (package builtins + user agents, launchers skipped)', async () => {
    const configPath = path.join(tmpDir, 'models.json');
    const settingsPath = path.join(tmpDir, 'settings.json');
    const adapter = new PiClientAdapter();
    adapter.getConfigPath = () => configPath;
    // Fake an installed pi-subagents package: one real builtin + one external-CLI launcher.
    const pkgAgents = path.join(tmpDir, 'npm', 'node_modules', 'pi-subagents', 'agents');
    fs.mkdirSync(pkgAgents, { recursive: true });
    fs.writeFileSync(path.join(pkgAgents, 'scout.md'), '---\nname: scout\ndescription: recon\n---\nbody');
    fs.writeFileSync(path.join(pkgAgents, 'claude-code.md'), '---\nname: claude-code\nrunner:\n  type: external-cli\n---\nbody');
    // A custom user agent.
    const userAgents = path.join(tmpDir, 'agents');
    fs.mkdirSync(userAgents, { recursive: true });
    fs.writeFileSync(path.join(userAgents, 'custom-helper.md'), '---\nname: custom-helper\ndescription: mine\n---\nbody');

    const res = await adapter.setup({ port: 4000, models: { main: 'auto' } });
    expect(res.success).toBe(true);

    const overrides = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).subagents.agentOverrides;
    expect(overrides.scout.model).toBe('onecast-router/auto-lite'); // known role → preset tier
    expect(overrides['custom-helper'].model).toBe('onecast-router/auto'); // discovered custom → auto cascade
    expect(overrides['claude-code']).toBeUndefined(); // external-CLI launcher skipped
    expect(overrides.planner).toBeUndefined(); // preset-only role absent from a discoverable roster

    const status = await adapter.getStatus();
    const keys = status.modelSlots.map(s => s.key);
    expect(keys).toContain('main');
    expect(keys).toContain('scout');
    expect(keys).toContain('custom-helper');
    expect(keys).not.toContain('claude-code');
    expect(keys).not.toContain('planner');
  });

  it('Dsh adapter should create the web profile patch, hook, and remove cleanly on teardown', async () => {
    const profilesRoot = path.join(tmpDir, 'profiles'); // does not exist yet
    const webFile = path.join(profilesRoot, 'web', 'cordis.patch.yml');
    const adapter = new DshClientAdapter();
    adapter.getConfigPath = () => profilesRoot;

    let status = await adapter.getStatus();
    expect(status.exists).toBe(false);
    expect(status.hooked).toBe(false);

    const setupRes = await adapter.setup({ port: 4000, models: { main: 'auto-pro' }, apiKey: 'sk-test', extraModels: ['deepseek-v4-pro'] });
    expect(setupRes.success).toBe(true);
    expect(fs.existsSync(webFile)).toBe(true);

    status = await adapter.getStatus();
    expect(status.hooked).toBe(true);
    expect(status.modelSlots[0].value).toBe('auto-pro');
    expect(status.extraModels).toEqual(['deepseek-v4-pro']);

    const data = parseYaml(fs.readFileSync(webFile, 'utf8'));
    expect(Array.isArray(data)).toBe(true);
    const route = data[0].config.providers['onecast-router'];
    expect(route.baseURL).toBe('http://127.0.0.1:4000/v1');
    expect(route.api).toBe('openai-completions');
    expect(route.headers.Authorization).toBe('Bearer sk-test');
    // Fixed auto* alias block is injected after main (minus main itself), then the user's extras.
    expect(route.models.map((m: any) => m.id)).toEqual(['auto-pro', 'auto', 'auto-lite', 'auto-plus', 'auto-ultra', 'deepseek-v4-pro']);

    const teardownRes = await adapter.teardown();
    expect(teardownRes.success).toBe(true);
    expect((await adapter.getStatus()).hooked).toBe(false);
  });

  it('Dsh adapter should hook EVERY existing profile and preserve user entries in each', async () => {
    const profilesRoot = path.join(tmpDir, 'profiles');
    const desktopFile = path.join(profilesRoot, 'desktop', 'cordis.patch.yml');
    const webFile = path.join(profilesRoot, 'web', 'cordis.patch.yml');
    fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
    fs.mkdirSync(path.dirname(webFile), { recursive: true });
    fs.writeFileSync(desktopFile, [
      '- id: ui-theme',
      '  config:',
      '    preference: dark',
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      my-gateway:',
      '        api: openai-completions',
      '        baseURL: https://gw.example.com/v1',
      '        models:',
      '          - id: m1',
      '',
    ].join('\n'));
    fs.writeFileSync(webFile, '[]\n');

    const adapter = new DshClientAdapter();
    adapter.getConfigPath = () => profilesRoot;

    const res = await adapter.setup({ port: 4000, models: { main: 'auto' }, apiKey: 'sk-real' });
    expect(res.success).toBe(true);
    expect(res.message).toContain('desktop');
    expect(res.message).toContain('web');
    expect(fs.existsSync(`${desktopFile}.bak.ocr`)).toBe(true);

    const status = await adapter.getStatus();
    expect(status.hooked).toBe(true);
    expect(status.details).toContain('desktop');

    const desktop = parseYaml(fs.readFileSync(desktopFile, 'utf8'));
    const theme = desktop.find((e: any) => e.id === 'ui-theme');
    expect(theme.config.preference).toBe('dark'); // untouched user entry
    const entry = desktop.find((e: any) => e.id === 'llm-pi-ai');
    expect(Object.keys(entry.config.providers)).toContain('my-gateway'); // user provider preserved
    expect(entry.config.providers['onecast-router'].baseURL).toBe('http://127.0.0.1:4000/v1');
    expect(entry.config.providers['onecast-router'].headers.Authorization).toBe('Bearer sk-real');

    const web = parseYaml(fs.readFileSync(webFile, 'utf8'));
    expect(web[0].config.providers['onecast-router']).toBeDefined();

    const teardownRes = await adapter.teardown();
    expect(teardownRes.success).toBe(true);
    expect((await adapter.getStatus()).hooked).toBe(false);
    const desktopAfter = parseYaml(fs.readFileSync(desktopFile, 'utf8'));
    const entryAfter = desktopAfter.find((e: any) => e.id === 'llm-pi-ai');
    expect(entryAfter.config.providers['onecast-router']).toBeUndefined();
    expect(entryAfter.config.providers['my-gateway']).toBeDefined();
    expect(desktopAfter.find((e: any) => e.id === 'ui-theme')).toBeDefined();
  });

  it('Dsh adapter teardown after double-setup must leave the client fully unhooked (restore-then-strip)', async () => {
    const profilesRoot = path.join(tmpDir, 'profiles-double');
    const webFile = path.join(profilesRoot, 'web', 'cordis.patch.yml');
    const adapter = new DshClientAdapter();
    adapter.getConfigPath = () => profilesRoot;

    await adapter.setup({ port: 4000, models: { main: 'auto' } });
    await adapter.setup({ port: 8000, models: { main: 'auto' } }); // port-change re-apply → backup now contains a hooked file

    const res = await adapter.teardown();
    expect(res.success).toBe(true);
    expect((await adapter.getStatus()).hooked).toBe(false);
    const data = parseYaml(fs.readFileSync(webFile, 'utf8'));
    expect(data.find((e: any) => e?.config?.providers?.['onecast-router'])).toBeUndefined();
  });

  it('Dsh adapter should treat a LAN/name-selector manual hook entry as hooked (host-agnostic marker)', async () => {
    const profilesRoot = path.join(tmpDir, 'profiles-lan');
    const webFile = path.join(profilesRoot, 'web', 'cordis.patch.yml');
    fs.mkdirSync(path.dirname(webFile), { recursive: true });
    fs.writeFileSync(webFile, [
      `- name: '@deepseek-ai/dsh-llm-pi-ai'`,
      '  config:',
      '    providers:',
      '      onecast-router:',
      '        api: openai-completions',
      '        baseURL: http://192.168.1.20:4000/v1',
      '        models:',
      '          - id: auto',
      '',
    ].join('\n'));

    const adapter = new DshClientAdapter();
    adapter.getConfigPath = () => profilesRoot;

    const status = await adapter.getStatus();
    expect(status.hooked).toBe(true);
    expect(status.modelSlots[0].value).toBe('auto');
  });

  it('Dsh adapter should refuse setup on a non-array patch file (no data loss)', async () => {
    const profilesRoot = path.join(tmpDir, 'profiles-broken');
    const webFile = path.join(profilesRoot, 'web', 'cordis.patch.yml');
    fs.mkdirSync(path.dirname(webFile), { recursive: true });
    fs.writeFileSync(webFile, 'providers: not-an-array\n');

    const adapter = new DshClientAdapter();
    adapter.getConfigPath = () => profilesRoot;

    const res = await adapter.setup({ port: 4000 });
    expect(res.success).toBe(false);
    // The unreadable file must be left byte-for-byte intact.
    expect(fs.readFileSync(webFile, 'utf8')).toBe('providers: not-an-array\n');
  });
});

describe('Embedded UI & Management API Endpoints', () => {
  const dummyConfig: any = {
    port: 4000,
    host: '127.0.0.1',
    models: [],
    classifier: { localModel: false },
    rateLimit: { maxRequestsPerMinute: 1000 },
  };

  it('should serve HTML UI under /admin and redirect / to it', async () => {
    const { app } = createServer(dummyConfig, true);

    // `/` is an entry redirect to the console prefix, not a page.
    const resRoot = await app.inject({ method: 'GET', url: '/' });
    expect(resRoot.statusCode).toBe(301);
    expect(resRoot.headers.location).toBe('/admin/');

    const resAdmin = await app.inject({ method: 'GET', url: '/admin' });
    expect(resAdmin.statusCode).toBe(200);
    expect(resAdmin.headers['content-type']).toContain('text/html');
    expect(resAdmin.body).toContain('OneCastRouter');
    expect(resAdmin.body).toContain('Gateway Console');

    const resTiers = await app.inject({ method: 'GET', url: '/admin/tiers' });
    expect(resTiers.statusCode).toBe(200);
    expect(resTiers.headers['content-type']).toContain('text/html');

    const resProviders = await app.inject({ method: 'GET', url: '/admin/providers' });
    expect(resProviders.statusCode).toBe(200);
    expect(resProviders.headers['content-type']).toContain('text/html');
  });

  it('should return aggregated status on GET /api/admin/status', async () => {
    const { app } = createServer(dummyConfig, true);
    const res = await app.inject({ method: 'GET', url: '/api/admin/status' });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.status).toBe('ok');
    expect(json.metrics).toBeDefined();
    expect(json.circuitBreakers).toBeDefined();
    expect(Array.isArray(json.clients)).toBe(true);
    expect(json.clients.length).toBe(6);
  });

  it('should support reading and validating raw YAML config on /api/admin/config/raw', async () => {
    const { app } = createServer(dummyConfig, true);
    const resGet = await app.inject({ method: 'GET', url: '/api/admin/config/raw' });
    expect(resGet.statusCode).toBe(200);
    const json = JSON.parse(resGet.body);
    expect(json.status).toBe('ok');
    expect(json.yaml).toContain('port:');

    // Test saving invalid YAML
    const resInvalid = await app.inject({
      method: 'POST',
      url: '/api/admin/config/raw',
      payload: { yaml: 'invalid: : yaml: [' },
    });
    expect(resInvalid.statusCode).toBe(400);
  });

  it('should probe provider ping connectivity on /api/admin/providers/test', async () => {
    const { app } = createServer(dummyConfig, true);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/providers/test',
      payload: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-invalid-test-key' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('daemon spawn-args builders (env-switch must not inherit PORT/HOST)', () => {
  const prevPort = process.env.PORT;
  const prevHost = process.env.HOST;

  beforeEach(() => {
    process.env.PORT = '9999';
    process.env.HOST = '0.0.0.0';
  });
  afterEach(() => {
    if (prevPort === undefined) delete process.env.PORT;
    else process.env.PORT = prevPort;
    if (prevHost === undefined) delete process.env.HOST;
    else process.env.HOST = prevHost;
  });

  it('plain restart: PORT/HOST inherited AND pinned (byte-identical semantics)', () => {
    const env = buildGatewayChildEnv({ extraEnv: { PORT: '4000', HOST: '127.0.0.1' } });
    expect(env.PORT).toBe('4000');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.NODE_ENV).toBe('production');
    expect(env[RESTART_PARENT_ENV]).toBe(String(process.pid));
    const sets = buildWindowsEnvSets({ extraEnv: { PORT: '4000', HOST: '127.0.0.1' } });
    // no clear-prefix; RESTART → PORT → HOST → NODE_ENV order preserved
    expect(sets).toBe(
      `set "${RESTART_PARENT_ENV}=${process.pid}" && set "PORT=4000" && set "HOST=127.0.0.1" && set "NODE_ENV=production" && `
    );
  });

  it('env switch: inherited PORT/HOST DROPPED, only OCR_ENV injected', () => {
    const env = buildGatewayChildEnv({ extraEnv: { OCR_ENV: 'dev' }, omitPortHost: true });
    expect(env.PORT).toBeUndefined(); // the L3 P1-2 hole: previously inherited 9999
    expect(env.HOST).toBeUndefined();
    expect(env.OCR_ENV).toBe('dev');
    expect(env.NODE_ENV).toBe('production');
    expect(env[RESTART_PARENT_ENV]).toBe(String(process.pid));
  });

  it('env switch Windows: `set "PORT=" && set "HOST=" &&` clears precede the settings', () => {
    const sets = buildWindowsEnvSets({ extraEnv: { OCR_ENV: 'dev' }, omitPortHost: true });
    expect(sets.startsWith('set "PORT=" && set "HOST=" && ')).toBe(true);
    expect(sets).toContain(`set "${RESTART_PARENT_ENV}=${process.pid}" && `);
    expect(sets).toContain('set "OCR_ENV=dev" && ');
    expect(sets).toContain('set "NODE_ENV=production" && ');
    expect(sets).not.toMatch(/set "PORT=9999"/);
  });
});

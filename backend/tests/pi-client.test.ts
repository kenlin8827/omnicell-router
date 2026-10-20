import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PiClientAdapter } from '../src/cli/clients/pi.js';

/**
 * Pi adapter: profile-link layer (sidecar echo, write-through, unlink,
 * teardown sidecar cleanup). Each test gets a sandboxed config dir — the
 * adapter's settings path derives from getConfigPath, so overriding it
 * isolates both models.json and settings.json.
 */
describe('Pi client adapter — profile links', () => {
  let tmpDir: string;
  let configPath: string;
  let adapter: PiClientAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-pi-test-'));
    configPath = path.join(tmpDir, 'models.json');
    adapter = new PiClientAdapter();
    adapter.getConfigPath = () => configPath;
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf8'));

  it('setup applies linked + manual role bindings, records the sidecar echo, and presets never steal explicit roles', async () => {
    const res = await adapter.setup({
      port: 4000,
      models: { main: 'auto', worker: 'anthropic/claude-x' }, // worker: manual foreign pin
      agentModels: { scout: 'auto-lite' }, // scout: profile-linked (resolved)
      profile: { id: 'p1', bindings: { scout: 'flash' } },
    });
    expect(res.success).toBe(true);

    // The hook lands in models.json; the linked ref is exposed so pi can
    // resolve the override against the provider's declared ids.
    const cfg = readJson(configPath);
    expect(cfg.providers['onecast-router'].baseUrl).toBe('http://127.0.0.1:4000/v1');
    expect(cfg.providers['onecast-router'].models.some((m: any) => m.id === 'auto-lite')).toBe(true);

    // settings.json: the linked role is qualified, the manual foreign pin is
    // verbatim, and a preset role (researcher — discoverable roster is empty in
    // the sandbox, so the preset table applies) got its tier default.
    const settings = readJson(path.join(tmpDir, 'settings.json'));
    expect(settings.subagents.agentOverrides.scout.model).toBe('onecast-router/auto-lite');
    expect(settings.subagents.agentOverrides.worker.model).toBe('anthropic/claude-x');
    expect(settings.subagents.agentOverrides.researcher.model).toBe('onecast-router/auto-lite');

    // Sidecar echo (never settings.json — a running pi wipes foreign keys there).
    const meta = readJson(`${configPath}.ocr-meta.json`);
    expect(meta.profile).toEqual({ id: 'p1', bindings: { scout: 'flash' } });

    const status = await adapter.getStatus();
    expect(status.hooked).toBe(true);
    expect(status.profile?.id).toBe('p1');
    expect(status.profile?.bindings.scout).toBe('flash');
  });

  it('refreshProfileBindings re-points linked roles only and is a no-op when nothing changed', async () => {
    await adapter.setup({
      port: 4000,
      models: { main: 'auto', worker: 'anthropic/claude-x' },
      agentModels: { scout: 'auto-lite' },
      profile: { id: 'p1', bindings: { scout: 'flash' } },
    });

    const res = await adapter.refreshProfileBindings('p1', { scout: 'flash' }, { flash: 'qwen-max' });
    expect(res.success).toBe(true);
    const settings = readJson(path.join(tmpDir, 'settings.json'));
    expect(settings.subagents.agentOverrides.scout.model).toBe('onecast-router/qwen-max');
    // Manual foreign pin untouched by the write-through.
    expect(settings.subagents.agentOverrides.worker.model).toBe('anthropic/claude-x');
    // The new ref joined the provider models list.
    const cfg = readJson(configPath);
    expect(cfg.providers['onecast-router'].models.some((m: any) => m.id === 'qwen-max')).toBe(true);

    // No-diff save → explicit no-op (no settings rewrite).
    const again = await adapter.refreshProfileBindings('p1', { scout: 'flash' }, { flash: 'qwen-max' });
    expect(again.message).toContain('already up to date');
  });

  it("refreshProfileBindings treats an 'auto' slot ref as inherit and strips the override", async () => {
    await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      agentModels: { scout: 'auto-lite' },
      profile: { id: 'p1', bindings: { scout: 'flash' } },
    });

    const res = await adapter.refreshProfileBindings('p1', { scout: 'autoSlot' }, { autoSlot: 'auto' });
    expect(res.success).toBe(true);
    const settings = readJson(path.join(tmpDir, 'settings.json'));
    // The role had only the model field — the whole entry is pruned; no
    // literal onecast-router/auto pin is ever written.
    expect(settings.subagents.agentOverrides.scout).toBeUndefined();
    expect(JSON.stringify(settings)).not.toContain('onecast-router/auto"');
  });

  it("setup with profile id '' un-links: tagged roles fall back to presets, manual pins survive, echo clears", async () => {
    await adapter.setup({
      port: 4000,
      models: { main: 'auto', worker: 'anthropic/claude-x' },
      agentModels: { scout: 'auto-lite' },
      profile: { id: 'p1', bindings: { scout: 'flash' } },
    });

    const res = await adapter.setup({
      port: 4000,
      models: { main: 'auto', worker: 'anthropic/claude-x' },
      profile: { id: '', bindings: {} },
    });
    expect(res.success).toBe(true);

    const settings = readJson(path.join(tmpDir, 'settings.json'));
    // The linked role's override was stripped and the tier preset refilled it.
    expect(settings.subagents.agentOverrides.scout.model).toBe('onecast-router/auto-lite');
    // The manual foreign pin survived the un-link.
    expect(settings.subagents.agentOverrides.worker.model).toBe('anthropic/claude-x');

    const meta = readJson(`${configPath}.ocr-meta.json`);
    expect(meta.profile).toBeUndefined();
    expect((await adapter.getStatus()).profile).toBeUndefined();
  });

  it('teardown removes the sidecar along with the hook', async () => {
    await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      agentModels: { scout: 'auto-lite' },
      profile: { id: 'p1', bindings: { scout: 'flash' } },
    });
    expect(fs.existsSync(`${configPath}.ocr-meta.json`)).toBe(true);

    const res = await adapter.teardown();
    expect(res.success).toBe(true);
    expect(fs.existsSync(`${configPath}.ocr-meta.json`)).toBe(false);
    expect((await adapter.getStatus()).profile).toBeUndefined();
  });
});

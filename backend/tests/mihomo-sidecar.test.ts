import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import type { ProxyConfig } from '../src/config/types.js';
import type { MihomoChildLike } from '../src/proxy/mihomo-sidecar.js';
import {
  getMihomoStatus,
  mihomoLastErrorForTests,
  setMihomoSidecarDepsForTests,
  startMihomoSidecar,
  stopMihomoSidecar,
} from '../src/proxy/mihomo-sidecar.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mihomo-side-'));
}

function healthyChild(pid = 4242): MihomoChildLike {
  return { pid, on: () => {}, unref: () => {} };
}

const SECRET = 'sidecar-secret-do-not-log';

function baseProxy(over: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    enabled: true,
    mode: 'mihomo',
    mihomo: {
      mixedPort: 7890,
      controllerPort: 9090,
      controllerSecret: SECRET,
      selectedGroup: 'PROXY',
      subscriptions: [{ id: 'alpha', name: 'Alpha', url: 'https://sub.example/a?token=hide-me', enabled: true }],
    },
    ...over,
  };
}

describe('mihomo sidecar', () => {
  test('spawns mihomo with -d/-f, writes a config that keeps the secret out of the error log', async () => {
    const dir = tempDir();
    const spawned: Array<{ cmd: string; args: string[] }> = [];
    let probes = 0;
    const fetchImpl = (() => {
      probes += 1;
      if (probes === 1) return Promise.reject(new Error('connection refused'));
      return Promise.resolve(new Response(JSON.stringify({ version: 'v1.19.15' }), { status: 200 }));
    }) as typeof fetch;
    const result = await startMihomoSidecar({
      config: baseProxy(),
      workDir: dir,
      fetchImpl,
      readyTimeoutMs: 2000,
      pollIntervalMs: 10,
      persistSecret: () => {},
      binaryResolver: () => ({ path: '/opt/mihomo', source: 'configured' }),
      spawnImpl: (cmd, args) => {
        spawned.push({ cmd, args });
        return healthyChild();
      },
    });
    expect(result.ok).toBe(true);
    expect(result.action).toBe('start');
    expect(spawned[0].cmd).toBe('/opt/mihomo');
    expect(spawned[0].args[0]).toBe('-d');
    expect(spawned[0].args[2]).toBe('-f');
    expect(spawned[0].args.join(' ')).not.toContain(SECRET);
    const doc = parse(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')) as any;
    expect(doc.secret).toBe(SECRET);
    expect(doc['external-controller']).toBe('127.0.0.1:9090');
    expect(doc['proxy-providers'].alpha.url).toContain('token=hide-me');
    expect(JSON.stringify(mihomoLastErrorForTests())).not.toContain(SECRET);
    expect(JSON.stringify(mihomoLastErrorForTests())).not.toContain('hide-me');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('re-selects the remembered node as soon as the group lists it', async () => {
    const dir = tempDir();
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const fetchImpl = (async (input: any, init?: any) => {
      const url = String(input);
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body });
      if (url.endsWith('/version')) return new Response(JSON.stringify({ version: 'v1' }), { status: 200 });
      if (url.endsWith('/proxies')) {
        return new Response(JSON.stringify({
          proxies: { PROXY: { name: 'PROXY', type: 'Selector', now: 'node-a', all: ['node-a', 'node-b'] } },
        }), { status: 200 });
      }
      if (url.endsWith('/proxies/PROXY') && init?.method === 'PUT') return new Response(null, { status: 204 });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const config = baseProxy();
    config.mihomo = { ...config.mihomo, selectedNodes: { PROXY: 'node-b' } };

    const started = await startMihomoSidecar({
      config,
      workDir: dir,
      fetchImpl,
      persistSecret: () => {},
      binaryResolver: () => ({ path: '/opt/mihomo', source: 'configured' }),
      spawnImpl: () => healthyChild(),
    });
    expect(started.ok).toBe(true);
    const selection = calls.find((call) => call.method === 'PUT' && call.url.endsWith('/proxies/PROXY'));
    expect(selection?.body).toBe(JSON.stringify({ name: 'node-b' }));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an automatic group is never pinned to the remembered pick', async () => {
    const dir = tempDir();
    const calls: Array<{ method: string; url: string }> = [];
    const fetchImpl = (async (input: any, init?: any) => {
      const url = String(input);
      calls.push({ method: init?.method ?? 'GET', url });
      if (url.endsWith('/proxies')) {
        return new Response(JSON.stringify({
          proxies: { PROXY: { name: 'PROXY', type: 'URLTest', now: 'node-a', all: ['node-a', 'node-b'] } },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ version: 'v1' }), { status: 200 });
    }) as typeof fetch;
    const config = baseProxy();
    config.mihomo = { ...config.mihomo, groupType: 'url-test', selectedNodes: { PROXY: 'node-b' } };

    const started = await startMihomoSidecar({
      config,
      workDir: dir,
      fetchImpl,
      persistSecret: () => {},
      binaryResolver: () => ({ path: null, source: null }),
      spawnImpl: () => healthyChild(),
    });
    expect(started.ok).toBe(true);
    // PUT /proxies/{group} is mihomo's Set — a PIN that outranks the group's own
    // delay ordering while the node stays alive, i.e. it would freeze the
    // auto-switch this group type exists for.
    expect(calls.some((call) => call.method === 'PUT' && call.url.endsWith('/proxies/PROXY'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('adopts a healthy controller without spawning', async () => {
    const dir = tempDir();
    let spawned = false;
    const fetchImpl = (() => Promise.resolve(new Response(JSON.stringify({ version: 'v9' }), { status: 200 }))) as typeof fetch;
    const first = await startMihomoSidecar({
      config: baseProxy(),
      workDir: dir,
      fetchImpl,
      persistSecret: () => {},
      binaryResolver: () => ({ path: null, source: null }),
      spawnImpl: () => {
        spawned = true;
        return healthyChild();
      },
    });
    expect(first.ok).toBe(true);
    expect(first.action).toBe('reload');
    const result = await startMihomoSidecar({
      config: baseProxy(),
      workDir: dir,
      fetchImpl,
      persistSecret: () => {},
      binaryResolver: () => ({ path: null, source: null }),
      spawnImpl: () => {
        spawned = true;
        return healthyChild();
      },
    });
    expect(result.ok).toBe(true);
    expect(result.action).toBe('adopt');
    expect(result.version).toBe('v9');
    expect(spawned).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('refuses to start under the legacy rule (no autoStart, mode manual) and reports a missing binary', async () => {
    // `autoStart` absent means "follow the mode", so this stays a refusal —
    // the pre-split behaviour existing configs rely on.
    const manual = await startMihomoSidecar({
      config: { enabled: true, mode: 'manual', url: 'http://127.0.0.1:7890' },
      workDir: tempDir(),
      persistSecret: () => {},
    });
    expect(manual.ok).toBe(false);
    expect(manual.code).toBe('disabled');

    const missing = await startMihomoSidecar({
      config: baseProxy(),
      workDir: tempDir(),
      fetchImpl: (() => Promise.reject(new Error('down'))) as typeof fetch,
      readyTimeoutMs: 50,
      pollIntervalMs: 10,
      persistSecret: () => {},
      binaryResolver: () => ({ path: null, source: null }),
    });
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe('binary-missing');
    expect(missing.error || '').not.toContain(SECRET);
  });

  test('runs the core on its own while outbound stays manual (autoStart overrides the mode)', async () => {
    // The whole point of the split: outbound is direct, the core is still ours.
    const proxy = baseProxy();
    const result = await startMihomoSidecar({
      config: {
        ...proxy,
        enabled: false,
        mode: 'manual',
        url: 'http://127.0.0.1:7890',
        mihomo: { ...(proxy.mihomo ?? {}), autoStart: true },
      },
      workDir: tempDir(),
      fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({ version: 'v9' }), { status: 200 }))) as typeof fetch,
      persistSecret: () => {},
      binaryResolver: () => ({ path: null, source: null }),
    });
    expect(result.ok).toBe(true);
    expect(result.reused).toBe(true);
  });

  test('honours an explicit autoStart: false even in mihomo mode', async () => {
    // Stopped by hand must not be "fixed" by an unrelated config save.
    const proxy = baseProxy();
    const result = await startMihomoSidecar({
      config: { ...proxy, mihomo: { ...(proxy.mihomo ?? {}), autoStart: false } },
      workDir: tempDir(),
      persistSecret: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('disabled');
  });

  test('stop kills the recorded pid', async () => {
    const dir = tempDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mihomo.pid'), '5151');
    fs.writeFileSync(path.join(dir, 'owner'), 'spawned');
    const killed: number[] = [];
    const result = await stopMihomoSidecar({
      config: baseProxy(),
      workDir: dir,
      killTreeImpl: (pid) => {
        killed.push(pid);
        return true;
      },
      // The recorded pid is not a live process; pretend the kill path still
      // runs by making the status probe fail so we only use the pid file when
      // pidAlive says no. A dead pid falls through to a no-op unless the
      // controller is up. Drive the controller-up + discovered-pid path.
      fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({ version: 'v1' }), { status: 200 }))) as typeof fetch,
      pidByPortImpl: () => 5151,
    });
    expect(result.ok).toBe(true);
    expect(killed).toEqual([5151]);
    expect(fs.existsSync(path.join(dir, 'mihomo.pid'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('status reports installed and secretConfigured without returning the secret', async () => {
    const dir = tempDir();
    const bin = path.join(dir, 'mihomo');
    fs.writeFileSync(bin, '');
    const status = await getMihomoStatus({
      config: baseProxy({ mihomo: { ...baseProxy().mihomo, binaryPath: bin } }),
      workDir: dir,
      fetchImpl: (() => Promise.reject(new Error('down'))) as typeof fetch,
      binaryResolver: () => ({ path: bin, source: 'configured' }),
    });
    expect(status.installed).toBe(true);
    expect(status.secretConfigured).toBe(true);
    expect(status.running).toBe(false);
    expect(JSON.stringify(status)).not.toContain(SECRET);
    setMihomoSidecarDepsForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

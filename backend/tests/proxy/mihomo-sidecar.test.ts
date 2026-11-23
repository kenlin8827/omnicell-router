import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import type { ProxyConfig } from '../../src/config/types.js';
import type { MihomoChildLike } from '../../src/proxy/mihomo-sidecar.js';
import { clearMihomoCoreLogs, mihomoCoreLogs } from '../../src/proxy/mihomo-logs.js';
import {
  getMihomoStatus,
  mihomoLastErrorForTests,
  mihomoWorkDir,
  setMihomoSidecarDepsForTests,
  startMihomoSidecar,
  stopMihomoSidecar,
  stopSpawnedMihomoSync,
} from '../../src/proxy/mihomo-sidecar.js';

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

  test('captures the core\'s piped output into the shared log ring', async () => {
    clearMihomoCoreLogs();
    const dir = tempDir();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    let probes = 0;
    const fetchImpl = (() => {
      probes += 1;
      if (probes === 1) return Promise.reject(new Error('connection refused'));
      return Promise.resolve(new Response(JSON.stringify({ version: 'v1' }), { status: 200 }));
    }) as typeof fetch;
    const child: MihomoChildLike = { pid: 777, on: () => {}, unref: () => {}, stdout, stderr };
    const started = await startMihomoSidecar({
      config: baseProxy(),
      workDir: dir,
      fetchImpl,
      readyTimeoutMs: 2000,
      pollIntervalMs: 10,
      persistSecret: () => {},
      binaryResolver: () => ({ path: '/opt/mihomo', source: 'configured' }),
      spawnImpl: () => child,
    });
    expect(started.ok).toBe(true);
    stdout.emit('data', 'level=warning msg="provider fetch failed"\npartial');
    stderr.emit('data', '\u001b[31mlevel=error boom\u001b[0m\n');
    stdout.emit('data', ' line-done\n');
    const lines = mihomoCoreLogs();
    // The spawn marker is the ring's first row, so a restart is legible in a
    // pane that also holds the previous process's last words.
    expect(lines[0]).toMatchObject({ stream: 'gateway', text: 'core process started (pid 777)' });
    const texts = lines.map((line) => line.text);
    expect(texts).toContain('level=warning msg="provider fetch failed"');
    // ANSI colour codes never reach the console.
    expect(texts).toContain('level=error boom');
    // A partial line is held until its newline arrives.
    expect(texts).toContain('partial line-done');
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

  test('a geo rule list stops the start before spawning while the databases are missing', async () => {
    const dir = tempDir();
    const proxy = baseProxy();
    proxy.mihomo!.rules = [{ type: 'GEOIP', payload: 'CN', target: 'DIRECT' }];
    let spawned = 0;
    const refused = await startMihomoSidecar({
      config: proxy,
      workDir: dir,
      fetchImpl: (() => Promise.resolve(new Response('{}', { status: 200 }))) as typeof fetch,
      readyTimeoutMs: 1000,
      pollIntervalMs: 10,
      persistSecret: () => {},
      binaryResolver: () => ({ path: '/opt/mihomo', source: 'configured' }),
      spawnImpl: () => {
        spawned += 1;
        return healthyChild();
      },
    });
    // The core would exit fatally mid-download; the start answers a code the
    // console can explain instead, and no process is ever created.
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('geo-missing');
    expect(spawned).toBe(0);

    // With both databases installed the same list starts normally.
    fs.writeFileSync(path.join(dir, 'geoip.metadb'), 'stub');
    fs.writeFileSync(path.join(dir, 'GeoSite.dat'), 'stub');
    let probes = 0;
    const healthy = await startMihomoSidecar({
      config: proxy,
      workDir: dir,
      fetchImpl: (() => {
        probes += 1;
        if (probes === 1) return Promise.reject(new Error('connection refused'));
        return Promise.resolve(new Response(JSON.stringify({ version: 'v1' }), { status: 200 }));
      }) as typeof fetch,
      readyTimeoutMs: 2000,
      pollIntervalMs: 10,
      persistSecret: () => {},
      binaryResolver: () => ({ path: '/opt/mihomo', source: 'configured' }),
      spawnImpl: () => healthyChild(),
    });
    expect(healthy.ok).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
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

  test('a core that never becomes ready is reaped, and its bind refusal reads as port-in-use', async () => {
    setMihomoSidecarDepsForTests(null);
    const dir = tempDir();
    const stdout = new EventEmitter();
    const killed: number[] = [];
    const child: MihomoChildLike = { pid: 6111, on: () => {}, unref: () => {}, stdout, stderr: new EventEmitter() };
    const pending = startMihomoSidecar({
      config: baseProxy(),
      workDir: dir,
      fetchImpl: (() => Promise.reject(new Error('down'))) as typeof fetch,
      readyTimeoutMs: 120,
      pollIntervalMs: 20,
      persistSecret: () => {},
      binaryResolver: () => ({ path: '/opt/mihomo', source: 'configured' }),
      spawnImpl: () => child,
      killTreeImpl: (pid) => {
        killed.push(pid);
        return true;
      },
      pidByPortImpl: () => null,
    });
    setTimeout(() => stdout.emit('data', 'listen tcp 127.0.0.1:7890: bind: Only one usage of each socket address\n'), 10);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.code).toBe('port-in-use');
    expect(result.error).toContain('127.0.0.1:7890');
    // The failed attempt must not leak the process it just spawned.
    expect(killed).toEqual([6111]);
    expect(fs.existsSync(path.join(dir, 'mihomo.pid'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'owner'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a silent start failure reaps the child and reports not-ready', async () => {
    setMihomoSidecarDepsForTests(null);
    const dir = tempDir();
    const killed: number[] = [];
    const result = await startMihomoSidecar({
      config: baseProxy(),
      workDir: dir,
      fetchImpl: (() => Promise.reject(new Error('down'))) as typeof fetch,
      readyTimeoutMs: 80,
      pollIntervalMs: 10,
      persistSecret: () => {},
      binaryResolver: () => ({ path: '/opt/mihomo', source: 'configured' }),
      spawnImpl: () => healthyChild(6112),
      killTreeImpl: (pid) => {
        killed.push(pid);
        return true;
      },
      pidByPortImpl: () => null,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('not-ready');
    expect(killed).toEqual([6112]);
    expect(fs.existsSync(path.join(dir, 'mihomo.pid'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reaps a recorded core that holds neither port before spawning a replacement', async () => {
    setMihomoSidecarDepsForTests(null);
    const dir = tempDir();
    fs.mkdirSync(dir, { recursive: true });
    // A live pid is required so the self-heal branch runs; this test's own
    // process is the only pid guaranteed to exist.
    fs.writeFileSync(path.join(dir, 'mihomo.pid'), String(process.pid));
    fs.writeFileSync(path.join(dir, 'owner'), 'spawned');
    const killed: number[] = [];
    let probes = 0;
    const fetchImpl = (() => {
      probes += 1;
      if (probes === 1) return Promise.reject(new Error('down'));
      return Promise.resolve(new Response(JSON.stringify({ version: 'v1' }), { status: 200 }));
    }) as typeof fetch;
    const result = await startMihomoSidecar({
      config: baseProxy(),
      workDir: dir,
      fetchImpl,
      readyTimeoutMs: 2000,
      pollIntervalMs: 10,
      persistSecret: () => {},
      binaryResolver: () => ({ path: '/opt/mihomo', source: 'configured' }),
      spawnImpl: () => healthyChild(5151),
      killTreeImpl: (pid) => {
        killed.push(pid);
        return true;
      },
      pidByPortImpl: () => null,
    });
    expect(result.ok).toBe(true);
    expect(killed).toEqual([process.pid]);
    expect(fs.readFileSync(path.join(dir, 'mihomo.pid'), 'utf8')).toBe('5151');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('never reaps an operator core, even when it holds no port', async () => {
    setMihomoSidecarDepsForTests(null);
    const dir = tempDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mihomo.pid'), String(process.pid));
    fs.writeFileSync(path.join(dir, 'owner'), 'adopted');
    const killed: number[] = [];
    let probes = 0;
    const fetchImpl = (() => {
      probes += 1;
      if (probes === 1) return Promise.reject(new Error('down'));
      return Promise.resolve(new Response(JSON.stringify({ version: 'v1' }), { status: 200 }));
    }) as typeof fetch;
    const result = await startMihomoSidecar({
      config: baseProxy(),
      workDir: dir,
      fetchImpl,
      readyTimeoutMs: 2000,
      pollIntervalMs: 10,
      persistSecret: () => {},
      binaryResolver: () => ({ path: '/opt/mihomo', source: 'configured' }),
      spawnImpl: () => healthyChild(5152),
      killTreeImpl: (pid) => {
        killed.push(pid);
        return true;
      },
      pidByPortImpl: () => null,
    });
    expect(result.ok).toBe(true);
    expect(killed).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('takes ownership of an orphan it spawned before, and the exit teardown kills only that', async () => {
    setMihomoSidecarDepsForTests(null);
    const dir = tempDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mihomo.pid'), String(process.pid));
    fs.writeFileSync(path.join(dir, 'owner'), 'spawned');
    const adopted = await startMihomoSidecar({
      config: baseProxy(),
      workDir: dir,
      fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({ version: 'v9' }), { status: 200 }))) as typeof fetch,
      persistSecret: () => {},
      binaryResolver: () => ({ path: null, source: null }),
      spawnImpl: () => {
        throw new Error('must not spawn over a live controller');
      },
    });
    expect(adopted.ok).toBe(true);
    const killed: number[] = [];
    stopSpawnedMihomoSync((pid) => {
      killed.push(pid);
      return true;
    });
    expect(killed).toEqual([process.pid]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('never kills an operator core it merely adopted', async () => {
    setMihomoSidecarDepsForTests(null);
    const dir = tempDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mihomo.pid'), String(process.pid));
    fs.writeFileSync(path.join(dir, 'owner'), 'adopted');
    const adopted = await startMihomoSidecar({
      config: baseProxy(),
      workDir: dir,
      fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({ version: 'v9' }), { status: 200 }))) as typeof fetch,
      persistSecret: () => {},
      binaryResolver: () => ({ path: null, source: null }),
    });
    expect(adopted.ok).toBe(true);
    const killed: number[] = [];
    stopSpawnedMihomoSync((pid) => {
      killed.push(pid);
      return true;
    });
    expect(killed).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a core that exits on its own leaves no markers behind', async () => {
    setMihomoSidecarDepsForTests(null);
    const dir = tempDir();
    const handlers = new Map<string, (...args: any[]) => void>();
    const stdout = new EventEmitter();
    let probes = 0;
    const fetchImpl = (() => {
      probes += 1;
      if (probes === 1) return Promise.reject(new Error('down'));
      return Promise.resolve(new Response(JSON.stringify({ version: 'v1' }), { status: 200 }));
    }) as typeof fetch;
    const started = await startMihomoSidecar({
      config: baseProxy(),
      workDir: dir,
      fetchImpl,
      readyTimeoutMs: 2000,
      pollIntervalMs: 10,
      persistSecret: () => {},
      binaryResolver: () => ({ path: '/opt/mihomo', source: 'configured' }),
      spawnImpl: () => ({
        pid: 6333,
        on: (event, listener) => {
          handlers.set(event, listener);
        },
        unref: () => {},
        stdout,
        stderr: new EventEmitter(),
      }),
    });
    expect(started.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, 'mihomo.pid'))).toBe(true);
    handlers.get('exit')?.(0, null);
    expect(fs.existsSync(path.join(dir, 'mihomo.pid'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'owner'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a failed kill keeps the child\'s markers so the next start can find it', async () => {
    setMihomoSidecarDepsForTests(null);
    const dir = tempDir();
    const result = await startMihomoSidecar({
      config: baseProxy(),
      workDir: dir,
      fetchImpl: (() => Promise.reject(new Error('down'))) as typeof fetch,
      readyTimeoutMs: 80,
      pollIntervalMs: 10,
      persistSecret: () => {},
      binaryResolver: () => ({ path: '/opt/mihomo', source: 'configured' }),
      spawnImpl: () => healthyChild(6113),
      // Access denied / taskkill refused: the process is still alive.
      killTreeImpl: () => false,
      pidByPortImpl: () => null,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('not-ready');
    expect(fs.readFileSync(path.join(dir, 'mihomo.pid'), 'utf8')).toBe('6113');
    expect(fs.readFileSync(path.join(dir, 'owner'), 'utf8')).toBe('spawned');
    setMihomoSidecarDepsForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the exit teardown refuses a pid the markers no longer name', async () => {
    setMihomoSidecarDepsForTests(null);
    const dir = tempDir();
    let probes = 0;
    const fetchImpl = (() => {
      probes += 1;
      if (probes === 1) return Promise.reject(new Error('down'));
      return Promise.resolve(new Response(JSON.stringify({ version: 'v1' }), { status: 200 }));
    }) as typeof fetch;
    const started = await startMihomoSidecar({
      config: baseProxy(),
      workDir: dir,
      fetchImpl,
      readyTimeoutMs: 2000,
      pollIntervalMs: 10,
      persistSecret: () => {},
      binaryResolver: () => ({ path: '/opt/mihomo', source: 'configured' }),
      spawnImpl: () => healthyChild(6444),
    });
    expect(started.ok).toBe(true);
    // The default work dir is what the exit hook reads; a marker there naming a
    // different pid means ownership moved on (or the pid was reused).
    const markerDir = mihomoWorkDir();
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, 'mihomo.pid'), '4242');
    fs.writeFileSync(path.join(markerDir, 'owner'), 'spawned');
    const killed: number[] = [];
    stopSpawnedMihomoSync((pid) => {
      killed.push(pid);
      return true;
    });
    expect(killed).toEqual([]);
    fs.rmSync(path.join(markerDir, 'mihomo.pid'), { force: true });
    fs.rmSync(path.join(markerDir, 'owner'), { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('stale spawned markers beside a dead pid are rewritten to adopted on adoption', async () => {
    setMihomoSidecarDepsForTests(null);
    const dir = tempDir();
    fs.mkdirSync(dir, { recursive: true });
    // A pid that cannot exist: the live core behind the controller is not the
    // one the marker recorded, i.e. an operator's core.
    fs.writeFileSync(path.join(dir, 'mihomo.pid'), '2147483647');
    fs.writeFileSync(path.join(dir, 'owner'), 'spawned');
    const adopted = await startMihomoSidecar({
      config: baseProxy(),
      workDir: dir,
      fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({ version: 'v9' }), { status: 200 }))) as typeof fetch,
      persistSecret: () => {},
      binaryResolver: () => ({ path: null, source: null }),
      spawnImpl: () => {
        throw new Error('must not spawn over a live controller');
      },
    });
    expect(adopted.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'owner'), 'utf8')).toBe('adopted');
    const killed: number[] = [];
    stopSpawnedMihomoSync((pid) => {
      killed.push(pid);
      return true;
    });
    expect(killed).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
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

/**
 * headroom sidecar lifecycle state machine — pure injected-deps tests.
 * No real processes, ports or /health endpoints are touched: fetch, spawn,
 * kill and the pid-file path are all injected. Runs in the isolated runner
 * (per-file OCR_HOME sandbox) like every other suite here.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HeadroomChildLike,
  isLoopbackUrl,
  startHeadroomSidecar,
  stopHeadroomSidecar,
  getHeadroomSidecarStatus,
} from '../src/compression/headroom-sidecar.js';

function tempPidFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headroom-sidecar-'));
  return path.join(dir, 'headroom.pid');
}

function okFetch(version = '0.5.21'): typeof fetch {
  return ((_input: any, _init?: any) => Promise.resolve(new Response(JSON.stringify({ status: 'healthy', version }), { status: 200 }))) as typeof fetch;
}

function failFetch(): typeof fetch {
  return ((_input: any, _init?: any) => Promise.reject(new Error('connection refused'))) as typeof fetch;
}

function countingFetch(failFirst: number, version = '0.5.21'): { impl: typeof fetch; calls: () => number } {
  let n = 0;
  const impl = ((_input: any, _init?: any) => {
    n += 1;
    if (n <= failFirst) return Promise.reject(new Error('not yet'));
    return Promise.resolve(new Response(JSON.stringify({ status: 'healthy', version }), { status: 200 }));
  }) as typeof fetch;
  return { impl, calls: () => n };
}

/** Child stub whose 'error' listener is invoked synchronously on register. */
function failingChild(err: Error): HeadroomChildLike {
  return {
    pid: 4242,
    on: (_event, listener) => listener(err),
    unref: () => {},
  };
}

function healthyChild(pid = 4242): HeadroomChildLike {
  return { pid, on: () => {}, unref: () => {} };
}

const LOOPBACK = 'http://127.0.0.1:8787';
const FAST = { readyTimeoutMs: 2000, pollIntervalMs: 10 };

// ── isLoopbackUrl ────────────────────────────────────────────────────────────

describe('isLoopbackUrl', () => {
  test('accepts loopback spellings', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8787')).toBe(true);
    expect(isLoopbackUrl('http://localhost:8787')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8787')).toBe(true);
  });

  test('rejects remote hosts and garbage', () => {
    expect(isLoopbackUrl('http://192.168.1.5:8787')).toBe(false);
    expect(isLoopbackUrl('http://example.com:8787')).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });
});

// ── startHeadroomSidecar ─────────────────────────────────────────────────────

describe('startHeadroomSidecar', () => {
  test('adopts an already-running sidecar without spawning', async () => {
    let spawned = false;
    const r = await startHeadroomSidecar(
      { url: LOOPBACK },
      { fetchImpl: okFetch('1.2.3'), spawnImpl: () => { spawned = true; return healthyChild(); }, pidFilePath: tempPidFile() }
    );
    expect(r.ok).toBe(true);
    expect(r.reused).toBe(true);
    expect(r.version).toBe('1.2.3');
    expect(r.code).toBeNull();
    expect(spawned).toBe(false);
  });

  test('spawns detached and records the pid once /health answers', async () => {
    const { impl, calls } = countingFetch(2);
    const pidPath = tempPidFile();
    const spawnedArgs: { cmd: string; args: string[] }[] = [];
    const r = await startHeadroomSidecar(
      { url: LOOPBACK, ...FAST },
      {
        fetchImpl: impl,
        spawnImpl: (cmd, args) => {
          spawnedArgs.push({ cmd, args });
          return healthyChild(4242);
        },
        pidFilePath: pidPath,
      }
    );
    expect(r.ok).toBe(true);
    expect(r.reused).toBe(false);
    expect(r.pid).toBe(4242);
    expect(calls()).toBeGreaterThanOrEqual(3);
    expect(spawnedArgs[0]?.cmd).toBe('headroom');
    expect(spawnedArgs[0]?.args).toEqual(['proxy', '--host', '127.0.0.1', '--port', '8787', '--mode', 'cache']);
    expect(fs.readFileSync(pidPath, 'utf8')).toBe('4242');
  });

  test('reports an install hint when the CLI is missing (ENOENT)', async () => {
    const r = await startHeadroomSidecar(
      { url: LOOPBACK },
      {
        fetchImpl: failFetch(),
        spawnImpl: () => failingChild(Object.assign(new Error('spawn headroom ENOENT'), { code: 'ENOENT' })),
        pidFilePath: tempPidFile(),
      }
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('spawn-exited');
    expect(r.error).toContain('pip install');
  });

  test('refuses non-loopback URLs before any spawn', async () => {
    let spawned = false;
    const r = await startHeadroomSidecar(
      { url: 'http://192.168.1.5:8787' },
      { fetchImpl: failFetch(), spawnImpl: () => { spawned = true; return healthyChild(); }, pidFilePath: tempPidFile() }
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('not-loopback');
    expect(r.error).toContain('loopback');
    expect(spawned).toBe(false);
  });

  test('fails honestly when the sidecar never becomes ready (no retry loop)', async () => {
    const r = await startHeadroomSidecar(
      { url: LOOPBACK, readyTimeoutMs: 60, pollIntervalMs: 10 },
      { fetchImpl: failFetch(), spawnImpl: () => healthyChild(4242), pidFilePath: tempPidFile() }
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('not-ready');
    expect(r.error).toContain('did not become ready');
  });

  test('fails with a clear message when url is unset', async () => {
    const r = await startHeadroomSidecar({}, { fetchImpl: failFetch(), pidFilePath: tempPidFile() });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('url-missing');
    expect(r.error).toContain('url is not configured');
  });
});

// ── stopHeadroomSidecar ──────────────────────────────────────────────────────

describe('stopHeadroomSidecar', () => {
  test('stops a manually started LOCAL instance via port-pid discovery', async () => {
    const killed: number[] = [];
    const r = await stopHeadroomSidecar(
      { url: LOOPBACK },
      {
        fetchImpl: okFetch(),
        pidByPortImpl: (port) => (port === 8787 ? 4321 : null),
        killTreeImpl: (pid) => { killed.push(pid); return true; },
        pidFilePath: tempPidFile(),
      }
    );
    expect(r.ok).toBe(true);
    expect(r.stopped).toBe(true);
    expect(r.pid).toBe(4321);
    expect(killed).toEqual([4321]);
  });

  test('reports pid-unknown when the local listener cannot be identified', async () => {
    const r = await stopHeadroomSidecar(
      { url: LOOPBACK },
      { fetchImpl: okFetch(), pidByPortImpl: () => null, killTreeImpl: () => true, pidFilePath: tempPidFile() }
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('pid-unknown');
    expect(r.error).toContain('could not identify');
  });

  test('refuses to stop a remote instance', async () => {
    const r = await stopHeadroomSidecar(
      { url: 'http://192.168.1.5:8787' },
      { fetchImpl: okFetch(), pidByPortImpl: () => 1, killTreeImpl: () => true, pidFilePath: tempPidFile() }
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('not-loopback');
    expect(r.error).toContain('remote host');
  });

  test('clean no-op when nothing runs and nothing is recorded', async () => {
    const r = await stopHeadroomSidecar(
      { url: LOOPBACK },
      { fetchImpl: failFetch(), killTreeImpl: () => true, pidFilePath: tempPidFile() }
    );
    expect(r.ok).toBe(true);
    expect(r.stopped).toBe(false);
  });

  test('reports kill-failed (with code) when termination fails', async () => {
    const pidPath = tempPidFile();
    fs.writeFileSync(pidPath, '4242', 'utf8');
    const r = await stopHeadroomSidecar(
      { url: LOOPBACK },
      { fetchImpl: failFetch(), killTreeImpl: () => false, pidFilePath: pidPath }
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('kill-failed');
    expect(r.pid).toBe(4242);
  });

  test('kills only the recorded pid and removes the record', async () => {
    const pidPath = tempPidFile();
    fs.writeFileSync(pidPath, '4242', 'utf8');
    const killed: number[] = [];
    const r = await stopHeadroomSidecar(
      { url: LOOPBACK },
      { fetchImpl: failFetch(), killTreeImpl: (pid) => { killed.push(pid); return true; }, pidFilePath: pidPath }
    );
    expect(r.ok).toBe(true);
    expect(r.stopped).toBe(true);
    expect(r.pid).toBe(4242);
    expect(killed).toEqual([4242]);
    expect(fs.existsSync(pidPath)).toBe(false);
  });
});

// ── getHeadroomSidecarStatus ─────────────────────────────────────────────────

describe('getHeadroomSidecarStatus', () => {
  test('reports running + version for a healthy sidecar', async () => {
    const s = await getHeadroomSidecarStatus(
      { url: LOOPBACK },
      { fetchImpl: okFetch('9.9.9'), pidFilePath: tempPidFile() }
    );
    expect(s.running).toBe(true);
    expect(s.version).toBe('9.9.9');
    expect(s.managed).toBe(false);
  });

  test('drops a stale pid record and reports unmanaged', async () => {
    const pidPath = tempPidFile();
    fs.writeFileSync(pidPath, '2147480000', 'utf8'); // alive-ish range but not a real process
    const s = await getHeadroomSidecarStatus(
      { url: LOOPBACK },
      { fetchImpl: failFetch(), pidFilePath: pidPath }
    );
    // The pid either fails the liveness probe (dropped + unmanaged) — a live
    // pid squatting on the number would only flip `managed`, never crash.
    expect(s.running).toBe(false);
    expect(s.version).toBeNull();
    expect(fs.existsSync(pidPath) === false || s.managed === true).toBe(true);
  });
});

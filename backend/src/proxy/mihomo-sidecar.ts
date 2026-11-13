/**
 * mihomo sidecar lifecycle (ADR-0022).
 *
 * The gateway owns the process it spawns: pid file + an `owner` marker
 * (`spawned` vs `adopted`) live under `<env>/mihomo/`. A controller that is
 * already healthy is adopted and left running. Explicit stop kills a local
 * listener either way. Switching back to manual mode only stops a process
 * this gateway spawned — an operator's own mihomo is not touched.
 *
 * Auto-start is `proxy.enabled && proxy.mode === 'mihomo'`. A missing binary
 * is reported (`binary-missing`); the download helper is opt-in and never
 * runs at boot. Subscription URLs and the controller secret are never logged.
 */
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getEnvRootDir } from '../config/env.js';
import { loadConfig, saveConfig } from '../config/index.js';
import {
  DEFAULT_MIHOMO_CONTROLLER_PORT,
  DEFAULT_MIHOMO_GROUP,
  DEFAULT_MIHOMO_MIXED_PORT,
} from '../config/defaults.js';
import type { ProxyConfig } from '../config/types.js';
import { resolveMihomoBinary } from './mihomo-binary.js';
import { MihomoClient } from './mihomo-client.js';
import { mihomoConfigSummary, renderMihomoConfig } from './mihomo-config.js';

export type MihomoSidecarCode =
  | 'disabled'
  | 'port-collision'
  | 'binary-missing'
  | 'spawn-failed'
  | 'spawn-exited'
  | 'not-ready'
  | 'pid-unknown'
  | 'kill-failed'
  | 'reload-failed';

export interface MihomoChildLike {
  pid?: number;
  on?(event: string, listener: (...args: any[]) => void): void;
  unref?(): void;
}

export type MihomoSpawnLike = (cmd: string, args: string[], opts: Record<string, unknown>) => MihomoChildLike;

export interface MihomoSidecarDeps {
  fetchImpl?: typeof fetch;
  spawnImpl?: MihomoSpawnLike;
  killTreeImpl?: (pid: number) => boolean;
  pidByPortImpl?: (port: number) => number | null;
  workDir?: string;
  binaryResolver?: typeof resolveMihomoBinary;
  persistSecret?: (secret: string) => void;
  /** Override the config the sidecar acts on. Tests pass this; production reads loadConfig(). */
  config?: ProxyConfig;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface MihomoStatus {
  installed: boolean;
  binaryPath: string | null;
  running: boolean;
  managed: boolean;
  adopted: boolean;
  pid: number | null;
  mode: 'manual' | 'mihomo';
  enabled: boolean;
  mixedPort: number;
  controllerPort: number;
  secretConfigured: boolean;
  version: string | null;
  error: string | null;
  code: MihomoSidecarCode | null;
}

export interface MihomoOpResult {
  ok: boolean;
  action: 'start' | 'adopt' | 'reload' | 'stop' | 'noop';
  reused: boolean;
  pid: number | null;
  version: string | null;
  error: string | null;
  code: MihomoSidecarCode | null;
}

const PROBE_TIMEOUT_MS = 1500;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 200;

let testDeps: MihomoSidecarDeps | null = null;
let queue: Promise<unknown> = Promise.resolve();
let lastError: { error: string | null; code: MihomoSidecarCode | null } = { error: null, code: null };

export function setMihomoSidecarDepsForTests(deps: MihomoSidecarDeps | null): void {
  testDeps = deps;
  lastError = { error: null, code: null };
}

function merged(extra?: MihomoSidecarDeps): MihomoSidecarDeps {
  return { ...testDeps, ...extra };
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

export function mihomoWorkDir(deps?: MihomoSidecarDeps): string {
  return deps?.workDir ?? path.join(getEnvRootDir(), 'mihomo');
}

function remember(error: string | null, code: MihomoSidecarCode | null): void {
  lastError = { error, code };
}

function proxyOf(deps: MihomoSidecarDeps): ProxyConfig {
  return deps.config ?? loadConfig().proxy ?? {};
}

function shouldRun(proxy: ProxyConfig): boolean {
  return proxy.enabled === true && proxy.mode === 'mihomo';
}

function portsOf(proxy: ProxyConfig): { mixed: number; controller: number; group: string; secret: string } {
  const mihomo = proxy.mihomo ?? {};
  return {
    mixed: mihomo.mixedPort ?? DEFAULT_MIHOMO_MIXED_PORT,
    controller: mihomo.controllerPort ?? DEFAULT_MIHOMO_CONTROLLER_PORT,
    group: mihomo.selectedGroup || DEFAULT_MIHOMO_GROUP,
    secret: (mihomo.controllerSecret || '').trim(),
  };
}

function newSecret(): string {
  return crypto.randomBytes(24).toString('hex');
}

/** Persist a generated secret through the normal config writer. Never logs it. */
export function persistMihomoSecret(secret: string): void {
  const current = loadConfig();
  const proxy = current.proxy ?? {};
  if ((proxy.mihomo?.controllerSecret || '') === secret) return;
  saveConfig({
    proxy: {
      ...proxy,
      mihomo: { ...(proxy.mihomo ?? {}), controllerSecret: secret },
    },
  });
}

function readPid(file: string): number | null {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writePid(file: string, pid: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(pid), 'utf8');
}

function ownerOf(dir: string): 'spawned' | 'adopted' | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'owner'), 'utf8').trim();
    return raw === 'spawned' || raw === 'adopted' ? raw : null;
  } catch {
    return null;
  }
}

function writeOwner(dir: string, owner: 'spawned' | 'adopted'): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner'), owner, 'utf8');
}

async function probe(fetchImpl: typeof fetch, port: number, secret: string): Promise<{ ok: boolean; version: string | null }> {
  if (!secret) return { ok: false, version: null };
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/version`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, version: null };
    let version: string | null = null;
    try {
      const body = await res.json() as { version?: unknown };
      if (typeof body?.version === 'string' && body.version.trim()) version = body.version;
    } catch {
      version = null;
    }
    return { ok: true, version };
  } catch {
    return { ok: false, version: null };
  }
}

function writeGeneratedConfig(dir: string, proxy: ProxyConfig, secret: string): { yamlPath: string; summary: string; changed: boolean } {
  const { mixed, controller, group } = portsOf(proxy);
  const rendered = renderMihomoConfig({
    mixedPort: mixed,
    controllerPort: controller,
    secret,
    group,
    subscriptions: proxy.mihomo?.subscriptions ?? [],
  });
  fs.mkdirSync(path.join(dir, 'providers'), { recursive: true });
  const yamlPath = path.join(dir, 'config.yaml');
  const next = rendered.yaml;
  let changed = true;
  try {
    changed = fs.readFileSync(yamlPath, 'utf8') !== next;
  } catch {
    changed = true;
  }
  if (changed) fs.writeFileSync(yamlPath, next, 'utf8');
  return { yamlPath, summary: mihomoConfigSummary(rendered, { mixedPort: mixed, controllerPort: controller }), changed };
}

function ensureSecret(proxy: ProxyConfig, deps: MihomoSidecarDeps): string {
  const existing = (proxy.mihomo?.controllerSecret || '').trim();
  if (existing) return existing;
  const secret = newSecret();
  proxy.mihomo = { ...(proxy.mihomo ?? {}), controllerSecret: secret };
  try {
    (deps.persistSecret ?? persistMihomoSecret)(secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'persist failed';
    console.warn(`[Mihomo] could not persist controller secret (${message})`);
  }
  return secret;
}

function clientFor(port: number, secret: string, fetchImpl: typeof fetch): MihomoClient {
  return new MihomoClient({ port, secret, fetchImpl, timeoutMs: 8000 });
}

async function applySelection(proxy: ProxyConfig, port: number, secret: string, fetchImpl: typeof fetch): Promise<void> {
  const group = proxy.mihomo?.selectedGroup || DEFAULT_MIHOMO_GROUP;
  const node = proxy.mihomo?.selectedNodes?.[group];
  if (!node) return;
  try {
    await clientFor(port, secret, fetchImpl).select(group, node);
  } catch {
    // Providers may still be downloading. The stored selection is retried on the next start.
  }
}

function defaultSpawn(cmd: string, args: string[], opts: Record<string, unknown>): MihomoChildLike {
  return spawn(cmd, args, opts as never);
}

function defaultKill(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
      return res.status === 0;
    }
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

function defaultPidByPort(port: number): number | null {
  try {
    if (process.platform === 'win32') {
      const res = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1).OwningProcess`],
        { windowsHide: true, encoding: 'utf8' },
      );
      const pid = Number(res.stdout?.trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    }
    const res = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
    const pid = Number(res.stdout?.trim().split(/\r?\n/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function fail(code: MihomoSidecarCode, error: string): MihomoOpResult {
  remember(error, code);
  return { ok: false, action: 'noop', reused: false, pid: null, version: null, error, code };
}

async function startUnlocked(deps: MihomoSidecarDeps): Promise<MihomoOpResult> {
  const proxy = proxyOf(deps);
  if (!shouldRun(proxy)) {
    return fail('disabled', 'proxy.enabled and proxy.mode mihomo are both required');
  }
  const { mixed, controller } = portsOf(proxy);
  if (mixed === controller) return fail('port-collision', 'mihomo mixedPort and controllerPort must differ');
  const secret = ensureSecret(proxy, deps);
  const dir = mihomoWorkDir(deps);
  let written: { yamlPath: string; summary: string; changed: boolean };
  try {
    written = writeGeneratedConfig(dir, proxy, secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'config write failed';
    return fail('spawn-failed', `could not write mihomo config (${message})`);
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const health = await probe(fetchImpl, controller, secret);
  if (health.ok) {
    if (written.changed) {
      try {
        await clientFor(controller, secret, fetchImpl).reloadConfig(written.yamlPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'reload failed';
        return fail('reload-failed', `mihomo config reload failed (${message})`);
      }
    }
    const pidFile = path.join(dir, 'mihomo.pid');
    const recorded = readPid(pidFile);
    if (!ownerOf(dir)) writeOwner(dir, 'adopted');
    await applySelection(proxy, controller, secret, fetchImpl);
    remember(null, null);
    console.log(`[Mihomo] ${written.changed ? 'reloaded' : 'adopted'} ${written.summary}`);
    return {
      ok: true,
      action: written.changed ? 'reload' : 'adopt',
      reused: true,
      pid: recorded && pidAlive(recorded) ? recorded : recorded,
      version: health.version,
      error: null,
      code: null,
    };
  }

  const resolved = (deps.binaryResolver ?? resolveMihomoBinary)(proxy.mihomo?.binaryPath);
  if (!resolved.path) return fail('binary-missing', 'mihomo binary not found — install it or set proxy.mihomo.binaryPath');
  const spawnImpl = deps.spawnImpl ?? defaultSpawn;
  const spawnState = { error: null as Error | null, exitCode: null as number | null };
  let child: MihomoChildLike;
  try {
    child = spawnImpl(resolved.path, ['-d', dir, '-f', written.yamlPath], {
      cwd: dir,
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'spawn failed';
    return fail('spawn-failed', `failed to spawn mihomo (${message})`);
  }
  child.on?.('error', (err: Error) => {
    spawnState.error = err;
  });
  child.on?.('exit', (code: number | null) => {
    spawnState.exitCode = code;
  });
  child.unref?.();
  if (child.pid) {
    writePid(path.join(dir, 'mihomo.pid'), child.pid);
    writeOwner(dir, 'spawned');
  }

  const readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (spawnState.error) {
      const code = (spawnState.error as NodeJS.ErrnoException).code;
      return fail('spawn-exited', `mihomo exited immediately (${spawnState.error.message}${code ? ` [${code}]` : ''})`);
    }
    if (spawnState.exitCode !== null) {
      return fail('spawn-exited', `mihomo exited immediately (code ${spawnState.exitCode})`);
    }
    const again = await probe(fetchImpl, controller, secret);
    if (again.ok) {
      await applySelection(proxy, controller, secret, fetchImpl);
      remember(null, null);
      console.log(`[Mihomo] started ${written.summary}${child.pid ? ` pid=${child.pid}` : ''}`);
      return { ok: true, action: 'start', reused: false, pid: child.pid ?? null, version: again.version, error: null, code: null };
    }
    if (Date.now() >= deadline) {
      return fail('not-ready', `mihomo did not become ready within ${Math.round(readyTimeoutMs / 1000)}s`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

async function stopUnlocked(deps: MihomoSidecarDeps, onlySpawned: boolean): Promise<MihomoOpResult> {
  const proxy = proxyOf(deps);
  const { controller } = portsOf(proxy);
  const dir = mihomoWorkDir(deps);
  const pidFile = path.join(dir, 'mihomo.pid');
  const recorded = readPid(pidFile);
  const owner = ownerOf(dir);
  if (onlySpawned && owner !== 'spawned') {
    return { ok: true, action: 'noop', reused: false, pid: null, version: null, error: null, code: null };
  }
  const kill = deps.killTreeImpl ?? defaultKill;
  let pid = recorded && pidAlive(recorded) ? recorded : null;
  if (pid == null && !onlySpawned) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const secret = (proxy.mihomo?.controllerSecret || '').trim();
    const health = await probe(fetchImpl, controller, secret);
    if (health.ok) {
      pid = (deps.pidByPortImpl ?? defaultPidByPort)(controller);
      if (pid == null) return fail('pid-unknown', 'mihomo is listening but its pid could not be identified');
    }
  }
  if (pid == null) {
    try { fs.unlinkSync(pidFile); } catch { /* already gone */ }
    try { fs.unlinkSync(path.join(dir, 'owner')); } catch { /* already gone */ }
    remember(null, null);
    return { ok: true, action: 'noop', reused: false, pid: null, version: null, error: null, code: null };
  }
  if (!kill(pid)) return fail('kill-failed', `failed to terminate mihomo process ${pid}`);
  try { fs.unlinkSync(pidFile); } catch { /* already gone */ }
  try { fs.unlinkSync(path.join(dir, 'owner')); } catch { /* already gone */ }
  remember(null, null);
  console.log(`[Mihomo] stopped pid=${pid}`);
  return { ok: true, action: 'stop', reused: false, pid, version: null, error: null, code: null };
}

export function getMihomoStatus(extra?: MihomoSidecarDeps): Promise<MihomoStatus> {
  const deps = merged(extra);
  const proxy = proxyOf(deps);
  const { mixed, controller, secret } = portsOf(proxy);
  const resolved = (deps.binaryResolver ?? resolveMihomoBinary)(proxy.mihomo?.binaryPath);
  const dir = mihomoWorkDir(deps);
  const recorded = readPid(path.join(dir, 'mihomo.pid'));
  const alive = recorded != null && pidAlive(recorded);
  const owner = ownerOf(dir);
  return probe(deps.fetchImpl ?? fetch, controller, secret).then((health) => ({
    installed: resolved.path != null,
    binaryPath: resolved.path,
    running: health.ok,
    managed: owner === 'spawned' && alive,
    adopted: owner === 'adopted' && (health.ok || alive),
    pid: alive ? recorded : null,
    mode: proxy.mode === 'mihomo' ? 'mihomo' : 'manual',
    enabled: proxy.enabled === true,
    mixedPort: mixed,
    controllerPort: controller,
    secretConfigured: secret.length > 0,
    version: health.version,
    error: lastError.error,
    code: lastError.code,
  }));
}

export function startMihomoSidecar(extra?: MihomoSidecarDeps): Promise<MihomoOpResult> {
  const deps = merged(extra);
  return enqueue(() => startUnlocked(deps));
}

export function stopMihomoSidecar(extra?: MihomoSidecarDeps): Promise<MihomoOpResult> {
  const deps = merged(extra);
  return enqueue(() => stopUnlocked(deps, false));
}

export function restartMihomoSidecar(extra?: MihomoSidecarDeps): Promise<MihomoOpResult> {
  const deps = merged(extra);
  return enqueue(async () => {
    const stopped = await stopUnlocked(deps, false);
    if (!stopped.ok) return stopped;
    return startUnlocked(deps);
  });
}

/**
 * Bring the sidecar in line with the saved proxy section.
 * Runs at boot and after a config save. Never throws.
 */
export async function reconcileMihomoSidecar(proxy?: ProxyConfig, extra?: MihomoSidecarDeps): Promise<MihomoOpResult> {
  const deps = merged({ ...extra, ...(proxy ? { config: proxy } : {}) });
  const current = proxyOf(deps);
  if (!shouldRun(current)) {
    return enqueue(() => stopUnlocked(deps, true));
  }
  return startMihomoSidecar(deps);
}

/** Test-only: the last log-safe failure, so suites can assert the secret stayed out of it. */
export function mihomoLastErrorForTests(): { error: string | null; code: MihomoSidecarCode | null } {
  return lastError;
}

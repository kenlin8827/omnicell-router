import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { getInfoFilePath, getLogFilePath, getPidFilePath, getRepoRootDir } from './paths.js';
import { DaemonInfo } from './types.js';
import { APP_VERSION } from '../version.js';
import { getAllClientStatuses } from './clients/index.js';
import { defaultGatewayPort } from './clients/base.js';
import { loadConfig } from '../config/index.js';
import { resolveEnvName } from '../config/env.js';

/**
 * Env name for ocr.info.json: this CLI/gateway process resolves the same
 * pointer/env the spawned child inherits. A failing resolution (unknown
 * OCR_ENV) yields undefined — the CHILD fails fast loudly in its own
 * process, which is where that error belongs; the wrapper must not duplicate
 * the crash before even attempting the spawn.
 */
function resolveActiveEnvName(): string | undefined {
  try {
    return resolveEnvName();
  } catch {
    return undefined;
  }
}

const IS_WINDOWS = process.platform === 'win32';
const IS_MACOS = process.platform === 'darwin';

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM'; // Exists but no permission to signal
  }
}

/**
 * Size-based log rotation, run once per daemon start (not per write). If
 * `logFile` exceeds `maxSizeMB`, it becomes `logFile.1`, existing `.N` shift
 * up to `.N+1`, and archives beyond `keepArchives` are deleted.
 */
function rotateLogIfNeeded(logFile: string, maxSizeMB: number, keepArchives: number): void {
  if (!fs.existsSync(logFile)) return;
  try {
    const stat = fs.statSync(logFile);
    if (stat.size < maxSizeMB * 1024 * 1024) return;
    if (keepArchives < 1) {
      fs.unlinkSync(logFile);
      return;
    }
    const oldest = `${logFile}.${keepArchives}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let i = keepArchives - 1; i >= 1; i--) {
      const src = `${logFile}.${i}`;
      if (fs.existsSync(src)) fs.renameSync(src, `${logFile}.${i + 1}`);
    }
    fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    // Best-effort — never block daemon startup on rotation failure
  }
}

export function getRunningPid(): number | null {
  const pidFile = getPidFilePath();
  if (!fs.existsSync(pidFile)) return null;

  try {
    const content = fs.readFileSync(pidFile, 'utf8').trim();
    const pid = parseInt(content, 10);
    if (isNaN(pid)) {
      fs.unlinkSync(pidFile);
      return null;
    }
    if (isProcessAlive(pid)) {
      return pid;
    }
    // Stale PID file
    fs.unlinkSync(pidFile);
    return null;
  } catch {
    return null;
  }
}

export function getDaemonInfo(): DaemonInfo | null {
  const infoFile = getInfoFilePath();
  if (!fs.existsSync(infoFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  } catch {
    return null;
  }
}

export async function checkServerHealth(port = defaultGatewayPort(), host = '127.0.0.1'): Promise<{ ok: boolean; data?: any }> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = await res.json();
      return { ok: true, data };
    }
  } catch {
    // offline
  }
  return { ok: false };
}

/**
 * True when this process itself is a bun compiled snapshot (bun build
 * --compile — how the desktop sidecar ships): process.execPath IS the gateway
 * binary, so a replacement child is a bare relaunch of our own exe with no
 * runtime install or repo layout needed. Detection rides Bun.main's virtual
 * embedded-FS path; node/bun source runs report a real path and stay on the
 * source-layout resolution below.
 */
function compiledSnapshotExe(): boolean {
  try {
    // Verified on bun 1.3.14 (scripts/tmp-probe.ts experiment, 2026-10-18):
    // inside a `bun build --compile` snapshot Bun.main/import.meta.path live
    // on the virtual embedded FS (Windows: `B:\~BUN\root\…`, POSIX:
    // `/$bunfs/…`); a plain `bun`/node runtime reports a real path. Note
    // Bun.embeddedFiles is [] in BOTH modes on this version — not a signal.
    const bunMain = (globalThis as { Bun?: { main?: string } }).Bun?.main;
    if (!bunMain) return false;
    return bunMain.startsWith('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(bunMain);
  } catch {
    return false;
  }
}

export function resolveRuntimeBinary(): { bin: string; args: string[] } {
  // Compiled snapshot (desktop sidecar): our own exe is the gateway entry.
  if (compiledSnapshotExe()) return { bin: process.execPath, args: [] };
  const repoDir = getRepoRootDir();
  const entryTs = path.join(repoDir, 'backend', 'src', 'index.ts');
  const entryJs = path.join(repoDir, 'dist', 'index.js');

  // Candidate bun locations; PATH lookup first, then the common Windows homes.
  // NOTE: BUN_INSTALL is deliberately NOT consulted here (an earlier `bunPath`
  // computed it and no candidate list ever used it) — adding it is a behavior
  // change to daemon spawn resolution, tracked separately.
  const candidates = [
    'bun',
    'D:\\dev\\bun\\bin\\bun.exe',
    path.join(process.env.USERPROFILE || '', '.bun', 'bin', 'bun.exe'),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return { bin: c, args: ['run', '--no-env-file', entryTs] };
    }
  }

  // Fallback to node
  if (fs.existsSync(entryJs)) {
    return { bin: 'node', args: [entryJs] };
  }
  return { bin: 'npx', args: ['tsx', entryTs] };
}

/**
 * Write `ocr.pid` + `ocr.info.json` so `ocr status` / `ocr stop` / the UI can
 * track this gateway. Shared between `startDaemon` (wrapper pid) and the
 * UI-restart child (self-registers its own pid after adoption).
 * `env` records the ACTIVE ENVIRONMENT name (book-set) for `ocr status`.
 */
export function writeDaemonFiles(pid: number, port: number, host: string, env?: string): void {
  const pidFile = getPidFilePath();
  const infoFile = getInfoFilePath();
  fs.writeFileSync(pidFile, String(pid), 'utf8');
  fs.writeFileSync(
    infoFile,
    JSON.stringify(
      {
        pid,
        port,
        host,
        env: env ?? resolveActiveEnvName(),
        startTime: new Date().toISOString(),
        version: APP_VERSION,
      },
      null,
      2
    ),
    'utf8'
  );
}

/**
 * Env var set on the detached restart-child spawned by `spawnDetachedRestartChild`:
 * the OLD gateway's pid it must wait for (and force-kill if stuck) before serving.
 */
export const RESTART_PARENT_ENV = 'OCR_RESTART_OF';

/**
 * Shared guts of every detached replacement-gateway spawn. `extraEnv` carries
 * the per-variant settings ON TOP of the adoption handshake; the parent's own
 * environment is inherited by both branches (POSIX via `...process.env`,
 * Windows via Start-Process environment inheritance + inline `set` lines).
 * `omitPortHost` is the env-switch deviation (L3 P1-2): a child booting a
 * DIFFERENT book-set must not inherit/keep PORT/HOST — the target env's own
 * config.yaml decides where it listens (an inherited HOST=0.0.0.0 would force
 * webAuth on in an env that never configured it, killing the child in
 * validateWebAuthStartup AFTER the parent already exited = total outage).
 * Best-effort: returns false if the spawn fails (caller keeps serving).
 */
interface GatewayChildSpawnOpts {
  extraEnv: Record<string, string>;
  omitPortHost?: boolean;
}

function childSettings(extraEnv: Record<string, string>): Record<string, string> {
  return {
    [RESTART_PARENT_ENV]: String(process.pid),
    ...extraEnv,
    NODE_ENV: 'production',
  };
}

/** Pure POSIX child-env builder — exported so spawn args are assertable without spawning. */
export function buildGatewayChildEnv(opts: GatewayChildSpawnOpts): Record<string, string> {
  const settings = childSettings(opts.extraEnv);
  if (!opts.omitPortHost) return { ...process.env, ...settings } as Record<string, string>;
  // Destructure-drops the inherited PORT/HOST before the settings spread.
  const { PORT: _dropPort, HOST: _dropHost, ...rest } = process.env;
  return { ...rest, ...settings } as Record<string, string>;
}

/**
 * Windows inline `set` chain (PowerShell 5.1 has no -Environment).
 * `set "NAME="` clears an inherited value for the whole cmd child chain —
 * emitted ONLY in omitPortHost mode; the plain-restart string is unchanged.
 */
export function buildWindowsEnvSets(opts: GatewayChildSpawnOpts): string {
  const clears = opts.omitPortHost ? 'set "PORT=" && set "HOST=" && ' : '';
  const sets = Object.entries(childSettings(opts.extraEnv))
    .map(([k, v]) => `set "${k}=${v}" && `)
    .join('');
  return clears + sets;
}

function spawnDetachedGatewayChild(opts: GatewayChildSpawnOpts): boolean {
  try {
    const { bin, args } = resolveRuntimeBinary();
    // Snapshot mode: the repo layout doesn't exist in an installed app —
    // anchor the detached spawn next to our own exe so the -WorkingDirectory
    // / cwd points at a real directory.
    const repoDir = compiledSnapshotExe() ? path.dirname(process.execPath) : getRepoRootDir();
    const logFile = getLogFilePath();

    if (IS_WINDOWS) {
      // Same Start-Process pattern as startDaemon: hidden cmd wrapper that
      // appends stdout/stderr to the daemon log. Env must be set inline since
      // Start-Process -Environment needs PowerShell 7 (we target 5.1).
      const envSets = buildWindowsEnvSets(opts);
      const cmdLine = `/c "${envSets}"${bin}" ${args.map((a) => `"${a}"`).join(' ')} >> "${logFile}" 2>&1"`;
      const psCmd = `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '${cmdLine.replace(/'/g, "''")}' -WorkingDirectory '${repoDir.replace(/'/g, "''")}' -WindowStyle Hidden -PassThru; $p.Id`;
      const res = spawnSync('powershell', ['-NoProfile', '-Command', psCmd], {
        windowsHide: true,
        encoding: 'utf8',
      });
      return parseInt(res.stdout?.trim() || '0', 10) > 0;
    }

    const logFd = fs.openSync(logFile, 'a');
    const child = spawn(bin, args, {
      cwd: repoDir,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: buildGatewayChildEnv(opts),
      shell: false,
    });
    child.unref();
    return Boolean(child.pid);
  } catch {
    return false;
  }
}

/**
 * Spawn a detached copy of the gateway runtime pointed at the same entry, with
 * `OCR_RESTART_OF=<our pid>` in its env. The child waits for us to exit, then
 * boots and self-registers the pid/info files. Best-effort: returns false if
 * the spawn fails (caller then degrades to plain stop semantics).
 */
export function spawnDetachedRestartChild(opts: { port: number; host: string }): boolean {
  return spawnDetachedGatewayChild({ extraEnv: { PORT: String(opts.port), HOST: opts.host } });
}

/**
 * Environment-switch variant of `spawnDetachedRestartChild`. CRITICAL
 * difference: NO PORT/HOST is pinned NOR inherited (`omitPortHost`) — the
 * target environment's own config.yaml decides where it listens; OCR_ENV is
 * the only injection. OCR_HOME keeps flowing via parent-env inheritance.
 */
export function spawnDetachedEnvSwitchChild(opts: { envName: string }): boolean {
  return spawnDetachedGatewayChild({ extraEnv: { OCR_ENV: opts.envName }, omitPortHost: true });
}

/**
 * Called once at gateway boot. If we were spawned as a UI-restart child, wait
 * for the old gateway process to die (it self-exits ~0.5s after acknowledging
 * the restart; force-kill after 15s), briefly let the listen port release, and
 * consume the env flag so a crash-looped child never adopts recursively.
 * Returns true when this process IS a restart child (caller then writes the
 * daemon pid/info files for itself once it is listening).
 */
export async function adoptRestartParent(): Promise<boolean> {
  const raw = process.env[RESTART_PARENT_ENV];
  delete process.env[RESTART_PARENT_ENV];
  const oldPid = parseInt(raw || '', 10);
  if (!raw || isNaN(oldPid) || oldPid === process.pid) return false;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && isProcessAlive(oldPid)) {
    await sleep(200);
  }
  if (isProcessAlive(oldPid)) {
    try {
      if (IS_WINDOWS) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(oldPid)], { windowsHide: true });
      } else {
        process.kill(oldPid, 'SIGKILL');
      }
    } catch {
      // already gone between check and kill
    }
  }
  await sleep(300); // let the OS finish releasing the listen socket
  return true;
}

export async function startDaemon(options: {
  port?: number;
  host?: string;
  daemon?: boolean;
  /** `--env` flag: run the gateway on this environment (OCR_ENV injected into the child). */
  envName?: string;
} = {}): Promise<{
  success: boolean;
  pid: number;
  port: number;
  message: string;
}> {
  const existingPid = getRunningPid();
  const port = options.port || defaultGatewayPort();
  const host = options.host || '127.0.0.1';
  const envName = options.envName ?? resolveActiveEnvName();

  if (existingPid) {
    const health = await checkServerHealth(port, host);
    return {
      success: true,
      pid: existingPid,
      port,
      message: `OCR gateway is already running (PID: ${existingPid}, status: ${health.ok ? 'online' : 'initializing'}).`,
    };
  }

  const logFile = getLogFilePath();

  const { bin, args } = resolveRuntimeBinary();
  // Snapshot mode (desktop sidecar): the repo layout doesn't exist in an
  // installed app — anchor the spawn next to our own exe, same as the
  // restart-child branch in spawnDetachedGatewayChild.
  const repoDir = compiledSnapshotExe() ? path.dirname(process.execPath) : getRepoRootDir();

  // Rotate before opening the log for append so the new daemon always starts
  // on a fresh file when the previous one had grown past the threshold.
  let logCfg: { maxSizeMB?: number; keepArchives?: number } = {};
  try {
    logCfg = loadConfig().logging ?? {};
  } catch {
    // config unreadable — fall through to defaults
  }
  rotateLogIfNeeded(logFile, logCfg.maxSizeMB ?? 10, logCfg.keepArchives ?? 7);

  let pid: number;

  if (IS_WINDOWS) {
    // Windows: launch through `cmd /c "<bin> <args> >> <log> 2>&1"` via
    // Start-Process so stdout/stderr append to the daemon log file (the older
    // Win32_Process.Create approach dropped them entirely). The returned PID
    // is the cmd wrapper's; stopDaemon kills the whole tree via taskkill /T.
    // --env: OCR_ENV set inline (PowerShell 5.1 has no -Environment support).
    // Without --env the command line stays byte-identical to plain `ocr start`.
    const envSet = options.envName ? `set "OCR_ENV=${options.envName}" && ` : '';
    const cmdLine = envSet
      ? `/c "${envSet}"${bin}" ${args.map((a) => `"${a}"`).join(' ')} >> "${logFile}" 2>&1"`
      : `/c ""${bin}" ${args.map((a) => `"${a}"`).join(' ')} >> "${logFile}" 2>&1"`;
    const psCmd = `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '${cmdLine.replace(/'/g, "''")}' -WorkingDirectory '${repoDir.replace(/'/g, "''")}' -WindowStyle Hidden -PassThru; $p.Id`;
    const res = spawnSync('powershell', ['-NoProfile', '-Command', psCmd], {
      windowsHide: true,
      encoding: 'utf8',
    });
    pid = parseInt(res.stdout?.trim() || '0', 10);
  } else {
    const logFd = fs.openSync(logFile, 'a');
    const env = {
      ...process.env,
      PORT: String(port),
      HOST: host,
      NODE_ENV: 'production',
      ...(options.envName ? { OCR_ENV: options.envName } : {}),
    };
    const child = spawn(bin, args, {
      cwd: repoDir,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env,
      shell: false,
    });
    pid = child.pid || 0;
    child.unref();
  }

  if (!pid) {
    return {
      success: false,
      pid: 0,
      port,
      message: 'Failed to spawn OCR background process.',
    };
  }

  writeDaemonFiles(pid, port, host, envName);

  // Wait for health check up to 5 seconds
  let online = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const health = await checkServerHealth(port, host);
    if (health.ok) {
      online = true;
      break;
    }
  }

  return {
    success: true,
    pid,
    port,
    message: online
      ? `OCR gateway started successfully in background (PID: ${pid}, Port: ${port})`
      : `OCR gateway started (PID: ${pid}), waiting for initial synchronization... Check ${logFile} for details.`,
  };
}

export async function stopDaemon(): Promise<{ success: boolean; message: string }> {
  const pid = getRunningPid();
  if (!pid) {
    return { success: true, message: 'OCR gateway is not currently running.' };
  }

  try {
    if (IS_WINDOWS) {
      // Windows: the tracked PID is the cmd wrapper (Start-Process) and the
      // gateway is its child — process.kill/TerminateProcess would kill ONLY
      // the wrapper and orphan the gateway, so always kill the whole tree.
      // spawnSync (not spawn) so the kill lands before the liveness polling.
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch (err: any) {
    if (err.code !== 'ESRCH' && !IS_WINDOWS) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  }

  // Poll for process exit
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (!isProcessAlive(pid)) {
      break;
    }
  }

  if (isProcessAlive(pid)) {
    try {
      if (IS_WINDOWS) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      // ignore
    }
  }

  const pidFile = getPidFilePath();
  const infoFile = getInfoFilePath();
  if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  if (fs.existsSync(infoFile)) fs.unlinkSync(infoFile);

  return { success: true, message: `OCR gateway (PID: ${pid}) has been stopped.` };
}

export async function restartDaemon(options: { port?: number; host?: string; envName?: string } = {}): Promise<{
  success: boolean;
  message: string;
}> {
  await stopDaemon();
  await new Promise((r) => setTimeout(r, 800));
  const res = await startDaemon(options);
  return {
    success: res.success,
    message: `OCR gateway restarted: ${res.message}`,
  };
}

export async function getStatusOutput(): Promise<{
  running: boolean;
  pid: number | null;
  port: number;
  env?: string;
  uptime?: string;
  health?: any;
  clients: any[];
}> {
  const pid = getRunningPid();
  const info = getDaemonInfo();
  const port = info?.port || defaultGatewayPort();
  const host = info?.host || '127.0.0.1';

  let health: any = null;
  if (pid) {
    const res = await checkServerHealth(port, host);
    if (res.ok) {
      health = res.data;
    }
  }

  const clients = await getAllClientStatuses();

  let uptime: string | undefined;
  if (info?.startTime) {
    const diffSec = Math.floor((Date.now() - new Date(info.startTime).getTime()) / 1000);
    const hours = Math.floor(diffSec / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    const secs = diffSec % 60;
    uptime = `${hours}h ${mins}m ${secs}s`;
  }

  return {
    running: Boolean(pid),
    pid,
    port,
    env: info?.env,
    uptime,
    health,
    clients,
  };
}

export async function openBrowserUrl(url: string): Promise<void> {
  if (IS_WINDOWS) {
    spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true });
  } else if (IS_MACOS) {
    spawn('open', [url], { detached: true });
  } else {
    spawn('xdg-open', [url], { detached: true });
  }
}

export async function launchWeb(options: { port?: number } = {}): Promise<void> {
  const status = await getStatusOutput();
  const port = options.port || status.port || defaultGatewayPort();

  if (!status.running) {
    console.log('[OCR] Gateway is not running. Starting background service first...');
    const startRes = await startDaemon({ port });
    console.log(`[OCR] ${startRes.message}`);
  }

  const targetUrl = `http://127.0.0.1:${port}/`;
  console.log(`[OCR] Opening Web Dashboard at: ${targetUrl}`);
  await openBrowserUrl(targetUrl);
}

export async function launchDesktop(options: { port?: number } = {}): Promise<void> {
  const status = await getStatusOutput();
  const port = options.port || status.port || defaultGatewayPort();

  if (!status.running) {
    console.log('[OCR] Gateway is not running. Starting background service first...');
    await startDaemon({ port });
  }

  // Look for native Tauri desktop binary candidates
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'opencode-router', 'opencode-router-desktop.exe'),
    path.join(getRepoRootDir(), 'desktop', 'src-tauri', 'target', 'release', 'opencode-router-desktop.exe'),
  ];

  let desktopBin: string | null = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      desktopBin = c;
      break;
    }
  }

  if (desktopBin) {
    console.log(`[OCR] Launching native desktop application (${desktopBin})...`);
    spawn(desktopBin, [], { detached: true, stdio: 'ignore', windowsHide: false });
  } else {
    console.log('[OCR] 💡 Native desktop client (Tauri) package not found.');
    console.log('      Seamlessly opening Web Console in your browser...');
    console.log('      (Download native desktop installers at https://github.com/kenlin8827/opencode-router/releases)');
    await launchWeb(options);
  }
}

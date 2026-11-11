import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  compiledSnapshotExe,
  getInfoFilePath,
  getLogFilePath,
  getPidFilePath,
  getRepoRootDir,
  getRestartChildPidFilePath,
  getRestartLogFilePath,
  getRestartStatusFilePath,
} from './paths.js';
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
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // Exists but no permission to signal
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
  // Wildcard binds are probed through loopback: `http://0.0.0.0:port` is not
  // a routable target on every platform.
  const probeHost = host === '0.0.0.0' || host === '::' || host === '[::]' ? '127.0.0.1' : host;
  try {
    const res = await fetch(`http://${probeHost}:${port}/health`, { signal: AbortSignal.timeout(1500) });
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
 * True when this process is a bun compiled snapshot — see
 * `paths.ts compiledSnapshotExe`, the one definition shared with the shim
 * writer. Kept as a local alias so this module's call sites read unchanged.
 */
const isCompiledSnapshot = compiledSnapshotExe;

export function resolveRuntimeBinary(): { bin: string; args: string[] } {
  // Compiled snapshot (desktop sidecar): our own exe is the gateway entry.
  if (isCompiledSnapshot()) return { bin: process.execPath, args: [] };
  const repoDir = getRepoRootDir();
  const entryTs = path.join(repoDir, 'backend', 'src', 'index.ts');
  const entryJsCandidates = [
    path.join(repoDir, 'backend', 'dist', 'index.js'),
    path.join(repoDir, 'dist', 'index.js'),
  ];
  const entryJs = entryJsCandidates.find((p) => fs.existsSync(p));

  if (fs.existsSync(entryTs)) {
    const bunExe = process.platform === 'win32' ? 'bun.exe' : 'bun';
    const fallbackLocations = [
      process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bin', bunExe) : '',
      path.join(process.env.USERPROFILE || process.env.HOME || '', '.bun', 'bin', bunExe),
    ].filter(Boolean);

    const candidates = ['bun', ...fallbackLocations];
    for (const c of candidates) {
      if (c === 'bun') {
        try {
          const probe = spawnSync('bun', ['--version'], { encoding: 'utf8', windowsHide: true });
          if (probe.status === 0) {
            return { bin: 'bun', args: ['run', '--no-env-file', entryTs] };
          }
        } catch {
          // not on PATH
        }
      } else if (fs.existsSync(c)) {
        return { bin: c, args: ['run', '--no-env-file', entryTs] };
      }
    }
  }

  // Fallback to node
  if (entryJs) {
    return { bin: 'node', args: [entryJs] };
  }
  return { bin: 'npx', args: ['tsx', entryTs] };
}

/**
 * Write `ocr.pid` + `ocr.info.json` so `ocr status` / `ocr stop` / the UI can
 * track this gateway. Shared between `startDaemon` (wrapper pid) and the
 * supervisor-spawned gateway (self-registers its pid once listening).
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
 * Env var set on the detached restart SUPERVISOR spawned by
 * `spawnDetachedRestartChild` / `spawnDetachedEnvSwitchChild`: the OLD
 * gateway's pid whose exit it must wait for (and force-kill if stuck) before
 * starting the replacement.
 */
export const RESTART_PARENT_ENV = 'OCR_RESTART_OF';

/**
 * Marks a detached process as the restart supervisor (see
 * `runRestartSupervisor`): it owns the handover — wait for the old gateway,
 * spawn the replacement, verify `/health` with retries, record the verdict —
 * and never serves itself. Consumed at supervisor start so the gateway it
 * spawns can never re-enter supervisor mode.
 */
export const RESTART_SUPERVISOR_ENV = 'OCR_RESTART_SUPERVISOR';

/**
 * Set on the gateway child spawned BY the supervisor: it writes the pid/info
 * files itself once it is listening (the old process already exited; nobody
 * else owns those files at that point).
 */
const RESTART_SELF_REGISTER_ENV = 'OCR_RESTART_SELF_REGISTER';

/** Every env key that carries a restart-handshake ROLE (see `withoutRestartFlags`). */
const RESTART_FLAGS = [RESTART_PARENT_ENV, RESTART_SUPERVISOR_ENV, RESTART_SELF_REGISTER_ENV];

/**
 * Inherited env minus every restart-handshake flag. A spawn must NEVER inherit
 * a role: a gateway child still seeing `OCR_RESTART_SUPERVISOR=1` would
 * re-enter supervisor mode, and a supervisor still carrying a stale
 * `OCR_RESTART_OF` would wait on the wrong pid. Explicit flags are re-applied
 * through `extraEnv` (POSIX) / the inline `set` chain (Windows) AFTER the
 * strip.
 *
 * The strip is applied to the env OBJECT (POSIX) and inline via `set "NAME="`
 * (Windows) because deleting from `process.env` is not guaranteed to reach the
 * native block a Windows child inherits (observed on Bun/Windows) — the object
 * alone is not enough.
 */
function withoutRestartFlags(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of RESTART_FLAGS) delete clean[key];
  return clean;
}

/**
 * How long a replacement gateway gets to answer `/health` before the attempt
 * is judged. Deliberately below the console's ~45 s reconnect budget
 * (Layout / EnvironmentsPage) so the handover reaches a verdict before the
 * browser gives up polling.
 */
export const STARTUP_HEALTH_TIMEOUT_MS = 40_000;

/** Retried ONLY when a spawned gateway exited (crash) — never while it still lives. */
const SUPERVISOR_MAX_ATTEMPTS = 3;
const SUPERVISOR_RETRY_DELAY_MS = 1_000;
/** The old gateway self-exits ~0.5 s after acknowledging; force-kill only when stuck. */
const OLD_GATEWAY_EXIT_TIMEOUT_MS = 15_000;
/** Let the OS finish releasing the listen socket before the replacement binds. */
const PORT_RELEASE_GRACE_MS = 300;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Verdict of the last controlled startup/restart handover, written by the
 * detached supervisor (console restart / environment switch) and by
 * `startDaemon` (CLI). `ocr status` reads it: a handover that never produced
 * a serving gateway has no HTTP surface left to report through, so the file is
 * the durable answer to "did the restart work?".
 *
 * - `ok`         — a gateway answered `/health` on the expected address.
 * - `unverified` — the spawned process is ALIVE but never answered in budget
 *                  (it may still finish booting; the log has the details).
 * - `failed`     — the process died / could not be spawned; a retry was made
 *                  when the failure was a crash.
 */
export interface RestartStatus {
  status: 'ok' | 'unverified' | 'failed';
  /** Spawn attempts used (1 unless a crash forced a retry). */
  attempts: number;
  startedAt: string;
  finishedAt: string;
  port: number;
  host: string;
  /** Pid of the spawned gateway process when known. */
  pid?: number;
  error?: string;
  logFile: string;
}

export function readRestartStatus(): RestartStatus | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getRestartStatusFilePath(), 'utf8')) as RestartStatus;
    return parsed && typeof parsed === 'object' && ['ok', 'unverified', 'failed'].includes(parsed.status)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Atomic best-effort write: a torn verdict must never be observed. */
function writeRestartStatus(status: RestartStatus): void {
  try {
    const file = getRestartStatusFilePath();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // Observability only — never fail a startup/restart on status reporting.
  }
}

/** Record the gateway a supervisor is bringing up (see the path helper's docblock). */
function writeRestartChildPid(pid: number): void {
  try {
    fs.writeFileSync(getRestartChildPidFilePath(), String(pid), 'utf8');
  } catch {
    // Bookkeeping only — a handover must never fail on it.
  }
}

function readRestartChildPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(getRestartChildPidFilePath(), 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function clearRestartChildPid(): void {
  try {
    fs.rmSync(getRestartChildPidFilePath(), { force: true });
  } catch {
    // benign
  }
}

/**
 * Kill a replacement gateway a supervisor left behind and drop the record.
 *
 * Called by `stopDaemon` AFTER the tracked pid is dead: on Windows the tracked
 * pid is killed with `taskkill /F`, so the supervisor's own `SIGTERM` handler
 * never ran and its detached child (a separate process tree — `Start-Process`
 * reparents it) would otherwise keep booting and bind the port.
 */
function reapInFlightGateway(): void {
  const pid = readRestartChildPid();
  if (pid === null) return;
  if (isProcessAlive(pid)) forceKillProcessTree(pid);
  clearRestartChildPid();
}

/**
 * Shared guts of every detached gateway/supervisor spawn. `extraEnv` carries
 * the per-variant settings; the parent's own environment is inherited by both
 * branches (POSIX via `...process.env`, Windows via Start-Process environment
 * inheritance + inline `set` lines).
 * `omitPortHost` is the env-switch deviation (L3 P1-2): a child booting a
 * DIFFERENT book-set must not inherit/keep PORT/HOST — the target env's own
 * config.yaml decides where it listens (an inherited HOST=0.0.0.0 would force
 * webAuth on in an env that never configured it, killing the child in
 * validateWebAuthStartup AFTER the parent already exited = total outage).
 */
interface GatewayChildSpawnOpts {
  extraEnv: Record<string, string>;
  omitPortHost?: boolean;
  /** stdout/stderr destination; defaults to the gateway log (`ocr.log`). */
  logFile?: string;
}

function childSettings(extraEnv: Record<string, string>): Record<string, string> {
  return { ...extraEnv, NODE_ENV: 'production' };
}

/** Pure POSIX child-env builder — exported so spawn args are assertable without spawning. */
export function buildGatewayChildEnv(opts: GatewayChildSpawnOpts): Record<string, string> {
  const settings = childSettings(opts.extraEnv);
  const base = withoutRestartFlags(process.env);
  if (!opts.omitPortHost) return { ...base, ...settings } as Record<string, string>;
  // Destructure-drops the inherited PORT/HOST before the settings spread.
  const { PORT: _dropPort, HOST: _dropHost, ...rest } = base;
  return { ...rest, ...settings } as Record<string, string>;
}

/**
 * Windows inline `set` chain (PowerShell 5.1 has no -Environment).
 * `set "NAME="` clears an inherited value for the whole cmd child chain: the
 * restart flags ALWAYS (no role inheritance), PORT/HOST only in `omitPortHost`
 * mode (env switch). Settings are emitted AFTER the clears, so a flag the
 * variant WANTS is re-established by its own `set`.
 */
export function buildWindowsEnvSets(opts: GatewayChildSpawnOpts): string {
  const clears = [
    ...RESTART_FLAGS.map((key) => `set "${key}="`),
    ...(opts.omitPortHost ? ['set "PORT="', 'set "HOST="'] : []),
  ].join(' && ');
  const sets = Object.entries(childSettings(opts.extraEnv))
    .map(([k, v]) => `set "${k}=${v}" && `)
    .join('');
  return `${clears} && ${sets}`;
}

/** Detached spawn; returns the spawned process pid (the cmd wrapper on Windows). */
function spawnDetachedGatewayProcess(opts: GatewayChildSpawnOpts): number | null {
  try {
    const { bin, args } = resolveRuntimeBinary();
    // Snapshot mode: the repo layout doesn't exist in an installed app —
    // anchor the detached spawn next to our own exe so the -WorkingDirectory
    // / cwd points at a real directory.
    const repoDir = isCompiledSnapshot() ? path.dirname(process.execPath) : getRepoRootDir();
    const logFile = opts.logFile ?? getLogFilePath();

    if (IS_WINDOWS) {
      // Same Start-Process pattern as startDaemon: hidden cmd wrapper that
      // appends stdout/stderr to the chosen log. Env must be set inline since
      // Start-Process -Environment needs PowerShell 7 (we target 5.1).
      const envSets = buildWindowsEnvSets(opts);
      const cmdLine = `/c "${envSets}"${bin}" ${args.map((a) => `"${a}"`).join(' ')} >> "${logFile}" 2>&1"`;
      const psCmd = `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '${cmdLine.replace(/'/g, "''")}' -WorkingDirectory '${repoDir.replace(/'/g, "''")}' -WindowStyle Hidden -PassThru; $p.Id`;
      const res = spawnSync('powershell', ['-NoProfile', '-Command', psCmd], {
        windowsHide: true,
        encoding: 'utf8',
      });
      const pid = parseInt(res.stdout?.trim() || '0', 10);
      return pid > 0 ? pid : null;
    }

    const logFd = fs.openSync(logFile, 'a');
    try {
      const child = spawn(bin, args, {
        cwd: repoDir,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: buildGatewayChildEnv(opts),
        shell: false,
      });
      child.unref();
      return child.pid ?? null;
    } finally {
      // The child inherited the descriptor; the parent's copy must go (one
      // spawn per handover would otherwise leak a handle until we exit).
      try {
        fs.closeSync(logFd);
      } catch {
        // already closed — never mask a successful spawn
      }
    }
  } catch {
    return null;
  }
}

/** Force-kill a process tree (Windows) / the process (POSIX). Best-effort. */
function forceKillProcessTree(pid: number): void {
  try {
    if (IS_WINDOWS) {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // already gone between check and kill
  }
}

/**
 * Pure spawn-env builders (exported so the handshake args are assertable
 * without spawning). `RESTART_PARENT_ENV` names the old gateway the supervisor
 * must wait for; `RESTART_SUPERVISOR_ENV` puts the spawned process into
 * supervisor mode instead of gateway mode.
 */
export function restartSupervisorEnv(opts: { port: number; host: string }): Record<string, string> {
  return {
    [RESTART_PARENT_ENV]: String(process.pid),
    [RESTART_SUPERVISOR_ENV]: '1',
    PORT: String(opts.port),
    HOST: opts.host,
  };
}

/**
 * Environment-switch variant. CRITICAL difference: NO PORT/HOST is pinned NOR
 * inherited (`omitPortHost`) — the target environment's own config.yaml
 * decides where it listens; OCR_ENV is the only injection. OCR_HOME keeps
 * flowing via parent-env inheritance.
 */
export function envSwitchSupervisorEnv(opts: { envName: string }): Record<string, string> {
  return {
    [RESTART_PARENT_ENV]: String(process.pid),
    [RESTART_SUPERVISOR_ENV]: '1',
    OCR_ENV: opts.envName,
  };
}

/**
 * Spawn a detached restart SUPERVISOR pointed at the same entry. The caller
 * (the serving gateway) exits ~0.5 s later; the supervisor waits for that
 * exit, spawns the replacement, verifies `/health` (retrying a crashed child)
 * and records the verdict. Best-effort: returns false if the spawn fails
 * (caller then keeps serving instead of stopping without a replacement).
 */
export function spawnDetachedRestartChild(opts: { port: number; host: string }): boolean {
  return (
    spawnDetachedGatewayProcess({
      extraEnv: restartSupervisorEnv(opts),
      logFile: getRestartLogFilePath(),
    }) !== null
  );
}

/** Environment-switch variant of `spawnDetachedRestartChild` (see `envSwitchSupervisorEnv`). */
export function spawnDetachedEnvSwitchChild(opts: { envName: string }): boolean {
  return (
    spawnDetachedGatewayProcess({
      extraEnv: envSwitchSupervisorEnv(opts),
      omitPortHost: true,
      logFile: getRestartLogFilePath(),
    }) !== null
  );
}

/** True when this process is the detached handover supervisor. */
export function isRestartSupervisorProcess(): boolean {
  return process.env[RESTART_SUPERVISOR_ENV] === '1';
}

/**
 * Gateway-boot hook: consume the supervisor's self-registration flag.
 * True = this process must write the pid/info files once it is listening.
 */
export function takeRestartSelfRegisterFlag(): boolean {
  const flag = process.env[RESTART_SELF_REGISTER_ENV] === '1';
  delete process.env[RESTART_SELF_REGISTER_ENV];
  return flag;
}

/** Wait for the old gateway to exit, force-killing it when it is stuck. */
async function waitForGatewayExit(pid: number): Promise<void> {
  const deadline = Date.now() + OLD_GATEWAY_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await sleep(200);
  }
  if (isProcessAlive(pid)) forceKillProcessTree(pid);
  await sleep(PORT_RELEASE_GRACE_MS);
}

/**
 * Poll `/health` while the spawned process is alive. A crash short-circuits
 * the wait (the supervisor can retry immediately); a live process gets the
 * full budget before the attempt is called unverified.
 */
async function waitForGatewayHealth(
  pid: number,
  port: number,
  host: string
): Promise<'healthy' | 'exited' | 'timeout'> {
  const deadline = Date.now() + STARTUP_HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await checkServerHealth(port, host)).ok) return 'healthy';
    if (!isProcessAlive(pid)) return 'exited';
    await sleep(300);
  }
  if ((await checkServerHealth(port, host)).ok) return 'healthy';
  // Died inside the last poll window: still a crash (retryable), not "slow".
  return isProcessAlive(pid) ? 'timeout' : 'exited';
}

/**
 * Supervisor target address: pinned PORT/HOST (plain restart) win; otherwise
 * the active env's own config.yaml decides (environment switch).
 */
function resolveSupervisorTarget(): { port: number; host: string } {
  const envPort = parseInt(process.env.PORT || '', 10);
  const envHost = (process.env.HOST || '').trim();
  try {
    const cfg = loadConfig();
    return {
      port: Number.isFinite(envPort) && envPort > 0 ? envPort : cfg.port,
      host: envHost || cfg.host || '127.0.0.1',
    };
  } catch {
    return {
      port: Number.isFinite(envPort) && envPort > 0 ? envPort : defaultGatewayPort(),
      host: envHost || '127.0.0.1',
    };
  }
}

/**
 * Body of the detached restart supervisor (entered from `main()` when
 * `RESTART_SUPERVISOR_ENV` is set). Order matters:
 *
 * 1. consume the handshake flags (a spawned gateway must never nest);
 * 2. wait for the old gateway to exit and release the listen socket;
 * 3. spawn the replacement DETACHED and poll `/health`;
 * 4. retry only when the replacement exited (a crash), never while it lives;
 * 5. record the verdict in `ocr.restart.json` and exit.
 *
 * The supervisor is detached from the caller, so the caller's exit (or the
 * terminal/desktop window closing) cannot kill the handover mid-flight.
 * Returns the process exit code: 0 = a gateway is serving (or a live process
 * still initializing), 1 = the handover failed.
 */
export async function runRestartSupervisor(): Promise<number> {
  const rawOldPid = process.env[RESTART_PARENT_ENV];
  delete process.env[RESTART_PARENT_ENV];
  delete process.env[RESTART_SUPERVISOR_ENV];
  const oldPid = parseInt(rawOldPid || '', 10);

  const { port, host } = resolveSupervisorTarget();
  const logFile = getLogFilePath();
  const startedAt = new Date().toISOString();
  const status: RestartStatus = { status: 'failed', attempts: 0, startedAt, finishedAt: startedAt, port, host, logFile };

  // Take over the daemon pid record for the DURATION of the handover: the
  // desktop shell and `ocr stop` kill the tracked tree, so an in-flight
  // handover must be visible there instead of looking like a dead pid. The
  // gateway child overwrites these files with its own pid once listening.
  try {
    writeDaemonFiles(process.pid, port, host);
  } catch {
    // Best-effort bookkeeping — never fail the handover on it.
  }

  // `ocr stop` / a desktop-shell exit can target this supervisor (see the pid
  // record takeover above). Cancel the attempt instead of leaving a booting
  // gateway behind: kill the in-flight child, record why, then exit.
  //
  // Signals only reach us on POSIX: `ocr stop` on Windows is `taskkill /F`,
  // which has no SIGTERM channel, and `forceKillProcessTree` uses SIGKILL on
  // POSIX. This handler is therefore best-effort by nature — the
  // `ocr.restart.child` record is what lets the killer reap the child in the
  // cases the signal never arrives (see `reapInFlightGateway`).
  let spawnedPid: number | null = null;
  const abortHandover = (): void => {
    if (spawnedPid !== null && isProcessAlive(spawnedPid)) forceKillProcessTree(spawnedPid);
    clearRestartChildPid();
    // A cancelled handover still owes `ocr status` a verdict: the old gateway is
    // gone and the replacement was killed, so silence would read as a success.
    status.status = 'failed';
    status.error = 'restart handover cancelled (OCR stop / shell exit)';
    status.finishedAt = new Date().toISOString();
    writeRestartStatus(status);
    process.exit(130);
  };
  process.once('SIGINT', abortHandover);
  process.once('SIGTERM', abortHandover);

  if (Number.isFinite(oldPid) && oldPid > 0 && oldPid !== process.pid) {
    console.log(`[OCR] Restart supervisor: waiting for the old gateway (pid ${oldPid}) to exit...`);
    await waitForGatewayExit(oldPid);
  }
  console.log(`[OCR] Restart supervisor: starting the replacement on ${host}:${port}...`);

  let lastError = '';
  for (let attempt = 1; attempt <= SUPERVISOR_MAX_ATTEMPTS; attempt++) {
    status.attempts = attempt;
    const pid = spawnDetachedGatewayProcess({ extraEnv: { [RESTART_SELF_REGISTER_ENV]: '1' } });
    if (pid === null) {
      lastError = 'could not spawn the gateway process';
    } else {
      status.pid = pid;
      spawnedPid = pid;
      // Published BEFORE we wait: whoever kills this supervisor mid-handover
      // must be able to find the child it is about to orphan.
      writeRestartChildPid(pid);
      const outcome = await waitForGatewayHealth(pid, port, host);
      if (outcome === 'healthy') {
        status.status = 'ok';
        status.error = undefined;
        status.finishedAt = new Date().toISOString();
        writeRestartStatus(status);
        console.log(`[OCR] Restart supervisor: gateway healthy at ${host}:${port} (pid ${pid}, attempt ${attempt})`);
        spawnedPid = null; // the replacement now owns its own lifecycle
        clearRestartChildPid();
        return 0;
      }
      lastError =
        outcome === 'exited'
          ? `gateway process ${pid} exited before becoming healthy`
          : `gateway process ${pid} did not answer /health within ${Math.round(STARTUP_HEALTH_TIMEOUT_MS / 1000)}s`;
      if (outcome === 'timeout') {
        // A LIVE process owns the listen socket; spawning another would only
        // fight it for the port. Leave it (it may still finish booting) and
        // record the unverified verdict instead of a false failure.
        status.status = 'unverified';
        status.error = lastError;
        status.finishedAt = new Date().toISOString();
        writeRestartStatus(status);
        console.warn(`[OCR] Restart supervisor: ${lastError} — process is still alive, leaving it to finish. See ${logFile}`);
        spawnedPid = null; // a live-but-slow gateway must survive us
        clearRestartChildPid();
        return 0;
      }
    }
    if (attempt < SUPERVISOR_MAX_ATTEMPTS) await sleep(SUPERVISOR_RETRY_DELAY_MS);
  }

  status.status = 'failed';
  status.error = lastError;
  status.finishedAt = new Date().toISOString();
  writeRestartStatus(status);
  clearRestartChildPid();
  console.error(`[OCR] Restart supervisor: gateway FAILED to start after ${status.attempts} attempt(s) — ${lastError}. See ${logFile}`);
  return 1;
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
  // restart-supervisor branch in spawnDetachedGatewayProcess.
  const repoDir = isCompiledSnapshot() ? path.dirname(process.execPath) : getRepoRootDir();

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
    // Windows: launch through `cmd /c "<sets> && <bin> <args> >> <log> 2>&1"`
    // via Start-Process so stdout/stderr append to the daemon log file. The
    // returned PID is the cmd wrapper's; stopDaemon kills the whole tree via
    // taskkill /T. Env must be set inline (PowerShell 5.1 has no -Environment).
    // PORT is ALWAYS pinned from the resolved start port: without it the
    // `--port` flag was silently ignored on Windows (the child bound the
    // config.yaml port while the health check and ocr.info.json reported the
    // requested one). The env chain comes from `buildWindowsEnvSets` — the
    // hand-rolled twin that used to live here drifted from the POSIX builder.
    const envSet = buildWindowsEnvSets({
      extraEnv: {
        PORT: String(port),
        HOST: host,
        ...(options.envName ? { OCR_ENV: options.envName } : {}),
      },
    });
    const cmdLine = `/c "${envSet}"${bin}" ${args.map((a) => `"${a}"`).join(' ')} >> "${logFile}" 2>&1"`;
    const psCmd = `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '${cmdLine.replace(/'/g, "''")}' -WorkingDirectory '${repoDir.replace(/'/g, "''")}' -WindowStyle Hidden -PassThru; $p.Id`;
    const res = spawnSync('powershell', ['-NoProfile', '-Command', psCmd], {
      windowsHide: true,
      encoding: 'utf8',
    });
    pid = parseInt(res.stdout?.trim() || '0', 10);
  } else {
    const logFd = fs.openSync(logFile, 'a');
    const env = buildGatewayChildEnv({
      extraEnv: {
        PORT: String(port),
        HOST: host,
        ...(options.envName ? { OCR_ENV: options.envName } : {}),
      },
    });
    try {
      const child = spawn(bin, args, {
        cwd: repoDir,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env,
        shell: false,
      });
      pid = child.pid || 0;
      child.unref();
    } finally {
      // The child inherited the descriptor; the parent's copy must go (one
      // daemon start would otherwise leak a handle until we exit).
      try {
        fs.closeSync(logFd);
      } catch {
        // already closed — never mask a successful spawn
      }
    }
  }

  if (!pid) {
    const now = new Date().toISOString();
    writeRestartStatus({
      status: 'failed',
      attempts: 1,
      startedAt: now,
      finishedAt: now,
      port,
      host,
      error: 'could not spawn the gateway process',
      logFile,
    });
    return {
      success: false,
      pid: 0,
      port,
      message: `Failed to spawn OCR background process — see ${logFile}`,
    };
  }

  writeDaemonFiles(pid, port, host, envName);

  // Verify the start with the SAME budget the restart supervisor uses. A
  // process that DIED during boot is a definite failure (report it, exit
  // non-zero); a live-but-slow process keeps the historical "initializing"
  // answer and leaves an `unverified` verdict for `ocr status`.
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + STARTUP_HEALTH_TIMEOUT_MS;
  let online = false;
  while (!online && Date.now() < deadline && isProcessAlive(pid)) {
    await sleep(250);
    online = (await checkServerHealth(port, host)).ok;
  }
  if (!online && isProcessAlive(pid)) online = (await checkServerHealth(port, host)).ok;
  const alive = online || isProcessAlive(pid);

  writeRestartStatus({
    status: online ? 'ok' : alive ? 'unverified' : 'failed',
    attempts: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    port,
    host,
    pid,
    ...(online || alive ? {} : { error: `gateway process ${pid} exited before becoming healthy` }),
    logFile,
  });

  if (!alive) {
    return {
      success: false,
      pid,
      port,
      message: `OCR gateway failed to start (PID: ${pid} exited during boot) — see ${logFile}`,
    };
  }

  return {
    success: true,
    pid,
    port,
    message: online
      ? `OCR gateway started successfully in background (PID: ${pid}, Port: ${port})`
      : `OCR gateway started (PID: ${pid}) but is not answering /health yet — check ${logFile} for details.`,
  };
}

export async function stopDaemon(): Promise<{ success: boolean; message: string }> {
  const pid = getRunningPid();
  if (!pid) {
    // No served pid, but a handover may still be booting a replacement.
    reapInFlightGateway();
    return { success: true, message: 'OCR gateway is not currently running.' };
  }

  try {
    if (IS_WINDOWS) {
      // Windows: the tracked PID is the cmd wrapper and the gateway is its
      // child — killing the wrapper alone orphans the gateway, so always kill
      // the whole tree, synchronously (the kill must land before polling).
      forceKillProcessTree(pid);
    } else {
      // POSIX: SIGTERM first — the graceful shutdown flushes breaker, session
      // and rate-limit state before exiting.
      process.kill(pid, 'SIGTERM');
    }
  } catch (err) {
    // `code` is the POSIX errno (`ERR_INVALID_ARG_TYPE` on a bad pid, etc.).
    if (!IS_WINDOWS && (err as NodeJS.ErrnoException).code !== 'ESRCH') {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  }

  // Poll for process exit
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    if (!isProcessAlive(pid)) {
      break;
    }
  }

  if (isProcessAlive(pid)) forceKillProcessTree(pid);

  // The tracked pid may have been a restart supervisor: reap the replacement it
  // had already spawned (Windows `taskkill /F` delivers no cancel signal).
  reapInFlightGateway();

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
  await sleep(800);
  const res = await startDaemon(options);
  return {
    success: res.success,
    // A failed start already carries its own diagnosis (dead process, log
    // path) — prefixing "restarted" would read like it worked.
    message: res.success ? `OCR gateway restarted: ${res.message}` : res.message,
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
  /** Verdict of the last controlled startup/restart — see `RestartStatus`. */
  lastRestart: RestartStatus | null;
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
    lastRestart: readRestartStatus(),
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

  // Native Tauri desktop binary candidates. Names must track
  // desktop/src-tauri/tauri.conf.json (productName drives both the NSIS
  // install dir and the bundled exe name).
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    // installed layout (NSIS, currentUser): %LOCALAPPDATA%\OmniCellRouter\OmniCellRouter.exe
    path.join(localAppData, 'OmniCellRouter', 'OmniCellRouter.exe'),
    // dev bare-run layout: cargo keeps the package name for target/release
    path.join(getRepoRootDir(), 'desktop', 'src-tauri', 'target', 'release', 'omnicell-router-desktop.exe'),
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
    console.log('      (Download native desktop installers at https://github.com/kenlin8827/omnicell-router/releases)');
    await launchWeb(options);
  }
}

/**
 * headroom sidecar lifecycle — association, not ownership (ADR-0005 §6).
 *
 * Model A "detached-resident + adopt-or-spawn": the gateway probes
 * `<url>/health` and reuses whatever answers (a manually started headroom
 * is adopted as-is); only when nothing is listening does it spawn
 * `headroom proxy --host 127.0.0.1 --port <port> --mode cache` as a
 * DETACHED process. The gateway never kills the sidecar on exit: headroom's
 * session-replay state is what keeps upstream prefixes byte-stable across
 * the gateway's own controlled restarts (ADR-0007), so the sidecar is
 * designed to outlive the gateway.
 *
 * Stop semantics: a gateway-spawned pid is recorded at `<home>/headroom.pid`
 * (process-level file, same convention as ocr.pid) and killed directly. A
 * manually started LOCAL instance is stopped just as well — the /health probe
 * confirms the port serves headroom, then the listener pid is discovered by
 * port (loopback URLs only) and terminated. Refusals stay honest: remote
 * instances and unidentifiable listeners are reported, never guessed.
 *
 * Failure posture mirrors the compression stage itself: probing/spawning is
 * fire-and-forget at boot and never blocks or crashes the gateway — the
 * request path stays fail-open regardless of sidecar health.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { getHeadroomPidFilePath } from '../cli/paths.js';

/** Machine-readable failure codes — the console maps them to localized UI text. */
export type HeadroomSidecarErrorCode =
  | 'url-missing' // compression.headroom.url not configured
  | 'not-loopback' // manage (start/stop) refuses non-loopback URLs
  | 'spawn-failed' // headroom CLI could not be spawned
  | 'spawn-exited' // spawned CLI died immediately (e.g. ENOENT → not installed)
  | 'not-ready' // /health never turned 200 within the readiness window
  | 'disabled' // start refused: compression.headroom.enabled is false
  | 'pid-unknown' // stop: running instance whose listener pid cannot be identified
  | 'kill-failed'; // the target pid could not be terminated

/** Minimal shape of the spawned child — real ChildProcess satisfies it. */
export interface HeadroomChildLike {
  pid?: number;
  on?(event: string, listener: (err: Error) => void): void;
  unref?(): void;
}

export type HeadroomSpawnLike = (cmd: string, args: string[], opts: Record<string, unknown>) => HeadroomChildLike;
export type HeadroomKillTreeLike = (pid: number) => boolean;
export type HeadroomPidByPortLike = (port: number) => number | null;

/** Injectable seams so tests exercise the state machine without real processes. */
export interface HeadroomSidecarDeps {
  fetchImpl?: typeof fetch;
  spawnImpl?: HeadroomSpawnLike;
  killTreeImpl?: HeadroomKillTreeLike;
  pidByPortImpl?: HeadroomPidByPortLike;
  pidFilePath?: string;
}

export interface HeadroomSidecarOptions {
  url?: string; // compression.headroom.url (base, e.g. http://127.0.0.1:8787)
  readyTimeoutMs?: number; // default 20000 — /health poll horizon after spawn
  pollIntervalMs?: number; // default 500
}

/** Aggregate view for the console badge (GET /api/admin/headroom/sidecar). */
export interface HeadroomSidecarStatus {
  url: string;
  running: boolean; // something healthy answers <url>/health
  version: string | null; // from the /health payload
  managed: boolean; // a gateway-recorded pid exists and is alive
  pid: number | null;
  error: string | null; // last failure reason (probe failure is NOT an error)
  code: HeadroomSidecarErrorCode | null;
}

export interface HeadroomStartResult {
  ok: boolean;
  reused: boolean; // already running — nothing was spawned
  pid: number | null;
  version: string | null;
  error: string | null; // English operator/log text; UI localization rides `code`
  code: HeadroomSidecarErrorCode | null;
}

export interface HeadroomStopResult {
  ok: boolean;
  stopped: boolean; // false = nothing to stop (or refused to touch an adopted instance)
  pid: number | null;
  error: string | null;
  code: HeadroomSidecarErrorCode | null;
}

const PROBE_TIMEOUT_MS = 1500;
const DEFAULT_READY_TIMEOUT_MS = 20000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const INSTALL_HINT = 'install with: pip install "headroom-ai[all]"';

/* ─── URL helpers ────────────────────────────────────────────────────────── */

function normalizeBase(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** autoStart can only manage a process on THIS machine — loopback hosts only. */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function derivePort(url: string): number {
  const parsed = new URL(url);
  const port = Number(parsed.port);
  return Number.isInteger(port) && port > 0 ? port : 8787;
}

/* ─── Probe ──────────────────────────────────────────────────────────────── */

interface ProbeResult {
  ok: boolean;
  version: string | null;
}

async function probeHeadroom(
  fetchImpl: typeof fetch,
  base: string,
  timeoutMs: number
): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, version: null };
    let version: string | null = null;
    try {
      const body: any = await res.json();
      if (body && typeof body === 'object' && typeof body.version === 'string') version = body.version;
    } catch {
      // A 200 on /health without a JSON body is still a healthy headroom.
    }
    return { ok: true, version };
  } catch {
    return { ok: false, version: null };
  }
}

/* ─── pid record (process-level file, <home>/headroom.pid) ───────────────── */

function readRecordedPid(pidFilePath: string): number | null {
  try {
    const raw = fs.readFileSync(pidFilePath, 'utf8').trim();
    const pid = Number(raw);
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

function writeRecordedPid(pidFilePath: string, pid: number): boolean {
  try {
    fs.writeFileSync(pidFilePath, String(pid), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function removeRecordedPid(pidFilePath: string): void {
  try {
    fs.unlinkSync(pidFilePath);
  } catch {
    // Already gone / never written — nothing to clean up.
  }
}

/* ─── Default process seams ──────────────────────────────────────────────── */

function defaultSpawn(cmd: string, args: string[], opts: Record<string, unknown>): HeadroomChildLike {
  return spawn(cmd, args, opts as never);
}

function defaultKillTree(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      // Tree-kill: headroom may run uvicorn workers; the recorded pid is the
      // root. Same pattern as daemon.ts stop paths.
      const res = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
      return res.status === 0;
    }
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the pid listening on a local port — lets the console stop a manually
 * started LOCAL sidecar it has no pid record for. Callers must have verified
 * via /health that the port currently serves headroom.
 */
function defaultPidByPort(port: number): number | null {
  try {
    if (process.platform === 'win32') {
      const res = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1).OwningProcess`],
        { windowsHide: true, encoding: 'utf8' }
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

/* ─── Operations ─────────────────────────────────────────────────────────── */

export async function getHeadroomSidecarStatus(
  opts: HeadroomSidecarOptions,
  deps: HeadroomSidecarDeps = {}
): Promise<HeadroomSidecarStatus> {
  const base = normalizeBase(opts.url);
  const status: HeadroomSidecarStatus = {
    url: base || opts.url || '',
    running: false,
    version: null,
    managed: false,
    pid: null,
    error: null,
    code: null,
  };
  if (!base) {
    status.error = 'compression.headroom.url is not configured';
    status.code = 'url-missing';
    return status;
  }
  const pidFilePath = deps.pidFilePath ?? getHeadroomPidFilePath();
  const recorded = readRecordedPid(pidFilePath);
  if (recorded !== null && pidAlive(recorded)) {
    status.managed = true;
    status.pid = recorded;
  } else if (recorded !== null) {
    // Stale record from a crashed/killed sidecar — drop it so `managed`
    // stays honest and a later start can re-record cleanly.
    removeRecordedPid(pidFilePath);
  }
  const probe = await probeHeadroom(deps.fetchImpl ?? fetch, base, PROBE_TIMEOUT_MS);
  status.running = probe.ok;
  status.version = probe.version;
  return status;
}

/**
 * Probe → reuse, else detached-spawn + readiness poll. Never throws.
 * Loopback URLs only: a non-loopback base cannot be a process we manage.
 */
export async function startHeadroomSidecar(
  opts: HeadroomSidecarOptions,
  deps: HeadroomSidecarDeps = {}
): Promise<HeadroomStartResult> {
  const base = normalizeBase(opts.url);
  const fail = (code: HeadroomSidecarErrorCode, error: string): HeadroomStartResult => ({
    ok: false,
    reused: false,
    pid: null,
    version: null,
    code,
    error,
  });
  if (!base) return fail('url-missing', 'compression.headroom.url is not configured');
  if (!isLoopbackUrl(base)) {
    return fail('not-loopback', `headroom sidecar auto-start requires a loopback URL (got ${new URL(base).hostname}) — start it manually on the remote host`);
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const first = await probeHeadroom(fetchImpl, base, PROBE_TIMEOUT_MS);
  if (first.ok) return { ok: true, reused: true, pid: readRecordedPid(deps.pidFilePath ?? getHeadroomPidFilePath()), version: first.version, error: null, code: null };

  const port = derivePort(base);
  const spawnImpl = deps.spawnImpl ?? defaultSpawn;
  // Boxed so the 'error' callback assignment is visible across awaits
  // (a bare `let` gets CFA-narrowed to null by TypeScript).
  const spawnState = { error: null as Error | null };
  let child: HeadroomChildLike;
  try {
    child = spawnImpl('headroom', ['proxy', '--host', '127.0.0.1', '--port', String(port), '--mode', 'cache'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
  } catch (err: any) {
    return fail('spawn-failed', `failed to spawn headroom CLI (${err?.message ?? err}) — ${INSTALL_HINT}`);
  }
  child.on?.('error', (err: Error) => {
    spawnState.error = err;
  });
  child.unref?.();

  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (spawnState.error) {
      const code = (spawnState.error as any)?.code;
      const hint = code === 'ENOENT' ? ` — ${INSTALL_HINT}` : '';
      return fail('spawn-exited', `headroom CLI exited immediately (${spawnState.error.message}${code ? ` [${code}]` : ''})${hint}`);
    }
    const probe = await probeHeadroom(fetchImpl, base, PROBE_TIMEOUT_MS);
    if (probe.ok) {
      const pidFilePath = deps.pidFilePath ?? getHeadroomPidFilePath();
      const recorded = child.pid && writeRecordedPid(pidFilePath, child.pid) ? child.pid : null;
      return { ok: true, reused: false, pid: recorded, version: probe.version, error: null, code: null };
    }
    if (Date.now() >= deadline) {
      // The detached process may still be mid-startup (uvicorn boot, Kompress
      // model load). Leave it alone — the next probe/start adopts it if it
      // comes up — but report honestly that this attempt did not confirm.
      return fail('not-ready', `headroom proxy did not become ready within ${Math.round(readyTimeoutMs / 1000)}s (still starting or misconfigured — check headroom's own logs)`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

/**
 * Stop a running sidecar regardless of who started it: a gateway-recorded pid
 * is killed directly; a manually started LOCAL instance is identified by port
 * (the caller just confirmed via /health that the port serves headroom) and
 * killed the same way. Remote instances and unidentifiable listeners are
 * refused with an honest code — never guessed.
 */
export async function stopHeadroomSidecar(
  opts: HeadroomSidecarOptions,
  deps: HeadroomSidecarDeps = {}
): Promise<HeadroomStopResult> {
  const base = normalizeBase(opts.url);
  const pidFilePath = deps.pidFilePath ?? getHeadroomPidFilePath();
  const recorded = readRecordedPid(pidFilePath);
  if (recorded === null) {
    const probe = base ? await probeHeadroom(deps.fetchImpl ?? fetch, base, PROBE_TIMEOUT_MS) : { ok: false };
    if (!probe.ok) {
      return { ok: true, stopped: false, pid: null, error: null, code: null }; // already stopped; clean no-op
    }
    // Running but unrecorded (started manually).
    if (!base || !isLoopbackUrl(base)) {
      return {
        ok: false,
        stopped: false,
        pid: null,
        code: 'not-loopback',
        error: 'headroom is running on a remote host — stop it there manually',
      };
    }
    const discovered = (deps.pidByPortImpl ?? defaultPidByPort)(derivePort(base));
    if (discovered === null) {
      return {
        ok: false,
        stopped: false,
        pid: null,
        code: 'pid-unknown',
        error: 'could not identify the process listening on the port — stop it manually',
      };
    }
    const killTree = deps.killTreeImpl ?? defaultKillTree;
    if (!killTree(discovered)) {
      return { ok: false, stopped: false, pid: discovered, code: 'kill-failed', error: `failed to terminate headroom process ${discovered}` };
    }
    return { ok: true, stopped: true, pid: discovered, error: null, code: null };
  }
  const killTree = deps.killTreeImpl ?? defaultKillTree;
  const killed = killTree(recorded);
  removeRecordedPid(pidFilePath);
  if (!killed) {
    return { ok: false, stopped: false, pid: recorded, code: 'kill-failed', error: `failed to terminate headroom process ${recorded}` };
  }
  return { ok: true, stopped: true, pid: recorded, error: null, code: null };
}

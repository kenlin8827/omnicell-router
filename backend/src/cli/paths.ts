import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export function getOcrHomeDir(): string {
  const home = os.homedir();
  // OCR_HOME override: the isolation substrate for named environments and
  // sandboxed test runs (see config/env.ts). Empty/whitespace = unset.
  // Creation semantics unchanged: ensure the resolved directory exists.
  const override = process.env.OCR_HOME?.trim();
  const dir = override ? path.resolve(override) : path.join(home, '.omnicell-router');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * The one OpenClaw config file, relocated by the vendor's own `OPENCLAW_CONFIG_PATH` (which does
 * NOT follow the state dir). Shared by the takeover client and the harness host adapter so the
 * gateway can never write one file while the runtime reads another.
 */
export function openclawConfigPath(): string {
  const override = process.env.OPENCLAW_CONFIG_PATH?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.openclaw', 'openclaw.json');
}

/** OpenClaw's state root (skills, plugin registry, sidecars), relocated by `OPENCLAW_STATE_DIR`. */
export function openclawStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.openclaw');
}

export function getPidFilePath(): string {
  return path.join(getOcrHomeDir(), 'ocr.pid');
}

export function getLogFilePath(): string {
  return path.join(getOcrHomeDir(), 'ocr.log');
}

export function getInfoFilePath(): string {
  return path.join(getOcrHomeDir(), 'ocr.info.json');
}

/**
 * Pid of the gateway a supervisor is currently bringing up.
 *
 * The supervisor takes over `ocr.pid` for the handover, so `ocr stop` targets
 * the SUPERVISOR — and on Windows the kill is `taskkill /F`, which cannot
 * deliver a signal (see `abortHandover`). This record is what lets the killer
 * reap the in-flight replacement afterwards instead of leaving an orphan that
 * binds the port after `ocr.pid` was already unlinked.
 */
export function getRestartChildPidFilePath(): string {
  return path.join(getOcrHomeDir(), 'ocr.restart.child');
}

/**
 * Verdict of the LAST controlled restart handover, written by the detached
 * restart supervisor (console restart / environment switch) and by
 * `startDaemon` (CLI). `ocr status` reads it so a failed handover that left
 * nothing serving is still discoverable after the fact.
 */
export function getRestartStatusFilePath(): string {
  return path.join(getOcrHomeDir(), 'ocr.restart.json');
}

/**
 * Diagnostics of the detached restart supervisor (handover waiting, spawn
 * attempts, verdict). Kept SEPARATE from `ocr.log`: the supervisor spawns the
 * replacement gateway with `>> ocr.log`, and on Windows two cmd processes
 * appending to one file are fragile while the parent handle is still open —
 * the gateway's own log must never be held by the supervisor.
 */
export function getRestartLogFilePath(): string {
  return path.join(getOcrHomeDir(), 'ocr.restart.log');
}

/** Pid record of a gateway-spawned headroom sidecar (compression/headroom-sidecar.ts). */
export function getHeadroomPidFilePath(): string {
  return path.join(getOcrHomeDir(), 'headroom.pid');
}

export function getDefaultBinDir(): string {
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'omnicell-router', 'bin');
  }
  return path.join(os.homedir(), '.local', 'bin');
}

export function getRepoRootDir(): string {
  // src/cli/paths.ts -> root is two levels up
  const currentDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  return path.resolve(currentDir, '..', '..', '..');
}

/**
 * Are we running inside a `bun build --compile` snapshot (the desktop
 * sidecar)? The ONE definition of "packaged install" — the spawn resolver
 * (`daemon.ts`) and the shim writer (`shim.ts`) must not disagree about it.
 *
 * Verified on bun 1.3.14 (scripts/tmp-probe.ts experiment, 2026-10-18): inside
 * a snapshot Bun.main/import.meta.path live on the virtual embedded FS
 * (Windows: `B:\~BUN\root\…`, POSIX: `/$bunfs/…`); a plain `bun`/node runtime
 * reports a real path. Note Bun.embeddedFiles is [] in BOTH modes on this
 * version — not a signal.
 */
export function compiledSnapshotExe(): boolean {
  try {
    const bunMain = (globalThis as { Bun?: { main?: string } }).Bun?.main;
    if (!bunMain) return false;
    return bunMain.startsWith('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(bunMain);
  } catch {
    return false;
  }
}

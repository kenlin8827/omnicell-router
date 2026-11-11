import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

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
 * Per-user data root shared by EVERY OCR book-set on this machine. Mirrors the
 * desktop shell's default OCR_HOME (`desktop/src-tauri/src/main.rs`
 * `default_ocr_home`): `%LOCALAPPDATA%\omnicell-router` on Windows, the XDG
 * data dir on Linux, `~/Library/Application Support` on macOS.
 *
 * The MITM CA lives here, not under an individual OCR home: a trust anchor is
 * machine state, so the second install must ADOPT the certificate the operator
 * already imported instead of minting a same-CN twin (the `CERT_SIGNATURE_FAILURE`
 * shadowing class). Book-set state (access logs, snapshots) stays under
 * `getOcrHomeDir()`.
 */
export function getSharedDataRootDir(): string {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'omnicell-router');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'omnicell-router');
  }
  const xdg = process.env.XDG_DATA_HOME?.trim();
  return path.join(xdg || path.join(os.homedir(), '.local', 'share'), 'omnicell-router');
}

/**
 * DeepSeek Harness's home (profiles, logs, credential file), relocated by the vendor's own
 * `DSH_HOME` — which accepts a leading `~`. Shared by the CLI hook client and the harness host
 * adapter so both resolve the same profile tree.
 */
export function dshHome(): string {
  const env = process.env.DSH_HOME?.trim();
  if (!env) return path.join(os.homedir(), '.dsh');
  // dsh expands a leading ~ in DSH_HOME itself; mirror that here.
  if (env === '~') return os.homedir();
  if (env.startsWith('~/') || env.startsWith('~\\')) return path.join(os.homedir(), env.slice(2));
  return path.resolve(env);
}

/** DSH's per-profile root: `$DSH_HOME/profiles`, one directory per runnable composition. */
export function dshProfilesDir(): string {
  return path.join(dshHome(), 'profiles');
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

/**
 * The DSH executable the gateway may spawn, resolved dynamically on every call:
 *
 *   1. `DSH_CLI` — explicit operator override (a file, not a directory).
 *   2. PATH — a standalone install (npm/pnpm/bun/volta/…) the user already selected there.
 *   3. Package-manager shim dirs and the desktop app's bundled launcher, so a machine that has
 *      DSH but never registered `dsh` on PATH still works.
 *
 * Falls back to `'dsh'` when nothing exists (the child then reports its own ENOENT). Nothing is
 * cached: a profile/bundle installed while the gateway runs becomes visible on the next plan.
 */
export function dshCliPath(): string {
  const override = process.env.DSH_CLI?.trim();
  if (override) return override;
  return findOnPath() ?? findKnownDsh() ?? 'dsh';
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function dshNames(): string[] {
  if (process.platform !== 'win32') return ['dsh'];
  const pathext = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  // A Windows command is a file with an executable suffix — scanning `dsh.cmd` is how the global
  // npm/pnpm shim is found. A bare `dsh` goes LAST: npm ships an extensionless POSIX script next
  // to it, and picking that one makes CreateProcess fail even though the command exists.
  return [
    ...new Set([
      ...pathext.map((ext) => `dsh${ext}`),
      'dsh.cmd',
      'dsh.exe',
      'dsh.bat',
      'dsh.com',
      'dsh',
    ]),
  ];
}

function findOnPath(): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = dshNames();
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The desktop app's bundled launcher only — no PATH, no package-manager shims. */
export function dshDesktopCliPath(): string | undefined {
  return findLauncher(desktopCliDirs());
}

/**
 * Best-effort preflight: the vendor requires the Electron app to be fully quit before its
 * profile is mutated. Returns false when the probe itself is unavailable, so a missing `tasklist`
 * / `pgrep` never blocks a legitimate install.
 */
export function dshDesktopRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 2000,
      });
      return /deepseek harness\.exe/i.test(out);
    }
    for (const pattern of ['DeepSeek Harness', 'deepseek-harness']) {
      try {
        const out = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8', timeout: 2000 });
        if (out.trim().length > 0) return true;
      } catch {
        // no match for this spelling — try the other one
      }
    }
    return false;
  } catch {
    return false;
  }
}

function desktopCliDirs(): string[] {
  const home = os.homedir();
  const tail = ['resources', 'runtime', 'cli', 'bin'];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    const dirs = local
      ? [
          path.join(local, 'Programs', 'DeepSeek Harness', ...tail),
          path.join(local, 'DeepSeek Harness', ...tail),
        ]
      : [];
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]) {
      if (root) dirs.push(path.join(root, 'DeepSeek Harness', ...tail));
    }
    return dirs;
  }
  if (process.platform === 'darwin') {
    return [
      path.join('/Applications/DeepSeek Harness.app/Contents', ...tail),
      path.join(home, 'Applications/DeepSeek Harness.app/Contents', ...tail),
    ];
  }
  return [
    path.join(home, '.local', 'share', 'DeepSeek Harness', ...tail),
    path.join('/opt', 'DeepSeek Harness', ...tail),
  ];
}

function findLauncher(dirs: string[]): string | undefined {
  const names = dshNames();
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Install roots the vendor/known package managers use; first existing launcher wins. */
function findKnownDsh(): string | undefined {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA;
  const roaming = process.env.APPDATA;
  const dirs = desktopCliDirs();
  if (process.platform === 'win32') {
    if (local) {
      dirs.push(
        path.join(local, 'pnpm'),
        path.join(local, 'Yarn', 'bin'),
        path.join(local, 'Volta', 'bin'),
        path.join(local, 'Microsoft', 'WinGet', 'Links'),
        path.join(local, 'Microsoft', 'WindowsApps')
      );
    }
    if (roaming) dirs.push(path.join(roaming, 'npm'));
    dirs.push(
      path.join(home, '.bun', 'bin'),
      path.join(home, '.asdf', 'shims'),
      path.join(home, 'scoop', 'shims'),
      path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'bin')
    );
  } else if (process.platform === 'darwin') {
    dirs.push(
      '/usr/local/bin',
      '/opt/homebrew/bin',
      path.join(home, '.bun', 'bin'),
      path.join(home, '.local', 'bin'),
      path.join(home, 'Library', 'pnpm'),
      path.join(home, '.yarn', 'bin'),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.asdf', 'shims'),
      path.join(home, '.local', 'share', 'mise', 'shims')
    );
  } else {
    dirs.push(
      '/usr/local/bin',
      '/usr/bin',
      '/snap/bin',
      path.join(home, '.local', 'bin'),
      path.join(home, '.local', 'share', 'pnpm'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.yarn', 'bin'),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.asdf', 'shims'),
      path.join(home, '.local', 'share', 'mise', 'shims')
    );
  }
  for (const prefix of [process.env.PNPM_HOME, process.env.NPM_CONFIG_PREFIX, process.env.npm_config_prefix]) {
    if (prefix) dirs.push(path.join(prefix, 'bin'), prefix);
  }
  return findLauncher(dirs);
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

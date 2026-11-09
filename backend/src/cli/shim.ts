import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { compiledSnapshotExe, getDefaultBinDir, getRepoRootDir } from './paths.js';

/** Repo-checkout trampolines: shell out to bun/node + backend/src/cli/index.ts. */
const TRAMPOLINE_MARKER = 'omnicell-router-trampoline';
/** Packaged (desktop) shims: call the compiled `ocr-backend --cli` directly. */
const SELF_MARKER = 'omnicell-router-self-shim';

const COMMANDS = ['ocr', 'omnicell-router'];
const WINDOWS_EXTENSIONS = ['.cmd', '.ps1'];

export interface ShimRegistrationResult {
  success: boolean;
  binDir: string;
  message: string;
}

/**
 * A packaged install ships the compiled gateway as `ocr-backend` and has no
 * repo checkout (and no bun/node) to trampoline into. In that case the shims
 * target the binary itself: `index.ts` accepts `--cli` and hands control to
 * the CLI surface, so one file serves both the server and the `ocr` command.
 *
 * Packaged-vs-checkout is `compiledSnapshotExe()` — the SAME predicate the
 * spawn resolver uses. An `fs.existsSync` probe on the source entry is not a
 * substitute: inside a compiled snapshot that path lives on bun's virtual
 * embedded FS and answers true, which would write a trampoline to a file no
 * installed app can run.
 */
function packagedExecutable(forcePackaged: boolean): string | null {
  if (!forcePackaged && !compiledSnapshotExe()) return null;
  const exec = process.execPath;
  return exec && fs.existsSync(exec) ? exec : null;
}

/**
 * Home the shim should pin: a packaged install (the desktop app) runs the
 * gateway under its OWN `OCR_HOME` (Windows: `%LOCALAPPDATA%\omnicell-router`),
 * while the CLI default is `~/.omnicell-router`. A shim that leaves OCR_HOME
 * unset would therefore read a different book-set than the app that wrote it —
 * `ocr status` reporting "not running" for a live desktop gateway. Pin the
 * installing process's home into the shim; unset stays unset (plain CLI
 * installs keep the documented default).
 */
function pinnedHome(): string | null {
  const override = process.env.OCR_HOME?.trim();
  if (!override) return null;
  // Same resolution `getOcrHomeDir` applies, minus its mkdir side effect.
  return path.resolve(override);
}

/** One `export OCR_HOME=…` / `set "OCR_HOME=…"` line, empty when unpinned. */
function homeLine(pin: string | null, isWindows: boolean): string {
  if (!pin) return '';
  return isWindows ? `set "OCR_HOME=${pin}"\r\n` : `OCR_HOME=${quoted(pin)}\n`;
}

/** PowerShell flavour: single-quoted literal, '' escapes an embedded quote. */
function homeLinePs1(pin: string | null): string {
  if (!pin) return '';
  return `$env:OCR_HOME = '${pin.replace(/'/g, "''")}'\r\n`;
}

/** Strings safe inside a double-quoted `sh` word / Windows command line. */
function quoted(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function writeSelfShims(binDir: string, exe: string, isWindows: boolean): void {
  const pin = pinnedHome();
  for (const name of COMMANDS) {
    if (isWindows) {
      const cmd = `@echo off\r\nrem ${SELF_MARKER}\r\n${homeLine(pin, true)}${quoted(exe)} --cli %*\r\nexit /b %ERRORLEVEL%\r\n`;
      const ps1 = `# ${SELF_MARKER}\r\n${homeLinePs1(pin)}& ${quoted(exe)} --cli @args\r\nexit $LASTEXITCODE\r\n`;
      fs.writeFileSync(path.join(binDir, `${name}.cmd`), cmd, 'utf8');
      fs.writeFileSync(path.join(binDir, `${name}.ps1`), ps1, 'utf8');
    } else {
      const sh = `#!/bin/sh\n# ${SELF_MARKER}\n${homeLine(pin, false)}exec ${quoted(exe)} --cli "$@"\n`;
      writeExecutable(path.join(binDir, name), sh);
    }
  }
}

/**
 * Write a POSIX shim and FORCE the exec bit. `{ mode: 0o755 }` in
 * writeFileSync only applies when the file is CREATED — an `ocr` that already
 * exists unexecutable (restored from a backup, copied, hand-created) would
 * otherwise be overwritten 0644 and silently become non-runnable.
 */
function writeExecutable(file: string, body: string): void {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

export interface ShimRegisterOptions {
  /** Register the bin dir on the user PATH (default true). */
  writePath?: boolean;
  /**
   * Test seam for "this is a compiled-snapshot install": `compiledSnapshotExe()`
   * can only answer inside a real `bun build --compile` binary, so the packaged
   * branch (self shims) is otherwise unreachable from a source run.
   */
  packagedInstall?: boolean;
}

export function registerGlobalShims(
  customRepoDir?: string,
  customBinDir?: string,
  opts: ShimRegisterOptions = {}
): ShimRegistrationResult {
  const repoDir = customRepoDir || getRepoRootDir();
  const binDir = customBinDir || getDefaultBinDir();
  const isWindows = process.platform === 'win32';

  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  const selfExe = packagedExecutable(opts.packagedInstall === true);
  if (selfExe) {
    writeSelfShims(binDir, selfExe, isWindows);
    if (opts.writePath !== false) {
      if (isWindows) ensureWindowsPath(binDir);
      else ensurePosixPath(binDir);
    }
    return {
      success: true,
      binDir,
      message: `Registered global shims (ocr, omnicell-router) in ${binDir} -> ${selfExe} --cli.`,
    };
  }

  // Ensure repo/bin exists
  const repoBinDir = path.join(repoDir, 'bin');
  if (!fs.existsSync(repoBinDir)) {
    fs.mkdirSync(repoBinDir, { recursive: true });
  }

  const commands = COMMANDS.map(name => ({ name, script: name }));

  if (isWindows) {
    for (const cmd of commands) {
      const targetCmd = path.join(binDir, `${cmd.name}.cmd`);
      const targetPs1 = path.join(binDir, `${cmd.name}.ps1`);

      // Script that invokes Bun or Node to run backend/src/cli/index.ts
      const cliEntry = path.join(repoDir, 'backend', 'src', 'cli', 'index.ts');
      const distEntry = fs.existsSync(path.join(repoDir, 'backend', 'dist', 'cli', 'index.js'))
        ? path.join(repoDir, 'backend', 'dist', 'cli', 'index.js')
        : path.join(repoDir, 'dist', 'cli', 'index.js');

      const cmdContent = `@echo off\r\nrem ${TRAMPOLINE_MARKER}\r\nsetlocal\r\nwhere bun >nul 2>nul\r\nif %ERRORLEVEL% equ 0 (\r\n  bun run "${cliEntry}" %*\r\n  exit /b %ERRORLEVEL%\r\n)\r\nif exist "%USERPROFILE%\\.bun\\bin\\bun.exe" (\r\n  "%USERPROFILE%\\.bun\\bin\\bun.exe" run "${cliEntry}" %*\r\n  exit /b %ERRORLEVEL%\r\n)\r\nwhere node >nul 2>nul\r\nif %ERRORLEVEL% equ 0 (\r\n  if exist "${distEntry}" (\r\n    node "${distEntry}" %*\r\n    exit /b %ERRORLEVEL%\r\n  )\r\n  npx tsx "${cliEntry}" %*\r\n  exit /b %ERRORLEVEL%\r\n)\r\necho [OCR ERROR] Neither bun nor node found on PATH.\r\nexit /b 1\r\n`;

      const ps1Content = `# ${TRAMPOLINE_MARKER}\r\n$cliEntry = "${cliEntry.replace(/\\/g, '\\\\')}"\r\n$distEntry = "${distEntry.replace(/\\/g, '\\\\')}"\r\n$bun = Get-Command bun -ErrorAction SilentlyContinue\r\nif ($bun) {\r\n  & bun run $cliEntry @args\r\n  exit $LASTEXITCODE\r\n}\r\n$bunDefault = Join-Path $env:USERPROFILE ".bun\\bin\\bun.exe"\r\nif (Test-Path $bunDefault) {\r\n  & $bunDefault run $cliEntry @args\r\n  exit $LASTEXITCODE\r\n}\r\n$node = Get-Command node -ErrorAction SilentlyContinue\r\nif ($node) {\r\n  if (Test-Path $distEntry) {\r\n    & node $distEntry @args\r\n  } else {\r\n    & npx tsx $cliEntry @args\r\n  }\r\n  exit $LASTEXITCODE\r\n}\r\nWrite-Error "[OCR ERROR] Neither bun nor node found in PATH."\r\nexit 1\r\n`;

      fs.writeFileSync(targetCmd, cmdContent, 'utf8');
      fs.writeFileSync(targetPs1, ps1Content, 'utf8');
    }

    // Check Windows User PATH
    if (opts.writePath !== false) ensureWindowsPath(binDir);

    return {
      success: true,
      binDir,
      message: `Registered Windows global shims (ocr, omnicell-router) in ${binDir}.`,
    };
  } else {
    // POSIX shell trampolines
    for (const cmd of commands) {
      const targetSh = path.join(binDir, cmd.name);
      const cliEntry = path.join(repoDir, 'backend', 'src', 'cli', 'index.ts');
      const distEntry = path.join(repoDir, 'dist', 'cli', 'index.js');

      const shContent = `#!/usr/bin/env bash\n# ${TRAMPOLINE_MARKER}\nif command -v bun >/dev/null 2>&1; then\n  exec bun run "${cliEntry}" "$@"\nelif command -v node >/dev/null 2>&1; then\n  if [ -f "${distEntry}" ]; then\n    exec node "${distEntry}" "$@"\n  else\n    exec npx tsx "${cliEntry}" "$@"\n  fi\nelse\n  echo "[OCR ERROR] Neither bun nor node found in PATH." >&2\n  exit 1\nfi\n`;

      writeExecutable(targetSh, shContent);
    }

    if (opts.writePath !== false) ensurePosixPath(binDir);

    return {
      success: true,
      binDir,
      message: `Registered POSIX global shims (ocr, omnicell-router) in ${binDir}.`,
    };
  }
}

/**
 * Remove the shims this PRODUCT wrote (marker-checked), regardless of which
 * install mode wrote them.
 *
 * Matching BOTH markers is deliberate: a marker records which install WROTE the
 * file, not which install is running now, and both flavours target the same
 * filenames (`ocr`, `omnicell-router`) in one bin dir — so the last install wins
 * and the other one's marker is what usually sits on disk. When the writing
 * checkout is gone, a single-marker match leaves an `ocr` pointing at a deleted
 * entry with no command able to remove it. A file carrying NEITHER marker was
 * not written by us and is never touched.
 */
export function unregisterGlobalShims(_customRepoDir?: string, customBinDir?: string): {
  binDir: string;
  removed: string[];
} {
  const binDir = customBinDir || getDefaultBinDir();
  const markers = [SELF_MARKER, TRAMPOLINE_MARKER];
  const removed: string[] = [];

  if (!fs.existsSync(binDir)) return { binDir, removed };

  for (const name of COMMANDS) {
    for (const ext of process.platform === 'win32' ? WINDOWS_EXTENSIONS : ['', '.cmd', '.ps1']) {
      const target = path.join(binDir, `${name}${ext}`);
      if (!fs.existsSync(target)) continue;
      try {
        const body = fs.readFileSync(target, 'utf8');
        if (!markers.some((marker) => body.includes(marker))) continue;
        fs.rmSync(target);
        removed.push(target);
      } catch {
        // benign — a locked shim is retried on the next uninstall
      }
    }
  }
  return { binDir, removed };
}

function ensureWindowsPath(binDir: string): void {
  try {
    const currentPath = process.env.PATH || '';
    if (!currentPath.toLowerCase().includes(binDir.toLowerCase())) {
      // Add to user environment via powershell without throwing
      const psCmd = `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${binDir}', 'User')`;
      spawnSync('powershell', ['-NoProfile', '-Command', psCmd], { windowsHide: true });
    }
  } catch {
    // benign
  }
}

function ensurePosixPath(binDir: string): void {
  try {
    const currentPath = process.env.PATH || '';
    if (!currentPath.includes(binDir)) {
      const home = os.homedir();
      const rcFiles = ['.bashrc', '.zshrc', '.profile'];
      for (const rc of rcFiles) {
        const rcPath = path.join(home, rc);
        if (fs.existsSync(rcPath)) {
          const content = fs.readFileSync(rcPath, 'utf8');
          if (!content.includes(binDir)) {
            fs.appendFileSync(rcPath, `\n# OmniCellRouter (ocr) binary path\nexport PATH="${binDir}:$PATH"\n`);
          }
        }
      }
    }
  } catch {
    // benign
  }
}

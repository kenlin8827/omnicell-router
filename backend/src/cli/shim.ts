import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { getDefaultBinDir, getRepoRootDir } from './paths.js';

const SHIM_MARKER = 'onecast-router-trampoline';

export function registerGlobalShims(customRepoDir?: string, customBinDir?: string): {
  success: boolean;
  binDir: string;
  message: string;
} {
  const repoDir = customRepoDir || getRepoRootDir();
  const binDir = customBinDir || getDefaultBinDir();
  const isWindows = process.platform === 'win32';

  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  // Ensure repo/bin exists
  const repoBinDir = path.join(repoDir, 'bin');
  if (!fs.existsSync(repoBinDir)) {
    fs.mkdirSync(repoBinDir, { recursive: true });
  }

  const commands = [
    { name: 'ocr', script: 'ocr' },
    { name: 'onecast-router', script: 'onecast-router' },
  ];

  if (isWindows) {
    for (const cmd of commands) {
      const targetCmd = path.join(binDir, `${cmd.name}.cmd`);
      const targetPs1 = path.join(binDir, `${cmd.name}.ps1`);

      // Script that invokes Bun or Node to run backend/src/cli/index.ts
      const cliEntry = path.join(repoDir, 'backend', 'src', 'cli', 'index.ts');
      const distEntry = fs.existsSync(path.join(repoDir, 'backend', 'dist', 'cli', 'index.js'))
        ? path.join(repoDir, 'backend', 'dist', 'cli', 'index.js')
        : path.join(repoDir, 'dist', 'cli', 'index.js');

      const cmdContent = `@echo off\r\nrem ${SHIM_MARKER}\r\nsetlocal\r\nwhere bun >nul 2>nul\r\nif %ERRORLEVEL% equ 0 (\r\n  bun run "${cliEntry}" %*\r\n  exit /b %ERRORLEVEL%\r\n)\r\nif exist "%USERPROFILE%\\.bun\\bin\\bun.exe" (\r\n  "%USERPROFILE%\\.bun\\bin\\bun.exe" run "${cliEntry}" %*\r\n  exit /b %ERRORLEVEL%\r\n)\r\nwhere node >nul 2>nul\r\nif %ERRORLEVEL% equ 0 (\r\n  if exist "${distEntry}" (\r\n    node "${distEntry}" %*\r\n    exit /b %ERRORLEVEL%\r\n  )\r\n  npx tsx "${cliEntry}" %*\r\n  exit /b %ERRORLEVEL%\r\n)\r\necho [OCR ERROR] Neither bun nor node found on PATH.\r\nexit /b 1\r\n`;

      const ps1Content = `# ${SHIM_MARKER}\r\n$cliEntry = "${cliEntry.replace(/\\/g, '\\\\')}"\r\n$distEntry = "${distEntry.replace(/\\/g, '\\\\')}"\r\n$bun = Get-Command bun -ErrorAction SilentlyContinue\r\nif ($bun) {\r\n  & bun run $cliEntry @args\r\n  exit $LASTEXITCODE\r\n}\r\n$bunDefault = Join-Path $env:USERPROFILE ".bun\\bin\\bun.exe"\r\nif (Test-Path $bunDefault) {\r\n  & $bunDefault run $cliEntry @args\r\n  exit $LASTEXITCODE\r\n}\r\n$node = Get-Command node -ErrorAction SilentlyContinue\r\nif ($node) {\r\n  if (Test-Path $distEntry) {\r\n    & node $distEntry @args\r\n  } else {\r\n    & npx tsx $cliEntry @args\r\n  }\r\n  exit $LASTEXITCODE\r\n}\r\nWrite-Error "[OCR ERROR] Neither bun nor node found in PATH."\r\nexit 1\r\n`;

      fs.writeFileSync(targetCmd, cmdContent, 'utf8');
      fs.writeFileSync(targetPs1, ps1Content, 'utf8');
    }

    // Check Windows User PATH
    ensureWindowsPath(binDir);

    return {
      success: true,
      binDir,
      message: `Registered Windows global shims (ocr, onecast-router) in ${binDir}.`,
    };
  } else {
    // POSIX shell trampolines
    for (const cmd of commands) {
      const targetSh = path.join(binDir, cmd.name);
      const cliEntry = path.join(repoDir, 'backend', 'src', 'cli', 'index.ts');
      const distEntry = path.join(repoDir, 'dist', 'cli', 'index.js');

      const shContent = `#!/usr/bin/env bash\n# ${SHIM_MARKER}\nif command -v bun >/dev/null 2>&1; then\n  exec bun run "${cliEntry}" "$@"\nelif command -v node >/dev/null 2>&1; then\n  if [ -f "${distEntry}" ]; then\n    exec node "${distEntry}" "$@"\n  else\n    exec npx tsx "${cliEntry}" "$@"\n  fi\nelse\n  echo "[OCR ERROR] Neither bun nor node found in PATH." >&2\n  exit 1\nfi\n`;

      fs.writeFileSync(targetSh, shContent, { mode: 0o755 });
    }

    ensurePosixPath(binDir);

    return {
      success: true,
      binDir,
      message: `Registered POSIX global shims (ocr, onecast-router) in ${binDir}.`,
    };
  }
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

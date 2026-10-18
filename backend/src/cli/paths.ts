import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export function getOcrHomeDir(): string {
  const home = os.homedir();
  // OCR_HOME override: the isolation substrate for named environments and
  // sandboxed test runs (see config/env.ts). Empty/whitespace = unset.
  // Creation semantics unchanged: ensure the resolved directory exists.
  const override = process.env.OCR_HOME?.trim();
  const dir = override ? path.resolve(override) : path.join(home, '.opencode-router');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
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

/** Pid record of a gateway-spawned headroom sidecar (compression/headroom-sidecar.ts). */
export function getHeadroomPidFilePath(): string {
  return path.join(getOcrHomeDir(), 'headroom.pid');
}

export function getDefaultBinDir(): string {
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'opencode-router', 'bin');
  }
  return path.join(os.homedir(), '.local', 'bin');
}

export function getRepoRootDir(): string {
  // src/cli/paths.ts -> root is two levels up
  const currentDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  return path.resolve(currentDir, '..', '..', '..');
}

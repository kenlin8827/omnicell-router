import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Compile-time version injection for embedded builds: the desktop sidecar is
 * a bun build --compile snapshot living on a virtual FS with NO package.json
 * on disk, so the runtime resolution below returns the '0.0.0' fallback
 * there. desktop/scripts/build-sidecar.ts passes the repo root version via
 * --define. Undefined in every other runtime (source, node dist) — the
 * typeof guard keeps those on the file-based resolution.
 */
declare const __OCR_VERSION__: string | undefined;

/**
 * Resolve the application version at runtime.
 * Single source of truth: the repository root package.json.
 * Works both from source (backend/src/version.ts) and compiled output
 * (backend/dist/version.js) — both sit two levels below the repo root.
 */
function resolveAppVersion(): string {
  const candidates = [
    path.resolve(here, '../../package.json'), // repo root
    path.resolve(here, '../package.json'), // backend/package.json fallback
  ];
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string };
      if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
    } catch {
      // fall through to the next candidate
    }
  }
  return '0.0.0';
}

export const APP_VERSION: string =
  typeof __OCR_VERSION__ !== 'undefined' && __OCR_VERSION__
    ? __OCR_VERSION__
    : resolveAppVersion();

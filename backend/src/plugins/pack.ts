import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, type Zippable } from 'fflate';

/**
 * The ONE plugin packager: `scripts/build-plugins.ts` writes its zips with it
 * and the console's package export (`GET /api/admin/plugins/:id/package`)
 * zips a dev-tree plugin with it. Sharing the walker means an exported dev
 * plugin is the same bytes `plugins:build` would have written — a download
 * round-trips through Install, and `plugins:check` still catches drift.
 */

/**
 * Fixed entry mtime for every packaged file. Without it fflate stamps the
 * CURRENT time into the zip (2-second DOS resolution), so two runs seconds
 * apart produce different bytes — which makes `--check` (and any byte-level
 * drift guard) fail unconditionally. A fixed stamp makes the package
 * reproducible: same sources ⇒ same bytes, forever.
 */
const ZIP_ENTRY_MTIME = new Date('2000-01-01T00:00:00Z');

/** Files one plugin ships — the whole dir minus editor junk. Symlinks are
 *  skipped rather than followed: this walker also runs behind an HTTP route,
 *  where following a link would turn export into an arbitrary-file read. */
export function collectPluginFiles(dir: string): Zippable {
  const out: Zippable = {};
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    for (const name of readdirSync(abs)) {
      if (name === '.' || name === '..' || name.startsWith('.')) continue;
      const child = rel ? `${rel}/${name}` : name;
      const childAbs = join(abs, name);
      const stat = lstatSync(childAbs);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(child);
      else out[child] = [new Uint8Array(readFileSync(childAbs)), { mtime: ZIP_ENTRY_MTIME }];
    }
  };
  walk('');
  return out;
}

/** Deterministic zip of one plugin directory (manifest at the archive root). */
export function zipPluginDir(dir: string): Uint8Array {
  return zipSync(collectPluginFiles(dir));
}

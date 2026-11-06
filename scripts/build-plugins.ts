/**
 * Plugin packager: zip every `plugins/<id>/` that carries a
 * plugin.json into `<ocrHome>/plugins/<id>.zip`. The runtime host
 * (backend/src/plugins/host.ts) extracts stale packages on boot and imports
 * the entry. Run via `bun run plugins:build`; wired into the root build.
 *
 * Usage: bun scripts/build-plugins.ts [--check]   (--check: exit 1 on drift, CI mode)
 */
import { zipSync } from 'fflate';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePluginManifest } from '../backend/src/plugins/manifest.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(repoRoot, 'plugins');

function ocrHome(): string {
  const override = process.env.OCR_HOME?.trim();
  if (override) return override;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!home) throw new Error('cannot resolve OCR home (no USERPROFILE/HOME)');
  return join(home, '.omnicell-router');
}

// plugin.json IS the single manifest truth, so the packager and the runtime
// loader (backend/src/plugins/host.ts) share ONE validator — a manifest that
// passes here can never fail at load.
const validateManifest = (manifest: unknown, dirName: string): void =>
  validatePluginManifest(manifest, `[plugins] ${dirName}/plugin.json invalid`);

/**
 * Fixed entry mtime for every packaged file. Without it fflate stamps the
 * CURRENT time into the zip (2-second DOS resolution), so two runs seconds
 * apart produce different bytes — which makes `--check` (and any byte-level
 * drift guard) fail unconditionally. A fixed stamp makes the package
 * reproducible: same sources ⇒ same bytes, forever.
 */
const ZIP_ENTRY_MTIME = new Date('2000-01-01T00:00:00Z');

/** Files one plugin ships — the whole dir minus editor junk. */
function collect(dir: string): Record<string, [Uint8Array, { mtime: Date }]> {
  const out: Record<string, [Uint8Array, { mtime: Date }]> = {};
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    for (const name of readdirSync(abs)) {
      if (name === '.' || name === '..' || name.startsWith('.')) continue;
      const child = rel ? `${rel}/${name}` : name;
      const childAbs = join(abs, name);
      if (statSync(childAbs).isDirectory()) walk(child);
      else out[child] = [new Uint8Array(readFileSync(childAbs)), { mtime: ZIP_ENTRY_MTIME }];
    }
  };
  walk('');
  return out;
}

const check = process.argv.includes('--check');
const home = ocrHome();
const destRoot = join(home, 'plugins');
if (!existsSync(srcRoot)) {
  console.log(`[plugins] no plugins/ source dir — nothing to package`);
  process.exit(0);
}
let built = 0;
let drift = 0;
for (const name of readdirSync(srcRoot)) {
  const dir = join(srcRoot, name);
  if (!existsSync(join(dir, 'plugin.json'))) continue;
  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
  validateManifest(manifest, name);
  if (manifest.id !== name) {
    console.error(`[plugins] ${name}/plugin.json id "${manifest.id}" does not match directory name`);
    process.exit(1);
  }
  mkdirSync(destRoot, { recursive: true });
  const dest = join(destRoot, `${name}.zip`);
  const zipped = zipSync(collect(dir));
  if (check) {
    const existing = existsSync(dest) ? new Uint8Array(readFileSync(dest)) : undefined;
    const same =
      existing?.length === zipped.length && existing.every((b, i) => b === zipped[i]);
    if (!same) {
      console.error(`[plugins] drift: ${dest} is older than plugins/${name}/ (run \`bun run plugins:build\`)`);
      drift++;
    }
  } else {
    writeFileSync(dest, zipped);
    console.log(`[plugins] packaged ${name} -> ${dest} (${zipped.length} bytes)`);
  }
  built++;
}
if (check && drift > 0) process.exit(1);
console.log(`[plugins] ${built} plugin(s) ${check ? 'checked' : 'packaged'}`);

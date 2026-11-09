/**
 * Plugin packager: bundle + zip every `plugins/<id>/` that carries a
 * plugin.json into `<repo>/.plugin-dist/<id>.zip` — a build OUTPUT inside the
 * repo, never the user's OCR home: `bun run build` must not touch operator
 * state, and a zip dropped in the runtime root is shadowed by the dev tree
 * anyway. Install one through the console's upload, or unzip it by hand.
 * Run via `bun run plugins:build`; wired into the root build.
 *
 * The entry is BUNDLED (third-party imports inlined) because released hosts
 * are compiled executables that cannot resolve packages from disk: a
 * source-only zip fails to load at install time. See ADR-0017 §6.
 *
 * Usage: bun scripts/build-plugins.ts [--check]   (--check: exit 1 on drift, CI mode)
 *
 * `--check` compares BYTES, so it must run on the platform the artifact is
 * published from: Bun's bundler output is stable within one OS/arch (fixed
 * entry mtimes, sorted walk, cwd-independent headers — see pack.ts), but it is
 * not guaranteed identical ACROSS platforms, so pinning the check to one OS in
 * CI is the correct setup rather than expecting a Windows dev and a Linux
 * runner to agree byte for byte.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePluginManifest } from '../backend/src/plugins/manifest.js';
import { bundlePluginDir } from '../backend/src/plugins/pack.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(repoRoot, 'plugins');

// plugin.json IS the single manifest truth, so the packager and the runtime
// loader (backend/src/plugins/host.ts) share ONE validator — a manifest that
// passes here can never fail at load.
const validateManifest = (manifest: unknown, dirName: string): void =>
  validatePluginManifest(manifest, `[plugins] ${dirName}/plugin.json invalid`);

const check = process.argv.includes('--check');
// Build output, owned entirely by this script: safe to prune, and never the
// runtime plugins root (ADR-0017 §6).
const destRoot = join(repoRoot, '.plugin-dist');
const produced = new Set<string>();
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
  produced.add(`${name}.zip`);
  let zipped: Uint8Array;
  try {
    zipped = await bundlePluginDir(dir);
  } catch (err) {
    console.error(`[plugins] ${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
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
if (!check) {
  // A package whose source was removed must not linger in the artifact dir.
  for (const stale of existsSync(destRoot) ? readdirSync(destRoot) : []) {
    if (/\.zip$/i.test(stale) && !produced.has(stale)) {
      rmSync(join(destRoot, stale), { force: true });
      console.log(`[plugins] pruned stale ${stale}`);
    }
  }
}
if (check && drift > 0) process.exit(1);
console.log(`[plugins] ${built} plugin(s) ${check ? 'checked' : 'packaged'}`);

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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(repoRoot, 'plugins');

function ocrHome(): string {
  const override = process.env.OCR_HOME?.trim();
  if (override) return override;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!home) throw new Error('cannot resolve OCR home (no USERPROFILE/HOME)');
  return join(home, '.omnicell-router');
}

/** Structural validation of plugin.json — plugin.json IS the single manifest
 *  truth (the runtime module declares no manifest), so a broken or partial
 *  JSON must fail the build, never ship. Kept in sync with
 *  backend/src/plugins/types.ts PluginManifest by contract. */
function validateManifest(manifest: unknown, dirName: string): void {
  const fail = (msg: string): never => {
    throw new Error(`[plugins] ${dirName}/plugin.json invalid: ${msg}`);
  };
  if (typeof manifest !== 'object' || manifest === null) fail('not an object');
  const m = manifest as Record<string, unknown>;
  if (typeof m.id !== 'string' || !m.id) fail('id must be a non-empty string');
  if (typeof m.name !== 'string' || !m.name) fail('name must be a non-empty string');
  if (typeof m.version !== 'string' || !m.version) fail('version must be a non-empty string');
  if (m.type !== 'model-service') fail('type must be "model-service"');
  if (!Array.isArray(m.wires) || m.wires.length === 0 || !m.wires.every((w) => typeof w === 'string' && w)) {
    fail('wires must be a non-empty string array');
  }
  if (m.logo !== undefined && typeof m.logo !== 'string') fail('logo must be a string');
  if (m.description !== undefined && typeof m.description !== 'string' && (typeof m.description !== 'object' || m.description === null)) {
    fail('description must be a string or locale map');
  }
  if (m.presets !== undefined) {
    if (!Array.isArray(m.presets)) fail('presets must be an array');
    for (const preset of m.presets) {
      const p = preset as Record<string, unknown>;
      if (typeof p !== 'object' || p === null) fail('preset must be an object');
      if (typeof p.presetId !== 'string' || !p.presetId) fail('preset.presetId must be a non-empty string');
      if (typeof p.providerId !== 'string' || !p.providerId) fail('preset.providerId must be a non-empty string');
      if (typeof p.npm !== 'string' || !p.npm) fail('preset.npm must be a non-empty string');
      if (typeof p.baseUrl !== 'string' || !p.baseUrl) fail('preset.baseUrl must be a non-empty string');
      if (p.displayName !== undefined && typeof p.displayName !== 'string' && (typeof p.displayName !== 'object' || p.displayName === null)) {
        fail('preset.displayName must be a string or locale map');
      }
    }
  }
}

/** Files one plugin ships — the whole dir minus editor junk. */
function collect(dir: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    for (const name of readdirSync(abs)) {
      if (name === '.' || name === '..' || name.startsWith('.')) continue;
      const child = rel ? `${rel}/${name}` : name;
      const childAbs = join(abs, name);
      if (statSync(childAbs).isDirectory()) walk(child);
      else out[child] = new Uint8Array(readFileSync(childAbs));
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

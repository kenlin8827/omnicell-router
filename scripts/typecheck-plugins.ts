/**
 * Typecheck the dev-tree client-gateway plugin sources.
 *
 * Plugins live outside `backend/tsconfig.json` (they are separate repositories,
 * gitignored in this checkout), so `bun run typecheck` cannot see them. Bun only
 * transpiles — it never typechecks — so a contract drift (e.g. a host method
 * gaining a parameter) would ship silently.
 *
 * The plugin sources import backend modules by relative path; those pull
 * `bun:sqlite`, which has no ambient declarations in this repo. We therefore
 * typecheck everything and FAIL only on diagnostics whose path is under
 * `plugins/` — core diagnostics are already covered by `bun run typecheck`.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!fs.existsSync(tsc)) {
  console.error('[typecheck-plugins] typescript is not installed');
  process.exit(1);
}

const entries: string[] = [];
for (const id of fs.readdirSync(path.join(root, 'plugins'))) {
  const dir = path.join(root, 'plugins', id);
  const manifestPath = path.join(dir, 'plugin.json');
  if (!fs.existsSync(path.join(dir, 'index.ts')) || !fs.existsSync(manifestPath)) continue;
  // Model-service plugins use a different host contract (and some live in
  // trees pinned to another checkout layout); this gate covers the inbound
  // gateways whose types changed with ADR-0017.
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { type?: string };
    if (manifest.type !== 'client-gateway') continue;
  } catch {
    continue;
  }
  entries.push(path.join('plugins', id, 'index.ts'));
}
if (entries.length === 0) {
  console.log('[typecheck-plugins] no dev-tree plugins; nothing to check');
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [
    tsc,
    '--noEmit',
    '--strict',
    '--target',
    'ES2022',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--lib',
    'ES2022',
    '--skipLibCheck',
    '--types',
    'node',
    ...entries,
  ],
  { cwd: root, encoding: 'utf8' },
);

const diagnostics = `${result.stdout ?? ''}${result.stderr ?? ''}`
  .split(/\r?\n/)
  .filter((line) => /^plugins[\\/]/.test(line));

if (diagnostics.length > 0) {
  console.error(diagnostics.join('\n'));
  console.error(`[typecheck-plugins] ${diagnostics.length} plugin diagnostic(s)`);
  process.exit(1);
}
console.log(`[typecheck-plugins] ${entries.length} plugin(s) clean`);

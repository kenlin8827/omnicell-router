import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// PORT arrives from the root package.json `dev` script (pinned 3000 for dev,
// independent of the config.yaml `port:` that production/desktop reads) or
// from the caller's own env when this file is run directly.
const backendPort = process.env.PORT || '3000';
console.log(`🚀 Starting OmniCellRouter (OCR) Full-Stack Development Services...`);
console.log(`   ├─ Backend API:  http://127.0.0.1:${backendPort}`);
console.log(`   └─ Frontend App: http://127.0.0.1:5173\n`);

// The dev command is the ONE entry point that loads the untracked source tree
// on its own (ADR-0017 §6): `plugins/` is where a plugin is edited, and `bun run
// dev` is where that happens. Everything else — `bun run start`, the desktop
// sidecar, a packaged install — keeps the source tier opt-in, so an installed
// gateway never lists plugins nobody installed. Opt out here with an empty
// `OCR_PLUGIN_SRC_DIR=`, or point it at another tree. The default is ABSOLUTE:
// the loader resolves a relative value against the backend child's cwd, which
// would make the source tier depend on where `bun run dev` was launched from.
const backendEnv = {
  ...process.env,
  FORCE_COLOR: '1',
  OCR_PLUGIN_SRC_DIR: process.env.OCR_PLUGIN_SRC_DIR ?? resolve(import.meta.dir, '..', 'plugins'),
};

// 1. Start Backend in watch mode
const backend = spawn('bun', ['--no-env-file', '--watch', 'backend/src/index.ts'], {
  stdio: 'inherit',
  shell: true,
  env: backendEnv,
});

// 2. Start Frontend dev server
const frontend = spawn('bun', ['run', 'dev'], {
  cwd: './frontend',
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, FORCE_COLOR: '1' },
});

function cleanup() {
  console.log('\n🛑 Shutting down OCR development services...');
  try { backend.kill('SIGINT'); } catch {}
  try { frontend.kill('SIGINT'); } catch {}
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

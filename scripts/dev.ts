import { spawn } from 'node:child_process';

// PORT arrives from the root package.json `dev` script (pinned 3000 for dev,
// independent of the config.yaml `port:` that production/desktop reads) or
// from the caller's own env when this file is run directly.
const backendPort = process.env.PORT || '3000';
console.log(`🚀 Starting OmniCellRouter (OCR) Full-Stack Development Services...`);
console.log(`   ├─ Backend API:  http://127.0.0.1:${backendPort}`);
console.log(`   └─ Frontend App: http://127.0.0.1:5173\n`);

// 1. Start Backend in watch mode
const backend = spawn('bun', ['--no-env-file', '--watch', 'backend/src/index.ts'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, FORCE_COLOR: '1' },
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

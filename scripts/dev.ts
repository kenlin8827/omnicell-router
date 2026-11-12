import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';
import { DEFAULT_DEV_PORT } from '../backend/src/config/defaults.js';

// ONE resolved port for the whole dev stack — the backend child and the Vite
// proxy both receive it, so they can never target different ports. `PORT`
// passed by the caller wins; the fallback is DEFAULT_DEV_PORT (4000 is the
// installed gateway's port, so the dev stack must not squat it).
const devPort = process.env.PORT?.trim() || String(DEFAULT_DEV_PORT);

/**
 * Pre-flight: refuse to start on a port something else already owns, BEFORE
 * either child spawns. Without this the backend dies with a bare EADDRINUSE
 * while Vite stays up on 5173 serving a console whose API calls all fail —
 * the exact "port 3000 is in use" confusion this script exists to prevent.
 */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = net.createServer();
    probe.once('error', () => done(false));
    probe.once('listening', () => probe.close(() => done(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/**
 * Kill the whole child tree. `shell: true` wraps each child in cmd.exe and
 * `bun --watch` adds a grandchild of its own, so signalling the direct child
 * leaves the actual listener orphaned — that is how a closed dev session keeps
 * squatting its port. Windows needs taskkill /T to walk the tree; elsewhere
 * SIGINT on the process group is enough.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
    return;
  }
  try { child.kill('SIGINT'); } catch {}
}

async function main(): Promise<void> {
  if (!(await portIsFree(Number(devPort)))) {
    console.error(
      `\n✖ Port ${devPort} is already in use — refusing to start the dev stack.\n` +
        `  A previous dev session (or another program) still owns it.\n` +
        `  Windows: netstat -ano | findstr :${devPort}   then   taskkill /F /PID <pid>\n` +
        `  Or pick another port: PORT=4800 bun run dev\n`
    );
    process.exit(1);
  }

  console.log(`🚀 Starting OmniCellRouter (OCR) Full-Stack Development Services...`);
  console.log(`   ├─ Backend API:  http://127.0.0.1:${devPort}`);
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
    PORT: devPort,
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
    env: { ...backendEnv, FORCE_COLOR: '1' },
  });

  const cleanup = () => {
    console.log('\n🛑 Shutting down OCR development services...');
    killTree(backend);
    killTree(frontend);
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);
}

void main();

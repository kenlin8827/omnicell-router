// Builds the gateway sidecar exe for the desktop shell. Wrapped in a script
// so the repo-root version can be injected at compile time (--define): the
// installed app has no package.json on disk, and backend/src/version.ts's
// runtime file resolution lands on the embedded-snapshot fallback (0.0.0)
// inside a bun-compiled snapshot.
//
// Usage: bun run sidecar  (from desktop/) — paths are cwd-relative.

import { readFileSync, mkdirSync } from 'node:fs';

const rootPkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version?: string };
const version = rootPkg.version ?? '0.0.0';

const argTarget = process.argv[2];
const argBunTarget = process.argv[3];

let target = argTarget;
let bunTarget = argBunTarget;
let ext = '';

if (!target) {
  if (process.platform === 'win32') {
    target = 'x86_64-pc-windows-msvc';
    bunTarget = 'bun-windows-x64';
    ext = '.exe';
  } else if (process.platform === 'darwin') {
    target = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    bunTarget = process.arch === 'arm64' ? 'bun-darwin-arm64' : 'bun-darwin-x64';
  } else {
    target = 'x86_64-unknown-linux-gnu';
    bunTarget = 'bun-linux-x64';
  }
} else if (target.includes('windows')) {
  ext = '.exe';
}

mkdirSync('src-tauri/bin', { recursive: true });
const outfile = `src-tauri/bin/ocr-backend-${target}${ext}`;
const spawnArgs = [
  'bun',
  'build',
  '--compile',
  '--external',
  'onnxruntime-node',
  '--define',
  `__OCR_VERSION__:"${version}"`,
];
if (bunTarget) {
  spawnArgs.push('--target', bunTarget);
}
spawnArgs.push('../backend/src/index.ts', '--outfile', outfile);

const proc = Bun.spawn(spawnArgs, { stdout: 'inherit', stderr: 'inherit' });
process.exit(await proc.exited);

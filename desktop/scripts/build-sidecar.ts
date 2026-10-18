// Builds the gateway sidecar exe for the desktop shell. Wrapped in a script
// so the repo-root version can be injected at compile time (--define): the
// installed app has no package.json on disk, and backend/src/version.ts's
// runtime file resolution lands on the embedded-snapshot fallback (0.0.0)
// inside a bun-compiled snapshot.
//
// Usage: bun run sidecar  (from desktop/) — paths are cwd-relative.

import { readFileSync } from 'node:fs';

const rootPkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version?: string };
const version = rootPkg.version ?? '0.0.0';

const outfile = 'src-tauri/bin/ocr-backend-x86_64-pc-windows-msvc.exe';
const proc = Bun.spawn(
  [
    'bun',
    'build',
    '--compile',
    '--external',
    'onnxruntime-node',
    '--define',
    `__OCR_VERSION__:"${version}"`,
    '../backend/src/index.ts',
    '--outfile',
    outfile,
  ],
  { stdout: 'inherit', stderr: 'inherit' },
);
process.exit(await proc.exited);

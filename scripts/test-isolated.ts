/**
 * Isolated test runner — the trustworthy `bun test` entry point.
 *
 * WHY THIS EXISTS: running `bun test backend/tests` from the repo root in ONE
 * process produces ~26 phantom failures. Two independent causes:
 *   1. cwd contamination — getConfigPath() prefers <cwd>/config.yaml, and the
 *      repo's real (gitignored) config.yaml carries the operator's webAuth
 *      login gate, so /api/admin console endpoints 401 in trace/variants/...
 *   2. describe-cascade — one process means one shared module registry; the
 *      chdir-based sandboxes some suites install leak into later files.
 * Running each file from a sandbox cwd holding a minimal placeholder config
 * (port/host/apiKeys/models only) fixes both — this is how the suite is
 * verified to reach 0 fail (553 pass as of 2026-10-11).
 *
 * Usage: bun scripts/test-isolated.ts [substring-filter ...]
 * A file runs only when its path contains one of the filter substrings
 * (no filters = every file). Exit code 0 iff every run had 0 failures.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const testsDir = path.join(repoRoot, 'backend', 'tests');

const filters = process.argv.slice(2);
const files = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => filters.length === 0 || filters.some((s) => f.includes(s)))
  .sort()
  .map((f) => path.join(testsDir, f));

if (files.length === 0) {
  console.error(`No test files match: ${filters.join(' ') || '(all)'}`);
  process.exit(2);
}

// Sandbox cwd for every child: a placeholder config.yaml so the operator's
// real one (api keys, per-key policies, webAuth) can never leak into a run.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-test-iso-'));
fs.writeFileSync(
  path.join(sandbox, 'config.yaml'),
  'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\n'
);

let totalPass = 0;
let totalFail = 0;
const failedFiles: string[] = [];

try {
  process.chdir(sandbox); // children inherit this cwd
  for (const file of files) {
    const name = path.basename(file, '.test.ts');
    const proc = Bun.spawnSync(['bun', 'test', file], {
      cwd: sandbox,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = `${proc.stdout?.toString() ?? ''}\n${proc.stderr?.toString() ?? ''}`;
    const pass = Number(out.match(/\b(\d+) pass\b/)?.[1] ?? 0);
    const fail = Number(out.match(/\b(\d+) fail\b/)?.[1] ?? 0);
    totalPass += pass;
    totalFail += fail;
    if (fail > 0 || proc.exitCode !== 0) {
      failedFiles.push(name);
      console.log(`✗ ${name.padEnd(28)} ${pass} pass  ${fail} FAIL  (exit ${proc.exitCode})`);
      // Print the failing file's output so nobody has to re-run it by hand.
      const failureBlock = out
        .split('\n')
        .filter((l) => /\(fail\)|error:|AssertionError|Expected|Received|TypeError/.test(l))
        .slice(0, 40)
        .join('\n');
      if (failureBlock) console.log(failureBlock + '\n');
    } else {
      console.log(`✓ ${name.padEnd(28)} ${pass} pass`);
    }
  }
} finally {
  process.chdir(repoRoot);
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log('----');
console.log(`TOTAL: ${totalPass} pass, ${totalFail} fail across ${files.length} files`);
if (failedFiles.length > 0) {
  console.log(`FAILED FILES: ${failedFiles.join(', ')}`);
  process.exit(1);
}
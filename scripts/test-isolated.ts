/**
 * Isolated test runner — the trustworthy `bun test` entry point.
 *
 * WHY THIS EXISTS: running `bun test backend/tests` from the repo root in ONE
 * process produces ~26 phantom failures. Two independent causes:
 *   1. config leakage — without OCR_HOME every child resolves the operator's
 *      real ~/.opencode-router environment (its config.yaml carries the
 *      webAuth login gate), so /api/admin console endpoints 401 in
 *      trace/variants/... and test writes land on real data.
 *   2. describe-cascade — one process means one shared module registry; the
 *      chdir-based sandboxes some suites install leak into later files.
 * Running each file as its own process against a sandbox OCR_HOME holding one
 * placeholder environment (a minimal config.yaml: port/host/apiKeys/models)
 * fixes both — this is how the suite is verified to reach 0 fail.
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

// Sandbox OCR_HOME for every child, holding a placeholder env config so the
// operator's real ~/.opencode-router (api keys, per-key policies, webAuth) can
// never leak into a run — and never be written by one. Config resolution is
// env-relative (<home>/envs/<env>/config.yaml), so the child's cwd is
// irrelevant: OCR_HOME + OCR_ENV are the only levers that matter.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-test-iso-'));
const ocrHome = path.join(sandbox, 'home');
const defaultEnvDir = path.join(ocrHome, 'envs', 'default');
fs.mkdirSync(defaultEnvDir, { recursive: true });
fs.writeFileSync(
  path.join(defaultEnvDir, 'config.yaml'),
  'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\n'
);
fs.writeFileSync(
  path.join(defaultEnvDir, 'env.json'),
  JSON.stringify({ name: 'default', type: 'regular', createdAt: new Date().toISOString(), schemaVersion: 1 })
);
// opencode paths are sandboxed
// too: user-config.ts (auth.json/opencode.jsonc) and credentials/paths.ts
// (auth.json, opencode.db, installed.version) resolve from XDG_CONFIG_HOME /
// XDG_DATA_HOME, falling back to os.homedir(). Without these a test reads —
// and worse, can WRITE — the OPERATOR's real opencode files. A test that
// starts failing here was accidentally consuming operator state: that is a
// bug; fix it with injection/fixtures (per-file XDG overrides still work —
// this is only the default).
const xdgConfig = path.join(sandbox, 'xdg-config');
const xdgData = path.join(sandbox, 'xdg-data');
fs.mkdirSync(xdgConfig, { recursive: true });
fs.mkdirSync(xdgData, { recursive: true });
const childEnv = {
  ...process.env,
  OCR_HOME: ocrHome,
  OCR_ENV: 'default',
  XDG_CONFIG_HOME: xdgConfig,
  XDG_DATA_HOME: xdgData,
};
// opencode v2 service discovery (connector/OpencodeV2Store) must be inert in the sandbox:
// DELIBERATELY UNSET (not ''), or a test hitting the connector would talk to
// the operator's live opencode service.
delete childEnv.OPENCODE_SERVER_URL;
delete childEnv.OPENCODE_SERVER_PASSWORD;

let totalPass = 0;
let totalFail = 0;
const failedFiles: string[] = [];

try {
  process.chdir(sandbox); // children inherit this cwd
  for (const file of files) {
    const name = path.basename(file, '.test.ts');
    const proc = Bun.spawnSync(['bun', 'test', '--no-env-file', file], {
      cwd: sandbox,
      env: childEnv,
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
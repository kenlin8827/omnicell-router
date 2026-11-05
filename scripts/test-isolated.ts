/**
 * Isolated test runner — the trustworthy `bun test` entry point.
 *
 * WHY THIS EXISTS: running `bun test backend/tests` from the repo root in ONE
 * process produces ~26 phantom failures. Two independent causes:
 *   1. config leakage — without OCR_HOME every child resolves the operator's
 *      real ~/.omnicell-router environment (its config.yaml carries the
 *      webAuth login gate), so /api/admin console endpoints 401 in
 *      trace/variants/... and test writes land on real data.
 *   2. describe-cascade — one process means one shared module registry; the
 *      chdir-based sandboxes some suites install leak into later files.
 * Running each file as its own process against a sandbox OCR_HOME holding one
 * placeholder environment (a minimal config.yaml: port/host/apiKeys/models)
 * fixes both — this is how the suite is verified to reach 0 fail.
 *
 * Files run CONCURRENTLY (a bounded pool, default 8 workers): every file gets
 * its own pristine per-file sandbox directory, so concurrent runs share
 * nothing but the OS. Real listeners inside tests bind port 0; the fixed
 * `port: 3000` hits are config values, never binds — concurrency is safe.
 * Override the pool size with OCR_TEST_JOBS (1 = fully serial).
 *
 * Usage: bun scripts/test-isolated.ts [substring-filter ...]
 * A file runs only when its path contains one of the filter substrings
 * (no filters = every file). Exit code 0 iff every run had 0 failures.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Subprocess } from 'bun';

/** Per-file wall clock. A hang guard, not a performance budget — generous by design. */
const FILE_TIMEOUT_MS = 120_000;

/**
 * Worker-pool width. Cold start (~0.7s of I/O wait per child) dominates most
 * files, so a width beyond CPU count still pays off; beyond ~12 the spawn
 * storm costs more than it saves on Windows.
 */
const JOBS = Math.max(
  1,
  Math.min(16, Number(process.env.OCR_TEST_JOBS ?? Math.min(8, Math.max(2, os.cpus().length))) || 8),
);

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
// operator's real ~/.omnicell-router (api keys, per-key policies, webAuth) can
// never leak into a run — and never be written by one. Config resolution is
// env-relative (<home>/envs/<env>/config.yaml), so the child's cwd is
// irrelevant: OCR_HOME + OCR_ENV are the only levers that matter.
// TRIPWIRE: the placeholder book-set is deliberately NOT named `default`.
// `default` is the bootstrap tier, exempt from the resolution fail-fast
// (assertEnvResolvable in backend/src/config/env.ts): if OCR_HOME sandboxing
// ever leaked, OCR_ENV=default would silently resolve to the operator's REAL
// default env and write into it. Naming the sandbox env `itest` — a name that
// exists in no real home — turns any such leak into an immediate boot error.
const SANDBOX_ENV = 'itest';
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-test-iso-'));

/**
 * One PRISTINE sandbox per test file.
 *
 * A single shared sandbox looked isolated because each file runs in its own
 * process — it is not: files still share <home>/credentials*.json,
 * providers.json, catalog/, breaker state and XDG dirs on DISK. A suite that
 * leaves a credential behind makes a later suite treat that provider as
 * connected and hit the network for real (auto-pull / source sync), which is
 * a silent multi-minute stall in the middle of the run. Re-seeding the few
 * tiny files per file is cheap and removes the whole contamination class.
 * This stays true under concurrency: each worker gets its own `file-<name>`
 * tree, so parallel runs never touch the same path either.
 */
function sandboxEnvFor(tag: string): Record<string, string | undefined> {
  const dir = path.join(sandbox, `file-${tag}`);
  const ocrHome = path.join(dir, 'home');
  const sandboxEnvDir = path.join(ocrHome, 'envs', SANDBOX_ENV);
  fs.mkdirSync(sandboxEnvDir, { recursive: true });
  fs.writeFileSync(
    path.join(sandboxEnvDir, 'config.yaml'),
    'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\n'
  );
  fs.writeFileSync(
    path.join(sandboxEnvDir, 'env.json'),
    JSON.stringify({ name: SANDBOX_ENV, type: 'regular', createdAt: new Date().toISOString(), schemaVersion: 1 })
  );
  // opencode paths are sandboxed too: user-config.ts (auth.json/opencode.jsonc)
  // and credentials/paths.ts (auth.json, opencode.db, installed.version)
  // resolve from XDG_CONFIG_HOME / XDG_DATA_HOME, falling back to os.homedir().
  // Without these a test reads — and worse, can WRITE — the OPERATOR's real
  // opencode files. A test that starts failing here was accidentally consuming
  // operator state: that is a bug; fix it with injection/fixtures (per-file
  // XDG overrides still work — this is only the default).
  const xdgConfig = path.join(dir, 'xdg-config');
  const xdgData = path.join(dir, 'xdg-data');
  fs.mkdirSync(xdgConfig, { recursive: true });
  fs.mkdirSync(xdgData, { recursive: true });
  // OpenClaw resolves its config/state from the vendor's own env vars (the host adapter and the
  // takeover client share `cli/paths.ts`), so both are pinned into the per-file sandbox — a test
  // must never read or rewrite the operator's `~/.openclaw`.
  const openclawState = path.join(dir, 'openclaw');
  fs.mkdirSync(openclawState, { recursive: true });
  const env: Record<string, string | undefined> = {
    ...process.env,
    OCR_HOME: ocrHome,
    OCR_ENV: SANDBOX_ENV,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    OPENCLAW_STATE_DIR: openclawState,
    OPENCLAW_CONFIG_PATH: path.join(openclawState, 'openclaw.json'),
  };
  // opencode v2 service discovery (connector/OpencodeV2Store) must be inert in
  // the sandbox: DELIBERATELY UNSET (not ''), or a test hitting the connector
  // would talk to the operator's live opencode service.
  delete env.OPENCODE_SERVER_URL;
  delete env.OPENCODE_SERVER_PASSWORD;
  return env;
}

interface FileResult {
  name: string;
  pass: number;
  fail: number;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
  readError?: string;
  failureBlock: string;
  ms: number;
}

/**
 * Run one file in its own bun process against its own sandbox.
 *
 * Output goes to a FILE, never a pipe. A piped child that prints more than the
 * OS buffer holds blocks on write while the parent blocks on wait — a silent
 * deadlock that looked like "the suite hung". File redirection has no limit.
 * The timeout is enforced by killing the child (Bun.spawn has no built-in
 * deadline); a killed child reports exitCode null, which the classifier below
 * surfaces as TIMEOUT.
 */
async function runFile(file: string): Promise<FileResult> {
  const name = path.basename(file, '.test.ts');
  const started = Date.now();
  const result: FileResult = {
    name,
    pass: 0,
    fail: 0,
    exitCode: null,
    timedOut: false,
    failureBlock: '',
    ms: 0,
  };
  let out = '';
  try {
    const childEnv = sandboxEnvFor(name);
    const logFile = path.join(sandbox, `run-${name}.log`);
    const fd = fs.openSync(logFile, 'w');
    let child: Subprocess;
    try {
      child = Bun.spawn(['bun', 'test', '--no-env-file', file], {
        cwd: sandbox,
        env: childEnv,
        stdout: fd,
        stderr: fd,
      });
    } finally {
      fs.closeSync(fd);
    }
    const killer = setTimeout(() => {
      result.timedOut = true;
      child.kill();
    }, FILE_TIMEOUT_MS);
    try {
      await child.exited;
    } finally {
      clearTimeout(killer);
    }
    result.exitCode = child.exitCode;
    try {
      out = fs.readFileSync(logFile, 'utf8');
    } catch (err) {
      result.readError = err instanceof Error ? err.message : String(err);
    }
    result.pass = Number(out.match(/\b(\d+) pass\b/)?.[1] ?? 0);
    result.fail = Number(out.match(/\b(\d+) fail\b/)?.[1] ?? 0);
    result.failureBlock = out
      .split('\n')
      .filter((l) => /\(fail\)|error:|AssertionError|Expected|Received|TypeError/.test(l))
      .slice(0, 40)
      .join('\n');
  } catch (err) {
    result.spawnError = err instanceof Error ? err.message : String(err);
  }
  result.ms = Date.now() - started;
  return result;
}

let totalPass = 0;
let totalFail = 0;
const failedFiles: string[] = [];

try {
  const results: FileResult[] = new Array(files.length);
  let next = 0;
  // Bounded worker pool: each worker pulls the next file until the list is
  // drained. Results land in sorted order regardless of completion order.
  await Promise.all(
    Array.from({ length: Math.min(JOBS, files.length) }, async () => {
      // Claim the index BEFORE awaiting: `next++` must happen synchronously,
      // or two workers awaiting on the same tick both pick up the same file
      // (observed: admin-logs-clear ran twice in one sandbox, EBUSY/ENOENT).
      while (next < files.length) {
        const i = next++;
        results[i] = await runFile(files[i]);
      }
    }),
  );

  for (const r of results) {
    totalPass += r.pass;
    totalFail += r.fail;
    const secs = (r.ms / 1000).toFixed(1).padStart(5);
    if (r.readError) {
      failedFiles.push(r.name);
      console.log(`✗ ${r.name.padEnd(28)} INFRA FAIL  (unreadable run log: ${r.readError})`);
    } else if (r.spawnError && !r.timedOut) {
      failedFiles.push(r.name);
      console.log(`✗ ${r.name.padEnd(28)} INFRA FAIL  (${r.spawnError})`);
    } else if (r.timedOut || r.fail > 0 || r.exitCode !== 0) {
      failedFiles.push(r.name);
      console.log(
        `✗ ${r.name.padEnd(28)} ${r.pass} pass  ${r.fail} FAIL  (${r.timedOut ? `TIMEOUT ${FILE_TIMEOUT_MS / 1000}s` : `exit ${r.exitCode}`})  ${secs}s`,
      );
      if (r.failureBlock) console.log(r.failureBlock + '\n');
    } else {
      console.log(`✓ ${r.name.padEnd(28)} ${String(r.pass).padStart(4)} pass  ${secs}s`);
    }
  }
} finally {
  // Keep the sandbox on a failure: the run logs are the only record of what
  // that file actually printed. A green run is disposable.
  if (failedFiles.length === 0) {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

console.log('----');
console.log(`TOTAL: ${totalPass} pass, ${totalFail} fail across ${files.length} files (${JOBS} workers)`);
if (failedFiles.length > 0) {
  console.log(`FAILED FILES: ${failedFiles.join(', ')}`);
  console.log(`RUN LOGS KEPT: ${sandbox}`);
  process.exit(1);
}

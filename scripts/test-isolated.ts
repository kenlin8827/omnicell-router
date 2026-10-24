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
 * Usage: bun scripts/test-isolated.ts [substring-filter ...]
 * A file runs only when its path contains one of the filter substrings
 * (no filters = every file). Exit code 0 iff every run had 0 failures.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Per-file wall clock. A hang guard, not a performance budget — generous by design. */
const FILE_TIMEOUT_MS = 120_000;

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
  const env: Record<string, string | undefined> = {
    ...process.env,
    OCR_HOME: ocrHome,
    OCR_ENV: SANDBOX_ENV,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
  };
  // opencode v2 service discovery (connector/OpencodeV2Store) must be inert in
  // the sandbox: DELIBERATELY UNSET (not ''), or a test hitting the connector
  // would talk to the operator's live opencode service.
  delete env.OPENCODE_SERVER_URL;
  delete env.OPENCODE_SERVER_PASSWORD;
  return env;
}

let totalPass = 0;
let totalFail = 0;
const failedFiles: string[] = [];

try {
  process.chdir(sandbox); // children inherit this cwd
  for (const file of files) {
    const name = path.basename(file, '.test.ts');
    // One file's infrastructure failure (locked log file, sandbox EPERM from an
    // AV scanner, spawn hiccup) must never abort the run — record it and go on.
    try {
      const childEnv = sandboxEnvFor(name);
      // Output goes to a FILE, never a pipe. spawnSync cannot drain a piped
      // child while it blocks, and on Windows the anonymous pipe buffer is
      // tiny: a chatty test file (bun test prints every pass) fills it, the
      // child blocks on write, the parent blocks on wait — a silent deadlock
      // that looked like "the suite hung". File redirection has no limit.
      const logFile = path.join(sandbox, `run-${name}.log`);
      const fd = fs.openSync(logFile, 'w');
      let proc: ReturnType<typeof Bun.spawnSync> | undefined;
      let spawnError: string | undefined;
      try {
        proc = Bun.spawnSync(['bun', 'test', '--no-env-file', file], {
          cwd: sandbox,
          env: childEnv,
          stdout: fd,
          stderr: fd,
          timeout: FILE_TIMEOUT_MS,
        });
      } catch (err) {
        // spawnSync THROWS on timeout (rather than returning a null exit code);
        // without this catch one hanging file aborts the whole run silently.
        spawnError = err instanceof Error ? err.message : String(err);
      } finally {
        fs.closeSync(fd);
      }
      // A log that cannot be read (a locked/AV-removed file, a vanished sandbox)
      // must not cost the whole run: an unparsable result is recorded as an
      // INFRA failure for THIS file, with the rest of the suite still running.
      let out = '';
      let readError: string | undefined;
      try {
        out = fs.readFileSync(logFile, 'utf8');
      } catch (err) {
        readError = err instanceof Error ? err.message : String(err);
      }
      const pass = Number(out.match(/\b(\d+) pass\b/)?.[1] ?? 0);
      const fail = Number(out.match(/\b(\d+) fail\b/)?.[1] ?? 0);
      const exitCode = proc?.exitCode ?? null;
      const timedOut = spawnError !== undefined && /tim(e|ed)?\s*out|timeout/i.test(spawnError);
      totalPass += pass;
      totalFail += fail;
      if (readError) {
        failedFiles.push(name);
        console.log(`✗ ${name.padEnd(28)} INFRA FAIL  (unreadable run log: ${readError})`);
      } else if (spawnError && !timedOut) {
        failedFiles.push(name);
        console.log(`✗ ${name.padEnd(28)} INFRA FAIL  (${spawnError})`);
      } else if (timedOut || fail > 0 || exitCode !== 0) {
        failedFiles.push(name);
        console.log(
          `✗ ${name.padEnd(28)} ${pass} pass  ${fail} FAIL  (${timedOut ? `TIMEOUT ${FILE_TIMEOUT_MS / 1000}s` : `exit ${exitCode}`})`,
        );
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
    } catch (err) {
      failedFiles.push(name);
      console.log(
        `✗ ${name.padEnd(28)} INFRA FAIL  (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
} finally {
  process.chdir(repoRoot);
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
console.log(`TOTAL: ${totalPass} pass, ${totalFail} fail across ${files.length} files`);
if (failedFiles.length > 0) {
  console.log(`FAILED FILES: ${failedFiles.join(', ')}`);
  console.log(`RUN LOGS KEPT: ${sandbox}`);
  process.exit(1);
}
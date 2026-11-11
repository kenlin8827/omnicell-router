import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerGlobalShims, shimStatus, unregisterGlobalShims } from '../src/cli/shim.js';

/**
 * Two shim flavours share one bin dir: repo-checkout trampolines (shell out to
 * bun/node) and packaged self shims (the compiled `ocr-backend --cli`). The
 * packaged one must exist because a desktop install has no repo and no runtime.
 * Both flavours target the SAME filenames, so whichever install ran last owns
 * the file on disk — uninstall therefore matches either marker (and nothing
 * else). PATH writes are disabled here — these assertions are about file
 * contents.
 */

const isWindows = process.platform === 'win32';

function makeSandbox(fn: (dirs: { repo: string; bin: string }) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-shim-'));
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(repo, 'backend', 'src', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'backend', 'src', 'cli', 'index.ts'), '// fixture\n');
  try {
    fn({ repo, bin });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}



describe('CLI shim registration', () => {
  it('repo checkout gets trampolines into the TypeScript entry', () => {
    makeSandbox(({ repo, bin }) => {
      const res = registerGlobalShims(repo, bin, { writePath: false });
      assert.equal(res.success, true);
      assert.deepEqual(
        fs.readdirSync(bin).sort(),
        isWindows ? ['ocr.cmd', 'ocr.ps1', 'omnicell-router.cmd', 'omnicell-router.ps1'] : ['ocr', 'omnicell-router']
      );
      const body = fs.readFileSync(path.join(bin, isWindows ? 'ocr.cmd' : 'ocr'), 'utf8');
      assert.match(body, /omnicell-router-trampoline/);
      assert.ok(body.includes(path.join(repo, 'backend', 'src', 'cli', 'index.ts')));
    });
  });

  it('packaged install (compiled snapshot) targets the binary itself with --cli', () => {
    makeSandbox(({ bin }) => {
      // `packagedInstall` is the seam for "we ARE the compiled sidecar": that
      // state cannot be faked from a source run (the real predicate reads
      // Bun.main's virtual snapshot path), and a repo dir without the CLI
      // entry must NOT be mistaken for it — that layout writes trampolines.
      const packagedRepo = path.join(path.dirname(bin), 'no-repo');
      const res = registerGlobalShims(packagedRepo, bin, { writePath: false, packagedInstall: true });
      assert.equal(res.success, true);
      const body = fs.readFileSync(path.join(bin, isWindows ? 'ocr.cmd' : 'ocr'), 'utf8');
      assert.match(body, /omnicell-router-self-shim/);
      assert.ok(body.includes('--cli'));
      assert.ok(body.includes(process.execPath));
      // No bun/node trampoline may leak into the packaged shim.
      assert.doesNotMatch(body, /bun run|npx tsx/);
    });
  });

  it('a repo dir with no CLI entry is not a packaged install', () => {
    makeSandbox(({ repo, bin }) => {
      const noRepo = path.join(path.dirname(bin), 'no-repo');
      fs.mkdirSync(repo, { recursive: true });
      registerGlobalShims(noRepo, bin, { writePath: false });
      const body = fs.readFileSync(path.join(bin, isWindows ? 'ocr.cmd' : 'ocr'), 'utf8');
      assert.match(body, /omnicell-router-trampoline/);
      assert.doesNotMatch(body, /omnicell-router-self-shim/);
    });
  });

  it('uninstall removes BOTH shim flavours, whichever wrote last', () => {
    makeSandbox(({ repo, bin }) => {
      // Last install wins: one name can only carry one flavour at a time, so
      // both product filenames must be exercised — `ocr` holds the packaged
      // self shim (installed later, the checkout gone) while
      // `omnicell-router` still holds the checkout's trampoline.
      registerGlobalShims(repo, bin, { writePath: false });
      const self = path.join(bin, isWindows ? 'ocr.cmd' : 'ocr');
      fs.writeFileSync(self, '# omnicell-router-self-shim\nexec app --cli "$@"\n');
      const trampoline = path.join(bin, isWindows ? 'omnicell-router.cmd' : 'omnicell-router');
      const trampolineBody = fs.readFileSync(trampoline, 'utf8');
      assert.match(trampolineBody, /omnicell-router-trampoline/);

      const res = unregisterGlobalShims(repo, bin);

      // Every file this product wrote (`.cmd` + `.ps1` on Windows) is gone.
      assert.deepEqual(fs.readdirSync(bin), []);
      assert.ok(res.removed.includes(self));
      assert.ok(res.removed.includes(trampoline));
    });
  });

  it('uninstall never touches a product-named file that carries no marker', () => {
    makeSandbox(({ bin }) => {
      // A hand-written command with one of OUR names still belongs to the
      // operator: only a marker proves this product wrote the file.
      fs.mkdirSync(bin, { recursive: true });
      const foreign = path.join(bin, isWindows ? 'ocr.cmd' : 'ocr');
      fs.writeFileSync(foreign, '#!/bin/sh\necho not ours\n');

      const res = unregisterGlobalShims(undefined, bin);

      assert.deepEqual(fs.readdirSync(bin), [path.basename(foreign)]);
      assert.deepEqual(res.removed, []);
    });
  });
});

describe('shim status (the desktop tray toggle reads this)', () => {
  it('is installed after registration and empty again after uninstall', () => {
    makeSandbox(({ repo, bin }) => {
      // The toggle's verb must follow the files on disk: install -> remove is
      // one round trip, so a menu that still says "install" after it worked
      // (or "uninstall" after the operator deleted a shim) cannot happen.
      registerGlobalShims(repo, bin, { writePath: false });
      const installed = shimStatus(bin);
      assert.equal(installed.installed, true);
      assert.equal(installed.binDir, bin);
      assert.equal(installed.shims.length, isWindows ? 4 : 2);
      assert.ok(installed.shims.every((file) => path.dirname(file) === bin));

      unregisterGlobalShims(repo, bin);
      const gone = shimStatus(bin);
      assert.equal(gone.installed, false);
      assert.deepEqual(gone.shims, []);
    });
  });

  it('a missing bin dir and a foreign same-named file both read as not installed', () => {
    makeSandbox(({ bin }) => {
      assert.equal(shimStatus(path.join(bin, 'nope')).installed, false);

      // Same marker discipline as uninstall: our NAME is not our FILE.
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, isWindows ? 'ocr.cmd' : 'ocr'), '#!/bin/sh\necho not ours\n');
      const status = shimStatus(bin);
      assert.equal(status.installed, false);
      assert.deepEqual(status.shims, []);
    });
  });
});

describe('shims-status CLI contract (what the desktop tray shells out to)', () => {
  it('answers pure JSON + exit 0/1 through the dual entry, without booting a gateway', () => {
    // The tray toggle reads ONLY two things: a parseable JSON line and the
    // exit code (0 = installed). Both hold for the real entry point the desktop
    // runs (`ocr-backend --cli …` → backend/src/index.ts), and the dual entry
    // must never fall through to `main()` — a cliMode regression would turn a
    // menu click into a second gateway boot instead of an answer.
    //
    // Sandboxed by redirecting the platform's data dir (LOCALAPPDATA / HOME),
    // taken FROM the command's own reply so this test never re-derives the bin
    // dir. `writePath: false` keeps the operator's PATH untouched.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-shims-status-'));
    try {
      const env = { ...process.env };
      if (isWindows) env.LOCALAPPDATA = root;
      else env.HOME = root;
      const cliEntry = path.join(import.meta.dir, '..', 'src', 'index.ts');
      const run = () =>
        spawnSync(process.execPath, [cliEntry, '--cli', 'shims-status'], {
          env,
          encoding: 'utf8',
          timeout: 60_000,
        });

      const empty = run();
      assert.equal(empty.status, 1, `stderr: ${empty.stderr}`);
      // No banner: stdout is one JSON document and nothing else.
      const emptyReply = JSON.parse(empty.stdout) as { binDir: string; shims: string[]; installed: boolean };
      assert.equal(emptyReply.installed, false);
      assert.deepEqual(emptyReply.shims, []);
      assert.ok(
        emptyReply.binDir.startsWith(root),
        `sandbox redirect failed, binDir = ${emptyReply.binDir}`
      );

      registerGlobalShims(path.join(root, 'no-repo'), emptyReply.binDir, {
        writePath: false,
        packagedInstall: true,
      });
      const installed = run();
      assert.equal(installed.status, 0, `stderr: ${installed.stderr}`);
      const reply = JSON.parse(installed.stdout) as { shims: string[]; installed: boolean };
      assert.equal(reply.installed, true);
      assert.equal(reply.shims.length, isWindows ? 4 : 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

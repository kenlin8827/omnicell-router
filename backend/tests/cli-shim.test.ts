import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerGlobalShims, unregisterGlobalShims } from '../src/cli/shim.js';

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

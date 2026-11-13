import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  JETBRAINS_PROXY_EXCEPTIONS,
  ideSslTrustPath,
  mergeProxyExceptions,
  purgePinnedMitmCerts,
} from '../src/cli/clients/jetbrains-proxy.js';

/**
 * The proxy hook has TWO failure modes that only show up on a real machine and
 * both look like something else:
 *
 *   1. an exception list that swallows the hosts we must intercept — every mock
 *      silently stops answering and the IDE looks "logged out";
 *   2. the IDE's own per-host acceptance store (`<config>/ssl/cacerts`) still
 *      pinning OUR forged leaf, so a host we no longer touch keeps presenting a
 *      pin nothing revalidates.
 *
 * These tests pin both.
 */

/** Hosts the gateway plugins answer for. Writing any of these into PROXY_EXCEPTIONS disables the mock. */
const MOCKED_HOSTS = [
  'api.ai.jetbrains.com.cn',
  'api.jetbrains.cloud',
  'api.jetbrains.ai',
  'grazie.jetbrains.com',
  'ai-api.jetbrains.com',
];

describe('JetBrains proxy exceptions', () => {
  it('never lists a host the gateway mocks', () => {
    for (const host of MOCKED_HOSTS) {
      assert.equal(
        JETBRAINS_PROXY_EXCEPTIONS.includes(host),
        false,
        `${host} must stay proxied: an exception here turns the mock off`,
      );
    }
  });

  it('never uses a wildcard that would match a mocked host', () => {
    // `*.jetbrains.com` also matches grazie.jetbrains.com; `*.com.cn` would match
    // api.ai.jetbrains.com.cn. Only wildcards whose suffix excludes every mocked
    // host are allowed.
    for (const entry of JETBRAINS_PROXY_EXCEPTIONS.filter((h) => h.startsWith('*'))) {
      const suffix = entry.slice(1); // ".example.com"
      for (const host of MOCKED_HOSTS) {
        assert.equal(host.endsWith(suffix), false, `${entry} would bypass the mocked host ${host}`);
      }
    }
  });

  it('bypasses the telemetry/account/marketplace hosts that produced the certificate dialog', () => {
    for (const host of [
      'analytics.services.jetbrains.com.cn',
      'account.jetbrains.com.cn',
      'plugins.jetbrains.com',
      'downloads.marketplace.jetbrains.com',
      'resources.jetbrains.com.cn',
    ]) {
      assert.ok(JETBRAINS_PROXY_EXCEPTIONS.includes(host), `${host} must bypass the proxy (no forged leaf => no dialog)`);
    }
  });

  it('bypasses the agent-binary hosts so the ACP download does not 502', () => {
    for (const host of ['github.com', '*.githubusercontent.com', 'release-assets.githubusercontent.com']) {
      assert.ok(JETBRAINS_PROXY_EXCEPTIONS.includes(host));
    }
  });
});

describe('mergeProxyExceptions', () => {
  it('keeps the operator list first and appends ours', () => {
    const merged = mergeProxyExceptions('corp.example.com, *.internal.example');
    const parts = merged.split(',');
    assert.equal(parts[0], 'corp.example.com');
    assert.equal(parts[1], '*.internal.example');
    assert.ok(parts.includes('analytics.services.jetbrains.com.cn'));
  });

  it('dedupes case-insensitively without reordering', () => {
    const merged = mergeProxyExceptions('LOCALHOST,corp.example.com');
    const lowered = merged.split(',').map((h) => h.toLowerCase());
    assert.equal(lowered.filter((h) => h === 'localhost').length, 1);
    assert.equal(lowered[0], 'localhost');
    assert.equal(lowered[1], 'corp.example.com');
  });

  it('tolerates an absent, empty or messy list', () => {
    for (const existing of [undefined, '', '  ,  ,', ' , corp.example.com , ']) {
      const parts = mergeProxyExceptions(existing).split(',');
      assert.ok(parts.includes('localhost'));
      assert.equal(parts.includes(''), false);
      assert.equal(parts.includes(' '), false);
    }
  });
});

describe('purgePinnedMitmCerts', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /**
   * A stand-in keytool: it answers `-list -v` with an issuer line chosen by the
   * alias, and logs every argv it saw. `.cmd` on win32, `sh` elsewhere — the same
   * two shapes `runCommand` handles.
   */
  function fakeKeytool(cwd: string): { tool: string; log: string } {
    const log = path.join(cwd, 'argv.log');
    if (process.platform === 'win32') {
      const tool = path.join(cwd, 'fakekeytool.cmd');
      fs.writeFileSync(
        tool,
        [
          '@echo off',
          // Redirect-first so the `>>` is never parsed as part of `%*`.
          `>>"${log}" echo %*`,
          'echo %* | findstr /C:"analytics.services.jetbrains.com.cn" >nul && echo Issuer: CN=OmniCellRouter Forward Proxy CA',
          'echo %* | findstr /C:"account.jetbrains.com.cn" >nul && echo Issuer: CN=Corporate Root CA',
          'exit /b 0',
          '',
        ].join('\r\n'),
      );
      return { tool, log };
    }
    const tool = path.join(cwd, 'fakekeytool.sh');
    fs.writeFileSync(
      tool,
      [
        '#!/bin/sh',
        `echo "$@" >> "${log}"`,
        'case "$*" in',
        '  *analytics.services.jetbrains.com.cn*) echo "Issuer: CN=OmniCellRouter Forward Proxy CA" ;;',
        '  *account.jetbrains.com.cn*) echo "Issuer: CN=Corporate Root CA" ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'),
    );
    fs.chmodSync(tool, 0o755);
    return { tool, log };
  }

  it('deletes the host pins that hold OUR forged leaf, and only those', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-pin-'));
    dirs.push(cwd);
    const store = ideSslTrustPath(path.join(cwd, 'config'));
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, 'placeholder-keystore');
    const { tool, log } = fakeKeytool(cwd);

    const purged = await purgePinnedMitmCerts(store, tool, [
      'analytics.services.jetbrains.com.cn',
      'account.jetbrains.com.cn',
      '*.google.com',
      'localhost',
    ]);

    assert.deepEqual(purged, ['analytics.services.jetbrains.com.cn']);
    const lines = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean);
    const deletes = lines.filter((line) => line.startsWith('-delete'));
    assert.deepEqual(deletes.map((line) => line.split('-alias ')[1]), ['analytics.services.jetbrains.com.cn']);
    // A corporate root under the same alias style is left alone (it was listed).
    assert.ok(lines.some((line) => line.startsWith('-list') && line.endsWith('account.jetbrains.com.cn')));
    // Wildcards and loopback never reach keytool at all.
    assert.equal(lines.some((line) => line.includes('google.com')), false);
    assert.equal(lines.some((line) => line.endsWith('localhost')), false);
  });

  it('is a no-op when the store or the tool is missing', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-pin-'));
    dirs.push(cwd);
    const { tool } = fakeKeytool(cwd);
    const store = ideSslTrustPath(path.join(cwd, 'config'));

    assert.deepEqual(await purgePinnedMitmCerts(store, tool), []);
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, 'x');
    assert.deepEqual(await purgePinnedMitmCerts(store, path.join(cwd, 'nope')), []);
  });
});

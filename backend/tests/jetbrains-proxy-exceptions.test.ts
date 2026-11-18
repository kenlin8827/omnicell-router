import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

// The plugin sources live in a gitignored dev tree (a separate repository), so a
// fresh checkout has no `plugins/jetbrains-gateway`. A static import cannot be
// conditional — the file would fail at module load — so the package is loaded
// only when its directory exists. Bun's `node:test` compat layer ignores a
// `skip` option, so every block below registers only through `d`; `src!` is
// therefore never evaluated without the package.
const pluginDir = path.resolve(import.meta.dirname, '../../plugins/jetbrains-gateway');
const src = fs.existsSync(pluginDir) ? await import('../../plugins/jetbrains-gateway/adapter.js') : null;
/** Register a plugin-dependent block only when the package is present. */
const d = src ? describe : null;

/**
 * The Common Name a real host supplies (`host.caCommonName()`); the package
 * carries no CA constant of its own, so the test names the value it wants the
 * issuer check to match.
 */
const CA_COMMON_NAME = 'OmniCellRouter Forward Proxy CA';

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

d?.('JetBrains proxy exceptions', () => {
  const { JETBRAINS_PROXY_EXCEPTIONS } = src!;
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

d?.('mergeProxyExceptions', () => {
  const { mergeProxyExceptions } = src!;
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

/**
 * A whole-store `keytool -list -v` dump, the shape the purge now consumes: one
 * `Alias name:` block per entry, each carrying its OWN issuer line. Deliberately
 * contains four traps —
 *   • `account.jetbrains.com.cn` is one of our bypassed hosts but holds a
 *     CORPORATE root (must survive);
 *   • `other.example.com` holds OUR root but is not a bypassed host (must
 *     survive);
 *   • `api.jetbrains.ai` holds our root, so it is deleted too;
 *   • the alias case differs from the host list, so matching must be
 *     case-insensitive.
 */
const STORE_DUMP = `Keystore type: PKCS12
Keystore provider: SUN

Your keystore contains 4 entries

Alias name: Analytics.Services.JetBrains.Com.Cn
Creation date: 2026-01-01
Owner: CN=analytics.services.jetbrains.com.cn
Issuer: CN=OmniCellRouter Forward Proxy CA
Certificate fingerprints:
\t SHA1: 11:22

Alias name: account.jetbrains.com.cn
Owner: CN=account.jetbrains.com.cn
Issuer: CN=Corporate Root CA

Alias name: other.example.com
Owner: CN=other.example.com
Issuer: CN=OmniCellRouter Forward Proxy CA

Alias name: api.jetbrains.ai
Owner: CN=api.jetbrains.ai
Issuer: CN=OmniCellRouter Forward Proxy CA
`;

d?.('purgePinnedMitmCerts', () => {
  const { ideSslTrustPath, purgePinnedMitmCerts, pinnedAliases, JETBRAINS_PROXY_EXCEPTIONS } = src!;
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /**
   * A stand-in keytool: `-list` answers the whole-store dump above, `-delete`
   * just succeeds. Every argv is logged. `.cmd` on win32, `sh` elsewhere — the
   * same two shapes `runCommand` handles.
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
          'echo %* | findstr /C:"-delete" >nul',
          'if %errorlevel%==0 exit /b 0',
          'echo Keystore type: PKCS12',
          'echo Keystore provider: SUN',
          'echo.',
          'echo Your keystore contains 4 entries',
          'echo.',
          'echo Alias name: Analytics.Services.JetBrains.Com.Cn',
          'echo Issuer: CN=OmniCellRouter Forward Proxy CA',
          'echo.',
          'echo Alias name: account.jetbrains.com.cn',
          'echo Issuer: CN=Corporate Root CA',
          'echo.',
          'echo Alias name: other.example.com',
          'echo Issuer: CN=OmniCellRouter Forward Proxy CA',
          'echo.',
          'echo Alias name: api.jetbrains.ai',
          'echo Issuer: CN=OmniCellRouter Forward Proxy CA',
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
        'case "$*" in *-delete*) exit 0 ;; esac',
        "cat <<'DUMP'",
        STORE_DUMP.trimEnd(),
        'DUMP',
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
      'api.jetbrains.ai',
      'account.jetbrains.com.cn',
      '*.google.com',
      'localhost',
    ], CA_COMMON_NAME);

    assert.deepEqual(purged, ['Analytics.Services.JetBrains.Com.Cn', 'api.jetbrains.ai']);
    const lines = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean);
    const lists = lines.filter((line) => line.startsWith('-list'));
    const deletes = lines.filter((line) => line.startsWith('-delete'));
    // ONE dump for the whole store, not one JVM per host (that was ~4.7 s of
    // every setup); deletes only for the aliases that actually matched.
    assert.equal(lists.length, 1);
    assert.equal(lists[0].includes('-alias'), false);
    assert.deepEqual(
      deletes.map((line) => line.split('-alias ')[1]),
      ['Analytics.Services.JetBrains.Com.Cn', 'api.jetbrains.ai'],
    );
    // Only matching blocks are purged: a corporate root under one of our host
    // names, and our root under a host we never bypass, both survive.
    assert.equal(lines.some((line) => line.includes('account.jetbrains.com.cn')), false);
    assert.equal(lines.some((line) => line.includes('other.example.com')), false);
    // Wildcards and loopback never reach keytool at all.
    assert.equal(lines.some((line) => line.includes('google.com')), false);
    assert.equal(lines.some((line) => line.includes('localhost')), false);
  });

  it('matches an alias block to its OWN issuer, never a neighbour\'s', async () => {
    // The corporate root sits FIRST here; a naive whole-dump `includes` would
    // delete the host that holds our root even though only the neighbour names
    // the CA.
    const dump = `Alias name: account.jetbrains.com.cn
Issuer: CN=Corporate Root CA

Alias name: api.jetbrains.ai
Issuer: CN=OmniCellRouter Forward Proxy CA
`;
    const wanted = new Set(['account.jetbrains.com.cn', 'api.jetbrains.ai']);
    assert.deepEqual(pinnedAliases(dump, wanted, CA_COMMON_NAME), ['api.jetbrains.ai']);
    // No CA name = fail closed, even with a matching alias in the dump.
    assert.deepEqual(pinnedAliases(dump, wanted, ''), []);
  });

  it('is a no-op when the store or the tool is missing', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-pin-'));
    dirs.push(cwd);
    const { tool } = fakeKeytool(cwd);
    const store = ideSslTrustPath(path.join(cwd, 'config'));

    assert.deepEqual(await purgePinnedMitmCerts(store, tool, JETBRAINS_PROXY_EXCEPTIONS, CA_COMMON_NAME), []);
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, 'x');
    assert.deepEqual(await purgePinnedMitmCerts(store, path.join(cwd, 'nope'), JETBRAINS_PROXY_EXCEPTIONS, CA_COMMON_NAME), []);
  });
});

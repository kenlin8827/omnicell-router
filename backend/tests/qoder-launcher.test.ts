import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  QODER_NO_PROXY,
  buildQoderCliLauncher,
  buildQoderLauncher,
  countFreshCatalogs,
  detectQoderCliBin,
  launcherPath,
  staleModelCatalog,
} from '../src/cli/clients/qoder-proxy.js';

/**
 * Qoder's hook has THREE proxy surfaces: Chromium's `--proxy-server`, the
 * lowercase http(s)_proxy vars read by the agent SDK's Node/undici fetch, and
 * `grpc_proxy`, which grpc-js consults FIRST for the chat channel. The launcher
 * must carry all three, trust the OCR CA on the Node side and keep loopback out
 * of the hop — these are pure script assertions (no Qoder install, no proxy).
 */

const base = {
  binary: 'C:\\Apps\\Qoder.exe',
  port: 4555,
  caPath: 'C:\\ocr\\forward-proxy\\ca.pem',
};

const PROXY_URL = `http://127.0.0.1:${base.port}`;

type LineKind = 'preamble' | 'comment' | 'env' | 'launch' | 'stray';

function classify(line: string, platform: NodeJS.Platform): LineKind {
  if (platform === 'win32') {
    if (line === '@echo off' || line === 'setlocal') return 'preamble';
    if (/^REM /.test(line)) return 'comment';
    if (/^set "[A-Za-z_]\w*=/.test(line)) return 'env';
    if (/^start "/.test(line)) return 'launch';
    return 'stray';
  }
  if (line === '#!/bin/sh') return 'preamble';
  if (/^# /.test(line)) return 'comment';
  if (/^export [A-Za-z_]\w*=/.test(line)) return 'env';
  if (/^(?:exec|nohup) /.test(line)) return 'launch';
  return 'stray';
}

function statements(script: string, platform: NodeJS.Platform): string[] {
  const lines = script.split(platform === 'win32' ? '\r\n' : '\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
function assignments(lines: string[], platform: NodeJS.Platform): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines) {
    const match = platform === 'win32' ? /^set "([A-Za-z_]\w*)=(.*)"$/ : /^export ([A-Za-z_]\w*)="(.*)"$/;
    const hit = match.exec(line);
    if (hit) out.set(hit[1], hit[2]);
  }
  return out;
}

describe('qoder launcher — Windows', () => {
  const script = buildQoderLauncher({ platform: 'win32', ...base });
  const lines = statements(script, 'win32');

  it('uses cmd.exe preambles, CRLF and no stray statements', () => {
    assert.deepEqual(lines.slice(0, 2), ['@echo off', 'setlocal']);
    assert.equal(script.includes('\r\n'), true);
    assert.equal(script.replace(/\r\n/g, '').includes('\n'), false, 'every newline is CRLF');
    for (const line of lines) assert.notEqual(classify(line, 'win32'), 'stray', line);
  });

  it('routes Chromium through --proxy-server and the Node/gRPC legs through lowercase env', () => {
    const env = assignments(lines, 'win32');
    assert.equal(env.get('grpc_proxy'), PROXY_URL);
    assert.equal(env.get('https_proxy'), PROXY_URL);
    assert.equal(env.get('http_proxy'), PROXY_URL);
    assert.equal(env.get('NODE_EXTRA_CA_CERTS'), base.caPath);
    assert.equal(env.get('NO_PROXY'), QODER_NO_PROXY);
    // Windows env is case-insensitive: a second spelling would be a drift twin.
    assert.equal(env.has('no_proxy'), false);
    assert.match(lines.find((line) => classify(line, 'win32') === 'launch') ?? '', /--proxy-server=http:\/\/127\.0\.0\.1:4555/);
  });

  it('keeps loopback out of the proxy hop', () => {
    for (const host of ['localhost', '127.0.0.1', '::1']) assert.equal(QODER_NO_PROXY.includes(host), true);
  });
});

describe('qoder launcher — strict credentials', () => {
  it('carries the key in Chromium and Node/gRPC proxy URLs', () => {
    const script = buildQoderLauncher({
      platform: 'win32',
      ...base,
      proxyCredential: 'sk-ocr-key',
    });
    assert.match(script, /--proxy-server=http:\/\/ocr:sk-ocr-key@127\.0\.0\.1:4555/);
    assert.match(script, /grpc_proxy=http:\/\/ocr:sk-ocr-key@127\.0\.0\.1:4555/);
    assert.match(script, /https_proxy=http:\/\/ocr:sk-ocr-key@127\.0\.0\.1:4555/);
  });

  it('percent-encodes the CLI launcher credential', () => {
    const text = buildQoderCliLauncher({
      platform: 'linux',
      binary: '/usr/bin/qodercli',
      port: 4556,
      proxyCredential: 'a b&c',
    });
    assert.match(text, /https_proxy="?http:\/\/ocr:a%20b%26c@127\.0\.0\.1:4556/);
    assert.match(text, /grpc_proxy="?http:\/\/ocr:a%20b%26c@127\.0\.0\.1:4556/);
  });
});

describe('qoder launcher — POSIX', () => {
  it('exports grpc_proxy, both http(s)_proxy spellings and both no_proxy spellings', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const script = buildQoderLauncher({ platform, binary: '/opt/Qoder/qoder', ...base, caPath: undefined });
      const lines = statements(script, platform);
      assert.equal(lines[0], '#!/bin/sh');
      const env = assignments(lines, platform);
      assert.equal(env.get('grpc_proxy'), PROXY_URL);
      assert.equal(env.get('https_proxy'), PROXY_URL);
      assert.equal(env.get('http_proxy'), PROXY_URL);
      assert.equal(env.get('NO_PROXY'), QODER_NO_PROXY);
      assert.equal(env.get('no_proxy'), QODER_NO_PROXY);
      assert.equal(env.has('NODE_EXTRA_CA_CERTS'), false, 'no CA path passed, no CA export');
      for (const line of lines) assert.notEqual(classify(line, platform), 'stray', line);
    }
  });

  it('detaches on macOS so closing the terminal window cannot kill Qoder', () => {
    const mac = buildQoderLauncher({ platform: 'darwin', binary: '/Applications/Qoder.app/Contents/MacOS/Qoder', ...base });
    assert.match(mac, /^nohup .* &$/m);
    const linux = buildQoderLauncher({ platform: 'linux', binary: '/opt/Qoder/qoder', ...base });
    assert.match(linux, /^exec /m);
  });
});

describe('qoder launcher path', () => {
  it('lives under the OCR home clients directory', () => {
    const file = launcherPath().split(/[\\/]/).pop() ?? '';
    assert.match(file, /^qoder-launcher\.(cmd|sh|command)$/);
  });
});

/**
 * The client only refreshes a catalog that EXISTS but is stale; deleting it
 * makes `get_models` return an empty list forever. Setup must therefore
 * backdate, never rename, and must undo renames left by older builds.
 */
describe('qoder model catalog freshness', () => {
  it('backdates catalog-v<N> in place and leaves everything else alone', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-home-'));
    const uid = path.join(home, '.models', 'uid-1');
    fs.mkdirSync(path.join(uid, 'external-providers'), { recursive: true });
    fs.writeFileSync(path.join(uid, 'catalog-v7'), '{"app":[]}');
    fs.writeFileSync(path.join(uid, 'notes.txt'), 'keep');
    fs.writeFileSync(path.join(uid, 'external-providers', 'catalog-v7-abc'), 'keep');

    assert.equal(countFreshCatalogs(home), 1, 'just written, so fresh');
    const staled = staleModelCatalog(home);
    assert.deepEqual(staled, [path.join(uid, 'catalog-v7')]);
    assert.equal(countFreshCatalogs(home), 0, 'the client now refreshes in the background');
    assert.equal(fs.existsSync(path.join(uid, 'catalog-v7')), true, 'the file must stay readable');
    assert.equal(fs.readFileSync(path.join(uid, 'catalog-v7'), 'utf8'), '{"app":[]}');
    assert.equal(fs.existsSync(path.join(uid, 'notes.txt')), true);
    assert.equal(fs.existsSync(path.join(uid, 'external-providers', 'catalog-v7-abc')), true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('a missing data home is not an error', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-empty-'));
    assert.equal(countFreshCatalogs(home), 0);
    assert.deepEqual(staleModelCatalog(home), []);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

/**
 * Two launchers, two trust stories. The desktop (Electron) daemon drops
 * NODE_OPTIONS and ignores NODE_EXTRA_CA_CERTS, so its script disables
 * verification for that process; qodercli is plain Node and can use the clean
 * system-root switch.
 */
describe('qoder CLI launcher', () => {
  it('runs qodercli with argv passthrough and the clean system-CA switch', () => {
    const text = buildQoderCliLauncher({
      platform: 'win32',
      binary: 'C:\\npm\\qodercli.cmd',
      port: 4556,
      caPath: 'C:\\ca.pem',
    });
    assert.match(text, /NODE_OPTIONS=--use-system-ca/);
    assert.match(text, /C:\\npm\\qodercli\.cmd/);
    assert.match(text, /call "C:\\npm\\qodercli\.cmd" %\*/, 'call keeps the caller cmd alive');
    assert.match(text, /exit \/b %ERRORLEVEL%/);
    assert.doesNotMatch(text, /NODE_TLS_REJECT_UNAUTHORIZED/, 'the CLI does not need verification disabled');
    assert.doesNotMatch(text, /--proxy-server/, 'the CLI reads http(s)_proxy, not a Chromium flag');
    assert.match(text, /https_proxy=http:\/\/127\.0\.0\.1:4556/);
    assert.match(text, /grpc_proxy=http:\/\/127\.0\.0\.1:4556/);
    assert.ok(text.includes(`NO_PROXY=${QODER_NO_PROXY}`));
  });

  it('the desktop launcher carries the daemon TLS workaround', () => {
    const text = buildQoderLauncher({ platform: 'win32', binary: 'C:\\Qoder.exe', port: 4556, caPath: 'C:\\ca.pem' });
    assert.match(text, /NODE_TLS_REJECT_UNAUTHORIZED=0/);
    assert.match(text, /--proxy-server=http:\/\/127\.0\.0\.1:4556/);
  });

  it('detects qodercli on PATH and honours QODERCLI_BIN', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-cli-'));
    const name = process.platform === 'win32' ? 'qodercli.cmd' : 'qodercli';
    const stub = path.join(dir, name);
    fs.writeFileSync(stub, '');
    assert.equal(detectQoderCliBin({ PATH: dir }), stub);
    assert.equal(detectQoderCliBin({ PATH: path.join(dir, 'nowhere') }), null);
    const override = path.join(dir, 'custom-cli');
    fs.writeFileSync(override, '');
    assert.equal(detectQoderCliBin({ PATH: '', QODERCLI_BIN: override }), override);
    assert.equal(detectQoderCliBin({ PATH: '', QODERCLI_BIN: path.join(dir, 'missing') }), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CursorClientAdapter, CURSOR_NO_PROXY, LEGACY_MODELS_JSON_PATH, agentLauncherPath, buildCursorLaunchers, launcherPath, pemBundleContainsCa } from '../src/cli/clients/cursor.js';
import { getEnvPaths } from '../src/config/env.js';

/**
 * Cursor's per-app hook has TWO proxy surfaces: Chromium's `--proxy-server`
 * flag and the lowercase http(s)_proxy env vars read by Electron's Node/gRPC
 * legs. The launcher must carry both, trust the OCR CA on the Node side
 * (bundled Mozilla roots, not the OS store) and keep loopback out of the hop.
 * These are pure script assertions — no Cursor install, no live proxy — plus
 * one behavioural setup case for the POSIX exec bit.
 */

const base = {
  binary: 'C:\\Apps\\Cursor.exe',
  agentBinary: 'C:\\Apps\\cursor-agent.exe',
  port: 4555,
  caPath: 'C:\\ocr\\forward-proxy\\ca.pem',
};

const PROXY_URL = `http://127.0.0.1:${base.port}`;

type ScriptLineKind = 'preamble' | 'comment' | 'env' | 'launch' | 'exit' | 'stray';

/** win32 main: `@echo off` + `setlocal`, two REM lines, four env lines, launch. */
const WIN32_SEQUENCE: ScriptLineKind[] = ['preamble', 'preamble', 'comment', 'comment', 'env', 'env', 'env', 'env', 'launch'];
/** The win32 CLI launcher adds the `exit /b` that returns the shim's code. */
const WIN32_AGENT_SEQUENCE: ScriptLineKind[] = [...WIN32_SEQUENCE, 'exit'];
/** POSIX: the shebang, two comments, five env lines, launch. */
const POSIX_SEQUENCE: ScriptLineKind[] = ['preamble', 'comment', 'comment', 'env', 'env', 'env', 'env', 'env', 'launch'];

/** The platform's own line ending: the generator joins on it, so a script that
 *  mixed endings would break cmd.exe / a POSIX shell — not just this test. */
function lineEnding(platform: NodeJS.Platform): string {
  return platform === 'win32' ? '\r\n' : '\n';
}

/** The script's statements, split on the platform's line ending. The generator
 *  terminates its join with one line ending, so trailing blanks are dropped. */
function statements(script: string, platform: NodeJS.Platform): string[] {
  const lines = script.split(lineEnding(platform));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Classify one generated line by SHAPE. Comment TEXT is deliberately not
 *  pinned (rewording a REM must not fail a contract test), but anything that is
 *  none of the known shapes is `stray` — which is the check an `includes()`
 *  over the whole script can never make. */
function classify(line: string, platform: NodeJS.Platform): ScriptLineKind {
  if (platform === 'win32') {
    if (line === '@echo off' || line === 'setlocal') return 'preamble';
    if (/^REM /.test(line)) return 'comment';
    if (/^set "[A-Za-z_]\w*=/.test(line)) return 'env';
    if (/^(?:start|call) "/.test(line)) return 'launch';
    if (/^exit \/b /.test(line)) return 'exit';
    return 'stray';
  }
  if (line === '#!/bin/sh') return 'preamble';
  if (/^# /.test(line)) return 'comment';
  if (/^export [A-Za-z_]\w*=/.test(line)) return 'env';
  if (/^(?:exec|nohup) /.test(line)) return 'launch';
  return 'stray';
}

/** Ordered `set` / `export` assignments, with name and value split apart. */
function envAssignments(script: string, platform: NodeJS.Platform): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const line of statements(script, platform)) {
    if (classify(line, platform) !== 'env') continue;
    const match = platform === 'win32' ? /^set "([^=]+)=(.*)"$/.exec(line) : /^export ([^=]+)="(.*)"$/.exec(line);
    assert.ok(match, `an env line must be fully quoted: ${line}`);
    out.push({ name: match[1], value: match[2] });
  }
  return out;
}

/** No env name may be assigned twice. Windows' env block is case-insensitive
 *  (`no_proxy` IS `NO_PROXY` there); POSIX is not, and needs both spellings. */
function assertUniqueEnvNames(script: string, platform: NodeJS.Platform): void {
  const names = envAssignments(script, platform).map((a) => (platform === 'win32' ? a.name.toLowerCase() : a.name));
  assert.deepEqual(names, [...new Set(names)], `duplicate env assignment in: ${names.join(', ')}`);
}

/** The script's statement SEQUENCE, by kind. A stray line is anything that
 *  shifts it: one extra statement, a moved env block, a launch that is not
 *  last. Comment TEXT stays free, the COUNT does not — a launcher script is a
 *  fixed shape and one extra line is one extra thing cmd.exe / sh will run. */
function assertStatementSequence(script: string, platform: NodeJS.Platform, expected: ScriptLineKind[]): void {
  assert.deepEqual(statements(script, platform).map((line) => classify(line, platform)), expected);
}

/** The ONE launch line of a script: exactly one statement may start the app and
 *  it must be the LAST statement — a forwarding suffix that landed in an
 *  earlier statement (or inside a quoted argument) never sees the caller's
 *  args. The only sanctioned tail is the win32 CLI launcher's `exit /b`, which
 *  must come AFTER the call to carry the shim's exit code back. */
function launchStatement(script: string, platform: NodeJS.Platform): string {
  const all = statements(script, platform);
  const stray = all.filter((line) => classify(line, platform) === 'stray');
  assert.deepEqual(stray, [], `no unrecognised statement expected: ${stray.join(' | ')}`);
  const launches = all.filter((line) => classify(line, platform) === 'launch');
  assert.equal(launches.length, 1, `exactly one launch line expected, got: ${launches.join(' | ')}`);
  const tail = classify(all[all.length - 1], platform) === 'exit' ? all.slice(0, -1) : all;
  assert.equal(tail[tail.length - 1], launches[0], `the launch line must be the last statement: ${all.join(' | ')}`);
  return launches[0];
}

/** A binary as a regex, quoted: the launcher must quote it so a path with a
 *  space cannot split the command. */
function quotedBinary(binary: string): RegExp {
  return new RegExp(`"${binary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
}

/** The launch line's SHAPE, asserted on that single line (never as a substring
 *  of the whole file): quoted binary, the Chromium flag naming the gateway, and
 *  the platform's argument-forwarding suffix as the line's tail. */
function assertLaunchShape(line: string, platform: NodeJS.Platform, binary: string): void {
  assert.match(line, quotedBinary(binary), `the binary must be quoted on the launch line: ${line}`);
  assert.match(line, /--proxy-server=http:\/\/127\.0\.0\.1:4555(?!\d)/, `the gateway must be the Chromium proxy: ${line}`);
  assert.match(line, platform === 'win32' ? / %\*$/ : / "\$@"(?: |$)/, `the forwarding suffix must end the launch line: ${line}`);
}

/** The exact win32 env contract, in order: the CA, both proxy spellings, and
 *  ONE case-insensitive `NO_PROXY`. */
const WIN32_ENV = [
  { name: 'NODE_EXTRA_CA_CERTS', value: base.caPath },
  { name: 'https_proxy', value: PROXY_URL },
  { name: 'http_proxy', value: PROXY_URL },
  { name: 'NO_PROXY', value: CURSOR_NO_PROXY },
];

/** The POSIX env contract: the same lines plus the lowercase `no_proxy`, which
 *  a case-sensitive shell needs alongside the uppercase one. */
function posixEnv(caPath: string): { name: string; value: string }[] {
  return [
    { name: 'NODE_EXTRA_CA_CERTS', value: caPath },
    { name: 'https_proxy', value: PROXY_URL },
    { name: 'http_proxy', value: PROXY_URL },
    { name: 'NO_PROXY', value: CURSOR_NO_PROXY },
    { name: 'no_proxy', value: CURSOR_NO_PROXY },
  ];
}

describe('Cursor launcher scripts', () => {
  it('win32 carries the Chromium flag, the Node env and the loopback bypass', () => {
    const { main, agent } = buildCursorLaunchers({ platform: 'win32', ...base });

    assertStatementSequence(main, 'win32', WIN32_SEQUENCE);
    assert.deepEqual(envAssignments(main, 'win32'), WIN32_ENV);
    assertUniqueEnvNames(main, 'win32');
    assertLaunchShape(launchStatement(main, 'win32'), 'win32', base.binary);
    assert.ok(!main.includes('export '), 'a win32 script must not carry POSIX exports');

    assert.ok(agent);
    assertStatementSequence(agent, 'win32', WIN32_AGENT_SEQUENCE);
    assert.deepEqual(envAssignments(agent, 'win32'), WIN32_ENV);
    assertUniqueEnvNames(agent, 'win32');
    // The CLI launcher forwards the caller's args but never carries the
    // Chromium flag — that one belongs to the IDE.
    assert.equal(launchStatement(agent, 'win32'), `call "${base.agentBinary}" %*`);
    assert.ok(!agent.includes('--proxy-server'));
  });

  it('win32 scopes the env to the launcher and calls the CLI shim', () => {
    const { main, agent } = buildCursorLaunchers({ platform: 'win32', ...base });

    for (const body of [main, agent!]) {
      // `setlocal` as the first statement after `@echo off`: without it the
      // `set` lines rewrite the CALLING shell's proxy env and echo state.
      assert.deepEqual(statements(body, 'win32').slice(0, 2), ['@echo off', 'setlocal']);
    }
    // `cursor-agent` may be a .cmd shim: `call` keeps an `exit` inside it from
    // killing the caller's cmd.exe, and the exit code still comes back — so the
    // `exit /b` tail is deliberate AND last.
    assert.deepEqual(statements(agent!, 'win32').slice(-2), [`call "${base.agentBinary}" %*`, 'exit /b %ERRORLEVEL%']);
  });

  it('win32 sets ONE no_proxy variable — the env block is case-insensitive', () => {
    const { main, agent } = buildCursorLaunchers({ platform: 'win32', ...base });

    for (const body of [main, agent!]) {
      const noProxy = envAssignments(body, 'win32').filter((a) => a.name.toLowerCase() === 'no_proxy');
      assert.deepEqual(noProxy, [{ name: 'NO_PROXY', value: CURSOR_NO_PROXY }]);
    }
  });

  it('posix exports the same contract, in BOTH no_proxy spellings', () => {
    const caPath = '/home/u/.omnicell-router/forward-proxy/ca.pem';
    const { main } = buildCursorLaunchers({ platform: 'linux', binary: '/opt/cursor/cursor', agentBinary: null, port: 4555, caPath });

    assertStatementSequence(main, 'linux', POSIX_SEQUENCE);
    assert.deepEqual(envAssignments(main, 'linux'), posixEnv(caPath));
    assertUniqueEnvNames(main, 'linux');
    // Linux `.sh` is terminal-launched by design: `exec` keeps it in the
    // foreground so its exit status is the caller's.
    const launch = launchStatement(main, 'linux');
    assert.match(launch, /^exec /, `linux must exec in the foreground: ${launch}`);
    assertLaunchShape(launch, 'linux', '/opt/cursor/cursor');
    assert.ok(!main.includes('nohup'));
    assert.ok(!main.includes('set '));
    assert.ok(!main.includes('setlocal'));
  });

  it('posix quotes the values so a path with a space survives', () => {
    const caPath = '/Users/Jane Doe/.omnicell-router/forward-proxy/ca.pem';
    const { main } = buildCursorLaunchers({
      platform: 'darwin',
      binary: '/Applications/Cursor.app/Contents/MacOS/Cursor',
      agentBinary: null,
      port: 4555,
      caPath,
    });

    // An unquoted `export K=v` truncates at the first space — a macOS home
    // directory with a space would silently point Node at the wrong CA file.
    // The parsed value keeping the WHOLE path is what the quoting buys.
    assert.deepEqual(envAssignments(main, 'darwin'), posixEnv(caPath));
    assertUniqueEnvNames(main, 'darwin');
  });

  it('darwin carries the same env contract through a .command body', () => {
    const caPath = '/Users/u/.omnicell-router/forward-proxy/ca.pem';
    const binary = '/Applications/Cursor.app/Contents/MacOS/Cursor';
    const { main, agent } = buildCursorLaunchers({
      platform: 'darwin',
      binary,
      agentBinary: '/Users/u/.cursor/bin/cursor-agent',
      port: 4555,
      caPath,
    });

    assert.equal(statements(main, 'darwin')[0], '#!/bin/sh');
    assertStatementSequence(main, 'darwin', POSIX_SEQUENCE);
    assert.deepEqual(envAssignments(main, 'darwin'), posixEnv(caPath));
    assertUniqueEnvNames(main, 'darwin');
    // The `.command` runs in a Terminal window: Cursor is detached (`nohup … &`)
    // so closing that window does not SIGHUP it.
    const launch = launchStatement(main, 'darwin');
    assert.match(launch, /^nohup /, `darwin must detach: ${launch}`);
    assertLaunchShape(launch, 'darwin', binary);
    assert.match(launch, />\/dev\/null 2>&1 &$/, `the detached launch must not hold the terminal: ${launch}`);
    assert.ok(!main.includes('exec "'));

    // The CLI launcher stays foreground — it IS the terminal session.
    assert.ok(agent);
    assertStatementSequence(agent, 'darwin', POSIX_SEQUENCE);
    assert.deepEqual(envAssignments(agent, 'darwin'), posixEnv(caPath));
    assert.equal(launchStatement(agent, 'darwin'), 'exec "/Users/u/.cursor/bin/cursor-agent" "$@"');
    assert.ok(!agent.includes('--proxy-server'));
  });

  it('omits the CLI launcher when cursor-agent is absent', () => {
    const scripts = buildCursorLaunchers({ platform: 'win32', binary: base.binary, agentBinary: null, port: 4555, caPath: base.caPath });
    assert.equal(scripts.agent, undefined);
  });
});

describe('Cursor adapter teardown', () => {
  it('removes BOTH launchers and the legacy models artifact, not only the IDE one', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cursor-launcher-'));
    const previous = process.env.OCR_HOME;
    process.env.OCR_HOME = home;
    try {
      // Fixture derived from the exported helpers, never re-spelled here: the
      // filename, the platform extension and the legacy path are the adapter's
      // contract, so a rename must fail THIS test only where it really broke.
      const files = [launcherPath(), agentLauncherPath(), path.join(home, LEGACY_MODELS_JSON_PATH)];
      for (const file of files) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'managed');
      }

      const result = await new CursorClientAdapter().teardown();

      assert.equal(result.success, true);
      for (const file of files) assert.equal(fs.existsSync(file), false);
    } finally {
      if (previous === undefined) delete process.env.OCR_HOME;
      else process.env.OCR_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * Setup writes real files, so its file-system contract needs a real run: the
 * per-file sandbox OCR_HOME gets a config with `forwardProxy` enabled and a CA
 * on disk, and both binaries are pinned through the adapters' env overrides.
 * POSIX only — Windows has no exec bit.
 */
if (process.platform !== 'win32') {
  describe('Cursor adapter setup (POSIX)', () => {
    /** Point the adapter at a sandboxed forward proxy; returns the restore fn. */
    const armSandbox = (): (() => void) => {
      const configPath = getEnvPaths().configPath;
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cursor-setup-'));
      const caDir = path.join(home, 'forward-proxy');
      fs.mkdirSync(caDir, { recursive: true });
      fs.writeFileSync(path.join(caDir, 'ca.pem'), 'test-ca');
      const binary = path.join(home, 'Cursor');
      const agent = path.join(home, 'cursor-agent');
      for (const p of [binary, agent]) fs.writeFileSync(p, '');

      const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        [
          'schemaVersion: 1',
          'client:',
          '  forwardProxy:',
          '    enabled: true',
          `    caDir: ${JSON.stringify(caDir)}`,
          '    rules: [{match: "*", ingress: intercept, egress: proxy}]',
          '',
        ].join('\n')
      );
      const previous = {
        CURSOR_BIN: process.env.CURSOR_BIN,
        CURSOR_AGENT_BIN: process.env.CURSOR_AGENT_BIN,
      };
      process.env.CURSOR_BIN = binary;
      process.env.CURSOR_AGENT_BIN = agent;

      return () => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        if (original === null) fs.rmSync(configPath, { force: true });
        else fs.writeFileSync(configPath, original);
        fs.rmSync(home, { recursive: true, force: true });
      };
    };

    it('re-arms the exec bit on pre-existing launchers', async () => {
      const restore = armSandbox();
      try {
        const targets = [launcherPath(), agentLauncherPath()];
        for (const p of targets) {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          // 0644: what a restored backup / a copy / an older build leaves behind.
          fs.writeFileSync(p, 'stale', 'utf8');
          fs.chmodSync(p, 0o644);
          assert.equal(fs.statSync(p).mode & 0o111, 0, `precondition: ${path.basename(p)} is not executable`);
        }

        const result = await new CursorClientAdapter().setup();

        assert.equal(result.success, true);
        for (const p of targets) {
          assert.notEqual(fs.statSync(p).mode & 0o111, 0, `${path.basename(p)} must be executable after setup`);
          assert.ok(fs.readFileSync(p, 'utf8').startsWith('#!/bin/sh'));
        }
      } finally {
        restore();
      }
    });
  });
}

describe('CA bundle probe', () => {
  const body = 'TUlJQ3RBSVNBREJBR0NTcUdTSWIzRFFFSEJxQ0NBd0F3Z2dM';
  const pem = `-----BEGIN CERTIFICATE-----\n${body.slice(0, 32)}\n${body.slice(32)}\n-----END CERTIFICATE-----\n`;

  it('matches the same certificate across PEM line wrapping', () => {
    const bundle = `-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n${pem.replace(/\n/g, '\r\n')}`;
    assert.equal(pemBundleContainsCa(bundle, pem), true);
  });

  it('does not match a different certificate body', () => {
    const other = '-----BEGIN CERTIFICATE-----\nREVG\n-----END CERTIFICATE-----\n';
    assert.equal(pemBundleContainsCa(other, pem), false);
  });
});

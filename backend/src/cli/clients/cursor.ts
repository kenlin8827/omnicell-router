import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClientAdapter, ClientActionResult, probeClientVersion, resolveForwardProxyEndpoint, runCommand } from './base.js';
import { ClientHookStatus } from '../types.js';
import { getOcrHomeDir } from '../paths.js';
import { getForwardProxyStatus } from '../../forward-proxy/status.js';
import { CA_CN } from '../../forward-proxy/ca.js';

/**
 * Cursor client adapter — proxy-access hook (no config-file rewrite).
 *
 * Cursor cannot be pointed at a custom LLM endpoint by configuration: its AI
 * traffic is hardcoded to api2.cursor.sh. The `cursor` plugin MITMs those
 * hosts through OCR's inbound forward proxy. This adapter therefore "hooks"
 * Cursor by publishing launch scripts (<ocrHome>/clients/cursor-launcher.*
 * and, when the CLI exists, cursor-agent-launcher.*) that start Cursor/the
 * CLI through the forward proxy: `--proxy-server` for Chromium legs, plus the
 * lowercase http(s)_proxy + NODE_EXTRA_CA_CERTS + NO_PROXY environment for
 * Electron's Node/gRPC legs (they ignore the flag and the OS cert store).
 * Non-LLM destinations forward transparently.
 *
 * The launchers are the ONLY artifact this adapter writes: phase 1 publishes
 * no model advertisement (the plugin's `AvailableModels` arrives in phase 2).
 * The CA trust and Cursor's own files are NEVER touched by setup/teardown;
 * getStatus only PROBES CA trust (best-effort, honest unknown) so the console
 * can show what still needs manual action.
 */


/** Well-known Cursor install locations, per platform. */
function cursorBinaryCandidates(): string[] {
  switch (process.platform) {
    case 'win32': {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return [
        path.join(localAppData, 'Programs', 'cursor', 'Cursor.exe'),
        path.join(localAppData, 'Programs', 'Cursor', 'Cursor.exe'),
        path.join(localAppData, 'cursor', 'Cursor.exe'),
      ];
    }
    case 'darwin':
      return [
        '/Applications/Cursor.app/Contents/MacOS/Cursor',
        path.join(os.homedir(), 'Applications', 'Cursor.app/Contents/MacOS/Cursor'),
      ];
    default:
      return [
        '/usr/bin/cursor',
        '/usr/local/bin/cursor',
        '/opt/cursor/cursor',
        '/opt/Cursor/cursor',
        '/usr/share/cursor/cursor',
        // AppImage installs are first-class on Linux: the binary IS the file.
        path.join(os.homedir(), 'Applications', 'Cursor.AppImage'),
        path.join(os.homedir(), 'Applications', 'cursor.AppImage'),
        '/opt/Cursor.AppImage',
        '/opt/cursor.AppImage',
      ];
  }
}

/** The detected Cursor binary path, or null. `CURSOR_BIN` wins so an install
 *  layout outside the well-known list (Nix, custom AppImage, snap wrapper) can
 *  still be hooked without editing this table. */
function detectCursorBinary(): string | null {
  const override = process.env.CURSOR_BIN?.trim();
  if (override && fs.existsSync(override)) return override;
  const hit = cursorBinaryCandidates().find(p => fs.existsSync(p));
  return hit || null;
}
/** Well-known cursor-agent CLI locations, per platform. */
function agentBinaryCandidates(): string[] {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return [
        path.join(home, 'AppData', 'Local', 'cursor-agent', 'cursor-agent.exe'),
        path.join(home, 'AppData', 'Local', 'cursor-agent', 'cursor-agent.cmd'),
        path.join(home, '.cursor', 'cursor-agent.exe'),
        path.join(home, '.cursor', 'cursor-agent.cmd'),
      ];
    case 'darwin':
      return [
        path.join(home, '.cursor', 'bin', 'cursor-agent'),
        '/usr/local/bin/cursor-agent',
      ];
    default:
      return [
        path.join(home, '.local', 'bin', 'cursor-agent'),
        '/usr/local/bin/cursor-agent',
        '/usr/bin/cursor-agent',
      ];
  }
}

/** The detected cursor-agent CLI binary path, or null. `CURSOR_AGENT_BIN`
 *  overrides the well-known table for non-standard installs. */
function detectAgentBinary(): string | null {
  const override = process.env.CURSOR_AGENT_BIN?.trim();
  if (override && fs.existsSync(override)) return override;
  const hit = agentBinaryCandidates().find(p => fs.existsSync(p));
  return hit || null;
}

/** Launcher script extension per platform (darwin gets a double-clickable .command). */
function launcherExtension(): string {
  return process.platform === 'win32' ? '.cmd' : process.platform === 'darwin' ? '.command' : '.sh';
}

function clientsDir(): string {
  return path.join(getOcrHomeDir(), 'clients');
}

export function launcherPath(): string {
  return path.join(clientsDir(), `cursor-launcher${launcherExtension()}`);
}

/** The CLI launcher — written only while `cursor-agent` is installed. */
export function agentLauncherPath(): string {
  return path.join(clientsDir(), `cursor-agent-launcher${launcherExtension()}`);
}

/** ocrHome-relative location of the ≤0.1.x model advertisement. Teardown still
 *  removes it after an upgrade; setup never writes it (phase 1 publishes no
 *  model list). */
export const LEGACY_MODELS_JSON_PATH = path.join('gateways', 'cursor', 'models.json');

/**
 * Loopback never enters the proxy hop. Cursor's Node legs inherit the proxy
 * env vars set by the launcher, and proxying its own local services (language
 * server, extension host, a project's dev server) would tie them to the
 * gateway's lifetime. Both spellings are set on POSIX because libraries differ
 * on which one they read; Windows env blocks are case-insensitive, so `set`
 * emits ONE variable there.
 */
export const CURSOR_NO_PROXY = 'localhost,127.0.0.1,::1';

export interface CursorLauncherScripts {
  main: string;
  agent?: string;
}

/**
 * The launcher text for one platform. Pure so the env contract is testable
 * without a real Cursor install:
 *   - `--proxy-server` covers Chromium legs;
 *   - lowercase `http(s)_proxy` covers Electron's Node/gRPC legs (they ignore
 *     the flag);
 *   - `NODE_EXTRA_CA_CERTS` covers Node's bundled Mozilla roots (the OS store
 *     is not consulted there);
 *   - `NO_PROXY`/`no_proxy` keeps loopback out of the proxy (one variable on
 *     Windows — the env block is case-insensitive there).
 *
 * Windows bodies open with `setlocal`: the `set` lines would otherwise rewrite
 * the CALLING shell's proxy env for the rest of its life, and the agent body
 * `call`s the target so an `exit` inside a `.cmd` shim cannot kill the caller.
 *
 * POSIX assignments quote the VALUE (`export K="v"`): a home directory with a
 * space in it (routine on macOS) would otherwise truncate `NODE_EXTRA_CA_CERTS`
 * at the first space. Both Windows bodies forward the caller's arguments with
 * `%*` — `cmd.exe` re-expands them on `call`, which is the caller's business.
 */
export function buildCursorLaunchers(args: {
  platform: NodeJS.Platform;
  binary: string;
  agentBinary?: string | null;
  port: number;
  caPath?: string;
}): CursorLauncherScripts {
  const proxy = `http://127.0.0.1:${args.port}`;
  const win = args.platform === 'win32';
  // Quote the value so a CA path containing `&`, `^` or spaces cannot break
  // the script.
  const env = (k: string, v: string): string => (win ? `set "${k}=${v}"` : `export ${k}="${v}"`);
  const envBlock = (): string[] => [
    ...(args.caPath ? [env('NODE_EXTRA_CA_CERTS', args.caPath)] : []),
    env('https_proxy', proxy),
    env('http_proxy', proxy),
    env('NO_PROXY', CURSOR_NO_PROXY),
    // Windows env blocks are case-insensitive: `no_proxy` IS `NO_PROXY`, so a
    // second `set` would only overwrite the first line.
    ...(win ? [] : [env('no_proxy', CURSOR_NO_PROXY)]),
  ];
  const main = win
    ? [
        '@echo off',
        'setlocal',
        'REM omnicell-router-managed launcher: start Cursor through the OCR forward proxy.',
        'REM Regenerated by `ocr setup cursor`; manual edits are overwritten on the next setup.',
        ...envBlock(),
        `start "" "${args.binary}" --proxy-server=${proxy} %*`,
        '',
      ].join('\r\n')
    : [
        '#!/bin/sh',
        '# omnicell-router-managed launcher: start Cursor through the OCR forward proxy.',
        '# Regenerated by `ocr setup cursor`; manual edits are overwritten on the next setup.',
        ...envBlock(),
        // macOS: the `.command` runs inside a Terminal window, so `exec` would
        // make Cursor that window's child — closing the window SIGHUPs Cursor.
        // Detach instead; the Linux `.sh` stays `exec` (terminal-launched by
        // design, and its exit status is the point).
        args.platform === 'darwin'
          ? `nohup "${args.binary}" --proxy-server=${proxy} "$@" >/dev/null 2>&1 &`
          : `exec "${args.binary}" --proxy-server=${proxy} "$@"`,
        '',
      ].join('\n');
  if (!args.agentBinary) return { main };
  const agent = win
    ? [
        '@echo off',
        'setlocal',
        'REM omnicell-router-managed launcher: run cursor-agent through the OCR forward proxy.',
        'REM Regenerated by `ocr setup cursor`; manual edits are overwritten on the next setup.',
        ...envBlock(),
        // `call` + `exit /b`: the target may be a `.cmd` shim whose own `exit`
        // would otherwise terminate the caller's cmd.exe.
        `call "${args.agentBinary}" %*`,
        'exit /b %ERRORLEVEL%',
        '',
      ].join('\r\n')
    : [
        '#!/bin/sh',
        '# omnicell-router-managed launcher: run cursor-agent through the OCR forward proxy.',
        '# Regenerated by `ocr setup cursor`; manual edits are overwritten on the next setup.',
        ...envBlock(),
        `exec "${args.agentBinary}" "$@"`,
        '',
      ].join('\n');
  return { main, agent };
}



/** Trust-anchor directories used by the mainstream Linux distro families. */
const LINUX_CA_DIRS = [
  '/usr/local/share/ca-certificates', // Debian/Ubuntu — update-ca-certificates
  '/etc/pki/ca-trust/source/anchors', // Fedora/RHEL — update-ca-trust
  '/etc/pki/trust/anchors', // SUSE
];

/** NSS databases Chromium/Electron consult on Linux (`certutil -d sql:<db>`).
 *  A distro bundle update does NOT reach these, so they need their own check. */
const LINUX_NSS_DATABASES = [path.join(os.homedir(), '.pki', 'nssdb'), '/etc/pki/nssdb'];

/**
 * True when `bundlePem` (a merged trust bundle such as
 * /etc/ssl/certs/ca-certificates.crt) carries the exact certificate `caPem`.
 * `update-ca-certificates` appends the PEM body verbatim, so a normalized
 * substring match is enough — no OpenSSL dependency, no CN parsing.
 */
export function pemBundleContainsCa(bundlePem: string, caPem: string): boolean {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(caPem);
  const body = match?.[1].replace(/\s+/g, '');
  return body !== undefined && bundlePem.replace(/\s+/g, '').includes(body);
}

/** Linux trust: file anchors, the merged bundle, then the NSS databases that
 *  Chromium/Electron actually read. Any hit is proof; every probe failing to
 *  run leaves the answer 'unknown' instead of a dishonest false. */
async function probeLinuxCaTrusted(caPath?: string): Promise<boolean | 'unknown'> {
  let checked = false;
  for (const dir of LINUX_CA_DIRS) {
    try {
      if (!fs.existsSync(dir)) continue;
      checked = true;
      if (fs.readdirSync(dir).some(e => /omnicell|ocr-forward-proxy/i.test(e))) return true;
    } catch {
      // unreadable anchor dir = this check did not run
    }
  }
  if (caPath) {
    try {
      const caPem = fs.readFileSync(caPath, 'utf8');
      for (const bundle of ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/ca-bundle.pem']) {
        if (!fs.existsSync(bundle)) continue;
        checked = true;
        if (pemBundleContainsCa(fs.readFileSync(bundle, 'utf8'), caPem)) return true;
      }
    } catch {
      // unreadable bundle = this check did not run
    }
  }
  const nssDbs = LINUX_NSS_DATABASES.filter(db => fs.existsSync(db));
  if (nssDbs.length > 0) {
    for (const db of nssDbs) {
      const r = await runCommand('certutil', ['-d', `sql:${db}`, '-L']);
      if (/ENOENT|not found/i.test(r.stderr) && !r.stdout) continue; // no certutil → cannot judge
      checked = true;
      if (r.ok && new RegExp(CA_CN, 'i').test(r.stdout)) return true;
    }
  }
  return checked ? false : 'unknown';
}

/** macOS trust: `security verify-cert` evaluates the REAL SSL trust policy
 *  for our own cert file, so a non-zero exit is a definite NOT-trusted. The
 *  keychain PRESENCE probe (`find-certificate -c <CN>`) only proves the cert
 *  was added — a CA imported with default trust settings sits in the keychain
 *  and still fails Cursor's TLS — so it is consulted ONLY when verify-cert
 *  could not run at all, never as a second opinion on a failed verdict. */
async function probeDarwinCaTrusted(caPath?: string): Promise<boolean | 'unknown'> {
  if (!caPath) return 'unknown';
  const v = await runCommand('security', ['verify-cert', '-c', caPath, '-p', 'ssl']);
  if (v.ok) return true;
  if (!/ENOENT|command not found/i.test(v.stderr)) return false;
  for (const keychain of ['/Library/Keychains/System.keychain', path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db')]) {
    const r = await runCommand('security', ['find-certificate', '-c', CA_CN, keychain]);
    if (r.ok) return true;
  }
  return 'unknown';
}

/**
 * Best-effort platform probe: is the OCR forward-proxy CA trusted?
 * Returns true/false; 'unknown' means the probe itself failed (missing tool,
 * permission error) — the UI text stays honest about it.
 *
 * `caPath` is the PEM the client must trust; macOS verifies THAT file against
 * the keychain trust policy, Linux matches its body inside the distro bundle.
 */
async function probeCaTrusted(caPath?: string): Promise<boolean | 'unknown'> {
  try {
    if (process.platform === 'win32') {
      // certutil dumps both Local Machine and Current User Root stores; our CA
      // is trusted only if its CN appears in one of them.
      const machine = await runCommand('certutil', ['-store', 'Root']);
      const user = await runCommand('certutil', ['-user', '-store', 'Root']);
      const rx = new RegExp(CA_CN, 'i');
      if (machine.stdout && rx.test(machine.stdout)) return true;
      if (user.stdout && rx.test(user.stdout)) return true;
      if (!machine.stdout && !user.stdout) return 'unknown';
      return false;
    }
    if (process.platform === 'darwin') return probeDarwinCaTrusted(caPath);
    return probeLinuxCaTrusted(caPath);
  } catch {
    return 'unknown';
  }
}

/** CA-trust probe cache: one entry per CA path, 60s TTL — the console polls
 *  status every 3s and this probe spawns up to three subprocesses per call
 *  (`probeClientVersion`'s rule: status polls must not spawn processes). */
const caTrustCache = new Map<string, { trusted: boolean | 'unknown'; at: number }>();
const CA_TRUST_PROBE_TTL_MS = 60 * 1000;

async function probeCaTrustedCached(caPath: string): Promise<boolean | 'unknown'> {
  const hit = caTrustCache.get(caPath);
  if (hit && Date.now() - hit.at < CA_TRUST_PROBE_TTL_MS) return hit.trusted;
  const trusted = await probeCaTrusted(caPath);
  caTrustCache.set(caPath, { trusted, at: Date.now() });
  return trusted;
}

export class CursorClientAdapter implements ClientAdapter {
  name = 'cursor' as const;
  displayName = 'Cursor';

  versionCmd = ['cursor', '--version'];

  getConfigPath(): string {
    // No client config file is owned — the meaningful artifact is the launcher.
    return launcherPath();
  }

  async getStatus(): Promise<ClientHookStatus> {
    const fp = resolveForwardProxyEndpoint();
    const live = getForwardProxyStatus();
    const launcher = fs.existsSync(launcherPath());
    const binary = detectCursorBinary();
    const versionProbe = await probeClientVersion(this.versionCmd);
    const installed = !!binary || versionProbe !== null;
    // Only probe when there is something to probe, and only through the TTL
    // cache: an absent Cursor has no trust state worth three subprocesses.
    const caTrusted = installed && fp ? await probeCaTrustedCached(fp.caPath) : 'unknown';

    let hooked = false;
    let details: string;
    if (!installed) {
      details = 'Cursor not detected (no known install location and no `cursor` command on PATH)';
    } else if (!fp) {
      details = 'forwardProxy disabled in config.yaml — enable it before hooking Cursor';
    } else if (!launcher) {
      details = `Forward proxy enabled (port ${live.port ?? fp.port}${live.running ? ', running' : ', NOT running'}) — CA trust: ${caTrusted === true ? 'trusted' : caTrusted === false ? 'NOT trusted' : 'unknown'} — run setup to write the Cursor launcher`;
    } else {
      hooked = true;
      details = `Cursor starts via the OCR launcher (${launcherPath()}) with --proxy-server=${fp.url}; quit Cursor fully before launching — an existing instance ignores a later launcher invocation; forward proxy ${live.running ? `running on port ${live.port ?? fp.port}` : 'NOT running (start the gateway)'}; CA trust: ${caTrusted === true ? 'trusted' : caTrusted === false ? 'NOT trusted — import <ocrHome>/forward-proxy/ca.pem manually' : 'unknown'}`;
    }

    return {
      name: this.name,
      displayName: this.displayName,
      configPath: this.getConfigPath(),
      exists: launcher,
      hooked,
      backupExists: false,
      details,
      // Slot-less by design: phase 1 publishes no model advertisement, so a
      // picker here would be a control that silently discards the choice.
      modelSlots: [],
    };
  }

  async setup(options?: { port?: number }): Promise<ClientActionResult> {
    // The live runtime snapshot is the single source of truth — a fresh
    // loadConfig() could advertise a port the running proxy no longer listens on.
    const fp = resolveForwardProxyEndpoint();
    if (!fp) {
      return {
        success: false,
        reasonCode: 'forward_proxy_disabled',
        message:
          'forwardProxy is not enabled in config.yaml — set `forwardProxy.enabled: true` (and keep the gateway running) before hooking Cursor.',
      };
    }
    if (!fs.existsSync(fp.caPath)) {
      return {
        success: false,
        reasonCode: 'forward_proxy_ca_missing',
        params: { path: fp.caPath },
        message: `Forward-proxy MITM CA not found at ${fp.caPath} — it is generated when the gateway boots with forwardProxy enabled. Start the gateway and retry.`,
      };
    }

    let binary = detectCursorBinary();
    if (!binary) {
      const cli = await probeClientVersion(this.versionCmd);
      if (cli === null) {
        return {
          success: false,
          reasonCode: 'cursor_not_found',
          message:
            'Cursor was not detected — install Cursor (or put its `cursor` command on PATH) and retry. The launcher needs the real binary path.',
        };
      }
      binary = 'cursor';
    }

    const port = Number.isFinite(options?.port) && (options?.port as number) > 0 ? (options?.port as number) : fp.port;

    const scripts = buildCursorLaunchers({
      platform: process.platform,
      binary,
      agentBinary: detectAgentBinary(),
      port,
      caPath: fp.caPath,
    });
    const lPath = launcherPath();
    fs.mkdirSync(clientsDir(), { recursive: true });
    const writeScript = (p: string, text: string): void => {
      const win = process.platform === 'win32';
      // `mode` only applies when the file is CREATED: a launcher restored from
      // a backup, copied, or written by an older build is rewritten still-0644
      // and then neither `./cursor-launcher.sh` nor a Finder double-click runs.
      fs.writeFileSync(p, text, win ? 'utf8' : { encoding: 'utf8', mode: 0o755 });
      if (!win) fs.chmodSync(p, 0o755);
    };
    writeScript(lPath, scripts.main);
    if (scripts.agent) {
      writeScript(agentLauncherPath(), scripts.agent);
    } else {
      // No CLI detected: a launcher left from an earlier setup would point at a
      // dead binary and a stale port. setup owns that file — remove it.
      fs.rmSync(agentLauncherPath(), { force: true });
    }

    return {
      success: true,
      message: `Cursor hooked: start it via ${lPath} (Chromium legs use --proxy-server, Electron Node legs use http(s)_proxy + NODE_EXTRA_CA_CERTS). Import the MITM CA (${fp.caPath}) into the OS trust store if Cursor still fails TLS to api2.cursor.sh. Close Cursor before launching it through the proxy.`,
    };
  }

  async teardown(): Promise<ClientActionResult> {
    const removed: string[] = [];
    // Legacy ≤0.1.x artifact: the models advertisement is gone (phase 1
    // publishes none), but an upgrade must leave nothing behind.
    const legacyModels = path.join(getOcrHomeDir(), LEGACY_MODELS_JSON_PATH);
    for (const p of [launcherPath(), agentLauncherPath(), legacyModels]) {
      if (!fs.existsSync(p)) continue;
      try {
        fs.unlinkSync(p);
        removed.push(p);
      } catch (err) {
        return {
          success: false,
          reasonCode: 'remove_failed',
          params: { path: p, detail: String(err) },
          message: `Failed to remove ${p}: ${String(err)}`,
        };
      }
    }
    if (removed.length === 0) {
      return { success: false, reasonCode: 'not_active', message: 'Cursor proxy mode is not active — no launcher to remove.' };
    }
    // The CA and Cursor's own files are intentionally untouched.
    return {
      success: true,
      message: `Cursor proxy mode disabled: removed ${removed.join(', ')}. Start Cursor normally (no proxy) — the MITM CA remains in the trust store if you imported it manually.`,
    };
  }
}

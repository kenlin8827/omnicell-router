import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ClientAdapter, ClientActionResult, collectHookWarnings, probeClientVersion, resolveForwardProxyEndpoint } from './base.js';
import { quoteWindowsArgs } from '../../utils/run-command.js';
import { ClientArtifact, ClientHookStatus } from '../types.js';
import { getOcrHomeDir } from '../paths.js';
import { getForwardProxyStatus } from '../../forward-proxy/status.js';
import { probeCaTrustedCached } from '../../forward-proxy/ca-trust.js';

/**
 * Cursor proxy client adapter — forward-proxy hook (no config-file rewrite).
 *
 * Cursor cannot be pointed at a custom LLM endpoint by configuration: its AI
 * traffic is hardcoded to api2.cursor.sh. The `cursor-gateway` plugin MITMs those
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
  /**
   * Strict mode (`forwardProxy.requireCredential`) needs the key IN the proxy
   * URL: Chromium can prompt, but the Electron Node/gRPC legs cannot. Only the
   * console setup passes it (the launcher file then holds the secret; written
   * 0600/0700 instead of the default).
   */
  proxyCredential?: string;
}): CursorLauncherScripts {
  const userinfo = args.proxyCredential
    ? `ocr:${encodeURIComponent(args.proxyCredential)}@`
    : '';
  const proxy = `http://${userinfo}127.0.0.1:${args.port}`;
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
        'REM Regenerated by `ocr setup cursor-proxy`; manual edits are overwritten on the next setup.',
        ...envBlock(),
        `start "" "${args.binary}" --proxy-server=${proxy} %*`,
        '',
      ].join('\r\n')
    : [
        '#!/bin/sh',
        '# omnicell-router-managed launcher: start Cursor through the OCR forward proxy.',
        '# Regenerated by `ocr setup cursor-proxy`; manual edits are overwritten on the next setup.',
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
        'REM Regenerated by `ocr setup cursor-proxy`; manual edits are overwritten on the next setup.',
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
        '# Regenerated by `ocr setup cursor-proxy`; manual edits are overwritten on the next setup.',
        ...envBlock(),
        `exec "${args.agentBinary}" "$@"`,
        '',
      ].join('\n');
  return { main, agent };
}

export class CursorProxyClientAdapter implements ClientAdapter {
  name = 'cursor-proxy' as const;
  hookKind = 'launcher' as const;
  displayName = 'Cursor';

  versionCmd = ['cursor', '--version'];

  getConfigPath(): string {
    // No client config file is owned — the meaningful artifact is the launcher.
    return launcherPath();
  }

  async getStatus(): Promise<Omit<ClientHookStatus, 'hookKind'>> {
    const fp = resolveForwardProxyEndpoint();
    const live = getForwardProxyStatus();
    const launcher = fs.existsSync(launcherPath());
    const binary = detectCursorBinary();
    const versionProbe = await probeClientVersion(this.versionCmd);
    const installed = !!binary || versionProbe !== null;
    // Only probe when there is something to probe, and only through the TTL
    // cache: an absent Cursor has no trust state worth three subprocesses.
    const caTrusted = installed && fp ? (await probeCaTrustedCached(fp.caPath)).trusted : 'unknown';

    // The CLI launcher is a second owned artifact: setup writes it only while
    // `cursor-agent` is installed and removes it otherwise, so a file left from
    // an earlier setup is shown too (stale, but the operator can still see it).
    const agentLauncher = agentLauncherPath();
    const agentLauncherExists = fs.existsSync(agentLauncher);
    const artifacts: ClientArtifact[] | undefined =
      detectAgentBinary() || agentLauncherExists ? [{ path: agentLauncher, exists: agentLauncherExists }] : undefined;

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
      details = `Cursor starts via \`ocr cursor\` (or ${launcherPath()}) with --proxy-server=${fp.url}; quit Cursor fully before launching — an existing instance ignores a later launcher invocation; forward proxy ${live.running ? `running on port ${live.port ?? fp.port}` : 'NOT running (start the gateway)'}; CA trust: ${caTrusted === true ? 'trusted' : caTrusted === false ? `NOT trusted — import ${fp.caPath} manually` : 'unknown'}`;
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
      artifacts,
    };
  }

  async setup(options?: { port?: number; apiKey?: string }): Promise<ClientActionResult> {
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
    // Strict mode closes the proxy to every credential-less connection; the
    // console passes the bound key so the launcher can carry it in the URL.
    const proxyCredential = fp.requireCredential
      ? options?.apiKey?.trim() || process.env.OCR_PROXY_KEY?.trim()
      : undefined;
    if (fp.requireCredential && !proxyCredential) {
      return {
        success: false,
        reasonCode: 'proxy_credential_required',
        message:
          'forwardProxy.requireCredential is on — setup needs the proxy key. Pick/bind a key in the console Client Hub, or point http(s)_proxy at http://ocr:<key>@host:port manually.',
      };
    }

    const scripts = buildCursorLaunchers({
      platform: process.platform,
      binary,
      agentBinary: detectAgentBinary(),
      port,
      caPath: fp.caPath,
      ...(proxyCredential ? { proxyCredential } : {}),
    });
    const lPath = launcherPath();
    fs.mkdirSync(clientsDir(), { recursive: true });
    const writeScript = (p: string, text: string): void => {
      const win = process.platform === 'win32';
      // A credential-bearing launcher is owner-only; a plain one only needs
      // the exec bit. `mode` applies on creation only, so chmod unconditionally.
      const mode = proxyCredential ? 0o700 : 0o755;
      fs.writeFileSync(p, text, win ? 'utf8' : { encoding: 'utf8', mode });
      if (!win) fs.chmodSync(p, mode);
    };
    writeScript(lPath, scripts.main);
    if (scripts.agent) {
      writeScript(agentLauncherPath(), scripts.agent);
    } else {
      // No CLI detected: a launcher left from an earlier setup would point at a
      // dead binary and a stale port. setup owns that file — remove it.
      fs.rmSync(agentLauncherPath(), { force: true });
    }
    // The launcher is written and correct; what can STILL fail is the running
    // stack. Report those as warnings, never gates: an operator commonly
    // imports the root right AFTER hooking, and a blocked setup would be a
    // dead end (the wizard that installs the CA lives on another page).
    const warnings = await collectHookWarnings(fp, port);

    return {
      success: true,
      message: `Cursor launcher written at ${lPath}. Start it via \`ocr cursor\` (Chromium legs use --proxy-server, Electron Node legs use http(s)_proxy + NODE_EXTRA_CA_CERTS) — the takeover happens at launch time; Cursor itself is untouched. Import the MITM CA (${fp.caPath}) into the OS trust store if Cursor still fails TLS to api2.cursor.sh. Quit Cursor fully before launching it through the proxy.`,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async teardown(): Promise<ClientActionResult> {
    const removed: string[] = [];
    for (const p of [launcherPath(), agentLauncherPath()]) {
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
      return { success: false, reasonCode: 'not_active', message: 'No Cursor launcher to delete — run `ocr setup cursor-proxy` first.' };
    }
    // The CA and Cursor's own files are intentionally untouched.
    return {
      success: true,
      message: `Cursor launchers deleted (${removed.join(', ')}). Cursor itself was never modified — start it normally for a direct connection. The MITM CA remains in the trust store if you imported it manually.`,
    };
  }
}

/** Outcome of a passthrough launcher run. */
export interface CursorLaunchResult {
  ok: boolean;
  code: number;
  /** Launcher returns before the target exits (IDE launcher on win32/darwin). */
  detached: boolean;
  message?: string;
}

/**
 * Run one of the managed launchers, forwarding stdio and the launcher's exit code.
 *
 * `ocr cursor` / `ocr cursor-agent` go through the SCRIPT instead of re-deriving
 * the proxy environment here: the launcher stays the single source of the env
 * contract (flag for Chromium legs, lowercase http(s)_proxy + CA for Electron's
 * Node legs), so a CLI launch and a double-click can never drift apart.
 *
 * `detached` flags the IDE launcher on win32/darwin, which returns as soon as
 * the app is started (`start ""` / `nohup … &`): there the exit code is the
 * LAUNCHER's, not the target's, and the target's own stdio never reaches us.
 * The Linux `.sh` and the agent launchers stay attached, so their exit code is
 * the real one.
 */
export async function runCursorLauncher(kind: 'ide' | 'agent', argv: string[]): Promise<CursorLaunchResult> {
  const detached = kind === 'ide' && process.platform !== 'linux';
  const script = kind === 'ide' ? launcherPath() : agentLauncherPath();
  if (!fs.existsSync(script)) {
    return {
      ok: false,
      code: 1,
      detached,
      message:
        `${kind === 'ide' ? 'Cursor' : 'cursor-agent'} launcher not found at ${script} — run \`ocr setup cursor-proxy\`` +
        `${kind === 'agent' ? ' (with the cursor-agent CLI installed)' : ''}.`,
    };
  }
  const win = process.platform === 'win32';
  // `.cmd` needs cmd.exe; `quoteWindowsArgs` is the SAME quoting `runCommand`
  // applies to Windows shims, so an argument survives the extra shell hop.
  const args = win ? quoteWindowsArgs(argv) : argv;
  const cmd = win && /\s/.test(script) ? `"${script}"` : script;
  // Executor form on purpose: the project lib target predates
  // `Promise.withResolvers`, and the child events are the only completion path.
  return await new Promise<CursorLaunchResult>(resolve => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: win, windowsHide: true });
    child.on('error', err => resolve({ ok: false, code: 1, detached, message: String(err) }));
    child.on('close', (code, signal) => {
      // A signal-killed child reports `code === null`; POSIX convention is
      // 128 + signum, so a caller can tell an interrupt from a real failure.
      const signum = signal ? (os.constants.signals as Record<string, number>)[signal] : undefined;
      resolve({ ok: code === 0, code: code ?? (signum ? 128 + signum : 1), detached });
    });
  });
}

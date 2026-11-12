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
 * Qoder proxy client adapter — forward-proxy hook (no config-file rewrite).
 *
 * Qoder cannot be pointed at a custom LLM endpoint: its AI traffic is
 * hardcoded to the vendor hosts (`api2-v2.qoder.sh` and friends, or
 * `gateway.qoder.com.cn` in the China build). The `qoder-gateway` plugin MITMs
 * those hosts through OCR's inbound forward proxy. This adapter publishes a
 * launch script that starts Qoder through that proxy:
 *
 *   - `--proxy-server` for Chromium legs;
 *   - lowercase `http(s)_proxy` + `grpc_proxy` for the agent SDK's Node fetch
 *     and grpc-js legs (grpc-js reads `grpc_proxy` FIRST, then `https_proxy`);
 *   - `NODE_EXTRA_CA_CERTS` for Node's bundled roots;
 *   - `NO_PROXY` to keep loopback out of the proxy hop.
 *
 * Non-LLM destinations forward transparently. The launchers are the only files
 * this adapter WRITES; the sole client-side state it touches is the cached model
 * catalog's mtime (`staleModelCatalog`) — never its contents.
 */

/** Well-known Qoder install locations, per platform. */
function qoderBinaryCandidates(): string[] {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  switch (process.platform) {
    case 'win32':
      return [
        path.join(localAppData, 'Programs', 'Qoder', 'Qoder.exe'),
        path.join(localAppData, 'Programs', 'Qoder CN', 'Qoder.exe'),
        path.join(localAppData, 'Qoder', 'Qoder.exe'),
      ];
    case 'darwin':
      return [
        '/Applications/Qoder.app/Contents/MacOS/Qoder',
        '/Applications/Qoder CN.app/Contents/MacOS/Qoder',
        path.join(os.homedir(), 'Applications', 'Qoder.app/Contents/MacOS/Qoder'),
      ];
    default:
      return [
        '/usr/bin/qoder',
        '/usr/local/bin/qoder',
        '/opt/Qoder/qoder',
        '/opt/qoder/qoder',
        path.join(os.homedir(), 'Applications', 'Qoder.AppImage'),
        '/opt/Qoder.AppImage',
      ];
  }
}

/** The detected Qoder binary path, or null. `QODER_BIN` wins so an install
 *  layout outside the well-known list can still be hooked. */
function detectQoderBinary(): string | null {
  const override = process.env.QODER_BIN?.trim();
  if (override && fs.existsSync(override)) return override;
  return qoderBinaryCandidates().find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Qoder's per-user data root; the agent SDK honours `QODER_HOME`. */
function qoderDataHome(): string {
  const override = process.env.QODER_HOME?.trim();
  return override || path.join(os.homedir(), '.qoder');
}

const CATALOG_FILE = /^catalog-v(\d+)$/;
/** Old enough that the client's freshness check can never pass. */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Qoder's agent serves the model catalog from `<qoderHome>/.models/<uid>/catalog-v<N>`
 * and only refreshes it in the BACKGROUND when that file is present but STALE.
 * A missing file is not a miss it recovers from: `get_models` returns an empty
 * list and never touches the network, which leaves the composer stuck on
 * "this account cannot use the model for this task".
 *
 * So: keep the file, backdate its mtime. The client then serves the old list
 * immediately (nothing is disabled) and refetches through the gateway, which
 * merges the `ocr/*` entries into the reply.
 */
export function staleModelCatalog(home = qoderDataHome()): string[] {
  const root = path.join(home, '.models');
  const touched: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return touched;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const canonical = files.filter((file) => CATALOG_FILE.test(file));
    const stale = new Date(Date.now() - STALE_MS);
    for (const file of canonical) {
      const full = path.join(dir, file);
      try {
        fs.utimesSync(full, stale, stale);
        touched.push(full);
      } catch {
        // Locked by a running Qoder; the next setup after a full quit marks it.
      }
    }
  }
  return touched;
}

/** Count catalogs the client would serve without a background refresh. */
export function countFreshCatalogs(home = qoderDataHome(), maxAgeMs = 60 * 60 * 1000): number {
  const root = path.join(home, '.models');
  const cutoff = Date.now() - maxAgeMs;
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .reduce((total, entry) => {
        const dir = path.join(root, entry.name);
        let files: string[];
        try {
          files = fs.readdirSync(dir).filter((file) => CATALOG_FILE.test(file));
        } catch {
          return total;
        }
        return total + files.filter((file) => {
          try {
            return fs.statSync(path.join(dir, file)).mtimeMs > cutoff;
          } catch {
            return false;
          }
        }).length;
      }, 0);
  } catch {
    return 0;
  }
}

function launcherExtension(): string {
  return process.platform === 'win32' ? '.cmd' : process.platform === 'darwin' ? '.command' : '.sh';
}

function clientsDir(): string {
  return path.join(getOcrHomeDir(), 'clients');
}

export function launcherPath(): string {
  return path.join(clientsDir(), `qoder-launcher${launcherExtension()}`);
}

/** The CLI launcher — written only while `qodercli` is installed. */
export function cliLauncherPath(): string {
  return path.join(clientsDir(), `qoder-cli-launcher${launcherExtension()}`);
}

/**
 * The `qodercli` executable, resolved from `PATH` (npm installs a `.cmd` shim
 * on Windows). `QODERCLI_BIN` wins for non-standard installs. The CLI is a
 * plain Node program, so its launcher can use the CLEAN trust switch
 * (`NODE_OPTIONS=--use-system-ca`), unlike the Electron daemon.
 */
export function detectQoderCliBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.QODERCLI_BIN?.trim();
  if (override && fs.existsSync(override)) return override;
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `qodercli${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Strict mode (`forwardProxy.requireCredential`) needs the key IN the URL:
 * Chromium can prompt, but the agent SDK's grpc-js/fetch legs cannot. Only the
 * console setup passes it; the launcher file then holds the secret.
 */
function proxyUrl(port: number, credential?: string): string {
  const userinfo = credential ? `ocr:${encodeURIComponent(credential)}@` : '';
  return `http://${userinfo}127.0.0.1:${port}`;
}

/**
 * CLI launcher text. Unlike the desktop launcher this one forwards argv and
 * returns the CLI's exit status; `NODE_OPTIONS=--use-system-ca` makes Node use
 * the OS root store, where the gateway CA lives, without disabling
 * verification (the SDK ignores `NODE_EXTRA_CA_CERTS`).
 */
export function buildQoderCliLauncher(args: {
  platform: NodeJS.Platform;
  binary: string;
  port: number;
  caPath?: string;
  proxyCredential?: string;
}): string {
  const proxy = proxyUrl(args.port, args.proxyCredential);
  const win = args.platform === 'win32';
  const env = (k: string, v: string): string => (win ? `set "${k}=${v}"` : `export ${k}="${v}"`);
  const envBlock = (): string[] => [
    ...(args.caPath ? [env('NODE_EXTRA_CA_CERTS', args.caPath)] : []),
    env('NODE_OPTIONS', '--use-system-ca'),
    env('grpc_proxy', proxy),
    env('https_proxy', proxy),
    env('http_proxy', proxy),
    env('NO_PROXY', QODER_NO_PROXY),
    ...(win ? [] : [env('no_proxy', QODER_NO_PROXY)]),
  ];
  if (win) {
    return [
      '@echo off',
      'setlocal',
      'REM omnicell-router-managed launcher: run qodercli through the OCR forward proxy.',
      'REM Regenerated by `ocr setup qoder-proxy`; manual edits are overwritten on the next setup.',
      ...envBlock(),
      // `call` + `exit /b`: the npm shim is a `.cmd` whose `exit` would
      // otherwise terminate the caller's cmd.exe.
      `call "${args.binary}" %*`,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    '# omnicell-router-managed launcher: run qodercli through the OCR forward proxy.',
    '# Regenerated by `ocr setup qoder-proxy`; manual edits are overwritten on the next setup.',
    ...envBlock(),
    `exec "${args.binary}" "$@"`,
    '',
  ].join('\n');
}

/**
 * Loopback never enters the proxy hop. Both spellings are set on POSIX because
 * libraries differ on which one they read; Windows env blocks are
 * case-insensitive, so `set` emits ONE variable there.
 */
export const QODER_NO_PROXY = 'localhost,127.0.0.1,::1';

/**
 * The launcher text for one platform. Pure so the env contract is testable
 * without a real Qoder install. Windows bodies open with `setlocal` so the
 * `set` lines cannot rewrite the CALLING shell's proxy env.
 */
export function buildQoderLauncher(args: {
  platform: NodeJS.Platform;
  binary: string;
  port: number;
  caPath?: string;
  proxyCredential?: string;
}): string {
  const proxy = proxyUrl(args.port, args.proxyCredential);
  const win = args.platform === 'win32';
  const env = (k: string, v: string): string => (win ? `set "${k}=${v}"` : `export ${k}="${v}"`);
  const envBlock = (): string[] => [
    ...(args.caPath ? [env('NODE_EXTRA_CA_CERTS', args.caPath)] : []),
    // The desktop daemon drops NODE_OPTIONS (so `--use-system-ca` cannot reach
    // it) and its SDK builds its own `ca` list, ignoring
    // NODE_EXTRA_CA_CERTS. Verification stays disabled for THIS process only;
    // otherwise every call dies at TLS before a request reaches the proxy.
    env('NODE_TLS_REJECT_UNAUTHORIZED', '0'),
    // grpc-js prefers `grpc_proxy`; the fetch/undici leg reads http(s)_proxy.
    env('grpc_proxy', proxy),
    env('https_proxy', proxy),
    env('http_proxy', proxy),
    env('NO_PROXY', QODER_NO_PROXY),
    ...(win ? [] : [env('no_proxy', QODER_NO_PROXY)]),
  ];
  if (win) {
    return [
      '@echo off',
      'setlocal',
      'REM omnicell-router-managed launcher: start Qoder through the OCR forward proxy.',
      'REM Regenerated by `ocr setup qoder-proxy`; manual edits are overwritten on the next setup.',
      ...envBlock(),
      `start "" "${args.binary}" --proxy-server=${proxy} %*`,
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    '# omnicell-router-managed launcher: start Qoder through the OCR forward proxy.',
    '# Regenerated by `ocr setup qoder-proxy`; manual edits are overwritten on the next setup.',
    ...envBlock(),
    // macOS: the `.command` runs inside a Terminal window, so `exec` would make
    // Qoder that window's child — closing the window SIGHUPs Qoder. Detach.
    args.platform === 'darwin'
      ? `nohup "${args.binary}" --proxy-server=${proxy} "$@" >/dev/null 2>&1 &`
      : `exec "${args.binary}" --proxy-server=${proxy} "$@"`,
    '',
  ].join('\n');
}

export class QoderProxyClientAdapter implements ClientAdapter {
  name = 'qoder-proxy' as const;
  hookKind = 'launcher' as const;
  displayName = 'Qoder';

  versionCmd = ['qoder', '--version'];

  getConfigPath(): string {
    // No client config file is owned — the launcher is the artifact.
    return launcherPath();
  }

  async getStatus(): Promise<Omit<ClientHookStatus, 'hookKind'>> {
    const fp = resolveForwardProxyEndpoint();
    const live = getForwardProxyStatus();
    const launcher = fs.existsSync(launcherPath());
    const binary = detectQoderBinary();
    const versionProbe = await probeClientVersion(this.versionCmd);
    const installed = !!binary || versionProbe !== null;
    const caTrusted = installed && fp ? (await probeCaTrustedCached(fp.caPath)).trusted : 'unknown';

    // The CLI launcher is a second owned artifact, written by setup only while
    // `qodercli` is installed; a stale file from an earlier setup is shown too.
    const cliLauncher = cliLauncherPath();
    const cliLauncherExists = fs.existsSync(cliLauncher);
    const cliBin = detectQoderCliBin();
    const artifacts: ClientArtifact[] | undefined =
      cliBin || cliLauncherExists ? [{ path: cliLauncher, exists: cliLauncherExists }] : undefined;

    const cliNote = cliBin
      ? `; Qoder CLI detected at ${cliBin} — ${cliLauncherExists ? 'launch it via ' + cliLauncher : 'run setup to write ' + cliLauncher}`
      : cliLauncherExists
        ? `; stale CLI launcher ${cliLauncher} (qodercli no longer on PATH)`
        : '';
    let hooked = false;
    let details: string;
    if (!installed) {
      details = 'Qoder not detected (no known install location and no `qoder` command on PATH)';
    } else if (!fp) {
      details = 'forwardProxy disabled in config.yaml — enable it before hooking Qoder';
    } else if (!launcher) {
      details = `Forward proxy enabled (port ${live.port ?? fp.port}${live.running ? ', running' : ', NOT running'}) — CA trust: ${caTrusted === true ? 'trusted' : caTrusted === false ? 'NOT trusted' : 'unknown'} — run setup to write the Qoder launcher`;
    } else {
      hooked = true;
      const fresh = countFreshCatalogs();
      details = `Qoder starts via ${launcherPath()} with --proxy-server=${fp.url} and grpc_proxy for the agent SDK; quit Qoder fully before launching — an existing instance ignores a later launcher invocation; forward proxy ${live.running ? `running on port ${live.port ?? fp.port}` : 'NOT running (start the gateway)'}; CA trust: ${caTrusted === true ? 'trusted' : caTrusted === false ? `NOT trusted — import ${fp.caPath} manually` : 'unknown'}${fresh > 0 ? `; ${fresh} fresh model catalog cache(s) found — run setup again so Qoder refetches through the gateway instead of serving the old list` : ''}${cliNote}`;
    }

    return {
      name: this.name,
      displayName: this.displayName,
      configPath: this.getConfigPath(),
      exists: launcher,
      hooked,
      backupExists: false,
      details,
      ...(artifacts ? { artifacts } : {}),
      // The gateway plugin owns model selection; a slot picker here would be a
      // control that silently discards the choice.
      modelSlots: [],
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
          'forwardProxy is not enabled in config.yaml — set `forwardProxy.enabled: true` (and keep the gateway running) before hooking Qoder.',
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

    let binary = detectQoderBinary();
    if (!binary) {
      const cli = await probeClientVersion(this.versionCmd);
      if (cli === null) {
        return {
          success: false,
          reasonCode: 'qoder_not_found',
          message:
            'Qoder was not detected — install Qoder (or set QODER_BIN to its executable) and retry. The launcher needs the real binary path.',
        };
      }
      binary = 'qoder';
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
          'forwardProxy.requireCredential is on — setup needs the proxy key. Pick/bind a key in the console Client Hub, or point grpc_proxy/http(s)_proxy at http://ocr:<key>@host:port manually.',
      };
    }
    const text = buildQoderLauncher({
      platform: process.platform,
      binary,
      port,
      caPath: fp.caPath,
      ...(proxyCredential ? { proxyCredential } : {}),
    });
    const lPath = launcherPath();
    fs.mkdirSync(clientsDir(), { recursive: true });
    const win = process.platform === 'win32';
    const mode = proxyCredential ? 0o700 : 0o755;
    fs.writeFileSync(lPath, text, win ? 'utf8' : { encoding: 'utf8', mode });
    if (!win) fs.chmodSync(lPath, mode);

    // Second owned artifact: the CLI launcher, only while `qodercli` exists.
    // A launcher left from an earlier setup would point at a dead binary and a
    // stale port, so setup owns (and prunes) that file too.
    const cliBin = detectQoderCliBin();
    const cliPath = cliLauncherPath();
    if (cliBin) {
      fs.writeFileSync(
        cliPath,
        buildQoderCliLauncher({
          platform: process.platform,
          binary: cliBin,
          port,
          caPath: fp.caPath,
          ...(proxyCredential ? { proxyCredential } : {}),
        }),
        win ? 'utf8' : { encoding: 'utf8', mode },
      );
      if (!win) fs.chmodSync(cliPath, mode);
    } else {
      fs.rmSync(cliPath, { force: true });
    }

    // A fresh catalog cache is served without asking the gateway; a MISSING one
    // is never recovered from (the client returns an empty list and stays
    // offline). Backdating is the only state that yields both: the old list is
    // still displayed and the client refreshes it in the background.
    const staled = staleModelCatalog();

    // Same advisories as the Cursor hook: the launcher disables verification
    // for the Node/grpc SDK only — Chromium legs still read the OS store, and
    // a stopped listener breaks every leg.
    const warnings = await collectHookWarnings(fp, port);

    return {
      success: true,
      message: `Qoder launcher written at ${lPath}. Start the desktop app via \`ocr qoder\` — the takeover happens at launch time; Qoder itself is untouched.${cliBin ? ` Qoder CLI launcher: ${cliPath} (run \`ocr qoder-cli -p "..."\`). ` : ' '}${staled.length > 0 ? `Marked ${staled.length} cached model catalog(s) stale — quit Qoder completely first, then launch through the proxy; it will serve the old list and refetch in the background through the gateway. ` : ''}Install/enable the \`qoder-gateway\` plugin for OCR models; the desktop launcher disables TLS verification for the Node/grpc SDK because its daemon ignores every CA store except the compiled-in one.`,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async teardown(): Promise<ClientActionResult> {
    const targets = [launcherPath(), cliLauncherPath()];
    const removed: string[] = [];
    for (const target of targets) {
      if (!fs.existsSync(target)) continue;
      try {
        fs.unlinkSync(target);
        removed.push(target);
      } catch (err) {
        return {
          success: false,
          reasonCode: 'remove_failed',
          params: { path: target, detail: String(err) },
          message: `Failed to remove ${target}: ${String(err)}`,
        };
      }
    }
    if (removed.length === 0) {
      return { success: false, reasonCode: 'not_active', message: 'No Qoder launcher to delete — run `ocr setup qoder-proxy` first.' };
    }
    // The CA and Qoder's own files are intentionally untouched — the catalog
    // mtimes setup backdated are left stale, so the next launch refreshes them.
    return {
      success: true,
      message: `Qoder launchers deleted (${removed.join(', ')}). Qoder itself was never modified — start it normally for a direct connection. The MITM CA remains in the trust store if you imported it manually.`,
    };
  }
}

export interface QoderLaunchResult {
  ok: boolean;
  code: number;
  /** The desktop launcher returns before Qoder exits (win32/darwin `start`). */
  detached: boolean;
  message?: string;
}

/**
 * Run one of the managed launchers, forwarding stdio and the launcher's exit
 * code — the `ocr qoder` / `ocr qoder-cli` contract, identical to Cursor's.
 * The CLI is interactive (`-p`, or a full TUI), so it must keep the caller's
 * stdio; the desktop launcher detaches by itself via `start`.
 */
export async function runQoderLauncher(
  kind: 'desktop' | 'cli',
  argv: string[],
): Promise<QoderLaunchResult> {
  const detached = kind === 'desktop' && process.platform !== 'linux';
  const script = kind === 'desktop' ? launcherPath() : cliLauncherPath();
  if (!fs.existsSync(script)) {
    return {
      ok: false,
      code: 1,
      detached,
      message:
        `${kind === 'desktop' ? 'Qoder' : 'Qoder CLI'} launcher not found at ${script} — run \`ocr setup qoder-proxy\`` +
        `${kind === 'cli' ? ' (with qodercli installed)' : ''}.`,
    };
  }
  const win = process.platform === 'win32';
  const args = win ? quoteWindowsArgs(argv) : argv;
  const cmd = win && /\s/.test(script) ? `"${script}"` : script;
  return await new Promise<QoderLaunchResult>(resolve => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: win, windowsHide: true });
    child.on('error', err => resolve({ ok: false, code: 1, detached, message: String(err) }));
    child.on('close', (code, signal) => {
      const signum = signal ? (os.constants.signals as Record<string, number>)[signal] : undefined;
      resolve({ ok: code === 0, code: code ?? (signum ? 128 + signum : 1), detached });
    });
  });
}

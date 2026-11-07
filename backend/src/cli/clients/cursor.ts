import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClientAdapter, ClientActionResult, probeClientVersion, resolveForwardProxyEndpoint, runCommand } from './base.js';
import { ClientHookStatus, ClientModelSlot } from '../types.js';
import { getOcrHomeDir } from '../paths.js';
import { getForwardProxyStatus } from '../../forward-proxy/status.js';
import { CA_CN } from '../../forward-proxy/ca.js';

/**
 * Cursor client adapter — proxy-access hook (no config-file rewrite).
 *
 * Cursor cannot be pointed at a custom LLM endpoint by configuration: its AI
 * traffic is hardcoded to api2.cursor.sh. The cursor-gateway plugin MITMs
 * those hosts through OCR's inbound forward proxy. This adapter therefore
 * "hooks" Cursor by:
 *
 *   1. Publishing a launcher script (<ocrHome>/clients/cursor-launcher.*) that
 *      starts the detected Cursor binary with
 *      `--proxy-server=http://127.0.0.1:<forwardProxy.port>` so its Chromium
 *      network stack sends ALL traffic through the forward proxy (non-LLM
 *      destinations forward transparently).
 *   2. Writing the models advertisement
 *      <ocrHome>/gateways/cursor/models.json ({ models: string[] }) — the
 *      plugin's contract for which OCR models Cursor's picker should show.
 *
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
      ];
  }
}

/** The detected Cursor binary path ('cursor' when only a PATH `cursor` exists), null when absent. */
function detectCursorBinary(): string | null {
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

/** The detected cursor-agent CLI binary path ('cursor-agent' when only PATH has it), null when absent. */
function detectAgentBinary(): string | null {
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

function launcherPath(): string {
  return path.join(clientsDir(), `cursor-launcher${launcherExtension()}`);
}

function modelsJsonPath(): string {
  return path.join(getOcrHomeDir(), 'gateways', 'cursor', 'models.json');
}


/**
 * Best-effort platform probe: is the OCR forward-proxy CA trusted?
 * Returns true/false; 'unknown' means the probe itself failed (missing tool,
 * permission error) — the UI text stays honest about it.
 */
async function probeCaTrusted(): Promise<boolean | 'unknown'> {
  try {
    if (process.platform === 'win32') {
      // certutil dumps both Local Machine and Current User Root stores; our CA
      // is trusted only if its CN appears in one of them. [INFERENCE: exact
      // certutil dump rendering unverified on a live store.]
      const machine = await runCommand('certutil', ['-store', 'Root']);
      const user = await runCommand('certutil', ['-user', '-store', 'Root']);
      const rx = new RegExp(CA_CN, 'i');
      if (machine.stdout && rx.test(machine.stdout)) return true;
      if (user.stdout && rx.test(user.stdout)) return true;
      if (!machine.stdout && !user.stdout) return 'unknown';
      return false;
    }
    if (process.platform === 'darwin') {
      // System keychain lookup for any certificate whose common name starts
      // with our CN prefix (security matches by partial name).
      const r = await runCommand('security', ['find-certificate', '-c', CA_CN, '/Library/Keychains/System.keychain']);
      if (r.ok) return true;
      if (/could not be found|The specified item/i.test(r.stderr)) return false;
      return 'unknown';
    }
    // Linux: the conventional trust dir — we install as ocr-forward-proxy.crt
    // (setup does NOT install it; presence means someone trusted it manually).
    const dir = '/usr/local/share/ca-certificates';
    if (!fs.existsSync(dir)) return 'unknown';
    const entries = fs.readdirSync(dir);
    return entries.some(e => /omnicell|ocr-forward-proxy/i.test(e));
  } catch {
    return 'unknown';
  }
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
    const versionProbe = await probeClientVersion(['cursor', '--version']);
    const installed = !!binary || versionProbe !== null;
    const caTrusted = fp ? await probeCaTrusted() : 'unknown';
    const modelsFile = fs.existsSync(modelsJsonPath());

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
      details = `Cursor starts via the OCR launcher (${launcherPath()}) with --proxy-server=${fp.url}; forward proxy ${live.running ? `running on port ${live.port ?? fp.port}` : 'NOT running (start the gateway)'}; CA trust: ${caTrusted === true ? 'trusted' : caTrusted === false ? 'NOT trusted — import <ocrHome>/forward-proxy/ca.pem manually' : 'unknown'}; models advertisement: ${modelsFile ? 'published' : 'missing — re-run setup'}`;
    }

    const slots: ClientModelSlot[] = [{ key: 'main' }];
    return {
      name: this.name,
      displayName: this.displayName,
      configPath: this.getConfigPath(),
      exists: installed,
      hooked,
      backupExists: false,
      details,
      modelSlots: slots,
      extraModels: modelsFile ? this.readPublishedModels() : undefined,
    };
  }

  /** Best-effort read of the currently published models list (status echo only). */
  private readPublishedModels(): string[] {
    try {
      const data = JSON.parse(fs.readFileSync(modelsJsonPath(), 'utf8'));
      return Array.isArray(data?.models) ? data.models.filter((m: unknown) => typeof m === 'string') : [];
    } catch {
      return [];
    }
  }

  async setup(options?: {
    port?: number;
    models?: Record<string, string>;
    extraModels?: string[];
    virtualModels?: string[];
  }): Promise<ClientActionResult> {
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
      const cli = await probeClientVersion(['cursor', '--version']);
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

    // Launcher: starts Cursor with the Chromium --proxy-server flag so all its
    // traffic flows through the forward proxy (only LLM hosts are intercepted
    // into the OCR pipeline; everything else forwards transparently).
    const proxyArg = `--proxy-server=http://127.0.0.1:${port}`;
    // Cursor's AI RPCs run in Electron's Node processes, whose TLS trusts the
    // bundled Mozilla CA store — the Windows cert store is NOT consulted, so a
    // store-installed OCR CA alone leaves every api2/api3 handshake aborted
    // (client-side 'socket hang up'). NODE_EXTRA_CA_CERTS closes that gap for
    // Node legs; Chromium legs already read the OS store.
    const caExport = fp.caPath ? `NODE_EXTRA_CA_CERTS=${fp.caPath}` : '';
    // The Chromium-only `--proxy-server` flag does not reach Electron's MAIN
    // process: Cursor's inference legs (api.origin / agentn.api5) are raw
    // Node/gRPC sockets that honour ONLY the LOWERCASE http(s)_proxy env vars.
    // Without them those sockets dial the public endpoints directly and never
    // touch the forward proxy. Chromium legs ignore these vars and keep using
    // --proxy-server, so setting both is safe.
    const proxyEnv = [`https_proxy=http://127.0.0.1:${port}`, `http_proxy=http://127.0.0.1:${port}`];
    const lPath = launcherPath();
    fs.mkdirSync(clientsDir(), { recursive: true });
    if (process.platform === 'win32') {
      const content = [
        '@echo off',
        'REM omnicell-router-managed launcher: start Cursor through the OCR forward proxy.',
        'REM Regenerated by `ocr setup cursor`; manual edits are overwritten on the next setup.',
        ...(caExport ? [`set ${caExport}`] : []),
        ...proxyEnv.map((e) => `set ${e}`),
        `start "" "${binary}" ${proxyArg}`,
        '',
      ].join('\r\n');
      fs.writeFileSync(lPath, content, 'utf8');
    } else {
      const content = [
        '#!/bin/sh',
        '# omnicell-router-managed launcher: start Cursor through the OCR forward proxy.',
        '# Regenerated by `ocr setup cursor`; manual edits are overwritten on the next setup.',
        ...(caExport ? [`export ${caExport}`] : []),
        ...proxyEnv.map((e) => `export ${e}`),
        `exec "${binary}" ${proxyArg} "$@"`,
        '',
      ].join('\n');
      fs.writeFileSync(lPath, content, { encoding: 'utf8', mode: 0o755 });
    }
    // CLI launcher: `cursor-agent` is a standalone Node binary (no Electron),
    // so --proxy-server does not exist for it. Its gRPC stack routes through
    // an HTTP proxy only via the LOWERCASE http(s)_proxy env vars, and its TLS
    // trusts the bundled Mozilla roots — same NODE_EXTRA_CA_CERTS story as the
    // IDE's Node legs. The launcher wires both, then execs the real CLI.
    const agentLauncherPath = path.join(clientsDir(), `cursor-agent-launcher${launcherExtension()}`);
    const agentBin = detectAgentBinary();
    if (agentBin) {
      const proxyExports = [
        caExport,
        `https_proxy=http://127.0.0.1:${port}`,
        `http_proxy=http://127.0.0.1:${port}`,
      ];
      if (process.platform === 'win32') {
        const content = [
          '@echo off',
          'REM omnicell-router-managed launcher: run cursor-agent through the OCR forward proxy.',
          'REM Regenerated by `ocr setup cursor`; manual edits are overwritten on the next setup.',
          ...proxyExports.map((e) => `set ${e}`),
          `"${agentBin}" %*`,
          '',
        ].join('\r\n');
        fs.writeFileSync(agentLauncherPath, content, 'utf8');
      } else {
        const content = [
          '#!/bin/sh',
          '# omnicell-router-managed launcher: run cursor-agent through the OCR forward proxy.',
          '# Regenerated by `ocr setup cursor`; manual edits are overwritten on the next setup.',
          ...proxyExports.map((e) => `export ${e}`),
          `exec "${agentBin}" "$@"`,
          '',
        ].join('\n');
        fs.writeFileSync(agentLauncherPath, content, { encoding: 'utf8', mode: 0o755 });
      }
    }


    // Models advertisement — the cursor-gateway plugin's contract: the main
    // slot leads, concrete extras and virtual tiers follow, in that order.
    const models: string[] = [];
    const main = options?.models?.main;
    if (main && main !== 'auto') models.push(main);
    for (const m of options?.extraModels ?? []) if (typeof m === 'string' && m && !models.includes(m)) models.push(m);
    for (const m of options?.virtualModels ?? []) if (typeof m === 'string' && m && !models.includes(m)) models.push(m);
    const mPath = modelsJsonPath();
    fs.mkdirSync(path.dirname(mPath), { recursive: true });
    fs.writeFileSync(mPath, JSON.stringify({ models }, null, 2) + '\n', 'utf8');

    return {
      success: true,
      message: `Cursor hooked: start it via ${lPath} (launches ${binary} with ${proxyArg}); models published to ${mPath}. Import the MITM CA (${fp.caPath}) into the OS trust store if Cursor still fails TLS to api2.cursor.sh. Close Cursor before launching it through the proxy.`,
    };
  }

  async teardown(): Promise<ClientActionResult> {
    const lPath = launcherPath();
    const mPath = modelsJsonPath();
    const removed: string[] = [];
    for (const p of [lPath, mPath]) {
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
      return { success: false, reasonCode: 'not_active', message: 'Cursor proxy mode is not active — no launcher or models file to remove.' };
    }
    // The CA and Cursor's own files are intentionally untouched.
    return {
      success: true,
      message: `Cursor proxy mode disabled: removed ${removed.join(', ')}. Start Cursor normally (no proxy) — the MITM CA remains in the trust store if you imported it manually.`,
    };
  }
}

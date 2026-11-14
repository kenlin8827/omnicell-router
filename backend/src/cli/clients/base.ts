import fs from 'node:fs';
import path from 'node:path';
import { ClientHookKind, ClientHookStatus, ModelProfileBinding, SupportedClient } from '../types.js';
import { loadConfig, getRuntimeConfigRef } from '../../config/index.js';
import { DEFAULT_FORWARD_PROXY_PORT, DEFAULT_GATEWAY_PORT } from '../../config/defaults.js';
import { renameWithRetry } from '../../utils/atomic-write.js';
import { caCertPath } from '../../forward-proxy/ca.js';
import type { RouterConfig } from '../../config/types.js';
import { runCommand } from '../../utils/run-command.js';
import { getForwardProxyStatus } from '../../forward-proxy/status.js';
import { probeCaTrustedCached } from '../../forward-proxy/ca-trust.js';
import { getOcrHomeDir } from '../paths.js';
/** Last-resort fallback URL when config is unreadable; mirrors the config default. */
export const OCR_DEFAULT_PORT = DEFAULT_GATEWAY_PORT;
export const OCR_DEFAULT_URL = `http://127.0.0.1:${OCR_DEFAULT_PORT}`;
export const OCR_DEFAULT_V1_URL = `${OCR_DEFAULT_URL}/v1`;
export const OCR_WATERMARK = 'omnicell-router-managed';

/**
 * Port the gateway actually listens on — config.yaml `port` is the single
 * source of truth (backend/src/index.ts listens on loadConfig().port). Client
 * hooks and daemon tooling MUST derive base URLs from here so what they write
 * always matches the running gateway. OCR_DEFAULT_PORT stays only as a
 * last-resort fallback for when config is unreadable (bare CLI outside a repo).
 */
export function defaultGatewayPort(): number {
  try {
    const port = loadConfig().port;
    return Number.isFinite(port) && port > 0 ? port : OCR_DEFAULT_PORT;
  } catch {
    return OCR_DEFAULT_PORT;
  }
}

/**
 * The gateway URL a client should be pointed at — VERIFIED, not assumed.
 *
 * `loadConfig().port` is the config's answer, but it is not always the port the
 * gateway is serving on: `bun run dev` boots with `PORT=4700` while the config may
 * still say 3000, and an installed desktop sidecar may be squatting 4000 with its
 * own key set. Writing an unverified port into a client's model profile produces
 * an agent that 401s on every turn, which is worse than a setup that says it could
 * not find the gateway.
 *
 * Candidates are tried in order and the winner must answer an AUTHENTICATED
 * `GET /v1/models` with 200 — unauthenticated `/v1/models` is public, so a bare
 * reachability probe would happily pick a different instance's gateway.
 */
export async function resolveGatewayBaseUrl(
  apiKey?: string,
  options: { timeoutMs?: number } = {},
): Promise<{ url: string; port: number; reachable: boolean }> {
  const ports: number[] = [];
  const push = (value: unknown) => {
    const port = Number(value);
    if (Number.isFinite(port) && port > 0 && port < 65536 && !ports.includes(port)) ports.push(port);
  };
  // The sidecar's own advertised port first: it is written at boot, so it is the
  // one number that cannot be stale relative to the process answering right now.
  try {
    const info = JSON.parse(fs.readFileSync(path.join(getOcrHomeDir(), 'ocr.info.json'), 'utf8')) as { port?: number };
    push(info.port);
  } catch {
    /* no sidecar info: fall through to config/env */
  }
  push(process.env.PORT);
  try {
    push(loadConfig().port);
  } catch {
    /* unreadable config: DEFAULT_GATEWAY_PORT still applies */
  }
  push(DEFAULT_GATEWAY_PORT);

  const timeoutMs = options.timeoutMs ?? 1500;
  for (const port of ports) {
    const url = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${url}/v1/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Without a key nothing can be distinguished, so any 200 is the best answer available.
      if (res.ok || (!apiKey && res.status === 401)) return { url, port, reachable: res.ok };
    } catch {
      /* not listening: try the next candidate */
    }
  }
  return { url: `http://127.0.0.1:${ports[0] ?? DEFAULT_GATEWAY_PORT}`, port: ports[0] ?? DEFAULT_GATEWAY_PORT, reachable: false };
}

/** Strip json comments (line and block) without external dependency */
export function stripJsonComments(jsonStr: string): string {
  return jsonStr
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1');
}

export function safeReadJson(filePath: string): any {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const cleaned = stripJsonComments(raw);
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

export function safeWriteJson(filePath: string, data: any): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const content = JSON.stringify(data, null, 2) + '\n';
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  try {
    renameWithRetry(tmpPath, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    throw e;
  }
}

export function createBackup(filePath: string): string | null {
  const backupPath = `${filePath}.bak.ocr`;
  // The FIRST snapshot is the operator's original: a re-setup (model change,
  // port move, console re-apply) reads an already-hooked file, and recopying
  // it would make teardown restore the hook itself. Keep the pristine copy —
  // a client teardown restores it and then deletes it; the harness writers
  // share this helper and keep it as their own pre-image.
  if (!fs.existsSync(filePath) || fs.existsSync(backupPath)) return null;
  try {
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

export function restoreBackup(filePath: string): boolean {
  const backupPath = `${filePath}.bak.ocr`;
  if (!fs.existsSync(backupPath)) return false;
  try {
    fs.copyFileSync(backupPath, filePath);
    fs.unlinkSync(backupPath);
    return true;
  } catch {
    return false;
  }
}

/** Setup-result fragment naming the snapshot — only when one actually exists. */
export function describeBackup(filePath: string): string {
  const backupPath = `${filePath}.bak.ocr`;
  return fs.existsSync(backupPath) ? ` Backup at ${backupPath}` : '';
}

export interface ClientActionResult {
  success: boolean;
  /** Human-readable detail (English, backend-side); the console prefers the reasonCode template when one is mapped. */
  message: string;
  /** Machine-readable failure reason for console i18n mapping (absent = no dedicated key — the raw message shows). */
  reasonCode?: string;
  /** Template params for the reasonCode's i18n string. */
  params?: Record<string, string>;
  /** Advise-only findings from a SUCCESSFUL setup (CA trust, listener state). */
  warnings?: ClientActionWarning[];
}

/**
 * Non-blocking post-setup advisories: the setup itself succeeded and wrote the
 * artifact, but the hooked client will still fail at USE time until the
 * advisory is fixed. Rendered as a warning (never an error) so a launcher is
 * never withheld because the operator still has to import the CA.
 */
export interface ClientActionWarning {
  code:
    | 'ca_not_trusted'
    | 'ca_trust_unknown'
    | 'proxy_not_running'
    /** One of the hooked IDEs was running, so it can rewrite its proxy settings on exit. */
    | 'ide_running'
    /** The install's own truststore is read-only, so the CA went into a copy the IDE's vmoptions point at. */
    | 'ide_truststore_readonly'
    /** The ACP agent (Junie) could not be provisioned; the IDE will try its own slow download. */
    | 'junie_install_failed'
    /** Junie's OCR model list could not be written (no usable API key, or a locked ~/.junie). */
    | 'junie_models_failed';
  /** Template params for the console's i18n string. */
  params?: Record<string, string>;
}

export interface ClientAdapter {
  name: SupportedClient;
  displayName: string;
  /** Where the hook lands; the registry stamps it into every status row. */
  hookKind: ClientHookKind;
  /**
   * Oldest CLI release whose config contract this adapter's writes still
   * honor — the compatibility floor, NOT the newest verified version. Set
   * together with `versionCmd`; absent = no version gate for this client.
   */
  minVersion?: string;
  /** Command whose output reports the installed CLI version (e.g. `['kimi', '--version']`). */
  versionCmd?: string[];
  getConfigPath(): string;
  /** Async by contract: adapters may probe external processes (e.g. `opencode service get env`); never block the event loop. */
  getStatus(): Promise<Omit<ClientHookStatus, 'hookKind'>>;
  /**
   * Model slots: slotKey → model id | 'auto' (intelligent routing default).
   * Only slots present in the record are written; absent slots stay untouched
   * (the plain `ocr setup` CLI command passes no models). apiKey (optional):
   * gateway-issued key to write into the client's auth field.
   */
  setup(options?: { port?: number; models?: Record<string, string>; apiKey?: string; /** Context window tokens written to the client's context-management envs (claude: CLAUDE_CODE_MAX_CONTEXT_TOKENS + CLAUDE_CODE_AUTO_COMPACT_WINDOW) */ contextWindow?: number; /** Extra concrete models to expose in the client's model switcher (adapters that publish a model list) */ extraModels?: string[]; /** Virtual tier entries to inject (follow mode): the subset of auto/lite/plus/pro/ultra the selected key's policy admits. Absent = the adapter's default block (all five where it injects any). */ virtualModels?: string[]; /** Effective agent bindings: agent/role name → resolved modelRef ('auto' = inherit the default model), written by the adapters that carry agent bindings. */ agentModels?: Record<string, string>; /** Profile-link echo written to the OCR sidecar meta when defined: agent → profile-slot key; id '' un-links. */ profile?: ModelProfileBinding; /** Family adapters: hook ONLY this product (an id from `getStatus().products`); absent = every detected product. Single-product adapters ignore it. */ product?: string }): Promise<ClientActionResult>;
  /**
   * Profile-change write-through: re-resolve the linked agents' slot keys
   * against the just-saved profile slots and rewrite the client config
   * without a full setup. Absent on adapters without profile links.
   */
  refreshProfileBindings?(profileId: string, tags: Record<string, string>, slots: Record<string, string>): Promise<ClientActionResult>;
  /** Family adapters take the same optional `product` selector — teardown ONE
   *  product (the other, still-hooked one keeps its hook) or all of them. */
  teardown(options?: { product?: string }): Promise<ClientActionResult>;
}

/** Version-probe cache: one entry per command, 10-minute TTL — status polls
 *  must not spawn a subprocess every refresh, and CLI versions don't churn. */
const versionProbeCache = new Map<string, { version: string | null; at: number }>();
const VERSION_PROBE_TTL_MS = 10 * 60 * 1000;

/**
 * Probe the installed CLI version by running the adapter's version command.
 * Returns the first `major[.minor[.patch…]]` token in the output (CLI banners
 * are prose — "kimi version 2.4.1"), or null when the command fails/times out
 * (absent client, non-zero exit). Failures are cached like successes so a
 */
export async function probeClientVersion(cmd: string[]): Promise<string | null> {
  const key = cmd.join(' ');
  const hit = versionProbeCache.get(key);
  if (hit && Date.now() - hit.at < VERSION_PROBE_TTL_MS) return hit.version;
  const { ok, stdout } = await runCommand(cmd[0], cmd.slice(1), 5000);
  const version = ok ? stdout.match(/\d+(?:\.\d+)+/)?.[0] ?? null : null;
  versionProbeCache.set(key, { version, at: Date.now() });
  return version;
}

/** Client-facing forward-proxy endpoint derived from the runtime config snapshot. */
export interface ForwardProxyEndpoint {
  url: string;
  port: number;
  caPath: string;
  /** `forwardProxy.requireCredential`: launchers must carry the key in the URL. */
  requireCredential: boolean;
}

/**
 * Effective forward-proxy endpoint from the runtime config snapshot; null
 * when the forward proxy is disabled or the config is unreadable.
 */
export function resolveForwardProxyEndpoint(): ForwardProxyEndpoint | null {
  let cfg: RouterConfig | undefined;
  try {
    cfg = getRuntimeConfigRef() || loadConfig();
  } catch {
    return null;
  }
  const fp = cfg?.forwardProxy;
  if (!fp || fp.enabled !== true) return null;
  const port = Number.isFinite(fp.port) && (fp.port as number) > 0 ? (fp.port as number) : DEFAULT_FORWARD_PROXY_PORT;
  // `host` is a LISTEN address — the client-facing URL must stay reachable
  // from the client on the same machine, so wildcard binds normalize to loopback.
  const host = !fp.host || fp.host === '0.0.0.0' || fp.host === '::' ? '127.0.0.1' : fp.host;
  return {
    url: `http://${host}:${port}`,
    port,
    caPath: caCertPath(fp.caDir),
    requireCredential: fp.requireCredential === true,
  };
}

/**
 * Post-setup advisories for a launcher hook: the launcher is written, but the
 * hooked client still fails at USE time until the listener runs and the platform
 * store trusts the MITM root. Shared by the launcher adapters so the code set and
 * the force semantics cannot drift adapter by adapter. (A `service-env` hook
 * writes NODE_EXTRA_CA_CERTS and needs none of this.)
 *
 * The CA verdict is FORCED: a cached pre-install "trusted" must never silence
 * the warning (the TTL cache still absorbs repeated status polls).
 */
export async function collectHookWarnings(fp: ForwardProxyEndpoint, port: number): Promise<ClientActionWarning[]> {
  const warnings: ClientActionWarning[] = [];
  if (!getForwardProxyStatus().running) {
    warnings.push({ code: 'proxy_not_running', params: { port: String(port) } });
  }
  const { trusted } = await probeCaTrustedCached(fp.caPath, { force: true });
  if (trusted === false) {
    warnings.push({ code: 'ca_not_trusted', params: { path: fp.caPath } });
  } else if (trusted === 'unknown') {
    warnings.push({ code: 'ca_trust_unknown' });
  }
  return warnings;
}


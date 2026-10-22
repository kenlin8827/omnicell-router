import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ClientAdapter } from './base.js';
import { ClientHookStatus } from '../types.js';
import { loadConfig, getRuntimeConfigRef } from '../../config/index.js';
import { DEFAULT_FORWARD_PROXY_PORT } from '../../config/defaults.js';
import { getOcrHomeDir } from '../paths.js';

/**
 * OpenCode "proxy mode" client adapter.
 *
 * Unlike OpenCodeClientAdapter (provider injection into opencode.json(c)),
 * this hook leaves the client config file untouched and points OpenCode's OWN
 * outbound traffic at OCR's inbound forward proxy by persisting managed
 * service environment variables (OpenCode v2 managed service):
 *
 *   opencode service set env HTTPS_PROXY http://127.0.0.1:<forwardProxy.port>
 *   opencode service set env HTTP_PROXY  http://127.0.0.1:<forwardProxy.port>
 *   opencode service set env NO_PROXY    localhost,127.0.0.1,::1   (REQUIRED:
 *     the opencode CLI talks to its background service over local HTTP —
 *     routing that through any proxy breaks opencode itself)
 *   opencode service set env NODE_EXTRA_CA_CERTS <forwardProxy.caDir>/ca.pem
 *     (the forward proxy is a full-capture MITM — its CA must be trusted)
 *
 * The forward proxy intercepts only canonical LLM endpoints
 * (/v1/chat/completions, /v1/messages, /v1/responses) into the routing
 * pipeline; every other destination is forwarded transparently, so pointing
 * ALL of opencode's HTTPS traffic at it is safe. Models and API keys stay
 * opencode-native — the gateway key / provider-injection model picker do not
 * apply to this mode (modelSlots stays empty).
 *
 * Every value is resolved from the RUNTIME config snapshot
 * (getRuntimeConfigRef() || loadConfig()) — never hardcoded — so what gets
 * written into opencode always matches the RUNNING forward proxy. A fresh
 * loadConfig() after a hot reload could advertise a port the running proxy
 * no longer listens on.
 *
 * Scope caveat (opencode v2 docs): `service set env` configures the managed
 * background service ONLY. `opencode --standalone`, `opencode serve` and
 * shell-launched CLIs read their own process environment — the setup message
 * tells the user to set the same variables there manually.
 */

const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'] as const;
const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1';

interface ForwardProxyEndpoint {
  url: string;
  caPath: string;
}

/**
 * Effective forward-proxy endpoint from the runtime config snapshot; null
 * when the forward proxy is disabled or the config is unreadable.
 */
function resolveForwardProxyEndpoint(): ForwardProxyEndpoint | null {
  let cfg: ReturnType<typeof loadConfig> | undefined;
  try {
    cfg = getRuntimeConfigRef() || loadConfig();
  } catch {
    return null;
  }
  const fp = cfg?.forwardProxy;
  if (!fp || fp.enabled !== true) return null;
  const port = Number.isFinite(fp.port) && (fp.port as number) > 0 ? (fp.port as number) : DEFAULT_FORWARD_PROXY_PORT;
  // `host` is a LISTEN address — the client-facing URL must stay reachable
  // from opencode on the same machine, so wildcard binds normalize to loopback.
  const host = !fp.host || fp.host === '0.0.0.0' || fp.host === '::' ? '127.0.0.1' : fp.host;
  const caDir = fp.caDir?.trim() || path.join(getOcrHomeDir(), 'forward-proxy');
  return { url: `http://${host}:${port}`, caPath: path.join(caDir, 'ca.pem') };
}

function defaultCaPath(): string {
  return path.join(getOcrHomeDir(), 'forward-proxy', 'ca.pem');
}

/** Stable sidecar recording the service env values we replaced (teardown restores them). */
function metaPath(): string {
  return path.join(getOcrHomeDir(), 'opencode-proxy.env-meta.json');
}

interface ProxyMeta {
  previous?: Partial<Record<(typeof PROXY_ENV_KEYS)[number], string>>;
}

function readMeta(): ProxyMeta {
  try {
    if (fs.existsSync(metaPath())) return JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
  } catch {
    // ignore — treated as "no originals recorded"
  }
  return {};
}

function writeMeta(meta: ProxyMeta): void {
  try {
    fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2), 'utf8');
  } catch {
    // best effort — teardown then just unsets whatever we set
  }
}

interface OcRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run `opencode <args>` ASYNCHRONOUSLY — getStatus is polled (~4s) by the
 * console, so a sync spawn here would block the whole gateway event loop.
 *
 * Windows: opencode may be an npm `.cmd` shim, so the spawn goes through
 * cmd.exe and args containing spaces/cmd metacharacters are pre-quoted for
 * the shell line (note: `%` inside double quotes is still cmd-expanded —
 * paths containing `%` are out of scope). Other platforms spawn directly
 * with an argv array.
 */
function runOpenCode(args: string[]): Promise<OcRunResult> {
  const isWin = process.platform === 'win32';
  const finalArgs = isWin
    ? args.map(a => (/[\s"%^&|<>()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
    : args;
  return new Promise(resolve => {
    const child = spawn('opencode', finalArgs, {
      shell: isWin,
      windowsHide: true,
      timeout: 20_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', err => resolve({ ok: false, stdout, stderr: `${err}` }));
    child.on('close', code => resolve({ ok: code === 0, stdout, stderr }));
  });
}

/**
 * `opencode service get env` probe with a 30s TTL — the console polls status
 * every ~4s and spawning the CLI that often is wasteful. Invalidated by
 * setup/teardown so hook-state changes reflect immediately.
 */
const PROBE_TTL_MS = 30_000;
let probeCache: { at: number; result: OcRunResult } | null = null;

function probeServiceEnv(): Promise<OcRunResult> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return Promise.resolve(probeCache.result);
  return runOpenCode(['service', 'get', 'env']).then(result => {
    probeCache = { at: Date.now(), result };
    return result;
  });
}

function invalidateProbe(): void {
  probeCache = null;
}

/**
 * Substring test for our proxy URL with a digit-boundary guard — plain
 * `includes` would collide on port prefixes (4555 vs 45550).
 */
function urlMentioned(raw: string, url: string): boolean {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped + '(?![0-9])').test(raw);
}

/**
 * Parse `opencode service get env` output. The exact rendering is not a
 * stable contract (JSON object, KEY=value lines or bullet lists), so accept
 * JSON (flat or one level of wrapper objects) and per-line `KEY[=:] value`
 * pairs. Only OUR four keys are ever read back, so extra output is harmless.
 */
function parseServiceEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const trimmed = (raw || '').trim();
  if (!trimmed) return out;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const obj = JSON.parse(trimmed);
      const collect = (input: unknown, depth: number): void => {
        if (!input || typeof input !== 'object' || depth > 1) return;
        for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
          if (typeof v === 'string') out[k.toUpperCase()] = v;
          else collect(v, depth + 1);
        }
      };
      collect(obj, 0);
      if (Object.keys(out).length > 0) return out;
    } catch {
      // fall through to line parsing
    }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(/^\s*\*?\s*-?\s*([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/);
    if (m) out[m[1].toUpperCase()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/**
 * Heuristic: does this env value belong to OUR hook (vs the user's own proxy
 * like clash)? Used by teardown when no sidecar originals were recorded —
 * only then is it safe to unset.
 */
function looksLikeOurs(key: string, value: string, fp: ForwardProxyEndpoint | null): boolean {
  if (!value) return false;
  const v = value.trim();
  if (fp && v === fp.url) return true;
  if (key === 'NO_PROXY') return v.replace(/\s/g, '') === LOOPBACK_NO_PROXY;
  if (key === 'NODE_EXTRA_CA_CERTS') {
    const ours = path.resolve(fp?.caPath || defaultCaPath());
    try {
      return path.resolve(v) === ours;
    } catch {
      return false;
    }
  }
  return false;
}

export class OpenCodeProxyClientAdapter implements ClientAdapter {
  name = 'opencode-proxy' as const;
  displayName = 'OpenCode (Proxy Mode)';

  getConfigPath(): string {
    // Proxy mode owns no client config file; the meaningful artifact is the
    // MITM CA written into opencode's trust store (NODE_EXTRA_CA_CERTS).
    return resolveForwardProxyEndpoint()?.caPath || defaultCaPath();
  }

  async getStatus(): Promise<ClientHookStatus> {
    const fp = resolveForwardProxyEndpoint();
    const probe = await probeServiceEnv();
    const exists = probe.ok; // CLI reachable AND the v2 `service` subcommand works
    const backupExists = fs.existsSync(metaPath());
    let hooked = false;
    let details: string;

    if (!probe.ok) {
      details = /not recognized|ENOENT|not found/i.test(probe.stderr)
        ? 'opencode CLI not detected on PATH'
        : 'opencode detected but `service` command unavailable (OpenCode v2 required)';
    } else if (!fp) {
      details = 'forwardProxy disabled in config.yaml — enable it before hooking proxy mode';
    } else {
      const env = parseServiceEnv(probe.stdout);
      const proxyValue = (env.HTTPS_PROXY || env.HTTP_PROXY || '').trim();
      const oursProxy = proxyValue === fp.url || urlMentioned(probe.stdout, fp.url);
      const oursCa = (env.NODE_EXTRA_CA_CERTS || '').trim().length > 0 || /NODE_EXTRA_CA_CERTS/i.test(probe.stdout);
      if (oursProxy && oursCa) {
        hooked = true;
        details = `Proxied through OCR forward proxy (${fp.url}); CA: ${env.NODE_EXTRA_CA_CERTS || fp.caPath}`;
      } else if (proxyValue) {
        details = `Active with another proxy (${proxyValue}) — setup will replace it (previous value kept for teardown)`;
      } else {
        details = 'opencode service env has no proxy configured';
      }
    }

    return {
      name: this.name,
      displayName: this.displayName,
      configPath: this.getConfigPath(),
      exists,
      hooked,
      backupExists,
      details,
      modelSlots: [], // no model picker — models/keys stay opencode-native in proxy mode
    };
  }

  async setup(): Promise<{ success: boolean; message: string }> {
    invalidateProbe();
    const fp = resolveForwardProxyEndpoint();
    if (!fp) {
      return {
        success: false,
        message:
          'forwardProxy is not enabled in config.yaml — set `forwardProxy.enabled: true` (and keep the gateway running) before enabling OpenCode proxy mode.',
      };
    }
    if (!fs.existsSync(fp.caPath)) {
      return {
        success: false,
        message: `Forward-proxy MITM CA not found at ${fp.caPath} — it is generated when the gateway boots with forwardProxy enabled. Start the gateway and retry.`,
      };
    }
    const probe = await probeServiceEnv();
    if (!probe.ok) {
      return {
        success: false,
        message: `\`opencode service get env\` failed — OpenCode v2 with the managed service is required for proxy mode. ${(probe.stderr || probe.stdout).trim()}`.trim(),
      };
    }

    // Record originals BEFORE overwriting: if a later `set env` fails midway,
    // teardown must still restore what setup replaced — the looksLikeOurs
    // fallback can only unset OUR values, which would lose the user's
    // original. Restoring an identical value on a never-replaced key is
    // harmless; data preservation wins over the stale-restore edge case.
    const current = parseServiceEnv(probe.stdout);
    const previous: Partial<Record<(typeof PROXY_ENV_KEYS)[number], string>> = {};
    for (const k of PROXY_ENV_KEYS) {
      const v = current[k];
      if (typeof v === 'string' && v.length > 0) previous[k] = v;
    }
    writeMeta({ previous });

    for (const [k, v] of [
      ['HTTPS_PROXY', fp.url],
      ['HTTP_PROXY', fp.url],
      ['NO_PROXY', LOOPBACK_NO_PROXY],
      ['NODE_EXTRA_CA_CERTS', fp.caPath],
    ] as const) {
      const r = await runOpenCode(['service', 'set', 'env', k, v]);
      if (!r.ok) {
        return { success: false, message: `\`opencode service set env ${k}\` failed: ${(r.stderr || r.stdout).trim()}` };
      }
    }

    // Changing managed env stops the running service — start it back up.
    const start = await runOpenCode(['service', 'start']);
    if (!start.ok) {
      return {
        success: false,
        message: `Proxy env persisted (${fp.url}) but \`opencode service start\` failed: ${(start.stderr || start.stdout).trim()} — run it manually, or teardown to revert.`,
      };
    }

    return {
      success: true,
      message: `OpenCode proxy mode enabled: HTTPS_PROXY/HTTP_PROXY → ${fp.url}, NO_PROXY → ${LOOPBACK_NO_PROXY}, NODE_EXTRA_CA_CERTS → ${fp.caPath}. LLM endpoints are intercepted into the OCR pipeline, other traffic forwards transparently. NOTE: \`opencode --standalone\`/\`serve\` and shell-launched CLIs read their own process env — set the same variables there manually if you use those modes.`,
    };
  }

  async teardown(): Promise<{ success: boolean; message: string }> {
    invalidateProbe();
    const probe = await probeServiceEnv();
    if (!probe.ok) {
      return {
        success: false,
        message: `\`opencode service get env\` failed — cannot inspect opencode service env. ${(probe.stderr || probe.stdout).trim()}`.trim(),
      };
    }
    const { previous } = readMeta();
    const current = parseServiceEnv(probe.stdout);
    const fp = resolveForwardProxyEndpoint();

    const touched: string[] = [];
    let oursPresent = false;
    for (const k of PROXY_ENV_KEYS) {
      const prev = previous?.[k];
      const cur = current[k] || '';
      if (prev !== undefined) {
        const r = await runOpenCode(['service', 'set', 'env', k, prev]);
        if (!r.ok) {
          return { success: false, message: `\`opencode service set env ${k}\` failed: ${(r.stderr || r.stdout).trim()}` };
        }
        touched.push(`${k} (restored)`);
        oursPresent = true;
      } else if (cur && looksLikeOurs(k, cur, fp)) {
        const r = await runOpenCode(['service', 'unset', 'env', k]);
        if (!r.ok) {
          return { success: false, message: `\`opencode service unset env ${k}\` failed: ${(r.stderr || r.stdout).trim()}` };
        }
        touched.push(`${k} (removed)`);
        oursPresent = true;
      }
    }

    try {
      fs.unlinkSync(metaPath());
    } catch {
      // best effort
    }

    if (!oursPresent) {
      return { success: false, message: 'OpenCode proxy mode is not active — nothing to tear down.' };
    }

    const start = await runOpenCode(['service', 'start']);
    if (!start.ok) {
      return {
        success: false,
        message: `Env restored (${touched.join(', ')}) but \`opencode service start\` failed: ${(start.stderr || start.stdout).trim()} — run it manually.`,
      };
    }

    return {
      success: true,
      message: `OpenCode proxy mode disabled: ${touched.join(', ')}. Service restarted with the previous environment.`,
    };
  }
}

/**
 * Mihomo external-controller client (Clash API, loopback only).
 *
 * Every call sends `Authorization: Bearer <secret>`. The secret is never
 * placed in an error message, a URL, or a log line. Paths are encoded so a
 * node name with a slash cannot escape the route.
 */
import { DEFAULT_MIHOMO_TEST_URL, MIHOMO_DELAY_TIMEOUT_MS } from '../config/defaults.js';

export class MihomoControllerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'MihomoControllerError';
    this.status = status;
    this.code = code;
  }
}

export interface MihomoProxyNode {
  name: string;
  type: string;
  now?: string;
  all?: string[];
  delay?: number | null;
}

export interface MihomoProxiesSnapshot {
  proxies: Record<string, MihomoProxyNode>;
}

/** One row of the core's effective rule table (`GET /rules`). */
export interface MihomoRuleRow {
  type: string;
  payload: string;
  proxy: string;
}

export interface MihomoProviderInfo {
  name: string;
  vehicleType?: string;
  updatedAt?: string;
  nodeCount?: number;
}

export interface MihomoClientOptions {
  port: number;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class MihomoClient {
  private readonly port: number;
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: MihomoClientOptions) {
    this.port = opts.port;
    this.secret = opts.secret;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async version(): Promise<string | null> {
    const body = await this.request('GET', '/version');
    const version = body && typeof body === 'object' ? (body as { version?: unknown }).version : undefined;
    return typeof version === 'string' && version.trim() ? version : null;
  }

  async proxies(): Promise<MihomoProxiesSnapshot> {
    const body = await this.request('GET', '/proxies');
    const raw = body && typeof body === 'object' ? (body as { proxies?: unknown }).proxies : undefined;
    const proxies: Record<string, MihomoProxyNode> = {};
    if (raw && typeof raw === 'object') {
      for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const rec = value as Record<string, unknown>;
        const history = Array.isArray(rec.history) ? rec.history : [];
        const last = history.length ? (history[history.length - 1] as { delay?: unknown }) : undefined;
        // mihomo records a FAILED url-test as delay 0 in the history; zero is
        // not a measurement, it is a timeout. Keep it null so the console can
        // render "—" instead of a misleading "0 ms".
        const delay = last && typeof last.delay === 'number' && last.delay > 0 ? last.delay : null;
        proxies[name] = {
          name: typeof rec.name === 'string' ? rec.name : name,
          type: typeof rec.type === 'string' ? rec.type : 'Unknown',
          now: typeof rec.now === 'string' ? rec.now : undefined,
          all: Array.isArray(rec.all) ? rec.all.filter((item): item is string => typeof item === 'string') : undefined,
          delay,
        };
      }
    }
    return { proxies };
  }

  async select(group: string, name: string): Promise<void> {
    await this.request('PUT', `/proxies/${encodeURIComponent(group)}`, { name });
  }

  /**
   * Round-trip delay in milliseconds for one proxy.
   *
   * The config-scoped route (`/proxies/{name}/delay`) resolves names through
   * mihomo's own proxy map — the generated `proxies:` block, the groups and
   * the built-ins. A proxy-provider (subscription) node is NOT registered
   * there: it belongs to its provider, so the controller answers that route
   * with 404 "Resource not found" for a perfectly healthy node. The provider
   * scope exposes the SAME delay test at
   * `/providers/proxies/{provider}/{name}/healthcheck`, so membership decides
   * which route a name goes down.
   */
  async delay(name: string, timeoutMs = MIHOMO_DELAY_TIMEOUT_MS, testUrl = DEFAULT_MIHOMO_TEST_URL): Promise<number> {
    const q = new URLSearchParams({
      timeout: String(timeoutMs),
      url: testUrl,
    });
    const snapshot = await this.proxies();
    if (snapshot.proxies[name]) {
      return this.runDelay(`/proxies/${encodeURIComponent(name)}/delay?${q}`, timeoutMs);
    }
    const owner = (await this.providerIndex())[name]?.provider;
    if (!owner) {
      throw new MihomoControllerError(`proxy "${name}" is not known to the running core`, 404, 'node-not-found');
    }
    const path = `/providers/proxies/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/healthcheck?${q}`;
    return this.runDelay(path, timeoutMs);
  }

  /** Shared body of the delay endpoints: run one URL test, read its measurement. */
  private async runDelay(path: string, timeoutMs: number): Promise<number> {
    let body: unknown;
    try {
      body = await this.request('GET', path, undefined, timeoutMs + 2000);
    } catch (err) {
      // A failed test is not a controller fault. mihomo answers the ctx
      // timeout with 504 (`{"message":"Timeout"}`) — its delay handler renders
      // `http.StatusGatewayTimeout` — so 504 is the timeout; 408 is kept for
      // builds/forks that answer the request-timeout status instead.
      if (err instanceof MihomoControllerError && (err.status === 504 || err.status === 408)) {
        throw new MihomoControllerError('delay test timed out (node or target unreachable)', err.status, 'timeout');
      }
      throw err;
    }
    const measured = body && typeof body === 'object' && 'delay' in body ? body.delay : undefined;
    // A failed delay test surfaces as delay 0; treat it as "no measurement"
    // rather than reporting a 0 ms round trip.
    if (typeof measured !== 'number' || !Number.isFinite(measured) || measured <= 0) {
      throw new MihomoControllerError('mihomo delay test returned no measurement', 200, 'delay-missing');
    }
    return measured;
  }

  /** name → delay (ms) for every member of a group. */
  async groupDelay(name: string, timeoutMs = MIHOMO_DELAY_TIMEOUT_MS, testUrl = DEFAULT_MIHOMO_TEST_URL): Promise<Record<string, number>> {
    const q = new URLSearchParams({
      timeout: String(timeoutMs),
      url: testUrl,
    });
    const body = await this.request('GET', `/group/${encodeURIComponent(name)}/delay?${q}`, undefined, timeoutMs + 2000);
    const out: Record<string, number> = {};
    if (body && typeof body === 'object') {
      for (const [node, value] of Object.entries(body as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[node] = value;
      }
    }
    return out;
  }

  async providers(): Promise<MihomoProviderInfo[]> {
    const body = await this.request('GET', '/providers/proxies');
    const raw = body && typeof body === 'object' ? (body as { providers?: unknown }).providers : undefined;
    if (!raw || typeof raw !== 'object') return [];
    const out: MihomoProviderInfo[] = [];
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const rec = value as Record<string, unknown>;
      const proxies = Array.isArray(rec.proxies) ? rec.proxies.length : undefined;
      const updated = rec.updatedAt;
      // Go marshals `time.Time{}` — a provider that never fetched — as
      // 0001-01-01T00:00:00Z. That is "no timestamp", not an ancient one, so
      // drop it at the boundary instead of teaching every consumer the zero
      // value. Date.parse rejects junk, and the zero instant is negative.
      const updatedMs = typeof updated === 'string' ? Date.parse(updated) : NaN;
      out.push({
        name: typeof rec.name === 'string' ? rec.name : name,
        vehicleType: typeof rec.vehicleType === 'string' ? rec.vehicleType : undefined,
        updatedAt: Number.isFinite(updatedMs) && updatedMs > 0 ? (updated as string) : undefined,
        nodeCount: proxies,
      });
    }
    return out;
  }

  /**
   * Flat index of provider-backed proxies: name → { provider, type, delay }.
   *
   * WHY this exists: `/proxies` only returns the groups and the built-ins, NOT
   * the nodes a `proxy-provider` contributed — yet a group's `all` lists their
   * names. Resolving a member from `/proxies` alone therefore yields nothing,
   * which is what rendered an entire subscription as type "Unknown" with no
   * delay. `/providers/proxies` carries the full records (type + history), so it
   * is the second half of the same answer.
   */
  async providerIndex(): Promise<Record<string, { provider: string; type: string; delay: number | null }>> {
    const body = await this.request('GET', '/providers/proxies');
    const raw = body && typeof body === 'object' ? (body as { providers?: unknown }).providers : undefined;
    if (!raw || typeof raw !== 'object') return {};
    const index: Record<string, { provider: string; type: string; delay: number | null }> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const rec = value as Record<string, unknown>;
      const provider = typeof rec.name === 'string' && rec.name ? rec.name : key;
      const list = Array.isArray(rec.proxies) ? rec.proxies : [];
      for (const item of list) {
        if (typeof item === 'string') {
          index[item] = { provider, type: '', delay: null };
          continue;
        }
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const name = typeof row.name === 'string' ? row.name : '';
        if (!name) continue;
        const history = Array.isArray(row.history) ? row.history : [];
        const last = history.length ? (history[history.length - 1] as { delay?: unknown }) : undefined;
        index[name] = {
          provider,
          type: typeof row.type === 'string' ? row.type : '',
          delay: last && typeof last.delay === 'number' && last.delay > 0 ? last.delay : null,
        };
      }
    }
    return index;
  }

  /**
   * The rule table the core actually loaded (`GET /rules`) — the effective
   * truth, not what any config file claims. A subscription's own `rules:` are
   * NOT part of it: providers only contribute proxies.
   */
  async rules(): Promise<MihomoRuleRow[]> {
    const body = await this.request('GET', '/rules');
    const list = body && typeof body === 'object' ? (body as { rules?: unknown }).rules : undefined;
    if (!Array.isArray(list)) return [];
    const rows: MihomoRuleRow[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const type = typeof row.type === 'string' ? row.type : '';
      const proxy = typeof row.proxy === 'string' ? row.proxy : '';
      if (!type) continue;
      rows.push({ type, payload: typeof row.payload === 'string' ? row.payload : '', proxy });
    }
    return rows;
  }

  /** Ask mihomo to re-fetch one proxy-provider. */
  async refreshProvider(name: string): Promise<void> {
    await this.request('PUT', `/providers/proxies/${encodeURIComponent(name)}`);
  }

  /**
   * The live outbound mode (`/configs` → `mode`), or null when the controller
   * reports nothing usable. Distinct from the gateway's `proxy.mode`.
   */
  async routingMode(): Promise<'rule' | 'global' | 'direct' | null> {
    const body = await this.request('GET', '/configs');
    const mode = body && typeof body === 'object' ? (body as { mode?: unknown }).mode : undefined;
    if (mode === 'rule' || mode === 'global' || mode === 'direct') return mode;
    return null;
  }

  /** Hot-swap the outbound mode (PATCH /configs) — no restart, no config rewrite. */
  async setRoutingMode(mode: 'rule' | 'global' | 'direct'): Promise<void> {
    await this.request('PATCH', '/configs', { mode });
  }

  /** Reload the on-disk config (PUT /configs). */
  async reloadConfig(configPath: string): Promise<void> {
    await this.request('PUT', '/configs?force=true', { path: configPath });
  }

  private async request(method: string, path: string, jsonBody?: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    const url = `http://127.0.0.1:${this.port}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.secret}`,
          ...(jsonBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'controller unreachable';
      throw new MihomoControllerError(`mihomo controller unreachable (${message})`, 0, 'unreachable');
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new MihomoControllerError('mihomo controller rejected the secret', res.status, 'unauthorized');
    }
    if (!res.ok && res.status !== 204) {
      // The controller explains failures in a JSON `message`; dropping it
      // turns "why did the node test fail" into an opaque status code.
      let detail = '';
      try {
        const parsed = JSON.parse(text) as { message?: unknown };
        if (typeof parsed.message === 'string' && parsed.message.trim()) detail = `: ${parsed.message.trim()}`;
      } catch {
        /* non-JSON error body */
      }
      throw new MihomoControllerError(`mihomo controller returned ${res.status}${detail}`, res.status, 'controller-error');
    }
    if (!text || res.status === 204) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
}

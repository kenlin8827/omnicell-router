/**
 * Mihomo external-controller client (Clash API, loopback only).
 *
 * Every call sends `Authorization: Bearer <secret>`. The secret is never
 * placed in an error message, a URL, or a log line. Paths are encoded so a
 * node name with a slash cannot escape the route.
 */
import { MIHOMO_DELAY_TEST_URL } from './mihomo-config.js';

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
        const delay = last && typeof last.delay === 'number' ? last.delay : null;
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

  /** Round-trip delay in milliseconds for one proxy. */
  async delay(name: string, timeoutMs = 5000): Promise<number> {
    const q = new URLSearchParams({
      timeout: String(timeoutMs),
      url: MIHOMO_DELAY_TEST_URL,
    });
    const body = await this.request('GET', `/proxies/${encodeURIComponent(name)}/delay?${q}`, undefined, timeoutMs + 2000);
    const delay = body && typeof body === 'object' ? (body as { delay?: unknown }).delay : undefined;
    if (typeof delay !== 'number' || !Number.isFinite(delay)) {
      throw new MihomoControllerError('mihomo delay test returned no measurement', 200, 'delay-missing');
    }
    return delay;
  }

  /** name → delay (ms) for every member of a group. */
  async groupDelay(name: string, timeoutMs = 5000): Promise<Record<string, number>> {
    const q = new URLSearchParams({
      timeout: String(timeoutMs),
      url: MIHOMO_DELAY_TEST_URL,
    });
    const body = await this.request('GET', `/group/${encodeURIComponent(name)}/delay?${q}`, undefined, timeoutMs + 2000);
    const out: Record<string, number> = {};
    if (body && typeof body === 'object') {
      for (const [node, value] of Object.entries(body as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) out[node] = value;
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
      out.push({
        name: typeof rec.name === 'string' ? rec.name : name,
        vehicleType: typeof rec.vehicleType === 'string' ? rec.vehicleType : undefined,
        updatedAt: typeof updated === 'string' ? updated : undefined,
        nodeCount: proxies,
      });
    }
    return out;
  }

  /** Ask mihomo to re-fetch one proxy-provider. */
  async refreshProvider(name: string): Promise<void> {
    await this.request('PUT', `/providers/proxies/${encodeURIComponent(name)}`);
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
      throw new MihomoControllerError(`mihomo controller returned ${res.status}`, res.status, 'controller-error');
    }
    if (!text || res.status === 204) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
}

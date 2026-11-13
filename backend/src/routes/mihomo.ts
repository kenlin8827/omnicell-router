/**
 * Admin routes for the mihomo outbound core (ADR-0022).
 *
 * Mounted under /api/admin/proxy/mihomo/*, so the console auth preHandler
 * covers them. Responses never include the controller secret or a raw
 * subscription URL in an error string. The subscription list itself is
 * returned to the authenticated console — the operator edits those URLs.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig, mergeProxyConfig, saveConfig } from '../config/index.js';
import type { MihomoSubscription, ProxyConfig } from '../config/types.js';
import { installMihomoBinary } from '../proxy/mihomo-binary.js';
import { MihomoClient, MihomoControllerError } from '../proxy/mihomo-client.js';
import { redactSubscriptionUrl } from '../proxy/mihomo-config.js';
import {
  getMihomoStatus,
  reconcileMihomoSidecar,
  restartMihomoSidecar,
  startMihomoSidecar,
  stopMihomoSidecar,
  type MihomoOpResult,
} from '../proxy/mihomo-sidecar.js';
import { DEFAULT_MIHOMO_GROUP } from '../config/defaults.js';

function currentProxy(): ProxyConfig {
  return loadConfig().proxy ?? {};
}

function persistProxy(next: ProxyConfig): { success: boolean; error?: string } {
  return saveConfig({ proxy: mergeProxyConfig(currentProxy(), next) });
}

function clientOrNull(proxy: ProxyConfig): MihomoClient | null {
  const secret = (proxy.mihomo?.controllerSecret || '').trim();
  const port = proxy.mihomo?.controllerPort;
  if (!secret || !port) return null;
  return new MihomoClient({ port, secret });
}

function opBody(result: MihomoOpResult) {
  return { status: result.ok ? 'ok' as const : 'error' as const, ...result };
}

function badSubscription(message: string) {
  return { status: 'error' as const, message };
}

function normalizeDraft(body: any, id: string): MihomoSubscription {
  return {
    id,
    name: typeof body?.name === 'string' ? body.name : '',
    url: typeof body?.url === 'string' ? body.url : '',
    interval: typeof body?.interval === 'number' ? body.interval : undefined,
    enabled: body?.enabled !== false,
  };
}

export function registerMihomoRoutes(app: FastifyInstance): void {
  app.get('/api/admin/proxy/mihomo/status', async () => {
    const status = await getMihomoStatus();
    return { status: 'ok', ...status };
  });

  app.post('/api/admin/proxy/mihomo/start', async () => opBody(await startMihomoSidecar()));
  app.post('/api/admin/proxy/mihomo/stop', async () => opBody(await stopMihomoSidecar()));
  app.post('/api/admin/proxy/mihomo/restart', async () => opBody(await restartMihomoSidecar()));

  app.post('/api/admin/proxy/mihomo/install', async (req) => {
    const version = typeof (req.body as { version?: unknown } | null)?.version === 'string'
      ? (req.body as { version: string }).version
      : undefined;
    const result = await installMihomoBinary({ version });
    return { status: result.ok ? 'ok' : 'error', ...result };
  });

  app.get('/api/admin/proxy/mihomo/subscriptions', async () => {
    const proxy = currentProxy();
    const subscriptions = proxy.mihomo?.subscriptions ?? [];
    let providers: Array<{ name: string; updatedAt?: string; nodeCount?: number; vehicleType?: string }> = [];
    const client = clientOrNull(proxy);
    if (client) {
      try {
        providers = await client.providers();
      } catch {
        providers = [];
      }
    }
    return { status: 'ok', subscriptions, providers };
  });

  app.post('/api/admin/proxy/mihomo/subscriptions', async (req, reply) => {
    const proxy = currentProxy();
    const id = crypto.randomBytes(6).toString('hex');
    const draft = normalizeDraft(req.body, id);
    const merged = mergeProxyConfig(proxy, {
      mihomo: { subscriptions: [...(proxy.mihomo?.subscriptions ?? []), draft] },
    });
    const saved = merged.mihomo?.subscriptions ?? [];
    if (!saved.some((item) => item.id === id)) {
      return reply.status(400).send(badSubscription('subscription needs a name and an http(s) url'));
    }
    const result = persistProxy(merged);
    if (!result.success) return reply.status(400).send({ status: 'error', message: result.error || 'save failed' });
    const sidecar = await reconcileMihomoSidecar();
    return { status: 'ok', subscription: saved.find((item) => item.id === id), sidecar: opBody(sidecar) };
  });

  app.put('/api/admin/proxy/mihomo/subscriptions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const proxy = currentProxy();
    const list = proxy.mihomo?.subscriptions ?? [];
    if (!list.some((item) => item.id === id)) {
      return reply.status(404).send({ status: 'error', message: 'subscription not found' });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const nextList = list.map((item) => item.id === id
      ? normalizeDraft({ ...item, ...body, id }, id)
      : item);
    const merged = mergeProxyConfig(proxy, { mihomo: { subscriptions: nextList } });
    const saved = merged.mihomo?.subscriptions?.find((item) => item.id === id);
    if (!saved) return reply.status(400).send(badSubscription('subscription needs a name and an http(s) url'));
    const result = persistProxy(merged);
    if (!result.success) return reply.status(400).send({ status: 'error', message: result.error || 'save failed' });
    const sidecar = await reconcileMihomoSidecar();
    return { status: 'ok', subscription: saved, sidecar: opBody(sidecar) };
  });

  app.delete('/api/admin/proxy/mihomo/subscriptions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const proxy = currentProxy();
    const list = proxy.mihomo?.subscriptions ?? [];
    if (!list.some((item) => item.id === id)) {
      return reply.status(404).send({ status: 'error', message: 'subscription not found' });
    }
    const merged = mergeProxyConfig(proxy, {
      mihomo: { subscriptions: list.filter((item) => item.id !== id) },
    });
    const result = persistProxy(merged);
    if (!result.success) return reply.status(400).send({ status: 'error', message: result.error || 'save failed' });
    const sidecar = await reconcileMihomoSidecar();
    return { status: 'ok', sidecar: opBody(sidecar) };
  });

  app.post('/api/admin/proxy/mihomo/subscriptions/:id/refresh', async (req, reply) => {
    const { id } = req.params as { id: string };
    const proxy = currentProxy();
    if (!(proxy.mihomo?.subscriptions ?? []).some((item) => item.id === id)) {
      return reply.status(404).send({ status: 'error', message: 'subscription not found' });
    }
    const client = clientOrNull(proxy);
    if (!client) return reply.status(409).send({ status: 'error', code: 'not-running', message: 'mihomo controller is not configured' });
    try {
      await client.refreshProvider(id);
      return { status: 'ok', refreshed: [id] };
    } catch (err) {
      return reply.status(502).send(controllerFailure(err));
    }
  });

  app.post('/api/admin/proxy/mihomo/subscriptions/refresh', async (_req, reply) => {
    const proxy = currentProxy();
    const ids = (proxy.mihomo?.subscriptions ?? []).filter((item) => item.enabled !== false).map((item) => item.id);
    const client = clientOrNull(proxy);
    if (!client) return reply.status(409).send({ status: 'error', code: 'not-running', message: 'mihomo controller is not configured' });
    const refreshed: string[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      try {
        await client.refreshProvider(id);
        refreshed.push(id);
      } catch {
        failed.push(id);
      }
    }
    return { status: failed.length ? 'error' : 'ok', refreshed, failed };
  });

  app.get('/api/admin/proxy/mihomo/proxies', async () => {
    const proxy = currentProxy();
    const group = proxy.mihomo?.selectedGroup || DEFAULT_MIHOMO_GROUP;
    const client = clientOrNull(proxy);
    if (!client) {
      return { status: 'ok', running: false, group, groups: [], nodes: [] };
    }
    try {
      const snap = await client.proxies();
      const groups = Object.values(snap.proxies)
        .filter((item) => item.type === 'Selector' || item.type === 'URLTest' || item.type === 'Fallback' || item.type === 'LoadBalance')
        .map((item) => ({ name: item.name, type: item.type, now: item.now ?? '', all: item.all ?? [] }));
      const active = snap.proxies[group];
      const names = active?.all ?? [];
      const nodes = names.map((name) => {
        const node = snap.proxies[name];
        return {
          name,
          type: node?.type || 'Unknown',
          delay: node?.delay ?? null,
          selected: active?.now === name,
        };
      });
      return { status: 'ok', running: true, group, now: active?.now ?? null, groups, nodes };
    } catch (err) {
      if (err instanceof MihomoControllerError && err.code === 'unreachable') {
        return { status: 'ok', running: false, group, groups: [], nodes: [] };
      }
      return { running: false, group, groups: [], nodes: [], ...controllerFailure(err) };
    }
  });

  app.post('/api/admin/proxy/mihomo/proxies/select', async (req, reply) => {
    const body = (req.body ?? {}) as { group?: unknown; name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.status(400).send({ status: 'error', message: 'name is required' });
    const proxy = currentProxy();
    const group = typeof body.group === 'string' && body.group.trim() ? body.group.trim() : (proxy.mihomo?.selectedGroup || DEFAULT_MIHOMO_GROUP);
    const client = clientOrNull(proxy);
    if (!client) return reply.status(409).send({ status: 'error', code: 'not-running', message: 'mihomo controller is not configured' });
    try {
      await client.select(group, name);
    } catch (err) {
      return reply.status(502).send(controllerFailure(err));
    }
    const selectedNodes = { ...(proxy.mihomo?.selectedNodes ?? {}), [group]: name };
    const merged = mergeProxyConfig(proxy, { mihomo: { selectedGroup: group, selectedNodes } });
    const result = persistProxy(merged);
    if (!result.success) return reply.status(400).send({ status: 'error', message: result.error || 'save failed' });
    return { status: 'ok', group, name };
  });

  app.post('/api/admin/proxy/mihomo/proxies/test', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: unknown; group?: unknown; timeoutMs?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.status(400).send({ status: 'error', message: 'name is required' });
    const proxy = currentProxy();
    const client = clientOrNull(proxy);
    if (!client) return reply.status(409).send({ status: 'error', code: 'not-running', message: 'mihomo controller is not configured' });
    const timeoutMs = typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? Math.min(body.timeoutMs, 20_000) : 5000;
    try {
      if (body.group === true) {
        const delays = await client.groupDelay(name, timeoutMs);
        return { status: 'ok', group: name, delays };
      }
      const delay = await client.delay(name, timeoutMs);
      return { status: 'ok', name, delay };
    } catch (err) {
      return reply.status(502).send(controllerFailure(err));
    }
  });
}

function controllerFailure(err: unknown): { status: 'error'; code: string; message: string } {
  if (err instanceof MihomoControllerError) {
    return { status: 'error', code: err.code, message: err.message };
  }
  return { status: 'error', code: 'controller-error', message: 'mihomo controller request failed' };
}

/** Re-export so a log site that only has a URL can redact it without importing the generator. */
export { redactSubscriptionUrl };

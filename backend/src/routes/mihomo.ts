/**
 * Admin routes for the mihomo outbound core (ADR-0022).
 *
 * Mounted under /api/admin/proxy/mihomo/*, so the console auth preHandler
 * covers them. Responses never include the controller secret or a raw
 * subscription URL in an error string. The subscription list itself is
 * returned to the authenticated console — the operator edits those URLs.
 */
import crypto from 'node:crypto';
import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import { parse, stringify } from 'yaml';
import { loadConfig, mergeProxyConfig, sanitizeProxyConfig, saveConfig } from '../config/index.js';
import { isManualNodeProtocol, manualNodeCatalog, sanitizeTypedNode } from '../proxy/manual-node-spec.js';
import type { MihomoCustomRule, MihomoGroupType, MihomoManualNode, MihomoSubscription, ProxyConfig } from '../config/types.js';
import { installMihomoBinary } from '../proxy/mihomo-binary.js';
import { MihomoClient, MihomoControllerError } from '../proxy/mihomo-client.js';
import { MANUAL_NODE_FORM_KEYS, manualNodeFields, manualNodeMapping, redactSubscriptionUrl } from '../proxy/mihomo-config.js';
import { fetchSubscriptionYaml, importRulesFromYaml, readCachedProviderYaml } from '../proxy/mihomo-rules-import.js';
import {
  getMihomoStatus,
  mihomoWorkDir,
  reconcileMihomoSidecar,
  restartMihomoSidecar,
  startMihomoSidecar,
  stopMihomoSidecar,
  type MihomoOpResult,
} from '../proxy/mihomo-sidecar.js';
import { DEFAULT_MIHOMO_GROUP, DEFAULT_MIHOMO_MIXED_PORT, DEFAULT_MIHOMO_TEST_URL, MIHOMO_DELAY_TIMEOUT_MS, MIHOMO_NODE_PROBE_TIMEOUT_MS } from '../config/defaults.js';
import { PAC_PATH, buildPacScript } from '../proxy/mihomo-pac.js';

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

/**
 * Whitelist one manual node through the shared field table, so the route and
 * the read path can never disagree about what a valid node is. A rejected row
 * names the offending field; the caller answers 400 for the console.
 */
function sanitizeNodeDraft(body: unknown, id: string): { node: MihomoManualNode | null; errorField?: string } {
  return sanitizeTypedNode((body ?? {}) as Record<string, unknown>, id);
}

/** One pasted document → proxy mappings. Accepts a single mapping, a list of
 *  them, or a Clash fragment carrying `proxies:` — the three shapes an
 *  operator copies out of a profile. */
function parseNodeYamlBatch(text: string): Record<string, unknown>[] | null {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    return null;
  }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { proxies?: unknown })
    : null;
  const items: unknown[] = Array.isArray(parsed)
    ? parsed
    : record && Array.isArray(record.proxies) ? record.proxies : [parsed];
  return items.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

/** Empty/omitted → `undefined` (fall back to the persisted value); malformed
 *  or non-http(s) → null (caller answers 400). */
function parseRequestTestUrl(raw: unknown): string | null | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const value = raw.trim();
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname || parsed.username || parsed.password) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/** A raw mapping goes through the same sanitizer as a hand-edited config row,
 *  so identity/uniqueness rules cannot drift between the two entry points. */
function sanitizeNodeYamlDraft(draft: Record<string, unknown>, id: string): MihomoManualNode | null {
  const cleaned = sanitizeProxyConfig({ mihomo: { manualNodes: [{ id, yaml: stringify(draft) }] } });
  return cleaned.mihomo?.manualNodes?.[0] ?? null;
}

/** Names the core owns, or the group the operator is routing through. */
function nodeNameConflict(name: string, group: string, others: MihomoManualNode[]): string | null {
  if (name.toUpperCase() === group.toUpperCase() || ['DIRECT', 'REJECT', 'PASS', 'GLOBAL'].includes(name.toUpperCase())) {
    return `node name "${name}" is reserved`;
  }
  if (others.some((node) => node.name.toLowerCase() === name.toLowerCase())) {
    return `node name "${name}" already exists`;
  }
  return null;
}

function manualNodeFailure() {
  return 'node needs a name, a protocol, server, port and the credentials that protocol requires (or a complete Clash proxy mapping)';
}

export function registerMihomoRoutes(app: FastifyInstance): void {
  // Proxy auto-config for clients that cannot take a bare host:port (browsers,
  // OS network preferences): one URL, no secrets, so it sits outside /api and
  // is whitelisted in the auth preHandler. Generated from the live config on
  // every fetch, so a port edit in the console takes effect on the next read.
  app.get(PAC_PATH, async (_req, reply) => {
    const proxy = currentProxy();
    const proxyPort = proxy.mihomo?.mixedPort ?? DEFAULT_MIHOMO_MIXED_PORT;
    reply.header('content-type', 'application/x-ns-proxy-autoconfig; charset=utf-8');
    reply.header('cache-control', 'no-store');
    return reply.send(buildPacScript({ proxyPort }));
  });

  app.get('/api/admin/proxy/mihomo/status', async () => {
    const status = await getMihomoStatus();
    const proxy = currentProxy();
    const configured = proxy.mihomo?.routingMode ?? 'rule';
    // The core is the only truth for what it is actually doing: an operator can
    // flip the mode from another client (or the core can fall back), so the
    // console shows the LIVE value when the controller answers and keeps the
    // configured one as the request/edit baseline.
    let live: 'rule' | 'global' | 'direct' | null = null;
    if (status.running) {
      const client = clientOrNull(proxy);
      if (client) {
        try {
          live = await client.routingMode();
        } catch {
          live = null;
        }
      }
    }
    return { status: 'ok', ...status, routingMode: configured, liveRoutingMode: live };
  });

  // Outbound mode (rule / global / direct) — the deliberate kill switch next to
  // "stop the core": direct keeps subscriptions updating and the controller
  // alive while traffic bypasses the tunnel. Persisted for the next start AND
  // hot-applied through PATCH /configs, so no restart rewrites the config file.
  app.post('/api/admin/proxy/mihomo/routing-mode', async (req, reply) => {
    const raw = (req.body as { mode?: unknown } | null)?.mode;
    if (raw !== 'rule' && raw !== 'global' && raw !== 'direct') {
      return reply.status(400).send({ status: 'error', message: 'mode must be rule, global or direct' });
    }
    const proxy = currentProxy();
    const merged = mergeProxyConfig(proxy, { mihomo: { routingMode: raw } });
    const result = persistProxy(merged);
    if (!result.success) return reply.status(400).send({ status: 'error', message: result.error || 'save failed' });
    const client = clientOrNull(merged);
    const running = client ? (await getMihomoStatus()).running : false;
    if (!client || !running) {
      // Saved for the next start; nothing live to patch.
      return { status: 'ok', routingMode: raw, live: false };
    }
    try {
      await client.setRoutingMode(raw);
      return { status: 'ok', routingMode: raw, live: true };
    } catch (err) {
      const message = err instanceof MihomoControllerError ? err.message : String((err as Error)?.message ?? err);
      return { status: 'ok', routingMode: raw, live: false, warning: message };
    }
  });

  app.post('/api/admin/proxy/mihomo/start', async () => opBody(await startMihomoSidecar()));
  app.post('/api/admin/proxy/mihomo/stop', async () => opBody(await stopMihomoSidecar()));
  app.post('/api/admin/proxy/mihomo/restart', async () => opBody(await restartMihomoSidecar()));

  // Streaming install: a release binary is tens of MB, so the console needs a
  // percentage instead of a button that says "downloading…" for a minute.
  // Same NDJSON shape as the README translation: `progress` (bytes) events
  // then exactly one `result` carrying the plain install outcome.
  app.post('/api/admin/proxy/mihomo/install', async (req, reply) => {
    const version = typeof (req.body as { version?: unknown } | null)?.version === 'string'
      ? (req.body as { version: string }).version
      : undefined;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    let closed = false;
    raw.on('close', () => {
      closed = true;
    });
    const send = (evt: Record<string, unknown>) => {
      if (closed) return;
      try {
        raw.write(`${JSON.stringify(evt)}\n`);
      } catch {
        closed = true;
      }
    };
    let lastSent = 0;
    try {
      const result = await installMihomoBinary({
        version,
        // Coalesce byte ticks: one event per 100ms is plenty for a progress bar
        // and keeps a fast link from flooding the socket.
        onProgress: (downloaded, total) => {
          const now = Date.now();
          if (now - lastSent < 100 && downloaded !== total) return;
          lastSent = now;
          send({ type: 'progress', downloaded, total });
        },
      });
      send({ type: 'result', status: result.ok ? 'ok' : 'error', ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({ type: 'result', status: 'error', ok: false, code: 'install-failed', error: message });
    }
    raw.end();
  });

  // The rule table the RUNNING core reports: the console shows what is in
  // effect instead of what the generated config was supposed to say. A dead
  // core has no table — 409 not-running, the same code every other
  // controller-backed action answers with.
  app.get('/api/admin/proxy/mihomo/rules', async (_req, reply) => {
    const client = clientOrNull(currentProxy());
    if (!client) return reply.status(409).send({ status: 'error', code: 'not-running', message: 'mihomo core is not running' });
    try {
      return { status: 'ok', rules: await client.rules() };
    } catch {
      return reply.status(409).send({ status: 'error', code: 'not-running', message: 'mihomo core is not running' });
    }
  });

  // Operator-authored rules. The body is the WHOLE ordered list: this is a rule
  // TABLE, so a patch-style merge would silently reorder or resurrect rows the
  // operator deleted. Sanitizing happens on the config boundary (whitelisted
  // types/targets, no separators in the payload), which is also why the saved
  // list — not the requested one — is echoed back.
  app.put('/api/admin/proxy/mihomo/rules', async (req, reply) => {
    const body = (req.body ?? {}) as { rules?: unknown };
    if (!Array.isArray(body.rules)) {
      return reply.status(400).send({ status: 'error', message: 'rules must be an array' });
    }
    const proxy = currentProxy();
    const merged = mergeProxyConfig(proxy, { mihomo: { rules: body.rules as MihomoCustomRule[] } });
    const result = persistProxy(merged);
    if (!result.success) return reply.status(400).send({ status: 'error', message: result.error || 'save failed' });
    const sidecar = await reconcileMihomoSidecar();
    return { status: 'ok', rules: merged.mihomo?.rules ?? [], sidecar: opBody(sidecar) };
  });

  // Import a subscription's own `rules:` as a DRAFT (nothing is saved here).
  // The console merges the rows into its editable list, so the operator reviews
  // and commits them through the PUT above — an import must never move traffic
  // on its own. Flattening rules live in mihomo-rules-import.ts; this route only
  // resolves the source and returns the counts to report.
  app.post('/api/admin/proxy/mihomo/rules/import', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const mapUnknownTarget = body.mapUnknownTarget !== false;
    let text: string;
    /** Where the imported document came from — the console says so out loud. */
    let fromCache = false;
    /** Subscription name used as the provenance label on imported rows. */
    let subscriptionName = '';
    if (body.source === 'text') {
      if (typeof body.text !== 'string' || !body.text.trim()) {
        return reply.status(400).send({ status: 'error', message: 'text is required' });
      }
      text = body.text;
    } else {
      const id = typeof body.subscriptionId === 'string' ? body.subscriptionId : '';
      const subscription = (currentProxy().mihomo?.subscriptions ?? []).find((item) => item.id === id);
      if (!subscription) {
        return reply.status(404).send({ status: 'error', message: 'subscription not found' });
      }
      subscriptionName = subscription.name.trim();
      // Prefer the core's own provider cache: it is the document the running
      // config actually uses, it works offline, and it is the only source when
      // this runtime rejects the airport's TLS chain.
      const cached = await readCachedProviderYaml(mihomoWorkDir(), id);
      if (cached) {
        text = cached;
        fromCache = true;
      } else {
        try {
          // The URL may carry a token: neither it nor the body is logged or echoed.
          text = await fetchSubscriptionYaml(subscription.url);
        } catch (err) {
          return reply.status(502).send({
            status: 'error',
            code: 'import-failed',
            message: err instanceof Error ? err.message : 'subscription fetch failed',
          });
        }
      }
    }
    return {
      status: 'ok',
      source: body.source === 'text' ? 'text' : fromCache ? 'cache' : 'network',
      // Provenance is stamped at import time so a later batch cleanup can name
      // where a rule came from without asking the operator.
      ...importRulesFromYaml(text, {
        mapUnknownTarget,
        sourceLabel: body.source === 'text' ? 'paste' : (subscriptionName || 'subscription'),
      }),
    };
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
    if (!client) return reply.status(409).send({ status: 'error', code: 'not-running', message: 'mihomo core is not running' });
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
    if (!client) return reply.status(409).send({ status: 'error', code: 'not-running', message: 'mihomo core is not running' });
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
  // Probe an UNSAVED node: the core can only delay-test config members, so the
  // dialog's Test button checks what is knowable before saving — DNS + TCP
  // reachability on the node's server:port. The socket is a DIRECT connect
  // (`node:net` never consults HTTP_PROXY/HTTPS_PROXY or the gateway's forward
  // proxy), so the result describes this host → node, not our own proxy chain.
  // It never claims credentials or the tunnel work.
  app.post('/api/admin/proxy/mihomo/nodes/test', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    let server = typeof body.server === 'string' ? body.server.trim() : '';
    let port = typeof body.port === 'number' ? body.port : Number(body.port);
    if (typeof body.yaml === 'string') {
      const drafts = parseNodeYamlBatch(body.yaml);
      if (!drafts || drafts.length !== 1) {
        return reply.status(400).send({ status: 'error', message: 'invalid YAML: expected exactly one proxy mapping' });
      }
      server = typeof drafts[0].server === 'string' ? drafts[0].server.trim() : '';
      const rawPort = typeof drafts[0].port === 'string' ? Number(drafts[0].port) : drafts[0].port;
      port = typeof rawPort === 'number' ? rawPort : Number.NaN;
    }
    if (!server || server.length > 253 || /\s/.test(server) || !Number.isInteger(port) || port < 1 || port > 65535) {
      return reply.status(400).send({ status: 'error', message: 'a server and port are required' });
    }
    const started = Date.now();
    // `Promise.withResolvers` is outside the backend's TS lib target; the
    // executor form is the supported equivalent here.
    return await new Promise<Record<string, unknown>>((resolve) => {
      let settled = false;
      const socket = net.connect({ host: server, port });
      const finish = (reachable: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ status: 'ok', reachable, ms: Date.now() - started, ...(error ? { error } : {}) });
      };
      socket.setTimeout(MIHOMO_NODE_PROBE_TIMEOUT_MS, () => finish(false, 'timeout'));
      socket.once('connect', () => finish(true));
      socket.once('error', (err: NodeJS.ErrnoException) => finish(false, err.code || 'error'));
    });
  });

  // Config rows + the form projection of a YAML-authored mapping. The console
  // edits nodes through the form, so it needs the modeled fields the stored
  // YAML carries; parsing happens here, next to the renderer, not in the UI.
  app.get('/api/admin/proxy/mihomo/nodes', async () => {
    const baseKeys = new Set<string>(['name', 'type', 'server', 'port', ...MANUAL_NODE_FORM_KEYS]);
    const nodes = (currentProxy().mihomo?.manualNodes ?? []).map((node) => {
      if (!node.yaml) return node;
      try {
        const mapping = parse(node.yaml);
        if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return node;
        const record = mapping as Record<string, unknown>;
        // Keys the form cannot edit stay in YAML; name them so the console can
        // say "N more keys" instead of silently hiding them.
        const unmodeled = Object.keys(record).filter(key => !baseKeys.has(key));
        return { ...node, fields: manualNodeFields(record), unmodeled };
      } catch {
        return node;
      }
    });
    return { status: 'ok', nodes };
  });

  /** Protocols, per-protocol fields and enum whitelists — the console renders
   *  its controls from this, so it never re-declares a backend whitelist. */
  app.get('/api/admin/proxy/mihomo/nodes/catalog', async () => ({ status: 'ok', ...manualNodeCatalog() }));

  // Hand-authored nodes (ADR-0022). They need no subscription and no fetch:
  // the row is written into the generated `proxies:` block and joins the same
  // group a provider member does. Mutations save + reconcile, exactly like a
  // subscription edit — proxies live in the generated file, so a running core
  // must reload to see the change.
  app.post('/api/admin/proxy/mihomo/nodes', async (req, reply) => {
    const proxy = currentProxy();
    const list = proxy.mihomo?.manualNodes ?? [];
    const group = proxy.mihomo?.selectedGroup || DEFAULT_MIHOMO_GROUP;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const additions: MihomoManualNode[] = [];
    if (typeof body.yaml === 'string' && body.yaml.trim()) {
      // A paste may carry a whole profile fragment; every row is validated and
      // the batch is all-or-nothing, so a typo in row 4 never leaves rows 1-3
      // half-saved.
      const drafts = parseNodeYamlBatch(body.yaml);
      if (!drafts || drafts.length === 0) {
        return reply.status(400).send({ status: 'error', message: 'invalid YAML: expected one or more proxy mappings' });
      }
      if (drafts.length > 50) {
        return reply.status(400).send({ status: 'error', message: 'too many nodes in one paste (max 50)' });
      }
      for (const draft of drafts) {
        const node = sanitizeNodeYamlDraft(draft, crypto.randomBytes(6).toString('hex'));
        if (!node) {
          const label = typeof draft.name === 'string' && draft.name.trim() ? ` "${draft.name.trim()}"` : '';
          return reply.status(400).send({ status: 'error', message: `invalid proxy mapping${label}: name, type, server and port are required` });
        }
        const conflict = nodeNameConflict(node.name, group, [...list, ...additions]);
        if (conflict) return reply.status(400).send({ status: 'error', message: conflict });
        additions.push(node);
      }
    } else {
      const typed = sanitizeNodeDraft(body, crypto.randomBytes(6).toString('hex'));
      if (!typed.node) {
        return reply.status(400).send({
          status: 'error', code: 'invalid-node-field', field: typed.errorField, message: manualNodeFailure(),
        });
      }
      const node = typed.node;
      const conflict = nodeNameConflict(node.name, group, list);
      if (conflict) return reply.status(400).send({ status: 'error', message: conflict });
      additions.push(node);
    }
    const merged = mergeProxyConfig(proxy, { mihomo: { manualNodes: [...list, ...additions] } });
    const saved = additions
      .map((node) => merged.mihomo?.manualNodes?.find((item) => item.id === node.id))
      .filter((node): node is MihomoManualNode => Boolean(node));
    if (saved.length !== additions.length) {
      return reply.status(400).send({ status: 'error', message: manualNodeFailure() });
    }
    const result = persistProxy(merged);
    if (!result.success) return reply.status(400).send({ status: 'error', message: result.error || 'save failed' });
    const sidecar = await reconcileMihomoSidecar();
    return { status: 'ok', node: saved[0], nodes: saved, sidecar: opBody(sidecar) };
  });

  app.put('/api/admin/proxy/mihomo/nodes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const proxy = currentProxy();
    const list = proxy.mihomo?.manualNodes ?? [];
    const existing = list.find((item) => item.id === id);
    if (!existing) return reply.status(404).send({ status: 'error', message: 'node not found' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    let node: MihomoManualNode | null;
    if (typeof body.yaml === 'string' && body.yaml.trim()) {
      const drafts = parseNodeYamlBatch(body.yaml as string);
      node = drafts && drafts.length === 1 ? sanitizeNodeYamlDraft(drafts[0], id) : null;
    } else if (existing.yaml) {
      // A form save on a YAML-authored row: the key list the form owns is
      // replaced (or removed, so clearing a field really clears it), every
      // other key in the operator's mapping stays untouched. Changing the
      // protocol still needs the YAML tab — the mapping shape is per-protocol.
      if (typeof body.type === 'string' && body.type !== existing.type) {
        return reply.status(400).send({ status: 'error', message: 'edit a YAML node in the YAML tab to change its protocol' });
      }
      let mapping: unknown;
      try {
        mapping = parse(existing.yaml);
      } catch {
        mapping = null;
      }
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
        return reply.status(400).send({ status: 'error', message: 'stored YAML mapping is invalid' });
      }
      if (!isManualNodeProtocol(existing.type)) {
        // Unsupported protocol (tuic, wireguard, …): the form only knows the
        // identity fields, so overlay those and leave the mapping's options.
        const next = { ...(mapping as Record<string, unknown>) };
        if (typeof body.name === 'string' && body.name.trim()) next.name = body.name.trim();
        if (typeof body.server === 'string' && body.server.trim()) next.server = body.server.trim();
        const rawPort = typeof body.port === 'number' ? body.port : Number(body.port);
        if (Number.isFinite(rawPort) && rawPort > 0) next.port = rawPort;
        node = sanitizeNodeYamlDraft(next, id);
      } else {
        const typed = sanitizeNodeDraft({ ...existing, ...body, yaml: undefined }, id);
        if (!typed.node) {
          return reply.status(400).send({
            status: 'error', code: 'invalid-node-field', field: typed.errorField, message: manualNodeFailure(),
          });
        }
        const formKeys = manualNodeMapping(typed.node);
        const next: Record<string, unknown> = { ...(mapping as Record<string, unknown>), ...formKeys };
        for (const key of MANUAL_NODE_FORM_KEYS) {
          if (!(key in formKeys)) delete next[key];
        }
        node = sanitizeNodeYamlDraft(next, id);
      }
    } else {
      const typed = sanitizeNodeDraft({ ...existing, ...body }, id);
      if (!typed.node) {
        return reply.status(400).send({
          status: 'error', code: 'invalid-node-field', field: typed.errorField, message: manualNodeFailure(),
        });
      }
      node = typed.node;
    }
    if (!node) {
      return reply.status(400).send({ status: 'error', message: 'invalid YAML: expected exactly one complete proxy mapping' });
    }
    const group = proxy.mihomo?.selectedGroup || DEFAULT_MIHOMO_GROUP;
    const conflict = nodeNameConflict(node.name, group, list.filter((item) => item.id !== id));
    if (conflict) return reply.status(400).send({ status: 'error', message: conflict });
    const merged = mergeProxyConfig(proxy, {
      mihomo: { manualNodes: list.map((item) => (item.id === id ? node : item)) },
    });
    const saved = merged.mihomo?.manualNodes?.find((item) => item.id === id);
    if (!saved) return reply.status(400).send({ status: 'error', message: manualNodeFailure() });
    const result = persistProxy(merged);
    if (!result.success) return reply.status(400).send({ status: 'error', message: result.error || 'save failed' });
    const sidecar = await reconcileMihomoSidecar();
    return { status: 'ok', node: saved, nodes: [saved], sidecar: opBody(sidecar) };
  });

  app.delete('/api/admin/proxy/mihomo/nodes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const proxy = currentProxy();
    const list = proxy.mihomo?.manualNodes ?? [];
    const removed = list.find((item) => item.id === id);
    if (!removed) {
      return reply.status(404).send({ status: 'error', message: 'node not found' });
    }
    // A selection that points at the deleted row would be replayed on every
    // boot as a name the core cannot resolve; drop it in the same write.
    const selectedNodes = Object.fromEntries(
      Object.entries(proxy.mihomo?.selectedNodes ?? {}).filter(([, name]) => name !== removed.name),
    );
    const merged = mergeProxyConfig(proxy, {
      mihomo: { manualNodes: list.filter((item) => item.id !== id), selectedNodes },
    });
    const result = persistProxy(merged);
    if (!result.success) return reply.status(400).send({ status: 'error', message: result.error || 'save failed' });
    const sidecar = await reconcileMihomoSidecar();
    return { status: 'ok', sidecar: opBody(sidecar) };
  });


  app.get('/api/admin/proxy/mihomo/proxies', async (req) => {
    const proxy = currentProxy();
    // `?group=` answers for the group the operator just picked. Without it the
    // route only ever described the configured group, and a caller that listed
    // another group's members had no type/delay for them (rendered "Unknown").
    const asked = (req.query ?? {}) as { group?: unknown };
    const group = typeof asked.group === 'string' && asked.group.trim()
      ? asked.group.trim()
      : (proxy.mihomo?.selectedGroup || DEFAULT_MIHOMO_GROUP);
    const client = clientOrNull(proxy);
    if (!client) {
      return { status: 'ok', running: false, group, groups: [], nodes: [] };
    }
    try {
      // `/proxies` omits provider-backed nodes (a group's `all` still lists
      // them), so the provider snapshot is required for their type, delay and
      // owning subscription. A controller that refuses it must not break the
      // listing: the group and built-ins still render.
      const [snap, providerIndex] = await Promise.all([
        client.proxies(),
        client.providerIndex().catch((): Record<string, { provider: string; type: string; delay: number | null }> => ({})),
      ]);
      const groups = Object.values(snap.proxies)
        .filter((item) => item.type === 'Selector' || item.type === 'URLTest' || item.type === 'Fallback' || item.type === 'LoadBalance')
        .map((item) => ({ name: item.name, type: item.type, now: item.now ?? '', all: item.all ?? [] }));
      // mihomo's provider key is our subscription id — the operator typed a
      // NAME for it, so the console must not show the id as the filter label.
      const nameById = new Map((proxy.mihomo?.subscriptions ?? []).map((sub) => [sub.id, sub.name || sub.id]));
      // A manual node is identified by its config id, not by its display name:
      // the console uses the id to edit/delete the row without re-deriving it.
      const manualIdByName = new Map((proxy.mihomo?.manualNodes ?? []).map((node) => [node.name, node.id]));
      const active = snap.proxies[group];
      const names = active?.all ?? [];
      const nodes = names.map((name) => {
        const node = snap.proxies[name];
        const fromProvider = providerIndex[name];
        // Attribute a node to a subscription ONLY when that provider is one we
        // declared. mihomo also exposes built-in providers (`default` holds
        // DIRECT/REJECT/PASS) whose id is not an operator-visible name — the
        // console must never print one as a filter label.
        const providerId = fromProvider && nameById.has(fromProvider.provider) ? fromProvider.provider : null;
        const manualId = manualIdByName.get(name) ?? null;
        // ONE origin per row, in both directions: a manual node is ours even
        // when the controller also lists it in some provider snapshot, and a
        // provider node is attributed only to a declared subscription (mihomo's
        // `default` provider holds built-ins whose id is not a label).
        const source = manualId
          ? { kind: 'manual' as const, id: manualId }
          : providerId
            ? { kind: 'subscription' as const, id: providerId }
            : { kind: 'builtin' as const, id: null };
        return {
          name,
          // Prefer the live snapshot, fall back to the provider record: a
          // provider node has no /proxies entry at all.
          type: node?.type || fromProvider?.type || 'Unknown',
          delay: node?.delay ?? fromProvider?.delay ?? null,
          selected: active?.now === name,
          manualId,
          source,
        };
      });
      // The live group's kind decides whether the console may pick a node at
      // all: mihomo owns the choice under url-test/fallback.
      const groupType: MihomoGroupType = active?.type === 'URLTest'
        ? 'url-test'
        : active?.type === 'Fallback' ? 'fallback' : 'select';
      return { status: 'ok', running: true, group, groupType, now: active?.now ?? null, groups, nodes };
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
    if (!client) return reply.status(409).send({ status: 'error', code: 'not-running', message: 'mihomo core is not running' });
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
    const body = (req.body ?? {}) as { name?: unknown; group?: unknown; timeoutMs?: unknown; url?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.status(400).send({ status: 'error', message: 'name is required' });
    const proxy = currentProxy();
    const client = clientOrNull(proxy);
    if (!client) return reply.status(409).send({ status: 'error', code: 'not-running', message: 'mihomo core is not running' });
    const timeoutMs = requestedDelayTimeout(body.timeoutMs);
    // The console may send the URL currently typed in the field, so a changed
    // but unsaved test URL is exercised immediately. Invalid input is a 400 —
    // the core would otherwise fetch it and report a confusing test failure.
    const requested = parseRequestTestUrl(body.url);
    if (requested === null) return reply.status(400).send({ status: 'error', message: 'invalid test URL' });
    const testUrl = requested || proxy.mihomo?.testUrl || DEFAULT_MIHOMO_TEST_URL;
    try {
      if (body.group === true) {
        const delays = await client.groupDelay(name, timeoutMs, testUrl);
        return { status: 'ok', group: name, delays };
      }
      const delay = await client.delay(name, timeoutMs, testUrl);
      return { status: 'ok', name, delay };
    } catch (err) {
      return reply.status(502).send(controllerFailure(err));
    }
  });

  // Reachability is not latency. This endpoint answers only "can the
  // configured URL be fetched THROUGH the proxy": mihomo runs its delay test
  // on the group's currently selected node. The add-node dialog's "test
  // connection" is the opposite by design — a direct TCP probe of the node's
  // server:port with no proxy.
  app.post('/api/admin/proxy/mihomo/test-url', async (req, reply) => {
    const proxy = currentProxy();
    const client = clientOrNull(proxy);
    if (!client) return reply.status(409).send({ status: 'error', code: 'not-running', message: 'mihomo core is not running' });
    const body = (req.body ?? {}) as { url?: unknown; group?: unknown; timeoutMs?: unknown };
    const requested = parseRequestTestUrl(body.url);
    if (requested === null) return reply.status(400).send({ status: 'error', message: 'invalid test URL' });
    const url = requested || proxy.mihomo?.testUrl || DEFAULT_MIHOMO_TEST_URL;
    // The console shows the RUNNING core's group; a group edited but not yet
    // applied exists only in config, so the request may name the live one.
    const requestedGroup = typeof body.group === 'string' ? body.group.trim() : '';
    const groupName = requestedGroup || proxy.mihomo?.selectedGroup || DEFAULT_MIHOMO_GROUP;
    let snapshot;
    try {
      snapshot = await client.proxies();
    } catch (err) {
      return reply.status(502).send(controllerFailure(err));
    }
    const groupNode = snapshot.proxies[groupName];
    const node = groupNode?.now || groupNode?.all?.[0];
    if (!node) {
      return reply.status(409).send({ status: 'error', code: 'no-node', message: 'no proxy node is selected' });
    }
    try {
      const ms = await client.delay(node, requestedDelayTimeout(body.timeoutMs), url);
      return { status: 'ok', reachable: true, url, node, ms };
    } catch (err) {
      // Give the console something actionable: a timeout stays a stable code
      // (localized in the UI), everything else carries the controller's own
      // explanation instead of the opaque `controller-error`.
      const failure = err instanceof MihomoControllerError
        ? (err.code === 'delay-missing' || err.code === 'timeout' ? 'timeout' : err.message)
        : 'error';
      return { status: 'ok', reachable: false, url, node, error: failure };
    }
  });
}

function controllerFailure(err: unknown): { status: 'error'; code: string; message: string } {
  if (err instanceof MihomoControllerError) {
    // "Unreachable" IS the down-core case once the secret exists: answer with
    // the code the console localizes (and routes to the core card), never with
    // the transport string. A failed delay test keeps its own codes.
    if (err.code === 'unreachable') {
      return { status: 'error', code: 'not-running', message: 'mihomo core is not running' };
    }
    return { status: 'error', code: err.code, message: err.message };
  }
  return { status: 'error', code: 'controller-error', message: 'mihomo controller request failed' };
}

/** Delay-test budget from the console: absent = the shared default, and the
 *  clamp keeps one bad value from pinning a row in the table for a minute. */
function requestedDelayTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, 20_000)
    : MIHOMO_DELAY_TIMEOUT_MS;
}

/** Re-export so a log site that only has a URL can redact it without importing the generator. */
export { redactSubscriptionUrl };

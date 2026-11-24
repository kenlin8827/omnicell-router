import { ProxyConfig } from '../config/types.js';
import { globMatch } from './glob.js';
import { nodeProxiedFetch } from './proxy-node.js';

/**
 * Outbound proxy resolution for upstream HTTP calls.
 *
 * Config comes from config.yaml `proxy:` (snapshot via initProxyConfig at gateway
 * startup — config has no hot reload). Resolution order for a target URL:
 *   1. Loopback targets (localhost / 127.0.0.1 / ::1) are NEVER proxied, so local
 *      services (OpenCode, Ollama) keep working even with a global proxy set.
 *   2. excludes — a matching provider/model forces direct.
 *   3. includes — the ALLOWLIST: only a matching provider/model is proxied. An
 *      empty (or absent) list proxies NOTHING — no rule configured means no
 *      outbound proxy (ADR-0022 amendment 2026-12).
 *   4. undefined — direct; Bun fetch then still honors HTTP_PROXY/HTTPS_PROXY/NO_PROXY.
 *
 * List patterns match BOTH the composite `provider/modelId` and the bare model id,
 * so one syntax covers both levels: `providerName/asterisk` (slash-star) selects
 * every model of a provider; a leading star-slash prefix scopes a model pattern
 * to any provider; a bare `claude-*` matches the model id (no wildcard = substring). Calls without a match target (catalog/logo sync) are
 * unlisted: a call with no match target is never proxied, because the empty
 * includes list is direct.
 *
 * proxiedFetch passes the resolved proxy via Bun's fetch `proxy` option
 * (verified on bun 1.3.14). Node's fetch ignores that option, so the Node
 * path opens the proxy itself (absolute-form HTTP, CONNECT for HTTPS) —
 * see utils/proxy-node.ts. In `mihomo` mode the endpoint is the local
 * mixed-port; loopback targets, including the controller, stay direct.
 */

let activeConfig: ProxyConfig | undefined;

/** Snapshot the proxy config (call once at startup, after loadConfig). */
export function initProxyConfig(config: ProxyConfig | undefined): void {
  activeConfig = config;
}

/** True for loopback hosts — local services are never routed through a proxy. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '::1' ||
      host === '[::1]' ||
      /^127\.\d+\.\d+\.\d+$/.test(host) ||
      host === '0.0.0.0'
    );
  } catch {
    return false;
  }
}

/**
 * A pattern hits when it matches `provider/modelId`, the bare provider, the bare
 * model id, or — for a call that has no model at all — the provider's own
 * `provider/` prefix.
 *
 * That last target exists because a model-LESS call (a quota read, a catalog
 * pull, a sign-in exchange) would otherwise be unreachable by the natural way
 * to write "everything under this provider": `qoder/*` requires a model
 * segment, so it silently matched inference ONLY and left the same provider's
 * quota traffic direct. Offering `provider/` (which `provider/*` matches, `*`
 * being allowed to match the empty string) makes one pattern cover the whole
 * provider. A model-scoped pattern like `workbuddy/gpt-*` still does NOT hit a
 * model-less call — there is no model to test, and guessing one would be wrong.
 */
function patternHits(pattern: string, match?: { provider?: string; model?: string }): boolean {
  if (!match) return false;
  const targets: string[] = [];
  if (match.model) targets.push(match.model);
  if (match.provider && match.model) targets.push(`${match.provider}/${match.model}`);
  else if (match.provider) {
    targets.push(match.provider);
    targets.push(`${match.provider}/`);
  }
  return targets.some((t) => globMatch(pattern, t));
}

let warnedInvalidProxyUrl = false;

/** True when this process's fetch understands the Bun `proxy` option. */
export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

/**
 * The endpoint `proxy.enabled` actually dials, with no include/exclude gate.
 * `manual` uses `proxy.url`. `mihomo` uses the loopback mixed-port (ADR-0022)
 * and ignores `proxy.url`.
 */
function globalProxyUrl(): string | undefined {
  const cfg = activeConfig;
  if (cfg?.mode === 'mihomo') {
    const port = cfg.mihomo?.mixedPort;
    const controller = cfg.mihomo?.controllerPort;
    if (!Number.isInteger(port) || port! < 1 || port! > 65535 || port === controller) return undefined;
    return `http://127.0.0.1:${port}`;
  }
  const url = (cfg?.url || '').trim();
  if (!url) return undefined;
  // Fail-safe: an unparseable / non-http(s) proxy URL would break every upstream
  // call at fetch time — warn once and fall back to direct instead.
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
  } catch {
    if (!warnedInvalidProxyUrl) {
      console.warn(`[Proxy] Invalid proxy.url "${url}" — expected http(s)://[user:pass@]host:port; ignoring proxy (direct).`);
      warnedInvalidProxyUrl = true;
    }
    return undefined;
  }
  return url;
}

/**
 * The outbound proxy URL with NO provider/model gating — `proxy.enabled` +
 * `proxy.url`, nothing else.
 *
 * `resolveProxyUrl` answers "which proxy for THIS provider/model" (includes /
 * excludes). Callers that already decided the egress themselves — the
 * forward-proxy transit legs after the egress table (ADR-0018) — must not be
 * re-gated by a list that was never about hosts.
 */
export function outboundProxyUrl(): string | undefined {
  const cfg = activeConfig;
  if (!cfg || cfg.enabled !== true) return undefined;
  return globalProxyUrl();
}

/**
 * Resolve the proxy URL for a target. `match` identifies the logical caller
 * ({ provider, model }) for list evaluation; omit it for unlisted infra calls.
 * Returns undefined for direct connections.
 */
export function resolveProxyUrl(
  targetUrl: string,
  match?: { provider?: string; model?: string }
): string | undefined {
  const cfg = activeConfig;
  if (!cfg || cfg.enabled !== true) return undefined; // opt-in: off unless explicitly enabled
  if (isLoopbackUrl(targetUrl)) return undefined;

  if (cfg.excludes?.length && cfg.excludes.some((p) => patternHits(p, match))) return undefined;
  if (!cfg.includes?.length || !match) return undefined;
  return cfg.includes.some((p) => patternHits(p, match)) ? globalProxyUrl() : undefined;
}

/**
 * Redact a proxy URL to its origin (`scheme://host:port`). Proxy URLs may
 * embed credentials (`http://user:pass@host:8080`) — capture must never
 * persist userinfo, and the origin is all you need to debug "which proxy
 * did this request take".
 */
export function redactProxyUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid-proxy-url';
  }
}

/** fetch wrapper honoring proxy.url + includes/excludes matching. */
export async function proxiedFetch(
  url: string,
  init: RequestInit = {},
  match?: { provider?: string; model?: string }
): Promise<Response> {
  const proxy = resolveProxyUrl(url, match);
  if (!proxy) return fetch(url, init);
  return fetchViaProxy(url, init, proxy);
}

/**
 * fetch through an EXPLICIT proxy endpoint, bypassing the `proxy.enabled` /
 * include-exclude policy. Callers that already decided the egress themselves
 * (the geo download legs, ADR-0022) name the endpoint they mean. Bun honors
 * the `proxy` option; Node's fetch cannot, so the request opens the proxy.
 */
export async function fetchViaProxy(url: string, init: RequestInit, proxy: string): Promise<Response> {
  if (isBunRuntime()) {
    return fetch(url, { ...init, proxy } as RequestInit & { proxy: string });
  }
  return nodeProxiedFetch(url, init, proxy);
}

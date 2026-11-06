import { ProxyConfig } from '../config/types.js';
import { globMatch } from './glob.js';

/**
 * Outbound proxy resolution for upstream HTTP calls.
 *
 * Config comes from config.yaml `proxy:` (snapshot via initProxyConfig at gateway
 * startup — config has no hot reload). Resolution order for a target URL:
 *   1. Loopback targets (localhost / 127.0.0.1 / ::1) are NEVER proxied, so local
 *      services (OpenCode, Ollama) keep working even with a global proxy set.
 *   2. excludes — a matching provider/model forces direct.
 *   3. includes — when non-empty, ONLY matching provider/models go through the proxy.
 *   4. proxy.url — global default (skipped when empty).
 *   5. undefined — direct; Bun fetch then still honors HTTP_PROXY/HTTPS_PROXY/NO_PROXY.
 *
 * List patterns match BOTH the composite `provider/modelId` and the bare model id,
 * so one syntax covers both levels: `providerName/asterisk` (slash-star) selects
 * every model of a provider; a leading star-slash prefix scopes a model pattern
 * to any provider; a bare `claude-*` matches the model id (no wildcard = substring). Calls without a match target (catalog/logo sync) are
 * unlisted: a non-empty includes list sends them direct, otherwise proxy.url applies.
 *
 * proxiedFetch passes the resolved proxy via Bun's fetch `proxy` option
 * (verified on bun 1.3.14); under Node the option is simply ignored and the
 * call behaves like plain fetch.
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

/** A pattern hits when it matches `provider/modelId`, the bare provider, or the bare model id. */
function patternHits(pattern: string, match?: { provider?: string; model?: string }): boolean {
  if (!match) return false;
  const targets: string[] = [];
  if (match.model) targets.push(match.model);
  if (match.provider && match.model) targets.push(`${match.provider}/${match.model}`);
  else if (match.provider) targets.push(match.provider);
  return targets.some((t) => globMatch(pattern, t));
}

let warnedInvalidProxyUrl = false;

function globalProxyUrl(): string | undefined {
  const url = (activeConfig?.url || '').trim();
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
  if (cfg.includes?.length) {
    return cfg.includes.some((p) => patternHits(p, match)) ? globalProxyUrl() : undefined;
  }

  return globalProxyUrl();
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
  return proxy ? fetch(url, { ...init, proxy } as RequestInit & { proxy: string }) : fetch(url, init);
}

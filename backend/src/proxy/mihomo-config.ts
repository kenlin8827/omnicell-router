/**
 * Generated mihomo (Clash Meta) config (ADR-0022).
 *
 * The file is the sidecar's runtime config, not the gateway's config.yaml.
 * Subscription URLs and the controller secret belong in that file — mihomo
 * cannot fetch a provider or authenticate its controller without them — and
 * must not be copied into logs. `mihomoConfigSummary` is the only string
 * that is safe to log.
 */
import { stringify } from 'yaml';
import {
  DEFAULT_MIHOMO_GROUP,
  DEFAULT_MIHOMO_SUB_INTERVAL_SEC,
} from '../config/defaults.js';
import type { MihomoSubscription } from '../config/types.js';

/** Delay-test URL mihomo and the console share. A 204 endpoint, no body. */
export const MIHOMO_DELAY_TEST_URL = 'https://www.gstatic.com/generate_204';

export interface RenderMihomoInput {
  mixedPort: number;
  controllerPort: number;
  /** Required. Written into the file, never into a log line. */
  secret: string;
  group?: string;
  subscriptions?: MihomoSubscription[];
}

export interface RenderedMihomoConfig {
  yaml: string;
  group: string;
  providerNames: string[];
}

/** Origin + path only. Query tokens and userinfo are dropped. */
export function redactSubscriptionUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'invalid-subscription-url';
  }
}

/**
 * One-line description safe for logs and the boot banner. Contains ports,
 * the group name and the provider count — never the secret or a subscription URL.
 */
export function mihomoConfigSummary(rendered: RenderedMihomoConfig, ports: { mixedPort: number; controllerPort: number }): string {
  return `mixed=${ports.mixedPort} controller=${ports.controllerPort} group=${rendered.group} providers=${rendered.providerNames.length} secret=set`;
}

export function renderMihomoConfig(input: RenderMihomoInput): RenderedMihomoConfig {
  if (!input.secret) throw new Error('mihomo controller secret is required');
  if (input.mixedPort === input.controllerPort) {
    throw new Error('mihomo mixedPort and controllerPort must differ');
  }
  const group = input.group && input.group.trim() ? input.group.trim() : DEFAULT_MIHOMO_GROUP;
  const providers: Record<string, unknown> = {};
  const use: string[] = [];
  for (const sub of input.subscriptions ?? []) {
    if (sub.enabled === false) continue;
    providers[sub.id] = {
      type: 'http',
      url: sub.url,
      interval: sub.interval ?? DEFAULT_MIHOMO_SUB_INTERVAL_SEC,
      path: `./providers/${sub.id}.yaml`,
      'health-check': { enable: false, url: MIHOMO_DELAY_TEST_URL, interval: 300 },
    };
    use.push(sub.id);
  }
  const doc: Record<string, unknown> = {
    'mixed-port': input.mixedPort,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    mode: 'rule',
    'log-level': 'warning',
    ipv6: false,
    'external-controller': `127.0.0.1:${input.controllerPort}`,
    secret: input.secret,
    'unified-delay': true,
    profile: { 'store-selected': true },
    'proxy-groups': [
      {
        name: group,
        type: 'select',
        ...(use.length ? { use } : {}),
        proxies: ['DIRECT'],
      },
    ],
    rules: [`MATCH,${group}`],
  };
  if (use.length) doc['proxy-providers'] = providers;
  return { yaml: stringify(doc), group, providerNames: use };
}

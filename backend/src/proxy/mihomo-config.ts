/**
 * Generated mihomo (Clash Meta) config (ADR-0022).
 *
 * The file is the sidecar's runtime config, not the gateway's config.yaml.
 * Subscription URLs and the controller secret belong in that file — mihomo
 * cannot fetch a provider or authenticate its controller without them — and
 * must not be copied into logs. `mihomoConfigSummary` is the only string
 * that is safe to log.
 */
import { parse, stringify } from 'yaml';
import {
  DEFAULT_MIHOMO_GROUP,
  DEFAULT_MIHOMO_GROUP_INTERVAL_SEC,
  DEFAULT_MIHOMO_GROUP_TOLERANCE_MS,
  DEFAULT_MIHOMO_SUB_INTERVAL_SEC,
  DEFAULT_MIHOMO_TEST_URL,
  MIHOMO_GROUP_INTERVAL_MAX_SEC,
  MIHOMO_GROUP_INTERVAL_MIN_SEC,
} from '../config/defaults.js';
import type { MihomoCustomRule, MihomoGroupType, MihomoManualNode, MihomoSubscription } from '../config/types.js';
import { manualNodeMapping } from './manual-node-spec.js';

// The field table in `manual-node-spec` owns both directions; these names stay
// re-exported here because the generated-config module is where callers look.
export { MANUAL_NODE_FORM_KEYS, manualNodeFields, manualNodeMapping } from './manual-node-spec.js';

export interface RenderMihomoInput {
  mixedPort: number;
  /** mihomo outbound mode; omitted = 'rule'. */
  routingMode?: 'rule' | 'global' | 'direct';
  controllerPort: number;
  /** Required. Written into the file, never into a log line. */
  secret: string;
  group?: string;
  /** Group picker mode; omitted = 'select' (the console's manual picker). */
  groupType?: MihomoGroupType;
  /** Delay-test cadence (seconds) for automatic groups; omitted = 300. */
  groupInterval?: number;
  /** `url-test` tolerance (ms); omitted = 50. */
  groupTolerance?: number;
  /** Health-check / delay-test URL; omitted = the factory default. */
  testUrl?: string;
  subscriptions?: MihomoSubscription[];
  /** Hand-authored nodes, rendered into `proxies:` and added to the group. */
  manualNodes?: MihomoManualNode[];
  /** Operator-authored rules, rendered before the final MATCH. */
  rules?: MihomoCustomRule[];
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

/** A raw pasted mapping is the operator's whole proxy definition: emit it
 *  verbatim (the sanitizer already canonicalized and validated its identity). */
function renderRawProxy(node: MihomoManualNode): Record<string, unknown> | null {
  if (!node.yaml) return null;
  try {
    const parsed = parse(node.yaml);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}


function renderManualProxy(node: MihomoManualNode): Record<string, unknown> {
  return renderRawProxy(node) ?? manualNodeMapping(node);
}

/**
 * Cadence written into the generated group AND its provider health-check. The
 * interval bounds the failure-detection window (a dead member keeps serving
 * traffic until the next cycle), so an explicit value is clamped to the same
 * bounds the loader enforces — a hand-built input must not smuggle 0 s.
 */
function resolveGroupInterval(input: RenderMihomoInput): number {
  const raw = input.groupInterval;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.min(MIHOMO_GROUP_INTERVAL_MAX_SEC, Math.max(MIHOMO_GROUP_INTERVAL_MIN_SEC, Math.round(raw)));
  }
  return DEFAULT_MIHOMO_GROUP_INTERVAL_SEC;
}
/**
 * The one proxy group the gateway generates. `select` keeps `DIRECT` as a
 * manual escape hatch; the automatic modes must NOT — a direct route measures
 * ~0 ms, so `url-test` would pick it every cycle and silently bypass the
 * tunnel, and `fallback` would hand everything to it the moment a node failed.
 * Manual nodes are concrete proxies, so they join every group type.
 */
function renderGroup(
  input: RenderMihomoInput,
  group: string,
  use: string[],
  manualNames: string[],
): Record<string, unknown> {
  const type: MihomoGroupType = input.groupType ?? 'select';
  if (type === 'select') {
    return {
      name: group,
      type: 'select',
      ...(use.length ? { use } : {}),
      proxies: [...manualNames, 'DIRECT'],
    };
  }
  return {
    name: group,
    type,
    ...(use.length ? { use } : {}),
    ...(manualNames.length ? { proxies: manualNames } : {}),
    url: input.testUrl ?? DEFAULT_MIHOMO_TEST_URL,
    interval: resolveGroupInterval(input),
    ...(type === 'url-test' ? { tolerance: input.groupTolerance ?? DEFAULT_MIHOMO_GROUP_TOLERANCE_MS } : {}),
  };
}

/**
 * `TYPE,payload,target` rows, emitted BEFORE the catch-all so they can actually
 * win. `PROXY` is a symbolic target here and becomes the live group name, so
 * renaming the group never orphans a rule. IP rules carry `no-resolve`: without
 * it every IP rule forces mihomo to resolve a candidate hostname first, which
 * both costs a DNS round-trip and lets a resolved IP match a rule that the
 * operator wrote against literal addresses.
 */
function renderCustomRules(input: RenderMihomoInput): string[] {
  const group = input.group || DEFAULT_MIHOMO_GROUP;
  const out: string[] = [];
  for (const rule of input.rules ?? []) {
    const target = rule.target === 'PROXY' ? group : rule.target;
    const noResolve = rule.type === 'IP-CIDR' || rule.type === 'IP-CIDR6' ? ',no-resolve' : '';
    out.push(`${rule.type},${rule.payload},${target}${noResolve}`);
  }
  return out;
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
      // Disabled on purpose: the group's own url-test already walks every
      // member, so a second provider-level probe would only double the test
      // traffic. The cadence still comes from the shared resolver — the old
      // literal 300 was a drift twin of the default constant.
      'health-check': { enable: false, url: input.testUrl ?? DEFAULT_MIHOMO_TEST_URL, interval: resolveGroupInterval(input) },
    };
    use.push(sub.id);
  }
  const manual = input.manualNodes ?? [];
  const proxies = manual.map(renderManualProxy);
  const doc: Record<string, unknown> = {
    'mixed-port': input.mixedPort,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    mode: input.routingMode ?? 'rule',
    'log-level': 'warning',
    ipv6: false,
    'external-controller': `127.0.0.1:${input.controllerPort}`,
    secret: input.secret,
    'unified-delay': true,
    profile: { 'store-selected': true },
    ...(proxies.length ? { proxies } : {}),
    'proxy-groups': [renderGroup(input, group, use, manual.map(node => node.name))],
    rules: [...renderCustomRules(input), `MATCH,${group}`],
  };
  if (use.length) doc['proxy-providers'] = providers;
  return { yaml: stringify(doc), group, providerNames: use };
}

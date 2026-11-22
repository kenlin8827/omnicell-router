/**
 * Subscription rule import (ADR-0022): read a Clash-style `rules:` list and
 * FLATTEN it into operator-editable rows.
 *
 * Deliberately not a live binding. Two things are flattened away, and both are
 * counted so the console can say what was lost:
 *
 * - targets that name the subscription's OWN proxy-groups become `PROXY`, the
 *   gateway's single group. Importing their groups instead would put two
 *   selection sets in one config, and the node picked in the console would then
 *   apply to only half the traffic.
 * - rule types the core cannot evaluate without a geo database or an external
 *   rule-set fetch (GEOIP / GEOSITE / RULE-SET / logical rules) are dropped.
 *   Shipping them changes egress silently when the data is missing — the one
 *   failure mode an operator cannot see from the console.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { MIHOMO_CUSTOM_RULES_MAX, MIHOMO_CUSTOM_RULE_TYPES } from '../config/index.js';
import type { MihomoCustomRule, MihomoRuleType } from '../config/types.js';

/** Everything that could not be imported, keyed by why it could not. */
export interface RuleImportSkip {
  /** `GEOIP`, `GEOSITE`, `RULE-SET`, `MATCH`, `LOGICAL`, `unknown-target`, `limit` … */
  reason: string;
  count: number;
}

export interface RuleImportResult {
  rules: MihomoCustomRule[];
  skipped: RuleImportSkip[];
  /** Rules the source declared, before filtering. */
  total: number;
  /** Rows whose target named a subscription group and became `PROXY`. */
  mappedToProxy: number;
}

const DIRECT_OR_REJECT = new Set(['DIRECT', 'REJECT']);
const TYPE_SET = new Set<string>(MIHOMO_CUSTOM_RULE_TYPES);
/** Types that exist in Clash but need data this deployment does not carry. */
const UNSUPPORTED_HINT: Record<string, string> = {
  GEOIP: 'GEOIP',
  GEOSITE: 'GEOSITE',
  'SRC-GEOIP': 'GEOIP',
  'SRC-GEOSITE': 'GEOSITE',
  'IP-ASN': 'IP-ASN',
  'RULE-SET': 'RULE-SET',
  'SRC-IP-CIDR': 'SRC-IP-CIDR',
  'SRC-IP-CIDR6': 'SRC-IP-CIDR',
};

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) if (typeof item === 'string') out.push(item);
  return out;
}

/**
 * Parse a subscription document and flatten its rule list.
 *
 * `mapUnknownTarget` decides what happens to a rule whose target is neither
 * `DIRECT`/`REJECT` nor one of the subscription's own groups (a typo, or a
 * built-in like `GLOBAL`): `true` maps it to `PROXY`, `false` drops it. Either
 * way the count is reported instead of guessed at.
 */
export function importRulesFromYaml(
  text: string,
  options: { mapUnknownTarget?: boolean; sourceLabel?: string } = {},
): RuleImportResult {
  const mapUnknownTarget = options.mapUnknownTarget !== false;
  const sourceLabel = (options.sourceLabel ?? '').trim().slice(0, 40);
  const skipped = new Map<string, number>();
  const rules: MihomoCustomRule[] = [];
  const seen = new Set<string>();
  let mappedToProxy = 0;

  let doc: any = null;
  try {
    doc = parse(text);
  } catch {
    return { rules, skipped: [{ reason: 'unparsable', count: 1 }], total: 0, mappedToProxy };
  }

  const declared = asStringArray(doc?.rules);
  const groupNames = new Set<string>();
  if (Array.isArray(doc?.['proxy-groups'])) {
    for (const group of doc['proxy-groups']) {
      if (group && typeof group.name === 'string') groupNames.add(group.name);
    }
  }

  for (const line of declared) {
    const parts = line.split(',').map(part => part.trim());
    const type = (parts[0] || '').toUpperCase();
    // `AND` / `OR` / `NOT` / `SUB-RULE` / `MATCH` carry nested or empty payloads
    // the flat row model cannot express.
    if (type === 'MATCH' || type === 'AND' || type === 'OR' || type === 'NOT' || type === 'SUB-RULE') {
      bump(skipped, 'LOGICAL');
      continue;
    }
    if (!TYPE_SET.has(type)) {
      bump(skipped, UNSUPPORTED_HINT[type] ?? type);
      continue;
    }
    const payload = parts[1] || '';
    if (!payload) {
      bump(skipped, type);
      continue;
    }
    // The row is written verbatim as `TYPE,payload,target`: a payload carrying a
    // separator would splice extra fields into the generated document.
    if (payload.includes(',') || payload.includes('\n') || payload.includes('\r')) {
      bump(skipped, type);
      continue;
    }

    // The only 4th field the flat model can honour is `no-resolve` on IP rules.
    // Anything else means the source row carries more semantics than these rows
    // can express (`DOMAIN,bad,payload,DIRECT` would otherwise import as payload
    // `bad` targeting a group named `payload`), so the row is dropped rather
    // than half-imported.
    const options = parts.slice(3).filter(Boolean);
    if (options.length > 1 || (options.length === 1 && options[0].toLowerCase() !== 'no-resolve')) {
      bump(skipped, type);
      continue;
    }

    const rawTarget = parts[2] || '';
    const upper = rawTarget.toUpperCase();
    let target: MihomoCustomRule['target'];
    if (DIRECT_OR_REJECT.has(upper)) {
      target = upper as MihomoCustomRule['target'];
    } else if (groupNames.has(rawTarget)) {
      target = 'PROXY';
      mappedToProxy += 1;
    } else if (mapUnknownTarget) {
      target = 'PROXY';
      mappedToProxy += 1;
    } else {
      bump(skipped, 'unknown-target');
      continue;
    }

    const key = `${type}\u0000${payload}\u0000${target}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (rules.length >= MIHOMO_CUSTOM_RULES_MAX) {
      bump(skipped, 'limit');
      continue;
    }
    rules.push({ type: type as MihomoRuleType, payload, target, ...(sourceLabel ? { source: sourceLabel } : null) });
  }

  return {
    rules,
    skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
    total: declared.length,
    mappedToProxy,
  };
}

/** Cap for a subscription document: a rule list this large is a dump, not a profile. */
const MAX_SUBSCRIPTION_BYTES = 8 * 1024 * 1024;

/**
 * Fetch a subscription document. The URL may carry a token, so nothing here
 * logs it, echoes it, or includes it in an error message.
 */
export async function fetchSubscriptionYaml(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<string> {
  const res = await fetchImpl(url, {
    headers: { accept: 'text/yaml, text/plain, */*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`subscription answered HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(length) && length > MAX_SUBSCRIPTION_BYTES) {
    throw new Error('subscription document is too large');
  }
  const text = await res.text();
  if (text.length > MAX_SUBSCRIPTION_BYTES) throw new Error('subscription document is too large');
  return text;
}

/**
 * Read a subscription document from the CORE's provider cache
 * (`<workDir>/providers/<id>.yaml`).
 *
 * The core already downloaded that file once, so it is the honest source for an
 * import: it works offline, it does not spend a request on the airport's URL, and
 * it survives the very case that made this necessary — a subscription host whose
 * TLS chain this runtime rejects (the core's own fetch accepted it when the
 * provider was seeded). Returns null when there is no usable cache yet.
 */
export async function readCachedProviderYaml(
  workDir: string,
  subscriptionId: string,
  maxBytes = MAX_SUBSCRIPTION_BYTES,
): Promise<string | null> {
  // Subscription ids are generated slugs; refuse anything that could escape the
  // providers directory.
  if (!/^[A-Za-z0-9_-]+$/.test(subscriptionId)) return null;
  const file = path.join(workDir, 'providers', `${subscriptionId}.yaml`);
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size === 0 || info.size > maxBytes) return null;
    const text = await readFile(file, 'utf8');
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

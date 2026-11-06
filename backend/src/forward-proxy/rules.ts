import { globMatch } from '../utils/glob.js';
import type { ForwardProxyRule, RuleEgress, RuleExit, RuleIngress } from '../config/types.js';

/**
 * The forward-proxy rule table (ADR-0018).
 *
 * ONE ordered table. Each row carries TWO fields that split the outcome matrix
 * into its two axes:
 *
 *   `ingress` — `intercept` (MITM, the default posture) / `passthrough`
 *               (blind tunnel) / `reject` (403 on admission);
 *   `egress`  — `direct` (straight out of the machine) / `proxy` (through the
 *               outbound proxy, `config.proxy`).
 *
 * A `reject` row never sends bytes anywhere, so its `egress` MUST be `direct`
 * (reject + egress proxy is invalid; `lintRules` flags it).
 *
 * Invariants no rule can override:
 *   - loopback targets are passthrough + direct (cycle safety + local dev);
 *   - an unmatched host falls back to direct + intercepted, which is the
 *     pre-ADR-0018 posture, so an EMPTY table changes nothing.
 *
 * SCOPE: traffic this gateway proxies or relays for a client. The gateway's own
 * upstream calls keep their provider/model-scoped `proxy:` policy
 * (`utils/proxy.ts`), so a `reject` rule can never silence inference.
 *
 * Order is the whole semantics — no specificity ranking, no category precedence.
 * `lintRules` reports shadowed rows so the console can say so.
 *
 * ONE spelling. A row is `{ match, ingress, egress }` and nothing else; any other
 * shape is an invalid row (reported, position-preserving), never translated.
 */

export const RULE_INGRESSES: readonly RuleIngress[] = ['intercept', 'passthrough', 'reject'];

export const RULE_EGRESSES: readonly RuleEgress[] = ['direct', 'proxy'];

/**
 * Validate one row.
 *
 * A row is valid iff it carries a non-empty `match`, an `ingress` in
 * `RULE_INGRESSES` and an `egress` in `RULE_EGRESSES`, and is not the one
 * invalid combination (`reject` + `egress: 'proxy'`). Anything else is invalid —
 * including a row written in a spelling this vocabulary does not have: there is
 * ONE spelling, and a row that does not parse is reported (position-preserving,
 * `lintRules` `invalid-rule`) rather than quietly reinterpreted, because
 * guessing at a half-understood row is how a `reject` silently becomes a
 * `proxy`, or a pinned host silently starts being decrypted.
 */
function parseRule(entry: Partial<ForwardProxyRule> & Record<string, unknown>): ForwardProxyRule | undefined {
  const match = typeof entry?.match === 'string' ? entry.match.trim() : '';
  if (!match) return undefined;
  const { ingress, egress } = entry;
  if (!RULE_INGRESSES.includes(ingress as RuleIngress) || !RULE_EGRESSES.includes(egress as RuleEgress)) return undefined;
  if (ingress === 'reject' && egress !== 'direct') return undefined; // invalid slot
  return { match, ingress: ingress as RuleIngress, egress: egress as RuleEgress };
}

/** The EXIT half of a decision — where the bytes go (`RuleDecision.action`). */
export function ruleExit(egress: RuleEgress, ingress: RuleIngress): RuleExit {
  if (ingress === 'reject') return 'reject';
  return egress;
}

/** True when the rule must NOT be intercepted (the blind-tunnel leg). */
export function isPassthroughIngress(ingress: RuleIngress): boolean {
  return ingress === 'passthrough';
}

/** True for loopback / unspecified hosts — never proxied, never intercepted. */
export function isLoopbackHost(host: string): boolean {
  const h = (host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    /^127\.\d+\.\d+\.\d+$/.test(h) ||
    h === '0.0.0.0'
  );
}

/**
 * A rule that can never match. Invalid entries are NORMALIZED INTO POSITION
 * (rather than filtered out) so a warning's `ruleIndex` always addresses the
 * row the operator typed, not a shifted survivor.
 */
const INVALID_RULE: ForwardProxyRule = { match: '', ingress: 'intercept', egress: 'direct' };

/** The full decision for one host — the ledger note and the console preview read this. */
export interface RuleDecision {
  /** The EXIT: `direct` / `proxy` / `reject` — where the bytes go. */
  action: RuleExit;
  /** Intercept (false, the default) or blind tunnel (true). */
  tunnel: boolean;
  /** `loopback` / `rule` / `fallback` — why. */
  reason: 'loopback' | 'rule' | 'fallback';
  /** Position in the table (present only for `reason: 'rule'`). */
  ruleIndex?: number;
  /** The glob that matched (present only for `reason: 'rule'`). */
  match?: string;
}

/** The complete lint vocabulary, as RUNTIME data so the console's mirror can be
 *  parity-checked (forward-proxy-console-vocabulary-parity.test.ts) instead of
 *  drifting silently. */
export const RULE_WARNING_CODES = ['invalid-rule', 'unreachable-rule', 'no-catch-all', 'proxy-rule-without-proxy'] as const;

export type RuleWarningCode = (typeof RULE_WARNING_CODES)[number];

export interface RuleWarning {
  code: RuleWarningCode;
  /** Index into the RAW rules array (what the operator typed). */
  ruleIndex?: number;
  /** English detail for logs only — the console renders the CODE through i18n. */
  detail?: string;
}

/**
 * Structural normalization: trims matches and drops unknown values /
 * reject-with-proxy-egress rows into position-preserving invalid slots.
 */
export function normalizeRules(raw: unknown): ForwardProxyRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => parseRule((entry ?? {}) as never) ?? { ...INVALID_RULE });
}

/**
 * Resolve one host. Every leg (CONNECT admission, the MITM inner leg, the plain
 * absolute-URI leg, the tunnels, h2-forward, the direct-forward relay) and the
 * console preview call this, so they can never disagree.
 */
export function resolveHost(host: string, rules?: ForwardProxyRule[]): RuleDecision {
  // Brackets are IPv6 syntax, not part of the name: a CONNECT target arrives as
  // `[2001:db8::1]`, a plain-HTTP `Host` header may not carry them.
  const h = (host || '').trim().replace(/^\[|\]$/g, '');
  if (!h) return { action: 'direct', tunnel: false, reason: 'fallback' };
  if (isLoopbackHost(h)) return { action: 'direct', tunnel: true, reason: 'loopback' };
  for (let i = 0; i < (rules?.length ?? 0); i += 1) {
    const rule = rules![i];
    if (!rule?.match) continue; // invalid slot — never matches
    if (globMatch(rule.match, h)) {
      return {
        action: ruleExit(rule.egress, rule.ingress),
        tunnel: isPassthroughIngress(rule.ingress),
        reason: 'rule',
        ruleIndex: i,
        match: rule.match,
      };
    }
  }
  return { action: 'direct', tunnel: false, reason: 'fallback' };
}

/**
 * Lint the RAW array so `ruleIndex` addresses what the operator typed. Codes
 * only — the console owns the wording (i18n), the boot log renders `detail`.
 *
 * `proxyEnabled` is `config.proxy.enabled`: an `egress: 'proxy'` row on a
 * disabled outbound proxy resolves to DIRECT at runtime, so the table would
 * otherwise display a lie.
 */
export function lintRules(raw: unknown, proxyEnabled: boolean): RuleWarning[] {
  const entries = Array.isArray(raw) ? raw : [];
  const warnings: RuleWarning[] = [];
  const seen = new Set<string>();
  let catchAllAt = -1;
  entries.forEach((entry, ruleIndex) => {
    const rule = parseRule((entry ?? {}) as never);
    if (!rule) {
      const e = (entry ?? {}) as Record<string, unknown>;
      if (e.ingress === 'reject' && e.egress === 'proxy') {
        warnings.push({ code: 'invalid-rule', ruleIndex, detail: 'reject with egress proxy' });
      } else {
        const ingressBad = e.ingress !== undefined && !RULE_INGRESSES.includes(e.ingress as RuleIngress);
        const egressBad = e.egress !== undefined && !RULE_EGRESSES.includes(e.egress as RuleEgress);
        const bad = ingressBad ? e.ingress : egressBad ? e.egress : e.match;
        warnings.push({
          code: 'invalid-rule',
          ruleIndex,
          detail: ingressBad || egressBad
            ? `invalid ${ingressBad ? 'ingress' : 'egress'} "${String(bad)}"`
            : `invalid rule "${String(bad)}"`,
        });
      }
      return;
    }
    const { match, egress } = rule;
    const key = match.toLowerCase();
    if (catchAllAt >= 0) {
      warnings.push({ code: 'unreachable-rule', ruleIndex, detail: 'after the catch-all rule' });
    } else if (seen.has(key)) {
      warnings.push({ code: 'unreachable-rule', ruleIndex, detail: 'duplicate match (first wins)' });
    }
    if (key === '*' && catchAllAt < 0) catchAllAt = ruleIndex;
    seen.add(key);
    if (egress === 'proxy' && !proxyEnabled) {
      warnings.push({ code: 'proxy-rule-without-proxy', ruleIndex, detail: match });
    }
  });
  if (catchAllAt < 0) warnings.push({ code: 'no-catch-all' });
  return warnings;
}

export function hasCatchAllRule(rules?: { match: string }[]): boolean {
  return (rules || []).some((r) => r?.match === '*');
}

/**
 * The table for a forward-proxy config: an explicit `rules` key wins (an EMPTY
 * array is authoritative — it is not "absent"); a section without `rules`
 * (a fresh install before the section is written) has an empty table.
 */
export function normalizeRuleTable(raw: unknown): ForwardProxyRule[] {
  const fp = (raw ?? {}) as Record<string, any>;
  return Array.isArray(fp.rules) ? normalizeRules(fp.rules) : [];
}

/**
 * The host list handed to the OPERATING SYSTEM proxy settings (`system-proxy.ts`).
 *
 * Only LITERAL direct-egress INTERCEPT rows belong there: the OS bypass list
 * means "do not send this host to the proxy at all", which is exactly an
 * `egress: 'direct'` decision. `proxy` rows must reach the proxy; `reject` rows
 * must reach it too — that is where they are refused — so a rejected host in the
 * bypass list would silently un-block itself. A glob cannot be expressed in
 * either platform's bypass syntax.
 */
export function osBypassHosts(rules?: ForwardProxyRule[]): string[] {
  const out: string[] = [];
  for (const rule of rules || []) {
    if (!rule?.match || rule.egress !== 'direct' || rule.ingress === 'reject') continue;
    if (/[*?]/.test(rule.match)) continue; // not expressible as an OS bypass entry
    if (!out.includes(rule.match)) out.push(rule.match);
  }
  return out;
}

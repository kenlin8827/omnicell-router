import { describe, it, expect } from 'bun:test';
import {
  RULE_EGRESSES,
  RULE_INGRESSES,
  hasCatchAllRule,
  isLoopbackHost,
  lintRules,
  normalizeRuleTable,
  normalizeRules,
  osBypassHosts,
  resolveHost,
} from '../src/forward-proxy/rules.js';
import type { ForwardProxyRule, RuleEgress, RuleIngress } from '../src/config/types.js';

const r = (match: string, ingress: RuleIngress, egress: RuleEgress): ForwardProxyRule => ({ match, ingress, egress });

describe('resolveHost — first match wins, exit + posture per row', () => {
  const table: ForwardProxyRule[] = [
    r('ads.example.com', 'reject', 'direct'),
    r('*.internal.com', 'passthrough', 'direct'),
    r('*.openai.com', 'intercept', 'proxy'),
    r('*', 'intercept', 'proxy'),
  ];

  it('first match wins, in table order', () => {
    expect(resolveHost('ads.example.com', table)).toEqual({
      action: 'reject',
      tunnel: false,
      reason: 'rule',
      ruleIndex: 0,
      match: 'ads.example.com',
    });
    expect(resolveHost('db.internal.com', table)).toMatchObject({ action: 'direct', tunnel: true, ruleIndex: 1 });
    expect(resolveHost('api.openai.com', table)).toMatchObject({ action: 'proxy', tunnel: false, ruleIndex: 2 });
    expect(resolveHost('anything.else', table)).toMatchObject({ action: 'proxy', ruleIndex: 3 });
  });

  it('a later rule never overrides an earlier one', () => {
    const shadowed = [r('*', 'intercept', 'proxy'), r('ads.example.com', 'reject', 'direct')];
    expect(resolveHost('ads.example.com', shadowed).action).toBe('proxy');
    expect(resolveHost('ads.example.com', shadowed).ruleIndex).toBe(0);
  });

  it('falls back to direct + intercepted when nothing matches or the table is empty', () => {
    expect(resolveHost('nowhere.test', [r('a.com', 'reject', 'direct')])).toEqual({
      action: 'direct',
      tunnel: false,
      reason: 'fallback',
    });
    expect(resolveHost('a.com', [])).toEqual({ action: 'direct', tunnel: false, reason: 'fallback' });
    expect(resolveHost('a.com', undefined)).toEqual({ action: 'direct', tunnel: false, reason: 'fallback' });
    expect(resolveHost('', [r('*', 'intercept', 'proxy')])).toEqual({ action: 'direct', tunnel: false, reason: 'fallback' });
  });

  it('loopback is direct + tunneled even against a catch-all reject', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]', 'app.localhost', '0.0.0.0', '127.9.9.9']) {
      expect(resolveHost(host, [r('*', 'reject', 'direct')])).toEqual({ action: 'direct', tunnel: true, reason: 'loopback' });
      expect(resolveHost(host, [r('*', 'intercept', 'proxy')])).toEqual({ action: 'direct', tunnel: true, reason: 'loopback' });
    }
  });

  it('`*` crosses dots, so a subdomain glob does not cover the bare host', () => {
    const rules = [r('*.internal.com', 'intercept', 'direct'), r('*', 'intercept', 'proxy')];
    expect(resolveHost('db.internal.com', rules).action).toBe('direct');
    expect(resolveHost('internal.com', rules).action).toBe('proxy');
  });

  it('matches the bare hostname case-insensitively and strips brackets', () => {
    expect(resolveHost('ADS.Example.COM', [r('ads.example.com', 'reject', 'direct')]).action).toBe('reject');
    expect(resolveHost('[2001:db8::1]', [r('2001:db8::*', 'reject', 'direct')]).action).toBe('reject');
  });

  it('an invalid row in the middle never matches (and does not shift indices)', () => {
    const rules = normalizeRules([r('a.com', 'intercept', 'proxy'), { match: '', ingress: 'intercept', egress: 'proxy' }, r('b.com', 'reject', 'direct')]);
    expect(resolveHost('a.com', rules).ruleIndex).toBe(0);
    expect(resolveHost('b.com', rules)).toMatchObject({ action: 'reject', ruleIndex: 2 });
  });

  it('intercept ingress tunnels nothing; passthrough ingress is the blind tunnel', () => {
    expect(resolveHost('a.com', [r('a.com', 'intercept', 'direct')]).tunnel).toBe(false);
    expect(resolveHost('a.com', [r('a.com', 'passthrough', 'direct')]).tunnel).toBe(true);
    expect(resolveHost('a.com', [r('a.com', 'intercept', 'proxy')]).tunnel).toBe(false);
    expect(resolveHost('a.com', [r('a.com', 'passthrough', 'proxy')]).tunnel).toBe(true);
    expect(resolveHost('a.com', [r('a.com', 'reject', 'direct')]).tunnel).toBe(false);
  });

  it('expresses the whole matrix as exit/tunnel pairs', () => {
    const seen = [
      resolveHost('h', [r('h', 'intercept', 'direct')]),
      resolveHost('h', [r('h', 'passthrough', 'direct')]),
      resolveHost('h', [r('h', 'intercept', 'proxy')]),
      resolveHost('h', [r('h', 'passthrough', 'proxy')]),
      resolveHost('h', [r('h', 'reject', 'direct')]),
    ].map((d) => `${d.action}/${d.tunnel}`);
    expect(seen).toEqual(['direct/false', 'direct/true', 'proxy/false', 'proxy/true', 'reject/false']);
  });
});

describe('vocabulary', () => {
  it('RULE_INGRESSES / RULE_EGRESSES are the closed sets; the pair IS the outcome matrix', () => {
    expect([...RULE_INGRESSES]).toEqual(['intercept', 'passthrough', 'reject']);
    expect([...RULE_EGRESSES]).toEqual(['direct', 'proxy']);
    expect(isLoopbackHost('localhost')).toBe(true);
  });

  it('isLoopbackHost covers the loopback spellings', () => {
    for (const h of ['localhost', 'LOCALHOST', 'x.localhost', '127.0.0.1', '127.255.255.255', '::1', '[::1]', '0.0.0.0'])
      expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['example.com', '10.0.0.1', 'localhost.example.com', '']) expect(isLoopbackHost(h)).toBe(false);
  });
});

describe('normalizeRules — vocabulary translation + structural cleanup', () => {
  it('current two-field rows pass through untouched', () => {
    expect(normalizeRules([r('a.com', 'passthrough', 'direct'), r('b.com', 'passthrough', 'proxy'), r('c.com', 'reject', 'direct')])).toEqual([
      r('a.com', 'passthrough', 'direct'),
      r('b.com', 'passthrough', 'proxy'),
      r('c.com', 'reject', 'direct'),
    ]);
  });

  it('trims matches and keeps a valid table as-is', () => {
    expect(normalizeRules([{ match: '  a.com  ', ingress: 'reject', egress: 'direct' }, r('*', 'passthrough', 'proxy')])).toEqual([
      r('a.com', 'reject', 'direct'),
      r('*', 'passthrough', 'proxy'),
    ]);
  });

  it('reject + egress proxy is an invalid slot (never sent anywhere)', () => {
    expect(normalizeRules([{ match: 'a.com', ingress: 'reject', egress: 'proxy' }])).toEqual([{ match: '', ingress: 'intercept', egress: 'direct' }]);
  });

  it('turns junk rows into never-matching slots, preserving positions', () => {
    const out = normalizeRules([
      { match: '', ingress: 'intercept', egress: 'proxy' },
      { match: 'a.com' },
      { match: 'b.com', ingress: 'outbound' as unknown as string, egress: 'direct' },
      { match: 'c.com', sideway: true },
      null,
      r('d.com', 'reject', 'direct'),
    ]);
    expect(out).toHaveLength(6);
    expect(out.slice(0, 5).every((x) => x.match === '')).toBe(true);
    expect(out[5]).toEqual(r('d.com', 'reject', 'direct'));
  });

  it('non-array input is an empty table', () => {
    expect(normalizeRules(undefined)).toEqual([]);
    expect(normalizeRules({ match: '*' })).toEqual([]);
  });
});

describe('lintRules — codes only, indices address the RAW array', () => {
  const codes = (rules: unknown, proxyEnabled = true) => lintRules(rules, proxyEnabled).map((w) => w.code);

  it('a clean table with a catch-all and an enabled proxy is silent', () => {
    expect(codes([r('a.com', 'reject', 'direct'), r('*', 'intercept', 'proxy')])).toEqual([]);
  });

  it('flags an invalid row', () => {
    expect(lintRules([{ match: 'a.com', ingress: 'reject', egress: 'proxy' }, r('*', 'intercept', 'direct')], true)).toEqual([
      { code: 'invalid-rule', ruleIndex: 0, detail: 'reject with egress proxy' },
    ]);
    expect(lintRules([{ match: 'a.com', ingress: 'intercept', egress: 'satellite' }], true)[0]).toMatchObject({
      code: 'invalid-rule',
      detail: 'invalid egress "satellite"',
    });
    expect(lintRules([{ match: 'a.com', ingress: 'moat', egress: 'direct' }], true)[0]).toMatchObject({
      code: 'invalid-rule',
      detail: 'invalid ingress "moat"',
    });
    expect(lintRules([{ match: 'a.com', sideway: true }], true)[0]).toMatchObject({
      code: 'invalid-rule',
      detail: 'invalid rule "a.com"',
    });
  });

  it('flags an `egress: proxy` row while the outbound proxy is disabled', () => {
    expect(codes([r('*', 'intercept', 'proxy')], false)).toEqual(['proxy-rule-without-proxy']);
    expect(codes([r('*', 'intercept', 'direct')], false)).toEqual([]);
    expect(lintRules([r('*', 'intercept', 'proxy')], false)[0].detail).toBe('*');
  });

  it('every warning is addressable to a raw index (no table field)', () => {
    const warnings = lintRules([{ match: '', ingress: 'intercept', egress: 'proxy' }, r('*', 'intercept', 'proxy'), r('x.com', 'intercept', 'direct')], false);
    expect(warnings.map((w) => w.ruleIndex)).toEqual([0, 1, 2]);
    expect(warnings.every((w) => !('table' in w))).toBe(true);
  });

  it('flags rows after the catch-all and duplicate matches', () => {
    const warnings = lintRules([r('*', 'intercept', 'proxy'), r('ads.com', 'reject', 'direct'), r('*', 'reject', 'direct')], true);
    expect(warnings).toEqual([
      { code: 'unreachable-rule', ruleIndex: 1, detail: 'after the catch-all rule' },
      { code: 'unreachable-rule', ruleIndex: 2, detail: 'after the catch-all rule' },
    ]);
    const dup = lintRules([r('A.com', 'intercept', 'direct'), r('a.com', 'intercept', 'proxy'), r('*', 'intercept', 'direct')], true);
    expect(dup).toEqual([{ code: 'unreachable-rule', ruleIndex: 1, detail: 'duplicate match (first wins)' }]);
  });

  it('flags a missing catch-all — unmatched hosts then go DIRECT', () => {
    expect(codes([r('a.com', 'reject', 'direct')])).toEqual(['no-catch-all']);
    expect(codes([])).toEqual(['no-catch-all']);
  });
});

describe('hasCatchAllRule', () => {
  it('is true only for a literal `*` row', () => {
    expect(hasCatchAllRule([r('*', 'intercept', 'direct')])).toBe(true);
    expect(hasCatchAllRule([r('*.com', 'intercept', 'direct')])).toBe(false);
    expect(hasCatchAllRule(undefined)).toBe(false);
  });
});

describe('normalizeRuleTable — explicit table wins, empty is authoritative', () => {
  it('uses `rules` when present', () => {
    expect(normalizeRuleTable({ rules: [r('a.com', 'reject', 'direct')] })).toEqual([r('a.com', 'reject', 'direct')]);
  });

  it('an EMPTY rules array is authoritative, not "absent"', () => {
    expect(normalizeRuleTable({ rules: [] })).toEqual([]);
  });

  it('a section without `rules` is an empty table (the loader supplies the default)', () => {
    // `normalizeRuleTable` reads exactly one key: `rules`. Anything else in the
    // section (a key from an older schema, a typo) contributes no row — the
    // loader is what falls back to the shipped default.
    expect(normalizeRuleTable({ somethingElse: ['a.com'], enabled: true })).toEqual([]);
    expect(normalizeRuleTable({})).toEqual([]);
    expect(normalizeRuleTable(undefined)).toEqual([]);
  });
});

describe('osBypassHosts — only literal direct-egress rows belong in the OS bypass list', () => {
  it('takes direct-egress literals, skips globs, proxy-egress and reject rows', () => {
    expect(
      osBypassHosts([
        r('a.com', 'intercept', 'direct'),
        r('*.glob.com', 'passthrough', 'direct'),
        r('b.com', 'passthrough', 'direct'),
        r('c.com', 'intercept', 'proxy'),
        r('e.com', 'passthrough', 'proxy'),
        r('d.com', 'reject', 'direct'),
        r('a.com', 'intercept', 'direct'),
      ])
    ).toEqual(['a.com', 'b.com']);
  });

  it('is empty for an absent table', () => {
    expect(osBypassHosts(undefined)).toEqual([]);
  });
});

/**
 * Subscription rule import (ADR-0022): targets are FLATTENED onto the gateway's
 * single group and unsupported types are dropped WITH A COUNT — the two things
 * that make an import auditable instead of a silent egress change.
 */
import { describe, expect, test } from 'bun:test';
import { importRulesFromYaml } from '../src/proxy/mihomo-rules-import.js';

const SUBSCRIPTION = `
proxies:
  - { name: hk-01, type: vless, server: example.com, port: 443 }
proxy-groups:
  - { name: 🚀 节点选择, type: select, proxies: [hk-01] }
  - { name: 🇭🇰 香港, type: url-test, proxies: [hk-01] }
rules:
  - DOMAIN-SUFFIX,google.com,🚀 节点选择
  - DOMAIN-SUFFIX,apple.com,🇭🇰 香港
  - DOMAIN-SUFFIX,corp.internal,DIRECT
  - DOMAIN-KEYWORD,ads,REJECT
  - GEOIP,CN,DIRECT
  - GEOSITE,netflix,🚀 节点选择
  - RULE-SET,rules/ads.yaml,REJECT
  - MATCH,🚀 节点选择
  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
  - DOMAIN,bad,payload,DIRECT
  - DOMAIN-SUFFIX,dup,DIRECT
  - DOMAIN-SUFFIX,dup,DIRECT
`;

describe('subscription rule import', () => {
  test('subscription group targets are flattened to PROXY and counted', () => {
    const result = importRulesFromYaml(SUBSCRIPTION);
    expect(result.rules).toEqual([
      { type: 'DOMAIN-SUFFIX', payload: 'google.com', target: 'PROXY' },
      { type: 'DOMAIN-SUFFIX', payload: 'apple.com', target: 'PROXY' },
      { type: 'DOMAIN-SUFFIX', payload: 'corp.internal', target: 'DIRECT' },
      { type: 'DOMAIN-KEYWORD', payload: 'ads', target: 'REJECT' },
      { type: 'IP-CIDR', payload: '192.168.0.0/16', target: 'DIRECT' },
      { type: 'DOMAIN-SUFFIX', payload: 'dup', target: 'DIRECT' },
    ]);
    // Two group targets (not DIRECT/REJECT) became PROXY.
    expect(result.mappedToProxy).toBe(2);
    expect(result.total).toBe(12);
  });

  test('unsupported types and unpairable rows are reported, never shipped', () => {
    const result = importRulesFromYaml(SUBSCRIPTION);
    const byReason = Object.fromEntries(result.skipped.map(entry => [entry.reason, entry.count]));
    expect(byReason.GEOIP).toBe(1);
    expect(byReason.GEOSITE).toBe(1);
    expect(byReason['RULE-SET']).toBe(1);
    expect(byReason.LOGICAL).toBe(1);
    // `DOMAIN,bad,payload,DIRECT` carries a separator inside the payload.
    expect(byReason.DOMAIN).toBe(1);
    // The duplicate collapsed instead of being counted as a skip.
    expect(result.rules.filter(rule => rule.payload === 'dup')).toHaveLength(1);
  });

  test('an unknown target is dropped when mapping is switched off', () => {
    const text = `
proxy-groups:
  - { name: AUTO, type: url-test, proxies: [] }
rules:
  - DOMAIN-SUFFIX,a.com,GLOBAL
  - DOMAIN-SUFFIX,b.com,AUTO
`;
    const mapped = importRulesFromYaml(text);
    expect(mapped.rules.map(rule => rule.target)).toEqual(['PROXY', 'PROXY']);

    const strict = importRulesFromYaml(text, { mapUnknownTarget: false });
    expect(strict.rules).toEqual([{ type: 'DOMAIN-SUFFIX', payload: 'b.com', target: 'PROXY' }]);
    expect(strict.skipped).toEqual([{ reason: 'unknown-target', count: 1 }]);
  });

  test('a subscription without rules and an unparsable document both answer empty', () => {
    const none = importRulesFromYaml('proxies: []\n');
    expect(none).toEqual({ rules: [], skipped: [], total: 0, mappedToProxy: 0 });

    const broken = importRulesFromYaml('rules: [unclosed\n\t:');
    expect(broken.rules).toEqual([]);
    expect(broken.skipped).toEqual([{ reason: 'unparsable', count: 1 }]);
  });
});

import { describe, expect, test } from 'bun:test';
import {
  MANUAL_NODE_FIELDS,
  manualNodeFields,
  manualNodeMapping,
  sanitizeTypedNode,
} from '../src/proxy/manual-node-spec.js';
import type { MihomoManualNode } from '../src/config/types.js';

/** Form-owned values round-trip mapping → fields without loss. */
const ROUND_TRIP: MihomoManualNode[] = [
  {
    id: 'ss1', name: 'ss1', type: 'ss', server: 's.example', port: 8388,
    cipher: 'aes-256-gcm', password: 'pw', udp: true, tfo: true, ipVersion: 'ipv4-prefer',
    plugin: 'obfs', pluginMode: 'tls', pluginHost: 'h.example',
  },
  {
    id: 'vm1', name: 'vm1', type: 'vmess', server: 'v.example', port: 443,
    uuid: '11111111-2222-3333-4444-555555555555', alterId: 0, vmessCipher: 'auto',
    network: 'ws', wsPath: '/ws', wsHost: 'cdn.example', tls: true, sni: 'sni.example',
    alpn: ['h2', 'http/1.1'], clientFingerprint: 'chrome', skipCertVerify: true,
    udp: true, tfo: true, ipVersion: 'dual',
  },
  {
    id: 'vl1', name: 'vl1', type: 'vless', server: 'r.example', port: 24443,
    uuid: '11111111-2222-3333-4444-555555555555', flow: 'xtls-rprx-vision',
    network: 'grpc', grpcServiceName: 'svc', tls: true, sni: 'cdn.example',
    realityPublicKey: 'hD5cxUiWuOJuhepcV521_w_UUsldvqYhd3QRJkuoOzQ',
    realityShortId: '427f3316a646944b', alpn: ['h2'], clientFingerprint: 'safari',
    udp: true,
  },
  {
    id: 'tr1', name: 'tr1', type: 'trojan', server: 't.example', port: 443,
    password: 'pw', network: 'ws', wsPath: '/t', wsHost: 't.example',
    sni: 't.example', alpn: ['h2'], clientFingerprint: 'firefox',
    skipCertVerify: true, udp: true, tfo: true,
  },
  {
    id: 'hy1', name: 'hy1', type: 'hysteria2', server: 'h.example', port: 443,
    password: 'pw', sni: 'h.example', skipCertVerify: true,
    obfs: 'salamander', obfsPassword: 'obfs-pw', up: '50 Mbps', down: '200 Mbps',
    ports: '443,1000-2000', ipVersion: 'ipv6-prefer', alpn: ['h3'],
  },
  {
    id: 'ht1', name: 'ht1', type: 'http', server: 'p.example', port: 8080,
    username: 'u', password: 'pw', tls: true, skipCertVerify: true, udp: true,
  },
];

describe('manual node field table', () => {
  for (const node of ROUND_TRIP) {
    test(`${node.type} round-trips every form-owned field`, () => {
      const mapping = manualNodeMapping(node);
      const back = manualNodeFields(mapping);
      for (const key of MANUAL_NODE_FIELDS[node.type as keyof typeof MANUAL_NODE_FIELDS]) {
        const expected = node[key];
        if (expected === undefined) continue;
        expect(back[key]).toEqual(
          typeof expected === 'number' ? String(expected) : expected,
        );
      }
    });
  }

  test('a full typed draft passes the sanitizer unchanged', () => {
    const raw = {
      name: 'vl1', type: 'vless', server: 'r.example', port: 24443,
      uuid: '11111111-2222-3333-4444-555555555555', network: 'h2',
      h2Host: 'h.example', h2Path: '/h2', tls: true, sni: 'cdn.example',
      alpn: ['h2'], clientFingerprint: 'chrome', tfo: true, ipVersion: 'ipv4',
    };
    const result = sanitizeTypedNode(raw, 'x');
    expect(result.node).toMatchObject(raw);
    expect(manualNodeMapping(result.node!)).toMatchObject({
      'h2-opts': { host: ['h.example'], path: '/h2' },
      tfo: true, 'ip-version': 'ipv4',
    });
  });

  test('invalid values name the offending field', () => {
    expect(sanitizeTypedNode({ name: 'n', type: 'vless', server: 'a.example', port: 1, uuid: 'nope' }, 'x'))
      .toEqual({ node: null, errorField: 'uuid' });
    expect(sanitizeTypedNode({
      name: 'n', type: 'vless', server: 'a.example', port: 1,
      uuid: '11111111-2222-3333-4444-555555555555', realityPublicKey: 'short',
    }, 'x')).toEqual({ node: null, errorField: 'realityPublicKey' });
    expect(sanitizeTypedNode({
      name: 'n', type: 'trojan', server: 'a.example', port: 1, password: 'p', network: 'h2',
    }, 'x')).toEqual({ node: null, errorField: 'network' });
    expect(sanitizeTypedNode({
      name: 'n', type: 'ss', server: 'a.example', port: 1, cipher: 'aes-256-gcm', password: 'p',
      plugin: 'obfs', pluginMode: 'websocket',
    }, 'x')).toEqual({ node: null, errorField: 'pluginMode' });
    expect(sanitizeTypedNode({ name: 'n', type: 'tuic', server: 'a.example', port: 1 }, 'x'))
      .toEqual({ node: null, errorField: 'type' });
  });
});

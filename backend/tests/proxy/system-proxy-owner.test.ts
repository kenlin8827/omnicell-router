import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProxyServer, planSystemProxyAction, lanBypassHosts, osProxyBypasses } from '../../src/forward-proxy/system-proxy.js';

/**
 * The System Proxy card's only authoritative input is the OS setting itself —
 * not installed software, not process names. These cases pin the read:
 * a disabled ProxyServer is stale, a PAC URL is active, and WinINET's
 * per-scheme form still yields one host:port for ownership comparison.
 */

describe('system proxy ownership read', () => {
  it('ignores a stale ProxyServer when ProxyEnable is off', () => {
    assert.equal(normalizeProxyServer('127.0.0.1:7890', 0, ''), undefined);
  });

  it('reduces WinINET per-scheme values to one endpoint (https preferred)', () => {
    assert.equal(normalizeProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891', 1, ''), '127.0.0.1:7891');
    assert.equal(normalizeProxyServer('127.0.0.1:7890', 1, ''), '127.0.0.1:7890');
  });

  it('treats a PAC URL as the active proxy', () => {
    assert.equal(normalizeProxyServer('', 0, 'http://wpad.example/proxy.pac'), 'http://wpad.example/proxy.pac');
  });

});

/**
 * ONE snapshot slot, two OCR endpoints (inbound forward proxy / Clash mixed
 * port). The plan is the safety-critical decision: only a FIRST enable may
 * read the OS into the snapshot — once we own it, re-enabling or switching
 * must never re-snapshot, or the user's original settings are lost forever.
 */
describe('system proxy ownership plan', () => {
  it('snapshots when nothing is owned yet', () => {
    assert.equal(planSystemProxyAction(undefined, '127.0.0.1:4555'), 'snapshot');
  });

  it('refreshes the same endpoint without touching the snapshot', () => {
    assert.equal(planSystemProxyAction({ targetServer: '127.0.0.1:4555' }, '127.0.0.1:4555'), 'refresh');
    assert.equal(planSystemProxyAction({ targetServer: '127.0.0.1:7890' }, '127.0.0.1:7890'), 'refresh');
  });

  it('switches endpoints in place, keeping the pre-OCR payload', () => {
    assert.equal(planSystemProxyAction({ targetServer: '127.0.0.1:4555' }, '127.0.0.1:7890'), 'switch');
    assert.equal(planSystemProxyAction({ targetServer: '127.0.0.1:7890' }, '127.0.0.1:4555'), 'switch');
  });
});

/**
 * The Clash target's bypass list is not the forward target's: the core's
 * generated config ends in `MATCH,<group>`, so private/LAN ranges must stay
 * DIRECT in each platform's bypass syntax or they would be tunneled.
 */
describe('clash system-proxy bypass', () => {
  it('uses WinINET wildcards on Windows', () => {
    const hosts = lanBypassHosts('win32');
    assert.ok(hosts.includes('10.*'));
    assert.ok(hosts.includes('192.168.*'));
    assert.ok(hosts.includes('172.31.*'));
  });

  it('uses CIDR where networksetup / gsettings take it', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const hosts = lanBypassHosts(platform);
      assert.ok(hosts.includes('10.0.0.0/8'));
      assert.ok(hosts.includes('172.16.0.0/12'));
      assert.ok(hosts.includes('192.168.0.0/16'));
    }
  });
});

/**
 * The machine leg of the endpoint check asks "would the OS send this host
 * through its proxy?" — mis-answer it either way and the leg measures the
 * wrong path. Loopback is always direct; every syntax the three platforms
 * actually store must be understood.
 */
describe('OS proxy bypass matching', () => {
  it('never proxies loopback', () => {
    assert.equal(osProxyBypasses('127.0.0.1', []), true);
    assert.equal(osProxyBypasses('127.8.9.10', ['example.com']), true);
    assert.equal(osProxyBypasses('localhost', []), true);
    assert.equal(osProxyBypasses('::1', []), true);
  });

  it('matches WinINET wildcards and <local>', () => {
    assert.equal(osProxyBypasses('192.168.1.20', ['192.168.*']), true);
    assert.equal(osProxyBypasses('10.5.0.9', ['10.*']), true);
    assert.equal(osProxyBypasses('example.com', ['<local>']), false, 'a dotted name is not <local>');
    assert.equal(osProxyBypasses('intranet', ['<local>']), true);
    assert.equal(osProxyBypasses('api.example.com', ['example.com']), false);
  });

  it('matches CIDR entries in both directions', () => {
    assert.equal(osProxyBypasses('10.1.2.3', ['10.0.0.0/8']), true);
    assert.equal(osProxyBypasses('11.1.2.3', ['10.0.0.0/8']), false);
    assert.equal(osProxyBypasses('172.31.255.1', ['172.16.0.0/12']), true);
    assert.equal(osProxyBypasses('172.32.0.1', ['172.16.0.0/12']), false);
  });

  it('matches domain suffixes and single-host wildcards', () => {
    assert.equal(osProxyBypasses('api.example.com', ['.example.com']), true);
    assert.equal(osProxyBypasses('example.com', ['.example.com']), true);
    assert.equal(osProxyBypasses('sub.api.example.com', ['*.example.com']), true);
    assert.equal(osProxyBypasses('example.com.evil.org', ['.example.com']), false);
  });

  it('proxies an unmatched public host', () => {
    assert.equal(osProxyBypasses('www.google.com', ['localhost', '127.*', '192.168.*']), false);
    assert.equal(osProxyBypasses('8.8.8.8', ['192.168.*']), false);
  });
});

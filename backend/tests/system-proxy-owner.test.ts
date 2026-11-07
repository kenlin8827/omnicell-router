import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProxyServer } from '../src/forward-proxy/system-proxy.js';

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

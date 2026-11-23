/**
 * PAC address derivation (ADR-0022): the advertised URL follows the gateway's
 * OWN origin — the request Host — never the console document's origin, which
 * under the Vite dev server is the 5174 dev origin.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_GATEWAY_PORT } from '../../src/config/defaults.js';
import { PAC_PATH, pacUrlFor } from '../../src/proxy/mihomo-pac.js';

describe('pacUrlFor', () => {
  test('uses the request Host verbatim', () => {
    expect(pacUrlFor('192.168.1.10:4700')).toBe(`http://192.168.1.10:4700${PAC_PATH}`);
    expect(pacUrlFor('gateway.lan')).toBe(`http://gateway.lan${PAC_PATH}`);
  });

  test('falls back to loopback plus the live gateway port', () => {
    expect(pacUrlFor(undefined, 'http', 4701)).toBe(`http://127.0.0.1:4701${PAC_PATH}`);
    expect(pacUrlFor('  ', 'http', 4701)).toBe(`http://127.0.0.1:4701${PAC_PATH}`);
  });

  test('falls back to the default gateway port when no config is passed', () => {
    expect(pacUrlFor(undefined)).toBe(`http://127.0.0.1:${DEFAULT_GATEWAY_PORT}${PAC_PATH}`);
  });

  test('keeps the request protocol', () => {
    expect(pacUrlFor('gw.example', 'https')).toBe(`https://gw.example${PAC_PATH}`);
  });
});
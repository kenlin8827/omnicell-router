import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import net from 'node:net';
import { isProbeHost, probeTcp } from '../src/harness/tcp-reach.js';

/**
 * The DSN builder's reachability dial (ADR-0015 §D11).
 *
 * These cases pin the honesty boundaries: a listening port reads reachable, a closed one reads
 * unreachable carrying the socket's own message, and a malformed target never starts a dial.
 * Nothing here asserts authentication or TLS — the probe must not claim either.
 */

let server: net.Server;
let listeningPort = 0;
let closedPort = 0;

beforeAll(async () => {
  // Two real sockets: one that stays listening, one whose port is proven closed after teardown.
  server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  listeningPort = (server.address() as net.AddressInfo).port;

  const throwaway = net.createServer();
  await new Promise<void>((resolve) => throwaway.listen(0, '127.0.0.1', resolve));
  closedPort = (throwaway.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => throwaway.close((error) => (error ? reject(error) : resolve())));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('probeTcp', () => {
  it('reports a listening port as reachable', async () => {
    expect(await probeTcp('127.0.0.1', listeningPort)).toEqual({ reachable: true });
  });

  it('reports a closed port with the socket message', async () => {
    const result = await probeTcp('127.0.0.1', closedPort);
    expect(result.reachable).toBe(false);
    expect(result.message).toContain('ECONNREFUSED');
  });

  it('rejects a malformed target without dialing', async () => {
    expect(await probeTcp('postgres://user@host', 5432)).toEqual({
      reachable: false,
      message: 'invalid target',
    });
    expect(await probeTcp('127.0.0.1', 0)).toEqual({ reachable: false, message: 'invalid target' });
  });
});

describe('isProbeHost', () => {
  it('accepts names, addresses and bracketed IPv6 literals only', () => {
    expect(isProbeHost('db.internal')).toBe(true);
    expect(isProbeHost('10.0.0.4')).toBe(true);
    expect(isProbeHost('[::1]')).toBe(true);
    expect(isProbeHost('')).toBe(false);
    expect(isProbeHost('db host')).toBe(false);
    expect(isProbeHost('db/name')).toBe(false);
  });
});

import { describe, expect, it } from 'bun:test';

import { isSelfBaseURL } from '../src/utils/self-url.js';

/**
 * Unit coverage for the self-reference helper itself (ADR-0010): the criterion
 * is the URL, never the id. The pool/console/auto-pull verdicts that CALL this
 * helper are locked in boot-direct-self-loop.test.ts and the write-routes
 * suite — this file pins the helper's own edges.
 */
describe('isSelfBaseURL — self-reference by URL, never by id', () => {
  it('loopback host + the gateway port is self', () => {
    expect(isSelfBaseURL('http://127.0.0.1:41022/v1', 41022)).toBe(true);
    expect(isSelfBaseURL('http://localhost:41022/v1', 41022)).toBe(true);
  });

  it('hostname case and trailing slashes do not matter', () => {
    expect(isSelfBaseURL('http://LOCALHOST:41022', 41022)).toBe(true);
    expect(isSelfBaseURL('http://127.0.0.1:41022/', 41022)).toBe(true);
  });

  it('both IPv6 spellings are recognized', () => {
    expect(isSelfBaseURL('http://[::1]:41022/v1', 41022)).toBe(true);
    expect(isSelfBaseURL('http://[::1]:41022/v1', 41023)).toBe(false);
  });

  it('0.0.0.0 can only ever mean this machine', () => {
    expect(isSelfBaseURL('http://0.0.0.0:41022/v1', 41022)).toBe(true);
  });

  it('default ports resolve: https 443, http 80', () => {
    expect(isSelfBaseURL('https://localhost/', 443)).toBe(true);
    expect(isSelfBaseURL('http://localhost/', 80)).toBe(true);
    expect(isSelfBaseURL('https://localhost/', 80)).toBe(false);
  });

  it('same loopback host on ANOTHER port is a federation upstream, not self', () => {
    expect(isSelfBaseURL('http://127.0.0.1:41999/v1', 41022)).toBe(false);
    expect(isSelfBaseURL('http://localhost:41022/v1', 41023)).toBe(false);
  });

  it('a non-loopback host at the gateway port is not self', () => {
    expect(isSelfBaseURL('http://192.168.1.10:41022/v1', 41022)).toBe(false);
    expect(isSelfBaseURL('https://relay.example.com:41022/v1', 41022)).toBe(false);
  });

  it('non-http(s) schemes are never self', () => {
    expect(isSelfBaseURL('ftp://localhost:41022', 41022)).toBe(false);
    expect(isSelfBaseURL('file:///etc/passwd', 41022)).toBe(false);
  });

  it('unparseable or absent URLs are not self (unroutable is another plane)', () => {
    expect(isSelfBaseURL('not a url', 41022)).toBe(false);
    expect(isSelfBaseURL('http://', 41022)).toBe(false);
    expect(isSelfBaseURL('', 41022)).toBe(false);
    expect(isSelfBaseURL(undefined, 41022)).toBe(false);
    expect(isSelfBaseURL(null, 41022)).toBe(false);
  });
});

import type net from 'node:net';
import { FORWARD_PROXY_KEEPALIVE_MS } from '../config/defaults.js';

/**
 * Which way a relayed chunk travelled: `a2b` = first argument → second.
 */
export type SpliceDirection = 'a2b' | 'b2a';

/**
 * Bidirectional byte relay between two sockets with backpressure.
 *
 * Two Bun node:net/tls quirks are load-bearing here (verified on 1.3.14):
 *  - `socket.pipe()` FROM a TLSSocket does not flush already-buffered data —
 *    an explicit 'data' relay is used instead;
 *  - a previously `pause()`d stream does NOT auto-flow when a 'data' listener
 *    attaches — `resume()` must be called explicitly.
 *
 * `tap` observes every relayed chunk WITHOUT owning the stream: it runs inside
 * the relay's own 'data' handler, so it can never consume bytes that the relay
 * has not forwarded yet. (Attaching a separate 'data' listener before the relay
 * starts — the obvious way to "peek" a tunnel — silently eats everything that
 * arrives during the async dial.)
 *
 * TCP keepalive is armed on BOTH sockets. A relayed connection has no
 * application-level idle timeout on purpose (a tunnel may carry a legitimately
 * silent protocol — IMAP IDLE keeps quiet for ~29 minutes), so the only way a
 * peer that vanished without FIN/RST gets reaped is the kernel probe. The
 * default OS idle (2 hours) is longer than a crashed client's socket lives, so
 * a half-dead tunnel would hold two descriptors for hours; probing after
 * `FORWARD_PROXY_KEEPALIVE_MS` reclaims them without ever touching a live but
 * quiet stream. `setKeepAlive` is chainable on Bun 1.3.14 (verified: it neither
 * throws nor disturbs the byte flow).
 */
export function splice(
  a: net.Socket,
  b: net.Socket,
  tap?: (dir: SpliceDirection, chunk: Buffer) => void
): void {
  a.on('data', (d: Buffer) => {
    tap?.('a2b', d);
    if (!b.write(d)) {
      a.pause();
      b.once('drain', () => a.resume());
    }
  });
  b.on('data', (d: Buffer) => {
    tap?.('b2a', d);
    if (!a.write(d)) {
      b.pause();
      a.once('drain', () => b.resume());
    }
  });
  a.on('end', () => {
    try {
      b.end();
    } catch {}
  });
  b.on('end', () => {
    try {
      a.end();
    } catch {}
  });
  a.on('error', () => {
    try {
      b.destroy();
    } catch {}
  });
  b.on('error', () => {
    try {
      a.destroy();
    } catch {}
  });
  // `destroy()` on one side emits `close` WITHOUT `error`, so the error
  // handlers above miss it. A policy sweep (strict credential mode) or an
  // abrupt local close would otherwise leave the upstream half — and, for a
  // MITM tunnel, the decrypted loopback socket — open until the OS reaps it.
  // The socket is already fully closed here, so destroying the peer cannot cut
  // a live half-close short.
  a.on('close', () => {
    if (b.destroyed) return;
    try {
      b.destroy();
    } catch {}
  });
  b.on('close', () => {
    if (a.destroyed) return;
    try {
      a.destroy();
    } catch {}
  });
  a.resume();
  b.resume();
  for (const s of [a, b]) {
    try {
      s.setKeepAlive(true, FORWARD_PROXY_KEEPALIVE_MS);
    } catch {}
  }
}

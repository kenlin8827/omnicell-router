# ADR-0020: Transport Fidelity and Tunnel Observation

Date: 2026-12
Status: Accepted
Governs: `backend/src/forward-proxy/server.ts` (the MITM legs, the tunnels, the
`Upgrade:` relay), `backend/src/forward-proxy/relay.ts` (`splice` + its tap),
`backend/src/forward-proxy/ws-frames.ts` (the frame observer),
`backend/src/forward-proxy/access-log.ts` (`recordProxyTunnel`),
`backend/src/forward-proxy/sni.ts` (`peekClientHello`).

## Context

The proxy terminates TLS and then has to re-originate whatever it accepted. Three
questions kept coming back, and each had an unstated answer in the code:

1. **How faithful must the re-origination be?** An h2 client cannot be answered
   over h1 (gRPC/Connect framing, trailers, bidi streams), which is why
   `h2-forward.ts` exists. But the same question applies to WebSockets, to
   `Upgrade:` in general, and to whatever a blind tunnel carries.
2. **What does "blind tunnel" mean for a gateway?** Generic TCP interception
   (mitmproxy's `tcp` mode) is a debugging feature, not a gateway feature: bytes
   with no HTTP semantics cannot enter the routing pipeline at all.
3. **What is the runtime able to do?** Several Bun gaps decide the answer, and
   an undocumented gap is indistinguishable from a bug.

## Decision

### 1. Fidelity: the client's protocol is re-originated upstream

Whatever the client spoke, the origin leg speaks it too. When that is impossible,
the answer is an explicit error — never a silent downgrade.

| Client leg | Origin leg | Note |
|---|---|---|
| h1 request | h1 (`forwardDirect` / `forwardSecureViaProxy`) | — |
| h2 request | h2 (`forwardH2`), h1 fallback | fallback only before any byte reaches the client, replaying the captured body head |
| `Upgrade:` (h1) | byte-verbatim relay | the handshake is a single hop; re-serializing it would break subprotocols/extensions |
| h2 `CONNECT :protocol=websocket` | **not served** | see §3 |
| blind tunnel | raw splice | see §2 |

### 2. TCP is passthrough-only — and observable

A blind tunnel is never decrypted, never parsed, never modified. What it MUST be
is observable, because "a tunnel was opened" answers nothing:

- **Identity without decryption.** The first bytes of every tunnel are peeked for
  a ClientHello (`peekClientHello`): SNI and offered ALPN are recorded. The peek
  rides the relay's own tap, so it cannot steal bytes from the splice, and it
  never delays the relay — a server-speaks-first protocol (SMTP, IMAPS) is not
  blocked waiting for a client that is waiting for the greeting.
- **Byte totals and lifetime.** A finished tunnel lands a closing row with
  `reqBytes` / `respBytes` / `durationMs`. Without them "opened and carried
  nothing for six hours" and "opened and moved 2 GB" look identical.
- **A non-TLS CONNECT is relayed immediately.** The ClientHello classifier
  distinguishes "not TLS at all" from "not complete yet", so an SSH/IMAPS tunnel
  is no longer buffered until 32 KiB accumulates.
- **No application-level idle timeout; a kernel probe instead.** A tunnel may
  carry a legitimately silent protocol (IMAP IDLE keeps quiet for ~29 minutes),
  so any "close after N idle minutes" default is a regression waiting for the
  first IMAP client. What still has to be reclaimed is the peer that vanished
  without FIN/RST — the half-dead SSE stream that holds two descriptors forever.
  `splice` therefore arms TCP keepalive on both sockets
  (`FORWARD_PROXY_KEEPALIVE_MS`, 60 s), as do the h1/h2 upstream legs; the OS
  default idle is two hours, which is longer than the leak lives. A live but
  quiet stream is never touched: keepalive only fails a connection when the
  probes go unanswered.

### 3. WebSocket: relayed byte-verbatim, observed at frame level

The upgrade relay forwards the client's handshake and frames untouched — vendor
SEMANTICS on a claimed host belong to a client-gateway plugin (ADR-0017), never
to the core proxy. The core still observes: `ws-frames.ts` is a streaming frame
counter (messages, text/binary, ping/pong, close code, payload bytes) that
buffers nothing, rewrites nothing, and stops instead of allocating when a stream
declares an absurd frame length. The counts land in the upgrade row's note.

**Two WebSocket surfaces are runtime-blocked, verified on Bun 1.3.14:**

- **Plain `ws://` through the plain proxy port.** The `'upgrade'` event handler
  receives a socket whose writes are swallowed (`write()` returns true,
  `bytesWritten` stays 0, the client receives nothing), and handing an accepted
  socket to an `http.Server` via `emit('connection')` is not honoured either, so
  there is no front-door workaround. `wss://` through CONNECT — the only form a
  TLS-terminating proxy can intercept anyway — is fully supported.
- **RFC 8441 (`CONNECT :protocol=websocket`) on the h2 leg.** Bun answers 405 to
  an extended CONNECT the moment the `'stream'` listener returns without
  responding, and the correct answer cannot be produced synchronously (it must
  relay the origin's `sec-websocket-accept`). A conforming client never tries:
  Bun's h2 server does not advertise `SETTINGS_ENABLE_CONNECT_PROTOCOL`, which is
  the gate Chrome (and every compliant client) checks before using the extension.
  Those clients fall back to h1 WebSocket, which is fully supported.

### 4. `Upgrade:` inherits the CONNECT authority's port

An upgrade head carries a plain `Host` (no port) exactly like any other request
head, so it follows the same precedence as ADR-0018 §3a: explicit `Host` port >
CONNECT port > 443. Defaulting to 443 sent an upgrade for a non-443 origin to the
wrong port — the same silent-wrong-target class the request leg already fixed.

## Consequences

- The h1/h2/upgrade legs can no longer disagree about fidelity: each either
  re-originates the client's protocol or answers with a named error.
- Tunnels become answerable questions ("which host, which protocol, how much
  traffic, how long") without decrypting a byte — a capability mitmproxy does not
  have, because it either intercepts or sees nothing.
- WebSocket traffic gets frame-level visibility without the proxy ever editing a
  frame.
- The two runtime gaps are documented with the exact verification, so the next
  reader does not re-litigate them.

## Non-goals

- **Generic TCP interception** (mitmproxy's `tcp` mode): protocol identification
  plus a frame editor, with no HTTP semantics to route, meter or bill. The
  product is a gateway, not a byte-level debugger.
- **HTTP/3 / QUIC MITM.** A client behind an explicit HTTP proxy does not use
  h3 at all, and CONNECT-UDP/MASQUE is a different transport surface.
- **h2c on the plain proxy port** and **PUSH_PROMISE forwarding.** Neither has a
  real client in this product's traffic, and both would add a second transport
  path with its own failure modes.
- **WebSocket frame EDITING** (rewriting payloads, injecting frames). That is a
  plugin capability (ADR-0017); the core observes only.
- **h1 response trailers.** Bun's `res.addTrailers` is a wire no-op (verified:
  the chunked terminator carries no trailer part), so an h1 client cannot receive
  upstream trailers. The h2 leg — where gRPC actually lives — does carry them.
- **An application-level idle timeout** (`close a connection after N minutes of
  silence`). It cannot be made correct without per-surface defaults — 30 s is
  right for an HTTP leg, wrong for a WebSocket, and fatal for IMAP IDLE — and a
  per-surface default is a policy surface of its own. The fd bound is
  `maxConnections`; the half-dead peer is reaped by keepalive (§2).

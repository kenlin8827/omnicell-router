# ADR-0019: Upstream TLS Trust and Interception Observability

Date: 2026-12
Status: Accepted
Governs: `backend/src/forward-proxy/upstream-tls.ts` (the resolver),
`backend/src/forward-proxy/egress.ts` (`describeUpstreamFailure`),
`backend/src/forward-proxy/server.ts` (the origin legs and the terminator
lifecycle), `backend/src/forward-proxy/h2-forward.ts` (the h2 leg + session
pool), `backend/src/config/index.ts` (`normalizeUpstreamTlsConfig`),
`backend/src/config/types.ts` (`ForwardProxyConfig.upstreamTls`).

## Context

The forward proxy is a MITM: it terminates the client's TLS and then originates
its OWN TLS to the origin. Two consequences were unhandled.

1. **The origin leg is the proxy's own trust decision.** A MITM must validate
   the real target certificate (that is the entire reason it does not simply
   strip verification). But the only trust store available was the system one,
   so an origin signed by a PRIVATE CA — a corporate TLS-inspection chain, an
   internal service, a staging box — was unreachable through the proxy, with no
   way to name the CA and no way to say "I know, accept it".
2. **Every failure looked identical.** A TLS trust failure, a DNS failure and a
   refused port all produced `502 Forward proxy: upstream connection failed`.
   The one field that identifies the cause (`err.code`) was thrown away, in the
   message AND in the ledger note. Meanwhile a client that rejected OUR leaf
   (certificate pinning) never reached the ledger at all — it aborts inside the
   handshake, so no request is ever made.

## Decision

### 1. `forwardProxy.upstreamTls` is the trust surface

```yaml
forwardProxy:
  upstreamTls:
    caFile: /etc/corp/root-ca.pem   # appended to the system store
    insecure: false                 # escape hatch, default false
```

- `caFile` is **appended** to the system trust store, never a replacement: the
  operator names what is missing, they do not take over trust.
- `insecure` disables verification entirely and is default-off. It is warned at
  boot and shown as a console banner while on — a standing risk must not live
  only in a YAML comment.
- A missing/unreadable `caFile` warns once per path and falls back to the system
  store. It never silently turns verification off: fail closed, loudly.
- Hot-applied. The options are resolved per origin leg off the live config ref,
  and the bundle is re-stat'ed on a short TTL so a rotated file is picked up.
  The h2 session pool key includes the trust signature, so a session opened
  under the old policy is never reused.

### 2. Failures are classified, not collapsed

`describeUpstreamFailure(err, { proxied, timedOut })` is the single classifier
for every origin leg (h1 direct, h1 through the outbound proxy, the h2 relay and
the Upgrade relay). It returns `{ status, message, note }`:

- TLS trust codes (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `CERT_HAS_EXPIRED`,
  `ERR_TLS_CERT_ALTNAME_INVALID`, …) → 502 that NAMES the trust failure and
  points at `forwardProxy.upstreamTls.caFile`;
- DNS codes → 502 that says the host could not be resolved;
- everything else → 502 carrying the code;
- the proxy's own hang guard → 504.

The same string lands in the ledger note (`upstream tls: <code>`,
`upstream dns: <code>`, `upstream connect: <code>`, `upstream timeout`), so the
console answers "why did this host stop working" without a packet capture.

### 3. A rejected leaf is an observation

A client that rejects the intercepted certificate (pinning, a trust store
without our CA) is the number-one support question for a MITM proxy. It now
lands in the ledger as a `connect` row.

The signal had to be built, because Bun does not provide the obvious one:
`tlsClientError` does NOT fire when the client rejects the certificate (verified
on 1.3.14 — the server sees `secureConnection` and then a bare socket close).
The reliable signal is "a TLS session that closes without a single decrypted
byte", which is caught on the decrypted stream. Both paths share a per-terminator
dedupe window: a pinned client retries in a tight loop and would otherwise flush
every real row out of the ring.

### 4. Eviction drains instead of killing

Terminators are LRU-bounded (full capture sees every host a client visits). The
old eviction closed the listener immediately, so a CONNECT that had already
resolved that terminator's port could hit `ECONNREFUSED` and silently degrade to
a blind tunnel — losing interception for that exchange, with only a log line.

An evicted terminator now enters a DRAINING set (bounded, 30 s): it still accepts
the connection already in flight, it is never reused for a NEW CONNECT, and it
never outlives its grace window. `close()` tears the draining set down too.

### 5. An error envelope is terminal for the connection

`Connection: close` alone does not close the MITM inner connection on Bun
(verified: the client's TLS session stayed open after a complete 502, hanging
every non-streaming client), and the inner server's `res.socket.end()` is inert
for the loopback pair. The terminator therefore carries an `abort()` hook, and
the error answer closes the client transport once the envelope has actually been
handed over (the next chunk the inner server emits IS that envelope, so this is
exact — an immediate `end()` truncated the response).

## Consequences

- A private-CA origin becomes reachable by naming its CA, and `insecure` exists
  as a documented, loudly-flagged escape hatch instead of an unsupported wish.
- Every origin failure is self-describing in both the client's answer and the
  ledger.
- A pinned client is visible instead of mysterious.
- Terminator eviction can no longer degrade interception silently.
- `ForwardProxyDeps.upstreamTls` (the test seam) is now MERGED over the live
  options field by field, so a test can inject a `lookup` while the real
  `caFile` / `insecure` resolution still runs.

## Non-goals

- **Replacing the system trust store.** `caFile` appends; an operator who wants
  a closed trust set can point `caFile` at their own bundle and accept that the
  system roots remain (a per-install trust override is a different feature).
- **Per-host or per-rule TLS policy.** Trust is one process-wide decision, like
  the outbound proxy URL. A per-host `insecure` would be an inventory, not a
  policy, and the rule table already carries two axes (ADR-0018).
- **Client-certificate (mTLS) presentation to origins.** Tracked as a separate
  capability; it needs a credential surface (where does the cert live, who
  rotates it), not a flag.
- **`tlsClientError` as the pinning signal.** It is not one on Bun; the
  decrypted-stream signal is authoritative.

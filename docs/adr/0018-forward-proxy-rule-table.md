# ADR-0018: The Forward-Proxy Rule Table

Date: 2026-12
Status: Accepted (revised twice — see the two Revision sections)
Governs: `backend/src/forward-proxy/rules.ts` (the resolver),
`backend/src/forward-proxy/egress.ts` (`ruleDecision` / `isRuleRejected` /
`ruleTunnels` / `transitEgressFor` / `transitProxyFor`),
`backend/src/forward-proxy/server.ts` and `h2-forward.ts` (every transit leg),
`backend/src/surfaces/direct-forward.ts`,
`backend/src/config/index.ts` (`resolveForwardProxyConfig`),
`backend/src/routes/console.ts` (lint + dry-run endpoint),
`frontend/src/pages/ProxyAccessPage.tsx` (the rule card).

## Context

Forward-proxy policy had grown into four partial mechanisms describing two
questions in overlapping vocabularies.

**Question A — where do this host's bytes go?**
1. `forwardProxy.viaOutboundProxy` — one global boolean for every non-bypassed
   host.
2. `forwardProxy.bypassHosts[].viaProxy` — a per-entry flag, but reachable only
   for hosts that were ALSO excluded from interception. An intercepted (MITM'd)
   host could not be given its own egress at all: `transitProxyFor(host, port,
   force)` received `force === undefined` on every MITM leg and followed the
   global flag.
3. `proxy.includes` / `proxy.excludes` — provider/model-scoped lists that the
   forward proxy reached into with `{ model: host }`, i.e. a hostname smuggled
   through a provider-model matcher. `includes` non-empty therefore silently
   forced transit traffic to DIRECT.

**Question B — is this connection intercepted at all?**
4. `bypassHosts` (deny) and `mitmHosts` (allow) — two lists on the SAME axis,
   with an empty-list sentinel ("empty = intercept everything not bypassed") and
   a fixed `deny > allow > default` precedence.

There was no way to refuse a host. There was no way to say "everything through
the proxy except these" without flipping a flag that governed tunnels and
forwards alike. And "direct for `*.internal.com`" and "don't intercept
`*.internal.com`" were expressed in two unrelated places, so nobody could see a
host's full outcome without cross-reading three sections.

An intermediate revision split this into two ordered tables (`egressRules` +
`decryptRules`). That removed the redundancy but kept the operator's real
complaint: one host's outcome lived in two lists, and the word "decrypt" became a
first-class config concept. Interception is the product's default posture, not a
mode — so it belongs in a DEFAULT, not in a table of its own.

## Revision 2 — the two-field `{ ingress, egress }` row

The single-word enum below was itself an intermediate: it packed the two axes
back into one token, and an operator moving between the console and the config
file had to keep a mental mapping (`intercept + proxy ✓` ↔ `proxy-passthrough`).
The row shape is now two SINGLE-AXIS fields — the console's per-row controls and
the YAML rows are word-for-word the same vocabulary:

```yaml
forwardProxy:
  rules:
    - { match: "ads.example.com",  ingress: reject,      egress: direct }
    - { match: "*.pinned.example", ingress: passthrough, egress: proxy }
    - { match: "*.internal.com",   ingress: passthrough, egress: direct }
    - { match: "*",                ingress: intercept,   egress: proxy }
```

- `ingress: intercept | passthrough | reject` — what happens at ingress:
  intercepted and decrypted (the default posture), blind-tunneled, or 403 on
  admission;
- `egress: direct | proxy` — where the admitted bytes exit: straight out of this
  machine, or through the outbound proxy on the Proxy page.

A `reject` row must carry `egress: direct`; `reject` + `egress: proxy` is the
ONE invalid combination — linted (`invalid-rule`, position-preserving), never
silently remapped. `ForwardProxyRule` carries both fields; the runtime
`RuleDecision` is UNCHANGED (`{ action: 'direct'|'proxy'|'reject', tunnel,
… }`, derived from `ingress`/`egress`), so every transit leg is untouched.
This revision was itself shipped WITH a translation of the two earlier
spellings; **Revision 3 removes it** — see below. Wherever the prose in this ADR
names a `-passthrough` word, read `ingress: passthrough` + the matching `egress`.

## Revision 3 — one spelling, no translation

The translations of Revision 1's `{ action }` matrix and the original
`{ action, tunnel }` pair are GONE, together with the folding of the pre-ADR-0018
section keys (`viaOutboundProxy` / `bypassHosts` / `mitmHosts`). Keeping a second
reader alive is the worst of both worlds: it preserves a vocabulary the console
cannot render, it makes every future row-shape change a three-way merge, and it
hides the fact that the file needs rewriting.

What happens instead, in ONE place each:

- a row without `ingress` + `egress` is an **invalid row** — position-preserving,
  reported by `lintRules` (`invalid-rule`), never reinterpreted;
- a section key the schema does not declare is **dropped** in
  `resolveForwardProxyConfig` (never folded, never re-persisted on the next
  console save). An upgrading install therefore starts from the shipped default
  table and writes the rows it wants, in the one spelling that exists.

`normalizeRuleTable` is the whole contract: an explicit `rules` array (even an
empty one) wins, otherwise the shipped default applies.

## Revision 1 — the single-word action enum

The original decision spelled a row as `{ action, tunnel? }` — two fields where
`tunnel` named the MECHANISM (blind tunneling) instead of the EFFECT (no
interception), and sat on a different axis than the three `action` values. The
five possible outcomes are a closed set, so the vocabulary now IS the matrix:

```yaml
forwardProxy:
  rules:
    - { match: "ads.example.com", action: reject }
    - { match: "*.pinned.example", action: proxy-passthrough }
    - { match: "*.internal.com",  action: direct-passthrough }
    - { match: "*",               action: proxy }
```

| action | exit | intercepted? |
|---|---|---|
| `direct` | direct | yes (the default posture) |
| `direct-passthrough` | direct | no — blind tunnel |
| `proxy` | outbound proxy | yes (the default posture) |
| `proxy-passthrough` | outbound proxy | no — blind tunnel |
| `reject` | none — 403 on admission | — |

The base word is the EXIT, the `-passthrough` suffix is the interception
opt-out, and the plain forms stay the default posture — so an existing row
without the suffix keeps its exact original meaning. `ForwardProxyRule` loses
the `tunnel` field; the runtime `RuleDecision` keeps the derived
`{ action: 'direct'|'proxy'|'reject', tunnel: boolean }` shape (exit +
intercepted) so every transit leg is unchanged. (The `{ action, tunnel }`
translation this revision shipped was itself removed by Revision 3 — a row in
that spelling is now an invalid row, reported and never reinterpreted.)
Wherever the prose below says `tunnel: true`, read the `-passthrough`
spelling.

## Decision (original two-field spelling, superseded by the Revisions above)

### 1. ONE ordered table, one row per host outcome

The examples in this section keep their historical spelling so the two Revisions
read as history; today's rows are the `{ ingress, egress }` pair shown there.

```yaml
forwardProxy:
  rules:
    - { match: "ads.example.com", action: reject }
    - { match: "*.pinned.example", action: proxy-passthrough }
    - { match: "*.internal.com",  action: direct-passthrough }
    - { match: "*",               action: proxy }
```

`match` is a glob over the **bare hostname** (`*` crosses dots, so
`*.internal.com` does NOT cover `internal.com` itself — list both). Ports are not
matched: a CONNECT target is stripped to its host before resolution.
`action` is one of five values — the five possible outcomes ARE the vocabulary:

| action | exit | intercepted? |
|---|---|---|
| `direct` | direct | yes (the default posture) |
| `direct-passthrough` | direct | no — blind tunnel |
| `proxy` | outbound proxy — `proxy.enabled` + `proxy.url` | yes (the default posture) |
| `proxy-passthrough` | outbound proxy — `proxy.enabled` + `proxy.url` | no — blind tunnel |
| `reject` | none — 403, answered on admission | — |

The base word is the EXIT; the `-passthrough` suffix opts out of interception:
the bytes are still sent to that exit, but nothing is decrypted. (Historical
note: this ADR originally spelled the opt-out as an optional `tunnel: true`
flag, then as a `-passthrough` suffix; both are gone. Only
`{ ingress, egress }` parses — see Revision 3.)

**Order IS the semantics.** There is no specificity ranking (`*.foo.com` vs
`foo.*` has no defensible ordering) and no category precedence (`direct` over
`proxy` would be an arbitrary convention nobody can read off the table). The
first matching rule wins, and the console reports WHICH rule won.

**Why one table and not two.** The two questions are genuinely independent
("intercept this but send it direct", "tunnel this but send it through the
proxy"), but only one of them has a real default: interception. So the EXIT is
mandatory (every host needs an exit, or a refusal) and the no-intercept
exception is simply absent on the overwhelming majority of rows (`ingress`
carries it). Splitting
them into `egressRules` + `decryptRules` made the operator read two ordered lists
to answer one question about one host, and put a mechanism word ("decrypt") on
the config surface. This ADR therefore also retires the intermediate two-table
spelling: `egressRules` / `decryptRules` are dropped on load.

### 2. Invariants no rule can override

- **Loopback is always `direct` + blind-tunneled.** `isLoopbackHost` is consulted
  before the table: proxying or intercepting a loopback target risks a cycle
  (forward-proxy → outbound proxy → forward-proxy) and breaks local dev. A
  loopback `reject` is unspellable — deliberate. Loopback always resolves to
  `ingress: passthrough` + `egress: direct`, no matter what the table says.
- **An unmatched host is `direct` + intercepted.** A `reject` fallback would turn
  one missing rule into a total outage on the machine's traffic valve; a
  "not intercepted" fallback would silently turn full capture off for a config
  that only wanted one exception. Both fallbacks equal the pre-ADR-0018 defaults,
  so an EMPTY table changes nothing.

### 3. `reject` is an ADMISSION gate, checked before interception

A rejected host is answered 403 **before** any tunnel is opened and before a
certificate is minted, on all three legs: CONNECT (raw socket 403, no `200
Connection Established`), plain-HTTP absolute-URI, and the MITM inner server (the
inner `Host` can differ from the CONNECT target). The decision lands in the
access-log ledger (`connect (rejected by rule)` / `rejected by rule`), so a
refusal is observable, not a mystery hang.

#### 3a. The CONNECT authority is the interception identity and the port default

Admission and interception both read the CONNECT authority, never a guess:

- **Identity.** A ClientHello WITHOUT SNI is still intercepted, with the
  certificate minted for the CONNECT authority. Falling back to a blind tunnel
  there made interception optional for the client — omitting one extension was
  enough to opt out — and an IP-literal target can never send SNI at all
  (RFC 6066). Only a non-TLS stream (SSH, IMAPS, a bespoke protocol) or a hello
  that never completes takes the blind-tunnel path, and the ledger note says
  which (`connect (not tls, blind tunnel)` / `connect (hello incomplete, blind
  tunnel)`).
- **Port.** The intercepted request's upstream port is, in order: an explicit
  `Host`/`:authority` port > the CONNECT authority's port > 443. The CONNECT
  port rides from admission into the inner request as per-connection state
  (`MitmTarget`), because HTTPS clients routinely omit the port from the request
  head; re-deriving it with a hardcoded 443 default silently forwarded
  `CONNECT host:8443` + `Host: host` to 443.

### 4. `action: proxy` is host-scoped and final

The `action` resolves the proxy URL through `outboundProxyUrl()` —
`proxy.enabled` + `proxy.url` only. It deliberately does **not** consult
`proxy.includes` / `proxy.excludes`: those lists answer "which provider/model",
and letting a provider-scoped list downgrade a host-scoped decision to direct is
exactly the silent lie this table exists to remove.

`proxy` while `proxy.enabled !== true` resolves to DIRECT (that is what
`resolveProxyUrl` does with no enabled proxy). Because the table would otherwise
display a lie, that combination is surfaced twice: a boot warning and a console
banner.

### 5. Scope: traffic this gateway handles for a client

Every transit leg consults the table: `forwardTo` (plain-proxy + intercepted h1),
`tunnel` (blind tunnels), the `Upgrade:` relay, `forwardH2` (intercepted h2
upstream) and the pipeline's `direct-forward` relay. The gateway's own upstream
calls keep their provider/model-scoped `proxy:` policy (`providers/*`,
`systemone/native`, catalog sync via `proxiedFetch`) — a `reject` rule can never
silence inference, and the two vocabularies never collide.

Consequence of the placement: the table lives under `forwardProxy.` and therefore
governs forward-proxy/relay traffic. Host-based egress for the gateway's own
infrastructure calls is explicitly out of scope; covering those would require
promoting the table to a top-level `egress:` section and retiring
`proxy.includes/excludes` in the same move.

### 6. No migration surface — retired keys are dropped, not folded

Superseded by Revision 3. The pre-ADR-0018 keys (`viaOutboundProxy`,
`bypassHosts`, `mitmHosts`, plus the intermediate `egressRules` /
`decryptRules`) are not part of the schema and are dropped by
`resolveForwardProxyConfig`; nothing is folded and nothing is warned about per
key, because a tombstone that keeps reading a dead surface is not a migration,
it is a second implementation.

An install that still carries them therefore lands on the shipped default table
(`* → intercept + proxy`) and rewrites its rows:

| old surface | row that reproduces it |
|---|---|
| `bypassHosts: [<host>]` | `{ match: <host>, ingress: passthrough, egress: direct }` |
| `bypassHosts: [{ host: <host>, viaProxy: true }]` | `{ match: <host>, ingress: passthrough, egress: proxy }` |
| `viaOutboundProxy: true` | the catch-all row's `egress: proxy` |

No schema bump: the disk schema never declared these keys on the v1 side either,
so dropping them is a shrink, not a version change. The fresh-install template
seeds `enabled: false` + `rules: [{ match: '*', ingress: intercept, egress:
proxy }]` — one catch-all: intercept everything, exit through the outbound proxy.
The listener is the master gate, so the seed routes nothing until the operator
turns the proxy on — and when they do, "everything through the outbound proxy" is
the posture a blocked network needs. `reject` is never seeded.

### 7. The console is part of the contract

An ordered table is only readable if you can ask it a question, so
`POST /api/admin/forward-proxy/rules/resolve` returns, for the UNSAVED table:

- `warnings` — lint codes (`invalid-rule`, `unreachable-rule`, `no-catch-all`,
  `proxy-rule-without-proxy`) carrying the index of the row the operator typed;
  the console renders the wording through i18n, the backend owns the rule;
- `decision` — `{ action, tunnel, reason, ruleIndex, match }` for a probe host
  (`action` is the EXIT — direct / proxy / reject — and `tunnel` says whether it
  is blind), produced by the SAME `resolveHost` the proxy legs call, so the
  preview cannot disagree with reality.

The console speaks the row's OWN two fields and nothing else: one dropdown for
`ingress` (Intercept / Passthrough / Reject), one toggle for `egress`
(direct / proxy), and the probe renders its answer with the same two labels —
so "UI vocabulary" is not a separate vocabulary, it is the schema. The mirror is
parity-checked by `forward-proxy-console-vocabulary-parity.test.ts` against the
backend's runtime value lists (`RULE_INGRESSES`, `RULE_EGRESSES`,
`RULE_WARNING_CODES`), and a lint code the console has no sentence for is a
typecheck failure, not a fall-through to the wrong sentence.

New rows are inserted BEFORE the catch-all and inherit its `egress`
— appended after it they would never match, which reads as "the feature is
broken" rather than "you put it in the wrong place". Reordering is ↑↓ buttons,
not drag: the list lives in a scrolling container and must stay
keyboard-reachable.

The OS proxy integration (`system-proxy.ts`) derives its bypass list from the
table: literal (non-glob) `egress: direct` rows are exactly the hosts that
should not be sent to the proxy at all. `proxy` rows must reach the proxy,
`reject` rows must reach it to be refused — so `reject` is excluded from the
bypass list even though its `egress` is `direct`. This also
fixes an old inconsistency — `bypassHosts` used to be written into the OS
bypass list even when its egress was "via proxy".

## Consequences

- Two concepts replace four mechanisms: per host, "where do the bytes go" and "is
  this connection intercepted", answered by one row in one ordered list.
- The MITM-leg egress hole is closed: an intercepted host can be direct, proxied,
  or rejected independently of every other host.
- Refusal becomes expressible, and observable in the ledger.
- `h2-forward` and the h1 forwarder can no longer disagree about egress (both
  call `transitEgressFor`).
- The page's three-part egress UI (global switch + per-row checkbox + a
  provider-scoped list reached through a hostname) and its separate MITM
  allow-list collapse into one rule card.
- `mitmHosts` users lose the opt-in allow-list mode; the equivalent is a
  catch-all row carrying the `passthrough` ingress (`ingress: passthrough,
  egress: proxy`).
- A config that sets `proxy.includes` and expects it to gate transit traffic now
  sees the rule table win. That is the intended correction, and it is why `proxy`
  resolves through `outboundProxyUrl()`.

## Non-goals

- **A second table for the interception axis.** Rejected in §1 — it doubles the
  reading for one host and promotes a default into a mechanism.
- **Reordering `proxy.includes` / `proxy.excludes` into a third table.** Those
  lists match `provider/modelId` (with three interpretations of one string: bare
  provider, bare model id, substring), not hosts; a shared `match` field name
  would invite confusion. They also have no third representation fighting them,
  which is what forced this ADR. If that surface ever needs the same treatment it
  gets its own ADR — including the known wart that a non-empty `includes` sends
  unlisted callers (catalog sync, logo fetch, probes) direct.
- **CIDR / IP-range matching.** `globMatch` is a string glob; `10.0.0.0/8` does
  not mean anything. IPv4/IPv6 literals match as plain strings.
- **Port-scoped rules.** Rules match the bare hostname.
- **Overriding loopback.** No rule can proxy, reject, or intercept a loopback
  target.
- **Per-rule metadata** (labels, notes, hit counters). This is a routing table,
  not an inventory.

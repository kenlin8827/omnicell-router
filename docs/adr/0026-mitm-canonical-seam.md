# ADR-0026 — The MITM Canonical Seam: Plugin-Owned Model Traffic, No Unresolved-Model Mechanism

- **Status:** Implemented
- **Date:** 2026-11-15
- **Supersedes:** [ADR-0003](./0003-model-addressing-and-tier-membership.md) §7a (retired in full)
- **Relates to:** [ADR-0017](./0017-client-gateway-plugins.md) (client-gateway plugins), [ADR-0018](./0018-forward-proxy-rule-table.md) (rule table / admission), [ADR-0008](./0008-protocol-surfaces-and-capture.md) (surface table)

## Context

Two questions were open at once, and they were the same question:

1. `forwardProxy.unresolvedModel` (ADR-0003 §7a) was a **second model-addressing policy living in transport config**. Its three verbs each duplicated a mechanism that already had an owner — `fail` reproduced the `#variant` 404 contract, `direct` reproduced the proxy's own byte-verbatim passthrough, and a modelRef reproduced combos and tier aliases. Its per-host override table was the only part with no twin, and its only real use case ("this host's catalog is not mirrored here") is a fact about a VENDOR, not a global policy.
2. The MITM leg **understood model traffic itself**: the interceptor detected canonical surfaces and dispatched them into the pipeline, so "who handles this request" was answered in two places — the plugin registry (host claims) and the interceptor (path table).

The observed cost of (1) was a dedicated console page, a nav item, eight locale namespaces, a config key with three YAML comment entries, one test file, a `DirectForwardPlan` result shape, a `direct`-only transport executor, and an orchestrator branch that had to ask "am I on the MITM leg?". The observed cost of (2) was that a gateway plugin could claim a host but could never *own the canonical wires*, because the interceptor had already taken them.

## Decision

### 1. The unresolved-model mechanism is deleted, not deprecated

`forwardProxy.unresolvedModel`, `pipeline/unresolved-model.ts`, the `UnresolvedModelConfig` type, the `DirectForwardPlan` result, `surfaces/direct-forward.ts`, the `directMiss` orchestrator path, the console page, its route, its nav entry and its locale namespace **do not exist**. Nothing is accepted, translated or warned about.

A model name that survives every resolution stage reaches the classifier — on **every** leg, MITM included. That is the entire behavior. There is no "MITM is special" posture left anywhere in the pipeline, and the orchestrator no longer asks which leg it is on.

The reason this is a deletion rather than a smaller key: each verb was a duplicate of an existing decision point, and a duplicate that disagrees is worse than a missing feature. A vendor whose model names the gateway does not mirror is handled by *not claiming that vendor's host* (the request then forwards transparently, byte-verbatim, which is what `direct` was imitating) or by a gateway plugin that maps names explicitly (which is what a modelRef was imitating, but with the mapping owned by the thing that knows the vendor).

### 2. Two claim shapes, one accept hook

`ClientGatewayPlugin.hosts` admits exactly two kinds of entry:

- an **exact SNI host** (`api2.cursor.sh`) — a vendor owner;
- the **wildcard** `'*'` — a universal gateway, willing to answer for any host no exact claim took.

Ordering is the registry's, never the plugin's: **all exact claims are consulted first, wildcard claims last.** A wildcard can therefore never shadow a vendor plugin by manifest order.

`match(info)` is the **accept** step and it is not optional, which is what makes a wildcard safe: `hosts: ['*']` says *"I am willing to answer here"*, `match()` says *"and here is the traffic I actually recognize"* (canonical path, method). A wildcard that declines is not a capture of everything — the request falls through to the next gateway and, ultimately, to the transparent forward.

This is the whole extension point. A universal gateway is a plugin with `hosts: ['*']` and a `match()` that accepts the canonical surfaces; it needs no new plugin type, no new manifest field, and no core change.

### 3. Model service is a gateway ROW, including the built-in one

Revision 2 (2026-11-15): the interceptor no longer dispatches any surface. It has two outcomes, not three:

1. a gateway accepts the request — exact claim, then installed wildcard claim, then the **built-in** wildcard row — and owns it;
2. nothing accepted it → not model traffic → transparent forward, byte-for-byte.

The canonical wires are owned by `plugins/builtin/model-gateway.ts`: `hosts: ['*']`, `match()` = `POST` + a path in `surfaces/table.ts`, `handle()` = read body → `createNodeHttpTransport` → `dispatchSurface`. It is a gateway in every sense the orchestration cares about; the only thing that makes it "built-in" is that it is bound in-process instead of loaded from a package, because it needs the live orchestrator and nothing else.

It is consulted **last**, after every installed wildcard. That ordering is the whole swap story: installing a wildcard package pre-empts the built-in row with no core change, disabling it hands the traffic back, and no plugin can shadow a vendor's exact claim by manifest order.

The built-in row is deliberately kept OUTSIDE the `gateways` map: the interceptor owns it and passes it to `findGateway()` as the caller's FALLBACK row, so it is not registry state. `listGatewayHosts()` feeds CONNECT admission, the h2-first relay choice and the console's claim preview — a literal `'*'` in that set would flip every host's decision. The row is invisible to those consumers by construction, not by filtering, and being a parameter rather than module state means two interceptors in one process cannot re-point each other's model traffic.

### 4. Why the slot's default occupant is built-in, not a package

The tempting alternative — ship the same thing as `plugins/model-gateway/` — cannot be made faithful today. Serving a decrypted canonical request is not only "run the pipeline": the request arrives as node-http `req`/`res`, and four policies live in the adapter that turns that pair into a `TransportContext`:

- **Body reading with the 32 MB cap** and its 413 envelope (`surfaces/transport-node-http.ts`).
- **Client-exchange capture** (`observability/http-exchange.ts`): the console's per-turn client request/response record, emitted from inside the transport's terminal sends. Nothing in the plugin SDK reaches it — `GatewayRelayTap` is a *different* feed (a plugin's own traffic log, as Cursor's gateway writes), so a package would either duplicate the recorder or silently drop captured turns the moment it was installed. A gateway that changes what the console can show is not a drop-in replacement.
- **The keyless POLICY EXEMPTION** (see `surfaces/transport-node-http.ts`: the `Authorization` header on that wire belongs to the real upstream). Gateway-plugin completions are **key-bound** (ADR-0017 §48: `accountKeyId` or the CONNECT-bound key, else 401), so a package would either require the operator to bind a key — changing what "point your tool at the proxy" costs — or the SDK must hand a plugin an exemption.
- **Wire shapes.** `host.chat()` takes a canonical **OpenAI-shaped** body; the built-in row serves four wires whose bodies are parsed by `surfaces/` first.

Exposing all four to plugins does not produce a plugin — it produces the adapter, published under a plugin-shaped name. So the seam is drawn where the policy actually lives: the adapter stays in core, and the ROW is what a package can replace. If a future ADR opens the capture recorder and the exemption to the SDK, the package form becomes possible **and** the built-in row keeps working unchanged — the ordering already allows it.

What an operator can do today without any of that: install a wildcard package that accepts only the wires it wants to own (for example `/v1/messages` for an Anthropic-only workflow) and declines the rest. Declines fall through to the built-in row, so partial replacement already works.

## Consequences

- **Deletions.** One console page + route + nav item, eight locale entries, one config key (with three YAML comment entries in each of en/zh), one 223-line test file, one test block in `forward-proxy.test.ts`, one assertion in `config-migration.test.ts`, `pipeline/unresolved-model.ts`, `surfaces/direct-forward.ts`, `DirectForwardPlan`, `directForward`, `directMiss`, `ProcessContext.unresolvedModel`, `TransportContext.relayUpstream`'s only caller.
- **The `forwardProxy` section is now purely transport.** Rules, admission, TLS trust, access log, port/host/caDir. Nothing in it decides what a model name means.
- **The interceptor has no dispatch branch.** `forward-proxy/interceptor.ts` is `findGateway` → `handle` → otherwise `return false`. It cannot answer "what does this request mean", only "who owns it" — so no future surface can be added to the MITM leg without going through a gateway row.
- **A proxied client's unknown model name is no longer a 404 and no longer a passthrough.** It routes like any other unregistered name: the classifier decides. An operator who wants a hard failure registers the name, or uses a plugin that maps it.
- **`listGatewayHosts()` returns the wildcard verbatim.** It is the claim vocabulary, not a resolved host list; consumers that need concrete hosts filter `'*'` themselves. The rule table's `claimed` reason stays exact-match, so a wildcard gateway does not silently flip every host to `intercept` — MITM decisions remain the table's.
- **The vendored `dist/` artifacts carry the retired strings** until the next build; they are generated, never read by anything at runtime, and are not a compatibility promise.


## An exact-host package occupant: `opencode-gateway`

Proxy mode is two halves, and neither replaces the other: an **ingress** that makes the client's traffic enter the forward proxy (`HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` written into OpenCode's managed service), and **ownership** of what that traffic means. This section is the second half. Since ADR-0028 both halves ship as the ONE package `plugins/opencode-gateway/` — the ingress as its `client-adapter` part, the claims below as its `client-gateway` part.

`plugins/opencode-gateway/` is the first packaged occupant of an EXACT host claim rather than the wildcard, and it pins three boundaries worth keeping:

- **No wildcard.** OpenCode has no exclusive host, so a `'*'` claim would shadow the built-in row for every other client on the machine. The claim is a configurable host list, and `match()` narrows it to `POST` on a model path — telemetry, auth, uploads and the model catalog stay transparent.
- **One wire, not four.** `host.chat()` emits canonical OpenAI frames, so the OpenAI chat wire is answered end to end with nothing translated. Anthropic and Responses requests are DECLINED and fall through to the built-in row, whose converters already live in core — a package copy would be a second implementation of the four policies above, with no owner keeping the two equal.
- **`intercept: false` still claims.** "Installed but transparent" cannot be expressed by declining: the built-in row would dispatch anyway. So the package claims and then relays byte-verbatim through `host.relayUpstream`, the same transport policy every transparent forward uses.

Its model policy is the proxy-mode contract in one place: a ref the OCR catalog carries is preserved; an OpenCode-native ref it does not carry (`claude-sonnet-4-5`) lands on the configured target (`auto` by default) instead of 404ing; `forceModel` rewrites every request regardless of what the client picked.

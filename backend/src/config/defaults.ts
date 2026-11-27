import type { ReasoningEffort } from '../types/router.js';
import type { ForwardProxyRule, InterceptPosture, MihomoCustomRule } from './types.js';

/**
 * Single source of truth for magic defaults that previously lived as
 * independently-declared literals in multiple modules (config defaults,
 * runtime fallbacks, CLI fallbacks, cross-cutting guards). Import from here;
 * never re-declare the literal locally.
 */

/**
 * Gateway listen port when neither the `PORT` env lever nor a config.yaml
 * `port:` names one. Matches the packaged/desktop sidecar default
 * (`OCR_DEFAULT_PORT`, the Rust shell's `PORT`) so a bare CLI boot, the
 * install, and the console's own snippets all advertise the same number.
 * Deliberately NOT 3000: that is the default of half the JS dev tooling on a
 * workstation (Grafana, CRA, Next, Rails…) and squats the port a gateway needs.
 */
export const DEFAULT_GATEWAY_PORT = 4000;

/**
 * Listen port for `bun run dev` (scripts/dev.ts), pinned for the backend AND
 * the Vite proxy so the two can never disagree. Kept apart from
 * DEFAULT_GATEWAY_PORT on purpose: the dev stack must be able to run beside an
 * installed desktop gateway, and 4700 sits outside the crowded 3000/4000/
 * 5000/8000 dev ranges. Override with `PORT=` (bare `bun run dev` keeps this).
 */
export const DEFAULT_DEV_PORT = 4700;

/**
 * BUFFERED provider call (`createCompletion`) wall-clock cap when
 * `provider.timeoutMs` is unset — 30 MINUTES.
 *
 * Why 30 and not 2 h: a buffered call has NO progress signal, so the wall clock
 * is its only bound — and while it runs it holds the request, a credential's
 * concurrency/quota and the client's patience. A timeout is retriable, so the
 * retry budget multiplies it (`retry.inplace.maxAttempts` + the failover hops
 * ≈ 3 attempts worst case = 90 min for ONE client request). 30 min is already
 * ~3× the ceiling vendors impose on non-stream calls (Anthropic's SDK floors
 * its dynamic timeout at 10 min for a non-streaming large-max_tokens request),
 * so it never truncates a legitimate answer while it still caps a dead socket.
 * Override per provider with `provider.timeoutMs`.
 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * STREAMED provider leg (`createStream`) wall-clock cap when
 * `provider.streamTimeoutMs` is unset — 60 MINUTES.
 *
 * Deliberately larger than the buffered cap: the streamed leg carries a
 * progress signal, so liveness is enforced by `DEFAULT_STREAM_IDLE_TIMEOUT_MS`
 * (silence), and the only thing this cap must clear is the largest legitimate
 * single answer — about 128 k output tokens at a slow 50 tok/s ≈ 43 min. A
 * stream still trickling bytes past an hour is a runaway loop, not an answer.
 */
export const DEFAULT_STREAM_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * SSE idle watchdog for the streamed provider leg: abort after this long
 * WITHOUT A SINGLE BYTE (keep-alive comments and `ping` frames count as
 * progress). Five minutes of total silence means a dead connection, while a
 * long thinking phase that streams deltas never trips it — which is what lets
 * the TOTAL cap above be an hour without letting a hung socket linger.
 * Override per provider with `provider.streamIdleTimeoutMs`.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * Synthetic health-probe wall-clock bound (backend/src/resilience/health-prober.ts).
 * A 1-token liveness ping should answer in seconds, and one hung upstream must
 * never stall the whole sweep (the sweep's re-entry guard would otherwise stay
 * held). Deliberately much shorter than DEFAULT_PROVIDER_TIMEOUT_MS: a probe is
 * evidence, not serving work. Known consequence — a provider that legitimately
 * needs longer than this for a 1-token completion (long prefill / cold queue)
 * fails every probe; and because a probe timeout classifies SERVICE_UNAVAILABLE
 * at model scope, every such cycle re-OPENs EVERY existing tuple of that model
 * with a fresh escalated cooldown (not just the probed one).
 * `circuitBreaker.activeProbing` stays off by default for exactly that reason.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/**
 * One quota probe's wall clock (the DSL runner, code adapters, and the
 * plugin-host seam when the operator left `quotaProbes.settings.timeoutMs`
 * unset). Shorter than the capability probe above: quota is a meter read on a
 * key we already hold, and the cadence — not this number — decides whether a
 * slow vendor is worth waiting for. Every failed attempt keeps the previous
 * values and marks them stale, so a timeout costs a stale badge, never a
 * missing number.
 */
export const DEFAULT_QUOTA_PROBE_TIMEOUT_MS = 10_000;

/** Forward-proxy listen port when `forwardProxy.port` is unset. */
export const DEFAULT_FORWARD_PROXY_PORT = 4555;

/** Forward-proxy listen host when `forwardProxy.host` is unset (loopback only). */
export const DEFAULT_FORWARD_PROXY_HOST = '127.0.0.1';

/**
 * Fresh-install rule table (ADR-0018, Revision 4): one catch-all — blind-tunnel
 * every host and send it through the outbound proxy policy. Inert until BOTH
 * `forwardProxy.enabled` and `proxy.enabled` are on (the listener ships
 * disabled, so this seed routes nothing by itself).
 *
 * The seed is PASSTHROUGH, not intercept: interception is decided by the
 * capability set (the hosts a live client-gateway plugin claims, plus rows an
 * operator writes `ingress: intercept`), so a seed that decrypted everything
 * made ~92% of a real machine's TLS a side effect of installing a gateway —
 * with the trust store of every non-Bun TLS stack (IDEA's per-host
 * `<config>/ssl/cacerts`, pinned clients) as the blast radius. `reject` is
 * never seeded — shipping a blocklist would break traffic nobody asked to
 * block.
 */
export const DEFAULT_FORWARD_PROXY_RULES: ForwardProxyRule[] = [
  { match: '*', ingress: 'passthrough', egress: 'proxy' },
];

/**
 * Forward-proxy interception posture when `forwardProxy.intercept` is unset or
 * unreadable (ADR-0018 Revision 4): decrypt only what a capability declares
 * (plugin claims + explicit `ingress: intercept` rows); everything else is a
 * blind tunnel. `'all'` is the explicit audit posture and is never a default.
 */
export const DEFAULT_FORWARD_PROXY_INTERCEPT: InterceptPosture = 'claims';

/** Forward-proxy access log: day-file retention for the persisted JSONL (auto-cleanup). */
export const DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS = 7;
/**
 * Forward-proxy access log: per-side INLINE capture cap when
 * `forwardProxy.accessLog.bodyBytes` is unset (1 MiB). Bounds the memory ring
 * and the JSONL rows — a browsing proxy otherwise buffers whole downloads in
 * the heap. A body that outgrows the cap spills to a raw body file while
 * persistence is on, so the default costs no captured bytes.
 */
export const DEFAULT_PROXY_ACCESS_LOG_BODY_BYTES = 1_048_576;
/**
 * Traffic feed display windows. TWO numbers, two different costs:
 * - DISSECT — the per-side prefix the read path hands the plugin dissector.
 *   The route allocates only `min(fileSize, window)` per side, so the cost
 *   tracks the bodies actually on disk (most rows are kilobytes), not the
 *   window itself; 256 KiB is the compromise between protocol visibility and
 *   the per-row read the 500-row tail pays on every poll.
 * - BODY PREVIEW — the most the console renders of a body it loads through
 *   the opaque token. Paid once, on drawer open, and the row payload never
 *   carries it, so it can be generous (1 MiB — the proxy log's inline budget).
 * Bodies beyond either window are one download away
 * (`/api/admin/traffic-body/:token`).
 */
export const DEFAULT_TRAFFIC_DISSECT_WINDOW_BYTES = 262_144;
export const DEFAULT_TRAFFIC_BODY_PREVIEW_BYTES = 1_048_576;
/** Day-file retention clamp bounds (config input is clamped into this range). */
export const PROXY_ACCESS_LOG_PERSIST_DAYS_MIN = 1;
export const PROXY_ACCESS_LOG_PERSIST_DAYS_MAX = 365;

/**
 * Forward-proxy concurrent-socket cap when `forwardProxy.maxConnections` is
 * unset. Every accepted socket holds an fd and, once MITM'd, a loopback peer —
 * an unbounded listener is a local fd-exhaustion vector (one client can open
 * CONNECTs faster than the OS reclaims them).
 */
export const DEFAULT_FORWARD_PROXY_MAX_CONNECTIONS = 512;
/** Connection-cap clamp bounds (config input is clamped into this range). */
export const FORWARD_PROXY_MAX_CONNECTIONS_MIN = 16;
export const FORWARD_PROXY_MAX_CONNECTIONS_MAX = 8192;


/**
 * Mihomo (Clash Meta) mixed-port when `proxy.mihomo.mixedPort` is unset.
 * The gateway's outbound calls use `http://127.0.0.1:<mixedPort>` while
 * `proxy.mode` is `mihomo` (ADR-0022). 7890 is mihomo's own default.
 */
export const DEFAULT_MIHOMO_MIXED_PORT = 7890;

/** External-controller port when `proxy.mihomo.controllerPort` is unset. */
export const DEFAULT_MIHOMO_CONTROLLER_PORT = 9090;

/** Selector group written into the generated mihomo config. */
export const DEFAULT_MIHOMO_GROUP = 'PROXY';

/**
 * Subscription refresh interval (seconds) when a subscription omits `interval`.
 * Mihomo's proxy-provider `interval` is seconds. Clamped on load.
 */
export const DEFAULT_MIHOMO_SUB_INTERVAL_SEC = 3600;
export const MIHOMO_SUB_INTERVAL_MIN_SEC = 300;
export const MIHOMO_SUB_INTERVAL_MAX_SEC = 86_400;

/**
 * Delay-test cadence (seconds) for an automatic group (`url-test` / `fallback`)
 * when `proxy.mihomo.groupInterval` is unset. The interval is the failure
 * DETECTION window, not just a display refresh: a member that dies stays
 * selected — and its latency reading stays stale — until the next cycle, so a
 * dead node costs up to one interval of real traffic. Mihomo's own 300 s
 * default leaves that window at five minutes; the gateway ships one minute.
 */
export const DEFAULT_MIHOMO_GROUP_INTERVAL_SEC = 60;
/**
 * Bounds for `proxy.mihomo.groupInterval`. Every cycle issues one real request
 * per member THROUGH that member, so 30 s is the fastest cadence that still
 * leaves a subscription-sized node list alone (mihomo's runner up is 10 s).
 */
export const MIHOMO_GROUP_INTERVAL_MIN_SEC = 30;
export const MIHOMO_GROUP_INTERVAL_MAX_SEC = 86_400;
/** How much faster (ms) a candidate must be before `url-test` switches. */
export const DEFAULT_MIHOMO_GROUP_TOLERANCE_MS = 50;
/** Upper bound for `proxy.mihomo.groupTolerance`: past a few seconds the
 *  tolerance stops describing jitter and starts describing an outage. */
export const MIHOMO_GROUP_TOLERANCE_MAX_MS = 5000;

/**
 * URL mihomo fetches for group health checks and console delay tests. This is
 * mihomo's own `DefaultTestURL` — a 204 endpoint (no body, one RTT) and the
 * de-facto Clash-ecosystem convention — and it is configurable because it must
 * be reachable from the machine AND through the nodes (a global default is not
 * reachable everywhere).
 */
export const DEFAULT_MIHOMO_TEST_URL = 'https://www.gstatic.com/generate_204';

/**
 * Baseline direct rules shipped with the generated Clash config (ADR-0022):
 * loopback, RFC1918, CGNAT, link-local and the IPv6 ULA / link-local ranges
 * must never enter the tunnel. They are the only direct defaults the gateway
 * can guarantee without a geo database — `GEOIP`/`GEOSITE` rows need downloaded
 * data files and are offered as an explicit console preset instead.
 *
 * Seeded into `proxy.mihomo.rules` only while that key is absent. Once the
 * operator touches the list (including deleting every row) the saved list is
 * authoritative and the defaults never come back on their own.
 */
export const MIHOMO_LAN_DIRECT_RULES: MihomoCustomRule[] = [
  { type: 'IP-CIDR', payload: '127.0.0.0/8', target: 'DIRECT', source: 'default' },
  { type: 'IP-CIDR', payload: '10.0.0.0/8', target: 'DIRECT', source: 'default' },
  { type: 'IP-CIDR', payload: '172.16.0.0/12', target: 'DIRECT', source: 'default' },
  { type: 'IP-CIDR', payload: '192.168.0.0/16', target: 'DIRECT', source: 'default' },
  { type: 'IP-CIDR', payload: '169.254.0.0/16', target: 'DIRECT', source: 'default' },
  { type: 'IP-CIDR', payload: '100.64.0.0/10', target: 'DIRECT', source: 'default' },
  { type: 'IP-CIDR6', payload: '::1/128', target: 'DIRECT', source: 'default' },
  { type: 'IP-CIDR6', payload: 'fc00::/7', target: 'DIRECT', source: 'default' },
  { type: 'IP-CIDR6', payload: 'fe80::/10', target: 'DIRECT', source: 'default' },
];

/**
 * One-click "CN direct" preset, inserted only when the operator asks for it
 * (ADR-0022). Deliberately NOT a default: the core's rules apply to EVERY
 * client of the mixed port, including forward-proxy rows whose `egress` is
 * `proxy`, so a blanket domestic-bypass rule would silently leak traffic the
 * operator explicitly routed through the exit.
 *
 * Both rows need the geo databases; the download is an explicit console action
 * and the core refuses to start with these rows before the files exist.
 */
export const MIHOMO_CN_DIRECT_RULES: MihomoCustomRule[] = [
  { type: 'GEOSITE', payload: 'cn', target: 'DIRECT', source: 'preset' },
  { type: 'GEOIP', payload: 'CN', target: 'DIRECT', source: 'preset' },
];

/**
 * Age at which the console marks the installed geo databases stale and
 * suggests a re-sync (ADR-0022). Advisory only: nothing refetches on its own
 * and a core with older data still starts — the operator's sync is the only
 * thing that moves the files.
 */
export const MIHOMO_GEO_STALE_DAYS = 30;

/**
 * TCP reachability probe budget for the console's add-node dialog (ms). This
 * is a connect() deadline, not a delay measurement: the node is not in the
 * running config yet, so the core cannot route through it.
 */
export const MIHOMO_NODE_PROBE_TIMEOUT_MS = 5000;

/**
 * Budget for one delay measurement through the core (ms), shared by the
 * console's per-node, batch and URL probes and by the controller client's own
 * default. It is the round-trip deadline AND the cut-off for calling a row
 * "timeout": mihomo answers a dead node with delay 0, so a measurement can
 * only be trusted when it finishes inside this budget.
 */
export const MIHOMO_DELAY_TIMEOUT_MS = 5000;

/** Headroom sidecar port (and base URL) when `compression.headroom.url` is unset. */
export const DEFAULT_HEADROOM_PORT = 8787;
export const DEFAULT_HEADROOM_URL = `http://127.0.0.1:${DEFAULT_HEADROOM_PORT}`;

/** Headroom call timeout when `compression.headroom.timeoutMs` is unset. */
export const DEFAULT_HEADROOM_TIMEOUT_MS = 3000;

/** Per-body capture cap when `requestCapture.maxBodyBytes` is unset (16 MB —
 * sized for a fully-loaded 2M-token context). This bounds what the ARCHIVE
 * stores, never what the gateway ACCEPTS — see GATEWAY_MAX_BODY_BYTES. */
export const DEFAULT_MAX_BODY_BYTES = 16_777_216;

/**
 * Field budget for the outbound OpenAI Responses `call_id` (`ir/adapters/openai-responses.ts`
 * `responsesCallId`). The value arriving here is NOT ours: a chat client owns
 * `tool_calls[].id`, and the cursor-gateway plugin's agent loop re-injects the id the
 * PREVIOUS upstream minted (its `tc.id`; plugins are a gitignored tree outside this
 * source, so it is a name to grep in `plugins/`, not a tracked path), so a cascade that
 * starts on a verbose provider and lands on a
 * Responses-compatible one replays an id the new upstream never issued. Such
 * upstreams field-validate this string and answer 400 — a breach is silent to
 * the client (it sees an opaque failure of its own agent loop) and unfixable
 * from the client side, because nothing about the payload is wrong.
 *
 * 64 is the strictest bound of that family we have evidence for. An id already inside
 * it AND inside the shared charset `[A-Za-z0-9_-]` leaves byte-identical (see the
 * projection invariant on
 * `responsesCallId`); an id outside either is replaced by a `sha256` digest that fits —
 * `call_` + 59 hex, so 236 bits and the shape consumers key on survives. Truncating
 * the ORIGINAL is deliberately not the fallback: ids sharing a prefix would merge
 * two tool results onto one call with no error on any leg. That is also why this
 * number is a hard bound rather than something to raise: it is the strictest
 * outbound Responses shape OCR has evidence for, not an inconvenience to widen.
 */
export const RESPONSES_CALL_ID_MAX_LEN = 64;

/**
 * Field budget for a Responses ITEM id body — the `fc_` / `ctc_` prefix is added
 * in front of at most this many characters, so a digested item id is 48 hex + 3 = 51
 * in total (see `responsesToolItemId`). Declared
 * beside {@link RESPONSES_CALL_ID_MAX_LEN} because the two limits differ and one
 * adapter reads both: a correlation id may sit at the full 64, while an item id
 * must leave room for its item-type prefix. Where an id does not fit, the DIGEST
 * is what gets shortened (48 hex chars = 192 bits, no realistic collision) — never
 * the original string, which would merge two ids sharing a prefix.
 */
export const RESPONSES_TOOL_ITEM_ID_MAX_LEN = 48;

/**
 * Request-body admission cap for inference traffic, ONE value for BOTH legs:
 * the native Fastify routes (route `bodyLimit`) and the MITM/node-http leg
 * (`surfaces/transport-node-http.ts` reads it, `forward-proxy/h2-forward.ts`
 * bounds its h2 preface buffer with it). 32 MiB — the value ADR-0008 documents
 * for the proxy, and the ceiling a 2M-token context plus base64 attachments
 * needs (an agent upload of several MB is normal traffic here, and the capture
 * plane is already sized for 16 MB bodies untruncated).
 *
 * WHY IT IS NOT `DEFAULT_MAX_BODY_BYTES`: that constant is the capture
 * truncation window and is operator-tunable (`requestCapture.maxBodyBytes`).
 * Wiring an admission gate to a storage cap means raising what the operator is
 * willing to RECORD silently changes what the gateway is willing to SERVE —
 * two independent policies that must never share a number.
 */
export const GATEWAY_MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Request-body admission cap for the ADMIN plane (console/API routes), applied as
 * the Fastify INSTANCE default in `server.ts` — that placement is the point:
 * Fastify's own instance default is 1 MiB, and a route that forgets to declare a
 * limit silently inherits it. `POST /api/admin/config/raw` is exactly such a
 * route: its body is the WHOLE `config.yaml` as a string, so an operator with a
 * large config got `413 "Payload Too Large"` from the framework, in an envelope the
 * console could not even name.
 *
 * 8 MiB, deliberately NOT `GATEWAY_MAX_BODY_BYTES`: a config, preset, rule set or
 * harness manifest is kilobytes-to-low-megabytes, and the ceiling a client can
 * push at the model plane has no business applying to the control plane. Keeping
 * the tiers separate is what makes the answer to "why did that request get 413?"
 * explainable. Bodies that really are big already declare their own cap per route
 * (`IMPORT_BODY_LIMIT_BYTES`, `PLUGIN_PACKAGE_MAX_BYTES`).
 */
export const ADMIN_MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Bounds for the operator-tunable admission caps (`client.bodyLimits`), enforced by
 * the config cleaner so a typo cannot turn the gateway into a memory sponge or
 * make it refuse traffic it can no longer serve.
 *
 * 64 KiB floor: below that even a modest chat request with a short system prompt is
 * rejected, so a smaller number is always a mistake rather than a policy.
 * 512 MiB ceiling: 16x the shipped inference default. The cap is what a request may
 * hold IN MEMORY while it is admitted, so the ceiling is a durability limit on the
 * gateway itself, not a statement about models; an operator who genuinely needs
 * more than this is describing a different product (streaming spooling), not a
 * config value.
 */
export const BODY_LIMIT_MIN_BYTES = 64 * 1024;
export const BODY_LIMIT_MAX_BYTES = 512 * 1024 * 1024;

/** Forward-proxy hang protection: upstream socket timeout applied until
 * response headers arrive (blackholed-peer guard). */
export const FORWARD_PROXY_HANG_TIMEOUT_MS = 60_000;

/**
 * INBOUND liveness bounds, declared once and SET EXPLICITLY on every listener the
 * gateway owns. Leaving them to the runtime is not a neutral choice: Node ships
 * `requestTimeout` 300s / `headersTimeout` 60s / `keepAliveTimeout` 5s, Bun ships
 * none of them, so the same slow or half-open client holds a socket forever on one
 * runtime and is reaped on the other. That is the same class of bug as the original
 * 413 — an invisible runtime default deciding gateway policy (here: which clients
 * get served) — so the values are named, and they match Node's shipped numbers
 * deliberately: on Node this changes nothing, it makes the behavior on Bun the
 * behavior on Node instead of undefined.
 *
 * `REQUEST_BODY_IDLE_TIMEOUT_MS` is the bound the server-level timeouts cannot
 * express: `requestTimeout` measures the WHOLE request, so a client that trickles
 * one byte per minute never trips it on either runtime. This one is armed per chunk
 * in `readRequestBody`, so a stalled upload is refused with 408 while the ceiling
 * still guards the size axis.
 */
export const SERVER_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
export const SERVER_HEADERS_TIMEOUT_MS = 60_000;
export const SERVER_KEEP_ALIVE_TIMEOUT_MS = 5_000;
export const REQUEST_BODY_IDLE_TIMEOUT_MS = 60_000;

/** Forward-proxy tunnel keepalive: TCP probe interval armed on both sides of
 * every relayed connection (blind tunnels and `Upgrade:` relays). There is no
 * application-level idle timeout — a tunnel may legitimately carry a silent
 * protocol (IMAP IDLE) — so this is what reaps a peer that vanished without
 * FIN/RST. */
export const FORWARD_PROXY_KEEPALIVE_MS = 60_000;

/** Layer-2 decision layer timeout when `classifier.layer2.timeoutMs` is unset. */
export const DEFAULT_LAYER2_TIMEOUT_MS = 5000;

/**
 * Lowest thinking level the L2 decision layer may assign when
 * `classifier.layer2.effortDecision` is on (ADR-0011). A client-explicit ask is
 * never overridden at all; this floor only bounds the model's OWN choice, so a
 * classifier mistake can never silently strip thinking from a turn.
 */
export const DEFAULT_LAYER2_EFFORT_FLOOR: ReasoningEffort = 'low';

/** Native System One decision passthrough timeout when `provider.timeoutMs` is unset. */
export const DEFAULT_SYSTEMONE_NATIVE_TIMEOUT_MS = 120_000;

/** Console smart-assign decider hard deadline — requests must not hang on a dead upstream. */
export const SMART_ASSIGN_TIMEOUT_MS = 60_000;

/** Reserved `@ocr-*` directive namespace when `directives.prefix` is unset. */
export const DEFAULT_DIRECTIVE_PREFIX = '@ocr-';

/** Route-entries LRU capacity when `routeEntries.maxEntries` is unset. */
export const DEFAULT_ROUTE_ENTRIES_MAX = 5000;

/** Capture-replay one-shot upstream hard deadline — streaming thinking
 *  models legitimately run minutes; 30s aborted healthy generations. */
export const DEFAULT_REPLAY_TIMEOUT_MS = 300_000;

/** Upper bound for a per-credential spread weight (integers >= 1; absence = 1).
 *  Weights only shape the NEW-session hash spread — they never touch the
 *  ratchet, failover order, or the sync boundary. */
export const CREDENTIAL_WEIGHT_MAX = 100;

/** Plugin package (.zip) upload cap — route bodyLimit and the handler's
 *  413 check both read this so they can never desync. */
export const PLUGIN_PACKAGE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Follow-catalog auto-resync debounce (event-driven, not a poll).
 * Key-policy edits coalesce quickly; pool rebuilds (catalog auto-pull storms)
 * wait longer so one rewrite covers a burst of defs/credential mutations.
 */
export const FOLLOW_CATALOG_KEY_DEBOUNCE_MS = 300;
export const FOLLOW_CATALOG_POOL_DEBOUNCE_MS = 2_000;

/** Default for `client.autoResyncFollowCatalogs` — lazy-operator default ON. */
export const DEFAULT_AUTO_RESYNC_FOLLOW_CATALOGS = true;


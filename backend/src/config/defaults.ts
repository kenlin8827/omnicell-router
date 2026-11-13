import type { ReasoningEffort } from '../types/router.js';
import type { ForwardProxyRule } from './types.js';

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

/** Provider upstream request timeout when `provider.timeoutMs` is unset. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 300_000;

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

/** Forward-proxy listen port when `forwardProxy.port` is unset. */
export const DEFAULT_FORWARD_PROXY_PORT = 4555;

/** Forward-proxy listen host when `forwardProxy.host` is unset (loopback only). */
export const DEFAULT_FORWARD_PROXY_HOST = '127.0.0.1';

/**
 * Fresh-install rule table (ADR-0018): one catch-all — intercept everything and
 * send it through the outbound proxy policy. Inert until BOTH
 * `forwardProxy.enabled` and `proxy.enabled` are on (the listener ships
 * disabled, so this seed routes nothing by itself); it exists so an operator who
 * turns the proxy on gets the posture they almost certainly wanted (a blocked
 * network) instead of a silent direct egress. `reject` is never seeded —
 * shipping a blocklist would break traffic nobody asked to block.
 */
export const DEFAULT_FORWARD_PROXY_RULES: ForwardProxyRule[] = [
  { match: '*', ingress: 'intercept', egress: 'proxy' },
];

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

/** Headroom sidecar port (and base URL) when `compression.headroom.url` is unset. */
export const DEFAULT_HEADROOM_PORT = 8787;
export const DEFAULT_HEADROOM_URL = `http://127.0.0.1:${DEFAULT_HEADROOM_PORT}`;

/** Headroom call timeout when `compression.headroom.timeoutMs` is unset. */
export const DEFAULT_HEADROOM_TIMEOUT_MS = 3000;

/** Per-body capture cap when `requestCapture.maxBodyBytes` is unset (16 MB —
 * sized for a fully-loaded 2M-token context). */
export const DEFAULT_MAX_BODY_BYTES = 16_777_216;

/** Forward-proxy hang protection: upstream socket timeout applied until
 * response headers arrive (blackholed-peer guard). */
export const FORWARD_PROXY_HANG_TIMEOUT_MS = 60_000;

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


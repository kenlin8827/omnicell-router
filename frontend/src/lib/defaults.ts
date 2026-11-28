/**
 * Frontend mirrors of backend runtime defaults (backend/src/config/defaults.ts).
 * The console has no bootstrap-time config before the first `/api/config`
 * round-trip, so these fallbacks exist for empty-config rendering. When a
 * backend default changes, update the mirror here in the same commit.
 */

/** `requestCapture.maxBodyBytes` backend default (16 MB per body). */
export const DEFAULT_MAX_BODY_BYTES = 16_777_216;

/** `forwardProxy.port` backend default. */
export const DEFAULT_FORWARD_PROXY_PORT = 4555;

/** `forwardProxy.host` backend default (loopback only). */
export const DEFAULT_FORWARD_PROXY_HOST = '127.0.0.1';

/** `forwardProxy.maxConnections` backend default (concurrent proxied exchanges).
 *  Mirrors backend `DEFAULT_FORWARD_PROXY_MAX_CONNECTIONS` (backend/src/config/defaults.ts). */
export const DEFAULT_FORWARD_PROXY_MAX_CONNECTIONS = 512;

/** `forwardProxy.accessLog.persistDays` backend default (day-file retention). */
export const DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS = 7;

/** `forwardProxy.accessLog.bodyBytes` backend default (per-side inline cap, 1 MiB). */
export const DEFAULT_PROXY_ACCESS_LOG_BODY_BYTES = 1_048_576;

/** Traffic feed drawers render at most this many bytes of a token-addressed
 *  body — mirrors backend `DEFAULT_TRAFFIC_BODY_PREVIEW_BYTES`
 *  (backend/src/config/defaults.ts, 1 MiB). The backend's DISSECTOR window is
 *  a separate number (`DEFAULT_TRAFFIC_DISSECT_WINDOW_BYTES`, 256 KiB) and
 *  allocates only `min(fileSize, window)` per side, so it is a ceiling rather
 *  than a fixed per-row cost. Update both copies in the same commit. */
export const DEFAULT_TRAFFIC_BODY_PREVIEW_BYTES = 1_048_576;
/** `persistDays` clamp bounds — mirrors backend
 *  `PROXY_ACCESS_LOG_PERSIST_DAYS_MIN/MAX` (backend/src/config/defaults.ts). */
export const PROXY_ACCESS_LOG_PERSIST_DAYS_MIN = 1;
export const PROXY_ACCESS_LOG_PERSIST_DAYS_MAX = 365;

/** `compression.headroom.url` backend default (loopback-only sidecar). */
export const DEFAULT_HEADROOM_URL = 'http://127.0.0.1:8787';

/** `proxy.mihomo.mixedPort` backend default (ADR-0022). */
export const DEFAULT_MIHOMO_MIXED_PORT = 7890;

/** `proxy.mihomo.controllerPort` backend default. */
export const DEFAULT_MIHOMO_CONTROLLER_PORT = 9090;

/** `proxy.mihomo.selectedGroup` backend default. */
export const DEFAULT_MIHOMO_GROUP = 'PROXY';

/** Subscription refresh interval (seconds) when unset. */
export const DEFAULT_MIHOMO_SUB_INTERVAL_SEC = 3600;

/**
 * `proxy.mihomo.groupInterval` backend default (seconds, automatic groups).
 * The interval is the failure-detection window, so it ships at one minute
 * instead of mihomo's five.
 */
export const DEFAULT_MIHOMO_GROUP_INTERVAL_SEC = 60;

/** Backend bounds for `proxy.mihomo.groupInterval` (seconds). */
export const MIHOMO_GROUP_INTERVAL_MIN_SEC = 30;
export const MIHOMO_GROUP_INTERVAL_MAX_SEC = 86400;


/** `proxy.mihomo.groupTolerance` backend default and upper bound (ms,
 *  `url-test` only). */
export const DEFAULT_MIHOMO_GROUP_TOLERANCE_MS = 50;
export const MIHOMO_GROUP_TOLERANCE_MAX_MS = 5000;

/** `proxy.mihomo.testUrl` backend default (mihomo's 204 health-check URL). */
export const DEFAULT_MIHOMO_TEST_URL = 'https://www.gstatic.com/generate_204';

/** `directives.prefix` backend default (`@ocr-*` reserved namespace). */
export const DEFAULT_DIRECTIVE_PREFIX = '@ocr-';

/** `client.autoResyncFollowCatalogs` backend default (event-driven follow catalog rewrite). */
export const DEFAULT_AUTO_RESYNC_FOLLOW_CATALOGS = true;

/** Packaged gateway port — mirrors backend `DEFAULT_GATEWAY_PORT`
 *  (backend/src/config/defaults.ts), which in turn matches `OCR_DEFAULT_PORT`
 *  (backend/src/cli/clients/base.ts). Last-resort fallback for console
 *  snippets when neither the status poll nor the page origin can report the
 *  real listening port (config.yaml `port` is the source of truth). */
export const DEFAULT_GATEWAY_PORT = 4000;

/** `bun run dev` listen port — mirrors backend `DEFAULT_DEV_PORT`. The Vite
 *  proxy falls back to this when `PORT` is absent (running the frontend alone),
 *  so the console never proxies to a port the dev backend does not own.
 *  Update both copies in the same commit. */
export const DEFAULT_DEV_PORT = 4700;

/** `circuitBreaker.activeProbing.intervalMs` backend default — mirrors backend
 *  `DEFAULT_PROBE_INTERVAL_MS` (backend/src/utils/probe-interval.ts, shared by
 *  the health prober and the quota prober). */
export const DEFAULT_PROBE_INTERVAL_MS = 60_000;

/** Longest 429 Retry-After wait the in-place retry path may sleep out — mirrors
 *  backend `DEFAULT_MAX_RATE_LIMIT_WAIT_MS` (backend/src/resilience/circuit-breaker.ts).
 *  The breaker's hard/counted boundary borrows it (trip.rateLimit.hardTripAboveMs). */
export const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 2000;

/** Floor of any Retry-After-derived 429 cooldown — mirrors backend
 *  `RATE_LIMIT_MIN_COOLDOWN_MS` (backend/src/resilience/circuit-breaker.ts). */
export const RATE_LIMIT_MIN_COOLDOWN_MS = 1000;

/** Cap of the no-Retry-After 429 counted floor — mirrors backend
 *  `RATE_LIMIT_NO_RETRY_AFTER_CAP_MS` (backend/src/resilience/circuit-breaker.ts).
 *  The effective floor is `min(this, initialCooldownMs)`. */
export const RATE_LIMIT_NO_RETRY_AFTER_CAP_MS = 60_000;

/** Upper bound for a per-credential spread weight — mirrors backend
 *  `CREDENTIAL_WEIGHT_MAX` (backend/src/config/defaults.ts). Integers >= 1;
 *  absence = 1. Weights only shape the NEW-session hash spread. */
export const CREDENTIAL_WEIGHT_MAX = 100;

/** DSH profile-name rule — mirrors backend `DSH_PROFILE_NAME`
 *  (backend/src/harness/host/adapters/dsh.ts, applied by `dshProfileError`). The backend stays
 *  authoritative; this copy exists only so the console's "Custom…" field can refuse a name the
 *  vendor CLI would reject, instead of sending the install and showing its error. Update both in
 *  the same commit. */
export const DSH_PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Buffered provider timeout (ms) — mirrors backend `DEFAULT_PROVIDER_TIMEOUT_MS`
 *  (backend/src/config/defaults.ts). Update both in the same commit. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30 * 60 * 1000;

/** Streamed idle watchdog timeout (ms) — mirrors backend `DEFAULT_STREAM_IDLE_TIMEOUT_MS`
 *  (backend/src/config/defaults.ts). Update both in the same commit. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** The core-injected outbound-leg switch — mirrors backend
 *  `GATEWAY_EGRESS_CONFIG_KEY` / `GATEWAY_EGRESS_VALUES`
 *  (backend/src/plugins/manifest.ts). Its wording is CONSOLE chrome, not package
 *  content, so the drawer translates it from the i18n tables and therefore has
 *  to recognize the field by key and value set. Update both in the same commit;
 *  `forward-proxy-console-vocabulary-parity.test.ts` pins the two lists. */
export const GATEWAY_EGRESS_CONFIG_KEY = 'egress';
export const GATEWAY_EGRESS_VALUES = ['inherit', 'proxy', 'direct'] as const;

/** `client.bodyLimits.maxBytes` backend default (32 MiB) — mirrors
 *  `GATEWAY_MAX_BODY_BYTES` (backend/src/config/defaults.ts), the inference-plane
 *  request-body admission cap. Update both copies in the same commit. */
export const DEFAULT_GATEWAY_MAX_BODY_BYTES = 33_554_432;

/** `client.bodyLimits.adminMaxBytes` backend default (8 MiB) — mirrors
 *  `ADMIN_MAX_BODY_BYTES`, the console-plane cap (largest real payload is the
 *  raw-YAML config save). */
export const DEFAULT_ADMIN_MAX_BODY_BYTES = 8_388_608;

/** Bounds the backend clamps the two caps into — mirrors
 *  `BODY_LIMIT_MIN_BYTES` / `BODY_LIMIT_MAX_BYTES`. Out-of-range input is clamped
 *  server-side on load, so the console shows the same floor and ceiling. */
export const BODY_LIMIT_MIN_BYTES = 65_536;
export const BODY_LIMIT_MAX_BYTES = 536_870_912;

/** Member rotation weight ceiling — mirrors backend `MAX_MEMBER_WEIGHT`
 *  (backend/src/providers/selection.ts). The backend clamps every weight on
 *  read; the console clamps its inputs to the same ceiling so a displayed
 *  rotation share never diverges from the effective one. Update both in the
 *  same commit. */
export const MEMBER_WEIGHT_MAX = 1_000_000;

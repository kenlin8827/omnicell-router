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
/** `persistDays` clamp bounds — mirrors backend
 *  `PROXY_ACCESS_LOG_PERSIST_DAYS_MIN/MAX` (backend/src/config/defaults.ts). */
export const PROXY_ACCESS_LOG_PERSIST_DAYS_MIN = 1;
export const PROXY_ACCESS_LOG_PERSIST_DAYS_MAX = 365;

/** `compression.headroom.url` backend default (loopback-only sidecar). */
export const DEFAULT_HEADROOM_URL = 'http://127.0.0.1:8787';

/** `directives.prefix` backend default (`@ocr-*` reserved namespace). */
export const DEFAULT_DIRECTIVE_PREFIX = '@ocr-';

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

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

/** `compression.headroom.url` backend default (loopback-only sidecar). */
export const DEFAULT_HEADROOM_URL = 'http://127.0.0.1:8787';

/** `directives.prefix` backend default (`@ocr-*` reserved namespace). */
export const DEFAULT_DIRECTIVE_PREFIX = '@ocr-';

/** Packaged gateway port — mirrors backend `OCR_DEFAULT_PORT`
 *  (backend/src/cli/clients/base.ts). Last-resort fallback for console
 *  snippets when neither the status poll nor the page origin can report the
 *  real listening port (config.yaml `port` is the source of truth; its
 *  in-code default 3000 applies to bare `bun run dev` only). */
export const DEFAULT_GATEWAY_PORT = 4000;

/** Upper bound for a per-credential spread weight — mirrors backend
 *  `CREDENTIAL_WEIGHT_MAX` (backend/src/config/defaults.ts). Integers >= 1;
 *  absence = 1. Weights only shape the NEW-session hash spread. */
export const CREDENTIAL_WEIGHT_MAX = 100;

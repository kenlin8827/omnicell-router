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

/** `compression.headroom.url` backend default (loopback-only sidecar). */
export const DEFAULT_HEADROOM_URL = 'http://127.0.0.1:8787';

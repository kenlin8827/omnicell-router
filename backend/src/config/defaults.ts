import type { ReasoningEffort } from '../types/router.js';

/**
 * Single source of truth for magic defaults that previously lived as
 * independently-declared literals in multiple modules (config defaults,
 * runtime fallbacks, CLI fallbacks, cross-cutting guards). Import from here;
 * never re-declare the literal locally.
 */

/** Provider upstream request timeout when `provider.timeoutMs` is unset. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 300_000;

/** Forward-proxy listen port when `forwardProxy.port` is unset. */
export const DEFAULT_FORWARD_PROXY_PORT = 4555;

/** Forward-proxy listen host when `forwardProxy.host` is unset (loopback only). */
export const DEFAULT_FORWARD_PROXY_HOST = '127.0.0.1';


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

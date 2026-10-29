/**
 * Migration v0 → v1 (ADR-0016) — the COMPLETE v1 knowledge.
 *
 * This file owns everything version-specific about the v1 disk format:
 *   - `SECTION_MOVES_V1`: the disk↔runtime mapping table (the v1 layout);
 *   - `DiskConfigV1`: the grouped disk type;
 *   - the migration itself (the legacy flat layout → v1 transform).
 *   1. renames the legacy `adminApiKey` master key to `adminKey`
 *      (disk: `client.adminKey`; env lever `ROUTER_API_KEY` stays a legacy
 *      fallback for the new `OCR_ADMIN_KEY`);
 * runtime-shaped layout with NO `schemaVersion` key. The step:
 *   2. regroups the flat sections into the six semantic groups
 *      (client / protocol / routing / upstream / resilience / ops);
 *   3. renames `routing.mode` → `routing.strategy`,
 *      `clientProfileMemory` → `routing.profileMemory`,
 *      `fallback` → `resilience.retry.escalation`.
 *
 * FROZEN after release: later schema versions MUST NOT edit this file —
 * the chain v0→v1→v2→… only appends. Frozen fixtures in backend/tests
 * anchor the exact transform. schema.ts binds `SECTION_MOVES_V1` as the
 * CURRENT layout (see LATEST_LAYOUT there) — bump that pointer when v2 ships.
 */
import type {
  ApiKeyConfig,
  CatalogConfig,
  ClassifierConfig,
  ClientProfileMemoryEntry,
  ComboConfig,
  CompressionConfig,
  CredentialLimitConfig,
  DefaultModelsConfig,
  DirectivesConfig,
  ForwardProxyConfig,
  FallbackConfig,
  LoggingConfig,
  ModelProfileConfig,
  OpenCodeConfig,
  ProxyConfig,
  QuotaConfig,
  RateLimitConfig,
  RequestCaptureConfig,
  ResponsesSurfaceConfig,
  RouterConfig,
  RoutingMode,
  SessionConfig,
  StreamingConfig,
  SystemoneSurfaceConfig,
  TiersConfig,
  TracePersistConfig,
  WebAuthConfig,
} from '../types.js';
import type { CircuitBreakerConfig } from '../../resilience/types.js';
import type { RouteEntriesConfig, RetryConfig } from '../types.js';
import type { Migration } from '../schema.js';
import { toDiskConfigWith, type SectionMove } from '../layout.js';
/** Disk `resilience.retry` = the runtime retry tree + the escalation fallback. */
export type DiskRetryConfigV1 = RetryConfig & { escalation?: FallbackConfig };

/** Disk format of schemaVersion 1: six semantic groups, no legacy flat keys. */
export interface DiskConfigV1 {
  schemaVersion: number;
  client?: {
    port?: number;
    host?: string;
    adminKey?: string;
    webAuth?: WebAuthConfig;
    apiKeys?: ApiKeyConfig[];
    rateLimit?: RateLimitConfig;
    forwardProxy?: ForwardProxyConfig;
  };
  protocol?: {
    systemone?: SystemoneSurfaceConfig;
    responses?: ResponsesSurfaceConfig;
  };
  routing?: {
    strategy?: RoutingMode;
    tiers?: TiersConfig;
    classifier?: ClassifierConfig;
    session?: SessionConfig;
    directives?: DirectivesConfig;
    routeEntries?: RouteEntriesConfig;
    combos?: ComboConfig[];
    modelProfiles?: ModelProfileConfig[];
    profileMemory?: Record<string, ClientProfileMemoryEntry>;
  };
  upstream?: {
    proxy?: ProxyConfig;
    credentials?: Record<string, CredentialLimitConfig[]>;
    streaming?: StreamingConfig;
    compression?: CompressionConfig;
  };
  resilience?: {
    circuitBreaker?: CircuitBreakerConfig;
    retry?: DiskRetryConfigV1;
  };
  ops?: {
    requestCapture?: RequestCaptureConfig;
    tracePersist?: TracePersistConfig;
    logging?: LoggingConfig;
    catalog?: CatalogConfig;
    quota?: QuotaConfig;
    quotaProbes?: Record<string, unknown[]>;
    opencode?: OpenCodeConfig;
    defaultModels?: DefaultModelsConfig;
  };
}

/**
 * THE v1 layout: whole-section moves, disk path ↔ runtime path (dot paths).
 * This table IS the definition of "what the v1 disk looks like".
 */
export const SECTION_MOVES_V1: ReadonlyArray<SectionMove> = [
  ['client.port', 'port'],
  ['client.host', 'host'],
  ['client.webAuth', 'webAuth'],
  ['client.adminKey', 'adminKey'],
  ['client.apiKeys', 'apiKeys'],
  ['client.rateLimit', 'rateLimit'],
  ['client.forwardProxy', 'forwardProxy'],
  ['protocol.systemone', 'systemone'],
  ['protocol.responses', 'responses'],
  ['routing.strategy', 'routing.mode'],
  ['routing.tiers', 'tiers'],
  ['routing.classifier', 'classifier'],
  ['routing.session', 'session'],
  ['routing.directives', 'directives'],
  ['routing.routeEntries', 'routeEntries'],
  ['routing.combos', 'combos'],
  ['routing.modelProfiles', 'modelProfiles'],
  ['routing.profileMemory', 'clientProfileMemory'],
  ['upstream.proxy', 'proxy'],
  ['upstream.credentials', 'credentials'],
  ['upstream.streaming', 'streaming'],
  ['upstream.compression', 'compression'],
  ['resilience.circuitBreaker', 'circuitBreaker'],
  ['ops.requestCapture', 'requestCapture'],
  ['ops.tracePersist', 'tracePersist'],
  ['ops.logging', 'logging'],
  ['ops.catalog', 'catalog'],
  ['ops.quota', 'quota'],
  ['ops.quotaProbes', 'quotaProbes'],
  ['ops.opencode', 'opencode'],
  ['ops.defaultModels', 'defaultModels'],
];

export const migrationV0ToV1: Migration = {
  from: 0,
  to: 1,
  warn: [
    'config.yaml migrated to schemaVersion 1 (grouped format): flat top-level sections regrouped into client / protocol / routing / upstream / resilience / ops',
    'adminApiKey renamed to adminKey (disk: client.adminKey; env lever ROUTER_API_KEY kept as a legacy fallback for OCR_ADMIN_KEY)',
    'the fallback section moved to resilience.retry.escalation (keys unchanged)',
    'routing.mode renamed to routing.strategy',
    'clientProfileMemory renamed to routing.profileMemory',
  ],
  migrate: (raw) => {
    // v0 disk shape == runtime flat shape. Rename the legacy master key,
    // then group under the v1 layout. Retired-surface keys
    // (providers/models/systemoneUpstreams/rules/capture/flywheel) are NOT
    // in SECTION_MOVES_V1 and therefore vanish here; migrateConfig surfaces
    // them via legacySurfaceWarnings (boot warning).
    const flat = { ...raw } as Record<string, unknown>;
    if (flat.adminApiKey !== undefined && flat.adminKey === undefined) {
      flat.adminKey = flat.adminApiKey;
    }
    delete flat.adminApiKey;
    delete flat.schemaVersion;
    return toDiskConfigWith(SECTION_MOVES_V1, flat as Partial<RouterConfig>);
  },
};

/**
 * Boot warning for retired hand-written surfaces (ADR-0010) present in a v0
 * file: they are NOT in SECTION_MOVES_V1, so the migration drops them
 * silently — this helper lets migrateConfig say so once instead.
 */
export function legacySurfaceWarnings(raw: Record<string, unknown>): string[] {
  const hits = (['providers', 'models', 'systemoneUpstreams'] as const).filter(
    (k) => Array.isArray(raw[k]) && (raw[k] as unknown[]).length > 0
  );
  return hits.length > 0
    ? [
        `retired hand-written section(s) ${hits.map((h) => `'${h}:'`).join(' and ')} found — these surfaces were retired ` +
          `(ADR-0010); providers come from <ocrHome>/providers.json, models materialize from defs + catalog at boot. ` +
          `The section(s) are ignored and will not re-persist.`,
      ]
    : [];
}

import type { RouterConfig } from '../../src/config/types.js';
import { loadConfig } from '../../src/config/index.js';
import { createServer } from '../../src/server.js';

/**
 * Shared test seam for the post-`providers[]`-retirement world (ADR-0010):
 * production chat providers enter via `registerProvider` post-boot, so tests
 * reassemble them through the `createServer` provider-config seam. The System
 * One surface is conversion-only — there are no native decision upstreams.
 */
const CHAT_PROVIDERS = new WeakMap<object, any[]>();

export function bootServer(config: RouterConfig, mockMode = false) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createServer(config, mockMode, undefined, undefined, CHAT_PROVIDERS.get(config) ?? [] as any[]);
}

export function makeConfig(
  providers: any[],
  models: any[],
  opts: { systemone?: any; disableLayer2Classifier?: boolean } = {}
): RouterConfig {
  const base = loadConfig();
  const config = {
    ...base,
    apiKeys: [],
    models,
    ...(opts.systemone ? { systemone: opts.systemone } : {}),
    ...(opts.disableLayer2Classifier
      ? { classifier: { ...base.classifier, layer2: { ...base.classifier?.layer2, enabled: false } } }
      : {}),
    requestCapture: { ...base.requestCapture, enabled: false },
    session: { ...base.session, enabled: false },
    tracePersist: { ...base.tracePersist, enabled: false },
  } as RouterConfig;
  CHAT_PROVIDERS.set(config, providers);
  return config;
}

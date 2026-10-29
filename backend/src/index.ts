import { loadConfig, ensureDefaultConfigFile, upgradeConfigFile, getRuntimeConfigRef } from './config/index.js';
import { setPoolRefreshHook } from './providers/pool-refresh.js';
import { createServer } from './server.js';
import { ProviderRegistry } from './providers/registry.js';
import { refreshDirectPool } from './providers/boot-direct.js';
import { DispatchingProvider } from './providers/dispatch.js';
import { buildDirectPool } from './providers/boot-direct.js';
import { FinOpsTracker } from './metrics/finops-tracker.js';
import { PipelineOrchestrator } from './pipeline/orchestrator.js';

import { catalogRepository } from './opencode/catalog/repository.js';
import { initProxyConfig } from './utils/proxy.js';
import { adoptRestartParent, writeDaemonFiles } from './cli/daemon.js';
import { openFinOpsStore } from './trace/persist.js';
import { openRateLimitEventStore, getRateLimitEventLog } from './ratelimit/event-log.js';
import { openRateLimitWindowStore } from './ratelimit/window-store.js';
import { getRateLimiter } from './ratelimit/rate-limiter.js';
import { RATE_LIMIT_CHECKPOINT_INTERVAL_MS } from './config/index.js';
import { openQuotaEventStore, getQuotaEventLog } from './quota/events.js';
import { openFailureEventStore, getFailureEventLog } from './observability/failure-events.js';
import { QuotaProber, setQuotaProber, getQuotaProber } from './quota/prober.js';
import { getQuotaStore } from './quota/store.js';
import { keyHashPrefix, type CredentialStore } from './opencode/credentials/types.js';
import { getProviderNodeById } from './opencode/user-config.js';
import { getEnvPaths, resolveEnvName } from './config/env.js';
import { getWarnThrottle } from './observability/warn-throttle.js';
import { validateWebAuthStartup } from './auth/web-auth.js';
import { startForwardProxy } from './forward-proxy/index.js';
import { setForwardProxyStatus } from './forward-proxy/status.js';
import { defaultBreakerStateStore } from './resilience/breaker-state.js';
import { startHeadroomSidecar } from './compression/headroom-sidecar.js';

/**
 * Provider-defs inference baseURL (the single def truth) for ids the registry
 * never saw — a provider with no maintained model has no registry config, but
 * its defs node still anchors L-d quota-entry origin containment.
 */
function providerDefBaseUrl(providerId: string): string | undefined {
  const def = getProviderNodeById(providerId);
  const base = def?.options?.baseURL ?? def?.settings?.baseURL;
  return typeof base === 'string' && base.length > 0 ? base : undefined;
}

async function main() {
  // If this process was spawned by the UI "Restart Gateway" button, wait for
  // the old gateway to die (and take over) before booting further.
  const isRestartChild = await adoptRestartParent();

  // Active environment (book-set) — resolve FIRST: an unknown OCR_ENV /
  // dangling pointer crashes the boot here with a clear message (fail-fast,
  // never silently run on the wrong data set). Module-level path singletons
  // cache this resolution; switching envs requires a restart by design.
  const envName = resolveEnvName();
  console.log(`[OCR] env: ${envName} (config: ${getEnvPaths().configPath})`);

  // First-boot template: a fresh install gets a self-documenting config.yaml
  // (annotated DEFAULT_CONFIG) instead of silent in-memory defaults + an empty
  // raw-YAML editor. No-op when any config file already resolves.
  const cfgTemplate = ensureDefaultConfigFile();
  if (cfgTemplate.created) {
    console.log(`[OCR] No config.yaml found — wrote default template to ${cfgTemplate.path} (edit + restart to apply)`);
  }
  // Schema upgrade (ADR-0016): the ONE legacy-config migration point. Older
  // files are rewritten to the current schemaVersion before the first
  // loadConfig; a file targeting a NEWER schema fails boot (upgrade OCR).
  upgradeConfigFile();

  const config = loadConfig();
  initProxyConfig(config.proxy);

  // Headroom sidecar association (opt-in compression.headroom.autoStart):
  // probe <url>/health → adopt a running instance, else detached-spawn one.
  // Fire-and-forget — never blocks or crashes boot; the compression stage
  // stays fail-open regardless of sidecar health, and the Token Saver page
  // surfaces the live status via /api/admin/headroom/sidecar.
  const headroomCfg = config.compression?.headroom;
  if (headroomCfg?.enabled && headroomCfg.autoStart && headroomCfg.url) {
    void startHeadroomSidecar({ url: headroomCfg.url })
      .then((r) => {
        if (r.ok) {
          console.log(
            `[OCR] headroom sidecar ${r.reused ? 'adopted (already running)' : 'started'}${r.pid ? ` (pid ${r.pid})` : ''}${r.version ? ` v${r.version}` : ''}`
          );
        } else {
          console.warn(`[OCR] headroom sidecar auto-start failed: ${r.error}`);
        }
      })
      .catch((err: any) => console.warn(`[OCR] headroom sidecar auto-start threw: ${err?.message ?? err}`));
  }

  // Console webAuth boot gate — a non-loopback binding FORCES console login
  // on. Throws (crash with a clear message) on an insecure/contradictory
  // setup instead of silently serving an open admin console to the LAN.
  validateWebAuthStartup(config);

  // -1. Provider/model catalog sync (config-driven sources; defaults when unset)
  try {
    catalogRepository.applyConfig(config.catalog);
    await catalogRepository.start();
    console.log(`[OCR] Catalog synced: ${catalogRepository.lastSyncOrigin}`);
  } catch (err: any) {
    console.warn(`[OCR] Catalog sync failed (will retry on interval): ${err.message}`);
  }

  // 0.5 FinOps cumulative-totals persistence — shared SQLite file under
  //     <env.traces>/traces.db (the active environment's traces dir — the
  //     default env binds it to <ocrHome>/traces; same file the trace
  //     store uses, but an independent handle for fault isolation). On
  //     non-bun runtimes `openFinOpsStore` returns null and the tracker
  //     silently falls back to in-memory-only.
  const finopsStore = await openFinOpsStore(getEnvPaths().tracesDir);
  const tracker = new FinOpsTracker(finopsStore);
  tracker.hydrate();
  if (finopsStore) {
    const snap = tracker.getStats();
    console.log(
      `[OCR] FinOps cumulative: ${snap.totalRequests} requests / ${snap.fallbackCount} fallbacks (since ${new Date(snap.persistence.since).toISOString()})`
    );
  } else {
    console.log('[OCR] FinOps persistence: in-memory only (no bun:sqlite)');
  }

  // 0.5b Rate-limit event ledger persistence — attach the durable mirror of
  //     the triggered-cap ledger (same traces.db, independent handle) and
  //     replay last lifetime's events into the ring BEFORE the server
  //     serves traffic, so the /rate-limit page survives a restart — the
  //     moment operators actually want the history. Memory-only when the
  //     knob is off, the runtime lacks bun:sqlite, or the store fails to
  //     open: the ledger is observability, never a boot dependency.
  //     Same knob gates the limiter's WINDOW checkpoints (0.5b-bis below):
  //     both are the rateLimit.persist durability concern.
  if (config.rateLimit?.persist?.enabled !== false) {
    const rlStore = await openRateLimitEventStore(getEnvPaths().tracesDir);
    if (rlStore) {
      const replayed = getRateLimitEventLog().attachStore(rlStore);
      console.log(`[OCR] Rate-limit ledger: SQLite mirror active (${replayed} event(s) replayed)`);
    } else {
      console.log('[OCR] Rate-limit ledger: in-memory only (no bun:sqlite)');
    }

    // 0.5b-bis Window checkpoints — rehydrate last lifetime's sliding windows
    //     (must run AFTER the boot reload armed the constraints) and arm the
    //     periodic 30s checkpoint. A `1d` cost/token budget now survives a
    //     restart instead of resetting. Memory-only without bun:sqlite.
    //     Boot ordering matters: reload() HERE arms the constraint table
    //     before attachWindowStore, or every persisted row is skipped at
    //     rehydrate and the first checkpoint's deleteStale([]) would wipe
    //     them all. createServer reloads again later (idempotent swap).
    getRateLimiter().reload(config);
    const windowStore = await openRateLimitWindowStore(getEnvPaths().tracesDir);
    if (windowStore) {
      const rehydrated = getRateLimiter().attachWindowStore(windowStore);
      getRateLimiter().startCheckpointing(RATE_LIMIT_CHECKPOINT_INTERVAL_MS);
      console.log(
        `[OCR] Rate-limit windows: checkpointing active (${rehydrated} window(s) rehydrated)`
      );
    } else {
      console.log('[OCR] Rate-limit windows: memory-only (no bun:sqlite)');
    }
  } else {
    console.log('[OCR] Rate-limit ledger: persistence disabled (rateLimit.persist.enabled=false)');
  }

  // 0.5c Quota tracking: attach the quota_events durable mirror
  //     (same traces.db, independent handle — the FinOps/ledger precedent) and
  //     start the due-based prober. The prober's raw-key access is the
  //     sanctioned in-process consumer door (CredentialStore resolveKey chain
  //     contract): keys are read to build the inference-auth
  //     probe header and never leave the process except toward the entry's
  //     own disclosed host. Kill switch: quota.enabled:false. A quota failure
  //     NEVER touches breakers (probe failure != quota failure).
  const quotaEventStore = await openQuotaEventStore(getEnvPaths().tracesDir);
  if (quotaEventStore) {
    const replayed = getQuotaEventLog().attachStore(quotaEventStore);
    if (replayed > 0) console.log(`[OCR] Quota events ledger: SQLite mirror active (${replayed} event(s) replayed)`);
  }

  // 0.5d Failure-events ledger: attach the durable mirror (same traces.db,
  //     independent handle — the quota_events precedent) and replay last
  //     lifetime's failures into the ring BEFORE traffic. Memory-only when
  //     bun:sqlite is unavailable: observability, never a boot dependency.
  const failureEventStore = await openFailureEventStore(getEnvPaths().tracesDir);
  if (failureEventStore) {
    const replayed = getFailureEventLog().attachStore(failureEventStore);
    if (replayed > 0) console.log(`[OCR] Failure events ledger: SQLite mirror active (${replayed} event(s) replayed)`);
  }

  // 0.6 Bind the credential store (ALWAYS the OCR file) and initialize the
  //     credential-sync engine BEFORE the direct pool builds —
  //     a one-shot migration pulls opencode-v2-db-only keys into the OCR file
  //     so the store flip never breaks routing, auto-sync timers arm, and the
  //     auto-write hook attaches to the bound store. Never crashes boot:
  //     sync failures land as recorded outcomes on credential-sync.json.
  //     The handle is kept for the quota prober's activation source (below):
  //     quota activation follows CREDENTIALS, not model registration.
  let credentialStore: CredentialStore | undefined;
  try {
    const { getCredentialStore, initCredentialSync } = await import('./opencode/credentials/index.js');
    credentialStore = await getCredentialStore();
    await initCredentialSync(credentialStore);
  } catch (err: any) {
    console.warn(`[OCR] credential store bind / sync init failed (boot continues): ${err?.message ?? err}`);
  }

  let registry: ProviderRegistry;
  try {
    const boot = await buildDirectPool();
    config.models = boot.models;

    // An EMPTY direct pool boots an EMPTY registry on purpose: the console
    // model list stays empty and the guardrails matrix guides the operator to
    // connect a provider — mock tier models are a TEST surface (e2e-capture,
    // createServer(mockMode)), never a production fallback.
    registry = new ProviderRegistry(config, false);
    for (const inst of boot.instances) {
      // the credential chain rides straight into the
      // registry (raw keys stay in-process; no console/API serialization).
      registry.registerProvider(
        inst.name,
        new DispatchingProvider(inst.config, inst.wireBases),
        inst.credentialChain,
        inst.config
      );
    }
    console.log(
      `[OCR] Direct pool: ${boot.instances.length} providers / ${boot.models.length} models (no daemon)`
    );
    // Background producers (catalog auto-pull) resync the pool through this
    // hook — same builder, same fail-open contract, no import cycles.
    setPoolRefreshHook(() => refreshDirectPool(registry));
    const providerLevel = boot.excluded.filter((e) => !e.model);
    const modelLevel = boot.excluded.filter((e) => e.model);
    for (const ex of providerLevel) console.log(`[OCR]   excluded ${ex.provider}: ${ex.reason}`);
    if (modelLevel.length > 0)
      console.log(`[OCR]   ${modelLevel.length} models excluded (non-text wire/modality), e.g. ${modelLevel.slice(0, 3).map((e) => e.model).join(', ')}`);
  } catch (err: any) {
    console.warn(`[OCR] Direct pool build failed, booting an EMPTY registry (no chat providers): ${err.message}`);
    registry = new ProviderRegistry(config, false);
    setPoolRefreshHook(() => refreshDirectPool(registry));
  }

  // breaker memory: attach the on-disk
  // store and resume last lifetime's cooldowns / backoff / manual trips.
  // Attached AFTER every config model is registered, so the restore can
  // drop records for models the current config no longer knows (self-clean,
  // no ghost breakers) and skip OPEN records whose trip rule is now disabled
  // (rules-config invariant 2). The flush debounce is config-driven
  // (circuitBreaker.persistence.debounceMs). A store failure never blocks
  // boot: the gateway falls back to the pre-amendment in-memory behavior.
  const breakerStore = defaultBreakerStateStore({
    debounceMs: config.circuitBreaker?.persistence?.debounceMs,
  });
  const cbManager = registry.getCircuitBreakerManager();
  cbManager.attachStateStore(breakerStore);
  try {
    const restored = cbManager.restoreState();
    if (restored.pairs) {
      console.log(
        `[OCR] Breaker memory restored (${breakerStore.filePath}): ` +
          `${restored.pairs} tuple breaker(s)`
      );
    }
  } catch (err: any) {
    console.warn(`[OCR] breaker memory restore failed (boot continues in-memory): ${err?.message ?? err}`);
  }

  const orchestrator = new PipelineOrchestrator(config, registry, tracker);

  // Quota prober: coverage ships with the release, activation
  // follows credentials — the bound credential store is the activation source
  // (ADR-0009 §1: a covered provider whose model list is still empty holds
  // probed credentials all the same), with the registry chain and the
  // config-baked inference key (chain-less degeneracy) as fallbacks. Raw keys
  // are read through the store's in-process consumer door; the prober
  // serializes only display-safe snapshots.
  if (config.quota?.enabled !== false) {
    const quotaProber = new QuotaProber({
      registry: {
        getCredentialChain: (name) => registry.getCredentialChain(name),
        getProviderApiKey: (name) => registry.getProviderConfig(name)?.apiKey,
        // L-d origin containment anchor: a model-less provider has no registry
        // config, so fall back to its provider-defs node (the single def truth).
        getProviderBaseUrl: (name) => registry.getProviderConfig(name)?.baseUrl ?? providerDefBaseUrl(name),
        listStoredCredentials: (name) => {
          if (!credentialStore) return [];
          try {
            return credentialStore.resolveKeyChain(name).map((c) => ({
              keyHashPrefix: keyHashPrefix(c.key),
              key: c.key,
            }));
          } catch {
            // Unreadable store: no pairs from this door (the chain fallback in
            // the prober still applies) — a quota read must never crash a tick.
            return [];
          }
        },
      },
      config: () => getRuntimeConfigRef() ?? config,
    });
    setQuotaProber(quotaProber);
    quotaProber.start();
    const covered = quotaProber.getPlan().byProvider.size;
    console.log(`[OCR] Quota prober: due-based scheduling active (${covered} provider(s) covered)`);
  } else {
    console.log('[OCR] Quota prober: disabled (quota.enabled=false)');
  }

  const { app } = createServer(config, false, registry, orchestrator);

  try {
    await app.listen({ port: config.port, host: config.host });
    // A UI-restart child must self-register: the pid/info files still point at
    // the old (now-exiting) gateway, and nobody else rewrites them.
    if (isRestartChild) writeDaemonFiles(process.pid, config.port, config.host);
    console.log('\n============================================================');
    console.log(`🚀 OCR Gateway (OmniCellRouter) is ready! (OpenAI API Compatible)`);
    console.log(`👉 API Base URL     : http://127.0.0.1:${config.port}/v1`);
    console.log(`👉 Default Model    : auto (Virtual models: auto, lite, plus, pro, ultra)`);
    console.log(`👉 Chat Completions : http://127.0.0.1:${config.port}/v1/chat/completions`);
    console.log(`👉 Anthropic Msgs   : http://127.0.0.1:${config.port}/v1/messages`);
    console.log(`👉 Models List      : http://127.0.0.1:${config.port}/v1/models`);
    console.log(`👉 FinOps Metrics   : http://127.0.0.1:${config.port}/api/admin/metrics`);
    console.log(`👉 Sessions Inspect : http://127.0.0.1:${config.port}/api/admin/sessions`);
    console.log('============================================================\n');

    // Inbound forward proxy (HTTP_PROXY / HTTPS_PROXY server) — opt-in.
    // Fault-tolerance contract: started WITHOUT awaiting the boot path — a
    // failing / slow proxy must never block or crash the gateway. Failures are
    // logged here and surfaced on the Proxy Access page via /api/admin/status.
    if (config.forwardProxy?.enabled) {
      const fpCfg = config.forwardProxy;
      const fpHost = fpCfg.host || '127.0.0.1';
      void startForwardProxy(fpCfg, orchestrator)
        .then((fp) => {
          setForwardProxyStatus({ running: true, port: fp.port, host: fpHost, startedAt: Date.now() });
          console.log(
            `👉 Forward Proxy    : http://${fpHost}:${fp.port} (set HTTP_PROXY / HTTPS_PROXY on clients)`
          );
        })
        .catch((fpErr: any) => {
          const message = fpErr?.message || String(fpErr);
          setForwardProxyStatus({ running: false, error: message });
          console.warn(`[OCR] Forward proxy failed to start (gateway continues without it): ${message}`);
        });
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = () => {
    // Flush FIRST: a throwing summary must never cost the snapshot its last
    // chance to reach the disk (breaker memory is durability-critical).
    breakerStore.flush();
    // Session continuity (anchors + conversation keys) is debounced at 2s —
    // flush the last window so a controlled restart doesn't strand an in-flight
    // tool loop one boundary short of re-anchoring. Synchronous, self-contained.
    orchestrator.getSessionManager().flushPersist();
    // Quota: stop the scheduler, then flush pending snapshot writes
    // (the store debounces; a graceful exit should not lose the last cycles).
    getQuotaProber()?.stop();
    getQuotaStore().flush();
    // Rate-limit windows: flush the last checkpoint so a controlled restart
    // (console restart route included) rehydrates with zero under-count, then
    // stop the periodic timer and close the SQLite handle — explicit teardown
    // of the durability machinery this process armed at boot.
    getRateLimiter().checkpoint();
    getRateLimiter().stopCheckpointing();
    getRateLimiter().closeWindowStore();
    // Graceful-shutdown observability: print a one-line summary for every
    // deduped warn key when the process is asked to exit. Operators get a
    // final view of "what was failing during this lifetime" without the
    // noise of every single suppressed repeat during the run.
    getWarnThrottle().summary();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Windows Ctrl+Break — without this the console sits in silence.
  process.on('SIGBREAK', shutdown);
  // Signal handlers never run for process.exit() — the console's restart
  // route (console.ts handleRestart) exits exactly that way. 'exit' fires
  // on every cooperative termination; Node allows only sync code there,
  // and flush() is synchronous and self-contained. Hard kills (taskkill
  // /F, power loss) have no handler anywhere: the debounce window is the
  // honest loss bound for those.
  process.on('exit', () => {
    breakerStore.flush();
    orchestrator.getSessionManager().flushPersist();
  });
}

main();

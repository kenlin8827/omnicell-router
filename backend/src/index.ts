import path from 'node:path';
import { loadConfig, ensureDefaultConfigFile } from './config/index.js';
import { createServer } from './server.js';
import { ProviderRegistry } from './providers/registry.js';
import { DispatchingProvider } from './providers/dispatch.js';
import { buildDirectPool } from './providers/boot-direct.js';
import { FinOpsTracker } from './metrics/finops-tracker.js';
import { PipelineOrchestrator } from './pipeline/orchestrator.js';

import { Layer1Classifier } from './router/layer1-classifier.js';
import { catalogRepository } from './opencode/catalog/repository.js';
import { initProxyConfig } from './utils/proxy.js';
import { adoptRestartParent, writeDaemonFiles } from './cli/daemon.js';
import { openFinOpsStore } from './trace/persist.js';
import { getOcrHomeDir } from './cli/paths.js';
import { getWarnThrottle } from './observability/warn-throttle.js';
import { startForwardProxy } from './forward-proxy/index.js';
import { setForwardProxyStatus } from './forward-proxy/status.js';

async function main() {
  // If this process was spawned by the UI "Restart Gateway" button, wait for
  // the old gateway to die (and take over) before booting further.
  const isRestartChild = await adoptRestartParent();

  // First-boot template: a fresh install gets a self-documenting config.yaml
  // (annotated DEFAULT_CONFIG) instead of silent in-memory defaults + an empty
  // raw-YAML editor. No-op when any config file already resolves.
  const cfgTemplate = ensureDefaultConfigFile();
  if (cfgTemplate.created) {
    console.log(`[OCR] No config.yaml found — wrote default template to ${cfgTemplate.path} (edit + restart to apply)`);
  }

  const config = loadConfig();
  initProxyConfig(config.proxy);

  // -1. Provider/model catalog sync (config-driven sources; defaults when unset)
  try {
    catalogRepository.applyConfig(config.catalog);
    await catalogRepository.start();
    console.log(`[OCR] Catalog synced: ${catalogRepository.lastSyncOrigin}`);
  } catch (err: any) {
    console.warn(`[OCR] Catalog sync failed (will retry on interval): ${err.message}`);
  }

  // 0. Auto-initialize Layer 1 model base scaffold
  await Layer1Classifier.init(config.classifier?.localModel);
  console.log(`[OCR] Layer 1 classifier ready: ${Layer1Classifier.getModelStatus()}`);

  // 0.5 FinOps cumulative-totals persistence — shared SQLite file under
  //     <ocrHome>/traces/traces.db (same file the trace store uses, but
  //     an independent handle for fault isolation). On non-bun runtimes
  //     `openFinOpsStore` returns null and the tracker silently falls back
  //     to in-memory-only (legacy behavior).
  const finopsStore = await openFinOpsStore(path.join(getOcrHomeDir(), 'traces'));
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

  let registry: ProviderRegistry;
  try {
    const boot = await buildDirectPool();
    config.models = boot.models;
    const defaultPlus = boot.models.find((m) => m.tier === 'plus' && m.isDefaultInTier) || boot.models[0];
    config.baselineModel = defaultPlus?.id || 'auto';

    registry = new ProviderRegistry(config, boot.models.length === 0);
    for (const inst of boot.instances) {
      registry.registerProvider(inst.name, new DispatchingProvider(inst.config, inst.wireBases));
    }
    console.log(
      `[OCR] Direct pool: ${boot.instances.length} providers / ${boot.models.length} models (no daemon)`
    );
    const providerLevel = boot.excluded.filter((e) => !e.model);
    const modelLevel = boot.excluded.filter((e) => e.model);
    for (const ex of providerLevel) console.log(`[OCR]   excluded ${ex.provider}: ${ex.reason}`);
    if (modelLevel.length > 0)
      console.log(`[OCR]   ${modelLevel.length} models excluded (non-text wire/modality), e.g. ${modelLevel.slice(0, 3).map((e) => e.model).join(', ')}`);
  } catch (err: any) {
    console.warn(`[OCR] Direct pool build failed, falling back to standalone config: ${err.message}`);
    registry = new ProviderRegistry(config, true);
  }

  const orchestrator = new PipelineOrchestrator(config, registry, tracker);
  const { app } = createServer(config, false, registry, orchestrator);

  try {
    await app.listen({ port: config.port, host: config.host });
    // A UI-restart child must self-register: the pid/info files still point at
    // the old (now-exiting) gateway, and nobody else rewrites them.
    if (isRestartChild) writeDaemonFiles(process.pid, config.port, config.host);
    console.log('\n============================================================');
    console.log(`🚀 OCR Gateway (OpenCode Router) is ready! (OpenAI API Compatible)`);
    console.log(`👉 API Base URL     : http://127.0.0.1:${config.port}/v1`);
    console.log(`👉 Default Model    : auto (Virtual models: auto, auto-lite, auto-plus, auto-pro, auto-ultra)`);
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

  // Graceful-shutdown observability: print a one-line summary for every
  // deduped warn key when the process is asked to exit. Operators get a
  // final view of "what was failing during this lifetime" without the
  // noise of every single suppressed repeat during the run.
  const shutdown = () => {
    getWarnThrottle().summary();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();

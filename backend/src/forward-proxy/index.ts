import path from 'node:path';
import { getOcrHomeDir } from '../cli/paths.js';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import type { ForwardProxyConfig } from '../config/types.js';
import { DEFAULT_FORWARD_PROXY_PORT, DEFAULT_FORWARD_PROXY_HOST, DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS } from '../config/defaults.js';
import { getRuntimeConfigRef } from '../config/index.js';
import { createForwardProxyServer, type ForwardProxyHandle } from './server.js';
import { createProxyInterceptor } from './interceptor.js';
import { setProxyAccessLogSettingsReader, setProxyAccessLogPersistDir, initProxyAccessLogPersistence } from './access-log.js';

/**
 * Start the inbound forward proxy (HTTP_PROXY / HTTPS_PROXY server).
 * Enabled via config.yaml `forwardProxy.enabled`; defaults: port 4555,
 * loopback-only, CA under ~/.omnicell-router/forward-proxy/.
 */
export async function startForwardProxy(
  cfg: ForwardProxyConfig,
  orchestrator: PipelineOrchestrator
): Promise<ForwardProxyHandle> {
  const host = cfg.host?.trim() || DEFAULT_FORWARD_PROXY_HOST;
  const caDir = cfg.caDir?.trim() || path.join(getOcrHomeDir(), 'forward-proxy');
  const intercept = createProxyInterceptor(orchestrator);
  // Hot-apply seam: the access-log flags re-read the live runtime ref per
  // request, so console saves need no restart.
  setProxyAccessLogPersistDir(path.join(caDir, 'access-log'));
  initProxyAccessLogPersistence();
  setProxyAccessLogSettingsReader(() => {
    const fp = getRuntimeConfigRef()?.forwardProxy;
    return {
      enabled: fp?.accessLog?.enabled !== false,
      bodyBytes: fp?.accessLog?.bodyBytes,
      persist: fp?.accessLog?.persist !== false,
      persistDays: fp?.accessLog?.persistDays ?? DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS,
    };
  });
  const handle = await createForwardProxyServer({
    port: cfg.port ?? DEFAULT_FORWARD_PROXY_PORT,
    host,
    caDir,
    bypassHosts: cfg.bypassHosts || [],
    viaOutboundProxy: cfg.viaOutboundProxy === true,
    // Hot-apply seam: bypassHosts / viaOutboundProxy / unresolvedModel re-read
    // the runtime ref per request, so console saves need no restart.
    liveForwardProxy: () => getRuntimeConfigRef()?.forwardProxy,
    intercept,
    log: (m) => console.log(`[ForwardProxy] ${m}`),
  });
  console.log(`[ForwardProxy] ready on http://${host}:${handle.port} — MITM CA: ${path.join(caDir, 'ca.pem')}`);
  return handle;
}
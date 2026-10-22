import path from 'node:path';
import { getOcrHomeDir } from '../cli/paths.js';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import type { ForwardProxyConfig } from '../config/types.js';
import { DEFAULT_FORWARD_PROXY_PORT } from '../config/defaults.js';
import { createForwardProxyServer, type ForwardProxyHandle } from './server.js';
import { createProxyInterceptor } from './interceptor.js';

/**
 * Start the inbound forward proxy (HTTP_PROXY / HTTPS_PROXY server).
 * Enabled via config.yaml `forwardProxy.enabled`; defaults: port 4555,
 * loopback-only, CA under ~/.onecast-router/forward-proxy/.
 */
export async function startForwardProxy(
  cfg: ForwardProxyConfig,
  orchestrator: PipelineOrchestrator
): Promise<ForwardProxyHandle> {
  const host = cfg.host?.trim() || '127.0.0.1';
  const caDir = cfg.caDir?.trim() || path.join(getOcrHomeDir(), 'forward-proxy');
  const intercept = createProxyInterceptor(orchestrator);
  const handle = await createForwardProxyServer({
    port: cfg.port ?? DEFAULT_FORWARD_PROXY_PORT,
    host,
    caDir,
    bypassHosts: cfg.bypassHosts || [],
    viaOutboundProxy: cfg.viaOutboundProxy === true,
    intercept,
    log: (m) => console.log(`[ForwardProxy] ${m}`),
  });
  console.log(`[ForwardProxy] ready on http://${host}:${handle.port} — MITM CA: ${path.join(caDir, 'ca.pem')}`);
  return handle;
}
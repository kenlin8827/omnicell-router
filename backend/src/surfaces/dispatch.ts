import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { runChatSurface } from './chat-pipeline.js';
import { runDecisionSurface } from './decision-pipeline.js';
import type { ProtocolSurface, TransportContext } from './types.js';

/**
 * Table-driven entry into a surface's execution pipeline, discriminated on
 * `exec` (contract §6: pure protocol functions, no opaque handler objects).
 * Both transports (Fastify shim, node-http interceptor) call this, so
 * protocol semantics run identically on every leg.
 *
 * Capture policy stays SURFACE-owned (protocol-level, not transport-owned):
 * the chat pipeline spreads `t.captureProcessContext()`, and the decision
 * pipeline consults it only behind `recorder.isSystemoneEnabled()`
 * (requestCapture.enabled × systemone.enabled surface master — OFF until the
 * master is turned on) and strictly after its gates — which is why the
 * decision branch needs the recorder + session-manager accessors, not just
 * the registry. `process` stays chat-family-only.
 */
export async function dispatchSurface(
  t: TransportContext,
  surface: ProtocolSurface,
  orchestrator: Pick<PipelineOrchestrator, 'process' | 'getRegistry' | 'getCaptureRecorder' | 'getSessionManager'>,
  body: unknown
): Promise<void> {
  if (surface.exec === 'chat-pipeline') {
    await runChatSurface(t, surface, orchestrator, body);
    return;
  }
  // exec === 'decision-pipeline': the one DecisionSurface (systemoneSurface)
  // resolves its own envelope internally; the orchestrator is passed whole-
  // shaped so the pipeline can reach registry + capture helpers.
  await runDecisionSurface(t, orchestrator, body);
}

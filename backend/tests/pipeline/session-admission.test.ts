import { describe, expect, it } from 'bun:test';
import { loadConfig } from '../../src/config/index.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { FinOpsTracker } from '../../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../../src/pipeline/orchestrator.js';
import { UpstreamEventContext, emitUpstreamRequestOnce } from '../../src/observability/upstream-events.js';
import { SessionManager } from '../../src/session/session-manager.js';
import type { LLMProvider } from '../../src/providers/base.js';
import type { ModelRegistration, RouterConfig } from '../../src/config/types.js';
import { processIR, responseIR } from '../helpers/ir.js';

/**
 * The conversation is resolved at admission. Request capture copies it and
 * cannot be the thing that creates it.
 */

const model: ModelRegistration = {
  id: 'p1/alpha',
  provider: 'p1',
  upstreamModel: 'alpha',
  tier: 'plus',
  isDefaultInTier: true,
  pricing: { input: 1, output: 2, cacheRead: 0.1 },
};

function makeOrchestrator(capture: boolean) {
  const base = loadConfig();
  const config = {
    ...base,
    models: [],
    requestCapture: { ...base.requestCapture, enabled: capture },
    session: { enabled: true, strategy: 'monotonic', ttlSeconds: 3600, maxSessions: 100 },
  } as unknown as RouterConfig;
  const registry = new ProviderRegistry(config, false);
  registry.setAutoRefreshMembers(false);
  const seen: { sessionId?: string; ctx?: UpstreamEventContext }[] = [];
  const provider = {
    name: 'p1',
    async createCompletion(
      _req: unknown,
      served: ModelRegistration,
      ctx?: UpstreamEventContext,
      _credential?: unknown,
      sessionId?: string,
    ) {
      seen.push({ sessionId, ctx });
      return responseIR('ok', { id: 'ok', model: served.upstreamModel });
    },
  } as LLMProvider;
  registry.registerProvider('p1', provider);
  registry.registerModel(model, true);
  const orchestrator = new PipelineOrchestrator(config, registry, new FinOpsTracker());
  return { orchestrator, seen };
}

const turn = { model: 'p1/alpha', messages: [{ role: 'user' as const, content: 'hello' }] };

describe('admission owns the conversation', () => {
  it('delivers the caller session id when capture is off', async () => {
    const { orchestrator, seen } = makeOrchestrator(false);
    await processIR(orchestrator, turn, { headers: { 'x-session-id': 'pg_abd354d1ea624eab' } });
    expect(seen[0]?.sessionId).toBe('pg_abd354d1ea624eab');
    expect(seen[0]?.ctx).toBeUndefined();
    expect(orchestrator.getCaptureRecorder().isEnabled()).toBe(false);
    expect(orchestrator.getSessionManager().getSession('pg_abd354d1ea624eab')).toBeDefined();
  });

  it('does not open a session when the addressed variant does not exist', async () => {
    const { orchestrator, seen } = makeOrchestrator(true);
    const id = 'pg_rejected';
    await expect(
      processIR(
        orchestrator,
        { model: 'p1/alpha#missing', messages: [{ role: 'user', content: 'hello' }] },
        { headers: { 'x-session-id': id } },
      ),
    ).rejects.toThrow(/not found/);
    expect(seen).toHaveLength(0);
    expect(orchestrator.getSessionManager().turnHighWaterOf(id)).toBe(0);
    expect(orchestrator.getSessionManager().getSession(id)).toBeUndefined();
  });

  it('delivers the same session id when capture is on, without putting it on the capture handle', async () => {
    const { orchestrator, seen } = makeOrchestrator(true);
    await processIR(orchestrator, turn, { headers: { 'x-session-id': 'pg_abd354d1ea624eab' } });
    expect(seen[0]?.sessionId).toBe('pg_abd354d1ea624eab');
    const ctx = seen[0]?.ctx;
    expect(ctx).toBeInstanceOf(UpstreamEventContext);
    expect(ctx && 'sessionId' in ctx).toBe(false);
  });
});

describe('capture writes only a real handle', () => {
  it('copies the sealed id and ignores a plain object', () => {
    const events: { sessionId?: string }[] = [];
    const recorder = { isEnabled: () => true, recordEvent: (event: { sessionId?: string }) => { events.push(event); } };
    const ctx = new UpstreamEventContext({
      recorder: recorder as never,
      sessionId: 'pg_abd354d1ea624eab',
      requestId: 'req_1',
      model: 'p1/alpha',
    });
    const wire = { url: 'http://127.0.0.1/v1', method: 'POST', requestHeaders: {}, requestBody: '{}' };
    emitUpstreamRequestOnce(ctx, wire);
    expect(events[0]?.sessionId).toBe('pg_abd354d1ea624eab');
    expect(emitUpstreamRequestOnce({ recorder, requestId: 'req_1', model: 'p1/alpha', sessionId: 'stolen' } as never, wire)).toBeUndefined();
    expect(events).toHaveLength(1);
  });

  it('reads an explicit session header and does not invent one', () => {
    expect(SessionManager.explicitSessionId({ 'x-session-id': 'pg_abd354d1ea624eab' })).toBe('pg_abd354d1ea624eab');
    expect(SessionManager.explicitSessionId({ 'x-session-id': '   ' })).toBeUndefined();
    expect(SessionManager.explicitSessionId(undefined)).toBeUndefined();
  });
});

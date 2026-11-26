import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { FinOpsTracker } from '../../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../../src/pipeline/orchestrator.js';
import { RouterConfig, ModelRegistration } from '../../src/config/types.js';
import { ChatCompletionRequest, ChatCompletionMessage } from '../../src/types/openai.js';
import { processIR } from '../helpers/ir.js';

// ---------------------------------------------------------------------------
// The directive seam must preserve an EXPLICIT empty support set (`[]`, a
// toggle model with no level control) all the way into applyEffortDirectives.
// modelSupportsEfforts collapses `[]` to undefined (the registry's "cannot
// serve a mapped level" rule); if the orchestrator fed that undefined to the
// directive applier, `@ocr-effort-up` would silently STEP a toggle model —
// exactly the no-op contract ADR-0011 pins. This file drives the REAL
// orchestrator (mock mode) so the seam, not just the helper, is tested.
// ---------------------------------------------------------------------------

function configWith(models: Array<Partial<ModelRegistration> & { id: string; tier: 'lite' | 'plus' | 'pro' | 'ultra' }>): RouterConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    baselineModel: models[0]!.id,
    fallback: { enabled: false, maxRetries: 0, escalateTier: 'plus', injectErrorContext: false },
    models: models.map((m) => ({
      provider: 'mock',
      upstreamModel: m.id,
      pricing: { input: 1, output: 2, cacheRead: 0.5 },
      wire: 'openai-chat',
      ...m,
    })) as ModelRegistration[],
  };
}

const user = (content: string): ChatCompletionMessage => ({ role: 'user', content });
const assistant = (content: string): ChatCompletionMessage => ({ role: 'assistant', content });

function harness(models: Array<Partial<ModelRegistration> & { id: string; tier: 'lite' | 'plus' | 'pro' | 'ultra' }>) {
  const cfg = configWith(models);
  const reg = new ProviderRegistry(cfg, true);
  const orch = new PipelineOrchestrator(cfg, reg, new FinOpsTracker());
  return { orch, reg };
}

describe('Effort directives on a no-level-control model — orchestrator seam', () => {
  it('@ocr-effort-up is a NO-OP on a toggle model ([] support), never a step', async () => {
    const { orch } = harness([{ id: 'toggle-model', tier: 'plus', supportedReasoningEfforts: [] }]);
    // Same conversation shape the escalation e2e uses: the directive rides
    // the LAST user message of an established session.
    const r = await processIR(orch, {
      model: 'auto',
      messages: [
        user('explain the locking protocol'),
        assistant('mock reply'),
        user('@ocr-effort-up explain it again'),
      ],
    } as ChatCompletionRequest);
    assert.equal(r.modelUsed, 'toggle-model');
    assert.equal(r.effortSource, undefined, 'a no-op directive never owns the ask');
    assert.equal(r.actualEffort, undefined, 'no level was written for a model with no level control');
    const trace = orch.getTraceTracker().getRecentTraces().data[0];
    assert.notEqual(trace?.routing?.reasonCode, 'directive.effort_up', 'the no-op must not ledger as a step');
  });

  it('@ocr-effort-up still steps a model WITH a declared ladder (control)', async () => {
    const { orch } = harness([{ id: 'ladder-model', tier: 'plus', supportedReasoningEfforts: ['none', 'low', 'medium', 'high'] }]);
    const r = await processIR(orch, {
      model: 'auto',
      messages: [
        user('explain the locking protocol'),
        assistant('mock reply'),
        user('@ocr-effort-up explain it again'),
      ],
      reasoning_effort: 'low',
    } as ChatCompletionRequest);
    assert.equal(r.effortSource, 'directive');
    assert.equal(r.actualEffort, 'medium', 'one rung up from the client ask');
    const trace = orch.getTraceTracker().getRecentTraces().data[0];
    assert.equal(trace?.routing?.reasonCode, 'directive.effort_up');
  });

  it('contradictory only-none table + always-think: a real-level ask never rewrites to none', async () => {
    // Operator override / hand defs left a table of ONLY `none` while the vendor
    // says always-think. Boot strips it to []; routing must mirror the ask, not
    // mint thinking-off the vendor forbids (round-3 Finding B).
    const { orch } = harness([
      { id: 'contradictory', tier: 'plus', supportedReasoningEfforts: [], reasoningDisableable: false },
    ]);
    const r = await processIR(orch, {
      model: 'contradictory',
      messages: [user('explain the locking protocol')],
      reasoning_effort: 'low',
    } as ChatCompletionRequest);
    assert.equal(r.modelUsed, 'contradictory');
    assert.notEqual(r.actualEffort, 'none', 'an always-think model must never be rewritten to thinking-off');
  });

  it('an always-think model never serves thinking-off through a directive step', async () => {
    // reasoningDisableable:false + a stale table that still lists `none`:
    // the routing resolution strips it, so a DOWN-step from low lands on the
    // lowest REAL level, never on none.
    const { orch } = harness([
      { id: 'always-think', tier: 'plus', supportedReasoningEfforts: ['none', 'low', 'high'], reasoningDisableable: false },
    ]);
    const r = await processIR(orch, {
      model: 'auto',
      messages: [
        user('explain the locking protocol'),
        assistant('mock reply'),
        user('@ocr-effort-down explain it again'),
      ],
      reasoning_effort: 'low',
    } as ChatCompletionRequest);
    assert.equal(r.modelUsed, 'always-think');
    assert.notEqual(r.actualEffort, 'none', 'the vendor forbids thinking-off — a directive must not re-open it');
  });
});
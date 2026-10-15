import { describe, expect, it } from 'bun:test';
import { loadConfig } from '../src/config/index.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { accountSpreadIndex } from '../src/pipeline/account-selection.js';
import { keyHashPrefix } from '../src/opencode/credentials/index.js';
import type { CallCredential } from '../src/providers/base.js';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../src/types/openai.js';
import type { ModelRegistration, RouterConfig } from '../src/config/types.js';

/**
 * Session affinity through the REAL orchestrator pipeline
 * (no net: stub providers record the credential each call was served with; the
 * pair state is driven through the public breaker API, not injected errors).
 * Harness mirrors registry-credential-selection.test.ts (stub LLMProvider +
 * registered chains) crossed with pipeline.test.ts (process() end to end).
 */

const cred = (key: string, label: string): CallCredential => ({
  key,
  keyHashPrefix: keyHashPrefix(key),
  label,
});
const chainP1 = [cred('sk-aff-p1-a', 'p1-a'), cred('sk-aff-p1-b', 'p1-b')];
const chainP2 = [cred('sk-aff-p2-a', 'p2-a'), cred('sk-aff-p2-b', 'p2-b')];

const m1: ModelRegistration = {
  id: 'p1/alpha',
  provider: 'p1',
  upstreamModel: 'alpha',
  tier: 'plus',
  isDefaultInTier: true,
  pricing: { input: 1, output: 2, cacheRead: 0.1 },
};
const m2: ModelRegistration = {
  id: 'p2/beta',
  provider: 'p2',
  upstreamModel: 'beta',
  tier: 'plus',
  pricing: { input: 1.2, output: 2.4, cacheRead: 0.1 },
};

/** Stub provider recording every credential it was handed. */
function makeStub(name: string) {
  const seen: (CallCredential | undefined)[] = [];
  const provider = {
    name,
    async createCompletion(
      _req: ChatCompletionRequest,
      model: ModelRegistration,
      _ctx: unknown,
      credential?: CallCredential
    ): Promise<ChatCompletionResponse> {
      seen.push(credential);
      return {
        id: `ok-${name}`,
        object: 'chat.completion',
        created: 1,
        model: model.upstreamModel,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      } as ChatCompletionResponse;
    },
  };
  return { provider: provider as unknown as import('../src/providers/base.js').LLMProvider, seen };
}

function makeFixture(combos?: { id: string; models: string[] }[], mode: 'both' | 'm1only' = 'both') {
  const base = loadConfig();
  const config = {
    ...base,
    providers: [],
    models: [],
    tiers: base.tiers ?? {},
    combos,
    session: { enabled: true, strategy: 'monotonic', ttlSeconds: 3600, maxSessions: 100 },
    circuitBreaker: {
      ...base.circuitBreaker,
      enabled: true,
      failureThreshold: 1000, // manual trips drive state here; auto trips must not fire
      initialCooldownMs: 600000,
      accountAffinity: { cacheTtlMs: 300000 },
    },
  } as unknown as RouterConfig;
  const registry = new ProviderRegistry(config, false);
  registry.setAutoRefreshTierMatch(false);
  const stub1 = makeStub('p1');
  const stub2 = makeStub('p2');
  registry.registerProvider('p1', stub1.provider, chainP1);
  if (mode === 'both') registry.registerProvider('p2', stub2.provider, chainP2);
  registry.registerModel(m1, true);
  if (mode === 'both') registry.registerModel(m2);
  const orchestrator = new PipelineOrchestrator(config, registry, new FinOpsTracker());
  return { registry, orchestrator, stub1, stub2 };
}

const sessCtx = (sessionId: string) => ({ headers: { 'x-session-id': sessionId } });
const turn = (content: string, model = 'p1/alpha'): ChatCompletionRequest => ({
  model,
  messages: [{ role: 'user', content }],
});

describe('affinity bind + persistence across turns', () => {
  it('turn 1 spreads deterministically and persists the bind; turn 2 keeps it', async () => {
    const { orchestrator, stub1 } = makeFixture();
    const sessionId = 'sess-aff-keep';

    const r1 = await orchestrator.process(turn('first hello', 'p1/alpha'), sessCtx(sessionId));
    const expected = chainP1[accountSpreadIndex(sessionId, 2)].keyHashPrefix;
    expect(stub1.seen[0]?.keyHashPrefix).toBe(expected); // selection actually served
    expect(r1.servedAccountPrefix).toBe(expected); // observability mirrors it (additive)
    expect(r1.breakerState).toBe('CLOSED'); // legacy field shape kept
    const session = orchestrator.getSessionManager().getSession(sessionId)!;
    expect(session.boundKeyHashPrefix).toBe(expected);
    expect(typeof session.boundAt).toBe('number');

    // Turn 2: explicit head "changes" (nothing tripped) — no rebalancing allowed.
    const r2 = await orchestrator.process(turn('second hello', 'p1/alpha'), sessCtx(sessionId));
    expect(stub1.seen[1]?.keyHashPrefix).toBe(expected);
    expect(session.boundKeyHashPrefix).toBe(expected);
    expect(r2.servedAccountPrefix).toBe(expected);
  });

  it('forced failover: OPEN bound pair breaker moves to the other account and the rebind persists', async () => {
    const { orchestrator, registry, stub1 } = makeFixture();
    const sessionId = 'sess-aff-fail';
    const cb = registry.getCircuitBreakerManager();

    await orchestrator.process(turn('hello', 'p1/alpha'), sessCtx(sessionId));
    const bound = orchestrator.getSessionManager().getSession(sessionId)!.boundKeyHashPrefix!;
    const other = chainP1.find((c) => c.keyHashPrefix !== bound)!;

    cb.tripPair(m1.id, bound, { cooldownMs: 600000 }, 'p1');
    const r2 = await orchestrator.process(turn('hello again', 'p1/alpha'), sessCtx(sessionId));
    expect(r2.modelUsed).toBe(m1.id); // SAME model — only the account moved
    expect(stub1.seen[1]?.keyHashPrefix).toBe(other.keyHashPrefix);
    expect(orchestrator.getSessionManager().getSession(sessionId)!.boundKeyHashPrefix).toBe(other.keyHashPrefix);
    expect(r2.servedAccountPrefix).toBe(other.keyHashPrefix);

    // Old account recovers: NO switch-back (the prefix lives where traffic went).
    cb.resetScoped(m1.id, bound);
    const r3 = await orchestrator.process(turn('hello third', 'p1/alpha'), sessCtx(sessionId));
    expect(stub1.seen[2]?.keyHashPrefix).toBe(other.keyHashPrefix);
    expect(orchestrator.getSessionManager().getSession(sessionId)!.boundKeyHashPrefix).toBe(other.keyHashPrefix);
    expect(r3.servedAccountPrefix).toBe(other.keyHashPrefix);
  });

  it('all-unhealthy force keeps legacy semantics: no prefix, no attribution, binding frozen', async () => {
    const { orchestrator, registry, stub1 } = makeFixture(undefined, 'm1only');
    const sessionId = 'sess-aff-nospec';
    await orchestrator.process(turn('hello', 'p1/alpha'), sessCtx(sessionId));
    const bound = orchestrator.getSessionManager().getSession(sessionId)!.boundKeyHashPrefix!;

    // Trip BOTH p1 accounts: selection says all-unhealthy (no bind decided).
    // m1 is the pool's only candidate -> today's last-candidate FORCE runs the
    // legacy no-prefix execute; the binding must not move without a verified
    // alternative, and the model breaker (not a pair) records the outcome.
    const cb = registry.getCircuitBreakerManager();
    for (const c of chainP1) cb.tripPair(m1.id, c.keyHashPrefix, { cooldownMs: 600000 }, 'p1');
    const r2 = await orchestrator.process(turn('hello again', 'p1/alpha'), sessCtx(sessionId));
    expect(r2.modelUsed).toBe(m1.id); // served via the last-candidate force
    expect(stub1.seen[1]).toBeUndefined(); // no credential selector on the forced call
    expect(r2.servedAccountPrefix).toBeUndefined();
    expect(orchestrator.getSessionManager().getSession(sessionId)!.boundKeyHashPrefix).toBe(bound);
  });
});

describe('self-healing: account rebind rides the model repin', () => {
  it('model down repins the model and re-spreads onto the new provider chain', async () => {
    const { orchestrator, registry, stub1, stub2 } = makeFixture();
    const sessionId = 'sess-aff-heal';

    const r1 = await orchestrator.process(turn('hello', 'p1/alpha'), sessCtx(sessionId));
    expect(r1.modelUsed).toBe(m1.id);
    const boundP1 = orchestrator.getSessionManager().getSession(sessionId)!.boundKeyHashPrefix!;
    expect(chainP1.some((c) => c.keyHashPrefix === boundP1)).toBe(true);

    // m1 model breaker down: aggregate unavailable -> self-healing repins to m2, and
    // the (foreign) binding is stale for p2's chain -> forced re-spread.
    registry.getCircuitBreakerManager().trip(m1.id, { reason: 'test outage' }, 'p1');
    // auto mode so the session pin (ratchet) drives the preference:
    const r2 = await orchestrator.process(turn('hello again', 'auto-plus'), sessCtx(sessionId));
    expect(r2.modelUsed).toBe(m2.id);
    const session = orchestrator.getSessionManager().getSession(sessionId)!;
    expect(session.pinnedModel).toBe(m2.id);
    expect(stub2.seen[0]?.keyHashPrefix).toBeDefined(); // selection passed a real credential
    expect(session.boundKeyHashPrefix).toBe(stub2.seen[0]!.keyHashPrefix); // continuity moved to p2
    expect(chainP2.some((c) => c.keyHashPrefix === session.boundKeyHashPrefix)).toBe(true);
    expect(chainP2.some((c) => c.keyHashPrefix === boundP1)).toBe(false); // different account space
    expect(stub1.seen).toHaveLength(1); // m1 never called after the trip (model gate)
  });

  it('binding survives a same-provider model repin (continuity kept, NOT re-spread)', async () => {
    // m1 and m2 share provider p1's chain: the self-healed repin keeps the bound
    // account because the prefix exists in the new pin's chain.
    const base = loadConfig();
    const config = {
      ...base,
      providers: [],
      models: [],
      tiers: base.tiers ?? {},
      session: { enabled: true, strategy: 'monotonic', ttlSeconds: 3600, maxSessions: 100 },
      circuitBreaker: { ...base.circuitBreaker, enabled: true, failureThreshold: 1000, initialCooldownMs: 600000 },
    } as unknown as RouterConfig;
    const registry = new ProviderRegistry(config, false);
    registry.setAutoRefreshTierMatch(false);
    const stub = makeStub('p1');
    registry.registerProvider('p1', stub.provider, chainP1);
    const m2same = { ...m2, id: 'p1/beta', provider: 'p1' } as ModelRegistration;
    registry.registerModel(m1, true);
    registry.registerModel(m2same);
    const orchestrator = new PipelineOrchestrator(config, registry, new FinOpsTracker());
    const sessionId = 'sess-aff-heal-same';

    await orchestrator.process(turn('hello', 'p1/alpha'), sessCtx(sessionId));
    const bound = orchestrator.getSessionManager().getSession(sessionId)!.boundKeyHashPrefix!;
    registry.getCircuitBreakerManager().trip(m1.id, undefined, 'p1');
    const r2 = await orchestrator.process(turn('hello again', 'auto-plus'), sessCtx(sessionId));
    expect(r2.modelUsed).toBe(m2same.id);
    expect(orchestrator.getSessionManager().getSession(sessionId)!.boundKeyHashPrefix).toBe(bound); // continuity
    expect(stub.seen[1]?.keyHashPrefix).toBe(bound); // served on the SAME account
  });
});

describe('explicit-pin and combo paths flow through the same selection', () => {
  it('combo leader serves through the selected credential (no bypass)', async () => {
    const { orchestrator, stub1 } = makeFixture([{ id: 'mycombo', models: ['p1/alpha', 'p2/beta'] }]);
    const sessionId = 'sess-aff-combo';
    const result = await orchestrator.process(turn('hello combo', 'mycombo'), sessCtx(sessionId));
    expect(result.modelUsed).toBe(m1.id); // priority strategy: first healthy member leads
    const served = stub1.seen[0];
    expect(served).toBeDefined();
    expect(chainP1.some((c) => c.keyHashPrefix === served!.keyHashPrefix)).toBe(true);
    expect(result.servedAccountPrefix).toBe(served!.keyHashPrefix);
    // Combo sessions carry no session row (bypass mode never creates one): the
    // deterministic hash is the affinity; nothing to persist. Documented shape.
    expect(orchestrator.getSessionManager().getSession(sessionId)).toBeUndefined();
  });

  it('unknown-prefix selectors cannot reach the registry throw (stale binding recovers)', async () => {
    const { orchestrator, stub1 } = makeFixture();
    const sessionId = 'sess-aff-stale';
    // Turn 1 binds through the spread.
    await orchestrator.process(turn('hello', 'p1/alpha'), sessCtx(sessionId));
    const session = orchestrator.getSessionManager().getSession(sessionId)!;
    // Simulate the stale-binding boot state (pool rebuilt without that key):
    session.boundKeyHashPrefix = 'ffffffffffff';
    const r2 = await orchestrator.process(turn('hello again', 'p1/alpha'), sessCtx(sessionId));
    expect(r2.servedAccountPrefix).toBeDefined(); // recovered via forced re-spread
    expect(r2.servedAccountPrefix).not.toBe('ffffffffffff');
    expect(session.boundKeyHashPrefix).toBe(r2.servedAccountPrefix);
    expect(stub1.seen[1]?.keyHashPrefix).toBe(r2.servedAccountPrefix); // and it was actually served
  });
});

import { describe, expect, it } from 'bun:test';
import { loadConfig } from '../src/config/index.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { keyHashPrefix } from '../src/opencode/credentials/index.js';
import type { CallCredential } from '../src/providers/base.js';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../src/types/openai.js';
import type { ModelRegistration, RouterConfig, TierMemberRule } from '../src/config/types.js';
import type { TierLevel } from '../src/types/router.js';

/**
 * Session-pin eviction (the ratchet-mode hard switch).
 *
 * A pinned model is switched out when either force hits:
 *   CONFIG — the model no longer joins the pool its live member lists give it
 *            (unclassified / global denylist / unresolvable zombie pin);
 *   HEALTH — the model CAPABILITY view (registry.modelHealthView): evict
 *            only at 'unavailable' (model breaker OPEN, or every pair
 *            hard-OPEN / SUSPECT / operator-DISABLED). 'recovering' — a
 *            canary trial in flight, slot free OR busy — is never
 *            eviction-worthy (peek would read a busy canary as
 *            unavailable; routing may failover, the pin holds).
 * NOT triggers: a model moved to another tier (still joins "its own" pool),
 * partial credential disablement (the credential dimension rebinds, the pin holds),
 * shadow-mode automatic trips (the view folds them as serving — the verdict
 * contract), and the explicit / combo paths (4B never runs for them by
 * contract).
 *
 * Harness mirrors credential-affinity-orchestrator.test.ts (stub providers, real
 * orchestrator, manual breaker drives). Models carry tierMatch so they are
 * reclassification-capable — and are built FRESH per fixture, because
 * reclassifyTiers mutates the live registration objects and the credential-state
 * store persists (any DISABLED must be re-ENABLED in the same test).
 */

const cred = (key: string, label: string): CallCredential => ({
  key,
  keyHashPrefix: keyHashPrefix(key),
  label,
});
const chainP1 = [cred('sk-ev-p1-a', 'p1-a'), cred('sk-ev-p1-b', 'p1-b')];
const chainP2 = [cred('sk-ev-p2-a', 'p2-a'), cred('sk-ev-p2-b', 'p2-b')];

const mkModel = (id: string, provider: string, tier: TierLevel, isDefault?: boolean): ModelRegistration => ({
  id,
  provider,
  upstreamModel: id.split('/')[1],
  tier,
  isDefaultInTier: isDefault,
  // Captured models reclassify against member lists; without this flag a
  // model is hand-configured and member-list edits never move it.
  tierMatch: { reasoningFlag: false },
  pricing: { input: 1, output: 2, cacheRead: 0.1 },
});

const ALPHA = 'p1/alpha';
const BETA = 'p2/beta';

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

function makeConfig(base: unknown, extras: Record<string, unknown> = {}) {
  return {
    ...(base as Record<string, unknown>),
    providers: [],
    models: [],
    // fresh copy: tests mutate tierPolicies in place (denylist hook) — never
    // touch the object loadConfig() may share across fixtures.
    tiers: { ...((base as any).tiers ?? {}) },
    combos: [],
    session: { enabled: true, strategy: 'monotonic', ttlSeconds: 3600, maxSessions: 100 },
    circuitBreaker: {
      ...(base as any).circuitBreaker,
      enabled: true,
      failureThreshold: 1000, // manual trips drive state here; auto trips must not fire
      initialCooldownMs: 600000,
      credentialAffinity: { cacheTtlMs: 300000 },
    },
    ...extras,
  } as unknown as RouterConfig;
}

function makeFixture(mode: 'both' | 'm1only' = 'both', extras: Record<string, unknown> = {}) {
  const config = makeConfig(loadConfig(), extras);
  const registry = new ProviderRegistry(config, false);
  registry.setAutoRefreshTierMatch(false);
  const stub1 = makeStub('p1');
  const stub2 = makeStub('p2');
  const m1 = mkModel(ALPHA, 'p1', 'plus', true);
  const m2 = mkModel(BETA, 'p2', 'plus', false);
  registry.registerProvider('p1', stub1.provider, chainP1);
  registry.registerModel(m1, true);
  if (mode === 'both') {
    registry.registerProvider('p2', stub2.provider, chainP2);
    registry.registerModel(m2);
  }
  // Member lists are the ONLY pool source — commit the plus pool explicitly
  // (the production contract: pools are the per-tier projection of
  // tiers[t].members; a stored tier alone never joins a model).
  commitMembers(registry, { plus: [{ pattern: 'p1/*' }, { pattern: 'p2/*' }] });
  const orchestrator = new PipelineOrchestrator(config, registry, new FinOpsTracker());
  return { registry, orchestrator, stub1, stub2, m1, m2 };
}

const sessCtx = (sessionId: string) => ({ headers: { 'x-session-id': sessionId } });
const turn = (content: string, model = 'auto-plus'): ChatCompletionRequest => ({
  model,
  messages: [{ role: 'user', content }],
});

/**
 * Last turn's routing attribution as persisted on the trace — pins the
 * cross-layer repin contract: the backend trio (orchestrator 4B) and the
 * literal keys the frontend formatReason reads must not drift (the params
 * maps are untyped Records on both sides; a rename would silently render '?').
 */
const lastTurnParams = (orchestrator: PipelineOrchestrator, sessionId: string): Record<string, unknown> => {
  const traces = orchestrator.getTraceTracker().getTracesBySession(sessionId);
  return (traces[traces.length - 1]?.routing?.reasonParams ?? {}) as Record<string, unknown>;
};

/** Replay member lists over the live registry (the console save-commit path). */
const commitMembers = (
  registry: ProviderRegistry,
  members: Partial<Record<TierLevel, TierMemberRule[]>>
) =>
  registry.reclassifyTiers({
    lite: [],
    plus: [],
    pro: [],
    ultra: [],
    ...members,
  } as Record<TierLevel, TierMemberRule[]>);

describe('config eviction: removed from tier members', () => {
  it('a session pinned to a model removed from every member list repins to the tier head', async () => {
    const { orchestrator, registry, stub1, stub2, m1, m2 } = makeFixture();
    const sessionId = 'sess-ev-members';

    const r1 = await orchestrator.process(turn('first hello'), sessCtx(sessionId));
    expect(r1.modelUsed).toBe(m1.id); // priority pool head pins the session
    expect(orchestrator.getSessionManager().getSession(sessionId)!.pinnedModel).toBe(m1.id);

    // Operator edits the plus list down to p2/* — m1 no longer joins any pool.
    commitMembers(registry, { plus: [{ pattern: 'p2/*' }] });

    const r2 = await orchestrator.process(turn('second hello'), sessCtx(sessionId));
    expect(r2.modelUsed).toBe(m2.id);
    const session = orchestrator.getSessionManager().getSession(sessionId)!;
    expect(session.pinnedModel).toBe(m2.id); // hard switch + write-back in one seam
    expect(stub1.seen).toHaveLength(1); // m1 never called after the removal
    expect(stub2.seen).toHaveLength(1);
    // Attribution rides the trace ADDITIVELY: the session.sticky params from
    // the ratchet rewrite survive the merge, the repin trio names the switch.
    // Attribution rides the trace ADDITIVELY: the session.preserved params from
    // the ratchet rewrite survive the merge, the repin trio names the switch.
    expect(lastTurnParams(orchestrator, sessionId)).toMatchObject({
      tier: 'plus',
      repin: 'config',
      repinFrom: m1.id,
      repinTo: m2.id,
    });
  });

  it('the global denylist (tiers.exclude) evicts a pin the same way member lists do', async () => {
    const { orchestrator, registry, m1, m2 } = makeFixture();
    const sessionId = 'sess-ev-deny';
    await orchestrator.process(turn('first hello'), sessCtx(sessionId));

    // The registry holds the committed tierPolicies object live; the denylist
    // is applied from it at pool-build time. Mutating the getter's return is
    // the sanctioned test hook (production path: console save → applyTierConfigNow).
    registry.getTierPolicies().exclude = ['p1/alpha'];

    const r2 = await orchestrator.process(turn('second hello'), sessCtx(sessionId));
    expect(r2.modelUsed).toBe(m2.id);
    expect(orchestrator.getSessionManager().getSession(sessionId)!.pinnedModel).toBe(m2.id);
  });

  it('a zombie pin (id gone from the registry) is repaired, not re-fallen-back forever', async () => {
    const { orchestrator, m1 } = makeFixture();
    const sessionId = 'sess-ev-zombie';
    await orchestrator.process(turn('first hello'), sessCtx(sessionId));

    // Simulate the post-restart state: config.models lost the pinned id.
    orchestrator.getSessionManager().getSession(sessionId)!.pinnedModel = 'ghost/gone';

    const r2 = await orchestrator.process(turn('second hello'), sessCtx(sessionId));
    expect(r2.modelUsed).toBe(m1.id);
    // Pre-fix the zombie string survived (each turn silently used the tier
    // head via the null-pin fallback); the eviction seam writes it back.
    expect(orchestrator.getSessionManager().getSession(sessionId)!.pinnedModel).toBe(m1.id);
  });

  it('a model MOVED to another tier is NOT config-evicted (cross-tier move != removal)', async () => {
    const { orchestrator, registry, m1 } = makeFixture();
    const sessionId = 'sess-ev-move';
    await orchestrator.process(turn('first hello'), sessCtx(sessionId));

    // m1 is now claimed by pro (its m.tier is rewritten), plus keeps m2.
    commitMembers(registry, { plus: [{ pattern: 'p2/*' }], pro: [{ pattern: 'p1/*' }] });

    const r2 = await orchestrator.process(turn('second hello'), sessCtx(sessionId));
    expect(r2.modelUsed).toBe(m1.id); // pin kept — it still joins "its own" tier's pool
    expect(orchestrator.getSessionManager().getSession(sessionId)!.pinnedModel).toBe(m1.id);
  });

  it('hand-configured models (no tierMatch) are never member-list-evicted', async () => {
    const { orchestrator, registry, m1, m2 } = makeFixture();
    const sessionId = 'sess-ev-hand';
    const hand = { ...m2, tierMatch: undefined } as unknown as ModelRegistration;
    registry.registerModel(hand); // re-register m2 as hand-configured
    await orchestrator.process(turn('first hello'), sessCtx(sessionId));
    expect(orchestrator.getSessionManager().getSession(sessionId)!.pinnedModel).toBe(m1.id);

    // Empty the plus list: m1 (captured) falls out of every pool and gets
    // evicted; m2 (hand-configured) is reclassify-immune and stays in the
    // pool through its declared tier — and serves as the landing.
    commitMembers(registry, { plus: [] });
    const r2 = await orchestrator.process(turn('second hello'), sessCtx(sessionId));
    expect(r2.modelUsed).toBe(m2.id);
    expect(orchestrator.getSessionManager().getSession(sessionId)!.pinnedModel).toBe(m2.id);
  });
});

describe('health eviction: in the pool, nothing to serve it', () => {
  it('a model whose every credential is operator-DISABLED is pinned out (aggregate reads out)', async () => {
    const { orchestrator, registry, m1, m2 } = makeFixture();
    const sessionId = 'sess-ev-disabled';
    await orchestrator.process(turn('first hello'), sessCtx(sessionId));

    const store = registry.getCircuitBreakerManager().getCredentialStateStore();
    for (const c of chainP1) store.disable('p1', c.keyHashPrefix);
    try {
      // Config dimension untouched: m1 still joins the plus pool (healthyOnly=false).
      const configPool = registry.getCandidateModelsForTier('plus', false);
      expect(configPool.some((m) => m.id === m1.id)).toBe(true);
      // All pairs operator-DISABLED → takedown outranks trial state → 'unavailable'.
      expect(registry.modelHealthView(m1)).toBe('unavailable');

      const r2 = await orchestrator.process(turn('second hello'), sessCtx(sessionId));
      expect(r2.modelUsed).toBe(m2.id);
      expect(orchestrator.getSessionManager().getSession(sessionId)!.pinnedModel).toBe(m2.id);
      expect(lastTurnParams(orchestrator, sessionId)).toMatchObject({ repin: 'health', repinFrom: m1.id, repinTo: m2.id });
    } finally {
      // DISABLED persists to disk — never leak a takedown into the next fixture.
      for (const c of chainP1) store.enable('p1', c.keyHashPrefix);
    }
  });

  it('partial disablement is NOT eviction: the pin holds, only the credential moves', async () => {
    const { orchestrator, registry, stub1, m1 } = makeFixture();
    const sessionId = 'sess-ev-partial';
    await orchestrator.process(turn('first hello'), sessCtx(sessionId));
    const bound = orchestrator.getSessionManager().getSession(sessionId)!.boundKeyHashPrefix!;
    const parked = chainP1.find((c) => c.keyHashPrefix === bound)!;
    const other = chainP1.find((c) => c.keyHashPrefix !== bound)!;

    const store = registry.getCircuitBreakerManager().getCredentialStateStore();
    store.disable('p1', parked.keyHashPrefix);
    try {
      const r2 = await orchestrator.process(turn('second hello'), sessCtx(sessionId));
      expect(r2.modelUsed).toBe(m1.id); // same model — the aggregate still reads available
      expect(orchestrator.getSessionManager().getSession(sessionId)!.pinnedModel).toBe(m1.id);
      expect(stub1.seen[1]?.keyHashPrefix).toBe(other.keyHashPrefix); // credential FORCED-rebinded
    } finally {
      store.enable('p1', parked.keyHashPrefix);
    }
  });

  it('a recovering trial model is NEVER evicted (busy canary ≠ gone — the pin survives the trial)', async () => {
    const { orchestrator, registry, m1 } = makeFixture();
    const sessionId = 'sess-ev-halfopen';
    await orchestrator.process(turn('first hello'), sessCtx(sessionId));

    const cb = registry.getCircuitBreakerManager();
    // Open both pairs, then outlast the cooldown floor (manual trips clamp to
    // a 1000ms minimum) so the breakers enter HALF_OPEN on the next state
    // read; consume each canary slot through the CONSUMING gate: the peek
    // view now reads m1 unavailable (quota reached) while the capability
    // view reads a model one successful probe away from closing back.
    for (const c of chainP1) cb.tripPair(m1.id, c.keyHashPrefix, { cooldownMs: 1000 }, 'p1');
    await new Promise((r) => setTimeout(r, 1200));
    for (const c of chainP1) cb.canExecuteScoped(m1.id, c.keyHashPrefix);

    // The two views MUST diverge here — the eviction-strictness discriminator:
    expect(registry.modelAvailable(m1).available).toBe(false); // peek: unavailable (a peek-based predicate would evict)
    expect(registry.modelHealthView(m1)).toBe('recovering'); // capability: trial in flight → never evict

    const r2 = await orchestrator.process(turn('second hello'), sessCtx(sessionId));
    // The pin is the contract: no eviction fired ('recovering' ≠
    // 'unavailable'), so the session rides the trial. Where the turn's
    // request itself lands is EXISTING gate semantics — model breaker CLOSED
    // while pairs are mid-trial takes the legacy no-prefix force on the
    // head (pre-P3 behavior, not this seam's business) — the one thing this
    // assertion must prove is that no switch-away was persisted.
    expect(r2.modelUsed).toBe(m1.id);
    expect(orchestrator.getSessionManager().getSession(sessionId)!.pinnedModel).toBe(m1.id);
  });

  it('no healthy landing keeps the evicted pin (safe fail, never jump into a fire pit)', async () => {
    const { orchestrator, registry, stub1, m1 } = makeFixture('m1only');
    const sessionId = 'sess-ev-landing';
    await orchestrator.process(turn('first hello'), sessCtx(sessionId));

    // Trip every pair: aggregate down (health eviction), and the only landing
    // candidate is m1 itself → the guard refuses the switch, legacy force serves.
    const cb = registry.getCircuitBreakerManager();
    for (const c of chainP1) cb.tripPair(m1.id, c.keyHashPrefix, { cooldownMs: 600000 }, 'p1');
    // Hard-OPEN pairs (long cooldown): capability view reads 'unavailable'.
    expect(registry.modelHealthView(m1)).toBe('unavailable');

    const r2 = await orchestrator.process(turn('second hello'), sessCtx(sessionId));
    expect(r2.modelUsed).toBe(m1.id); // served via the last-candidate force
    expect(orchestrator.getSessionManager().getSession(sessionId)!.pinnedModel).toBe(m1.id);
    expect(stub1.seen[1]).toBeUndefined(); // no credential selector on the forced call
  });
});

describe('shadow mode: automatic trips never evict', () => {
  // Shadow runs the breaker accounting but flips an automatic trip's veto
  // (the verdict() contract) — routing serves the model anyway. An eviction
  // predicate that ignored the fold would burn KV caches on breakers that
  // deny nothing; MANUAL trips and takedowns enforce verbatim.
  const shadowBreaker = {
    enabled: true,
    shadow: true,
    failureThreshold: 1, // a single 503 auto-trips — the trip must be REAL
    initialCooldownMs: 600000,
    credentialAffinity: { cacheTtlMs: 300000 },
  };
  const diag5xx = {
    category: 'SERVICE_UNAVAILABLE' as const,
    statusCode: 503,
    isRetriable: true,
    isInPlaceRetriable: true,
    shouldTripBreaker: true,
    hardTrip: false,
    reason: 'upstream 503',
  };

  it('a shadowed model-scope trip reads available and the pin holds', async () => {
    const { orchestrator, registry, m1 } = makeFixture('both', { circuitBreaker: shadowBreaker });
    const sessionId = 'sess-ev-shadow';
    const r1 = await orchestrator.process(turn('first hello'), sessCtx(sessionId));
    expect(r1.modelUsed).toBe(m1.id);

    registry.getCircuitBreakerManager().recordFailure(m1.id, diag5xx, 'p1');
    // The trip really fired (accounting runs under shadow) — the fold is
    // what saves the view, not a missing state change.
    expect(registry.getCircuitBreakerManager().getSummary().tripped).toBe(1);
    expect(registry.modelHealthView(m1)).toBe('available');

    const r2 = await orchestrator.process(turn('second hello'), sessCtx(sessionId));
    expect(r2.modelUsed).toBe(m1.id); // still served — shadow denies nothing
    expect(orchestrator.getSessionManager().getSession(sessionId)!.pinnedModel).toBe(m1.id);
  });

  it('the same automatic trip WITHOUT shadow evicts (the fold is the discriminator)', async () => {
    const { orchestrator, registry, m1, m2 } = makeFixture('both', {
      circuitBreaker: { ...shadowBreaker, shadow: false },
    });
    const sessionId = 'sess-ev-noshadow';
    await orchestrator.process(turn('first hello'), sessCtx(sessionId));

    registry.getCircuitBreakerManager().recordFailure(m1.id, diag5xx, 'p1');
    expect(registry.getCircuitBreakerManager().getSummary().tripped).toBe(1);
    expect(registry.modelHealthView(m1)).toBe('unavailable');

    const r2 = await orchestrator.process(turn('second hello'), sessCtx(sessionId));
    expect(r2.modelUsed).toBe(m2.id);
    expect(orchestrator.getSessionManager().getSession(sessionId)!.pinnedModel).toBe(m2.id);
    expect(lastTurnParams(orchestrator, sessionId)).toMatchObject({ repin: 'health', repinFrom: m1.id, repinTo: m2.id });
  });
});

describe('eviction scope: only ratchet-mode pins are hard-switched', () => {
  it('explicit requests still serve a config-evicted model (explicit-wins contract)', async () => {
    const { orchestrator, registry, stub1, m1 } = makeFixture();
    const sessionId = 'sess-ev-explicit';
    await orchestrator.process(turn('first hello', 'p1/alpha'), sessCtx(sessionId));

    commitMembers(registry, { plus: [{ pattern: 'p2/*' }] }); // m1 unclassified

    const r2 = await orchestrator.process(turn('second hello', 'p1/alpha'), sessCtx(sessionId));
    expect(r2.modelUsed).toBe(m1.id); // client named it, registry still has it
    expect(stub1.seen).toHaveLength(2);
  });

  it('combos keep serving a tier-evicted member (the combo list IS the combo pool)', async () => {
    const config = makeConfig(loadConfig(), {
      combos: [{ id: 'evcombo', models: [ALPHA, BETA] }],
    });
    const registry = new ProviderRegistry(config, false);
    registry.setAutoRefreshTierMatch(false);
    const stub1 = makeStub('p1');
    const stub2 = makeStub('p2');
    const m1 = mkModel(ALPHA, 'p1', 'plus', true);
    const m2 = mkModel(BETA, 'p2', 'plus', false);
    registry.registerProvider('p1', stub1.provider, chainP1);
    registry.registerProvider('p2', stub2.provider, chainP2);
    registry.registerModel(m1, true);
    registry.registerModel(m2);
    // (the constructor already applied config.combos — member lists own the pool)
    const orchestrator = new PipelineOrchestrator(config, registry, new FinOpsTracker());

    commitMembers(registry, { plus: [{ pattern: 'p2/*' }] }); // m1 unclassified by tier
    const r = await orchestrator.process(turn('combo hello', 'evcombo'), sessCtx('sess-ev-combo'));
    expect(r.modelUsed).toBe(m1.id); // member list owns the combo pool; tier eviction is not combo eviction
  });
});

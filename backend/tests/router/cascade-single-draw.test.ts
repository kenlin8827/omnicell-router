import '../helpers/sandbox-home.js';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RouterConfig, SessionConfig, TierMemberRule } from '../../src/config/types.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { FinOpsTracker } from '../../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../../src/pipeline/orchestrator.js';
import {
  RouteEntryStore,
  applyRouteEntriesConfig,
  getRouteEntryStore,
  promptHashOf,
  setRouteEntryStoreForTests,
} from '../../src/router/route-entries.js';
import { processIR } from '../helpers/ir.js';

/**
 * The lite-lead schema cascade draws EXACTLY ONCE per leg it serves.
 *
 * A JSON-contract request routed to a tier (here via an experience-table hit)
 * arms the cascade: a lite leg runs first, and on an assertion failure the
 * request escalates to `fallback.escalateTier`. Before the hoisted predicate,
 * the pre-execution auto leader was drawn BEFORE the cascade was chosen, so
 * every cascade-eligible request advanced the tier cursor twice and discarded
 * the first draw — a 3:1 pool paired its picks (plus-2 every turn, pro/ultra
 * draws burned). The placeholder the cascade path still needs for the effort
 * preview is the pool HEAD, never a draw.
 *
 * These use `strategy: 'stateless'` so the request takes the no-pin path, where
 * the pre-execution auto draw (the bug) actually existed; a pinned session
 * supplies the model up front and never took that draw. The cascade itself
 * runs for pinned sessions too — a pin does not suppress it.
 */

let storeDir: string;

beforeAll(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cascade-draw-'));
  setRouteEntryStoreForTests(new RouteEntryStore(path.join(storeDir, 'route-entries.json')));
  applyRouteEntriesConfig({ enabled: true });
});

afterAll(() => {
  setRouteEntryStoreForTests(null);
  try {
    fs.rmSync(storeDir, { recursive: true, force: true });
  } catch {
    /* sandbox */
  }
});

function seedEntry(prompt: string, tier: 'lite' | 'plus'): void {
  getRouteEntryStore().upsert({ promptHash: promptHashOf(prompt), tier, source: 'human', confidence: 1.0 });
}

const makeConfig = (session?: SessionConfig): RouterConfig => ({
  port: 3000,
  host: '127.0.0.1',
  baselineModel: 'plus-1',
  fallback: {
    enabled: true,
    maxRetries: 1,
    escalateTier: 'plus',
    injectErrorContext: false,
  },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 3,
  },
  retry: {
    enabled: true,
    inplace: { enabled: true, maxAttempts: 1, backoffMs: 10, jitterMs: 5 },
    failover: { enabled: true, maxAttempts: 3, tierCrossPolicy: 'allow_escalate' },
  },
  session: session ?? { enabled: true, strategy: 'stateless' },
  models: [
    {
      id: 'lite-1',
      provider: 'mock',
      upstreamModel: 'lite-1',
      tier: 'lite',
      priority: 1,
      isDefaultInTier: true,
      pricing: { input: 0.15, cacheRead: 0.015, output: 0.6 },
    },
    {
      id: 'lite-2',
      provider: 'mock',
      upstreamModel: 'lite-2',
      tier: 'lite',
      priority: 2,
      pricing: { input: 0.15, cacheRead: 0.015, output: 0.6 },
    },
    {
      id: 'plus-1',
      provider: 'mock',
      upstreamModel: 'plus-1',
      tier: 'plus',
      priority: 1,
      isDefaultInTier: true,
      pricing: { input: 3.0, cacheRead: 0.3, output: 15.0 },
    },
    {
      id: 'plus-2',
      provider: 'mock',
      upstreamModel: 'plus-2',
      tier: 'plus',
      priority: 2,
      pricing: { input: 3.0, cacheRead: 0.3, output: 15.0 },
    },
  ],
  tiers: {
    lite: {
      selection: 'round_robin',
      members: [{ pattern: 'lite-1' }, { pattern: 'lite-2' }] as TierMemberRule[],
    },
    plus: {
      selection: 'round_robin',
      members: [{ pattern: 'plus-1' }, { pattern: 'plus-2' }] as TierMemberRule[],
    },
  },
});

function makeOrchestrator(session?: SessionConfig): { registry: ProviderRegistry; orchestrator: PipelineOrchestrator } {
  const config = makeConfig(session);
  const registry = new ProviderRegistry(config, true);
  // Hermetic: the lazy disk replay would replace the member pools with the
  // developer's config.yaml and drop this test's strategy/members.
  registry.setAutoRefreshMembers(false);
  const orchestrator = new PipelineOrchestrator(config, registry, new FinOpsTracker());
  return { registry, orchestrator };
}

async function runAuto(
  orchestrator: PipelineOrchestrator,
  prompt: string,
  opts: { sessionId: string; json?: boolean; malformed?: boolean },
) {
  return processIR(orchestrator, {
    model: 'auto',
    messages: [{ role: 'user', content: prompt }],
    ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    router_options: { session_id: opts.sessionId },
    ...(opts.malformed ? { __simulate_malformed__: true } : {}),
  } as any);
}

describe('lite-lead cascade — one draw per served leg', () => {
  it('a plus entry that escalates serves the plus rotation once per request', async () => {
    const prompt = 'cascade plus escalation probe';
    seedEntry(prompt, 'plus');
    const { orchestrator } = makeOrchestrator();
    const served: string[] = [];
    for (let i = 0; i < 4; i++) {
      // Malformed lite output fails the static assertion, forcing escalation.
      const r = await runAuto(orchestrator, prompt, { sessionId: 'cascade-plus', json: true, malformed: true });
      assert.equal(r.tierUsed, 'plus', `turn ${i} tier`);
      served.push(r.modelUsed!);
    }
    // Before the skip-draw fix the pre-execution auto draw burned every second
    // plus pick, so the escalation leg served plus-2 on every turn.
    assert.deepEqual(served, ['plus-1', 'plus-2', 'plus-1', 'plus-2']);
  });

  it('a lite entry that passes the assertion serves the lite rotation once per request', async () => {
    const prompt = 'cascade lite pass probe';
    seedEntry(prompt, 'lite');
    const { orchestrator } = makeOrchestrator();
    const served: string[] = [];
    for (let i = 0; i < 4; i++) {
      // Valid JSON output passes the assertion, so the lite leg is the answer.
      const r = await runAuto(orchestrator, prompt, { sessionId: 'cascade-lite', json: true });
      assert.equal(r.tierUsed, 'lite', `turn ${i} tier`);
      served.push(r.modelUsed!);
    }
    // Same skip-draw contract on the lite leg: without it the pre-draw and the
    // cascade draw paired up and lite-2 served every turn (lite-1 never did).
    assert.deepEqual(served, ['lite-1', 'lite-2', 'lite-1', 'lite-2']);
  });
});
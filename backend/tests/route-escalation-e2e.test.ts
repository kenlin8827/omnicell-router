import { describe, it, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { loadConfig } from '../src/config/index.js';
import { getEnvPaths } from '../src/config/env.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { registerConsoleRoutes } from '../src/routes/console.js';
import { ChatCompletionRequest, ChatCompletionMessage } from '../src/types/openai.js';
import { promptHashOf, getRouteEntryStore } from '../src/router/route-entries.js';

/**
 * Retry-escalation ladder, end to end through the REAL orchestrator in mock
 * mode (ADR-0011) — the integration seam the unit tests don't cover. The
 * message arrays ACCUMULATE like a real chat client (history + the repeated
 * prompt as the last message): the session conversation key hashes the FIRST
 * user message, and a turn-1-SHAPED resend ([A] alone) deliberately mints a
 * fresh session (session-manager anti-false-merge) — so bare stateless
 * resends are OUTSIDE the ladder's session scope by design.
 *
 * Capability note: mock models declare no thinking support, so turn 2's
 * effort+1 write ('low') is honestly clamped to 'none' by the pinned-model
 * branch (reasoningDegraded) — exactly the executor-clamp behavior the
 * planner trusts it for; the ladder recovers on turn 3 with the tier step.
 */

const config = loadConfig();
const registry = new ProviderRegistry(config, true); // mockMode — mock-lite/plus/pro/ultra
const orchestrator = new PipelineOrchestrator(config, registry, new FinOpsTracker());

const PROMPT_A = 'Write a distributed lock service in Go with fencing tokens';
const PROMPT_B = 'Actually explain the locking protocol with a sequence diagram';

const user = (text: string): ChatCompletionMessage => ({ role: 'user', content: text });
const assistant = (text: string): ChatCompletionMessage => ({ role: 'assistant', content: text });

async function turn(...messages: ChatCompletionMessage[]) {
  const req: ChatCompletionRequest = { model: 'auto', messages };
  return orchestrator.process(req);
}

describe('Retry escalation — orchestrator end to end (mock mode)', () => {
  const store = getRouteEntryStore();
  const hashA = promptHashOf(PROMPT_A);
  let sessionId = '';

  it('turn 1: fresh prompt serves the plus baseline and records retry state', async () => {
    const r = await turn(user(PROMPT_A));
    assert.equal(r.tierUsed, 'plus');
    assert.ok(r.sessionId);
    sessionId = r.sessionId!;
    const retry = orchestrator.getSessionManager().getSession(sessionId)?.retry;
    assert.equal(retry?.lastPromptHash, hashA);
    assert.equal(retry?.lastOutcomeOk, true);
    assert.equal(retry?.retryCount, 0);
    assert.equal(retry?.escalated, false);
  });

  it('turn 2: same prompt is attempt 1 — effort+1 written, executor clamps honestly', async () => {
    // Real-client resend shape: history + the repeated prompt last.
    const r = await turn(user(PROMPT_A), assistant('mock reply one'), user(PROMPT_A));
    assert.equal(r.tierUsed, 'plus', 'effort step keeps the tier');
    assert.equal(r.requestedEffort, 'low', 'planner wrote next(none)=low into the request');
    assert.equal(r.actualEffort, 'none', 'mock pin supports no thinking — clamped');
    assert.equal(r.reasoningDegraded, true);
    const retry = orchestrator.getSessionManager().getSession(sessionId)?.retry;
    assert.equal(retry?.retryCount, 1);
    assert.equal(retry?.escalated, true);
    // Retry attribution survives the ratchet's session.* rewrite (merged params).
    const trace = orchestrator.getTraceTracker().getRecentTraces().data[0];
    assert.equal(trace?.routing?.reasonParams?.retry, 'effort');
    assert.equal(trace?.routing?.reasonParams?.attempt, 1);
  });

  it('turn 3: same prompt again is attempt 2 — tier+1 to pro, effort falls back', async () => {
    const r = await turn(
      user(PROMPT_A),
      assistant('mock reply one'),
      user(PROMPT_A),
      assistant('mock reply two'),
      user(PROMPT_A)
    );
    assert.equal(r.tierUsed, 'pro');
    assert.equal(r.requestedEffort, undefined, 'tier step drops the effort write');
    const session = orchestrator.getSessionManager().getSession(sessionId);
    assert.equal(session?.pinnedModel, 'mock-pro', 'upgrade re-pins through the ratchet');
    assert.equal(session?.maxTier, 'pro');
    assert.equal(session?.retry?.retryCount, 2);
  });

  it('turn 4: a different prompt in the SAME session observes correction → write-back', async () => {
    const r = await turn(
      user(PROMPT_A),
      assistant('mock reply one'),
      user(PROMPT_A),
      assistant('mock reply two'),
      user(PROMPT_A),
      assistant('mock reply three'),
      user(PROMPT_B)
    );
    assert.equal(r.tierUsed, 'pro', 'the session ratchet floor (turn 3 escalated) holds — never a downgrade');
    const entry = store.peek(hashA);
    assert.ok(entry, 'correction created the row');
    assert.equal(entry?.source, 'correction');
    assert.equal(entry?.tier, 'pro', 'the ESCALATED tier is what gets remembered');
    assert.equal(entry?.confidence, 1.0);
  });

  it('turn 5: asking prompt A again hits the experience table (entry short-circuits)', async () => {
    const r = await turn(
      user(PROMPT_A),
      assistant('mock reply one'),
      user(PROMPT_A),
      assistant('mock reply two'),
      user(PROMPT_A),
      assistant('mock reply three'),
      user(PROMPT_B),
      assistant('mock reply four'),
      user(PROMPT_A)
    );
    assert.equal(r.layerUsed, 'entry');
    assert.equal(r.tierUsed, 'pro', 'the entry tier (correction knowledge) is served');
  });

  it('routing ledger recorded the whole lifecycle (hash-only, append-only)', async () => {
    await new Promise((resolve) => setTimeout(resolve, 60)); // fire-and-forget appends
    const file = path.join(getEnvPaths().dataDir, 'routing-ledger.jsonl');
    const kinds = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { kind: string }).kind);
    assert.equal(kinds.filter((k) => k === 'retry_detected').length, 2);
    assert.equal(kinds.filter((k) => k === 'escalation').length, 2);
    assert.equal(kinds.filter((k) => k === 'correction').length, 1);
    const correctionIdx = kinds.indexOf('correction');
    const entryHitIdx = kinds.indexOf('entry_hit');
    assert.ok(entryHitIdx > correctionIdx, 'entry hit lands after the correction that fed it');
    assert.ok(!fs.readFileSync(file, 'utf8').includes(PROMPT_A), 'prompt text never enters the ledger');
  });
});

describe('Route-entry console API contract (what /route-entries consumes)', () => {
  const app = Fastify();
  registerConsoleRoutes(app, registry, orchestrator);
  const store = getRouteEntryStore();
  const hash = promptHashOf('Console API contract probe prompt for the table');

  afterAll(async () => {
    await app.close();
  });

  it('GET lists rows with the gate attached', async () => {
    store.upsert({ promptHash: hash, tier: 'plus', source: 'l2_confident', confidence: 0.9, snippet: 'probe' });
    const res = await app.inject({ method: 'GET', url: '/api/admin/route-entries' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'ok');
    assert.ok(Array.isArray(body.rows));
    assert.ok(body.gate && typeof body.gate.enabled === 'boolean');
    const row = body.rows.find((r: { promptHash: string }) => r.promptHash === hash);
    assert.ok(row, 'the seeded row is listed');
    assert.equal(row.snippet, 'probe');
    assert.equal(row.sessionCount, 0);
  });

  it('PATCH lands an immutable human row; bad tier is a loud 400; unknown hash is 404', async () => {
    const ok = await app.inject({ method: 'PATCH', url: `/api/admin/route-entries/${hash}`, payload: { tier: 'ultra' } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().entry.source, 'human');
    assert.equal(ok.json().entry.confidence, 1.0);
    // The immunity contract, through the real route: automatic writes can't
    // drag the human row back down.
    store.upsert({ promptHash: hash, tier: 'lite', source: 'correction', confidence: 1.0 });
    assert.equal(store.peek(hash)?.tier, 'ultra');
    // effort validates against the ladder (null clears)
    const effort = await app.inject({ method: 'PATCH', url: `/api/admin/route-entries/${hash}`, payload: { tier: 'ultra', effort: 'high' } });
    assert.equal(effort.statusCode, 200);
    assert.equal(store.peek(hash)?.effort, 'high');
    const bad = await app.inject({ method: 'PATCH', url: `/api/admin/route-entries/${hash}`, payload: { tier: 'mega' } });
    assert.equal(bad.statusCode, 400);
    const missing = await app.inject({ method: 'PATCH', url: '/api/admin/route-entries/deadbeef', payload: { tier: 'pro' } });
    assert.equal(missing.statusCode, 404);
  });

  it('DELETE removes the row', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/admin/route-entries/${hash}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().removed, true);
    assert.equal(store.peek(hash), undefined);
  });
});

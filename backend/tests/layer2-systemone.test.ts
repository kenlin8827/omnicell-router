import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { serve } from 'bun';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { bootServer, makeConfig as seamMakeConfig } from './helpers/systemone-seam.js';
// This suite always runs with the Layer 2 micro-classifier disabled —
// pin it once instead of threading the option through every call site.
const makeConfig = (providers: any[], models: any[], systemone?: any): RouterConfig =>
  seamMakeConfig(providers, models, { systemone, disableLayer2Classifier: true });
import { ModelRegistration, RouterConfig } from '../src/config/types.js';
import { Layer2Decision } from '../src/router/layer2-decision.js';
import { RouterEngine } from '../src/router/index.js';
import { CaptureRecorder } from '../src/capture/recorder.js';
import { resetDecisionCaptureConfig } from '../src/capture/decision-capture.js';
import { getRouteEntryStore, normalizePrompt, promptHashOf } from '../src/router/route-entries.js';
import { getEnvPaths } from '../src/config/env.js';
import { flushRoutingLedgerForTests } from '../src/router/routing-ledger.js';
import { DEFAULT_LAYER2_EFFORT_FLOOR } from '../src/config/defaults.js';
import { ChatCompletionRequest, ChatCompletionResponse } from '../src/types/openai.js';

// ---------------------------------------------------------------------------
// Layer 2 rides the gateway's own System One protocol — no vendor
// SDK. These tests pin the contract: the decision layer speaks a well-formed System One
// request to a registered model, reads the tier out of the typed answer, and
// degrades to null (→ caller falls back to the plus baseline) on every failure mode.
// Plus: decision-call CAPTURE (the single requestCapture.enabled master
// → upstream-direction event pair with purpose 'l2-decision' on the OUTER
// request's trace/session) and the dataset sink's single-key gate
// (classifier.layer2.collectEnabled).
// ---------------------------------------------------------------------------
const originalCwd = process.cwd();
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-layer2-'));
const sandbox = path.join(sandboxRoot, 'plain');
fs.mkdirSync(sandbox);
// Config + state resolve from OCR_HOME (never the cwd) — isolate a throwaway
// home whose bootstrap `default` env holds the placeholder config.
process.env.OCR_HOME = path.join(sandboxRoot, 'home');
// Owns its home → declares its book-set name (the runner's tripwire name
// `itest` exists only in the runner's own sandbox home).
process.env.OCR_ENV = 'default';
const ENV_DIR = path.join(process.env.OCR_HOME, 'envs', 'default');
fs.mkdirSync(ENV_DIR, { recursive: true });
fs.writeFileSync(path.join(ENV_DIR, 'config.yaml'), 'schemaVersion: 1\nclient:\n  port: 3000\n  host: 127.0.0.1\n  apiKeys: []\n');
fs.writeFileSync(path.join(ENV_DIR, 'env.json'), JSON.stringify({ name: 'default', type: 'regular', schemaVersion: 1 }));
process.chdir(sandbox);

afterAll(() => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function fakeChat(content: string): ChatCompletionResponse {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1700000000,
    model: 'upstream',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  } as ChatCompletionResponse;
}

/** Chat completion wrapping a decision-answers body (converted decision layer path). */
function chatAnswers(answers: any): ChatCompletionResponse {
  return fakeChat(JSON.stringify({ answers }));
}

const PROOF = "Prove Fermat's Last Theorem.";

beforeEach(() => {
  Layer2Decision.clearDecisionCache();
  resetDecisionCaptureConfig();
  // Capture tests assert file presence/absence — start each from clean disk.
  try {
    fs.rmSync(path.join(ENV_DIR, 'data'), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('Layer 2 decision capture (dataset sink — single-key gate classifier.layer2.collectEnabled)', () => {
  const capturePath = () => path.join(ENV_DIR, 'data', 'layer2-decisions.jsonl');

  test('enabled: a decision-model decision lands as one parseable row', async () => {
    fs.writeFileSync(path.join(ENV_DIR, 'config.yaml'),
      'schemaVersion: 1\nclient:\n  port: 3000\n  host: 127.0.0.1\n  apiKeys: []\nrouting:\n  classifier:\n    layer2:\n      collectEnabled: true\n');
    const upstream = serve({
      port: 0,
      async fetch() {
        return Response.json(chatAnswers({ tier: { type: 'choice', choice: 'plus', confidence: 0.77 } }));
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-cap', type: 'openai-compatible', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test' }],
        [{ id: 'l2-cap/jev', provider: 'l2-cap', upstreamModel: 'jev', tier: 'plus', pricing: { input: 0, output: 0, cacheRead: 0 } }]
      );
      const { registry } = bootServer(config);
      const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: PROOF }] };

      const result = await Layer2Decision.evaluate(request, { enabled: true, model: 'l2-cap/jev', timeoutMs: 5000 }, registry);
      expect(result).not.toBeNull();
      await new Promise((r) => setTimeout(r, 100));

      const lines = fs.readFileSync(capturePath(), 'utf8').trim().split('\n');
      expect(lines.length).toBe(1);
      const row = JSON.parse(lines[0]);
      expect(row.source).toBe('layer2_decision');
      expect(row.model).toBe('l2-cap/jev');
      expect(row.upstreamKind).toBe('converted');
      expect(row.tier).toBe('plus');
      expect(row.confidence).toBeCloseTo(0.77, 10);
      expect(row.state).toBe(`user: ${PROOF}`);
      expect(typeof row.latencyMs).toBe('number');
    } finally {
      upstream.stop(true);
    }
  });

  test('default off: zero writes', async () => {
    fs.writeFileSync(path.join(ENV_DIR, 'config.yaml'), 'schemaVersion: 1\nclient:\n  port: 3000\n  host: 127.0.0.1\n  apiKeys: []\n');
    const upstream = serve({
      port: 0,
      async fetch() {
        return Response.json(chatAnswers({ tier: { type: 'choice', choice: 'lite', confidence: 0.9 } }));
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-cap2', type: 'openai-compatible', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test' }],
        [{ id: 'l2-cap2/jev', provider: 'l2-cap2', upstreamModel: 'jev', tier: 'plus', pricing: { input: 0, output: 0, cacheRead: 0 } }]
      );
      const { registry } = bootServer(config);
      await Layer2Decision.evaluate(
        { model: 'auto', messages: [{ role: 'user', content: PROOF }] },
        { enabled: true, model: 'l2-cap2/jev', timeoutMs: 5000 },
        registry
      );
      await new Promise((r) => setTimeout(r, 100));
      expect(fs.existsSync(capturePath())).toBe(false);
    } finally {
      upstream.stop(true);
    }
  });

  test('an abandoned late result never lands in the dataset', async () => {
    fs.writeFileSync(path.join(ENV_DIR, 'config.yaml'),
      'schemaVersion: 1\nclient:\n  port: 3000\n  host: 127.0.0.1\n  apiKeys: []\nrouting:\n  classifier:\n    layer2:\n      collectEnabled: true\n');
    const upstream = serve({
      port: 0,
      async fetch() {
        // Valid answer, but slower than the decision layer deadline.
        await new Promise((r) => setTimeout(r, 400));
        return Response.json(chatAnswers({ tier: { type: 'choice', choice: 'ultra', confidence: 0.99 } }));
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-cap3', type: 'openai-compatible', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test', timeoutMs: 60_000 }],
        [{ id: 'l2-cap3/jev', provider: 'l2-cap3', upstreamModel: 'jev', tier: 'plus', pricing: { input: 0, output: 0, cacheRead: 0 } }]
      );
      const { registry } = bootServer(config);
      const result = await Layer2Decision.evaluate(
        { model: 'auto', messages: [{ role: 'user', content: PROOF }] },
        { enabled: true, model: 'l2-cap3/jev', timeoutMs: 150 },
        registry
      );
      expect(result).toBeNull();
      await new Promise((r) => setTimeout(r, 800));
      expect(fs.existsSync(capturePath())).toBe(false);
    } finally {
      upstream.stop(true);
    }
  });
});

describe('Layer 2 decision layer speaks the System One protocol', () => {
  test('System One decision layer upstream: typed answers become the routing tier', async () => {
    let received: any = null;
    const upstream = serve({
      port: 0,
      async fetch(req) {
        received = await req.json();
        return Response.json(chatAnswers({ tier: { type: 'choice', choice: 'pro', probabilities: { lite: 0, plus: 0.05, pro: 0.93, ultra: 0.02 }, confidence: 0.91 } }));
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-native', type: 'openai-compatible', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test' }],
        [
          {
            id: 'l2-native/jev',
            provider: 'l2-native',
            upstreamModel: 'jev-latest',
            tier: 'plus',
            pricing: { input: 0, output: 0, cacheRead: 0 },
          },
        ]
      );
      const { registry } = bootServer(config);
      const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: PROOF }] };

      const result = await Layer2Decision.evaluate(
        request,
        { enabled: true, model: 'l2-native/jev', timeoutMs: 5000 },
        registry
      );

      expect(result).not.toBeNull();
      expect(result!.targetTier).toBe('pro');
      expect(result!.confidence).toBeCloseTo(0.91, 10);
      expect(result!.model).toBe('l2-native/jev');
      expect(result!.reasonCode).toBe('l2.system_one_uncalibrated');
      expect(result!.reasonParams).toEqual({ model: 'l2-native/jev', tier: 'pro' });
      expect(result!.reason).toContain('not yet calibrated');

      // The upstream saw the JSON-constrained chat call: the STATE/QUESTIONS
      // payload rides inside the user message, model = upstream id.
      expect(received.model).toBe('jev-latest');
      expect(received.messages[0].role).toBe('system');
      const wirePayload = JSON.parse(received.messages[1].content.split('\n').slice(1).join('\n'));
      expect(wirePayload.state).toBe(`user: ${PROOF}`);
      expect(wirePayload.questions.tier.type).toBe('choice');
      expect(Object.keys(wirePayload.questions.tier.criteria).sort()).toEqual(['lite', 'plus', 'pro', 'ultra']);
      expect(String(wirePayload.questions.tier.instructions)).toContain('NEVER decide difficulty by character length');
    } finally {
      upstream.stop(true);
    }
  });

  test('records the last wire-attempt outcome (fail → ok; cache hits never overwrite)', async () => {
    let fail = true;
    const upstream = serve({
      port: 0,
      async fetch() {
        if (fail) return new Response('{"error":{"message":"quota exhausted"}}', { status: 429 });
        return Response.json(chatAnswers({ tier: { type: 'choice', choice: 'plus', confidence: 0.9 } }));
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-native', type: 'openai-compatible', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test' }],
        [
          {
            id: 'l2-native/jev',
            provider: 'l2-native',
            upstreamModel: 'jev-latest',
            tier: 'plus',
            pricing: { input: 0, output: 0, cacheRead: 0 },
          },
        ]
      );
      const { registry } = bootServer(config);
      const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: PROOF }] };
      const decisionConfig = { enabled: true, model: 'l2-native/jev', timeoutMs: 5000 } as const;

      // Wire attempt fails → the console surface gets a failure record.
      expect(await Layer2Decision.evaluate(request, decisionConfig, registry)).toBeNull();
      const failed = Layer2Decision.getLastOutcome();
      expect(failed).not.toBeNull();
      expect(failed!.ok).toBe(false);
      expect(failed!.modelId).toBe('l2-native/jev');
      expect(String(failed!.error)).toContain('429');

      // Next attempt succeeds → the failure record is replaced.
      fail = false;
      expect(await Layer2Decision.evaluate(request, decisionConfig, registry)).not.toBeNull();
      const okOutcome = Layer2Decision.getLastOutcome();
      expect(okOutcome!.ok).toBe(true);
      expect(okOutcome!.latencyMs).toBeGreaterThanOrEqual(0);

      // A cache hit is NOT a wire attempt: the record must stay untouched.
      const before = Layer2Decision.getLastOutcome()!.ts;
      expect(await Layer2Decision.evaluate(request, decisionConfig, registry)).not.toBeNull();
      expect(Layer2Decision.getLastOutcome()!.ts).toBe(before);
    } finally {
      upstream.stop(true);
    }
  });

  test('any registered chat model serves the decision layer by conversion, flagged uncalibrated', async () => {
    const seen: any[] = [];
    const upstream = serve({
      port: 0,
      async fetch(req) {
        seen.push(await req.json());
        return Response.json(
          fakeChat(
            JSON.stringify({
              answers: {
                tier: { choice: 'ultra', confidence: 0.62, probabilities: { lite: 0, plus: 0, pro: 0.1, ultra: 0.9 } },
              },
            })
          )
        );
      },
    });
    try {
      const config = makeConfig(
        [
          {
            name: 'l2-chat',
            type: 'openai-compatible',
            baseUrl: `http://localhost:${upstream.port}`,
            apiKey: 'sk-test',
            timeoutMs: 5000,
          },
        ],
        [
          {
            id: 'l2-chat/model',
            provider: 'l2-chat',
            upstreamModel: 'upstream-chat',
            tier: 'plus',
            pricing: { input: 1, output: 1, cacheRead: 0 },
          },
        ]
      );
      const { registry } = bootServer(config);
      const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: PROOF }] };

      const result = await Layer2Decision.evaluate(request, { enabled: true, timeoutMs: 5000 }, registry, 'l2-chat/model');

      expect(result).not.toBeNull();
      expect(result!.targetTier).toBe('ultra');
      expect(result!.confidence).toBeCloseTo(0.62, 10);
      // Fidelity is visible in the code/params: a converted answer is a self-report.
      expect(result!.reasonCode).toBe('l2.system_one_uncalibrated');
      expect(result!.reasonParams).toEqual({ model: 'l2-chat/model', tier: 'ultra' });
      expect(result!.reason).toContain('not yet calibrated');
      expect(seen.length).toBe(1);
      expect(seen[0].response_format).toEqual({ type: 'json_object' });
      expect(String(seen[0].messages[0].content)).toContain('System One');
    } finally {
      upstream.stop(true);
    }
  });

  test('an identical context hits the decision cache instead of the model', async () => {
    let calls = 0;
    const upstream = serve({
      port: 0,
      async fetch() {
        calls++;
        return Response.json(chatAnswers({ tier: { type: 'choice', choice: 'plus', confidence: 0.8 } }));
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-cache', type: 'openai-compatible', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test' }],
        [
          {
            id: 'l2-cache/jev',
            provider: 'l2-cache',
            upstreamModel: 'jev',
            tier: 'plus',
            pricing: { input: 0, output: 0, cacheRead: 0 },
          },
        ]
      );
      const { registry } = bootServer(config);
      const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: PROOF }] };
      const config2 = { enabled: true, model: 'l2-cache/jev', timeoutMs: 5000 };

      const first = await Layer2Decision.evaluate(request, config2, registry);
      const second = await Layer2Decision.evaluate(request, config2, registry);

      expect(first!.targetTier).toBe('plus');
      expect(second!.targetTier).toBe('plus');
      expect(second!.reason).toContain('[Decision Cache]');
      // A hit propagates the cached code/params and only flags `cached` —
      // no cache-specific code, and the stored entry stays unflagged.
      expect(second!.reasonCode).toBe(first!.reasonCode);
      expect(second!.reasonParams?.cached).toBe(true);
      expect(first!.reasonParams?.cached).toBeUndefined();
      expect(calls).toBe(1);
    } finally {
      upstream.stop(true);
    }
  });

  test('every failure mode degrades to null instead of throwing', async () => {
    const upstream = serve({
      port: 0,
      fetch() {
        return new Response('upstream exploded', { status: 500 });
      },
    });
    try {
      const config = makeConfig(
        [
          {
            name: 'l2-fail',
            type: 'openai-compatible',
            baseUrl: `http://localhost:${upstream.port}`,
            apiKey: 'sk-test',
            timeoutMs: 5000,
          },
        ],
        [
          {
            id: 'l2-fail/model',
            provider: 'l2-fail',
            upstreamModel: 'upstream-chat',
            tier: 'plus',
            pricing: { input: 1, output: 1, cacheRead: 0 },
          },
        ]
      );
      const { registry } = bootServer(config);
      const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: PROOF }] };

      // Decision off.
      expect(await Layer2Decision.evaluate(request, { enabled: false, model: 'l2-fail/model' }, registry)).toBeNull();
      // No model configured anywhere.
      expect(await Layer2Decision.evaluate(request, { enabled: true }, registry)).toBeNull();
      // Model not registered.
      expect(await Layer2Decision.evaluate(request, { enabled: true, model: 'nope/absent' }, registry)).toBeNull();
      // Upstream 500 → upstream_error is swallowed, routing falls back.
      expect(await Layer2Decision.evaluate(request, { enabled: true, model: 'l2-fail/model', timeoutMs: 5000 }, registry)).toBeNull();
    } finally {
      upstream.stop(true);
    }
  });

  test('the decision layer deadline returns null so the cascade keeps moving', async () => {
    const upstream = serve({
      port: 0,
      // Never answers — only the decision layer's own deadline can end this call.
      fetch() {
        return new Promise<Response>(() => {});
      },
    });
    try {
      const config = makeConfig(
        [
          {
            name: 'l2-slow',
            type: 'openai-compatible',
            baseUrl: `http://localhost:${upstream.port}`,
            apiKey: 'sk-test',
            timeoutMs: 60_000,
          },
        ],
        [
          {
            id: 'l2-slow/model',
            provider: 'l2-slow',
            upstreamModel: 'upstream-chat',
            tier: 'plus',
            pricing: { input: 1, output: 1, cacheRead: 0 },
          },
        ]
      );
      const { registry } = bootServer(config);
      const request: ChatCompletionRequest = { model: 'user', messages: [{ role: 'user', content: PROOF }] };

      const started = Date.now();
      const result = await Layer2Decision.evaluate(request, { enabled: true, model: 'l2-slow/model', timeoutMs: 300 }, registry);
      expect(result).toBeNull();
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      upstream.stop(true);
    }
  });
  test('a late result after the deadline must not poison the decision cache', async () => {
    // The decision layer gives up at 150ms; the upstream answers a VALID tier at 400ms.
    // The abandoned `.then` still runs — but only the race winner may write
    // the cache, so a second identical-context decision layer call must go upstream
    // again (2 calls total). Had the loser written the cache, this would be 1.
    const seen: number[] = [];
    const started = Date.now();
    const upstream = serve({
      port: 0,
      async fetch() {
        seen.push(Date.now() - started);
        await new Promise((r) => setTimeout(r, 400));
        return Response.json(chatAnswers({ tier: { type: 'choice', choice: 'pro', confidence: 0.9 } }));
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-late', type: 'openai-compatible', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test', timeoutMs: 60_000 }],
        [
          {
            id: 'l2-late/jev',
            provider: 'l2-late',
            upstreamModel: 'jev',
            tier: 'plus',
            pricing: { input: 0, output: 0, cacheRead: 0 },
          },
        ]
      );
      const { registry } = bootServer(config);
      const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: PROOF }] };
      const decisionCfg = { enabled: true, model: 'l2-late/jev', timeoutMs: 150 };

      expect(await Layer2Decision.evaluate(request, decisionCfg, registry)).toBeNull();
      // Immediate re-decision of the identical context: the abandoned call must
      // NOT have cached its answer.
      expect(await Layer2Decision.evaluate(request, decisionCfg, registry)).toBeNull();

      // Let both abandoned upstream calls finish landing.
      await new Promise((r) => setTimeout(r, 1200));
      expect(seen.length).toBe(2);
    } finally {
      upstream.stop(true);
    }
  });

  test('the deadline never fires a repair call after the decision layer gave up', async () => {
    // Regression guard: an unusable first reply used to trigger the conversion
    // repair retry EVEN AFTER the decision layer stopped waiting — a second full chat
    // call spent for an answer nobody reads. The decision layer's signal must suppress it.
    const seen: number[] = [];
    const started = Date.now();
    const upstream = serve({
      port: 0,
      async fetch() {
        seen.push(Date.now() - started);
        // Slow AND unusable → would force the repair retry if one still fired.
        await new Promise((r) => setTimeout(r, 250));
        return Response.json(fakeChat('I cannot do that.'));
      },
    });
    try {
      const config = makeConfig(
        [
          {
            name: 'l2-repair',
            type: 'openai-compatible',
            baseUrl: `http://localhost:${upstream.port}`,
            apiKey: 'sk-test',
            timeoutMs: 60_000,
          },
        ],
        [
          {
            id: 'l2-repair/model',
            provider: 'l2-repair',
            upstreamModel: 'upstream-chat',
            tier: 'plus',
            pricing: { input: 1, output: 1, cacheRead: 0 },
          },
        ]
      );
      const { registry } = bootServer(config);
      const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: PROOF }] };

      const result = await Layer2Decision.evaluate(request, { enabled: true, model: 'l2-repair/model', timeoutMs: 150 }, registry);
      expect(result).toBeNull();

      // Wait past the first call's own duration: no repair may have been sent.
      await new Promise((r) => setTimeout(r, 900));
      expect(seen.length).toBe(1);
    } finally {
      upstream.stop(true);
    }
  });

});

describe('retired Layer 2 vendor keys are stripped at load time', () => {
  test('provider / baseUrl / apiKey never survive a config round-trip', () => {
    const legacyPath = path.join(sandboxRoot, 'legacy-layer2.yaml');
    fs.writeFileSync(
      legacyPath,
      [
        'schemaVersion: 1',
        'client:',
        '  port: 3000',
        '  host: 127.0.0.1',
        '  apiKeys: []',
        'routing:',
        '  classifier:',
        '    layer2:',
        '      enabled: true',
        '      provider: "typesafe"',
        '      baseUrl: "https://api.typesafe.ai/v1"',
        '      apiKey: "sk-legacy"',
        '      timeoutMs: 900',
        '',
      ].join('\n')
    );
    const layer2 = loadConfig(legacyPath).classifier?.layer2 as Record<string, unknown>;
    expect(layer2.enabled).toBe(true);
    expect(layer2.timeoutMs).toBe(900);
    expect(layer2.provider).toBeUndefined();
    expect(layer2.baseUrl).toBeUndefined();
    expect(layer2.apiKey).toBeUndefined();
  });
});

describe('routeAsync wires the Layer 2 decision layer', () => {
  test('an enabled decision layer answers through routeAsync with layerUsed=layer2', async () => {
    const upstream = serve({
      port: 0,
      async fetch() {
        return Response.json(chatAnswers({ tier: { type: 'choice', choice: 'pro', probabilities: { pro: 1 }, confidence: 0.95 } }));
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-route', type: 'openai-compatible', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test' }],
        [
          {
            id: 'l2-route/jev',
            provider: 'l2-route',
            upstreamModel: 'jev',
            tier: 'plus',
            pricing: { input: 0, output: 0, cacheRead: 0 },
          },
        ]
      );
      const { registry } = bootServer(config);
      const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: PROOF }] };

      const decision = await RouterEngine.routeAsync(
        request,
        { layer2: { enabled: true, model: 'auto', timeoutMs: 5000 } },
        registry,
        'l2-route/jev' // systemone.defaultModel, reached via model: 'auto'
      );

      expect(decision.layerUsed).toBe('layer2');
      expect(decision.targetTier).toBe('pro');
    } finally {
      upstream.stop(true);
    }
  });

  test('no registry → the default plus baseline stands (decision layer-less callers keep working)', async () => {
    const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] };
    const decision = await RouterEngine.routeAsync(request, { layer2: { enabled: true } });
    expect(decision.layerUsed).toBe('layer0');
    expect(decision.targetTier).toBe('plus');
  });

  test('an enabled but unconfigured decision layer never silently picks a model — the default baseline answers', async () => {
    const upstream = serve({
      port: 0,
      async fetch() {
        return Response.json(chatAnswers({ tier: { type: 'choice', choice: 'ultra', probabilities: { ultra: 1 }, confidence: 0.99 } }));
      },
    });
    try {
      // Models exist, but NEITHER classifier.layer2.model NOR
      // systemone.defaultModel names one. The decision layer must stay inert rather
      // than cascade into the tier pool — System One serves the model named.
      const config = makeConfig(
        [
          {
            name: 'l2-unset',
            type: 'openai-compatible',
            baseUrl: `http://localhost:${upstream.port}`,
            apiKey: 'sk-test',
            timeoutMs: 5000,
          },
        ],
        [
          {
            id: 'l2-unset/lite',
            provider: 'l2-unset',
            upstreamModel: 'upstream-chat',
            tier: 'lite',
            pricing: { input: 1, output: 1, cacheRead: 0 },
          },
        ]
      );
      const { registry } = bootServer(config);
      const request: ChatCompletionRequest = {
        model: 'auto',
        messages: [{ role: 'user', content: PROOF }],
      };

      const decision = await RouterEngine.routeAsync(request, { layer2: { enabled: true } }, registry);

      expect(decision.layerUsed).toBe('layer0');
      expect(decision.targetTier).not.toBe('ultra');
    } finally {
      upstream.stop(true);
    }
  });
});
// ---------------------------------------------------------------------------
// L2-DECISION-CALL CAPTURE: when a routed chat turn cascades into the
// Layer 2 decision layer, the decision-model HTTP leg is recorded as an upstream-
// direction http-exchange PAIR attached to the OUTER request's trace/session,
// labeled purpose 'l2-decision'. Gate: the single requestCapture.enabled
// master, checked inside the decision layer — when off, EVERYTHING stays
// silent (the exact pre-feature call shape): the decision leg, the turn's own
// client and candidate-execution events alike. Both upstream classes
// are covered: the CONVERTED path (registry.execute plumbing) and the NATIVE
// Conversion path (registry.execute, fetch wrapped directly).
// ---------------------------------------------------------------------------
describe('decision-call capture (requestCapture.enabled master)', () => {
  interface Evt {
    eventType: string;
    direction: 'client' | 'upstream';
    phase: 'request' | 'response';
    spanId: string;
    traceId: string;
    sessionId: string;
    purpose?: string;
    wire: {
      requestLine: string;
      requestHeaders: Record<string, string>;
      requestBody: string;
      status: number;
    };
  }

  function readEvents(dir: string): Evt[] {
    const day = path.join(dir, CaptureRecorder.localDateDir(new Date()));
    if (!fs.existsSync(day)) return [];
    const out: Evt[] = [];
    for (const f of fs.readdirSync(day)) {
      for (const line of fs.readFileSync(path.join(day, f), 'utf8').split('\n').filter(Boolean)) {
        out.push(JSON.parse(line));
      }
    }
    return out;
  }

  async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error('capture events did not settle within timeout');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Route one real /v1/chat/completions turn whose Layer-2 decision layer dials the
   *  given provider kind; returns every http-exchange event written. */
  async function routedTurn(opts: { captureEnabled: boolean }): Promise<{ events: Evt[]; marker: string }> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-l2dec-cap-'));
    const marker = `DECCAP-${Date.now()}`;
    // Decision upstream: answers the System One question as a JSON-constrained
    // chat completion (converted path — the only path).
    const decisionSrv = serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch() {
        return Response.json(
          fakeChat(JSON.stringify({ answers: { tier: { choice: 'plus', confidence: 0.8, probabilities: { lite: 0, plus: 0.8, pro: 0.2, ultra: 0 } } } }))
        );
      },
    });
    // Execution upstream: serves the outer turn after the decision layer picks plus.
    const execUpstream = serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch() {
        return Response.json(fakeChat('executed after decision layer'));
      },
    });
    try {
      const decisionProvider = { name: 'jc-conv', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${decisionSrv.port}`, apiKey: 'sk-jc-secret-1', timeoutMs: 5000 };
      const decisionModel = {
        id: `${decisionProvider.name}/decider`,
        provider: decisionProvider.name,
        upstreamModel: 'l2dec-upstream',
        // ULTRA tier keeps the decision layer model OUT of the plus pool the decision layer
        // itself selects — the outer execution then demonstrably runs a
        // different (purpose-less) call.
        tier: 'ultra',
        pricing: { input: 1, output: 1, cacheRead: 0 },
      };
      const config = makeConfig(
        [decisionProvider, { name: 'jc-exec', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${execUpstream.port}`, apiKey: 'sk-exec-secret', timeoutMs: 5000 }],
        [
          decisionModel,
          { id: 'jc-exec/chat', provider: 'jc-exec', upstreamModel: 'exec-upstream', tier: 'plus', pricing: { input: 1, output: 1, cacheRead: 0 } },
        ]
      );
      config.requestCapture = {
        ...config.requestCapture,
        enabled: opts.captureEnabled,
        dir: tmp,
        retentionDays: 7,
        maxTotalMB: 64,
        maxBodyBytes: 65536,
      };
      config.classifier = {
        ...config.classifier,
        layer2: { enabled: true, model: decisionModel.id, timeoutMs: 5000 },
      };
      const { app } = bootServer(config);
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { 'content-type': 'application/json' },
          payload: { model: 'auto', messages: [{ role: 'user', content: `${PROOF} ${marker}` }] },
        });
        expect(res.statusCode).toBe(200);
        if (opts.captureEnabled) {
          // Settle: outer client pair + execution pair + the decision layer
          // pair (3 response events — the count is part of what the OFF/ON
          // pair pins).
          await waitUntil(() => readEvents(tmp).filter((e) => e.phase === 'response').length >= 3);
        } else {
          // Master-OFF settle: a leaked capture event would land within the
          // inject await already; 250ms mirrors the guard suites' window.
          await new Promise((r) => setTimeout(r, 250));
        }
        return { events: readEvents(tmp), marker };
      } finally {
        await app.close();
      }
    } finally {
      decisionSrv.stop(true);
      execUpstream.stop(true);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  function assertDecisionPair(events: Evt[], marker: string): void {
    const decisionEvents = events.filter((e) => e.purpose === 'l2-decision');
    expect(decisionEvents.length).toBe(2);
    const req = decisionEvents.find((e) => e.phase === 'request')!;
    const resp = decisionEvents.find((e) => e.phase === 'response')!;
    expect(req.direction).toBe('upstream');
    expect(resp.direction).toBe('upstream');
    expect(resp.spanId).toBe(req.spanId); // one exchange, two events
    // ATTACHED TO THE OUTER REQUEST'S IDENTITY: same trace/session as the
    // outer client-request event.
    const outer = events.find((e) => e.direction === 'client' && e.phase === 'request')!;
    expect(req.traceId).toBe(outer.traceId);
    expect(req.sessionId).toBe(outer.sessionId);
    // The decision layer's decision wire carried the conversation state (marker) and
    // the credential header reached disk ONLY redacted.
    expect(req.wire.requestBody).toContain(marker);
    expect(req.wire.requestHeaders.authorization).toBe('[REDACTED]');
    expect(resp.wire.status).toBe(200);
    // The candidate-execution leg exists as a SEPARATE purpose-less pair —
    // the purpose marker is what tells them apart.
    const exec = events.filter((e) => e.direction === 'upstream' && e.phase === 'request' && e.purpose === undefined);
    expect(exec.length).toBeGreaterThanOrEqual(1);
  }

  test('capture master ON: outer turn archives a purpose l2-decision upstream pair on the outer trace', async () => {
    const { events, marker } = await routedTurn({ captureEnabled: true });
    assertDecisionPair(events, marker);
  });

  test('capture master OFF: zero events at all — the decision ctx never passes, turn still served', async () => {
    const { events } = await routedTurn({ captureEnabled: false });
    expect(events.length).toBe(0);
  });

});

// ---------------------------------------------------------------------------
// ADR-0012: L2-emitted thinking effort. With classifier.layer2.
// effortDecision ON and a client-omitted reasoning_effort, the decision layer's ONE
// System One call asks tier AND effort (6-level ladder). Pinned here:
// the question shape on the wire, client-explicit suppression, tolerant
// parse (a garbled effort never sinks a good tier), the cache-namespace
// split on the gate, and the full chain (injection → serving payload →
// trace effortSource → experience-table learning).
// ---------------------------------------------------------------------------
describe('L2-emitted thinking effort (ADR-0012)', () => {
  const PRICING = { input: 1, output: 1, cacheRead: 0 };

  /** System One decision layer upstream answering the given answers body (converted). */
  function decisionUpstream(answers: any, onBody?: (body: any) => void) {
    return serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const body = await req.json();
        onBody?.(body);
        return Response.json(chatAnswers(answers));
      },
    });
  }

  function decisionOnlyConfig(port: number, name = 'je') {
    return makeConfig(
      [{ name, type: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-je', timeoutMs: 5000 }],
      [{ id: `${name}/jev`, provider: name, upstreamModel: 'jev', tier: 'ultra', pricing: PRICING }]
    );
  }

  test('gate ON + client omitted: the effort question rides the same call and parses into the result', async () => {
    let body: any = null;
    const upstream = decisionUpstream(
      {
        tier: { type: 'choice', choice: 'pro', confidence: 0.95 },
        effort: { type: 'choice', choice: 'high', confidence: 0.88 },
      },
      (b) => (body = b)
    );
    try {
      const { registry } = bootServer(decisionOnlyConfig(upstream.port));
      const result = await Layer2Decision.evaluate(
        { model: 'auto', messages: [{ role: 'user', content: PROOF }] },
        { enabled: true, model: 'je/jev', timeoutMs: 5000, effortDecision: true },
        registry
      );
      expect(result).not.toBeNull();
      expect(result!.targetTier).toBe('pro');
      expect(result!.effort).toBe('high');
      expect(result!.effortConfidence).toBeCloseTo(0.88, 10);
      expect(result!.reasonParams?.effort).toBe('high');
      // The wire carried BOTH questions; the effort answer space is the
      // full 6-level ladder, 'none' included.
      const wirePayload = JSON.parse(body.messages[1].content.split('\n').slice(1).join('\n'));
      expect(Object.keys(wirePayload.questions).sort()).toEqual(['effort', 'tier']);
      expect(Object.keys(wirePayload.questions.effort.criteria)).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
      expect(wirePayload.questions.effort.type).toBe('choice');
    } finally {
      upstream.stop(true);
    }
  });

  test('client-explicit reasoning_effort suppresses the effort question entirely', async () => {
    let body: any = null;
    const upstream = decisionUpstream(
      { tier: { type: 'choice', choice: 'plus', confidence: 0.9 } },
      (b) => (body = b)
    );
    try {
      const { registry } = bootServer(decisionOnlyConfig(upstream.port, 'je2'));
      const result = await Layer2Decision.evaluate(
        { model: 'auto', messages: [{ role: 'user', content: PROOF }], reasoning_effort: 'low' },
        { enabled: true, model: 'je2/jev', timeoutMs: 5000, effortDecision: true },
        registry
      );
      // Never second-guess the client: the question was not even asked.
      const wirePayload = JSON.parse(body.messages[1].content.split('\n').slice(1).join('\n'));
      expect(Object.keys(wirePayload.questions)).toEqual(['tier']);
      expect(result!.effort).toBeUndefined();
    } finally {
      upstream.stop(true);
    }
  });

  test('gate OFF (default): no effort question, no effort in the result — even when the upstream volunteers one', async () => {
    let body: any = null;
    const upstream = decisionUpstream(
      {
        tier: { type: 'choice', choice: 'plus', confidence: 0.9 },
        effort: { type: 'choice', choice: 'max', confidence: 0.99 }, // ignored
      },
      (b) => (body = b)
    );
    try {
      const { registry } = bootServer(decisionOnlyConfig(upstream.port, 'je3'));
      const result = await Layer2Decision.evaluate(
        { model: 'auto', messages: [{ role: 'user', content: PROOF }] },
        { enabled: true, model: 'je3/jev', timeoutMs: 5000 },
        registry
      );
      const wirePayload = JSON.parse(body.messages[1].content.split('\n').slice(1).join('\n'));
      expect(Object.keys(wirePayload.questions)).toEqual(['tier']);
      expect(result!.effort).toBeUndefined();
    } finally {
      upstream.stop(true);
    }
  });

  test('a garbled effort answer never sinks a good tier decision', async () => {
    // Converted-path semantics: a choice outside the criteria keys cannot
    // survive synthesis — the answer is REPAIRED to the argmax probability
    // ('high' here) and the tier decision stands.
    const upstream = decisionUpstream({
      tier: { type: 'choice', choice: 'pro', probabilities: { lite: 0, plus: 0.05, pro: 0.93, ultra: 0.02 }, confidence: 0.93 },
      effort: { type: 'choice', choice: 'banana', probabilities: { none: 0, low: 0, medium: 0, high: 1, xhigh: 0, max: 0 }, confidence: 0.7 },
    });
    try {
      const { registry } = bootServer(decisionOnlyConfig(upstream.port, 'je4'));
      const result = await Layer2Decision.evaluate(
        { model: 'auto', messages: [{ role: 'user', content: PROOF }] },
        { enabled: true, model: 'je4/jev', timeoutMs: 5000, effortDecision: true },
        registry
      );
      expect(result).not.toBeNull();
      expect(result!.targetTier).toBe('pro');
      expect(result!.effort).toBe('high');
    } finally {
      upstream.stop(true);
    }
  });

  test('the decision cache namespaces on the gate: effort answers never leak across modes', async () => {
    let calls = 0;
    const upstream = decisionUpstream(
      {
        tier: { type: 'choice', choice: 'pro', confidence: 0.9 },
        effort: { type: 'choice', choice: 'low', confidence: 0.9 },
      },
      () => calls++
    );
    try {
      const { registry } = bootServer(decisionOnlyConfig(upstream.port, 'je5'));
      const req: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: PROOF }] };
      const on = { enabled: true, model: 'je5/jev', timeoutMs: 5000, effortDecision: true };

      const first = await Layer2Decision.evaluate(req, on, registry);
      expect(first!.effort).toBe('low');
      const second = await Layer2Decision.evaluate(req, on, registry);
      expect(second!.reason).toContain('[Decision Cache]');
      expect(second!.effort).toBe('low'); // the effort answer survives the cache round-trip
      expect(calls).toBe(1); // the second judgment was served from cache

      // Gate OFF: same state, different namespace → a fresh decision layer call, no effort.
      const off = await Layer2Decision.evaluate(req, { enabled: true, model: 'je5/jev', timeoutMs: 5000 }, registry);
      expect(off!.effort).toBeUndefined();
      expect(off!.reason).not.toContain('[Decision Cache]');
      expect(calls).toBe(2);
    } finally {
      upstream.stop(true);
    }
  });

  test('full chain: L2-decided effort reaches the serving payload, the X-OCR headers, the trace, and the experience table', async () => {
    const execSeen: any[] = [];
    const decisionSrv = decisionUpstream({
      tier: { type: 'choice', choice: 'pro', confidence: 0.95 },
      effort: { type: 'choice', choice: 'high', confidence: 0.88 },
    });
    const exec = serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        execSeen.push(await req.json());
        return Response.json(fakeChat('served with L2 decision effort'));
      },
    });
    try {
      const config = makeConfig(
        [
          { name: 'fc-decision', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${decisionSrv.port}`, apiKey: 'sk-j', timeoutMs: 5000 },
          { name: 'fc-exec', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${exec.port}`, apiKey: 'sk-e', timeoutMs: 5000 },
        ],
        [
          // ULTRA keeps the decision layer model out of the pro pool it selects.
          { id: 'fc-decision/jev', provider: 'fc-decision', upstreamModel: 'jev', tier: 'ultra', pricing: PRICING },
          {
            id: 'fc-exec/pro-chat',
            provider: 'fc-exec',
            upstreamModel: 'pro-chat',
            tier: 'pro',
            pricing: PRICING,
            supportedReasoningEfforts: ['low', 'medium', 'high'],
          },
        ]
      );
      config.classifier = {
        ...config.classifier,
        layer2: { enabled: true, model: 'fc-decision/jev', timeoutMs: 5000, effortDecision: true },
      };
      const { app, orchestrator } = bootServer(config);
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { 'content-type': 'application/json' },
          payload: { model: 'auto', messages: [{ role: 'user', content: PROOF }] },
        });
        expect(res.statusCode).toBe(200);

        // 1. The serving upstream received the L2-decided level.
        expect(execSeen.length).toBe(1);
        expect(execSeen[0].reasoning_effort).toBe('high');

        // 2. The client sees the effective ask AND its author.
        expect(res.headers['x-ocr-tier']).toBe('pro');
        expect(res.headers['x-ocr-thinking-requested']).toBe('high');
        expect(res.headers['x-ocr-thinking-actual']).toBe('high');
        expect(res.headers['x-ocr-thinking-degraded']).toBe('false');
        expect(res.headers['x-ocr-thinking-source']).toBe('l2-decision');

        // 3. The trace attributes the ask to the decision layer (ADR-0012 §2).
        const sessionId = String(res.headers['x-ocr-session-id']);
        const traces = orchestrator.getTraceTracker().getTracesBySession(sessionId);
        expect(traces.length).toBe(1);
        expect(traces[0].execution.requestedEffort).toBe('high');
        expect(traces[0].execution.actualEffort).toBe('high');
        expect(traces[0].execution.reasoningDegraded).toBe(false);
        expect(traces[0].execution.effortSource).toBe('l2-decision');

        // 4. The experience table learned the level with the tier
        //    (l2_confident write-back — confidence 0.95 ≥ 0.85).
        const entry = getRouteEntryStore().peek(promptHashOf(normalizePrompt(PROOF)));
        expect(entry).toBeDefined();
        expect(entry!.tier).toBe('pro');
        expect(entry!.effort).toBe('high');
        expect(entry!.source).toBe('l2_confident');
      } finally {
        await app.close();
      }
    } finally {
      decisionSrv.stop(true);
      exec.stop(true);
    }
  });

  test('effortFloor: an L2 decision BELOW the floor serves AT the floor and ledgers the clamp', async () => {
    const execSeen: any[] = [];
    // NOT `PROOF`: an earlier test in this file writes a PROOF experience row
    // (with its own effort) into the process-wide route-entry store, and
    // `beforeEach` cannot evict it — an entry hit would pre-empt the L2
    // injection this case is about.
    const FLOOR_PROMPT = 'Explain why the floor exists.';
    // The decision layer picks 'none' — below the default floor ('low').
    // ADR-0011 §6: automatic machinery never strips thinking below the floor;
    // the only lever lower is the user's @ocr-effort-down.
    const decisionSrv = decisionUpstream({
      tier: { type: 'choice', choice: 'pro', confidence: 0.95 },
      effort: { type: 'choice', choice: 'none', confidence: 0.9 },
    });
    const exec = serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        execSeen.push(await req.json());
        return Response.json(fakeChat('served at the floor'));
      },
    });
    try {
      const config = makeConfig(
        [
          { name: 'fl-decision', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${decisionSrv.port}`, apiKey: 'sk-j', timeoutMs: 5000 },
          { name: 'fl-exec', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${exec.port}`, apiKey: 'sk-e', timeoutMs: 5000 },
        ],
        [
          { id: 'fl-decision/jev', provider: 'fl-decision', upstreamModel: 'jev', tier: 'ultra', pricing: PRICING },
          {
            id: 'fl-exec/pro-chat',
            provider: 'fl-exec',
            upstreamModel: 'pro-chat',
            tier: 'pro',
            pricing: PRICING,
            supportedReasoningEfforts: ['low', 'medium', 'high'],
          },
        ]
      );
      config.classifier = {
        ...config.classifier,
        layer2: { enabled: true, model: 'fl-decision/jev', timeoutMs: 5000, effortDecision: true },
      };
      const { app, orchestrator } = bootServer(config);
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { 'content-type': 'application/json' },
          payload: { model: 'auto', messages: [{ role: 'user', content: FLOOR_PROMPT }] },
        });
        expect(res.statusCode).toBe(200);

        // The wire carries the FLOOR, not the sub-floor decision.
        expect(execSeen[0].reasoning_effort).toBe(DEFAULT_LAYER2_EFFORT_FLOOR);
        expect(res.headers['x-ocr-thinking-requested']).toBe(DEFAULT_LAYER2_EFFORT_FLOOR);
        expect(res.headers['x-ocr-thinking-source']).toBe('l2-decision');

        // The clamp is ledgered so the operator sees whose judgement landed.
        await flushRoutingLedgerForTests();
        const ledgerFile = path.join(getEnvPaths().dataDir, 'routing-ledger.jsonl');
        const rows = fs
          .readFileSync(ledgerFile, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
        const clamp = rows.find((r) => r.kind === 'effort_change');
        expect(clamp).toBeDefined();
        expect(clamp.detail).toMatchObject({
          source: 'l2-decision',
          baseline: 'floor',
          from: 'none',
          to: DEFAULT_LAYER2_EFFORT_FLOOR,
        });
      } finally {
        await app.close();
      }
    } finally {
      decisionSrv.stop(true);
      exec.stop(true);
    }
  });
});

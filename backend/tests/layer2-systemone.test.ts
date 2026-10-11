import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { serve } from 'bun';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config/index.js';
import { ModelRegistration, RouterConfig } from '../src/config/types.js';
import { Layer2Judge } from '../src/router/layer2-judge.js';
import { RouterEngine } from '../src/router/index.js';
import { SystemoneProvider } from '../src/providers/systemone.js';
import { resetDecisionCaptureConfig } from '../src/flywheel/decision-capture.js';
import { ChatCompletionRequest, ChatCompletionResponse } from '../src/types/openai.js';

// ---------------------------------------------------------------------------
// Layer 2 rides the gateway's own System One protocol — no vendor
// SDK. These tests pin the contract: the judge speaks a well-formed System One
// request to a registered model, reads the tier out of the typed answer, and
// degrades to null (→ caller falls back to Layer 1) on every failure mode.
// ---------------------------------------------------------------------------
const originalCwd = process.cwd();
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-layer2-'));
const sandbox = path.join(sandboxRoot, 'plain');
fs.mkdirSync(sandbox);
// getConfigPath() prefers cwd/config.yaml — isolate from the repo's real one.
fs.writeFileSync(path.join(sandbox, 'config.yaml'), 'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\n');
process.chdir(sandbox);

afterAll(() => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function makeConfig(providers: any[], models: any[], systemone?: any): RouterConfig {
  const base = loadConfig();
  return {
    ...base,
    apiKeys: [],
    providers,
    models,
    ...(systemone ? { systemone } : {}),
    classifier: { ...base.classifier, layer2: { ...base.classifier?.layer2, enabled: false } },
    capture: { ...base.capture, enabled: false },
    flywheel: { ...base.flywheel, enabled: false },
    session: { ...base.session, enabled: false },
    tracePersist: { ...base.tracePersist, enabled: false },
  } as RouterConfig;
}

function fakeChat(content: string): ChatCompletionResponse {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1700000000,
    model: 'upstream',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  } as ChatCompletionResponse;
}

const PROOF = "Prove Fermat's Last Theorem.";

beforeEach(() => {
  Layer2Judge.clearDecisionCache();
  resetDecisionCaptureConfig();
  // Capture tests assert file presence/absence — start each from clean disk.
  try {
    fs.rmSync(path.join(sandbox, 'data'), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('Layer 2 decision capture (opt-in sink)', () => {
  const capturePath = () => path.join(sandbox, 'data', 'layer2-decisions.jsonl');

  test('enabled: a judged decision lands as one parseable row', async () => {
    fs.writeFileSync(path.join(sandbox, 'config.yaml'),
      'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\nclassifier:\n  layer2:\n    decisionCapture:\n      enabled: true\n');
    const upstream = serve({
      port: 0,
      async fetch() {
        return Response.json({ answers: { tier: { type: 'choice', choice: 'plus', confidence: 0.77 } } });
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-cap', type: 'systemone', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test' }],
        [{ id: 'l2-cap/jev', provider: 'l2-cap', upstreamModel: 'jev', tier: 'plus', pricing: { input: 0, output: 0, cacheRead: 0 } }]
      );
      const { registry } = createServer(config);
      const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: PROOF }] };

      const result = await Layer2Judge.evaluate(request, { enabled: true, model: 'l2-cap/jev', timeoutMs: 5000 }, registry);
      expect(result).not.toBeNull();
      await new Promise((r) => setTimeout(r, 100));

      const lines = fs.readFileSync(capturePath(), 'utf8').trim().split('\n');
      expect(lines.length).toBe(1);
      const row = JSON.parse(lines[0]);
      expect(row.source).toBe('layer2_judge');
      expect(row.model).toBe('l2-cap/jev');
      expect(row.upstreamKind).toBe('native');
      expect(row.tier).toBe('plus');
      expect(row.confidence).toBeCloseTo(0.77, 10);
      expect(row.state).toBe(`user: ${PROOF}`);
      expect(typeof row.latencyMs).toBe('number');
    } finally {
      upstream.stop(true);
    }
  });

  test('default off: zero writes', async () => {
    fs.writeFileSync(path.join(sandbox, 'config.yaml'), 'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\n');
    const upstream = serve({
      port: 0,
      async fetch() {
        return Response.json({ answers: { tier: { type: 'choice', choice: 'lite', confidence: 0.9 } } });
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-cap2', type: 'systemone', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test' }],
        [{ id: 'l2-cap2/jev', provider: 'l2-cap2', upstreamModel: 'jev', tier: 'plus', pricing: { input: 0, output: 0, cacheRead: 0 } }]
      );
      const { registry } = createServer(config);
      await Layer2Judge.evaluate(
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
    fs.writeFileSync(path.join(sandbox, 'config.yaml'),
      'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\nclassifier:\n  layer2:\n    decisionCapture:\n      enabled: true\n');
    const upstream = serve({
      port: 0,
      async fetch() {
        // Valid answer, but slower than the judge deadline.
        await new Promise((r) => setTimeout(r, 400));
        return Response.json({ answers: { tier: { type: 'choice', choice: 'ultra', confidence: 0.99 } } });
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-cap3', type: 'systemone', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test', timeoutMs: 60_000 }],
        [{ id: 'l2-cap3/jev', provider: 'l2-cap3', upstreamModel: 'jev', tier: 'plus', pricing: { input: 0, output: 0, cacheRead: 0 } }]
      );
      const { registry } = createServer(config);
      const result = await Layer2Judge.evaluate(
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

describe('Layer 2 judge speaks the System One protocol', () => {
  test('native System One upstream: typed answers become the routing tier', async () => {
    let received: any = null;
    const upstream = serve({
      port: 0,
      async fetch(req) {
        received = await req.json();
        return Response.json({
          model: 'jev-1.13.0',
          answers: {
            tier: {
              type: 'choice',
              choice: 'pro',
              probabilities: { lite: 0, plus: 0.05, pro: 0.93, ultra: 0.02 },
              confidence: 0.91,
            },
          },
        });
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-native', type: 'systemone', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test' }],
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
      const { registry } = createServer(config);
      const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: PROOF }] };

      const result = await Layer2Judge.evaluate(
        request,
        { enabled: true, model: 'l2-native/jev', timeoutMs: 5000 },
        registry
      );

      expect(result).not.toBeNull();
      expect(result!.targetTier).toBe('pro');
      expect(result!.confidence).toBeCloseTo(0.91, 10);
      expect(result!.model).toBe('l2-native/jev');
      expect(result!.reason).toContain('System One (l2-native/jev)');
      expect(result!.reason).not.toContain('uncalibrated');

      // The upstream saw a well-formed System One request, not a vendor wire.
      expect(received.state).toBe(`user: ${PROOF}`);
      expect(received.questions.tier.type).toBe('choice');
      expect(Object.keys(received.questions.tier.criteria).sort()).toEqual(['lite', 'plus', 'pro', 'ultra']);
      expect(String(received.questions.tier.instructions)).toContain('NEVER judge difficulty by character length');
      expect(received.model).toBe('jev-latest');
    } finally {
      upstream.stop(true);
    }
  });

  test('any registered chat model serves the judge by conversion, flagged uncalibrated', async () => {
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
      const { registry } = createServer(config);
      const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: PROOF }] };

      const result = await Layer2Judge.evaluate(request, { enabled: true, timeoutMs: 5000 }, registry, 'l2-chat/model');

      expect(result).not.toBeNull();
      expect(result!.targetTier).toBe('ultra');
      expect(result!.confidence).toBeCloseTo(0.62, 10);
      // Fidelity is visible in the reason: a converted answer is a self-report.
      expect(result!.reason).toContain('uncalibrated self-report');
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
        return Response.json({ answers: { tier: { type: 'choice', choice: 'plus', confidence: 0.8 } } });
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-cache', type: 'systemone', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test' }],
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
      const { registry } = createServer(config);
      const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: PROOF }] };
      const config2 = { enabled: true, model: 'l2-cache/jev', timeoutMs: 5000 };

      const first = await Layer2Judge.evaluate(request, config2, registry);
      const second = await Layer2Judge.evaluate(request, config2, registry);

      expect(first!.targetTier).toBe('plus');
      expect(second!.targetTier).toBe('plus');
      expect(second!.reason).toContain('[Decision Cache]');
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
      const { registry } = createServer(config);
      const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: PROOF }] };

      // Judge off.
      expect(await Layer2Judge.evaluate(request, { enabled: false, model: 'l2-fail/model' }, registry)).toBeNull();
      // No model configured anywhere.
      expect(await Layer2Judge.evaluate(request, { enabled: true }, registry)).toBeNull();
      // Model not registered.
      expect(await Layer2Judge.evaluate(request, { enabled: true, model: 'nope/absent' }, registry)).toBeNull();
      // Upstream 500 → upstream_error is swallowed, routing falls back.
      expect(await Layer2Judge.evaluate(request, { enabled: true, model: 'l2-fail/model', timeoutMs: 5000 }, registry)).toBeNull();
    } finally {
      upstream.stop(true);
    }
  });

  test('the judge deadline returns null so the cascade keeps moving', async () => {
    const upstream = serve({
      port: 0,
      // Never answers — only the judge's own deadline can end this call.
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
      const { registry } = createServer(config);
      const request: ChatCompletionRequest = { model: 'user', messages: [{ role: 'user', content: PROOF }] };

      const started = Date.now();
      const result = await Layer2Judge.evaluate(request, { enabled: true, model: 'l2-slow/model', timeoutMs: 300 }, registry);
      expect(result).toBeNull();
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      upstream.stop(true);
    }
  });
  test('a late result after the deadline must not poison the decision cache', async () => {
    // The judge gives up at 150ms; the upstream answers a VALID tier at 400ms.
    // The abandoned `.then` still runs — but only the race winner may write
    // the cache, so a second identical-context judge call must go upstream
    // again (2 calls total). Had the loser written the cache, this would be 1.
    const seen: number[] = [];
    const started = Date.now();
    const upstream = serve({
      port: 0,
      async fetch() {
        seen.push(Date.now() - started);
        await new Promise((r) => setTimeout(r, 400));
        return Response.json({ answers: { tier: { type: 'choice', choice: 'pro', confidence: 0.9 } } });
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-late', type: 'systemone', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test', timeoutMs: 60_000 }],
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
      const { registry } = createServer(config);
      const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: PROOF }] };
      const judge = { enabled: true, model: 'l2-late/jev', timeoutMs: 150 };

      expect(await Layer2Judge.evaluate(request, judge, registry)).toBeNull();
      // Immediate re-judge of the identical context: the abandoned call must
      // NOT have cached its answer.
      expect(await Layer2Judge.evaluate(request, judge, registry)).toBeNull();

      // Let both abandoned upstream calls finish landing.
      await new Promise((r) => setTimeout(r, 1200));
      expect(seen.length).toBe(2);
    } finally {
      upstream.stop(true);
    }
  });

  test('the deadline never fires a repair call after the judge gave up', async () => {
    // Regression guard: an unusable first reply used to trigger the conversion
    // repair retry EVEN AFTER the judge stopped waiting — a second full chat
    // call spent for an answer nobody reads. The judge's signal must suppress it.
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
      const { registry } = createServer(config);
      const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: PROOF }] };

      const result = await Layer2Judge.evaluate(request, { enabled: true, model: 'l2-repair/model', timeoutMs: 150 }, registry);
      expect(result).toBeNull();

      // Wait past the first call's own duration: no repair may have been sent.
      await new Promise((r) => setTimeout(r, 900));
      expect(seen.length).toBe(1);
    } finally {
      upstream.stop(true);
    }
  });

  test('an abandoned native call is aborted for real, not left running', async () => {
    // The native client owns its transport, so the judge's signal must tear
    // the request down promptly — proof: it rejects at ~150ms instead of
    // hanging until the provider's own 60s timeout.
    const upstream = serve({
      port: 0,
      fetch() {
        return new Promise<Response>(() => {}); // never answers
      },
    });
    try {
      const provider = new SystemoneProvider({
        name: 'abort-native',
        type: 'systemone',
        baseUrl: `http://localhost:${upstream.port}`,
        apiKey: 'sk-test',
        timeoutMs: 60_000,
      });
      const model: ModelRegistration = {
        id: 'abort-native/jev',
        provider: 'abort-native',
        upstreamModel: 'jev',
        tier: 'plus',
        pricing: { input: 0, output: 0, cacheRead: 0 },
      };

      const controller = new AbortController();
      const started = Date.now();
      const pending = provider.createDecision({ state: 's', questions: {} }, model, controller.signal);
      setTimeout(() => controller.abort(), 150);

      let rejected = false;
      await pending.then(
        () => undefined,
        () => {
          rejected = true;
        }
      );
      expect(rejected).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
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
        'port: 3000',
        'host: 127.0.0.1',
        'apiKeys: []',
        'models: []',
        'classifier:',
        '  layer2:',
        '    enabled: true',
        '    provider: "typesafe"',
        '    baseUrl: "https://api.typesafe.ai/v1"',
        '    apiKey: "sk-legacy"',
        '    timeoutMs: 900',
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

describe('routeAsync wires the Layer 2 judge', () => {
  test('an enabled judge answers through routeAsync with layerUsed=layer2', async () => {
    const upstream = serve({
      port: 0,
      async fetch() {
        return Response.json({
          answers: { tier: { type: 'choice', choice: 'pro', probabilities: { pro: 1 }, confidence: 0.95 } },
        });
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'l2-route', type: 'systemone', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test' }],
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
      const { registry } = createServer(config);
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

  test('no registry → Layer 1 decision stands (classifier-only callers keep working)', async () => {
    const request: ChatCompletionRequest = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] };
    const decision = await RouterEngine.routeAsync(request, { layer2: { enabled: true } });
    expect(decision.layerUsed).toBe('layer1');
  });

  test('an enabled but unconfigured judge never silently picks a model — Layer 1 answers', async () => {
    const upstream = serve({
      port: 0,
      async fetch() {
        return Response.json({
          answers: { tier: { type: 'choice', choice: 'ultra', probabilities: { ultra: 1 }, confidence: 0.99 } },
        });
      },
    });
    try {
      // Models exist, but NEITHER classifier.layer2.model NOR
      // systemone.defaultModel names one. The judge must stay inert rather
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
      const { registry } = createServer(config);
      const request: ChatCompletionRequest = {
        model: 'auto',
        messages: [{ role: 'user', content: PROOF }],
      };

      const decision = await RouterEngine.routeAsync(request, { layer2: { enabled: true } }, registry);

      expect(decision.layerUsed).toBe('layer1');
      expect(decision.targetTier).not.toBe('ultra');
    } finally {
      upstream.stop(true);
    }
  });
});
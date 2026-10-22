import { afterAll, describe, expect, test } from 'bun:test';
import { serve } from 'bun';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config/index.js';
import { __resetEnvResolutionForTests } from '../src/config/env.js';
import { RouterConfig } from '../src/config/types.js';
import {
  buildDecisionChatRequest,
  decisionReasoningEffort,
  synthesizeSystemoneResponse,
  validateSystemoneRequest,
} from '../src/protocols/systemone/convert.js';
import { ChatCompletionResponse } from '../src/types/openai.js';

// ---------------------------------------------------------------------------
// Isolation: config resolves from OCR_HOME (envs/<env>/config.yaml) and
// request-time code re-reads the disk config per call, so a sandbox switch is
// an OCR_ENV swap plus a resolution-cache reset. The operator's real
// ~/.onecast-router config — api keys, per-key policies, webAuth — must never
// leak into these tests.
// ---------------------------------------------------------------------------
const originalCwd = process.cwd();
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-systemone-'));
const sandboxPlain = path.join(sandboxRoot, 'plain');
const sandboxDefault = path.join(sandboxRoot, 'with-default');
fs.mkdirSync(sandboxPlain);
fs.mkdirSync(sandboxDefault);
process.env.OCR_HOME = path.join(sandboxRoot, 'home');
const baseYaml = 'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\n';

/** Materialize a sandbox environment under the throwaway OCR_HOME. */
function seedSandboxEnv(name: string, yaml: string): void {
  const dir = path.join(process.env.OCR_HOME as string, 'envs', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), yaml);
  fs.writeFileSync(path.join(dir, 'env.json'), JSON.stringify({ name, type: 'regular', schemaVersion: 1 }));
}

seedSandboxEnv('plain', baseYaml);
seedSandboxEnv('with-default', baseYaml + 'systemone:\n  defaultModel: "test/chat"\n');
process.env.OCR_ENV = 'plain';
process.chdir(sandboxPlain);

function useSandbox(name: 'plain' | 'with-default'): void {
  process.env.OCR_ENV = name;
  __resetEnvResolutionForTests(); // "switch = restart": re-resolve against the new env
  process.chdir(name === 'plain' ? sandboxPlain : sandboxDefault);
}

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
    requestCapture: { ...base.requestCapture, enabled: false },
    session: { ...base.session, enabled: false },
    tracePersist: { ...base.tracePersist, enabled: false },
  } as RouterConfig;
}

const REQ = {
  state: { ticket: 'T-1001', content: 'Paid twice for one order, please fix.' },
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { billing: 'payments/refunds', technical: 'bugs/outages' },
    },
    escalate: { type: 'noul', instructions: 'Needs immediate escalation?' },
    severity: { type: 'score', instructions: 'How severe?', criteria: ['minor', 'degraded', 'broken'] },
  },
} as any;

function fakeChat(content: string): ChatCompletionResponse {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1700000000,
    model: 'upstream',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  } as ChatCompletionResponse;
}

describe('System One: request validation', () => {
  test('accepts a well-formed request', () => {
    const v = validateSystemoneRequest(REQ);
    expect(v.ok).toBe(true);
  });

  test('rejects malformed requests', () => {
    expect(validateSystemoneRequest(null).ok).toBe(false);
    expect(validateSystemoneRequest({ questions: REQ.questions }).ok).toBe(false);
    expect(validateSystemoneRequest({ ...REQ, questions: {} }).ok).toBe(false);
    expect(validateSystemoneRequest({ ...REQ, questions: { q: { type: 'mystery' } } }).ok).toBe(false);
    expect(validateSystemoneRequest({ ...REQ, questions: { q: { type: 'choice', criteria: {} } } }).ok).toBe(false);
    expect(validateSystemoneRequest({ ...REQ, questions: { q: { type: 'score', criteria: ['only'] } } }).ok).toBe(false);
  });
});

describe('System One: chat request synthesis', () => {
  test('one call carries every question + the JSON contract', () => {
    const chat = buildDecisionChatRequest(REQ, 'test/chat');
    expect(chat.response_format).toEqual({ type: 'json_object' });
    expect(chat.temperature).toBe(0);
    expect(chat.model).toBe('test/chat');
    const user = String((chat.messages[1] as any).content);
    expect(user).toContain('department');
    expect(user).toContain('severity');
    expect(user).toContain('T-1001');
    expect(String((chat.messages[0] as any).content)).toContain('System One');
  });

  test('repair mode appends the bad output and the reason', () => {
    const chat = buildDecisionChatRequest(REQ, 'test/chat', {
      previousOutput: '{"oops": true}',
      reason: "'escalate': no answer object",
    });
    expect(chat.messages.length).toBe(4);
    expect((chat.messages[2] as any).role).toBe('assistant');
    expect(String((chat.messages[3] as any).content)).toContain('could not be used');
  });
});

describe('System One: reasoning-effort pin', () => {
  test('lowest trustworthy level: explicit → its lowest, coarse boolean → low, undeclared → omitted', () => {
    // Explicit declaration → its lowest level ('none' is trusted only here).
    expect(decisionReasoningEffort({ supportedReasoningEfforts: ['none', 'low', 'high'] })).toBe('none');
    expect(decisionReasoningEffort({ supportedReasoningEfforts: ['medium', 'low', 'high'] })).toBe('low');
    // Coarse legacy boolean certifies "thinking-capable", NOT that the
    // vendor enum accepts 'none' → start at the lowest universally-safe level.
    expect(decisionReasoningEffort({ supportsReasoningEffort: true })).toBe('low');
    // Operator effortMap translation wins over capability inference.
    expect(decisionReasoningEffort({ effortMap: { none: 'low' } })).toBe('low');
    // No explicit effort control → omit the field entirely.
    expect(decisionReasoningEffort({})).toBeUndefined();
  });
});

describe('System One: answer synthesis', () => {
  test('converts a full valid answer set (fenced JSON, case-insensitive options)', () => {
    const content =
      '```json\n' +
      JSON.stringify({
        answers: {
          department: { choice: 'Billing', confidence: 0.88, probabilities: { billing: 9, technical: 1 } },
          escalate: { noul: 0.95 },
          severity: { score: 2, probabilities: { '0': 0, '1': 0.1, '2': 0.9 } },
        },
      }) +
      '\n```';
    const r = synthesizeSystemoneResponse(fakeChat(content), REQ, 'test/chat');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ans = r.response.answers as any;
    expect(ans.department.choice).toBe('billing');
    expect(ans.department.probabilities.billing).toBeCloseTo(0.9, 10);
    expect(ans.department.probabilities.technical).toBeCloseTo(0.1, 10);
    expect(ans.department.confidence).toBe(0.88);
    expect(ans.escalate.noul).toBe(0.95);
    expect(ans.severity.score).toBe(2);
    expect(ans.severity.legend).toEqual({ '0': 'minor', '1': 'degraded', '2': 'broken' });
    expect(r.response.usage).toEqual({ input_tokens: 12, output_tokens: 7 });
  });

  test('score without a declared index uses the probability-weighted expectation', () => {
    const content = JSON.stringify({
      answers: {
        department: { choice: 'billing' },
        escalate: { noul: 'yes' },
        severity: { probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 } },
      },
    });
    const r = synthesizeSystemoneResponse(fakeChat(content), REQ, 'test/chat');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ans = r.response.answers as any;
    expect(ans.severity.score).toBeCloseTo(1.6, 10);
    expect(ans.escalate.noul).toBe(1);
    expect(ans.department.probabilities).toEqual({ billing: 1, technical: 0 });
  });

  test('reports unusable answers instead of fabricating them', () => {
    const r = synthesizeSystemoneResponse(fakeChat('I think it is billing!'), REQ, 'test/chat');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('JSON');

    const r2 = synthesizeSystemoneResponse(
      fakeChat(JSON.stringify({ answers: { department: { choice: 'sales' } } })),
      REQ,
      'test/chat'
    );
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toContain('department');
    expect(r2.reason).toContain('escalate');
    expect(r2.reason).toContain('severity');
  });
});

describe('POST /v1/systemone end-to-end', () => {
  test('native provider passthrough', async () => {
    useSandbox('plain');
    let received: any = null;
    const upstream = serve({
      port: 0,
      async fetch(req) {
        received = await req.json();
        return Response.json({
          model: 'jev-1.13.0',
          answers: {
            department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.94, technical: 0.06 }, confidence: 0.88 },
          },
          usage: { input_tokens: 125, output_tokens: 0 },
        });
      },
    });
    try {
      const config = makeConfig(
        [{ name: 'native-test', type: 'systemone', baseUrl: `http://localhost:${upstream.port}`, apiKey: 'sk-test' }],
        [
          {
            id: 'native-test/jev',
            provider: 'native-test',
            upstreamModel: 'jev-latest',
            tier: 'lite',
            pricing: { input: 0, output: 0, cacheRead: 0 },
          },
        ]
      );
      const { app } = createServer(config);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/systemone',
        payload: { ...REQ, model: 'native-test/jev' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.answers.department.choice).toBe('billing');
      expect(body.usage.input_tokens).toBe(125);
      expect(received.model).toBe('jev-latest');
      expect(received.state).toEqual(REQ.state);
      expect(received.questions.department.type).toBe('choice');
      expect(res.headers['x-ocr-systemone-upstream']).toBe('native');
      expect(res.headers['x-ocr-model']).toBe('native-test/jev');
    } finally {
      upstream.stop(true);
    }
  });

  test('chat-model conversion with one repair retry', async () => {
    useSandbox('with-default');
    const seen: any[] = [];
    const upstream = serve({
      port: 0,
      async fetch(req) {
        const payload = await req.json();
        seen.push(payload);
        if (seen.length === 1) {
          return Response.json(fakeChat('Sorry, I cannot do that yet.'));
        }
        return Response.json(
          fakeChat(
            JSON.stringify({
              answers: {
                department: { choice: 'billing', confidence: 0.7, probabilities: { billing: 0.8, technical: 0.2 } },
                escalate: { noul: 0.4 },
                severity: { score: 1, probabilities: { '0': 0.2, '1': 0.8, '2': 0 } },
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
            name: 'chat-test',
            type: 'openai-compatible',
            baseUrl: `http://localhost:${upstream.port}`,
            apiKey: 'sk-test',
            timeoutMs: 5000,
          },
        ],
        [
          {
            id: 'test/chat',
            provider: 'chat-test',
            upstreamModel: 'upstream-chat',
            tier: 'plus',
            supportedReasoningEfforts: ['none', 'low', 'medium', 'high'],
            pricing: { input: 1, output: 1, cacheRead: 0 },
          },
        ],
        { defaultModel: 'test/chat' }
      );
      const { app } = createServer(config);
      // `model` omitted → systemone.defaultModel from the disk config.
      const res = await app.inject({ method: 'POST', url: '/v1/systemone', payload: REQ });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.model).toBe('test/chat');
      expect(body.answers.department.choice).toBe('billing');
      expect(body.answers.escalate.noul).toBe(0.4);
      expect(body.answers.severity.score).toBe(1);
      expect(body.answers.severity.legend).toEqual({ '0': 'minor', '1': 'degraded', '2': 'broken' });
      expect(res.headers['x-ocr-systemone-upstream']).toBe('converted');
      expect(seen.length).toBe(2);
      expect(seen[0].response_format).toEqual({ type: 'json_object' });
      expect(seen[0].reasoning_effort).toBe('none');
      expect(String(seen[0].messages[0].content)).toContain('System One');
      expect(seen[1].reasoning_effort).toBe('none');
      expect(String(seen[1].messages[3].content)).toContain('could not be used');
    } finally {
      upstream.stop(true);
    }
  });

  test('upstream rejecting the effort value → retried with low, then memoized', async () => {
    useSandbox('plain');
    const seen: any[] = [];
    const upstream = serve({
      port: 0,
      async fetch(req) {
        const payload = await req.json();
        seen.push(payload);
        if (payload.reasoning_effort === 'none') {
          return Response.json(
            {
              error: {
                code: 'invalid_parameter_error',
                message: "'reasoning_effort' must be one of: 'low', 'high', 'max'",
                type: 'invalid_request_error',
              },
            },
            { status: 400 }
          );
        }
        return Response.json(
          fakeChat(
            JSON.stringify({
              answers: {
                department: { choice: 'billing' },
                escalate: { noul: 0.5 },
                severity: { score: 1 },
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
            name: 'reject-none',
            type: 'openai-compatible',
            baseUrl: `http://localhost:${upstream.port}`,
            apiKey: 'sk-test',
            timeoutMs: 5000,
          },
        ],
        [
          {
            id: 'test/reject-none',
            provider: 'reject-none',
            upstreamModel: 'reject-none',
            tier: 'plus',
            supportedReasoningEfforts: ['none', 'low', 'high'],
            pricing: { input: 0, output: 0, cacheRead: 0 },
          },
        ]
      );
      const { app } = createServer(config);
      const res = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { ...REQ, model: 'test/reject-none' } });
      expect(res.statusCode).toBe(200);
      expect(seen.length).toBe(2);
      expect(seen[0].reasoning_effort).toBe('none');
      expect(seen[1].reasoning_effort).toBe('low');
      // Memoized: the next request goes straight to 'low' — no extra attempt.
      const res2 = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { ...REQ, model: 'test/reject-none' } });
      expect(res2.statusCode).toBe(200);
      expect(seen.length).toBe(3);
      expect(seen[2].reasoning_effort).toBe('low');
    } finally {
      upstream.stop(true);
    }
  });

  test('upstream rejecting every effort value → retried without the field, then memoized', async () => {
    useSandbox('plain');
    const seen: any[] = [];
    const upstream = serve({
      port: 0,
      async fetch(req) {
        const payload = await req.json();
        seen.push(payload);
        if (payload.reasoning_effort !== undefined) {
          return Response.json(
            {
              error: {
                code: 'invalid_parameter_error',
                message: "'reasoning_effort' must be one of: 'low', 'high', 'max'",
                type: 'invalid_request_error',
              },
            },
            { status: 400 }
          );
        }
        return Response.json(
          fakeChat(
            JSON.stringify({
              answers: {
                department: { choice: 'billing' },
                escalate: { noul: 0.5 },
                severity: { score: 1 },
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
            name: 'reject-all',
            type: 'openai-compatible',
            baseUrl: `http://localhost:${upstream.port}`,
            apiKey: 'sk-test',
            timeoutMs: 5000,
          },
        ],
        [
          {
            id: 'test/reject-all',
            provider: 'reject-all',
            upstreamModel: 'reject-all',
            tier: 'plus',
            supportedReasoningEfforts: ['none'],
            pricing: { input: 0, output: 0, cacheRead: 0 },
          },
        ]
      );
      const { app } = createServer(config);
      const res = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { ...REQ, model: 'test/reject-all' } });
      expect(res.statusCode).toBe(200);
      expect(seen.length).toBe(3);
      expect(seen[0].reasoning_effort).toBe('none');
      expect(seen[1].reasoning_effort).toBe('low');
      expect(seen[2].reasoning_effort).toBeUndefined();
      // Memoized as 'omit': the next request sends no effort field at all.
      const res2 = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { ...REQ, model: 'test/reject-all' } });
      expect(res2.statusCode).toBe(200);
      expect(seen.length).toBe(4);
      expect(seen[3].reasoning_effort).toBeUndefined();
    } finally {
      upstream.stop(true);
    }
  });

  test('effort rejection targeting an enum without none/low → picks its lowest allowed level', async () => {
    useSandbox('plain');
    const seen: any[] = [];
    const upstream = serve({
      port: 0,
      async fetch(req) {
        const payload = await req.json();
        seen.push(payload);
        if (
          payload.reasoning_effort !== undefined &&
          payload.reasoning_effort !== 'medium' &&
          payload.reasoning_effort !== 'high'
        ) {
          return Response.json(
            {
              error: {
                code: 'invalid_parameter_error',
                message: "'reasoning_effort' must be one of: 'medium', 'high'",
                type: 'invalid_request_error',
              },
            },
            { status: 400 }
          );
        }
        return Response.json(
          fakeChat(
            JSON.stringify({
              answers: {
                department: { choice: 'billing' },
                escalate: { noul: 0.5 },
                severity: { score: 1 },
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
            name: 'reject-none-low',
            type: 'openai-compatible',
            baseUrl: `http://localhost:${upstream.port}`,
            apiKey: 'sk-test',
            timeoutMs: 5000,
          },
        ],
        [
          {
            id: 'test/parse-enum',
            provider: 'reject-none-low',
            upstreamModel: 'parse-enum',
            tier: 'plus',
            supportedReasoningEfforts: ['none', 'medium', 'high'],
            pricing: { input: 0, output: 0, cacheRead: 0 },
          },
        ]
      );
      const { app } = createServer(config);
      const res = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { ...REQ, model: 'test/parse-enum' } });
      expect(res.statusCode).toBe(200);
      expect(seen.length).toBe(2);
      expect(seen[0].reasoning_effort).toBe('none');
      expect(seen[1].reasoning_effort).toBe('medium');
      // Memoized: straight to 'medium' next time.
      const res2 = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { ...REQ, model: 'test/parse-enum' } });
      expect(res2.statusCode).toBe(200);
      expect(seen.length).toBe(3);
      expect(seen[2].reasoning_effort).toBe('medium');
    } finally {
      upstream.stop(true);
    }
  });

  test("model:'auto' is gated by the RESOLVED physical model, not just the alias", async () => {
    useSandbox('with-default'); // sandbox defaultModel: "test/chat"
    const config = makeConfig(
      [{ name: 'dummy', type: 'openai-compatible', baseUrl: 'http://localhost:1', apiKey: 'sk-dummy' }],
      [
        {
          id: 'test/chat',
          provider: 'dummy',
          upstreamModel: 'dummy',
          tier: 'plus',
          pricing: { input: 0, output: 0, cacheRead: 0 },
        },
      ]
    );
    // Deny-mode key that denies exactly the resolved physical model.
    config.apiKeys = [
      { name: 'limited', key: 'sk-limited', modelAccess: { mode: 'deny', models: ['test/chat'] } },
    ] as any;
    const { app } = createServer(config);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/systemone',
      headers: { authorization: 'Bearer sk-limited' },
      payload: { ...REQ, model: 'auto' },
    });
    expect(res.statusCode).toBe(403);
    expect(String(res.json().error?.message)).toContain('not allowed');
  });

  test('rejects an unknown model and a missing default', async () => {
    useSandbox('plain');
    // createServer demands at least one routable model (the orchestrator
    // resolves its baseline tier at construction); a dummy that is never
    // called keeps this test focused on the reject paths.
    const config = makeConfig(
      [{ name: 'dummy', type: 'openai-compatible', baseUrl: 'http://localhost:1', apiKey: 'sk-dummy' }],
      [
        {
          id: 'dummy/chat',
          provider: 'dummy',
          upstreamModel: 'dummy',
          tier: 'plus',
          pricing: { input: 0, output: 0, cacheRead: 0 },
        },
      ]
    );
    const { app } = createServer(config);
    const res = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { ...REQ, model: 'ghost/model' } });
    expect(res.statusCode).toBe(404);

    const res2 = await app.inject({ method: 'POST', url: '/v1/systemone', payload: REQ });
    expect(res2.statusCode).toBe(400);
    expect(res2.json().error.code).toBe('model_required');

    const res3 = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { questions: {} } });
    expect(res3.statusCode).toBe(400);
  });
});

describe('System One: tier alias resolution', () => {
  /** One native systemone upstream + one model per tier: alias resolution is
   *  observable purely through X-OCR-Model (native passthrough echoes the
   *  upstream body, so the header is the only honest disclosure). */
  function tieredConfig(upstreamPort: number, apiKeys: any[] = []): RouterConfig {
    const config = makeConfig(
      [{ name: 'native-tiers', type: 'systemone', baseUrl: `http://localhost:${upstreamPort}`, apiKey: 'sk-test' }],
      [
        {
          id: 'native/lite-a',
          provider: 'native-tiers',
          upstreamModel: 'lite-a',
          tier: 'lite',
          pricing: { input: 0, output: 0, cacheRead: 0 },
        },
        {
          id: 'native/plus-b',
          provider: 'native-tiers',
          upstreamModel: 'plus-b',
          tier: 'plus',
          pricing: { input: 0, output: 0, cacheRead: 0 },
        },
        {
          id: 'native/plus-c',
          provider: 'native-tiers',
          upstreamModel: 'plus-c',
          tier: 'plus',
          pricing: { input: 0, output: 0, cacheRead: 0 },
        },
      ]
    );
    config.apiKeys = apiKeys as any;
    return config;
  }

  const NATIVE_ANSWERS = {
    model: 'jev-test',
    answers: { department: { type: 'choice', choice: 'billing', probabilities: { billing: 1 } } },
    usage: { input_tokens: 1, output_tokens: 0 },
  };

  test('plus / lite resolve to the chain-head member of the named tier', async () => {
    useSandbox('plain');
    const upstream = serve({
      port: 0,
      async fetch() {
        return Response.json(NATIVE_ANSWERS);
      },
    });
    try {
      const { app } = createServer(tieredConfig(upstream.port));
      const plus = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { ...REQ, model: 'plus' } });
      expect(plus.statusCode).toBe(200);
      expect(plus.headers['x-ocr-model']).toBe('native/plus-b'); // first registered plus member

      const lite = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { ...REQ, model: 'lite' } });
      expect(lite.statusCode).toBe(200);
      expect(lite.headers['x-ocr-model']).toBe('native/lite-a');
    } finally {
      upstream.stop(true);
    }
  });

  test('a denied plus member never blocks its allowed sibling (filter before pick)', async () => {
    useSandbox('plain');
    const upstream = serve({
      port: 0,
      async fetch() {
        return Response.json(NATIVE_ANSWERS);
      },
    });
    try {
      const config = tieredConfig(upstream.port, [
        { name: 'skip-b', key: 'sk-skip', modelAccess: { mode: 'deny', models: ['native/plus-b'] } },
      ]);
      const { app } = createServer(config);
      // plus-b is the chain head but denied; the pick must land on plus-c.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/systemone',
        headers: { authorization: 'Bearer sk-skip' },
        payload: { ...REQ, model: 'plus' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ocr-model']).toBe('native/plus-c');
    } finally {
      upstream.stop(true);
    }
  });

  test('deny-mode key denying every plus member → 403 model_not_allowed', async () => {
    useSandbox('plain');
    const config = tieredConfig(1, [
      { name: 'no-plus', key: 'sk-no-plus', modelAccess: { mode: 'deny', models: ['native/plus-b', 'native/plus-c'] } },
    ]);
    const { app } = createServer(config);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/systemone',
      headers: { authorization: 'Bearer sk-no-plus' },
      payload: { ...REQ, model: 'plus' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('model_not_allowed');
    expect(String(res.json().error.message)).toContain('plus');
  });

  test('tier with no registered members → 404 model_not_found', async () => {
    useSandbox('plain');
    const config = tieredConfig(1); // lite/plus members exist; ultra/pro tiers are empty
    const { app } = createServer(config);
    const res = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { ...REQ, model: 'ultra' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('model_not_found');
    // Pinned to the tier-pool message so this test discriminates the alias
    // resolution path from the generic unknown-model 404.
    expect(String(res.json().error.message)).toContain("No candidate model in tier 'ultra'");
  });

  test('allow-mode key whitelisting a physical member but NOT the alias → 403 at the alias gate', async () => {
    useSandbox('plain');
    const config = tieredConfig(1, [
      { name: 'narrow', key: 'sk-narrow', modelAccess: { mode: 'allow', models: ['native/plus-c'] } },
    ]);
    const { app } = createServer(config);
    // Mirrors the chat surfaces: an allow-mode key must NAME the tier alias.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/systemone',
      headers: { authorization: 'Bearer sk-narrow' },
      payload: { ...REQ, model: 'plus' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('model_not_allowed');
  });

  test('allow-mode key naming the tier alias → tier-wide whitelist serves the chain head', async () => {
    useSandbox('plain');
    const upstream = serve({
      port: 0,
      async fetch() {
        return Response.json(NATIVE_ANSWERS);
      },
    });
    try {
      const config = tieredConfig(upstream.port, [
        { name: 'tier-wide', key: 'sk-tier', modelAccess: { mode: 'allow', models: ['plus'] } },
      ]);
      const { app } = createServer(config);
      // 'plus' in the whitelist expands to EVERY plus-tier member, so
      // both plus-b and plus-c are admissible; the chain head serves.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/systemone',
        headers: { authorization: 'Bearer sk-tier' },
        payload: { ...REQ, model: 'plus' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ocr-model']).toBe('native/plus-b');
    } finally {
      upstream.stop(true);
    }
  });

  test('every tier member breaker-open → 503 no_healthy_model', async () => {
    useSandbox('plain');
    const config = tieredConfig(1);
    const { app, registry } = createServer(config);
    const breaker = registry.getCircuitBreakerManager();
    breaker.trip('native/plus-b', { reason: 'test', cooldownMs: 60000 });
    breaker.trip('native/plus-c', { reason: 'test', cooldownMs: 60000 });
    const res = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { ...REQ, model: 'plus' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('no_healthy_model');
  });

  test("bare 'auto' still resolves via systemone.defaultModel (non-regression)", async () => {
    useSandbox('with-default'); // sandbox defaultModel: "test/chat"
    const seen: any[] = [];
    const upstream = serve({
      port: 0,
      async fetch(req) {
        seen.push(await req.json());
        return Response.json(
          fakeChat(
            JSON.stringify({
              answers: { department: { choice: 'billing' }, escalate: { noul: 0.5 }, severity: { score: 1 } },
            })
          )
        );
      },
    });
    try {
      const config = makeConfig(
        [
          {
            name: 'chat-test',
            type: 'openai-compatible',
            baseUrl: `http://localhost:${upstream.port}`,
            apiKey: 'sk-test',
            timeoutMs: 5000,
          },
        ],
        [
          {
            id: 'test/chat',
            provider: 'chat-test',
            upstreamModel: 'upstream-chat',
            tier: 'plus',
            supportedReasoningEfforts: ['none', 'low'],
            pricing: { input: 1, output: 1, cacheRead: 0 },
          },
        ],
        { defaultModel: 'test/chat' }
      );
      const { app } = createServer(config);
      const res = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { ...REQ, model: 'auto' } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ocr-model']).toBe('test/chat');
      expect(seen[0].model).toBe('upstream-chat');
    } finally {
      upstream.stop(true);
    }
  });
});
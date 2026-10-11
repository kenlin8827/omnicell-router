import { afterAll, describe, expect, test } from 'bun:test';
import { serve } from 'bun';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config/index.js';
import { RouterConfig } from '../src/config/types.js';
import {
  buildDecisionChatRequest,
  decisionReasoningEffort,
  synthesizeSystemoneResponse,
  validateSystemoneRequest,
} from '../src/protocols/systemone/convert.js';
import { ChatCompletionResponse } from '../src/types/openai.js';

// ---------------------------------------------------------------------------
// Isolation: getConfigPath() prefers cwd/config.yaml, and request-time paths
// (auth preHandler, systemone.defaultModel) re-read the disk config per call —
// so chdir into sandboxes holding minimal placeholders BEFORE any server
// construction. The repo's real (gitignored) config.yaml — api keys, per-key
// policies, webAuth — must never leak into these tests.
// ---------------------------------------------------------------------------
const originalCwd = process.cwd();
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-systemone-'));
const sandboxPlain = path.join(sandboxRoot, 'plain');
const sandboxDefault = path.join(sandboxRoot, 'with-default');
fs.mkdirSync(sandboxPlain);
fs.mkdirSync(sandboxDefault);
const baseYaml = 'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\n';
fs.writeFileSync(path.join(sandboxPlain, 'config.yaml'), baseYaml);
fs.writeFileSync(
  path.join(sandboxDefault, 'config.yaml'),
  baseYaml + 'systemone:\n  defaultModel: "test/chat"\n'
);
process.chdir(sandboxPlain);

function useSandbox(name: 'plain' | 'with-default'): void {
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
    capture: { ...base.capture, enabled: false },
    flywheel: { ...base.flywheel, enabled: false },
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
  test('none when supported, lowest level for thinking-only models, omitted otherwise', () => {
    expect(decisionReasoningEffort({ supportedReasoningEfforts: ['none', 'low', 'high'] })).toBe('none');
    // Legacy boolean = full ladder (includes none).
    expect(decisionReasoningEffort({ supportsReasoningEffort: true })).toBe('none');
    // Thinking-only model → its lowest declared level.
    expect(decisionReasoningEffort({ supportedReasoningEfforts: ['medium', 'low', 'high'] })).toBe('low');
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
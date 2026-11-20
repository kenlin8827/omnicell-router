import { afterAll, describe, expect, test } from 'bun:test';
import { serve } from 'bun';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootServer, makeConfig } from '../helpers/systemone-seam.js';
import { __resetEnvResolutionForTests } from '../../src/config/env.js';
import { RouterConfig } from '../../src/config/types.js';
import {
  buildDecisionRequest,
  canonicalOutputText,
  decisionReasoningEffort,
  synthesizeSystemoneResponse as synthesizeCanonicalResponse,
  validateSystemoneRequest,
} from '../../src/protocols/systemone/convert.js';
import { ChatCompletionResponse } from '../../src/types/openai.js';
import { responseToIR } from '../helpers/ir.js';
import { SCHEMA_VERSION } from '../../src/config/schema.js';

// ---------------------------------------------------------------------------
// Isolation: config resolves from OCR_HOME (envs/<env>/config.yaml) and
// request-time code re-reads the disk config per call, so a sandbox switch is
// an OCR_ENV swap plus a resolution-cache reset. The operator's real
// ~/.omnicell-router config — api keys, per-key policies, webAuth — must never
// leak into these tests.
// ---------------------------------------------------------------------------
const originalCwd = process.cwd();
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-systemone-'));
const sandboxPlain = path.join(sandboxRoot, 'plain');
const sandboxDefault = path.join(sandboxRoot, 'with-default');
fs.mkdirSync(sandboxPlain);
fs.mkdirSync(sandboxDefault);
process.env.OCR_HOME = path.join(sandboxRoot, 'home');
const baseYaml = `schemaVersion: ${SCHEMA_VERSION}\nclient:\n  port: 3000\n  host: 127.0.0.1\n  apiKeys: []\n`;

/** Materialize a sandbox environment under the throwaway OCR_HOME. */
function seedSandboxEnv(name: string, yaml: string): void {
  const dir = path.join(process.env.OCR_HOME as string, 'envs', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), yaml);
  fs.writeFileSync(path.join(dir, 'env.json'), JSON.stringify({ name, type: 'regular', schemaVersion: 1 }));
}

seedSandboxEnv('plain', baseYaml);
seedSandboxEnv('with-default', baseYaml + 'protocol:\n  systemone:\n    defaultModel: "test/chat"\n');
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

// Chat JSON remains an explicit fixture boundary for System One unit tests.
function synthesizeSystemoneResponse(response: ChatCompletionResponse, req: any, modelId: string) {
  return synthesizeCanonicalResponse(responseToIR(response), req, modelId);
}

function chatOutputText(response: ChatCompletionResponse): string {
  return canonicalOutputText(responseToIR(response));
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

describe('System One: canonical request synthesis', () => {
  test('one call carries every question + the JSON contract', () => {
    const request = buildDecisionRequest(REQ, 'test/chat');
    expect(request.text?.format).toEqual({ type: 'json_object' });
    expect(request.generation?.temperature).toBe(0);
    expect(request.model).toBe('test/chat');
    const user = JSON.stringify(request.input[1]);
    expect(user).toContain('department');
    expect(user).toContain('severity');
    expect(user).toContain('T-1001');
    expect(JSON.stringify(request.input[0])).toContain('System One');
    // No token cap here: the pin (initial value + rejection fallback) is
    // owned by the decider, same as reasoning effort.
    expect(request.generation?.maxOutputTokens).toBeUndefined();
  });

  test('repair mode appends the bad output and the reason', () => {
    const request = buildDecisionRequest(REQ, 'test/chat', {
      previousOutput: '{"oops": true}',
      reason: "'escalate': no answer object",
    });
    expect(request.input.length).toBe(4);
    expect(request.input[2]?.type).toBe('message');
    expect(request.input[2]?.role).toBe('assistant');
    expect(JSON.stringify(request.input[3])).toContain('could not be used');
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

  test('empty content falls back to the reasoning surfaces (thinking models)', () => {
    const answers = JSON.stringify({
      answers: { department: { choice: 'billing' }, escalate: { noul: 0.9 }, severity: { score: 1 } },
    });
    // DeepSeek / Alibaba style reasoning_content.
    const withReasoningContent = fakeChat('');
    (withReasoningContent.choices[0].message as any).reasoning_content = `Let me think... ${answers}`;
    const r = synthesizeSystemoneResponse(withReasoningContent, REQ, 'test/chat');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.response.answers.department).toMatchObject({ type: 'choice', choice: 'billing' });

    // OpenRouter style reasoning.
    const withReasoning = fakeChat('');
    (withReasoning.choices[0].message as any).reasoning = answers;
    const r2 = synthesizeSystemoneResponse(withReasoning, REQ, 'test/chat');
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.response.answers.severity).toMatchObject({ type: 'score', score: 1 });

    // chatOutputText (the repair prompt's previous-output surface) picks the
    // first non-empty surface: the thinking text, never "(empty output)".
    expect(chatOutputText(withReasoningContent)).toContain('department');
    expect(chatOutputText(fakeChat('{"answers":{}}'))).toBe('{"answers":{}}');
  });

  test('unparsable content falls back to reasoning surfaces; a valid content still wins', () => {
    const answers = JSON.stringify({
      answers: { department: { choice: 'technical' }, escalate: { noul: 0.2 }, severity: { score: 2 } },
    });
    // Content is prose without a usable JSON object, reasoning carries it.
    const chat = fakeChat('Hmm, let me decide.');
    (chat.choices[0].message as any).reasoning_content = answers;
    const r = synthesizeSystemoneResponse(chat, REQ, 'test/chat');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.response.answers.department).toMatchObject({ type: 'choice', choice: 'technical' });

    // When content itself parses, it is preferred over the reasoning fields.
    const contentWins = fakeChat(JSON.stringify({ answers: { department: { choice: 'billing' }, escalate: { noul: 0.5 }, severity: { score: 0 } } }));
    (contentWins.choices[0].message as any).reasoning_content = JSON.stringify({
      answers: { department: { choice: 'technical' }, escalate: { noul: 0.5 }, severity: { score: 2 } },
    });
    const r2 = synthesizeSystemoneResponse(contentWins, REQ, 'test/chat');
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.response.answers.department).toMatchObject({ type: 'choice', choice: 'billing' });
  });

  test('content:null is no text surface; a JSON object without answers does not shadow the reasoning field', () => {
    const answers = JSON.stringify({
      answers: { department: { choice: 'billing' }, escalate: { noul: 0.6 }, severity: { score: 2 } },
    });
    // DeepSeek reasoners answer with content:null while the JSON sits in
    // reasoning_content. The null is a type violation of the chat contract but
    // a real vendor shape, so the test seam casts deliberately.
    const nullContent = fakeChat(null as unknown as string);
    (nullContent.choices[0].message as any).reasoning_content = answers;
    // The repair prompt must show the model's actual text, never the literal '""'.
    expect(chatOutputText(nullContent)).toBe(answers);
    const r = synthesizeSystemoneResponse(nullContent, REQ, 'test/chat');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.response.answers.department).toMatchObject({ type: 'choice', choice: 'billing' });

    // Content parses to an object WITHOUT an answers envelope — the reasoning
    // surface that carries one still wins instead of failing on the decoy.
    const decoy = fakeChat(JSON.stringify({ note: 'deciding' }));
    (decoy.choices[0].message as any).reasoning_content = answers;
    const r2 = synthesizeSystemoneResponse(decoy, REQ, 'test/chat');
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.response.answers.severity).toMatchObject({ type: 'score', score: 2 });
  });
});

describe('POST /v1/systemone end-to-end', () => {
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
            type: 'openai-chat',
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
      const { app } = bootServer(config);
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
            type: 'openai-chat',
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
      const { app } = bootServer(config);
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

  test('upstream rejecting the max_tokens pin → retried without the field, then memoized', async () => {
    useSandbox('plain');
    const seen: any[] = [];
    const upstream = serve({
      port: 0,
      async fetch(req) {
        const payload = await req.json();
        seen.push(payload);
        if (payload.max_tokens !== undefined) {
          return Response.json(
            {
              error: {
                code: 'invalid_parameter_error',
                message: "'max_tokens' is too large: 16384. This model supports at most 8192 completion tokens",
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
            name: 'reject-max-tokens',
            type: 'openai-chat',
            baseUrl: `http://localhost:${upstream.port}`,
            apiKey: 'sk-test',
            timeoutMs: 5000,
          },
        ],
        [
          {
            id: 'test/reject-max-tokens',
            provider: 'reject-max-tokens',
            upstreamModel: 'reject-max-tokens',
            tier: 'plus',
            supportedReasoningEfforts: ['none', 'low'],
            pricing: { input: 0, output: 0, cacheRead: 0 },
          },
        ]
      );
      const { app } = bootServer(config);
      const res = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { ...REQ, model: 'test/reject-max-tokens' } });
      expect(res.statusCode).toBe(200);
      expect(seen.length).toBe(2);
      expect(seen[0].max_tokens).toBe(16384);
      expect(seen[1].max_tokens).toBeUndefined();
      // Memoized: the next request never sends the pin again.
      const res2 = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { ...REQ, model: 'test/reject-max-tokens' } });
      expect(res2.statusCode).toBe(200);
      expect(seen.length).toBe(3);
      expect(seen[2].max_tokens).toBeUndefined();
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
            type: 'openai-chat',
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
      const { app } = bootServer(config);
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
            type: 'openai-chat',
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
      const { app } = bootServer(config);
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

  test('upstream rejecting response_format (JSON mode) → retried without the field, then memoized', async () => {
    useSandbox('plain');
    const seen: any[] = [];
    const upstream = serve({
      port: 0,
      async fetch(req) {
        const payload = await req.json();
        seen.push(payload);
        if (payload.response_format !== undefined) {
          return Response.json(
            {
              error: {
                code: 'invalid_parameter_error',
                message: "'response_format' is not supported by this model",
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
            name: 'reject-json',
            type: 'openai-chat',
            baseUrl: `http://localhost:${upstream.port}`,
            apiKey: 'sk-test',
            timeoutMs: 5000,
          },
        ],
        [
          {
            id: 'test/reject-json',
            provider: 'reject-json',
            upstreamModel: 'reject-json',
            tier: 'plus',
            pricing: { input: 0, output: 0, cacheRead: 0 },
          },
        ]
      );
      const { app } = bootServer(config);
      const res = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { ...REQ, model: 'test/reject-json' } });
      expect(res.statusCode).toBe(200);
      expect(seen.length).toBe(2);
      expect(seen[0].response_format).toEqual({ type: 'json_object' });
      expect(seen[1].response_format).toBeUndefined();
      // Memoized: the next request never sends response_format again.
      const res2 = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { ...REQ, model: 'test/reject-json' } });
      expect(res2.statusCode).toBe(200);
      expect(seen.length).toBe(3);
      expect(seen[2].response_format).toBeUndefined();
    } finally {
      upstream.stop(true);
    }
  });

  test("model:'auto' is gated by the RESOLVED physical model, not just the alias", async () => {
    useSandbox('with-default'); // sandbox defaultModel: "test/chat"
    const config = makeConfig(
      [{ name: 'dummy', type: 'openai-chat', baseUrl: 'http://localhost:1', apiKey: 'sk-dummy' }],
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
    const { app } = bootServer(config);
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
      [{ name: 'dummy', type: 'openai-chat', baseUrl: 'http://localhost:1', apiKey: 'sk-dummy' }],
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
    const { app } = bootServer(config);
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
  /** One chat provider + one decision model per tier: alias resolution is
   *  observable through X-OCR-Model (the header names the resolved model). */
  function tieredConfig(upstreamPort: number, apiKeys: any[] = []): RouterConfig {
    const config = makeConfig(
      [{ name: 'native-tiers', type: 'openai-chat', baseUrl: `http://localhost:${upstreamPort}`, apiKey: 'sk-test' }],
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

  const DECISION_ANSWERS = JSON.stringify({
    answers: {
      department: { choice: 'billing', confidence: 0.9, probabilities: { billing: 1, technical: 0 } },
      escalate: { noul: 0.4 },
      severity: { score: 1, probabilities: { '0': 0.2, '1': 0.8, '2': 0 } },
    },
  });

  test('plus / lite resolve to the leading member of the named tier', async () => {
    useSandbox('plain');
    const upstream = serve({
      port: 0,
      async fetch() {
        return Response.json(fakeChat(DECISION_ANSWERS));
      },
    });
    try {
      const { app } = bootServer(tieredConfig(upstream.port));
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
        return Response.json(fakeChat(DECISION_ANSWERS));
      },
    });
    try {
      const config = tieredConfig(upstream.port, [
        { name: 'skip-b', key: 'sk-skip', modelAccess: { mode: 'deny', models: ['native/plus-b'] } },
      ]);
      const { app } = bootServer(config);
      // plus-b is the leading member but denied; the pick must land on plus-c.
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
    const { app } = bootServer(config);
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
    const { app } = bootServer(config);
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
    const { app } = bootServer(config);
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

  test('allow-mode key naming the tier alias → tier-wide whitelist serves the leading member', async () => {
    useSandbox('plain');
    const upstream = serve({
      port: 0,
      async fetch() {
        return Response.json(fakeChat(DECISION_ANSWERS));
      },
    });
    try {
      const config = tieredConfig(upstream.port, [
        { name: 'tier-wide', key: 'sk-tier', modelAccess: { mode: 'allow', models: ['plus'] } },
      ]);
      const { app } = bootServer(config);
      // 'plus' in the whitelist expands to EVERY plus-tier member, so
      // both plus-b and plus-c are admissible; the leading member serves.
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
    const { app, registry } = bootServer(config);
    const breaker = registry.getCircuitBreakerManager();
    // The pool filter reads the per-credential aggregate, so trip every
    // member's tuple for the provider's credential.
    registry.refreshCredentialChain('native-tiers', [{ keyHashPrefix: 'k1', key: 'sk-test' }]);
    breaker.tripPair('native/plus-b', 'k1', { reason: 'test', cooldownMs: 60000 }, 'native-tiers');
    breaker.tripPair('native/plus-c', 'k1', { reason: 'test', cooldownMs: 60000 }, 'native-tiers');
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
            type: 'openai-chat',
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
      const { app } = bootServer(config);
      const res = await app.inject({ method: 'POST', url: '/v1/systemone', payload: { ...REQ, model: 'auto' } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ocr-model']).toBe('test/chat');
      expect(seen[0].model).toBe('upstream-chat');
    } finally {
      upstream.stop(true);
    }
  });
});
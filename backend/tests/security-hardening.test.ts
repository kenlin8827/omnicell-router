/**
 * Regression pins for the ADR-0033 security batch (S-01..S-06 / A1 / B4 / B5).
 */
import { describe, expect, it } from 'bun:test';
import { serve } from 'bun';
import type { ModelRegistration, ProviderConfig } from '../src/config/types.js';
import { redactUpstreamBody } from '../src/observability/upstream-body-redaction.js';
import { assertAllowedUpstream, UpstreamUrlError } from '../src/utils/upstream-url-guard.js';
import { OpenAIChatProvider } from '../src/providers/executors/openai-chat.js';
import { SseParser } from '../src/providers/executors/http-stream.js';
import { normalizeLegacyChatRequest } from '../src/protocols/chat-compat.js';
import { IrUnsupportedError } from '../src/ir/errors.js';
import { toIR } from './helpers/ir.js';
import type { ChatCompletionRequest } from '../src/types/openai.js';

describe('redactUpstreamBody', () => {
  it('strips Authorization bearer material and caps length', () => {
    const key = 'sk-live-secret-abcdef0123456789';
    const body = `invalid api key: Bearer ${key} plus ${'x'.repeat(2000)}`;
    const out = redactUpstreamBody(body, { Authorization: `Bearer ${key}` });
    expect(out).not.toContain(key);
    expect(out).toContain('[REDACTED]');
    expect(out.length).toBeLessThanOrEqual(601);
  });
});

describe('assertAllowedUpstream', () => {
  it('refuses metadata and self-loop; allows https public', () => {
    expect(() => assertAllowedUpstream('http://169.254.169.254/latest', 4000)).toThrow(UpstreamUrlError);
    expect(() => assertAllowedUpstream('http://127.0.0.1:4000/v1', 4000)).toThrow(UpstreamUrlError);
    expect(() => assertAllowedUpstream('http://example.com/v1', 4000)).toThrow(UpstreamUrlError);
    expect(assertAllowedUpstream('https://api.example.com/v1', 4000).hostname).toBe('api.example.com');
    expect(assertAllowedUpstream('http://127.0.0.1:11434', 4000).port).toBe('11434');
  });
});

describe('shared HTTP helpers redact upstream error bodies', () => {
  it('openai-chat createCompletion does not echo the live key', async () => {
    const key = 'sk-echo-me-please-0123456789abcdef';
    const server = serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ error: { message: `bad Authorization: Bearer ${key}` } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    });
    try {
      const config: ProviderConfig = {
        name: 'p',
        type: 'openai-chat',
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: key,
      };
      const provider = new OpenAIChatProvider(config);
      const model: ModelRegistration = {
        id: 'p/m1',
        provider: 'p',
        upstreamModel: 'm1',
        tier: 'plus',
        wire: 'openai-chat',
        pricing: { input: 1, output: 2, cacheRead: 0.1 },
      };
      const request = toIR({ model: 'p/m1', messages: [{ role: 'user', content: 'hi' }] });
      await expect(provider.createCompletion(request, model)).rejects.toThrow(/REDACTED/);
      try {
        await provider.createCompletion(request, model);
      } catch (err: any) {
        expect(String(err.message)).not.toContain(key);
        expect(String(err.errorBody ?? '')).not.toContain(key);
      }
    } finally {
      server.stop(true);
    }
  });
});

describe('SseParser linear scan', () => {
  it('parses thousands of short frames from one push', () => {
    const parser = new SseParser();
    const n = 5000;
    const chunk = Array.from({ length: n }, (_, i) => `data: {"i":${i}}\n\n`).join('');
    const frames = parser.push(chunk);
    expect(frames.length).toBe(n);
    expect(frames[0]).toEqual({ data: '{"i":0}' });
    expect(frames[n - 1]).toEqual({ data: `{"i":${n - 1}}` });
  });
});

describe('chat-compat fails visible on malformed legacy', () => {
  it('rejects non-array functions and bad function_call', () => {
    expect(() =>
      normalizeLegacyChatRequest({
        model: 'auto',
        messages: [{ role: 'user', content: 'x' }],
        functions: { name: 'nope' },
      } as unknown as ChatCompletionRequest),
    ).toThrow(IrUnsupportedError);

    expect(() =>
      normalizeLegacyChatRequest({
        model: 'auto',
        messages: [{ role: 'user', content: 'x' }],
        function_call: { name: 12 },
      } as unknown as ChatCompletionRequest),
    ).toThrow(IrUnsupportedError);

    expect(() =>
      normalizeLegacyChatRequest({
        model: 'auto',
        messages: [{ role: 'user', content: 'x' }],
        functions: [{ description: 'missing name' }],
      } as unknown as ChatCompletionRequest),
    ).toThrow(IrUnsupportedError);
  });
});

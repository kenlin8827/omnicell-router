import { describe, it, expect, afterEach } from 'bun:test';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { GoogleProvider } from '../src/providers/google.js';
import { ResponsesProvider } from '../src/providers/responses.js';
import { DispatchingProvider } from '../src/providers/dispatch.js';
import { UpstreamError } from '../src/resilience/error-classifier.js';
import type { LLMProvider } from '../src/providers/base.js';
import type { CallCredential } from '../src/opencode/credentials/types.js';
import type { ModelRegistration, ProviderConfig } from '../src/config/types.js';

/**
 * Per-call credential threading through the executor
 * layer. A global-fetch capture records the EXACT outbound header object each
 * executor builds (proxiedFetch with an uninitialized proxy config always
 * reaches global fetch — utils/proxy.ts rule 5).
 *
 * Coverage:
 *  (b) per-call credential overrides the baked key in headers for all four
 *      wires (Authorization / x-api-key / x-goog-api-key);
 *  (c) the no-credential-param path keeps authenticating with config.apiKey —
 *      byte-identical to every pre-P3 request.
 */

interface Captured {
  url: string;
  headers: Record<string, string>;
}
const captured: Captured[] = [];
const originalFetch = globalThis.fetch;

function mockFetch(status = 400, body = '{"error":{"message":"nope"}}'): void {
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    captured.push({ url: String(input), headers: init?.headers ?? {} });
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  captured.length = 0;
});

const BAKED = 'sk-baked-at-boot';
const PER_CALL = 'sk-per-call-selected';
const credential: CallCredential = { key: PER_CALL, keyHashPrefix: 'deadbeef0000', label: 'acct-2' };

const config = (name: string, type: ProviderConfig['type']): ProviderConfig => ({
  name,
  type,
  baseUrl: 'https://upstream.invalid/v1',
  apiKey: BAKED,
});

const model = (wire: ModelRegistration['wire']): ModelRegistration => ({
  id: 'p/m1',
  provider: 'p',
  upstreamModel: 'm1',
  tier: 'plus',
  wire,
  pricing: { input: 1, output: 2, cacheRead: 0.1 },
});

import type { ChatCompletionRequest } from '../src/types/openai.js';

const request: ChatCompletionRequest = {
  model: 'p/m1',
  messages: [{ role: 'user', content: 'hi' }],
};

const okChatBody = JSON.stringify({
  id: 'cmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'm1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
});

/** Run a completion expecting failure (400 → UpstreamError) — headers are captured BEFORE the throw. */
async function expectUpstreamFailure(provider: LLMProvider, cred?: CallCredential): Promise<void> {
  try {
    await provider.createCompletion(request, model(undefined), undefined, cred);
    throw new Error('expected UpstreamError was not thrown');
  } catch (err) {
    if (!(err instanceof UpstreamError)) throw err;
  }
}

describe('(b) per-call credential overrides the baked key — all four wires', () => {
  it('openai-compatible: Authorization carries the selected key on a SUCCESS call', async () => {
    mockFetch(200, okChatBody);
    const provider = new OpenAICompatibleProvider(config('p', 'openai-compatible'));
    const res = await provider.createCompletion(request, model('openai'), undefined, credential);
    expect(res.choices[0]?.message?.content).toBe('ok');
    expect(captured[0]?.headers['Authorization']).toBe(`Bearer ${PER_CALL}`);
  });

  it('anthropic: x-api-key carries the selected key', async () => {
    mockFetch();
    const provider = new AnthropicProvider(config('p', 'anthropic'));
    await expectUpstreamFailure(provider, credential);
    expect(captured[0]?.headers['x-api-key']).toBe(PER_CALL);
  });

  it('google: x-goog-api-key carries the selected key', async () => {
    mockFetch();
    const provider = new GoogleProvider(config('p', 'google'));
    await expectUpstreamFailure(provider, credential);
    expect(captured[0]?.headers['x-goog-api-key']).toBe(PER_CALL);
  });

  it('responses: Authorization carries the selected key', async () => {
    mockFetch();
    const provider = new ResponsesProvider(config('p', 'responses'));
    await expectUpstreamFailure(provider, credential);
    expect(captured[0]?.headers['Authorization']).toBe(`Bearer ${PER_CALL}`);
  });

  it('DispatchingProvider threads the credential to the wire executor (completion + stream)', async () => {
    mockFetch();
    const dispatch = new DispatchingProvider(config('p', 'dispatch'), {
      openai: 'https://upstream.invalid/v1',
    });
    await expectUpstreamFailure(dispatch, credential);
    expect(captured[0]?.headers['Authorization']).toBe(`Bearer ${PER_CALL}`);

    captured.length = 0;
    mockFetch(200, 'data: [DONE]\n\n');
    await dispatch.createStream({ ...request, stream: true }, model('openai'), credential);
    expect(captured[0]?.headers['Authorization']).toBe(`Bearer ${PER_CALL}`);
  });
});

describe('(c) no-credential path stays on the baked key (byte-identical)', () => {
  it('openai-compatible: Authorization equals config.apiKey', async () => {
    mockFetch(200, okChatBody);
    const provider = new OpenAICompatibleProvider(config('p', 'openai-compatible'));
    await provider.createCompletion(request, model('openai'));
    expect(captured[0]?.headers['Authorization']).toBe(`Bearer ${BAKED}`);
  });

  it('anthropic: x-api-key equals config.apiKey', async () => {
    mockFetch();
    const provider = new AnthropicProvider(config('p', 'anthropic'));
    await expectUpstreamFailure(provider);
    expect(captured[0]?.headers['x-api-key']).toBe(BAKED);
  });

  it('google: x-goog-api-key equals config.apiKey', async () => {
    mockFetch();
    const provider = new GoogleProvider(config('p', 'google'));
    await expectUpstreamFailure(provider);
    expect(captured[0]?.headers['x-goog-api-key']).toBe(BAKED);
  });

  it('responses: Authorization equals config.apiKey', async () => {
    mockFetch();
    const provider = new ResponsesProvider(config('p', 'responses'));
    await expectUpstreamFailure(provider);
    expect(captured[0]?.headers['Authorization']).toBe(`Bearer ${BAKED}`);
  });

  it('DispatchingProvider without a credential still bakes the config key', async () => {
    mockFetch(200, okChatBody);
    const dispatch = new DispatchingProvider(config('p', 'dispatch'), {
      openai: 'https://upstream.invalid/v1',
    });
    await dispatch.createCompletion(request, model('openai'));
    expect(captured[0]?.headers['Authorization']).toBe(`Bearer ${BAKED}`);
  });
});

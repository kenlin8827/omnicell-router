import { describe, expect, test } from 'bun:test';
import { serve } from 'bun';
import { buildAnthropicPayload, googleToChatCompletion, buildResponsesPayload, responseToIR, toIR } from '../helpers/ir.js';
import { anthropicRequestToIR, AnthropicMessagesEventEncoder } from '../../src/ir/adapters/anthropic-messages.js';
import { canonicalResponseToEvents } from '../../src/ir/stream.js';
import { PromptOptimizer } from '../../src/pipeline/prompt-optimizer.js';
import { OpenAIChatProvider } from '../../src/providers/executors/openai-chat.js';
import { ModelRegistration, ProviderConfig } from '../../src/config/types.js';
import { ChatCompletionRequest } from '../../src/types/openai.js';

const model = { id: 'm1', upstreamModel: 'up-model-1' } as unknown as ModelRegistration;
const ephemeral = { type: 'ephemeral' };

describe('cache integrity: Anthropic breakpoints survive conversion', () => {
  test('inbound: system block, content part, tool_result and tool breakpoints reach the canonical request', () => {
    const request = anthropicRequestToIR({
      model: 'auto',
      max_tokens: 64,
      system: [{ type: 'text', text: 'sys', cache_control: ephemeral }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: ephemeral }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'ok', cache_control: ephemeral },
          ],
        },
      ],
      tools: [{ name: 'f', input_schema: { type: 'object' }, cache_control: ephemeral }],
    });
    expect(request.instructions).toBe('sys');
    expect(request.vendor?.anthropic?.systemCache).toMatchObject(ephemeral);
    expect(request.input[0]).toMatchObject({ type: 'message', content: [{ cache: ephemeral }] });
    expect(request.input[1]).toMatchObject({ type: 'tool_result', callId: 'call_1', cache: ephemeral });
    expect(request.tools?.[0].function.cache).toMatchObject(ephemeral);
  });

  test('outbound: message, content-part, tool_result and tool markers reach the Anthropic payload', () => {
    const request: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        { role: 'system', content: 'sys', cache_control: ephemeral },
        { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: ephemeral }] },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
        { role: 'tool', content: 'ok', tool_call_id: 'call_1', cache_control: ephemeral },
      ],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' }, cache_control: ephemeral } }],
    };
    const payload = buildAnthropicPayload(request, model) as any;
    expect(payload.system[0].cache_control).toEqual(ephemeral);
    expect(payload.messages[0].content[0].cache_control).toEqual(ephemeral);
    expect(payload.messages[2].content[0].cache_control).toEqual(ephemeral);
    expect(payload.tools[0].cache_control).toEqual(ephemeral);
  });

  test('outbound: multiple system blocks are joined AND keep the declared marker', () => {
    const request: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        { role: 'system', content: 'first', cache_control: ephemeral },
        { role: 'system', content: 'second' },
      ],
    };
    const payload = buildAnthropicPayload(request, model) as any;
    expect(payload.system[0].text).toBe('first\n\nsecond');
    expect(payload.system[0].cache_control).toEqual(ephemeral);
  });

  test('outbound: Responses keeps system part cache breakpoints instead of folding them away', () => {
    const request: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        {
          role: 'system',
          content: [{ type: 'text', text: 'sys', prompt_cache_breakpoint: { mode: 'explicit' } }],
        },
        { role: 'user', content: 'hi' },
      ],
    };
    const payload = buildResponsesPayload(request, model) as any;
    expect(payload.instructions).toBeUndefined();
    expect(payload.input[0]).toMatchObject({
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: 'sys', prompt_cache_breakpoint: { mode: 'explicit' } }],
    });
  });
});

describe('cache integrity: streaming and buffered legs agree', () => {
  test('Anthropic SSE message_start carries cache_read_input_tokens like the JSON body', () => {
    const response = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'up-model-1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 5,
        total_tokens: 125,
        prompt_tokens_details: { cached_tokens: 100 },
      },
    } as any;
    const ir = responseToIR(response);
    const encoder = new AnthropicMessagesEventEncoder();
    const start = canonicalResponseToEvents(ir)
      .flatMap((event) => encoder.encode(event, 'served-model', ir))
      .find((event) => event.type === 'message_start')!;
    const payload = start;
    expect(payload.message.usage).toEqual({
      input_tokens: 20,
      output_tokens: 0,
      cache_read_input_tokens: 100,
    });
  });

  test('live Anthropic encodeChunk path also puts cache tokens on message_start', () => {
    // Mirrors surfaces/anthropic.ts encodeChunk: no finalResponse argument.
    // Native Anthropic decode emits created then usage from the same message_start.
    const encoder = new AnthropicMessagesEventEncoder();
    const beforeUsage = encoder.encode(
      { type: 'response.created', id: 'msg_live', model: 'served-model' },
      'served-model',
    );
    expect(beforeUsage.some((event) => event.type === 'message_start')).toBe(false);
    // IR usage.inputTokens is the FULL prompt (cached + uncached), matching
    // chat `prompt_tokens`. Anthropic wire then splits cache out of input_tokens.
    const afterUsage = encoder.encode({
      type: 'response.usage',
      usage: { inputTokens: 120, outputTokens: 0, cachedInputTokens: 100 },
    }, 'served-model');
    const start = afterUsage.find((event) => event.type === 'message_start')!;
    expect(start.message.usage).toEqual({
      input_tokens: 20,
      output_tokens: 0,
      cache_read_input_tokens: 100,
    });
  });
});

describe('cache integrity: usage accounting', () => {
  test('Google maps cachedContentTokenCount to prompt_tokens_details.cached_tokens', () => {
    const resp = googleToChatCompletion(
      {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 5,
          totalTokenCount: 105,
          cachedContentTokenCount: 80,
        },
      } as any,
      model
    );
    expect(resp.usage?.prompt_tokens_details?.cached_tokens).toBe(80);
    expect(resp.usage?.prompt_tokens).toBe(100);
  });

  test('Google omits the cache breakdown when nothing was cached', () => {
    const resp = googleToChatCompletion(
      {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      } as any,
      model
    );
    expect(resp.usage?.prompt_tokens_details).toBeUndefined();
  });
});

describe('cache integrity: Responses carrier', () => {
  test('prompt_cache_retention / options and content breakpoints reach the payload', () => {
    const request: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        {
          role: 'tool',
          content: [
            { type: 'text', text: 'line 1' },
            { type: 'text', text: 'line 2' },
          ],
          tool_call_id: 'call_1',
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi', prompt_cache_breakpoint: { mode: 'explicit' } }],
        },
      ],
      prompt_cache_retention: '24h',
      prompt_cache_options: { mode: 'explicit' },
    };
    const payload = buildResponsesPayload(request, model) as any;
    expect(payload.input[0].output).toBe('line 1\nline 2');
    expect(payload.input[1].content[0].prompt_cache_breakpoint).toEqual({ mode: 'explicit' });
    expect(payload.prompt_cache_retention).toBe('24h');
    expect(payload.prompt_cache_options).toEqual({ mode: 'explicit' });
  });

  test('rejects a non-text instruction part instead of silently dropping it', () => {
    const request: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        {
          role: 'system',
          content: [{ type: 'image_url', image_url: { url: 'https://example.test/instruction.png' } }],
        },
        { role: 'user', content: 'hi' },
      ],
    };
    expect(() => buildResponsesPayload(request, model)).toThrow(/instructions carry text only/);
  });
});

describe('cache integrity: prompt prefix normalization', () => {
  test('moves system/developer messages without trimming, merging or dropping part metadata', () => {
    const items = PromptOptimizer.normalizeMessages(toIR({
      model: 'auto',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: [{ type: 'text', text: '  first  ', cache_control: ephemeral }], cache_control: ephemeral },
        { role: 'developer', content: [{ type: 'text', text: '\nsecond\n' }] },
      ],
    }));
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.type === 'message' ? item.role : item.type)).toEqual(['system', 'developer', 'user']);
    expect(items[0]).toMatchObject({
      type: 'message', role: 'system', cache: ephemeral,
      content: [{ type: 'text', text: '  first  ', cache: ephemeral }],
    });
    expect(items[1]).toMatchObject({
      type: 'message', role: 'developer',
      content: [{ type: 'text', text: '\nsecond\n' }],
    });
  });
});

describe('cache integrity: generic OpenAI-compatible wire', () => {
  test('strips foreign carrier cache fields before dispatch', async () => {
    let received: any = null;
    const server = serve({
      port: 0,
      async fetch(req) {
        received = await req.json();
        return Response.json({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1700000000,
          model: 'upstream-model-id',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    try {
      const config: ProviderConfig = {
        name: 'test-provider',
        type: 'openai-chat',
        baseUrl: `http://localhost:${server.port}`,
        apiKey: 'sk-test',
      };
      const provider = new OpenAIChatProvider(config);
      const request: ChatCompletionRequest = {
        model: 'm1',
        messages: [
          { role: 'system', content: 'sys', cache_control: ephemeral },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hi', cache_control: ephemeral, prompt_cache_breakpoint: { mode: 'explicit' } },
            ],
          },
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'f', parameters: { type: 'object' }, cache_control: ephemeral },
          },
        ],
        prompt_cache_retention: '24h',
        prompt_cache_options: { mode: 'explicit' },
        max_thinking_tokens: 4096,
      };
      await provider.createCompletion(toIR(request), model);
      expect(received.messages[0].cache_control).toBeUndefined();
      expect(received.messages[1].content[0].cache_control).toBeUndefined();
      expect(received.messages[1].content[0].prompt_cache_breakpoint).toBeUndefined();
      expect(received.tools[0].function.cache_control).toBeUndefined();
      expect(received.prompt_cache_retention).toBeUndefined();
      expect(received.prompt_cache_options).toBeUndefined();
      expect(received.max_thinking_tokens).toBeUndefined();
      // Tool definitions themselves must survive the strip.
      expect(received.tools[0].function.name).toBe('f');
    } finally {
      server.stop(true);
    }
  });
});

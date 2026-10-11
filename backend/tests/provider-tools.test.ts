import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnthropicPayload, anthropicToChatCompletion } from '../src/providers/anthropic.js';
import { buildGooglePayload, googleToChatCompletion } from '../src/providers/google.js';
import { buildResponsesPayload, responsesToChatCompletion } from '../src/providers/responses.js';
import { ChatCompletionRequest, ToolCall } from '../src/types/openai.js';

const model = { id: 'm1', upstreamModel: 'up-model-1' } as any;

const chatRequest: ChatCompletionRequest = {
  model: 'auto',
  messages: [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'list the files' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } },
      ],
    },
    { role: 'tool', content: 'a.ts,b.ts', tool_call_id: 'call_1' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List files in a directory',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    },
  ],
} as ChatCompletionRequest;

describe('Anthropic upstream wire: tools mapping', () => {
  it('maps request.tools to Anthropic tools with input_schema', () => {
    const p = buildAnthropicPayload(chatRequest, model) as any;
    assert.deepStrictEqual(p.tools, [
      {
        name: 'list_files',
        description: 'List files in a directory',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]);
  });

  it('maps assistant tool_calls to tool_use blocks and tool role to tool_result blocks', () => {
    const p = buildAnthropicPayload(chatRequest, model) as any;
    const assistant = p.messages.find((m: any) => m.role === 'assistant');
    assert.deepStrictEqual(assistant.content, [
      { type: 'tool_use', id: 'call_1', name: 'list_files', input: { path: '.' } },
    ]);
    const toolTurn = p.messages.find((m: any) => Array.isArray(m.content) && m.content[0].type === 'tool_result');
    assert.strictEqual(toolTurn.role, 'user');
    assert.strictEqual(toolTurn.content[0].tool_use_id, 'call_1');
    assert.strictEqual(toolTurn.content[0].content, 'a.ts,b.ts');
  });

  it('keeps system prompt + ephemeral cache block and maps tool_choice', () => {
    const req = { ...chatRequest, tool_choice: 'auto' as const };
    const p = buildAnthropicPayload(req, model) as any;
    assert.strictEqual(p.system[0].cache_control.type, 'ephemeral');
    assert.deepStrictEqual(p.tool_choice, { type: 'auto' });
  });

  it('maps image parts to Anthropic source blocks (base64 + url) and stop to stop_sequences', () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
            { type: 'image_url', image_url: { url: 'https://example.com/pic.jpg' } },
          ],
        },
      ],
      stop: ['END', 'STOP_ALL'],
    } as ChatCompletionRequest;
    const p = buildAnthropicPayload(req, model) as any;
    const blocks = p.messages[0].content;
    assert.strictEqual(blocks[0].type, 'text');
    assert.deepStrictEqual(blocks[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
    assert.deepStrictEqual(blocks[2], { type: 'image', source: { type: 'url', url: 'https://example.com/pic.jpg' } });
    assert.deepStrictEqual(p.stop_sequences, ['END', 'STOP_ALL']);
  });

  it('maps upstream tool_use blocks back to chat tool_calls with finish_reason tool_calls', () => {
    const resp = anthropicToChatCompletion(
      {
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'call_9', name: 'read_file', input: { path: 'a.ts' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 6 },
      } as any,
      model
    );
    const msg = resp.choices[0].message;
    assert.strictEqual(resp.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(msg.content, 'checking');
    assert.strictEqual(msg.tool_calls?.[0].id, 'call_9');
    assert.strictEqual(msg.tool_calls?.[0].function.name, 'read_file');
    assert.strictEqual(JSON.parse(msg.tool_calls?.[0].function.arguments || '{}').path, 'a.ts');
    assert.strictEqual(resp.usage.prompt_tokens, 16, 'uncached + cached = prompt tokens');
  });
});

describe('Google upstream wire: tools mapping', () => {
  it('maps request.tools to functionDeclarations', () => {
    const p = buildGooglePayload(chatRequest, model) as any;
    assert.deepStrictEqual(p.tools, [
      {
        functionDeclarations: [
          {
            name: 'list_files',
            description: 'List files in a directory',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      },
    ]);
  });

  it('maps assistant tool_calls to functionCall parts and tool role to functionResponse with resolved name', () => {
    const p = buildGooglePayload(chatRequest, model) as any;
    const modelTurn = p.contents.find((c: any) => c.role === 'model');
    assert.deepStrictEqual(modelTurn.parts, [{ functionCall: { name: 'list_files', args: { path: '.' } } }]);
    const toolTurn = p.contents.find((c: any) => c.parts?.[0]?.functionResponse);
    assert.strictEqual(toolTurn.role, 'user');
    assert.strictEqual(toolTurn.parts[0].functionResponse.name, 'list_files', 'call_id must resolve to the function name');
    assert.deepStrictEqual(toolTurn.parts[0].functionResponse.response, { result: 'a.ts,b.ts' });
  });

  it('maps tool_choice to functionCallingConfig mode', () => {
    const p = buildGooglePayload({ ...chatRequest, tool_choice: 'none' } as ChatCompletionRequest, model) as any;
    assert.deepStrictEqual(p.toolConfig, { functionCallingConfig: { mode: 'NONE' } });
  });

  it('maps data-URL images to inlineData with the real MIME type (not image/*)', () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,WFla' } },
          ],
        },
      ],
    } as ChatCompletionRequest;
    const p = buildGooglePayload(req, model) as any;
    assert.deepStrictEqual(p.contents[0].parts, [
      { text: 'look' },
      { inlineData: { mimeType: 'image/jpeg', data: 'WFla' } },
    ]);
  });

  it('maps upstream functionCall parts back to chat tool_calls with finish_reason tool_calls', () => {
    const resp = googleToChatCompletion(
      {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 },
      } as any,
      model
    );
    const msg = resp.choices[0].message;
    assert.strictEqual(resp.choices[0].finish_reason, 'tool_calls');
    const tc: ToolCall | undefined = msg.tool_calls?.[0];
    assert.strictEqual(tc?.function.name, 'read_file');
    assert.deepStrictEqual(JSON.parse(tc?.function.arguments || '{}'), { path: 'a.ts' });
    assert.deepStrictEqual(resp.usage, { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 });
  });
});

describe('Responses upstream wire: tools mapping', () => {
  it('passes request.tools through (identical flat function shape) and maps reasoning_effort', () => {
    const p = buildResponsesPayload(
      { ...chatRequest, reasoning_effort: 'high' } as ChatCompletionRequest,
      model
    ) as any;
    assert.deepStrictEqual(p.tools, chatRequest.tools);
    assert.deepStrictEqual(p.reasoning, { effort: 'high' });
  });

  it('maps assistant tool_calls to function_call items and tool role to function_call_output items', () => {
    const p = buildResponsesPayload(chatRequest, model) as any;
    const fc = p.input.find((i: any) => i.type === 'function_call');
    assert.strictEqual(fc.call_id, 'call_1');
    assert.strictEqual(fc.name, 'list_files');
    assert.strictEqual(fc.arguments, '{"path":"."}');
    const out = p.input.find((i: any) => i.type === 'function_call_output');
    assert.strictEqual(out.call_id, 'call_1');
    assert.strictEqual(out.output, 'a.ts,b.ts');
  });

  it('maps upstream function_call output items back to chat tool_calls (call_id preserved) and system to instructions', () => {
    const resp = responsesToChatCompletion(
      {
        output: [
          { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
        ],
        usage: { input_tokens: 5, output_tokens: 2 },
      } as any,
      model
    );
    const msg = resp.choices[0].message;
    assert.strictEqual(resp.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(msg.tool_calls?.[0].id, 'call_1', 'call_id must round-trip so the tool result matches');
    assert.strictEqual(msg.tool_calls?.[0].function.name, 'read_file');
    assert.strictEqual(resp.usage.total_tokens, 7, 'total falls back to input+output when absent');
  });
});

describe('Reasoning-token surfacing in upstream responses', () => {
  it('Anthropic: surfaces output_tokens_details.thinking_tokens as reasoning_tokens', () => {
    const resp = anthropicToChatCompletion(
      {
        id: 'msg_1',
        content: [{ type: 'text', text: '42' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 5,
          output_tokens: 10,
          output_tokens_details: { thinking_tokens: 7 },
        },
      } as any,
      model
    );
    assert.strictEqual(resp.usage?.completion_tokens_details?.reasoning_tokens, 7);
  });

  it('Anthropic: omits reasoning breakdown when thinking_tokens is absent', () => {
    const resp = anthropicToChatCompletion(
      {
        id: 'msg_2',
        content: [{ type: 'text', text: 'plain' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 10 },
      } as any,
      model
    );
    assert.strictEqual(resp.usage?.completion_tokens_details, undefined);
  });

  it('Google: surfaces usageMetadata.thoughtsTokenCount as reasoning_tokens', () => {
    const resp = googleToChatCompletion(
      {
        candidates: [
          {
            content: { parts: [{ text: '42' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15, thoughtsTokenCount: 8 },
      } as any,
      model
    );
    assert.strictEqual(resp.usage?.completion_tokens_details?.reasoning_tokens, 8);
  });

  it('Google: omits reasoning breakdown when thoughtsTokenCount is absent', () => {
    const resp = googleToChatCompletion(
      {
        candidates: [
          { content: { parts: [{ text: 'plain' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 },
      } as any,
      model
    );
    assert.strictEqual(resp.usage?.completion_tokens_details, undefined);
  });

  it('Responses: surfaces output_tokens_details.reasoning_tokens', () => {
    const resp = responsesToChatCompletion(
      {
        id: 'resp_1',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '42' }] }],
        usage: {
          input_tokens: 5,
          output_tokens: 10,
          total_tokens: 15,
          output_tokens_details: { reasoning_tokens: 6 },
        },
      } as any,
      model
    );
    assert.strictEqual(resp.usage?.completion_tokens_details?.reasoning_tokens, 6);
  });
});

describe('Thinking controls across upstreams', () => {
  it('Anthropic: maps reasoning_effort ladder to thinking.budget_tokens and bumps max_tokens', () => {
    const p = buildAnthropicPayload(
      { ...chatRequest, reasoning_effort: 'high' } as ChatCompletionRequest,
      model
    ) as any;
    assert.deepStrictEqual(p.thinking, { type: 'enabled', budget_tokens: 16384 });
    // max_tokens must leave headroom over the budget so Anthropic accepts the request.
    assert.ok(p.max_tokens > 16384, `max_tokens (${p.max_tokens}) must exceed thinking budget`);
  });

  it('Anthropic: explicit max_thinking_tokens wins over effort ladder', () => {
    const p = buildAnthropicPayload(
      { ...chatRequest, reasoning_effort: 'low', max_thinking_tokens: 8000 } as ChatCompletionRequest,
      model
    ) as any;
    assert.deepStrictEqual(p.thinking, { type: 'enabled', budget_tokens: 8000 });
  });

  it('Anthropic: leaves thinking unset when neither effort nor budget is given', () => {
    const p = buildAnthropicPayload(chatRequest, model) as any;
    assert.strictEqual(p.thinking, undefined);
  });

  it('Google: maps reasoning_effort ladder to thinkingConfig.thinkingBudget', () => {
    const p = buildGooglePayload(
      { ...chatRequest, reasoning_effort: 'medium' } as ChatCompletionRequest,
      model
    ) as any;
    assert.deepStrictEqual(p.generationConfig.thinkingConfig, {
      thinkingBudget: 4096,
      includeThoughts: true,
    });
  });

  it('Google: explicit max_thinking_tokens wins over effort ladder', () => {
    const p = buildGooglePayload(
      { ...chatRequest, reasoning_effort: 'low', max_thinking_tokens: 2000 } as ChatCompletionRequest,
      model
    ) as any;
    assert.deepStrictEqual(p.generationConfig.thinkingConfig, {
      thinkingBudget: 2000,
      includeThoughts: true,
    });
  });

  it('Google: omits thinkingConfig when neither effort nor budget is set', () => {
    const p = buildGooglePayload(chatRequest, model) as any;
    assert.strictEqual(p.generationConfig?.thinkingConfig, undefined);
  });

  it('Responses: maps reasoning_effort + max_thinking_tokens into the reasoning object', () => {
    const p = buildResponsesPayload(
      { ...chatRequest, reasoning_effort: 'high', max_thinking_tokens: 9000 } as ChatCompletionRequest,
      model
    ) as any;
    assert.deepStrictEqual(p.reasoning, { effort: 'high', max_tokens: 9000 });
  });

  it('Responses: emits reasoning.max_tokens alone when only budget is given', () => {
    const p = buildResponsesPayload(
      { ...chatRequest, max_thinking_tokens: 1500 } as ChatCompletionRequest,
      model
    ) as any;
    assert.deepStrictEqual(p.reasoning, { max_tokens: 1500 });
  });

  it('Anthropic: reasoning_effort=none leaves thinking unset (upstream default)', () => {
    const p = buildAnthropicPayload(
      { ...chatRequest, reasoning_effort: 'none' } as ChatCompletionRequest,
      model
    ) as any;
    assert.strictEqual(p.thinking, undefined);
  });

  it('Anthropic: reasoning_effort=xhigh maps to budget_tokens=32768', () => {
    const p = buildAnthropicPayload(
      { ...chatRequest, reasoning_effort: 'xhigh' } as ChatCompletionRequest,
      model
    ) as any;
    assert.deepStrictEqual(p.thinking, { type: 'enabled', budget_tokens: 32768 });
    assert.ok(p.max_tokens > 32768);
  });

  // P1.2: `max` is Anthropic's top-tier effort (Opus 5.5+). The 65536
  // budget is the engineering estimate for the top tier — operators with
  // strict cost caps should pass an explicit `max_thinking_tokens` instead
  // of relying on the ladder. This assertion locks the current estimate so
  // changes to the table are caught by review.
  it('Anthropic: reasoning_effort=max maps to budget_tokens=65536', () => {
    const p = buildAnthropicPayload(
      { ...chatRequest, reasoning_effort: 'max' } as ChatCompletionRequest,
      model
    ) as any;
    assert.deepStrictEqual(p.thinking, { type: 'enabled', budget_tokens: 65536 });
    assert.ok(p.max_tokens > 65536);
  });

  it('Google: reasoning_effort=none leaves thinkingConfig unset', () => {
    const p = buildGooglePayload(
      { ...chatRequest, reasoning_effort: 'none' } as ChatCompletionRequest,
      model
    ) as any;
    assert.strictEqual(p.generationConfig?.thinkingConfig, undefined);
  });

  it('Google: reasoning_effort=xhigh maps to thinkingBudget=32768', () => {
    const p = buildGooglePayload(
      { ...chatRequest, reasoning_effort: 'xhigh' } as ChatCompletionRequest,
      model
    ) as any;
    assert.deepStrictEqual(p.generationConfig.thinkingConfig, {
      thinkingBudget: 32768,
      includeThoughts: true,
    });
  });

  // P1.2: `max` on the Google wire is an interop alias — Gemini natively
  // only honors `low` and `high`; we accept it for vocabulary uniformity
  // and translate to a high budget. Operators should pass explicit
  // `max_thinking_tokens` for production cost control.
  it('Google: reasoning_effort=max maps to thinkingBudget=65536', () => {
    const p = buildGooglePayload(
      { ...chatRequest, reasoning_effort: 'max' } as ChatCompletionRequest,
      model
    ) as any;
    assert.deepStrictEqual(p.generationConfig.thinkingConfig, {
      thinkingBudget: 65536,
      includeThoughts: true,
    });
  });

  it('Responses: reasoning_effort=none passes through verbatim (OpenAI Responses treats it as "no reasoning")', () => {
    const p = buildResponsesPayload(
      { ...chatRequest, reasoning_effort: 'none' } as ChatCompletionRequest,
      model
    ) as any;
    assert.deepStrictEqual(p.reasoning, { effort: 'none' });
  });

  it('Responses: reasoning_effort=xhigh passes through verbatim', () => {
    const p = buildResponsesPayload(
      { ...chatRequest, reasoning_effort: 'xhigh' } as ChatCompletionRequest,
      model
    ) as any;
    assert.deepStrictEqual(p.reasoning, { effort: 'xhigh' });
  });

  it('reasoning_effort=none with explicit max_thinking_tokens → budget wins (explicit value beats "no effort")', () => {
    // Operator sanity test: "none" means "I want no effort control" but
    // an explicit budget number IS a budget directive. Documented ordering.
    const p = buildAnthropicPayload(
      { ...chatRequest, reasoning_effort: 'none', max_thinking_tokens: 8000 } as ChatCompletionRequest,
      model
    ) as any;
    assert.deepStrictEqual(p.thinking, { type: 'enabled', budget_tokens: 8000 });
  });

  it('reasoning_effort=none alone → no thinking block on Anthropic', () => {
    const p = buildAnthropicPayload(
      { ...chatRequest, reasoning_effort: 'none' } as ChatCompletionRequest,
      model
    ) as any;
    assert.strictEqual(p.thinking, undefined, 'none must not construct thinking block');
  });
});

describe('Provider payload builders: temperature capability (models.dev tri-state)', () => {
  const reqWithTemp = { ...chatRequest, temperature: 1 } as ChatCompletionRequest;
  const strippedModel = { ...model, temperature: false } as any;
  const allowedModel = { ...model, temperature: true } as any;

  it('anthropic: temperature:false → field dropped from the serialized wire body', () => {
    const p = buildAnthropicPayload(reqWithTemp, strippedModel) as any;
    assert.strictEqual(p.temperature, undefined);
    assert.ok(!JSON.stringify(p).includes('"temperature"'), 'wire body must not carry temperature');
  });

  it('anthropic: temperature:true / undefined (manual registration) keeps passthrough', () => {
    assert.strictEqual((buildAnthropicPayload(reqWithTemp, allowedModel) as any).temperature, 1);
    assert.strictEqual((buildAnthropicPayload(reqWithTemp, model) as any).temperature, 1);
  });

  it('google: temperature:false → generationConfig.temperature omitted', () => {
    const p = buildGooglePayload(reqWithTemp, strippedModel) as any;
    assert.strictEqual(p.generationConfig?.temperature, undefined);
    assert.strictEqual((buildGooglePayload(reqWithTemp, allowedModel) as any).generationConfig.temperature, 1);
  });

  it('responses: temperature:false → payload.temperature omitted', () => {
    const p = buildResponsesPayload(reqWithTemp, strippedModel) as any;
    assert.strictEqual(p.temperature, undefined);
    assert.strictEqual((buildResponsesPayload(reqWithTemp, allowedModel) as any).temperature, 1);
  });
});

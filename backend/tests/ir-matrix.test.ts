import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRegistration, StreamingClientMode, StreamingUpstreamMode } from '../src/config/types.js';
import type { CanonicalRequest, CanonicalResponse, StreamEvent } from '../src/ir/types.js';
import type { ExecutionResult } from '../src/types/router.js';
import type { ChatSurface } from '../src/surfaces/types.js';
import {
  chatRequestToIR,
  chatResponseToIR,
  irToChatRequest,
  irToChatResponse,
} from '../src/ir/adapters/openai-chat.js';
import {
  canonicalToResponsesPayload,
  responsesRequestToIR,
  responsesResponseToIR,
} from '../src/ir/adapters/openai-responses.js';
import {
  anthropicRequestToIR,
  anthropicResponseToIR,
  canonicalToAnthropicPayload,
  canonicalToAnthropicResponse,
} from '../src/ir/adapters/anthropic-messages.js';
import { canonicalToGooglePayload, googleResponseToIR } from '../src/ir/adapters/google-gemini.js';
import { OpenAIResponsesStreamDecoder } from '../src/ir/adapters/openai-responses-stream.js';
import { AnthropicMessagesStreamDecoder } from '../src/ir/adapters/anthropic-messages-stream.js';
import { GoogleGeminiStreamDecoder } from '../src/ir/adapters/google-gemini-stream.js';
import {
  canonicalResponseToEvents,
  createEventAccumulator,
} from '../src/ir/stream.js';
import { ChatStreamDecoder } from '../src/ir/adapters/openai-chat-stream.js';
import { chatSurface } from '../src/surfaces/chat.js';
import { responsesSurface } from '../src/surfaces/responses.js';
import { anthropicSurface } from '../src/surfaces/anthropic.js';
import {
  applyStreamingPosture,
  resetStreamingPostureForTests,
} from '../src/pipeline/streaming-posture.js';

const model: ModelRegistration = {
  id: 'provider/model', provider: 'provider', upstreamModel: 'upstream-model', tier: 'plus',
  pricing: { input: 1, output: 1, cacheRead: 0.1 },
};

const requestBodies = {
  chat: (stream: boolean) => ({
    model: 'auto', stream,
    messages: [
      { role: 'system', content: 'be precise' },
      { role: 'user', content: 'inspect the file' },
      {
        role: 'assistant', content: '', tool_calls: [{
          id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' },
        }]
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
    ],
    tools: [{
      type: 'function', function: {
        name: 'read', description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }
    }],
    router_options: { force_tier: 'pro' },
  }),
  responses: (stream: boolean) => ({
    model: 'auto', stream, instructions: 'be precise',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect the file' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
    ],
    tools: [{
      type: 'function', name: 'read', description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }],
  }),
  anthropic: (stream: boolean) => ({
    model: 'auto', stream, max_tokens: 256, system: 'be precise',
    messages: [
      { role: 'user', content: 'inspect the file' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file contents' }] },
    ],
    tools: [{
      name: 'read', description: 'Read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }],
  }),
} as const;

type Northbound = keyof typeof requestBodies;
type Southbound = 'chat' | 'responses' | 'anthropic' | 'google';

const requestParsers: Record<Northbound, (body: unknown) => CanonicalRequest> = {
  chat: (body) => chatRequestToIR(body as any),
  responses: (body) => responsesRequestToIR(body),
  anthropic: (body) => anthropicRequestToIR(body),
};

const requestRenderers: Record<Southbound, (request: CanonicalRequest) => Record<string, any>> = {
  chat: (request) => irToChatRequest(request, model.upstreamModel!) as Record<string, any>,
  responses: (request) => canonicalToResponsesPayload(request, model),
  anthropic: (request) => canonicalToAnthropicPayload(request, model),
  google: (request) => canonicalToGooglePayload(request, model),
};

const responseBodies: Record<Southbound, () => unknown> = {
  chat: () => ({
    id: 'chatcmpl_1', object: 'chat.completion', created: 1, model: 'upstream-model',
    choices: [{
      index: 0, finish_reason: 'tool_calls', message: {
        role: 'assistant', content: 'hello',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }],
      }
    }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 4 } },
  }),
  responses: () => ({
    id: 'resp_1', object: 'response', created_at: 1, model: 'upstream-model', status: 'completed',
    output: [
      { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}', status: 'completed' },
    ],
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 4 } },
  }),
  anthropic: () => ({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'upstream-model', stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.ts' } },
    ],
    usage: { input_tokens: 6, output_tokens: 3, cache_read_input_tokens: 4 },
  }),
  google: () => ({
    responseId: 'google_1', modelVersion: 'upstream-model',
    candidates: [{
      index: 0, finishReason: 'STOP', content: {
        role: 'model', parts: [
          { text: 'hello' }, { functionCall: { id: 'call_1', name: 'read', args: { path: 'a.ts' } } },
        ]
      }
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13, cachedContentTokenCount: 4 },
  }),
};

const responseParsers: Record<Southbound, (body: unknown) => CanonicalResponse> = {
  chat: (body) => chatResponseToIR(body as any),
  responses: (body) => responsesResponseToIR(body),
  anthropic: (body) => anthropicResponseToIR(body),
  google: (body) => googleResponseToIR(body),
};

const nativeFrames: Record<Southbound, () => unknown[]> = {
  chat: () => [
    { id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'upstream-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'hel' }, finish_reason: null }] },
    { id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'upstream-model', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] },
    { id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'upstream-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":' } }] }, finish_reason: null }] },
    { id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'upstream-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: 'tool_calls' }] },
    { id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'upstream-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 4 } } },
  ],
  responses: () => [
    { type: 'response.created', response: { id: 'resp_1', model: 'upstream-model', created_at: 1 } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hel' },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'lo' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'hello' },
    { type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'hello', annotations: [] } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"a.ts"}' },
    { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"path":"a.ts"}' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}', status: 'completed' } },
    { type: 'response.completed', response: { id: 'resp_1', model: 'upstream-model', created_at: 1, status: 'completed', usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 4 } } } },
  ],
  anthropic: () => [
    { type: 'message_start', message: { id: 'msg_1', model: 'upstream-model', usage: { input_tokens: 6, output_tokens: 0, cache_read_input_tokens: 4 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hel' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'read', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ],
  google: () => [
    { responseId: 'google_1', modelVersion: 'upstream-model', candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hel' }] } }] },
    { responseId: 'google_1', modelVersion: 'upstream-model', candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'lo' }, { functionCall: { id: 'call_1', name: 'read', args: { path: 'a.ts' } } }] } }] },
    { responseId: 'google_1', modelVersion: 'upstream-model', candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13, cachedContentTokenCount: 4 } },
  ],
};

function decodeNative(upstream: Southbound): StreamEvent[] {
  const decoder = upstream === 'chat' ? new ChatStreamDecoder()
    : upstream === 'responses' ? new OpenAIResponsesStreamDecoder()
      : upstream === 'anthropic' ? new AnthropicMessagesStreamDecoder()
        : new GoogleGeminiStreamDecoder();
  const events: StreamEvent[] = [];
  for (const frame of nativeFrames[upstream]()) events.push(...decoder.push(frame as any));
  events.push(...decoder.finish());
  return events;
}

function accumulate(events: StreamEvent[]): CanonicalResponse {
  const accumulator = createEventAccumulator();
  for (const event of events) accumulator.push(event);
  return accumulator.finish();
}

interface SemanticResponse {
  text: string;
  toolName: string;
  arguments: string;
  cached: number;
  terminal: string;
}

function semanticIR(response: CanonicalResponse): SemanticResponse {
  return {
    text: response.output.flatMap((item) => item.type === 'message'
      ? item.content.flatMap((part) => part.type === 'text' ? [part.text] : []) : []).join(''),
    toolName: response.output.find((item) => item.type === 'tool_call')?.name ?? '',
    arguments: response.output.find((item) => item.type === 'tool_call')?.arguments ?? '',
    cached: response.usage.cachedInputTokens ?? 0,
    terminal: response.status,
  };
}

function semanticJson(wire: Northbound, raw: any): SemanticResponse {
  if (wire === 'chat') {
    const choice = raw.choices[0];
    return {
      text: choice.message.content ?? '', toolName: choice.message.tool_calls?.[0]?.function.name ?? '',
      arguments: choice.message.tool_calls?.[0]?.function.arguments ?? '',
      cached: raw.usage?.prompt_tokens_details?.cached_tokens ?? 0, terminal: choice.finish_reason,
    };
  }
  if (wire === 'responses') {
    const message = raw.output.find((item: any) => item.type === 'message');
    const call = raw.output.find((item: any) => item.type === 'function_call');
    return {
      text: message?.content?.map((part: any) => part.text ?? '').join('') ?? '',
      toolName: call?.name ?? '', arguments: call?.arguments ?? '',
      cached: raw.usage?.input_tokens_details?.cached_tokens ?? 0, terminal: raw.status,
    };
  }
  const call = raw.content.find((item: any) => item.type === 'tool_use');
  return {
    text: raw.content.flatMap((item: any) => item.type === 'text' ? [item.text] : []).join(''),
    toolName: call?.name ?? '', arguments: call ? JSON.stringify(call.input) : '',
    cached: raw.usage?.cache_read_input_tokens ?? 0, terminal: raw.stop_reason,
  };
}

function ssePayloads(frames: string[]): any[] {
  return frames.join('').split(/\r?\n/)
    .filter((line) => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]')
    .map((line) => JSON.parse(line.slice(5).trim()));
}

function semanticSse(wire: Northbound, frames: string[]): SemanticResponse {
  const payloads = ssePayloads(frames);
  if (wire === 'chat') {
    const chunks = payloads.filter((payload) => payload.object === 'chat.completion.chunk');
    const deltas = chunks.flatMap((chunk) => chunk.choices ?? []);
    const usage = [...chunks].reverse().find((chunk) => chunk.usage)?.usage;
    assert.equal(frames.join('').match(/data: \[DONE\]/g)?.length, 1);
    assert.equal(deltas.filter((choice: any) => choice.finish_reason).length, 1);
    return {
      text: deltas.map((choice: any) => choice.delta?.content ?? '').join(''),
      toolName: deltas.map((choice: any) => choice.delta?.tool_calls?.[0]?.function?.name ?? '').join(''),
      arguments: deltas.map((choice: any) => choice.delta?.tool_calls?.[0]?.function?.arguments ?? '').join(''),
      cached: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      terminal: deltas.find((choice: any) => choice.finish_reason)?.finish_reason,
    };
  }
  if (wire === 'responses') {
    assert.equal(payloads.filter((payload) => payload.type === 'response.completed').length, 1);
    const completed = payloads.find((payload) => payload.type === 'response.completed');
    const call = completed.response.output.find((item: any) => item.type === 'function_call');
    return {
      text: payloads.flatMap((payload) => payload.type === 'response.output_text.delta' ? [payload.delta] : []).join(''),
      toolName: call?.name ?? '', arguments: call?.arguments ?? '',
      cached: completed.response.usage?.input_tokens_details?.cached_tokens ?? 0,
      terminal: completed.response.status,
    };
  }
  assert.equal(payloads.filter((payload) => payload.type === 'message_stop').length, 1);
  const start = payloads.find((payload) => payload.type === 'message_start');
  const delta = [...payloads].reverse().find((payload) => payload.type === 'message_delta');
  const call = payloads.find((payload) => payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use');
  return {
    text: payloads.flatMap((payload) => payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta' ? [payload.delta.text] : []).join(''),
    toolName: call?.content_block.name ?? '',
    arguments: payloads.flatMap((payload) => payload.type === 'content_block_delta' && payload.delta?.type === 'input_json_delta' ? [payload.delta.partial_json] : []).join(''),
    cached: delta?.usage?.cache_read_input_tokens ?? start?.message.usage?.cache_read_input_tokens ?? 0,
    terminal: delta?.delta.stop_reason,
  };
}

function execution(response: CanonicalResponse): ExecutionResult {
  return { response, modelUsed: 'served-model', latencyMs: 0, fallbackOccurred: false };
}

const surfaces: Record<Northbound, ChatSurface> = {
  chat: chatSurface, responses: responsesSurface, anthropic: anthropicSurface,
};

function assertCommonSemantic(actual: SemanticResponse, terminal: string): void {
  assert.equal(actual.text, 'hello');
  assert.equal(actual.toolName, 'read');
  assert.equal(actual.arguments, '{"path":"a.ts"}');
  assert.equal(actual.cached, 4);
  assert.equal(actual.terminal, terminal);
}

describe('IR request conversion matrix (3 northbound x 4 southbound)', () => {
  for (const north of Object.keys(requestParsers) as Northbound[]) {
    for (const south of Object.keys(requestRenderers) as Southbound[]) {
      it(`${north} -> IR -> ${south}`, () => {
        const ir = requestParsers[north](requestBodies[north](true));
        const wire = requestRenderers[south]({ ...ir, input: structuredClone(ir.input) });
        const json = JSON.stringify(wire);
        if (south !== 'google') assert.equal(wire.model, 'upstream-model');
        assert.ok(json.includes('be precise'));
        assert.ok(json.includes('inspect the file'));
        assert.ok(json.includes('file contents'));
        assert.ok(json.includes('"read"'));
        assert.ok(json.includes('a.ts'));
        if (south !== 'google') assert.ok(json.includes('call_1'));
        assert.equal('router_options' in wire, false);
        assert.equal('routerOptions' in wire, false);
        assert.equal(JSON.stringify(requestRenderers[south](ir)), json, 'rendering must be deterministic for cache prefixes');
      });
    }
  }
});

describe('IR buffered response matrix (4 southbound x 3 northbound)', () => {
  const expectedTerminal: Record<Northbound, string> = { chat: 'tool_calls', responses: 'completed', anthropic: 'tool_use' };
  for (const south of Object.keys(responseParsers) as Southbound[]) {
    const ir = responseParsers[south](responseBodies[south]());
    assertCommonSemantic(semanticIR(ir), 'completed');
    for (const north of Object.keys(surfaces) as Northbound[]) {
      it(`${south} -> IR -> ${north}`, () => {
        const encoded = north === 'chat' ? irToChatResponse(ir, 'client_1', 'served-model')
          : north === 'responses' ? surfaces.responses.encodeJson(execution(ir), surfaces.responses.parse(requestBodies.responses(false)).state)
            : canonicalToAnthropicResponse(ir, 'served-model');
        assertCommonSemantic(semanticJson(north, encoded), expectedTerminal[north]);
      });
    }
  }
});

describe('IR streaming matrix (3 clients x 4 upstreams x 2 client shapes x 2 upstream shapes)', () => {
  const expectedTerminal: Record<Northbound, string> = { chat: 'tool_calls', responses: 'completed', anthropic: 'tool_use' };
  for (const north of Object.keys(surfaces) as Northbound[]) {
    for (const south of Object.keys(responseParsers) as Southbound[]) {
      for (const upstreamShape of ['native', 'buffered'] as const) {
        const events = upstreamShape === 'native'
          ? decodeNative(south)
          : canonicalResponseToEvents(responseParsers[south](responseBodies[south]()));
        const response = accumulate(events);
        assertCommonSemantic(semanticIR(response), 'completed');
        for (const clientShape of ['sse', 'json'] as const) {
          it(`${north} ${clientShape} <- ${south} ${upstreamShape}`, () => {
            const surface = surfaces[north];
            const parsed = surface.parse(requestBodies[north](clientShape === 'sse'));
            assert.ok(parsed.request, parsed.error);
            const result = execution(response);
            if (clientShape === 'json') {
              assertCommonSemantic(semanticJson(north, surface.encodeJson(result, parsed.state)), expectedTerminal[north]);
              return;
            }
            const frames = [...(surface.streamStart?.(parsed.state, { model: result.modelUsed, includeUsage: true, state: parsed.state }) ?? [])];
            for (const event of events) {
              const frame = surface.encodeChunk?.(event, { model: result.modelUsed, includeUsage: true, state: parsed.state });
              if (frame) frames.push(frame);
            }
            frames.push(...(surface.streamEnd?.(result, parsed.state, { model: result.modelUsed, includeUsage: true, state: parsed.state }) ?? []));
            assertCommonSemantic(semanticSse(north, frames), expectedTerminal[north]);
          });
        }
      }
    }
  }
});

describe('independent client/upstream streaming posture matrix', () => {
  for (const client of ['allow', 'deny', 'always'] as StreamingClientMode[]) {
    for (const upstream of ['follow', 'stream', 'buffered'] as StreamingUpstreamMode[]) {
      it(`client=${client}, upstream=${upstream}`, () => {
        try {
          assert.deepEqual(applyStreamingPosture({ client: { mode: client }, upstream: { mode: upstream } }), { client, upstream });
        } finally {
          resetStreamingPostureForTests();
        }
      });
    }
  }
});

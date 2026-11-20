import { describe, expect, it } from 'bun:test';
import { AnthropicMessagesEventEncoder, canonicalToAnthropicResponse } from '../src/ir/adapters/anthropic-messages';
import {
  OpenAIResponsesEventEncoder,
  canonicalToResponsesObject,
  defaultResponsesEcho,
  newResponseMessageId,
  newResponseStreamSequence,
  responsesEventFrame,
} from '../src/ir/adapters/openai-responses-output';
import { formatChatChunkForClient } from '../src/utils/chat-sse';
import type { StreamEvent } from '../src/ir/types';
import {
  CHAT_PROTOCOLS,
  CHAT_PROTOCOL_BY_ID,
  asChatProtocolId,
  elideDataUrls,
  elideImagePayloads,
  formatBytes,
  imageBytes,
  mergeUsage,
  type WireFrame,
  type WireImage,
  type WireMessage,
  type WireParams,
  type WireUsage,
} from '../../frontend/src/lib/playground-protocols';
import { anthropicRequestToIR } from '../src/ir/adapters/anthropic-messages';
import { chatRequestToIR } from '../src/ir/adapters/openai-chat';
import { responsesRequestToIR } from '../src/ir/adapters/openai-responses';
import { assertCanonicalRequestSupported } from '../src/ir/validate';
import { resetSandbox, runPlaygroundTool } from '../../frontend/src/lib/playground-tools';
import type { CanonicalRequest, ContentPart } from '../src/ir/types';
import { responseIR } from './helpers/ir';

/**
 * The playground console speaks the three chat-shaped wires through ONE adapter
 * table (`frontend/src/lib/playground-protocols.ts`) — the page itself never
 * spells a wire field. Nothing in the typechecker links that table to the
 * backend converters, so this file is the link: it drives the REAL encoders
 * (`AnthropicMessagesEventEncoder`, `OpenAIResponsesEventEncoder`, `formatChatChunkForClient`)
 * and asserts the console can decode what the gateway actually emits.
 *
 * Two failure modes it exists to catch:
 *  - a request field the console spells itself (e.g. sending `max_tokens` to
 *    responses, or `reasoning_effort` to anthropic) — the wire 400s against a
 *    strict upstream while the page looks fine;
 *  - a response/frame vocabulary drift — the answer streams into an empty bubble
 *    because the delta key moved.
 */

const MESSAGES = [
  { role: 'assistant' as const, content: 'earlier answer' },
  { role: 'user' as const, content: 'hello' },
];
const PARAMS = { model: 'gateway-model', stream: true, temperature: 0.2, maxTokens: 512, effort: 'high' };

/** One turn of the page's SSE fold, minus the DOM: feed frames, keep the fold. */
function foldFrames(frames: string[]): { content: string; reasoning: string; usage?: WireUsage; error?: string } {
  let content = '';
  let reasoning = '';
  let usage: WireUsage | undefined;
  let error: string | undefined;
  for (const raw of frames) {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      const frame: WireFrame | null = decodeAny(payload);
      if (!frame) continue;
      if (frame.text) content += frame.text;
      if (frame.reasoning) reasoning += frame.reasoning;
      if (frame.usage) usage = mergeUsage(usage, frame.usage);
      if (frame.error) error = frame.error;
    }
  }
  return { content, reasoning, usage, error };
}

/** The page picks the adapter by the selected protocol; the fold is identical. */
let active: keyof typeof CHAT_PROTOCOL_BY_ID = 'openai-chat';
function decodeAny(payload: string): WireFrame | null {
  return CHAT_PROTOCOL_BY_ID[active].decodeFrame(JSON.parse(payload) as Record<string, unknown>);
}

describe('playground wire adapters — request bodies', () => {
  it('registers exactly the three chat-shaped surfaces, in backend table order', () => {
    expect(CHAT_PROTOCOLS.map((p) => p.id)).toEqual(['openai-chat', 'openai-responses', 'anthropic-messages']);
    expect(CHAT_PROTOCOLS.map((p) => p.path)).toEqual(['/v1/chat/completions', '/v1/responses', '/v1/messages']);
  });

  it('chat keeps the system prompt as the first message and asks for the usage frame', () => {
    const body = CHAT_PROTOCOL_BY_ID['openai-chat'].buildBody(MESSAGES, 'be terse', PARAMS);
    expect(body.messages).toEqual([{ role: 'system', content: 'be terse' }, ...MESSAGES]);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.reasoning_effort).toBe('high');
    expect(body.max_tokens).toBe(512);
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
  });

  it('anthropic hoists the system prompt to a top-level field and never into history', () => {
    const body = CHAT_PROTOCOL_BY_ID['anthropic-messages'].buildBody(MESSAGES, 'be terse', PARAMS);
    expect(body.system).toBe('be terse');
    expect(body.messages).toEqual(MESSAGES);
    expect(body.max_tokens).toBe(512);
    expect(body.output_config).toEqual({ effort: 'high' });
    // No home on this wire: emitting either is a 400, not a silent no-op.
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('responses maps system to instructions, the cap to max_output_tokens, effort into reasoning', () => {
    const body = CHAT_PROTOCOL_BY_ID['openai-responses'].buildBody(MESSAGES, 'be terse', PARAMS);
    expect(body.instructions).toBe('be terse');
    expect(body.input).toEqual(MESSAGES.map((m) => ({ type: 'message', role: m.role, content: m.content })));
    expect(body.max_output_tokens).toBe(512);
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.max_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.messages).toBeUndefined();
  });

  it('omits the system slot and the unused params when the operator left them empty', () => {
    const bare = { model: 'auto', stream: false };
    for (const protocol of CHAT_PROTOCOLS) {
      const body = protocol.buildBody(MESSAGES, '', bare);
      expect(body.system).toBeUndefined();
      expect(body.instructions).toBeUndefined();
      expect(body.messages === undefined || !JSON.stringify(body.messages).includes('system')).toBe(true);
      expect(body.stream).toBeUndefined();
      expect(body.stream_options).toBeUndefined();
      expect(body.temperature).toBeUndefined();
    }
  });

  it('narrows an unknown stored protocol instead of trusting it', () => {
    expect(asChatProtocolId('openai-responses')).toBe('openai-responses');
    expect(asChatProtocolId('anthropic-messages')).toBe('anthropic-messages');
    expect(asChatProtocolId('responses')).toBe('openai-responses');
    expect(asChatProtocolId('anthropic')).toBe('anthropic-messages');
    expect(asChatProtocolId('systemone')).toBe('openai-chat');
    expect(asChatProtocolId(undefined)).toBe('openai-chat');
    expect(asChatProtocolId(42)).toBe('openai-chat');
  });
});

describe('playground wire adapters — non-streaming answers', () => {
  it('decodes the anthropic JSON body the gateway emits', () => {
    const wire = canonicalToAnthropicResponse(
      responseIR('hello there', {
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 60 },
      }),
      'gateway-model',
    );
    const answer = CHAT_PROTOCOL_BY_ID['anthropic-messages'].decodeJson(wire);
    expect(answer.content).toBe('hello there');
    // The wire reports input_tokens WITHOUT the cached portion (40 + 60);
    // the console must report the prompt the client actually paid for.
    expect(answer.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 60 });
  });

  it('decodes the responses JSON body the gateway emits', () => {
    const wire = canonicalToResponsesObject(
      responseIR('hi', { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 4 } }),
      'gateway-model',
      { store: false, echo: defaultResponsesEcho() },
    );
    const answer = CHAT_PROTOCOL_BY_ID['openai-responses'].decodeJson(wire);
    expect(answer.content).toBe('hi');
    expect(answer.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cached_tokens: 4 });
  });

  it('decodes a chat completion whose cache carrier sits in prompt_tokens_details', () => {
    const answer = CHAT_PROTOCOL_BY_ID['openai-chat'].decodeJson({
      choices: [{ message: { content: 'yo' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 4 } },
    });
    expect(answer.content).toBe('yo');
    expect(answer.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cached_tokens: 4 });
  });
});

describe('playground wire adapters — streaming frames', () => {
  it('folds an anthropic turn the gateway encoder produces', () => {
    active = 'anthropic-messages';
    const final = responseIR('hello world', {
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 60 },
    });
    const enc = new AnthropicMessagesEventEncoder();
    const payloads = [
      ...enc.encode({ type: 'response.created' } as StreamEvent, 'gateway-model', final),
      ...enc.encode(
        {
          type: 'response.output_item.added',
          index: 0,
          item: { type: 'message', id: 'm1', role: 'assistant', content: [] },
        } as StreamEvent,
        'gateway-model',
        final,
      ),
      ...enc.encode(
        { type: 'response.content_part.added', index: 0, partIndex: 0, part: { type: 'text', text: '' } } as StreamEvent,
        'gateway-model',
        final,
      ),
      ...enc.encode(
        { type: 'response.output_text.delta', index: 0, partIndex: 0, text: 'hello ' } as StreamEvent,
        'gateway-model',
        final,
      ),
      ...enc.encode(
        { type: 'response.output_text.delta', index: 0, partIndex: 0, text: 'world' } as StreamEvent,
        'gateway-model',
        final,
      ),
      ...enc.encode({ type: 'response.completed' } as StreamEvent, 'gateway-model', final),
    ];
    // Exactly the surface's framing (surfaces/anthropic.ts `sse`).
    const frames = payloads.map((p) => `event: ${String(p.type)}\ndata: ${JSON.stringify(p)}\n\n`);
    const folded = foldFrames(frames);
    expect(folded.content).toBe('hello world');
    expect(folded.error).toBeUndefined();
    expect(folded.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 60 });
  });

  it('folds a responses turn the gateway encoder produces', () => {
    active = 'openai-responses';
    const final = responseIR('hi', {
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 4 },
    });
    const enc = new OpenAIResponsesEventEncoder(
      'resp_1',
      newResponseMessageId(),
      newResponseStreamSequence(),
      false,
      defaultResponsesEcho(),
    );
    const events: StreamEvent[] = [
      { type: 'response.created' } as StreamEvent,
      { type: 'response.output_item.added', index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [] } } as StreamEvent,
      { type: 'response.content_part.added', index: 0, partIndex: 0, part: { type: 'text', text: '' } } as StreamEvent,
      { type: 'response.output_text.delta', index: 0, partIndex: 0, text: 'h' } as StreamEvent,
      { type: 'response.output_text.delta', index: 0, partIndex: 0, text: 'i' } as StreamEvent,
      { type: 'response.completed' } as StreamEvent,
    ];
    const frames: string[] = [];
    for (const event of events) {
      for (const payload of enc.encode(event, 'gateway-model', final)) frames.push(responsesEventFrame(payload));
    }
    const folded = foldFrames(frames);
    expect(folded.content).toBe('hi');
    expect(folded.error).toBeUndefined();
    expect(folded.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cached_tokens: 4 });
  });

  it('folds a chat turn through the client SSE formatter', () => {
    active = 'openai-chat';
    const frames = [
      formatChatChunkForClient({ choices: [{ index: 0, delta: { content: 'he' } }] } as never, 'gateway-model', true),
      formatChatChunkForClient({ choices: [{ index: 0, delta: { content: 'llo' } }] } as never, 'gateway-model', true),
      formatChatChunkForClient(
        {
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        } as never,
        'gateway-model',
        true,
      ),
    ].filter((x): x is string => x !== null);
    const folded = foldFrames(frames);
    expect(folded.content).toBe('hello');
    expect(folded.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cached_tokens: undefined });
  });

  it('surfaces a protocol failure frame instead of an empty bubble', () => {
    active = 'anthropic-messages';
    expect(CHAT_PROTOCOL_BY_ID['anthropic-messages'].decodeFrame({ type: 'error', error: { message: 'boom' } })).toEqual({
      error: 'boom',
    });
    active = 'openai-responses';
    expect(
      CHAT_PROTOCOL_BY_ID['openai-responses'].decodeFrame({
        type: 'response.failed',
        response: { status: 'failed', error: { message: 'upstream died' } },
      }),
    ).toEqual({ error: 'upstream died' });
  });

  it('ignores frames that carry nothing the transcript renders', () => {
    for (const protocol of CHAT_PROTOCOLS) {
      expect(protocol.decodeFrame({ type: 'ping' })).toBeNull();
      expect(protocol.decodeFrame({})).toBeNull();
    }
  });
});

describe('mergeUsage', () => {
  it('completes a record split across two frames and recomputes the total', () => {
    const opened = mergeUsage(undefined, { prompt_tokens: 100, completion_tokens: 0, cached_tokens: 60 });
    expect(opened?.total_tokens).toBe(100);
    const closed = mergeUsage(opened, { completion_tokens: 20 });
    expect(closed).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 60 });
  });

  it('keeps the previous record when the frame reports nothing', () => {
    expect(mergeUsage({ prompt_tokens: 1 }, undefined)).toEqual({ prompt_tokens: 1 });
  });
});

describe('playground wire adapters — image attachments', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const bytes: WireImage = { kind: 'base64', mediaType: 'image/png', data: PNG };
  const remote: WireImage = { kind: 'url', url: 'https://example.test/a.png' };
  const params: WireParams = { model: 'auto', stream: false };

  /** Pull the image part out of a canonical request, whatever wire produced it. */
  const imagePartsOf = (ir: CanonicalRequest) =>
    ir.input.flatMap(item =>
      item.type === 'message'
        ? item.content.filter((p): p is Extract<ContentPart, { type: 'image' }> => p.type === 'image')
        : []
    );

  it('builds the part vocabulary each wire declares, not a shared one', () => {
    const message: WireMessage = { role: 'user', content: 'what is this', images: [bytes] };

    const chatBody = CHAT_PROTOCOL_BY_ID['openai-chat'].buildBody([message], '', params) as {
      messages: { content: Record<string, unknown>[] }[];
    };
    expect(chatBody.messages[0].content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
    ]);

    const anthropicBody = CHAT_PROTOCOL_BY_ID['anthropic-messages'].buildBody([message], '', params) as {
      messages: { content: Record<string, unknown>[] }[];
    };
    expect(anthropicBody.messages[0].content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ]);

    const responsesBody = CHAT_PROTOCOL_BY_ID['openai-responses'].buildBody([message], '', params) as {
      input: { content: Record<string, unknown>[] }[];
    };
    expect(responsesBody.input[0].content).toEqual([
      { type: 'input_text', text: 'what is this' },
      { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
    ]);
  });

  it('keeps a plain string when the turn carries no image', () => {
    const message: WireMessage = { role: 'user', content: 'hello' };
    const chatBody = CHAT_PROTOCOL_BY_ID['openai-chat'].buildBody([message], '', params) as {
      messages: { content: unknown }[];
    };
    expect(chatBody.messages[0].content).toBe('hello');
    const responsesBody = CHAT_PROTOCOL_BY_ID['openai-responses'].buildBody([message], '', params) as {
      input: { content: unknown }[];
    };
    expect(responsesBody.input[0].content).toBe('hello');
  });

  it('omits the text part on an image-only turn', () => {
    const message: WireMessage = { role: 'user', content: '', images: [bytes] };
    const chatBody = CHAT_PROTOCOL_BY_ID['openai-chat'].buildBody([message], '', params) as {
      messages: { content: Record<string, unknown>[] }[];
    };
    expect(chatBody.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
    ]);
  });

  it('spells a remote image as a URL source where the wire distinguishes them', () => {
    const message: WireMessage = { role: 'user', content: '', images: [remote] };
    const anthropicBody = CHAT_PROTOCOL_BY_ID['anthropic-messages'].buildBody([message], '', params) as {
      messages: { content: Record<string, unknown>[] }[];
    };
    expect(anthropicBody.messages[0].content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
    ]);
  });

  // The real contract: the gateway's OWN inbound parser must accept what the
  // page emits. A body-shape assertion alone would pass even if the two drifted.
  it('is parsed back by the gateway into one canonical image part per wire', () => {
    const message: WireMessage = { role: 'user', content: 'what is this', images: [bytes] };

    const fromChat = imagePartsOf(
      chatRequestToIR(CHAT_PROTOCOL_BY_ID['openai-chat'].buildBody([message], '', params) as never)
    );
    expect(fromChat).toHaveLength(1);
    expect(fromChat[0].source).toEqual({ kind: 'base64', mediaType: 'image/png', data: PNG });

    const fromAnthropic = imagePartsOf(
      anthropicRequestToIR(CHAT_PROTOCOL_BY_ID['anthropic-messages'].buildBody([message], '', params) as never)
    );
    expect(fromAnthropic[0].source).toEqual({ kind: 'base64', mediaType: 'image/png', data: PNG });

    const fromResponses = imagePartsOf(
      responsesRequestToIR(CHAT_PROTOCOL_BY_ID['openai-responses'].buildBody([message], '', params) as never)
    );
    expect(fromResponses[0].source).toEqual({ kind: 'base64', mediaType: 'image/png', data: PNG });
  });

  it('surfaces the capability gate for every implemented image source', () => {
    const message: WireMessage = { role: 'user', content: '', images: [bytes] };
    const ir = chatRequestToIR(CHAT_PROTOCOL_BY_ID['openai-chat'].buildBody([message], '', params) as never);
    expect(() => assertCanonicalRequestSupported(ir, 'openai-chat')).not.toThrow();
    expect(() => assertCanonicalRequestSupported(ir, 'anthropic-messages')).not.toThrow();
    expect(() => assertCanonicalRequestSupported(ir, 'openai-responses')).not.toThrow();
  });

  it('elides bytes from a displayed or persisted body but keeps the receipt', () => {
    expect(imageBytes(bytes)).toBe(Math.floor((PNG.length * 3) / 4));
    expect(imageBytes({ kind: 'base64', mediaType: 'image/png', data: '', bytes: 2048 })).toBe(2048);
    expect(formatBytes(2048)).toBe('2 KB');
    expect(imageBytes(remote)).toBe(0);

    const elided = elideDataUrls({ messages: [{ content: `data:image/png;base64,${PNG}` }] }) as {
      messages: { content: string }[];
    };
    expect(elided.messages[0].content.startsWith('data:image/png;base64,… (')).toBe(true);
    expect(elided.messages[0].content).not.toContain(PNG);

    const stored = elideImagePayloads([bytes, remote]);
    expect(stored[0]).toEqual({ kind: 'base64', mediaType: 'image/png', data: '', bytes: imageBytes(bytes) });
    expect(stored[1]).toEqual(remote);
  });
});

describe('playground wire adapters — tool calls', () => {
  const TOOLS = [
    {
      name: 'read',
      description: 'read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ];
  const params = { ...PARAMS, tools: TOOLS, toolChoice: 'auto' as const, parallelTools: true };

  /** The three turns of one tool round-trip, in canonical form. */
  const ROUND: WireMessage[] = [
    { role: 'user', content: 'read src/index.ts' },
    {
      role: 'assistant',
      content: 'ok',
      toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"src/index.ts"}' }],
    },
    { role: 'user', content: '', toolResults: [{ id: 'call_1', name: 'read', content: '1\timport x' }] },
  ];

  it('spells one tool definition three different ways', () => {
    const chat = CHAT_PROTOCOL_BY_ID['openai-chat'].buildBody(MESSAGES, '', params);
    expect(chat.tools).toEqual([
      {
        type: 'function',
        function: { name: 'read', description: 'read a file', parameters: TOOLS[0]!.parameters },
      },
    ]);
    expect(chat.tool_choice).toBe('auto');
    expect(chat.parallel_tool_calls).toBe(true);

    const anthropic = CHAT_PROTOCOL_BY_ID['anthropic-messages'].buildBody(MESSAGES, '', params);
    // `input_schema`, NOT `parameters`, and no `type: 'function'` wrapper.
    expect(anthropic.tools).toEqual([
      { name: 'read', description: 'read a file', input_schema: TOOLS[0]!.parameters },
    ]);
    expect(anthropic.tool_choice).toEqual({ type: 'auto' });
    // Anthropic expresses parallelism INSIDE the choice object.
    expect(anthropic.parallel_tool_calls).toBeUndefined();

    const responses = CHAT_PROTOCOL_BY_ID['openai-responses'].buildBody(MESSAGES, '', params);
    expect(responses.tools).toEqual([
      { type: 'function', name: 'read', description: 'read a file', parameters: TOOLS[0]!.parameters },
    ]);
    expect(responses.tool_choice).toBe('auto');
    expect(responses.parallel_tool_calls).toBe(true);
  });

  it('maps tool_choice and parallel_tool_calls onto each wire spelling', () => {
    const off = { ...params, parallelTools: false };
    expect(CHAT_PROTOCOL_BY_ID['openai-chat'].buildBody(MESSAGES, '', off).parallel_tool_calls).toBe(false);
    // Anthropic has no parallel flag: it rides INSIDE the choice object.
    expect(CHAT_PROTOCOL_BY_ID['anthropic-messages'].buildBody(MESSAGES, '', off).tool_choice).toEqual({
      type: 'auto',
      disable_parallel_tool_use: true,
    });
    expect(CHAT_PROTOCOL_BY_ID['openai-responses'].buildBody(MESSAGES, '', off).parallel_tool_calls).toBe(false);

    // `required` is a chat/responses string and an anthropic `{type: 'any'}`.
    const required = { ...params, toolChoice: 'required' as const };
    expect(CHAT_PROTOCOL_BY_ID['openai-chat'].buildBody(MESSAGES, '', required).tool_choice).toBe('required');
    expect(CHAT_PROTOCOL_BY_ID['anthropic-messages'].buildBody(MESSAGES, '', required).tool_choice).toEqual({ type: 'any' });
    expect(CHAT_PROTOCOL_BY_ID['openai-responses'].buildBody(MESSAGES, '', required).tool_choice).toBe('required');

    const none = { ...params, toolChoice: 'none' as const };
    expect(CHAT_PROTOCOL_BY_ID['anthropic-messages'].buildBody(MESSAGES, '', none).tool_choice).toEqual({ type: 'none' });
  });

  it('omits the whole tool axis when no tool is checked', () => {
    for (const protocol of CHAT_PROTOCOLS) {
      const body = protocol.buildBody(MESSAGES, '', { model: 'auto', stream: true });
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.parallel_tool_calls).toBeUndefined();
    }
  });

  it('echoes the call and the result in each wire vocabulary', () => {
    const chat = CHAT_PROTOCOL_BY_ID['openai-chat'].buildBody(ROUND, '', PARAMS) as {
      messages: Record<string, unknown>[];
    };
    // OpenAI-compatible: `tool_calls` on the assistant message, one `tool`
    // message per result, and `content: null` beside the calls.
    expect(chat.messages[1]).toEqual({
      role: 'assistant',
      content: 'ok',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"src/index.ts"}' } },
      ],
    });
    expect(chat.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '1\timport x' });

    const anthropic = CHAT_PROTOCOL_BY_ID['anthropic-messages'].buildBody(ROUND, '', PARAMS) as {
      messages: Record<string, unknown>[];
    };
    // Content blocks, `input` as an OBJECT (a JSON string is rejected), and the
    // result as a `tool_result` block inside a user turn.
    expect(anthropic.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'src/index.ts' } },
      ],
    });
    expect(anthropic.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '1\timport x' }],
    });

    const responses = CHAT_PROTOCOL_BY_ID['openai-responses'].buildBody(ROUND, '', PARAMS) as {
      input: Record<string, unknown>[];
    };
    // A FLAT item list: the call and the output are items, not message fields.
    expect(responses.input).toEqual([
      { type: 'message', role: 'user', content: 'read src/index.ts' },
      { type: 'message', role: 'assistant', content: 'ok' },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"src/index.ts"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '1\timport x' },
    ]);
  });

  // The real contract: the gateway's OWN inbound parser must undo exactly what
  // the page emitted, on every wire. A body-shape assertion alone would pass
  // even if the two had drifted.
  it('is parsed back by the gateway into one tool_call and one tool_result per wire', () => {
    const kindsOf = (ir: CanonicalRequest) =>
      ir.input.flatMap((item) =>
        item.type === 'tool_call'
          ? [{ kind: 'call', id: item.id, callId: item.callId, name: item.name, arguments: item.arguments }]
          : item.type === 'tool_result'
            ? [{ kind: 'result', callId: item.callId }]
            : []
      );

    const fromChat = kindsOf(chatRequestToIR(CHAT_PROTOCOL_BY_ID['openai-chat'].buildBody(ROUND, '', PARAMS) as never));
    expect(fromChat).toEqual([
      { kind: 'call', id: 'call_1', callId: 'call_1', name: 'read', arguments: '{"path":"src/index.ts"}' },
      { kind: 'result', callId: 'call_1' },
    ]);

    const fromAnthropic = kindsOf(
      anthropicRequestToIR(CHAT_PROTOCOL_BY_ID['anthropic-messages'].buildBody(ROUND, '', PARAMS) as never)
    );
    expect(fromAnthropic.map((x) => x.kind)).toEqual(['call', 'result']);
    expect(fromAnthropic[0]).toMatchObject({ name: 'read', arguments: '{"path":"src/index.ts"}' });
    expect(fromAnthropic[1]).toEqual({ kind: 'result', callId: 'call_1' });

    const fromResponses = kindsOf(
      responsesRequestToIR(CHAT_PROTOCOL_BY_ID['openai-responses'].buildBody(ROUND, '', PARAMS) as never)
    );
    expect(fromResponses.map((x) => x.kind)).toEqual(['call', 'result']);
    expect(fromResponses[1]).toEqual({ kind: 'result', callId: 'call_1' });
  });

  it('assembles streamed arguments from each wire fragment container', () => {
    // chat: `delta.tool_calls[].function.arguments` fragments, id+name only on
    // the first one. The chunk goes through the real chat-sse formatter so the
    // container under test is the one the gateway emits.
    const chatStream = CHAT_PROTOCOL_BY_ID['openai-chat'].createToolStream();
    for (const chunk of [
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"pa' } }] } },
        ],
      },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"src/a.ts"}' } }] } }] },
    ]) {
      const frame = formatChatChunkForClient(chunk as never, 'gateway-model', true);
      chatStream.push(JSON.parse(frame.replace(/^data: /, '').trim()) as Record<string, unknown>);
    }
    expect(chatStream.calls()).toEqual([{ id: 'call_1', name: 'read', arguments: '{"path":"src/a.ts"}' }]);

    // anthropic: `content_block_start` opens the call, `input_json_delta`
    // carries the fragments.
    const anthropicStream = CHAT_PROTOCOL_BY_ID['anthropic-messages'].createToolStream();
    for (const payload of [
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} },
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pa' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'th":"src/a.ts"}' } },
      { type: 'content_block_stop', index: 1 },
    ]) {
      anthropicStream.push(payload);
    }
    expect(anthropicStream.calls()).toEqual([{ id: 'toolu_1', name: 'read', arguments: '{"path":"src/a.ts"}' }]);

    // responses: `output_item.added` registers, `function_call_arguments.delta`
    // appends (keyed by item id, not by index).
    const responsesStream = CHAT_PROTOCOL_BY_ID['openai-responses'].createToolStream();
    for (const payload of [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"pa' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: 'th":"src/a.ts"}' },
    ]) {
      responsesStream.push(payload);
    }
    expect(responsesStream.calls()).toEqual([{ id: 'call_1', name: 'read', arguments: '{"path":"src/a.ts"}' }]);
  });

  it('decodes a buffered answer that carries calls', () => {
    const chat = CHAT_PROTOCOL_BY_ID['openai-chat'].decodeJson({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }],
          },
        },
      ],
    });
    expect(chat.toolCalls).toEqual([{ id: 'call_1', name: 'read', arguments: '{"path":"a"}' }]);

    const anthropic = CHAT_PROTOCOL_BY_ID['anthropic-messages'].decodeJson({
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a' } }],
    });
    // The wire carries `input` as an object; the console needs the STRING form
    // so ONE call shape flows through the whole loop.
    expect(anthropic.toolCalls).toEqual([{ id: 'toolu_1', name: 'read', arguments: '{"path":"a"}' }]);

    const responses = CHAT_PROTOCOL_BY_ID['openai-responses'].decodeJson({
      output: [{ type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' }],
    });
    expect(responses.toolCalls).toEqual([{ id: 'call_1', name: 'read', arguments: '{"path":"a"}' }]);
  });

  it('keeps a truncated argument payload verbatim and reports it as a tool error', () => {
    const frame = formatChatChunkForClient(
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'edit', arguments: '{"old' } }] } },
        ],
      } as never,
      'gateway-model',
      true
    );
    const stream = CHAT_PROTOCOL_BY_ID['openai-chat'].createToolStream();
    stream.push(JSON.parse(frame.replace(/^data: /, '').trim()) as Record<string, unknown>);
    // A truncated payload is a real outcome: the transcript shows it and the
    // executor reports it, rather than losing the call.
    expect(stream.calls()).toEqual([{ id: 'c', name: 'edit', arguments: '{"old' }]);
    expect(runPlaygroundTool('edit', '{"old')).toContain('arguments are not valid JSON');
  });

  it('captures responses tool arguments delivered only in response.function_call_arguments.done', () => {
    const stream = CHAT_PROTOCOL_BY_ID['openai-responses'].createToolStream();
    stream.push({
      type: 'response.output_item.added',
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '' },
    });
    stream.push({
      type: 'response.function_call_arguments.done',
      item_id: 'fc_1',
      arguments: '{"path":"README.md"}',
    });
    expect(stream.calls()).toEqual([
      { id: 'call_1', name: 'read', arguments: '{"path":"README.md"}' },
    ]);
  });
});

describe('playground tool sandbox', () => {
  it('reads with line numbers and honours offset/limit', () => {
    resetSandbox();
    expect(runPlaygroundTool('read', '{"path":"src/util.ts"}')).toBe(
      '1	export const add = (a: number, b: number): number => a + b;'
    );
    expect(runPlaygroundTool('read', '{"path":"data/report.csv","offset":2,"limit":1}')).toBe(
      '2\tqwen3.8-flash,1200,340'
    );
  });

  it('keeps every path inside the virtual tree', () => {
    resetSandbox();
    // A model that tries to walk out gets an error string, never a host path.
    expect(runPlaygroundTool('read', '{"path":"../../etc/passwd"}')).toBe(
      'error: path must be a relative path inside the sandbox'
    );
    expect(runPlaygroundTool('ls', '{"path":".."}')).toBe('error: path must be a relative path inside the sandbox');
  });

  it('refuses an ambiguous edit and applies a unique one', () => {
    resetSandbox();
    // `number` appears twice in util.ts: the anchor must be widened.
    expect(runPlaygroundTool('edit', '{"path":"src/util.ts","oldText":"number","newText":"n"}')).toBe(
      'error: oldText appears more than once in src/util.ts; include more context'
    );
    expect(runPlaygroundTool('edit', '{"path":"src/util.ts","oldText":"a + b","newText":"a + b + 0"}')).toBe(
      'edited src/util.ts'
    );
    expect(runPlaygroundTool('read', '{"path":"src/util.ts"}')).toContain('a + b + 0');
  });

  it('writes, greps and removes through the same tree', () => {
    resetSandbox();
    expect(runPlaygroundTool('write', '{"path":"tmp/a.txt","content":"hello\\nworld"}')).toBe(
      'created tmp/a.txt (11 bytes)'
    );
    expect(runPlaygroundTool('grep', '{"pattern":"^world$","path":"tmp"}')).toBe('tmp/a.txt:2: world');
    expect(runPlaygroundTool('ls', '{}')).toContain('tmp/');
    expect(runPlaygroundTool('rm', '{"path":"tmp/a.txt"}')).toBe('removed tmp/a.txt');
    expect(runPlaygroundTool('rm', '{"path":"tmp/a.txt"}')).toBe('error: no such file: tmp/a.txt');
  });

  it('reports an unknown tool and a bad regex instead of throwing', () => {
    expect(runPlaygroundTool('bash', '{"cmd":"ls"}')).toContain('error: unknown tool: bash');
    expect(runPlaygroundTool('grep', '{"pattern":"("}')).toContain('error: invalid regular expression');
  });
});


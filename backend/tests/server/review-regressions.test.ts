/**
 * Self-proof regressions from the uncommitted IR review.
 *
 * Each assertion documents the CORRECT contract. A red run proves the defect
 * exists; a green run after the fix proves it is closed. Do not weaken these
 * to match broken behavior.
 */
import { describe, expect, it } from 'bun:test';
import {
  AnthropicMessagesEventEncoder,
  anthropicRequestToIR,
  canonicalToAnthropicPayload,
} from '../../src/ir/adapters/anthropic-messages.js';
import { AnthropicMessagesStreamDecoder } from '../../src/ir/adapters/anthropic-messages-stream.js';
import { canonicalToGooglePayload, googleResponseToIR } from '../../src/ir/adapters/google-gemini.js';
import { canonicalToResponsesPayload, responsesRequestToIR } from '../../src/ir/adapters/openai-responses.js';
import { OpenAIResponsesStreamDecoder } from '../../src/ir/adapters/openai-responses-stream.js';
import { chatRequestToIR, irToChatRequest } from '../../src/ir/adapters/openai-chat.js';
import { canonicalResponseToEvents } from '../../src/ir/stream.js';
import { capabilitiesFor } from '../../src/ir/capabilities.js';
import { assertCanonicalRequestSupported } from '../../src/ir/validate.js';
import { ChatEventEncoder, ChatStreamDecoder } from '../../src/ir/adapters/openai-chat-stream.js';
import { assertAllowedUpstream } from '../../src/utils/upstream-url-guard.js';
import { postProviderStream } from '../../src/providers/executors/http-stream.js';
import { countToolMarkupLeak } from '../../src/providers/compat/tool-markup-leak.js';
import { createToolMarkupStreamRecovery, recoverToolMarkupText } from '../../src/providers/compat/tool-markup-recovery.js';
import { repairToolCallPairing } from '../../src/pipeline/tool-pairing.js';
import { canonicalProtocol } from '../../src/providers/protocol.js';
import { SessionManager } from '../../src/session/session-manager.js';
import type { CanonicalRequest, CanonicalResponse } from '../../src/ir/types.js';
import {
  OpenAIResponsesEventEncoder,
  defaultResponsesEcho,
  newResponseStreamSequence,
} from '../../src/ir/adapters/openai-responses-output.js';
import { anthropicSurface } from '../../src/surfaces/anthropic.js';
import { chatSurface } from '../../src/surfaces/chat.js';
import { responsesSurface } from '../../src/surfaces/responses.js';
import type { ExecutionResult } from '../../src/surfaces/types.js';
import { normalizeProviderDef } from '../../src/opencode/user-config.js';
import { readProviderDefsFile } from '../../src/opencode/provider-defs.js';
import { pullLiveModels, autoPullProviderModels } from '../../src/opencode/catalog/auto-pull.js';
import { buildDirectPool } from '../../src/providers/boot-direct.js';
import { loadConfig } from '../../src/config/index.js';
import { runSystemoneDecision } from '../../src/protocols/systemone/decide.js';
import { PipelineOrchestrator } from '../../src/pipeline/orchestrator.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { FinOpsTracker } from '../../src/metrics/finops-tracker.js';
import { UpstreamError } from '../../src/resilience/error-classifier.js';
import { scanDirectives } from '../../src/pipeline/directives.js';
import { SchemaAssertion } from '../../src/validator/schema-assertion.js';
import { buildChatOcrCompletionFacts } from '../../src/surfaces/ocr-headers.js';
import { V1ToV2Migrate } from '../../src/capture/migrate/steps/v1-to-v2.js';
import { createServer } from '../../src/server.js';
import { clientRenderableDefs } from '../../src/opencode/credentials/def-materialize.js';
import { currentPackageFor } from '../../src/opencode/provider-package.js';
import { probeProvider } from '../../src/opencode/probe.js';
import { claimPluginWires } from '../../src/providers/plugin-wires.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHAT_PROTOCOL_BY_ID,
  hasUnansweredToolCalls,
  wireHistoryFromTurns,
  type WireImage,
  type WireMessage,
  type WireParams,
} from '../../../frontend/src/lib/playground-protocols.ts';

function chatTextLiveEvents(): ReturnType<ChatStreamDecoder['push']> {
  const decoder = new ChatStreamDecoder();
  const events = [
    ...decoder.push({
      id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'upstream-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }],
    } as never),
    ...decoder.push({
      id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'upstream-model',
      choices: [],
      usage: {
        prompt_tokens: 120, completion_tokens: 2, total_tokens: 122,
        prompt_tokens_details: { cached_tokens: 100 },
      },
    } as never),
    ...decoder.finish(),
  ];
  return events;
}

function encodeAnthropicLive(events: ReturnType<typeof chatTextLiveEvents>) {
  const encoder = new AnthropicMessagesEventEncoder();
  return events.flatMap((event) => encoder.encode(event, 'served-model'));
}

const completedText: CanonicalResponse = {
  id: 'resp_1',
  model: 'served-model',
  status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
  usage: { inputTokens: 20, outputTokens: 2, cachedInputTokens: 100 },
};

function execution(response: CanonicalResponse = completedText): ExecutionResult {
  return { response, modelUsed: 'served-model', latencyMs: 0, fallbackOccurred: false };
}

const baseRequest = (): CanonicalRequest => ({
  model: 'upstream-model',
  input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
});

describe('review proof: Chat upstream → Anthropic live SSE', () => {
  it('emits content_block_stop for text opened via content_part.added', () => {
    const wire = encodeAnthropicLive(chatTextLiveEvents());
    const types = wire.map((frame) => frame.type);
    expect(types).toContain('content_block_start');
    expect(types).toContain('content_block_stop');
    expect(types.indexOf('content_block_stop')).toBeLessThan(types.indexOf('message_stop'));
  });

  it('streams content immediately without waiting for trailing usage, and reports cache_read_input_tokens on message_delta', () => {
    const encoder = new AnthropicMessagesEventEncoder();
    const events = chatTextLiveEvents();
    const firstChunk = events.slice(0, 3).flatMap((ev) => encoder.encode(ev, 'served-model'));
    expect(firstChunk.map((f) => f.type)).toEqual(['message_start', 'content_block_start']);

    const rest = events.slice(3).flatMap((ev) => encoder.encode(ev, 'served-model'));
    const delta = [...firstChunk, ...rest].find((frame) => frame.type === 'message_delta');
    expect(delta).toBeTruthy();
    expect(delta!.usage).toMatchObject({
      input_tokens: 20,
      cache_read_input_tokens: 100,
    });
  });
});

describe('review proof: playground Anthropic image attachments', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const params: WireParams = { model: 'auto', stream: false };

  it('does not emit Anthropic url source for a pasted data: image URL', () => {
    // Reproduces PlaygroundPage.addImageUrl accepting data: and storing kind:'url'.
    const pasted: WireImage = { kind: 'url', url: `data:image/png;base64,${PNG}` };
    const message: WireMessage = { role: 'user', content: 'what is this', images: [pasted] };
    const body = CHAT_PROTOCOL_BY_ID['anthropic-messages'].buildBody([message], '', params) as {
      messages: { content: { type: string; source?: { type: string; url?: string; media_type?: string; data?: string } }[] }[];
    };
    const image = body.messages[0].content.find((part) => part.type === 'image');
    expect(image?.source).toEqual({ type: 'base64', media_type: 'image/png', data: PNG });
  });
});

describe('review proof: capability / effort honesty', () => {
  it('allows generation.topK on google-gemini (adapter already renders it)', () => {
    const ir: CanonicalRequest = { ...baseRequest(), generation: { topK: 8 } };
    expect(() => assertCanonicalRequestSupported(ir, 'google-gemini')).not.toThrow();
    const payload = canonicalToGooglePayload(ir, {
      id: 'm1', upstreamModel: 'upstream-model',
    } as never) as { generationConfig?: { topK?: number } };
    expect(payload.generationConfig?.topK).toBe(8);
  });

  it('does not emit Responses reasoning.effort values the inbound parser rejects', () => {
    const ir: CanonicalRequest = { ...baseRequest(), reasoning: { effort: 'max' } };
    const payload = canonicalToResponsesPayload(ir, {
      id: 'm1', upstreamModel: 'upstream-model',
    } as never) as { reasoning?: { effort?: string } };
    const effort = payload.reasoning?.effort;
    expect(effort).toBeDefined();
    expect(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).toContain(effort);
  });
});

describe('review proof: buffered SSE ocr-summary parity', () => {
  it('Anthropic encodeStream includes the trailing ocr-summary chat already embeds', () => {
    const chat = chatSurface.encodeStream(execution()).join('');
    const anthropic = anthropicSurface.encodeStream(execution()).join('');
    expect(chat).toContain('ocr-summary');
    expect(anthropic).toContain('ocr-summary');
  });

  it('Responses encodeStream includes the trailing ocr-summary', () => {
    const state = {
      encoder: new OpenAIResponsesEventEncoder(
        'resp_proof', 'msg_proof', newResponseStreamSequence(), false, defaultResponsesEcho(),
      ),
    };
    const frames = responsesSurface.encodeStream(execution(), state).join('');
    expect(frames).toContain('ocr-summary');
  });
});

describe('review proof: protocol id vocabulary', () => {
  it('retired short id anthropic is NOT anthropic-messages capabilities', () => {
    // Trap documented by playground-protocols.test.ts using assertCanonicalRequestSupported(ir, 'anthropic'):
    // the short id falls through to plugin/chat caps, so Anthropic-only knobs are invisible there.
    const short = capabilitiesFor('anthropic');
    const real = capabilitiesFor('anthropic-messages');
    expect(short.generation.topK).toBeUndefined();
    expect(real.generation.topK).toBe(true);
    expect(short.reasoningSignature).toBe(false);
    expect(real.reasoningSignature).toBe(true);
  });
});

describe('review proof: playground unanswered tool calls', () => {
  const call = { id: 'call_1', name: 'ls', arguments: '{}' };
  const params: WireParams = { model: 'auto', stream: false };

  it('detects the latest assistant turn when tools never ran', () => {
    expect(hasUnansweredToolCalls([
      { role: 'user', content: 'list' },
      { role: 'assistant', content: '', toolCalls: [call] },
    ])).toBe(true);
    expect(hasUnansweredToolCalls([
      { role: 'user', content: 'list' },
      { role: 'assistant', content: '', toolCalls: [call], toolResults: [{ id: 'call_1', name: 'ls', content: '[]' }] },
    ])).toBe(false);
  });

  it('drops orphan tool_use from Anthropic history so the next user turn is valid', () => {
    const history = wireHistoryFromTurns(
      [
        { role: 'user', content: 'list' },
        { role: 'assistant', content: 'calling ls', toolCalls: [call] },
      ],
      { role: 'user', content: 'actually never mind' },
    );
    expect(history).toEqual([
      { role: 'user', content: 'list' },
      { role: 'assistant', content: 'calling ls' },
      { role: 'user', content: 'actually never mind' },
    ]);
    const body = CHAT_PROTOCOL_BY_ID['anthropic-messages'].buildBody(history, '', params) as {
      messages: { role: string; content: unknown }[];
    };
    const assistant = body.messages[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBe('calling ls');
  });
});

describe('review proof: Anthropic streamEnd synthesizes message_stop', () => {
  it('closes the wire when encodeChunk never saw response.completed', () => {
    const parsed = anthropicSurface.parse({
      model: 'auto', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }],
    });
    expect('state' in parsed && parsed.state).toBeTruthy();
    const state = (parsed as { state: { encoder: AnthropicMessagesEventEncoder } }).state;
    // Usage + text only — no terminal IR event (decoder/finish gap).
    state.encoder.encode(
      { type: 'response.usage', usage: { inputTokens: 5, outputTokens: 1 } },
      'served-model',
    );
    state.encoder.encode({
      type: 'response.content_part.added', index: 0, partIndex: 0, part: { type: 'text', text: '' },
    }, 'served-model');
    state.encoder.encode({
      type: 'response.output_text.delta', index: 0, partIndex: 0, text: 'hi',
    }, 'served-model');

    const frames = anthropicSurface.streamEnd!(execution(completedText), state).join('');
    expect(frames).toContain('event: message_stop');
    expect(frames).toContain('ocr-summary');
    const stopAt = frames.indexOf('event: message_stop');
    const summaryAt = frames.indexOf(': ocr-summary');
    expect(summaryAt).toBeGreaterThan(stopAt);
  });
});

describe('review proof: round-2 security, protocol, streaming and session regressions', () => {
  it('OpenAIResponsesStreamDecoder accepts underscore function_call_arguments and reasoning_summary_part.done', () => {
    const dec = new OpenAIResponsesStreamDecoder();
    const evs = dec.push({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"a":1}' });
    expect(evs).toEqual([{ type: 'response.function_call.arguments.delta', index: 0, argumentsDelta: '{"a":1}' }]);
    expect(dec.push({ type: 'response.reasoning_summary_part.done', output_index: 0, summary_index: 0 })).toEqual([]);
  });

  it('irToChatRequest strips Anthropic systemCache when carrierExtensions is false', () => {
    const ir = anthropicRequestToIR({
      model: 'claude-sonnet-4-5',
      max_tokens: 16,
      system: [{ type: 'text', text: 'System', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(() => irToChatRequest(ir, 'gpt-4o', { carrierExtensions: false })).not.toThrow();
  });

  it('upstream-url-guard allows fe* public domains and blocks IPv4-mapped metadata, trailing dot, and 127.0.0.2 self-loop', () => {
    expect(() => assertAllowedUpstream('https://featherless.ai/v1', 4555)).not.toThrow();
    expect(() => assertAllowedUpstream('https://feature.ai/v1', 4555)).not.toThrow();
    expect(() => assertAllowedUpstream('https://[::ffff:169.254.169.254]/latest/meta-data/', 4555)).toThrow();
    expect(() => assertAllowedUpstream('https://metadata.google.internal./computeMetadata/v1/', 4555)).toThrow();
    expect(() => assertAllowedUpstream('http://127.0.0.2:4555/v1', 4555)).toThrow();
  });

  it('tool-markup regexes stay linear on repeated spaces and streaming keeps malformed wrappers indivisible', () => {
    const spaces = '<' + ' '.repeat(800) + 'x';
    const t0 = performance.now();
    expect(countToolMarkupLeak(spaces)).toBe(0);
    const req: CanonicalRequest = {
      model: 'deepseek-v4',
      input: [],
      tools: [{ type: 'function', function: { name: 'ls', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    };
    expect(recoverToolMarkupText(spaces, req).calls).toHaveLength(0);
    expect(performance.now() - t0).toBeLessThan(50);

    const malformed = '<｜tool_calls｜><｜invoke name="ls"><｜parameter name="path">src</｜parameter></｜invoke><｜invoke name="unknown"></｜invoke></｜tool_calls｜>';
    const srec = createToolMarkupStreamRecovery(req);
    const streamEvs = [
      ...srec.push({ type: 'response.output_text.delta', index: 0, partIndex: 0, text: malformed }),
      ...srec.finish(),
    ];
    expect(streamEvs.filter((e) => e.type === 'response.output_item.done' && e.item.type === 'tool_call')).toHaveLength(0);
  });

  it('Anthropic thinking signature does not duplicate and message_delta preserves cached token counts', () => {
    const resp: CanonicalResponse = {
      id: 'msg_sig',
      model: 'claude-sonnet-4-5',
      status: 'completed',
      output: [
        { type: 'reasoning', text: 'hmm', signature: 'sig_abc' },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      ],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
    const enc = new AnthropicMessagesEventEncoder();
    const frames = canonicalResponseToEvents(resp).flatMap((ev) => enc.encode(ev, resp.model, resp));
    const dec = new AnthropicMessagesStreamDecoder();
    const decoded = frames.flatMap((f) => dec.push(f));
    const done = decoded.find((e) => e.type === 'response.output_item.done' && e.item.type === 'reasoning');
    expect(done?.type === 'response.output_item.done' && done.item.type === 'reasoning' ? done.item.signature : '').toBe('sig_abc');

    const dec2 = new AnthropicMessagesStreamDecoder();
    dec2.push({
      type: 'message_start',
      message: {
        id: 'm1',
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 100,
          cache_creation: { ephemeral_5m_input_tokens: 100 },
          output_tokens: 1,
        },
      },
    });
    const evs = dec2.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 42 } });
    const usageEv = evs.find((e) => e.type === 'response.usage');
    expect(usageEv?.type === 'response.usage' ? usageEv.usage.cachedInputTokens : -1).toBe(500);
    expect(usageEv?.type === 'response.usage' ? usageEv.usage.cacheWrite5mTokens : -1).toBe(100);
  });

  it('Chat refusal converts cleanly in buffered and streaming paths and Anthropic omits disable_parallel_tool_use on none', () => {
    const chat = irToChatRequest({
      model: 'gpt-4o',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'refusal', text: 'No.' }] },
      ],
    }, 'gpt-4o');
    expect(chat.messages[1]?.refusal).toBe('No.');

    const cdec = new ChatStreamDecoder();
    const evs = cdec.push({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o',
      choices: [{ index: 0, delta: { role: 'assistant', refusal: 'Nope' } as never, finish_reason: null }],
    });
    expect(evs.some((e) => e.type === 'response.refusal.delta')).toBe(true);
    const cenc = new ChatEventEncoder();
    const chunk = cenc.encode({ type: 'response.refusal.delta', index: 0, partIndex: 0, text: 'Nope' }, 'gpt-4o');
    expect((chunk?.choices[0]?.delta as { refusal?: string } | undefined)?.refusal).toBe('Nope');

    const anthPayload = canonicalToAnthropicPayload({
      model: 'claude-sonnet-4-5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      toolChoice: { type: 'none' },
      parallelToolCalls: false,
    }, { id: 'm', upstreamModel: 'claude-sonnet-4-5' } as never) as { tool_choice?: Record<string, unknown> };
    expect(anthPayload.tool_choice).toEqual({ type: 'none' });
  });

  it('Gemini preserves thoughtSignature on buffered response and replays it; tool-pairing flushes before reasoning', () => {
    const irResp = googleResponseToIR({
      candidates: [{
        content: { role: 'model', parts: [{ text: 'thought', thought: true, thoughtSignature: 'gem_sig' }, { text: 'ok' }] },
        finishReason: 'PROHIBITED_CONTENT',
      }],
    }, 'gemini-2.5-pro');
    const rItem = irResp.output.find((i) => i.type === 'reasoning');
    expect(rItem?.type === 'reasoning' ? rItem.signature : undefined).toBe('gem_sig');
    expect(irResp.reason).toBe('content_filter');
    expect(() => canonicalToGooglePayload({
      model: 'gemini-2.5-pro',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'q' }] },
        { type: 'reasoning', text: 'thought', signature: 'gem_sig' },
      ],
    }, { id: 'g', upstreamModel: 'gemini-2.5-pro' } as never)).not.toThrow();

    const paired = repairToolCallPairing([
      { type: 'tool_call', id: 'c1', callId: 'c1', name: 'f1', arguments: '{}' },
      { type: 'reasoning', text: 'next' },
      { type: 'tool_call', id: 'c2', callId: 'c2', name: 'f2', arguments: '{}' },
      { type: 'tool_result', callId: 'c2', content: [{ type: 'text', text: 'r2' }] },
    ]);
    expect(paired.input[1]).toMatchObject({ type: 'tool_result', callId: 'c1' });
  });

  it('canonicalProtocol normalizes case/whitespace safely and SessionManager anchors survive reasoning + sliding cache', () => {
    expect(canonicalProtocol(' OPENAI ')).toBe('openai-chat');
    expect(typeof canonicalProtocol('toString')).toBe('string');

    const sm = new SessionManager();
    const t1: CanonicalRequest = {
      model: 'claude-sonnet-4-5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }], cache: { type: 'ephemeral' } }],
    };
    const r1 = sm.resolveSessionId(t1);
    sm.registerCompletedTurn(r1.sessionId, SessionManager.serializeInput(t1.input), [
      { type: 'reasoning', text: 'hidden' },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
    ]);
    const r2 = sm.resolveSessionId(t1);
    sm.registerCompletedTurn(r2.sessionId, SessionManager.serializeInput(t1.input), [
      { type: 'reasoning', text: 'other' },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
    ]);
    const t2: CanonicalRequest = {
      model: 'claude-sonnet-4-5',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'next' }], cache: { type: 'ephemeral' } },
      ],
    };
    expect(sm.resolveSessionId(t2).sessionId).toBe(r1.sessionId);
  });
});

describe('review proof: round-3 self-proved defects', () => {
  it('createToolMarkupStreamRecovery emits output_item.added with empty arguments shell so delta does not double arguments', () => {
    const recovery = createToolMarkupStreamRecovery({
      model: 'mimo-v2-pro-free',
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'read a.ts' }] }],
      tools: [{
        type: 'function',
        function: {
          name: 'read',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      }],
    }, {
      providerId: 'opencode',
      modelId: 'opencode/mimo-v2-pro-free',
      upstreamModel: 'mimo-v2-pro-free',
    });
    expect(recovery).not.toBeNull();
    const events = [
      ...recovery!.push({ type: 'response.created', id: 'resp_1', model: 'mimo-v2-pro-free' }),
      ...recovery!.push({
        type: 'response.output_text.delta',
        index: 0,
        partIndex: 0,
        text: '<｜DSML｜function_calls><｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">a.ts</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>',
      }),
      ...recovery!.push({ type: 'response.completed' }),
    ];
    const added = events.find((e) => e.type === 'response.output_item.added' && e.item.type === 'tool_call');
    const delta = events.find((e) => e.type === 'response.function_call.arguments.delta');
    const done = events.find((e) => e.type === 'response.output_item.done' && e.item.type === 'tool_call');
    expect(added && added.type === 'response.output_item.added' && added.item.type === 'tool_call' ? added.item.arguments : null).toBe('');
    expect(delta && delta.type === 'response.function_call.arguments.delta' ? delta.argumentsDelta : null).toBe('{"path":"a.ts"}');
    expect(done && done.type === 'response.output_item.done' && done.item.type === 'tool_call' ? done.item.arguments : null).toBe('{"path":"a.ts"}');
  });

  it('repairToolCallPairing preserves real tool_result when reasoning is interleaved in the same assistant turn', () => {
    const interleaved = repairToolCallPairing([
      { type: 'tool_call', id: 'c1', callId: 'c1', name: 'f1', arguments: '{}' },
      { type: 'reasoning', text: 'thinking between tool calls' },
      { type: 'tool_result', callId: 'c1', content: [{ type: 'text', text: 'real_result' }] },
    ]);
    expect(interleaved.synthesized).toBe(0);
    expect(interleaved.duplicates).toBe(0);
    expect(interleaved.input).toHaveLength(3);
    expect(interleaved.input[2]).toMatchObject({
      type: 'tool_result',
      callId: 'c1',
      content: [{ type: 'text', text: 'real_result' }],
    });
  });

  it('canonicalToAnthropicPayload omits temperature, top_p, and top_k when thinking is enabled', () => {
    const payload = canonicalToAnthropicPayload({
      model: 'claude-sonnet-4-5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'solve' }] }],
      generation: { temperature: 0.7, topP: 0.9, topK: 40, maxOutputTokens: 4096 },
      reasoning: { effort: 'high' },
    }, { id: 'm', upstreamModel: 'claude-sonnet-4-5' } as never);
    expect(payload.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
    expect(payload.temperature).toBeUndefined();
    expect(payload.top_p).toBeUndefined();
    expect(payload.top_k).toBeUndefined();
  });

  it('normalizeProviderDef and readProviderDefsFile normalize legacy SDK packages on both package and npm fields', () => {
    const normalizedV2 = normalizeProviderDef({
      package: '@opencode/ai/providers/anthropic',
      settings: { baseURL: 'https://api.anthropic.com/v1' },
    });
    expect(normalizedV2.npm).toBe('anthropic-messages');
    expect(normalizedV2.package).toBe('anthropic-messages');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rev3-defs-'));
    try {
      const defsFile = path.join(tmp, 'providers.json');
      fs.writeFileSync(defsFile, JSON.stringify({
        version: 1,
        providers: {
          legacy: {
            npm: '@ai-sdk/google',
            package: '@opencode/ai/providers/google',
            models: {
              'gemini-2.5-pro': {
                provider: { npm: '@ai-sdk/google', package: '@opencode/ai/providers/google' },
              },
            },
          },
        },
      }));
      const read = readProviderDefsFile({ ocrHome: tmp } as never);
      expect(read?.providers.legacy.npm).toBe('google-gemini');
      expect(read?.providers.legacy.package).toBe('google-gemini');
      expect(read?.providers.legacy.models['gemini-2.5-pro'].provider.npm).toBe('google-gemini');
      expect(read?.providers.legacy.models['gemini-2.5-pro'].provider.package).toBe('google-gemini');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('buildDirectPool and auto-pull enforce upstream URL guard after env-template expansion and respect opt-in gate order', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rev3-pool-'));
    const prevOcrHome = process.env.OCR_HOME;
    const prevOcrEnv = process.env.OCR_ENV;
    const prevXdgConfig = process.env.XDG_CONFIG_HOME;
    const prevXdgData = process.env.XDG_DATA_HOME;
    const prevMetaUrl = process.env.REV3_METADATA_URL;
    const prevPublicHttp = process.env.REV3_PUBLIC_HTTP_URL;
    const prevUnexpanded = process.env.REV3_UNSET_ENV;
    try {
      process.env.OCR_HOME = tmp;
      delete process.env.OCR_ENV;
      process.env.XDG_CONFIG_HOME = tmp;
      process.env.XDG_DATA_HOME = tmp;
      process.env.REV3_METADATA_URL = 'http://169.254.169.254/latest/meta-data';
      process.env.REV3_PUBLIC_HTTP_URL = 'http://public-upstream.example.com/v1';
      delete process.env.REV3_UNSET_ENV;

      fs.writeFileSync(path.join(tmp, 'providers.json'), JSON.stringify({
        version: 1,
        providers: {
          'meta-ssrf': {
            package: 'openai-chat',
            settings: { baseURL: '{env:REV3_METADATA_URL}', apiKey: 'sk-test-123456' },
            models: { m1: { name: 'M1' } },
          },
          'cleartext-pub': {
            package: 'openai-chat',
            settings: { baseURL: '{env:REV3_PUBLIC_HTTP_URL}', apiKey: 'sk-test-123456' },
            models: { m1: { name: 'M1' } },
          },
          'opted-out-unset-env': {
            package: 'openai-chat',
            settings: { baseURL: '{env:REV3_UNSET_ENV}', apiKey: 'sk-test-123456' },
            models: { m1: { name: 'M1' } },
          },
        },
      }));

      const cfg = loadConfig();
      const prevCatalog = cfg.catalog;
      const prevPort = cfg.port;
      cfg.port = 14555;
      cfg.catalog = {
        ...cfg.catalog,
        autoPullModels: true,
        autoPullPatterns: {
          'meta-ssrf': '*',
        },
      };

      try {
        const boot = await buildDirectPool();
        expect(boot.instances.map((i) => i.name)).not.toContain('meta-ssrf');
        expect(boot.instances.map((i) => i.name)).not.toContain('cleartext-pub');
        expect(boot.excluded.find((e) => e.provider === 'meta-ssrf')?.reasonCode).toBe('metadata_target_refused');
        expect(boot.excluded.find((e) => e.provider === 'cleartext-pub')?.reasonCode).toBe('insecure_public_upstream');

        const liveRes = await pullLiveModels('meta-ssrf', { dryRun: true });
        expect(liveRes.httpStatus).toBe(400);
        expect(liveRes.body.reasonCode).toBe('metadata_target_refused');

        const sweep = await autoPullProviderModels();
        const optedOut = sweep.find((e) => e.providerId === 'opted-out-unset-env');
        expect(optedOut?.mode).toBe('skipped');
        expect(optedOut?.error).toBeUndefined();
        const optedInMeta = sweep.find((e) => e.providerId === 'meta-ssrf');
        expect(optedInMeta?.mode).toBe('skipped');
        expect(optedInMeta?.error).toMatch(/metadata/i);
      } finally {
        cfg.catalog = prevCatalog;
        cfg.port = prevPort;
      }
    } finally {
      if (prevOcrHome === undefined) delete process.env.OCR_HOME; else process.env.OCR_HOME = prevOcrHome;
      if (prevOcrEnv === undefined) delete process.env.OCR_ENV; else process.env.OCR_ENV = prevOcrEnv;
      if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdgConfig;
      if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevXdgData;
      if (prevMetaUrl === undefined) delete process.env.REV3_METADATA_URL; else process.env.REV3_METADATA_URL = prevMetaUrl;
      if (prevPublicHttp === undefined) delete process.env.REV3_PUBLIC_HTTP_URL; else process.env.REV3_PUBLIC_HTTP_URL = prevPublicHttp;
      if (prevUnexpanded === undefined) delete process.env.REV3_UNSET_ENV; else process.env.REV3_UNSET_ENV = prevUnexpanded;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('review proof: round-4 self-proved defects', () => {
  it('runSystemoneDecision succeeds on an anthropic-messages model without failing the json_object capability gate', async () => {
    const model = {
      id: 'anthropic/claude-haiku-4-5',
      provider: 'anthropic',
      upstreamModel: 'claude-haiku-4-5',
      wire: 'anthropic-messages' as const,
      tier: 'lite' as const,
      pricing: { inputPer1M: 1, outputPer1M: 5 },
    };
    const fakeRegistry = {
      execute: async (req: CanonicalRequest) => {
        // Real Anthropic adapter validation must accept the synthesized decision request.
        canonicalToAnthropicPayload(req, model as never);
        return {
          status: 'completed' as const,
          output: [{
            type: 'message' as const,
            role: 'assistant' as const,
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                answers: {
                  tier: { choice: 'plus', confidence: 0.9, probabilities: { lite: 0.1, plus: 0.9 } },
                },
              }),
            }],
          }],
          usage: { inputTokens: 20, outputTokens: 15 },
        };
      },
    };
    const decision = await runSystemoneDecision(
      fakeRegistry as never,
      {
        state: 'Refactor authentication middleware',
        questions: {
          tier: {
            type: 'choice',
            criteria: { lite: 'simple', plus: 'standard' },
          },
        },
      },
      model as never,
    );
    expect(decision.upstreamKind).toBe('converted');
    expect(decision.response.answers.tier).toMatchObject({ type: 'choice', choice: 'plus' });
  });

  it('playground wire adapters omit disable_parallel_tool_use on Anthropic toolChoice none and clamp Responses max effort to xhigh', () => {
    const messages: WireMessage[] = [{ role: 'user', content: 'hi' }];
    const tools = [{
      name: 'read',
      description: 'Read file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    }];
    const anthBody = CHAT_PROTOCOL_BY_ID['anthropic-messages'].buildBody(messages, '', {
      model: 'auto',
      stream: false,
      tools,
      toolChoice: 'none',
      parallelTools: false,
    });
    expect(anthBody.tool_choice).toEqual({ type: 'none' });

    const respBody = CHAT_PROTOCOL_BY_ID['openai-responses'].buildBody(messages, '', {
      model: 'auto',
      stream: false,
      effort: 'max',
    });
    expect(respBody.reasoning).toEqual({ effort: 'xhigh' });
    expect(() => responsesRequestToIR(respBody)).not.toThrow();
  });

  it('orchestrator translates reasoning.budgetTokens to reasoning.effort when failing over from anthropic-messages to openai-chat', async () => {
    const anthModel = {
      id: 'anth/claude-sonnet-4-5',
      provider: 'anth',
      upstreamModel: 'claude-sonnet-4-5',
      wire: 'anthropic-messages' as const,
      tier: 'plus' as const,
      supportsReasoningEffort: true,
      pricing: { inputPer1M: 3, outputPer1M: 15 },
    };
    const chatModel = {
      id: 'oai/o3-mini',
      provider: 'oai',
      upstreamModel: 'o3-mini',
      wire: 'openai-chat' as const,
      tier: 'plus' as const,
      supportsReasoningEffort: true,
      pricing: { inputPer1M: 1, outputPer1M: 4 },
    };
    const config = {
      port: 3000,
      host: '127.0.0.1',
      providers: {},
      models: [anthModel, chatModel],
      tiers: {
        lite: { members: [{ pattern: '*' }] },
        plus: { members: [{ pattern: '*' }] },
        pro: { members: [] },
        ultra: { members: [] },
      },
      fallback: { enabled: false, escalateTier: 'plus' as const },
      retry: {
        enabled: true,
        inplace: { enabled: false, maxAttempts: 0, backoffMs: 1, jitterMs: 0 },
        failover: { enabled: true, maxAttempts: 2, tierCrossPolicy: 'same_tier_only' as const },
      },
    };
    const registry = new ProviderRegistry({ providers: {}, models: [anthModel, chatModel], tiers: config.tiers } as never);
    let chatSeenEffort: string | undefined;
    (registry as any).providers.set('anth', {
      name: 'anth',
      createCompletion: async () => {
        throw new UpstreamError({ message: 'overloaded', status: 503, provider: 'anth', modelId: anthModel.id });
      },
    });
    (registry as any).providers.set('oai', {
      name: 'oai',
      createCompletion: async (req: CanonicalRequest) => {
        chatSeenEffort = req.reasoning?.effort;
        return {
          status: 'completed' as const,
          output: [{ type: 'message' as const, role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    });

    const orchestrator = new PipelineOrchestrator(config as never, registry, new FinOpsTracker());
    const res = await orchestrator.process({
      model: 'auto',
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'think hard' }] }],
      reasoning: { budgetTokens: 16384 },
    });
    expect(res.modelUsed).toBe('oai/o3-mini');
    expect(chatSeenEffort).toBe('high');
    expect(res.actualEffort).toBe('high');
  });

  it('assertCanonicalRequestSupported rejects encrypted reasoning blobs on google-gemini at the pre-validation gate', () => {
    expect(() => assertCanonicalRequestSupported({
      model: 'gemini-2.5-pro',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { type: 'reasoning', encrypted: 'opaque_encrypted_blob' },
      ],
    }, 'google-gemini')).toThrow(/encrypted/i);
  });
});

describe('review proof: goal pass-1 providers, stream security and URL guard', () => {
  it('createToolMarkupStreamRecovery restores suppressed DSML text on response.failed after content_part.done without breaking AnthropicMessagesEventEncoder', () => {
    const request: CanonicalRequest = {
      model: 'mimo-v2-pro-free',
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'read a.ts' }] }],
      tools: [{
        type: 'function',
        function: {
          name: 'read',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      }],
    };
    const recovery = createToolMarkupStreamRecovery(request);
    const encoder = new AnthropicMessagesEventEncoder();
    const rawMarkup = '<｜DSML｜function_calls><｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">a.ts</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>';
    const upstreamEvents = [
      { type: 'response.created' as const, id: 'resp_fail_1', model: 'mimo-v2-pro-free' },
      { type: 'response.output_item.added' as const, index: 0, item: { type: 'message' as const, role: 'assistant' as const, content: [] } },
      { type: 'response.content_part.added' as const, index: 0, partIndex: 0, part: { type: 'text' as const, text: '' } },
      { type: 'response.output_text.delta' as const, index: 0, partIndex: 0, text: rawMarkup },
      { type: 'response.output_text.done' as const, index: 0, partIndex: 0, text: rawMarkup },
      { type: 'response.content_part.done' as const, index: 0, partIndex: 0, part: { type: 'text' as const, text: rawMarkup } },
      { type: 'response.output_item.done' as const, index: 0, item: { type: 'message' as const, role: 'assistant' as const, content: [{ type: 'text' as const, text: rawMarkup }] } },
      { type: 'response.failed' as const, reason: 'upstream_interrupted' },
    ];
    const rewritten = upstreamEvents.flatMap((ev) => recovery.push(ev));
    expect(() => rewritten.flatMap((ev) => encoder.encode(ev, 'mimo-v2-pro-free'))).not.toThrow();
  });

  it('postProviderStream redacts echoed request secrets from mid-stream error events before forwarding them', async () => {
    const secretKey = 'sk-live-super-secret-token-999999';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        `data: {"type":"error","error":{"type":"authentication_error","message":"Rejected key ${secretKey} on stream"}}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as unknown as typeof fetch;
    try {
      const stream = await postProviderStream({
        url: 'https://api.anthropic.com/v1/messages',
        headers: { 'x-api-key': secretKey, 'content-type': 'application/json' },
        payload: {},
        model: { id: 'anth/m', provider: 'anth', upstreamModel: 'm', tier: 'plus', pricing: { inputPer1M: 1, outputPer1M: 1 } } as never,
        provider: 'anth',
        label: 'anthropic',
        timeoutMs: 5000,
        idleTimeoutMs: 5000,
        createDecoder: () => new AnthropicMessagesStreamDecoder(),
        parseBuffered: () => ({ status: 'completed', output: [], usage: { inputTokens: 0, outputTokens: 0 } }),
      });
      const events = [];
      for await (const ev of stream) events.push(ev);
      const errEvent = events.find((e) => e.type === 'error');
      expect(errEvent).toBeDefined();
      expect(errEvent && errEvent.type === 'error' ? errEvent.message : '').not.toContain(secretKey);
      expect(errEvent && errEvent.type === 'error' ? errEvent.message : '').toContain('[REDACTED]');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('assertAllowedUpstream admits IPv6 ULA private HTTP upstreams while blocking Alibaba Cloud metadata 100.100.100.200 and 0.0.0.0/8 self-loops', () => {
    expect(() => assertAllowedUpstream('http://[fd12:3456:789a::1]:11434/v1', 4555)).not.toThrow();
    expect(() => assertAllowedUpstream('http://100.100.100.200/latest/meta-data', 4555)).toThrow(/metadata/i);
    expect(() => assertAllowedUpstream('http://0.1.2.3:4555/v1', 4555)).toThrow(/gateway itself/i);
  });
});

describe('review proof: goal pass-2 canonical IR cache integrity and adapter parity', () => {
  it('preserves cache_control on Anthropic tool_use blocks and Chat content-less assistant tool_calls across the canonical IR hop', () => {
    const anthIr = anthropicRequestToIR({
      model: 'claude-sonnet-4-5',
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'read file' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'read',
              input: { path: 'a.ts' },
              cache_control: { type: 'ephemeral', ttl: '5m' },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
        },
      ],
    });
    const anthPayload = canonicalToAnthropicPayload(anthIr, {
      id: 'm',
      upstreamModel: 'claude-sonnet-4-5',
    } as never);
    expect(anthPayload.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });

    const chatIr = chatRequestToIR({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'user', content: 'read file' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }],
          cache_control: { type: 'ephemeral' },
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      ],
    });
    const chatWithExt = irToChatRequest(chatIr, 'claude-sonnet-4-5', { carrierExtensions: true });
    expect(chatWithExt.messages[1]?.cache_control).toEqual({ type: 'ephemeral' });
    const chatStripped = irToChatRequest(chatIr, 'gpt-4o', { carrierExtensions: false });
    expect(chatStripped.messages[1]?.cache_control).toBeUndefined();
  });

  it('AnthropicMessagesEventEncoder flushes buffered pending content deltas before emitting a terminal stream error frame', () => {
    const encoder = new AnthropicMessagesEventEncoder();
    const events = [
      { type: 'response.created' as const, id: 'msg_err_1', model: 'claude-sonnet-4-5' },
      { type: 'response.output_item.added' as const, index: 0, item: { type: 'message' as const, role: 'assistant' as const, content: [] } },
      { type: 'response.content_part.added' as const, index: 0, partIndex: 0, part: { type: 'text' as const, text: '' } },
      { type: 'response.output_text.delta' as const, index: 0, partIndex: 0, text: 'partial answer before crash' },
      { type: 'error' as const, message: 'upstream disconnected' },
    ];
    const frames = events.flatMap((ev) => encoder.encode(ev, 'claude-sonnet-4-5'));
    const textDeltas = frames.filter((f) => f.type === 'content_block_delta' && f.delta?.type === 'text_delta');
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0]?.delta.text).toBe('partial answer before crash');
    expect(frames.at(-1)).toMatchObject({ type: 'error', error: { message: 'upstream disconnected' } });
  });

  it('anthropicRequestToIR normalizes data: URLs in url image/document sources into base64 sources like Chat and Responses', () => {
    const ir = anthropicRequestToIR({
      model: 'claude-sonnet-4-5',
      max_tokens: 128,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: 'data:image/png;base64,QUJDRA==' } },
          { type: 'document', source: { type: 'url', url: 'data:application/pdf;base64,JVBERi0=' } },
        ],
      }],
    });
    const msg = ir.input[0];
    expect(msg?.type === 'message' ? msg.content[0] : null).toEqual({
      type: 'image',
      source: { kind: 'base64', mediaType: 'image/png', data: 'QUJDRA==' },
    });
    expect(msg?.type === 'message' ? msg.content[1] : null).toEqual({
      type: 'file',
      source: { kind: 'base64', mediaType: 'application/pdf', data: 'JVBERi0=' },
    });
  });
});

describe('review proof: goal pass-3 session anchors, directives cache integrity, and strict schema validation', () => {
  it('SessionManager keeps the same sessionId and conversationKey when cache_control slides off an image or document part on turn 2', () => {
    const sm = new SessionManager();
    const turn1Input: CanonicalRequest['input'] = [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'image',
            source: { kind: 'url', url: 'https://example.com/diagram.png' },
            cache: { type: 'ephemeral' },
          },
          { type: 'text', text: 'Analyze this diagram' },
        ],
      },
    ];
    const s1 = sm.resolveSessionId({ model: 'claude-sonnet-4-5', input: turn1Input });
    const k1 = SessionManager.conversationKey(turn1Input);
    sm.registerCompletedTurn(s1.sessionId, SessionManager.serializeInput(turn1Input), [
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'The diagram shows a router.' }] },
    ]);

    // Turn 2: Claude Code slides cache_control off the turn-1 image onto turn-2 user text.
    const turn2Input: CanonicalRequest['input'] = [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'image',
            source: { kind: 'url', url: 'https://example.com/diagram.png' },
          },
          { type: 'text', text: 'Analyze this diagram' },
        ],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'The diagram shows a router.' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'Now explain the failover path', cache: { type: 'ephemeral' } }],
      },
    ];
    const s2 = sm.resolveSessionId({ model: 'claude-sonnet-4-5', input: turn2Input });
    const k2 = SessionManager.conversationKey(turn2Input);
    expect(s2.sessionId).toBe(s1.sessionId);
    expect(k2).toBe(k1);
  });

  it('scanDirectives preserves cache breakpoints when stripping a directive-only text part from a multi-part message', () => {
    const scan = scanDirectives([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'text', text: 'Explain the bug in this module' },
          { type: 'text', text: '@ocr-tier-up', cache: { type: 'ephemeral', ttl: '5m' } },
        ],
      },
    ]);
    expect(scan.effective.map((h) => h.action)).toEqual(['tier_up']);
    const msg = scan.input[0];
    expect(msg?.type).toBe('message');
    if (msg?.type === 'message') {
      expect(msg.content).toEqual([
        {
          type: 'text',
          text: 'Explain the bug in this module',
          cache: { type: 'ephemeral', ttl: '5m' },
        },
      ]);
    }
  });

  it('SchemaAssertion accepts required nullable properties in OpenAI strict JSON schemas (type array and anyOf)', () => {
    const format = {
      type: 'json_schema' as const,
      name: 'StrictResponse',
      strict: true,
      schema: {
        type: 'object',
        required: ['answer', 'error', 'detail'],
        properties: {
          answer: { type: 'string' },
          error: { type: ['string', 'null'] },
          detail: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
    };
    const validWithNulls = SchemaAssertion.validate(
      JSON.stringify({ answer: '42', error: null, detail: null }),
      format,
    );
    expect(validWithNulls.valid).toBe(true);

    const invalidType = SchemaAssertion.validate(
      JSON.stringify({ answer: '42', error: 123, detail: null }),
      format,
    );
    expect(invalidType.valid).toBe(false);
  });

  it('irToChatRequest preserves per-part cache breakpoints on tool_result items across Chat projections', () => {
    const ir: CanonicalRequest = {
      model: 'claude-sonnet-4-5',
      stream: false,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'run status' }] },
        { type: 'tool_call', id: 'call_1', callId: 'call_1', name: 'bash', arguments: '{}' },
        {
          type: 'tool_result',
          callId: 'call_1',
          content: [{ type: 'text', text: 'clean tree', cache: { type: 'ephemeral' } }],
        },
      ],
    };
    const projected = irToChatRequest(ir, ir.model);
    const toolMsg = projected.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('review proof: goal pass-4 surfaces, capture migration, IPv6 CSRF, and console URL template guards', () => {
  it('buildChatOcrCompletionFacts includes X-OCR-Tier when fallbackOccurred escalates the tier after routing headers', () => {
    const result: ExecutionResult = {
      response: { id: 'r1', model: 'p/m', output: [], stopReason: 'stop' },
      tierUsed: 'pro',
      modelUsed: 'p/m',
      protocolUsed: 'openai-compatible',
      layerUsed: 'layer0',
      fallbackOccurred: true,
      failoverOccurred: true,
      failoverAttempts: 2,
      failoverPath: ['p/lite-m', 'p/m'],
      inplaceRetries: 0,
      breakerState: 'CLOSED',
      sessionId: 'sess_1',
      sessionRatchetApplied: false,
      requestId: 'req_1',
      latencyMs: 120,
      upstreamStream: 'sse',
    };
    const completion = buildChatOcrCompletionFacts(result);
    expect(completion['X-OCR-Tier']).toBe('pro-escalated');
  });

  it('V1ToV2Migrate replays structural turn boundaries over legacy OpenAI Responses and Anthropic payloads when recorded prompt pairs are absent', () => {
    const step = new V1ToV2Migrate();
    const lines: Record<string, unknown>[] = [
      {
        id: 'evt_r1',
        ts: 1000,
        eventType: 'http-exchange',
        sessionId: 'sess_resp_v1',
        direction: 'client',
        phase: 'request',
        spanId: 'span_r1',
        wire: {
          requestLine: 'POST /v1/responses HTTP/1.1',
          requestBody: JSON.stringify({
            model: 'gpt-4o',
            input: [{ type: 'message', role: 'user', content: 'List files' }],
          }),
        },
      },
      {
        id: 'evt_r2',
        ts: 2000,
        eventType: 'http-exchange',
        sessionId: 'sess_resp_v1',
        direction: 'client',
        phase: 'request',
        spanId: 'span_r2',
        wire: {
          requestLine: 'POST /v1/responses HTTP/1.1',
          requestBody: JSON.stringify({
            model: 'gpt-4o',
            input: [
              { type: 'message', role: 'user', content: 'List files' },
              { type: 'function_call', call_id: 'call_1', name: 'ls', arguments: '{}' },
              { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
            ],
          }),
        },
      },
    ];
    step.begin({ filePath: 'resp.jsonl', lines });
    const v1 = step.migrate(lines[0]!, { filePath: 'resp.jsonl', index: 0, total: 2 });
    const v2 = step.migrate(lines[1]!, { filePath: 'resp.jsonl', index: 1, total: 2 });
    expect(v1.ok && v1.line.turnIndex).toBe(1);
    expect(v1.ok && v1.line.isPromptStart).toBe(true);
    expect(v1.ok && v1.line.turnDecision).toBe('new_prompt');
    expect(v2.ok && v2.line.turnIndex).toBe(1);
    expect(v2.ok && v2.line.isPromptStart).toBe(false);
    expect(v2.ok && v2.line.turnDecision).toBe('continuation');
  });

  it('server admin CSRF gate allows same-host bracketed IPv6 Origin matching Host header', async () => {
    const cfg = loadConfig();
    const testCfg = {
      ...cfg,
      host: '127.0.0.1',
      webAuth: { enabled: false },
      adminKey: undefined,
    };
    const { app } = createServer(testCfg, true);
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/metrics/reset',
        headers: {
          host: '[fd00::1]:8080',
          origin: 'http://[fd00::1]:8080',
        },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('console provider create expands {env:VAR} templates in baseURL before enforcing assertAllowedUpstream', async () => {
    const prevUrl = process.env.OCR_TEST_EVIL_BASE_URL;
    process.env.OCR_TEST_EVIL_BASE_URL = 'http://169.254.169.254/v1';
    const cfg = loadConfig();
    const testCfg = {
      ...cfg,
      host: '127.0.0.1',
      webAuth: { enabled: false },
      adminKey: undefined,
    };
    const { app } = createServer(testCfg, true);
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/opencode/providers',
        payload: {
          id: 'custom-env-imds-test',
          name: 'Custom IMDS',
          baseURL: '{env:OCR_TEST_EVIL_BASE_URL}',
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().reasonCode).toBe('metadata_target_refused');
    } finally {
      if (prevUrl === undefined) delete process.env.OCR_TEST_EVIL_BASE_URL;
      else process.env.OCR_TEST_EVIL_BASE_URL = prevUrl;
      await app.close();
    }
  });
});

describe('review proof: goal pass-5 opencode def materialization, package normalization, and probe header parity', () => {
  it('clientRenderableDefs substitutes unloadable systemone and plugin wires on model-level provider.package just like provider-level package', () => {
    claimPluginWires(['qoder']);
    try {
      const rendered = clientRenderableDefs({
        hybrid: {
          package: 'openai-chat',
          settings: { baseURL: 'https://hybrid.example.com/v1' },
          models: {
            'decision-m': {
              name: 'decision-m',
              provider: { package: 'systemone' },
            },
            'plugin-m': {
              name: 'plugin-m',
              provider: { package: 'qoder' },
            },
          },
        },
      });
      expect(rendered.hybrid.package).toBe('@opencode/ai/providers/openai-compatible');
      expect(rendered.hybrid.models['decision-m'].provider.package).toBe('@opencode/ai/providers/openai-compatible');
      expect(rendered.hybrid.models['plugin-m'].provider.package).toBe('@opencode/ai/providers/openai-compatible');
    } finally {
      claimPluginWires([]);
    }
  });

  it('clientRenderableDefs strips model-level apiKey secrets and redacts custom -key / x-auth / signature headers', () => {
    const rendered = clientRenderableDefs({
      azureLike: {
        package: 'openai-chat',
        headers: {
          'Ocp-Apim-Subscription-Key': 'sub-secret-123456',
          'X-Auth-Header': 'auth-secret-123456',
          'X-Custom-Trace': 'visible',
        },
        models: {
          m1: {
            name: 'm1',
            options: {
              apiKey: 'sk-model-inline-secret',
              headers: {
                'X-Functions-Key': 'fn-secret-789012',
              },
            },
            settings: {
              apiKey: 'sk-model-settings-secret',
            },
          },
        },
      },
    });
    expect(rendered.azureLike.headers['Ocp-Apim-Subscription-Key']).toBe('[REDACTED]');
    expect(rendered.azureLike.headers['X-Auth-Header']).toBe('[REDACTED]');
    expect(rendered.azureLike.headers['X-Custom-Trace']).toBe('visible');
    expect(rendered.azureLike.models.m1.options.apiKey).toBeUndefined();
    expect(rendered.azureLike.models.m1.settings.apiKey).toBeUndefined();
    expect(rendered.azureLike.models.m1.options.headers['X-Functions-Key']).toBe('[REDACTED]');
  });

  it('currentPackageFor normalizes whitespace-padded and mixed-case @opencode/ai/providers/* package strings', () => {
    expect(currentPackageFor('  @opencode/ai/providers/OpenAI  ')).toBe('openai-responses');
    expect(currentPackageFor(' @opencode/ai/providers/OpenAI-Compatible ')).toBe('openai-chat');
    expect(currentPackageFor(' @opencode/ai/providers/Anthropic ')).toBe('anthropic-messages');
  });

  it('probeProvider overrides headers case-insensitively without duplicating Anthropic-Version and redacts custom header secrets from error bodies', async () => {
    let seenAnthropicVersion = '';
    const customSubKey = 'sub-secret-key-99887766';
    const srv = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        seenAnthropicVersion = req.headers.get('anthropic-version') ?? '';
        return new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'authentication_error',
              message: `Rejected subscription key ${customSubKey}`,
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    try {
      const res = await probeProvider({
        baseURL: `http://127.0.0.1:${srv.port}/v1`,
        apiKey: 'sk-primary-12345678',
        model: 'claude-sonnet-4-5',
        kind: 'anthropic-messages',
        headers: {
          'Anthropic-Version': '2024-06-01',
          'Ocp-Apim-Subscription-Key': customSubKey,
        },
      });
      expect(seenAnthropicVersion).toBe('2024-06-01');
      expect(res.ok).toBe(false);
      expect(res.upstreamBody).not.toContain(customSubKey);
    } finally {
      await srv.stop(true);
    }
  });

  it('orchestrator strips non-portable reasoning signatures on cross-protocol failover to openai-chat', async () => {
    const anthModel = {
      id: 'anth/claude-sonnet-4-5',
      provider: 'anth',
      upstreamModel: 'claude-sonnet-4-5',
      wire: 'anthropic-messages' as const,
      tier: 'plus' as const,
      pricing: { inputPer1M: 3, outputPer1M: 15 },
    };
    const chatModel = {
      id: 'oai/gpt-4o',
      provider: 'oai',
      upstreamModel: 'gpt-4o',
      wire: 'openai-chat' as const,
      tier: 'plus' as const,
      pricing: { inputPer1M: 2.5, outputPer1M: 10 },
    };
    const config = {
      port: 3000,
      host: '127.0.0.1',
      providers: {},
      models: [anthModel, chatModel],
      tiers: {
        lite: { members: [{ pattern: '*' }] },
        plus: { members: [{ pattern: '*' }] },
        pro: { members: [] },
        ultra: { members: [] },
      },
      fallback: { enabled: false, escalateTier: 'plus' as const },
      retry: {
        enabled: true,
        inplace: { enabled: false, maxAttempts: 0, backoffMs: 1, jitterMs: 0 },
        failover: { enabled: true, maxAttempts: 2, tierCrossPolicy: 'same_tier_only' as const },
      },
    };
    const registry = new ProviderRegistry({ providers: {}, models: [anthModel, chatModel], tiers: config.tiers } as never);
    let seenInput: CanonicalRequest['input'] | undefined;
    (registry as any).providers.set('anth', {
      name: 'anth',
      createCompletion: async () => {
        throw new UpstreamError({ message: 'overloaded', status: 503, provider: 'anth', modelId: anthModel.id });
      },
    });
    (registry as any).providers.set('oai', {
      name: 'oai',
      createCompletion: async (req: CanonicalRequest) => {
        seenInput = req.input;
        return {
          status: 'completed' as const,
          output: [{ type: 'message' as const, role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    });

    const orchestrator = new PipelineOrchestrator(config as never, registry, new FinOpsTracker());
    const res = await orchestrator.process({
      model: 'auto',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'first' }] },
        { type: 'reasoning', text: 'kept thought', signature: 'sig_anth_123' },
        { type: 'reasoning', encrypted: 'opaque_blob' },
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'follow-up' }] },
      ],
    });
    expect(res.modelUsed).toBe('oai/gpt-4o');
    expect(seenInput).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'first' }] },
      { type: 'reasoning', text: 'kept thought' },
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'follow-up' }] },
    ]);
  });
});

describe('ttftTimeoutMs watchdog', () => {
  it('aborts a stream that keeps sending SSE keep-alive comments past ttftTimeoutMs without emitting output', async () => {
    const originalFetch = globalThis.fetch;
    let timer: ReturnType<typeof setInterval> | undefined;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(': PROCESSING\n\n'));
          timer = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(': PROCESSING\n\n'));
            } catch {
              if (timer) clearInterval(timer);
            }
          }, 25);
          init?.signal?.addEventListener('abort', () => {
            if (timer) clearInterval(timer);
            try { controller.error(new DOMException('Aborted', 'AbortError')); } catch { /* ignore */ }
          }, { once: true });
        },
        cancel() {
          if (timer) clearInterval(timer);
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    try {
      const stream = await postProviderStream({
        url: 'https://api.anthropic.com/v1/messages',
        headers: { 'x-api-key': 'sk-test', 'content-type': 'application/json' },
        payload: {},
        model: { id: 'anth/m', provider: 'anth', upstreamModel: 'm', tier: 'plus', pricing: { inputPer1M: 1, outputPer1M: 1 } } as never,
        provider: 'anth',
        label: 'anthropic',
        timeoutMs: 5000,
        idleTimeoutMs: 500,
        ttftTimeoutMs: 80,
        createDecoder: () => new AnthropicMessagesStreamDecoder(),
        parseBuffered: () => ({ status: 'completed', output: [], usage: { inputTokens: 0, outputTokens: 0 } }),
      });
      let caught: unknown;
      try {
        for await (const _ev of stream) {
          /* drain */
        }
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain('TTFT exceeded 80ms');
    } finally {
      if (timer) clearInterval(timer);
      globalThis.fetch = originalFetch;
    }
  });

  it('disarms ttftTimeoutMs once a substantive content event arrives', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"type":"message_start","message":{"id":"msg_ttft","model":"m","usage":{"input_tokens":5,"output_tokens":0}}}\n\n'
            + 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
            + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
          ));
          setTimeout(() => {
            controller.enqueue(encoder.encode(
              'data: {"type":"content_block_stop","index":0}\n\n'
              + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n'
              + 'data: {"type":"message_stop"}\n\n',
            ));
            controller.close();
          }, 150);
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    try {
      const stream = await postProviderStream({
        url: 'https://api.anthropic.com/v1/messages',
        headers: { 'x-api-key': 'sk-test', 'content-type': 'application/json' },
        payload: {},
        model: { id: 'anth/m', provider: 'anth', upstreamModel: 'm', tier: 'plus', pricing: { inputPer1M: 1, outputPer1M: 1 } } as never,
        provider: 'anth',
        label: 'anthropic',
        timeoutMs: 5000,
        idleTimeoutMs: 500,
        ttftTimeoutMs: 80,
        createDecoder: () => new AnthropicMessagesStreamDecoder(),
        parseBuffered: () => ({ status: 'completed', output: [], usage: { inputTokens: 0, outputTokens: 0 } }),
      });
      const events = [];
      for await (const ev of stream) events.push(ev);
      expect(events.some((e) => e.type === 'response.output_text.delta' && e.text === 'hi')).toBe(true);
      expect(events.some((e) => e.type === 'response.completed')).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

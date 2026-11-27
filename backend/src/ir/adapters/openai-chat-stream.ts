/**
 * Chat Completions stream codecs — an EXPLICIT Chat boundary (ADR-0033 §3).
 *
 * Lives beside `adapters/openai-chat.ts`, not in the vendor-neutral `ir/stream.ts`.
 * Southbound: Chat SSE chunks → canonical StreamEvent.
 * Northbound: StreamEvent → Chat completion chunks for the Chat surface.
 */
import type { ChatCompletionChunk } from '../../types/openai.js';
import type { CanonicalResponse, OutputItem, StreamEvent, Usage } from '../types.js';
import { extractChatReasoningText, usageToIR } from './openai-chat.js';
import { IrUnsupportedError } from '../errors.js';
import { upstreamToolCallId } from '../tool-identity.js';
import { assertCanonicalResponseSupported, assertCanonicalStreamEventSupported } from '../validate.js';

type ToolFragment = {
  index?: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
};

interface CandidateState {
  nextItem: number;
  messageIndex?: number;
  reasoningIndex?: number;
  tools: Map<number, { index: number; emitted: boolean; item: Extract<OutputItem, { type: 'tool_call' }> }>;
  message?: Extract<OutputItem, { type: 'message' }>;
  reasoning?: Extract<OutputItem, { type: 'reasoning' }>;
  reason?: string;
}

/** Decode an OpenAI Chat SSE stream into canonical item events, once per chunk. */
export class ChatStreamDecoder {
  private readonly candidates = new Map<number, CandidateState>();
  private createdSent = false;
  private id = '';
  private model = '';
  private createdAt = 0;
  private systemFingerprint?: string;
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };
  private terminalSent = false;

  public push(chunk: ChatCompletionChunk): StreamEvent[] {
    const events: StreamEvent[] = [];
    this.id ||= chunk.id;
    this.model ||= chunk.model;
    this.createdAt ||= chunk.created;
    this.systemFingerprint ??= chunk.system_fingerprint;
    if (!this.createdSent) {
      this.createdSent = true;
      events.push({
        type: 'response.created', id: this.id, model: this.model, createdAt: this.createdAt,
        ...(this.systemFingerprint ? { systemFingerprint: this.systemFingerprint } : {}),
      });
    }
    if (chunk.usage) {
      this.usage = usageToIR(chunk.usage);
      events.push({ type: 'response.usage', usage: this.usage });
    }
    for (const choice of chunk.choices ?? []) {
      const candidateIndex = choice.index ?? 0;
      const state = this.state(candidateIndex);
      const delta = choice.delta as ChatCompletionChunk['choices'][number]['delta'] & { reasoning?: string; refusal?: string | null };
      const reasoningDelta = extractChatReasoningText(delta);
      if (typeof reasoningDelta === 'string') {
        if (state.reasoningIndex === undefined) {
          state.reasoningIndex = state.nextItem++;
          state.reasoning = { type: 'reasoning', text: '' };
          events.push({ type: 'response.output_item.added', candidateIndex, index: state.reasoningIndex, item: { type: 'reasoning', text: '' } });
        }
        if (reasoningDelta) {
          state.reasoning!.text = (state.reasoning!.text ?? '') + reasoningDelta;
          events.push({ type: 'response.reasoning.delta', candidateIndex, index: state.reasoningIndex, text: reasoningDelta });
        }
      }
      if (delta.role === 'assistant' || typeof delta.content === 'string' || typeof delta.refusal === 'string') {
        if (state.messageIndex === undefined) {
          state.messageIndex = state.nextItem++;
          state.message = { type: 'message', role: 'assistant', content: [] };
          events.push({
            type: 'response.output_item.added', candidateIndex, index: state.messageIndex,
            item: { type: 'message', role: 'assistant', content: [] },
          });
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          let textPartIndex = state.message!.content.findIndex((p) => p.type === 'text');
          if (textPartIndex === -1) {
            textPartIndex = state.message!.content.length;
            state.message!.content.push({ type: 'text', text: '' });
            events.push({
              type: 'response.content_part.added', candidateIndex, index: state.messageIndex,
              partIndex: textPartIndex, part: { type: 'text', text: '' },
            });
          }
          const part = state.message!.content[textPartIndex]!;
          if (part.type === 'text') part.text += delta.content;
          events.push({
            type: 'response.output_text.delta', candidateIndex, index: state.messageIndex,
            partIndex: textPartIndex, text: delta.content,
          });
        }
        if (typeof delta.refusal === 'string' && delta.refusal.length > 0) {
          let refusalPartIndex = state.message!.content.findIndex((p) => p.type === 'refusal');
          if (refusalPartIndex === -1) {
            refusalPartIndex = state.message!.content.length;
            state.message!.content.push({ type: 'refusal', text: '' });
            events.push({
              type: 'response.content_part.added', candidateIndex, index: state.messageIndex,
              partIndex: refusalPartIndex, part: { type: 'refusal', text: '' },
            });
          }
          const part = state.message!.content[refusalPartIndex]!;
          if (part.type === 'refusal') part.text += delta.refusal;
          events.push({
            type: 'response.refusal.delta', candidateIndex, index: state.messageIndex,
            partIndex: refusalPartIndex, text: delta.refusal,
          });
        }
      }
      const fragments = delta.tool_calls as ToolFragment[] | undefined;
      if (Array.isArray(fragments)) {
        fragments.forEach((fragment, position) => {
          const wireIndex = typeof fragment.index === 'number' ? fragment.index : position;
          let call = state.tools.get(wireIndex);
          if (!call) {
            // Minted, not positional: `call_<candidate>_<index>` repeats the SAME id for the
            // same position of EVERY response, so two turns of one session would carry two
            // calls under one correlation id and the upstream would merge their results.
            const id = upstreamToolCallId(fragment.id);
            call = {
              index: state.nextItem++,
              emitted: false,
              item: { type: 'tool_call', id, callId: id, name: '', arguments: '' },
            };
            state.tools.set(wireIndex, call);
          }
          if (fragment.id) {
            call.item.id = fragment.id;
            call.item.callId = fragment.id;
          }
          if (fragment.function?.name) call.item.name += fragment.function.name;
          if (fragment.function?.arguments) {
            // Defer tool_call output_item.added until arguments begin (or finish) so
            // chunked names or id-before-name deltas are complete before downstream encoders open the block.
            if (!call.emitted) {
              // Flush earlier unemitted tool calls in ascending index order so parallel
              // tool calls with empty arguments on an earlier index are never reordered.
              for (const prev of [...state.tools.values()].sort((a, b) => a.index - b.index)) {
                if (prev.index < call.index && !prev.emitted) {
                  prev.emitted = true;
                  events.push({
                    type: 'response.output_item.added', candidateIndex, index: prev.index,
                    item: { ...prev.item, arguments: '' },
                  });
                }
              }
              call.emitted = true;
              events.push({
                type: 'response.output_item.added', candidateIndex, index: call.index,
                item: { ...call.item, arguments: '' },
              });
            }
            call.item.arguments += fragment.function.arguments;
            events.push({
              type: 'response.function_call.arguments.delta', candidateIndex,
              index: call.index, argumentsDelta: fragment.function.arguments,
            });
          }
        });
      }
      if (choice.finish_reason) state.reason = choice.finish_reason;
    }
    return events;
  }

  public finish(): StreamEvent[] {
    if (this.terminalSent) return [];
    this.terminalSent = true;
    if (!this.createdSent) {
      this.createdSent = true;
    }
    const events: StreamEvent[] = [];
    let incompleteReason: string | undefined;
    for (const [candidateIndex, state] of this.candidates) {
      if (state.message && state.messageIndex !== undefined) {
        for (let partIndex = 0; partIndex < state.message.content.length; partIndex++) {
          const part = state.message.content[partIndex]!;
          if (part.type === 'text') {
            events.push({
              type: 'response.output_text.done', candidateIndex, index: state.messageIndex,
              partIndex, text: part.text,
            });
            // Anthropic / Responses encoders close blocks on content_part.done.
            // Emitting only output_item.done leaves those wires without a stop frame.
            events.push({
              type: 'response.content_part.done', candidateIndex, index: state.messageIndex,
              partIndex, part: { ...part },
            });
          } else if (part.type === 'refusal') {
            events.push({
              type: 'response.refusal.done', candidateIndex, index: state.messageIndex,
              partIndex, text: part.text,
            });
            events.push({
              type: 'response.content_part.done', candidateIndex, index: state.messageIndex,
              partIndex, part: { ...part },
            });
          }
        }
        events.push({
          type: 'response.output_item.done', candidateIndex, index: state.messageIndex,
          item: { ...state.message, content: state.message.content.map((p) => ({ ...p })) },
        });
      }
      if (state.reasoning && state.reasoningIndex !== undefined) {
        if (state.reasoning.text !== undefined) {
          events.push({
            type: 'response.reasoning.done', candidateIndex, index: state.reasoningIndex, text: state.reasoning.text,
          });
        }
        events.push({
          type: 'response.output_item.done', candidateIndex, index: state.reasoningIndex,
          item: { ...state.reasoning },
        });
      }
      for (const call of [...state.tools.values()].sort((a, b) => a.index - b.index)) {
        if (!call.emitted) {
          call.emitted = true;
          events.push({
            type: 'response.output_item.added', candidateIndex, index: call.index,
            item: { ...call.item, arguments: '' },
          });
        }
        events.push({
          type: 'response.function_call.arguments.done', candidateIndex,
          index: call.index, arguments: call.item.arguments,
        });
        events.push({
          type: 'response.output_item.done', candidateIndex, index: call.index,
          item: { ...call.item },
        });
      }
      if (state.reason === 'length' || state.reason === 'content_filter') incompleteReason = state.reason;
    }
    events.push(incompleteReason
      ? { type: 'response.incomplete', reason: incompleteReason }
      : { type: 'response.completed' });
    return events;
  }

  private state(index: number): CandidateState {
    let state = this.candidates.get(index);
    if (!state) {
      state = { nextItem: 0, tools: new Map() };
      this.candidates.set(index, state);
    }
    return state;
  }
}

/** Canonical event → OpenAI Chat chunk; state belongs to one client turn. */
export class ChatEventEncoder {
  private id = '';
  private model = '';
  private createdAt = 0;
  private systemFingerprint?: string;
  private readonly toolPositions = new Map<string, number>();
  private readonly deferUsage: boolean;
  private pendingUsage?: Usage;

  constructor(options?: { deferUsage?: boolean }) {
    this.deferUsage = options?.deferUsage === true;
  }

  private usageChunk(usage: Usage, modelOverride: string): ChatCompletionChunk {
    return {
      ...this.base(modelOverride), choices: [], usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
        ...(usage.cachedInputTokens !== undefined || usage.audioInputTokens !== undefined ? {
          prompt_tokens_details: {
            ...(usage.cachedInputTokens !== undefined ? { cached_tokens: usage.cachedInputTokens } : {}),
            ...(usage.audioInputTokens !== undefined ? { audio_tokens: usage.audioInputTokens } : {}),
          },
        } : {}),
        ...(usage.reasoningTokens !== undefined || usage.audioOutputTokens !== undefined ||
          usage.acceptedPredictionTokens !== undefined || usage.rejectedPredictionTokens !== undefined ? {
          completion_tokens_details: {
            ...(usage.reasoningTokens !== undefined ? { reasoning_tokens: usage.reasoningTokens } : {}),
            ...(usage.audioOutputTokens !== undefined ? { audio_tokens: usage.audioOutputTokens } : {}),
            ...(usage.acceptedPredictionTokens !== undefined
              ? { accepted_prediction_tokens: usage.acceptedPredictionTokens } : {}),
            ...(usage.rejectedPredictionTokens !== undefined
              ? { rejected_prediction_tokens: usage.rejectedPredictionTokens } : {}),
          },
        } : {}),
      }
    };
  }

  public encode(event: StreamEvent, modelOverride: string): ChatCompletionChunk | null {
    assertCanonicalStreamEventSupported(event, 'openai-chat');
    if (event.type === 'response.created') {
      this.id = event.id ?? this.id;
      this.model = event.model ?? this.model;
      this.createdAt = event.createdAt ?? this.createdAt;
      this.systemFingerprint = event.systemFingerprint ?? this.systemFingerprint;
      return null;
    }
    const candidateIndex = event.candidateIndex ?? 0;
    if (event.type === 'response.usage') {
      if (this.deferUsage) {
        this.pendingUsage = event.usage;
        return null;
      }
      return this.usageChunk(event.usage, modelOverride);
    }
    if (event.type === 'response.output_item.added') {
      if (event.item.type === 'message') {
        return { ...this.base(modelOverride), choices: [{ index: candidateIndex, delta: { role: 'assistant' }, finish_reason: null }] };
      }
      if (event.item.type === 'tool_call') {
        const key = `${candidateIndex}:${event.index}`;
        const position = [...this.toolPositions.keys()].filter((k) => k.startsWith(`${candidateIndex}:`)).length;
        this.toolPositions.set(key, position);
        return {
          ...this.base(modelOverride), choices: [{
            index: candidateIndex, finish_reason: null, delta: {
              tool_calls: [{ index: position, id: event.item.callId ?? event.item.id, type: 'function', function: { name: event.item.name, arguments: '' } }] as any,
            }
          }]
        };
      }
      if (event.item.type === 'extension') {
        throw new IrUnsupportedError('output_item', `Chat cannot carry ${event.item.protocol} extension output.`, 'openai-chat');
      }
      return null;
    }
    if (event.type === 'response.output_text.delta') {
      return { ...this.base(modelOverride), choices: [{ index: candidateIndex, delta: { content: event.text }, finish_reason: null }] };
    }
    if (event.type === 'response.refusal.delta') {
      return { ...this.base(modelOverride), choices: [{ index: candidateIndex, delta: { refusal: event.text } as any, finish_reason: null }] };
    }
    if (event.type === 'response.reasoning.delta') {
      return { ...this.base(modelOverride), choices: [{ index: candidateIndex, delta: { reasoning_content: event.text }, finish_reason: null }] };
    }
    if (event.type === 'response.function_call.arguments.delta') {
      const position = this.toolPositions.get(`${candidateIndex}:${event.index}`) ?? event.index;
      return {
        ...this.base(modelOverride), choices: [{
          index: candidateIndex, finish_reason: null, delta: {
            tool_calls: [{ index: position, function: { arguments: event.argumentsDelta } }] as any,
          }
        }]
      };
    }
    return null;
  }

  /** Terminal frames need the accumulated per-candidate status and tool calls. */
  public finish(response: CanonicalResponse, modelOverride: string): ChatCompletionChunk[] {
    assertCanonicalResponseSupported(response, 'openai-chat');
    this.id = response.id ?? this.id;
    this.model = response.model ?? this.model;
    this.createdAt = response.createdAt ?? this.createdAt;
    this.systemFingerprint = response.systemFingerprint ?? this.systemFingerprint;
    const candidates = response.candidates?.length ? response.candidates : [{
      index: 0, status: response.status, ...(response.reason ? { reason: response.reason } : {}), output: response.output,
    }];
    const frames: ChatCompletionChunk[] = candidates.map((candidate) => ({
      ...this.base(modelOverride),
      choices: [{
        index: candidate.index,
        delta: {},
        finish_reason: candidate.status === 'incomplete'
          ? candidate.reason === 'content_filter' ? 'content_filter' : 'length'
          : candidate.status === 'failed'
            ? 'content_filter'
            : candidate.reason === 'tool_calls' || candidate.output.some((item) => item.type === 'tool_call')
              ? 'tool_calls'
              : 'stop',
      }],
    }));
    if (this.pendingUsage) {
      frames.push(this.usageChunk(this.pendingUsage, modelOverride));
      this.pendingUsage = undefined;
    }
    return frames;
  }

  private base(modelOverride: string): Omit<ChatCompletionChunk, 'choices'> {
    return {
      id: this.id || `chatcmpl-${this.createdAt || Date.now()}`,
      object: 'chat.completion.chunk',
      created: this.createdAt || Math.floor(Date.now() / 1000),
      model: modelOverride || this.model,
      ...(this.systemFingerprint ? { system_fingerprint: this.systemFingerprint } : {}),
    };
  }
}

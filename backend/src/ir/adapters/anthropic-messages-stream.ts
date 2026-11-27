import type { ContentPart, OutputItem, StreamEvent, Usage } from '../types.js';
import { IrUpstreamError } from '../errors.js';
import { anthropicUsageFromWire } from './anthropic-messages.js';
import { upstreamToolCallId } from '../tool-identity.js';

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function invalid(message: string): never {
  throw new IrUpstreamError(`Invalid Anthropic stream: ${message}`);
}

type BlockState = {
  wireIndex: number;
  itemIndex: number;
  item: OutputItem;
  part?: ContentPart;
  kind: 'text' | 'tool' | 'reasoning' | 'extension';
};

/** Anthropic Messages SSE → canonical item lifecycle decoder. */
export class AnthropicMessagesStreamDecoder {
  private readonly blocks = new Map<number, BlockState>();
  private nextItem = 0;
  private createdSent = false;
  private nativeTerminal = false;
  private terminalSent = false;
  private stopReason: string | undefined;
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };

  public get terminated(): boolean {
    return this.nativeTerminal;
  }

  public push(raw: unknown): StreamEvent[] {
    const frame = record(raw);
    const type = String(frame.type ?? '');
    if (type === 'message_start') {
      const message = record(frame.message);
      this.usage = anthropicUsageFromWire(message.usage);
      this.createdSent = true;
      return [
        {
          type: 'response.created',
          ...(typeof message.id === 'string' ? { id: message.id } : {}),
          ...(typeof message.model === 'string' ? { model: message.model } : {}),
        },
        { type: 'response.usage', usage: this.usage },
      ];
    }
    if (type === 'content_block_start') {
      const wireIndex = this.wireIndex(frame.index);
      if (this.blocks.has(wireIndex)) invalid(`content block ${wireIndex} was opened twice.`);
      const block = record(frame.content_block);
      const itemIndex = this.nextItem++;
      let state: BlockState;
      const events: StreamEvent[] = [];
      if (block.type === 'text') {
        const part: ContentPart = {
          type: 'text', text: typeof block.text === 'string' ? block.text : '',
          ...(Array.isArray(block.citations)
            ? { annotations: block.citations.map((payload) => ({ type: 'extension' as const, protocol: 'anthropic-messages', payload })) }
            : {}),
        };
        const item: OutputItem = { type: 'message', role: 'assistant', content: [part] };
        state = { wireIndex, itemIndex, item, part, kind: 'text' };
        events.push(
          { type: 'response.output_item.added', index: itemIndex, item: { type: 'message', role: 'assistant', content: [] } },
          {
            type: 'response.content_part.added', index: itemIndex, partIndex: 0,
            part: { type: 'text', text: '', ...(part.annotations ? { annotations: [...part.annotations] } : {}) },
          },
        );
        if (part.text) events.push({ type: 'response.output_text.delta', index: itemIndex, partIndex: 0, text: part.text });
      } else if (block.type === 'tool_use') {
        // The streaming leg names an unnamed call exactly the way the buffered leg does
        // (`anthropicResponseToIR`), so a call the client must answer always carries something
        // to answer with on both legs. An empty id here would survive to the outbound gate and
        // the client's tool result could not name the call it belongs to.
        const id = upstreamToolCallId(typeof block.id === 'string' ? block.id : undefined);
        const item: OutputItem = { type: 'tool_call', id, callId: id, name: String(block.name ?? ''), arguments: '' };
        state = { wireIndex, itemIndex, item, kind: 'tool' };
        events.push({ type: 'response.output_item.added', index: itemIndex, item: { ...item, arguments: '' } });
        const initial = block.input && typeof block.input === 'object' && Object.keys(block.input).length
          ? JSON.stringify(block.input)
          : '';
        if (initial) {
          item.arguments = initial;
          events.push({ type: 'response.function_call.arguments.delta', index: itemIndex, argumentsDelta: initial });
        }
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        const item: OutputItem = {
          type: 'reasoning',
          ...(block.type === 'thinking' ? { text: typeof block.thinking === 'string' ? block.thinking : '' } : {}),
          ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
          ...(typeof block.data === 'string' ? { encrypted: block.data } : {}),
          vendor: { anthropic: { blockType: block.type } },
        };
        state = { wireIndex, itemIndex, item, kind: 'reasoning' };
        events.push({
          type: 'response.output_item.added',
          index: itemIndex,
          item: { ...item, ...(block.type === 'thinking' ? { text: '' } : {}) },
        });
        if (item.text) events.push({ type: 'response.reasoning.delta', index: itemIndex, text: item.text });
      } else {
        const item: OutputItem = { type: 'extension', protocol: 'anthropic-messages', payload: frame.content_block };
        state = { wireIndex, itemIndex, item, kind: 'extension' };
        events.push({ type: 'response.output_item.added', index: itemIndex, item: { ...item } });
      }
      this.blocks.set(wireIndex, state);
      return events;
    }
    if (type === 'content_block_delta') {
      const state = this.block(frame.index);
      const delta = record(frame.delta);
      if (delta.type === 'text_delta' && state.part?.type === 'text') {
        if (typeof delta.text !== 'string') invalid('text_delta requires text.');
        state.part.text += delta.text;
        return [{ type: 'response.output_text.delta', index: state.itemIndex, partIndex: 0, text: delta.text }];
      }
      if (delta.type === 'thinking_delta' && state.item.type === 'reasoning') {
        if (typeof delta.thinking !== 'string') invalid('thinking_delta requires thinking.');
        state.item.text = (state.item.text ?? '') + delta.thinking;
        return [{ type: 'response.reasoning.delta', index: state.itemIndex, text: delta.thinking }];
      }
      if (delta.type === 'signature_delta' && state.item.type === 'reasoning') {
        if (typeof delta.signature !== 'string') invalid('signature_delta requires signature.');
        state.item.signature = (state.item.signature ?? '') + delta.signature;
        return [];
      }
      if (delta.type === 'input_json_delta' && state.item.type === 'tool_call') {
        if (typeof delta.partial_json !== 'string') invalid('input_json_delta requires partial_json.');
        state.item.arguments += delta.partial_json;
        return [{
          type: 'response.function_call.arguments.delta', index: state.itemIndex,
          argumentsDelta: delta.partial_json,
        }];
      }
      if (delta.type === 'citations_delta' && state.part?.type === 'text') {
        const annotation = { type: 'extension' as const, protocol: 'anthropic-messages', payload: delta.citation };
        state.part.annotations ??= [];
        const annotationIndex = state.part.annotations.push(annotation) - 1;
        return [{
          type: 'response.output_text.annotation.added', index: state.itemIndex,
          partIndex: 0, annotationIndex, annotation,
        }];
      }
      return invalid(`delta "${String(delta.type)}" does not match content block ${state.wireIndex}.`);
    }
    if (type === 'content_block_stop') return this.closeBlock(this.wireIndex(frame.index));
    if (type === 'message_delta') {
      const delta = record(frame.delta);
      if (typeof delta.stop_reason === 'string') this.stopReason = delta.stop_reason;
      const events: StreamEvent[] = [];
      if (frame.usage && typeof frame.usage === 'object') {
        this.mergeUsage(record(frame.usage));
        events.push({ type: 'response.usage', usage: this.usage });
      }
      return events;
    }
    if (type === 'message_stop') {
      this.nativeTerminal = true;
      this.terminalSent = true;
      const events: StreamEvent[] = [];
      if (!this.createdSent) {
        this.createdSent = true;
        events.push({ type: 'response.created' });
      }
      for (const index of [...this.blocks.keys()].sort((a, b) => a - b)) events.push(...this.closeBlock(index));
      const reason = this.stopReason === 'max_tokens' ? 'length'
        : this.stopReason === 'refusal' ? 'content_filter' : undefined;
      events.push(reason ? { type: 'response.incomplete', reason } : { type: 'response.completed' });
      return events;
    }
    if (type === 'error') {
      this.nativeTerminal = true;
      this.terminalSent = true;
      const error = record(frame.error);
      return [{ type: 'error', code: error.type, message: String(error.message ?? 'Anthropic stream failed.') }];
    }
    if (type === 'ping') return [];
    return invalid(`unsupported event "${type || 'missing type'}".`);
  }

  public finish(): StreamEvent[] {
    if (this.terminalSent) return [];
    this.terminalSent = true;
    const events: StreamEvent[] = [];
    for (const index of [...this.blocks.keys()].sort((a, b) => a - b)) events.push(...this.closeBlock(index));
    events.push(this.stopReason === 'max_tokens'
      ? { type: 'response.incomplete', reason: 'length' }
      : this.stopReason === 'refusal'
        ? { type: 'response.incomplete', reason: 'content_filter' }
        : { type: 'response.completed' });
    return events;
  }

  private closeBlock(wireIndex: number): StreamEvent[] {
    const state = this.blocks.get(wireIndex);
    if (!state) invalid(`content block ${wireIndex} was not open.`);
    this.blocks.delete(wireIndex);
    const index = state.itemIndex;
    if (state.kind === 'text' && state.part?.type === 'text' && state.item.type === 'message') {
      const partSnapshot: ContentPart = {
        ...state.part,
        ...(state.part.annotations ? { annotations: [...state.part.annotations] } : {}),
      };
      return [
        {
          type: 'response.output_text.done', index, partIndex: 0, text: state.part.text,
          ...(state.part.annotations ? { annotations: [...state.part.annotations] } : {}),
        },
        { type: 'response.content_part.done', index, partIndex: 0, part: partSnapshot },
        { type: 'response.output_item.done', index, item: { ...state.item, content: [partSnapshot] } },
      ];
    }
    if (state.kind === 'reasoning' && state.item.type === 'reasoning') {
      return [
        ...(state.item.text !== undefined
          ? [{ type: 'response.reasoning.done', index, text: state.item.text } satisfies StreamEvent]
          : []),
        { type: 'response.output_item.done', index, item: { ...state.item } },
      ];
    }
    if (state.kind === 'tool' && state.item.type === 'tool_call') {
      return [
        { type: 'response.function_call.arguments.done', index, arguments: state.item.arguments },
        { type: 'response.output_item.done', index, item: { ...state.item } },
      ];
    }
    return [{ type: 'response.output_item.done', index, item: { ...state.item } }];
  }

  private mergeUsage(raw: Record<string, any>): void {
    const next = anthropicUsageFromWire(raw);
    const prevUncached = Math.max(
      0,
      this.usage.inputTokens - (this.usage.cachedInputTokens ?? 0) - (this.usage.cacheWriteTokens ?? 0),
    );
    const uncached = typeof raw.input_tokens === 'number' ? raw.input_tokens : prevUncached;
    const cached = typeof raw.cache_read_input_tokens === 'number'
      ? raw.cache_read_input_tokens
      : (this.usage.cachedInputTokens ?? 0);
    const write = typeof raw.cache_creation_input_tokens === 'number'
      ? raw.cache_creation_input_tokens
      : (this.usage.cacheWriteTokens ?? 0);
    const hasInput = raw.input_tokens !== undefined || raw.cache_read_input_tokens !== undefined ||
      raw.cache_creation_input_tokens !== undefined;
    this.usage = {
      ...this.usage,
      ...(hasInput ? {
        inputTokens: uncached + cached + write,
        cachedInputTokens: cached,
        cacheWriteTokens: write,
      } : {}),
      ...(next.cacheWrite5mTokens !== undefined ? { cacheWrite5mTokens: next.cacheWrite5mTokens } : {}),
      ...(next.cacheWrite1hTokens !== undefined ? { cacheWrite1hTokens: next.cacheWrite1hTokens } : {}),
      ...(raw.output_tokens !== undefined ? { outputTokens: next.outputTokens } : {}),
      ...(next.reasoningTokens !== undefined ? { reasoningTokens: next.reasoningTokens } : {}),
    };
    this.usage.totalTokens = this.usage.inputTokens + this.usage.outputTokens;
  }

  private wireIndex(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) invalid('content block index must be a non-negative integer.');
    return value;
  }

  private block(value: unknown): BlockState {
    const index = this.wireIndex(value);
    const state = this.blocks.get(index);
    if (!state) invalid(`delta references unopened content block ${index}.`);
    return state;
  }
}

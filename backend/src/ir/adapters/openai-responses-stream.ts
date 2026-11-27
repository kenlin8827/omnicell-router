import type { OutputItem, StreamEvent } from '../types.js';
import { IrUpstreamError } from '../errors.js';
import {
  responsesAnnotationFromWire,
  responsesPartFromWire,
  responsesResponseToIR,
  responsesUsageFromWire,
} from './openai-responses.js';

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function invalid(message: string): never {
  throw new IrUpstreamError(`Invalid Responses stream: ${message}`);
}

function itemFromWire(raw: unknown): OutputItem {
  const item = responsesResponseToIR({ status: 'in_progress', output: [raw] }).output[0];
  if (!item) invalid('output_item did not contain an item.');
  return item;
}

/** A wire tool item that carries NO name of its own (`id` and `call_id` both absent or empty). */
function wireNamesToolCall(raw: unknown): boolean {
  const item = record(raw);
  if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return true;
  return (typeof item.call_id === 'string' && item.call_id !== '')
    || (typeof item.id === 'string' && item.id !== '');
}

const BUILTIN_TOOL_PROGRESS_RE =
  /^response\.(?:web_search_call|file_search_call|code_interpreter_call|code_interpreter_call_code|mcp_call|mcp_call_arguments|mcp_list_tools|image_generation_call)\.(?:in_progress|searching|interpreting|generating|partial_image|delta|done|completed|failed)$/;

/** Stateful OpenAI Responses SSE → canonical item lifecycle decoder. */
export class OpenAIResponsesStreamDecoder {
  private nativeTerminal = false;
  private terminalSent = false;
  private createdSent = false;
  private readonly annotations = new Map<string, import('../types.js').Annotation[]>();
  /**
   * Names this decoder invented for items the wire left unnamed, keyed by output index. An
   * id-less `function_call` arrives as BOTH `output_item.added` and `output_item.done`, and
   * each frame is read on its own, so a plain read-time mint would give one item two canonical
   * ids. The accumulator replaces the added item with the done item (`ir/stream.ts`), so the
   * LAST name wins: without this memo the id a client was handed while streaming is not the
   * one its tool result pairs against, and the buffered and streaming legs of one accounting
   * plane disagree. First name seen wins here, and it is reused for every later frame of the
   * same index; an id the upstream DID send is never touched.
   */
  private readonly mintedIds = new Map<number, string>();

  public get terminated(): boolean {
    return this.nativeTerminal;
  }

  /** Read one wire item, reusing this decoder's name for an item the wire left unnamed. */
  private namedItem(index: number, raw: unknown): OutputItem {
    const item = itemFromWire(raw);
    if (item.type !== 'tool_call' || wireNamesToolCall(raw)) return item;
    const seen = this.mintedIds.get(index);
    if (seen) {
      item.id = seen;
      item.callId = seen;
      return item;
    }
    this.mintedIds.set(index, item.id ?? '');
    return item;
  }

  public push(raw: unknown): StreamEvent[] {
    const frame = record(raw);
    const type = String(frame.type ?? '');
    const index = typeof frame.output_index === 'number' ? frame.output_index : 0;
    const partIndex = typeof frame.content_index === 'number' ? frame.content_index : 0;
    const summaryIndex = typeof frame.summary_index === 'number' ? frame.summary_index : 0;
    if (type === 'response.created') {
      this.createdSent = true;
      const response = record(frame.response);
      return [{
        type: 'response.created',
        ...(typeof response.id === 'string' ? { id: response.id } : {}),
        ...(typeof response.model === 'string' ? { model: response.model } : {}),
        ...(typeof response.created_at === 'number' ? { createdAt: response.created_at } : {}),
      }];
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      return [{
        type: type === 'response.output_item.added' ? 'response.output_item.added' : 'response.output_item.done',
        index,
        item: this.namedItem(index, frame.item),
      }];
    }
    if (type === 'response.content_part.added' || type === 'response.content_part.done') {
      const part = responsesPartFromWire(frame.part);
      if (part.type === 'text' && part.annotations) this.annotations.set(this.key(index, partIndex), part.annotations);
      return [{
        type: type === 'response.content_part.added' ? 'response.content_part.added' : 'response.content_part.done',
        index, partIndex, part,
      }];
    }
    if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
      if (type.endsWith('.delta')) {
        if (typeof frame.delta !== 'string') invalid(`${type} requires its text payload.`);
        return [{ type: 'response.output_text.delta', index, partIndex, text: frame.delta }];
      }
      if (typeof frame.text !== 'string') invalid(`${type} requires its text payload.`);
      const annotations = this.annotations.get(this.key(index, partIndex));
      return [{
        type: 'response.output_text.done', index, partIndex, text: frame.text,
        ...(annotations ? { annotations } : {}),
      }];
    }
    if (type === 'response.output_text.annotation.added') {
      const annotation = responsesAnnotationFromWire(frame.annotation);
      const key = this.key(index, partIndex);
      const list = this.annotations.get(key) ?? [];
      list.push(annotation);
      this.annotations.set(key, list);
      return [{
        type: 'response.output_text.annotation.added', index, partIndex,
        annotationIndex: typeof frame.annotation_index === 'number' ? frame.annotation_index : list.length - 1,
        annotation,
      }];
    }
    if (type === 'response.refusal.delta' || type === 'response.refusal.done') {
      const text = type.endsWith('.delta') ? frame.delta : frame.refusal;
      if (typeof text !== 'string') invalid(`${type} requires its refusal payload.`);
      return [{
        type: type.endsWith('.delta') ? 'response.refusal.delta' : 'response.refusal.done',
        index, partIndex, text,
      }];
    }
    if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_text.done' ||
      type === 'response.reasoning.delta' || type === 'response.reasoning.done') {
      const text = type.endsWith('.delta') ? frame.delta : frame.text;
      if (typeof text !== 'string') invalid(`${type} requires its reasoning payload.`);
      return [{
        type: type.endsWith('.delta') ? 'response.reasoning.delta' : 'response.reasoning.done',
        index, text,
      }];
    }
    if (type === 'response.reasoning_summary_part.added') {
      return [{ type: 'response.reasoning_summary_part.added', index, summaryIndex }];
    }
    if (type === 'response.reasoning_summary_part.done') {
      return [];
    }
    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_summary_text.done' ||
      type === 'response.reasoning_summary.delta' || type === 'response.reasoning_summary.done') {
      const text = type.endsWith('.delta') ? frame.delta : frame.text;
      if (typeof text !== 'string') invalid(`${type} requires its summary payload.`);
      return [{
        type: type.endsWith('.delta') ? 'response.reasoning_summary.delta' : 'response.reasoning_summary.done',
        index, summaryIndex, text,
      }];
    }
    if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done' ||
      type === 'response.function_call.arguments.delta' || type === 'response.function_call.arguments.done' ||
      type === 'response.custom_tool_call_input.delta' || type === 'response.custom_tool_call_input.done' ||
      type === 'response.custom_tool_call.input.delta' || type === 'response.custom_tool_call.input.done') {
      const done = type.endsWith('.done');
      const text = done
        ? (typeof frame.arguments === 'string' ? frame.arguments : frame.input)
        : frame.delta;
      if (typeof text !== 'string') invalid(`${type} requires its tool input payload.`);
      return [done
        ? { type: 'response.function_call.arguments.done', index, arguments: text }
        : { type: 'response.function_call.arguments.delta', index, argumentsDelta: text }];
    }
    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      this.nativeTerminal = true;
      this.terminalSent = true;
      const response = record(frame.response);
      const events: StreamEvent[] = [];
      if (frame.response && typeof frame.response === 'object') {
        if (!this.createdSent) {
          this.createdSent = true;
          events.push({
            type: 'response.created',
            ...(typeof response.id === 'string' ? { id: response.id } : {}),
            ...(typeof response.model === 'string' ? { model: response.model } : {}),
            ...(typeof response.created_at === 'number' ? { createdAt: response.created_at } : {}),
          });
        }
        if (response.usage && typeof response.usage === 'object') {
          events.push({ type: 'response.usage', usage: responsesUsageFromWire(response.usage) });
        }
      }
      if (type === 'response.failed') {
        const error = record(response.error);
        const message = typeof error.message === 'string' ? error.message : 'error';
        events.push({
          type: 'response.failed',
          reason: message,
          ...(response.error && typeof response.error === 'object'
            ? { error: { ...(typeof error.code === 'string' ? { code: error.code } : {}), message } }
            : {}),
        });
      } else if (type === 'response.incomplete') {
        const wireReason = record(response.incomplete_details).reason;
        events.push({
          type: 'response.incomplete',
          reason: wireReason === 'content_filter' ? 'content_filter' : wireReason === 'max_output_tokens' ? 'length' : wireReason,
        });
      } else {
        events.push({ type: 'response.completed' });
      }
      return events;
    }
    if (type === 'response.error' || type === 'error') {
      this.nativeTerminal = true;
      this.terminalSent = true;
      const error = record(frame.error ?? frame);
      return [{ type: 'error', code: error.code, message: String(error.message ?? 'Responses stream failed.') }];
    }
    if (type === 'response.in_progress' || type === 'response.queued' || type === 'ping' || BUILTIN_TOOL_PROGRESS_RE.test(type)) return [];
    return invalid(`unsupported event "${type || 'missing type'}".`);
  }

  public finish(): StreamEvent[] {
    if (this.terminalSent) return [];
    this.terminalSent = true;
    return [{ type: 'response.completed' }];
  }

  private key(index: number, partIndex: number): string {
    return `${index}:${partIndex}`;
  }
}

import crypto from 'node:crypto';
import { IrUnsupportedError } from '../errors.js';
import type {
  CanonicalResponse,
  ContentPart,
  OutputItem,
  StreamEvent,
  Usage,
} from '../types.js';
import { assertCanonicalResponseSupported, assertCanonicalStreamEventSupported } from '../validate.js';
import { responsesPartToWire, responsesToolItemId } from './openai-responses.js';

const PROTOCOL = 'openai-responses';

function shortId(prefix: string): string {
  return prefix + crypto.randomBytes(12).toString('hex');
}

export interface ResponsesEcho {
  instructions: string | null;
  metadata: Record<string, unknown> | null;
  temperature: number | null;
  top_p: number | null;
  max_output_tokens: number | null;
  tool_choice: unknown;
  parallel_tool_calls: boolean;
  previous_response_id: string | null;
  service_tier: string | null;
  tools: Record<string, unknown>[];
  text?: unknown;
  reasoning?: unknown;
  truncation?: 'auto' | 'disabled';
  background?: boolean;
  include?: string[];
  prompt?: unknown;
  conversation?: unknown;
  safety_identifier?: string | null;
}

export function defaultResponsesEcho(): ResponsesEcho {
  return {
    instructions: null,
    metadata: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    previous_response_id: null,
    service_tier: null,
    tools: [],
  };
}

export interface ResponsesStreamSequence {
  value: number;
}

export function newResponseStreamSequence(): ResponsesStreamSequence {
  return { value: 0 };
}

export function newResponseMessageId(): string {
  return shortId('msg_');
}

function responsesUsage(usage: Usage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
    ...((usage.cachedInputTokens !== undefined || usage.audioInputTokens !== undefined)
      ? {
          input_tokens_details: {
            ...(usage.cachedInputTokens !== undefined ? { cached_tokens: usage.cachedInputTokens } : {}),
            ...(usage.audioInputTokens !== undefined ? { audio_tokens: usage.audioInputTokens } : {}),
          },
        }
      : {}),
    ...((usage.reasoningTokens !== undefined || usage.audioOutputTokens !== undefined ||
      usage.acceptedPredictionTokens !== undefined || usage.rejectedPredictionTokens !== undefined)
      ? {
          output_tokens_details: {
            ...(usage.reasoningTokens !== undefined ? { reasoning_tokens: usage.reasoningTokens } : {}),
            ...(usage.audioOutputTokens !== undefined ? { audio_tokens: usage.audioOutputTokens } : {}),
            ...(usage.acceptedPredictionTokens !== undefined
              ? { accepted_prediction_tokens: usage.acceptedPredictionTokens } : {}),
            ...(usage.rejectedPredictionTokens !== undefined
              ? { rejected_prediction_tokens: usage.rejectedPredictionTokens } : {}),
          },
        }
      : {}),
  };
}

function outputPartToWire(part: ContentPart): Record<string, unknown> {
  return responsesPartToWire(part, 'assistant');
}

function outputItemToWire(item: OutputItem, messageId?: string): Record<string, unknown> {
  if (item.type === 'message') {
    return {
      type: 'message',
      id: item.id ?? messageId ?? shortId('msg_'),
      status: item.status ?? 'completed',
      role: 'assistant',
      content: item.content.map(outputPartToWire),
    };
  }
  if (item.type === 'tool_call') {
    const custom = item.vendor?.[PROTOCOL]?.itemType === 'custom_tool_call';
    return {
      type: custom ? 'custom_tool_call' : 'function_call',
      id: responsesToolItemId(item.id || shortId(custom ? 'ctc_' : 'fc_'), custom),
      call_id: item.callId ?? item.id,
      name: item.name,
      ...(custom ? { input: item.arguments } : { arguments: item.arguments }),
      status: item.status ?? 'completed',
    };
  }
  if (item.type === 'reasoning') {
    return {
      type: 'reasoning',
      id: item.id ?? shortId('rs_'),
      status: item.status ?? 'completed',
      summary: item.summary?.map((text) => ({ type: 'summary_text', text })) ?? [],
      ...(item.text ? { content: [{ type: 'reasoning_text', text: item.text }] } : {}),
      ...(item.signature ? { signature: item.signature } : {}),
      ...(item.encrypted ? { encrypted_content: item.encrypted } : {}),
    };
  }
  if (item.protocol !== PROTOCOL) {
    throw new IrUnsupportedError('output_item', `Cannot convert ${item.protocol} output to Responses.`, PROTOCOL);
  }
  return item.payload as Record<string, unknown>;
}

export function canonicalToResponsesObject(
  response: CanonicalResponse,
  ids: { respId: string; messageId?: string },
  model: string,
  store = true,
  echo: ResponsesEcho = defaultResponsesEcho(),
): Record<string, unknown> {
  assertCanonicalResponseSupported(response, PROTOCOL);
  const incompleteReason = response.status === 'incomplete'
    ? response.reason === 'content_filter' ? 'content_filter' : 'max_output_tokens'
    : null;
  return {
    id: ids.respId,
    object: 'response',
    created_at: response.createdAt ?? Math.floor(Date.now() / 1000),
    status: response.status,
    error: response.error ?? null,
    incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
    instructions: echo.instructions,
    metadata: echo.metadata,
    model,
    output: response.output.map((item, index) => outputItemToWire(item, index === 0 ? ids.messageId : undefined)),
    parallel_tool_calls: echo.parallel_tool_calls,
    temperature: echo.temperature,
    tool_choice: echo.tool_choice,
    tools: echo.tools,
    top_p: echo.top_p,
    max_output_tokens: echo.max_output_tokens,
    previous_response_id: response.previousResponseId ?? echo.previous_response_id,
    service_tier: response.serviceTier ?? echo.service_tier,
    store,
    text: echo.text ?? { format: { type: 'text' } },
    reasoning: echo.reasoning ?? null,
    truncation: echo.truncation ?? 'disabled',
    background: echo.background ?? false,
    include: echo.include ?? [],
    prompt: echo.prompt ?? null,
    conversation: echo.conversation ?? null,
    safety_identifier: echo.safety_identifier ?? null,
    usage: responsesUsage(response.usage),
  };
}

export function responsesEventFrame(payload: Record<string, unknown>): string {
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** One stateful encoder per Responses client stream. */
export class OpenAIResponsesEventEncoder {
  private readonly itemIds = new Map<number, string>();
  private readonly customItems = new Set<number>();
  private terminal = false;

  public constructor(
    private readonly respId: string,
    private readonly messageId: string,
    private readonly seq: ResponsesStreamSequence,
    private readonly store: boolean,
    private readonly echo: ResponsesEcho,
  ) {}

  public encode(event: StreamEvent, model: string, finalResponse?: CanonicalResponse): Record<string, unknown>[] {
    assertCanonicalStreamEventSupported(event, PROTOCOL);
    if ((event.candidateIndex ?? 0) !== 0) return [];
    if (event.type === 'response.created') {
      const response = this.responseObject(finalResponse, model, 'in_progress', true);
      return [this.sequenced({ type: 'response.created', response }), this.sequenced({ type: 'response.in_progress', response })];
    }
    if (event.type === 'response.output_item.added') {
      const item = this.item(event.index, event.item, true);
      return [this.sequenced({ type: 'response.output_item.added', output_index: event.index, item })];
    }
    if (event.type === 'response.content_part.added') {
      const openingPart: ContentPart = event.part.type === 'text'
        ? { ...event.part, text: '', ...(event.part.annotations ? { annotations: [] } : {}) }
        : event.part.type === 'refusal'
          ? { ...event.part, text: '' }
          : event.part;
      return [this.sequenced({
        type: 'response.content_part.added', item_id: this.itemId(event.index), output_index: event.index,
        content_index: event.partIndex, part: outputPartToWire(openingPart),
      })];
    }
    if (event.type === 'response.output_text.delta') {
      return [this.sequenced({
        type: 'response.output_text.delta', item_id: this.itemId(event.index), output_index: event.index,
        content_index: event.partIndex, delta: event.text,
      })];
    }
    if (event.type === 'response.output_text.done') {
      return [this.sequenced({
        type: 'response.output_text.done', item_id: this.itemId(event.index), output_index: event.index,
        content_index: event.partIndex, text: event.text,
      })];
    }
    if (event.type === 'response.output_text.annotation.added') {
      const annotations = outputPartToWire({ type: 'text', text: '', annotations: [event.annotation] }).annotations;
      return [this.sequenced({
        type: 'response.output_text.annotation.added', item_id: this.itemId(event.index), output_index: event.index,
        content_index: event.partIndex, annotation_index: event.annotationIndex,
        annotation: Array.isArray(annotations) ? annotations[0] : annotations,
      })];
    }
    if (event.type === 'response.refusal.delta') {
      return [this.sequenced({
        type: 'response.refusal.delta', item_id: this.itemId(event.index), output_index: event.index,
        content_index: event.partIndex, delta: event.text,
      })];
    }
    if (event.type === 'response.refusal.done') {
      return [this.sequenced({
        type: 'response.refusal.done', item_id: this.itemId(event.index), output_index: event.index,
        content_index: event.partIndex, refusal: event.text,
      })];
    }
    if (event.type === 'response.reasoning.delta') {
      return [this.sequenced({
        type: 'response.reasoning_text.delta', item_id: this.itemId(event.index), output_index: event.index,
        content_index: 0, delta: event.text,
      })];
    }
    if (event.type === 'response.reasoning.done') {
      return [this.sequenced({
        type: 'response.reasoning_text.done', item_id: this.itemId(event.index), output_index: event.index,
        content_index: 0, text: event.text,
      })];
    }
    if (event.type === 'response.reasoning_summary_part.added') {
      return [this.sequenced({
        type: 'response.reasoning_summary_part.added', item_id: this.itemId(event.index), output_index: event.index,
        summary_index: event.summaryIndex, part: { type: 'summary_text', text: '' },
      })];
    }
    if (event.type === 'response.reasoning_summary.delta') {
      return [this.sequenced({
        type: 'response.reasoning_summary_text.delta', item_id: this.itemId(event.index), output_index: event.index,
        summary_index: event.summaryIndex, delta: event.text,
      })];
    }
    if (event.type === 'response.reasoning_summary.done') {
      return [
        this.sequenced({
          type: 'response.reasoning_summary_text.done', item_id: this.itemId(event.index), output_index: event.index,
          summary_index: event.summaryIndex, text: event.text,
        }),
        this.sequenced({
          type: 'response.reasoning_summary_part.done', item_id: this.itemId(event.index), output_index: event.index,
          summary_index: event.summaryIndex, part: { type: 'summary_text', text: event.text },
        }),
      ];
    }
    if (event.type === 'response.function_call.arguments.delta') {
      const custom = this.isCustom(event.index);
      return [this.sequenced({
        type: custom ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta',
        item_id: this.itemId(event.index), output_index: event.index, delta: event.argumentsDelta,
      })];
    }
    if (event.type === 'response.function_call.arguments.done') {
      const custom = this.isCustom(event.index);
      return [this.sequenced({
        type: custom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done',
        item_id: this.itemId(event.index), output_index: event.index,
        ...(custom ? { input: event.arguments } : { arguments: event.arguments }),
      })];
    }
    if (event.type === 'response.content_part.done') {
      return [this.sequenced({
        type: 'response.content_part.done', item_id: this.itemId(event.index), output_index: event.index,
        content_index: event.partIndex, part: outputPartToWire(event.part),
      })];
    }
    if (event.type === 'response.output_item.done') {
      return [this.sequenced({
        type: 'response.output_item.done', output_index: event.index, item: this.item(event.index, event.item, false),
      })];
    }
    if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      if (!finalResponse || this.terminal) return [];
      this.terminal = true;
      return [this.sequenced({
        type: event.type,
        response: this.responseObject(finalResponse, model, finalResponse.status, false),
      })];
    }
    if (event.type === 'error') {
      if (this.terminal) return [];
      this.terminal = true;
      const failed: CanonicalResponse = {
        status: 'failed', reason: 'error', output: [],
        usage: { inputTokens: 0, outputTokens: 0 }, error: { code: event.code, message: event.message },
      };
      return [this.sequenced({ type: 'response.failed', response: this.responseObject(failed, model, 'failed', false) })];
    }
    return [];
  }

  private itemId(index: number, item?: OutputItem): string {
    const existing = this.itemIds.get(index);
    if (existing) return existing;
    if (!item) {
      throw new IrUnsupportedError('stream_lifecycle', `Responses stream references unopened output item ${index}.`, PROTOCOL);
    }
    const sourceId = 'id' in item && typeof item.id === 'string' ? item.id : undefined;
    const custom = item.type === 'tool_call' && item.vendor?.[PROTOCOL]?.itemType === 'custom_tool_call';
    const id = item.type === 'tool_call' && sourceId !== undefined
      ? responsesToolItemId(sourceId, custom)
      : sourceId ?? (item.type === 'message' && index === 0 ? this.messageId : undefined)
        ?? shortId(item.type === 'message' ? 'msg_' : item.type === 'reasoning' ? 'rs_'
          : custom ? 'ctc_' : 'fc_');
    this.itemIds.set(index, id);
    return id;
  }

  private item(index: number, source: OutputItem, opening: boolean): Record<string, unknown> {
    if (source.type === 'tool_call' && source.vendor?.[PROTOCOL]?.itemType === 'custom_tool_call') {
      this.customItems.add(index);
    }
    const wire = outputItemToWire(source, this.itemId(index, source));
    wire.id = this.itemId(index, source);
    if (opening) {
      wire.status = 'in_progress';
      if (source.type === 'message') wire.content = [];
      if (source.type === 'tool_call') {
        if (wire.type === 'custom_tool_call') wire.input = '';
        else wire.arguments = '';
      }
      if (source.type === 'reasoning') {
        wire.summary = [];
        delete wire.content;
      }
    }
    return wire;
  }

  private isCustom(index: number): boolean {
    return this.customItems.has(index);
  }

  private responseObject(
    response: CanonicalResponse | undefined,
    model: string,
    status: CanonicalResponse['status'] | 'in_progress',
    opening: boolean,
  ): Record<string, unknown> {
    const base: CanonicalResponse = response ?? {
      status: 'completed', output: [], usage: { inputTokens: 0, outputTokens: 0 },
    };
    const object = canonicalToResponsesObject(base, {
      respId: this.respId, messageId: this.messageId,
    }, model, this.store, this.echo);
    object.status = status;
    if (opening) object.output = [];
    else if (Array.isArray(object.output)) {
      object.output.forEach((item: Record<string, unknown>, index: number) => {
        const id = this.itemIds.get(index);
        if (id) item.id = id;
      });
    }
    return object;
  }

  private sequenced(payload: Record<string, unknown>): Record<string, unknown> {
    return { sequence_number: this.seq.value++, ...payload };
  }
}

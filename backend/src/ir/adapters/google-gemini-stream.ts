import crypto from 'node:crypto';
import type { ContentPart, OutputItem, StreamEvent, Usage } from '../types.js';
import { IrUpstreamError } from '../errors.js';
import { googleUsageFromWire } from './google-gemini.js';
import { upstreamToolCallId } from '../tool-identity.js';

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function invalid(message: string): never {
  throw new IrUpstreamError(`Invalid Gemini stream: ${message}`);
}

type ActiveItem = {
  kind: 'text' | 'reasoning';
  itemIndex: number;
  item: Extract<OutputItem, { type: 'message' | 'reasoning' }>;
  part?: Extract<ContentPart, { type: 'text' }>;
};

type CandidateState = {
  nextItem: number;
  active?: ActiveItem;
  metadata?: Record<string, unknown>;
  finishReason?: string;
};

/** Gemini streamGenerateContent chunks → canonical item lifecycle events. */
export class GoogleGeminiStreamDecoder {
  private readonly candidates = new Map<number, CandidateState>();
  private readonly id = `google-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private createdSent = false;
  private nativeTerminal = false;
  private terminalSent = false;
  private blockedReason: string | undefined;

  public get terminated(): boolean {
    if (this.nativeTerminal) return true;
    return this.candidates.size > 0 && [...this.candidates.values()].every((candidate) => candidate.finishReason !== undefined);
  }

  public push(raw: unknown): StreamEvent[] {
    const body = record(raw);
    const events: StreamEvent[] = [];
    this.ensureCreated(body, events);
    if (body.usageMetadata) {
      const usage: Usage = googleUsageFromWire(body.usageMetadata);
      events.push({ type: 'response.usage', usage });
    }
    if (body.error) {
      this.nativeTerminal = true;
      this.terminalSent = true;
      const error = record(body.error);
      events.push({ type: 'error', code: error.status ?? error.code, message: String(error.message ?? 'Gemini stream failed.') });
      return events;
    }
    const feedback = record(body.promptFeedback);
    if (feedback.blockReason) {
      this.blockedReason = String(feedback.blockReason);
      this.nativeTerminal = true;
      this.terminalSent = true;
      events.push({ type: 'response.incomplete', reason: 'content_filter' });
      return events;
    }
    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    candidates.forEach((rawCandidate, position) => {
      const candidate = record(rawCandidate);
      const candidateIndex = typeof candidate.index === 'number' ? candidate.index : position;
      const state = this.state(candidateIndex);
      if (state.finishReason !== undefined) invalid(`candidate ${candidateIndex} continued after finishReason.`);
      const seenKinds = new Set<string>();
      const parts = Array.isArray(record(candidate.content).parts) ? record(candidate.content).parts : [];
      for (const rawPart of parts) {
        const part = record(rawPart);
        if (typeof part.text === 'string') {
          const kind = part.thought === true ? 'reasoning' : 'text';
          if (state.active?.kind !== kind || seenKinds.has(kind)) events.push(...this.closeActive(candidateIndex, state));
          seenKinds.add(kind);
          if (kind === 'reasoning') this.reasoningDelta(candidateIndex, state, part, events);
          else this.textDelta(candidateIndex, state, part, events);
          continue;
        }
        events.push(...this.closeActive(candidateIndex, state));
        if (part.functionCall) {
          const call = record(part.functionCall);
          const itemIndex = state.nextItem++;
          // One mint namespace with the buffered Gemini reader (`google-gemini.ts`), which also
          // has no correlation field to read. A response-scoped composite (`<id>:call:<c>:<i>`)
          // was a fourth spelling of the same idea, and its `:` is outside the charset both
          // Responses id fields share, so a Gemini call converted to Responses was rewritten by
          // the digest instead of passing through.
          const id = upstreamToolCallId(typeof call.id === 'string' ? call.id : undefined);
          const item: OutputItem = {
            type: 'tool_call', id, callId: id,
            name: String(call.name ?? ''), arguments: JSON.stringify(call.args ?? {}),
            ...(typeof part.thoughtSignature === 'string' ? { signature: part.thoughtSignature } : {}),
          };
          events.push(
            { type: 'response.output_item.added', candidateIndex, index: itemIndex, item: { ...item, arguments: '' } },
            { type: 'response.function_call.arguments.delta', candidateIndex, index: itemIndex, argumentsDelta: item.arguments },
            { type: 'response.function_call.arguments.done', candidateIndex, index: itemIndex, arguments: item.arguments },
            { type: 'response.output_item.done', candidateIndex, index: itemIndex, item: { ...item } },
          );
          continue;
        }
        const inline = record(part.inlineData);
        if (typeof inline.data === 'string') {
          const mediaType = typeof inline.mimeType === 'string' ? inline.mimeType : 'application/octet-stream';
          const kind = mediaType.startsWith('image/') ? 'image' : mediaType.startsWith('audio/') ? 'audio' : 'file';
          const content = {
            type: kind,
            source: { kind: 'base64', mediaType, data: inline.data },
            ...(typeof part.thoughtSignature === 'string' ? { signature: part.thoughtSignature } : {}),
          } as ContentPart;
          this.completeMessagePart(candidateIndex, state, content, events);
          continue;
        }
        const item: OutputItem = { type: 'extension', protocol: 'google-gemini', payload: rawPart };
        const itemIndex = state.nextItem++;
        events.push(
          { type: 'response.output_item.added', candidateIndex, index: itemIndex, item },
          { type: 'response.output_item.done', candidateIndex, index: itemIndex, item },
        );
      }
      if (candidate.groundingMetadata !== undefined || candidate.logprobsResult !== undefined) {
        state.metadata = {
          type: 'candidate_metadata',
          ...(candidate.groundingMetadata !== undefined ? { groundingMetadata: candidate.groundingMetadata } : {}),
          ...(candidate.logprobsResult !== undefined ? { logprobsResult: candidate.logprobsResult } : {}),
        };
      }
      if (typeof candidate.finishReason === 'string') {
        events.push(...this.closeActive(candidateIndex, state));
        events.push(...this.emitMetadata(candidateIndex, state));
        state.finishReason = candidate.finishReason;
      }
    });
    return events;
  }

  public finish(): StreamEvent[] {
    if (this.terminalSent) return [];
    this.terminalSent = true;
    if (this.blockedReason) return [{ type: 'response.incomplete', reason: 'content_filter' }];
    const events: StreamEvent[] = [];
    for (const [candidateIndex, state] of [...this.candidates.entries()].sort(([a], [b]) => a - b)) {
      events.push(...this.closeActive(candidateIndex, state));
      events.push(...this.emitMetadata(candidateIndex, state));
    }
    const primary = this.candidates.get(0) ?? [...this.candidates.entries()].sort(([a], [b]) => a - b)[0]?.[1];
    const reason = this.reason(primary?.finishReason);
    events.push(reason === 'length' || reason === 'content_filter'
      ? { type: 'response.incomplete', reason }
      : { type: 'response.completed' });
    return events;
  }

  private textDelta(candidateIndex: number, state: CandidateState, part: Record<string, any>, events: StreamEvent[]): void {
    let active = state.active;
    if (active?.kind !== 'text') {
      const itemIndex = state.nextItem++;
      const content: Extract<ContentPart, { type: 'text' }> = { type: 'text', text: '' };
      const item: Extract<OutputItem, { type: 'message' }> = {
        type: 'message', id: `${this.id}:item:${candidateIndex}:${itemIndex}`,
        role: 'assistant', content: [content],
      };
      active = { kind: 'text', itemIndex, item, part: content };
      state.active = active;
      events.push(
        { type: 'response.output_item.added', candidateIndex, index: itemIndex, item: { ...item, content: [] } },
        { type: 'response.content_part.added', candidateIndex, index: itemIndex, partIndex: 0, part: { type: 'text', text: '' } },
      );
    }
    const content = active.part!;
    content.text += part.text;
    if (typeof part.thoughtSignature === 'string') content.signature = part.thoughtSignature;
    if (part.text) {
      events.push({
        type: 'response.output_text.delta', candidateIndex, index: active.itemIndex, partIndex: 0, text: part.text,
      });
    }
  }

  private reasoningDelta(candidateIndex: number, state: CandidateState, part: Record<string, any>, events: StreamEvent[]): void {
    let active = state.active;
    if (active?.kind !== 'reasoning') {
      const itemIndex = state.nextItem++;
      const item: Extract<OutputItem, { type: 'reasoning' }> = { type: 'reasoning', id: `${this.id}:reasoning:${candidateIndex}:${itemIndex}`, text: '' };
      active = { kind: 'reasoning', itemIndex, item };
      state.active = active;
      events.push({ type: 'response.output_item.added', candidateIndex, index: itemIndex, item: { ...item, text: '' } });
    }
    if (active.item.type !== 'reasoning') invalid('internal reasoning item mismatch.');
    active.item.text = (active.item.text ?? '') + part.text;
    if (typeof part.thoughtSignature === 'string') active.item.signature = part.thoughtSignature;
    if (part.text) {
      events.push({ type: 'response.reasoning.delta', candidateIndex, index: active.itemIndex, text: part.text });
    }
  }

  private completeMessagePart(candidateIndex: number, state: CandidateState, part: ContentPart, events: StreamEvent[]): void {
    const itemIndex = state.nextItem++;
    const item: OutputItem = {
      type: 'message', id: `${this.id}:item:${candidateIndex}:${itemIndex}`,
      role: 'assistant', content: [part],
    };
    events.push(
      { type: 'response.output_item.added', candidateIndex, index: itemIndex, item: { ...item, content: [] } },
      { type: 'response.content_part.added', candidateIndex, index: itemIndex, partIndex: 0, part: { ...part } },
      { type: 'response.content_part.done', candidateIndex, index: itemIndex, partIndex: 0, part: { ...part } },
      { type: 'response.output_item.done', candidateIndex, index: itemIndex, item: { ...item, content: [{ ...part }] } },
    );
  }

  private closeActive(candidateIndex: number, state: CandidateState): StreamEvent[] {
    const active = state.active;
    if (!active) return [];
    state.active = undefined;
    const index = active.itemIndex;
    if (active.kind === 'reasoning' && active.item.type === 'reasoning') {
      return [
        { type: 'response.reasoning.done', candidateIndex, index, text: active.item.text ?? '' },
        { type: 'response.output_item.done', candidateIndex, index, item: { ...active.item } },
      ];
    }
    if (active.kind === 'text' && active.part && active.item.type === 'message') {
      const partSnapshot: Extract<ContentPart, { type: 'text' }> = {
        ...active.part,
        ...(active.part.annotations ? { annotations: [...active.part.annotations] } : {}),
      };
      return [
        {
          type: 'response.output_text.done', candidateIndex, index, partIndex: 0, text: active.part.text,
          ...(active.part.annotations ? { annotations: [...active.part.annotations] } : {}),
        },
        { type: 'response.content_part.done', candidateIndex, index, partIndex: 0, part: partSnapshot },
        { type: 'response.output_item.done', candidateIndex, index, item: { ...active.item, content: [partSnapshot] } },
      ];
    }
    return [];
  }

  private emitMetadata(candidateIndex: number, state: CandidateState): StreamEvent[] {
    if (!state.metadata) return [];
    const item: OutputItem = { type: 'extension', protocol: 'google-gemini', payload: state.metadata };
    state.metadata = undefined;
    const index = state.nextItem++;
    return [
      { type: 'response.output_item.added', candidateIndex, index, item },
      { type: 'response.output_item.done', candidateIndex, index, item },
    ];
  }

  private ensureCreated(body: Record<string, any>, events: StreamEvent[]): void {
    if (this.createdSent) return;
    this.createdSent = true;
    events.push({
      type: 'response.created',
      id: typeof body.responseId === 'string' ? body.responseId : this.id,
      ...(typeof body.modelVersion === 'string' ? { model: body.modelVersion } : {}),
      createdAt: this.createdAt,
    });
  }

  private state(index: number): CandidateState {
    let state = this.candidates.get(index);
    if (!state) {
      state = { nextItem: 0 };
      this.candidates.set(index, state);
    }
    return state;
  }

  private reason(finishReason: string | undefined): string {
    if (finishReason === 'MAX_TOKENS') return 'length';
    if (finishReason === 'SAFETY' || finishReason === 'RECITATION' || finishReason === 'PROHIBITED_CONTENT') return 'content_filter';
    return 'stop';
  }
}

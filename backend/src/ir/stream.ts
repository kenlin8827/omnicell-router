/**
 * Vendor-neutral stream helpers over the canonical IR event lifecycle.
 *
 * Chat Completions codecs (`ChatStreamDecoder` / `ChatEventEncoder`) live in
 * `ir/adapters/openai-chat-stream.ts` — they are an explicit Chat boundary (ADR-0033),
 * not part of this neutral core.
 */
import type { CanonicalCandidate, CanonicalResponse, OutputItem, StreamEvent, Usage } from './types.js';

const ACCUMULATE_MAX_CHARS = 32 * 1024 * 1024;

/** Accumulate canonical events for accounting while relaying the same objects. */
export function createEventAccumulator(options: { maxChars?: number } = {}): {
  push(event: StreamEvent): void;
  finish(): CanonicalResponse;
} {
  const maxChars = options.maxChars ?? ACCUMULATE_MAX_CHARS;
  let chars = 0;
  const chargedByItem = new Map<string, number>();
  const chargeCount = (count: number): void => {
    if (count <= 0) return;
    chars += count;
    if (chars > maxChars) throw new Error(`Upstream stream exceeded the accumulation cap (${maxChars} characters).`);
  };
  const chargeItem = (itemKey: string, text: string): void => {
    if (!text) return;
    chargedByItem.set(itemKey, (chargedByItem.get(itemKey) ?? 0) + text.length);
    chargeCount(text.length);
  };
  let id: string | undefined;
  let model: string | undefined;
  let createdAt: number | undefined;
  let systemFingerprint: string | undefined;
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let status: CanonicalResponse['status'] = 'completed';
  let reason: string | undefined;
  let error: CanonicalResponse['error'];
  const candidates = new Map<number, { items: Map<number, OutputItem> }>();
  const state = (index = 0) => {
    let value = candidates.get(index);
    if (!value) {
      value = { items: new Map() };
      candidates.set(index, value);
    }
    return value;
  };
  return {
    push(event): void {
      if (event.type === 'response.created') {
        id = event.id ?? id;
        model = event.model ?? model;
        createdAt = event.createdAt ?? createdAt;
        systemFingerprint = event.systemFingerprint ?? systemFingerprint;
        return;
      }
      if (event.type === 'response.usage') {
        usage = event.usage;
        return;
      }
      if (event.type === 'response.completed') { status = 'completed'; return; }
      if (event.type === 'response.incomplete') { status = 'incomplete'; reason = event.reason; return; }
      if (event.type === 'response.failed' || event.type === 'error') {
        status = 'failed';
        reason = event.type === 'error' ? event.message : event.reason;
        if (event.type === 'error') {
          error = { ...(event.code ? { code: event.code } : {}), message: event.message };
        } else if (event.error) {
          error = event.error;
        }
        return;
      }
      const candidateIndex = event.candidateIndex ?? 0;
      const candidate = state(candidateIndex);
      const itemKey = `${candidateIndex}:${event.index}`;
      if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
        const stored = event.type.endsWith('added')
          ? { ...event.item, ...(event.item.type === 'message' ? { content: event.item.content.map((part) => ({ ...part })) } : {}) }
          : event.item;
        if (event.type === 'response.output_item.done') {
          let doneChars = 0;
          if (stored.type === 'message') {
            for (const p of stored.content) {
              if (p.type === 'text' || p.type === 'refusal') doneChars += p.text.length;
            }
          } else if (stored.type === 'reasoning') {
            if (stored.text) doneChars += stored.text.length;
            for (const s of stored.summary ?? []) doneChars += s.length;
          } else if (stored.type === 'tool_call') {
            doneChars += stored.arguments.length;
          }
          const alreadyCharged = chargedByItem.get(itemKey) ?? 0;
          if (doneChars > alreadyCharged) {
            chargedByItem.set(itemKey, doneChars);
            chargeCount(doneChars - alreadyCharged);
          }
        }
        candidate.items.set(event.index, stored);
        return;
      }
      const item = candidate.items.get(event.index);
      // Lifecycle deltas without a prior output_item.added used to no-op and
      // finish() as completed with empty output — silent prompt/accounting loss.
      if (!item) {
        throw new Error(
          `Canonical stream event '${event.type}' referenced output item ${event.index} before response.output_item.added.`,
        );
      }
      if (event.type === 'response.content_part.added' && item.type === 'message') {
        item.content[event.partIndex] = { ...event.part };
      } else if (event.type === 'response.output_text.annotation.added' && item.type === 'message') {
        const part = item.content[event.partIndex];
        if (part?.type === 'text') {
          part.annotations ??= [];
          part.annotations.push(event.annotation);
        }
      } else if (event.type === 'response.output_text.delta' && item.type === 'message') {
        const part = item.content[event.partIndex];
        if (part?.type === 'text') { part.text += event.text; chargeItem(itemKey, event.text); }
      } else if (event.type === 'response.refusal.delta' && item.type === 'message') {
        const part = item.content[event.partIndex];
        if (part?.type === 'refusal') { part.text += event.text; chargeItem(itemKey, event.text); }
      } else if (event.type === 'response.reasoning.delta' && item.type === 'reasoning') {
        item.text = (item.text ?? '') + event.text;
        chargeItem(itemKey, event.text);
      } else if (event.type === 'response.reasoning_summary.delta' && item.type === 'reasoning') {
        item.summary ??= [];
        item.summary[event.summaryIndex] = (item.summary[event.summaryIndex] ?? '') + event.text;
        chargeItem(itemKey, event.text);
      } else if (event.type === 'response.function_call.arguments.delta' && item.type === 'tool_call') {
        item.arguments += event.argumentsDelta;
        chargeItem(itemKey, event.argumentsDelta);
      }
    },
    finish(): CanonicalResponse {
      const all: CanonicalCandidate[] = [...candidates.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, candidate]) => ({
          index,
          status: status === 'failed' ? 'failed' : status === 'incomplete' ? 'incomplete' : 'completed',
          ...(reason ? { reason } : {}),
          output: [...candidate.items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item),
        }));
      const primary = all.find((candidate) => candidate.index === 0) ?? all[0];
      return {
        ...(id ? { id } : {}), ...(model ? { model } : {}), ...(createdAt ? { createdAt } : {}),
        status, ...(reason ? { reason } : {}), ...(error ? { error } : {}), output: primary?.output ?? [],
        ...(all.length > 1 ? { candidates: all } : {}), usage,
        ...(systemFingerprint ? { systemFingerprint } : {}),
      };
    },
  };
}

/** Buffered IR → the common synthetic stream, used only when no native relay exists. */
export function canonicalResponseToEvents(response: CanonicalResponse): StreamEvent[] {
  const candidates = response.candidates?.length ? response.candidates : [{
    index: 0, status: response.status, ...(response.reason ? { reason: response.reason } : {}), output: response.output,
  }];
  const events: StreamEvent[] = [{
    type: 'response.created', id: response.id, model: response.model, createdAt: response.createdAt,
    ...(response.systemFingerprint ? { systemFingerprint: response.systemFingerprint } : {}),
  }];
  for (const candidate of candidates) {
    for (let index = 0; index < candidate.output.length; index++) {
      const item = candidate.output[index]!;
      const addedItem: OutputItem = item.type === 'message'
        ? { ...item, content: [] }
        : item.type === 'reasoning'
          ? {
            ...item,
            ...(item.text !== undefined ? { text: '' } : {}),
            ...(item.summary !== undefined ? { summary: [] } : {}),
          }
          : item.type === 'tool_call'
            ? { ...item, arguments: '' }
            : item;
      events.push({ type: 'response.output_item.added', candidateIndex: candidate.index, index, item: addedItem });
      if (item.type === 'message') {
        for (let partIndex = 0; partIndex < item.content.length; partIndex++) {
          const part = item.content[partIndex]!;
          const addedPart = part.type === 'text'
            ? { ...part, text: '', ...(part.annotations ? { annotations: [] } : {}) }
            : part.type === 'refusal'
              ? { ...part, text: '' }
              : part;
          events.push({ type: 'response.content_part.added', candidateIndex: candidate.index, index, partIndex, part: addedPart });
          if (part.type === 'text') {
            if (part.text) events.push({ type: 'response.output_text.delta', candidateIndex: candidate.index, index, partIndex, text: part.text });
            part.annotations?.forEach((annotation, annotationIndex) => events.push({
              type: 'response.output_text.annotation.added', candidateIndex: candidate.index, index, partIndex, annotationIndex, annotation,
            }));
            events.push({
              type: 'response.output_text.done', candidateIndex: candidate.index, index, partIndex, text: part.text,
              ...(part.annotations ? { annotations: part.annotations } : {}),
            });
          }
          if (part.type === 'refusal') {
            if (part.text) events.push({ type: 'response.refusal.delta', candidateIndex: candidate.index, index, partIndex, text: part.text });
            events.push({ type: 'response.refusal.done', candidateIndex: candidate.index, index, partIndex, text: part.text });
          }
          events.push({ type: 'response.content_part.done', candidateIndex: candidate.index, index, partIndex, part });
        }
      } else if (item.type === 'reasoning') {
        for (let summaryIndex = 0; summaryIndex < (item.summary?.length ?? 0); summaryIndex++) {
          const text = item.summary![summaryIndex]!;
          events.push({ type: 'response.reasoning_summary_part.added', candidateIndex: candidate.index, index, summaryIndex });
          if (text) events.push({ type: 'response.reasoning_summary.delta', candidateIndex: candidate.index, index, summaryIndex, text });
          events.push({ type: 'response.reasoning_summary.done', candidateIndex: candidate.index, index, summaryIndex, text });
        }
        if (item.text !== undefined) {
          if (item.text) events.push({ type: 'response.reasoning.delta', candidateIndex: candidate.index, index, text: item.text });
          events.push({ type: 'response.reasoning.done', candidateIndex: candidate.index, index, text: item.text });
        }
      } else if (item.type === 'tool_call') {
        events.push({ type: 'response.function_call.arguments.delta', candidateIndex: candidate.index, index, argumentsDelta: item.arguments });
        events.push({ type: 'response.function_call.arguments.done', candidateIndex: candidate.index, index, arguments: item.arguments });
      }
      events.push({ type: 'response.output_item.done', candidateIndex: candidate.index, index, item });
    }
  }
  events.push({ type: 'response.usage', usage: response.usage });
  events.push(response.status === 'failed'
    ? {
      type: 'response.failed',
      ...(response.reason ? { reason: response.reason } : {}),
      ...(response.error ? { error: response.error } : {}),
    }
    : response.status === 'incomplete'
      ? { type: 'response.incomplete', reason: response.reason }
      : { type: 'response.completed' });
  return events;
}

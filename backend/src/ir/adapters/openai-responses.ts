import crypto from 'node:crypto';
import type { ModelRegistration } from '../../config/types.js';
import { IrUnsupportedError } from '../errors.js';
import { DATA_URL_RE } from '../media.js';
import type {
  Annotation,
  CanonicalRequest,
  CanonicalResponse,
  ContentPart,
  InputItem,
  OutputItem,
  ToolDef,
  Usage,
} from '../types.js';
import { assertCanonicalRequestSupported } from '../validate.js';

const PROTOCOL = 'openai-responses' as const;

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function dataUrl(mediaType: string, data: string): string {
  return `data:${mediaType};base64,${data}`;
}

function annotationFromWire(raw: unknown): Annotation {
  const a = record(raw);
  if (a.type === 'url_citation' && typeof a.url === 'string') {
    return {
      type: 'url_citation', url: a.url,
      ...(typeof a.title === 'string' ? { title: a.title } : {}),
      ...(typeof a.start_index === 'number' ? { startIndex: a.start_index } : {}),
      ...(typeof a.end_index === 'number' ? { endIndex: a.end_index } : {}),
    };
  }
  if (a.type === 'file_citation' && typeof a.file_id === 'string') {
    return {
      type: 'file_citation', fileId: a.file_id,
      ...(typeof a.filename === 'string' ? { filename: a.filename } : {}),
      ...(typeof a.index === 'number' ? { index: a.index } : {}),
    };
  }
  if (a.type === 'file_path' && typeof a.file_id === 'string') {
    return { type: 'file_path', fileId: a.file_id, ...(typeof a.index === 'number' ? { index: a.index } : {}) };
  }
  return { type: 'extension', protocol: PROTOCOL, payload: raw };
}

function annotationToWire(annotation: Annotation): Record<string, unknown> {
  switch (annotation.type) {
    case 'url_citation':
      return {
        type: 'url_citation', url: annotation.url,
        ...(annotation.title !== undefined ? { title: annotation.title } : {}),
        ...(annotation.startIndex !== undefined ? { start_index: annotation.startIndex } : {}),
        ...(annotation.endIndex !== undefined ? { end_index: annotation.endIndex } : {}),
      };
    case 'file_citation':
      return {
        type: 'file_citation', file_id: annotation.fileId,
        ...(annotation.filename !== undefined ? { filename: annotation.filename } : {}),
        ...(annotation.index !== undefined ? { index: annotation.index } : {}),
      };
    case 'file_path':
      return { type: 'file_path', file_id: annotation.fileId, ...(annotation.index !== undefined ? { index: annotation.index } : {}) };
    case 'extension':
      if (annotation.protocol !== PROTOCOL) {
        throw new IrUnsupportedError('annotation', `Cannot convert ${annotation.protocol} annotation.`, PROTOCOL);
      }
      return record(annotation.payload);
  }
}

function partFromWire(raw: unknown): ContentPart {
  const p = record(raw);
  if ((p.type === 'input_text' || p.type === 'output_text') && typeof p.text === 'string') {
    return {
      type: 'text', text: p.text,
      ...(Array.isArray(p.annotations) ? { annotations: p.annotations.map(annotationFromWire) } : {}),
      ...(Array.isArray(p.logprobs) ? { logprobs: p.logprobs } : {}),
      ...(p.prompt_cache_breakpoint ? { cache: { raw: p.prompt_cache_breakpoint } } : {}),
    };
  }
  if (p.type === 'refusal' && typeof p.refusal === 'string') return { type: 'refusal', text: p.refusal };
  if (p.type === 'input_image') {
    if (typeof p.file_id === 'string' && p.file_id) {
      return {
        type: 'image', source: { kind: 'file', fileId: p.file_id },
        ...(p.detail && p.detail !== 'original' ? { detail: p.detail } : {}),
      };
    }
    if (typeof p.image_url === 'string' && p.image_url) {
      const match = DATA_URL_RE.exec(p.image_url);
      return {
        type: 'image',
        source: match ? { kind: 'base64', mediaType: match[1]!, data: match[2]! } : { kind: 'url', url: p.image_url },
        ...(p.detail && p.detail !== 'original' ? { detail: p.detail } : {}),
      };
    }
  }
  if (p.type === 'input_file') {
    const common = { ...(typeof p.filename === 'string' ? { filename: p.filename } : {}) };
    if (typeof p.file_id === 'string' && p.file_id) {
      return { type: 'file', source: { kind: 'file', fileId: p.file_id }, ...common };
    }
    if (typeof p.file_url === 'string' && p.file_url) {
      return { type: 'file', source: { kind: 'url', url: p.file_url }, ...common };
    }
    if (typeof p.file_data === 'string' && p.file_data) {
      const match = DATA_URL_RE.exec(p.file_data);
      if (match) {
        return {
          type: 'file', source: { kind: 'base64', mediaType: match[1]!, data: match[2]! },
          ...common,
        };
      }
    }
  }
  if (p.type === 'input_image' || p.type === 'input_file') {
    fail('content_part', `Invalid ${p.type}: no supported source was provided.`);
  }
  return { type: 'extension', protocol: PROTOCOL, payload: raw };
}

export function responsesPartToWire(part: ContentPart, role: 'user' | 'assistant'): Record<string, unknown> {
  if (part.type === 'extension') {
    if (part.protocol !== PROTOCOL) throw new IrUnsupportedError('content_part', `Cannot convert ${part.protocol} content.`, PROTOCOL);
    return record(part.payload);
  }
  if (part.type === 'text') {
    return {
      type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text,
      ...(part.annotations ? { annotations: part.annotations.map(annotationToWire) } : {}),
      ...(part.logprobs ? { logprobs: part.logprobs } : {}),
      ...(part.cache?.raw ? { prompt_cache_breakpoint: part.cache.raw } : {}),
    };
  }
  if (part.type === 'refusal') return { type: 'refusal', refusal: part.text };
  if (part.type === 'image') {
    return {
      type: 'input_image',
      ...(part.source.kind === 'url' ? { image_url: part.source.url } : {}),
      ...(part.source.kind === 'base64' ? { image_url: dataUrl(part.source.mediaType, part.source.data) } : {}),
      ...(part.source.kind === 'file' ? { file_id: part.source.fileId } : {}),
      ...(part.detail ? { detail: part.detail } : {}),
    };
  }
  if (part.type === 'file') {
    return {
      type: 'input_file',
      ...(part.source.kind === 'url' ? { file_url: part.source.url } : {}),
      ...(part.source.kind === 'base64' ? { file_data: dataUrl(part.source.mediaType, part.source.data) } : {}),
      ...(part.source.kind === 'file' ? { file_id: part.source.fileId } : {}),
      ...(part.filename ? { filename: part.filename } : {}),
    };
  }
  throw new IrUnsupportedError('audio_part', 'Responses adapter cannot carry input audio.', PROTOCOL);
}

export function responsesToolToWire(tool: ToolDef): Record<string, unknown> {
  if (tool.type === 'extension') {
    if (tool.protocol !== PROTOCOL) throw new IrUnsupportedError('tool_type', `Cannot convert ${tool.protocol} tool.`, PROTOCOL);
    return record(tool.payload);
  }
  if (tool.type === 'function') {
    return {
      type: 'function', name: tool.function.name,
      ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
      ...(tool.function.parameters !== undefined ? { parameters: tool.function.parameters } : {}),
      ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {}),
    };
  }
  if (tool.type === 'custom') {
    return {
      type: 'custom', name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.format !== undefined ? { format: tool.format } : {}),
    };
  }
  return { type: tool.kind, ...record(tool.config) };
}

/**
 * Responses tool items carry their own item `id`, distinct from the correlation
 * `call_id`, and upstreams reject an id that does not begin with the item-type
 * prefix (`Invalid 'input[2].id': Expected an ID that begins with 'fc'`).
 * Carriers without item ids (chat, Anthropic, Gemini) put the tool-call id in
 * both slots, so the Responses adapters derive one. Two invariants:
 *
 * - Deterministic: the same history MUST yield the same id on every turn, or
 *   the replayed prompt prefix turns over and the upstream prompt cache misses.
 * - Injective: distinct tool-call ids MUST NOT collapse onto one item id. The
 *   chat client controls `tool_calls[].id`, so an id that is not safe both in
 *   charset and length is hashed instead of sanitized/truncated — dropping
 *   characters or a tail would silently merge two calls into one id.
 */
export function responsesToolItemId(id: string, custom: boolean): string {
  const prefix = custom ? 'ctc_' : 'fc_';
  if (id.startsWith(prefix)) return id;
  if (/^[A-Za-z0-9_-]{1,48}$/.test(id)) return prefix + id;
  return prefix + crypto.createHash('sha256').update(id).digest('hex').slice(0, 48);
}

function itemToWire(item: InputItem): Record<string, unknown> | Record<string, unknown>[] | null {
  if (item.type === 'extension') {
    if (item.protocol !== PROTOCOL) throw new IrUnsupportedError('input_item', `Cannot convert ${item.protocol} item.`, PROTOCOL);
    return record(item.payload);
  }
  if (item.type === 'item_reference') return { type: 'item_reference', id: item.id };
  if (item.type === 'reasoning') {
    if (item.signature) throw new IrUnsupportedError('reasoning_signature', 'Responses cannot replay a foreign reasoning signature.', PROTOCOL);
    return {
      type: 'reasoning',
      ...(item.id ? { id: item.id } : {}),
      ...(item.status ? { status: item.status } : {}),
      summary: item.summary?.map((text) => ({ type: 'summary_text', text })) ?? [],
      ...(item.text ? { content: [{ type: 'reasoning_text', text: item.text }] } : {}),
      ...(item.encrypted ? { encrypted_content: item.encrypted } : {}),
    };
  }
  if (item.type === 'tool_call') {
    if (item.signature) throw new IrUnsupportedError('tool_call_signature', 'Responses cannot replay a foreign tool-call signature.', PROTOCOL);
    const custom = item.vendor?.[PROTOCOL]?.itemType === 'custom_tool_call';
    return {
      type: custom ? 'custom_tool_call' : 'function_call',
      id: responsesToolItemId(item.id, custom),
      call_id: item.callId ?? item.id,
      name: item.name,
      ...(custom ? { input: item.arguments } : { arguments: item.arguments }),
      ...(item.status ? { status: item.status } : {}),
    };
  }
  if (item.type === 'tool_result') {
    if (item.isError) throw new IrUnsupportedError('tool_result_error', 'Responses has no lossless is_error field for tool output.', PROTOCOL);
    const parts = item.content.map((p) => responsesPartToWire(p, 'user'));
    const textOnly = parts.every((p) => p.type === 'input_text');
    return {
      type: item.vendor?.[PROTOCOL]?.itemType === 'custom_tool_call_output' ? 'custom_tool_call_output' : 'function_call_output',
      call_id: item.callId,
      output: textOnly ? parts.map((p) => String(p.text ?? '')).join('\n') : parts,
    };
  }
  if (item.role === 'system' || item.role === 'developer') {
    // Plain system/developer text folds into top-level `instructions`. Keep the
    // input message only when a cache breakpoint must survive on a part/item.
    const hasCache = Boolean(item.cache)
      || item.content.some((part) => 'cache' in part && Boolean(part.cache));
    if (!hasCache) return null;
    return {
      type: 'message',
      role: item.role,
      ...(item.id ? { id: item.id } : {}),
      ...(item.status ? { status: item.status } : {}),
      content: item.content.map((p) => responsesPartToWire(p, 'user')),
    };
  }
  const role = item.role === 'assistant' ? 'assistant' : 'user';
  return {
    type: 'message', role,
    ...(item.id ? { id: item.id } : {}),
    ...(item.status ? { status: item.status } : {}),
    content: item.content.map((p) => responsesPartToWire(p, role)),
  };
}

/** Canonical IR → OpenAI Responses request. No request-object spreading. */
export function canonicalToResponsesPayload(
  ir: CanonicalRequest,
  model: ModelRegistration,
  stream = false,
): Record<string, any> {
  assertCanonicalRequestSupported(ir, PROTOCOL);
  const instructions = [
    ...(ir.instructions ? [ir.instructions] : []),
    ...ir.input.flatMap((item) => {
      if (item.type !== 'message' || (item.role !== 'system' && item.role !== 'developer')) return [];
      const hasCache = Boolean(item.cache)
        || item.content.some((part) => 'cache' in part && Boolean(part.cache));
      if (hasCache) return [];
      return item.content.map((p) => p.type === 'text'
        ? p.text
        : fail('system_part', 'Responses system/developer instructions carry text only.'));
    }),
  ].filter(Boolean).join('\n\n');
  const input = ir.input.flatMap((item) => {
    const converted = itemToWire(item);
    if (!converted) return [];
    return Array.isArray(converted) ? converted : [converted];
  });
  const include = [...(ir.include ?? [])];
  if (ir.reasoning?.include && !include.includes('reasoning.encrypted_content')) include.push('reasoning.encrypted_content');
  if ((ir.logprobs === true || ir.topLogprobs !== undefined) && !include.includes('message.output_text.logprobs')) {
    include.push('message.output_text.logprobs');
  }
  return {
    model: model.upstreamModel,
    input,
    stream,
    ...(ir.logprobs === true || ir.topLogprobs !== undefined ? { top_logprobs: ir.topLogprobs ?? 0 } : {}),
    ...(instructions ? { instructions } : {}),
    ...(ir.generation?.maxOutputTokens !== undefined ? { max_output_tokens: ir.generation.maxOutputTokens } : {}),
    ...(ir.generation?.temperature !== undefined && model.temperature !== false
      ? { temperature: ir.generation.temperature }
      : {}),
    ...(ir.generation?.topP !== undefined ? { top_p: ir.generation.topP } : {}),
    ...(ir.tools?.length ? { tools: ir.tools.map(responsesToolToWire) } : {}),
    ...(ir.toolChoice
      ? {
        tool_choice: ir.toolChoice.type === 'function' || ir.toolChoice.type === 'custom'
          ? { type: ir.toolChoice.type, name: ir.toolChoice.name }
          : ir.toolChoice.type === 'allowed'
            ? { type: 'allowed_tools', mode: ir.toolChoice.mode, tools: ir.toolChoice.tools }
            : ir.toolChoice.type,
      }
      : {}),
    ...(ir.parallelToolCalls !== undefined ? { parallel_tool_calls: ir.parallelToolCalls } : {}),
    ...(ir.text
      ? {
        text: {
          ...(ir.text.format
            ? {
              format: ir.text.format.type === 'json_schema'
                ? {
                  type: 'json_schema', name: ir.text.format.name ?? 'output', schema: ir.text.format.schema,
                  ...(ir.text.format.description !== undefined ? { description: ir.text.format.description } : {}),
                  ...(ir.text.format.strict !== undefined ? { strict: ir.text.format.strict } : {}),
                }
                : ir.text.format,
            }
            : {}),
          ...(ir.text.verbosity ? { verbosity: ir.text.verbosity } : {}),
        },
      }
      : {}),
    ...(ir.reasoning
      ? {
        reasoning: {
          // Canonical ladder includes `max`; Responses wire stops at `xhigh`.
          ...(ir.reasoning.effort
            ? { effort: ir.reasoning.effort === 'max' ? 'xhigh' : ir.reasoning.effort }
            : {}),
          ...(ir.reasoning.budgetTokens !== undefined ? { max_tokens: ir.reasoning.budgetTokens } : {}),
          ...(ir.reasoning.summary ? { summary: ir.reasoning.summary } : {}),
        },
      }
      : {}),
    ...(ir.cache?.key ? { prompt_cache_key: ir.cache.key } : {}),
    ...(ir.cache?.retention ? { prompt_cache_retention: ir.cache.retention } : {}),
    ...(ir.cache?.options ? { prompt_cache_options: ir.cache.options } : {}),
    ...(ir.store !== undefined ? { store: ir.store } : {}),
    ...(ir.previousResponseId ? { previous_response_id: ir.previousResponseId } : {}),
    ...(ir.conversation !== undefined ? { conversation: ir.conversation } : {}),
    ...(ir.prompt ? { prompt: ir.prompt } : {}),
    ...(ir.background !== undefined ? { background: ir.background } : {}),
    ...(include.length ? { include } : {}),
    ...(ir.truncation ? { truncation: ir.truncation } : {}),
    ...(ir.serviceTier ? { service_tier: ir.serviceTier } : {}),
    ...(ir.safetyIdentifier ? { safety_identifier: ir.safetyIdentifier } : {}),
    ...(ir.user ? { user: ir.user } : {}),
    ...(ir.metadata ? { metadata: ir.metadata } : {}),
  };
}

function fail(code: string, message: string): never {
  throw new IrUnsupportedError(code, message, PROTOCOL);
}

function responsesPartText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) fail('instructions', 'Responses instructions content must be text.');
  return content.map((raw) => {
    const part = record(raw);
    if ((part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') return part.text;
    return fail('instructions', 'Responses instructions arrays accept text content only.');
  }).join('\n\n');
}

function instructionsFromWire(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return raw || undefined;
  if (!Array.isArray(raw)) fail('instructions', 'Responses instructions must be a string or message array.');
  const text = raw.map((item) => {
    if (typeof item === 'string') return item;
    const message = record(item);
    if (message.type !== undefined && message.type !== 'message') {
      return fail('instructions', 'Responses instructions arrays accept message items only.');
    }
    return responsesPartText(message.content);
  }).filter(Boolean).join('\n\n');
  return text || undefined;
}

function toolsFromWire(raw: unknown): ToolDef[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) fail('tools', 'Responses tools must be an array.');
  return raw.map((entry): ToolDef => {
    const tool = record(entry);
    if (tool.type === 'function') {
      if (typeof tool.name !== 'string') fail('tool', 'Responses function tools require a name.');
      return {
        type: 'function',
        function: {
          name: tool.name,
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          ...(tool.parameters !== undefined ? { parameters: record(tool.parameters) } : {}),
          ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
        },
      };
    }
    if (tool.type === 'custom') {
      if (typeof tool.name !== 'string') fail('tool', 'Responses custom tools require a name.');
      const format = record(tool.format);
      return {
        type: 'custom', name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        ...(tool.format !== undefined ? {
          format: format.type === 'grammar'
            ? {
              type: 'grammar' as const,
              definition: String(format.definition ?? ''),
              syntax: format.syntax === 'regex' ? 'regex' as const : 'lark' as const,
            }
            : { type: 'text' as const },
        } : {}),
      };
    }
    if (typeof tool.type !== 'string' || !tool.type) fail('tool_type', 'Responses tools require a type.');
    const { type, ...config } = tool;
    return { type: 'builtin', kind: type, config };
  });
}

function toolChoiceFromWire(raw: unknown): CanonicalRequest['toolChoice'] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === 'auto' || raw === 'none' || raw === 'required') return { type: raw };
  const choice = record(raw);
  if ((choice.type === 'function' || choice.type === 'custom') && typeof choice.name === 'string') {
    return { type: choice.type, name: choice.name };
  }
  if (choice.type === 'allowed_tools' && (choice.mode === 'auto' || choice.mode === 'required') && Array.isArray(choice.tools)) {
    const tools = choice.tools.map((rawTool: unknown) => {
      const tool = record(rawTool);
      if ((tool.type !== 'function' && tool.type !== 'custom') || typeof tool.name !== 'string') {
        return fail('allowed_tools', 'Responses allowed_tools entries require a function/custom type and name.');
      }
      return { type: tool.type, name: tool.name };
    });
    return { type: 'allowed', mode: choice.mode, tools };
  }
  return fail('tool_choice', 'Unsupported Responses tool_choice.');
}

export function responsesInputToIR(raw: unknown): InputItem[] {
  if (typeof raw === 'string') {
    return raw ? [{ type: 'message', role: 'user', content: [{ type: 'text', text: raw }] }] : [];
  }
  if (!Array.isArray(raw)) fail('input', 'Responses input must be a string or item array.');
  return raw.flatMap((entry): InputItem[] => {
    const item = record(entry);
    const type = item.type ?? 'message';
    if (type === 'message') {
      const role = item.role ?? 'user';
      if (role !== 'system' && role !== 'developer' && role !== 'user' && role !== 'assistant') {
        fail('role', `Unsupported Responses message role: ${String(role)}.`);
      }
      const content = typeof item.content === 'string'
        ? [{ type: 'text' as const, text: item.content }]
        : Array.isArray(item.content)
          ? item.content.map(partFromWire)
          : fail('content', 'Responses message content must be a string or part array.');
      return [{
        type: 'message', role,
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        ...(typeof item.status === 'string' ? { status: item.status as 'in_progress' | 'completed' | 'incomplete' } : {}),
        content,
      }];
    }
    if (type === 'item_reference' && typeof item.id === 'string') return [{ type: 'item_reference', id: item.id }];
    if (type === 'reasoning') {
      const summary = Array.isArray(item.summary)
        ? item.summary.flatMap((part: unknown) => typeof record(part).text === 'string' ? [record(part).text as string] : [])
        : undefined;
      const content = Array.isArray(item.content)
        ? item.content.flatMap((part: unknown) => typeof record(part).text === 'string' ? [record(part).text as string] : [])
        : [];
      return [{
        type: 'reasoning',
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        ...(typeof item.status === 'string' ? { status: item.status as 'in_progress' | 'completed' | 'incomplete' } : {}),
        ...(content.length ? { text: content.join('\n') } : {}),
        ...(summary ? { summary } : {}),
        ...(typeof item.signature === 'string' ? { signature: item.signature } : {}),
        ...(typeof item.encrypted_content === 'string' ? { encrypted: item.encrypted_content } : {}),
      }];
    }
    if (type === 'function_call' || type === 'custom_tool_call') {
      const id = typeof item.id === 'string' ? item.id : String(item.call_id ?? '');
      const callId = typeof item.call_id === 'string' ? item.call_id : id;
      const args = type === 'custom_tool_call' ? item.input : item.arguments;
      return [{
        type: 'tool_call', id, callId,
        name: String(item.name ?? ''),
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        ...(typeof item.status === 'string' ? { status: item.status as 'in_progress' | 'completed' | 'incomplete' } : {}),
        ...(type === 'custom_tool_call' ? { vendor: { [PROTOCOL]: { itemType: type } } } : {}),
      }];
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      if (typeof item.call_id !== 'string') fail('tool_result', 'Responses tool outputs require call_id.');
      const content = typeof item.output === 'string'
        ? [{ type: 'text' as const, text: item.output }]
        : Array.isArray(item.output)
          ? item.output.map(partFromWire)
          : fail('tool_result', 'Responses tool output must be a string or content-part array.');
      return [{
        type: 'tool_result', callId: item.call_id, content,
        ...(type === 'custom_tool_call_output' ? { vendor: { [PROTOCOL]: { itemType: type } } } : {}),
      }];
    }
    return [{ type: 'extension', protocol: PROTOCOL, payload: entry }];
  });
}

/** OpenAI Responses request → Canonical IR. No Chat-shaped intermediate. */
export function responsesRequestToIR(body: unknown): CanonicalRequest {
  const req = record(body);
  if (req.input === undefined || req.input === null) fail('input', 'Invalid request: "input" is required.');
  const input = responsesInputToIR(req.input);
  if (input.length === 0) fail('input', 'Invalid request: "input" resolved to an empty item list.');
  const format = record(record(req.text).format);
  let text: CanonicalRequest['text'];
  if (format.type !== undefined || record(req.text).verbosity !== undefined) {
    let parsedFormat: NonNullable<CanonicalRequest['text']>['format'];
    if (format.type === undefined || format.type === 'text') parsedFormat = { type: 'text' };
    else if (format.type === 'json_object') parsedFormat = { type: 'json_object' };
    else if (format.type === 'json_schema') {
      if (typeof format.name !== 'string' || !format.schema || typeof format.schema !== 'object') {
        fail('response_format', 'Responses json_schema text.format requires name and schema.');
      }
      parsedFormat = {
        type: 'json_schema', name: format.name, schema: record(format.schema),
        ...(typeof format.description === 'string' ? { description: format.description } : {}),
        ...(typeof format.strict === 'boolean' ? { strict: format.strict } : {}),
      };
    } else fail('response_format', `Unsupported Responses text.format: ${String(format.type)}.`);
    const verbosity = record(req.text).verbosity;
    if (verbosity !== undefined && verbosity !== 'low' && verbosity !== 'medium' && verbosity !== 'high') {
      fail('text_verbosity', `Unsupported Responses text.verbosity: ${String(verbosity)}.`);
    }
    text = { format: parsedFormat, ...(verbosity ? { verbosity } : {}) };
  }
  const reasoningWire = record(req.reasoning);
  const effort = reasoningWire.effort;
  if (effort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(effort))) {
    fail('reasoning_effort', `Unsupported Responses reasoning effort: ${String(effort)}.`);
  }
  const generation = {
    ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    ...(typeof req.top_p === 'number' ? { topP: req.top_p } : {}),
    ...(typeof req.max_output_tokens === 'number' ? { maxOutputTokens: req.max_output_tokens } : {}),
  };
  const instructions = instructionsFromWire(req.instructions);
  const tools = toolsFromWire(req.tools);
  const toolChoice = toolChoiceFromWire(req.tool_choice);
  return {
    model: typeof req.model === 'string' && req.model.trim() ? req.model.trim() : 'auto',
    stream: req.stream === true,
    input,
    ...(instructions ? { instructions } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(typeof req.parallel_tool_calls === 'boolean' ? { parallelToolCalls: req.parallel_tool_calls } : {}),
    ...(Object.keys(generation).length ? { generation } : {}),
    ...(text ? { text } : {}),
    ...(req.reasoning !== undefined ? {
      reasoning: {
        ...(effort ? { effort: effort as NonNullable<CanonicalRequest['reasoning']>['effort'] } : {}),
        ...(typeof reasoningWire.max_tokens === 'number' ? { budgetTokens: reasoningWire.max_tokens } : {}),
        ...(typeof reasoningWire.summary === 'string' ? { summary: reasoningWire.summary as 'auto' | 'concise' | 'detailed' } : {}),
      },
    } : {}),
    ...(req.prompt_cache_key || req.prompt_cache_retention || req.prompt_cache_options ? {
      cache: {
        ...(typeof req.prompt_cache_key === 'string' ? { key: req.prompt_cache_key } : {}),
        ...(typeof req.prompt_cache_retention === 'string' ? { retention: req.prompt_cache_retention } : {}),
        ...(req.prompt_cache_options && typeof req.prompt_cache_options === 'object' ? { options: record(req.prompt_cache_options) } : {}),
      },
    } : {}),
    ...(typeof req.top_logprobs === 'number' ? { topLogprobs: req.top_logprobs } : {}),
    ...(typeof req.store === 'boolean' ? { store: req.store } : {}),
    ...(typeof req.previous_response_id === 'string' ? { previousResponseId: req.previous_response_id } : {}),
    ...(req.conversation !== undefined ? { conversation: req.conversation as CanonicalRequest['conversation'] } : {}),
    ...(req.prompt !== undefined ? { prompt: req.prompt as CanonicalRequest['prompt'] } : {}),
    ...(typeof req.background === 'boolean' ? { background: req.background } : {}),
    ...(Array.isArray(req.include) ? { include: req.include as string[] } : {}),
    ...(req.truncation !== undefined ? { truncation: req.truncation as 'auto' | 'disabled' } : {}),
    ...(typeof req.service_tier === 'string' ? { serviceTier: req.service_tier } : {}),
    ...(typeof req.safety_identifier === 'string' ? { safetyIdentifier: req.safety_identifier } : {}),
    ...(typeof req.user === 'string' ? { user: req.user } : {}),
    ...(req.metadata && typeof req.metadata === 'object' ? { metadata: record(req.metadata) } : {}),
  };
}

function usageFromWire(raw: unknown): Usage {
  const u = record(raw);
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    ...(u.total_tokens !== undefined ? { totalTokens: u.total_tokens } : {}),
    ...(u.input_tokens_details?.cached_tokens !== undefined
      ? { cachedInputTokens: u.input_tokens_details.cached_tokens }
      : {}),
    ...(u.input_tokens_details?.audio_tokens !== undefined ? { audioInputTokens: u.input_tokens_details.audio_tokens } : {}),
    ...(u.output_tokens_details?.reasoning_tokens !== undefined
      ? { reasoningTokens: u.output_tokens_details.reasoning_tokens }
      : {}),
    ...(u.output_tokens_details?.audio_tokens !== undefined
      ? { audioOutputTokens: u.output_tokens_details.audio_tokens }
      : {}),
    ...(u.output_tokens_details?.accepted_prediction_tokens !== undefined
      ? { acceptedPredictionTokens: u.output_tokens_details.accepted_prediction_tokens }
      : {}),
    ...(u.output_tokens_details?.rejected_prediction_tokens !== undefined
      ? { rejectedPredictionTokens: u.output_tokens_details.rejected_prediction_tokens }
      : {}),
  };
}

export function responsesResponseToIR(data: unknown): CanonicalResponse {
  const body = record(data);
  const output: OutputItem[] = [];
  for (const raw of Array.isArray(body.output) ? body.output : []) {
    const item = record(raw);
    if (item.type === 'reasoning') {
      const text = (Array.isArray(item.content) ? item.content : [])
        .flatMap((part) => typeof record(part).text === 'string' ? [record(part).text] : [])
        .join('\n');
      output.push({
        type: 'reasoning',
        ...(item.id ? { id: item.id } : {}),
        ...(item.status ? { status: item.status } : {}),
        ...(text ? { text } : {}),
        ...(Array.isArray(item.summary)
          ? { summary: item.summary.flatMap((part: unknown) => typeof record(part).text === 'string' ? [record(part).text] : []) }
          : {}),
        ...(typeof item.encrypted_content === 'string' ? { encrypted: item.encrypted_content } : {}),
      });
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const callId = typeof item.call_id === 'string' ? item.call_id : String(item.id ?? '');
      const args = item.type === 'custom_tool_call' ? item.input : item.arguments;
      output.push({
        type: 'tool_call', id: String(item.id ?? callId), callId,
        name: String(item.name ?? ''),
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        ...(item.status ? { status: item.status } : {}),
        ...(item.type === 'custom_tool_call' ? { vendor: { [PROTOCOL]: { itemType: item.type } } } : {}),
      });
    } else if (item.type === 'message') {
      output.push({
        type: 'message', role: 'assistant',
        ...(item.id ? { id: item.id } : {}),
        ...(item.status ? { status: item.status } : {}),
        content: (Array.isArray(item.content) ? item.content : []).map(partFromWire),
      });
    } else {
      output.push({ type: 'extension', protocol: PROTOCOL, payload: raw });
    }
  }
  const incomplete = body.status === 'incomplete';
  const failed = body.status === 'failed';
  const reason = failed ? 'error' : incomplete
    ? body.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length'
    : output.some((item) => item.type === 'tool_call') ? 'tool_calls' : 'stop';
  return {
    ...(body.id ? { id: body.id } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(typeof body.created_at === 'number' ? { createdAt: body.created_at } : {}),
    status: failed ? 'failed' : incomplete ? 'incomplete' : 'completed',
    reason,
    output,
    usage: usageFromWire(body.usage),
    ...(body.service_tier ? { serviceTier: body.service_tier } : {}),
    ...(body.previous_response_id ? { previousResponseId: body.previous_response_id } : {}),
    ...(body.error ? { error: { code: body.error.code, message: body.error.message ?? 'Responses turn failed.' } } : {}),
  };
}

export {
  annotationFromWire as responsesAnnotationFromWire,
  partFromWire as responsesPartFromWire,
  usageFromWire as responsesUsageFromWire,
};

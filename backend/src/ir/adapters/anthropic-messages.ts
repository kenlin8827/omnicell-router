import crypto from 'node:crypto';
import type { ModelRegistration } from '../../config/types.js';
import { EFFORT_LADDER, EFFORT_TO_BUDGET, type ReasoningEffort } from '../../types/router.js';
import { IrUnsupportedError } from '../errors.js';
import { DATA_URL_RE } from '../media.js';
import type {
  CacheBreakpoint,
  CanonicalRequest,
  CanonicalResponse,
  ContentPart,
  InputItem,
  OutputItem,
  TextConfig,
  ToolDef,
  Usage,
} from '../types.js';
import {
  assertCanonicalRequestSupported,
  assertCanonicalResponseSupported,
  assertCanonicalStreamEventSupported,
} from '../validate.js';

const PROTOCOL = 'anthropic-messages' as const;
const DEFAULT_MAX_TOKENS = 4096;

type Wire = Record<string, any>;

function record(value: unknown): Wire {
  return value && typeof value === 'object' ? value as Wire : {};
}

function fail(code: string, message: string): never {
  throw new IrUnsupportedError(code, message, PROTOCOL);
}

function cacheOf(raw: unknown): CacheBreakpoint | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = record(raw);
  const ttl = typeof value.ttl === 'string' ? value.ttl : undefined;
  // Reserve `raw` strictly for Responses opaque prompt_cache_breakpoint objects
  // so Anthropic cache_control never leaks across carriers.
  if (typeof value.type === 'string') {
    return { type: value.type, ...(ttl ? { ttl } : {}) };
  }
  return { raw: value };
}

function cacheToWire(cache: CacheBreakpoint | undefined): Wire | undefined {
  if (!cache) return undefined;
  if (cache.raw) return cache.raw;
  if (cache.type) return { type: cache.type, ...(cache.ttl ? { ttl: cache.ttl } : {}) };
  return undefined;
}

function parseObject(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, any>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // The explicit error below is the tool-call contract, not a fallback shape.
  }
  return fail('tool_arguments', 'Anthropic tool_use input requires a JSON object string.');
}

function sourceFromWire(raw: unknown): ContentPart | undefined {
  const source = record(raw);
  if (source.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
    return {
      type: 'image',
      source: { kind: 'base64', mediaType: source.media_type, data: source.data },
    };
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    const inline = DATA_URL_RE.exec(source.url);
    return {
      type: 'image',
      source: inline
        ? { kind: 'base64', mediaType: inline[1]!, data: inline[2]! }
        : { kind: 'url', url: source.url },
    };
  }
  if (source.type === 'file' && typeof source.file_id === 'string') {
    return { type: 'image', source: { kind: 'file', fileId: source.file_id } };
  }
  return undefined;
}

function partFromWire(raw: unknown): ContentPart {
  const block = record(raw);
  const cache = cacheOf(block.cache_control);
  if (block.type === 'text' && typeof block.text === 'string') {
    return {
      type: 'text', text: block.text,
      ...(Array.isArray(block.citations) ? {
        annotations: block.citations.map((payload) => ({ type: 'extension' as const, protocol: PROTOCOL, payload })),
      } : {}),
      ...(cache ? { cache } : {}),
    };
  }
  if (block.type === 'image') {
    const part = sourceFromWire(block.source);
    if (part) return { ...part, ...(cache ? { cache } : {}) };
  }
  if (block.type === 'document') {
    const source = record(block.source);
    const common = {
      ...(typeof block.title === 'string' ? { filename: block.title } : {}),
      ...(cache ? { cache } : {}),
    };
    if (source.type === 'base64' && typeof source.data === 'string') {
      return {
        type: 'file',
        source: {
          kind: 'base64',
          mediaType: typeof source.media_type === 'string' ? source.media_type : 'application/pdf',
          data: source.data,
        },
        ...common,
      };
    }
    if (source.type === 'url' && typeof source.url === 'string') {
      const inline = DATA_URL_RE.exec(source.url);
      return {
        type: 'file',
        source: inline
          ? { kind: 'base64', mediaType: inline[1]!, data: inline[2]! }
          : { kind: 'url', url: source.url },
        ...common,
      };
    }
    if (source.type === 'file' && typeof source.file_id === 'string') {
      return { type: 'file', source: { kind: 'file', fileId: source.file_id }, ...common };
    }
    if (source.type === 'text' && typeof source.data === 'string') {
      return {
        type: 'file',
        source: {
          kind: 'base64',
          mediaType: typeof source.media_type === 'string' ? source.media_type : 'text/plain',
          data: Buffer.from(source.data, 'utf8').toString('base64'),
        },
        ...common,
      };
    }
  }
  // Unknown blocks stay opaque. Same-carrier passthrough can replay them;
  // cross-carrier conversion fails at the common capability gate.
  return { type: 'extension', protocol: PROTOCOL, payload: raw };
}

function partToWire(part: ContentPart): Wire {
  if (part.type === 'extension') {
    if (part.protocol !== PROTOCOL) fail('content_part', `Cannot convert ${part.protocol} content.`);
    return record(part.payload);
  }
  const cache = 'cache' in part ? cacheToWire(part.cache) : undefined;
  if (part.type === 'text') {
    const citations = part.annotations?.map((annotation) => {
      if (annotation.type !== 'extension' || annotation.protocol !== PROTOCOL) {
        fail('annotation', `Anthropic cannot convert ${annotation.type} annotations without a carrier-native mapping.`);
      }
      return annotation.payload;
    });
    return {
      type: 'text', text: part.text,
      ...(citations ? { citations } : {}),
      ...(cache ? { cache_control: cache } : {}),
    };
  }
  if (part.type === 'image') {
    const source = part.source.kind === 'base64'
      ? { type: 'base64', media_type: part.source.mediaType, data: part.source.data }
      : part.source.kind === 'url'
        ? { type: 'url', url: part.source.url }
        : { type: 'file', file_id: part.source.fileId };
    return { type: 'image', source, ...(cache ? { cache_control: cache } : {}) };
  }
  if (part.type === 'file') {
    const source = part.source.kind === 'base64'
      ? { type: 'base64', media_type: part.source.mediaType, data: part.source.data }
      : part.source.kind === 'url'
        ? { type: 'url', url: part.source.url }
        : { type: 'file', file_id: part.source.fileId };
    return {
      type: 'document', source,
      ...(part.filename ? { title: part.filename } : {}),
      ...(cache ? { cache_control: cache } : {}),
    };
  }
  fail('content_part', `Anthropic cannot carry ${part.type} content.`);
}

function itemsFromMessage(role: 'user' | 'assistant', rawContent: unknown): InputItem[] {
  if (typeof rawContent === 'string') {
    return [{ type: 'message', role, content: rawContent ? [{ type: 'text', text: rawContent }] : [] }];
  }
  const blocks = Array.isArray(rawContent) ? rawContent : [];
  const items: InputItem[] = [];
  let messageParts: ContentPart[] = [];
  const flush = (): void => {
    if (!messageParts.length) return;
    items.push({ type: 'message', role, content: messageParts });
    messageParts = [];
  };
  for (const raw of blocks) {
    const block = record(raw);
    if (block.type === 'tool_use') {
      flush();
      items.push({
        type: 'tool_call',
        id: String(block.id ?? ''),
        callId: String(block.id ?? ''),
        name: String(block.name ?? ''),
        arguments: JSON.stringify(block.input ?? {}),
        ...(cacheOf(block.cache_control) ? { cache: cacheOf(block.cache_control) } : {}),
      });
      continue;
    }
    if (block.type === 'tool_result') {
      flush();
      const content = typeof block.content === 'string'
        ? [{ type: 'text' as const, text: block.content }]
        : (Array.isArray(block.content) ? block.content : []).map(partFromWire);
      items.push({
        type: 'tool_result',
        callId: String(block.tool_use_id ?? ''),
        content,
        ...(block.is_error === true ? { isError: true } : {}),
        ...(cacheOf(block.cache_control) ? { cache: cacheOf(block.cache_control) } : {}),
      });
      continue;
    }
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      flush();
      items.push({
        type: 'reasoning',
        ...(typeof block.thinking === 'string' ? { text: block.thinking } : {}),
        ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
        ...(typeof block.data === 'string' ? { encrypted: block.data } : {}),
        vendor: { anthropic: { blockType: block.type } },
      });
      continue;
    }
    messageParts.push(partFromWire(block));
  }
  flush();
  if (!items.length) items.push({ type: 'message', role, content: [] });
  return items;
}

function systemToIR(system: unknown): {
  instructions?: string;
  systemCache?: CacheBreakpoint;
  systemBlocks?: Wire[];
} {
  if (typeof system === 'string') return system ? { instructions: system } : {};
  if (!Array.isArray(system)) return system === undefined || system === null ? {} : fail('system', 'Anthropic system must be a string or block array.');
  const texts: string[] = [];
  let systemCache: CacheBreakpoint | undefined;
  for (const raw of system) {
    const block = record(raw);
    if (block.type !== 'text' || typeof block.text !== 'string') {
      fail('system_block', `Unsupported Anthropic system block: ${String(block.type)}.`);
    }
    texts.push(block.text);
    systemCache ??= cacheOf(block.cache_control);
  }
  return {
    ...(texts.length ? { instructions: texts.join('\n\n') } : {}),
    ...(systemCache ? { systemCache } : {}),
    ...(system.length ? { systemBlocks: system.map((block) => ({ ...record(block) })) } : {}),
  };
}

/** Anthropic Messages request → Canonical IR. No Chat-shaped intermediate. */
export function anthropicRequestToIR(body: unknown): CanonicalRequest {
  const req = record(body);
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    fail('messages', 'Invalid request: "messages" array is required.');
  }
  const input: InputItem[] = [];
  for (const raw of req.messages) {
    const message = record(raw);
    if (message.role !== 'user' && message.role !== 'assistant') fail('role', `Invalid Anthropic role: ${String(message.role)}.`);
    input.push(...itemsFromMessage(message.role, message.content));
  }
  const system = systemToIR(req.system);
  const tools = Array.isArray(req.tools) ? req.tools.map((raw): ToolDef => {
    const tool = record(raw);
    if (typeof tool.name !== 'string') fail('tool', 'Anthropic function tools require a name.');
    return {
      type: 'function',
      function: {
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters: record(tool.input_schema),
        ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
        ...(cacheOf(tool.cache_control) ? { cache: cacheOf(tool.cache_control) } : {}),
      },
    };
  }) : undefined;
  if (req.tools !== undefined && !Array.isArray(req.tools)) fail('tools', 'Anthropic tools must be an array.');
  const choice = record(req.tool_choice);
  const toolChoice = choice.type === 'auto' || choice.type === 'none'
    ? { type: choice.type }
    : choice.type === 'any'
      ? { type: 'required' as const }
      : choice.type === 'tool' && typeof choice.name === 'string'
        ? { type: 'function' as const, name: choice.name }
        : undefined;
  if (req.tool_choice !== undefined && !toolChoice) fail('tool_choice', 'Unsupported Anthropic tool_choice.');
  const thinking = record(req.thinking);
  const outputConfig = record(req.output_config);
  let text: TextConfig | undefined;
  if (outputConfig.format !== undefined) {
    if (!outputConfig.format || typeof outputConfig.format !== 'object' || Array.isArray(outputConfig.format)) {
      fail('response_format', 'Anthropic output_config.format must be an object.');
    }
    const fmt = record(outputConfig.format);
    if (fmt.type === 'json_schema') {
      if (!fmt.schema || typeof fmt.schema !== 'object' || Array.isArray(fmt.schema)) {
        fail('response_format', 'Anthropic output_config.format json_schema requires a schema object.');
      }
      text = {
        format: {
          type: 'json_schema',
          schema: record(fmt.schema),
          ...(typeof fmt.name === 'string' ? { name: fmt.name } : {}),
          ...(typeof fmt.description === 'string' ? { description: fmt.description } : {}),
          ...(typeof fmt.strict === 'boolean' ? { strict: fmt.strict } : {}),
        },
      };
    } else if (fmt.type === 'json_object' || fmt.type === 'text') {
      text = { format: { type: fmt.type } };
    } else {
      fail('response_format', `Unsupported Anthropic output_config.format.type: ${String(fmt.type)}.`);
    }
  }
  const configuredEffort = typeof outputConfig.effort === 'string' && (EFFORT_LADDER as readonly string[]).includes(outputConfig.effort)
    ? outputConfig.effort as ReasoningEffort
    : undefined;
  if (outputConfig.effort !== undefined && !configuredEffort) {
    fail('reasoning_effort', `Unsupported Anthropic output_config.effort: ${String(outputConfig.effort)}.`);
  }
  const metadata = record(req.metadata);
  return {
    model: typeof req.model === 'string' && req.model.trim() ? req.model.trim() : 'auto',
    stream: req.stream === true,
    ...(system.instructions ? { instructions: system.instructions } : {}),
    input,
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(toolChoice && choice.disable_parallel_tool_use === true ? { parallelToolCalls: false } : {}),
    generation: {
      maxOutputTokens: typeof req.max_tokens === 'number' ? req.max_tokens : DEFAULT_MAX_TOKENS,
      ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
      ...(typeof req.top_p === 'number' ? { topP: req.top_p } : {}),
      ...(typeof req.top_k === 'number' ? { topK: req.top_k } : {}),
      ...(Array.isArray(req.stop_sequences) ? { stop: req.stop_sequences } : {}),
    },
    ...(text ? { text } : {}),
    ...(thinking.type === 'enabled' || configuredEffort || thinking.type === 'disabled'
      ? {
        reasoning: {
          ...(thinking.type === 'enabled' && typeof thinking.budget_tokens === 'number'
            ? { budgetTokens: thinking.budget_tokens }
            : {}),
          ...(configuredEffort ? { effort: configuredEffort } : thinking.type === 'disabled' ? { effort: 'none' as const } : {}),
        },
      }
      : {}),
    ...(typeof metadata.user_id === 'string' ? { user: metadata.user_id } : {}),
    ...(outputConfig.format || system.systemCache || system.systemBlocks
      ? {
        vendor: {
          anthropic: {
            ...(outputConfig.format ? { outputFormat: outputConfig.format } : {}),
            ...(system.systemCache ? { systemCache: system.systemCache } : {}),
            ...(system.systemBlocks ? { systemBlocks: system.systemBlocks } : {}),
          },
        },
      }
      : {}),
  };
}

function appendMessage(messages: Wire[], role: 'user' | 'assistant', blocks: Wire[]): void {
  if (!blocks.length) return;
  const previous = messages[messages.length - 1];
  if (previous?.role === role && Array.isArray(previous.content)) previous.content.push(...blocks);
  else messages.push({ role, content: blocks });
}

function reasoningToWire(item: Extract<InputItem, { type: 'reasoning' }>): Wire {
  const redacted = item.vendor?.anthropic?.blockType === 'redacted_thinking' || (!item.text && item.encrypted);
  if (redacted) {
    if (!item.encrypted) fail('reasoning_signature', 'Redacted Anthropic thinking requires its opaque data.');
    return { type: 'redacted_thinking', data: item.encrypted };
  }
  return {
    type: 'thinking',
    thinking: item.text ?? '',
    ...(item.signature ? { signature: item.signature } : {}),
  };
}

/** Canonical IR → Anthropic Messages request. */
export function canonicalToAnthropicPayload(ir: CanonicalRequest, model: ModelRegistration): Wire {
  assertCanonicalRequestSupported(ir, PROTOCOL);
  const messages: Wire[] = [];
  for (const item of ir.input) {
    if (item.type === 'message') {
      if (item.role === 'system' || item.role === 'developer') continue;
      const blocks = item.content.map((part) => partToWire(part));
      if (item.cache) {
        const last = blocks.at(-1);
        if (!last) fail('cache_item_breakpoint', 'An Anthropic message cache breakpoint requires a content block.');
        if (last.cache_control) fail('cache_item_breakpoint', 'Message and final-part cache breakpoints cannot be merged.');
        last.cache_control = cacheToWire(item.cache);
      }
      appendMessage(messages, item.role, blocks);
      continue;
    }
    if (item.type === 'reasoning') {
      appendMessage(messages, 'assistant', [reasoningToWire(item)]);
      continue;
    }
    if (item.type === 'tool_call') {
      appendMessage(messages, 'assistant', [{
        type: 'tool_use', id: item.callId ?? item.id, name: item.name, input: parseObject(item.arguments),
        ...(cacheToWire(item.cache) ? { cache_control: cacheToWire(item.cache) } : {}),
      }]);
      continue;
    }
    if (item.type === 'tool_result') {
      const content = item.content.map((part) => partToWire(part));
      appendMessage(messages, 'user', [{
        type: 'tool_result', tool_use_id: item.callId,
        content: content.every((part) => part.type === 'text')
          ? content.map((part) => part.text).join('\n')
          : content,
        ...(item.isError ? { is_error: true } : {}),
        ...(cacheToWire(item.cache) ? { cache_control: cacheToWire(item.cache) } : {}),
      }]);
      continue;
    }
    if (item.type === 'extension' && item.protocol === PROTOCOL) {
      const raw = record(item.payload);
      appendMessage(messages, raw.role === 'assistant' ? 'assistant' : 'user', [raw]);
      continue;
    }
    fail('input_item', 'Anthropic cannot resolve item references or foreign extension items.');
  }
  const systemMessages = ir.input.filter((item): item is Extract<InputItem, { type: 'message' }> =>
    item.type === 'message' && (item.role === 'system' || item.role === 'developer'));
  const systemText = [ir.instructions, ...systemMessages.map((item) => item.type === 'message'
    ? item.content.map((part) => part.type === 'text' ? part.text : fail('system_part', 'Anthropic system prompts carry text only.')).join('\n\n')
    : '')].filter(Boolean).join('\n\n');
  const declaredCache = (() => {
    for (const item of systemMessages) {
      if (item.cache) return item.cache;
      for (const part of item.content) {
        if (part.type === 'text' && part.cache) return part.cache;
      }
    }
    return undefined;
  })();
  const vendorCache = ir.vendor?.anthropic?.systemCache;
  const vendorBlocks = ir.vendor?.anthropic?.systemBlocks;
  const originalBlocks = systemMessages.length === 0 && Array.isArray(vendorBlocks) &&
    vendorBlocks.every((block) => record(block).type === 'text' && typeof record(block).text === 'string')
    ? vendorBlocks as Wire[]
    : undefined;
  const originalText = originalBlocks?.map((block) => String(block.text)).join('\n\n');
  const replayOriginal = originalBlocks !== undefined && originalText === systemText && declaredCache === undefined;
  const systemCache = declaredCache ?? (vendorCache && typeof vendorCache === 'object'
    ? vendorCache as CacheBreakpoint
    : undefined);
  const systemWire = cacheToWire(systemCache);
  const system = replayOriginal
    ? originalBlocks.map((block) => ({ ...block }))
    : systemText
      // Never invent a cache breakpoint the client did not declare.
      ? [{ type: 'text', text: systemText, ...(systemWire ? { cache_control: systemWire } : {}) }]
      : undefined;
  const maxFromRequest = ir.generation?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  let maxTokens = maxFromRequest;
  let thinking: Wire | undefined;
  const effort = ir.reasoning?.effort;
  const explicitBudget = ir.reasoning?.budgetTokens !== undefined && ir.reasoning.budgetTokens > 0
    ? ir.reasoning.budgetTokens
    : undefined;
  if ((effort && effort !== 'none') || explicitBudget !== undefined) {
    // Anthropic enforces a 1024-token minimum for thinking.budget_tokens.
    const budget = explicitBudget ?? Math.max(1024, EFFORT_TO_BUDGET[effort as ReasoningEffort]);
    if (budget > 0) {
      maxTokens = Math.max(maxTokens, budget + 1024);
      thinking = { type: 'enabled', budget_tokens: budget };
    }
  }
  const tools = ir.tools?.map((tool) => {
    if (tool.type !== 'function') fail('tool_type', `Anthropic carries function tools only, not ${tool.type}.`);
    return {
      name: tool.function.name,
      ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
      input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
      ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {}),
      ...(cacheToWire(tool.function.cache) ? { cache_control: cacheToWire(tool.function.cache) } : {}),
    };
  });
  const disableParallel = ir.parallelToolCalls === false && !!tools?.length;
  const toolChoice = ir.toolChoice
    ? ir.toolChoice.type === 'required'
      ? { type: 'any' }
      : ir.toolChoice.type === 'function'
        ? { type: 'tool', name: ir.toolChoice.name }
        : ir.toolChoice.type === 'auto' || ir.toolChoice.type === 'none'
          ? { type: ir.toolChoice.type }
          : fail('tool_choice', `Anthropic cannot express ${ir.toolChoice.type}.`)
    : undefined;
  const applyDisableParallel = disableParallel && toolChoice?.type !== 'none';
  const schema = ir.text?.format?.type === 'json_schema' ? ir.text.format.schema : undefined;
  const outputFormat = ir.vendor?.anthropic?.outputFormat;
  return {
    model: model.upstreamModel,
    max_tokens: maxTokens,
    messages,
    ...(system ? { system } : {}),
    ...(ir.generation?.temperature !== undefined && model.temperature !== false && !thinking
      ? { temperature: ir.generation.temperature }
      : {}),
    ...(ir.generation?.topP !== undefined && !thinking ? { top_p: ir.generation.topP } : {}),
    ...(ir.generation?.topK !== undefined && !thinking ? { top_k: ir.generation.topK } : {}),
    ...(ir.generation?.stop?.length ? { stop_sequences: ir.generation.stop } : {}),
    ...(thinking ? { thinking } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice || applyDisableParallel
      ? { tool_choice: { ...(toolChoice ?? { type: 'auto' }), ...(applyDisableParallel ? { disable_parallel_tool_use: true } : {}) } }
      : {}),
    ...(schema || outputFormat
      ? { output_config: { ...(schema ? { format: { type: 'json_schema', schema } } : outputFormat ? { format: outputFormat } : {}) } }
      : {}),
    ...(ir.user ? { metadata: { user_id: ir.user } } : {}),
  };
}

function usageFromWire(raw: unknown): Usage {
  const usage = record(raw);
  const cached = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  const input = (usage.input_tokens ?? 0) + cached + write;
  const output = usage.output_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cachedInputTokens: cached,
    cacheWriteTokens: write,
    ...(usage.cache_creation?.ephemeral_5m_input_tokens !== undefined
      ? { cacheWrite5mTokens: usage.cache_creation.ephemeral_5m_input_tokens }
      : {}),
    ...(usage.cache_creation?.ephemeral_1h_input_tokens !== undefined
      ? { cacheWrite1hTokens: usage.cache_creation.ephemeral_1h_input_tokens }
      : {}),
    ...(usage.output_tokens_details?.thinking_tokens !== undefined
      ? { reasoningTokens: usage.output_tokens_details.thinking_tokens }
      : {}),
  };
}

/** Anthropic Messages response → Canonical IR, including signed thinking. */
export function anthropicResponseToIR(data: unknown): CanonicalResponse {
  const body = record(data);
  const output: OutputItem[] = [];
  for (const raw of Array.isArray(body.content) ? body.content : []) {
    const block = record(raw);
    if (block.type === 'tool_use') {
      output.push({
        type: 'tool_call', id: String(block.id ?? ''), callId: String(block.id ?? ''),
        name: String(block.name ?? ''), arguments: JSON.stringify(block.input ?? {}),
      });
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      output.push({
        type: 'reasoning',
        ...(typeof block.thinking === 'string' ? { text: block.thinking } : {}),
        ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
        ...(typeof block.data === 'string' ? { encrypted: block.data } : {}),
        vendor: { anthropic: { blockType: block.type } },
      });
    } else {
      output.push({ type: 'message', role: 'assistant', content: [partFromWire(block)] });
    }
  }
  const reason = body.stop_reason === 'tool_use' ? 'tool_calls'
    : body.stop_reason === 'max_tokens' ? 'length'
      : body.stop_reason === 'refusal' ? 'content_filter' : 'stop';
  return {
    ...(typeof body.id === 'string' ? { id: body.id } : {}),
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    status: reason === 'length' || reason === 'content_filter' ? 'incomplete' : 'completed',
    reason,
    output,
    usage: usageFromWire(body.usage),
    vendor: { anthropic: { stopReason: body.stop_reason ?? null, stopSequence: body.stop_sequence ?? null } },
  };
}

function stopReasonOf(response: CanonicalResponse): string {
  const native = response.vendor?.anthropic?.stopReason;
  if (typeof native === 'string') return native;
  if (response.reason === 'tool_calls' || response.output.some((item) => item.type === 'tool_call')) return 'tool_use';
  if (response.reason === 'length') return 'max_tokens';
  if (response.reason === 'content_filter') return 'refusal';
  return 'end_turn';
}

function usageToAnthropic(usage: Usage, opening = false): Wire {
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  return {
    input_tokens: Math.max(0, usage.inputTokens - cached - written),
    output_tokens: opening ? 0 : usage.outputTokens,
    ...(usage.cachedInputTokens !== undefined ? { cache_read_input_tokens: usage.cachedInputTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cache_creation_input_tokens: usage.cacheWriteTokens } : {}),
    ...((usage.cacheWrite5mTokens !== undefined || usage.cacheWrite1hTokens !== undefined)
      ? {
        cache_creation: {
          ...(usage.cacheWrite5mTokens !== undefined ? { ephemeral_5m_input_tokens: usage.cacheWrite5mTokens } : {}),
          ...(usage.cacheWrite1hTokens !== undefined ? { ephemeral_1h_input_tokens: usage.cacheWrite1hTokens } : {}),
        },
      }
      : {}),
  };
}

function toolArgumentsToWire(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('tool_arguments', 'Anthropic tool_use input must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof IrUnsupportedError) throw err;
    fail('tool_arguments', 'Cannot emit malformed tool-call arguments as an Anthropic tool_use block.');
  }
}

/** Canonical IR → Anthropic Messages JSON, without a Chat response projection. */
export function canonicalToAnthropicResponse(response: CanonicalResponse, model: string): Wire {
  assertCanonicalResponseSupported(response, PROTOCOL);
  const content: Wire[] = [];
  for (const item of response.output) {
    if (item.type === 'message') {
      for (const part of item.content) content.push(partToWire(part));
    } else if (item.type === 'reasoning') {
      content.push(reasoningToWire(item));
    } else if (item.type === 'tool_call') {
      content.push({
        type: 'tool_use',
        id: item.callId ?? item.id,
        name: item.name,
        input: toolArgumentsToWire(item.arguments),
      });
    } else if (item.protocol === PROTOCOL) {
      content.push(record(item.payload));
    } else {
      fail('output_item', `Cannot convert ${item.protocol} output to Anthropic.`);
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    id: response.id ?? `msg_${crypto.randomBytes(12).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReasonOf(response),
    stop_sequence: response.vendor?.anthropic?.stopSequence ?? null,
    usage: usageToAnthropic(response.usage),
  };
}

/** Stateful IR-event → Anthropic SSE payload encoder for one client turn. */
export class AnthropicMessagesEventEncoder {
  private id = `msg_${crypto.randomBytes(12).toString('hex')}`;
  private model = '';
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };
  private started = false;
  private terminal = false;
  private sawToolCall = false;
  private nextBlock = 0;
  private readonly blocks = new Map<string, number>();

  public encode(event: import('../types.js').StreamEvent, model: string, finalResponse?: CanonicalResponse): Wire[] {
    assertCanonicalStreamEventSupported(event, PROTOCOL);
    if ((event.candidateIndex ?? 0) !== 0) return [];
    if (model) this.model = model;
    if (event.type === 'response.created') {
      this.id = event.id ?? this.id;
      if (finalResponse) {
        this.usage = finalResponse.usage;
        return this.start();
      }
      // Hold `message_start` only across `response.created` so native Anthropic
      // streams (where `response.usage` follows immediately) still carry
      // `cache_read_input_tokens` on `message_start`. Any content event flushes
      // `message_start` immediately with zero added TTFT.
      return [];
    }
    if (event.type === 'response.usage') {
      this.usage = event.usage;
      return this.started ? [] : this.start();
    }
    return this.encodeReady(event, model, finalResponse);
  }

  private encodeReady(event: import('../types.js').StreamEvent, model: string, finalResponse?: CanonicalResponse): Wire[] {
    if (event.type === 'response.output_item.added') {
      const opening = this.start();
      if (event.item.type === 'tool_call') {
        this.sawToolCall = true;
        const block = this.blockFor(`item:${event.index}`, {
          type: 'tool_use', id: event.item.callId ?? event.item.id, name: event.item.name, input: {},
        });
        opening.push(block);
      } else if (event.item.type === 'reasoning') {
        opening.push(this.blockFor(`item:${event.index}`, reasoningStart(event.item)));
      } else if (event.item.type === 'extension') {
        if (event.item.protocol === PROTOCOL) {
          opening.push(this.blockFor(`item:${event.index}`, record(event.item.payload)));
        } else {
          fail('output_item', `Cannot convert ${event.item.protocol} output to an Anthropic stream.`);
        }
      }
      return opening;
    }
    if (event.type === 'response.content_part.added') {
      const opening = this.start();
      const part = event.part.type === 'text' ? { type: 'text', text: '' } : partToWire(event.part);
      opening.push(this.blockFor(`part:${event.index}:${event.partIndex}`, part));
      return opening;
    }
    if (event.type === 'response.output_text.delta') {
      return [...this.start(), {
        type: 'content_block_delta', index: this.blockIndex(`part:${event.index}:${event.partIndex}`),
        delta: { type: 'text_delta', text: event.text },
      }];
    }
    if (event.type === 'response.output_text.annotation.added') {
      if (event.annotation.type !== 'extension' || event.annotation.protocol !== PROTOCOL) {
        fail('annotation', 'Anthropic streams require carrier-native citation payloads.');
      }
      return [...this.start(), {
        type: 'content_block_delta', index: this.blockIndex(`part:${event.index}:${event.partIndex}`),
        delta: { type: 'citations_delta', citation: event.annotation.payload },
      }];
    }
    if (event.type === 'response.reasoning.delta') {
      return [...this.start(), {
        type: 'content_block_delta', index: this.blockIndex(`item:${event.index}`),
        delta: { type: 'thinking_delta', thinking: event.text },
      }];
    }
    if (event.type === 'response.function_call.arguments.delta') {
      return [...this.start(), {
        type: 'content_block_delta', index: this.blockIndex(`item:${event.index}`),
        delta: { type: 'input_json_delta', partial_json: event.argumentsDelta },
      }];
    }
    if (event.type === 'response.content_part.done') {
      return this.stopBlock(`part:${event.index}:${event.partIndex}`);
    }
    if (event.type === 'response.output_item.done') {
      if (event.item.type === 'reasoning' && event.item.signature) {
        const index = this.blockIndex(`item:${event.index}`);
        return [
          { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: event.item.signature } },
          ...this.stopBlock(`item:${event.index}`),
        ];
      }
      return this.stopBlock(`item:${event.index}`);
    }
    if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      if (this.terminal) return [];
      this.terminal = true;
      const reason = event.type === 'response.completed' ? undefined : event.reason;
      const effectiveReason = reason ?? (this.sawToolCall ? 'tool_calls' : undefined);
      const response: CanonicalResponse = finalResponse ?? {
        id: this.id, model: this.model || model, status: event.type === 'response.completed' ? 'completed'
          : event.type === 'response.incomplete' ? 'incomplete' : 'failed',
        ...(effectiveReason ? { reason: effectiveReason } : {}),
        ...(event.type === 'response.failed' && event.error ? { error: event.error } : {}),
        output: [], usage: this.usage,
      };
      if (event.type === 'response.failed') {
        return [{
          type: 'error',
          error: { type: 'api_error', message: response.error?.message ?? response.reason ?? 'Upstream stream failed.' },
        }];
      }
      // A finish/decoder gap can leave text/tool blocks open — close them so
      // message_stop is never preceded by an unfinished content_block_start.
      const dangling = [...this.blocks.entries()]
        .sort((a, b) => a[1] - b[1])
        .flatMap(([key]) => this.stopBlock(key));
      return [
        ...this.start(),
        ...dangling,
        {
          type: 'message_delta',
          delta: { stop_reason: stopReasonOf(response), stop_sequence: response.vendor?.anthropic?.stopSequence ?? null },
          usage: usageToAnthropic(response.usage),
        },
        { type: 'message_stop' },
      ];
    }
    if (event.type === 'error') {
      if (this.terminal) return [];
      this.terminal = true;
      return [{ type: 'error', error: { type: 'api_error', message: event.message } }];
    }
    return [];
  }

  private start(): Wire[] {
    if (this.started) return [];
    this.started = true;
    return [{
      type: 'message_start',
      message: {
        id: this.id, type: 'message', role: 'assistant', model: this.model,
        content: [], stop_reason: null, stop_sequence: null, usage: usageToAnthropic(this.usage, true),
      },
    }];
  }

  private blockFor(key: string, content: Wire): Wire {
    const index = this.nextBlock++;
    this.blocks.set(key, index);
    return { type: 'content_block_start', index, content_block: content };
  }

  private blockIndex(key: string): number {
    const index = this.blocks.get(key);
    if (index === undefined) fail('stream_lifecycle', `Anthropic stream delta references an unopened block (${key}).`);
    return index;
  }

  private stopBlock(key: string): Wire[] {
    const index = this.blocks.get(key);
    if (index === undefined) return [];
    this.blocks.delete(key);
    return [{ type: 'content_block_stop', index }];
  }
}

function reasoningStart(item: Extract<OutputItem, { type: 'reasoning' }>): Wire {
  const redacted = item.vendor?.anthropic?.blockType === 'redacted_thinking' || (!item.text && item.encrypted);
  // Signature is delivered via `signature_delta` on output_item.done, never on
  // content_block_start (emitting it in both places duplicates the signature).
  return redacted
    ? { type: 'redacted_thinking', data: item.encrypted ?? '' }
    : { type: 'thinking', thinking: '' };
}

export { usageFromWire as anthropicUsageFromWire };

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatMessageContentPart,
  Tool as ChatTool,
} from '../../types/openai.js';
import { IrUnsupportedError } from '../errors.js';
import { DATA_URL_RE } from '../media.js';
import { assertCanonicalRequestSupported, assertCanonicalResponseSupported } from '../validate.js';
import type {
  CacheBreakpoint,
  CanonicalCandidate,
  CanonicalRequest,
  CanonicalResponse,
  ContentPart,
  GenerationParams,
  InputItem,
  OutputItem,
  TextConfig,
  ToolDef,
  Usage,
} from '../types.js';

/** Options for the legacy execution bridge and the OpenAI-chat southbound wire. */
export interface ChatAdapterOptions {
  /** Keep Anthropic/Responses-only cache markers. Generic chat wires disable this. */
  carrierExtensions?: boolean;
}

function unsupported(code: string, message: string): never {
  throw new IrUnsupportedError(code, message, 'openai-chat');
}

function cacheOf(raw: unknown, prompt?: Record<string, unknown>): CacheBreakpoint | undefined {
  const out: CacheBreakpoint = {};
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    if (typeof rec.type === 'string') out.type = rec.type;
    if (typeof rec.ttl === 'string') out.ttl = rec.ttl;
    else if (!prompt && typeof rec.type !== 'string') out.raw = rec;
  }
  // Responses `prompt_cache_breakpoint` owns `raw` when both spellings are present.
  if (prompt) out.raw = prompt;
  return out.type || out.ttl || out.raw ? out : undefined;
}

function cacheControlOf(cache: CacheBreakpoint): Record<string, unknown> {
  // `raw` is the Responses breakpoint when a part carries both spellings.
  // Never leak that object into Anthropic's cache_control marker.
  if (cache.type) return { type: cache.type, ...(cache.ttl ? { ttl: cache.ttl } : {}) };
  return cache.raw ?? {};
}

export function partsFromChat(content: ChatMessage['content'] | null): ContentPart[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return content.map((p): ContentPart => {
    const cache = cacheOf(p.cache_control, p.prompt_cache_breakpoint);
    if (p.type === 'text') {
      return {
        type: 'text',
        text: p.text ?? '',
        ...(cache ? { cache } : {}),
      };
    }
    if (p.type === 'image_url' && p.image_url?.url) {
      const inline = DATA_URL_RE.exec(p.image_url.url);
      return {
        type: 'image',
        source: inline
          ? { kind: 'base64', mediaType: inline[1], data: inline[2] }
          : { kind: 'url', url: p.image_url.url },
        ...(p.image_url.detail ? { detail: p.image_url.detail } : {}),
        ...(cache ? { cache } : {}),
      };
    }
    return unsupported('content_part', `Unsupported chat content part: ${String((p as { type?: string }).type)}`);
  });
}

export function chatContentFromParts(
  parts: ContentPart[],
  protocol = 'openai-chat',
  options: ChatAdapterOptions = {},
): string | ChatMessageContentPart[] | null {
  const carrierExtensions = options.carrierExtensions !== false;
  if (parts.length === 0) return null;
  if (parts.every((p) => p.type === 'text' && (!p.cache || !carrierExtensions))) {
    return parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n\n');
  }
  return parts.map((p): ChatMessageContentPart => {
    if (p.type === 'text') {
      return {
        type: 'text',
        text: p.text,
        ...(carrierExtensions && p.cache?.type ? { cache_control: cacheControlOf(p.cache) } : {}),
        ...(carrierExtensions && p.cache?.raw ? { prompt_cache_breakpoint: p.cache.raw } : {}),
      };
    }
    if (p.type === 'image' && p.source.kind !== 'file') {
      const url = p.source.kind === 'base64'
        ? `data:${p.source.mediaType};base64,${p.source.data}`
        : p.source.url;
      return {
        type: 'image_url',
        image_url: { url, ...(p.detail ? { detail: p.detail } : {}) },
        ...(carrierExtensions && p.cache?.type ? { cache_control: cacheControlOf(p.cache) } : {}),
        ...(carrierExtensions && p.cache?.raw ? { prompt_cache_breakpoint: p.cache.raw } : {}),
      };
    }
    throw new IrUnsupportedError('content_part', `Chat cannot carry a ${p.type} part`, protocol);
  });
}

function generationFromChat(req: ChatCompletionRequest): GenerationParams | undefined {
  const out: GenerationParams = {};
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.topP = req.top_p;
  if (req.max_tokens !== undefined) out.maxOutputTokens = req.max_tokens;
  else if (req.max_completion_tokens !== undefined) out.maxOutputTokens = req.max_completion_tokens;
  if (req.stop !== undefined) out.stop = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (req.seed !== undefined) out.seed = req.seed;
  if (req.presence_penalty !== undefined) out.presencePenalty = req.presence_penalty;
  if (req.frequency_penalty !== undefined) out.frequencyPenalty = req.frequency_penalty;
  return Object.keys(out).length ? out : undefined;
}

function textFromChat(req: ChatCompletionRequest): TextConfig | undefined {
  const format = req.response_format;
  if (!format) return undefined;
  if (format.type === 'json_schema') {
    const detail = format.json_schema;
    if (!detail?.schema) {
      return unsupported('response_format', 'Chat json_schema response_format requires json_schema.schema.');
    }
    return {
      format: {
        type: 'json_schema',
        schema: detail.schema,
        ...(detail.name ? { name: detail.name } : {}),
        ...(detail.description ? { description: detail.description } : {}),
        ...(detail.strict !== undefined ? { strict: detail.strict } : {}),
      },
    };
  }
  if (format.type === 'json_object' || format.type === 'text') return { format: { type: format.type } };
  return unsupported('response_format', `Unsupported chat response_format: ${String((format as { type?: unknown }).type)}`);
}

/** Extract reasoning text across OpenAI-compatible dialects (`reasoning_content`, `reasoning`, `reasoning_details`). */
export function extractChatReasoningText(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.reasoning_content === 'string') return obj.reasoning_content;
  if (typeof obj.reasoning === 'string') return obj.reasoning;
  if (Array.isArray(obj.reasoning_details)) {
    const parts = obj.reasoning_details
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return '';
        const item = entry as Record<string, unknown>;
        if (typeof item.text === 'string') return item.text;
        if (typeof item.summary === 'string') return item.summary;
        return '';
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join('');
  }
  return undefined;
}

export function chatRequestToIR(req: ChatCompletionRequest): CanonicalRequest {
  const input: InputItem[] = [];
  for (const msg of req.messages) {
    if (msg.role === 'tool') {
      input.push({
        type: 'tool_result',
        callId: msg.tool_call_id ?? '',
        content: partsFromChat(msg.content),
        ...(msg.cache_control ? { cache: cacheOf(msg.cache_control) } : {}),
      });
      continue;
    }
    if (msg.role === 'assistant') {
      const reasoning = extractChatReasoningText(msg);
      if (reasoning) input.push({ type: 'reasoning', text: reasoning });
    }
    // Keep prose/refusal and tool calls in one contiguous assistant group. The
    // reverse adapter folds that group back into ONE chat assistant message.
    let assistantMessageEmitted = false;
    if (
      msg.role === 'assistant' &&
      (msg.content !== null && msg.content !== undefined) &&
      (typeof msg.content !== 'string' || msg.content.length > 0 || !msg.tool_calls?.length)
    ) {
      assistantMessageEmitted = true;
      input.push({
        type: 'message',
        role: 'assistant',
        content: partsFromChat(msg.content),
        ...(msg.name ? { name: msg.name } : {}),
        ...(msg.cache_control ? { cache: cacheOf(msg.cache_control) } : {}),
      });
    }
    if (msg.role === 'assistant' && msg.refusal) {
      input.push({ type: 'message', role: 'assistant', content: [{ type: 'refusal', text: msg.refusal }] });
    }
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const msgCache = !assistantMessageEmitted && msg.cache_control ? cacheOf(msg.cache_control) : undefined;
      msg.tool_calls.forEach((call, idx) => {
        const isLast = idx === msg.tool_calls!.length - 1;
        input.push({
          type: 'tool_call',
          id: call.id,
          callId: call.id,
          name: call.function.name,
          arguments: call.function.arguments ?? '{}',
          ...(isLast && msgCache ? { cache: msgCache } : {}),
        });
      });
      continue;
    }
    if (msg.role !== 'assistant') {
      input.push({
        type: 'message',
        role: msg.role,
        content: partsFromChat(msg.content),
        ...(msg.name ? { name: msg.name } : {}),
        ...(msg.cache_control ? { cache: cacheOf(msg.cache_control) } : {}),
      });
    } else if (!msg.reasoning_content && !msg.refusal && (msg.content === null || msg.content === undefined)) {
      // Preserve an explicitly empty assistant turn even without tool calls.
      input.push({ type: 'message', role: 'assistant', content: [] });
    }
  }

  const tools: ToolDef[] | undefined = req.tools?.map((t: ChatTool): ToolDef => ({
    type: 'function',
    function: {
      name: t.function.name,
      ...(t.function.description !== undefined ? { description: t.function.description } : {}),
      parameters: t.function.parameters ?? { type: 'object', properties: {} },
      ...(typeof t.function.strict === 'boolean' ? { strict: t.function.strict } : {}),
      ...(t.function.cache_control ? { cache: cacheOf(t.function.cache_control) } : {}),
    },
  }));

  const generation = generationFromChat(req);
  const text = textFromChat(req);
  return {
    model: req.model,
    stream: req.stream === true,
    input,
    // Reserved mock-mode controls are gateway-only and never rendered upstream.
    ...Object.fromEntries(Object.entries(req).filter(([key]) => key.startsWith('__simulate_'))),
    ...(req.router_options ? {
      routerOptions: {
        ...(req.router_options.force_tier ? { forceTier: req.router_options.force_tier } : {}),
        ...(req.router_options.disable_fallback !== undefined ? { disableFallback: req.router_options.disable_fallback } : {}),
        ...(req.router_options.failover !== undefined ? { failover: req.router_options.failover } : {}),
        ...(req.router_options.session_id ? { sessionId: req.router_options.session_id } : {}),
        ...(req.router_options.client_ref ? { clientRef: req.router_options.client_ref } : {}),
      },
    } : {}),
    ...(req.logit_bias !== undefined ? { logitBias: req.logit_bias } : {}),
    ...(req.logprobs !== undefined ? { logprobs: req.logprobs } : {}),
    ...(req.top_logprobs !== undefined ? { topLogprobs: req.top_logprobs } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(req.tool_choice !== undefined
      ? {
        toolChoice:
          req.tool_choice === 'auto' || req.tool_choice === 'none' || req.tool_choice === 'required'
            ? { type: req.tool_choice }
            : { type: 'function' as const, name: req.tool_choice.function.name },
      }
      : {}),
    ...(req.parallel_tool_calls !== undefined ? { parallelToolCalls: req.parallel_tool_calls } : {}),
    ...(generation ? { generation } : {}),
    ...(text ? { text } : {}),
    ...(req.reasoning_effort || req.max_thinking_tokens !== undefined
      ? {
        reasoning: {
          ...(req.reasoning_effort ? { effort: req.reasoning_effort } : {}),
          ...(req.max_thinking_tokens !== undefined ? { budgetTokens: req.max_thinking_tokens } : {}),
        },
      }
      : {}),
    ...(req.prompt_cache_key || req.prompt_cache_retention || req.prompt_cache_options
      ? {
        cache: {
          ...(req.prompt_cache_key ? { key: req.prompt_cache_key } : {}),
          ...(req.prompt_cache_retention ? { retention: req.prompt_cache_retention } : {}),
          ...(req.prompt_cache_options ? { options: req.prompt_cache_options } : {}),
        },
      }
      : {}),
    ...(req.n !== undefined ? { n: req.n } : {}),
    ...(req.user !== undefined ? { user: req.user } : {}),
    ...(req.service_tier !== undefined ? { serviceTier: req.service_tier } : {}),
    ...(req.safety_identifier !== undefined ? { safetyIdentifier: req.safety_identifier } : {}),
    ...(req.stream_options !== undefined
      ? {
        streamOptions: {
          ...(req.stream_options.include_usage !== undefined ? { includeUsage: req.stream_options.include_usage } : {}),
        },
      }
      : {}),
    ...(req.metadata !== undefined ? { metadata: req.metadata } : {}),
  };
}

function appendAssistantContent(
  current: { content: string | ChatMessageContentPart[] | null },
  addition: ChatMessage['content'] | null,
): void {
  if (addition === null) return;
  if (typeof current.content === 'string' && typeof addition === 'string') {
    current.content += addition;
    return;
  }
  const left = typeof current.content === 'string'
    ? current.content ? [{ type: 'text' as const, text: current.content }] : []
    : current.content ?? [];
  const right = typeof addition === 'string'
    ? addition ? [{ type: 'text' as const, text: addition }] : []
    : addition;
  current.content = [...left, ...right];
}

/** IR → the legacy execution request / OpenAI-chat request. */
export function irToChatRequest(
  ir: CanonicalRequest,
  model: string,
  options: ChatAdapterOptions = {},
): ChatCompletionRequest {
  assertCanonicalRequestSupported(ir, 'openai-chat', {
    stripCarrierExtensions: options.carrierExtensions === false,
  });
  const messages: ChatMessage[] = [];
  let assistant: ChatMessage | undefined;
  const ensureAssistant = (): ChatMessage => {
    if (!assistant) {
      assistant = { role: 'assistant', content: '' };
      messages.push(assistant);
    }
    return assistant;
  };
  // Mirror Responses/Anthropic/Google: fold instructions + system/developer into
  // ONE system message so cross-provider failover cannot duplicate the prompt.
  const systemChunks: string[] = [];
  let systemCache: CacheBreakpoint | undefined;
  if (ir.instructions) systemChunks.push(ir.instructions);

  for (const item of ir.input) {
    if (item.type === 'message' && (item.role === 'system' || item.role === 'developer')) {
      const texts = item.content.map((part) => {
        if (part.type !== 'text') unsupported('system_part', 'Chat system/developer messages carry text only.');
        if (!systemCache && part.cache) systemCache = part.cache;
        return part.text;
      });
      if (texts.length) systemChunks.push(texts.join('\n\n'));
      if (!systemCache && item.cache) systemCache = item.cache;
      continue;
    }
    if (item.type === 'reasoning') {
      if (item.signature || item.encrypted) {
        unsupported('reasoning_signature', 'Chat cannot replay signed or encrypted reasoning items.');
      }
      const msg = ensureAssistant();
      msg.reasoning_content = [msg.reasoning_content, item.text, ...(item.summary ?? [])]
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .join('\n');
      continue;
    }
    if (item.type === 'message' && item.role === 'assistant') {
      const msg = ensureAssistant();
      const refusals = item.content.filter((p): p is Extract<ContentPart, { type: 'refusal' }> => p.type === 'refusal');
      const visible = item.content.filter((p) => p.type !== 'refusal');
      appendAssistantContent(msg, chatContentFromParts(visible, 'openai-chat', options));
      if (refusals.length) msg.refusal = [msg.refusal, ...refusals.map((r) => r.text)].filter(Boolean).join('\n');
      if (item.name) msg.name = item.name;
      if (options.carrierExtensions !== false && item.cache) msg.cache_control = cacheControlOf(item.cache);
      continue;
    }
    if (item.type === 'tool_call') {
      if (item.signature) unsupported('tool_call_signature', 'Chat cannot replay a signed tool call.');
      const msg = ensureAssistant();
      msg.tool_calls = [
        ...(msg.tool_calls ?? []),
        {
          id: item.callId ?? item.id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments },
        },
      ];
      if (options.carrierExtensions !== false && item.cache) msg.cache_control = cacheControlOf(item.cache);
      continue;
    }
    assistant = undefined;
    if (item.type === 'tool_result') {
      if (!item.content.every((p) => p.type === 'text')) {
        unsupported('tool_result_content', 'Chat tool messages carry text only.');
      }
      const toolCache =
        item.cache ??
        item.content.find((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text' && Boolean(p.cache))
          ?.cache;
      messages.push({
        role: 'tool',
        content: item.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n\n'),
        tool_call_id: item.callId,
        ...(options.carrierExtensions !== false && toolCache ? { cache_control: cacheControlOf(toolCache) } : {}),
      });
      continue;
    }
    if (item.type === 'message') {
      messages.push({
        role: item.role,
        content: chatContentFromParts(item.content, 'openai-chat', options) ?? '',
        ...(item.name ? { name: item.name } : {}),
        ...(options.carrierExtensions !== false && item.cache ? { cache_control: cacheControlOf(item.cache) } : {}),
      });
      continue;
    }
    if (item.type === 'item_reference') {
      unsupported('item_reference', `Chat cannot resolve item_reference "${item.id}".`);
    }
    unsupported('input_item', `Chat cannot carry an extension item (${(item as { protocol?: string }).protocol ?? 'unknown'}).`);
  }

  if (systemChunks.length) {
    const vendorSystemCache = ir.vendor?.anthropic?.systemCache;
    if (!systemCache && vendorSystemCache && typeof vendorSystemCache === 'object') {
      systemCache = vendorSystemCache as CacheBreakpoint;
    }
    messages.unshift({
      role: 'system',
      content: systemChunks.join('\n\n'),
      ...(options.carrierExtensions !== false && systemCache ? { cache_control: cacheControlOf(systemCache) } : {}),
    });
  }

  const gen = ir.generation;
  const tools = ir.tools?.map((t) => {
    if (t.type !== 'function') {
      unsupported('tool_type', `Chat carries function tools only, not ${t.type}.`);
    }
    return {
      type: 'function' as const,
      function: {
        name: t.function.name,
        ...(t.function.description !== undefined ? { description: t.function.description } : {}),
        parameters: t.function.parameters ?? { type: 'object', properties: {} },
        ...(t.function.strict !== undefined ? { strict: t.function.strict } : {}),
        ...(options.carrierExtensions !== false && t.function.cache
          ? { cache_control: cacheControlOf(t.function.cache) }
          : {}),
      },
    };
  });
  const toolChoice = ir.toolChoice
    ? ir.toolChoice.type === 'function'
      ? { type: 'function' as const, function: { name: ir.toolChoice.name } }
      : ir.toolChoice.type === 'auto' || ir.toolChoice.type === 'none' || ir.toolChoice.type === 'required'
        ? ir.toolChoice.type
        : unsupported('tool_choice', `Chat cannot express tool_choice ${ir.toolChoice.type}.`)
    : undefined;
  if (ir.text?.verbosity) unsupported('text_verbosity', 'Chat cannot represent text.verbosity on this execution bridge.');
  if (ir.reasoning?.summary) unsupported('reasoning_summary', 'Chat cannot represent reasoning.summary.');
  for (const [code, value] of Object.entries({
    store: ir.store,
    previous_response_id: ir.previousResponseId,
    conversation: ir.conversation,
    prompt: ir.prompt,
    background: ir.background,
    include: ir.include,
    truncation: ir.truncation,
  })) {
    if (value !== undefined) unsupported(code, `Chat cannot represent ${code}.`);
  }

  return {
    model,
    stream: ir.stream,
    messages,
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(ir.parallelToolCalls !== undefined ? { parallel_tool_calls: ir.parallelToolCalls } : {}),
    ...(gen?.temperature !== undefined ? { temperature: gen.temperature } : {}),
    ...(gen?.topP !== undefined ? { top_p: gen.topP } : {}),
    ...(gen?.maxOutputTokens !== undefined ? { max_tokens: gen.maxOutputTokens } : {}),
    ...(gen?.stop ? { stop: gen.stop } : {}),
    ...(gen?.seed !== undefined ? { seed: gen.seed } : {}),
    ...(gen?.presencePenalty !== undefined ? { presence_penalty: gen.presencePenalty } : {}),
    ...(gen?.frequencyPenalty !== undefined ? { frequency_penalty: gen.frequencyPenalty } : {}),
    ...(ir.n !== undefined ? { n: ir.n } : {}),
    ...(ir.logitBias !== undefined ? { logit_bias: ir.logitBias } : {}),
    ...(ir.logprobs !== undefined ? { logprobs: ir.logprobs } : {}),
    ...(ir.topLogprobs !== undefined ? { top_logprobs: ir.topLogprobs } : {}),
    ...(ir.text?.format
      ? {
        response_format:
          ir.text.format.type === 'json_schema'
            ? {
              type: 'json_schema' as const,
              json_schema: {
                name: ir.text.format.name ?? 'output',
                schema: ir.text.format.schema,
                ...(ir.text.format.description !== undefined ? { description: ir.text.format.description } : {}),
                ...(ir.text.format.strict !== undefined ? { strict: ir.text.format.strict } : {}),
              },
            }
            : { type: ir.text.format.type },
      }
      : {}),
    ...(ir.reasoning?.effort ? { reasoning_effort: ir.reasoning.effort } : {}),
    ...(options.carrierExtensions !== false && ir.reasoning?.budgetTokens !== undefined
      ? { max_thinking_tokens: ir.reasoning.budgetTokens }
      : {}),
    ...(ir.cache?.key ? { prompt_cache_key: ir.cache.key } : {}),
    ...(options.carrierExtensions !== false && ir.cache?.retention ? { prompt_cache_retention: ir.cache.retention } : {}),
    ...(options.carrierExtensions !== false && ir.cache?.options ? { prompt_cache_options: ir.cache.options } : {}),
    ...(ir.user !== undefined ? { user: ir.user } : {}),
    ...(ir.serviceTier !== undefined ? { service_tier: ir.serviceTier } : {}),
    ...(ir.safetyIdentifier !== undefined ? { safety_identifier: ir.safetyIdentifier } : {}),
    ...(ir.streamOptions !== undefined
      ? {
        stream_options: {
          ...(ir.streamOptions.includeUsage !== undefined ? { include_usage: ir.streamOptions.includeUsage } : {}),
        },
      }
      : {}),
    ...(ir.metadata !== undefined ? { metadata: ir.metadata as Record<string, string> } : {}),
  };
}

export function usageToIR(usage: ChatCompletionResponse['usage']): Usage {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    ...(usage?.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
    ...(usage?.prompt_tokens_details?.cached_tokens !== undefined
      ? { cachedInputTokens: usage.prompt_tokens_details.cached_tokens }
      : {}),
    ...(usage?.prompt_tokens_details?.audio_tokens !== undefined
      ? { audioInputTokens: usage.prompt_tokens_details.audio_tokens }
      : {}),
    ...(usage?.completion_tokens_details?.reasoning_tokens !== undefined
      ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }
      : {}),
    ...(usage?.completion_tokens_details?.audio_tokens !== undefined
      ? { audioOutputTokens: usage.completion_tokens_details.audio_tokens }
      : {}),
    ...(usage?.completion_tokens_details?.accepted_prediction_tokens !== undefined
      ? { acceptedPredictionTokens: usage.completion_tokens_details.accepted_prediction_tokens }
      : {}),
    ...(usage?.completion_tokens_details?.rejected_prediction_tokens !== undefined
      ? { rejectedPredictionTokens: usage.completion_tokens_details.rejected_prediction_tokens }
      : {}),
  };
}

function choiceToCandidate(choice: ChatCompletionResponse['choices'][number]): CanonicalCandidate {
  const output: OutputItem[] = [];
  const reasoning = extractChatReasoningText(choice.message);
  if (reasoning) output.push({ type: 'reasoning', text: reasoning });
  if (choice.message.content !== null && choice.message.content !== undefined && choice.message.content !== '') {
    output.push({ type: 'message', role: 'assistant', content: partsFromChat(choice.message.content) });
  }
  if (choice.message.refusal) {
    output.push({ type: 'message', role: 'assistant', content: [{ type: 'refusal', text: choice.message.refusal }] });
  }
  for (const call of choice.message.tool_calls ?? []) {
    output.push({
      type: 'tool_call',
      id: call.id,
      callId: call.id,
      name: call.function.name,
      arguments: call.function.arguments ?? '{}',
    });
  }
  const reason = choice.finish_reason;
  return {
    index: choice.index,
    status: reason === 'length' || reason === 'content_filter' ? 'incomplete' : 'completed',
    ...(reason ? { reason } : {}),
    output,
  };
}

export function chatResponseToIR(resp: ChatCompletionResponse): CanonicalResponse {
  const first = resp.choices[0];
  if (!first) unsupported('empty_response', 'Chat response has no choices.');
  const candidates = resp.choices.map(choiceToCandidate);
  const primary = candidates[0]!;
  return {
    id: resp.id,
    model: resp.model,
    createdAt: resp.created,
    status: primary.status,
    ...(primary.reason ? { reason: primary.reason } : {}),
    output: primary.output,
    ...(candidates.length > 1 ? { candidates } : {}),
    usage: usageToIR(resp.usage),
    ...(resp.system_fingerprint ? { systemFingerprint: resp.system_fingerprint } : {}),
  };
}

function candidateToChatChoice(
  candidate: CanonicalCandidate,
): ChatCompletionResponse['choices'][number] {
  const message: ChatCompletionResponse['choices'][number]['message'] = { role: 'assistant', content: '' };
  for (const item of candidate.output) {
    if (item.type === 'reasoning') {
      message.reasoning_content = [message.reasoning_content, item.text, ...(item.summary ?? [])]
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .join('\n');
      continue;
    }
    if (item.type === 'tool_call') {
      message.tool_calls = [
        ...(message.tool_calls ?? []),
        {
          id: item.callId ?? item.id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments },
        },
      ];
      continue;
    }
    if (item.type === 'message') {
      const refusals = item.content.filter((p): p is Extract<ContentPart, { type: 'refusal' }> => p.type === 'refusal');
      const visible = item.content.filter((p) => p.type !== 'refusal');
      appendAssistantContent(message, chatContentFromParts(visible) ?? '');
      if (refusals.length) message.refusal = [message.refusal, ...refusals.map((r) => r.text)].filter(Boolean).join('\n');
      continue;
    }
    unsupported('output_item', `Chat cannot carry an extension output item (${item.type}).`);
  }
  const finish = candidate.status === 'incomplete'
    ? candidate.reason === 'content_filter' ? 'content_filter' : 'length'
    : candidate.status === 'failed'
      ? 'content_filter'
      : candidate.reason === 'tool_calls' || candidate.output.some((i) => i.type === 'tool_call')
        ? 'tool_calls'
        : 'stop';
  return { index: candidate.index, message, finish_reason: finish };
}

export function irToChatResponse(ir: CanonicalResponse, id: string, model: string): ChatCompletionResponse {
  assertCanonicalResponseSupported(ir, 'openai-chat');
  const candidates = ir.candidates?.length
    ? ir.candidates
    : [{ index: 0, status: ir.status, ...(ir.reason ? { reason: ir.reason } : {}), output: ir.output }];
  return {
    id,
    object: 'chat.completion',
    created: ir.createdAt ?? Math.floor(Date.now() / 1000),
    model,
    choices: candidates.map(candidateToChatChoice),
    usage: {
      prompt_tokens: ir.usage.inputTokens,
      completion_tokens: ir.usage.outputTokens,
      total_tokens: ir.usage.totalTokens ?? ir.usage.inputTokens + ir.usage.outputTokens,
      ...(ir.usage.cachedInputTokens !== undefined || ir.usage.audioInputTokens !== undefined
        ? {
          prompt_tokens_details: {
            ...(ir.usage.cachedInputTokens !== undefined ? { cached_tokens: ir.usage.cachedInputTokens } : {}),
            ...(ir.usage.audioInputTokens !== undefined ? { audio_tokens: ir.usage.audioInputTokens } : {}),
          },
        }
        : {}),
      ...(ir.usage.reasoningTokens !== undefined || ir.usage.audioOutputTokens !== undefined ||
        ir.usage.acceptedPredictionTokens !== undefined ||
        ir.usage.rejectedPredictionTokens !== undefined
        ? {
          completion_tokens_details: {
            ...(ir.usage.reasoningTokens !== undefined ? { reasoning_tokens: ir.usage.reasoningTokens } : {}),
            ...(ir.usage.audioOutputTokens !== undefined ? { audio_tokens: ir.usage.audioOutputTokens } : {}),
            ...(ir.usage.acceptedPredictionTokens !== undefined
              ? { accepted_prediction_tokens: ir.usage.acceptedPredictionTokens }
              : {}),
            ...(ir.usage.rejectedPredictionTokens !== undefined
              ? { rejected_prediction_tokens: ir.usage.rejectedPredictionTokens }
              : {}),
          },
        }
        : {}),
    },
    ...(ir.systemFingerprint ? { system_fingerprint: ir.systemFingerprint } : {}),
  };
}

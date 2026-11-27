import { capabilitiesFor, type ProtocolCapabilities } from './capabilities.js';
import { IrUnsupportedError } from './errors.js';
import type {
  CacheBreakpoint,
  CanonicalRequest,
  CanonicalResponse,
  ContentPart,
  GenerationParams,
  InputItem,
  OutputItem,
  ProtocolId,
  StreamEvent,
  ToolChoice,
} from './types.js';

/** Request = southbound payload; response = northbound encoder. Same matrix,
 *  but a few carriers accept a field on one leg only (Responses signatures). */
export type ValidationDirection = 'request' | 'response';

export interface RequestValidationOptions {
  /** Generic OpenAI wires deliberately strip foreign carrier cache extensions. */
  stripCarrierExtensions?: boolean;
}

/** Default fix when a capability is simply missing on the dialed wire. */
const GENERIC_HINT = 'Omit this field or use a protocol that supports it';

/**
 * Client-visible unsupported_parameter body. One voice for the gate and adapters:
 * feature + dialed protocol + actionable hint. Dial context (model / protocols[])
 * is layered on by `withDialContext` in the registry.
 */
export function formatUnsupported(protocol: ProtocolId, feature: string, hint: string = GENERIC_HINT): string {
  const tip = hint.trim().replace(/\.$/, '');
  return `Unsupported on outbound protocol '${protocol}': ${feature}. ${tip}.`;
}

/** Carrier shape family. The chat family is the DEFAULT: the three typed
 *  carriers are named, and every other protocol id (systemone, an OCR-native
 *  wire, any plugin wire) exposes the chat shape. */
function isChatProtocol(protocol: ProtocolId): boolean {
  return protocol !== 'openai-responses' && protocol !== 'anthropic-messages' && protocol !== 'google-gemini';
}

function fail(protocol: ProtocolId, code: string, feature: string, hint: string = GENERIC_HINT): never {
  throw new IrUnsupportedError(code, formatUnsupported(protocol, feature, hint), protocol);
}

/**
 * Operator-facing copy when a wire rejects non-function tools.
 * OpenAI Platform Chat Completions added `type:"custom"` in 2025-08, but OCR's
 * `openai-chat` id is the *portable* Chat Completions contract used by Xiaomi /
 * DeepSeek / Kimi-style compat endpoints — those accept function tools, not
 * OpenAI's freeform/grammar custom dialect or Responses builtins.
 */
export function unsupportedToolKindMessage(
  protocol: ProtocolId,
  kind: string,
  forChoice: boolean,
): string {
  const feature = forChoice ? `Forcing a ${kind} tool (tool_choice)` : `${kind} tools`;
  const responsesHint =
    `Add 'openai-responses' to the model's protocols[] if the vendor can serve it, or use a model whose protocols admit ${kind} tools`;
  if (isChatProtocol(protocol) && (kind === 'custom' || kind === 'builtin')) {
    const chatHint =
      kind === 'custom'
        ? `Portable openai-chat carries function tools only; ${responsesHint}`
        : `Portable openai-chat cannot carry builtin/hosted tools; ${responsesHint}`;
    return formatUnsupported(protocol, feature, chatHint);
  }
  if (kind === 'custom' || kind === 'builtin') {
    return formatUnsupported(protocol, feature, responsesHint);
  }
  return formatUnsupported(protocol, feature);
}

/**
 * Layer dial facts onto a gate/adapter refusal so the client sees which model
 * and protocols[] were in play. Same code/protocol; message only.
 */
export function withDialContext(
  err: IrUnsupportedError,
  opts: { modelId: string; dialWire: string; protocols?: readonly string[] },
): IrUnsupportedError {
  if (err.message.startsWith('Request for model ')) return err;
  const list =
    opts.protocols && opts.protocols.length > 0
      ? opts.protocols.join(', ')
      : opts.dialWire;
  const message = `Request for model '${opts.modelId}' (declared protocols: ${list}): ${err.message}`;
  return new IrUnsupportedError(err.code, message, err.protocol ?? opts.dialWire);
}

function validateCache(
  cache: CacheBreakpoint,
  protocol: ProtocolId,
  supported: boolean,
  code: string,
  feature: string,
  strip: boolean,
  hint: string = GENERIC_HINT,
): void {
  if (strip) return;
  if (!supported) fail(protocol, code, feature, hint);
  // Responses breakpoints are opaque objects; Anthropic only accepts its own
  // typed cache_control marker. Replaying a foreign marker is not passthrough.
  if (protocol === 'anthropic-messages' && cache.raw && !cache.type) {
    fail(protocol, code, 'Foreign raw cache breakpoints', 'Use an Anthropic cache_control marker');
  }
  if (protocol === 'openai-responses' && cache.type && !cache.raw) {
    fail(protocol, code, 'Anthropic cache_control breakpoints', 'Use a Responses prompt_cache breakpoint');
  }
}

function validatePart(
  part: ContentPart,
  protocol: ProtocolId,
  caps: ProtocolCapabilities,
  stripCarrierExtensions = false,
): void {
  if (part.type === 'extension') {
    if (part.protocol !== protocol) {
      fail(protocol, 'extension_part', `${part.protocol} extension content`, 'Keep same-carrier extensions only');
    }
    return;
  }
  if (!caps.parts[part.type]) fail(protocol, `${part.type}_part`, `${part.type} content parts`);
  if ('cache' in part && part.cache) {
    validateCache(
      part.cache, protocol, caps.cache.part_breakpoint === true,
      'cache_part_breakpoint', 'Content cache breakpoints', stripCarrierExtensions,
    );
  }
  if ('source' in part) {
    const allowed = caps.sources[part.type] ?? [];
    if (!allowed.includes(part.source.kind)) {
      fail(protocol, `${part.type}_source`, `${part.source.kind} ${part.type} sources`);
    }
  }
  if ((part.type === 'text' || part.type === 'image' || part.type === 'file' || part.type === 'audio') && part.signature) {
    if (!caps.reasoningSignature) fail(protocol, 'content_signature', 'Signed content replay');
  }
  if (part.type === 'text' && part.annotations?.length && !caps.annotations) {
    fail(protocol, 'annotations', 'Text annotations');
  }
  if (part.type === 'text' && part.logprobs?.length && !caps.logprobs) {
    fail(protocol, 'logprobs', 'Token log probabilities on content');
  }
}

function validateToolChoice(choice: ToolChoice | undefined, protocol: ProtocolId, caps: ProtocolCapabilities): void {
  if (!choice) return;
  if (choice.type === 'custom' && !caps.toolKinds.custom) {
    throw new IrUnsupportedError('tool_choice', unsupportedToolKindMessage(protocol, 'custom', true), protocol);
  }
  if (choice.type === 'allowed' && !caps.allowedToolChoice) {
    fail(protocol, 'allowed_tools', 'allowed_tools tool_choice');
  }
}

/**
 * Fail-visible conversion gate. It is deliberately adapter-independent: every
 * southbound wire runs the SAME checks before it builds its payload, so adding
 * a new protocol cannot reintroduce silent field loss in a peripheral builder.
 */
export function assertCanonicalRequestSupported(
  ir: CanonicalRequest,
  protocol: ProtocolId,
  options: RequestValidationOptions = {},
): void {
  const caps = capabilitiesFor(protocol);
  const strip = options.stripCarrierExtensions === true;
  for (const item of ir.input) validateItem(item, protocol, caps, strip, 'request');
  for (const tool of ir.tools ?? []) {
    if (tool.type === 'extension') {
      if (tool.protocol !== protocol) {
        fail(protocol, 'extension_tool', `${tool.protocol} tool definitions`, 'Keep same-carrier tools only');
      }
      continue;
    }
    if (!caps.toolKinds[tool.type]) {
      throw new IrUnsupportedError('tool_type', unsupportedToolKindMessage(protocol, tool.type, false), protocol);
    }
    if (tool.type === 'function' && tool.function.strict === true && !caps.toolStrict) {
      fail(protocol, 'tool_strict', 'Strict function schemas');
    }
    const cache = tool.type === 'function' ? tool.function.cache : tool.type === 'custom' ? tool.cache : undefined;
    if (cache) {
      validateCache(
        cache, protocol, caps.cache.tool_breakpoint === true,
        'cache_tool_breakpoint', 'Tool cache breakpoints', strip,
      );
    }
  }
  validateToolChoice(ir.toolChoice, protocol, caps);
  if (ir.parallelToolCalls === false && !caps.parallelToolCalls) {
    fail(protocol, 'parallel_tool_calls', 'Disabling parallel tool calls');
  }
  if (ir.text?.format && ir.text.format.type !== 'text' && !caps.responseFormat[ir.text.format.type]) {
    fail(protocol, 'response_format', `${ir.text.format.type} response format`);
  }
  if (ir.text?.verbosity && !caps.textVerbosity) fail(protocol, 'text_verbosity', 'text.verbosity');
  if (ir.reasoning?.budgetTokens !== undefined && !caps.reasoningBudget) {
    fail(protocol, 'reasoning_budget', 'Thinking-token budgets');
  }
  if (ir.reasoning?.summary && !caps.reasoningSummary) {
    fail(protocol, 'reasoning_summary', 'Reasoning summaries');
  }
  if (ir.n !== undefined && ir.n !== 1 && !caps.candidates) {
    fail(protocol, 'candidates', 'Multiple candidates (n > 1)');
  }
  if ((ir.logprobs === true || ir.topLogprobs !== undefined) && !caps.logprobs) {
    fail(protocol, 'logprobs', 'Log probabilities');
  }
  if (ir.logitBias !== undefined && !isChatProtocol(protocol)) {
    fail(protocol, 'logit_bias', 'Token logit bias');
  }
  if (ir.include !== undefined && protocol !== 'openai-responses') {
    fail(protocol, 'include', 'Responses include controls');
  }
  if (ir.store !== undefined || ir.previousResponseId || ir.conversation || ir.prompt) {
    if (!caps.stateful) fail(protocol, 'stateful_request', 'Server-side response state controls');
  }
  if (ir.background && !caps.background) fail(protocol, 'background', 'Background responses');
  if (ir.truncation === 'auto' && !caps.stateful) fail(protocol, 'truncation', 'Server-side truncation');
  if (ir.metadata && !caps.metadata) fail(protocol, 'metadata', 'Opaque request metadata');
  if (ir.serviceTier && !caps.serviceTier) fail(protocol, 'service_tier', 'Service tier selection');
  if (ir.safetyIdentifier && !caps.safetyIdentifier) {
    fail(protocol, 'safety_identifier', 'Safety identifiers');
  }
  if (ir.user && !caps.user) fail(protocol, 'user', 'End-user attribution');
  // streamOptions controls the northbound Chat encoder; it is not an upstream field.
  for (const key of ['key', 'retention', 'options'] as const) {
    if (ir.cache?.[key] !== undefined && !caps.cache[key] && !(strip && key !== 'key')) {
      fail(protocol, `cache_${key}`, `cache.${key}`);
    }
  }
  if (!strip && ir.vendor?.anthropic?.systemCache && typeof ir.vendor.anthropic.systemCache === 'object') {
    validateCache(
      ir.vendor.anthropic.systemCache as CacheBreakpoint,
      protocol,
      caps.cache.item_breakpoint === true,
      'cache_system_breakpoint',
      'Anthropic system cache breakpoints',
      strip,
    );
  }
  if (ir.reasoning?.include && protocol !== 'openai-responses') {
    fail(protocol, 'reasoning_include', 'Encrypted reasoning content');
  }
  for (const key of Object.keys(ir.generation ?? {}) as (keyof GenerationParams)[]) {
    if (ir.generation?.[key] !== undefined && !caps.generation[key]) {
      fail(protocol, `generation_${key}`, `generation.${key}`);
    }
  }
}

function validateItem(
  item: InputItem,
  protocol: ProtocolId,
  caps: ProtocolCapabilities,
  stripCarrierExtensions = false,
  direction: ValidationDirection = 'request',
): void {
  if (item.type === 'extension') {
    if (item.protocol !== protocol) {
      fail(protocol, 'extension_item', `${item.protocol} extension items`, 'Keep same-carrier extensions only');
    }
    return;
  }
  if (item.type === 'item_reference') {
    if (!caps.itemReference) fail(protocol, 'item_reference', 'Stored item references');
    return;
  }
  if (item.type === 'reasoning') {
    if ((item.signature || item.encrypted) && !caps.reasoningSignature) {
      fail(protocol, 'reasoning_signature', 'Signed or encrypted reasoning replay');
    }
    // Responses replays `encrypted_content` on the request wire and may echo a
    // `signature` on northbound output, but a foreign signature has no request
    // field — reject here so the matrix matches `itemToWire`, not only the adapter.
    if (direction === 'request' && protocol === 'openai-responses' && item.signature) {
      fail(
        protocol,
        'reasoning_signature',
        'Foreign reasoning signatures',
        'Strip signatures before dialing Responses, or stay on the signing carrier',
      );
    }
    if (direction === 'request' && protocol === 'google-gemini' && item.encrypted) {
      fail(
        protocol,
        'reasoning_signature',
        'Encrypted OpenAI/Anthropic thought blobs',
        'Strip encrypted reasoning before dialing Gemini',
      );
    }
    if (item.summary?.length && !caps.reasoningSummary) {
      fail(protocol, 'reasoning_summary', 'Structured reasoning summaries');
    }
    return;
  }
  if (item.type === 'tool_call') {
    if (item.signature && !caps.reasoningSignature) {
      fail(protocol, 'tool_call_signature', 'Signed tool-call replay');
    }
    if (direction === 'request' && protocol === 'openai-responses' && item.signature) {
      fail(
        protocol,
        'tool_call_signature',
        'Foreign tool-call signatures',
        'Strip signatures before dialing Responses, or stay on the signing carrier',
      );
    }
    if (item.cache) {
      validateCache(
        item.cache, protocol, caps.cache.item_breakpoint === true,
        'cache_item_breakpoint', 'Item-level cache breakpoints', stripCarrierExtensions,
      );
    }
    return;
  }
  if (item.type === 'tool_result' && item.isError && protocol !== 'anthropic-messages') {
    fail(protocol, 'tool_result_error', 'Tool-result error markers');
  }
  if ('cache' in item && item.cache) {
    validateCache(
      item.cache, protocol, caps.cache.item_breakpoint === true,
      'cache_item_breakpoint', 'Item-level cache breakpoints', stripCarrierExtensions,
    );
  }
  for (const part of item.content) validatePart(part, protocol, caps, stripCarrierExtensions);
}

function validateOutputPart(part: ContentPart, protocol: ProtocolId, caps: ProtocolCapabilities): void {
  validatePart(part, protocol, caps);
  if (part.type !== 'extension' && part.type !== 'text' && part.type !== 'refusal') {
    fail(protocol, 'output_part', `${part.type} output content`);
  }
  if (part.type !== 'text') return;
  for (const annotation of part.annotations ?? []) {
    if (annotation.type === 'extension' && annotation.protocol !== protocol) {
      fail(protocol, 'annotation', `${annotation.protocol} annotations`);
    }
    if (protocol === 'anthropic-messages' && (annotation.type !== 'extension' || annotation.protocol !== protocol)) {
      fail(
        protocol,
        'annotation',
        'Non-native annotations',
        'Anthropic output requires carrier-native citation payloads',
      );
    }
  }
  // Chat logprobs have a token-aligned stream shape that this output adapter
  // does not synthesize from Responses-span data. Reject instead of dropping.
  if (isChatProtocol(protocol) && part.logprobs?.length) {
    fail(protocol, 'output_logprobs', 'Responses token log probabilities on Chat output');
  }
}

function validateOutputItem(item: OutputItem, protocol: ProtocolId, caps: ProtocolCapabilities): void {
  validateItem(item, protocol, caps, false, 'response');
  if (item.type === 'message') {
    for (const part of item.content) validateOutputPart(part, protocol, caps);
  }
}

/** Validate every candidate before a buffered northbound encoder emits anything. */
export function assertCanonicalResponseSupported(response: CanonicalResponse, protocol: ProtocolId): void {
  const caps = capabilitiesFor(protocol);
  const candidates = response.candidates?.length ? response.candidates : [{
    index: 0, status: response.status, ...(response.reason ? { reason: response.reason } : {}), output: response.output,
  }];
  if (candidates.length > 1 && !caps.candidates) {
    fail(protocol, 'candidates', 'Multiple candidates');
  }
  for (const candidate of candidates) {
    for (const item of candidate.output) validateOutputItem(item, protocol, caps);
  }
}

/** Apply the same output contract to incremental events, before any wire delta. */
export function assertCanonicalStreamEventSupported(event: StreamEvent, protocol: ProtocolId): void {
  const caps = capabilitiesFor(protocol);
  if ((event.candidateIndex ?? 0) !== 0 && !caps.candidates) {
    fail(protocol, 'candidates', 'Streaming multiple candidates');
  }
  if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
    validateOutputItem(event.item, protocol, caps);
    return;
  }
  if (event.type === 'response.content_part.added' || event.type === 'response.content_part.done') {
    validateOutputPart(event.part, protocol, caps);
    return;
  }
  if (event.type === 'response.output_text.annotation.added') {
    validateOutputPart({ type: 'text', text: '', annotations: [event.annotation] }, protocol, caps);
    return;
  }
  if (event.type === 'response.output_text.done' && event.annotations?.length) {
    validateOutputPart({ type: 'text', text: event.text, annotations: event.annotations }, protocol, caps);
    return;
  }
  if ((event.type === 'response.refusal.delta' || event.type === 'response.refusal.done') && !caps.parts.refusal) {
    fail(protocol, 'refusal_part', 'Streaming refusal content');
    return;
  }
  if (event.type.startsWith('response.reasoning_summary') && !caps.reasoningSummary) {
    fail(protocol, 'reasoning_summary', 'Streaming structured reasoning summaries');
  }
}

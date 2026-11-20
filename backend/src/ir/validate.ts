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

function fail(protocol: ProtocolId, code: string, detail: string): never {
  throw new IrUnsupportedError(code, `${detail} Target protocol: ${protocol}.`, protocol);
}

/** Carrier shape family. The chat family is the DEFAULT: the three typed
 *  carriers are named, and every other protocol id (systemone, an OCR-native
 *  wire, any plugin wire) exposes the chat shape. */
function isChatProtocol(protocol: ProtocolId): boolean {
  return protocol !== 'openai-responses' && protocol !== 'anthropic-messages' && protocol !== 'google-gemini';
}

function validateCache(
  cache: CacheBreakpoint,
  protocol: ProtocolId,
  supported: boolean,
  code: string,
  detail: string,
  strip: boolean,
): void {
  if (strip) return;
  if (!supported) fail(protocol, code, detail);
  // Responses breakpoints are opaque objects; Anthropic only accepts its own
  // typed cache_control marker. Replaying a foreign marker is not passthrough.
  if (protocol === 'anthropic-messages' && cache.raw && !cache.type) {
    fail(protocol, code, 'Protocol cannot translate a foreign raw cache breakpoint.');
  }
  if (protocol === 'openai-responses' && cache.type && !cache.raw) {
    fail(protocol, code, 'Protocol cannot translate an Anthropic cache_control breakpoint.');
  }
}

function validatePart(
  part: ContentPart,
  protocol: ProtocolId,
  caps: ProtocolCapabilities,
  stripCarrierExtensions = false,
): void {
  if (part.type === 'extension') {
    if (part.protocol !== protocol) fail(protocol, 'extension_part', `Cannot convert ${part.protocol} extension content.`);
    return;
  }
  if (!caps.parts[part.type]) fail(protocol, `${part.type}_part`, `Protocol cannot carry ${part.type} content.`);
  if ('cache' in part && part.cache) {
    validateCache(
      part.cache, protocol, caps.cache.part_breakpoint === true,
      'cache_part_breakpoint', 'Protocol cannot carry a content cache breakpoint.', stripCarrierExtensions,
    );
  }
  if ('source' in part) {
    const allowed = caps.sources[part.type] ?? [];
    if (!allowed.includes(part.source.kind)) {
      fail(protocol, `${part.type}_source`, `Protocol cannot carry a ${part.source.kind} ${part.type} source.`);
    }
  }
  if ((part.type === 'text' || part.type === 'image' || part.type === 'file' || part.type === 'audio') && part.signature) {
    if (!caps.reasoningSignature) fail(protocol, 'content_signature', 'Protocol cannot replay signed content.');
  }
  if (part.type === 'text' && part.annotations?.length && !caps.annotations) {
    fail(protocol, 'annotations', 'Protocol cannot carry text annotations.');
  }
  if (part.type === 'text' && part.logprobs?.length && !caps.logprobs) {
    fail(protocol, 'logprobs', 'Protocol cannot carry token log probabilities.');
  }
}

function validateToolChoice(choice: ToolChoice | undefined, protocol: ProtocolId, caps: ProtocolCapabilities): void {
  if (!choice) return;
  if (choice.type === 'custom' && !caps.toolKinds.custom) {
    fail(protocol, 'tool_choice', 'Protocol cannot force a custom tool.');
  }
  if (choice.type === 'allowed' && !caps.allowedToolChoice) {
    fail(protocol, 'allowed_tools', 'Protocol cannot represent allowed_tools.');
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
      if (tool.protocol !== protocol) fail(protocol, 'extension_tool', `Cannot convert ${tool.protocol} tool definition.`);
      continue;
    }
    if (!caps.toolKinds[tool.type]) fail(protocol, 'tool_type', `Protocol cannot carry ${tool.type} tools.`);
    if (tool.type === 'function' && tool.function.strict === true && !caps.toolStrict) {
      fail(protocol, 'tool_strict', 'Protocol cannot enforce strict function schemas.');
    }
    const cache = tool.type === 'function' ? tool.function.cache : tool.type === 'custom' ? tool.cache : undefined;
    if (cache) {
      validateCache(
        cache, protocol, caps.cache.tool_breakpoint === true,
        'cache_tool_breakpoint', 'Protocol cannot carry a tool cache breakpoint.', strip,
      );
    }
  }
  validateToolChoice(ir.toolChoice, protocol, caps);
  if (ir.parallelToolCalls === false && !caps.parallelToolCalls) {
    fail(protocol, 'parallel_tool_calls', 'Protocol cannot disable parallel tool calls.');
  }
  if (ir.text?.format && ir.text.format.type !== 'text' && !caps.responseFormat[ir.text.format.type]) {
    fail(protocol, 'response_format', `Protocol cannot enforce ${ir.text.format.type}.`);
  }
  if (ir.text?.verbosity && !caps.textVerbosity) fail(protocol, 'text_verbosity', 'Protocol cannot control text verbosity.');
  if (ir.reasoning?.budgetTokens !== undefined && !caps.reasoningBudget) {
    fail(protocol, 'reasoning_budget', 'Protocol cannot enforce a thinking-token budget.');
  }
  if (ir.reasoning?.summary && !caps.reasoningSummary) {
    fail(protocol, 'reasoning_summary', 'Protocol cannot request reasoning summaries.');
  }
  if (ir.n !== undefined && ir.n !== 1 && !caps.candidates) {
    fail(protocol, 'candidates', 'Protocol cannot return multiple candidates.');
  }
  if ((ir.logprobs === true || ir.topLogprobs !== undefined) && !caps.logprobs) {
    fail(protocol, 'logprobs', 'Protocol cannot return log probabilities.');
  }
  if (ir.logitBias !== undefined && !isChatProtocol(protocol)) {
    fail(protocol, 'logit_bias', 'Protocol cannot honor token logit bias.');
  }
  if (ir.include !== undefined && protocol !== 'openai-responses') {
    fail(protocol, 'include', 'Protocol cannot honor Responses include controls.');
  }
  if (ir.store !== undefined || ir.previousResponseId || ir.conversation || ir.prompt) {
    if (!caps.stateful) fail(protocol, 'stateful_request', 'Protocol cannot carry server-side response state controls.');
  }
  if (ir.background && !caps.background) fail(protocol, 'background', 'Protocol cannot execute background responses.');
  if (ir.truncation === 'auto' && !caps.stateful) fail(protocol, 'truncation', 'Protocol cannot perform server-side truncation.');
  if (ir.metadata && !caps.metadata) fail(protocol, 'metadata', 'Protocol cannot carry opaque request metadata.');
  if (ir.serviceTier && !caps.serviceTier) fail(protocol, 'service_tier', 'Protocol cannot select a service tier.');
  if (ir.safetyIdentifier && !caps.safetyIdentifier) {
    fail(protocol, 'safety_identifier', 'Protocol cannot carry a safety identifier.');
  }
  if (ir.user && !caps.user) fail(protocol, 'user', 'Protocol cannot carry end-user attribution.');
  // streamOptions controls the northbound Chat encoder; it is not an upstream field.
  for (const key of ['key', 'retention', 'options'] as const) {
    if (ir.cache?.[key] !== undefined && !caps.cache[key] && !(strip && key !== 'key')) {
      fail(protocol, `cache_${key}`, `Protocol cannot honor cache.${key}.`);
    }
  }
  if (!strip && ir.vendor?.anthropic?.systemCache && typeof ir.vendor.anthropic.systemCache === 'object') {
    validateCache(
      ir.vendor.anthropic.systemCache as CacheBreakpoint,
      protocol,
      caps.cache.item_breakpoint === true,
      'cache_system_breakpoint',
      'Protocol cannot carry Anthropic system cache breakpoints.',
      strip,
    );
  }
  if (ir.reasoning?.include && protocol !== 'openai-responses') {
    fail(protocol, 'reasoning_include', 'Protocol cannot return encrypted reasoning content.');
  }
  for (const key of Object.keys(ir.generation ?? {}) as (keyof GenerationParams)[]) {
    if (ir.generation?.[key] !== undefined && !caps.generation[key]) {
      fail(protocol, `generation_${key}`, `Protocol cannot honor generation.${key}.`);
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
    if (item.protocol !== protocol) fail(protocol, 'extension_item', `Cannot convert ${item.protocol} extension item.`);
    return;
  }
  if (item.type === 'item_reference') {
    if (!caps.itemReference) fail(protocol, 'item_reference', 'Protocol cannot resolve stored item references.');
    return;
  }
  if (item.type === 'reasoning') {
    if ((item.signature || item.encrypted) && !caps.reasoningSignature) {
      fail(protocol, 'reasoning_signature', 'Protocol cannot replay signed or encrypted reasoning.');
    }
    // Responses replays `encrypted_content` on the request wire and may echo a
    // `signature` on northbound output, but a foreign signature has no request
    // field — reject here so the matrix matches `itemToWire`, not only the adapter.
    if (direction === 'request' && protocol === 'openai-responses' && item.signature) {
      fail(protocol, 'reasoning_signature', 'Responses cannot replay a foreign reasoning signature.');
    }
    if (direction === 'request' && protocol === 'google-gemini' && item.encrypted) {
      fail(protocol, 'reasoning_signature', 'Gemini reasoning replay cannot carry encrypted OpenAI/Anthropic thought blobs.');
    }
    if (item.summary?.length && !caps.reasoningSummary) {
      fail(protocol, 'reasoning_summary', 'Protocol cannot replay structured reasoning summaries.');
    }
    return;
  }
  if (item.type === 'tool_call') {
    if (item.signature && !caps.reasoningSignature) fail(protocol, 'tool_call_signature', 'Protocol cannot replay signed calls.');
    if (direction === 'request' && protocol === 'openai-responses' && item.signature) {
      fail(protocol, 'tool_call_signature', 'Responses cannot replay a foreign tool-call signature.');
    }
    if (item.cache) {
      validateCache(
        item.cache, protocol, caps.cache.item_breakpoint === true,
        'cache_item_breakpoint', 'Protocol cannot carry an item-level cache breakpoint.', stripCarrierExtensions,
      );
    }
    return;
  }
  if (item.type === 'tool_result' && item.isError && protocol !== 'anthropic-messages') {
    fail(protocol, 'tool_result_error', 'Protocol cannot preserve the tool result error marker.');
  }
  if ('cache' in item && item.cache) {
    validateCache(
      item.cache, protocol, caps.cache.item_breakpoint === true,
      'cache_item_breakpoint', 'Protocol cannot carry an item-level cache breakpoint.', stripCarrierExtensions,
    );
  }
  for (const part of item.content) validatePart(part, protocol, caps, stripCarrierExtensions);
}

function validateOutputPart(part: ContentPart, protocol: ProtocolId, caps: ProtocolCapabilities): void {
  validatePart(part, protocol, caps);
  if (part.type !== 'extension' && part.type !== 'text' && part.type !== 'refusal') {
    fail(protocol, 'output_part', `Protocol output adapter cannot emit ${part.type} content.`);
  }
  if (part.type !== 'text') return;
  for (const annotation of part.annotations ?? []) {
    if (annotation.type === 'extension' && annotation.protocol !== protocol) {
      fail(protocol, 'annotation', `Protocol cannot convert ${annotation.protocol} annotations.`);
    }
    if (protocol === 'anthropic-messages' && (annotation.type !== 'extension' || annotation.protocol !== protocol)) {
      fail(protocol, 'annotation', 'Anthropic output requires carrier-native citation payloads.');
    }
  }
  // Chat logprobs have a token-aligned stream shape that this output adapter
  // does not synthesize from Responses-span data. Reject instead of dropping.
  if (isChatProtocol(protocol) && part.logprobs?.length) {
    fail(protocol, 'output_logprobs', 'Chat output cannot preserve Responses token log probabilities.');
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
    fail(protocol, 'candidates', 'Protocol cannot return multiple candidates.');
  }
  for (const candidate of candidates) {
    for (const item of candidate.output) validateOutputItem(item, protocol, caps);
  }
}

/** Apply the same output contract to incremental events, before any wire delta. */
export function assertCanonicalStreamEventSupported(event: StreamEvent, protocol: ProtocolId): void {
  const caps = capabilitiesFor(protocol);
  if ((event.candidateIndex ?? 0) !== 0 && !caps.candidates) {
    fail(protocol, 'candidates', 'Protocol cannot stream multiple candidates.');
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
    fail(protocol, 'refusal_part', 'Protocol cannot stream refusal content.');
    return;
  }
  if (event.type.startsWith('response.reasoning_summary') && !caps.reasoningSummary) {
    fail(protocol, 'reasoning_summary', 'Protocol cannot stream structured reasoning summaries.');
  }
}

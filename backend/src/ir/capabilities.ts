import type { GenerationParams, ProtocolId } from './types.js';

export type PartKind = 'text' | 'image' | 'file' | 'audio' | 'refusal';
export type SourceKind = 'url' | 'base64' | 'file';
export type ResponseFormatKind = 'json_object' | 'json_schema';
export type CacheKind = 'key' | 'retention' | 'options' | 'part_breakpoint' | 'tool_breakpoint' | 'item_breakpoint';
export type ToolKind = 'function' | 'custom' | 'builtin';
export type GenerationKind = keyof GenerationParams;

/** Declarative, executable contract of one southbound protocol adapter. */
export interface ProtocolCapabilities {
  parts: Readonly<Partial<Record<PartKind, true>>>;
  sources: Readonly<Partial<Record<PartKind, readonly SourceKind[]>>>;
  toolKinds: Readonly<Partial<Record<ToolKind, true>>>;
  /**
   * Signed/encrypted reasoning and content signatures the carrier can replay.
   * Responses is asymmetric: request path rejects foreign `signature` (gate +
   * adapter) but still replays `encrypted` and may echo `signature` northbound.
   */
  reasoningSignature: boolean;
  reasoningBudget: boolean;
  reasoningSummary: boolean;
  responseFormat: Readonly<Partial<Record<ResponseFormatKind, true>>>;
  textVerbosity: boolean;
  toolStrict: boolean;
  parallelToolCalls: boolean;
  allowedToolChoice: boolean;
  cache: Readonly<Partial<Record<CacheKind, true>>>;
  annotations: boolean;
  logprobs: boolean;
  candidates: boolean;
  itemReference: boolean;
  stateful: boolean;
  background: boolean;
  generation: Readonly<Partial<Record<GenerationKind, true>>>;
  metadata: boolean;
  serviceTier: boolean;
  safetyIdentifier: boolean;
  user: boolean;
  streamOptions: boolean;
  nativeStreaming: boolean;
}

const CHAT_GENERATION: Readonly<Partial<Record<GenerationKind, true>>> = {
  temperature: true,
  topP: true,
  maxOutputTokens: true,
  stop: true,
  seed: true,
  presencePenalty: true,
  frequencyPenalty: true,
};

const OPENAI_CHAT: ProtocolCapabilities = {
  parts: { text: true, image: true, refusal: true },
  sources: { image: ['url', 'base64'] },
  toolKinds: { function: true },
  reasoningSignature: false,
  // The orchestrator translates a budget to reasoning_effort before this wire.
  reasoningBudget: true,
  reasoningSummary: false,
  responseFormat: { json_object: true, json_schema: true },
  textVerbosity: false,
  toolStrict: true,
  parallelToolCalls: true,
  allowedToolChoice: false,
  // Chat adapters can carry Anthropic/Responses cache extensions explicitly;
  // generic upstreams opt into the request gate's strip policy instead.
  cache: { key: true, part_breakpoint: true, tool_breakpoint: true, item_breakpoint: true },
  annotations: false,
  logprobs: true,
  candidates: true,
  itemReference: false,
  stateful: false,
  background: false,
  generation: CHAT_GENERATION,
  metadata: true,
  serviceTier: true,
  safetyIdentifier: true,
  user: true,
  streamOptions: true,
  nativeStreaming: true,
};

const OPENAI_RESPONSES: ProtocolCapabilities = {
  parts: { text: true, image: true, file: true, refusal: true },
  sources: { image: ['url', 'base64', 'file'], file: ['url', 'base64', 'file'] },
  toolKinds: { function: true, custom: true, builtin: true },
  reasoningSignature: true,
  reasoningBudget: true,
  reasoningSummary: true,
  responseFormat: { json_object: true, json_schema: true },
  textVerbosity: true,
  toolStrict: true,
  parallelToolCalls: true,
  allowedToolChoice: true,
  cache: { key: true, retention: true, options: true, part_breakpoint: true },
  annotations: true,
  logprobs: true,
  candidates: false,
  itemReference: true,
  stateful: true,
  background: true,
  generation: { temperature: true, topP: true, maxOutputTokens: true },
  metadata: true,
  serviceTier: true,
  safetyIdentifier: true,
  user: true,
  streamOptions: false,
  nativeStreaming: true,
};

const ANTHROPIC: ProtocolCapabilities = {
  parts: { text: true, image: true, file: true },
  sources: { image: ['url', 'base64', 'file'], file: ['url', 'base64', 'file'] },
  toolKinds: { function: true },
  reasoningSignature: true,
  reasoningBudget: true,
  reasoningSummary: false,
  responseFormat: { json_schema: true },
  textVerbosity: false,
  toolStrict: true,
  parallelToolCalls: true,
  allowedToolChoice: false,
  cache: { part_breakpoint: true, tool_breakpoint: true, item_breakpoint: true },
  annotations: true,
  logprobs: false,
  candidates: false,
  itemReference: false,
  stateful: false,
  background: false,
  generation: { temperature: true, topP: true, topK: true, maxOutputTokens: true, stop: true },
  metadata: false,
  serviceTier: false,
  safetyIdentifier: false,
  user: true,
  streamOptions: false,
  nativeStreaming: true,
};

const GOOGLE: ProtocolCapabilities = {
  parts: { text: true, image: true, file: true, audio: true },
  sources: {
    image: ['url', 'base64', 'file'], file: ['url', 'base64', 'file'], audio: ['url', 'base64'],
  },
  toolKinds: { function: true },
  reasoningSignature: true,
  reasoningBudget: true,
  reasoningSummary: false,
  responseFormat: { json_object: true, json_schema: true },
  textVerbosity: false,
  toolStrict: false,
  parallelToolCalls: false,
  allowedToolChoice: false,
  cache: {},
  // Grounding metadata and token probabilities need carrier-native mappings;
  // do not advertise them while the adapter cannot preserve their semantics.
  annotations: false,
  logprobs: false,
  candidates: true,
  itemReference: false,
  stateful: false,
  background: false,
  // Gemini honors topK; keep it off the shared chat generation table so
  // openai-chat upstreams still reject it fail-visibly.
  generation: { ...CHAT_GENERATION, topK: true },
  metadata: false,
  serviceTier: false,
  safetyIdentifier: false,
  user: false,
  streamOptions: false,
  nativeStreaming: true,
};

/** Plugin-native wires currently expose the chat-compatible executor contract. */
const PLUGIN_CHAT: ProtocolCapabilities = OPENAI_CHAT;

export function capabilitiesFor(protocol: ProtocolId): ProtocolCapabilities {
  switch (protocol) {
    case 'openai-chat':
      return OPENAI_CHAT;
    case 'openai-responses':
      return OPENAI_RESPONSES;
    case 'anthropic-messages':
      return ANTHROPIC;
    case 'google-gemini':
      return GOOGLE;
    case 'systemone':
      return PLUGIN_CHAT;
    default:
      // Every non-core protocol is a PLUGIN wire: the plugin owns the transport
      // and the core only knows the chat carrier shape it exposes. Naming the
      // vendors here would leave the next plugin wire without capabilities.
      return PLUGIN_CHAT;
  }
}

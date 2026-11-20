/**
 * CanonicalRequest / CanonicalResponse — the vendor-neutral IR for every protocol conversion.
 *
 * Northbound surfaces parse a client protocol into this model; southbound
 * adapters render it into the upstream wire. No OpenAI/Anthropic/Google field
 * name is normative here: an extension that only one vendor understands lives
 * in `VendorBag`, never in a top-level field. Losing a load-bearing part is a
 * conversion ERROR, not a silent projection (the prompt/cache integrity gates).
 *
 * Design rules:
 *   - `InputItem` / `OutputItem` are discriminated unions; new item kinds are
 *     explicit, never an optional grab-bag on a message.
 *   - Reasoning is an item with text/signature/opaque payload; it is not a
 *     string field on a message.
 *   - Usage is broken down (cached / cache-write / reasoning); carriers that
 *     cannot express a component simply omit it.
 *   - Streaming is an event union with item lifecycle, not a chat chunk.
 */

/** Conversion-surface protocol ids. The core shapes are literal for readers;
 *  the plugin half is OPEN — an OCR-native bare protocol name or any wire a
 *  loaded model-service plugin declares is a valid carrier (ADR-0033
 *  amendment). A closed union here would have to name vendors, which is the
 *  drift the plugin registry exists to avoid. */
export type CoreProtocolId =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-gemini'
  | 'systemone';
export type ProtocolId = CoreProtocolId | (string & {});

export type VendorBag = Record<string, Record<string, unknown>>;

/** A cache breakpoint attached to a part or tool definition. */
export interface CacheBreakpoint {
  /** Carrier-specific marker kind, e.g. Anthropic `ephemeral`. */
  type?: string;
  /** Anthropic prompt-cache TTL when `type` is `ephemeral` (`5m` / `1h`). */
  ttl?: string;
  /** Explicit breakpoint for Responses-style carriers. */
  raw?: Record<string, unknown>;
}

export interface CacheParams {
  key?: string;
  retention?: string;
  options?: Record<string, unknown>;
  /** Message- or part-level marker without a dedicated part slot. */
  breakpoints?: CacheBreakpoint[];
}

export interface GenerationParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stop?: string[];
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
}

/**
 * Responses calls this `text`; keeping it separate from sampling parameters is
 * the future-proof split (format/verbosity are output policy, not decoding).
 */
export interface TextConfig {
  format?:
    | { type: 'text' }
    | { type: 'json_object' }
    | { type: 'json_schema'; name?: string; description?: string; schema: Record<string, unknown>; strict?: boolean };
  verbosity?: 'low' | 'medium' | 'high';
}

export interface ReasoningParams {
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Explicit token budget (Anthropic thinking.budget_tokens / Responses max_tokens). */
  budgetTokens?: number;
  include?: boolean;
  summary?: 'auto' | 'concise' | 'detailed';
}

/** Citation attached to generated text (Responses annotations, Gemini grounding). */
export type Annotation =
  | { type: 'url_citation'; url: string; title?: string; startIndex?: number; endIndex?: number }
  | { type: 'file_citation'; fileId: string; filename?: string; index?: number }
  | { type: 'file_path'; fileId: string; index?: number }
  | { type: 'extension'; protocol: string; payload: unknown };

export interface Logprob {
  token: string;
  logprob: number;
  bytes?: number[];
  topLogprobs?: { token: string; logprob: number; bytes?: number[] }[];
}

export interface TextPart {
  type: 'text';
  text: string;
  /** Citations/grounding attached to this span. */
  annotations?: Annotation[];
  logprobs?: Logprob[];
  /** Carrier signature that must be replayed unchanged (Gemini thoughtSignature). */
  signature?: string;
  cache?: CacheBreakpoint;
}

export interface ImagePart {
  type: 'image';
  source:
    | { kind: 'url'; url: string }
    | { kind: 'base64'; mediaType: string; data: string }
    | { kind: 'file'; fileId: string };
  detail?: 'low' | 'high' | 'auto';
  signature?: string;
  cache?: CacheBreakpoint;
}

export interface FilePart {
  type: 'file';
  source:
    | { kind: 'url'; url: string }
    | { kind: 'base64'; mediaType: string; data: string }
    | { kind: 'file'; fileId: string };
  filename?: string;
  signature?: string;
  cache?: CacheBreakpoint;
}

export interface AudioPart {
  type: 'audio';
  /** Output audio item id, when the carrier returns one. */
  id?: string;
  source:
    | { kind: 'base64'; mediaType: string; data: string }
    | { kind: 'url'; url: string };
  transcript?: string;
  signature?: string;
  cache?: CacheBreakpoint;
}

export interface RefusalPart {
  type: 'refusal';
  text: string;
}

export interface ExtensionPart {
  type: 'extension';
  /** Protocol that owns the payload (e.g. `anthropic`, `openai-responses`). */
  protocol: string;
  /** Opaque payload, preserved only when the target is the same carrier. */
  payload: unknown;
}

export type ContentPart = TextPart | ImagePart | FilePart | AudioPart | RefusalPart | ExtensionPart;

export type Role = 'system' | 'developer' | 'user' | 'assistant';

export interface MessageItem {
  type: 'message';
  /** Stable item id when the carrier supplies one (Responses-like). */
  id?: string;
  status?: 'in_progress' | 'completed' | 'incomplete';
  role: Role;
  content: ContentPart[];
  name?: string;
  cache?: CacheBreakpoint;
  vendor?: VendorBag;
}

export interface ToolCallItem {
  type: 'tool_call';
  /** Item id (Responses `id`); carriers without item ids reuse `callId`. */
  id: string;
  /** Correlation id the tool result must reference (Responses `call_id`). */
  callId?: string;
  status?: 'in_progress' | 'completed' | 'incomplete';
  name: string;
  /** Raw JSON string as produced by the model; parsed only by the consumer. */
  arguments: string;
  /** Gemini `thoughtSignature` / carrier signature that must be replayed. */
  signature?: string;
  cache?: CacheBreakpoint;
  vendor?: VendorBag;
}

export interface ToolResultItem {
  type: 'tool_result';
  callId: string;
  content: ContentPart[];
  isError?: boolean;
  cache?: CacheBreakpoint;
  vendor?: VendorBag;
}

export interface ReasoningItem {
  type: 'reasoning';
  id?: string;
  status?: 'in_progress' | 'completed' | 'incomplete';
  text?: string;
  /** One summary part per entry (Responses `summary[]`), kept separate. */
  summary?: string[];
  /** Opaque signed/encrypted payload that MUST be replayed unchanged. */
  signature?: string;
  encrypted?: string;
  vendor?: VendorBag;
}

/** A reference to an item the carrier already stores (Responses `item_reference`). */
export interface ItemReferenceItem {
  type: 'item_reference';
  id: string;
}

export interface ExtensionItem {
  type: 'extension';
  protocol: string;
  payload: unknown;
}

export type InputItem =
  | MessageItem
  | ToolCallItem
  | ToolResultItem
  | ReasoningItem
  | ItemReferenceItem
  | ExtensionItem;

export interface FunctionTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
  cache?: CacheBreakpoint;
}

export interface FunctionToolDef {
  type: 'function';
  function: FunctionTool;
  vendor?: VendorBag;
}

/** Responses custom tool: freeform text or a grammar. */
export interface CustomToolDef {
  type: 'custom';
  name: string;
  description?: string;
  format?: { type: 'text' } | { type: 'grammar'; definition: string; syntax: 'lark' | 'regex' };
  cache?: CacheBreakpoint;
  vendor?: VendorBag;
}

/** Carrier-hosted tool (web search, file search, MCP, computer use, ...). */
export interface BuiltinToolDef {
  type: 'builtin';
  kind: string;
  config?: Record<string, unknown>;
  vendor?: VendorBag;
}

export interface ToolExtensionDef {
  type: 'extension';
  protocol: string;
  payload: unknown;
}

export type ToolDef = FunctionToolDef | CustomToolDef | BuiltinToolDef | ToolExtensionDef;

export type ToolChoice =
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'required' }
  | { type: 'function'; name: string }
  | { type: 'custom'; name: string }
  /** Responses `allowed_tools`: restrict the callable set. */
  | { type: 'allowed'; mode: 'auto' | 'required'; tools: { type: 'function' | 'custom'; name: string }[] };

export interface RouterOptions {
  forceTier?: 'lite' | 'plus' | 'pro' | 'ultra';
  disableFallback?: boolean;
  failover?: boolean;
  sessionId?: string;
  clientRef?: { kind?: string; id?: string };
}

export interface CanonicalRequest {
  model: string;
  stream: boolean;
  /** Gateway-only routing controls; never rendered onto an upstream wire. */
  routerOptions?: RouterOptions;
  /** System-level instructions, separate from conversation input (Responses-like). */
  instructions?: string;
  input: InputItem[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  generation?: GenerationParams;
  /** Output policy: structured-output format and verbosity. */
  text?: TextConfig;
  reasoning?: ReasoningParams;
  cache?: CacheParams;
  /** Ask the carrier to retain the response for `previousResponseId`. */
  store?: boolean;
  previousResponseId?: string;
  /** Responses stateful controls; only a stateful carrier may honor them. */
  conversation?: string | { id: string };
  prompt?: { id: string; version?: string; variables?: Record<string, string> };
  background?: boolean;
  /** Request additional output fields (Responses `include`). */
  include?: string[];
  truncation?: 'auto' | 'disabled';
  serviceTier?: string;
  safetyIdentifier?: string;
  /** Legacy chat attribution; maps to `safetyIdentifier` where supported. */
  user?: string;
  /** Chat sampling breadth; Responses/Anthropic have no equivalent. */
  n?: number;
  logitBias?: Record<string, number>;
  logprobs?: boolean;
  topLogprobs?: number;
  streamOptions?: { includeUsage?: boolean };
  metadata?: Record<string, unknown>;
  vendor?: VendorBag;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  /** Anthropic split of cache-write TTL buckets. */
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  reasoningTokens?: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
  acceptedPredictionTokens?: number;
  rejectedPredictionTokens?: number;
}

export interface AssistantMessageItem {
  type: 'message';
  id?: string;
  status?: 'in_progress' | 'completed' | 'incomplete';
  role: 'assistant';
  content: ContentPart[];
  vendor?: VendorBag;
}

export type OutputItem =
  | AssistantMessageItem
  | ToolCallItem
  | ReasoningItem
  | ExtensionItem;

export interface CanonicalCandidate {
  index: number;
  status: 'completed' | 'incomplete' | 'failed';
  reason?: CanonicalResponse['reason'];
  output: OutputItem[];
}

export interface CanonicalResponse {
  id?: string;
  model?: string;
  createdAt?: number;
  status: 'completed' | 'incomplete' | 'failed';
  reason?: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'error' | string;
  output: OutputItem[];
  /** Additional chat candidates; the primary candidate remains in `output`. */
  candidates?: CanonicalCandidate[];
  usage: Usage;
  serviceTier?: string;
  systemFingerprint?: string;
  previousResponseId?: string;
  error?: { code?: string; message: string };
  vendor?: VendorBag;
  /**
   * Residual upstream tool-call markup after scoped recovery (or on an
   * unscoped response). Drives `X-OCR-Tool-Markup-Leak` and the failure ledger;
   * successfully recovered calls are counted separately in `toolTextRecovery`.
   */
  toolMarkupLeak?: { calls: number };
  /** Complete, validated markup calls converted by the scoped gateway repair. */
  toolTextRecovery?: { kind: 'dsml'; calls: number };
}

/**
 * Item lifecycle events, modeled on the Responses event stream but
 * vendor-neutral: no carrier-specific event names, ids or payload envelopes.
 */
export type StreamEvent = (
  | { type: 'response.created'; id?: string; model?: string; createdAt?: number; systemFingerprint?: string }
  | { type: 'response.output_item.added'; index: number; item: OutputItem }
  | { type: 'response.content_part.added'; index: number; partIndex: number; part: ContentPart }
  | { type: 'response.output_text.delta'; index: number; partIndex: number; text: string }
  | { type: 'response.output_text.done'; index: number; partIndex: number; text: string; annotations?: Annotation[] }
  | { type: 'response.output_text.annotation.added'; index: number; partIndex: number; annotationIndex: number; annotation: Annotation }
  | { type: 'response.refusal.delta'; index: number; partIndex: number; text: string }
  | { type: 'response.refusal.done'; index: number; partIndex: number; text: string }
  | { type: 'response.reasoning.delta'; index: number; text: string }
  | { type: 'response.reasoning.done'; index: number; text: string }
  | { type: 'response.reasoning_summary_part.added'; index: number; summaryIndex: number }
  | { type: 'response.reasoning_summary.delta'; index: number; summaryIndex: number; text: string }
  | { type: 'response.reasoning_summary.done'; index: number; summaryIndex: number; text: string }
  | { type: 'response.function_call.arguments.delta'; index: number; argumentsDelta: string }
  | { type: 'response.function_call.arguments.done'; index: number; arguments: string }
  | { type: 'response.content_part.done'; index: number; partIndex: number; part: ContentPart }
  | { type: 'response.output_item.done'; index: number; item: OutputItem }
  | { type: 'response.usage'; usage: Usage }
  | { type: 'response.completed' }
  | { type: 'response.incomplete'; reason?: CanonicalResponse['reason'] }
  | { type: 'response.failed'; reason?: CanonicalResponse['reason']; error?: CanonicalResponse['error'] }
  | { type: 'error'; code?: string; message: string }
) & { candidateIndex?: number };

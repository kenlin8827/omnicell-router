import type { ReasoningEffort } from './router.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer';
  content: string | ChatMessageContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /**
   * Anthropic-style prompt-cache breakpoint on a message. Only the Anthropic
   * carrier consumes it; other wires strip or ignore it. Losing it across a
   * conversion silently raises cost (the prefix stops being cached).
   */
  cache_control?: CacheControl;
  /**
   * Thinking text of an assistant turn (DeepSeek / Qwen / Moonshot convention,
   * declared per model as `interleaved.field`). DeepSeek REQUIRES it to be
   * replayed on follow-up turns in thinking mode; wires that carry it must
   * preserve the field verbatim in both directions.
   */
  reasoning_content?: string;
  /**
   * Assistant refusal text (OpenAI chat: `message.refusal`, mutually exclusive
   * with normal content). The Responses wire carries the same text as a
   * `refusal` content part, so the converters move it between the two shapes.
   */
  refusal?: string;
}

export interface CacheControl {
  type?: string;
  /** Anthropic prompt-cache TTL when `type` is `ephemeral` (`5m` / `1h`). */
  ttl?: string;
}

export interface ChatMessageContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: 'low' | 'high' | 'auto';
  };
  /** Anthropic prompt-cache breakpoint (ignored by every other carrier). */
  cache_control?: CacheControl;
  /** Responses explicit cache breakpoint on a content block (Responses carrier only). */
  prompt_cache_breakpoint?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, any>;
    /**
     * Strict schema adherence (OpenAI function calling). The Responses wire
     * carries it FLAT on the tool (`{type:'function', name, strict}`), the
     * chat-completions wire nests it under `function`; both converters move it
     * verbatim so a schema-locked tool loop is never silently downgraded.
     */
    strict?: boolean;
    /** Anthropic tool-level prompt-cache breakpoint (other carriers strip it). */
    cache_control?: CacheControl;
  };
}

export interface ResponseFormat {
  type: 'text' | 'json_object' | 'json_schema';
  json_schema?: {
    name: string;
    description?: string;
    schema: Record<string, any>;
    strict?: boolean;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  n?: number;
  logit_bias?: Record<string, number>;
  logprobs?: boolean;
  top_logprobs?: number;
  stream?: boolean;
  stop?: string | string[];
  max_tokens?: number;
  max_completion_tokens?: number;
  presence_penalty?: number;
  /** Deterministic sampling seed (chat & Gemini; Responses/Anthropic have no equivalent). */
  seed?: number;
  frequency_penalty?: number;
  user?: string;
  /** Opaque request metadata; both wires accept it, neither interprets it. */
  metadata?: Record<string, string>;
  /** Processing tier (`auto`/`default`/`flex`/`priority`…), forwarded verbatim. */
  service_tier?: string;
  /** Cache bucketing key (chat & Responses share the field name). */
  prompt_cache_key?: string;
  /** Abuse-detection identifier (chat & Responses share the field name). */
  safety_identifier?: string;
  /**
   * Responses-only cache controls. Carried verbatim to a Responses-wire
   * upstream; every other carrier ignores/strips them (they are not chat
   * parameters, and OpenAI chat rejects unknown top-level fields).
   */
  prompt_cache_retention?: string;
  prompt_cache_options?: Record<string, unknown>;
  response_format?: ResponseFormat;
  tools?: Tool[];
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  /**
   * Chat-completions / Responses shared: whether the model may emit several
   * tool calls in one turn. The OpenAI-wire provider forwards it verbatim; the
   * Responses-wire provider maps it onto the same-named Responses field.
   */
  parallel_tool_calls?: boolean;

  /**
   * OpenAI streaming extras. The gateway requests the terminal usage frame from
   * the upstream on every streamed call (FinOps needs it) and forwards it to the
   * client ONLY when asked for here — a strict client must not receive a frame
   * shape it did not request.
   */
  stream_options?: { include_usage?: boolean };

  // Extended thinking-effort controls. The internal representation is
  // the full EFFORT_LADDER; the OpenAI Chat Completions wire only accepts
  // 5 levels (no `max` — that's Anthropic-only). The orchestrator's
  // downgrade step collapses any `max` before the openai-chat
  // provider builder sees it, so it never reaches an OpenAI wire. `none`
  // is the lowest tier — a real value the client sends to mean
  // "do not think", NOT a default or marker for an omitted field
  // (omitted = `undefined`).
  reasoning_effort?: ReasoningEffort;
  max_thinking_tokens?: number;

  // Custom router bypass or debug
  router_options?: {
    force_tier?: 'lite' | 'plus' | 'pro' | 'ultra';
    disable_fallback?: boolean;
    /** Explicit-mode opt-in: allow failover to tier-pool siblings when the named model fails. Default: the named model serves or errors. */
    failover?: boolean;
    session_id?: string;
    /**
     * Client-minted conversation id (Cursor's agent-wire `conversation_id`,
     * set by the in-process plugin host — there is no HTTP header on that
     * path). Bound to the gateway session as an ALIAS, never as the session
     * id: see ADR-0002 §1 "client conversation refs". Stripped before the
     * upstream request (like every router_options field).
     */
    client_ref?: { kind?: string; id?: string };
  };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    audio_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    audio_tokens?: number;
    accepted_prediction_tokens?: number;
    rejected_prediction_tokens?: number;
  };
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | ChatMessageContentPart[] | null;
    tool_calls?: ToolCall[];
    reasoning_content?: string;
    /** Refusal text (sibling of content), mirroring the Responses `refusal` part. */
    refusal?: string;
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: Usage;
  system_fingerprint?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: 'assistant';
    content?: string | null;
    tool_calls?: ToolCall[];
    reasoning_content?: string;
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: Usage;
  /** Present on chunk streams from fingerprint-reporting upstreams (OpenAI spec). */
  system_fingerprint?: string;
}

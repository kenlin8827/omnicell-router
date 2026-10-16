import type { ReasoningEffort } from './router.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer';
  content: string | ChatMessageContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatMessageContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: 'low' | 'high' | 'auto';
  };
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
  stream?: boolean;
  stop?: string | string[];
  max_tokens?: number;
  max_completion_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  response_format?: ResponseFormat;
  tools?: Tool[];
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };

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
  // downgrade step collapses any `max` before the openai-compatible
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
    session_id?: string;
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
    accepted_prediction_tokens?: number;
    rejected_prediction_tokens?: number;
  };
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: ToolCall[];
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

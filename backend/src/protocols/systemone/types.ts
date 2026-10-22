/**
 * System One protocol wire types. Reference vendors speaking this wire
 * (TypeSafe Jev, Alibaba Bailian decision models) may later be integrated as
 * ordinary providers — native wire support for them lives in native.ts.
 *
 * A request evaluates one `state` against a map of typed `questions`
 * (`choice` / `noul` / `score`); the response carries one typed `answers`
 * entry per question id. The protocol never generates text — answers are
 * values plus probabilities (best-effort estimates from chat conversion).
 * estimates for chat-model conversion, see convert.ts).
 *
 * Spec references:
 *  - TypeSafe: POST https://api.typesafe.ai/v1/systemone
 *  - Bailian:  POST https://{WorkspaceId}.<region>.maas.aliyuncs.com/compatible-mode/v1/systemone
 */

type SystemoneQuestionType = 'choice' | 'noul' | 'score';

export interface SystemoneQuestion {
  type: SystemoneQuestionType;
  /** Question text / rubric. Upstreams accept string | object | array. */
  instructions?: unknown;
  /**
   * Answer space. choice → map<option, description>; score → ordered level
   * descriptions (index 0 = lowest); noul → optional { true, false } hints.
   */
  criteria?: unknown;
}

export interface SystemoneRequest {
  /** Registered model id; 'auto'/omitted resolves via config `systemone.defaultModel`. */
  model?: string;
  /** Content to evaluate: plain text or structured (object/array) state. */
  state?: unknown;
  questions?: Record<string, SystemoneQuestion>;
  /** Unknown top-level fields are preserved and echoed back where possible. */
  [key: string]: unknown;
}

export interface SystemoneChoiceAnswer {
  type: 'choice';
  /** The highest-probability option (one of the question's criteria keys). */
  choice: string;
  /** Option → probability; values sum to 1. */
  probabilities: Record<string, number>;
  /** 0..1, derived from the distribution when the model omits it. */
  confidence: number;
}

export interface SystemoneNoulAnswer {
  type: 'noul';
  /** P(yes), 0 = no … 1 = yes. */
  noul: number;
}

export interface SystemoneScoreAnswer {
  type: 'score';
  /** Probability-weighted level index; may be fractional between levels. */
  score: number;
  /** Level index ("0"…"n-1") → level description. */
  legend: Record<string, string>;
  /** Level index → probability; values sum to 1. */
  probabilities: Record<string, number>;
  confidence: number;
}

export type SystemoneAnswer = SystemoneChoiceAnswer | SystemoneNoulAnswer | SystemoneScoreAnswer;

export interface SystemoneResponse {
  /** Model echo: the registered model id. */
  model: string;
  answers: Record<string, SystemoneAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number; [key: string]: unknown };
  /** Unknown fields are preserved (request_id, latency_ms, …). */
  [key: string]: unknown;
}
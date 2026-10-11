/**
 * System One protocol conversion — inbound validation, chat-model request
 * synthesis, and answer synthesis. Pure functions only (unit-testable).
 *
 * The conversion path targets ordinary chat models: one chat completion
 * carries ALL questions (mirroring System One's parallel evaluation), and the
 * reply is normalized back into the System One `answers` shape. Probabilities
 * produced this way are self-reported estimates — NOT calibrated (see
 * ADR-0014, fidelity statement).
 */
import { ChatCompletionRequest, ChatCompletionResponse, ChatMessage } from '../../types/openai.js';
import { EFFORT_LADDER, ReasoningEffort, modelSupportsEfforts } from '../../types/router.js';
import {
  SystemoneAnswer,
  SystemoneChoiceAnswer,
  SystemoneNoulAnswer,
  SystemoneQuestion,
  SystemoneRequest,
  SystemoneResponse,
  SystemoneScoreAnswer,
} from './types.js';

export type SystemoneValidation =
  | { ok: true; value: SystemoneRequest }
  | { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural validation only — shape checks shared by both upstream classes.
 * Upstream-specific limits (e.g. score level caps differ between TypeSafe and
 * Bailian) are deliberately NOT enforced here: the upstream stays the authority.
 */
export function validateSystemoneRequest(body: unknown): SystemoneValidation {
  if (!isPlainObject(body)) {
    return { ok: false, message: 'Invalid request: a JSON object body is required.' };
  }
  const req = body as SystemoneRequest;
  if (req.state === undefined) {
    return { ok: false, message: 'Invalid request: "state" is required (string, object or array).' };
  }
  if (!isPlainObject(req.questions)) {
    return { ok: false, message: 'Invalid request: "questions" must be an object map of typed questions.' };
  }
  const ids = Object.keys(req.questions);
  if (ids.length === 0) {
    return { ok: false, message: 'Invalid request: "questions" must contain at least one question.' };
  }
  for (const id of ids) {
    const q = req.questions[id] as SystemoneQuestion;
    if (!isPlainObject(q)) {
      return { ok: false, message: `Invalid question '${id}': must be an object.` };
    }
    if (q.type !== 'choice' && q.type !== 'noul' && q.type !== 'score') {
      return { ok: false, message: `Invalid question '${id}': "type" must be one of choice | noul | score.` };
    }
    if (q.type === 'choice') {
      if (!isPlainObject(q.criteria) || Object.keys(q.criteria).length === 0) {
        return { ok: false, message: `Invalid question '${id}': choice "criteria" must be a non-empty object map of options.` };
      }
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2) {
        return { ok: false, message: `Invalid question '${id}': score "criteria" must be an ordered array of at least 2 levels.` };
      }
    }
    // noul: criteria is optional ({ true, false } hints) — no structural requirement.
  }
  return { ok: true, value: req };
}

export const DECISION_SYSTEM_PROMPT = [
  'You are a System One decision engine. You evaluate a STATE and answer typed QUESTIONS.',
  'You never write prose, code, or explanations — you output ONLY one JSON object.',
  '',
  'Output shape: {"answers":{"<question-id>":<answer>, ...}}',
  'Answer object per question type:',
  '- choice: {"choice":"<one of this question\'s criteria option keys>","confidence":<0..1>,"probabilities":{"<option key>":<0..1>, ...}}',
  '- noul:   {"noul":<0..1>}  (probability that the answer is yes: 0 = no, 1 = yes)',
  '- score:  {"score":<0-based level index>,"confidence":<0..1>,"probabilities":{"<level index>":<0..1>, ...}}',
  '',
  'Rules:',
  '1. Answer EVERY question id with the exact id as the key.',
  "2. choice \"choice\" must be one of that question's criteria option keys — never invent options.",
  '3. score levels are 0-based indexes into that question\'s criteria array (0 = first/lowest);',
  '   "score" may be fractional (the probability-weighted value).',
  '4. Provide probabilities over the FULL answer space of each question (sum ≈ 1).',
  '5. Probabilities and confidence are honest calibrated estimates, not uniform filler.',
  '6. Output the JSON object only — no markdown fences, no commentary.',
].join('\n');

/**
 * Reasoning-effort pin for the conversion path: System One calls are fast
 * structured decisions — never let a reasoning model burn thinking tokens on
 * them when its declared capability allows a lower / no-think setting.
 *   - `none` in the declared support set  → 'none' (explicit no-think)
 *   - thinking-only model                 → its LOWEST declared level
 *   - no explicit effort control declared → undefined (omit the field —
 *     never inject a parameter a strict upstream might reject)
 */
export function decisionReasoningEffort(model: {
  supportedReasoningEfforts?: readonly ReasoningEffort[];
  supportsReasoningEffort?: boolean;
}): ReasoningEffort | undefined {
  const supported = modelSupportsEfforts(model.supportedReasoningEfforts, model.supportsReasoningEffort);
  if (!supported) return undefined;
  if (supported.includes('none')) return 'none';
  let lowest = supported[0];
  for (const level of supported) {
    if (EFFORT_LADDER.indexOf(level) < EFFORT_LADDER.indexOf(lowest)) lowest = level;
  }
  return lowest;
}

/**
 * Synthesize the chat completion that serves a System One request on an
 * ordinary chat model. `repair` (optional) appends the model's previous
 * invalid output plus the failure reason for a single correction attempt.
 */
export function buildDecisionChatRequest(
  req: SystemoneRequest,
  modelId: string,
  repair?: { previousOutput: string; reason: string }
): ChatCompletionRequest {
  const userPayload = JSON.stringify({ state: req.state, questions: req.questions });
  const messages: ChatMessage[] = [
    { role: 'system', content: DECISION_SYSTEM_PROMPT },
    { role: 'user', content: `STATE and QUESTIONS follow as one JSON document:\n${userPayload}` },
  ];
  if (repair) {
    messages.push({ role: 'assistant', content: repair.previousOutput.slice(0, 4000) || '(empty output)' });
    messages.push({
      role: 'user',
      content:
        `Your previous output could not be used: ${repair.reason}. ` +
        'Reply again with ONLY the corrected JSON object following the required shape.',
    });
  }
  return {
    model: modelId,
    messages,
    temperature: 0,
    stream: false,
    response_format: { type: 'json_object' },
    max_tokens: 4096,
  };
}

export type SystemoneSynthesis =
  | { ok: true; response: SystemoneResponse }
  | { ok: false; reason: string };

function extractJsonObject(text: string): unknown {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  const candidates: string[] = [];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(trimmed);
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Exact, then case-insensitive, option-key match. */
function matchKey(candidate: unknown, keys: string[]): string | undefined {
  if (typeof candidate !== 'string') return undefined;
  const trimmed = candidate.trim();
  if (keys.includes(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  return keys.find((key) => key.toLowerCase() === lower);
}

/** Keep only known keys, clamp, renormalize; empty map when no usable signal. */
function normalizeDistribution(raw: unknown, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isPlainObject(raw)) return out;
  const byLower = new Map<string, number>();
  for (const [key, value] of Object.entries(raw)) {
    const n = asNumber(value);
    // Keep the raw magnitude until renormalization — models sometimes emit
    // counts or scores > 1 (e.g. { billing: 9, technical: 1 }); only
    // negatives are floored.
    if (n !== undefined) byLower.set(key.trim().toLowerCase(), n > 0 ? n : 0);
  }
  let sum = 0;
  for (const key of keys) {
    const n = byLower.get(key.toLowerCase()) ?? 0;
    out[key] = n;
    sum += n;
  }
  if (sum <= 0) return {};
  for (const key of keys) out[key] = out[key] / sum;
  return out;
}

type BuildFailure = { error: string };

function previewKeys(keys: string[]): string {
  return keys.slice(0, 6).join(', ') + (keys.length > 6 ? ', …' : '');
}

function buildChoiceAnswer(raw: Record<string, any>, q: SystemoneQuestion): SystemoneChoiceAnswer | BuildFailure {
  const keys = Object.keys(q.criteria as Record<string, unknown>);
  const declared = matchKey(raw.choice ?? raw.decision ?? raw.answer, keys);
  let probabilities = normalizeDistribution(raw.probabilities, keys);
  if (Object.keys(probabilities).length === 0) {
    if (!declared) return { error: `no valid option (expected one of: ${previewKeys(keys)})` };
    probabilities = Object.fromEntries(keys.map((key) => [key, key === declared ? 1 : 0]));
  }
  let choice = declared;
  if (!choice) {
    choice = keys[0];
    for (const key of keys) {
      if ((probabilities[key] ?? 0) > (probabilities[choice] ?? 0)) choice = key;
    }
  }
  const confidence = clamp01(asNumber(raw.confidence) ?? Math.max(...Object.values(probabilities)));
  return { type: 'choice', choice, probabilities, confidence };
}

function buildNoulAnswer(raw: Record<string, any>): SystemoneNoulAnswer | BuildFailure {
  const source = raw.noul ?? raw.probability ?? raw.answer;
  let value = asNumber(source);
  if (value === undefined) {
    if (typeof source === 'boolean') {
      value = source ? 1 : 0;
    } else if (typeof source === 'string') {
      const s = source.trim().toLowerCase();
      if (s === 'yes' || s === 'true' || s === 'y') value = 1;
      else if (s === 'no' || s === 'false' || s === 'n') value = 0;
    }
  }
  if (value === undefined) return { error: 'no yes/no probability provided' };
  return { type: 'noul', noul: clamp01(value) };
}

function buildScoreAnswer(raw: Record<string, any>, q: SystemoneQuestion): SystemoneScoreAnswer | BuildFailure {
  const levels = q.criteria as unknown[];
  const keys = levels.map((_, i) => String(i));
  const declared = asNumber(raw.score ?? raw.level ?? raw.value);
  let probabilities = normalizeDistribution(raw.probabilities, keys);
  if (declared === undefined && Object.keys(probabilities).length === 0) {
    return { error: `no score provided (levels 0..${levels.length - 1})` };
  }
  let value: number;
  if (declared !== undefined) {
    value = declared;
  } else {
    value = keys.reduce((acc, key) => acc + Number(key) * (probabilities[key] ?? 0), 0);
  }
  value = Math.min(Math.max(value, 0), levels.length - 1);
  if (Object.keys(probabilities).length === 0) {
    const idx = String(Math.round(value));
    probabilities = Object.fromEntries(keys.map((key): [string, number] => [key, key === idx ? 1 : 0]));
  }
  const confidence = clamp01(asNumber(raw.confidence) ?? Math.max(...Object.values(probabilities)));
  const legend: Record<string, string> = {};
  levels.forEach((desc, i) => {
    legend[String(i)] = typeof desc === 'string' ? desc : JSON.stringify(desc);
  });
  return { type: 'score', score: value, legend, probabilities, confidence };
}

/**
 * Convert a chat completion into a conforming System One response. Any
 * question the model failed to answer validly is reported in `reason` —
 * deliberately no fabricated answers (the caller may repair-retry once).
 */
export function synthesizeSystemoneResponse(
  chat: ChatCompletionResponse,
  req: SystemoneRequest,
  modelId: string
): SystemoneSynthesis {
  const content = chat.choices?.[0]?.message?.content ?? '';
  const parsed = extractJsonObject(typeof content === 'string' ? content : JSON.stringify(content));
  if (!isPlainObject(parsed)) return { ok: false, reason: 'model output is not a single valid JSON object' };
  const answersRaw = (parsed as any).answers;
  if (!isPlainObject(answersRaw)) return { ok: false, reason: 'model output has no "answers" object' };

  const questions = req.questions as Record<string, SystemoneQuestion>;
  const answers: Record<string, SystemoneAnswer> = {};
  const problems: string[] = [];
  for (const id of Object.keys(questions)) {
    const q = questions[id];
    const raw = answersRaw[id];
    if (!isPlainObject(raw)) {
      problems.push(`'${id}': no answer object`);
      continue;
    }
    if (q.type === 'choice') {
      const r = buildChoiceAnswer(raw, q);
      if ('error' in r) problems.push(`'${id}': ${r.error}`);
      else answers[id] = r;
    } else if (q.type === 'noul') {
      const r = buildNoulAnswer(raw);
      if ('error' in r) problems.push(`'${id}': ${r.error}`);
      else answers[id] = r;
    } else {
      const r = buildScoreAnswer(raw, q);
      if ('error' in r) problems.push(`'${id}': ${r.error}`);
      else answers[id] = r;
    }
  }
  if (problems.length > 0) return { ok: false, reason: problems.join('; ') };

  const usage = chat.usage
    ? { input_tokens: chat.usage.prompt_tokens ?? 0, output_tokens: chat.usage.completion_tokens ?? 0 }
    : undefined;
  return {
    ok: true,
    response: { model: modelId, answers, ...(usage ? { usage } : {}) },
  };
}
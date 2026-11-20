/**
 * System One decision execution — ONE implementation shared by every caller.
 *
 * Limb selection is wire-driven (ADR-0008 §7): wire 'systemone' models
 * (npm '@ai-sdk/typesafe-ai') serve via NATIVE vendor passthrough
 * (native.ts); every chat-wire model serves via protocol conversion — one
 * JSON-constrained chat completion carries all questions; the reply is
 * normalized back into the System One answers shape (probabilities are
 * best-effort estimates).
 *
 * Shared by the /v1/systemone route (client-facing) and the Layer 2 router
 * decision layer (internal). Keeping one executor means the vendor-error effort
 * calibration below — the subtle part — is tuned once and benefits both.
 */
import { ProviderRegistry } from '../../providers/registry.js';
import type { UpstreamEventContext } from '../../providers/base.js';
import { ModelRegistration } from '../../config/types.js';
import type { CanonicalRequest, CanonicalResponse } from '../../ir/types.js';
import { capabilitiesFor } from '../../ir/capabilities.js';
import { IrUnsupportedError } from '../../ir/errors.js';
import { EFFORT_LADDER, ReasoningEffort } from '../../types/router.js';
import { SystemoneRequest, SystemoneResponse } from './types.js';
import { nativeSystemoneDecision } from './native.js';
import {
  buildDecisionRequest,
  canonicalOutputText,
  decisionReasoningEffort,
  synthesizeSystemoneResponse,
} from './convert.js';
import { UpstreamError } from '../../resilience/error-classifier.js';

const CONVERSION_REPAIR_ATTEMPTS = 1;

export interface SystemoneDecision {
  response: SystemoneResponse;
  /**
   * Which limb served the call: 'native' = wire 'systemone' vendor passthrough
   * (npm '@ai-sdk/typesafe-ai', ADR-0008 §7); 'converted' = chat-model
   * protocol conversion. Rides X-OCR-Systemone-Upstream.
   */
  upstreamKind: 'converted' | 'native';
}

/**
 * Per-model effort preference learned at runtime.
 * A level = the pin that last worked; 'omit' = the upstream rejects the
 * field entirely, stop sending it. Populated by executeDecision's rejection
 * fallback — vendor enums can contradict the catalog's coarse capability
 * flag (e.g. Alibaba accepts only low|high|max while the model is declared
 * thinking-capable). Process-lifetime; a gateway restart re-probes once.
 */
const effortPreferenceByModel = new Map<string, ReasoningEffort | 'omit'>();

/**
 * Initial max_tokens pin for the conversion path. The old hard-coded 4096
 * truncated decision calls: thinking models spend their completion budget on
 * reasoning FIRST, so a big candidate set could exhaust 4096 before a single
 * answer token was emitted — the classic "conversion failed: not a single
 * valid JSON object". Generous headroom; an upstream with a lower hard cap
 * rejects the value and the fallback below drops the field entirely (the
 * vendor's own default applies).
 */
const DECISION_MAX_TOKENS = 16384;

/**
 * Models whose upstream rejected the max_tokens pin outright. The fallback is
 * a single omit — the vendor then applies its own default / model maximum —
 * so the learned fact is a boolean per model, not a value. Process-lifetime,
 * like the other learned pins.
 */
const maxTokensRejectedByModel = new Set<string>();

/**
 * Per-model JSON-mode preference learned at runtime — true (or absent) = send
 * `response_format: { type: 'json_object' }`; false = the upstream rejected
 * the field, never send it again. Several OpenAI-compatible vendors (older
 * vLLM builds, some proxies, smaller vendor APIs) hard-400 on response_format
 * they don't implement; the prompt already carries the full JSON contract and
 * the synthesizer tolerates fences and surrounding prose, so the field is an
 * optimization, not a requirement. Same process-lifetime shape as the other
 * learned pins; a gateway restart re-probes once.
 */
const jsonModePreferenceByModel = new Map<string, boolean>();

/** Did the upstream reject our `reasoning_effort` parameter/value? */
function isEffortRejection(err: any): boolean {
  if (!(err instanceof UpstreamError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  return /reasoning_effort/i.test(`${err.message || ''} ${err.errorBody || ''}`);
}

/**
 * Did the upstream reject our `max_tokens` parameter/value? The token context
 * is required: a bare "too large" / "maximum … tokens" belongs to a
 * CONTEXT-length 400 (dropping max_tokens cannot fix that), so matching it
 * only buys a wasted retry.
 */
function isMaxTokensRejection(err: any): boolean {
  if (!(err instanceof UpstreamError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  return /max[_\s-]?tokens|(?:completion|output)\s+tokens|too many tokens/i.test(
    `${err.message || ''} ${err.errorBody || ''}`
  );
}

/** Did the upstream reject our `response_format` (JSON mode) parameter? */
function isJsonModeRejection(err: any): boolean {
  if (err instanceof IrUnsupportedError && err.code === 'response_format') return true;
  if (!(err instanceof UpstreamError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  return /response_format|json_object|json mode/i.test(`${err.message || ''} ${err.errorBody || ''}`);
}

/**
 * Ladder levels the vendor's error message enumerates as acceptable
 * (e.g. "'reasoning_effort' must be one of: 'low', 'high', 'max'").
 * Excludes the value we just tried; returns them ordered lowest → highest.
 * This is the "look at what the upstream actually supports" signal — there
 * is no query API for the real enum, but a rejection usually discloses it.
 */
const EFFORT_MENTION_RE = new RegExp(`\\b(${EFFORT_LADDER.join('|')})\\b`, 'gi');

function parseMentionedEfforts(errorText: string, exclude: ReasoningEffort): ReasoningEffort[] {
  const found = new Set<ReasoningEffort>();
  for (const token of errorText.match(EFFORT_MENTION_RE) || []) {
    const level = token.toLowerCase() as ReasoningEffort;
    if (level !== exclude) found.add(level);
  }
  return [...found].sort((a, b) => EFFORT_LADDER.indexOf(a) - EFFORT_LADDER.indexOf(b));
}

/** The pin to attempt for a model: memoized learning first, then capability. */
function plannedEffort(model: ModelRegistration): ReasoningEffort | 'omit' {
  const memo = effortPreferenceByModel.get(model.id);
  if (memo) return memo;
  return decisionReasoningEffort(model) ?? 'omit';
}

/**
 * Execute the decision call, downgrading a rejected pin when the upstream
 * rejects it. Three learnable pins, each with its own fallback chain:
 * - `reasoning_effort`: the retry target is learned from the vendor's own
 *   error ("must be one of: 'low', 'high', 'max'") → its LOWEST allowed
 *   level; when the message doesn't enumerate, the conservative chain
 *   applies ('none' → 'low' → omit).
 * - `max_tokens`: one downgrade → omit the field entirely (the vendor then
 *   applies its own default; its cap is the real limit either way).
 * - `response_format` (JSON mode): one downgrade → omit the field entirely
 *   (the system prompt carries the JSON contract; the synthesizer tolerates
 *   fences and prose, so the constraint is an optimization, not a need).
 * Accepted preferences are memoized per model so later calls go straight to
 * them. Each pin gets at most one repair, so a call is bounded by the initial
 * attempt plus the effort ladder (≤2 re-pins) plus max_tokens and
 * response_format (one omit each) — at most 5 wire calls, and any rejection
 * the fallbacks do not cover rethrows immediately.
 *
 * `upstreamEventContext` is the capture identity for the call (decision layer
 * plumbing or the surface pipeline itself), or undefined:
 * every attempt — including the pin-repair re-pins — is a real wire call,
 * so each gets its own event pair through the registry's normal mechanism.
 */
async function executeDecision(
  registry: ProviderRegistry,
  model: ModelRegistration,
  request: CanonicalRequest,
  signal?: AbortSignal,
  upstreamEventContext?: UpstreamEventContext,
): Promise<CanonicalResponse> {
  let attemptRequest = request;
  let rejections = 0;
  for (;;) {
    try {
      return await registry.execute(attemptRequest, model, upstreamEventContext);
    } catch (err: any) {
      const attemptedEffort = attemptRequest.reasoning?.effort as ReasoningEffort | undefined;
      const attemptedMaxTokens = attemptRequest.generation?.maxOutputTokens;
      if (signal?.aborted) throw err;
      let retry: CanonicalRequest | undefined;
      if (attemptedEffort && isEffortRejection(err)) {
        rejections += 1;
        let next: ReasoningEffort | 'omit';
        if (rejections >= 2) next = 'omit';
        else {
          const mentioned = parseMentionedEfforts(err.errorBody || '', attemptedEffort);
          next = mentioned.length > 0 ? mentioned[0]! : attemptedEffort === 'none' ? 'low' : 'omit';
        }
        effortPreferenceByModel.set(model.id, next);
        console.warn(`[systemone] upstream rejected reasoning_effort '${attemptedEffort}' for model '${model.id}' — downgrading the pin to '${next}'`);
        const reasoning = { ...attemptRequest.reasoning };
        if (next === 'omit') delete reasoning.effort;
        else reasoning.effort = next;
        retry = { ...attemptRequest, reasoning: Object.keys(reasoning).length ? reasoning : undefined };
      } else if (attemptedMaxTokens !== undefined && isMaxTokensRejection(err)) {
        rejections += 1;
        maxTokensRejectedByModel.add(model.id);
        console.warn(`[systemone] upstream rejected max_tokens ${attemptedMaxTokens} for model '${model.id}' — omitting the field (vendor default applies)`);
        const generation = { ...attemptRequest.generation };
        delete generation.maxOutputTokens;
        retry = { ...attemptRequest, generation: Object.keys(generation).length ? generation : undefined };
      } else if (attemptRequest.text?.format && isJsonModeRejection(err)) {
        rejections += 1;
        jsonModePreferenceByModel.set(model.id, false);
        console.warn(`[systemone] upstream rejected response_format json_object for model '${model.id}' — retrying without it (the prompt carries the JSON contract)`);
        const text = { ...attemptRequest.text };
        delete text.format;
        retry = { ...attemptRequest, text: Object.keys(text).length ? text : undefined };
      }
      if (!retry) throw err;
      attemptRequest = retry;
    }
  }
}

async function convertViaChatModel(
  registry: ProviderRegistry,
  body: SystemoneRequest,
  model: ModelRegistration,
  signal?: AbortSignal,
  upstreamEventContext?: UpstreamEventContext,
): Promise<SystemoneResponse> {
  const build = (repair?: { previousOutput: string; reason: string }): CanonicalRequest => {
    const request = buildDecisionRequest(body, model.id, repair);
    const supportsJsonObject = capabilitiesFor(model.wire ?? 'openai-chat').responseFormat.json_object === true;
    if (!supportsJsonObject || jsonModePreferenceByModel.get(model.id) === false) request.text = undefined;
    const preference = plannedEffort(model);
    if (preference !== 'omit') request.reasoning = { effort: preference };
    if (!maxTokensRejectedByModel.has(model.id)) {
      request.generation = { ...request.generation, maxOutputTokens: DECISION_MAX_TOKENS };
    }
    return request;
  };
  let response = await executeDecision(registry, model, build(), signal, upstreamEventContext);
  let synth = synthesizeSystemoneResponse(response, body, model.id);
  for (let attempt = 0; attempt < CONVERSION_REPAIR_ATTEMPTS && !synth.ok; attempt++) {
    if (signal?.aborted) break;
    const truncated = response.reason === 'length';
    response = await executeDecision(registry, model, build({
      previousOutput: canonicalOutputText(response),
      reason: truncated
        ? `${synth.reason} (the output was cut off at the token limit — keep it compact)`
        : synth.reason,
    }), signal, upstreamEventContext);
    synth = synthesizeSystemoneResponse(response, body, model.id);
  }
  if (!synth.ok) {
    const err: any = new Error(`System One conversion failed: the model output could not be converted (${synth.reason}).`);
    err.systemoneCode = 'conversion_failed';
    err.statusCode = 502;
    throw err;
  }
  return synth.response;
}

export interface SystemoneDecisionOptions {
  /**
   * Caller-side cancellation. Honored where the transport allows it: the
   * an upstream client aborts its fetch for real. The CONVERTED path cannot be
   * cancelled mid-flight (every provider owns its own AbortController, and
   * `registry.execute` takes no signal), so the signal is used to suppress
   * work we knowingly shouldn't START — above all the repair retry, which
   * would otherwise fire a second full chat call after the caller gave up.
   */
  signal?: AbortSignal;
  /**
   * Upstream capture context for L2-DECISION-CALL capture (Layer 2): the caller
   * has already checked the requestCapture.enabled master and passes the
   * OUTER request's identity with purpose 'l2-decision' — or
   * undefined, which keeps both paths silent exactly as before. The
   * /v1/systemone HTTP surface never passes it (its client leg is gated by
   * the same master in the surface pipeline).
   */
  upstreamEventContext?: UpstreamEventContext;
}

/**
 * Run one System One request against the named model. The limb is selected by
 * the model's RESOLVED wire, never by config: wire 'systemone' → native vendor
 * passthrough; every chat wire → protocol conversion. Callers own their own
 * error envelope: `conversion_failed` errors carry `statusCode: 502`.
 */
export async function runSystemoneDecision(
  registry: ProviderRegistry,
  body: SystemoneRequest,
  model: ModelRegistration,
  options?: SystemoneDecisionOptions
): Promise<SystemoneDecision> {
  if (model.wire === 'systemone') {
    return {
      response: await nativeSystemoneDecision(registry, body, model, options?.upstreamEventContext, options?.signal),
      upstreamKind: 'native',
    };
  }
  const response = await convertViaChatModel(
    registry,
    body,
    model,
    options?.signal,
    options?.upstreamEventContext
  );
  return { response, upstreamKind: 'converted' };
}
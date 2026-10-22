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
 * judge (internal). Keeping one executor means the vendor-error effort
 * calibration below — the subtle part — is tuned once and benefits both.
 */
import { ProviderRegistry } from '../../providers/registry.js';
import type { UpstreamEventContext } from '../../providers/base.js';
import { ModelRegistration } from '../../config/types.js';
import { ChatCompletionRequest, ChatCompletionResponse } from '../../types/openai.js';
import { EFFORT_LADDER, ReasoningEffort } from '../../types/router.js';
import { SystemoneRequest, SystemoneResponse } from './types.js';
import { nativeSystemoneDecision } from './native.js';
import {
  buildDecisionChatRequest,
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

/** Did the upstream reject our `reasoning_effort` parameter/value? */
function isEffortRejection(err: any): boolean {
  if (!(err instanceof UpstreamError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  return /reasoning_effort/i.test(`${err.message || ''} ${err.errorBody || ''}`);
}

/**
 * Ladder levels the vendor's error message enumerates as acceptable
 * (e.g. "'reasoning_effort' must be one of: 'low', 'high', 'max'").
 * Excludes the value we just tried; returns them ordered lowest → highest.
 * This is the "look at what the upstream actually supports" signal — there
 * is no query API for the real enum, but a rejection usually discloses it.
 */
function parseMentionedEfforts(errorText: string, exclude: ReasoningEffort): ReasoningEffort[] {
  const found = new Set<ReasoningEffort>();
  for (const token of errorText.match(/\b(none|low|medium|high|xhigh|max)\b/gi) || []) {
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
 * Execute the decision call, downgrading the effort pin when the upstream
 * rejects it. The retry target is learned from the vendor's own error
 * ("must be one of: 'low', 'high', 'max'") → its LOWEST allowed level;
 * when the message doesn't enumerate, the conservative chain applies
 * ('none' → 'low' → omit). Hard-bounded to 3 total attempts; the accepted
 * preference is memoized per model so later calls go straight to it.
 *
 * `upstreamEventContext` is the capture identity for the call (judge
 * plumbing or the surface pipeline itself), or undefined:
 * every attempt — including the effort-repair re-pin — is a real wire call,
 * so each gets its own event pair through the registry's normal mechanism.
 */
async function executeDecision(
  registry: ProviderRegistry,
  model: ModelRegistration,
  request: ChatCompletionRequest,
  signal?: AbortSignal,
  upstreamEventContext?: UpstreamEventContext
): Promise<ChatCompletionResponse> {
  let attemptRequest = request;
  let rejections = 0;
  for (;;) {
    try {
      return await registry.execute(attemptRequest, model, upstreamEventContext);
    } catch (err: any) {
      const attempted = attemptRequest.reasoning_effort as ReasoningEffort | undefined;
      if (!attempted || !isEffortRejection(err)) throw err;
      // Same rule as the repair gate below: once the caller has walked away,
      // re-pinning the effort buys nothing — an effort calibration is only
      // worth learning for a decision somebody is still waiting on. Without
      // this, a slow-then-400 upstream burns up to 2 more full chat calls
      // behind a deadline the judge already gave up on.
      if (signal?.aborted) throw err;
      rejections++;
      let next: ReasoningEffort | 'omit';
      if (rejections >= 2) {
        next = 'omit'; // hard stop — bounded at 3 total attempts
      } else {
        // Parse the upstream's RAW error body only — the gateway's own
        // message prefix carries the provider name, which may itself contain
        // effort words and would poison the candidate parse.
        const mentioned = parseMentionedEfforts(err.errorBody || '', attempted);
        next = mentioned.length > 0 ? mentioned[0] : attempted === 'none' ? 'low' : 'omit';
      }
      effortPreferenceByModel.set(model.id, next);
      console.warn(
        `[systemone] upstream rejected reasoning_effort '${attempted}' for model '${model.id}' — downgrading the pin to '${next}'`
      );
      const retry: ChatCompletionRequest = { ...request };
      if (next === 'omit') delete retry.reasoning_effort;
      else retry.reasoning_effort = next;
      attemptRequest = retry;
    }
  }
}

function chatText(chat: ChatCompletionResponse): string {
  const content = chat.choices?.[0]?.message?.content ?? '';
  return typeof content === 'string' ? content : JSON.stringify(content);
}

async function convertViaChatModel(
  registry: ProviderRegistry,
  body: SystemoneRequest,
  model: ModelRegistration,
  signal?: AbortSignal,
  upstreamEventContext?: UpstreamEventContext
): Promise<SystemoneResponse> {
  // System One = fast structured decisions: pin the decision call's reasoning
  // effort on the initial AND repair requests (memoized preference + runtime
  // rejection fallback live in plannedEffort / executeDecision).
  const build = (repair?: { previousOutput: string; reason: string }) => {
    const request = buildDecisionChatRequest(body, model.id, repair);
    const preference = plannedEffort(model);
    if (preference !== 'omit') request.reasoning_effort = preference;
    return request;
  };

  let chat = await executeDecision(registry, model, build(), signal, upstreamEventContext);
  let synth = synthesizeSystemoneResponse(chat, body, model.id);
  for (let attempt = 0; attempt < CONVERSION_REPAIR_ATTEMPTS && !synth.ok; attempt++) {
    // Never start a repair the caller has already walked away from: the first
    // call's output was unusable AND time is up — a second full chat call
    // would be pure cost. (The route passes no signal; only deadline-bound
    // callers like the Layer 2 judge do.)
    if (signal?.aborted) break;
    chat = await executeDecision(
      registry,
      model,
      build({ previousOutput: chatText(chat), reason: synth.reason }),
      signal,
      upstreamEventContext
    );
    synth = synthesizeSystemoneResponse(chat, body, model.id);
  }
  if (!synth.ok) {
    const err: any = new Error(
      `System One conversion failed: the model output could not be converted (${synth.reason}).`
    );
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
   * Upstream capture context for JUDGE-CALL capture (Layer 2): the caller
   * has already checked the three-tier chain requestCapture.enabled ×
   * systemone.enabled (surface master) × systemone.l2DecisionEnabled (sub)
   * and passes the OUTER request's identity with purpose 'l2-judge' — or
   * undefined, which keeps both paths silent exactly as before. The
   * /v1/systemone HTTP surface never passes it (its client leg is gated by
   * systemone.enabled (surface master) in the surface pipeline).
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
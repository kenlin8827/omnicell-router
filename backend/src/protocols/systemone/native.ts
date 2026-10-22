/**
 * Native System One decision passthrough — the vendor-side limb of the
 * decision executor (ADR-0008 §7). Reached ONLY for models whose resolved
 * wire is 'systemone' (provider def npm '@ai-sdk/typesafe-ai' / opencode v2
 * segment 'typesafe'): the client's decision request is forwarded to the
 * vendor's decision endpoint VERBATIM (`POST {baseUrl}/systemone`, Bearer
 * auth from the provider's credential chain), with the model id rewritten to
 * the registration's upstreamModel. The response answers shape is passed
 * through as-is — unknown answer types (e.g. TypeSafe's `box`) are the
 * vendor's vocabulary, not the gateway's to second-guess.
 *
 * Vendor wire contract pinned by the @ai-sdk/typesafe-ai SDK (v3):
 * `languageModel` throws NoSuchModelError (decision-only provider); the
 * decision model posts `{model, state, questions}` with
 * `Authorization: Bearer TYPESAFE_AI_API_KEY`; usage rides
 * `input_tokens` / `output_tokens`.
 *
 * Capture/error discipline mirrors providers/openai-compatible.ts: request
 * event before fetch, paired response/failure event after the body arrives,
 * UpstreamError on a non-2xx head.
 */
import { ProviderRegistry } from '../../providers/registry.js';
import type { UpstreamEventContext } from '../../providers/base.js';
import { ModelRegistration } from '../../config/types.js';
import { UpstreamError } from '../../resilience/error-classifier.js';
import { proxiedFetch, resolveProxyUrl } from '../../utils/proxy.js';
import {
  emitUpstreamRequestOnce,
  emitUpstreamResponseOnce,
  emitUpstreamFailureOnce,
  withUpstreamFailureGuard,
} from '../../observability/upstream-events.js';
import { SystemoneRequest, SystemoneResponse } from './types.js';
import { DEFAULT_SYSTEMONE_NATIVE_TIMEOUT_MS } from '../../config/defaults.js';

export async function nativeSystemoneDecision(
  registry: ProviderRegistry,
  body: SystemoneRequest,
  model: ModelRegistration,
  upstreamEventContext?: UpstreamEventContext,
  signal?: AbortSignal
): Promise<SystemoneResponse> {
  const config = registry.getProviderConfig(model.provider);
  if (!config || !config.baseUrl) {
    const err: any = new Error(
      `Provider '${model.provider}' has no baseUrl for the native System One wire (model '${model.id}').`
    );
    err.systemoneCode = 'native_upstream_unconfigured';
    err.statusCode = 502;
    throw err;
  }
  const url = `${config.baseUrl.replace(/\/+$/, '')}/systemone`;
  // No explicit selector on the decision surface → the chain head, which IS
  // the boot-baked key (registry invariant) — the same default registry.execute
  // uses when no credential is passed.
  const credential = registry.getCredentialChain(model.provider)?.[0];
  const apiKey = credential?.key ?? config.apiKey;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    ...(config.headers ?? {}),
  };

  // Verbatim passthrough with the model id rewritten to the upstream id.
  const payload: Record<string, unknown> = { ...body, model: model.upstreamModel };

  const spanId = emitUpstreamRequestOnce(upstreamEventContext, {
    url,
    method: 'POST',
    requestHeaders: headers,
    requestBody: JSON.stringify(payload),
    model: model.upstreamModel,
    proxy: resolveProxyUrl(url, { provider: config.name, model: model.id }),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs || DEFAULT_SYSTEMONE_NATIVE_TIMEOUT_MS);
  // Caller cancellation aborts the vendor call for real (transport-level), in
  // addition to the timeout above.
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await withUpstreamFailureGuard(
      upstreamEventContext,
      spanId,
      url,
      'POST',
      () => proxiedFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      }, { provider: config.name, model: model.id }),
      model.upstreamModel
    );

    let rawBody: string;
    try {
      rawBody = await res.text();
    } catch (err: any) {
      emitUpstreamFailureOnce(upstreamEventContext, {
        model: model.upstreamModel,
        spanId,
        url,
        method: 'POST',
        status: res.status,
        statusText: res.statusText,
        error: `Response body read failed: ${err?.message ?? err}`,
      });
      throw err;
    }

    if (!res.ok) {
      emitUpstreamFailureOnce(upstreamEventContext, {
        model: model.upstreamModel,
        spanId,
        url,
        method: 'POST',
        status: res.status,
        statusText: res.statusText,
        responseHeaders: res.headers,
        responseBody: rawBody,
        error: `Upstream ${res.status}`,
      });
      throw new UpstreamError({
        message: `Upstream ${config.name} returned status ${res.status}: ${rawBody}`,
        status: res.status,
        errorBody: rawBody,
        provider: config.name,
        modelId: model.id,
      });
    }

    emitUpstreamResponseOnce(upstreamEventContext, {
      model: model.upstreamModel,
      spanId,
      url,
      method: 'POST',
      status: res.status,
      statusText: res.statusText,
      responseHeaders: res.headers,
      responseBody: rawBody,
    });

    let json: SystemoneResponse;
    try {
      json = JSON.parse(rawBody) as SystemoneResponse;
    } catch (err: any) {
      const e: any = new Error(
        `Native System One upstream returned a non-JSON body for model '${model.id}': ${err?.message ?? err}`
      );
      e.systemoneCode = 'native_upstream_invalid_body';
      e.statusCode = 502;
      throw e;
    }
    // Model echo: the vendor may omit or reformat the model field — the
    // surface contract answers with the REGISTERED id (same as conversion).
    if (typeof json.model !== 'string' || json.model.length === 0) json.model = model.id;
    return json;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

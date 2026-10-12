import { ModelRegistration, ProviderConfig } from '../config/types.js';
import { SystemoneRequest, SystemoneResponse } from '../protocols/systemone/types.js';
import { UpstreamError } from '../resilience/error-classifier.js';
import { proxiedFetch, resolveProxyUrl } from '../utils/proxy.js';
import type { UpstreamEventContext } from './base.js';
import {
  emitUpstreamFailureOnce,
  emitUpstreamRequestOnce,
  emitUpstreamResponseOnce,
  withUpstreamFailureGuard,
} from '../observability/upstream-events.js';

/**
 * Native System One upstream client (TypeSafe Jev / Alibaba Bailian
 * decision-model-preview). Mirrors the chat provider classes' transport
 * discipline — proxy policy, provider timeout, UpstreamError taxonomy,
 * http-exchange event emission — but speaks the decision wire instead of
 * chat/completions.
 *
 * NOT part of the LLMProvider pool: native System One upstreams are called
 * directly by the decision surface and can never be dispatched by chat
 * routing.
 */
export class SystemoneProvider {
  public name: string;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.config = config;
  }

  public async createDecision(
    request: SystemoneRequest,
    model: ModelRegistration,
    signal?: AbortSignal,
    /**
     * Upstream capture context — passed by the Layer 2 judge plumbing
     * (purpose 'l2-judge') AND by the /v1/systemone surface pipeline itself
     * (no purpose tag; the surface's own turn makes the leg unambiguous),
     * each behind their config gates. Every Once helper no-ops on
     * undefined, so a gate-off caller stays byte-identical (its client leg
     * is captured separately by the transport terminal finalize).
     */
    upstreamEventContext?: UpstreamEventContext
  ): Promise<SystemoneResponse> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/systemone`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      ...this.config.headers,
    };
    // Forward the whole request body (protocol extensions survive) with the
    // model field swapped to the upstream model id.
    const payload = { ...request, model: model.upstreamModel };
    const bodyStr = JSON.stringify(payload);

    // Event-stream emit BEFORE the fetch fires — independent of the response.
    // Pairs with the upstream-response event below via `spanId`.
    const spanId = emitUpstreamRequestOnce(upstreamEventContext, {
      url,
      method: 'POST',
      requestHeaders: headers,
      requestBody: bodyStr,
      model: model.upstreamModel,
      proxy: resolveProxyUrl(url, { provider: this.config.name, model: model.id }),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || 30000);
    // Caller-side cancellation (the Layer 2 judge's own deadline) aborts the
    // fetch for real, so an abandoned decision stops costing the upstream.
    const onCallerAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
      // The guard emits a paired failure response event on ANY thrown error
      // (network / DNS / TLS / abort / timeout) so readers never see a
      // dangling request event. A loser-of-the-race judge call still emits
      // its request event — the wire call really happened; honest over tidy.
      const res = await withUpstreamFailureGuard(
        upstreamEventContext,
        spanId,
        url,
        'POST',
        () =>
          proxiedFetch(
            url,
            {
              method: 'POST',
              headers,
              body: bodyStr,
              signal: controller.signal,
            },
            { provider: this.config.name, model: model.id }
          ),
        model.upstreamModel
      );

      if (!res.ok) {
        // Body read can fail mid-stream (connection reset) — pair the request
        // event with a failure response before rethrowing.
        let errorText: string;
        try {
          errorText = await res.text();
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
        emitUpstreamFailureOnce(upstreamEventContext, {
          model: model.upstreamModel,
          spanId,
          url,
          method: 'POST',
          status: res.status,
          statusText: res.statusText,
          responseHeaders: res.headers,
          responseBody: errorText,
          error: `Upstream ${res.status}`,
        });
        throw new UpstreamError({
          message: `Upstream ${this.name} returned status ${res.status}: ${errorText}`,
          status: res.status,
          errorBody: errorText,
          provider: this.name,
          modelId: model.id,
        });
      }

      // Emit the response event the moment the body BYTES arrive — before
      // JSON.parse, mirroring the chat providers (the raw text is the truth).
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
      let json: any;
      try {
        json = JSON.parse(rawBody);
      } catch {
        throw new UpstreamError({
          message: `Upstream ${this.name} returned a non-JSON body`,
          status: 502,
          errorBody: rawBody,
          provider: this.name,
          modelId: model.id,
        });
      }
      if (!json || typeof json !== 'object' || !json.answers || typeof json.answers !== 'object') {
        throw new UpstreamError({
          message: `Upstream ${this.name} returned a non-System-One body (missing "answers")`,
          status: 502,
          errorBody: rawBody,
          provider: this.name,
          modelId: model.id,
        });
      }
      return json as SystemoneResponse;
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onCallerAbort);
    }
  }
}
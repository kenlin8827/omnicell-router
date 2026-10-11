import { ModelRegistration, ProviderConfig } from '../config/types.js';
import { SystemoneRequest, SystemoneResponse } from '../protocols/systemone/types.js';
import { UpstreamError } from '../resilience/error-classifier.js';
import { proxiedFetch } from '../utils/proxy.js';

/**
 * Native System One upstream client (TypeSafe Jev / Alibaba Bailian
 * decision-model-preview). Mirrors the chat provider classes' transport
 * discipline — proxy policy, provider timeout, UpstreamError taxonomy —
 * but speaks the decision wire instead of chat/completions.
 *
 * NOT part of the LLMProvider pool: native System One upstreams are called
 * directly by the /v1/systemone route and can never be dispatched by chat
 * routing (see ADR-0014).
 */
export class SystemoneProvider {
  public name: string;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.config = config;
  }

  public async createDecision(request: SystemoneRequest, model: ModelRegistration): Promise<SystemoneResponse> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/systemone`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      ...this.config.headers,
    };
    // Forward the whole request body (protocol extensions survive) with the
    // model field swapped to the upstream model id.
    const payload = { ...request, model: model.upstreamModel };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || 30000);

    try {
      const res = await proxiedFetch(
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
        { provider: this.config.name, model: model.id }
      );

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
        throw new UpstreamError({
          message: `Upstream ${this.name} returned status ${res.status}: ${errorText}`,
          status: res.status,
          errorBody: errorText,
          provider: this.name,
          modelId: model.id,
          retryAfterSeconds: Number.isNaN(retryAfterSeconds as number) ? undefined : retryAfterSeconds,
        });
      }

      const rawBody = await res.text();
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
    }
  }
}
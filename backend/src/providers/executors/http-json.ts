import type { ModelRegistration } from '../../config/types.js';
import { DEFAULT_MAX_BODY_BYTES } from '../../config/defaults.js';
import { UpstreamError } from '../../resilience/error-classifier.js';
import { proxiedFetch, resolveProxyUrl } from '../../utils/proxy.js';
import { redactUpstreamBody } from '../../observability/upstream-body-redaction.js';
import { readBoundedBodyText, STREAM_CAPTURE_CAP } from './http-stream.js';

/** Set a header while stripping any case-variant duplicate from custom config headers. */
export function setHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
  headers[name] = value;
}

/** Set a default header only if no case-variant key is already present. */
export function setDefaultHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return;
  }
  headers[name] = value;
}

/** Merge a required comma-separated token (e.g. anthropic-beta) with any custom value. */
export function mergeCommaHeader(
  headers: Record<string, string>,
  name: string,
  requiredToken: string,
): void {
  const lower = name.toLowerCase();
  const tokens: string[] = [requiredToken];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== lower) continue;
    const raw = headers[key];
    delete headers[key];
    if (typeof raw !== 'string') continue;
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (trimmed && !tokens.includes(trimmed)) tokens.push(trimmed);
    }
  }
  headers[name] = tokens.join(',');
}
import {
  emitUpstreamRequestOnce,
  emitUpstreamResponseOnce,
  emitUpstreamFailureOnce,
  withUpstreamFailureGuard,
  type UpstreamEventContext,
} from '../../observability/upstream-events.js';

/** One buffered JSON exchange with the shared capture/error contract. */
export async function postProviderJson(options: {
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  model: ModelRegistration;
  provider: string;
  label: string;
  timeoutMs: number;
  upstreamEventContext?: UpstreamEventContext;
}): Promise<unknown> {
  const { url, headers, payload, model, provider, label, upstreamEventContext } = options;
  const body = JSON.stringify(payload);
  const exchangeId = emitUpstreamRequestOnce(upstreamEventContext, {
    url,
    method: 'POST',
    requestHeaders: headers,
    requestBody: body,
    model: model.upstreamModel,
    proxy: resolveProxyUrl(url, { provider, model: model.id }),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const res = await withUpstreamFailureGuard(
      upstreamEventContext,
      exchangeId,
      url,
      'POST',
      () => proxiedFetch(url, {
        method: 'POST', headers, body, signal: controller.signal, redirect: 'manual',
      }, { provider, model: model.id }),
      model.upstreamModel,
    );
    let rawBody: string;
    try {
      rawBody = await readBoundedBodyText(res, res.ok ? DEFAULT_MAX_BODY_BYTES : STREAM_CAPTURE_CAP);
    } catch (err: any) {
      emitUpstreamFailureOnce(upstreamEventContext, {
        model: model.upstreamModel, exchangeId, url, method: 'POST',
        status: res.status, statusText: res.statusText,
        error: `Response body read failed: ${err?.message ?? err}`,
      });
      throw err;
    }
    if (!res.ok) {
      const retryAfterHeader = res.headers.get('retry-after');
      const parsedRetryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : Number.NaN;
      // Security: upstreams echo Authorization / api keys in 4xx bodies —
      // never forward the raw body to clients, logs, capture or the ledger.
      const safe = redactUpstreamBody(rawBody, headers);
      emitUpstreamFailureOnce(upstreamEventContext, {
        model: model.upstreamModel, exchangeId, url, method: 'POST',
        status: res.status, statusText: res.statusText,
        responseHeaders: res.headers, responseBody: safe,
        error: `${label} error [${res.status}]`,
      });
      throw new UpstreamError({
        message: `Upstream ${provider} [${label}] returned status ${res.status}: ${safe}`,
        status: res.status,
        errorBody: safe,
        provider,
        modelId: model.id,
        retryAfterSeconds: Number.isNaN(parsedRetryAfter) ? undefined : parsedRetryAfter,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch (err: any) {
      const safe = redactUpstreamBody(rawBody, headers);
      emitUpstreamFailureOnce(upstreamEventContext, {
        model: model.upstreamModel, exchangeId, url, method: 'POST',
        status: res.status, statusText: res.statusText,
        responseHeaders: res.headers, responseBody: safe,
        error: `${label} returned non-JSON response: ${err?.message ?? err}`,
      });
      throw new UpstreamError({
        message: `Upstream ${provider} [${label}] returned invalid JSON (status ${res.status}): ${safe.slice(0, 200)}`,
        status: 502,
        errorBody: safe,
        provider,
        modelId: model.id,
      });
    }
    emitUpstreamResponseOnce(upstreamEventContext, {
      model: model.upstreamModel, exchangeId, url, method: 'POST',
      status: res.status, statusText: res.statusText,
      responseHeaders: res.headers, responseBody: rawBody,
    });
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

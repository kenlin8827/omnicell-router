/**
 * One-shot upstream probe behind the console "Test" buttons.
 *
 * Speaks the three wire shapes users actually configure in opencode.jsonc:
 *   - openai    → POST {base}/chat/completions              (default / OpenAI-compatible gateways)
 *   - anthropic → POST {base}/messages                      (x-api-key, or Bearer for OAuth)
 *   - google    → POST {base}/models/{model}:generateContent
 *
 * A probe sends a tiny "ping" completion (max_tokens 16) and reports latency.
 * Real cost is a fraction of a cent; the value is catching dead keys / wrong
 * baseURLs / wrong model ids before the first genuine request fails.
 *
 * Outbound traffic honors the gateway proxy policy (proxiedFetch), so probing
 * a geo-restricted upstream works identically to routed inference.
 */

import { proxiedFetch } from '../utils/proxy.js';
import { wireFor, unroutableReason, anthropicMessagesUrl } from '../providers/wire.js';

export type ProbeKind = 'openai' | 'anthropic' | 'google' | 'responses' | 'unroutable';

export interface ProbeOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  /** Provider id — only used for outbound proxy includes/excludes matching. */
  provider?: string;
  kind?: ProbeKind;
  /** Provider-configured extra headers (opencode.jsonc options.headers). */
  headers?: Record<string, string>;
  /** auth.json credential is an OAuth token — anthropic wants Bearer, not x-api-key. */
  oauth?: boolean;
  timeoutMs?: number;
}

export interface ProbeResult {
  ok: boolean;
  kind: ProbeKind;
  model?: string;
  latencyMs?: number;
  error?: string;
  authHint?: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Wire decision for probes — DELEGATES to the shared `wireFor()` — 
 * the console probe and the execution dispatcher use the identical npm→wire
 * function, so a model can never be tested on one wire and routed on another.
 */
export function probeKindFor(api?: string, npm?: string): ProbeKind {
  return wireFor(npm, api);
}

function statusHint(status: number, body = ''): { authHint?: boolean; hint?: string } {
  if (/unsupported_country_region|Country, region, or territory/i.test(body))
    return { hint: '上游按出口 IP 区域封锁（OpenAI 政策）——需走允许的代理出口，或改用其它供给该模型的 provider' };
  if (status === 401 || status === 403) return { authHint: true, hint: '鉴权失败，请检查 API Key' };
  if (status === 400 && /ModelProtocolUnsupported|does not support this protocol/i.test(body))
    return { hint: '该模型不支持本次探测使用的协议线格式（Anthropic/OpenAI 二选一不匹配，或模型不在套餐协议白名单内，如图像/语音类模型不能走文本接口）' };
  if (status === 404) return { hint: '端点不存在（baseURL 可能缺少 /v1 后缀，或 API 类型不匹配）' };
  if (status === 429) return { hint: '被限流 / 额度不足' };
  if (status >= 500) return { hint: '上游服务错误' };
  return {};
}

export async function probeProvider(opts: ProbeOptions): Promise<ProbeResult> {
  const kind = opts.kind ?? 'openai';
  if (kind === 'unroutable') {
    // never fire a guessed wire at a package we cannot speak.
    return { ok: false, kind, model: opts.model, error: unroutableReason() };
  }
  const base = opts.baseURL.replace(/\/+$/, '');
  let url: string;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (kind === 'anthropic') {
    url = anthropicMessagesUrl(base); // tolerates both /v1-suffixed and bare bases
    headers['anthropic-version'] = '2023-06-01';
    if (opts.oauth) headers['authorization'] = `Bearer ${opts.apiKey}`;
    else headers['x-api-key'] = opts.apiKey;
  } else if (kind === 'google') {
    url = `${base}/models/${encodeURIComponent(opts.model)}:generateContent`;
    headers['x-goog-api-key'] = opts.apiKey;
  } else if (kind === 'responses') {
    // OpenAI Responses API wire (@ai-sdk/openai) — input, not messages.
    url = `${base}/responses`;
    headers['authorization'] = `Bearer ${opts.apiKey}`;
  } else {
    url = `${base}/chat/completions`;
    headers['authorization'] = `Bearer ${opts.apiKey}`;
  }
  // User-configured headers win — same precedence as the gateway executor.
  Object.assign(headers, opts.headers || {});

  const body =
    kind === 'anthropic'
      ? { model: opts.model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }
      : kind === 'google'
        ? { contents: [{ parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 16 } }
        : kind === 'responses'
          ? { model: opts.model, input: 'ping', stream: false }
          : { model: opts.model, max_tokens: 16, stream: false, messages: [{ role: 'user', content: 'ping' }] };

  const started = Date.now();
  try {
    const res = await proxiedFetch(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
      { provider: opts.provider, model: opts.model }
    );
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      const text = raw.replace(/\s+/g, ' ').slice(0, 300);
      const { authHint, hint } = statusHint(res.status, raw);
      return {
        ok: false,
        kind,
        model: opts.model,
        latencyMs,
        authHint,
        error: `HTTP ${res.status}${hint ? ` —— ${hint}` : ''}${text ? ` | ${text}` : ''}`,
      };
    }
    return { ok: true, kind, model: opts.model, latencyMs };
  } catch (err: any) {
    const latencyMs = Date.now() - started;
    const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
    const cause = err?.cause?.code || err?.cause?.message || err?.message;
    return {
      ok: false,
      kind,
      model: opts.model,
      latencyMs,
      error: aborted
        ? `请求超时（${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）`
        : `无法访问 ${url}: ${cause}`,
    };
  }
}

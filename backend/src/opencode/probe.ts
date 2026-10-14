/**
 * One-shot upstream probe behind the console "Test" buttons.
 *
 * Speaks the three wire shapes users actually configure in opencode.jsonc:
 *   - openai    → POST {base}/chat/completions              (default / OpenAI-compatible gateways)
 *   - anthropic → POST {base}/messages                      (x-api-key)
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
import { wireFor, unroutableInfo, anthropicMessagesUrl } from '../providers/wire.js';
import { redactBodySecrets } from './credentials/opencode-v2-store.js';

export type ProbeKind = 'openai' | 'anthropic' | 'google' | 'responses' | 'unroutable';

/** Machine codes of the status/body-derived CLASSIFICATION — short category
 * labels only (i18n contract). Product rule 2026-10-14: classify, never
 * speculate or instruct. The old hints failed by guessing causes ("/v1 suffix
 * missing") and giving advice ("check the API Key") that was wrong often
 * enough to mislead; the upstream's echoed body carries the real story. */
export type ProbeHintCode =
  | 'regionBlocked'
  | 'authFailed'
  | 'protocolMismatch'
  | 'urlModelMismatch'
  | 'rateLimited'
  | 'upstreamError'
  /** 404 with a provider-shaped JSON body: the API answered, rejected at business level. */
  | 'businessRejected'
  /** 404 with a gateway-shaped body (HTML/empty): the mount itself is absent. */
  | 'endpointNotFound';
export type ProbeTransportCode = 'timeout' | 'unreachable';

export interface ProbeOptions {
  baseURL: string;
  /** api key or OAuth access token — sent as the upstream auth credential. */
  apiKey: string;
  model: string;
  /** Provider id — only used for outbound proxy includes/excludes matching. */
  provider?: string;
  kind?: ProbeKind;
  /** Provider-configured extra headers (opencode.jsonc options.headers). */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface ProbeResult {
  ok: boolean;
  kind: ProbeKind;
  model?: string;
  latencyMs?: number;
  authHint?: boolean;
  /** Failure is scoped to the PROBED MODEL, not the connection: the upstream
   * API answered but rejected this one model (structured 404 like Ark's
   * ModelNotOpen/UnsupportedModel, 400 protocol mismatch, 400 url↔model
   * mismatch). Key + mount are proven alive, so a provider-level test may
   * rotate to the next candidate model. */
  modelScoped?: boolean;
  /** --- machine limbs of a failed probe (the console composes the display) --- */
  /** Upstream HTTP status, present iff the request reached an HTTP server. */
  httpStatus?: number;
  /** Category classification of the failure (see ProbeHintCode) — a label,
   * not a sentence; the echoed upstream body stays the detail. */
  hintCode?: ProbeHintCode;
  /** Transport-level failure (fetch threw before/without an HTTP response). */
  transportCode?: ProbeTransportCode;
  transportUrl?: string;
  /** Raw fetch-cause detail (English technical string, passed through verbatim). */
  transportCause?: string;
  timeoutMs?: number;
  /** Wire cannot be spoken by the gateway at all (kind === 'unroutable'). */
  unroutableCode?: 'unknownPackage' | 'dedicatedTransport';
  unroutableNpm?: string;
  /** Redacted, whitespace-flattened, 600-char-capped upstream error body.
   * Security P3-5: redaction happens BEFORE truncation (upstreams echo the
   * submitted key; slicing first could re-expose chars at the boundary). */
  upstreamBody?: string;
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

/**
 * Detect a provider-shaped JSON error body — `{"error":{...}}` (OpenAI / Ark),
 * `{"type":"error",...}` (Anthropic), or top-level `code`+`message`. A structured
 * body proves the API endpoint itself ANSWERED: a genuinely wrong URL yields an
 * HTML/empty gateway 404, never provider-format JSON. 404s with such a body are
 * business-level failures (model not opened / not in the plan / bad model id —
 * Ark reports all three as 404), so they must not read as "baseURL is wrong".
 */
export function structuredApiError(body: string): { code?: string } | null {
  const t = body.trim();
  if (!t.startsWith('{')) return null;
  let j: any;
  try {
    j = JSON.parse(t);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const hasShape = j.error !== undefined || j.type === 'error' || (j.code !== undefined && j.message !== undefined);
  if (!hasShape) return null;
  const e = j.error && typeof j.error === 'object' ? j.error : j;
  const code = e.code ?? j.code;
  return { code: code !== undefined ? String(code) : undefined };
}

function hintForStatus(status: number, body = ''): { authHint?: boolean; hintCode?: ProbeHintCode } {
  if (/unsupported_country_region|Country, region, or territory/i.test(body)) return { hintCode: 'regionBlocked' };
  if (status === 401 || status === 403) return { authHint: true, hintCode: 'authFailed' };
  if (status === 400 && /ModelProtocolUnsupported|does not support this protocol/i.test(body))
    return { hintCode: 'protocolMismatch' };
  // DashScope-family gateways report a model↔endpoint mismatch as a *URL*
  // error — classify it so it does not read as "baseURL broken".
  if (status === 400 && /url error, please check url/i.test(body)) return { hintCode: 'urlModelMismatch' };
  if (status === 404) return { hintCode: structuredApiError(body) ? 'businessRejected' : 'endpointNotFound' };
  if (status === 429) return { hintCode: 'rateLimited' };
  if (status >= 500) return { hintCode: 'upstreamError' };
  return {};
}

export async function probeProvider(opts: ProbeOptions): Promise<ProbeResult> {
  const kind = opts.kind ?? 'openai';
  if (kind === 'unroutable') {
    // never fire a guessed wire at a package we cannot speak.
    const info = unroutableInfo();
    return { ok: false, kind, model: opts.model, unroutableCode: info.code, unroutableNpm: info.npm };
  }
  const base = opts.baseURL.replace(/\/+$/, '');
  let url: string;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (kind === 'anthropic') {
    url = anthropicMessagesUrl(base); // tolerates both /v1-suffixed and bare bases
    headers['anthropic-version'] = '2023-06-01';
    // P2-review cleanup: the retired `oauth` flag's Bearer branch was dead —
    // no caller ever passed it (the console test route only probes api-key
    // credentials; OAuth rows are excluded before this point).
    headers['x-api-key'] = opts.apiKey;
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
      // Security P3-5: upstreams ECHO the request (validation-error bodies
      // repeating the offending value). Redact the submitted apiKey BEFORE
      // truncation — the error string flows into the console response and
      // logs; truncating first could re-expose key chars at the boundary.
      // 600 chars: enough for a full provider business-error (Ark's
      // ModelNotOpen sentence + request id) — the console card shows the
      // error inline and copyable, so the cap is the user-visible truth.
      const text = redactBodySecrets(raw.replace(/\s+/g, ' '), { key: opts.apiKey }).slice(0, 600);
      const { authHint, hintCode } = hintForStatus(res.status, raw);
      const modelScoped =
        (res.status === 404 && !!structuredApiError(raw)) ||
        (res.status === 400 &&
          (/ModelProtocolUnsupported|does not support this protocol/i.test(raw) ||
            /url error, please check url/i.test(raw)));
      return {
        ok: false,
        kind,
        model: opts.model,
        latencyMs,
        authHint,
        modelScoped,
        httpStatus: res.status,
        hintCode,
        upstreamBody: text || undefined,
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
      transportCode: aborted ? 'timeout' : 'unreachable',
      transportUrl: url,
      transportCause: cause ? String(cause) : undefined,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }
}

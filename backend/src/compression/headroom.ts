/**
 * headroom sidecar whole-context compression
 * (https://github.com/headroomlabs-ai/headroom).
 *
 * Headroom's POST /v1/compress endpoint consumes OpenAI Chat messages. The
 * gateway projects Canonical IR to Chat only at this optional external-service
 * boundary; execution remains Canonical IR end to end. Features the sidecar
 * cannot represent fail open before any request input is replaced.
 *
 * Prefix-cache safety: when the caller supplies a sessionId it is forwarded
 * as config.session_id, enabling headroom's session mode — headroom records
 * which compressed results it already returned for the session, replays
 * that prefix byte-identically on later turns, and compresses only the new
 * tail. This avoids the naive failure mode where re-compressing the whole
 * history each turn lets older messages drift and busts the upstream cache.
 *
 * Fail-open throughout: any error/timeout/non-200 returns null and the
 * original messages flow upstream unchanged.
 */
import { ChatMessage } from '../types/openai.js';
import { DEFAULT_HEADROOM_TIMEOUT_MS } from '../config/defaults.js';

export interface HeadroomOptions {
  enabled?: boolean;
  url?: string; // e.g. http://127.0.0.1:8787
  timeoutMs?: number; // default 3000
  compressUserMessages?: boolean; // forwarded as config.compress_user_messages (not in session mode)
}

export interface HeadroomResult {
  messages: ChatMessage[];
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  compressionRatio: number;
  sessionReplayed: boolean;
}

function buildCompressEndpoint(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/v1/compress`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * POST messages to the headroom sidecar; returns compressed messages + stats,
 * or null on any failure (fail-open).
 */
export async function compressWithHeadroom(
  messages: ChatMessage[],
  model: string,
  opts: HeadroomOptions,
  sessionId?: string
): Promise<HeadroomResult | null> {
  if (!opts?.enabled) return null;
  if (!opts.url) return null;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const endpoint = buildCompressEndpoint(opts.url);
  if (!endpoint) return null;

  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_HEADROOM_TIMEOUT_MS;

  const config: Record<string, unknown> = {};
  if (sessionId) {
    // Session mode: headroom keeps replay state; compress_user_messages is
    // refused by the endpoint in this mode, so never send it together.
    config.session_id = sessionId;
  } else if (opts.compressUserMessages) {
    config.compress_user_messages = true;
  }

  const payload: Record<string, unknown> = { messages, model };
  if (Object.keys(config).length > 0) payload.config = config;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`[compression:headroom] proxy returned HTTP ${res.status} — passthrough`);
      return null;
    }
    const data: any = await res.json();
    if (!Array.isArray(data?.messages) || data.messages.length !== messages.length) {
      console.warn('[compression:headroom] proxy response missing/mismatched messages[] — passthrough');
      return null;
    }
    if (data.compression_skipped === true) {
      return null;
    }
    return {
      messages: data.messages,
      tokensBefore: data.tokens_before || 0,
      tokensAfter: data.tokens_after || 0,
      tokensSaved: data.tokens_saved || 0,
      compressionRatio: typeof data.compression_ratio === 'number' ? data.compression_ratio : 1,
      sessionReplayed: data.session?.cached_prefix_replayed === true,
    };
  } catch (err: any) {
    console.warn(`[compression:headroom] request failed (${err?.message || err}) — passthrough`);
    return null;
  }
}

export function formatHeadroomLog(result: HeadroomResult | null): string | null {
  if (!result || result.tokensSaved <= 0) return null;
  const pct = result.tokensBefore > 0 ? ((result.tokensSaved / result.tokensBefore) * 100).toFixed(1) : '0';
  const sess = result.sessionReplayed ? ' session-replay' : '';
  return `[compression:headroom] saved ${result.tokensSaved} / ${result.tokensBefore} tokens (${pct}%)${sess}`;
}

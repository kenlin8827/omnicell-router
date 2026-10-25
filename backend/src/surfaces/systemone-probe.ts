import { defaultGatewayPort } from '../cli/clients/base.js';
import { loadConfig } from '../config/index.js';
import type { SystemoneResponse } from '../protocols/systemone/types.js';
import { firstEnabledKey } from '../harness/translation.js';

/**
 * System One default-model probe — the power behind the console's System One "test" button.
 *
 * The probe fires the REAL `/v1/systemone` fallback path over a one-question `noul` payload. The
 * surface's own admission gates deliver the verdicts verbatim (unset config → 400 model_required,
 * unknown id → 404 model_not_found). A probe is a REAL surface request — the capture ledger
 * records it like any client request when requestCapture is on, and it spends one upstream call.
 * An explicit click is the explicit consent to both.
 *
 * `overrideModel` carries the PICKER'S PENDING value so the operator tests BEFORE saving: given →
 * the request rides `model: <pending>` (the same gate chain the fallback would meet after a save;
 * only the trivial config-read differs), and an empty string = "as if unset" → `not_configured`
 * without a call; omitted → the saved `systemone.defaultModel` via the omitted-model path.
 */

export interface SystemoneProbe {
  ok: boolean;
  /** The configured `systemone.defaultModel` — what an omitted model resolves to. */
  configured: string;
  /** The registered model id the surface echoed back, when ok. */
  model?: string;
  latencyMs: number;
  code?: 'not_configured' | 'no_api_key' | 'upstream';
  error?: string;
}

/** One-question `noul` payload: the smallest legal decision request (answers are values, no prose). */
const PROBE_BODY = { state: 'probe', questions: { probe: { type: 'noul' } } };

export async function probeSystemoneDefault(overrideModel?: string): Promise<SystemoneProbe> {
  const configured =
    overrideModel !== undefined
      ? overrideModel.trim()
      : (loadConfig().systemone?.defaultModel || '').trim();
  const started = Date.now();
  if (!configured) {
    // Deterministic surface behavior (decision-pipeline rejects an omitted model with 400
    // model_required) — reporting it without a call is honest AND free.
    return {
      ok: false,
      configured: '',
      latencyMs: 0,
      code: 'not_configured',
      error: 'systemone.defaultModel is not configured — /v1/systemone requests without a model are rejected (400 model_required)',
    };
  }
  const key = firstEnabledKey();
  if (!key) {
    return { ok: false, configured, latencyMs: 0, code: 'no_api_key', error: 'no enabled gateway API key' };
  }

  // A pending selection rides as an explicit `model` — the surface resolves it through the same
  // gates the saved fallback would after a save. Only the no-override probe omits `model`.
  const body =
    overrideModel !== undefined ? { ...PROBE_BODY, model: configured } : PROBE_BODY;

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${defaultGatewayPort()}/v1/systemone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return {
      ok: false,
      configured,
      latencyMs: Date.now() - started,
      code: 'upstream',
      error: e instanceof Error ? e.message : String(e),
    };
  }

  if (!response.ok) {
    // The surface's error body names the real cause (model_required / model_not_found /
    // no_healthy_model) — carry a short snippet instead of a bare status code.
    let detail = '';
    try {
      detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 200);
    } catch { /* body unreadable — the status code is the whole message */ }
    return {
      ok: false,
      configured,
      latencyMs: Date.now() - started,
      code: 'upstream',
      error: `gateway returned HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
    };
  }

  const payload = (await response.json().catch(() => null)) as SystemoneResponse | null;
  if (!payload || !payload.answers || typeof payload.model !== 'string') {
    return {
      ok: false,
      configured,
      latencyMs: Date.now() - started,
      code: 'upstream',
      error: 'malformed decision response from gateway',
    };
  }
  return { ok: true, configured, model: payload.model, latencyMs: Date.now() - started };
}

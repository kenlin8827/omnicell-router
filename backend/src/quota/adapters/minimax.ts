import type { LastProbeCapture, QuotaCodeAdapter, QuotaAdapterContext, QuotaProbeOutcome, QuotaWindow } from '../types.js';
import { LAST_BODY_MAX_CHARS, LAST_BODY_MAX_JSON_CHARS } from '../engine.js';

/**
 * MiniMax quota — built-in code adapter (L-c).
 *
 * Why code and not the declaration table: MiniMax ships a multi-URL fallback
 * chain whose members carry INVERTED count semantics — on a `/coding_plan/`
 * endpoint the usage counts read as REMAINING, on `/token_plan/` they read as
 * USED. Per-URL inverted mapping is a banned DSL class by design (it smuggles
 * a value-condition through the table), and URL fallback is two-URLs-per-
 * entry, also banned. The facts below were self-recorded from public API
 * behavior (cross-checked against a public MIT reference implementation —
 * facts only, this code is original).
 *
 * Fact sheet (v1):
 *  - Covered providers (OCR catalog ids): `minimax`, `minimax-coding-plan`
 *    (global) and `minimax-cn`, `minimax-cn-coding-plan` (China). Region is
 *    chosen by the id suffix, never by a config knob.
 *  - Auth: `Authorization: Bearer <key>` — same header form as inference.
 *    GET only, no body.
 *  - Global URL order:
 *      1. https://www.minimax.io/v1/token_plan/remains        (counts = used)
 *      2. https://api.minimax.io/v1/api/openplatform/coding_plan/remains  (counts = remaining)
 *  - China URL order:
 *      1. https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains  (counts = remaining)
 *      2. https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains  (counts = remaining)
 *    (Note the CJK domain spelling: `minimaxi` with a trailing `i`.)
 *  - Fallback trigger: HTTP 404 / 405 / >= 500, or a network throw. 401/403
 *    (or envelope code 1004, or key-inactive wording) means the KEY is wrong,
 *    not the URL — no fallback.
 *  - Envelope: `{ base_resp: { status_code, status_msg } }` (camel variants
 *    exist); `status_code != 0` is an API-level error even at HTTP 200.
 *  - Windows: `model_remains[]`, each carrying a session (5h) and a weekly
 *    (7d) window; fields exist in BOTH snake_case and camelCase per rollout
 *    stage. Counts: `current_interval_total_count` /
 *    `current_interval_usage_count` (`current_weekly_*` siblings). Percent:
 *    `current_interval_remaining_percent` (`current_weekly_remaining_percent`
 *    sibling). Reset: `remains_time` is RELATIVE milliseconds (resolve as
 *    probe-time + delta), `end_time` absolute; `weekly_remains_time` /
 *    `weekly_end_time` siblings.
 *  - The M-series shared bucket ships percent-ONLY (count totals read 0):
 *    synthesize the window from the percent against a 100 scale, never emit
 *    a phantom absolute.
 *  - Window names: `<model label> (5h)` / `<model label> (7d)`; the
 *    wildcards `MiniMax-M*` / `general` render as `M-series`.
 *
 * Copilot / Zed / Kimi-OAuth channels: documented backlog — their auth is not
 * an inference-shaped header (device-code OAuth, minted tokens), so they can
 * never enter the config table either.
 */

const GLOBAL_URLS = [
  'https://www.minimax.io/v1/token_plan/remains',
  'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
];
const CHINA_URLS = [
  'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains',
  'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
];

/** On coding_plan endpoints the *_usage_count fields count REMAINING. */
function countMeansRemaining(url: string): boolean {
  return url.includes('/coding_plan/');
}

function urlsFor(providerId: string): string[] {
  return providerId.endsWith('-cn') ? CHINA_URLS : GLOBAL_URLS;
}

// ─── Response parsing (self-recorded fact shapes) ───────────────────────────

function field(model: Record<string, unknown>, snake: string, camel: string): unknown {
  return model[snake] ?? model[camel] ?? null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Percent clamp; null stays null (absence is meaningful here). */
function pct(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.max(0, Math.min(100, n));
}

function modelLabel(model: Record<string, unknown>): string {
  const raw = String(field(model, 'model_name', 'modelName') ?? '').trim();
  if (!raw) return 'MiniMax';
  if (raw === 'MiniMax-M*' || raw === 'general') return 'M-series';
  return raw.replace(/[_-]+/g, ' ');
}

/**
 * Resolve one window (session or weekly) from a model_remains item.
 * `remainingSemantics` flips the count reading; percent fields always mean
 * remaining (verified fact). Reset prefers the RELATIVE `*_remains_time`
 * (probe-time + delta) and falls back to the absolute `*_end_time`.
 */
function buildWindow(
  model: Record<string, unknown>,
  label: string,
  prefix: '' | 'current_weekly_',
  resetKeys: [string, string, string, string],
  totalKey: [string, string],
  countKey: [string, string],
  percentKey: [string, string],
  probeTimeMs: number,
  remainingSemantics: boolean
): QuotaWindow | null {
  const [snakeRel, camelRel, snakeAbs, camelAbs] = resetKeys;
  let total = num(field(model, ...totalKey)) ?? 0;
  let count = num(field(model, ...countKey)) ?? 0;
  const percentRemaining = pct(field(model, ...percentKey));

  if (total <= 0) {
    // M-series percent-only bucket: synthesize on a 100 scale.
    if (percentRemaining === null) return null;
    total = 100;
    count = remainingSemantics ? percentRemaining : 100 - percentRemaining;
  }

  const used = remainingSemantics ? Math.max(0, total - count) : Math.min(Math.max(0, count), total);
  const remaining = Math.max(0, total - used);
  const remainingPct = percentRemaining !== null ? percentRemaining : total > 0 ? (remaining / total) * 100 : null;

  const relMs = num(field(model, snakeRel, camelRel)) ?? 0;
  const absRaw = field(model, snakeAbs, camelAbs);
  const absMs = num(absRaw);
  const resetAt = relMs > 0 ? probeTimeMs + relMs : absMs && absMs > 0 ? (absMs < 1e12 ? absMs * 1000 : absMs) : null;

  return {
    name: `${label} ${prefix === 'current_weekly_' ? '(7d)' : '(5h)'}`,
    nameCode: prefix === 'current_weekly_' ? 'modelWeekly' : 'modelSession',
    nameArg: label,
    used: Math.round(used * 1e6) / 1e6,
    total: Math.round(total * 1e6) / 1e6,
    remainingPct: remainingPct === null ? null : Math.round(remainingPct * 100) / 100,
    resetAt,
    unlimited: false,
  };
}

function parseRemainsPayload(payload: any, probeTimeMs: number, url: string): QuotaWindow[] {
  const list = Array.isArray(payload?.model_remains) ? payload.model_remains : Array.isArray(payload?.modelRemains) ? payload.modelRemains : [];
  const windows: QuotaWindow[] = [];
  const flipped = countMeansRemaining(url);
  for (const model of list) {
    if (!model || typeof model !== 'object') continue;
    const label = modelLabel(model);
    const session = buildWindow(
      model, label, '',
      ['remains_time', 'remainsTime', 'end_time', 'endTime'],
      ['current_interval_total_count', 'currentIntervalTotalCount'],
      ['current_interval_usage_count', 'currentIntervalUsageCount'],
      ['current_interval_remaining_percent', 'currentIntervalRemainingPercent'],
      probeTimeMs, flipped
    );
    if (session) windows.push(session);
    const weekly = buildWindow(
      model, label, 'current_weekly_',
      ['weekly_remains_time', 'weeklyRemainsTime', 'weekly_end_time', 'weeklyEndTime'],
      ['current_weekly_total_count', 'currentWeeklyTotalCount'],
      ['current_weekly_usage_count', 'currentWeeklyUsageCount'],
      ['current_weekly_remaining_percent', 'currentWeeklyRemainingPercent'],
      probeTimeMs, flipped
    );
    if (weekly) windows.push(weekly);
  }
  return windows;
}

// ─── Probe ──────────────────────────────────────────────────────────────────

export const MINIMAX_ADAPTER: QuotaCodeAdapter = {
  id: 'minimax',
  providerIds: ['minimax', 'minimax-cn', 'minimax-coding-plan', 'minimax-cn-coding-plan'],

  async probe(ctx: QuotaAdapterContext): Promise<QuotaProbeOutcome> {
    const doFetch = ctx.fetchImpl ?? fetch;
    const now = ctx.now ?? Date.now;
    const timeoutMs = ctx.timeoutMs ?? 10_000;
    const urls = urlsFor(ctx.providerId);
    let lastFailure: QuotaProbeOutcome = { ok: false, reason: 'network' };

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const canFallback = i < urls.length - 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${ctx.key}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });

        // Hard key verdict — the credential is wrong, not the endpoint.
        const http: LastProbeCapture = { url, status: res.status, ok: res.ok };
        if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth', http };

        if (!res.ok) {
          lastFailure = { ok: false, reason: 'status' };
          if ((res.status === 404 || res.status === 405 || res.status >= 500) && canFallback) continue;
          return { ...lastFailure, http };
        }

        const raw = await res.text().catch(() => '');
        let payload: any = null;
        try {
          payload = raw ? JSON.parse(raw) : null;
        } catch {
          payload = null;
        }
        if (!payload || typeof payload !== 'object') {
          http.body = raw.slice(0, LAST_BODY_MAX_CHARS);
          return { ok: false, reason: 'shape', http };
        }

        const base = payload.base_resp ?? payload.baseResp ?? null;
        if (base && typeof base === 'object') {
          const code = Number(base.status_code ?? base.statusCode) || 0;
          const msg = `${String(base.status_msg ?? base.statusMsg ?? '')} ${raw}`;
          if (code === 1004 || /invalid api key|invalid key|unauthorized|inactive/i.test(msg)) {
            return { ok: false, reason: 'auth', http };
          }
          if (code !== 0) return { ok: false, reason: 'status', http };
        }

        const probeTimeMs = now();
        const windows = parseRemainsPayload(payload, probeTimeMs, url);
        if (windows.length === 0) return { ok: false, reason: 'shape', http };
        http.body = raw.length > LAST_BODY_MAX_JSON_CHARS ? raw.slice(0, LAST_BODY_MAX_CHARS) : payload;
        return { ok: true, windows, plan: ctx.providerId.includes('coding-plan') ? 'Token Plan' : undefined, http };
      } catch {
        lastFailure = { ok: false, reason: 'network' };
        if (!canFallback) return lastFailure;
        continue;
      } finally {
        clearTimeout(timer);
      }
    }
    return lastFailure;
  },
};

import React from 'react';
import { InfoTip } from './InfoTip';
import { useI18n } from '../i18n/I18nContext';
import type { RateLimitRule } from '../lib/api';

/**
 * Shared rate-limit rules editor — one row per sliding-window rule entry.
 * `window` is a duration string (30s / 5m / 1h / 1d — the same syntax the
 * backend compiles); each of the three countables is an INDEPENDENT
 * constraint sharing that window, blank = not capped. Compilation mirrors the
 * engine's validation client-side so a bad row never reaches the API.
 *
 * Two consumers by design: the inbound editor (ApiKeysPage, apiKeys[].limits)
 * and the outbound overlay (KeysPage accounts, config `accounts:`) — one
 * concept, one editor.
 */
const WINDOW_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

/** Mirror of the backend parseDuration bounds (rate-limiter.ts): a positive
 *  value whose millisecond form survives rounding (sub-ms would compile to a
 *  permanently-empty window). Keeps the editor promise "a bad row never
 *  reaches the API" true. */
const WINDOW_UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function validWindow(text: string): boolean {
  const m = WINDOW_PATTERN.exec(text.trim());
  if (!m) return false;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return false;
  return Math.round(value * WINDOW_UNIT_MS[m[2]]) >= 1;
}

export interface LimitDraft {
  window: string;
  requests: string;
  tokens: string;
  costUsd: string;
}

export const EMPTY_LIMIT_DRAFT: LimitDraft = { window: '', requests: '', tokens: '', costUsd: '' };

export const draftFromRule = (r: RateLimitRule): LimitDraft => ({
  window: r.window,
  requests: r.requests != null ? String(r.requests) : '',
  tokens: r.tokens != null ? String(r.tokens) : '',
  costUsd: r.costUsd != null ? String(r.costUsd) : '',
});

/** Technical rule label — machine-readable, locale-neutral (same window/dims
 *  echo the backend verdicts use). e.g. "1m: 30 req / 60000 tok". */
export const ruleLabel = (r: RateLimitRule): string => {
  const dims = [
    r.requests != null ? `${r.requests} req` : null,
    r.tokens != null ? `${r.tokens} tok` : null,
    r.costUsd != null ? `$${r.costUsd}` : null,
  ]
    .filter(Boolean)
    .join(' / ');
  return `${r.window}: ${dims}`;
};

/** Compile drafts → wire rules. Empty drafts are dropped; any invalid draft
 *  fails the whole save with an error message (never a silent partial write). */
export function compileLimitDrafts(
  drafts: LimitDraft[],
  t: (key: string) => string
): { rules?: RateLimitRule[]; error?: string } {
  const filled = drafts.filter((d) => d.window.trim() || d.requests.trim() || d.tokens.trim() || d.costUsd.trim());
  if (filled.length === 0) return {};
  const rules: RateLimitRule[] = [];
  for (const d of filled) {
    const window = d.window.trim();
    if (!validWindow(window)) return { error: t('apiKeys.limitsErrWindow') };
    const rule: RateLimitRule = { window };
    let any = false;
    for (const dim of ['requests', 'tokens', 'costUsd'] as const) {
      const raw = d[dim].trim();
      if (!raw) continue;
      const num = Number(raw);
      if (!Number.isFinite(num) || num < 0) return { error: t('apiKeys.limitsErrNumber') };
      rule[dim] = num;
      any = true;
    }
    if (!any) return { error: t('apiKeys.limitsErrNoCountable') };
    rules.push(rule);
  }
  return { rules };
}

export const LimitsEditor: React.FC<{
  value: LimitDraft[];
  onChange: (next: LimitDraft[]) => void;
}> = ({ value, onChange }) => {
  const { t } = useI18n();
  const patch = (i: number, next: Partial<LimitDraft>) =>
    onChange(value.map((row, j) => (j === i ? { ...row, ...next } : row)));

  const numInput = (dim: 'requests' | 'tokens' | 'costUsd', row: LimitDraft, i: number) => (
    <input
      type="number"
      min={0}
      step={dim === 'costUsd' ? '0.01' : '1'}
      className="input"
      style={{ flex: 1, minWidth: 0, padding: '6px 8px', fontSize: '12px' }}
      value={row[dim]}
      onChange={(e) => patch(i, { [dim]: e.target.value })}
      placeholder="—"
      aria-label={t(`apiKeys.limitsTh_${dim}`)}
    />
  );

  return (
    <div>
      <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)', display: 'block', marginBottom: '6px' }}>
        {t('apiKeys.limitsLabel')} <InfoTip text={t('apiKeys.limitsHint')} />
      </label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {value.map((row, i) => (
          <div key={i} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input
              type="text"
              className="input"
              style={{ width: '72px', padding: '6px 8px', fontSize: '12px' }}
              value={row.window}
              onChange={(e) => patch(i, { window: e.target.value })}
              placeholder="1m"
              aria-label={t('apiKeys.limitsTh_window')}
            />
            {numInput('requests', row, i)}
            {numInput('tokens', row, i)}
            {numInput('costUsd', row, i)}
            <button
              type="button"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: '4px' }}
              title={t('common.delete')}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '6px', fontSize: '10px', color: 'var(--text-dim)', marginTop: '4px', opacity: 0.8 }}>
        <span style={{ width: '72px' }}>{t('apiKeys.limitsTh_window')}</span>
        <span style={{ flex: 1 }}>{t('apiKeys.limitsTh_requests')}</span>
        <span style={{ flex: 1 }}>{t('apiKeys.limitsTh_tokens')}</span>
        <span style={{ flex: 1 }}>{t('apiKeys.limitsTh_costUsd')}</span>
        <span style={{ width: '20px' }} />
      </div>
      <button
        type="button"
        className="btn"
        style={{ marginTop: '8px', fontSize: '11px', padding: '4px 10px' }}
        onClick={() => onChange([...value, { ...EMPTY_LIMIT_DRAFT }])}
      >
        {t('apiKeys.limitsAddBtn')}
      </button>
    </div>
  );
};

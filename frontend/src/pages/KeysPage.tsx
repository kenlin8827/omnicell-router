import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { Key, Check, RefreshCw, Trash2, Plug, Plus, Lock, Cpu, Zap, Upload, Download, AlertTriangle, Pencil, Unplug, Clock, ShieldAlert, Ban, PowerOff, Power, Copy, Gauge, Maximize2, ArrowUpToLine } from 'lucide-react';
import {
  opencodeApi,
  api,
  type OpenCodeProviderView,
  type OpenCodeCatalogProvider,
  type CredentialStoreStatus,
  type CredentialStoreKind,
  type CredentialStoreCapabilities,
  type CredentialStoreDegradedCode,
  type CredentialExcludedReasonCode,
  type SyncPreconditionCode,
  type CredentialSyncClientView,
  type CredentialSyncOutcome,
  type CredentialMeta,
  type CredentialHealth,
  type CredentialWriteReasonCode,
  type CredentialRevealReasonCode,
  type RateLimitSnapshotEntry,
  type CredentialQuotaView,
  type NpmVocabularyEntry,
} from '../lib/api';
import {
  LimitsEditor,
  compileLimitDrafts,
  draftFromRule,
  ruleLabel,
  type LimitDraft,
} from '../components/RateLimitEditor';
import { ProviderModelsDialog } from '../components/ProviderModelsDialog';
import { Dialog } from '../components/Dialog';
import { useI18n } from '../i18n/I18nContext';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';
import { Combobox } from '../components/Combobox';
import { Pagination } from '../components/Pagination';
import { Switch } from '../components/Switch';
import { InfoTip } from '../components/InfoTip';
import { useModelTest } from '../lib/useModelTest';
import { useBackdropDismiss } from '../lib/useBackdropDismiss';
import { fmtLatency } from '../lib/format';
import { byWindowClass, headlineWindow } from '../lib/quotaRank';
import { failureCaption } from '../lib/quotaFailure';

import { FONT_MONO } from '../lib/fonts';
// Nested-card surface (bg/border/radius/padding) is the global .sub-card
// class in index.css — single source of truth across all pages and themes.
const cardFlex: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
};

const CATALOG_PAGE_SIZE = 20;
const CONNECTED_PAGE_SIZE = 12;
// Perceptible-click floor: a fast local API would otherwise spin for <100ms and
// look like nothing happened. Data renders as soon as it lands; only the button
// state release stretches to this floor. 1000ms+ was rejected as sluggish.
const MIN_SPIN_MS = 400;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const CONNECTED_PAGE_SIZES = [12, 24, 48];
const CATALOG_PAGE_SIZES = [10, 20, 50, 100, 200];

/**
 * Offline fallback ONLY (the npm-vocabulary endpoint lives in the same gateway
 * process, so this list is practically unreachable — it keeps the form usable
 * if the fetch fails). Source of truth = backend providers/vocabulary.ts,
 * served over /api/admin/opencode/npm-vocabulary.
 */
const FALLBACK_NPM_PACKAGES = [
  '@ai-sdk/openai-compatible',
  '@ai-sdk/anthropic',
  '@ai-sdk/openai',
  '@ai-sdk/google',
  '@ai-sdk/typesafe-ai',
  '@ai-sdk/azure',
  '@ai-sdk/amazon-bedrock',
  '@ai-sdk/xai',
  '@ai-sdk/mistral',
];
const CUSTOM_NPM = '__custom__';

/** One editable header row (2-column editor state). */
interface HeaderRow {
  name: string;
  value: string;
}
const rowsToHeaders = (rows: HeaderRow[]): Record<string, string> | undefined => {
  const h: Record<string, string> = {};
  for (const r of rows) {
    const k = r.name.trim();
    const v = r.value.trim();
    if (k && v) h[k] = v;
  }
  return Object.keys(h).length > 0 ? h : undefined;
};
const headersToRows = (headers?: Record<string, string>): HeaderRow[] =>
  Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));

/** Two-column header rows editor: name | value | remove, plus an add-row
 *  affordance. Blank rows are ignored on serialize. */
const HeadersEditor: React.FC<{
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  disabled?: boolean;
}> = ({ rows, onChange, disabled }) => {
  const { t } = useI18n();
  const setRow = (i: number, patch: Partial<HeaderRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 3fr) auto', gap: 6, alignItems: 'center' }}>
          <input
            className="input"
            style={{ fontSize: 12, fontFamily: FONT_MONO }}
            placeholder={t('op.headerNamePh')}
            value={r.name}
            disabled={disabled}
            onChange={e => setRow(i, { name: e.target.value })}
          />
          <input
            className="input"
            style={{ fontSize: 12, fontFamily: FONT_MONO }}
            placeholder={t('op.headerValuePh')}
            value={r.value}
            disabled={disabled}
            onChange={e => setRow(i, { value: e.target.value })}
          />
          <button
            className="btn btn-sm"
            style={{ color: 'var(--accent-rose)', flexShrink: 0 }}
            disabled={disabled}
            title={t('op.headerRemove')}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <div>
        <button className="btn btn-sm" disabled={disabled} onClick={() => onChange([...rows, { name: '', value: '' }])}>
          <Plus size={12} />
          <span>{t('op.headerAdd')}</span>
        </button>
      </div>
    </div>
  );
};

/** Live input mask for the custom-provider id field. Mirrors the backend wire
 *  contract `isValidProviderId` (backend/src/opencode/user-config.ts):
 *  lowercase slug over [a-z0-9._-] with a leading letter/digit. Stripping and
 *  lowercasing on keystroke (paste included) means the field can only hold a
 *  rule-conforming id - the user always sees exactly what will be stored. */
const normalizeProviderIdInput = (raw: string): string =>
  raw.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '');

/** Custom-provider form cell: a real label sits above the control and the
 *  placeholder is free to show an example — a typed field must not lose its
 *  identity when its placeholder disappears. */
const FormField: React.FC<{ label: string; required?: boolean; style?: React.CSSProperties; children: React.ReactNode }> = ({ label, required, style, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, ...style }}>
    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)' }}>
      {label}
      {required && <span style={{ color: 'var(--accent-rose)', marginLeft: 3 }} aria-hidden>*</span>}
    </span>
    {children}
  </div>
);

/** Provider logo on the theme-tinted chip plate (models.dev SVGs are dark glyphs:
 *  --logo-glyph-filter inverts them bright on dark-class themes, light-class
 *  themes draw as-is). Falls back to an initial-letter chip. */
const ProviderLogo: React.FC<{ id: string; logo?: string; size?: number }> = ({ id, logo, size = 28 }) => {
  const [failed, setFailed] = useState(false);
  const chip: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.max(6, size * 0.28),
    background: 'var(--chip-bg)',
    border: '1px solid var(--card-border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    overflow: 'hidden',
  };
  if (!logo || failed) {
    return (
      <div style={chip}>
        <span
          style={{
            fontWeight: 800,
            fontSize: size * 0.52,
            color: 'var(--text-main)',
            textTransform: 'uppercase',
            lineHeight: 1,
          }}
        >
          {id.slice(0, 1)}
        </span>
      </div>
    );
  }
  return (
    <div style={chip}>
      <img
        src={logo}
        alt={id}
        width={Math.round(size * 0.72)}
        height={Math.round(size * 0.72)}
        onError={() => setFailed(true)}
        style={{ objectFit: 'contain', filter: 'var(--logo-glyph-filter)' }}
        loading="lazy"
      />
    </div>
  );
};

// Outline badges: transparent fill, border derived from the text hue (the
// bg param is legacy at call sites — kept for signature stability).
// whiteSpace: nowrap — a pill never breaks mid-text (CJK allows a break
// between any two characters); squeezed badges wrap as whole units instead.
const badgeStyle = (color: string, _bg: string): React.CSSProperties => ({
  background: 'transparent',
  color,
  fontSize: '10px',
  fontWeight: 600,
  padding: '2px 8px',
  borderRadius: '99px',
  border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
  whiteSpace: 'nowrap',
});

type TFn = (path: string, params?: Record<string, string | number>) => string;

/** Relative "last synced" label (just now / N min ago / …) — "never" when absent. */
const syncTimeAgo = (ts: number | undefined, t: TFn): string => {
  if (!ts) return t('op.syncNever');
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('op.syncJustNow');
  if (diff < 3_600_000) return t('op.syncMinutesAgo', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('op.syncHoursAgo', { n: Math.floor(diff / 3_600_000) });
  return t('op.syncDaysAgo', { n: Math.floor(diff / 86_400_000) });
};

/** One-line outcome summary under a "last synced" timestamp (masked metadata only). */
const syncOutcomeText = (o: CredentialSyncOutcome | undefined, t: TFn): string => {
  if (!o) return '';
  if (o.precondition) {
    const map: Record<string, string> = {
      client_absent: 'op.syncPrecClientAbsent',
      client_unreadable: 'op.syncPrecClientUnreadable',
      service_unreachable: 'op.syncPrecServiceUnreachable',
    };
    return t(map[o.precondition] ?? 'op.syncGenericFailure');
  }
  const failed = o.entries.filter((e) => e.action === 'failed').length;
  const skipped = o.entries.filter((e) => e.action === 'skipped').length;
  const parts: string[] = [];
  if (o.pulled !== undefined) {
    parts.push(o.entries.length === 0 ? t('op.syncReadEmpty') : t('op.syncReadSummary', { n: o.pulled ?? 0, d: o.deduped ?? 0 }));
  } else {
    parts.push(o.entries.length === 0 ? t('op.syncWriteEmpty') : t('op.syncWriteSummary', { n: o.pushed ?? 0, d: o.deduped ?? 0 }));
  }
  if (skipped > 0) parts.push(t('op.syncSkippedCount', { n: skipped }));
  if (failed > 0) parts.push(t('op.syncFailedCount', { n: failed }));
  // The def half of a v2 write: rendered provider nodes. A failed reload is NOT
  // a metric — it is a state warning, so it rides the row's badge cluster (short
  // label + full explanation on hover) instead of bloating this dim summary.
  if (o.defsMaterialized !== undefined) parts.push(t('op.syncDefsSummary', { n: o.defsMaterialized }));
  // The def half of a READ: the client's hand-written provider defs are imported
  // add-only, through the adapter of the client that was synced.
  if (o.defsImported !== undefined && (o.defsImported > 0 || (o.defsConverted ?? 0) > 0)) {
    parts.push(t('op.syncDefsImported', { n: o.defsImported, c: o.defsConverted ?? 0 }));
  }
  return parts.join(' · ');
};

/** State warnings that must NOT be folded into the dim one-line summary —
 * they are conditions, not counts (e.g. the client keeps serving stale defs
 * until the next successful push). Callers render them as a badge (row) or
 * append them to a toast (manual run). */
const syncOutcomeWarnings = (o: CredentialSyncOutcome | undefined, t: TFn): string[] => {
  const out: string[] = [];
  if (o?.defsChanged === true && o.defsReloaded === false) out.push(t('op.syncDefsReloadFailed'));
  return out;
};

/** Tooltip for an outcome line: the PROVIDER dimension behind the credential
 *  counts. Returned only when the two differ — a provider holding several keys
 *  is the one case where "9 credentials" reads as "9 providers" (the line's
 *  visible text is the credential count, so a title equal to it says nothing). */
const syncOutcomeBreakdown = (o: CredentialSyncOutcome | undefined, t: TFn): string => {
  if (!o || o.entries.length === 0) return '';
  const byProvider = new Map<string, number>();
  for (const e of o.entries) byProvider.set(e.provider, (byProvider.get(e.provider) ?? 0) + 1);
  if (byProvider.size === o.entries.length) return '';
  const list = Array.from(byProvider.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([provider, n]) => `${provider} ×${n}`)
    .join(' · ');
  return t('op.syncProvidersBreakdown', { p: byProvider.size, list });
};

const syncHeadCell: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-dim)',
  borderBottom: '1px solid var(--divider)',
  paddingBottom: 6,
};
const syncTimeCell: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  fontSize: 12,
  color: 'var(--text-main)',
};
const syncOutcomeStyle: React.CSSProperties = {
  fontSize: 10.5,
  color: 'var(--text-dim)',
  lineHeight: 1.5,
};

/**
 * Clipboard write with a non-secure-context fallback. navigator.clipboard
 * requires a trustworthy origin: the loopback console has one, a LAN http://
 * bind does NOT — and webAuth (hence reveal) is exactly what a non-loopback
 * bind forces on, so the legacy execCommand path must keep "copy" meaning
 * "copy" there too.
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (!ok) throw new Error('clipboard-unavailable');
  }
}

// the credential-store API serves machine-readable codes ONLY;
// these tables own all user-visible copy (unknown codes fall back to the raw
// code string — loud, never a wrong localized claim).
const STORE_KIND_LABEL: Partial<Record<CredentialStoreKind, string>> = {
  'opencode-v2': 'op.storeKindOpencodeV2',
  'opencode-v2-readonly': 'op.storeKindOpencodeV2Readonly',
  ocr: 'op.storeKindOcr',
};
const STORE_DEGRADED_LABEL: Partial<Record<CredentialStoreDegradedCode, string>> = {
  bind_failed: 'op.storeDegradedBind',
};
const EXCLUDED_REASON_LABEL: Partial<Record<CredentialExcludedReasonCode, string>> = {
  db_unreadable: 'op.exclDbUnreadable',
  no_routable_credential: 'op.exclNoRoutable',
  reconcile_push_failed: 'op.exclReconcilePushFailed',
  bind_failed: 'op.exclBindFailed',
};
// Sync-path precondition codes. ocJson keeps the machine code on the error; only
// KNOWN codes get a localized claim — unknown codes fall back to the raw string,
// loud over pretty-but-wrong.
const SYNC_PRECONDITION_LABEL: Partial<Record<SyncPreconditionCode, string>> = {
  service_unreachable: 'op.pushOpencodeV2Unreachable',
  client_unreadable: 'op.pushOpencodeV2DbUnreadable',
  client_absent: 'op.syncPrecClientAbsent',
};
/**
 * Credential-store write reasonCodes — the per-credential routes AND provider
 * connect/key/create share console.ts `mapStoreWriteFailure`.
 */
const WRITE_REASON_LABEL: Partial<Record<CredentialWriteReasonCode, string>> = {
  credential_not_found: 'op.reasonCredentialNotFound',
  capability_unsupported: 'op.reasonCapabilityUnsupported',
  integration_unmatched: 'op.reasonIntegrationUnmatched',
  invalid_label: 'op.reasonInvalidLabel',
  store_readonly: 'op.reasonStoreReadonly',
  store_unreadable: 'op.reasonStoreUnreadable',
  write_failed: 'op.reasonWriteFailed',
  no_key_identity: 'op.reasonNoKeyIdentity',
  invalid_reason: 'op.reasonInvalidReason',
};
/**
 * Reveal-route preconditions (console.ts `credentialReveal`).
 * The store-layer failures of the same route already ride WRITE_REASON_LABEL
 * (shared failure mapper); these three are the password-gate vocabulary.
 */
const REVEAL_REASON_LABEL: Partial<Record<CredentialRevealReasonCode, string>> = {
  webauth_required: 'op.reasonWebauthRequired',
  invalid_password: 'op.reasonInvalidPassword',
  too_many_attempts: 'op.reasonTooManyAttempts',
};

/** Cooldown chip text — mm:ss under an hour, h:mm:ss above. */
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Per-credential quota badge — four states, display-only (never
 * gates routing). Compact label = the headline window's remaining percent
 * (probed) or a one-word state (declared / unverified); the tooltip lists every
 * window with its reset countdown, plus provenance (plan / entry / verified).
 * Staleness is honest: a probe failure keeps the last values and dims the
 * badge — the store, not the badge, is the source of truth.
 */
function QuotaBadge({ quota }: { quota: CredentialQuotaView }) {
  const { t } = useI18n();
  const now = Date.now();
  // The badge headlines the shortest-period capped window (a 5h session leads
  // over a weekly even when the weekly is tighter — it throttles the next
  // request). Balance pools carry no burn signal (their percent is a
  // flattening artifact, always 100) and never headline.
  const tightest = headlineWindow(quota.windows) ?? undefined;

  let color = 'var(--text-dim)';
  let label = '';
  if (quota.badge === 'probed') {
    const pct = tightest?.remainingPct ?? null;
    color = pct === null ? 'var(--text-dim)' : pct < 10 ? 'var(--accent-rose)' : pct < 25 ? 'var(--accent-amber)' : 'var(--accent)';
    label = pct === null ? '•' : `${Math.round(pct)}%`;
  } else if (quota.badge === 'stale') {
    color = 'var(--text-dim)';
    label = tightest ? `${Math.round(tightest.remainingPct ?? 0)}%` : '—';
  } else if (quota.badge === 'declared') {
    label = t('op.quotaBadgeDeclared');
  } else {
    // unverified — covered, waiting for the first result.
    label = '…';
  }

  const lines: string[] = [];
  if (quota.badge === 'stale' && quota.lastFailureAt) {
    lines.push(t('op.quotaStaleSince', { when: formatCountdown(Math.max(0, now - quota.lastFailureAt)) }));
  }
  // The recorded verdict (upstream status + its own words) — a covered pair
  // whose credential was rejected or whose plan is inactive must not read as
  // "waiting for the first sync".
  const failed = failureCaption(quota, t);
  if (failed) lines.push(failed);
  if (quota.badge === 'unverified' && !failed) lines.push(t('op.quotaUnverified'));
  if (quota.plan) lines.push(t('op.quotaPlan', { plan: quota.plan }));
  if (quota.windows.length === 0) {
    lines.push(t('op.quotaNoData'));
  } else {
    for (const w of [...quota.windows].sort(byWindowClass)) {
      let desc: string;
      if (w.nameCode === 'balance' && w.total !== null) desc = t('op.quotaBalance', { amount: fmtNum(Math.max(0, (w.total ?? 0) - (w.used ?? 0))) });
      else if (w.unlimited || w.total === null) desc = t('op.quotaNoCap');
      else if (w.remainingPct !== null && w.total === 100) desc = t('op.quotaLeft', { pct: Math.round(w.remainingPct) });
      else if (w.remainingPct !== null) desc = `${Math.round(w.remainingPct)}% · ${t('op.quotaLeftAbs', { remaining: fmtNum((w.total ?? 0) - (w.used ?? 0)), total: fmtNum(w.total ?? 0) })}`;
      else desc = t('op.quotaLeftAbs', { remaining: fmtNum((w.total ?? 0) - (w.used ?? 0)), total: fmtNum(w.total ?? 0) });
      if (w.resetAt && w.resetAt > now) desc += ` · ${t('op.quotaResets', { when: formatCountdown(w.resetAt - now) })}`;
      lines.push(`${w.name}: ${desc}`);
    }
  }
  if (quota.verifiedAt && quota.badge !== 'unverified') {
    lines.push(t('op.quotaVerified', { when: formatCountdown(Math.max(0, now - quota.verifiedAt)) }));
  }
  if (quota.entryId) lines.push(quota.entryId);

  return (
    <span
      style={{ ...badgeStyle(color, 'transparent'), display: 'inline-flex', alignItems: 'center', gap: 3, opacity: quota.badge === 'stale' || quota.badge === 'unverified' ? 0.7 : 1 }}
      title={lines.join('\n')}
    >
      <Gauge size={9} />
      {label}
    </span>
  );
}

/** Trim long decimals for tooltip text (quota values carry unit noise). */
function fmtNum(n: number): string {
  return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 100) / 100);
}

/**
 * 1-second clock for the cooldown chips. Ticks only until the LAST cooldown on
 * screen expires (`untilMax`), then the effect cleans itself up — no idle 1 Hz
 * re-render of a page nobody is watching.
 */
function useCountdownClock(untilMax: number): number {
  const [now, setNow] = useState(() => Date.now());
  const ticking = untilMax > now;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
}

/**
 * Capped credential list: 3 one-line rows visible, the rest scrolls inside the
 * card. `CREDENTIAL_ROW_HEIGHT_EST` is an ESTIMATE of a single-line CredentialRow
 * (padding + the tallest of its mono chips / icon buttons); if the row style
 * changes, this constant must follow — an off-by-a-few cap only shows slightly
 * fewer rows. Upgrade path if it ever needs to be exact: measure the first
 * rendered row and drive max-height from it.
 */
const CREDENTIAL_ROWS_VISIBLE = 3;
const CREDENTIAL_ROW_HEIGHT_EST = 36;

/**
 * Credential display name: the operator's label, or a bare neutral placeholder.
 * OCR never invents a name, and the placeholder carries no fingerprint either —
 * unlabeled rows are already distinguished by their masked key, and get the
 * explicit `#fingerprint` chip when even that collides (see prefixVisible).
 */
function credentialName(a: CredentialMeta, unnamed: string): string {
  return a.label?.trim() || unnamed;
}

/** Short fingerprint chip text (`#abcdef0123`); the full value rides in the title. */
const PrefixChip: React.FC<{ credential: CredentialHealth }> = ({ credential }) => {
  const { t } = useI18n();
  if (!credential.keyHashPrefix) return null;
  return (
    <span
      style={{ ...badgeStyle('var(--text-dim)', 'var(--chip-bg)'), fontFamily: FONT_MONO }}
      title={t('op.credentialPrefixTip', { prefix: credential.keyHashPrefix, id: credential.id })}
    >
      #{credential.keyHashPrefix.slice(0, 8)}
    </span>
  );
};

type CredentialRowProps = {
  credential: CredentialHealth;
  caps: CredentialStoreCapabilities;
  /**
   * This is the provider's ONLY routable credential, so it is what actually
   * serves even when the store leaves `active` false (opencode v2 does not flag
   * a lone row — resolveKey's sole-row fallback is what routes it). Rendering
   * the raw flag alone would leave a working single-key provider unmarked.
   */
  soleServing: boolean;
  /**
   * Show the fingerprint chip: only when another row of this provider masks to
   * the same text (or masks to nothing). Otherwise the id stays available in the
   * masked key's tooltip — it is a correlation id, not something to read.
   */
  prefixVisible: boolean;
  /** This row has a request in flight — only one row is busy at a time. */
  pending: boolean;
  /** A connectivity probe for THIS credential row is in flight (multi-credential: per-row, not per-card). */
  testing: boolean;
  /** Label edit mode is page-owned: it closes on the write's success, not before. */
  renaming: boolean;
  onStartRename: () => void;
  onCancelRename: () => void;
  /** Shared tick clock (cooldown chips). */
  now: number;
  onPin: (a: CredentialHealth) => void;
  onRename: (a: CredentialHealth, label: string) => void;
  /** One-shot upstream probe with THIS row's exact key (bypasses head selection). */
  onTest: (a: CredentialHealth) => void;
  onDisconnect: (a: CredentialHealth) => void;
  onToggleDisabled: (a: CredentialHealth) => void;
  onClearSuspect: (a: CredentialHealth) => void;
  /**
   * Reveal re-enters the console LOGIN password, so the
   * copy affordance only exists where that password lives (webAuth active).
   * Disabled-with-reason, never silently absent — a mystery-disabled button is
   * the same UX bug as an unlabeled one.
   */
  canReveal: boolean;
  onCopyKey: (a: CredentialHealth) => void;
  /** Open the outbound rate-limit overlay editor for THIS credential. */
  onEditLimits: (a: CredentialHealth) => void;
  /** 1-based chain slot in the list; the chain head is always #1. */
  position: number;
};

/** Compact icon-button look shared by every per-credential action. */
const CRED_ICON_BTN: React.CSSProperties = { padding: '2px 6px', fontSize: 11, lineHeight: 1 };
const CRED_ICON_BTN_LG: React.CSSProperties = { padding: '3px 7px', fontSize: 12, lineHeight: 1 };

/**
 * Status badges for one credential — shared by the card row and the zoom
 * table so the two surfaces can never disagree on what a row "says".
 * Word badges keep icon + text; icon-only markers lean on `title`.
 */
const CredentialStatusBadges: React.FC<{ credential: CredentialHealth; remaining: number }> = ({ credential, remaining }) => {
  const { t } = useI18n();
  return (
    <>
      {credential.disabled && (
        <span
          style={{ ...badgeStyle('var(--accent-rose)', 'color-mix(in srgb, var(--accent-rose) 12%, transparent)'), display: 'inline-flex', alignItems: 'center', gap: 3 }}
          title={credential.disabledReason ? `${t('op.credentialDisabledTip')} · ${credential.disabledReason}` : t('op.credentialDisabledTip')}
        >
          <PowerOff size={9} />
          {t('op.credentialDisabled')}
        </span>
      )}
      {!credential.routable && (
        <span style={{ display: 'inline-flex', color: 'var(--text-dim)' }} title={t('op.credentialNotRoutableTip')}>
          <Ban size={11} />
        </span>
      )}
      {credential.suspect && (
        <span style={{ display: 'inline-flex', color: 'var(--accent-rose)' }} title={t('op.credentialSuspectTip')}>
          <AlertTriangle size={11} />
        </span>
      )}
      {remaining > 0 && (
        <span
          style={{ ...badgeStyle('var(--accent-amber)', 'color-mix(in srgb, var(--accent-amber) 12%, transparent)'), display: 'inline-flex', alignItems: 'center', gap: 3 }}
          title={t('op.credentialOpenPairs', { n: credential.openPairs })}
        >
          <Clock size={9} />
          {formatCountdown(remaining)}
        </span>
      )}
      {/* Outbound caps armed for THIS credential (config credentials: overlay).
          The count is the rule count; per-rule detail lives in the tooltip. */}
      {(credential.limits ?? []).length > 0 && (
        <span
          style={{ ...badgeStyle('var(--accent)', 'color-mix(in srgb, var(--accent) 12%, transparent)'), display: 'inline-flex', alignItems: 'center', gap: 3 }}
          title={(credential.limits ?? []).map(ruleLabel).join('\n')}
        >
          <Gauge size={9} />
          {(credential.limits ?? []).length}
        </span>
      )}
      {/* Quota tracking badge: present only when the provider is COVERED —
          absence != the `unverified` state. Display-only, never gates routing. */}
      {credential.quota && <QuotaBadge quota={credential.quota} />}
    </>
  );
};

/**
 * Per-credential action buttons — the single source of action availability
 * (Decision 1: capability-first) shared by the card row and the zoom table.
 * Icon-only with full title + aria-label; the zoom table puts the labels in
 * its per-action column headers and renders ONE action per column via
 * `only` (the cell is empty when the row's state hides the action).
 */
type CredentialActionKind = 'test' | 'pin' | 'rename' | 'copy' | 'clearSuspect' | 'limits' | 'toggle' | 'disconnect';

type CredentialActionsProps = {
  credential: CredentialHealth;
  caps: CredentialStoreCapabilities;
  pending: boolean;
  testing: boolean;
  canReveal: boolean;
  /** Zoom-table sizing (slightly larger hit area). */
  large?: boolean;
  /** Render only this action (zoom-table per-column mode); omit for the full cluster. */
  only?: CredentialActionKind;
  /** Borderless inline look for buttons embedded beside cell text (rename beside the name, copy beside the key). */
  ghost?: boolean;
  onStartRename: () => void;
  onPin: (a: CredentialHealth) => void;
  onTest: (a: CredentialHealth) => void;
  onCopyKey: (a: CredentialHealth) => void;
  onClearSuspect: (a: CredentialHealth) => void;
  onEditLimits: (a: CredentialHealth) => void;
  onToggleDisabled: (a: CredentialHealth) => void;
  onDisconnect: (a: CredentialHealth) => void;
};

const CredentialActions: React.FC<CredentialActionsProps> = ({
  credential,
  caps,
  pending,
  testing,
  canReveal,
  large = false,
  only,
  ghost = false,
  onStartRename,
  onPin,
  onTest,
  onCopyKey,
  onClearSuspect,
  onEditLimits,
  onToggleDisabled,
  onDisconnect,
}) => {
  const { t } = useI18n();
  const btn: React.CSSProperties = ghost
    ? { ...CRED_ICON_BTN_LG, border: 'none', background: 'transparent', color: 'var(--text-dim)', padding: '2px 4px' }
    : large
      ? CRED_ICON_BTN_LG
      : CRED_ICON_BTN;
  const icon = large ? 13 : 12;
  // Action availability is capability-first (Decision 1: branch on flags,
  // never on `kind`). Disabled affordances keep the blocked-tooltip pattern so
  // the reason is never a mystery.
  const actionTip = (supported: boolean, okLabel: string) =>
    supported ? okLabel : t('op.reasonCapabilityUnsupported');
  // Pin-to-top is a reorder: shown on every non-head row (a takedown row
  // keeps the button, disabled with its reason — an empty cell reads as a
  // missing affordance). The store must advertise the capability, else say so.
  const pinTip = !caps.reorder
    ? t('op.reasonCapabilityUnsupported')
    : credential.disabled
      ? t('op.credentialDisabledTip')
      : t('op.credentialPinTip');
  const want = (kind: CredentialActionKind) => only === undefined || only === kind;
  return (
    <>
      {/* Per-credential connectivity probe: pins the store row THIS line
          names — the card-level Test only ever hits the head credential. */}
      {want('test') && credential.routable && (
        <button
          className="btn btn-sm"
          style={btn}
          disabled={testing || pending}
          title={testing ? t('op.testing') : t('op.credentialTestTip')}
          aria-label={t('op.credentialTest')}
          onClick={() => onTest(credential)}
        >
          {testing ? (
            <RefreshCw size={icon} style={{ animation: 'ocr-spin 0.8s linear infinite' }} />
          ) : (
            <Zap size={icon} />
          )}
        </button>
      )}
      {want('pin') && !credential.active && (
        <button
          className="btn btn-sm"
          style={btn}
          disabled={!caps.reorder || credential.disabled || !credential.routable || pending}
          title={pinTip}
          aria-label={t('op.credentialPin')}
          onClick={() => onPin(credential)}
        >
          <ArrowUpToLine size={icon} />
        </button>
      )}
      {want('rename') && (
        <button
          className="btn btn-sm"
          style={btn}
          disabled={!caps.rename || pending}
          title={actionTip(caps.rename, t('op.credentialRename'))}
          aria-label={t('op.credentialRename')}
          onClick={onStartRename}
        >
          <Pencil size={icon} />
        </button>
      )}
      {/* Raw-key export for the row the operator can name. Only api-key rows
          have anything to reveal (oauth material never leaves any surface). */}
      {want('copy') && credential.type === 'api' && credential.routable && (
        <button
          className="btn btn-sm"
          style={btn}
          disabled={!canReveal || pending}
          title={canReveal ? t('op.credentialCopyKey') : t('op.credentialCopyNeedsAuthTip')}
          aria-label={t('op.credentialCopyKey')}
          onClick={() => onCopyKey(credential)}
        >
          <Copy size={icon} />
        </button>
      )}
      {want('clearSuspect') && credential.suspect && credential.keyHashPrefix && (
        <button
          className="btn btn-sm"
          style={btn}
          disabled={pending}
          title={t('op.credentialClearSuspect')}
          aria-label={t('op.credentialClearSuspect')}
          onClick={() => onClearSuspect(credential)}
        >
          <ShieldAlert size={icon} />
        </button>
      )}
      {/* Outbound rate-limit overlay — CONFIG-side governance: the caps live
          in OCR's own config.yaml, not in the credential store. Routable rows
          only: a credential that can never carry traffic has nothing to shape. */}
      {want('limits') && credential.keyHashPrefix && credential.routable && (
        <button
          className="btn btn-sm"
          style={btn}
          disabled={pending}
          title={t('op.credentialLimitsTip')}
          aria-label={t('op.credentialLimits')}
          onClick={() => onEditLimits(credential)}
        >
          <Gauge size={icon} />
        </button>
      )}
      {/* Takedown first, destruction last: this is the safe lever, and the
          two must never be confused for one another. */}
      {want('toggle') && (
        <button
          className="btn btn-sm"
          style={btn}
          disabled={pending}
          title={credential.disabled ? t('op.credentialEnableTip') : t('op.credentialDisableTip')}
          aria-label={credential.disabled ? t('op.credentialEnable') : t('op.credentialDisable')}
          onClick={() => onToggleDisabled(credential)}
        >
          {credential.disabled ? <Power size={icon} /> : <PowerOff size={icon} />}
        </button>
      )}
      {want('disconnect') && (
        <button
          className="btn btn-sm"
          style={{ ...btn, color: 'var(--accent-rose)' }}
          disabled={pending}
          title={t('op.credentialDisconnect')}
          aria-label={t('op.credentialDisconnect')}
          onClick={() => onDisconnect(credential)}
        >
          <Unplug size={icon} />
        </button>
      )}
    </>
  );
};


/** One credential of a multi-credential provider — the drill-down row. */
const CredentialRow: React.FC<CredentialRowProps> = ({
  credential,
  caps,
  soleServing,
  prefixVisible,
  pending,
  testing,
  renaming,
  onStartRename,
  onCancelRename,
  now,
  onPin,
  onRename,
  onTest,
  onDisconnect,
  onToggleDisabled,
  onClearSuspect,
  canReveal,
  onCopyKey,
  onEditLimits,
  position,
}) => {
  const { t } = useI18n();
  const [labelDraft, setLabelDraft] = useState('');
  const remaining = credential.cooldownUntilMs !== undefined ? credential.cooldownUntilMs - now : 0;
  const name = credentialName(credential, t('op.credentialUnnamed'));

  return (
    <div
      className="list-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '7px 10px',
        // The scroll container is a flex column: without this the rows SHRINK
        // to fit the cap instead of overflowing and scrolling.
        flexShrink: 0,
        // Chain order rides the #1 slot number — no extra bar/border
        // (redundant encoding was the box-in-box complaint).
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      {renaming ? (
        <>
          <input
            className="input"
            style={{ fontSize: 12, flex: 1, minWidth: 110 }}
            aria-label={t('op.credentialLabelPlaceholder')}
            placeholder={t('op.credentialLabelPlaceholder')}
            maxLength={80}
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter with an empty draft is the CLEAR gesture, not a no-op.
              if (e.key === 'Enter') onRename(credential, labelDraft.trim());
              if (e.key === 'Escape') onCancelRename();
            }}
            autoFocus
          />
          <button
            className="btn btn-sm btn-primary"
            style={CRED_ICON_BTN}
            disabled={pending || labelDraft.trim() === (credential.label?.trim() ?? '')}
            title={labelDraft.trim() ? t('op.credentialRename') : t('op.credentialClearLabel')}
            onClick={() => onRename(credential, labelDraft.trim())}
          >
            <Check size={12} />
          </button>
          <button className="btn btn-sm" style={CRED_ICON_BTN} onClick={onCancelRename}>
            ✕
          </button>
        </>
      ) : (
        <>
          {/* Slot number = chain order (head = #1). The order itself changes
              only via the pin action (a multi-credential provider spreads NEW
              sessions across every healthy row — Decision 7 — so position is
              priority, not exclusivity). Uniform color: order metadata only,
              no row gets a special tint. */}
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              fontSize: 10,
              fontWeight: 600,
              minWidth: 12,
              color: 'var(--text-dim)',
              fontVariantNumeric: 'tabular-nums',
            }}
            title={t('op.credentialChainHeadTip')}
          >
            #{position}
          </span>
          <span
            style={{ fontWeight: 700, fontSize: 12, flex: '0 1 auto', minWidth: 48, overflow: 'hidden', textOverflow: 'ellipsis' }}
            title={name}
          >
            {name}
          </span>
          {/* The fingerprint is a CORRELATION id (breaker state, SUSPECT flags,
              the Guardrails per-credential trip and the logs all key on it), not
              something to read. So it lives in the masked key's tooltip, and the
              chip only appears when two rows of this provider mask to the same
              text — the one case where a row is otherwise ambiguous. */}
          {prefixVisible && <PrefixChip credential={credential} />}
          {credential.maskedKey && (
            <span
              style={{
                fontSize: 11,
                fontFamily: FONT_MONO,
                color: 'var(--text-dim)',
                // Shrinkable so a narrow card clips the KEY, never the buttons
                // (the action group holds flexShrink:0 and must stay reachable).
                flex: '0 1 auto',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={credential.keyHashPrefix ? t('op.credentialPrefixTip', { prefix: credential.keyHashPrefix, id: credential.id }) : undefined}
            >
              {credential.maskedKey}
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <CredentialStatusBadges credential={credential} remaining={remaining} />
            <CredentialActions
              credential={credential}
              caps={caps}
              pending={pending}
              testing={testing}
              canReveal={canReveal}
              onStartRename={() => {
                setLabelDraft(credential.label ?? '');
                onStartRename();
              }}
              onPin={onPin}
              onTest={onTest}
              onCopyKey={onCopyKey}
              onClearSuspect={onClearSuspect}
              onEditLimits={onEditLimits}
              onToggleDisabled={onToggleDisabled}
              onDisconnect={onDisconnect}
            />
          </span>
        </>
      )}
    </div>
  );
};

const ZOOM_TH: React.CSSProperties = {
  textAlign: 'left',
  fontSize: 11.5,
  fontWeight: 700,
  color: 'var(--text-dim)',
  padding: '5px 10px',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};
/** Action column headers: centered, wrapping so each column is as wide as its button. */
const ZOOM_TH_ACT: React.CSSProperties = { ...ZOOM_TH, textAlign: 'center', padding: '4px 2px', whiteSpace: 'normal' };
const ZOOM_TD: React.CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'middle',
  whiteSpace: 'nowrap',
};

type CredentialZoomRowProps = Omit<CredentialRowProps, 'now'> & { now: number };

/** One credential of the zoom dialog — a table row: the labels live in the
 *  column headers, the actions stay icon-only. Same shared badge/action
 *  components as the card row, so availability logic cannot drift. */
const CredentialZoomRow: React.FC<CredentialZoomRowProps> = ({
  credential,
  caps,
  soleServing,
  prefixVisible,
  pending,
  testing,
  renaming,
  onStartRename,
  onCancelRename,
  now,
  onPin,
  onRename,
  onTest,
  onDisconnect,
  onToggleDisabled,
  onClearSuspect,
  canReveal,
  onCopyKey,
  onEditLimits,
  position,
}) => {
  const { t } = useI18n();
  const [labelDraft, setLabelDraft] = useState('');
  const remaining = credential.cooldownUntilMs !== undefined ? credential.cooldownUntilMs - now : 0;
  const name = credentialName(credential, t('op.credentialUnnamed'));
  const startRename = () => {
    setLabelDraft(credential.label ?? '');
    onStartRename();
  };
  // One shared helper renders every per-column action — the pin/test/limits/
  // toggle/disconnect columns and the ghost copy/clear-suspect embeds all use
  // the same availability logic.
  const action = (kind: 'test' | 'pin' | 'copy' | 'clearSuspect' | 'limits' | 'toggle' | 'disconnect') => (
    <CredentialActions
      large
      only={kind}
      credential={credential}
      caps={caps}
      pending={pending}
      testing={testing}
      canReveal={canReveal}
      onStartRename={startRename}
      onPin={onPin}
      onTest={onTest}
      onCopyKey={onCopyKey}
      onClearSuspect={onClearSuspect}
      onEditLimits={onEditLimits}
      onToggleDisabled={onToggleDisabled}
      onDisconnect={onDisconnect}
    />
  );
  return (
    <tr>
      {/* Chain order column: plain slot number — head = #1, no star (the pin
          action in the action columns is how the order changes). */}
      <td style={{ ...ZOOM_TD, textAlign: 'center', color: 'var(--text-dim)', fontWeight: 600, fontSize: 12 }}>
        #{position}
      </td>
      <td style={{ ...ZOOM_TD, fontWeight: 700, fontSize: 13.5, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }} title={name}>
        {renaming ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input
              className="input"
              style={{ fontSize: 13, width: 180 }}
              aria-label={t('op.credentialLabelPlaceholder')}
              placeholder={t('op.credentialLabelPlaceholder')}
              maxLength={80}
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter with an empty draft is the CLEAR gesture, not a no-op.
                if (e.key === 'Enter') onRename(credential, labelDraft.trim());
                if (e.key === 'Escape') onCancelRename();
              }}
              autoFocus
            />
            <button
              className="btn btn-sm btn-primary"
              style={CRED_ICON_BTN_LG}
              disabled={pending || labelDraft.trim() === (credential.label?.trim() ?? '')}
              title={labelDraft.trim() ? t('op.credentialRename') : t('op.credentialClearLabel')}
              onClick={() => onRename(credential, labelDraft.trim())}
            >
              <Check size={13} />
            </button>
            <button className="btn btn-sm" style={CRED_ICON_BTN_LG} title={t('common.cancel')} aria-label={t('common.cancel')} onClick={onCancelRename}>
              ✕
            </button>
          </span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
            {prefixVisible && <PrefixChip credential={credential} />}
            {/* Rename lives beside the name it edits, not in its own column. */}
            <CredentialActions
              large
              ghost
              only="rename"
              credential={credential}
              caps={caps}
              pending={pending}
              testing={testing}
              canReveal={canReveal}
              onStartRename={startRename}
              onPin={onPin}
              onTest={onTest}
              onCopyKey={onCopyKey}
              onClearSuspect={onClearSuspect}
              onEditLimits={onEditLimits}
              onToggleDisabled={onToggleDisabled}
              onDisconnect={onDisconnect}
            />
          </span>
        )}
      </td>
      <td style={{ ...ZOOM_TD, fontSize: 12.5, fontFamily: FONT_MONO, color: 'var(--text-dim)', maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {credential.maskedKey && (
            <span
              title={credential.keyHashPrefix ? t('op.credentialPrefixTip', { prefix: credential.keyHashPrefix, id: credential.id }) : undefined}
            >
              {credential.maskedKey}
            </span>
          )}
          {/* Copy sits beside the key it copies. */}
          <CredentialActions large ghost only="copy" credential={credential} caps={caps} pending={pending} testing={testing} canReveal={canReveal} onStartRename={startRename} onPin={onPin} onTest={onTest} onCopyKey={onCopyKey} onClearSuspect={onClearSuspect} onEditLimits={onEditLimits} onToggleDisabled={onToggleDisabled} onDisconnect={onDisconnect} />
        </span>
      </td>
      <td style={{ ...ZOOM_TD, textAlign: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
          <CredentialStatusBadges credential={credential} remaining={remaining} />
          {/* Suspect-clear is a per-row conditional (suspect rows only), so it
              rides the status cell instead of an always-empty column. */}
          {action('clearSuspect')}
          {/* Explicit "normal" word: an empty cell reads as broken data. */}
          {!credential.disabled && !credential.suspect && remaining <= 0 && (credential.limits ?? []).length === 0 && !credential.quota && (
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{t('op.credentialZoomStatusNormal')}</span>
          )}
        </span>
      </td>
      {/* One action per column — the header above IS the label. Compact cells:
          the button sets the column's width, nothing more. */}
      {(['pin', 'test', 'limits', 'toggle', 'disconnect'] as const).map((kind) => (
        <td key={kind} style={{ ...ZOOM_TD, padding: '8px 2px', textAlign: 'center' }}>
          {action(kind)}
        </td>
      ))}
    </tr>
  );
};

type RevealDialogProps = {
  credential: CredentialHealth;
  password: string;
  error: string;
  busy: boolean;
  onPassword: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * Reveal password gate. The raw key is NEVER rendered or held
 * here — the confirm handler passes the response straight to the clipboard.
 * The input draft is cleared by the caller on close (the page-lifetime unlock
 * keeps the verified password in a ref, out of the DOM).
 */
const RevealKeyDialog: React.FC<RevealDialogProps> = ({
  credential,
  password,
  error,
  busy,
  onPassword,
  onCancel,
  onConfirm,
}) => {
  const { t } = useI18n();
  const name = credentialName(credential, t('op.credentialUnnamed'));
  return (
    <Dialog
      title={t('op.copyKeyTitle', { label: name })}
      subtitle={t('op.copyKeyDesc')}
      onClose={onCancel}
      closeLabel={t('common.cancel')}
      width={400}
      footerRight={
        <>
          <button className="btn btn-sm" onClick={onCancel}>
            <span>{t('common.cancel')}</span>
          </button>
          <button className="btn btn-sm btn-primary" disabled={busy || !password} onClick={onConfirm}>
            <Copy size={12} />
            <span>{busy ? t('op.copyKeyCopying') : t('op.copyKeyConfirm')}</span>
          </button>
        </>
      }
    >
      <input
        className="input secret-mask"
        // Re-auth gate. type="password" is unusable here: Chrome treats it
        // (even with "new-password") as a registration field and pops the
        // credential dropdown on focus — offering to fill the saved login
        // (silently satisfying the gate) or to GENERATE a strong password
        // (a random value that fails verification and may overwrite the
        // saved credential). No autocomplete value suppresses that dropdown;
        // the only reliable lever is not being a password field at all
        // (masking via .secret-mask in styles/index.css).
        type="text"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        style={{ fontSize: 12, width: '100%', marginBottom: 8 }}
        placeholder={t('op.copyKeyPassword')}
        value={password}
        onChange={(e) => onPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onConfirm();
          if (e.key === 'Escape') onCancel();
        }}
      />
      {error && <div style={{ fontSize: 11, color: 'var(--accent-rose)' }}>{error}</div>}
    </Dialog>
  );
};

/**
 * Outbound rate-limit overlay editor for ONE credential. Caps shape traffic
 * toward the provider (outbound); the window list is the live sliding-ledger
 * view, so what the operator arms is immediately verifiable.
 */
const CredentialLimitsDialog: React.FC<{
  providerId: string;
  credential: CredentialHealth;
  drafts: LimitDraft[];
  windows: RateLimitSnapshotEntry[];
  busy: boolean;
  onChangeDrafts: (next: LimitDraft[]) => void;
  onCancel: () => void;
  onSave: () => void;
}> = ({ providerId, credential, drafts, windows, busy, onChangeDrafts, onCancel, onSave }) => {
  const { t } = useI18n();
  const name = credentialName(credential, t('op.credentialUnnamed'));
  return (
    <Dialog
      title={t('op.credentialLimitsTitle', { label: name })}
      subtitle={t('op.credentialLimitsDesc', { provider: providerId })}
      onClose={onCancel}
      closeLabel={t('common.cancel')}
      width={460}
      footerRight={
        <>
          <button className="btn btn-sm" onClick={onCancel}>
            <span>{t('common.cancel')}</span>
          </button>
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={onSave}>
            <Check size={12} />
            <span>{t('common.confirm')}</span>
          </button>
        </>
      }
    >
      <LimitsEditor value={drafts} onChange={onChangeDrafts} />

        {windows.length > 0 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', marginBottom: 6 }}>
              {t('op.credentialLimitsWindows')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {windows.map((w) => (
                <div
                  key={w.rule}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 10,
                    fontSize: 11.5,
                    fontFamily: FONT_MONO,
                    color: w.retryAfterMs > 0 ? 'var(--accent-amber)' : 'var(--text-dim)',
                  }}
                >
                  <span>{w.rule}</span>
                  <span>
                    {w.used} / {w.limit}
                    {w.retryAfterMs > 0 ? ` · ${t('op.credentialLimitsRetryIn', { s: Math.ceil(w.retryAfterMs / 1000) })}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
    </Dialog>
  );
};


export const KeysPage: React.FC = () => {
  const { t } = useI18n();
  const confirmDialog = useConfirm();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [ocProviders, setOcProviders] = useState<OpenCodeProviderView[]>([]);
  const [ocPaths, setOcPaths] = useState<{ configPath: string }>({ configPath: '' });
  const [storeStatus, setStoreStatus] = useState<CredentialStoreStatus | null>(null);
  const [catalog, setCatalog] = useState<OpenCodeCatalogProvider[]>([]);
  const [catalogSource, setCatalogSource] = useState('');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectKey, setConnectKey] = useState('');
  const [keyEditId, setKeyEditId] = useState<string | null>(null);
  const [keyEditValue, setKeyEditValue] = useState('');
  const [modelsPanelId, setModelsPanelId] = useState<string | null>(null);
  const { testingIds, testResults, testAll, testOne, testAllTargets } = useModelTest();
  const [notice, setNotice] = useState('');
  const [noticeTone, setNoticeTone] = useState<'ok' | 'err'>('ok');
  const [ocError, setOcError] = useState('');
  const [busy, setBusy] = useState(false);

  // Controlled key reveal. The gate is a re-entry of
  // the console LOGIN password (a secret the browser does not keep after
  // login), so the flow only exists while webAuth is active; the session
  // probe is the same one App's boot gate uses.
  const [webAuthActive, setWebAuthActive] = useState(false);
  const [revealTarget, setRevealTarget] = useState<CredentialHealth | null>(null);
  const [revealPassword, setRevealPassword] = useState('');
  const [revealError, setRevealError] = useState('');
  const [revealBusy, setRevealBusy] = useState(false);
  /**
   * Page-lifetime unlock (operator-accepted relaxation):
   * after ONE deliberate dialog entry the verified password lives in this REF
   * — memory only, never storage, never rendered, gone on reload — and later
   * copies are one click. A 401 (or reload) takes the unlock away.
   */
  const revealPassRef = useRef('');

  // Outbound rate-limit overlay editor (config `credentials:`): the dialog is
  // page-owned like the reveal gate — the row only names its target.
  const [limitsTarget, setLimitsTarget] = useState<{ providerId: string; credential: CredentialHealth } | null>(null);
  const [limitsDraft, setLimitsDraft] = useState<LimitDraft[]>([]);
  const [limitsWindows, setLimitsWindows] = useState<RateLimitSnapshotEntry[]>([]);
  const [limitsBusy, setLimitsBusy] = useState(false);

  // Custom provider create form
  const [form, setForm] = useState<{ id: string; name: string; baseURL: string; npm: string; apiKey: string; inline: boolean; pullPattern: string; headerRows: HeaderRow[] }>({ id: '', name: '', baseURL: '', npm: '', apiKey: '', inline: false, pullPattern: '', headerRows: [] });
  const [npmChoice, setNpmChoice] = useState<string>('');
  /** Provider-def edit dialog (connected card pencil): def-node providers only. */
  const [editDef, setEditDef] = useState<{ id: string; name: string; baseURL: string; npm: string; pullPattern: string; headerRows: HeaderRow[] } | null>(null);
  const [savingDef, setSavingDef] = useState(false);
  // Backdrop closes only on a press+release that both land on the overlay
  // (shared guard: useBackdropDismiss).
  const defBackdrop = useBackdropDismiss(() => { if (!savingDef) setEditDef(null); });
  const openDefEdit = (p: OpenCodeProviderView) =>
    setEditDef({
      id: p.id,
      name: p.name ?? '',
      baseURL: p.baseURL ?? '',
      npm: displayNpm(p.npm) ?? '',
      pullPattern: p.autoPullPattern ?? '',
      headerRows: headersToRows(p.headers),
    });
  const saveDefEdit = async () => {
    if (!editDef) return;
    setSavingDef(true);
    try {
      await opencodeApi.updateProvider(editDef.id, {
        name: editDef.name.trim() || undefined,
        baseURL: editDef.baseURL.trim() || undefined,
        npm: editDef.npm.trim() || undefined,
        // Always sent: an emptied editor CLEARS the def's headers (the
        // backend contract is presence = full replace).
        headers: rowsToHeaders(editDef.headerRows) ?? {},
        // Same presence contract: blank clears the auto-pull whitelist entry.
        pullPattern: editDef.pullPattern.trim(),
      });
      showNotice(t('op.saveDefDone'));
      setEditDef(null);
      await refreshAll();
    } catch (err: any) {
      toast.error(reasonError(err));
    } finally {
      setSavingDef(false);
    }
  };
  const [activeTab, setActiveTab] = useState<'connected' | 'catalog' | 'custom' | 'sync'>('connected');
  // Default OFF (show connected providers): a connected provider is exactly where
  // a SECOND credential is added, so hiding connected rows made multi-credential
  // unreachable from this tab. Hiding is opt-in for "only show what's new".
  // Default ON: the catalog tab is pure-connect — hide rows already connected
  // (their credential management lives in the Connected tab). The toggle stays
  // available to reveal them as read-only badges.
  const [hideConnected, setHideConnected] = useState(true);
  const [connectedQuery, setConnectedQuery] = useState('');
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogPageSize, setCatalogPageSize] = useState(CATALOG_PAGE_SIZE);
  const [connectedPage, setConnectedPage] = useState(1);
  const [connectedPageSize, setConnectedPageSize] = useState(CONNECTED_PAGE_SIZE);
  const [refreshingConnected, setRefreshingConnected] = useState(false);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  // The backend-owned npm SDK vocabulary (providers/vocabulary.ts) — dropdown
  // order AND the v2-package → v1-alias display mapping come from here, so the
  // gateway's wire truth and the UI never drift apart.
  const [npmVocabulary, setNpmVocabulary] = useState<NpmVocabularyEntry[]>([]);
  useEffect(() => {
    opencodeApi.getNpmVocabulary().then(setNpmVocabulary).catch(() => {
      /* fail-open: the form falls back to the curated list below */
    });
  }, []);

  /** v2 `package` / v1 alias → the display alias (vocabulary-driven). */
  const displayNpm = useCallback((npm?: string): string | undefined => {
    if (!npm) return undefined;
    const hit = npmVocabulary.find((e) => e.package === npm || e.alias === npm);
    return hit ? hit.alias : npm;
  }, [npmVocabulary]);

  // npm dropdown options: the vocabulary's ordered aliases ARE the list — the
  // wire truth is backend data, not a frontend copy. models.dev catalog
  // packages that the vocabulary does not know ride through after it (they
  // resolve through wireFor's openai default anyway).
  const npmOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of catalog) {
      if (!c.npm) continue;
      counts.set(c.npm, (counts.get(c.npm) || 0) + 1);
    }
    const fromCatalog = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([pkg]) => pkg);
    const known = npmVocabulary.length > 0 ? npmVocabulary.map((e) => e.alias) : FALLBACK_NPM_PACKAGES;
    const extra = fromCatalog.filter((p) => !known.includes(p));
    return [...known, ...extra];
  }, [catalog, npmVocabulary]);

  const connectedIds = useMemo(() => new Set(ocProviders.map((p) => p.id)), [ocProviders]);

  // Decision 1: whether a submitted key ADDS an credential or OVERWRITES the only
  // one is a capability of the bound store, never a name-check on `kind` — the
  // ocr landing gets append semantics for free, a future single-credential store
  // would get overwrite without the UI changing.
  const multiCredentialStore = !!storeStatus?.capabilities.multiCredential;
  /**
   * The file the BOUND store actually addresses — the truth behind every "stored
   * in X" claim on this page. opencode v2 keeps credentials in `opencode.db`, an
   * OCR-only install in `credentials.json`; only opencode v1 uses `auth.json`, so
   * hardcoding that filename mislabeled the credential source on 2 of 3 bindings.
   * Basename only (the full path stays in the store badge's tooltip), and the
   * neutral word when the status endpoint failed — never a guessed filename.
   */
  const sinkLabel = useMemo(() => {
    const file = storeStatus?.credentialFile;
    const base = file ? file.split(/[\\/]/).pop() : '';
    return base || t('op.credentialStoreNeutral');
  }, [storeStatus, t]);
  /**
   * Credential writes on an integration-scoped sink (opencode v2) address a
   * REGISTERED integration. A provider whose integration was retired upstream
   * keeps routing its existing key but refuses every write — and that is exactly
   * the confusing case, because the card looks healthy. Gate the affordance on
   * the same registry the write consults. Absent list = unknown (the registry was
   * unreachable): change NOTHING, let the write answer with its honest 409.
   * Match is case-insensitive, mirroring resolveIntegrationId() on the backend.
   */
  const integrationIds = useMemo(
    () => (storeStatus?.integrations ? new Set(storeStatus.integrations.map((i) => i.toLowerCase())) : null),
    [storeStatus]
  );
  const canWriteCredential = (providerId: string): boolean =>
    integrationIds === null || integrationIds.has(providerId.toLowerCase());
  // ---- per-credential drill-down ----------------------------------------------------
  // The masked detail lives inside storeStatus (GET credential-store carries
  // it) so a write route's refreshed `credentials` array can patch it in place —
  // one source of truth, no second fetch.
  const credentialsByProvider = useMemo(() => {
    const map = new Map<string, CredentialHealth[]>();
    for (const a of storeStatus?.credentials ?? []) if (a.credentials && a.credentials.length > 0) map.set(a.providerId, a.credentials);
    return map;
  }, [storeStatus]);
  const maxCooldownUntil = useMemo(() => {
    let until = 0;
    for (const list of credentialsByProvider.values()) for (const a of list) until = Math.max(until, a.cooldownUntilMs ?? 0);
    return until;
  }, [credentialsByProvider]);
  const now = useCountdownClock(maxCooldownUntil);
  const [pendingCredential, setPendingCredential] = useState<string | null>(null);
  // `${providerId}:${credentialId}` of the row in label-edit mode (page-owned so it
  // closes only when the rename write succeeds).
  const [renameKey, setRenameKey] = useState<string | null>(null);
  // Provider whose credential list is open in the zoom dialog (page-scoped:
  // the dialog shares the card rows' handler wiring).
  const [zoomProviderId, setZoomProviderId] = useState<string | null>(null);

  const applyCredentialList = (providerId: string, credentials: CredentialHealth[]) =>
    setStoreStatus((prev) =>
      prev
        ? {
            ...prev,
            credentials: prev.credentials.map((a) =>
              a.providerId !== providerId
                ? a
                : {
                    ...a,
                    credentials,
                    // The overview counters are derivable from the detail list —
                    // patch them too so a disconnect never leaves a stale total.
                    total: credentials.length,
                    routable: credentials.filter((x) => x.routable).length,
                    activeCredentialId: credentials.find((x) => x.active)?.id ?? null,
                  }
            ),
          }
        : prev
    );

  /**
   * Gap #8 tail: known machine codes localize, unknown codes stay raw + loud.
   * The `as` only guides the table lookup — the code string itself arrives
   * untrusted from the HTTP body, and an unknown code never gets a guess.
   */
  const reasonError = (err: any): string => {    const code: string | undefined = err?.reasonCode;
    const key = code
      ? WRITE_REASON_LABEL[code as CredentialWriteReasonCode]
        ?? SYNC_PRECONDITION_LABEL[code as SyncPreconditionCode]
        ?? REVEAL_REASON_LABEL[code as CredentialRevealReasonCode]
      : undefined;
    if (key) return t(key);
    const message = err?.message ?? 'unknown error';
    return code ? t('op.reasonGenericCode', { code, message }) : t('op.reasonGeneric', { message });
  };

  const handleCredentialPin = async (a: CredentialHealth) => {
    setPendingCredential(`${a.providerId}:${a.id}`);
    try {
      // Reorder is a full permutation: move the pinned row to the head and
      // keep the remaining order stable.
      const list = credentialsByProvider.get(a.providerId) ?? [a];
      const orderedIds = [a.id, ...list.filter((c) => c.id !== a.id).map((c) => c.id)];
      const res = await opencodeApi.reorderProviderCredentials(a.providerId, orderedIds);
      applyCredentialList(a.providerId, res.credentials);
      toast.success(t('op.credentialPinned', { label: credentialName(a, t('op.credentialUnnamed')) }));
      // The card's own masked key mirrors the chain head — keep it honest.
      await loadOpenCodeProviders();
    } catch (err: any) {
      toast.error(reasonError(err));
    } finally {
      setPendingCredential(null);
    }
  };

  /**
   * Operator takedown toggle. Reversible and non-destructive (the key stays in
   * the store), so no confirmation gate — unlike disconnect, which deletes the
   * only copy and must double-confirm (Decision 8).
   */
  const handleCredentialToggleDisabled = async (a: CredentialHealth) => {
    setPendingCredential(`${a.providerId}:${a.id}`);
    try {
      const res = a.disabled
        ? await opencodeApi.enableProviderCredential(a.providerId, a.id)
        : await opencodeApi.disableProviderCredential(a.providerId, a.id);
      applyCredentialList(a.providerId, res.credentials);
      if (a.disabled) {
        toast.success(t('op.credentialEnabled', { label: credentialName(a, t('op.credentialUnnamed')) }));
      } else {
        toast.info(t('op.credentialDisabledOk', { label: credentialName(a, t('op.credentialUnnamed')) }));
      }
    } catch (err: any) {
      toast.error(reasonError(err));
    } finally {
      setPendingCredential(null);
    }
  };

  /** Empty `label` is the CLEAR gesture (backend: '' is a valid label value). */
  const handleCredentialRename = async (a: CredentialHealth, label: string) => {
    setPendingCredential(`${a.providerId}:${a.id}`);
    try {
      const res = await opencodeApi.renameProviderCredential(a.providerId, a.id, label);
      applyCredentialList(a.providerId, res.credentials);
      setRenameKey(null);
      toast.success(label ? t('op.credentialRenamed', { label }) : t('op.credentialLabelCleared'));
    } catch (err: any) {
      toast.error(reasonError(err));
    } finally {
      setPendingCredential(null);
    }
  };

  const handleCredentialDisconnect = async (a: CredentialHealth) => {
    const name = credentialName(a, t('op.credentialUnnamed'));
    const ok = await confirmDialog({
      title: t('op.credentialDisconnectConfirm', { label: name }),
      description: t('op.credentialDisconnectPurge'),
      danger: true,
      confirmLabel: t('common.delete'),
    });
    if (!ok) return;
    setPendingCredential(`${a.providerId}:${a.id}`);
    try {
      const res = await opencodeApi.disconnectProviderCredential(a.providerId, a.id);
      applyCredentialList(a.providerId, res.credentials);
      // A delete is a REVOCATION: report the client half honestly instead of a
      // blanket "disconnected" (the OCR row being gone says nothing about the
      // copy opencode routes from).
      const revoke = res.clientRevoke;
      if (revoke?.result === 'deleted') {
        toast.success(t('op.credentialRevokedEverywhere', { label: name, client: revoke.clientId }));
      } else if (revoke?.result === 'failed') {
        toast.info(t('op.credentialRevokeClientFailed', { label: name, reason: revoke.detail ?? t('op.syncGenericFailure') }));
      } else if (revoke) {
        toast.info(t('op.credentialRevokeClientSkipped', { label: name, reason: revoke.result }));
      } else {
        toast.success(t('op.credentialDisconnected', { label: name }));
      }
      // The credential set behind the card changed; the provider view must follow.
      await loadOpenCodeProviders();
    } catch (err: any) {
      toast.error(reasonError(err));
    } finally {
      setPendingCredential(null);
    }
  };

  /**
   * Decision 6 explicit admin door. The suspect flag lives in OCR's own state
   * file, not in the credential store.
   */
  const handleCredentialClearSuspect = async (a: CredentialHealth) => {
    if (!a.keyHashPrefix) return;
    setPendingCredential(`${a.providerId}:${a.id}`);
    try {
      const res = await api.clearSuspectCredential(a.providerId, a.keyHashPrefix);
      toast.info(res.cleared ? t('op.credentialSuspectCleared', { label: credentialName(a, t('op.credentialUnnamed')) }) : t('op.credentialSuspectNone', { label: credentialName(a, t('op.credentialUnnamed')) }));
      await loadCredentialStore();
    } catch (err: any) {
      toast.error(reasonError(err));
    } finally {
      setPendingCredential(null);
    }
  };

  /** Open the overlay editor for one credential: seed the draft from the row's
   *  armed rules and pull the live windows so usage shows up immediately. */
  const openLimitsDialog = async (providerId: string, a: CredentialHealth) => {
    if (!a.keyHashPrefix) return;
    setLimitsTarget({ providerId, credential: a });
    setLimitsDraft((a.limits ?? []).map(draftFromRule));
    setLimitsBusy(true);
    try {
      const snap = await api.getRateLimitWindows();
      const subject = `credential:${providerId}:${a.keyHashPrefix}`;
      setLimitsWindows(snap.windows.filter((w) => w.subject === subject));
    } catch (err) {
      console.warn('[ratelimit] live window snapshot fetch failed', err);
      setLimitsWindows([]);
    } finally {
      setLimitsBusy(false);
    }
  };

  /** Upsert the entry (empty compile result = null = remove it). saveConfig
   *  hot-reloads the limiter, so a successful write is already in effect. */
  const handleSaveCredentialLimits = async () => {
    if (!limitsTarget?.credential.keyHashPrefix) return;
    const compiled = compileLimitDrafts(limitsDraft, t);
    if (compiled.error) {
      toast.error(compiled.error);
      return;
    }
    setLimitsBusy(true);
    try {
      const res = await api.setCredentialLimits({
        provider: limitsTarget.providerId,
        keyHashPrefix: limitsTarget.credential.keyHashPrefix,
        limits: compiled.rules ?? null,
      });
      if (!res.success) {
        toast.error(typeof res.error === 'string' && res.error ? res.error : t('common.saveFailed'));
        return;
      }
      toast.success(compiled.rules?.length ? t('op.credentialLimitsSaved') : t('op.credentialLimitsCleared'));
      setLimitsTarget(null);
      await loadCredentialStore(); // the caps ride the withCredentialHealth overlay — refresh rows
    } catch (err: any) {
      toast.error(reasonError(err));
    } finally {
      setLimitsBusy(false);
    }
  };

  /**
   * Password dialog — the LOCKED arm of the copy gesture (see
   * `handleCredentialCopyKey`). The key never transits this page's state: every
   * response passes straight into the clipboard and is forgotten.
   */
  const openRevealDialog = (a: CredentialHealth) => {
    setRevealTarget(a);
    setRevealPassword('');
    setRevealError('');
  };

  /**
   * Copy gesture: with the page unlocked (a verified password in `revealPassRef`)
   * this is a silent one-click reveal; otherwise it opens the password dialog and
   * the confirm handler installs the unlock. This is the row's `onCopyKey`.
   */
  const handleCredentialCopyKey = async (a: CredentialHealth) => {
    if (!revealPassRef.current) {
      openRevealDialog(a);
      return;
    }
    setPendingCredential(`${a.providerId}:${a.id}`);
    try {
      const res = await opencodeApi.revealProviderKey(a.providerId, a.id, revealPassRef.current);
      await copyToClipboard(res.key);
      toast.success(t('op.credentialKeyCopied'));
    } catch (err: any) {
      if (err?.reasonCode === 'invalid_password') {
        // The held password stopped being true (changed upstream, or the
        // bucket was hot) — take the unlock away and fall back to the dialog.
        revealPassRef.current = '';
        openRevealDialog(a);
      } else {
        toast.error(reasonError(err));
      }
    } finally {
      setPendingCredential(null);
    }
  };

  const handleRevealConfirm = async () => {
    if (!revealTarget || !revealPassword) return;
    setRevealBusy(true);
    try {
      const res = await opencodeApi.revealProviderKey(revealTarget.providerId, revealTarget.id, revealPassword);
      await copyToClipboard(res.key);
      revealPassRef.current = revealPassword;
      setRevealTarget(null);
      setRevealPassword('');
      toast.success(t('op.credentialKeyCopiedUnlocked'));
    } catch (err: any) {
      setRevealError(reasonError(err));
    } finally {
      setRevealBusy(false);
    }
  };

  const connectedResults = useMemo(() => {
    const q = connectedQuery.trim().toLowerCase();
    if (!q) return ocProviders;
    return ocProviders.filter(
      (p) =>
        p.id.toLowerCase().includes(q) ||
        (p.name || '').toLowerCase().includes(q) ||
        (p.baseURL || '').toLowerCase().includes(q) ||
        p.models.some((m) => m.toLowerCase().includes(q))
    );
  }, [ocProviders, connectedQuery]);
  const pagedConnected = useMemo(() => {
    const start = (connectedPage - 1) * connectedPageSize;
    return connectedResults.slice(start, start + connectedPageSize);
  }, [connectedResults, connectedPage, connectedPageSize]);

  const catalogResults = useMemo(() => {
    const q = catalogQuery.trim().toLowerCase();
    let list = q
      ? catalog.filter((c) => (c.id || '').toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q))
      : catalog;
    if (hideConnected) list = list.filter((c) => !connectedIds.has(c.id));
    return list;
  }, [catalog, catalogQuery, hideConnected, connectedIds]);

  const pagedCatalog = catalogResults.slice(
    (catalogPage - 1) * catalogPageSize,
    catalogPage * catalogPageSize
  );

  const tabBtn = (tab: typeof activeTab, label: string, count?: number): React.CSSProperties => ({
    padding: '7px 14px',
    borderRadius: '8px',
    fontSize: '12.5px',
    fontWeight: activeTab === tab ? 700 : 500,
    color: activeTab === tab ? 'var(--accent)' : 'var(--text-muted)',
    background: activeTab === tab ? 'var(--surface-hover)' : 'transparent',
    border: activeTab === tab ? '1px solid var(--card-border)' : '1px solid transparent',
    cursor: 'pointer',
  });

  const loadOpenCodeProviders = async (): Promise<boolean> => {
    try {
      const res = await opencodeApi.listProviders();
      setOcProviders(res.providers);
      setOcPaths({ configPath: res.configPath });
      setOcError('');
      return true;
    } catch (err: any) {
      setOcError(err.message);
      return false;
    }
  };

  // Badge source. Quiet on failure: an unreachable status endpoint
  // must not fake-red the page — the badge simply stays absent. The resolved
  // status (or null) is also RETURNED so the delete flow can re-arbitrate the
  // Decision 8 confirm without waiting for the state round-trip.
  const loadCredentialStore = async (): Promise<CredentialStoreStatus | null> => {
    try {
      const res = await opencodeApi.getCredentialStore();
      setStoreStatus(res.store);
      return res.store;
    } catch {
      setStoreStatus(null);
      return null;
    }
  };

  // ---- credential sync (client ⇄ OCR file) ---------------------------------
  const [syncClients, setSyncClients] = useState<CredentialSyncClientView[]>([]);
  // `${clientId}:${direction}` of the in-flight manual run — one direction at a
  // time per client; both of the client's buttons disable while it runs.
  const [syncBusyKey, setSyncBusyKey] = useState<string | null>(null);

  const loadCredentialSync = async (): Promise<void> => {
    try {
      const res = await opencodeApi.getCredentialSync();
      setSyncClients(res.clients || []);
    } catch {
      // unreachable status endpoint must not fake-red the tab — it stays empty
    }
  };

  const handleSyncToggle = async (clientId: string, direction: 'read' | 'write', enabled: boolean) => {
    // Optimistic patch; the persisted echo (or a reload on failure) wins.
    setSyncClients((prev) =>
      prev.map((c) => (c.id === clientId ? { ...c, [direction === 'read' ? 'autoRead' : 'autoWrite']: enabled } : c))
    );
    try {
      const res = await opencodeApi.toggleCredentialSync(clientId, direction, enabled);
      setSyncClients((prev) => prev.map((c) => (c.id === clientId ? { ...res.client, id: clientId } : c)));
    } catch (err: any) {
      showNotice(err?.message ?? String(err), 'err');
      loadCredentialSync();
    }
  };

  const handleSyncRun = async (clientId: string, direction: 'read' | 'write') => {
    setSyncBusyKey(`${clientId}:${direction}`);
    const started = Date.now();
    try {
      const res = await opencodeApi.runCredentialSync(clientId, direction);
      // Perceptible-click floor, same contract as the rest of this page.
      const elapsed = Date.now() - started;
      if (elapsed < MIN_SPIN_MS) await sleep(MIN_SPIN_MS - elapsed);
      await loadCredentialSync();
      // The run reports gate/entry failures in-band (HTTP 200) — surface them.
      // Wording mirrors the "last synced" cell so toast and table agree.
      const outcome = direction === 'read' ? res.read : res.write;
      const failed = outcome?.entries.filter((e) => e.action === 'failed').length ?? 0;
      const label = t(direction === 'read' ? 'op.syncPull' : 'op.syncPush');
      const summary = outcome
        ? [syncOutcomeText(outcome, t), ...syncOutcomeWarnings(outcome, t)].filter(Boolean).join(' · ')
        : t('op.syncGenericFailure');
      if (!outcome || outcome.precondition || failed > 0) {
        toast.error(t('op.syncToastFail', { label, summary }));
      } else if (outcome.entries.length === 0) {
        toast.info(t('op.syncToastOk', { label, summary }));
      } else {
        toast.success(t('op.syncToastOk', { label, summary }));
      }
    } catch (err: any) {
      toast.error(reasonError(err));
      await sleep(MIN_SPIN_MS); // the spinner must stay perceptible on failure too
      loadCredentialSync();
    } finally {
      setSyncBusyKey(null);
    }
  };

  /** Returns whether the fetch succeeded. On a MANUAL refresh failure the
   * loaded catalog is kept (the caller surfaces an error notice — emptying the
   * list on a hiccup would destroy good data, cp-dataloss); initial load keeps
   * its original reset-to-empty behavior. */
  const loadCatalog = async (refresh = false): Promise<boolean> => {
    try {
      const res = await opencodeApi.catalog(refresh);
      setCatalog(res.providers);
      setCatalogSource(res.source);
      return true;
    } catch {
      if (!refresh) {
        setCatalog([]);
        setCatalogSource('none');
      }
      return false;
    }
  };

  useEffect(() => {
    // Catalog + auth session are mount-once. The provider/credential-store
    // rosters moved to the tab-entry effect below — the initial 'connected'
    // tab triggers them there, without a duplicate mount fetch.
    loadCatalog();
    api
      .getAuthSession()
      .then((s) => setWebAuthActive(Boolean(s.webAuth?.active)))
      .catch(() => setWebAuthActive(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every tab entry re-pulls that tab's own data — outcomes and rosters move
  // without page reloads (auto-sync runs on the gateway; other surfaces mutate
  // credentials) and a stale view invites wrong actions. The catalog tab is
  // deliberately absent: its loader resets the list to empty on failure and the
  // tab carries an explicit refresh button instead.
  useEffect(() => {
    if (activeTab === 'connected' || activeTab === 'custom') refreshAll();
    else if (activeTab === 'sync') loadCredentialSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Deep link from /models: /providers?openModels=<id> opens the model
  // maintenance dialog once the list has loaded. Every connected row owns a
  // defs node, so presence is the only gate.
  useEffect(() => {
    const target = searchParams.get('openModels');
    if (!target || ocProviders.length === 0) return;
    if (ocProviders.some((x) => x.id === target)) setModelsPanelId(target);
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ocProviders, searchParams]);

  const noticeTimer = useRef<ReturnType<typeof setTimeout>>();
  const showNotice = (msg: string, tone: 'ok' | 'err' = 'ok') => {
    clearTimeout(noticeTimer.current); // a newer notice owns the dismiss timer
    setNotice(msg);
    setNoticeTone(tone);
    noticeTimer.current = setTimeout(() => setNotice(''), 4000);
  };

  /** Credential mutations change both the provider view AND the bound-store status. */
  const refreshAll = async (): Promise<boolean> => {
    const [providersOk] = await Promise.all([loadOpenCodeProviders(), loadCredentialStore()]);
    return providersOk;
  };

  /**
   * One announcement rule for every "hand this key to the store" gesture (the
   * catalog connect and the card key submit are the SAME route): dedup says
   * which credential already owns the key, a first connection says connected, and a
   * key onto an already-connected provider states what the sink actually did —
   * appended an credential (multi-credential store) or replaced the only one.
   */
  const announceConnect = (res: Awaited<ReturnType<typeof opencodeApi.connectProvider>>, id: string) => {
    if (res.deduped) {
      toast.info(t('op.keyAlreadyExists', { label: res.credential ? credentialName(res.credential, t('op.credentialUnnamed')) : id }));
      return;
    }
    if (!connectedIds.has(id)) {
      showNotice(t('op.connectOk', { sink: sinkLabel }));
      return;
    }
    // The sink moved the chain head and we moved it back — say so, or the
    // operator cannot tell why the new row is not starred.
    if (res.headPreserved) {
      const added = res.credential ? credentialName(res.credential, t('op.credentialUnnamed')) : id;
      toast.info(t('op.headPreserved', { added, head: credentialName(res.headPreserved, t('op.credentialUnnamed')) }));
      return;
    }
    showNotice(t(multiCredentialStore ? 'op.keyAdded' : 'op.keyUpdated', { sink: sinkLabel }));
  };

  const handleConnect = async (id: string) => {
    if (!connectKey.trim()) return;
    setBusy(true);
    try {
      const res = await opencodeApi.connectProvider(id, connectKey.trim());
      // connectedIds is the pre-write snapshot — a first connect is NOT in it
      // yet; announceConnect lands the row before refreshAll() has returned.
      announceConnect(res, id);
      setConnectingId(null);
      setConnectKey('');
      await refreshAll();
    } catch (err: any) {
      toast.error(reasonError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateKey = async (id: string) => {
    if (!keyEditValue.trim()) return;
    setBusy(true);
    try {
      const res = await opencodeApi.connectProvider(id, keyEditValue.trim());
      announceConnect(res, id);
      setKeyEditId(null);
      setKeyEditValue('');
      await refreshAll();
    } catch (err: any) {
      toast.error(reasonError(err));
    } finally {
      setBusy(false);
    }
  };

  /** Batch test: bounded concurrency over the currently visible connected providers. */
  const handleTestAllProviders = () =>
    testAllTargets(connectedResults.map((p) => ({ key: p.id, providerId: p.id })));

  const handleDelete = async (p: OpenCodeProviderView) => {
    // Decision 8: the OCR file is the credential truth — the purge deletes its
    // rows, so the confirm names the sink. If the key is also synced into
    // opencode, the client keeps its copy until the next sync run.
    // Three-layer honesty about the def-node judgment: the view's `defNode`
    // is a list-load snapshot; the backend re-checks the file at DELETE time
    // (its runtime check is the only actor). Between those moments a def node
    // can appear or vanish (concurrent sessions edit the defs file), so the
    // confirm wording re-checks right before the dialog, and the success
    // toast follows the response's runtime `defRemoved` — never a snapshot.
    let hasDefNode = p.defNode;
    try {
      const fresh = (await opencodeApi.listProviders()).providers.find((x) => x.id === p.id);
      if (fresh) hasDefNode = fresh.defNode;
    } catch {
      // keep the snapshot — an unreachable list endpoint must not block the dialog
    }
    const ok = await confirmDialog({
      title: hasDefNode ? t('op.deleteConfirm', { id: p.id }) : t('op.deleteConfirmCredOnly', { id: p.id }),
      description: t(hasDefNode ? 'op.deletePurge' : 'op.deletePurgeCredOnly', { sink: sinkLabel }),
      danger: true,
      confirmLabel: t('common.delete'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await opencodeApi.deleteProvider(p.id, true);
      const failed = res.purge?.failed ?? [];
      // Decision 8 honesty: the config node may be gone while keys are NOT —
      // never show the plain 'deleted' notice when the store reports a partial
      // purge (success=false whenever attempted>0 && removed<attempted; the
      // double test guards against a malformed reply claiming success).
      if (res.success === false || failed.length > 0) {
        const detail =
          failed.map((f) => `${f.credentialId}: ${f.reason}`).join('; ') || t('op.purgeFailedUnknown');
        toast.error(t('op.purgeFailed', { detail }));
      } else {
        // Runtime truth wins: a def that appeared/vanished after the pre-dialog
        // re-check is reported as it actually happened.
        const defRemoved = res.defRemoved ?? hasDefNode;
        showNotice(t(defRemoved ? 'op.deleted' : 'op.deletedCredOnly'));
      }
      await refreshAll();
    } catch (err: any) {
      toast.error(reasonError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateCustom = async () => {
    if (!form.id.trim() || !form.baseURL.trim()) {
      toast.error(t('op.idAndUrlRequired'));
      return;
    }
    setBusy(true);
    try {
      await opencodeApi.createProvider({
        id: form.id.trim(),
        name: form.name.trim() || undefined,
        baseURL: form.baseURL.trim(),
        npm: form.npm.trim() || undefined,
        headers: rowsToHeaders(form.headerRows),
        apiKey: form.apiKey.trim() || undefined,
        apiKeyInline: form.inline,
        pullPattern: form.pullPattern.trim() || undefined,
      });
      showNotice(t('op.customTitle') + ' ✓');
      setForm({ id: '', name: '', baseURL: '', npm: '', apiKey: '', inline: false, pullPattern: '', headerRows: [] });
      setNpmChoice('');
      await refreshAll();
    } catch (err: any) {
      toast.error(reasonError(err));
      // The def may have survived the failure (integration_unmatched keeps it for
      // the post-restart retry) — refresh so the row shows up without a manual reload.
      await refreshAll();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', height: '100%' }}>
      <div className="card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column'}}>
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Plug size={18} color="var(--accent)" />
          <span style={{ fontWeight: 700, fontSize: 15 }}>{t('op.title')}</span>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '0 0 16px' }} title={ocPaths.configPath}>{t('op.desc', { sink: sinkLabel })}</p>

        {notice && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: noticeTone === 'err' ? 'color-mix(in srgb, var(--accent-rose) 12%, transparent)' : 'color-mix(in srgb, var(--accent-emerald) 15%, transparent)', border: `1px solid ${noticeTone === 'err' ? 'color-mix(in srgb, var(--accent-rose) 30%, transparent)' : 'color-mix(in srgb, var(--accent-emerald) 30%, transparent)'}`, color: noticeTone === 'err' ? 'var(--accent-rose)' : 'var(--accent-emerald)', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            {noticeTone === 'err' ? <AlertTriangle size={16} /> : <Check size={16} />}
            <span>{notice}</span>
          </div>
        )}
        {ocError && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'color-mix(in srgb, var(--accent-rose) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-rose) 30%, transparent)', color: 'var(--accent-rose)', fontSize: '13px', marginBottom: '16px' }}>
            {ocError}
          </div>
        )}

        {/* ---- Tabs ---- */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button style={tabBtn('connected', t('op.tabConnected'))} onClick={() => setActiveTab('connected')}>
            {t('op.tabConnected')} ({ocProviders.length})
          </button>
          <button style={tabBtn('catalog', t('op.tabCatalog'))} onClick={() => setActiveTab('catalog')}>
            {t('op.tabCatalog')} ({catalogResults.length})
          </button>
          <button style={tabBtn('custom', t('op.tabCustom'))} onClick={() => setActiveTab('custom')}>
            {t('op.tabCustom')}
          </button>
          <button style={tabBtn('sync', t('op.syncTab'))} onClick={() => setActiveTab('sync')}>
            {t('op.syncTab')}
          </button>
        </div>

        {/* Scrollable tab content: the tab bars stay fixed, long lists scroll here. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {activeTab === 'connected' && (<>
        {/* ---- Connected providers: bound credential-store status (defs file providers map ∪ bound store) ---- */}
        {storeStatus && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '0 0 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {storeStatus.degradedCode ? (
                <span
                  style={{ ...badgeStyle('var(--accent-amber)', 'color-mix(in srgb, var(--accent-amber) 12%, transparent)'), display: 'inline-flex', alignItems: 'center', gap: 3 }}
                  title={storeStatus.detail}
                >
                  <AlertTriangle size={9} />
                  {t(STORE_DEGRADED_LABEL[storeStatus.degradedCode] ?? 'op.storeDegradedGeneric')}
                </span>
              ) : (
                <span style={badgeStyle('var(--text-dim)', 'var(--chip-bg)')}>
                  {t(STORE_KIND_LABEL[storeStatus.kind] ?? storeStatus.kind)}
                </span>
              )}
              <span
                style={{ fontSize: 10, fontFamily: FONT_MONO, color: 'var(--text-muted)', maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={`${t('op.storeCredentialFile')}: ${storeStatus.credentialFile}`}
              >
                {storeStatus.credentialFile}
              </span>
            </div>
            {storeStatus.excluded.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)' }}>
                  {t('op.excludedTitle', { n: storeStatus.excluded.length })}
                </span>
                {storeStatus.excluded.map((e) => (
                  <div key={`${e.provider}:${e.reasonCode}`} style={{ fontSize: 11, color: 'var(--text-dim)' }} title={e.detail}>
                    <span style={{ fontFamily: FONT_MONO }}>{e.provider}</span>
                    <span> — {t(EXCLUDED_REASON_LABEL[e.reasonCode] ?? e.reasonCode)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ fontSize: 12, maxWidth: 420, flex: 1, minWidth: 200 }}
            placeholder={t('op.searchConnected')}
            value={connectedQuery}
            onChange={e => { setConnectedQuery(e.target.value); setConnectedPage(1); }}
          />
          <button
            className="btn btn-sm"
            disabled={refreshingConnected}
            title={t('op.refreshConnected')}
            onClick={async () => {
              setRefreshingConnected(true);
              const start = Date.now();
              let ok = false;
              try {
                ok = await refreshAll();
              } finally {
                await sleep(Math.max(0, MIN_SPIN_MS - (Date.now() - start)));
                setRefreshingConnected(false);
              }
              // On failure the red ocError banner already carries the message.
              if (ok) showNotice(t('op.refreshDone'));
            }}
          >
            <RefreshCw size={12} style={refreshingConnected ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined} />
            <span>{t('op.refreshConnected')}</span>
          </button>
          <button
            className="btn btn-sm"
            disabled={testAll.running || testingIds.size > 0 || connectedResults.length === 0}
            title={t('op.testAllBtn')}
            onClick={handleTestAllProviders}
          >
            {testAll.running ? <RefreshCw size={12} style={{ animation: 'ocr-spin 0.8s linear infinite' }} /> : <Zap size={12} />}
            <span>{testAll.running ? t('op.testAllRunning', { done: testAll.done, n: testAll.total }) : t('op.testAllBtn')}</span>
          </button>
        </div>
        {/* Responsive, capped at 3 columns: the min track is a THIRD of the row
            (minus gaps), so a wide screen never stretches 4+ cards into slivers,
            while a narrow one drops to 2 / 1 by the 300px floor. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(max(300px, calc((100% - 28px) / 3)), 1fr))', gap: '14px' }}>
          {pagedConnected.map(p => {
            const credentialList = credentialsByProvider.get(p.id) ?? [];
            const caps = storeStatus?.capabilities;
            // Sole routable credential (see CredentialRow.soleServing): exactly one
            // key that can route AND has not been taken down — a disabled row is
            // in neither the spread nor the failover pool, so it never counts.
            const liveIds = credentialList.filter((a) => a.routable && !a.disabled).map((a) => a.id);
            const soleRoutableId = liveIds.length === 1 ? liveIds[0] : null;
            // Key writes need a registered integration (see canWriteCredential).
            const keyWritable = canWriteCredential(p.id);
            // Two rows printing the same masked key are indistinguishable without
            // the fingerprint — that (and only that) is when the chip earns space.
            const masks = credentialList.map((a) => a.maskedKey ?? a.id);
            const ambiguousMasks = new Set(masks.filter((m, i) => masks.indexOf(m) !== i));
            return (
            <div key={p.id} className="sub-card" style={cardFlex}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <ProviderLogo id={p.id} logo={p.logo} size={44} />
                <div style={{ flex: '1 1 96px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontWeight: 700, fontSize: 14, fontFamily: FONT_MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.id}</span>
                  {p.name && <span style={{ fontSize: 11, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>}
                </div>
                {/* Identity badges ride the title row again — the wide npm badge
                    moved to the URL row, so the small chips fit; the 96px title
                    floor keeps the id readable on the narrowest card (badges
                    wrap inside their own box below that). */}
                {(p.custom || p.auth.inline || p.auth.type === 'oauth') && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', minWidth: 0 }}>
                    {p.custom && <span style={badgeStyle('var(--accent)', 'var(--accent-bg)')} title={t('op.badgeCustomTip')}>{t('op.badgeCustom')}</span>}
                    {p.auth.inline && (
                      <span style={{ ...badgeStyle('var(--accent-amber)', 'color-mix(in srgb, var(--accent-amber) 12%, transparent)'), display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <Key size={9} />
                        {t('op.badgeInline')}
                      </span>
                    )}
                    {p.auth.type === 'oauth' && <span style={badgeStyle('var(--hue-violet)', 'var(--hue-violet-soft)')}>{t('op.badgeOauth')}</span>}
                    {/* The api-key sink badge ("credentials.json") was removed:
                        the bound store is PAGE-level truth (stated in the tab
                        descriptions), identical on every card — a per-card
                        repetition carried zero information. */}
                  </div>
                )}
                {/* Empty defs node = this provider routes nothing (the boot pool
                    only logs the exclusion). Surface it on the card and make the
                    fix one click: the same model dialog that pulls / adds. */}
                {p.models.length === 0 && (
                  <button
                    className="btn btn-sm"
                    style={{ ...badgeStyle('var(--accent-amber)', ''), flexShrink: 0, cursor: 'pointer' }}
                    disabled={busy}
                    title={t('op.pmEmptyBadgeTip')}
                    onClick={() => setModelsPanelId(p.id)}
                  >
                    {t('op.pmEmptyBadge')}
                  </button>
                )}
                {caps && credentialList.length > 0 && (
                  <button
                    className="btn btn-sm"
                    style={{ flexShrink: 0 }}
                    title={t('op.credentialZoom')}
                    aria-label={t('op.credentialZoom')}
                    onClick={() => setZoomProviderId(p.id)}
                  >
                    <Maximize2 size={12} />
                  </button>
                )}
                {p.defNode && (
                  <button
                    className="btn btn-sm"
                    style={{ flexShrink: 0 }}
                    disabled={busy}
                    title={t('op.editDefTitle')}
                    onClick={() => openDefEdit(p)}
                  >
                    <Pencil size={12} />
                  </button>
                )}
                {keyEditId !== p.id && (
                  <button
                    className="btn btn-sm"
                    style={{ color: 'var(--accent-rose)', flexShrink: 0 }}
                    disabled={busy || testingIds.size > 0 || testAll.running}
                    title={t('op.deleteBtn')}
                    onClick={() => handleDelete(p)}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>

              {(p.baseURL || displayNpm(p.npm)) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {p.baseURL && (
                    <div style={{ flex: 1, minWidth: 0, fontSize: 11, fontFamily: FONT_MONO, color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                      {p.baseURL}
                    </div>
                  )}
                  {displayNpm(p.npm) && (
                    <span
                      style={{ ...badgeStyle('var(--text-dim)', 'var(--chip-bg)'), fontFamily: FONT_MONO, fontSize: 9.5, flexShrink: 0 }}
                      title={`${displayNpm(p.npm)} — ${t('catalogPage.ocrEditNpmHint')}`}
                    >
                      {displayNpm(p.npm)!.replace('@ai-sdk/', '')}
                    </span>
                  )}
                </div>
              )}

              {/* Chain-head key summary. With the per-credential list on screen it
                  would repeat the first row, so it renders only when that list
                  does not. The old OAuth-expiry line is gone: the provider view
                  never carried a live expiry (store credentials are api keys). */}
              {!(caps && credentialList.length > 0) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontFamily: FONT_MONO }}>
                  <Lock size={11} />
                  <span>{p.auth.keyMasked || '—'}</span>
                </div>
              )}

              {/* Credential list — always visible, one line per key,
                  capped at 3 rows (more scroll). No expand gesture: per-key state
                  is the reason this page exists, and hiding it behind a click put
                  the active credential out of sight. */}
              {caps && credentialList.length > 0 && liveIds.length > 1 && (
                <div style={{ fontSize: 10.5, color: 'var(--text-dim)' }} title={t('op.credentialChainHeadTip')}>
                  {t('op.credentialsSpreadHint', { n: liveIds.length })}
                </div>
              )}
              {/* Everything parked: say so plainly instead of letting the card look live. */}
              {caps && credentialList.length > 0 && liveIds.length === 0 && (
                <div style={{ fontSize: 10.5, color: 'var(--accent-rose)' }} title={t('op.credentialsAllDisabledTip')}>
                  {t('op.credentialsAllDisabled')}
                </div>
              )}
              {caps && credentialList.length > 0 && (
                <div
                  className="list-group"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    maxHeight: CREDENTIAL_ROWS_VISIBLE * CREDENTIAL_ROW_HEIGHT_EST,
                    overflowY: 'auto',
                  }}
                >
                  {credentialList.map((a, i) => (
                    <CredentialRow
                      key={a.id}
                      credential={a}
                      position={i + 1}
                      caps={caps}
                      soleServing={soleRoutableId === a.id}
                      prefixVisible={a.maskedKey ? ambiguousMasks.has(a.maskedKey) : true}
                      pending={pendingCredential === `${p.id}:${a.id}`}
                      testing={testingIds.has(`${p.id}:${a.id}`)}
                      onTest={(acc) => testOne({ key: `${p.id}:${acc.id}`, providerId: p.id, credentialId: acc.id })}
                      renaming={renameKey === `${p.id}:${a.id}`}
                      onStartRename={() => setRenameKey(`${p.id}:${a.id}`)}
                      onCancelRename={() => setRenameKey(null)}
                      now={now}
                      onPin={handleCredentialPin}
                      onRename={handleCredentialRename}
                      onDisconnect={handleCredentialDisconnect}
                      onToggleDisabled={handleCredentialToggleDisabled}
                      onClearSuspect={handleCredentialClearSuspect}
                      canReveal={webAuthActive}
                      onCopyKey={handleCredentialCopyKey}
                      onEditLimits={(acc) => openLimitsDialog(p.id, acc)}
                    />
                  ))}
                </div>
              )}

              {testResults[p.id] && (
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: FONT_MONO,
                    color: testResults[p.id].ok ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                    wordBreak: 'break-all',
                  }}
                  title={testResults[p.id].ok ? `${testResults[p.id].latencyMs} ms` : testResults[p.id].error}
                >
                  {testResults[p.id].ok
                    ? `✓ ${testResults[p.id].model} · ${fmtLatency(testResults[p.id].latencyMs ?? NaN)}`
                    : `✗ ${testResults[p.id].error || t('op.testFailMsg')}`}
                </div>
              )}

              {/* Action footer pinned to the card bottom (margin-top auto in
                  the flex-column card) so button rows align across a grid row
                  regardless of how many credential rows each card holds. */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 'auto' }}>
                {keyEditId === p.id ? (
                  <>
                    <input
                      className="input"
                      style={{ fontSize: 12, flex: 1, minWidth: 140 }}
                      placeholder={t(multiCredentialStore ? 'op.addKeyPrompt' : 'op.updateKeyPrompt')}
                      value={keyEditValue}
                      onChange={e => setKeyEditValue(e.target.value)}
                      autoFocus
                    />
                    <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => handleUpdateKey(p.id)}>
                      <Check size={12} />
                    </button>
                    <button className="btn btn-sm" onClick={() => { setKeyEditId(null); setKeyEditValue(''); }}>
                      ✕
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn-sm"
                    disabled={!keyWritable}
                    title={
                      !keyWritable
                          ? t('op.integrationMissingTip')
                          : t(multiCredentialStore ? 'op.addKeyCredentialTip' : 'op.updateKeyTip')
                    }
                    onClick={() => setKeyEditId(p.id)}
                  >
                    {multiCredentialStore ? <Plus size={12} /> : <Key size={12} />}
                    <span>{t(multiCredentialStore ? 'op.addKeyCredential' : 'op.updateKey')}</span>
                  </button>
                )}
                {keyEditId !== p.id && (
                  <>
                    <button
                      className="btn btn-sm"
                      disabled={testingIds.size > 0 || testAll.running}
                      title={testingIds.has(p.id) ? t('op.testing') : t('op.testBtn')}
                      onClick={() => testOne({ key: p.id, providerId: p.id })}
                    >
                      {testingIds.has(p.id) ? <RefreshCw size={12} style={{ animation: 'ocr-spin 0.8s linear infinite' }} /> : <Zap size={12} />}
                      {!testingIds.has(p.id) && <span>{t('op.testBtn')}</span>}
                    </button>
                    <button
                      className="btn btn-sm"
                      style={modelsPanelId === p.id ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
                      disabled={busy}
                      title={t('op.pmManage')}
                      onClick={() => setModelsPanelId(p.id)}
                    >
                      <Cpu size={12} />
                      <span>{t('op.pmManage')}</span>
                    </button>
                  </>
                )}
              </div>

              {modelsPanelId === p.id && (
                <ProviderModelsDialog
                  providerId={p.id}
                  providerName={p.name}
                  onClose={() => setModelsPanelId(null)}
                  onChanged={loadOpenCodeProviders}
                />
              )}
            </div>
            );
          })}
          {connectedResults.length === 0 && !ocError && (
            <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('op.emptyConnected')}</div>
          )}
        </div>

        </>)}

        {activeTab === 'catalog' && (<>
        {/* ---- Connect catalog provider ---- */}
        <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '0 0 12px' }}>
          {t('op.connectDesc')} · {t('op.catalogSource', { source: catalogSource || 'none' })}
        </p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            className="input"
            style={{ fontSize: 12, flex: 1 }}
            placeholder={t('op.searchCatalog')}
            value={catalogQuery}
            onChange={e => { setCatalogQuery(e.target.value); setCatalogPage(1); }}
          />
          <button
            className="btn btn-sm"
            disabled={refreshingCatalog}
            onClick={async () => {
              setRefreshingCatalog(true);
              const start = Date.now();
              const ok = await loadCatalog(true);
              await sleep(Math.max(0, MIN_SPIN_MS - (Date.now() - start)));
              setRefreshingCatalog(false);
              showNotice(ok ? t('op.refreshDone') : t('op.refreshFailed'), ok ? 'ok' : 'err');
            }}
          >
            <RefreshCw size={12} style={refreshingCatalog ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined} />
            <span>{t('op.refreshCatalog')}</span>
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
            <Switch size="sm" checked={hideConnected} onChange={v => { setHideConnected(v); setCatalogPage(1); }} />
            {t('op.hideConnected')}
          </label>
        </div>
        {/* Same responsive cap as the connected grid — one column rhythm across
            the page's tabs (3 cards per row on a wide screen, floor 280px). */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(max(280px, calc((100% - 20px) / 3)), 1fr))', gap: '10px' }}>
          {pagedCatalog.map(c => {
            const connected = connectedIds.has(c.id);
            return (
              // Connected rows keep their place in the grid but carry a static
              // badge: adding or replacing a credential lives in the Connected
              // tab — this tab only starts new connections.
              <div key={c.id} className="sub-card" style={{ ...cardFlex, padding: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <ProviderLogo id={c.id} logo={c.logo} size={38} />
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontWeight: 700, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: FONT_MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.id}</span>
                  </div>
                  {c.npm && (
                    <span style={{ fontSize: 9.5, color: 'var(--text-dim)', fontFamily: FONT_MONO, flexShrink: 0, border: '1px solid var(--chip-bg)', borderRadius: 4, padding: '1px 4px' }} title={t('catalogPage.ocrEditNpmHint')}>
                      {(displayNpm(c.npm) || '').replace('@ai-sdk/', '')}
                    </span>
                  )}
                  {(c.baseURL || c.api) && (
                    <button
                      className="btn btn-sm"
                      style={{ flexShrink: 0, padding: '2px 4px' }}
                      title={`${c.baseURL || c.api} — ${t('op.copyBaseUrl')}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(c.baseURL || c.api!);
                        showNotice(t('op.baseUrlCopied'), 'ok');
                      }}
                    >
                      <Copy size={11} />
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-dim)' }}>
                  <span>{t('op.modelsCount', { n: c.modelCount })}</span>
                  {typeof c.priceFrom === 'number' && (
                    <span style={{ color: 'var(--accent-emerald)' }}>{t('op.priceFrom', { price: c.priceFrom })}</span>
                  )}
                </div>
                {connected ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--accent-emerald)', padding: '7px 0' }}>
                    <Check size={12} />
                    <span>{t('op.alreadyConnected')}</span>
                  </div>
                ) : connectingId === c.id ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      className="input"
                      style={{ fontSize: 12, flex: 1 }}
                      placeholder={t('op.apiKeyPlaceholder')}
                      value={connectKey}
                      onChange={e => setConnectKey(e.target.value)}
                      autoFocus
                      onKeyDown={e => e.key === 'Enter' && handleConnect(c.id)}
                    />
                    <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => handleConnect(c.id)}>
                      <Check size={12} />
                    </button>
                    <button className="btn btn-sm" onClick={() => { setConnectingId(null); setConnectKey(''); }}>✕</button>
                  </div>
                ) : (
                  <button
                    className="btn btn-sm"
                    disabled={!canWriteCredential(c.id)}
                    title={
                      !canWriteCredential(c.id)
                          ? t('op.integrationMissingTip')
                          : undefined
                    }
                    onClick={() => { setConnectingId(c.id); setConnectKey(''); }}
                  >
                    <Plug size={12} />
                    <span>{t('op.connectBtn')}</span>
                  </button>
                )}
              </div>
            );
          })}
          {catalog.length === 0 && (
            <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('op.catalogEmpty')}</div>
          )}
        </div>

        </>)}

        {activeTab === 'custom' && (<>
        {/* ---- Custom provider form ---- */}
        <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '0 0 12px' }}>{t('op.customDesc')}</p>
        {/* Capped two-column form (was an uncapped 3-col grid that stretched every
            input to ~900px on wide screens). Base URL spans the row — it is the one
            long value; the inline switch lives INSIDE the key cell so the pair reads
            as one control. auto-fit collapses to a single column below ~580px. */}
        <div style={{ maxWidth: 720, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: '12px 14px' }}>
          <FormField label={t('op.fId')} required>
            <input className="input" style={{ fontSize: 12 }} placeholder={t('op.phId')} value={form.id} onChange={e => setForm({ ...form, id: normalizeProviderIdInput(e.target.value) })} />
            <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{t('op.idRule')}</span>
          </FormField>
          <FormField label={t('op.fName')}>
            <input className="input" style={{ fontSize: 12 }} placeholder={t('op.phName')} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          </FormField>
          <FormField label={t('op.fBaseUrl')} required style={{ gridColumn: '1 / -1' }}>
            <input className="input" style={{ fontSize: 12 }} placeholder={t('op.phBaseUrl')} value={form.baseURL} onChange={e => setForm({ ...form, baseURL: e.target.value })} />
          </FormField>
          {/* Key cell spans the row: the inline-switch sentence needs the full
              720px to stay on one line, and long sk- values want the width too. */}
          <FormField label={t('op.fKey', { sink: sinkLabel })} style={{ gridColumn: '1 / -1' }}>
            <input className="input" style={{ fontSize: 12 }} placeholder={t('op.phKey')} value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} />
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
              <Switch size="sm" checked={form.inline} onChange={v => setForm({ ...form, inline: v })} />
              <span>{t('op.fKeyInline')}</span>
            </label>
          </FormField>
          <FormField label={t('op.fPullPattern')} style={{ gridColumn: '1 / -1' }}>
            <input className="input" style={{ fontSize: 12, fontFamily: FONT_MONO }} placeholder={t('op.phPullPattern')} value={form.pullPattern} onChange={e => setForm({ ...form, pullPattern: e.target.value })} />
            <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{t('op.fPullPatternTip')}</span>
          </FormField>
          {/* AI SDK package is low-frequency (almost always the openai-compatible
              default) — parked last so the common path reads ID → name → URL → key. */}
          <FormField label={t('op.fNpmLabel')}>
            {npmChoice === CUSTOM_NPM ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="input" style={{ fontSize: 12, flex: 1, minWidth: 0 }} placeholder={t('op.fNpmCustom')} value={form.npm} onChange={e => setForm({ ...form, npm: e.target.value })} autoFocus />
                <button className="btn btn-sm" title={t('op.fNpmLabel')} onClick={() => { setNpmChoice(''); setForm({ ...form, npm: '' }); }}>↩</button>
              </div>
            ) : (
              <Combobox
                style={{ fontSize: 12, cursor: 'pointer' }}
                value={npmChoice}
                onChange={(v) => {
                  setNpmChoice(v);
                  if (v === CUSTOM_NPM) setForm({ ...form, npm: '' });
                  else setForm({ ...form, npm: v });
                }}
                placeholder={t('op.fNpm')}
                clearable
                options={[
                  { value: '', label: t('op.fNpm') },
                  ...npmOptions.map((pkg) => ({ value: pkg, label: pkg })),
                  { value: CUSTOM_NPM, label: `${t('op.fNpmCustom')}…` },
                ]}
              />
            )}
          </FormField>
          <FormField label={t('op.fHeaders')} style={{ gridColumn: '1 / -1' }}>
            <HeadersEditor rows={form.headerRows} onChange={headerRows => setForm({ ...form, headerRows })} />
          </FormField>
        </div>
        <div style={{ maxWidth: 720, marginTop: 14 }}>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={handleCreateCustom}>
            <Plus size={12} />
            <span>{busy ? t('op.creating') : t('op.createBtn')}</span>
          </button>
        </div>
        </>)}

        {activeTab === 'sync' && (<>
        {/* ---- Credential sync (client ⇄ OCR file; the OCR file is the single truth) ---- */}
        <p style={{ color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.7, margin: '0 0 7px' }}>{t('op.syncDesc')}</p>
        <p style={{ color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.7, margin: '0 0 14px' }}>{t('op.syncDescModes')}</p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns:
              'minmax(150px, 1.1fr) minmax(200px, 1.4fr) minmax(130px, 1fr) minmax(130px, 1fr) minmax(120px, 0.9fr)',
            gap: '12px 14px',
            alignItems: 'start',
          }}
        >
          <div style={syncHeadCell}>{t('op.syncColClient')}</div>
          <div style={syncHeadCell}>{t('op.syncColAuto')}</div>
          <div style={syncHeadCell}>{t('op.syncColLastRead')}</div>
          <div style={syncHeadCell}>{t('op.syncColLastWrite')}</div>
          <div style={{ ...syncHeadCell, textAlign: 'right' }}>{t('op.syncColAction')}</div>
          {syncClients.map((c) => {
            const readBusy = syncBusyKey === `${c.id}:read`;
            const writeBusy = syncBusyKey === `${c.id}:write`;
            const clientBusy = readBusy || writeBusy;
            return (
            <React.Fragment key={c.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 2 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{c.label}</span>
                {!c.present && (
                  // Absent client: compact amber warning glyph + hover bubble
                  // instead of a text badge (the condition is static per client).
                  <InfoTip variant="warning" text={t('op.syncClientAbsent')} />
                )}
                {c.present && !c.writeReady && (
                  <span style={badgeStyle('var(--text-dim)', 'transparent')}>{t('op.syncServiceMissing')}</span>
                )}
                {c.present && c.defsDrift === true && !(c.lastWrite?.defsChanged === true && c.lastWrite.defsReloaded === false) && (
                  // The client's materialized `providers` slot is behind the defs
                  // book. Autosync is OFF by default, so this is the normal state
                  // after any provider/model edit — it must be VISIBLE, because a
                  // silent drift is indistinguishable from a working push.
                  <span style={badgeStyle('var(--accent-amber)', 'transparent')} title={t('op.syncDefsDriftTip')}>
                    {t('op.syncDefsDrift')}
                  </span>
                )}
                {c.lastWrite?.defsChanged === true && c.lastWrite.defsReloaded === false && (
                  // A changed def render the client refused to reload: it keeps
                  // serving the OLD provider list until the next push. This is a
                  // condition, not a count — it belongs here, not in the dim
                  // one-line outcome summary under "last write".
                  <span style={badgeStyle('var(--accent-rose)', 'transparent')} title={t('op.syncDefsReloadFailed')}>
                    {t('op.syncDefsReloadFailedShort')}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16, paddingTop: 2 }}>
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-main)', cursor: 'pointer' }}
                  title={t('op.syncAutoReadTip')}
                >
                  <Switch
                    size="sm"
                    checked={c.autoRead}
                    onChange={(v) => handleSyncToggle(c.id, 'read', v)}
                  />
                  <span>{t('op.syncAutoRead')}</span>
                </label>
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-main)', cursor: 'pointer' }}
                  title={t('op.syncAutoWriteTip')}
                >
                  <Switch
                    size="sm"
                    checked={c.autoWrite}
                    onChange={(v) => handleSyncToggle(c.id, 'write', v)}
                  />
                  <span>{t('op.syncAutoWrite')}</span>
                </label>
              </div>
              <div style={syncTimeCell}>
                <div>{syncTimeAgo(c.lastReadAt, t)}</div>
                {syncOutcomeText(c.lastRead, t) && (
                  <div style={syncOutcomeStyle} title={syncOutcomeBreakdown(c.lastRead, t) || undefined}>
                    {syncOutcomeText(c.lastRead, t)}
                  </div>
                )}
              </div>
              <div style={syncTimeCell}>
                <div>{syncTimeAgo(c.lastWriteAt, t)}</div>
                {syncOutcomeText(c.lastWrite, t) && (
                  <div style={syncOutcomeStyle} title={syncOutcomeBreakdown(c.lastWrite, t) || undefined}>
                    {syncOutcomeText(c.lastWrite, t)}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                {/* Manual sync is per-direction: pull = client → OCR, push = OCR → client. */}
                <button
                  className="btn btn-sm"
                  title={t('op.syncPullTip')}
                  disabled={clientBusy}
                  onClick={() => handleSyncRun(c.id, 'read')}
                >
                  <Download
                    size={12}
                    style={readBusy ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined}
                  />
                  <span>{t('op.syncPull')}</span>
                </button>
                <button
                  className="btn btn-sm"
                  title={t('op.syncPushTip')}
                  disabled={clientBusy}
                  onClick={() => handleSyncRun(c.id, 'write')}
                >
                  <Upload
                    size={12}
                    style={writeBusy ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined}
                  />
                  <span>{t('op.syncPush')}</span>
                </button>
              </div>
            </React.Fragment>
            );
          })}
        </div>
        {syncClients.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 10 }}>{t('op.syncEmpty')}</div>
        )}
        </>)}
        </div>

        {/* Tab-scoped pagination pinned below the scroll area (never scrolls away). */}
        {activeTab === 'connected' && connectedResults.length > 0 && (
          <Pagination
            page={connectedPage}
            pageSize={connectedPageSize}
            total={connectedResults.length}
            onChange={setConnectedPage}
            showSummary
            pageSizeOptions={CONNECTED_PAGE_SIZES}
            onPageSizeChange={(s) => { setConnectedPageSize(s); setConnectedPage(1); }}
          />
        )}
        {activeTab === 'catalog' && catalogResults.length > 0 && (
          <Pagination
            page={catalogPage}
            pageSize={catalogPageSize}
            total={catalogResults.length}
            onChange={setCatalogPage}
            showSummary
            pageSizeOptions={CATALOG_PAGE_SIZES}
            onPageSizeChange={(s) => { setCatalogPageSize(s); setCatalogPage(1); }}
          />
        )}

        {/* Decision 10 password gate — fixed overlay, mounted outside the tab
            bodies so a tab switch cannot orphan it mid-reveal. */}
        {revealTarget && (
          <RevealKeyDialog
            credential={revealTarget}
            password={revealPassword}
            error={revealError}
            busy={revealBusy}
            onPassword={setRevealPassword}
            onCancel={() => {
              setRevealTarget(null);
              setRevealPassword('');
            }}
            onConfirm={handleRevealConfirm}
          />
        )}

        {/* Outbound rate-limit overlay editor — same fixed-overlay mount rule
            as the reveal gate (a tab switch must not orphan it). */}
        {limitsTarget && (
          <CredentialLimitsDialog
            providerId={limitsTarget.providerId}
            credential={limitsTarget.credential}
            drafts={limitsDraft}
            windows={limitsWindows}
            busy={limitsBusy}
            onChangeDrafts={setLimitsDraft}
            onCancel={() => setLimitsTarget(null)}
            onSave={handleSaveCredentialLimits}
          />
        )}

        {/* Per-provider credential zoom — a TABLE: the labels live in the
            column headers, the actions stay icon-only (title + aria-label
            carry the full name), so the dialog stays narrow. Rows reuse the
            same shared badge/action components as the card rows — availability
            logic cannot drift — and share the page-owned handler wiring. */}
        {zoomProviderId && ocProviders.some((x) => x.id === zoomProviderId) && (() => {
          const p = ocProviders.find((x) => x.id === zoomProviderId)!;
          const caps = storeStatus?.capabilities;
          const credentialList = credentialsByProvider.get(p.id) ?? [];
          const liveIds = credentialList.filter((a) => a.routable && !a.disabled).map((a) => a.id);
          const soleRoutableId = liveIds.length === 1 ? liveIds[0] : null;
          const masks = credentialList.map((a) => a.maskedKey ?? a.id);
          const ambiguousMasks = new Set(masks.filter((m, i) => masks.indexOf(m) !== i));
          const rowProps = (a: CredentialHealth, i: number) => ({
            credential: a,
            position: i + 1,
            caps: caps!,
            soleServing: soleRoutableId === a.id,
            prefixVisible: a.maskedKey ? ambiguousMasks.has(a.maskedKey) : true,
            pending: pendingCredential === `${p.id}:${a.id}`,
            testing: testingIds.has(`${p.id}:${a.id}`),
            onTest: (acc: CredentialHealth) => testOne({ key: `${p.id}:${acc.id}`, providerId: p.id, credentialId: acc.id }),
            renaming: renameKey === `${p.id}:${a.id}`,
            onStartRename: () => setRenameKey(`${p.id}:${a.id}`),
            onCancelRename: () => setRenameKey(null),
            now,
            onPin: handleCredentialPin,
            onRename: handleCredentialRename,
            onDisconnect: handleCredentialDisconnect,
            onToggleDisabled: handleCredentialToggleDisabled,
            onClearSuspect: handleCredentialClearSuspect,
            canReveal: webAuthActive,
            onCopyKey: handleCredentialCopyKey,
            onEditLimits: (acc: CredentialHealth) => openLimitsDialog(p.id, acc),
          });
          return (
            <Dialog
              title={p.id}
              subtitle={t('op.credentialZoomDesc')}
              onClose={() => setZoomProviderId(null)}
              closeLabel={t('common.close')}
              width={640}
              maxSize={{ width: 'min(860px, 94vw)' }}
              footerRight={
                <button className="btn btn-sm" onClick={() => setZoomProviderId(null)}>
                  <span>{t('common.close')}</span>
                </button>
              }
            >
              {caps && credentialList.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ ...ZOOM_TH, textAlign: 'center', padding: '5px 4px' }}>#</th>
                      <th style={ZOOM_TH}>{t('op.credentialZoomColName')}</th>
                      <th style={ZOOM_TH}>{t('op.credentialZoomColKey')}</th>
                      <th style={{ ...ZOOM_TH, textAlign: 'center', padding: '5px 16px', width: '1%' }}>{t('op.credentialZoomColStatus')}</th>
                      {/* One column per action — the header IS the label. Headers
                          wrap so each column stays as wide as its button. */}
                      <th style={ZOOM_TH_ACT}>{t('op.credentialPin')}</th>
                      <th style={ZOOM_TH_ACT}>{t('op.credentialTest')}</th>
                      <th style={ZOOM_TH_ACT}>{t('op.credentialLimits')}</th>
                      <th style={ZOOM_TH_ACT}>{t('op.credentialZoomColToggle')}</th>
                      <th style={{ ...ZOOM_TH_ACT, color: 'var(--accent-rose)' }}>{t('op.credentialDisconnect')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {credentialList.map((a, i) => (
                      <CredentialZoomRow key={a.id} {...rowProps(a, i)} />
                    ))}
                  </tbody>
                </table>
              )}
            </Dialog>
          );
        })()}

        {/* Provider-def edit dialog — same fixed-overlay mount rule as the
            reveal gate (a tab switch must not orphan it). zIndex 200, NOT
            higher: Combobox panels ride at 220 (PANEL_Z), and this dialog
            hosts the npm Combobox — the overlay must sit BELOW the dropdown
            layer or the panel opens underneath it. */}
        {editDef && createPortal(
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
            {...defBackdrop}
          >
            <div
              className="card"
              style={{ width: 'min(560px, 100%)', maxHeight: '90vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{ fontSize: 14, fontWeight: 700 }}>{t('op.editDefTitle')} — {editDef.id}</div>
              <FormField label={t('op.fName')}>
                <input className="input" style={{ fontSize: 12 }} value={editDef.name} onChange={e => setEditDef({ ...editDef, name: e.target.value })} />
              </FormField>
              <FormField label={t('op.fBaseUrl')}>
                <input className="input" style={{ fontSize: 12, fontFamily: FONT_MONO }} value={editDef.baseURL} onChange={e => setEditDef({ ...editDef, baseURL: e.target.value })} />
              </FormField>
              <FormField label={t('op.fNpmLabel')}>
                {/* Combobox, not a free input (repo dropdown convention). The
                    current value always rides first so a non-vocabulary def
                    stays visible; selections may also be cleared. */}
                <Combobox
                  style={{ fontSize: 12 }}
                  value={editDef.npm}
                  onChange={(v) => setEditDef({ ...editDef, npm: v })}
                  clearable
                  options={[
                    // Current value rides first ONLY when the vocabulary does not
                    // already list it — otherwise the dropdown shows the same
                    // alias twice, both ticked.
                    ...(editDef.npm && !npmOptions.includes(editDef.npm)
                      ? [{ value: editDef.npm, label: editDef.npm }]
                      : []),
                    ...npmOptions.map((pkg) => ({ value: pkg, label: pkg })),
                  ]}
                />
              </FormField>
              <FormField label={t('op.fPullPattern')}>
                <input className="input" style={{ fontSize: 12, fontFamily: FONT_MONO }} placeholder={t('op.phPullPattern')} value={editDef.pullPattern} onChange={e => setEditDef({ ...editDef, pullPattern: e.target.value })} />
                <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{t('op.fPullPatternTip')}</span>
              </FormField>
              <FormField label={t('op.fHeaders')}>
                <HeadersEditor rows={editDef.headerRows} onChange={headerRows => setEditDef({ ...editDef, headerRows })} disabled={savingDef} />
                <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{t('op.fHeadersTip')}</span>
              </FormField>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button className="btn btn-sm" disabled={savingDef} onClick={() => setEditDef(null)}>{t('op.cancelDefEdit')}</button>
                <button className="btn btn-primary btn-sm" disabled={savingDef} onClick={saveDefEdit}>
                  <Check size={12} />
                  <span>{savingDef ? t('op.savingDef') : t('op.saveDef')}</span>
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
      </div>
    </div>
  );
};

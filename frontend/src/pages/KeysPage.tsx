import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { Key, Check, RefreshCw, Trash2, Plug, Plus, Cpu, Zap, Upload, Download, AlertTriangle, Pencil, Unplug, Clock, ShieldAlert, Ban, PowerOff, Power, Copy, Gauge, ArrowUpToLine } from 'lucide-react';
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
  type PluginAuthType,
} from '../lib/api';
import { CREDENTIAL_WEIGHT_MAX } from '../lib/defaults';
import {
  LimitsEditor,
  compileLimitDrafts,
  draftFromRule,
  ruleLabel,
  type LimitDraft,
} from '../components/RateLimitEditor';
import { ProviderModelsDialog } from '../components/ProviderModelsDialog';
import { SearchInput } from '../components/SearchInput';
import { Dialog } from '../components/Dialog';
import { ScrollTable, type ScrollTableColumn } from '../components/ScrollTable';
import { AddCredentialDialog } from '../components/AddCredentialDialog';
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
import { FALLBACK_NPM_VOCABULARY } from '../lib/npm-vocabulary';
import { failureCaption } from '../lib/quotaFailure';

import { FONT_MONO } from '../lib/fonts';
import { copyToClipboard } from '../lib/clipboard';
/** Shared provider display sort: localized display name A→Z (case-insensitive),
 *  falling back to the id when a row carries no display name (def-only
 *  providers often have no `name`), with id as the stable tiebreak. Both the
 *  Connected tab and the catalog "All" tab render through this — the raw wire
 *  orders (providers.json write order, models.dev source order) carry no
 *  meaning for finding a provider. */
const byDisplayName = (a: { id: string; name?: string }, b: { id: string; name?: string }): number =>
  (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { sensitivity: 'base' }) ||
  a.id.localeCompare(b.id);
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
            style={{ fontSize: 'var(--text-sm)', fontFamily: FONT_MONO }}
            placeholder={t('op.headerNamePh')}
            value={r.name}
            disabled={disabled}
            onChange={e => setRow(i, { name: e.target.value })}
          />
          <input
            className="input"
            style={{ fontSize: 'var(--text-sm)', fontFamily: FONT_MONO }}
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
    <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-semibold)', color: 'var(--text-dim)' }}>
      {label}
      {required && <span style={{ color: 'var(--accent-rose)', marginLeft: 3 }} aria-hidden>*</span>}
    </span>
    {children}
  </div>
);

/** Provider logo on the fixed light `--logo-plate-bg` plate, unfiltered
 *  (see index.css). Falls back to an initial-letter chip. */
const ProviderLogo: React.FC<{ id: string; logo?: string; size?: number }> = ({ id, logo, size = 28 }) => {
  const [failed, setFailed] = useState(false);
  const chip: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.max(6, size * 0.28),
    background: 'var(--logo-plate-bg)',
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
            fontWeight: 'var(--font-extrabold)',
            fontSize: size * 0.52,
            color: 'var(--logo-plate-ink)',
            textTransform: 'uppercase',
            lineHeight: 'var(--leading-none)',
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
        style={{ objectFit: 'contain' }}
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
  fontSize: 'var(--text-2xs)',
  fontWeight: 'var(--font-semibold)',
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
  fontSize: 'var(--text-xs)',
  fontWeight: 'var(--font-semibold)',
  color: 'var(--text-dim)',
  borderBottom: '1px solid var(--divider)',
  paddingBottom: 6,
};
const syncTimeCell: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  fontSize: 'var(--text-sm)',
  color: 'var(--text-main)',
};
const syncOutcomeStyle: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  color: 'var(--text-dim)',
  lineHeight: 'var(--leading-snug)',
};

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

type CredentialZoomRowProps = {
  credential: CredentialHealth;
  caps: CredentialStoreCapabilities;
  /** The zoom table's weight column exists only for a store that carries one;
   *  header and every row cell must agree or the measured column tracks shift. */
  showWeight: boolean;
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
  /**
   * Commit a new spread weight for THIS credential (zoom-table editor; absent
   * = the store cannot carry weights, the row renders a read-only ×N badge).
   */
  onEditWeight?: (a: CredentialHealth, weight: number) => void;
  /** 1-based chain slot in the list; the chain head is always #1. */
  position: number;
};

/** Compact icon-button look shared by every per-credential action. */
const CRED_ICON_BTN: React.CSSProperties = { padding: '2px 6px', fontSize: 'var(--text-xs)', lineHeight: 'var(--leading-none)' };
/** One row height for every zoom-table control: the number input, the icon
 *  buttons and the status chips all sit on the same 28px baseline. */
const ZOOM_CTRL: React.CSSProperties = { height: 28, minHeight: 0, padding: '2px 6px', lineHeight: 1, fontSize: 'var(--text-sm)' };
const CRED_ICON_BTN_LG: React.CSSProperties = { ...ZOOM_CTRL, padding: '2px 7px' };

/**
 * Status badges for one credential — used by the maintenance (zoom) table so
 * the table can never disagree with itself on what a row "says". Word badges
 * keep icon + text; icon-only markers lean on `title`.
 */
const CredentialStatusBadges: React.FC<{ credential: CredentialHealth; remaining: number }> = ({ credential, remaining }) => {
  const { t } = useI18n();
  return (
    <>
      {/* Leading state slot: a fixed width keeps the timing/limit chips that
          follow aligned across rows, whether or not this row is disabled. */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, minWidth: 58, flex: '0 0 58px' }}>
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
      </span>
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
 * (Decision 1: capability-first) used by the maintenance (zoom) table.
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

/** Head cells for the ScrollTable: override its uppercase label treatment
 *  (wrong for CJK) and clip short labels to the fixed column tracks. */
const ZOOM_HEAD: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  fontWeight: 'var(--font-bold)',
  color: 'var(--text-dim)',
  padding: '7px 6px',
  textTransform: 'none',
  letterSpacing: 'normal',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const ZOOM_TD: React.CSSProperties = {
  padding: '6px 10px',
  borderBottom: '1px solid var(--divider)',
  verticalAlign: 'middle',
  whiteSpace: 'nowrap',
};

/** One credential of the maintenance (zoom) dialog — a table row: the labels
 *  live in the column headers, the actions stay icon-only (hover for the
 *  full name). */
const CredentialZoomRow: React.FC<CredentialZoomRowProps> = ({
  credential,
  caps,
  showWeight,
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
  onEditWeight,
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
      <td style={{ ...ZOOM_TD, textAlign: 'center', color: 'var(--text-dim)', fontWeight: 'var(--font-semibold)', fontSize: 'var(--text-sm)' }}>
        #{position}
      </td>
      <td style={{ ...ZOOM_TD, fontWeight: 'var(--font-bold)', fontSize: 'var(--text-base)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }} title={name}>
        {renaming ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input
              className="input"
              style={{ fontSize: 'var(--text-md)', width: 180 }}
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
      <td style={{ ...ZOOM_TD, fontSize: 'var(--text-md)', fontFamily: FONT_MONO, color: 'var(--text-dim)', maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
      {/* Weight: editable only when the bound store can carry one (OCR file);
          v2-bound rows render the read-only badge. Blur/Enter commits, the
          backend clamps — the input mirrors the same 1..MAX range. The column
          exists only when showWeight, matching the conditional header so the
          measured tracks never shift. */}
      {showWeight && (
        <td style={{ ...ZOOM_TD, textAlign: 'center' }}>
          {caps?.weight && onEditWeight ? (
            <input
              type="number"
              className="input"
              min={1}
              max={CREDENTIAL_WEIGHT_MAX}
              key={credential.weight ?? 1}
              defaultValue={credential.weight ?? 1}
              disabled={pending}
              aria-label={t('op.credentialWeight')}
              style={{ ...ZOOM_CTRL, width: 58, fontSize: 'var(--text-md)', textAlign: 'center' }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              onBlur={(e) => {
                const n = Math.floor(Number(e.target.value));
                const clamped = Number.isFinite(n) ? Math.min(Math.max(n, 1), CREDENTIAL_WEIGHT_MAX) : 1;
                if (clamped !== (credential.weight ?? 1)) onEditWeight(credential, clamped);
                else e.target.value = String(credential.weight ?? 1);
              }}
            />
          ) : (
            (credential.weight ?? 1) > 1 && (
              <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
                ×{credential.weight}
              </span>
            )
          )}
        </td>
      )}
      {/* Status: left-aligned so badges start at the same x on every row. The
          conditional state badge lives in a fixed-width leading slot inside
          CredentialStatusBadges, so the timing/limit chips never shift. */}
      <td style={ZOOM_TD}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <CredentialStatusBadges credential={credential} remaining={remaining} />
          {/* Suspect-clear is a per-row conditional (suspect rows only), so it
              rides the status cell instead of an always-empty column. */}
          {action('clearSuspect')}
          {/* Explicit "normal" word: an empty cell reads as broken data. */}
          {!credential.disabled && !credential.suspect && remaining <= 0 && (credential.limits ?? []).length === 0 && !credential.quota && (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{t('op.credentialZoomStatusNormal')}</span>
          )}
        </span>
      </td>
      {/* One action per column — the short header above names the action; the
          full label stays on the button's title / aria-label. */}
      {(['pin', 'test', 'limits', 'toggle', 'disconnect'] as const).map((kind) => (
        <td key={kind} style={{ ...ZOOM_TD, padding: '6px 2px', textAlign: 'center' }}>
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
        style={{ fontSize: 'var(--text-sm)', width: '100%', marginBottom: 8 }}
        placeholder={t('op.copyKeyPassword')}
        value={password}
        onChange={(e) => onPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onConfirm();
          if (e.key === 'Escape') onCancel();
        }}
      />
      {error && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-rose)' }}>{error}</div>}
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
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', color: 'var(--text-dim)', marginBottom: 6 }}>
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
                    fontSize: 'var(--text-sm)',
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
  // Unified add-credential dialog: every provider card (connected quick-add,
  // catalog connect) opens the SAME dialog; it hosts the key form and hands
  // web-login-capable providers over to the device-flow dialog.
  const [addCredential, setAddCredential] = useState<{
    id: string;
    name: string;
    webLogin?: boolean;
    webLoginSubmit?: boolean;
    authTypes?: PluginAuthType[];
    keyHint?: string;
  } | null>(null);
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
  // Three-state catalog filter (all / connected / unconnected). The old binary
  // "hide connected" toggle could not answer "which catalog entries have I
  // already connected?" — the segmented filter covers both directions.
  const [catalogFilter, setCatalogFilter] = useState<'all' | 'connected' | 'unconnected'>('all');
  // Origin filter: 'all' | 'builtin' | 'custom' | 'plugin' (any) | a plugin id.
  const [catalogOrigin, setCatalogOrigin] = useState('all');
  const [connectedQuery, setConnectedQuery] = useState('');
  const [connectedOrigin, setConnectedOrigin] = useState('all');
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
  // wire truth is backend data, not a frontend copy. Catalog-observed packages
  // do NOT ride through: the catalog carries unroutable SDKs (azure, bedrock,
  // vertex — SDK-side signing) and v2-package spellings that duplicate their
  // alias entries. Anything else can still be typed into the custom field.
  const npmOptions = useMemo(
    () => (npmVocabulary.length > 0 ? npmVocabulary.map((e) => e.alias) : FALLBACK_NPM_VOCABULARY.map((e) => e.alias)),
    [npmVocabulary]
  );

  const connectedIds = useMemo(() => new Set(ocProviders.map((p) => p.id)), [ocProviders]);
  // "Hide connected" in the catalog tab means HAS A CREDENTIAL — a merely
  // defined provider (e.g. a plugin-registered preset awaiting its key) must
  // stay searchable; connectedIds is the pre-write snapshot for the connect flow.
  const keyedProviderIds = useMemo(() => new Set(ocProviders.filter((p) => p.auth.connected).map((p) => p.id)), [ocProviders]);

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
  // Full probe-failure text for the card's failure-detail dialog: the row
  // itself only shows the classification (see composeProbeErrorShort).
  const [probeDetail, setProbeDetail] = useState<{ providerId: string; error: string } | null>(null);

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

  /** Spread weight commit (zoom-table editor). Shapes NEW-session placement only. */
  const handleCredentialWeight = async (a: CredentialHealth, weight: number) => {
    setPendingCredential(`${a.providerId}:${a.id}`);
    try {
      const res = await opencodeApi.setProviderCredentialWeight(a.providerId, a.id, weight);
      applyCredentialList(a.providerId, res.credentials);
      toast.success(t('op.credentialWeightSet', { label: credentialName(a, t('op.credentialUnnamed')), weight }));
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
      if (!(await copyToClipboard(res.key))) {
        // A failed clipboard write is NOT an API error: surface the localized
        // copy toast instead of routing a machine token through reasonError.
        toast.error(t('op.copyFailed'));
        return;
      }
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
      if (!(await copyToClipboard(res.key))) {
        setRevealError(t('op.copyFailed'));
        return;
      }
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

  // Origin-filter predicate shared by both tabs: builtin = covered by the
  // built-in models.dev catalog; custom = self-declared AND plugin-free
  // (plugin rows answer to the plugin / per-plugin options instead).
  const matchOrigin = (origin: string, p: { custom: boolean; pluginOrigin?: string }): boolean =>
    origin === 'builtin'
      ? !p.custom
      : origin === 'custom'
        ? p.custom && !p.pluginOrigin
        : origin === 'plugin'
          ? Boolean(p.pluginOrigin)
          : origin === 'all' || p.pluginOrigin === origin;
  // One origin-dropdown option list for both tabs (built from each tab's own
  // plugin id set).
  const originFilterOptions = (pluginIds: string[]) => [
    { value: 'all', label: t('op.filterOriginAll') },
    { value: 'builtin', label: t('op.filterOriginBuiltin') },
    { value: 'custom', label: t('op.filterOriginCustom') },
    { value: 'plugin', label: t('op.filterOriginPlugin') },
    ...pluginIds.map((id) => ({ value: id, label: `${t('op.pluginTag')} · ${id}` })),
  ];
  // Plugin ids among connected providers (mirrors the catalog tab's origin
  // dropdown options).
  const connectedPluginIds = useMemo(
    () => [...new Set(ocProviders.map((p) => p.pluginOrigin).filter((p): p is string => Boolean(p)))],
    [ocProviders]
  );
  const connectedResults = useMemo(() => {
    const q = connectedQuery.trim().toLowerCase();
    const list = q
      ? ocProviders.filter(
          (p) =>
            p.id.toLowerCase().includes(q) ||
            (p.name || '').toLowerCase().includes(q) ||
            (p.baseURL || '').toLowerCase().includes(q) ||
            p.models.some((m) => m.toLowerCase().includes(q))
        )
      : [...ocProviders];
    return list.filter((p) => matchOrigin(connectedOrigin, p)).sort(byDisplayName);
  }, [ocProviders, connectedQuery, connectedOrigin]);
  const pagedConnected = useMemo(() => {
    const start = (connectedPage - 1) * connectedPageSize;
    return connectedResults.slice(start, start + connectedPageSize);
  }, [connectedResults, connectedPage, connectedPageSize]);

  const catalogResults = useMemo(() => {
    const q = catalogQuery.trim().toLowerCase();
    let list = q
      ? catalog.filter((c) => (c.id || '').toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q))
      : [...catalog];
    if (catalogFilter !== 'all') {
      const wantConnected = catalogFilter === 'connected';
      list = list.filter((c) => keyedProviderIds.has(c.id) === wantConnected);
    }
    list = list.filter((c) => matchOrigin(catalogOrigin, c));
    // Same display sort as the Connected tab — a copy, never the state array.
    return list.sort(byDisplayName);
  }, [catalog, catalogQuery, catalogFilter, catalogOrigin, keyedProviderIds]);
  // Plugin ids present in the catalog (for the origin filter dropdown).
  const catalogPluginIds = useMemo(
    () => [...new Set(catalog.map((c) => c.pluginOrigin).filter((p): p is string => Boolean(p)))],
    [catalog]
  );

  // Web-login capability for the unified add-credential dialog: only catalog
  // rows carry webLogin/webLoginSubmit (plugin-driven), so connected-tab cards
  // resolve it through the same catalog snapshot — never a duplicated flag.
  const webLoginByProvider = useMemo(
    () => new Map(catalog.map((c) => [c.id, { webLogin: c.webLogin, webLoginSubmit: c.webLoginSubmit, authTypes: c.authTypes, keyHint: c.keyHint }])),
    [catalog]
  );

  const pagedCatalog = catalogResults.slice(
    (catalogPage - 1) * catalogPageSize,
    catalogPage * catalogPageSize
  );

  const tabBtn = (tab: typeof activeTab, label: string, count?: number): React.CSSProperties => ({
    padding: '7px 14px',
    borderRadius: '8px',
    fontSize: 'var(--text-md)',
    fontWeight: activeTab === tab ? 'var(--font-bold)' : 'var(--font-medium)',
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

  /**
   * Provider-level operator takedown — the coarse counterpart of the
   * per-credential switch. The card, defs node, models and credentials all
   * stay; the backend drops the provider from the routing pool in the same
   * request, so `/v1/models` follows immediately and a single click restores
   * exactly the previous pool.
   */
  const handleToggleProviderDisabled = async (p: OpenCodeProviderView) => {
    const disabling = !p.disabled;
    if (disabling) {
      const ok = await confirmDialog({
        title: t('op.providerDisableConfirmTitle', { id: p.id }),
        description: t('op.providerDisableConfirmDesc', { n: p.modelsCount ?? p.models.length }),
        danger: true,
        confirmLabel: t('op.providerDisable'),
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      if (disabling) await opencodeApi.disableProvider(p.id);
      else await opencodeApi.enableProvider(p.id);
      toast.success(t(disabling ? 'op.providerDisabledToast' : 'op.providerEnabledToast', { id: p.id }));
      await loadOpenCodeProviders();
    } catch (err) {
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
          <span style={{ fontWeight: 'var(--font-bold)', fontSize: 'var(--text-lg)' }}>{t('op.title')}</span>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', margin: '0 0 16px' }} title={ocPaths.configPath}>{t('op.desc', { sink: sinkLabel })}</p>

        {notice && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: noticeTone === 'err' ? 'color-mix(in srgb, var(--accent-rose) 12%, transparent)' : 'color-mix(in srgb, var(--accent-emerald) 15%, transparent)', border: `1px solid ${noticeTone === 'err' ? 'color-mix(in srgb, var(--accent-rose) 30%, transparent)' : 'color-mix(in srgb, var(--accent-emerald) 30%, transparent)'}`, color: noticeTone === 'err' ? 'var(--accent-rose)' : 'var(--accent-emerald)', fontSize: 'var(--text-md)', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            {noticeTone === 'err' ? <AlertTriangle size={16} /> : <Check size={16} />}
            <span>{notice}</span>
          </div>
        )}
        {ocError && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'color-mix(in srgb, var(--accent-rose) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-rose) 30%, transparent)', color: 'var(--accent-rose)', fontSize: 'var(--text-md)', marginBottom: '16px' }}>
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
        {/* Full-height flex column: the store-status note + filter toolbar stay
            pinned, only the provider card grid scrolls in the nested container. */}
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        {storeStatus && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '0 0 12px', flexShrink: 0 }}>
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
                style={{ fontSize: 'var(--text-2xs)', fontFamily: FONT_MONO, color: 'var(--text-muted)', maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={`${t('op.storeCredentialFile')}: ${storeStatus.credentialFile}`}
              >
                {storeStatus.credentialFile}
              </span>
            </div>
            {storeStatus.excluded.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
                <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-semibold)', color: 'var(--text-dim)' }}>
                  {t('op.excludedTitle', { n: storeStatus.excluded.length })}
                </span>
                {storeStatus.excluded.map((e) => (
                  <div key={`${e.provider}:${e.reasonCode}`} style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }} title={e.detail}>
                    <span style={{ fontFamily: FONT_MONO }}>{e.provider}</span>
                    <span> — {t(EXCLUDED_REASON_LABEL[e.reasonCode] ?? e.reasonCode)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {/* Divider under the toolbar separates the filter controls from the
            provider card grid (the catalog tab has the same rule). */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0, borderBottom: '1px solid var(--card-border)', paddingBottom: 12, marginBottom: 14 }}>
          {/* Origin filter leads the toolbar: it is the coarsest selector, so
              it sits leftmost and the search/filter controls refine within it
              (same layout as the catalog tab). */}
          <Combobox
            style={{ fontSize: 'var(--text-sm)', flexShrink: 0, width: 'fit-content', minWidth: 180 }}
            forceFilter
            value={connectedOrigin}
            onChange={(v) => { setConnectedOrigin(v || 'all'); setConnectedPage(1); }}
            placeholder={t('op.filterOrigin')}
            options={originFilterOptions(connectedPluginIds)}
          />
          <SearchInput
            style={{ maxWidth: 420 }}
            placeholder={t('op.searchConnected')}
            value={connectedQuery}
            onChange={(v) => { setConnectedQuery(v); setConnectedPage(1); }}
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
            (minus gaps), so a wide screen never stretches 4+ cards into slivers.
            The 340px floor is deliberate: below ~1050px of row width three cards
            cramp (URL text truncates, action rows wrap), so mid-size windows
            drop to 2 columns instead.
            auto-fill (not auto-fit): empty tracks keep their width, so a single
            card sits at one-third of the row instead of stretching full width. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(max(340px, calc((100% - 28px) / 3)), 1fr))', gap: '14px' }}>
          {pagedConnected.map(p => {
            const credentialList = credentialsByProvider.get(p.id) ?? [];
            const caps = storeStatus?.capabilities;
            // Live = routable AND not taken down; a disabled row is in neither
            // the spread nor the failover pool, so it never counts when deciding
            // whether the card may look live.
            const liveIds = credentialList.filter((a) => a.routable && !a.disabled).map((a) => a.id);
            // Pill tint / dot colour; text stays dim when everything is live.
            const healthColor = liveIds.length === 0 ? 'var(--accent-rose)' : liveIds.length < credentialList.length ? 'var(--accent-amber)' : 'var(--accent-emerald)';
            // Key writes need a registered integration (see canWriteCredential).
            const keyWritable = canWriteCredential(p.id);
            return (
            <div key={p.id} className="sub-card" style={cardFlex}>
              {/* Header: identity left, credential status pill right. The
                  pill is the card's health readout AND its maintenance entry
                  (dot + live/total), so the corner carries information instead
                  of a row of identical icon buttons. */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <ProviderLogo id={p.id} logo={p.logo} size={44} />
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 2 }}>
                  <span style={{ fontWeight: 'var(--font-bold)', fontSize: 'var(--text-base)', fontFamily: FONT_MONO, lineHeight: 1.25, overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }} title={p.id}>{p.id}</span>
                  {p.name && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.name}>{p.name}</span>}
                </div>
                {caps && credentialList.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                    {/* Read-only health readout — NOT a control. */}
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 7,
                        fontSize: 'var(--text-xs)',
                        fontVariantNumeric: 'tabular-nums',
                        color: liveIds.length === 0 ? 'var(--accent-rose)' : liveIds.length < credentialList.length ? 'var(--accent-amber)' : 'var(--text-dim)',
                      }}
                      title={
                        liveIds.length === 0
                          ? t('op.credentialsAllDisabledTip')
                          : liveIds.length > 1
                            ? t('op.credentialsSpreadHint', { n: liveIds.length })
                            : t('op.credentialChainHeadTip')
                      }
                    >
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          flexShrink: 0,
                          background: healthColor,
                        }}
                      />
                      {liveIds.length} / {credentialList.length}
                    </span>
                    {/* Maintenance entry, deliberately separate from the
                        status so reading health never triggers an action. */}
                    <button
                      className="btn btn-sm"
                      title={t('op.credentialManage')}
                      aria-label={t('op.credentialManage')}
                      onClick={() => setZoomProviderId(p.id)}
                    >
                      <Key size={12} />
                    </button>
                  </div>
                )}
              </div>

              {/* Meta: endpoint on its own line (single-line ellipsis keeps
                  every card's meta block the same height), then identity chips
                  with the provider utilities right-aligned on the same row.
                  `models` is the DEF-NODE list and is the routing truth: the
                  boot pool excludes a provider with no maintained models even
                  when the catalog knows some (see the "[OCR] excluded" log). */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                {/* The endpoint line is always present; an absent baseURL is
                    stated instead of leaving a silently empty row. */}
                {p.baseURL ? (
                  <span style={{ fontSize: 'var(--text-xs)', fontFamily: FONT_MONO, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.baseURL}>
                    {p.baseURL}
                  </span>
                ) : (
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontStyle: 'italic' }}>
                    {t('op.noBaseUrl')}
                  </span>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, rowGap: 4, flexWrap: 'wrap' }}>
                    {p.disabled && (
                      <span
                        style={{ ...badgeStyle('var(--accent-rose)', 'color-mix(in srgb, var(--accent-rose) 12%, transparent)'), display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}
                        title={p.disabledReason ? `${t('op.providerDisabledBadge')} — ${p.disabledReason}` : t('op.providerDisabledBadge')}
                      >
                        <PowerOff size={9} />
                        {t('op.providerDisabledBadge')}
                      </span>
                    )}
                    {displayNpm(p.npm) && (
                      <span
                        style={{ ...badgeStyle('var(--text-dim)', 'var(--chip-bg)'), fontFamily: FONT_MONO, fontSize: 'var(--text-2xs)', flexShrink: 0 }}
                        title={`${displayNpm(p.npm)} — ${t('catalogPage.ocrEditNpmHint')}`}
                      >
                        {displayNpm(p.npm)!.replace('@ai-sdk/', '')}
                      </span>
                    )}
                    {p.custom && <span style={badgeStyle('var(--accent)', 'var(--accent-bg)')} title={t('op.badgeCustomTip')}>{t('op.badgeCustom')}</span>}
                    {p.auth.inline && (
                      <span style={{ ...badgeStyle('var(--accent-amber)', 'color-mix(in srgb, var(--accent-amber) 12%, transparent)'), display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <Key size={9} />
                        {t('op.badgeInline')}
                      </span>
                    )}
                    {p.auth.type === 'oauth' && <span style={badgeStyle('var(--hue-violet)', 'var(--hue-violet-soft)')}>{t('op.badgeOauth')}</span>}
                    {/* No maintained def-node models = the boot pool excludes
                        this provider ("no models maintained in the config"),
                        so nothing routes. Plain text signal instead of another
                        bordered pill: ten cards showing it must not read as
                        ten alerts. */}
                    {p.models.length === 0 && (
                      <button
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--accent-amber)', fontSize: 'var(--text-2xs)', fontWeight: 'var(--font-semibold)', lineHeight: 1.4 }}
                        disabled={busy}
                        title={t('op.pmEmptyBadgeTip')}
                        aria-label={t('op.pmEmptyBadgeTip')}
                        onClick={() => setModelsPanelId(p.id)}
                      >
                        <AlertTriangle size={9} />
                        {t('op.pmEmptyBadge')}
                      </button>
                    )}
                    {/* The api-key sink badge ("credentials.json") was removed:
                        the bound store is PAGE-level truth (stated in the tab
                        descriptions), identical on every card — a per-card
                        repetition carried zero information. */}
                  </div>
                  {/* Provider utilities: quiet ghost icons in a delimited
                      group, sharing the chips row so no row is half empty. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, paddingLeft: 8, borderLeft: '1px solid var(--divider)' }}>
                    {p.defNode && (
                      <button
                        className="btn btn-sm"
                        style={{ border: 'none', background: 'transparent', boxShadow: 'none', padding: '0 6px', height: 24, minHeight: 24, color: 'var(--text-dim)' }}
                        disabled={busy}
                        title={t('op.editDefTitle')}
                        aria-label={t('op.editDefTitle')}
                        onClick={() => openDefEdit(p)}
                      >
                        <Pencil size={12} />
                      </button>
                    )}
                    <button
                      className="btn btn-sm"
                      style={{ border: 'none', background: 'transparent', boxShadow: 'none', padding: '0 6px', height: 24, minHeight: 24, color: p.disabled ? 'var(--accent-emerald)' : 'var(--text-dim)' }}
                      disabled={busy || testingIds.size > 0 || testAll.running}
                      title={t(p.disabled ? 'op.providerEnable' : 'op.providerDisable')}
                      aria-label={t(p.disabled ? 'op.providerEnable' : 'op.providerDisable')}
                      onClick={() => handleToggleProviderDisabled(p)}
                    >
                      {p.disabled ? <Power size={12} /> : <PowerOff size={12} />}
                    </button>
                    <button
                      className="btn btn-sm"
                      style={{ border: 'none', background: 'transparent', boxShadow: 'none', padding: '0 6px', height: 24, minHeight: 24, color: 'var(--accent-rose)' }}
                      disabled={busy || testingIds.size > 0 || testAll.running}
                      title={t('op.deleteBtn')}
                      aria-label={t('op.deleteBtn')}
                      onClick={() => handleDelete(p)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>

              {/* Footer: the probe result gets its own line (squeezed beside
                  three buttons it wrapped one token per line), then the action
                  row. `margin-top: auto` + the divider keep button rows aligned
                  across a grid row regardless of how much meta each card
                  carries. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 'auto', paddingTop: 10, borderTop: '1px solid var(--divider)' }}>
                {testResults[p.id] && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 'var(--text-xs)',
                        fontFamily: FONT_MONO,
                        color: testResults[p.id].ok ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={testResults[p.id].ok ? `${testResults[p.id].model} · ${testResults[p.id].latencyMs} ms` : undefined}
                    >
                      {testResults[p.id].ok
                        ? `✓ ${testResults[p.id].model} · ${fmtLatency(testResults[p.id].latencyMs ?? NaN)}`
                        : `✗ ${testResults[p.id].errorShort || testResults[p.id].error || t('op.testFailMsg')}`}
                    </span>
                    {/* Failure detail behind an explicit click: the upstream
                        body is multi-line JSON, so a hover bubble is the wrong
                        surface — it overflows the card and cannot select or
                        copy. */}
                    {!testResults[p.id].ok && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ border: 'none', background: 'transparent', boxShadow: 'none', color: 'var(--accent-rose)', padding: '2px 4px', height: 18 }}
                        title={t('op.probeDetailOpen')}
                        aria-label={t('op.probeDetailOpen')}
                        onClick={() => {
                          const r = testResults[p.id];
                          if (r) setProbeDetail({ providerId: p.id, error: r.error || t('op.testFailMsg') });
                        }}
                      >
                        <AlertTriangle size={12} />
                      </button>
                    )}
                  </div>
                )}
                {/* All actions left-aligned in chain-of-use order: the write
                    action first, then the two diagnostics. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-sm"
                    disabled={!keyWritable}
                    title={
                      !keyWritable
                          ? t('op.integrationMissingTip')
                          : t(multiCredentialStore ? 'op.addKeyCredentialTip' : 'op.updateKeyTip')
                    }
                    onClick={() => setAddCredential({ id: p.id, name: p.name ?? p.id, ...(webLoginByProvider.get(p.id) ?? {}) })}
                  >
                    {multiCredentialStore ? <Plus size={12} /> : <Key size={12} />}
                    <span>{t(multiCredentialStore ? 'op.addKeyCredential' : 'op.updateKey')}</span>
                  </button>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
                  </div>
                </div>
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
            <div style={{ color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>{t('op.emptyConnected')}</div>
          )}
        </div>
        </div>
        </div>

        </>)}

        {activeTab === 'catalog' && (<>
        {/* ---- Connect catalog provider ---- */}
        {/* Full-height flex column: the source note + filter toolbar stay pinned,
            only the card grid scrolls inside the nested container below. */}
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <p style={{ color: 'var(--text-dim)', fontSize: 'var(--text-xs)', margin: '0 0 12px', flexShrink: 0 }}>
          {t('op.connectDesc')} · {t('op.catalogSource', { source: catalogSource || 'none' })}
        </p>
        {/* Divider under the toolbar separates the filter controls from the
            provider card grid below. */}
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, borderBottom: '1px solid var(--card-border)', paddingBottom: 12, marginBottom: 14 }}>
          {/* Origin filter leads the toolbar: it is the coarsest selector, so
              it sits leftmost and the search/filter controls refine within it. */}
          <Combobox
            style={{ fontSize: 'var(--text-sm)', flexShrink: 0, width: 'fit-content', minWidth: 180 }}
            forceFilter
            value={catalogOrigin}
            onChange={(v) => { setCatalogOrigin(v || 'all'); setCatalogPage(1); }}
            placeholder={t('op.filterOrigin')}
            options={originFilterOptions(catalogPluginIds)}
          />
          <SearchInput
            placeholder={t('op.searchCatalog')}
            value={catalogQuery}
            onChange={(v) => { setCatalogQuery(v); setCatalogPage(1); }}
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
          {/* Segmented control: one bordered pill, inner cells share edges —
              three lone buttons read as unrelated actions. */}
          <div style={{ display: 'inline-flex', border: '1px solid var(--card-border)', borderRadius: 8, overflow: 'hidden', flexShrink: 0 }}>
            {(['all', 'connected', 'unconnected'] as const).map((f) => (
              <button
                key={f}
                style={{
                  padding: '6px 14px',
                  fontSize: 'var(--text-sm)',
                  fontWeight: catalogFilter === f ? 'var(--font-bold)' : 'var(--font-medium)',
                  color: catalogFilter === f ? 'var(--accent)' : 'var(--text-dim)',
                  background: catalogFilter === f ? 'var(--surface-hover)' : 'transparent',
                  border: 'none',
                  borderRight: f !== 'unconnected' ? '1px solid var(--card-border)' : 'none',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
                onClick={() => { setCatalogFilter(f); setCatalogPage(1); }}
              >
                {f === 'all' ? t('op.filterAll') : f === 'connected' ? t('op.tabConnected') : t('op.filterUnconnected')}
              </button>
            ))}
          </div>
        </div>
        {/* Same responsive cap as the connected grid — one column rhythm across
            the page's tabs (3 cards per row on a wide screen, floor 280px).
            auto-fill keeps empty tracks, so few-card results don't stretch. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(max(280px, calc((100% - 20px) / 3)), 1fr))', gap: '10px' }}>
          {pagedCatalog.map(c => {
            // badge = HAS A CREDENTIAL — a merely-defined provider (plugin preset
            // awaiting its key) must not read as already connected
            const connected = keyedProviderIds.has(c.id);
            return (
              // Connected rows keep their place in the grid: static badge plus a
              // quick "add credential" affordance that opens the same inline key
              // editor as a fresh connect (connectProvider adds one credential).
              <div key={c.id} className="sub-card" style={{ ...cardFlex, padding: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <ProviderLogo id={c.id} logo={c.logo} size={38} />
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontWeight: 'var(--font-bold)', fontSize: 'var(--text-md)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                    <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', fontFamily: FONT_MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.id}</span>
                  </div>
                  {c.npm && (
                    <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', fontFamily: FONT_MONO, flexShrink: 0, border: '1px solid var(--chip-bg)', borderRadius: 4, padding: '1px 4px' }} title={t('catalogPage.ocrEditNpmHint')}>
                      {(displayNpm(c.npm) || '').replace('@ai-sdk/', '')}
                    </span>
                  )}
                  {c.pluginOrigin && (
                    <span
                      style={{ fontSize: 'var(--text-2xs)', color: 'var(--accent)', flexShrink: 0, border: '1px solid color-mix(in srgb, var(--accent) 45%, transparent)', borderRadius: 4, padding: '1px 4px' }}
                      title={t('op.pluginOriginTip', { plugin: c.pluginOrigin })}
                    >
                      {t('op.pluginTag')}
                    </span>
                  )}
                  {(c.baseURL || c.api) && (
                    <button
                      className="btn btn-sm"
                      style={{ flexShrink: 0, padding: '2px 4px' }}
                      title={`${c.baseURL || c.api} — ${t('op.copyBaseUrl')}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void copyToClipboard(c.baseURL || c.api!).then((ok) => {
                          showNotice(
                            ok ? t('op.baseUrlCopied') : t('common.failed'),
                            ok ? 'ok' : 'err',
                          );
                        });
                      }}
                    >
                      <Copy size={11} />
                    </button>
                  )}
                </div>
                {/* marginTop auto absorbs the slack so the meta + status rows sit
                    at the card bottom and align across the grid row. */}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', marginTop: 'auto' }}>
                  <span>{t('op.modelsCount', { n: c.modelCount })}</span>
                  {typeof c.priceFrom === 'number' && (
                    <span style={{ color: 'var(--accent-emerald)' }}>{t('op.priceFrom', { price: c.priceFrom })}</span>
                  )}
                </div>
                {connected ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 0' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--accent-emerald)', flex: 1 }}>
                      <Check size={12} />
                      <span>{t('op.alreadyConnected')}</span>
                    </span>
                    <button
                      className="btn btn-sm"
                      disabled={!canWriteCredential(c.id)}
                      title={canWriteCredential(c.id) ? t('op.addCredentialQuickTip') : t('op.integrationMissingTip')}
                      onClick={() => setAddCredential({ id: c.id, name: c.name, webLogin: c.webLogin, webLoginSubmit: c.webLoginSubmit, authTypes: c.authTypes, keyHint: webLoginByProvider.get(c.id)?.keyHint })}
                    >
                      <Plug size={12} />
                      <span>{t('op.addCredentialQuick')}</span>
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className="btn btn-sm"
                      disabled={!canWriteCredential(c.id)}
                      title={!canWriteCredential(c.id) ? t('op.integrationMissingTip') : undefined}
                      onClick={() => setAddCredential({ id: c.id, name: c.name, webLogin: c.webLogin, webLoginSubmit: c.webLoginSubmit, authTypes: c.authTypes, keyHint: c.keyHint })}
                      style={{ flex: 1 }}
                    >
                      <Plug size={12} />
                      <span>{t('op.connectBtn')}</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {catalog.length === 0 && (
            <div style={{ color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>{t('op.catalogEmpty')}</div>
          )}
        </div>
        </div>
        </div>

        </>)}

        {activeTab === 'custom' && (<>
        {/* ---- Custom provider form ---- */}
        <p style={{ color: 'var(--text-dim)', fontSize: 'var(--text-xs)', margin: '0 0 12px' }}>{t('op.customDesc')}</p>
        {/* Capped two-column form (was an uncapped 3-col grid that stretched every
            input to ~900px on wide screens). Base URL spans the row — it is the one
            long value; the inline switch lives INSIDE the key cell so the pair reads
            as one control. auto-fit collapses to a single column below ~580px. */}
        <div style={{ maxWidth: 720, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: '12px 14px' }}>
          <FormField label={t('op.fId')} required>
            <input className="input" style={{ fontSize: 'var(--text-sm)' }} placeholder={t('op.phId')} value={form.id} onChange={e => setForm({ ...form, id: normalizeProviderIdInput(e.target.value) })} />
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('op.idRule')}</span>
          </FormField>
          <FormField label={t('op.fName')}>
            <input className="input" style={{ fontSize: 'var(--text-sm)' }} placeholder={t('op.phName')} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          </FormField>
          <FormField label={t('op.fBaseUrl')} required style={{ gridColumn: '1 / -1' }}>
            <input className="input" style={{ fontSize: 'var(--text-sm)' }} placeholder={t('op.phBaseUrl')} value={form.baseURL} onChange={e => setForm({ ...form, baseURL: e.target.value })} />
          </FormField>
          {/* Key cell spans the row: the inline-switch sentence needs the full
              720px to stay on one line, and long sk- values want the width too. */}
          <FormField label={t('op.fKey', { sink: sinkLabel })} style={{ gridColumn: '1 / -1' }}>
            <input className="input" style={{ fontSize: 'var(--text-sm)' }} placeholder={t('op.phKey')} value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} />
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: 2 }}>
              <Switch size="sm" checked={form.inline} onChange={v => setForm({ ...form, inline: v })} />
              <span>{t('op.fKeyInline')}</span>
            </label>
          </FormField>
          <FormField label={t('op.fPullPattern')} style={{ gridColumn: '1 / -1' }}>
            <input className="input" style={{ fontSize: 'var(--text-sm)', fontFamily: FONT_MONO }} placeholder={t('op.phPullPattern')} value={form.pullPattern} onChange={e => setForm({ ...form, pullPattern: e.target.value })} />
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('op.fPullPatternTip')}</span>
          </FormField>
          {/* AI SDK package is low-frequency (almost always the openai-compatible
              default) — parked last so the common path reads ID → name → URL → key. */}
          <FormField label={t('op.fNpmLabel')}>
            {npmChoice === CUSTOM_NPM ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="input" style={{ fontSize: 'var(--text-sm)', flex: 1, minWidth: 0 }} placeholder={t('op.fNpmCustom')} value={form.npm} onChange={e => setForm({ ...form, npm: e.target.value })} autoFocus />
                <button className="btn btn-sm" title={t('op.fNpmLabel')} onClick={() => { setNpmChoice(''); setForm({ ...form, npm: '' }); }}>↩</button>
              </div>
            ) : (
              <Combobox
                style={{ fontSize: 'var(--text-sm)', cursor: 'pointer' }}
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
        <p style={{ color: 'var(--text-dim)', fontSize: 'var(--text-xs)', lineHeight: 'var(--leading-relaxed)', margin: '0 0 7px' }}>{t('op.syncDesc')}</p>
        <p style={{ color: 'var(--text-dim)', fontSize: 'var(--text-xs)', lineHeight: 'var(--leading-relaxed)', margin: '0 0 14px' }}>{t('op.syncDescModes')}</p>
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
                <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--font-semibold)' }}>{c.label}</span>
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
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', color: 'var(--text-main)', cursor: 'pointer' }}
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
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', color: 'var(--text-main)', cursor: 'pointer' }}
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
          <div style={{ color: 'var(--text-dim)', fontSize: 'var(--text-sm)', marginTop: 10 }}>{t('op.syncEmpty')}</div>
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
        {/* Unified add-credential dialog — the ONLY surface for "hand this key
            to the store": connected quick-add, catalog connect and web-login-
            capable plugins all funnel here. Save announcements reuse the shared
            announceConnect rule; the device-flow callback refreshes catalog +
            connected views. */}
        {addCredential &&
          (() => {
            const ac = addCredential;
            return (
              <AddCredentialDialog
                providerId={ac.id}
                providerName={ac.name}
                webLogin={ac.webLogin}
                webLoginSubmit={ac.webLoginSubmit}
                authTypes={ac.authTypes}
                keyHint={ac.keyHint}
                multiCredential={multiCredentialStore}
                formatError={reasonError}
                onClose={() => setAddCredential(null)}
                onSaved={(res) => {
                  // connectedIds is the pre-write snapshot — a first connect is
                  // NOT in it yet; announce lands before refreshAll() returns.
                  announceConnect(res, ac.id);
                  setAddCredential(null);
                  refreshAll();
                }}
                onConnected={() => {
                  showNotice(t('op.webLoginDone'));
                  setAddCredential(null);
                  loadCatalog();
                  refreshAll();
                }}
              />
            );
          })()}

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

        {/* Per-provider credential maintenance — a TABLE: the labels live in
            the column headers, the actions stay icon-only (title + aria-label
            carry the full name), so the dialog stays narrow. Rows reuse the
            shared badge/action components, so availability logic cannot
            drift, and share the page-owned handler wiring. */}
        {zoomProviderId && ocProviders.some((x) => x.id === zoomProviderId) && (() => {
          const p = ocProviders.find((x) => x.id === zoomProviderId)!;
          const caps = storeStatus?.capabilities;
          const credentialList = credentialsByProvider.get(p.id) ?? [];
          const liveIds = credentialList.filter((a) => a.routable && !a.disabled).map((a) => a.id);
          const soleRoutableId = liveIds.length === 1 ? liveIds[0] : null;
          const masks = credentialList.map((a) => a.maskedKey ?? a.id);
          const ambiguousMasks = new Set(masks.filter((m, i) => masks.indexOf(m) !== i));
          const showWeight = Boolean(caps?.weight);
          const actLabel = (short: string, full: string) => <span title={full}>{short}</span>;
          const zoomColumns: ScrollTableColumn[] = [
            { key: 'position', label: '#', width: 36, align: 'center' },
            { key: 'name', label: t('op.credentialZoomColName'), width: 140 },
            { key: 'key', label: t('op.credentialZoomColKey'), width: 156 },
            ...(showWeight ? [{ key: 'weight', width: 64, align: 'center' as const, label: <>{t('op.credentialWeight')} <InfoTip text={t('op.credentialWeightTip')} /></> }] : []),
            { key: 'status', label: t('op.credentialZoomColStatus'), width: 200 },
            { key: 'pin', width: 44, align: 'center' as const, label: actLabel(t('op.credentialZoomColPin'), t('op.credentialPin')) },
            { key: 'test', width: 44, align: 'center' as const, label: actLabel(t('op.credentialZoomColTest'), t('op.credentialTest')) },
            { key: 'limits', width: 44, align: 'center' as const, label: actLabel(t('op.credentialZoomColLimits'), t('op.credentialLimits')) },
            { key: 'toggle', width: 44, align: 'center' as const, label: actLabel(t('op.credentialZoomColToggle'), `${t('op.credentialDisable')} / ${t('op.credentialEnable')}`) },
            { key: 'disconnect', width: 44, align: 'center' as const, label: actLabel(t('op.credentialZoomColDisconnect'), t('op.credentialDisconnect')), headStyle: { color: 'var(--accent-rose)' } },
          ];
          const zoomMinWidth = zoomColumns.reduce((sum, c) => sum + (typeof c.width === 'number' ? c.width : 0), 0);
          const rowProps = (a: CredentialHealth, i: number) => ({
            credential: a,
            position: i + 1,
            caps: caps!,
            showWeight,
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
            onEditWeight: handleCredentialWeight,
          });
          return (
            <Dialog
              title={p.id}
              subtitle={t('op.credentialZoomDesc')}
              onClose={() => setZoomProviderId(null)}
              closeLabel={t('common.close')}
              width={640}
              maxSize={{ width: 'min(860px, 94vw)' }}
              footerLeft={
                <button
                  className="btn btn-sm"
                  disabled={!canWriteCredential(p.id)}
                  title={
                    !canWriteCredential(p.id)
                      ? t('op.integrationMissingTip')
                      : t(multiCredentialStore ? 'op.addKeyCredentialTip' : 'op.updateKeyTip')
                  }
                  onClick={() => {
                    // Hand the screen to the add dialog: both are Dialog
                    // portals at the same layer, and the later-mounted one
                    // would otherwise sit UNDER this table.
                    setZoomProviderId(null);
                    setAddCredential({ id: p.id, name: p.name ?? p.id, ...(webLoginByProvider.get(p.id) ?? {}) });
                  }}
                >
                  {multiCredentialStore ? <Plus size={12} /> : <Key size={12} />}
                  <span>{t(multiCredentialStore ? 'op.addKeyCredential' : 'op.updateKey')}</span>
                </button>
              }
              footerRight={
                <button className="btn btn-sm" onClick={() => setZoomProviderId(null)}>
                  <span>{t('common.close')}</span>
                </button>
              }
            >
              {caps && credentialList.length > 0 && (
                <ScrollTable
                  minWidth={zoomMinWidth}
                  headCellStyle={ZOOM_HEAD}
                  columns={zoomColumns}
                >
                  {credentialList.map((a, i) => (
                    <CredentialZoomRow key={a.id} {...rowProps(a, i)} />
                  ))}
                </ScrollTable>
              )}
            </Dialog>
          );
        })()}

        {/* Probe failure detail: the card row keeps only the classification;
            the full (redacted, 600-char-bounded) upstream body lands here,
            where it stays inside the viewport and is selectable/copyable. */}
        {probeDetail && (
          <Dialog
            title={t('op.probeDetailTitle')}
            subtitle={probeDetail.providerId}
            onClose={() => setProbeDetail(null)}
            closeLabel={t('common.close')}
            width={720}
            footerLeft={
              <button
                className="btn btn-sm"
                onClick={async () => {
                  if (await copyToClipboard(probeDetail.error)) toast.success(t('op.probeDetailCopied'));
                  else toast.error(t('op.copyFailed'));
                }}
              >
                <Copy size={12} />
                <span>{t('common.copy')}</span>
              </button>
            }
            footerRight={
              <button className="btn btn-sm" onClick={() => setProbeDetail(null)}>
                <span>{t('common.close')}</span>
              </button>
            }
          >
            <pre
              style={{
                margin: 0,
                fontFamily: FONT_MONO,
                fontSize: 'var(--text-xs)',
                lineHeight: 'var(--leading-normal)',
                color: 'var(--text-main)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                userSelect: 'text',
              }}
            >
              {probeDetail.error}
            </pre>
          </Dialog>
        )}

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
              <div style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--font-bold)' }}>{t('op.editDefTitle')} — {editDef.id}</div>
              <FormField label={t('op.fName')}>
                <input className="input" style={{ fontSize: 'var(--text-sm)' }} value={editDef.name} onChange={e => setEditDef({ ...editDef, name: e.target.value })} />
              </FormField>
              <FormField label={t('op.fBaseUrl')}>
                <input className="input" style={{ fontSize: 'var(--text-sm)', fontFamily: FONT_MONO }} value={editDef.baseURL} onChange={e => setEditDef({ ...editDef, baseURL: e.target.value })} />
              </FormField>
              <FormField label={t('op.fNpmLabel')}>
                {/* Combobox, not a free input (repo dropdown convention). The
                    current value always rides first so a non-vocabulary def
                    stays visible; selections may also be cleared. */}
                <Combobox
                  style={{ fontSize: 'var(--text-sm)' }}
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
                <input className="input" style={{ fontSize: 'var(--text-sm)', fontFamily: FONT_MONO }} placeholder={t('op.phPullPattern')} value={editDef.pullPattern} onChange={e => setEditDef({ ...editDef, pullPattern: e.target.value })} />
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('op.fPullPatternTip')}</span>
              </FormField>
              <FormField label={t('op.fHeaders')}>
                <HeadersEditor rows={editDef.headerRows} onChange={headerRows => setEditDef({ ...editDef, headerRows })} disabled={savingDef} />
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('op.fHeadersTip')}</span>
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

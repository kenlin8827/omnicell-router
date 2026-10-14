import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Key, Check, RefreshCw, Trash2, Plug, Plus, Lock, Cpu, Zap, Upload, AlertTriangle, Star, Pencil, Unplug, Clock, ShieldAlert, Ban, PowerOff, Power, Copy } from 'lucide-react';
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
  type CredentialPushReasonCode,
  type AccountMeta,
  type AccountHealth,
  type CredentialWriteReasonCode,
  type CredentialRevealReasonCode,
} from '../lib/api';
import { ProviderModelsDialog } from '../components/ProviderModelsDialog';
import { useI18n } from '../i18n/I18nContext';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';
import { Combobox } from '../components/Combobox';
import { Pagination } from '../components/Pagination';
import { Switch } from '../components/Switch';
import { useModelTest } from '../lib/useModelTest';

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

/** Fallback npm packages when the models.dev catalog is unavailable. */
const FALLBACK_NPM_PACKAGES = [
  '@ai-sdk/openai-compatible',
  '@ai-sdk/anthropic',
  '@ai-sdk/openai',
  '@ai-sdk/google',
  '@ai-sdk/azure',
  '@ai-sdk/amazon-bedrock',
  '@ai-sdk/xai',
  '@ai-sdk/mistral',
];
const CUSTOM_NPM = '__custom__';

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

/** Provider logo on a light chip (models.dev SVGs are dark glyphs — invisible on
 *  the dark theme without a backing plate). Falls back to an initial-letter chip. */
const ProviderLogo: React.FC<{ id: string; logo?: string; size?: number }> = ({ id, logo, size = 28 }) => {
  const [failed, setFailed] = useState(false);
  const chip: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.max(6, size * 0.28),
    background: 'rgba(244, 244, 245, 0.95)',
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
            color: '#18181b',
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
        style={{ objectFit: 'contain' }}
        loading="lazy"
      />
    </div>
  );
};

// Outline badges: transparent fill, border derived from the text hue (the
// bg param is legacy at call sites — kept for signature stability).
const badgeStyle = (color: string, _bg: string): React.CSSProperties => ({
  background: 'transparent',
  color,
  fontSize: '10px',
  fontWeight: 600,
  padding: '2px 8px',
  borderRadius: '99px',
  border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
});

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

// ADR-0019 gap #8: the credential-store API serves machine-readable codes ONLY;
// these tables own all user-visible copy (unknown codes fall back to the raw
// code string — loud, never a wrong localized claim).
const STORE_KIND_LABEL: Partial<Record<CredentialStoreKind, string>> = {
  'opencode-v2': 'op.storeKindOpencodeV2',
  'opencode-v2-readonly': 'op.storeKindOpencodeV2Readonly',
  ocr: 'op.storeKindOcr',
};
const STORE_DEGRADED_LABEL: Partial<Record<CredentialStoreDegradedCode, string>> = {
  db_unreadable: 'op.storeDegradedDb',
  unsupported_version: 'op.storeDegradedV1',
  cli_absent_db_present: 'op.storeDegradedCli',
  bind_failed: 'op.storeDegradedBind',
};
const EXCLUDED_REASON_LABEL: Partial<Record<CredentialExcludedReasonCode, string>> = {
  db_unreadable: 'op.exclDbUnreadable',
  no_routable_credential: 'op.exclNoRoutable',
  reconcile_push_failed: 'op.exclReconcilePushFailed',
  bind_failed: 'op.exclBindFailed',
};
// Push-route 400 preconditions (backend PUSH_PRECONDITION_ERROR). ocJson keeps
// the machine code on the error; only KNOWN codes get a localized claim —
// unknown codes fall back to the raw string, loud over pretty-but-wrong.
const PUSH_REASON_LABEL: Partial<Record<CredentialPushReasonCode, string>> = {
  not_ocr_bound: 'op.pushNotOcrBound',
  opencode_v2_service_unreachable: 'op.pushOpencodeV2Unreachable',
  opencode_v2_db_unreadable: 'op.pushOpencodeV2DbUnreadable',
};
/**
 * Credential-store write reasonCodes — the per-account routes AND provider
 * connect/key/create share console.ts `mapStoreWriteFailure`.
 */
const WRITE_REASON_LABEL: Partial<Record<CredentialWriteReasonCode, string>> = {
  account_not_found: 'op.reasonAccountNotFound',
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
 * ADR-0019 Decision 10 reveal-route preconditions (console.ts `accountReveal`).
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
 * card. `ACCOUNT_ROW_HEIGHT_EST` is an ESTIMATE of a single-line AccountRow
 * (padding + the tallest of its mono chips / icon buttons); if the row style
 * changes, this constant must follow — an off-by-a-few cap only shows slightly
 * fewer rows. Upgrade path if it ever needs to be exact: measure the first
 * rendered row and drive max-height from it.
 */
const ACCOUNT_ROWS_VISIBLE = 3;
const ACCOUNT_ROW_HEIGHT_EST = 36;

/**
 * Credential display name: the operator's label, or a bare neutral placeholder.
 * OCR never invents a name, and the placeholder carries no fingerprint either —
 * unlabeled rows are already distinguished by their masked key, and get the
 * explicit `#fingerprint` chip when even that collides (see prefixVisible).
 */
function accountName(a: AccountMeta, unnamed: string): string {
  return a.label?.trim() || unnamed;
}

/** Short fingerprint chip text (`#abcdef0123`); the full value rides in the title. */
const PrefixChip: React.FC<{ account: AccountHealth }> = ({ account }) => {
  const { t } = useI18n();
  if (!account.keyHashPrefix) return null;
  return (
    <span
      style={{ ...badgeStyle('var(--text-dim)', 'var(--chip-bg)'), fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }}
      title={t('op.accountPrefixTip', { prefix: account.keyHashPrefix, id: account.id })}
    >
      #{account.keyHashPrefix.slice(0, 8)}
    </span>
  );
};

type AccountRowProps = {
  account: AccountHealth;
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
  /** v2-readonly binding: every credential write is refused (ADR-0019 Decision 2). */
  writesBlocked: boolean;
  /** This row has a request in flight — only one row is busy at a time. */
  pending: boolean;
  /** A connectivity probe for THIS credential row is in flight (multi-account: per-row, not per-card). */
  testing: boolean;
  /** Label edit mode is page-owned: it closes on the write's success, not before. */
  renaming: boolean;
  onStartRename: () => void;
  onCancelRename: () => void;
  /** Shared tick clock (cooldown chips). */
  now: number;
  onActivate: (a: AccountHealth) => void;
  onRename: (a: AccountHealth, label: string) => void;
  /** One-shot upstream probe with THIS row's exact key (bypasses head selection). */
  onTest: (a: AccountHealth) => void;
  onDisconnect: (a: AccountHealth) => void;
  onToggleDisabled: (a: AccountHealth) => void;
  onClearSuspect: (a: AccountHealth) => void;
  /**
   * ADR-0019 Decision 10: reveal re-enters the console LOGIN password, so the
   * copy affordance only exists where that password lives (webAuth active).
   * Disabled-with-reason, never silently absent — a mystery-disabled button is
   * the same UX bug as an unlabeled one.
   */
  canReveal: boolean;
  onCopyKey: (a: AccountHealth) => void;
  /** 1-based chain slot in the list. The chain head keeps the ★; every other
      row shows its slot number so the whole priority order is readable. */
  position: number;
};

/** One account of a multi-account provider — the ADR-0019 P3 drill-down row. */
const AccountRow: React.FC<AccountRowProps> = ({
  account,
  caps,
  soleServing,
  prefixVisible,
  writesBlocked,
  pending,
  testing,
  renaming,
  onStartRename,
  onCancelRename,
  now,
  onActivate,
  onRename,
  onTest,
  onDisconnect,
  onToggleDisabled,
  onClearSuspect,
  canReveal,
  onCopyKey,
  position,
}) => {
  const { t } = useI18n();
  const [labelDraft, setLabelDraft] = useState('');
  const remaining = account.cooldownUntilMs !== undefined ? account.cooldownUntilMs - now : 0;
  const name = accountName(account, t('op.accountUnnamed'));
  // Display truth: the active flag, or the only credential able to serve.
  // A takedown is never "serving", even when it is the store's active row or the
  // sole routable one — the operator took it out of routing on purpose.
  const serving = !account.disabled && (account.active || soleServing);

  // Action availability is capability-first, then the read-only binding gate
  // (Decision 1: branch on flags, never on `kind`). Disabled affordances keep
  // the existing blocked-tooltip pattern so the reason is never a mystery.
  const actionTip = (supported: boolean, okLabel: string) =>
    writesBlocked ? t('op.storeReadOnlyTip') : supported ? okLabel : t('op.reasonCapabilityUnsupported');
  // A non-routable row (oauth / wellknown / empty key) can never carry OCR
  // traffic, so "make it the chain head" has no routing effect — the only thing
  // it changes is which credential opencode itself uses. Say that, don't let the
  // button imply the gateway will start serving this key.
  const activateTip = !account.routable
    ? t('op.accountActivateNotRoutableTip')
    : actionTip(caps.activate, t('op.accountActivate'));

  // ONE line per credential: identity, status and actions share a single row so a
  // provider with several keys never outgrows its scroll cap. Word badges became
  // icon + tooltip for the same reason — `title` still carries the full claim.
  const rowIconBtn: React.CSSProperties = { padding: '2px 6px', fontSize: 11, lineHeight: 1 };

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
        // Serving state is already carried by the ★ chain-head marker — no
        // extra bar/border (redundant encoding was the box-in-box complaint).
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      {renaming ? (
        <>
          <input
            className="input"
            style={{ fontSize: 12, flex: 1, minWidth: 110 }}
            aria-label={t('op.accountLabelPlaceholder')}
            placeholder={t('op.accountLabelPlaceholder')}
            maxLength={80}
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter with an empty draft is the CLEAR gesture, not a no-op.
              if (e.key === 'Enter') onRename(account, labelDraft.trim());
              if (e.key === 'Escape') onCancelRename();
            }}
            autoFocus
          />
          <button
            className="btn btn-sm btn-primary"
            style={rowIconBtn}
            disabled={pending || labelDraft.trim() === (account.label?.trim() ?? '')}
            title={labelDraft.trim() ? t('op.accountRename') : t('op.accountClearLabel')}
            onClick={() => onRename(account, labelDraft.trim())}
          >
            <Check size={12} />
          </button>
          <button className="btn btn-sm" style={rowIconBtn} onClick={onCancelRename}>
            ✕
          </button>
        </>
      ) : (
        <>
          {/* Accent star = chain head. It does NOT mean "only this key serves":
              a multi-credential provider spreads NEW sessions across every
              healthy row (Decision 7), so the other rows are working too.
              Non-head rows show their 1-based slot number instead, so the
              whole fallback order is readable at a glance. */}
          {serving ? (
            <span
              style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--accent)' }}
              title={account.active ? t('op.accountChainHeadTip') : t('op.accountSoleServingTip')}
            >
              <Star size={12} fill="currentColor" />
            </span>
          ) : (
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
              title={t('op.accountChainHeadTip')}
            >
              #{position}
            </span>
          )}
          <span
            style={{ fontWeight: 700, fontSize: 12, flex: '0 1 auto', minWidth: 48, overflow: 'hidden', textOverflow: 'ellipsis' }}
            title={name}
          >
            {name}
          </span>
          {/* The fingerprint is a CORRELATION id (breaker state, SUSPECT flags,
              the Guardrails per-account trip and the logs all key on it), not
              something to read. So it lives in the masked key's tooltip, and the
              chip only appears when two rows of this provider mask to the same
              text — the one case where a row is otherwise ambiguous. */}
          {prefixVisible && <PrefixChip account={account} />}
          {account.maskedKey && (
            <span
              style={{
                fontSize: 11,
                fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace",
                color: 'var(--text-dim)',
                // Shrinkable so a narrow card clips the KEY, never the buttons
                // (the action group holds flexShrink:0 and must stay reachable).
                flex: '0 1 auto',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={account.keyHashPrefix ? t('op.accountPrefixTip', { prefix: account.keyHashPrefix, id: account.id }) : undefined}
            >
              {account.maskedKey}
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            {account.disabled && (
              <span
                style={{ ...badgeStyle('var(--accent-rose)', 'rgba(244,63,94,0.12)'), display: 'inline-flex', alignItems: 'center', gap: 3 }}
                title={account.disabledReason ? `${t('op.accountDisabledTip')} · ${account.disabledReason}` : t('op.accountDisabledTip')}
              >
                <PowerOff size={9} />
                {t('op.accountDisabled')}
              </span>
            )}
            {!account.routable && (
              <span style={{ display: 'inline-flex', color: 'var(--text-dim)' }} title={t('op.accountNotRoutableTip')}>
                <Ban size={11} />
              </span>
            )}
            {account.suspect && (
              <span style={{ display: 'inline-flex', color: 'var(--accent-rose)' }} title={t('op.accountSuspectTip')}>
                <AlertTriangle size={11} />
              </span>
            )}
            {remaining > 0 && (
              <span
                style={{ ...badgeStyle('var(--accent-amber)', 'rgba(245,158,11,0.12)'), display: 'inline-flex', alignItems: 'center', gap: 3 }}
                title={t('op.accountOpenPairs', { n: account.openPairs })}
              >
                <Clock size={9} />
                {formatCountdown(remaining)}
              </span>
            )}
            {/* Per-account connectivity probe: pins the store row THIS line
                names — the card-level Test only ever hits the head account. */}
            {account.routable && (
              <button
                className="btn btn-sm"
                style={rowIconBtn}
                disabled={testing || pending}
                title={testing ? t('op.testing') : t('op.accountTestTip')}
                aria-label={t('op.accountTest')}
                onClick={() => onTest(account)}
              >
                {testing ? (
                  <RefreshCw size={12} style={{ animation: 'ocr-spin 0.8s linear infinite' }} />
                ) : (
                  <Zap size={12} />
                )}
              </button>
            )}
            {!account.active && !account.disabled && (
              <button
                className="btn btn-sm"
                style={rowIconBtn}
                disabled={writesBlocked || !caps.activate || !account.routable || pending}
                title={activateTip}
                aria-label={t('op.accountActivate')}
                onClick={() => onActivate(account)}
              >
                <Star size={12} />
              </button>
            )}
            <button
              className="btn btn-sm"
              style={rowIconBtn}
              disabled={writesBlocked || !caps.rename || pending}
              title={actionTip(caps.rename, t('op.accountRename'))}
              aria-label={t('op.accountRename')}
              onClick={() => {
                setLabelDraft(account.label ?? '');
                onStartRename();
              }}
            >
              <Pencil size={12} />
            </button>
            {/* ADR-0019 Decision 10 — raw-key export for the row the operator
                can name. Only api-key rows have anything to reveal (oauth
                material never leaves any surface, ADR-0011 boundary). */}
            {account.type === 'api' && account.routable && (
              <button
                className="btn btn-sm"
                style={rowIconBtn}
                disabled={!canReveal || pending}
                title={canReveal ? t('op.accountCopyKey') : t('op.accountCopyNeedsAuthTip')}
                aria-label={t('op.accountCopyKey')}
                onClick={() => onCopyKey(account)}
              >
                <Copy size={12} />
              </button>
            )}
            {account.suspect && account.keyHashPrefix && (
              <button
                className="btn btn-sm"
                style={rowIconBtn}
                disabled={pending}
                title={t('op.accountClearSuspect')}
                aria-label={t('op.accountClearSuspect')}
                onClick={() => onClearSuspect(account)}
              >
                <ShieldAlert size={12} />
              </button>
            )}
            {/* Takedown first, destruction last: this is the safe lever, and the
                two must never be confused for one another. */}
            <button
              className="btn btn-sm"
              style={rowIconBtn}
              disabled={pending}
              title={account.disabled ? t('op.accountEnableTip') : t('op.accountDisableTip')}
              aria-label={account.disabled ? t('op.accountEnable') : t('op.accountDisable')}
              onClick={() => onToggleDisabled(account)}
            >
              {account.disabled ? <Power size={12} /> : <PowerOff size={12} />}
            </button>
            <button
              className="btn btn-sm"
              style={{ ...rowIconBtn, color: 'var(--accent-rose)' }}
              disabled={writesBlocked || pending}
              title={writesBlocked ? t('op.storeReadOnlyTip') : t('op.accountDisconnect')}
              aria-label={t('op.accountDisconnect')}
              onClick={() => onDisconnect(account)}
            >
              <Unplug size={12} />
            </button>
          </span>
        </>
      )}
    </div>
  );
};

type RevealDialogProps = {
  account: AccountHealth;
  password: string;
  error: string;
  busy: boolean;
  onPassword: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * ADR-0019 Decision 10 password gate. The raw key is NEVER rendered or held
 * here — the confirm handler passes the response straight to the clipboard.
 * The input draft is cleared by the caller on close (the page-lifetime unlock
 * keeps the verified password in a ref, out of the DOM).
 */
const RevealKeyDialog: React.FC<RevealDialogProps> = ({
  account,
  password,
  error,
  busy,
  onPassword,
  onCancel,
  onConfirm,
}) => {
  const { t } = useI18n();
  const name = accountName(account, t('op.accountUnnamed'));
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'var(--scrim)',
        display: 'flex',
        padding: 16,
        animation: 'ocr-fade-in 0.15s ease',
      }}
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('op.copyKeyTitle', { label: name })}
        style={{
          margin: 'auto',
          width: 400,
          maxWidth: '100%',
          padding: 16,
          borderRadius: 12,
          background: 'var(--card-bg, #111113)',
          border: '1px solid var(--card-border)',
          boxShadow: '0 16px 40px rgba(0,0,0,0.45)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{t('op.copyKeyTitle', { label: name })}</div>
        <p style={{ fontSize: 11.5, color: 'var(--text-dim)', margin: '0 0 12px', lineHeight: 1.6 }}>
          {t('op.copyKeyDesc')}
        </p>
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
        {error && <div style={{ fontSize: 11, color: 'var(--accent-rose)', margin: '2px 0 8px' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button className="btn btn-sm" onClick={onCancel}>
            <span>{t('common.cancel')}</span>
          </button>
          <button className="btn btn-sm btn-primary" disabled={busy || !password} onClick={onConfirm}>
            <Copy size={12} />
            <span>{busy ? t('op.copyKeyCopying') : t('op.copyKeyConfirm')}</span>
          </button>
        </div>
      </div>
    </div>
  );
};


export const KeysPage: React.FC = () => {
  const { t } = useI18n();
  const confirmDialog = useConfirm();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [ocProviders, setOcProviders] = useState<OpenCodeProviderView[]>([]);
  const [ocPaths, setOcPaths] = useState<{ configPath: string; authPath: string }>({ configPath: '', authPath: '' });
  const [storeStatus, setStoreStatus] = useState<CredentialStoreStatus | null>(null);
  const [pushingId, setPushingId] = useState<string | null>(null);
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

  // ADR-0019 Decision 10 — controlled key reveal. The gate is a re-entry of
  // the console LOGIN password (a secret the browser does not keep after
  // login), so the flow only exists while webAuth is active; the session
  // probe is the same one App's boot gate uses.
  const [webAuthActive, setWebAuthActive] = useState(false);
  const [revealTarget, setRevealTarget] = useState<AccountHealth | null>(null);
  const [revealPassword, setRevealPassword] = useState('');
  const [revealError, setRevealError] = useState('');
  const [revealBusy, setRevealBusy] = useState(false);
  /**
   * Page-lifetime unlock (ADR-0019 Decision 10, operator-accepted relaxation):
   * after ONE deliberate dialog entry the verified password lives in this REF
   * — memory only, never storage, never rendered, gone on reload — and later
   * copies are one click. A 401 (or reload) takes the unlock away.
   */
  const revealPassRef = useRef('');
  const [copyUnlocked, setCopyUnlocked] = useState(false);

  // Custom provider create form
  const [form, setForm] = useState({ id: '', name: '', baseURL: '', npm: '', apiKey: '', inline: false });
  const [npmChoice, setNpmChoice] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'connected' | 'catalog' | 'custom'>('connected');
  // Default OFF (show connected providers): a connected provider is exactly where
  // a SECOND credential is added, so hiding connected rows made multi-account
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

  // npm dropdown options: aggregate from models.dev catalog (usage-sorted),
  // always led by the openai-compatible default; offline → curated fallback.
  const npmOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of catalog) {
      if (!c.npm) continue;
      counts.set(c.npm, (counts.get(c.npm) || 0) + 1);
    }
    const fromCatalog = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([pkg]) => pkg);
    const merged = ['@ai-sdk/openai-compatible', ...fromCatalog.filter((p) => p !== '@ai-sdk/openai-compatible')];
    return merged.length > 1 ? merged : FALLBACK_NPM_PACKAGES;
  }, [catalog]);

  const connectedIds = useMemo(() => new Set(ocProviders.map((p) => p.id)), [ocProviders]);

  // opencode-v2-readonly = CLI absent, db present: routing reads work but every store
  // write is refused (ADR-0019 Decision 2) — disable credential-write affordances.
  const writesBlocked = storeStatus?.kind === 'opencode-v2-readonly';
  // Decision 1: whether a submitted key ADDS an account or OVERWRITES the only
  // one is a capability of the bound store, never a name-check on `kind` — the
  // ocr landing gets append semantics for free, a future single-account store
  // would get overwrite without the UI changing.
  const multiAccountStore = !!storeStatus?.capabilities.multiAccount;
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
  // OcrStore binding: its accounts are by definition local, not in opencode —
  // these get the one-shot Push to opencode affordance (Decision 2 convergence).
  const localOnlyProviders = useMemo(() => {
    const set = new Set<string>();
    if (storeStatus?.kind === 'ocr') {
      for (const a of storeStatus.accounts) if (a.total > 0) set.add(a.providerId);
    }
    return set;
  }, [storeStatus]);

  // ---- ADR-0019 P3 per-account drill-down -----------------------------------
  // The masked detail lives inside storeStatus (GET credential-store carries
  // it) so a write route's refreshed `accounts` array can patch it in place —
  // one source of truth, no second fetch.
  const accountsByProvider = useMemo(() => {
    const map = new Map<string, AccountHealth[]>();
    for (const a of storeStatus?.accounts ?? []) if (a.accounts && a.accounts.length > 0) map.set(a.providerId, a.accounts);
    return map;
  }, [storeStatus]);
  const maxCooldownUntil = useMemo(() => {
    let until = 0;
    for (const list of accountsByProvider.values()) for (const a of list) until = Math.max(until, a.cooldownUntilMs ?? 0);
    return until;
  }, [accountsByProvider]);
  const now = useCountdownClock(maxCooldownUntil);
  const [pendingAccount, setPendingAccount] = useState<string | null>(null);
  // `${providerId}:${accountId}` of the row in label-edit mode (page-owned so it
  // closes only when the rename write succeeds).
  const [renameKey, setRenameKey] = useState<string | null>(null);

  const applyAccountList = (providerId: string, accounts: AccountHealth[]) =>
    setStoreStatus((prev) =>
      prev
        ? {
            ...prev,
            accounts: prev.accounts.map((a) =>
              a.providerId !== providerId
                ? a
                : {
                    ...a,
                    accounts,
                    // The overview counters are derivable from the detail list —
                    // patch them too so a disconnect never leaves a stale total.
                    total: accounts.length,
                    routable: accounts.filter((x) => x.routable).length,
                    activeAccountId: accounts.find((x) => x.active)?.id ?? null,
                  }
            ),
          }
        : prev
    );

  /**
   * gap #8 tail: known machine codes localize, unknown codes stay raw + loud.
   * The `as` only guides the table lookup — the code string itself arrives
   * untrusted from the HTTP body, and an unknown code never gets a guess.
   */
  const reasonError = (err: any): string => {
    const code: string | undefined = err?.reasonCode;
    const key = code
      ? WRITE_REASON_LABEL[code as CredentialWriteReasonCode]
        ?? PUSH_REASON_LABEL[code as CredentialPushReasonCode]
        ?? REVEAL_REASON_LABEL[code as CredentialRevealReasonCode]
      : undefined;
    if (key) return t(key);
    const message = err?.message ?? 'unknown error';
    return code ? t('op.reasonGenericCode', { code, message }) : t('op.reasonGeneric', { message });
  };

  /**
   * Decision 8 arbiter, shared by provider delete and per-account disconnect:
   * a opencode-v2-family binding means the store holds the only copy of the key. A null
   * storeStatus may be a transient status-API failure rather than a non-v2
   * store, so refetch once and fail SAFE into the double confirmation —
   * over-confirming on the ocr store costs a click, under-confirming on opencode v2 loses the
   * store's only copy (export first via the row's password-gated reveal — never a backup).
   */
  const isOpencodeV2Binding = async (): Promise<boolean> => {
    const status = storeStatus ?? (await loadCredentialStore());
    return !status || status.kind === 'opencode-v2' || status.kind === 'opencode-v2-readonly';
  };

  const handleAccountActivate = async (a: AccountHealth) => {
    setPendingAccount(`${a.providerId}:${a.id}`);
    try {
      const res = await opencodeApi.activateProviderAccount(a.providerId, a.id);
      applyAccountList(a.providerId, res.accounts);
      toast.success(t('op.accountActivated', { label: accountName(a, t('op.accountUnnamed')) }));
      // The card's own masked key mirrors the ACTIVE account — keep it honest.
      await loadOpenCodeProviders();
    } catch (err: any) {
      toast.error(reasonError(err));
    } finally {
      setPendingAccount(null);
    }
  };

  /**
   * Operator takedown toggle. Reversible and non-destructive (the key stays in
   * the store), so no confirmation gate — unlike disconnect, which deletes the
   * only copy and must double-confirm (Decision 8).
   */
  const handleAccountToggleDisabled = async (a: AccountHealth) => {
    setPendingAccount(`${a.providerId}:${a.id}`);
    try {
      const res = a.disabled
        ? await opencodeApi.enableProviderAccount(a.providerId, a.id)
        : await opencodeApi.disableProviderAccount(a.providerId, a.id);
      applyAccountList(a.providerId, res.accounts);
      if (a.disabled) {
        toast.success(t('op.accountEnabled', { label: accountName(a, t('op.accountUnnamed')) }));
      } else {
        toast.info(t('op.accountDisabledOk', { label: accountName(a, t('op.accountUnnamed')) }));
      }
    } catch (err: any) {
      toast.error(reasonError(err));
    } finally {
      setPendingAccount(null);
    }
  };

  /** Empty `label` is the CLEAR gesture (backend: '' is a valid label value). */
  const handleAccountRename = async (a: AccountHealth, label: string) => {
    setPendingAccount(`${a.providerId}:${a.id}`);
    try {
      const res = await opencodeApi.renameProviderAccount(a.providerId, a.id, label);
      applyAccountList(a.providerId, res.accounts);
      setRenameKey(null);
      toast.success(label ? t('op.accountRenamed', { label }) : t('op.accountLabelCleared'));
    } catch (err: any) {
      toast.error(reasonError(err));
    } finally {
      setPendingAccount(null);
    }
  };

  const handleAccountDisconnect = async (a: AccountHealth) => {
    const name = accountName(a, t('op.accountUnnamed'));
    const boundOpencode = await isOpencodeV2Binding();
    const ok = await confirmDialog({
      title: t('op.accountDisconnectConfirm', { label: name }),
      description: boundOpencode ? t('op.deletePurgeV2') : t('op.accountDisconnectPurge'),
      danger: true,
      confirmLabel: t('common.delete'),
    });
    if (!ok) return;
    if (boundOpencode) {
      // Same Decision 8 second gate as the provider delete: no backup or
      // mitigation wording — the copy states plainly that the key is gone.
      const ok2 = await confirmDialog({
        title: t('op.accountDisconnectV2Title', { label: name }),
        description: t('op.accountDisconnectV2Desc'),
        danger: true,
        confirmLabel: t('op.deleteV2Btn'),
      });
      if (!ok2) return;
    }
    setPendingAccount(`${a.providerId}:${a.id}`);
    try {
      const res = await opencodeApi.disconnectProviderAccount(a.providerId, a.id);
      applyAccountList(a.providerId, res.accounts);
      toast.success(t('op.accountDisconnected', { label: name }));
      // The credential set behind the card changed; the provider view must follow.
      await loadOpenCodeProviders();
    } catch (err: any) {
      toast.error(reasonError(err));
    } finally {
      setPendingAccount(null);
    }
  };

  /**
   * Decision 6 explicit admin door. Not gated by writesBlocked: the suspect
   * flag lives in OCR's own state file, not in the credential store.
   */
  const handleAccountClearSuspect = async (a: AccountHealth) => {
    if (!a.keyHashPrefix) return;
    setPendingAccount(`${a.providerId}:${a.id}`);
    try {
      const res = await api.clearSuspectAccount(a.providerId, a.keyHashPrefix);
      toast.info(res.cleared ? t('op.accountSuspectCleared', { label: accountName(a, t('op.accountUnnamed')) }) : t('op.accountSuspectNone', { label: accountName(a, t('op.accountUnnamed')) }));
      await loadCredentialStore();
    } catch (err: any) {
      toast.error(reasonError(err));
    } finally {
      setPendingAccount(null);
    }
  };

  /**
   * ADR-0019 Decision 10 — copy gesture. With the page unlocked (a verified
   * password in the ref) this is a silent one-click reveal; otherwise it opens
   * the password dialog. The key never transits this page's state: every
   * response passes straight into the clipboard and is forgotten.
   */
  const openRevealDialog = (a: AccountHealth) => {
    setRevealTarget(a);
    setRevealPassword('');
    setRevealError('');
  };

  const handleAccountCopyKey = async (a: AccountHealth) => {
    if (!revealPassRef.current) {
      openRevealDialog(a);
      return;
    }
    setPendingAccount(`${a.providerId}:${a.id}`);
    try {
      const res = await opencodeApi.revealProviderKey(a.providerId, a.id, revealPassRef.current);
      await copyToClipboard(res.key);
      toast.success(t('op.accountKeyCopied'));
    } catch (err: any) {
      if (err?.reasonCode === 'invalid_password') {
        // The held password stopped being true (changed upstream, or the
        // bucket was hot) — take the unlock away and fall back to the dialog.
        revealPassRef.current = '';
        setCopyUnlocked(false);
        openRevealDialog(a);
      } else {
        toast.error(reasonError(err));
      }
    } finally {
      setPendingAccount(null);
    }
  };

  const handleRevealConfirm = async () => {
    if (!revealTarget || !revealPassword) return;
    setRevealBusy(true);
    try {
      const res = await opencodeApi.revealProviderKey(revealTarget.providerId, revealTarget.id, revealPassword);
      await copyToClipboard(res.key);
      revealPassRef.current = revealPassword;
      setCopyUnlocked(true);
      setRevealTarget(null);
      setRevealPassword('');
      toast.success(t('op.accountKeyCopiedUnlocked'));
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
      setOcPaths({ configPath: res.configPath, authPath: res.authPath });
      setOcError('');
      return true;
    } catch (err: any) {
      setOcError(err.message);
      return false;
    }
  };

  // ADR-0019 P2 badge source. Quiet on failure: an unreachable status endpoint
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
    loadOpenCodeProviders();
    loadCredentialStore();
    loadCatalog();
    api
      .getAuthSession()
      .then((s) => setWebAuthActive(Boolean(s.webAuth?.active)))
      .catch(() => setWebAuthActive(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deep link from /models: /providers?openModels=<id> opens the maintenance
  // dialog for that config-defined provider once the list has loaded.
  useEffect(() => {
    const target = searchParams.get('openModels');
    if (!target || ocProviders.length === 0) return;
    const p = ocProviders.find((x) => x.id === target);
    if (p?.custom) setModelsPanelId(target);
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
   * which account already owns the key, a first connection says connected, and a
   * key onto an already-connected provider states what the sink actually did —
   * appended an account (multi-account store) or replaced the only one.
   */
  const announceConnect = (res: Awaited<ReturnType<typeof opencodeApi.connectProvider>>, id: string) => {
    if (res.deduped) {
      toast.info(t('op.keyAlreadyExists', { label: res.account ? accountName(res.account, t('op.accountUnnamed')) : id }));
      return;
    }
    if (!connectedIds.has(id)) {
      showNotice(t('op.connectOk', { sink: sinkLabel }));
      return;
    }
    // The sink moved the chain head and we moved it back — say so, or the
    // operator cannot tell why the new row is not starred.
    if (res.headPreserved) {
      const added = res.account ? accountName(res.account, t('op.accountUnnamed')) : id;
      toast.info(t('op.headPreserved', { added, head: accountName(res.headPreserved, t('op.accountUnnamed')) }));
      return;
    }
    showNotice(t(multiAccountStore ? 'op.keyAdded' : 'op.keyUpdated', { sink: sinkLabel }));
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
    // Decision 8 arbiter (shared with the per-account disconnect): a opencode-v2-family
    // binding triggers the second confirm; an unknown store fails safe INTO it.
    // v2-readonly deletes are deliberately NOT disabled by writesBlocked: only
    // the credential purge fails there, through the honest error path below,
    // so config nodes in opencode.jsonc stay removable.
    const boundOpencode = await isOpencodeV2Binding();
    const ok = await confirmDialog({
      title: t('op.deleteConfirm', { id: p.id }),
      description: boundOpencode ? t('op.deletePurgeV2') : t('op.deletePurge', { sink: sinkLabel }),
      danger: true,
      confirmLabel: t('common.delete'),
    });
    if (!ok) return;
    if (boundOpencode) {
      // The key lives in opencode; after disconnect it is gone from the store —
      // export first via the row's password-gated reveal if needed. No backup/
      // mitigation wording — that would be proliferation dressed as safety
      // (ADR-0019 Decision 8).
      const ok2 = await confirmDialog({
        title: t('op.deleteV2Title', { id: p.id }),
        description: t('op.deleteV2Desc'),
        danger: true,
        confirmLabel: t('op.deleteV2Btn'),
      });
      if (!ok2) return;
    }
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
          failed.map((f) => `${f.accountId}: ${f.reason}`).join('; ') || t('op.purgeFailedUnknown');
        toast.error(t('op.purgeFailed', { detail }));
      } else {
        showNotice(t('op.deleted'));
      }
      await refreshAll();
    } catch (err: any) {
      toast.error(reasonError(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePush = async (id: string) => {
    setPushingId(id);
    try {
      const res = await opencodeApi.pushCredentialStore(id);
      const failed = res.failed || [];
      if (failed.length > 0) {
        toast.error(t('op.pushPartial', { detail: failed.map((f) => `${f.provider}: ${f.reason}`).join('; ') }));
      } else if ((res.pushed || []).length > 0) {
        toast.success(t('op.pushOk', { n: res.pushed.length }));
      } else {
        toast.info(t('op.pushNone'));
      }
      await refreshAll();
    } catch (err: any) {
      // Push 400s carry a machine reasonCode (attached by ocJson as OcApiError):
      // known codes render localized, unknown codes show the raw code + message
      // rather than a guessed translation (reasonError owns that table).
      toast.error(reasonError(err));
    } finally {
      setPushingId(null);
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
        apiKey: form.apiKey.trim() || undefined,
        apiKeyInline: form.inline,
      });
      showNotice(t('op.customTitle') + ' ✓');
      setForm({ id: '', name: '', baseURL: '', npm: '', apiKey: '', inline: false });
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

  const formatExpiry = (ms: number) => {
    const d = new Date(ms);
    const expired = d.getTime() < Date.now();
    return expired ? t('op.oauthExpired') : t('op.oauthExpires', { date: d.toLocaleDateString() });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', height: '100%' }}>
      <div className="card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column'}}>
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Plug size={18} color="var(--accent)" />
          <span style={{ fontWeight: 700, fontSize: 15 }}>{t('op.title')}</span>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '0 0 16px' }}>{t('op.desc', { sink: sinkLabel })}</p>

        {notice && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: noticeTone === 'err' ? 'rgba(244,63,94,0.12)' : 'rgba(16, 185, 129, 0.15)', border: `1px solid ${noticeTone === 'err' ? 'rgba(244,63,94,0.3)' : 'rgba(16, 185, 129, 0.3)'}`, color: noticeTone === 'err' ? 'var(--accent-rose)' : 'var(--accent-emerald)', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            {noticeTone === 'err' ? <AlertTriangle size={16} /> : <Check size={16} />}
            <span>{notice}</span>
          </div>
        )}
        {ocError && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'rgba(244,63,94,0.12)', border: '1px solid rgba(244,63,94,0.3)', color: 'var(--accent-rose)', fontSize: '13px', marginBottom: '16px' }}>
            {ocError}
          </div>
        )}

        {/* ---- Tabs ---- */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
          <button style={tabBtn('connected', t('op.tabConnected'))} onClick={() => setActiveTab('connected')}>
            {t('op.tabConnected')} ({ocProviders.length})
          </button>
          <button style={tabBtn('catalog', t('op.tabCatalog'))} onClick={() => setActiveTab('catalog')}>
            {t('op.tabCatalog')} ({catalogResults.length})
          </button>
          <button style={tabBtn('custom', t('op.tabCustom'))} onClick={() => setActiveTab('custom')}>
            {t('op.tabCustom')}
          </button>
        </div>

        {/* Scrollable tab content: the tab bars stay fixed, long lists scroll here. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {activeTab === 'connected' && (<>
        {/* ---- Connected providers (opencode.jsonc provider node ∪ bound store) ---- */}
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{t('op.connectedTitle')}</div>
        <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '0 0 12px' }} title={`${ocPaths.configPath} | ${ocPaths.authPath}`}>
          {t('op.connectedDesc', { sink: sinkLabel })}
        </p>

        {/* ---- Bound credential-store status (ADR-0019 P2 badge) ---- */}
        {storeStatus && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '0 0 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {storeStatus.degradedCode ? (
                <span
                  style={{ ...badgeStyle('var(--accent-amber)', 'rgba(245,158,11,0.12)'), display: 'inline-flex', alignItems: 'center', gap: 3 }}
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
                style={{ fontSize: 10, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-muted)', maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
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
                    <span style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }}>{e.provider}</span>
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
            const accountList = accountsByProvider.get(p.id) ?? [];
            const caps = storeStatus?.capabilities;
            // Sole routable credential (see AccountRow.soleServing): exactly one
            // key that can route AND has not been taken down — a disabled row is
            // in neither the spread nor the failover pool, so it never counts.
            const liveIds = accountList.filter((a) => a.routable && !a.disabled).map((a) => a.id);
            const soleRoutableId = liveIds.length === 1 ? liveIds[0] : null;
            // Key writes need a registered integration (see canWriteCredential).
            const keyWritable = canWriteCredential(p.id);
            // Two rows printing the same masked key are indistinguishable without
            // the fingerprint — that (and only that) is when the chip earns space.
            const masks = accountList.map((a) => a.maskedKey ?? a.id);
            const ambiguousMasks = new Set(masks.filter((m, i) => masks.indexOf(m) !== i));
            return (
            <div key={p.id} className="sub-card" style={cardFlex}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <ProviderLogo id={p.id} logo={p.logo} size={44} />
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontWeight: 700, fontSize: 14, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.id}</span>
                  {p.name && <span style={{ fontSize: 11, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>}
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {p.custom && <span style={badgeStyle('var(--accent)', 'var(--accent-bg)')}>{t('op.badgeCustom')}</span>}
                  {p.auth.inline && (
                    <span style={{ ...badgeStyle('#f59e0b', 'rgba(245,158,11,0.12)'), display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <Key size={9} />
                      {t('op.badgeInline')}
                    </span>
                  )}
                  {p.auth.type === 'oauth' && <span style={badgeStyle('var(--hue-violet)', 'var(--hue-violet-soft)')}>{t('op.badgeOauth')}</span>}
                  {p.auth.type === 'api' && !p.auth.inline && (
                    <span style={badgeStyle('var(--text-dim)', 'var(--chip-bg)')}>{t('op.badgeAuth', { sink: sinkLabel })}</span>
                  )}
                </div>
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

              {p.baseURL && (
                <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                  {p.baseURL}
                </div>
              )}

              {/* Chain-head key summary. With the per-credential list on screen it
                  would repeat the first row, so once that list renders only the
                  OAuth expiry still needs a line of its own — that field lives on
                  the provider view, never on AccountMeta. */}
              {!(caps && accountList.length > 0) ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }}>
                  <Lock size={11} />
                  <span>{p.auth.keyMasked || '—'}</span>
                  {p.auth.type === 'oauth' && p.auth.expires && (
                    <span style={{ color: p.auth.expires < Date.now() ? 'var(--accent-rose)' : 'var(--text-dim)' }}>
                      · {formatExpiry(p.auth.expires)}
                    </span>
                  )}
                </div>
              ) : p.auth.expires ? (
                <div
                  style={{ fontSize: 11, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", color: p.auth.expires < Date.now() ? 'var(--accent-rose)' : 'var(--text-dim)' }}
                >
                  {t('op.badgeOauth')} · {formatExpiry(p.auth.expires)}
                </div>
              ) : null}

              {/* ADR-0019 P3 credential list — always visible, one line per key,
                  capped at 3 rows (more scroll). No expand gesture: per-key state
                  is the reason this page exists, and hiding it behind a click put
                  the active credential out of sight. */}
              {caps && accountList.length > 0 && liveIds.length > 1 && (
                <div style={{ fontSize: 10.5, color: 'var(--text-dim)' }} title={t('op.accountChainHeadTip')}>
                  {t('op.accountsSpreadHint', { n: liveIds.length })}
                </div>
              )}
              {/* Everything parked: say so plainly instead of letting the card look live. */}
              {caps && accountList.length > 0 && liveIds.length === 0 && (
                <div style={{ fontSize: 10.5, color: 'var(--accent-rose)' }} title={t('op.accountsAllDisabledTip')}>
                  {t('op.accountsAllDisabled')}
                </div>
              )}
              {caps && accountList.length > 0 && (
                <div
                  className="list-group"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    maxHeight: ACCOUNT_ROWS_VISIBLE * ACCOUNT_ROW_HEIGHT_EST,
                    overflowY: 'auto',
                  }}
                >
                  {accountList.map((a, i) => (
                    <AccountRow
                      key={a.id}
                      account={a}
                      position={i + 1}
                      caps={caps}
                      soleServing={soleRoutableId === a.id}
                      prefixVisible={a.maskedKey ? ambiguousMasks.has(a.maskedKey) : true}
                      writesBlocked={writesBlocked}
                      pending={pendingAccount === `${p.id}:${a.id}`}
                      testing={testingIds.has(`${p.id}:${a.id}`)}
                      onTest={(acc) => testOne({ key: `${p.id}:${acc.id}`, providerId: p.id, accountId: acc.id })}
                      renaming={renameKey === `${p.id}:${a.id}`}
                      onStartRename={() => setRenameKey(`${p.id}:${a.id}`)}
                      onCancelRename={() => setRenameKey(null)}
                      now={now}
                      onActivate={handleAccountActivate}
                      onRename={handleAccountRename}
                      onDisconnect={handleAccountDisconnect}
                      onToggleDisabled={handleAccountToggleDisabled}
                      onClearSuspect={handleAccountClearSuspect}
                      canReveal={webAuthActive}
                      onCopyKey={openRevealDialog}
                    />
                  ))}
                </div>
              )}

              {testResults[p.id] && (
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace",
                    color: testResults[p.id].ok ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                    wordBreak: 'break-all',
                  }}
                  title={testResults[p.id].ok ? undefined : testResults[p.id].error}
                >
                  {testResults[p.id].ok
                    ? `✓ ${testResults[p.id].model} · ${testResults[p.id].latencyMs} ms`
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
                      placeholder={t(multiAccountStore ? 'op.addKeyPrompt' : 'op.updateKeyPrompt')}
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
                    disabled={writesBlocked || !keyWritable}
                    title={
                      writesBlocked
                        ? t('op.storeReadOnlyTip')
                        : !keyWritable
                          ? t('op.integrationMissingTip')
                          : t(multiAccountStore ? 'op.addKeyAccountTip' : 'op.updateKeyTip')
                    }
                    onClick={() => setKeyEditId(p.id)}
                  >
                    {multiAccountStore ? <Plus size={12} /> : <Key size={12} />}
                    <span>{t(multiAccountStore ? 'op.addKeyAccount' : 'op.updateKey')}</span>
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
                      title={t(p.custom ? 'op.pmManage' : 'op.pmView')}
                      onClick={() => setModelsPanelId(p.id)}
                    >
                      <Cpu size={12} />
                      <span>{t(p.custom ? 'op.pmManage' : 'op.pmView')}</span>
                    </button>
                    {localOnlyProviders.has(p.id) && (
                      <button
                        className="btn btn-sm"
                        disabled={busy || pushingId !== null}
                        title={t('op.pushTip')}
                        onClick={() => handlePush(p.id)}
                      >
                        {pushingId === p.id ? <RefreshCw size={12} style={{ animation: 'ocr-spin 0.8s linear infinite' }} /> : <Upload size={12} />}
                        <span>{t('op.pushBtn')}</span>
                      </button>
                    )}
                  </>
                )}
              </div>

              {modelsPanelId === p.id && (
                <ProviderModelsDialog
                  providerId={p.id}
                  providerName={p.name}
                  readOnly={!p.custom}
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
        <div style={{ fontSize: 13, fontWeight: 700, margin: '0 0 8px' }}>{t('op.connectTitle')}</div>
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
                    <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.id}</span>
                  </div>
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
                    disabled={writesBlocked || !canWriteCredential(c.id)}
                    title={
                      writesBlocked
                        ? t('op.storeReadOnlyTip')
                        : !canWriteCredential(c.id)
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
        <div style={{ fontSize: 13, fontWeight: 700, margin: '0 0 8px' }}>{t('op.customTitle')}</div>
        <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '0 0 12px' }}>{t('op.customDesc')}</p>
        {/* Capped two-column form (was an uncapped 3-col grid that stretched every
            input to ~900px on wide screens). Base URL spans the row — it is the one
            long value; the inline switch lives INSIDE the key cell so the pair reads
            as one control. auto-fit collapses to a single column below ~580px. */}
        <div style={{ maxWidth: 720, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: '12px 14px' }}>
          <FormField label={t('op.fId')} required>
            <input className="input" style={{ fontSize: 12 }} placeholder={t('op.phId')} value={form.id} onChange={e => setForm({ ...form, id: e.target.value })} />
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
        </div>
        <div style={{ maxWidth: 720, marginTop: 14 }}>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={handleCreateCustom}>
            <Plus size={12} />
            <span>{busy ? t('op.creating') : t('op.createBtn')}</span>
          </button>
        </div>
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
            account={revealTarget}
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
      </div>
    </div>
  );
};

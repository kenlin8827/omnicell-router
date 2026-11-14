import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Users, RefreshCw, Archive, BarChart3, Check, ChevronDown, ChevronRight, Copy, Eye, GitBranch, Laptop, Maximize2, Minimize2, Server, User, Waypoints, Wrench, Search, Trash2 } from 'lucide-react';
import { api, type SessionRecord, type TraceRecord } from '../lib/api';
import { formatReason, type Translate } from '../lib/reason';
import { formatCost, formatCostCompact, formatSessionId, decodeRate, formatSpeed, fmtLatency } from '../lib/format';
import { copyToClipboard } from '../lib/clipboard';
import { clientDisplayName } from '../lib/clientDetect';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Combobox } from '../components/Combobox';
import { Dialog } from '../components/Dialog';
import { Pagination } from '../components/Pagination';
import { ScrollTable, stickyBodyCell } from '../components/ScrollTable';
import { Descriptions } from '../components/Descriptions';

import { FONT_MONO } from '../lib/fonts';
const PAGE_SIZES = [10, 20, 25, 50, 100, 200];

/** Tier display: show the tier's own name (Lite / Plus / Pro / Ultra), not opaque numbers. */
const TIER_LABEL: Record<SessionRecord['maxTier'], string> = {
  lite: 'sessions.tierNameLite',
  plus: 'sessions.tierNamePlus',
  pro: 'sessions.tierNamePro',
  ultra: 'sessions.tierNameUltra',
};
const TIER_BADGE: Record<SessionRecord['maxTier'], string> = {
  lite: 'badge-success',
  plus: 'badge-info',
  pro: 'badge-warning',
  ultra: 'badge-amber',
};
// Hover tooltip restores the descriptor dropped from the compact badge
// (reuses the tier-policy page's own vocabulary — one source per tier name).
const TIER_FULL_LABEL: Record<SessionRecord['maxTier'], string> = {
  lite: 'tierPolicy.tierLite',
  plus: 'tierPolicy.tierPlus',
  pro: 'tierPolicy.tierPro',
  ultra: 'tierPolicy.tierUltra',
};

/**
 * One labeled stat line inside the merged tokens cell. The fixed-width dim
 * label keeps the number columns vertically aligned across the cell's 2×2
 * grid (In/Out stacked left, Cached/Hit stacked right) and across the Speed
 * column's two rows. `title` carries the exact value when the displayed one is
 * compacted or ellipsized.
 *
 * The row NEVER wraps: a two-line row would grow the whole table row and, in
 * the 2×2 grid, break the left/right pairing. A number too wide for its half
 * ellipsizes instead (the full value stays in the tooltip).
 */
const TokenStatRow: React.FC<{ label: string; value: string; color?: string; title?: string }> = ({ label, value, color, title }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'baseline',
      gap: 5,
      minWidth: 0,
      lineHeight: 'var(--leading-relaxed)',
      whiteSpace: 'nowrap',
    }}
  >
    {/* The NUMBER never clips; the label yields first. Labels are locale-
        dependent (ja "キャッシュ", es "En caché" are far wider than "Cached"),
        and a degraded label is a lesser loss than a truncated figure — the
        figure is the data. A fixed label track would slice the longer locales
        mid-word instead. */}
    <span
      style={{
        fontSize: 'var(--text-2xs)',
        color: 'var(--text-dim)',
        flexShrink: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {label}
    </span>
    <span
      title={title}
      style={{
        fontFamily: FONT_MONO,
        // One step below the table body: the 2×2 halves and the speed pair
        // live in narrow fixed columns, and text-sm mono pushes the widest
        // honest value (a compacted 4.3M, or "123 tok/s") past its share.
        fontSize: 'var(--text-xs)',
        fontWeight: 'var(--font-semibold)',
        color: color ?? 'var(--text-main)',
        flexShrink: 0,
      }}
    >
      {value}
    </span>
  </div>
);

/**
 * One `label value` pair inside a summary series. Labels stay dim and small,
 * figures take the mono weight — the same hierarchy the table rows use, so a
 * series reads as a row of miniature stats rather than a sentence.
 */
const SummaryStat: React.FC<{ label: string; value: string; title?: string; color?: string }> = ({
  label,
  value,
  title,
  color,
}) => (
  <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4, whiteSpace: 'nowrap' }}>
    <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>{label}</span>
    <span
      title={title}
      style={{
        fontFamily: FONT_MONO,
        fontSize: 'var(--text-xs)',
        fontWeight: 'var(--font-semibold)',
        color: color ?? 'var(--text-main)',
      }}
    >
      {value}
    </span>
  </span>
);

/** A horizontal run of SummaryStats separated by faint dots. */
const SummarySeries: React.FC<{ items: { key: string; node: React.ReactNode }[] }> = ({ items }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', rowGap: 4 }}>
    {items.map((item, i) => (
      <React.Fragment key={item.key}>
        {i > 0 && <span style={{ color: 'var(--divider)', fontSize: 'var(--text-2xs)' }}>·</span>}
        {item.node}
      </React.Fragment>
    ))}
  </div>
);

/**
 * Compact token display for the fixed-layout table: a 7-digit count (~65px
 * in mono 12px) overflows its half and would ellipsize (table-layout:fixed
 * plus the grid's minmax(0,1fr) halves), so ≥100K collapses to a
 * 38.9K/4.3M-style number; the exact value stays in the row tooltip.
 */
const COMPACT_FMT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const tokenDisplay = (v: number): string => (v >= 100_000 ? COMPACT_FMT.format(v) : v.toLocaleString());

/**
 * Share of the decode window spent in felt pauses that reads as choppy. A
 * tenth means one dead second in every ten of streaming — the point where
 * users describe the stream as "stuck". Display threshold only — it colours
 * the figure, never hides or rewrites it.
 */
const STALL_RATIO_WARN = 0.1;

/**
 * Compact percent for the stall-ratio cell: '—' when no gap was measurable,
 * '0%' for a measured smooth stream, '<1%' so a small but real share is never
 * rounded down into "0%", and whole percents above that.
 */
const fmtStallRatio = (share: number | undefined): string => {
  if (share === undefined) return '—';
  if (share <= 0) return '0%';
  if (share < 0.01) return '<1%';
  return `${Math.round(share * 100)}%`;
};

/**
 * Tier badge by entry mode (NOT a cell — it renders as the model column's
 * third stacked line since the standalone tier column merged there):
 * - combo   -> a neutral "Combo" badge (the composition is the decision, the
 *              executed member's tier is not a session ceiling).
 * - explicit-> nothing at all — a lone dash line under model/provider is
 *              empty decoration; the session simply has no tier lock.
 * - auto / mixed -> the tier badge (the ratchet's locked ceiling).
 */
const TierBadge: React.FC<{ s: SessionRecord }> = ({ s }) => {
  const { t } = useI18n();
  const effortTip = lastEffortTip(s, t);
  if (s.entryMode === 'combo') {
    return (
      <span
        className="badge badge-info"
        title={t('sessions.entryModeComboHint') + effortTip}
        style={{ display: 'inline-block', marginTop: '3px', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {t('sessions.entryModeCombo')}
      </span>
    );
  }
  if (s.entryMode === 'explicit') {
    return null;
  }
  return (
    <span
      className={`badge ${TIER_BADGE[s.maxTier]}`}
      title={t(TIER_FULL_LABEL[s.maxTier]) + effortTip}
      style={{ display: 'inline-block', marginTop: '3px', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
    >
      {t(TIER_LABEL[s.maxTier])}
    </span>
  );
};

/**
 * Model-ref cell: model id on top (inherits the cell's bold weight), serving
 * provider underneath in dim gray — two stacked, non-wrapping lines, each
 * ellipsized, with the full id / provider in its tooltip. Pure execution
 * semantics: the routing pin never surfaces here. `null` (a row with no trace
 * at all) renders an em dash.
 *
 * The id namespace is MIXED: hand-configured models register bare ids
 * (`deepseek-chat`), catalog/tier-derived ones register `provider/model`
 * (`alibaba/qwen3.8-flash`). The serving provider is authoritative for the
 * second line, and the id's own prefix is stripped from the first line only
 * when it IS that provider — an id that merely contains a slash (a
 * vendor-qualified upstream name under a different provider) renders verbatim
 * so no part of it is lost.
 */
const MODEL_LINE_STYLE: React.CSSProperties = {
  display: 'block',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

/**
 * One numeric cell of the request-detail table: mono, centered, small — the
 * density the hand-rolled grid had. Kept as one constant so the thirteen
 * columns cannot drift into different paddings.
 */
const DETAIL_TD_CENTER: React.CSSProperties = {
  padding: '6px 8px',
  textAlign: 'center',
  fontFamily: FONT_MONO,
  fontSize: 'var(--text-xs)',
  whiteSpace: 'nowrap',
};
const ModelRefCell: React.FC<{
  model: string | null;
  provider?: string | null;
  /** Tier badge rendered as the cell's own third line (model / provider /
   *  tier) — the model column owns the tier display since the former
   *  standalone tier column merged into it. `undefined` (explicit entry
   *  mode) renders nothing: no tier, no dash line. */
  tier?: React.ReactNode;
}> = ({ model, provider, tier }) => {
  if (model === null) {
    return (
      <span style={{ ...MODEL_LINE_STYLE, color: 'var(--text-dim)' }}>—</span>
    );
  }
  const slash = model.indexOf('/');
  const inlineNs = slash < 0 ? null : model.slice(0, slash);
  const ns = provider && provider.length > 0 ? provider : inlineNs;
  const bare = ns !== null && ns === inlineNs ? model.slice(slash + 1) : model;
  return (
    <>
      <span title={model} style={MODEL_LINE_STYLE}>
        {bare}
      </span>
      {ns !== null && (
        <span
          title={ns}
          style={{
            ...MODEL_LINE_STYLE,
            marginTop: '3px',
            fontSize: 'var(--text-2xs)',
            fontWeight: 'var(--font-medium)',
            color: 'var(--text-dim)',
          }}
        >
          {ns}
        </span>
      )}
      {/* Third line, full-width badge: an inline-right badge squeezed the
          provider name and read as one tangled row; stacked lines keep each
          element legible and match the session-id cell's stacked rhythm.
          Skipped entirely when there is no tier (explicit mode) — a lone
          dash line is empty decoration. */}
      {tier}
    </>
  );
};

/**
 * ONE-string model reference in the canonical `namespace/id` order — the same
 * spelling the request-detail table prints and the same namespace the wire id
 * uses (ADR-0003 `modelRef`). Used where a cell has the width for a single
 * line (the session-detail summary card): the two stacked lines of
 * `ModelRefCell` exist only because the narrow LIST column cannot fit one.
 *
 * Reuses ModelRefCell's rule for the namespace: the serving provider wins, and
 * the id's own prefix is stripped only when it IS that provider — an id that
 * merely contains a slash keeps its full spelling rather than losing a segment.
 */
const modelFullRef = (model: string | null, provider?: string | null): string => {
  if (model === null) return '—';
  const slash = model.indexOf('/');
  const inlineNs = slash < 0 ? null : model.slice(0, slash);
  const ns = provider && provider.length > 0 ? provider : inlineNs;
  if (ns === null) return model;
  return ns === inlineNs ? model : `${ns}/${model}`;
};

/**
 * Shared-provider chip (trail + request-detail fold headers): printed once
 * above rows that omit the `provider/` prefix; the tooltip explains the
 * omission and the rows' own tooltips carry the full refs.
 *
 * `textTransform`/`letterSpacing` are reset explicitly: this chip renders
 * inside uppercase fold headers, and both properties INHERIT — without the
 * reset the prefix is shouted in caps (`DEEPSEEK/`) and letter-spaced like a
 * section label, which is wrong for a literal identifier.
 */
const PROVIDER_CHIP_STYLE: React.CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: 'var(--text-2xs)',
  fontWeight: 'var(--font-medium)',
  color: 'var(--text-dim)',
  background: 'var(--chip-bg)',
  border: '1px solid var(--card-border)',
  padding: '1px 8px',
  borderRadius: '4px',
  wordBreak: 'break-all',
  textTransform: 'none',
  letterSpacing: 'normal',
};
const ProviderNsChip: React.FC<{ ns: string }> = ({ ns }) => {
  const { t } = useI18n();
  return (
    <span title={t('sessions.switchProviderTip')} style={PROVIDER_CHIP_STYLE}>
      {ns}/
    </span>
  );
};

/**
 * Thinking-level cell for the per-request detail grid: shows the level the
 * gateway actually served. `requested→actual` in amber when the turn was
 * degraded below the ask (the same signal X-OCR-Thinking-Degraded carries);
 * '—' when no explicit level was in play or the trace predates the fields.
 * A gateway-decided ask (ADR-0012: L2 decision / experience entry / `@ocr-*`
 * directive / model default) carries the localized `auto·` prefix and a
 * source line in the tooltip — a client ask renders bare. The gateway mark
 * renders as a micro Waypoints icon inline (the text `auto·` mark survives
 * only in text-only contexts, i.e. the tooltip lines built by lastEffortTip).
 */
// Legacy wire values from persisted traces map onto their current
// equivalents ('judge' was renamed to 'l2-decision'); unknown values fall
// through to the default label so a stale disk row can never crash the cell.
const EFFORT_SOURCE_KEY: Record<string, string> = {
  client: 'sessions.thinkSrcClient',
  'l2-decision': 'sessions.thinkSrcL2Decision',
  judge: 'sessions.thinkSrcL2Decision',
  entry: 'sessions.thinkSrcEntry',
  directive: 'sessions.thinkSrcDirective',
  // Legacy wire value: pre-directive traces recorded 'escalation'.
  escalation: 'sessions.thinkSrcDirective',
  default: 'sessions.thinkSrcDefault',
};
const effortSourceKey = (src: string): string => EFFORT_SOURCE_KEY[src] ?? 'sessions.thinkSrcDefault';

/**
 * Micro-badge stating which side MINTED a session id (see SessionIdSource,
 * backend/src/session/session-row.ts). The id's shape is not evidence: a client
 * naming it (`x-conversation-id`, embedded metadata.user_id, request.user) is
 * adopted verbatim, so a 36-char UUID in this column is the CLIENT's choice,
 * not a verbose gateway — the gateway's own mint is `sess_` + 16 hex. Icon-only
 * so the id stays the row's subject; the tooltip carries the sentence, and
 * aria-label keeps the word available to screen readers. Rendered IN FRONT of
 * the id: as a prefix it labels the value that follows, and it is not the
 * first thing an ellipsized cell drops.
 *
 * Colour: the CHIP stays neutral for both sides (`--chip-bg` / `--divider`, the
 * same quiet treatment as the internal badge and the client-ref chips) and only
 * the GLYPH is tinted. Provenance is not a status, so it must not paint blocks
 * of accent into the first column — on this gateway the client side is the
 * COMMON case (every WorkBuddy turn names its own id), and an accent block per
 * row would read as a warning and compete with the accent's selection/focus
 * meaning elsewhere. The tinted glyph keeps the one surprising fact ("the
 * client chose this string") noticeable without shouting.
 */
function IdSourceBadge({
  source,
  t,
  style,
}: {
  source: 'gateway' | 'client';
  t: Translate;
  style?: React.CSSProperties;
}) {
  const client = source === 'client';
  const Icon = client ? Laptop : Server;
  const label = t(client ? 'sessions.idSourceClient' : 'sessions.idSourceGateway');
  return (
    <span
      title={t(client ? 'sessions.idSourceClientTip' : 'sessions.idSourceGatewayTip')}
      role="img"
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        flex: 'none',
        borderRadius: '4px',
        verticalAlign: 'middle',
        background: 'var(--chip-bg)',
        border: '1px solid var(--divider)',
        color: client ? 'var(--accent)' : 'var(--text-dim)',
        cursor: 'help',
        ...style,
      }}
    >
      <Icon size={10} strokeWidth={2.4} />
    </span>
  );
}

/**
 * Tier-cell tooltip suffix: the LATEST turn's thinking-effort sample, lifted
 * from the session aggregates (`last*Effort*` fields). Effort floats per
 * turn and is never ratcheted (ADR-0012), so the line is explicitly worded
 * "last turn" — it must never read as a session lock next to the tier
 * ceiling. '' when the last trace predates the effort fields. Mirrors
 * EffortCell's rendering rules (gateway mark — icon in the cell, text
 * `auto·` prefix here since tooltips are plain text; degraded `req→act`).
 */
const lastEffortTip = (s: SessionRecord, t: Translate): string => {
  const req = s.lastRequestedEffort;
  const act = s.lastActualEffort;
  if (!req && !act) return '';
  const src = s.lastEffortSource;
  const degraded = s.lastReasoningDegraded === true;
  const gatewayDecided = src !== undefined && src !== 'client';
  const level = degraded && req && act && req !== act ? `${req}→${act}` : act ?? req;
  const marked = `${gatewayDecided ? t('sessions.thinkAutoMark') : ''}${level}`;
  return (
    `\n${t('sessions.thinkLast', { effort: marked })}` +
    (src ? `\n${t('sessions.thinkSource', { source: t(effortSourceKey(src)) })}` : '')
  );
};

const EffortCell: React.FC<{ tr: TraceRecord }> = ({ tr }) => {
  const { t } = useI18n();
  const req = tr.execution.requestedEffort;
  const act = tr.execution.actualEffort;
  const src = tr.execution.effortSource;
  // Tooltip carries only the non-obvious fact — who decided the level.
  // Degradation is self-evident from the amber `req→act` text; no-source
  // turns (client-specified / nothing in play) get no tooltip at all.
  const tip = src ? t('sessions.thinkSource', { source: t(effortSourceKey(src)) }) : '';
  if (!req && !act) {
    return (
      <span data-tip={tip || undefined} style={{ color: 'var(--text-dim)' }}>
        —
      </span>
    );
  }
  const degraded = tr.execution.reasoningDegraded === true;
  const gatewayDecided = src !== undefined && src !== 'client';
  // Source micro-icon: Waypoints = gateway-decided, User = client-specified;
  // each carries its own themed tooltip. Only shown when a level is in play.
  const sourceIcon = gatewayDecided ? (
    <span data-tip={t('sessions.thinkAutoTip')} style={{ display: 'inline-flex', verticalAlign: '-1px' }}>
      <Waypoints size={10} style={{ marginRight: '2px', color: 'var(--text-dim)' }} />
    </span>
  ) : (
    <span data-tip={t('sessions.thinkClientTip')} style={{ display: 'inline-flex', verticalAlign: '-1px' }}>
      <User size={10} style={{ marginRight: '2px', color: 'var(--text-muted)' }} />
    </span>
  );
  return (
    <span
      data-tip={tip || undefined}
      style={{ color: degraded ? 'var(--accent-amber)' : 'var(--text-muted)' }}
    >
      {sourceIcon}
      {degraded && req && act && req !== act ? `${req}→${act}` : act ?? req}
    </span>
  );
};

/**
 * Per-turn prompt cell for the detail grid: inline summary, or — when the
 * turn carried no user message (tool-result continuation) — a bare dim
 * wrench glyph (the tooltip carries the explanation). Hovering the cell
 * reveals a copy icon; clicking it copies the full summary. `copied`
 * flips the icon to a check for a moment as feedback.
 */
const PromptCell: React.FC<{ text: string }> = ({ text }) => {
  const { t } = useI18n();
  const toast = useToast();
  const [hover, setHover] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const hasText = text.length > 0;
  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setCopied(false); }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        minWidth: 0,
        width: '100%',
        color: hasText ? 'var(--text-muted)' : 'var(--text-dim)',
      }}
    >
      <span
        data-tip={hasText ? text : t('sessions.promptFallbackTip')}
        style={{
          minWidth: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {hasText ? text : <Wrench size={10} style={{ flexShrink: 0 }} />}
      </span>
      {hasText && hover && (
        <span
          style={{ display: 'inline-flex', flexShrink: 0, cursor: 'copy', color: 'var(--text-dim)' }}
          onClick={async (e) => {
            e.stopPropagation();
            const ok = await copyToClipboard(text);
            if (ok) {
              setCopied(true);
              toast.success(t('sessions.copiedPrompt'));
              window.setTimeout(() => setCopied(false), 1500);
            } else {
              toast.error(t('sessions.copyFailed'));
            }
          }}
        >
          {copied ? <Check size={10} /> : <Copy size={10} />}
        </span>
      )}
    </span>
  );
};

type SwitchKind = 'first' | 'ratchet' | 'fallback' | 'switch';
interface SwitchEvent {
  at: number;
  from: string | null;
  to: string;
  kind: SwitchKind;
  detail?: string;
  /** When the reason template carries a `{tier}` slot: the localized text
   *  around it, plus the raw tier id for badge lookup (TIER_BADGE/TIER_LABEL).
   *  The trail row renders pre + tier badge + post; `detail` stays the clean
   *  plain string for the tooltip. `model` (L2 decision codes only) joins the
   *  tooltip as a suffix line — never inline. */
  tieredDetail?: { tier: string; pre: string; post: string; model?: string };
}

const SWITCH_BADGE: Record<SwitchKind, string> = {
  first: 'badge-info',
  ratchet: 'badge-warning',
  fallback: 'badge-danger',
  switch: '',
};

const SWITCH_LABEL: Record<SwitchKind, string> = {
  first: 'sessions.switchFirst',
  ratchet: 'sessions.switchRatchet',
  fallback: 'sessions.switchFallback',
  switch: 'sessions.switchPlain',
};

/** Spine-dot color per switch kind — mirrors the SWITCH_BADGE hues. */
const SWITCH_DOT: Record<SwitchKind, string> = {
  first: 'var(--accent)',
  ratchet: 'var(--accent-amber)',
  fallback: 'var(--accent-rose)',
  switch: 'var(--text-dim)',
};

/**
 * Provider namespace shared by EVERY ref in the list, when all carry the
 * same `provider/` prefix. The modal prints the prefix once as a header
 * chip and keeps rows short (`glm-5.3-flash` instead of repeating a
 * 30-char ref per row); the rows' own tooltips carry the full refs.
 * Mixed or prefix-less models return null and rows fall back to full refs.
 */
const commonProviderOf = (models: ReadonlyArray<string | null | undefined>): string | null => {
  let ns: string | null = null;
  for (const m of models) {
    if (!m) continue;
    const slash = m.indexOf('/');
    const p = slash < 0 ? '' : m.slice(0, slash);
    if (ns === null) ns = p;
    else if (ns !== p) return null;
  }
  return ns ? ns : null;
};

/**
 * Split a tier-bearing reason text around its `{tier}` slot: rebuilds the
 * localized string with a sentinel in the slot, then cuts. The trail row
 * renders pre + tier badge + post, borrowing the sessions-table badge hues
 * (TIER_BADGE/TIER_LABEL) so a tier judgment pops out of the gray detail
 * line. Undefined when the code carries no `tier` param or the sentinel
 * did not survive the rebuild (unknown code -> raw-reason fallback) — the
 * guard is structural, no code allowlist needed.
 *
 * The L2 decision layer's model id never renders inline (it reads like the tier was
 * inferred FROM the model — it is not; the decision layer is a dedicated decision
 * leg): it rides back as `model` for a tooltip suffix line instead.
 */
const TIER_SENTINEL = '\u0000';
const tieredDetailOf = (
  tr: TraceRecord,
  t: Translate
): { tier: string; pre: string; post: string; model?: string } | undefined => {
  const params = tr.routing?.reasonParams;
  const tier = params?.tier;
  if (!params || typeof tier !== 'string') return undefined;
  const withSentinel = formatReason(
    tr.routing?.reasonCode,
    {
      ...params,
      tier: TIER_SENTINEL,
      // Decision confidence as a 0-100 integer for the l2 templates — the
      // number is the decision layer's own (self-reported on the converted path,
      // which is exactly what the "uncalibrated" caveat marks). Other
      // {tier} templates have no {confidence} slot and ignore it.
      confidence: Math.round((tr.routing?.confidence ?? 0) * 100),
    },
    tr.routing?.reason,
    t
  );
  const cut = withSentinel.indexOf(TIER_SENTINEL);
  if (cut < 0) return undefined;
  const code = tr.routing?.reasonCode;
  return {
    tier,
    pre: withSentinel.slice(0, cut),
    post: withSentinel.slice(cut + TIER_SENTINEL.length),
    model:
      (code === 'l2.system_one' || code === 'l2.system_one_uncalibrated') &&
      typeof params.model === 'string'
        ? params.model
        : undefined,
  };
};

/**
 * Derive the model-switch timeline from a session's chronological traces:
 * a switch happens wherever the executed model differs from the previous
 * request. Failure-driven changes (fallback/failover) are tagged separately
 * from ratchet escalations. Reasons are localized when the trace carries a
 * known `reasonCode`; anything older shows the gateway's own wording.
 */
const buildSwitchTimeline = (traces: TraceRecord[], t: Translate): SwitchEvent[] => {
  const events: SwitchEvent[] = [];
  let prev: string | null = null;
  for (const tr of traces) {
    const model = tr.execution.modelUsed;
    // Merge decision confidence (0-100) into the params so the l2 templates'
    // {confidence} slot renders on this path too — the backend reasonParams
    // carry only {model, tier} (+{effort}). Other templates have no
    // {confidence} slot and ignore it, so this is safe for every code.
    const routingDetail = formatReason(
      tr.routing?.reasonCode,
      { ...tr.routing?.reasonParams, confidence: Math.round((tr.routing?.confidence ?? 0) * 100) },
      tr.routing?.reason,
      t
    );
    if (prev === null) {
      events.push({ at: tr.timestamp, from: null, to: model, kind: 'first', detail: routingDetail, tieredDetail: tieredDetailOf(tr, t) });
    } else if (model !== prev) {
      const code = tr.routing?.reasonCode;
      // Structured code is authoritative; sessionRatchetApplied covers rows written before codes existed.
      const ratcheted =
        code === 'session.escalated' || code === 'session.ratchet' || tr.routing?.sessionRatchetApplied === true;
      const kind: SwitchKind =
        tr.execution.fallbackOccurred || tr.execution.failoverOccurred
          ? 'fallback'
          : ratcheted
            ? 'ratchet'
            : 'switch';
      // Failover narrative only when it tells a story: the pool pushes its
      // first candidate into failoverPath unconditionally (orchestrator
      // failoverAttempts), so a clean turn still carries a single-entry path —
      // preferring it would clobber the real routing reason with the bare
      // model ref.
      const fp = tr.execution.failoverPath;
      const failoverStory =
        tr.execution.failoverOccurred && fp && fp.length > 1 ? fp.join(' → ') : undefined;
      const detail = tr.execution.fallbackReason || failoverStory || routingDetail;
      events.push({
        at: tr.timestamp,
        from: prev,
        to: model,
        kind,
        detail,
        // A badge only matches when the displayed text IS the reason template
        // — a fallbackReason / failover story has no {tier} slot to cut into.
        tieredDetail: detail === routingDetail ? tieredDetailOf(tr, t) : undefined,
      });
    }
    prev = model;
  }
  return events;
};

export const SessionsPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  // Capture-jump column only renders when the archive feature is on —
  // asked once at mount; toggling capture mid-session just needs a refresh.
  const [captureOn, setCaptureOn] = useState(false);
  // Switch-timeline modal: null = closed; events + raw request rows filled
  // once traces arrive (the detail list renders every turn, not only switches).
  // Fold states are decided ONCE by the entry-point intent — switch badge
  // opens trail + collapses the request detail, the Detail button is the
  // reverse — and both headers stay user-toggleable afterwards.
  const [timeline, setTimeline] = useState<{
    session: SessionRecord;
    events: SwitchEvent[];
    traces: TraceRecord[];
    detailOpen: boolean;
    trailOpen: boolean;
    summaryOpen: boolean;
  } | null>(null);
  // (Backdrop dismiss + Escape + body scroll lock come from the shared
  // Dialog shell; the modal renders only while `timeline` is set.)
  // Request-detail list order: false = chronological (the traces' recorded
  // order), true = newest first. Reset per open in openTimeline.
  const [detailDesc, setDetailDesc] = useState(true);
  // Request-detail pager: long agent loops produce hundreds of trace rows —
  // paginate client-side instead of rendering one giant grid. Reset per
  // modal open alongside the sort order.
  const [detailPage, setDetailPage] = useState(1);
  const [detailPageSize, setDetailPageSize] = useState(20);
  // Expanded toggle (header action): the card grows to 90vw × 90vh, keeping
  // a 10% viewport margin on all sides — windowed, not `full` mode. Reset
  // per modal open.
  const [detailFull, setDetailFull] = useState(false);
  // Server-side filter (?q=), debounced from the search input; resets to page 1.
  const [filterInput, setFilterInput] = useState('');
  const [filter, setFilter] = useState('');
  // Per-application selector (server-side ?apiKey=, same semantics as the
  // captures page): '' = all apps, otherwise a client API-key id. Initialized
  // from the URL so /usage row clicks arrive pre-filtered.
  const [searchParams] = useSearchParams();
  const [apiKeyFilter, setApiKeyFilter] = useState(searchParams.get('apiKey') || '');
  const [apiKeyOptions, setApiKeyOptions] = useState<{ id: string; name: string }[]>([]);
  // Gateway-internal rows (console translation/probe loopback calls, reserved
  // `ocr-internal:` session ids) — server-side filter, ON by default: these
  // sessions are noise for inspecting client traffic and stay one click away.
  // The checkbox lives on the description line below, not in the action
  // toolbar (see the description block).
  const [hideInternal, setHideInternal] = useState(true);

  // Combobox options: the configured client keys (id + application name).
  // Best-effort — a console session without /api-keys visibility just shows
  // the "all apps" entry.
  useEffect(() => {
    let alive = true;
    api
      .getApiKeys()
      .then(r => {
        if (alive) setApiKeyOptions((r.keys || []).map(k => ({ id: k.id, name: k.name })));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      setFilter(filterInput.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [filterInput]);

  useEffect(() => {
    api.getCaptureStatus().then(st => setCaptureOn(Boolean(st?.enabled))).catch(() => setCaptureOn(false));
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getSessions(pageSize, (page - 1) * pageSize, filter || undefined, apiKeyFilter || undefined, hideInternal);
      setSessions(res.sessions);
      setTotal(res.total);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, filter, apiKeyFilter, hideInternal]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const timer = setInterval(loadData, 5000);
    return () => clearInterval(timer);
  }, [loadData]);

  const openTimeline = useCallback(
    async (s: SessionRecord, forceOpen: boolean) => {
      // Entry intent decides the fold states at open: switch badge → trail
      // open + everything else collapsed (the operator asked to read the
      // trajectory, so the summary must not eat the space it needs);
      // Detail button → the reverse (detail open, trail and summary
      // collapsed). The refill below only adds data — a toggle made while
      // traces load survives. Fresh modal = newest first again (per-session
      // reset).
      setDetailDesc(true);
      setDetailPage(1);
      setDetailFull(false);
      setTimeline({
        session: s,
        events: [],
        traces: [],
        detailOpen: forceOpen,
        trailOpen: !forceOpen,
        summaryOpen: forceOpen,
      });
      try {
        const traces = await api.getSessionTraces(s.id);
        setTimeline(cur =>
          cur && cur.session.id === s.id
            ? { ...cur, events: buildSwitchTimeline(traces, t), traces }
            : cur
        );
      } catch (err) {
        console.error(err);
        setTimeline(null);
        toast.error(t('sessions.switchLoadFailed'));
      }
    },
    [t, toast]
  );

  /** Clear ALL sessions (live routing state + every trace, incl. durable store). */
  const clearAll = useCallback(async () => {
    const ok = await confirmDialog({
      title: t('sessions.clearConfirmTitle'),
      description: t('sessions.clearConfirmDesc'),
      danger: true,
      confirmLabel: t('sessions.clearAll'),
    });
    if (!ok) return;
    try {
      const res = await api.clearSessions();
      if (res.status === 'ok') {
        toast.success(
          t('sessions.clearDone', { sessions: res.sessionsCleared ?? 0, traces: res.tracesCleared ?? 0 })
        );
        setPage(1);
        await loadData();
      } else {
        toast.error(res.message || t('common.failed'));
      }
    } catch (err: any) {
      toast.error(err.message || t('common.failed'));
    }
  }, [confirmDialog, t, toast, loadData]);

  /** Delete ONE session (live state + traces, incl. reconstructed history). */
  const deleteOne = useCallback(
    async (s: SessionRecord) => {
      const ok = await confirmDialog({
        title: t('sessions.deleteConfirmTitle'),
        description: t('sessions.deleteConfirmDesc', { id: formatSessionId(s.id) }),
        danger: true,
        confirmLabel: t('common.delete'),
      });
      if (!ok) return;
      try {
        const res = await api.deleteSession(s.id);
        if (res.status === 'ok') {
          toast.success(t('sessions.deleteDone'));
          await loadData();
        } else {
          toast.error(res.message || t('common.failed'));
        }
      } catch (err: any) {
        toast.error(err.message || t('common.failed'));
      }
    },
    [confirmDialog, t, toast, loadData]
  );

  // Column widths in PX, plus the horizontal floor derived from them. PX (not
  // percentages) is the point: a percentage layout shrinks every column with
  // the window until 13 columns are 20px wide and every value renders as an
  // ellipsis. With a px floor the cells keep their honest widths and the body
  // scrolls sideways below it (ScrollTable mirrors scrollLeft onto the head).
  //   session  id + client-ref chips + first-prompt line (the widest cell)
  //   apps     app-key / client badges, two lines deep when several appear
  //   model    model id over provider + tier badge on the provider line — the
  //            former standalone tier column merged here (a Combo badge or an
  //            explicit-mode dash is unreadable without the model context)
  //   tokens   the 1×4 volume stack (In / Cached / Out / Hit): one metric
  //            per line — a 2×2 half-column proved too narrow for label +
  //            value, so the full width belongs to each row now
  //   speed    TTFT P50 / TTFT P95 / output tok/s / stall ratio — 1×4 stack,
  //            same shape as tokens
  //   cost     sub-dollar `$0.078535` is the widest honest figure (9 glyphs at
  //            11px mono + 28px cell padding = 93px, hence 96); dollar-and-up
  //            values render 2 decimals (`$267.47`) and the exact number rides
  //            the cell tooltip.
  //   actions  ONE pinned column (sticky right): detail eye + usage chart +
  //            delete + capture jump — the row's whole click surface. With 12
  //            data columns the body scrolls sideways on narrow windows, and
  //            the actions would otherwise be the FIRST thing scrolled out of
  //            view; pinning keeps them reachable without scrolling. The
  //            former `detail` / `capture` columns are folded in here.
  //
  // Widths are MEASURED against real session data, not guessed. `cost` was 68
  // and overflowed by 26px on EVERY row — cost text carries no ellipsis, so it
  // bled into the Active column and made both look cramped — while `tokens`
  // carried ~30px of dead space per half. The rebalance moves that slack to
  // cost and leaves the table's total width (i.e. how much it scrolls
  // sideways) unchanged.
  const COL_W = {
    session: 156,
    apps: 88,
    // Model + tier in one cell (badge rides the provider line): the former
    // standalone tier column's 82px moved here.
    model: 186,
    switches: 60,
    turns: 54,
    requests: 58,
    tokens: 150,
    speed: 140,
    cost: 96,
    active: 68,
    actions: 128,
  } as const;
  const colMinWidth =
    COL_W.session + COL_W.apps + COL_W.model + COL_W.switches + COL_W.turns +
    COL_W.requests + COL_W.tokens + COL_W.speed + COL_W.cost + COL_W.active + COL_W.actions;
  // Switch-timeline modal: when every event shares one provider prefix, print
  // that prefix once as a header chip and show bare model ids in the rows.
  // Only pays off across MULTIPLE events — a single-row trail renders the
  // full ref inline instead of a dangling "ns/" fragment. (The request-detail
  // table needs no dedup: it prints each turn's full model ref on one line.)
  const providerNs =
    timeline && timeline.events.length > 1
      ? commonProviderOf(timeline.events.flatMap(ev => [ev.from, ev.to]))
      : null;
  const shortModel = (ns: string | null, m: string): string =>
    ns && m.startsWith(`${ns}/`) ? m.slice(ns.length + 1) : m;

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="card-header">
        <div className="card-title">
          <Users size={18} color="var(--accent-violet)" />
          <span>{t('sessions.sessionsTitle')}</span>
        </div>
        {/* flexWrap: at narrow window widths the toolbar wraps to a second row
            instead of clipping (same treatment as the captures toolbar). */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, flex: 1, justifyContent: 'flex-end' }}>
          <Combobox
            value={apiKeyFilter}
            onChange={v => {
              setApiKeyFilter(v);
              setPage(1);
            }}
            options={[
              { value: '', label: t('sessions.apiKeyAll') },
              ...apiKeyOptions.map(k => ({ value: k.id, label: k.name })),
            ]}
            style={{ fontSize: 'var(--text-sm)', padding: '5px 8px', width: 180 }}
          />
          <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 180, maxWidth: 420 }}>
            <Search
              size={12}
              style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', pointerEvents: 'none' }}
            />
            <input
              className="input"
              value={filterInput}
              onChange={e => setFilterInput(e.target.value)}
              placeholder={t('sessions.filterPlaceholder')}
              style={{ fontSize: 'var(--text-sm)', padding: '5px 8px 5px 24px', width: '100%' }}
            />
          </div>
          <button className="btn btn-sm" onClick={clearAll} disabled={loading || total === 0}>
            <Trash2 size={12} />
            <span>{t('sessions.clearAll')}</span>
          </button>
          <button className="btn btn-sm" onClick={loadData} disabled={loading}>
            <RefreshCw size={12} />
            <span>{t('sessions.refresh')}</span>
          </button>
        </div>
      </div>
      {/* The row filter for gateway-internal sessions sits HERE, next to the
          copy it explains, instead of in the action toolbar — the toolbar
          keeps the list-wide controls (app filter, search, clear, refresh).
          Server-side filter, ON by default (ADR-0015 D6b).
          flexWrap + `marginLeft: 'auto'` on the label: the paragraph shrinks
          first (it reflows), and only when even that is too narrow does the
          checkbox drop to its own right-aligned row instead of squeezing the
          copy to a column of single words. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, margin: '0 0 12px 0' }}>
        <p style={{ flex: 1, fontSize: 'var(--text-md)', color: 'var(--text-muted)', lineHeight: 'var(--leading-normal)', margin: 0 }}>
          {t('sessions.sessionsDesc')}
        </p>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 5, paddingTop: 2, flexShrink: 0, marginLeft: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-dim)', whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' }}
          title={t('sessions.hideInternalTip')}
        >
          <input
            type="checkbox"
            checked={hideInternal}
            onChange={(e) => {
              setHideInternal(e.target.checked);
              setPage(1);
            }}
            style={{ accentColor: 'var(--accent)' }}
          />
          {t('sessions.hideInternal')}
        </label>
      </div>

      {/* ScrollTable (repo standard for a scrolling table): the head is a
          normal row outside the body, and the body owns BOTH scroll axes.
          Columns carry PX widths and a matching horizontal floor — with 13
          columns, a percentage layout squeezes every cell into an ellipsis on
          a narrow window and the whole table turns into unreadable dots.
          Below the floor the body scrolls sideways (head follows) instead. */}
      <ScrollTable
        fill
        columns={[
          { key: 'session', label: t('sessions.thSessionId'), width: COL_W.session },
          { key: 'apps', label: t('sessions.thApps'), width: COL_W.apps, align: 'center' },
          { key: 'model', label: t('sessions.thCurrent'), width: COL_W.model, align: 'center' },
          { key: 'switches', label: t('sessions.thSwitches'), width: COL_W.switches, align: 'center' },
          {
            key: 'turns',
            label: <span title={t('sessions.thTurnsTip')}>{t('sessions.thTurns')}</span>,
            width: COL_W.turns,
            align: 'center',
          },
          { key: 'requests', label: t('sessions.thRequests'), width: COL_W.requests, align: 'center' },
          { key: 'tokens', label: t('sessions.thTokens'), width: COL_W.tokens },
          {
            key: 'speed',
            label: <span title={t('sessions.thSpeedTip')}>{t('sessions.thSpeed')}</span>,
            width: COL_W.speed,
          },
          { key: 'cost', label: t('sessions.thCost'), width: COL_W.cost, align: 'center' },
          { key: 'active', label: t('sessions.thActive'), width: COL_W.active, align: 'center' },
          {
            key: 'actions',
            label: t('sessions.thActions'),
            width: COL_W.actions,
            align: 'center',
            sticky: 'right',
          },
        ]}
        minWidth={colMinWidth}
        headCellStyle={{ padding: '10px 12px' }}
        empty={filter ? t('sessions.filterEmpty') : t('sessions.emptySessions')}
      >
            {sessions.map(s => (
                <tr key={s.id} style={{ borderBottom: '1px solid var(--divider)' }}>
                  <td
                    style={{
                      padding: '10px 14px',
                      textAlign: 'left',
                      fontFamily: FONT_MONO,
                      color: 'var(--text-main)',
                      // The id is a single opaque token: never break it across
                      // lines (a wrapped `sess_…` reads as two ids). Narrow
                      // windows ellipsize instead; the full value is in the
                      // title tooltip and the click-copy target.
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      {/* Minting side rides IN FRONT of the id (see
                          IdSourceBadge): as a prefix it labels the value that
                          follows, always stays visible when the cell ellipsizes
                          (a trailing badge is the first thing a truncated row
                          drops), and keeps the copy target = the id alone. */}
                      {s.idSource && <IdSourceBadge source={s.idSource} t={t} />}
                      <span
                        title={s.id}
                        style={{
                          cursor: 'copy',
                          flex: '1 1 auto',
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        onClick={async () => {
                          const ok = await copyToClipboard(s.id);
                          if (ok) toast.success(t('sessions.copiedSessionId'));
                          else toast.error(t('sessions.copyFailed'));
                        }}
                      >
                        {formatSessionId(s.id)}
                      </span>
                    </span>
                    {/* Internal marker: with the filter on, internal rows never
                        reach the client at all (server-side exclusion), so this
                        badge only ever appears after the checkbox above was
                        cleared — it is what makes those rows identifiable. */}
                    {s.internal && (
                      <span
                        title={t('sessions.internalBadgeTip')}
                        style={{
                          display: 'inline-block',
                          marginLeft: '6px',
                          verticalAlign: 'middle',
                          fontFamily: 'inherit',
                          fontSize: 'var(--text-2xs)',
                          lineHeight: 'var(--leading-14)',
                          padding: '1px 6px',
                          borderRadius: '4px',
                          background: 'var(--chip-bg)',
                          border: '1px solid var(--divider)',
                          color: 'var(--text-dim)',
                        }}
                      >
                        {t('sessions.internalBadge')}
                      </span>
                    )}
                    {/* Client-minted conversation id(s): the OTHER half of the
                        mapping (ADR-0002 §1). Line 2, right under the gateway
                        id, so the two id namespaces read as a pair — and sized
                        to the id's own width (~21 mono chars ≈ 151px) rather
                        than to the cell, so the chip's right edge lands on the
                        id's last glyph instead of floating past it. Full value
                        in the tooltip, click copies the complete id, and the
                        detail dialog prints it unclipped. */}
                    {s.clientRefs && s.clientRefs.length > 0 && (
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '4px',
                          marginTop: '3px',
                          minWidth: 0,
                        }}
                      >
                        {s.clientRefs.map(ref => (
                          <span
                            key={`${ref.kind}:${ref.id}`}
                            title={t('sessions.clientRefTooltip', { kind: ref.kind, id: ref.id })}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '5px',
                              minWidth: 0,
                              maxWidth: '100%',
                              padding: '1px 6px',
                              borderRadius: '4px',
                              background: 'var(--chip-bg)',
                              border: '1px solid var(--divider)',
                              lineHeight: 'var(--leading-14)',
                              verticalAlign: 'middle',
                              cursor: 'copy',
                            }}
                            onClick={async () => {
                              const ok = await copyToClipboard(ref.id);
                              if (ok) toast.success(t('sessions.copiedClientRef'));
                              else toast.error(t('sessions.copyFailed'));
                            }}
                          >
                            <span
                              style={{
                                flex: 'none',
                                fontSize: 'var(--text-3xs)',
                                letterSpacing: '0.08em',
                                textTransform: 'uppercase',
                                color: 'var(--text-dim)',
                              }}
                            >
                              {ref.kind}
                            </span>
                            {/* 15 leading characters + ellipsis is what makes
                                the chip 152px wide — the run of a 21-char
                                gateway id at 12px mono (151px), measured, not
                                guessed. A CSS ellipsis would size the chip to
                                the cell instead (it grows to fit whatever the
                                column allows), which is the alignment the row
                                should NOT have. A trailing separator (UUID
                                hyphen) is dropped so the label ends on a glyph,
                                not on a dangling dash: 56-60 bits, unambiguous
                                between rows. */}
                            <span
                              style={{
                                fontFamily: FONT_MONO,
                                fontSize: 'var(--text-2xs)',
                                color: 'var(--text-dim)',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {ref.id.length > 15
                                ? `${ref.id.slice(0, 15).replace(/-$/, '')}…`
                                : ref.id}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                    {/* Title = first user prompt (backend-capped summary);
                        single line, ellipsized, full text in the tooltip. It
                        follows the id pair: the ids identify, the title says
                        what the conversation was about. */}
                    {s.firstUserMessage && (
                      <div
                        title={s.firstUserMessage}
                        style={{
                          marginTop: '3px',
                          fontSize: 'var(--text-xs)',
                          color: 'var(--text-dim)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          cursor: 'copy',
                        }}
                        onClick={async () => {
                          const ok = await copyToClipboard(s.firstUserMessage!);
                          if (ok) toast.success(t('sessions.copiedPrompt'));
                          else toast.error(t('sessions.copyFailed'));
                        }}
                      >
                        {s.firstUserMessage}
                      </div>
                    )}
                  </td>
                  <td
                    style={{
                      // Tightest horizontal padding of any cell: the column
                      // is only 88px and each side's padding comes straight
                      // out of the badge text (a 14px side leaves ~44px of
                      // name — one ellipsized word). 8px keeps the column
                      // from touching its neighbors while the badge text
                      // gets the width back.
                      padding: '10px 8px',
                    }}
                  >
                    {(s.apiKeys && s.apiKeys.length > 0) || (s.clients && s.clients.length > 0) ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '4px' }}>
                        {s.apiKeys?.map(k => (
                          <span
                            key={k.id}
                            title={t('captures.apiKeyTooltip', { name: k.name, id: k.id })}
                            style={{
                              fontSize: 'var(--text-2xs)',
                              lineHeight: 'var(--leading-14)',
                              // Chip chrome (padding + border) eats into the
                              // 88px column — 4px sides keep the name legible.
                              padding: '1px 4px',
                              borderRadius: '4px',
                              background: 'color-mix(in srgb, var(--accent-emerald) 10%, transparent)',
                              border: '1px solid color-mix(in srgb, var(--accent-emerald) 25%, transparent)',
                              color: 'var(--accent-emerald)',
                              maxWidth: '150px',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {k.name}
                          </span>
                        ))}
                        {s.clients?.map(ua => (
                          <span
                            key={ua}
                            title={t('sessions.clientTip', { ua })}
                            style={{
                              fontSize: 'var(--text-2xs)',
                              lineHeight: 'var(--leading-14)',
                              padding: '1px 4px',
                              borderRadius: '4px',
                              background: 'color-mix(in srgb, var(--accent-violet) 10%, transparent)',
                              border: '1px solid color-mix(in srgb, var(--accent-violet) 25%, transparent)',
                              color: 'var(--accent-violet)',
                              maxWidth: '150px',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {clientDisplayName(ua)}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span style={{ color: 'var(--text-dim)' }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', fontWeight: 'var(--font-semibold)', textAlign: 'center' }}>
                    <ModelRefCell
                      model={s.currentModel}
                      provider={s.currentProvider}
                      tier={<TierBadge s={s} />}
                    />
                    {/* Credential affinity: the operator's label when the
                        registry chain carries one, else the display-safe
                        keyHash prefix (ADR-0002 §3). */}
                    {s.boundKeyHashPrefix && (
                      <span
                        title={t('sessions.boundCredentialTip', {
                          prefix: s.boundKeyHashPrefix,
                          time: s.boundAt ? new Date(s.boundAt).toLocaleString() : '—',
                        })}
                        style={{
                          display: 'block',
                          marginTop: '3px',
                          fontSize: 'var(--text-2xs)',
                          fontFamily: s.boundCredentialLabel ? undefined : FONT_MONO,
                          lineHeight: 'var(--leading-14)',
                          padding: '1px 6px',
                          borderRadius: '4px',
                          background: 'var(--chip-bg)',
                          border: '1px solid var(--card-border)',
                          color: 'var(--text-dim)',
                          fontWeight: 'var(--font-medium)',
                          maxWidth: '100%',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {s.boundCredentialLabel || `#${s.boundKeyHashPrefix}`}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                    <span
                      role="button"
                      title={`${t('sessions.switchTitle')} · ${t('sessions.switchHint')}`}
                      onClick={() => openTimeline(s, false)}
                      style={{
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        fontFamily: FONT_MONO,
                        fontWeight: 'var(--font-semibold)',
                        // Color = signal: blue only when switches actually
                        // happened; a zero row stays quiet gray.
                        color: s.switchCount > 0 ? 'var(--accent)' : 'var(--text-dim)',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                      onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                    >
                      <GitBranch size={12} />
                      ×{s.switchCount}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'center' }}>{s.turnCount}</td>
                  <td style={{ padding: '10px 14px', fontFamily: FONT_MONO, textAlign: 'center' }}>
                    {s.traceCount.toLocaleString()}
                  </td>
                  <td
                    style={{
                      padding: '10px 10px',
                      textAlign: 'left',
                      // Same rationale as the speed cell: the 2×2 labels
                      // (In/Cached/Out/Hit) yield width first, so padding is
                      // what gets reclaimed at the 150px floor.
                    }}
                  >
                    {/* Volume: In / Cached / Out / Hit — 1×4 stack, same
                        shape as the speed cell (see .tokens-stat-grid in
                        index.css for why 1×4 beats 2×2 here). */}
                    <div className="tokens-stat-grid">
                      <TokenStatRow
                        label={t('sessions.tokenIn')}
                        value={tokenDisplay(s.inputTokens)}
                        title={s.inputTokens.toLocaleString()}
                      />
                      <TokenStatRow
                        label={t('sessions.tokenCached')}
                        value={tokenDisplay(s.cachedTokens)}
                        title={s.cachedTokens.toLocaleString()}
                        color={s.cachedTokens > 0 ? 'var(--accent-emerald)' : 'var(--text-dim)'}
                      />
                      <TokenStatRow
                        label={t('sessions.tokenOut')}
                        value={tokenDisplay(s.outputTokens)}
                        title={s.outputTokens.toLocaleString()}
                        color="var(--text-muted)"
                      />
                      <TokenStatRow
                        label={t('sessions.tokenHit')}
                        value={
                          s.inputTokens > 0
                            // Integer percent: a half-column is ~60px of room at
                            // ordinary window widths, and one decimal pushes
                            // "100.0%" past it (the row would ellipsize). The
                            // exact rate is in the tooltip.
                            ? `${Math.round((s.cachedTokens / s.inputTokens) * 100)}%`
                            : '—'
                        }
                        title={
                          s.inputTokens > 0
                            ? t('sessions.cacheHitRate', { pct: ((s.cachedTokens / s.inputTokens) * 100).toFixed(1) })
                            : undefined
                        }
                        color="var(--text-dim)"
                      />
                    </div>
                  </td>
                  <td
                    style={{
                      padding: '10px 10px',
                      textAlign: 'left',
                      // Tighter than the default cell: every px of padding
                      // comes out of the four labels — a squeezed label
                      // ellipsizes FIRST (the value never yields), so
                      // reclaiming padding here is what keeps
                      // "TTFT"/output/stall ratio legible at the column's
                      // 140px floor. Same rationale applies to the speed
                      // cell's <td> below (shared shape, shared padding).
                    }}
                  >
                    {/* Industry decomposition of a streamed turn, all three
                        over STREAMED turns only:
                          TTFT  P50 — request start → first streamed chunk
                                (queueing + network + prefill + first decode
                                step; a proxy cannot separate those, so the
                                number is honestly named for the whole path)
                          P95   — the tail. Latency is a distribution: the
                                mean is the one statistic that hides a cold
                                start, which is why no published latency table
                                reports it.
                          Out   — output tokens ÷ decode window (first chunk
                                → stream end), i.e. OTel's time_per_output_token
                                inverted. No "prefill rate" row: prefill is a
                                server-internal measurement this proxy cannot
                                observe, and inventing input÷TTFT would just
                                track cache-hit rate.
                        Each row is one line (TokenStatRow never wraps); '—'
                        when the session never streamed. */}
                    {/* Speed cell — same 1×4 shape as the tokens cell (shared
                        CSS, index.css): TTFT P50 → P95 → output tok/s →
                        stall ratio, one metric per line, label carries the
                        qualifier so the bare value never squeezes it out.
                        Row order never changes — each metric keeps its color
                        and tooltip identity. '—' when never streamed.
                        Layout lives in .tokens-speed-stack, not inline.
                        Each row is one line (TokenStatRow never wraps); the
                        session-id cell sets the row height, four rows do not
                        grow it. */}
                    <div className="tokens-speed-stack">
                      <TokenStatRow
                        // The LABEL carries the unit ("TTFT P50"), the value
                        // stays a bare compact number — the Tokens-cell trick
                        // that keeps every label fully visible in a 140px
                        // column: short values leave the label room; a
                        // value-side suffix ("1.2s (P95)") is what squeezed
                        // the labels out. The full figure + unit + sample
                        // count ride the tooltip.
                        label={`${t('usage.ttft')} P50`}
                        value={s.ttftP50Ms !== undefined ? fmtLatency(s.ttftP50Ms) : '—'}
                        title={
                          s.ttftP50Ms !== undefined
                            ? `${t('sessions.ttftP50Tip')} · ${t('sessions.samples', { n: String(s.ttftSamples) })}`
                            : t('usage.ttftTip')
                        }
                        color="var(--text-muted)"
                      />
                      <TokenStatRow
                        // Same metric as the row above, tail percentile: the
                        // P50/P95 distinction lives in the LABEL (they sit in
                        // the same 2×2 row, visually paired), the value stays
                        // bare. Below two samples P95 IS P50 — showing the
                        // same number twice reads as a bug, hence '—'.
                        label={`${t('usage.ttft')} P95`}
                        value={
                          s.ttftP95Ms !== undefined && s.ttftSamples >= 2
                            ? fmtLatency(s.ttftP95Ms)
                            : '—'
                        }
                        title={t('sessions.ttftP95Tip')}
                        color="var(--text-dim)"
                      />
                      <TokenStatRow
                        // Unit (tok/s) rides the LABEL here too — the value
                        // stays a bare compact figure so the label never
                        // ellipsizes; the exact rate + unit + OTel-metric
                        // caveat live in the tooltip.
                        label={`${t('sessions.speedOutput')} ${t('usage.thToks')}`}
                        value={
                          s.genOutputTokens > 0 && s.genMsSum > 0
                            ? formatSpeed(decodeRate(s.genOutputTokens, s.genMsSum))
                            : '—'
                        }
                        title={
                          s.genOutputTokens > 0 && s.genMsSum > 0
                            ? `${formatSpeed(decodeRate(s.genOutputTokens, s.genMsSum))} ${t('usage.thToks')} · ${t('sessions.speedOutputTip')}`
                            : t('sessions.speedOutputTip')
                        }
                        color="var(--text-muted)"
                      />
                      {/* Perceived stall ratio: share of the decode window
                          spent in ≥1 s pauses. A share (not a longest-gap
                          maximum) so repeated stutters and one long freeze
                          land on the same scale; amber past the threshold
                          announces a choppy session without a tooltip. '—'
                          means no gap was measurable (never streamed, or a
                          single output chunk). */}
                      <TokenStatRow
                        label={t('sessions.speedStallRatio')}
                        value={fmtStallRatio(s.stallRatio)}
                        title={t('sessions.speedStallRatioTip')}
                        color={
                          s.stallRatio !== undefined && s.stallRatio >= STALL_RATIO_WARN
                            ? 'var(--accent-amber)'
                            : 'var(--text-dim)'
                        }
                      />
                    </div>
                  </td>
                  <td
                    style={{
                      padding: '10px 14px',
                      textAlign: 'center',
                      // Amber = money, consistent with the /usage table & cards.
                      color: 'var(--accent-amber)',
                      fontFamily: FONT_MONO,
                      // Belt and braces after the width fix: a cost figure with
                      // more digits than the column allows must ellipsize in
                      // place, never spill into the Active column (fixed table
                      // layout does not clip overflowing text by itself).
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={formatCost(s.costUsd)}
                  >
                    {formatCostCompact(s.costUsd)}
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-dim)', textAlign: 'center' }}>
                    {new Date(s.lastActiveAt).toLocaleTimeString()}
                  </td>
                  <td
                  style={{
                    ...stickyBodyCell,
                    padding: '10px 12px',
                    // Flex row: the icons must never wrap — a wrapped pair
                    // doubles every row's height.
                  }}
                >
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
                    <span
                      role="button"
                      aria-label={t('sessions.viewDetail')}
                      title={t('sessions.viewDetail')}
                      onClick={() => openTimeline(s, true)}
                      style={{
                        color: 'var(--text-dim)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
                      onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
                    >
                      <Eye size={13} />
                    </span>
                    <span
                      role="button"
                      aria-label={t('sessions.viewUsage')}
                      title={t('sessions.viewUsage')}
                      onClick={() => navigate(`/usage?session=${encodeURIComponent(s.id)}`)}
                      style={{
                        color: 'var(--text-dim)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
                      onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
                    >
                      <BarChart3 size={13} />
                    </span>
                    <span
                      role="button"
                      aria-label={t('sessions.deleteSession')}
                      title={t('sessions.deleteSession')}
                      onClick={() => deleteOne(s)}
                      style={{
                        color: 'var(--text-dim)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent-rose)')}
                      onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
                    >
                      <Trash2 size={13} />
                    </span>
                    {captureOn && (
                      <span
                        role="button"
                        aria-label={t('sessions.jumpToCapture')}
                        title={t('sessions.jumpToCapture')}
                        onClick={() => navigate(`/captures?session=${encodeURIComponent(s.id)}`)}
                        style={{
                          color: 'var(--text-dim)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          cursor: 'pointer',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
                        onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
                      >
                        <Archive size={13} />
                      </span>
                    )}
                    </span>
                  </td>
                </tr>
              ))}
      </ScrollTable>
      <div style={{ padding: '0 14px' }}>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onChange={setPage}
          disabled={loading}
          showSummary
          pageSizeOptions={PAGE_SIZES}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        />
      </div>

      {/* Model-switch timeline modal (fetched on demand per session). The
          shared Dialog shell portals to document.body — the page root .card's
          backdrop-filter would otherwise make itself the containing block
          for fixed descendants and size the scrim to the card. */}
      {timeline && (
        <Dialog
          title={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <GitBranch size={16} color="var(--accent)" />
              {t('sessions.detailTitle')}
            </span>
          }
          subtitle={
            <span
              style={{
                display: 'inline-flex',
                flexDirection: 'column',
                gap: '2px',
                fontFamily: FONT_MONO,
                fontSize: 'var(--text-xs)',
                wordBreak: 'break-all',
              }}
            >
              <span>
                {/* Same minting-side marker as the table row, IN FRONT of the id
                    for the same reason (it labels the value that follows). The
                    dialog keeps the WORD beside the icon: it is where the
                    operator decides whether the id's length is the client's
                    choice or the gateway's, and a bare tooltip would hide it. */}
                {timeline.session.idSource && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      marginRight: 8,
                      verticalAlign: 'middle',
                    }}
                  >
                    <IdSourceBadge source={timeline.session.idSource} t={t} />
                    <span
                      style={{
                        fontFamily: 'inherit',
                        fontSize: 'var(--text-2xs)',
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        color:
                          timeline.session.idSource === 'client'
                            ? 'var(--accent)'
                            : 'var(--text-dim)',
                      }}
                    >
                      {t(
                        timeline.session.idSource === 'client'
                          ? 'sessions.idSourceClient'
                          : 'sessions.idSourceGateway'
                      )}
                    </span>
                  </span>
                )}
                {timeline.session.id}
              </span>
              {/* The row can only afford a truncated prefix of a client-minted
                  conversation id; this dialog is where the FULL value is
                  readable and copyable (ADR-0002 §1). */}
              {timeline.session.clientRefs?.map(ref => (
                <span
                  key={`${ref.kind}:${ref.id}`}
                  title={t('sessions.clientRefTooltip', { kind: ref.kind, id: ref.id })}
                  style={{ color: 'var(--text-dim)', cursor: 'copy' }}
                  onClick={async () => {
                    const ok = await copyToClipboard(ref.id);
                    if (ok) toast.success(t('sessions.copiedClientRef'));
                    else toast.error(t('sessions.copyFailed'));
                  }}
                >
                  {ref.kind} · {ref.id}
                </span>
              ))}
            </span>
          }
          onClose={() => setTimeline(null)}
          closeLabel={t('common.close')}
          // 1080 − 2×20 card padding fits the request grid's ~1008px of
          // column minima with the right padding intact. Expanded keeps a
          // 10% viewport margin on all sides (90vw × 90vh) instead of the
          // viewport-filling `full` mode.
          width={1080}
          maxSize={detailFull ? { width: '90vw', height: '90vh' } : undefined}
          headerActions={
            <button
              type="button"
              className="btn btn-sm"
              style={{ display: 'flex', alignItems: 'center', height: 24, padding: '0 6px' }}
              onClick={() => {
                const next = !detailFull;
                setDetailFull(next);
                // The 90vh card fits ~25 rows; the collapsed one ~20. Follow
                // the toggle between those defaults, leaving a manually
                // chosen page size (via the pager) untouched.
                setDetailPageSize(s => (next ? (s === 20 ? 25 : s) : (s === 25 ? 20 : s)));
              }}
              title={detailFull ? t('captures.collapse') : t('captures.expand')}
              aria-label={detailFull ? t('captures.collapse') : t('captures.expand')}
            >
              {detailFull ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
          }
        >
            {/* Session summary card. The dialog used to open on an id and a
                switch trail — every quantity the list row showed (model, tier,
                tokens, cost, and the streamed-only TTFT percentiles + output
                speed) disappeared exactly when the session was inspected.

                Shape: a FIXED 6-track grid, not a flex-wrap strip. Content-
                sized cells were what made the old block look ragged (each cell
                wrapped at its own width, so rows never lined up). Wide figures
                share a row as dot-separated series, so every track has one
                value line and the card reads as a 2×6 matrix.

                Collapsible: the whole card is reference data, and an operator
                who opened the dialog to read the request table does not need it
                taking a third of the body. */}
            <div
              style={{
                border: '1px solid var(--divider)',
                borderRadius: 8,
                background: 'color-mix(in srgb, var(--card-bg), var(--bg))',
                overflow: 'hidden',
                // The Dialog body is a flex COLUMN, so every card is a flex item
                // and would be shrunk (flex-shrink defaults to 1) whenever the
                // body is height-capped — `overflow: hidden` then silently clips
                // the grid. `0 0 auto` keeps each card at content height; the
                // request-detail card below is the only one that may flex-fill.
                flex: '0 0 auto',
              }}
            >
              <button
                type="button"
                aria-expanded={timeline.summaryOpen}
                onClick={() => setTimeline(cur => (cur ? { ...cur, summaryOpen: !cur.summaryOpen } : cur))}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  padding: '9px 12px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text-dim)',
                  fontSize: 'var(--text-2xs)',
                  fontWeight: 'var(--font-bold)',
                  textTransform: 'uppercase',
                  letterSpacing: 'var(--tracking-label)',
                  textAlign: 'left',
                }}
              >
                {timeline.summaryOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>{t('sessions.summaryTitle')}</span>
                {!timeline.summaryOpen && (
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontFamily: FONT_MONO,
                      fontSize: 'var(--text-xs)',
                      textTransform: 'none',
                      letterSpacing: 0,
                      color: 'var(--text-muted)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {modelFullRef(timeline.session.currentModel, timeline.session.currentProvider)}
                    {timeline.session.ttftP50Ms !== undefined
                      ? ` · ${t('usage.ttft')} ${fmtLatency(timeline.session.ttftP50Ms)}`
                      : ''}
                  </span>
                )}
              </button>
              {timeline.summaryOpen && (
                <div style={{ padding: '2px 12px 14px' }}>
                  {/* One bordered Descriptions list: label cell + value cell per
                      metric, so the block reads as a table (the shape users
                      already know from every detail drawer) instead of the old
                      scattered stat tiles whose tracks were sized by content.
                      Tokens and Speed each merge their four sub-metrics into
                      ONE value cell — they are one fact each (token split,
                      latency profile), not eight separate fields. */}
                  <Descriptions
                    column={2}
                    items={[
                      {
                        key: 'model',
                        label: t('sessions.thCurrent'),
                        span: 2,
                        children: (
                          <span
                            title={modelFullRef(timeline.session.currentModel, timeline.session.currentProvider)}
                            style={{
                              fontFamily: FONT_MONO,
                              fontSize: 'var(--text-sm)',
                              fontWeight: 'var(--font-semibold)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              minWidth: 0,
                            }}
                          >
                            {modelFullRef(timeline.session.currentModel, timeline.session.currentProvider)}
                          </span>
                        ),
                      },
                      {
                        key: 'tier',
                        label: t('sessions.thTier'),
                        children: <TierBadge s={timeline.session} />,
                      },
                      {
                        key: 'cost',
                        label: t('sessions.thCost'),
                        children: (
                          <span
                            style={{
                              fontFamily: FONT_MONO,
                              fontWeight: 'var(--font-semibold)',
                              color: 'var(--accent-amber)',
                              fontSize: 'var(--text-sm)',
                            }}
                          >
                            {formatCost(timeline.session.costUsd)}
                          </span>
                        ),
                      },
                      {
                        key: 'requests',
                        label: t('sessions.thRequests'),
                        children: (
                          <span style={{ fontFamily: FONT_MONO, fontWeight: 'var(--font-semibold)', fontSize: 'var(--text-sm)' }}>
                            {timeline.session.traceCount.toLocaleString()}
                          </span>
                        ),
                      },
                      {
                        key: 'turns',
                        label: t('sessions.thTurns'),
                        title: t('sessions.thTurnsTip'),
                        children: (
                          <span style={{ fontFamily: FONT_MONO, fontWeight: 'var(--font-semibold)', fontSize: 'var(--text-sm)' }}>
                            {timeline.session.turnCount.toLocaleString()}
                          </span>
                        ),
                      },
                      {
                        key: 'tokens',
                        label: t('sessions.thTokens'),
                        span: 2,
                        children: (
                          <SummarySeries
                            items={[
                              {
                                key: 'in',
                                node: (
                                  <SummaryStat
                                    label={t('sessions.tokenIn')}
                                    value={tokenDisplay(timeline.session.inputTokens)}
                                    title={timeline.session.inputTokens.toLocaleString()}
                                  />
                                ),
                              },
                              {
                                key: 'cached',
                                node: (
                                  <SummaryStat
                                    label={t('sessions.tokenCached')}
                                    value={tokenDisplay(timeline.session.cachedTokens)}
                                    title={timeline.session.cachedTokens.toLocaleString()}
                                    color={timeline.session.cachedTokens > 0 ? 'var(--accent-emerald)' : 'var(--text-dim)'}
                                  />
                                ),
                              },
                              {
                                key: 'out',
                                node: (
                                  <SummaryStat
                                    label={t('sessions.tokenOut')}
                                    value={tokenDisplay(timeline.session.outputTokens)}
                                    title={timeline.session.outputTokens.toLocaleString()}
                                    color="var(--text-muted)"
                                  />
                                ),
                              },
                              {
                                key: 'hit',
                                node: (
                                  <SummaryStat
                                    label={t('sessions.tokenHit')}
                                    value={
                                      timeline.session.inputTokens > 0
                                        ? `${Math.round((timeline.session.cachedTokens / timeline.session.inputTokens) * 100)}%`
                                        : '—'
                                    }
                                    title={
                                      timeline.session.inputTokens > 0
                                        ? t('sessions.cacheHitRate', {
                                            pct: ((timeline.session.cachedTokens / timeline.session.inputTokens) * 100).toFixed(1),
                                          })
                                        : undefined
                                    }
                                    color="var(--text-dim)"
                                  />
                                ),
                              },
                            ]}
                          />
                        ),
                      },
                      {
                        key: 'speed',
                        label: t('sessions.thSpeed'),
                        title: t('sessions.thSpeedTip'),
                        span: 2,
                        children: (
                          <SummarySeries
                            items={[
                              {
                                key: 'ttft',
                                node: (
                                  <SummaryStat
                                    label={t('usage.ttft')}
                                    value={
                                      timeline.session.ttftP50Ms !== undefined ? fmtLatency(timeline.session.ttftP50Ms) : '—'
                                    }
                                    title={
                                      timeline.session.ttftP50Ms !== undefined
                                        ? `${t('sessions.ttftP50Tip')} · ${t('sessions.samples', { n: String(timeline.session.ttftSamples) })}`
                                        : t('usage.ttftTip')
                                    }
                                    color="var(--text-muted)"
                                  />
                                ),
                              },
                              {
                                key: 'p95',
                                node: (
                                  <SummaryStat
                                    label={t('usage.ttft')}
                                    value={
                                      timeline.session.ttftP95Ms !== undefined && timeline.session.ttftSamples >= 2
                                        ? `${fmtLatency(timeline.session.ttftP95Ms)} ${t('sessions.speedP95')}`
                                        : '—'
                                    }
                                    title={t('sessions.ttftP95Tip')}
                                    color="var(--text-dim)"
                                  />
                                ),
                              },
                              {
                                key: 'rate',
                                node: (
                                  <SummaryStat
                                    label={t('sessions.speedDecode')}
                                    value={
                                      timeline.session.genOutputTokens > 0 && timeline.session.genMsSum > 0
                                        ? `${formatSpeed(decodeRate(timeline.session.genOutputTokens, timeline.session.genMsSum))} ${t('usage.thToks')}`
                                        : '—'
                                    }
                                    title={t('sessions.speedOutputTip')}
                                    color="var(--text-muted)"
                                  />
                                ),
                              },
                              {
                                key: 'silent',
                                node: (
                                  <SummaryStat
                                    label={t('sessions.speedStallRatio')}
                                    value={fmtStallRatio(timeline.session.stallRatio)}
                                    title={t('sessions.speedStallRatioTip')}
                                    color={
                                      timeline.session.stallRatio !== undefined &&
                                      timeline.session.stallRatio >= STALL_RATIO_WARN
                                        ? 'var(--accent-amber)'
                                        : 'var(--text-dim)'
                                    }
                                  />
                                ),
                              },
                            ]}
                          />
                        ),
                      },
                    ]}
                  />
                </div>
              )}
            </div>
            {/* Model-switch trail — the SAME card shell as the summary above
                (border + rounded + fold header), because it was the only
                section floating loose inside the dialog body. Its header is a
                real button so the fold is keyboard-operable, and it carries the
                switch count on the right the way the list column does. */}
            <div
              style={{
                border: '1px solid var(--divider)',
                borderRadius: 8,
                background: 'color-mix(in srgb, var(--card-bg), var(--bg))',
                overflow: 'hidden',
                // Content-height like the summary card — see the flex note there.
                flex: '0 0 auto',
              }}
            >
              <button
                type="button"
                aria-expanded={timeline.trailOpen}
                onClick={() => setTimeline(cur => (cur ? { ...cur, trailOpen: !cur.trailOpen } : cur))}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  padding: '9px 12px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text-dim)',
                  fontSize: 'var(--text-2xs)',
                  fontWeight: 'var(--font-bold)',
                  textTransform: 'uppercase',
                  letterSpacing: 'var(--tracking-label)',
                  textAlign: 'left',
                }}
              >
                {timeline.trailOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>{t('sessions.switchTitle')}</span>
                <span
                  style={{
                    marginLeft: 'auto',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontFamily: FONT_MONO,
                    fontSize: 'var(--text-xs)',
                    textTransform: 'none',
                    letterSpacing: 0,
                    color: timeline.session.switchCount > 0 ? 'var(--accent)' : 'var(--text-dim)',
                  }}
                >
                  <GitBranch size={11} />×{timeline.session.switchCount}
                </span>
              </button>
              {timeline.trailOpen && (
                <div style={{ padding: '2px 12px 14px' }}>
                  {timeline.events.length === 0 ? (
                    <p style={{ fontSize: 'var(--text-md)', color: 'var(--text-dim)', margin: 0 }}>{t('sessions.switchEmpty')}</p>
                  ) : (
              <>
              {/* Legend, not a header ornament: the chip explains why the rows
                  BELOW omit `provider/`, so it belongs with them (and only
                  exists while they are visible). It also keeps the fold header
                  to two things — title and count. */}
              {providerNs && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    marginBottom: 10,
                    fontSize: 'var(--text-2xs)',
                    color: 'var(--text-dim)',
                  }}
                >
                  <ProviderNsChip ns={providerNs} />
                  <span>{t('sessions.switchPrefixLegend')}</span>
                </div>
              )}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  // Spine: rows read as one chronological trail, the per-row
                  // dot carries the badge's kind color.
                  borderLeft: '2px solid var(--divider)',
                  paddingLeft: '16px',
                  marginLeft: '4px',
                }}
              >
                {timeline.events.map((ev, i) => {
                  // A detail that merely restates the transition (the gateway's
                  // raw reason can be the bare target ref) is pure noise.
                  const detail =
                    ev.detail && ev.detail !== ev.to && ev.detail !== `${ev.from} → ${ev.to}` ? ev.detail : undefined;
                  // L2 decision identity lives in the tooltip only (suffix line) —
                  // an inline model id reads like reverse inference.
                  const detailTip =
                    ev.tieredDetail?.model && detail
                      ? `${detail}\n${t('routing.reason.decisionModel', { model: ev.tieredDetail.model })}`
                      : detail;
                  return (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: '10px',
                        fontSize: 'var(--text-sm)',
                        flexWrap: 'wrap',
                        position: 'relative',
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          position: 'absolute',
                          // 6px dot centered on the 2px spine: row content
                          // starts 18px from the container edge (2 border +
                          // 16 padding), so left edge = 1 - 3 - 18 = -20.
                          left: -20,
                          top: 4,
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: SWITCH_DOT[ev.kind],
                        }}
                      />
                      <span style={{ fontFamily: FONT_MONO, color: 'var(--text-dim)', minWidth: 68 }}>
                        {new Date(ev.at).toLocaleTimeString()}
                      </span>
                      <span className={'badge' + (SWITCH_BADGE[ev.kind] ? ` ${SWITCH_BADGE[ev.kind]}` : '')}>
                        {t(SWITCH_LABEL[ev.kind])}
                      </span>
                      <span
                        title={providerNs ? (ev.from ? `${ev.from} → ${ev.to}` : ev.to) : undefined}
                        style={{ fontWeight: 'var(--font-semibold)', fontFamily: FONT_MONO }}
                      >
                        {ev.from ? <><span style={{ color: 'var(--text-dim)' }}>{shortModel(providerNs, ev.from)}</span>{' → '}</> : null}
                        {shortModel(providerNs, ev.to)}
                      </span>
                      {detail && (
                        <span
                          style={{ color: 'var(--text-dim)', fontSize: 'var(--text-xs)', flexBasis: '100%', wordBreak: 'break-word' }}
                          title={detailTip}
                        >
                          {ev.tieredDetail ? (
                            <>
                              {ev.tieredDetail.pre}
                              <span
                                className={`badge ${TIER_BADGE[ev.tieredDetail.tier as SessionRecord['maxTier']] ?? ''}`}
                                style={{ margin: '0 3px' }}
                              >
                                {TIER_LABEL[ev.tieredDetail.tier as SessionRecord['maxTier']]
                                  ? t(TIER_LABEL[ev.tieredDetail.tier as SessionRecord['maxTier']])
                                  : ev.tieredDetail.tier}
                              </span>
                              {ev.tieredDetail.post}
                            </>
                          ) : (
                            detail
                          )}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              </>
                  )}
                </div>
              )}
            </div>
            {/* Per-request detail: every turn's recorded token counts + actual
                cost. Third card in the same shell as the two above — a
                separated block, so the dialog reads as three stacked panels
                instead of one panel plus two loose sections. */}
            {timeline.traces.length > 0 && (
              <div style={{
                border: '1px solid var(--divider)',
                borderRadius: 8,
                background: 'color-mix(in srgb, var(--card-bg), var(--bg))',
                overflow: 'hidden',
                // Expanded: this card fills the Dialog body's remaining height
                // so the request table scrolls internally — ScrollTable keeps
                // its head OUTSIDE that scroller (no floating/sticky header)
                // while the Dialog chrome (title, folds, pager) stays put.
                // Collapsed: content-sized.
                display: 'flex',
                flexDirection: 'column',
                // Expanded: fill the remaining height so the table scrolls
                // inside. Collapsed (or windowed): content height — a shrinkable
                // card would let `overflow: hidden` clip the last row.
                flex: detailFull ? '1 1 0' : '0 0 auto',
                minHeight: 0,
              }}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={timeline.detailOpen}
                  onClick={() => setTimeline(cur => (cur ? { ...cur, detailOpen: !cur.detailOpen } : cur))}
                  onKeyDown={e => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    setTimeline(cur => (cur ? { ...cur, detailOpen: !cur.detailOpen } : cur));
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '9px 12px',
                    fontSize: 'var(--text-2xs)',
                    fontWeight: 'var(--font-bold)',
                    textTransform: 'uppercase',
                    letterSpacing: 'var(--tracking-label)',
                    color: 'var(--text-dim)',
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  {timeline.detailOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span>{t('sessions.requestsTitle', { count: timeline.traces.length })}</span>
                  {/* Sort toggle: icon-only ghost button (same language as
                      RoundCard's header icons — a boxed btn read too heavy
                      on the 11px fold row). Title = what a click switches
                      to; stopPropagation keeps the section fold. */}
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      setDetailDesc(d => !d);
                    }}
                    title={detailDesc ? t('sessions.requestsSortAsc') : t('sessions.requestsSortDesc')}
                    style={{
                      marginLeft: 'auto',
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-dim)',
                      cursor: 'pointer',
                      padding: 2,
                      display: 'flex',
                      alignItems: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {detailDesc ? <ArrowDownWideNarrow size={12} /> : <ArrowUpNarrowWide size={12} />}
                  </button>
                </div>
                {timeline.detailOpen && (
                <ScrollTable
                  // Expanded: the body is the section's flex-fill scroll
                  // region (ScrollTable keeps the head OUTSIDE it, so rows
                  // never slide under a floating header — the hand-rolled grid
                  // this replaced put the header inside its own scroller and
                  // lost it as soon as the list scrolled).
                  fill={detailFull}
                  columns={[
                    { key: 'n', label: '#', width: 34 },
                    { key: 'start', label: t('sessions.colStart'), width: 66 },
                    { key: 'end', label: t('sessions.colEnd'), width: 66 },
                    // Model is ONE full ref per row, so it gets a fixed track
                    // wide enough for `provider/model` at 11px mono; the prompt
                    // keeps the whole remaining width (the only truly elastic
                    // column — it is what operators actually read).
                    { key: 'model', label: t('sessions.colModel'), width: 210 },
                    { key: 'prompt', label: t('sessions.colPrompt') },
                    { key: 'think', label: t('sessions.colThink'), width: 92 },
                    { key: 'in', label: t('sessions.colIn'), width: 62 },
                    { key: 'out', label: t('sessions.colOut'), width: 58 },
                    { key: 'cached', label: t('sessions.colCached'), width: 66 },
                    { key: 'cost', label: t('sessions.colCost'), width: 88 },
                    { key: 'ttft', label: t('usage.ttft'), width: 52 },
                    { key: 'toks', label: t('usage.thToks'), width: 60 },
                    { key: 'stallRatio', label: t('sessions.speedStallRatio'), width: 62 },
                    { key: 'ms', label: t('sessions.colMs'), width: 52 },
                  ]}
                  // Floor = the declared tracks plus a readable minimum for the
                  // one elastic (prompt) column; below it the body scrolls
                  // sideways instead of crushing every column into an ellipsis.
                  // 968 = the 13 declared tracks (34+66+66+210+92+62+58+66+
                  // 88+52+60+62+52); + 220 for the elastic prompt column.
                  minWidth={968 + 220}
                  headCellStyle={{ padding: '6px 8px', textAlign: 'center' }}
                  // The card already draws the frame: the table drops its own
                  // border/radius and insets to the card padding instead, so
                  // there is one rectangle per section, not a box in a box.
                  style={{ border: 'none', borderRadius: 0, margin: '0 12px 12px' }}
                >
                  {(() => {
                    const sorted = detailDesc ? [...timeline.traces].reverse() : timeline.traces;
                    // Clamp: a sort toggle or page-size change can leave the
                    // current page past the new last page.
                    const maxPage = Math.max(1, Math.ceil(sorted.length / detailPageSize));
                    const safePage = Math.min(detailPage, maxPage);
                    return sorted
                      .slice((safePage - 1) * detailPageSize, safePage * detailPageSize)
                      .map(tr => {
                    // Same unit as the session row (share of the decode
                    // window), computed per turn; undefined when unmeasurable.
                    const stallShare =
                      tr.execution.stalledMs != null && tr.execution.genMs != null && tr.execution.genMs > 0
                        ? tr.execution.stalledMs / tr.execution.genMs
                        : undefined;
                    return (
                    <tr key={tr.requestId} style={{ borderBottom: '1px solid var(--divider)' }}>
                      <td style={DETAIL_TD_CENTER}>#{tr.requestNumber}</td>
                      <td style={{ ...DETAIL_TD_CENTER, color: 'var(--text-dim)' }}>{new Date(tr.timestamp).toLocaleTimeString()}</td>
                      <td style={{ ...DETAIL_TD_CENTER, color: 'var(--text-dim)' }}>
                        {new Date(tr.timestamp + tr.execution.latencyMs).toLocaleTimeString()}
                      </td>
                      {/* ONE line, the full model ref. The two-line id-over-
                          provider cell belongs to the dense LIST column, where
                          width is scarce; this table has room and the row is
                          the unit being compared, so a single line keeps every
                          row the same height and never hides the provider
                          behind a header chip. Ellipsized with the full ref in
                          the tooltip only when the column is genuinely too
                          narrow (expanded mode shows it verbatim). */}
                      {/* Centered like every other column and like its own
                          header. The span is inline-block with maxWidth:100%
                          (not the block MODEL_LINE_STYLE) because a centered
                          BLOCK would overflow on BOTH sides and clip the left
                          edge with no ellipsis — as an inline box it ellipsizes
                          cleanly against the cell and stays centered while it
                          fits. */}
                      <td style={DETAIL_TD_CENTER}>
                        <span
                          title={tr.execution.modelUsed}
                          style={{ ...MODEL_LINE_STYLE, display: 'inline-block', maxWidth: '100%', verticalAlign: 'middle' }}
                        >
                          {tr.execution.modelUsed}
                        </span>
                      </td>
                      <td style={{ padding: '6px 8px', minWidth: 0 }}>
                        <PromptCell text={tr.request?.userPromptSummary ?? ''} />
                      </td>
                      <td style={DETAIL_TD_CENTER}><EffortCell tr={tr} /></td>
                      <td style={DETAIL_TD_CENTER}>{tr.finops.inputTokens.toLocaleString()}</td>
                      <td style={DETAIL_TD_CENTER}>{tr.finops.outputTokens.toLocaleString()}</td>
                      <td style={{ ...DETAIL_TD_CENTER, color: tr.finops.cachedTokens > 0 ? 'var(--accent-emerald)' : 'var(--text-dim)' }}>
                        {tr.finops.cachedTokens.toLocaleString()}
                      </td>
                      <td
                        style={{ ...DETAIL_TD_CENTER, color: 'var(--accent-amber)' }}
                        title={formatCost(tr.finops.costUsd)}
                      >{formatCostCompact(tr.finops.costUsd)}</td>
                      <td style={DETAIL_TD_CENTER} title={tr.execution.ttftMs != null ? `${tr.execution.ttftMs} ms` : t('usage.ttftTip')}>
                        {tr.execution.ttftMs != null ? fmtLatency(tr.execution.ttftMs) : '—'}
                      </td>
                      <td style={DETAIL_TD_CENTER} title={t('sessions.speedOutputTip')}>
                        {tr.execution.genMs != null
                          ? `${formatSpeed(decodeRate(tr.finops.outputTokens, tr.execution.genMs))} ${t('usage.thToks')}`
                          : '—'}
                      </td>
                      {/* Perceived stall time for THIS turn: total time spent
                          in ≥1 s pauses. Amber when this turn's share crosses
                          the same threshold the session row uses, so a bad
                          turn is findable by scanning colours rather than
                          reading numbers. */}
                      <td
                        style={{
                          ...DETAIL_TD_CENTER,
                          color:
                            stallShare !== undefined && stallShare >= STALL_RATIO_WARN
                              ? 'var(--accent-amber)'
                              : 'var(--text-dim)',
                        }}
                        title={
                          tr.execution.stalledMs != null
                            ? `${tr.execution.stalledMs} ms · ${t('sessions.speedStallRatioTip')}`
                            : t('sessions.speedStallRatioTip')
                        }
                      >
                        {fmtStallRatio(stallShare)}
                      </td>
                      <td style={DETAIL_TD_CENTER} title={`${tr.execution.latencyMs} ms`}>{fmtLatency(tr.execution.latencyMs)}</td>
                    </tr>
                    );
                      });
                  })()}
                </ScrollTable>
                )}
                {timeline.detailOpen && (() => {
                  const sorted = detailDesc ? [...timeline.traces].reverse() : timeline.traces;
                  const maxPage = Math.max(1, Math.ceil(sorted.length / detailPageSize));
                  const safePage = Math.min(detailPage, maxPage);
                  // Guarded by detailOpen: a collapsed card must not strand a
                  // pager under a fold that shows nothing to page through.
                  return sorted.length > detailPageSize ? (
                    <div style={{ padding: '0 12px 12px' }}>
                      <Pagination
                        page={safePage}
                        pageSize={detailPageSize}
                        total={sorted.length}
                        onChange={setDetailPage}
                        showSummary
                        pageSizeOptions={PAGE_SIZES}
                        onPageSizeChange={(s) => { setDetailPageSize(s); setDetailPage(1); }}
                      />
                    </div>
                  ) : null;
                })()}
              </div>
            )}
        </Dialog>
      )}
    </div>
  );
};

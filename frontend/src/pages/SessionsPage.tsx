import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Users, RefreshCw, Archive, BarChart3, Check, ChevronDown, ChevronRight, Copy, Eye, GitBranch, Maximize2, Minimize2, User, Waypoints, Wrench, Search, Trash2 } from 'lucide-react';
import { api, type SessionRecord, type TraceRecord } from '../lib/api';
import { formatReason, type Translate } from '../lib/reason';
import { copyToClipboard, formatCost, formatSessionId, decodeRate, formatRate, fmtLatency } from '../lib/format';
import { clientDisplayName } from '../lib/clientDetect';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Combobox } from '../components/Combobox';
import { Dialog } from '../components/Dialog';
import { Pagination } from '../components/Pagination';

import { FONT_MONO } from '../lib/fonts';
const PAGE_SIZES = [10, 20, 25, 50, 100, 200];

const TH_STYLE: React.CSSProperties = {
  padding: '10px 14px',
  // Header lives in its own static block now (split header/body tables) —
  // no sticky needed; solid fill keeps the card look consistent.
  background: 'color-mix(in srgb, var(--card-bg), var(--bg))',
};
// The tables default to centered (badges / numbers / icons read better in
// narrow fixed-width columns); only session id and Tokens stay left — both
// header and body opt back out with this / an inline textAlign:'left'.
const TH_LEFT: React.CSSProperties = { ...TH_STYLE, textAlign: 'left' };

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
 * grid (In/Out stacked left, Cached/Hit stacked right). `title` carries the
 * exact value when the displayed one is compacted.
 */
const TokenStatRow: React.FC<{ label: string; value: string; color?: string; title?: string; span?: boolean }> = ({ label, value, color, title, span }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'baseline',
      gap: 6,
      lineHeight: 1.7,
      // span: bleed across every grid column (no-op in the 1-col narrow
      // layout) so a lone trailing row doesn't strand an empty half-column.
      ...(span ? { gridColumn: '1 / -1' } : {}),
    }}
  >
    <span style={{ fontSize: '10px', color: 'var(--text-dim)', flexShrink: 0, minWidth: 24 }}>
      {label}
    </span>
    <span
      title={title}
      style={{
        fontFamily: FONT_MONO,
        fontWeight: 600,
        color: color ?? 'var(--text-main)',
      }}
    >
      {value}
    </span>
  </div>
);

/**
 * Compact token display for the fixed-layout table: a 7-digit count (~65px
 * in mono 12px) overflows its column and bleeds into the neighbor cell
 * (table-layout:fixed never clips). ≥100K collapses to 38.9K/4.3M-style so
 * the 2×2 halves stay inside the container-query threshold; the exact value
 * stays in the row tooltip.
 */
const COMPACT_FMT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const tokenDisplay = (v: number): string => (v >= 100_000 ? COMPACT_FMT.format(v) : v.toLocaleString());


/**
 * Tier column content by entry mode:
 * - combo   -> a neutral "Combo" badge (the composition is the decision, the
 *              executed member's tier is not a session ceiling).
 * - explicit-> nothing (a dash): the client named the model, the gateway holds
 *              no tier lock to display.
 * - auto / mixed / absent -> the tier badge (the ratchet's locked ceiling).
 */
const TierCell: React.FC<{ s: SessionRecord }> = ({ s }) => {
  const { t } = useI18n();
  const effortTip = lastEffortTip(s, t);
  if (s.entryMode === 'combo') {
    return (
      <span className="badge badge-info" title={t('sessions.entryModeComboHint') + effortTip}>
        {t('sessions.entryModeCombo')}
      </span>
    );
  }
  if (s.entryMode === 'explicit') {
    return <span style={{ color: 'var(--text-dim)' }} title={t('sessions.entryModeExplicitHint') + effortTip}>—</span>;
  }
  return (
    <span className={`badge ${TIER_BADGE[s.maxTier]}`} title={t(TIER_FULL_LABEL[s.maxTier]) + effortTip}>
      {t(TIER_LABEL[s.maxTier])}
    </span>
  );
};

/**
 * Pinned-model cell: split `provider/model` into two stacked, non-wrapping
 * lines — model name on top (inherits the cell's bold weight), provider below
 * in dim gray. Overflowing lines ellipsis; hover shows the full value.
 * Models without a `/` render as-is.
 */
const PINNED_LINE_STYLE: React.CSSProperties = {
  display: 'block',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const PinnedModelCell: React.FC<{ model: string }> = ({ model }) => {
  const slash = model.indexOf('/');
  if (slash < 0) {
    return (
      <span title={model} style={PINNED_LINE_STYLE}>
        {model}
      </span>
    );
  }
  return (
    <>
      <span title={model} style={PINNED_LINE_STYLE}>
        {model.slice(slash + 1)}
      </span>
      <span
        title={model}
        style={{
          ...PINNED_LINE_STYLE,
          marginTop: '3px',
          fontSize: '10px',
          fontWeight: 500,
          color: 'var(--text-dim)',
        }}
      >
        {model.slice(0, slash)}
      </span>
    </>
  );
};

/**
 * Shared-provider chip (trail + request-detail fold headers): printed once
 * above rows that omit the `provider/` prefix; the tooltip explains the
 * omission and the rows' own tooltips carry the full refs.
 */
const PROVIDER_CHIP_STYLE: React.CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: '10px',
  fontWeight: 500,
  color: 'var(--text-dim)',
  background: 'var(--chip-bg)',
  border: '1px solid var(--card-border)',
  padding: '1px 8px',
  borderRadius: '4px',
  wordBreak: 'break-all',
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
      // open + detail collapsed; Detail button → the reverse. The refill
      // below only adds data — a toggle made while traces load survives.
      // Fresh modal = newest first again (per-session reset).
      setDetailDesc(true);
      setDetailPage(1);
      setDetailFull(false);
      setTimeline({ session: s, events: [], traces: [], detailOpen: forceOpen, trailOpen: !forceOpen });
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

  // Shared column widths for the split header/body tables. table-layout:fixed
  // makes the <colgroup> authoritative — both tables render the identical
  // colgroup so columns line up pixel-perfect. Weights are normalized to
  // percentages; the capture column joins only when the archive is enabled.
  // Pinned model gets 13.5 so its two non-wrapping lines (model + provider,
  // e.g. "alibaba-token-plan-cn") fit without ellipsis; apps gets 11 (app-key
  // + client badges wrap onto two lines here) and session id 15 (long ids
  // wrap by design, so it can donate a unit).
  // In/Out/Cached share ONE column as a 2×2 stat grid (left half: In over
  // Out; right half: Cached over Hit-rate) — 16.5 units keeps its two halves
  // above the container-query threshold (see .tokens-stat-wrap in index.css)
  // on ordinary desktop windows; ≥100K counts render compact (4.3M/38.9K)
  // so a half never exceeds its share. Folding cached in also removed the
  // narrow centered column whose number used to bleed into neighbors.
  // Tier badge is a single short word (Lite/Plus/Pro/Ultra) — 6.5 units; it
  // clears the badge padding without bleeding into the Switches column;
  // Switches gets 5.5 (icon + ×N ≈ 36px content) so no cell overflows.
  // Detail holds two side-by-side icons — 7 units keeps them on one line
  // (flex nowrap below also guarantees rows never grow a second line here).
  // Session id gets 17: the cell also carries the first-user-prompt title
  // line, which reads poorly when squeezed; the donation comes out of
  // Pinned (model names ellipsize with a title tooltip) and Apps (badges
  // wrap freely), neither of which needs the extra width.
  // Active is a bare clock time — 6.5.
  // Alignment: the tables default to textAlign:center (badges / numbers /
  // icons read better in these narrow fixed columns); only session id (mono
  // copy target) and Tokens (2×2 stat grid with its own internal layout)
  // opt back out to left — see TH_LEFT and the two body cells.
  const colWeights = [19, 9.5, 11.5, 6.5, 5.5, 4.5, 5, 16.5, 6.5, 6.5, 7, 5, ...(captureOn ? [4] : [])];
  const colSum = colWeights.reduce((a, b) => a + b, 0);
  const colWidths = colWeights.map(w => `${((w / colSum) * 100).toFixed(3)}%`);
  // Switch-timeline modal: when every event shares one provider prefix, print
  // that prefix once as a header chip and show bare model ids in the rows.
  // Only pays off across MULTIPLE events — a single-row trail renders the
  // full ref inline instead of a dangling "ns/" fragment. Same dedup for the
  // request-detail grid (gated on >1 turn for the same reason).
  const providerNs =
    timeline && timeline.events.length > 1
      ? commonProviderOf(timeline.events.flatMap(ev => [ev.from, ev.to]))
      : null;
  const detailNs =
    timeline && timeline.traces.length > 1
      ? commonProviderOf(timeline.traces.map(tr => tr.execution.modelUsed))
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'flex-end' }}>
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
            style={{ fontSize: '12px', padding: '5px 8px', width: 180 }}
          />
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '12px', color: 'var(--text-dim)', whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' }}
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
              style={{ fontSize: '12px', padding: '5px 8px 5px 24px', width: '100%' }}
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
      <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.6', margin: '0 0 12px 0' }}>
        {t('sessions.sessionsDesc')}
      </p>

      {/* Header/body split tables: header block is static (natural flow), the
          body block is the only scroll region. Shared <colgroup> +
          table-layout:fixed align the columns; scrollbar-gutter reserves the
          same gutter on both so the body's scrollbar never desyncs widths. */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div style={{ scrollbarGutter: 'stable' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'center', fontSize: '12px', tableLayout: 'fixed' }}>
            <colgroup>{colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--divider)', color: 'var(--text-dim)' }}>
                <th style={TH_LEFT}>{t('sessions.thSessionId')}</th>
                <th style={TH_STYLE}>{t('sessions.thApps')}</th>
                <th style={TH_STYLE}>{t('sessions.thPinned')}</th>
                <th style={TH_STYLE}>
                  {/* Always two stacked lines: the 6.5-unit tier column is
                      sized for the badge, and whether the 5-char header fits
                      one line depends on window width — pin the wrap so the
                      header shape is width-independent. inline-block +
                      max-width wraps CJK every 2 chars, English per word. */}
                  <span style={{ display: 'inline-block', maxWidth: '2.5em' }}>{t('sessions.thTier')}</span>
                </th>
                <th style={TH_STYLE}>{t('sessions.thSwitches')}</th>
                <th style={TH_STYLE}>{t('sessions.thTurns')}</th>
                <th style={TH_STYLE}>{t('sessions.thRequests')}</th>
                <th style={TH_LEFT}>{t('sessions.thTokens')}</th>
                <th style={TH_STYLE}>{t('sessions.thCost')}</th>
                <th style={TH_STYLE}>{t('sessions.thActive')}</th>
                <th style={TH_STYLE}>{t('sessions.thDetail')}</th>
                <th style={TH_STYLE}>{t('sessions.thActions')}</th>
                {captureOn && <th style={TH_STYLE}>{t('sessions.thCapture')}</th>}
              </tr>
            </thead>
          </table>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, scrollbarGutter: 'stable' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'center', fontSize: '12px', tableLayout: 'fixed' }}>
            <colgroup>{colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
            <tbody>
            {sessions.length > 0 ? (
              sessions.map(s => (
                <tr key={s.id} style={{ borderBottom: '1px solid var(--divider)' }}>
                  <td
                    style={{
                      padding: '10px 14px',
                      textAlign: 'left',
                      fontFamily: FONT_MONO,
                      color: 'var(--text-main)',
                      wordBreak: 'break-all',
                    }}
                  >
                    <span
                      title={s.id}
                      style={{ cursor: 'copy' }}
                      onClick={async () => {
                        const ok = await copyToClipboard(s.id);
                        if (ok) toast.success(t('sessions.copiedSessionId'));
                        else toast.error(t('sessions.copyFailed'));
                      }}
                    >
                      {formatSessionId(s.id)}
                    </span>
                    {/* Title = first user prompt (backend-capped summary);
                        single line, ellipsized, full text in the tooltip. */}
                    {s.firstUserMessage && (
                      <div
                        title={s.firstUserMessage}
                        style={{
                          marginTop: '2px',
                          fontSize: '11px',
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
                  <td style={{ padding: '10px 14px' }}>
                    {(s.apiKeys && s.apiKeys.length > 0) || (s.clients && s.clients.length > 0) ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '4px' }}>
                        {s.apiKeys?.map(k => (
                          <span
                            key={k.id}
                            title={t('captures.apiKeyTooltip', { name: k.name, id: k.id })}
                            style={{
                              fontSize: '10px',
                              lineHeight: '14px',
                              padding: '1px 6px',
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
                              fontSize: '10px',
                              lineHeight: '14px',
                              padding: '1px 6px',
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
                  <td style={{ padding: '10px 14px', fontWeight: 600 }}>
                    <PinnedModelCell model={s.pinnedModel} />
                    {/* Credential affinity (display-safe keyHash). */}
                    {s.boundKeyHashPrefix && (
                      <span
                        title={t('sessions.boundCredentialTip', {
                          prefix: s.boundKeyHashPrefix,
                          time: s.boundAt ? new Date(s.boundAt).toLocaleString() : '—',
                        })}
                        style={{
                          display: 'block',
                          marginTop: '3px',
                          fontSize: '10px',
                          fontFamily: FONT_MONO,
                          lineHeight: '14px',
                          padding: '1px 6px',
                          borderRadius: '4px',
                          background: 'var(--chip-bg)',
                          border: '1px solid var(--card-border)',
                          color: 'var(--text-dim)',
                          fontWeight: 500,
                          maxWidth: '100%',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        #{s.boundKeyHashPrefix}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <TierCell s={s} />
                  </td>
                  <td style={{ padding: '10px 14px' }}>
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
                        fontWeight: 600,
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
                  <td style={{ padding: '10px 14px' }}>{s.turnCount}</td>
                  <td style={{ padding: '10px 14px', fontFamily: FONT_MONO }}>
                    {s.traceCount.toLocaleString()}
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'left' }}>
                    {/* Grid auto-placement fills row-major, so the child order
                        below yields: In|Cached on row 1, Out|Hit on row 2, and
                        the Rate row bleeding across both columns (2×2 grid +
                        a full-width line when the column is wide; 5 stacked
                        rows when narrow — see .tokens-stat-wrap in index.css). */}
                    <div className="tokens-stat-wrap">
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
                              ? `${((s.cachedTokens / s.inputTokens) * 100).toFixed(1)}%`
                              : '—'
                          }
                          color="var(--text-dim)"
                        />
                        {/* Session-level decode rate (industry TPS): output
                            tokens summed over STREAMED turns only, divided by
                            their summed decode window (first chunk → stream
                            end). Same semantics as the per-request rate in
                            the detail grid; '—' when the session never
                            streamed. Spans the full grid width — a 5th row
                            would otherwise strand an empty right half-column. */}
                        <TokenStatRow
                          span
                          label={t('sessions.tokenRate')}
                          value={
                            s.genOutputTokens > 0 && s.genMsSum > 0
                              ? `${formatRate(decodeRate(s.genOutputTokens, s.genMsSum))} ${t('usage.thToks')}`
                              : '—'
                          }
                          title={t('usage.toksTip')}
                          color="var(--text-muted)"
                        />
                      </div>
                    </div>
                  </td>
                  <td
                    style={{
                      padding: '10px 14px',
                      // Amber = money, consistent with the /usage table & cards.
                      color: 'var(--accent-amber)',
                      fontFamily: FONT_MONO,
                    }}
                  >
                    {formatCost(s.costUsd)}
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-dim)' }}>
                    {new Date(s.lastActiveAt).toLocaleTimeString()}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {/* Flex row: the two icons must never wrap — a wrapped pair
                        doubles every row's height. */}
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
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
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
                  </td>
                  {captureOn && (
                    <td style={{ padding: '10px 14px' }}>
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
                    </td>
                  )}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={captureOn ? 13 : 12} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)' }}>
                  {filter ? t('sessions.filterEmpty') : t('sessions.emptySessions')}
                </td>
              </tr>
            )}
            </tbody>
          </table>
        </div>
      </div>
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
            <span style={{ fontFamily: FONT_MONO, fontSize: '11px', wordBreak: 'break-all' }}>
              {timeline.session.id}
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
            <div
              role="button"
              aria-expanded={timeline.trailOpen}
              onClick={() => setTimeline(cur => (cur ? { ...cur, trailOpen: !cur.trailOpen } : cur))}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                marginBottom: timeline.trailOpen ? '8px' : 0,
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              {timeline.trailOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  color: 'var(--text-dim)',
                }}
              >
                {t('sessions.switchTitle')}
              </span>
              {/* Shared provider prefix, printed once: rows below show bare
                  model ids; hover reveals the full ref. */}
              {providerNs && <ProviderNsChip ns={providerNs} />}
            </div>
            {timeline.trailOpen &&
              (timeline.events.length === 0 ? (
                <p style={{ fontSize: '13px', color: 'var(--text-dim)', margin: 0 }}>{t('sessions.switchEmpty')}</p>
              ) : (
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
                        fontSize: '12px',
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
                        style={{ fontWeight: 600, fontFamily: FONT_MONO }}
                      >
                        {ev.from ? <><span style={{ color: 'var(--text-dim)' }}>{shortModel(providerNs, ev.from)}</span>{' → '}</> : null}
                        {shortModel(providerNs, ev.to)}
                      </span>
                      {detail && (
                        <span
                          style={{ color: 'var(--text-dim)', fontSize: '11px', flexBasis: '100%', wordBreak: 'break-word' }}
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
            ))}
            {/* Per-request detail: every turn's recorded token counts + actual cost */}
            {timeline.traces.length > 0 && (
              <div style={{
                marginTop: '16px',
                paddingTop: '12px',
                borderTop: '1px solid var(--divider)',
                // Expanded: this section fills the Dialog body's remaining
                // height so the GRID scrolls internally (sticky header) —
                // the Dialog chrome (title, folds, pager) stays put instead
                // of the whole body scrolling. Collapsed: content-sized.
                display: 'flex',
                flexDirection: 'column',
                flex: detailFull ? '1 1 0' : undefined,
                minHeight: 0,
              }}>
                <div
                  role="button"
                  aria-expanded={timeline.detailOpen}
                  onClick={() => setTimeline(cur => (cur ? { ...cur, detailOpen: !cur.detailOpen } : cur))}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '11px',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: 'var(--text-dim)',
                    marginBottom: timeline.detailOpen ? '8px' : 0,
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  {timeline.detailOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span>{t('sessions.requestsTitle', { count: timeline.traces.length })}</span>
                  {/* Same shared-prefix dedup as the trail: rows below show
                      bare ids; hover reveals the full ref. */}
                  {detailNs && <ProviderNsChip ns={detailNs} />}
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
                <div
                  style={{
                    display: 'grid',
                    // Prompt column is 12ch-floor flex: it shows the turn's
                    // user-prompt summary (or a fallback description when the
                    // turn carried no user message), ellipsized with the full
                    // text in the tooltip. Think stays 96px: worst case = a
                    // degraded req->act span like "xhigh->high" ~= 92px at
                    // 11px mono beside the source icon.
                    gridTemplateColumns: '30px 64px 64px minmax(140px, 1fr) minmax(120px, 1fr) 96px 56px 56px 60px 86px 52px 44px 44px',
                    columnGap: '8px',
                    rowGap: '6px',
                    // The model cell renders two stacked lines (name over
                    // provider) and sets the row height — center every cell
                    // vertically so the single-line cells don't hug the top.
                    alignItems: 'center',
                    fontSize: '11px',
                    fontFamily: FONT_MONO,
                    // Below the ~1008px column minimum (narrow window), scroll
                    // the grid instead of clipping the cost/latency columns.
                    overflowX: 'auto',
                    // Expanded: the grid is the section's flex-fill scroll
                    // region — rows scroll here, the header stays on top.
                    flex: detailFull ? '1 1 0' : undefined,
                    minHeight: 0,
                    overflowY: detailFull ? 'auto' : undefined,
                  }}
                >
                  {[
                    '#',
                    t('sessions.colStart'),
                    t('sessions.colEnd'),
                    t('sessions.colModel'),
                    t('sessions.colPrompt'),
                    t('sessions.colThink'),
                    t('sessions.colIn'),
                    t('sessions.colOut'),
                    t('sessions.colCached'),
                    t('sessions.colCost'),
                    t('sessions.colMs'),
                    t('usage.ttft'),
                    t('usage.thToks'),
                  ].map((label, i) => (
                    <span
                      key={i}
                      style={{
                        textAlign: 'center',
                        color: 'var(--text-dim)',
                        fontSize: '10px',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        // Sticky on the grid's internal (expanded) scroll:
                        // rows slide under the header, which keeps the card
                        // background so they never bleed through.
                        position: 'sticky',
                        top: 0,
                        background: 'var(--card-bg)',
                      }}
                    >
                      {label}
                    </span>
                  ))}
                  {(() => {
                    const sorted = detailDesc ? [...timeline.traces].reverse() : timeline.traces;
                    // Clamp: a sort toggle or page-size change can leave the
                    // current page past the new last page.
                    const maxPage = Math.max(1, Math.ceil(sorted.length / detailPageSize));
                    const safePage = Math.min(detailPage, maxPage);
                    return sorted
                      .slice((safePage - 1) * detailPageSize, safePage * detailPageSize)
                      .map(tr => (
                    <React.Fragment key={tr.traceId}>
                      <span style={{ textAlign: 'center', color: 'var(--text-dim)' }}>#{tr.turnNumber}</span>
                      <span style={{ textAlign: 'center', color: 'var(--text-dim)' }}>{new Date(tr.timestamp).toLocaleTimeString()}</span>
                      <span style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
                        {new Date(tr.timestamp + tr.execution.latencyMs).toLocaleTimeString()}
                      </span>
                      {/* Model name over provider, same split as the pinned
                          cell — full refs wrap badly in the mono grid. When
                          every turn shares one provider prefix (chip up in
                          the fold header) rows show the bare id and the
                          tooltip carries the full ref. */}
                      {detailNs ? (
                        <span
                          title={tr.execution.modelUsed}
                          style={{ ...PINNED_LINE_STYLE, color: 'var(--text-main)', textAlign: 'center' }}
                        >
                          {shortModel(detailNs, tr.execution.modelUsed)}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-main)', textAlign: 'center' }}>
                          <PinnedModelCell model={tr.execution.modelUsed} />
                        </span>
                      )}
                      <PromptCell text={tr.request?.userPromptSummary ?? ''} />
                      <span style={{ textAlign: 'center' }}><EffortCell tr={tr} /></span>
                      <span style={{ textAlign: 'center' }}>{tr.finops.inputTokens.toLocaleString()}</span>
                      <span style={{ textAlign: 'center' }}>{tr.finops.outputTokens.toLocaleString()}</span>
                      <span style={{ textAlign: 'center', color: tr.finops.cachedTokens > 0 ? 'var(--accent-emerald)' : 'var(--text-dim)' }}>
                        {tr.finops.cachedTokens.toLocaleString()}
                      </span>
                      <span style={{ textAlign: 'center', color: 'var(--accent-amber)' }}>{formatCost(tr.finops.costUsd)}</span>
                      <span style={{ textAlign: 'center' }} title={`${tr.execution.latencyMs} ms`}>{fmtLatency(tr.execution.latencyMs)}</span>
                      <span style={{ textAlign: 'center' }} title={tr.execution.ttftMs != null ? `${tr.execution.ttftMs} ms` : t('usage.ttftTip')}>
                        {tr.execution.ttftMs != null ? fmtLatency(tr.execution.ttftMs) : '—'}
                      </span>
                      <span style={{ textAlign: 'center' }} title={t('usage.toksTip')}>{formatRate(decodeRate(tr.finops.outputTokens, tr.execution.genMs))}</span>
                    </React.Fragment>
                      ));
                  })()}
                </div>
                )}
                {(() => {
                  const sorted = detailDesc ? [...timeline.traces].reverse() : timeline.traces;
                  const maxPage = Math.max(1, Math.ceil(sorted.length / detailPageSize));
                  const safePage = Math.min(detailPage, maxPage);
                  return sorted.length > detailPageSize ? (
                    <div style={{ marginTop: '10px' }}>
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

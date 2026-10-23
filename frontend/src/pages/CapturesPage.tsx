import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { Archive, RefreshCw, Trash2, X, AlertTriangle, Download, Search, Copy, Check, Braces, Maximize2, Minimize2, Scale, Zap, ArrowDownRight, ArrowUpRight } from 'lucide-react';
import {
  api,
  type CaptureStatus,
  type CaptureDateRow,
  type CaptureSessionRow,
  type CaptureFragmentRow,
  type HttpExchangeEvent,
  type CaptureTurn,
} from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';
import { Switch } from '../components/Switch';
import { Combobox } from '../components/Combobox';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';
import { copyToClipboard, shortId, decodeRate, formatRate, fmtDur, fmtLatency } from '../lib/format';
import { useSplitterWidth, VSplitter } from '../components/Splitter';
import { strToU8, zipSync } from 'fflate';
import { SessionTranscript } from '../components/SessionTranscript';
import { BackToTop } from '../components/BackToTop';
import { findMediaTokens, unwrapHarnessText } from '../lib/transcript';
import { DEFAULT_MAX_BODY_BYTES } from '../lib/defaults';

import { FONT_MONO } from '../lib/fonts';
/**
 * Best-effort completion-token extraction from a captured response wire body.
 * Non-streaming JSON carries usage once; streaming SSE repeats it, and the
 * LAST occurrence is the cumulative total for both Anthropic (message_delta)
 * and OpenAI (final usage chunk). Hex-encoded non-UTF-8 bodies are skipped.
 */
const COMPLETION_TOKENS_RE = /"(?:completion_tokens|output_tokens)"\s*:\s*(\d+)/g;
const completionTokensFrom = (event?: HttpExchangeEvent): number | null => {
  if (!event) return null;
  // Server-derived total (metadata-only reads strip the body) takes
  // precedence; the body regex stays as the fallback for older reads.
  if (typeof event.completionTokens === 'number') return event.completionTokens;
  const body = event.wire?.responseBody;
  if (typeof body !== 'string') return null;
  let last: string | null = null;
  for (const m of body.matchAll(COMPLETION_TOKENS_RE)) last = m[1];
  return last ? Number(last) : null;
};

/**
 * Per-turn streaming timing per leg, capture domain — the SAME TTFT /
 * decode-TPS vocabulary the trace domain uses, measured at the wire: the
 * response event's firstByteTs splits the leg's cycle latency into
 * wait-for-first-token (TTFT) and decode phases. Null when the leg never
 * streamed (buffered exchange) or the events predate the stamp — the chip
 * then renders its latency only, never a synthesized rate.
 */
const legTiming = (
  turn: CaptureTurn,
  side: 'upstream' | 'gateway'
): { ttftMs?: number; rate: number | null } | null => {
  const genMs = side === 'upstream' ? turn.upstreamGenMs : turn.gatewayGenMs;
  if (genMs === undefined) return null;
  const resp = side === 'upstream' ? turn.upstreamResponse : turn.gatewayResponse;
  const ttftMs = side === 'upstream' ? turn.upstreamTtftMs : turn.gatewayTtftMs;
  const tokens = completionTokensFrom(resp);
  return { ttftMs, rate: tokens !== null && tokens > 0 ? decodeRate(tokens, genMs) : null };
};

/**
 * Timing segments for one leg's chip: `· TTFT 3.0s · 52 tok/s`, each part
 * optional. Labels use fmtLatency smart units (sub-second ms → s → m s); the
 * chip's tooltip carries the exact raw ms (legTimingTip) since labels round.
 */
const legTimingText = (turn: CaptureTurn, side: 'upstream' | 'gateway'): string => {
  const tr = legTiming(turn, side);
  if (!tr) return '';
  const ttft = tr.ttftMs !== undefined ? ` · TTFT ${fmtLatency(tr.ttftMs)}` : '';
  const rate = tr.rate !== null ? ` · ${formatRate(tr.rate)} tok/s` : '';
  return ttft + rate;
};

/** Raw-ms appendix for the timing chip's tooltip: `TTFT 3002 ms`; '' when the
 *  leg never streamed — the tooltip then stays the static timing gloss. */
const legTimingTip = (turn: CaptureTurn, side: 'upstream' | 'gateway'): string => {
  const tr = legTiming(turn, side);
  return tr?.ttftMs !== undefined ? `TTFT ${tr.ttftMs} ms` : '';
};

// Left-rail splitter bounds + persistence (captures page session list).
const RAIL_MIN = 240;
const RAIL_MAX = 640;
const RAIL_DEFAULT = 320;
const RAIL_WIDTH_KEY = 'ocr.captures.railWidth';
const AUTO_REFRESH_KEY = 'ocr.captures.autoRefresh';
// Detail-pane tail poll cadence. Deliberately unhurried: the refresh is a
// quiet in-place turn-list replace, not a loading state.
const AUTO_REFRESH_INTERVAL_MS = 3000;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/** Local YYYY-MM-DD of a turn ts — the archive shard it physically landed in. */
function fmtDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Loading skeleton for the session pane — shimmer rows so a click gives
 *  instant structural feedback instead of a silent wait on the fetch. */
const TurnsSkeleton: React.FC<{ chat?: boolean }> = ({ chat }) => {
  const rows = chat ? 6 : 9;
  return (
    <div style={{ padding: '6px 0' }}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="ocr-skeleton-row"
          style={{ height: chat ? 44 : 26, width: `${88 - (i % 4) * 9}%`, marginLeft: chat ? 0 : 4 }}
        />
      ))}
    </div>
  );
};

/**
 * Wire-content block with a small toolbar: copy-to-clipboard (with textarea
 * fallback for non-secure contexts) and a JSON pretty/raw toggle offered
 * only when the content actually parses as JSON. Defaults to RAW — this is
 * a wire capture, so the bytes as actually sent/received are the source of
 * truth; pretty-printing is an opt-in reading aid.
 */
function JsonBlock({ value }: { value: unknown }) {
  const { t } = useI18n();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [formatted, setFormatted] = useState(false);
  const rawText =
    value === undefined || value === null
      ? ''
      : typeof value === 'string'
        ? value
        : JSON.stringify(value, null, 2);
  const pretty = useMemo(() => {
    if (!rawText) return null;
    try {
      return JSON.stringify(JSON.parse(rawText), null, 2);
    } catch {
      return null;
    }
  }, [rawText]);

  if (value === undefined || value === null) return null;
  const text = formatted && pretty !== null ? pretty : rawText;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for non-secure contexts (http://, older browsers).
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    toast.success(t('captures.copied'));
    setTimeout(() => setCopied(false), 1500);
  };

  const btnStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: 'var(--chip-bg)',
    border: '1px solid var(--card-border)',
    borderRadius: '4px',
    color: 'var(--text-dim)',
    fontSize: '11px',
    padding: '3px 8px',
    cursor: 'pointer',
    fontFamily: FONT_MONO,
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginBottom: 4 }}>
        {pretty !== null && (
          <button
            style={btnStyle}
            onClick={() => setFormatted(f => !f)}
            title={formatted ? t('captures.showRaw') : t('captures.formatJson')}
          >
            <Braces size={12} />
            {formatted ? t('captures.showRaw') : t('captures.formatJson')}
          </button>
        )}
        <button style={btnStyle} onClick={handleCopy} title={t('captures.copy')}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t('captures.copied') : t('captures.copy')}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: '12px 14px',
          background: 'var(--well-bg)',
          border: '1px solid var(--card-border)',
          borderRadius: '6px',
          fontSize: '11px',
          lineHeight: 1.55,
          // Without this the UA default monospace (Courier New on Windows)
          // renders the JSON — match the standard chain used elsewhere here.
          fontFamily: FONT_MONO,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text}
      </pre>
    </div>
  );
}

type DrawerTab = 'clientRequest' | 'gatewayResponse' | 'upstreamRequest' | 'upstreamResponse' | 'decisionRequest' | 'decisionResponse';

/**
 * Right-side detail drawer for one captured turn (portal, Esc/overlay close).
 * Tabs keep the three bodies (inbound request / upstream request / response)
 * focused instead of one long scroll — the upstream tab is where you land only
 * when debugging compression/wire behavior, so it defaults to the inbound view.
 * With metadata-first list reads the drawer shell paints instantly and the
 * full wire bodies stream in via the per-turn fetch (`loading`); `outOfWindow`
 * marks a turn archived beyond the read window (bodies unrecoverable).
 */
const CaptureDrawer: React.FC<{
  turn: CaptureTurn;
  /** Full wire bodies are being fetched for this turn. */
  loading?: boolean;
  /** Turn's bodies fall outside the read window (long archive, tail kept). */
  outOfWindow?: boolean;
  /** Tab to land on when the drawer opens (e.g. the decision layer tab when opened
   *  from the decision layer sub-row); defaults to the inbound request view. */
  initialTab?: DrawerTab;
  onClose: () => void;
}> = ({ turn, loading, outOfWindow, initialTab, onClose }) => {
  const { t } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState<DrawerTab>('clientRequest');
  useBodyScrollLock(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    setTab(initialTab ?? 'clientRequest');
    // Keyed by the client-request event id, not the traceId: a client that
    // reuses one traceId produces multiple turns sharing it.
  }, [turn.clientRequest?.id ?? turn.traceId, initialTab]);

  // Wire-side tabs, one per HTTP exchange phase. The naming is symmetric:
  // direction (client | upstream) × phase (request | response) — the same
  // shape as the W3C / OpenTelemetry span model. Clicking a tab shows the
  // full wire dump (request line + headers + body OR response line + headers
  // + body) of that side. Empty tab = the corresponding exchange never
  // fired (e.g. gateway-response is missing when the gateway times out
  // before sending a reply). The decision layer pair is a 5th/6th tab that only
  // appears when an L2 decision layer leg fired inside this turn — it shares the
  // trace but is a distinct upstream call from the serving one.
  const tabs: { key: DrawerTab; label: string; ev?: HttpExchangeEvent }[] = [
    { key: 'clientRequest',    label: t('captures.tabClientRequest'),    ev: turn.clientRequest },
    { key: 'gatewayResponse',  label: t('captures.tabGatewayResponse'),  ev: turn.gatewayResponse },
    { key: 'upstreamRequest',  label: t('captures.tabUpstreamRequest'),  ev: turn.upstreamRequest },
    { key: 'upstreamResponse', label: t('captures.tabUpstreamResponse'), ev: turn.upstreamResponse },
    ...(turn.decisionRequest || turn.decisionResponse
      ? [
          { key: 'decisionRequest' as DrawerTab,  label: t('captures.tabDecisionRequest'),  ev: turn.decisionRequest },
          { key: 'decisionResponse' as DrawerTab, label: t('captures.tabDecisionResponse'), ev: turn.decisionResponse },
        ]
      : []),
  ];
  const active = tabs.find(x => x.key === tab) ?? tabs[0];

  // The single timestamp the drawer shows in the header: pick the EARLIEST
  // event ts (client-request fires synchronously, upstream events may
  // arrive later — earliest is the turn's t0).
  const headerTs = turn.clientRequest?.ts
    ?? turn.upstreamRequest?.ts
    ?? turn.gatewayResponse?.ts
    ?? turn.upstreamResponse?.ts;
  const hasError = turn.error || active.ev?.status === 'error';
  // Application attribution: any event of the turn carries the same client
  // API-key identity (id + name only) once it is attached at capture time.
  const turnKey =
    turn.clientRequest?.apiKey ??
    turn.gatewayResponse?.apiKey ??
    turn.upstreamRequest?.apiKey ??
    turn.upstreamResponse?.apiKey;

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 210,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'flex-end',
        animation: 'ocr-fade-in 0.15s ease',
      }}
    >
      <div
        className="card"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(820px, 92vw)',
          height: '100vh',
          maxHeight: '100vh',
          borderRadius: 0,
          borderRight: 'none',
          borderTop: 'none',
          borderBottom: 'none',
          display: 'flex',
          flexDirection: 'column',
          animation: 'ocr-slide-in-right 0.18s ease',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '14px 16px',
            borderBottom: '1px solid var(--divider)',
            flexWrap: 'wrap',
          }}
        >
          <span
            className="badge"
            style={
              hasError
                ? { background: 'rgba(239,68,68,0.12)', color: '#ef4444' }
                : { background: 'color-mix(in srgb, var(--accent-emerald) 12%, transparent)', color: 'var(--accent-emerald)' }
            }
          >
            {hasError ? t('captures.statusError') : t('captures.statusOk')}
          </span>
          {turnKey && (
            <span
              className="badge"
              title={t('captures.apiKeyTooltip', { name: turnKey.name, id: turnKey.id })}
              style={{ background: 'var(--chip-bg)', color: 'var(--text-muted)' }}
            >
              {turnKey.name}
            </span>
          )}
          {headerTs !== undefined && (
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: FONT_MONO }}>
              {new Date(headerTs).toLocaleString()}
            </span>
          )}
          {/* TraceId — copy-on-click in the drawer header (kept out of the
              list rows: machine bookkeeping, rarely read inline). */}
          <span
            title={turn.traceId}
            onClick={async () => {
              const ok = await copyToClipboard(turn.traceId);
              if (ok) toast.success(t('captures.copied'));
              else toast.error(t('common.failed'));
            }}
            style={{
              fontSize: '11px',
              color: 'var(--text-dim)',
              fontFamily: FONT_MONO,
              cursor: 'copy',
            }}
          >
            {shortId(turn.traceId)}
          </span>
          <span
            style={{ fontSize: '12px', color: 'var(--text-dim)', fontFamily: FONT_MONO }}
            title={t('captures.inboundModel')}
          >
            {turn.model}
          </span>
          {/* Upstream model actually executed (from the upstream exchange
              events) — shown as `inbound → upstream` when known and
              different, e.g. `auto → gpt-4o`. */}
          {(() => {
            const upstreamModel = turn.upstreamRequest?.model ?? turn.upstreamResponse?.model;
            if (!upstreamModel || upstreamModel === turn.model) return null;
            return (
              <span
                style={{ fontSize: '12px', color: 'var(--text-dim)', fontFamily: FONT_MONO }}
                title={t('captures.outboundModel')}
              >
                → {upstreamModel}
              </span>
            );
          })()}
          {/* Proxy badge — visible without opening the upstream tab. */}
          {turn.upstreamRequest?.proxy && (
            <span
              className="badge"
              title={`${t('captures.viaProxy')}: ${turn.upstreamRequest.proxy}`}
              style={{
                background: 'var(--hue-blue-soft)',
                color: 'var(--hue-blue)',
                fontFamily: FONT_MONO,
                fontSize: '10px',
              }}
            >
              ⇢ {turn.upstreamRequest.proxy}
            </span>
          )}
          {/* Per-direction latency: gateway = client cycle, upstream =
              upstream cycle. Missing when one side never fired. */}
          {turn.gatewayLatencyMs !== undefined && (
            <span
              title={`${t('captures.gatewayLatency')} · ${turn.gatewayLatencyMs} ms`}
              style={{ fontSize: '12px', color: 'var(--text-dim)', fontFamily: FONT_MONO }}
            >
              <ArrowDownRight size={12} strokeWidth={2.75} style={{ verticalAlign: '-1px', color: 'var(--text)' }} /> {fmtLatency(turn.gatewayLatencyMs)}
              <span title={[t('captures.timingTip'), legTimingTip(turn, 'gateway')].filter(Boolean).join(' · ')}>
                {legTimingText(turn, 'gateway')}
              </span>
            </span>
          )}
          {turn.upstreamLatencyMs !== undefined && (
            <span
              title={`${t('captures.upstreamLatency')} · ${turn.upstreamLatencyMs} ms`}
              style={{ fontSize: '12px', color: 'var(--text-dim)', fontFamily: FONT_MONO }}
            >
              <ArrowUpRight size={12} strokeWidth={2.75} style={{ verticalAlign: '-1px', color: 'var(--text)' }} /> {fmtLatency(turn.upstreamLatencyMs)}
              <span title={[t('captures.timingTip'), legTimingTip(turn, 'upstream')].filter(Boolean).join(' · ')}>
                {legTimingText(turn, 'upstream')}
              </span>
            </span>
          )}
          {/* L2 decision layer leg badge: latency chip + the decision layer model, so the two
              upstream calls of one turn are distinguishable at a glance. */}
          {turn.decisionRequest && (
            <span
              className="badge"
              title={`${t('captures.decisionBadge')} · ${turn.decisionRequest.model}${turn.decisionLatencyMs !== undefined ? ` · ${turn.decisionLatencyMs} ms` : ''}`}
              style={{
                background: 'var(--hue-purple-soft, color-mix(in srgb, var(--accent) 12%, transparent))',
                color: 'var(--hue-purple, var(--accent))',
                fontFamily: FONT_MONO,
                fontSize: '10px',
              }}
            >
              <Scale size={10} style={{ verticalAlign: '-1px', marginRight: '3px' }} />
              {t('captures.decisionBadge')}
              {turn.decisionLatencyMs !== undefined && ` · ${fmtLatency(turn.decisionLatencyMs)}`}
              {turn.decisionRequest.model !== turn.model && ` · ${turn.decisionRequest.model}`}
            </span>
          )}
          <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label={t('common.close')}>
            <X size={14} />
          </button>
        </div>

        {/* Turn prompt summary — anchors the drawer to its conversation turn
            (the full text lives inside the clientRequest tab's wire JSON,
            far too buried for at-a-glance context). Hover shows the full
            summary; click copies it. Hidden when the turn has no prompt. */}
        {turn.promptSummary && (
          <div
            title={turn.promptSummary}
            onClick={async () => {
              const ok = await copyToClipboard(turn.promptSummary!);
              if (ok) toast.success(t('sessions.copiedPrompt'));
              else toast.error(t('sessions.copyFailed'));
            }}
            style={{
              padding: '6px 16px 10px',
              borderBottom: '1px solid var(--divider)',
              fontSize: '12px',
              lineHeight: 1.5,
              color: 'var(--text-muted)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              cursor: 'copy',
            }}
          >
            {turn.promptSummary}
          </div>
        )}

        {/* Error banner */}
        {turn.error && (
          <div
            style={{
              margin: '12px 16px 0',
              padding: '10px 12px',
              borderRadius: '6px',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              color: '#ef4444',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <AlertTriangle size={14} />
            <span>{turn.error}</span>
          </div>
        )}

        {/* Tabs — wire-side views (4 base + decision pair when present) */}
        <div style={{ display: 'flex', gap: '4px', padding: '12px 16px 0', borderBottom: '1px solid var(--divider)', flexWrap: 'wrap' }}>
          {tabs.map(x => {
            const empty = !x.ev;
            return (
              <button
                key={x.key}
                onClick={() => setTab(x.key)}
                title={empty ? t('captures.tabEmpty') : undefined}
                style={{
                  background: 'transparent',
                  border: 'none',
                  borderBottom: tab === x.key ? '2px solid var(--accent)' : '2px solid transparent',
                  color: tab === x.key ? 'var(--accent)' : 'var(--text-dim)',
                  opacity: empty ? 0.5 : 1,
                  fontSize: '12px',
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontFamily: FONT_MONO,
                }}
              >
                {x.label}
                {!empty && x.ev && x.ev.phase === 'response' && (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: '11px',
                      color: x.ev.status === 'error' ? '#ef4444' : 'var(--text-dim)',
                    }}
                  >
                    {x.ev.wire.status || 'ERR'}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Body: one wire dump (request line + headers + body) OR (response line + status + headers + body) */}
        <div style={{ flex: 1, overflow: 'auto', padding: '14px 16px', minHeight: 0 }}>
          {loading ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '12px' }}>
              <RefreshCw size={14} style={{ animation: 'ocr-spin 0.8s linear infinite', verticalAlign: '-2px', marginRight: 6 }} />
              {t('captures.turnLoading')}
            </div>
          ) : !active.ev ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '12px' }}>
              {t('captures.tabEmpty')}
            </div>
          ) : (
            <>
              {outOfWindow && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '11px',
                    color: 'var(--accent-amber)',
                    padding: '0 0 10px',
                  }}
                >
                  <AlertTriangle size={12} />
                  <span>{t('captures.turnOutOfRange')}</span>
                </div>
              )}
              <WireBlock event={active.ev} />
              {active.ev.truncated && (
                <div
                  style={{
                    marginTop: 12,
                    padding: '8px 10px',
                    borderRadius: '6px',
                    background: 'color-mix(in srgb, var(--accent-amber) 8%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--accent-amber) 30%, transparent)',
                    color: 'var(--accent-amber)',
                    fontSize: '11px',
                  }}
                >
                  {t('captures.truncatedBadge')}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

/** Render one wire dump: line + headers + body, in that order, with status
 *  for the response side. Mirrors the standard HTTP wire format so a
 *  support engineer can paste it directly into a curl / netcat replay. */
const WireBlock: React.FC<{ event: HttpExchangeEvent }> = ({ event }) => {
  const { t } = useI18n();
  const isResponse = event.phase === 'response';
  const statusLine = isResponse
    ? event.wire.responseLine || `HTTP/1.1 ${event.wire.status} ${event.wire.status === 0 ? 'NETWORK_ERROR' : ''}`.trim()
    : event.wire.requestLine;
  return (
    <div>
      <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: 6, fontFamily: FONT_MONO }}>
        {isResponse ? '← status line' : '→ request line'}
      </div>
      <pre
        style={{
          margin: 0,
          padding: '10px 12px',
          background: 'var(--well-bg)',
          border: '1px solid var(--card-border)',
          borderRadius: '6px',
          fontSize: '12px',
          fontFamily: FONT_MONO,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: 'var(--text)',
        }}
      >
        {statusLine || '(no status line)'}
      </pre>
      {/* Proxy routing — only present on upstream events that actually went
          through a proxy; absence means direct connection. */}
      {event.proxy && (
        <div
          style={{
            marginTop: 6,
            fontSize: '11px',
            color: 'var(--text-dim)',
            fontFamily: FONT_MONO,
          }}
        >
          ⇢ {t('captures.viaProxy')}: {event.proxy}
        </div>
      )}
      <div style={{ fontSize: '11px', color: 'var(--text-dim)', margin: '14px 0 6px', fontFamily: FONT_MONO }}>
        {isResponse ? '← response headers' : '→ request headers'}
      </div>
      <JsonBlock value={isResponse ? event.wire.responseHeaders : event.wire.requestHeaders} />
      <div style={{ fontSize: '11px', color: 'var(--text-dim)', margin: '14px 0 6px', fontFamily: FONT_MONO }}>
        {isResponse ? '← response body' : '→ request body'}
      </div>
      <JsonBlock value={isResponse ? event.wire.responseBody : event.wire.requestBody} />
    </div>
  );
};

/**
 * Export options dialog: pick which bodies to include in the JSONL download.
 * Metadata (time/status/model/routing/usage) is always kept — only the three
 * body views (request / upstreamRequest / response) are optional. The HTTP-
 * level observation (`upstreamHttp`) rides along with the upstream wire
 * body: stripping `upstreamRequest` strips both — they describe the same
 * outbound transaction.
 */
const ExportDialog: React.FC<{
  session: CaptureSessionRow;
  onClose: () => void;
  onConfirm: (exclude: string[], includeImages: boolean) => void;
}> = ({ session, onClose, onConfirm }) => {
  const { t } = useI18n();
  const [keepReqIn, setKeepReqIn] = useState(true);
  const [keepReqOut, setKeepReqOut] = useState(true);
  const [keepResp, setKeepResp] = useState(true);
  // Offload media files ride the export only when asked: the ZIP grows by
  // every referenced payload (deduped), the JSONL alone always stands on its
  // own — the [MEDIA …] placeholders keep it self-describing.
  const [withImages, setWithImages] = useState(false);
  useBodyScrollLock(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = [
    { checked: keepReqIn, set: setKeepReqIn, label: t('captures.tabReqIn') },
    { checked: keepReqOut, set: setKeepReqOut, label: t('captures.tabReqOut') },
    { checked: keepResp, set: setKeepResp, label: t('captures.tabResp') },
  ];
  // The response tab shows response ?? upstreamError, so one toggle drops both.
  const exclude: string[] = [];
  if (!keepReqIn) exclude.push('request');
  if (!keepReqOut) exclude.push('upstreamRequest', 'upstreamHttp');
  if (!keepResp) exclude.push('response', 'upstreamError');

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 220,
        background: 'var(--scrim)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        animation: 'ocr-fade-in 0.15s ease',
      }}
    >
      <div
        className="card"
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 380,
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
          animation: 'ocr-pop-in 0.18s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Download size={16} color="var(--accent)" />
          <span style={{ fontSize: '14px', fontWeight: 700 }}>{t('captures.exportOptionsTitle')}</span>
        </div>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: '11px',
            color: 'var(--text-dim)',
            wordBreak: 'break-all',
          }}
        >
          {session.sessionId}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map(r => (
            <label
              key={r.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                fontSize: '12.5px',
                cursor: 'pointer',
              }}
            >
              <span>{r.label}</span>
              <Switch checked={r.checked} onChange={r.set} ariaLabel={r.label} />
            </label>
          ))}
        </div>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            fontSize: '12.5px',
            cursor: 'pointer',
            paddingTop: 2,
            borderTop: '1px dashed var(--card-border)',
          }}
        >
          <span>{t('captures.exportIncludeImages')}</span>
          <Switch checked={withImages} onChange={setWithImages} ariaLabel={t('captures.exportIncludeImages')} />
        </label>
        <div style={{ fontSize: '11.5px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
          {t('captures.exportOptionsHint')}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={() => onConfirm(exclude, withImages)}>
            {t('captures.exportBtn')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export const CapturesPage: React.FC = () => {
  const { t } = useI18n();
  const confirmDialog = useConfirm();
  const toast = useToast();

  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [dates, setDates] = useState<CaptureDateRow[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [sessions, setSessions] = useState<CaptureSessionRow[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [turns, setTurns] = useState<CaptureTurn[]>([]);
  const [events, setEvents] = useState<HttpExchangeEvent[]>([]);
  // Logical turn count for the whole archive (totalLines is raw event
  // lines — 2-4 per turn — and must never be labelled as turns).
  const [totalTurns, setTotalTurns] = useState(0);
  const [fileTruncated, setFileTruncated] = useState(false);
  // Cross-midnight stitching: per-date fragments the displayed timeline was
  // merged from (empty = single-archive session).
  const [fragments, setFragments] = useState<CaptureFragmentRow[]>([]);
  const [selectedTurnIdx, setSelectedTurnIdx] = useState<number | null>(null);
  // Tab the drawer should land on ("decisionRequest" when opened from the
  // decision badge); reset to undefined when the selection changes.
  const [initialDrawerTab, setInitialDrawerTab] = useState<DrawerTab | undefined>(undefined);
  const openTurn = (idx: number, tab?: DrawerTab) => {
    setInitialDrawerTab(tab);
    setSelectedTurnIdx(idx);
  };
  // Main-pane view mode: wire timeline (default) or the reconstructed
  // conversation replay. Always starts on the timeline — the chat lens
  // parses + renders every round, so it should cost nothing until the
  // user opts in per visit (deliberately NOT persisted across reloads).
  const [mainView, setMainView] = useState<'timeline' | 'chat'>('timeline');
  // Fullscreen conversation reading (transient — never persisted).
  const [chatFull, setChatFull] = useState(false);
  // Scroll layer of the fullscreen reading portal — feeds the back-to-top pill.
  const chatFullScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!chatFull) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChatFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatFull]);
  // Switching archives (or lenses) drops the reader back to the pane.
  useEffect(() => {
    setChatFull(false);
  }, [selectedFile, mainView]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [toggling, setToggling] = useState(false);
  // Metadata-first reads: the turn list loads WITHOUT wire bodies (instant
  // paint); `bodiesLoaded` marks that the current `turns` carry the full
  // bodies (conversation lens / explicit full read). Drawer bodies are
  // fetched per turn and cached per session (fetchedTurnsRef).
  const [bodiesLoaded, setBodiesLoaded] = useState(false);
  // The date/file pair the rendered `turns` were loaded for — a date-chip
  // click updates the live selection one render BEFORE the turns are
  // replaced, so per-turn fetches must target this pair, not the live one.
  const [loadedFor, setLoadedFor] = useState<{ date: string; file: string }>({ date: '', file: '' });
  // Left-rail list: in-flight marker + monotonic read sequence — while a
  // date's list is loading the rail shows skeleton rows, never the stale
  // previous date's list nor a premature "no archives" empty state.
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const sessionsSeqRef = useRef(0);
  const [drawerTurn, setDrawerTurn] = useState<CaptureTurn | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerMiss, setDrawerMiss] = useState(false);
  // Monotonic read sequence: a newer selection supersedes an in-flight read
  // (fast A→B clicks must never let A's late response clobber B's).
  const loadSeqRef = useRef(0);
  // Set when the latest read failed: the conversation-lens upgrade effect
  // keys off bodiesLoaded/loading and would refetch in a loop on a
  // persistent failure — the explicit refresh buttons are the retry path.
  const loadFailedRef = useRef(false);
  const fetchedTurnsRef = useRef(new Map<string, CaptureTurn>());
  const [exportTarget, setExportTarget] = useState<CaptureSessionRow | null>(null);
  const [query, setQuery] = useState('');
  // Per-application retrieval: '' = all keys; otherwise a client API-key id
  // passed to the backend as `?apiKey=` (server-side session filtering).
  const [apiKeyFilter, setApiKeyFilter] = useState('');
  const [apiKeyOptions, setApiKeyOptions] = useState<{ id: string; name: string }[]>([]);
  const [pendingFile, setPendingFile] = useState<string>('');
  // Detail-pane auto refresh: quiet tail re-read of the open session archive
  // every AUTO_REFRESH_INTERVAL_MS. On by default; the choice persists.
  const [autoRefresh, setAutoRefresh] = useState(() => {
    try {
      return localStorage.getItem(AUTO_REFRESH_KEY) !== '0';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(AUTO_REFRESH_KEY, autoRefresh ? '1' : '0');
    } catch {
      /* storage unavailable — the toggle just won't persist */
    }
  }, [autoRefresh]);
  const [searchParams] = useSearchParams();
  const sessionParam = searchParams.get('session') || '';

  // Left-rail width: draggable splitter (persisted; double-click resets).
  const {
    width: railWidth,
    hot: railHot,
    onResizeStart: onRailResizeStart,
    reset: resetRailWidth,
    setHot: setRailHot,
  } = useSplitterWidth({ storageKey: RAIL_WIDTH_KEY, initial: RAIL_DEFAULT, min: RAIL_MIN, max: RAIL_MAX });

  const loadStatus = useCallback(async () => {
    try {
      const [st, ds] = await Promise.all([api.getCaptureStatus(), api.getCaptureDates()]);
      setStatus(st);
      setDates(ds);
      setSelectedDate(prev => (prev && ds.some(d => d.date === prev) ? prev : ds[0]?.date || ''));
    } catch (err) {
      console.error(err);
    }
  }, []);

  const loadSessions = useCallback(async (date: string, apiKey?: string) => {
    const seq = ++sessionsSeqRef.current;
    if (!date) {
      setSessions([]);
      setSessionsLoading(false);
      return;
    }
    setSessionsLoading(true);
    try {
      const rows = await api.getCaptureSessions(date, apiKey || undefined);
      if (seq !== sessionsSeqRef.current) return; // superseded by a newer date/filter
      setSessions(rows);
      setSelectedFile(prev => (prev && rows.some(r => r.file === prev) ? prev : ''));
    } catch (err) {
      console.error(err);
    } finally {
      if (seq === sessionsSeqRef.current) setSessionsLoading(false);
    }
  }, []);

  const loadRecords = useCallback(async (date: string, file: string, wantBodies = false) => {
    const seq = ++loadSeqRef.current;
    fetchedTurnsRef.current.clear();
    setDrawerTurn(null);
    setDrawerLoading(false);
    setDrawerMiss(false);
    setSelectedTurnIdx(null);
    setBodiesLoaded(false);
    // Immediate feedback: the previous session's rows drop right away and a
    // skeleton takes over — a click never waits silently on the fetch. The
    // metadata-first read (no wire bodies) keeps that wait to KBs.
    setTurns([]);
    setEvents([]);
    if (!date || !file) {
      // Supersedes any in-flight read — its seq-guarded finally must not be
      // the one to clear `loading`, so clear it here or a deselect while a
      // load is in flight would stick the skeleton on forever.
      if (seq === loadSeqRef.current) setLoading(false);
      return;
    }
    loadFailedRef.current = false;
    setLoading(true);
    setLoadedFor({ date, file });
    try {
      const res = await api.getCaptureEvents(date, file, 500, wantBodies ? 'full' : 'none');
      if (seq !== loadSeqRef.current) return; // superseded by a newer selection
      setTurns([...res.turns].reverse());
      setEvents(res.events);
      setTotalTurns(res.totalTurns);
      setFileTruncated(res.fileTruncated);
      setFragments(res.fragments ?? []);
      setBodiesLoaded(wantBodies);
    } catch (err) {
      console.error(err);
      // No auto-retry (see loadFailedRef) — flag it for the upgrade effect.
      if (seq === loadSeqRef.current) loadFailedRef.current = true;
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    loadSessions(selectedDate, apiKeyFilter);
    setSelectedFile('');
    setTurns([]);
    setEvents([]);
  }, [selectedDate, apiKeyFilter, loadSessions]);

  // Combobox options: the configured client keys (id + application name).
  // Best-effort — a console session without /api-keys visibility just shows
  // the "all keys" entry.
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
    // A session opened while the conversation lens is active needs full
    // bodies immediately; lens switches are upgraded by the effect below.
    loadRecords(selectedDate, selectedFile, mainView === 'chat');
  }, [selectedDate, selectedFile, loadRecords]);

  // Switching to the conversation lens needs full wire bodies (the
  // metadata-first list is enough only for the timeline). Upgrade in place:
  // the skeleton takes over, then the full read renders progressively.
  // loadFailedRef stops the loop: on a persistent failure this effect would
  // otherwise refire on every loading flip — the refresh button retries.
  useEffect(() => {
    if (mainView !== 'chat' || !selectedFile || bodiesLoaded || loading || loadFailedRef.current) return;
    loadRecords(selectedDate, selectedFile, true);
  }, [mainView, selectedFile, bodiesLoaded, loading, selectedDate, loadRecords]);

  /**
   * Deep link from other pages: /captures?session=<raw sessionId>.
   * The backend re-sanitizes the id (hashed archives match), so even whole
   * JSON-blob client ids resolve. Hit → select the newest archive date and
   * stage the file; the effect below expands it once the list has loaded.
   */
  useEffect(() => {
    if (!sessionParam) return;
    let alive = true;
    (async () => {
      try {
        const matches = await api.findCaptureSessions(sessionParam);
        if (!alive) return;
        if (matches.length > 0) {
          setSelectedDate(matches[0].date);
          setPendingFile(matches[0].file);
        } else {
          toast.error(t('captures.sessionNotFound'));
        }
      } catch (err) {
        console.error(err);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionParam, toast, t]);

  // Expand the deep-linked session once its date's list is in place.
  useEffect(() => {
    if (!pendingFile || sessions.length === 0) return;
    if (sessions.some(s => s.file === pendingFile)) {
      setSelectedFile(pendingFile);
    }
    setPendingFile('');
  }, [pendingFile, sessions]);

  // Drawer bodies: metadata-first turns carry no wire bodies — fetch the
  // full turn on open (cached per session so re-opening is instant). With
  // bodies already loaded (conversation lens) the local turn is used as-is.
  useEffect(() => {
    if (selectedTurnIdx === null) {
      setDrawerTurn(null);
      setDrawerMiss(false);
      return;
    }
    const meta = turns[selectedTurnIdx];
    if (!meta) return;
    // The rendered turns belong to `loadedFor`, not necessarily to the live
    // selection — a date-chip click updates selectedDate a render before the
    // turns are replaced. Fetching against the live selection here would ask
    // the WRONG archive for bodies; wait until the load lands.
    if (loadedFor.date !== selectedDate || loadedFor.file !== selectedFile) return;
    if (bodiesLoaded) {
      setDrawerTurn(meta);
      setDrawerMiss(false);
      return;
    }
    const key = meta.clientRequest?.id ?? meta.traceId;
    const cached = fetchedTurnsRef.current.get(key);
    if (cached) {
      setDrawerTurn(cached);
      setDrawerMiss(false);
      return;
    }
    let alive = true;
    setDrawerTurn(null);
    setDrawerLoading(true);
    setDrawerMiss(false);
    api
      .getCaptureTurn(loadedFor.date, loadedFor.file, key)
      .then(res => {
        if (!alive) return;
        if (res) {
          fetchedTurnsRef.current.set(key, res);
          setDrawerTurn(res);
        } else {
          // Turn archived beyond the read window — render the metadata-only
          // turn plus an explanation instead of a silent blank.
          setDrawerMiss(true);
        }
      })
      .catch(err => {
        console.error(err);
        if (alive) setDrawerMiss(true);
      })
      .finally(() => {
        if (alive) setDrawerLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selectedTurnIdx, turns, bodiesLoaded, loadedFor, selectedDate, selectedFile]);

  /**
   * Quiet tail refresh for the auto-poll: same request as the session-level
   * refresh button, but never disturbs the reader — no skeleton, no selection
   * reset, no loading flag. Skipped entirely while a turn drawer is open, a
   * read is already in flight, the tab is hidden, or no archive is selected.
   * On failure it stays silent — the next tick and the refresh buttons are
   * the retry paths (loadFailedRef semantics untouched).
   */
  const autoStateRef = useRef({ loading, selectedTurnIdx, selectedDate, selectedFile, bodiesLoaded });
  autoStateRef.current = { loading, selectedTurnIdx, selectedDate, selectedFile, bodiesLoaded };
  const tailRefreshSeqRef = useRef(0);
  const tailRefresh = useCallback(async () => {
    const st = autoStateRef.current;
    if (!st.selectedFile || st.loading || st.selectedTurnIdx !== null || document.hidden) return;
    const seq = ++tailRefreshSeqRef.current;
    try {
      const res = await api.getCaptureEvents(st.selectedDate, st.selectedFile, 500, st.bodiesLoaded ? 'full' : 'none');
      if (seq !== tailRefreshSeqRef.current) return;
      // The user may have switched archives mid-flight — the late response
      // must not clobber the new selection's turns.
      const cur = autoStateRef.current;
      if (cur.selectedDate !== st.selectedDate || cur.selectedFile !== st.selectedFile) return;
      // A drawer opened while this tick was in flight — a new turn landing at
      // the head shifts row indices and the drawer would silently re-resolve
      // to a different turn. Skip rather than disturb the reader.
      if (cur.selectedTurnIdx !== null) return;
      setTurns([...res.turns].reverse());
      setEvents(res.events);
      setTotalTurns(res.totalTurns);
      setFileTruncated(res.fileTruncated);
      setFragments(res.fragments ?? []);
      setBodiesLoaded(st.bodiesLoaded);
      loadFailedRef.current = false;
    } catch {
      /* silent — retried on the next tick */
    }
  }, []);

  useEffect(() => {
    if (!autoRefresh || !selectedFile) return;
    const id = setInterval(tailRefresh, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [autoRefresh, selectedFile, tailRefresh]);

  /**
   * Full refresh: status + date chips, then the session list of the selected
   * day, then the open session's timeline. The old button only re-read the
   * status header, which almost never changes — it looked dead.
   */
  const handleRefreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadStatus();
      await loadSessions(selectedDate, apiKeyFilter);
      if (selectedFile) await loadRecords(selectedDate, selectedFile, mainView === 'chat' || bodiesLoaded);
    } finally {
      setRefreshing(false);
    }
  }, [loadStatus, loadSessions, loadRecords, selectedDate, apiKeyFilter, selectedFile, mainView, bodiesLoaded]);

  const handleToggle = async (next: boolean) => {
    if (toggling) return;
    // Enabling persists full request/response bodies (potentially sensitive
    // data) — confirm once; disabling is instant and lossless.
    if (next) {
      const ok = await confirmDialog({
        title: t('captures.enableConfirm'),
        danger: false,
        confirmLabel: t('common.confirm'),
      });
      if (!ok) return;
    }
    setToggling(true);
    try {
      const cfg = await api.getConfig();
      // Whole-section rebuild: save shallow-merges top-level sections, so the
      // untouched requestCapture fields must be re-sent or they are dropped.
      const res: any = await api.saveConfig({
        ...cfg,
        requestCapture: {
          retentionDays: 7,
          maxTotalMB: 2048,
          maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
          maxSessionMB: 512,
          ...(cfg.requestCapture || {}),
          enabled: next,
        },
      });
      if (res.success !== false) {
        toast.success(t('captures.toggleSaved'));
        await loadStatus();
      } else {
        toast.error(res.error || res.message || t('common.failed'));
      }
    } catch (err: any) {
      toast.error(err.message || t('common.failed'));
    } finally {
      setToggling(false);
    }
  };

  const handleExport = async (s: CaptureSessionRow, exclude: string[] = [], includeImages = false) => {
    if (!selectedDate) return;
    try {
      const blob = await api.exportCaptureArchive(selectedDate, s.file, exclude.length ? exclude : undefined);
      const jsonlName = `capture-${selectedDate}-${s.sessionId}.jsonl`;
      if (!includeImages) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = jsonlName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast.success(t('captures.exported'));
        return;
      }
      // ZIP mode: the JSONL plus every offloaded payload it references
      // (deduped by sha). A media fetch failure skips that one file — the
      // archive text still exports complete with its [MEDIA …] placeholders.
      const text = await blob.text();
      const entries: Record<string, Uint8Array> = { [jsonlName]: strToU8(text) };
      const wanted = new Set<string>();
      for (const m of findMediaTokens(text)) if (m.file) wanted.add(m.sha256);
      for (const sha of wanted) {
        try {
          const res = await fetch(`/api/admin/capture/${selectedDate}/media/${sha}`);
          if (!res.ok) continue;
          const token = findMediaTokens(text).find(x => x.sha256 === sha && x.file);
          const name = token?.file?.replace(/^media\//, '') ?? sha;
          entries[`media/${name}`] = new Uint8Array(await res.arrayBuffer());
        } catch {
          // fail-open per file, same doctrine as the recorder.
        }
      }
      const zipped = zipSync(entries);
      const url = URL.createObjectURL(new Blob([zipped], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = jsonlName.replace(/\.jsonl$/, '.zip');
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(t('captures.exported'));
    } catch (err: any) {
      toast.error(err.message || t('common.failed'));
    }
  };

  const handleDeleteDate = async (date: string) => {
    const ok = await confirmDialog({
      title: t('captures.deleteConfirm').replace('{date}', date),
      danger: true,
      confirmLabel: t('common.delete'),
    });
    if (!ok) return;
    try {
      const res = await api.deleteCaptureDate(date);
      if (res.status === 'ok') {
        toast.success(t('captures.deleted'));
        setSelectedFile('');
        setTurns([]);
        setEvents([]);
        await loadStatus();
      } else {
        toast.error(res.message || t('common.failed'));
      }
    } catch (err: any) {
      toast.error(err.message || t('common.failed'));
    }
  };

  const handleDeleteSession = async (s: CaptureSessionRow) => {
    if (!selectedDate) return;
    const ok = await confirmDialog({
      title: t('captures.deleteSessionConfirm').replace('{sessionId}', s.sessionId),
      danger: true,
      confirmLabel: t('common.delete'),
    });
    if (!ok) return;
    try {
      const res = await api.deleteCaptureSession(selectedDate, s.file);
      if (res.status === 'ok') {
        toast.success(t('captures.sessionDeleted'));
        // Drop the drawer + timeline if the deleted session was open.
        if (selectedFile === s.file) {
          setSelectedFile('');
          setTurns([]);
          setEvents([]);
          setSelectedTurnIdx(null);
        }
        await loadSessions(selectedDate, apiKeyFilter);
        await loadStatus();
      } else {
        toast.error(res.message || t('common.failed'));
      }
    } catch (err: any) {
      toast.error(err.message || t('common.failed'));
    }
  };

  // Session filter: id substring OR first-message preview OR key name,
  // case-insensitive. (`apiKeyFilter` above is the server-side per-app selector.)
  const q = query.trim().toLowerCase();
  const visibleSessions = q
    ? sessions.filter(
        s =>
          s.sessionId.toLowerCase().includes(q) ||
          (s.preview || '').toLowerCase().includes(q) ||
          (s.apiKeys ?? []).some(k => k.name.toLowerCase().includes(q))
      )
    : sessions;

  // Header summary: sum of per-turn gateway latency over the loaded tail
  // window. Idle gaps between turns are deliberately excluded — in long
  // client sessions the wall-clock span is dominated by think time.
  const totalLatencyMs = useMemo(() => {
    let sum = 0;
    for (const turn of turns) sum += turn.gatewayLatencyMs ?? turn.upstreamLatencyMs ?? 0;
    return sum;
  }, [turns]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      {/* Archive status, master toggle & retention policy */}
      <div className="card" style={{ flexShrink: 0 }}>
        <div className="card-header" style={{ flexWrap: 'wrap', gap: '10px' }}>
          <div className="card-title">
            <Archive size={18} color="var(--accent)" />
            <span>{t('captures.title')}</span>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
              <span style={{ color: status?.enabled ? 'var(--accent-emerald)' : 'var(--text-dim)' }}>
                {status?.enabled ? t('captures.on') : t('captures.off')}
              </span>
              <Switch
                checked={Boolean(status?.enabled)}
                onChange={handleToggle}
                disabled={toggling || !status}
                ariaLabel={t('captures.title')}
              />
            </label>
            <button className="btn btn-sm" onClick={handleRefreshAll} disabled={loading || refreshing}>
              <RefreshCw size={12} style={refreshing ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined} />
              <span>{t('captures.refresh')}</span>
            </button>
          </div>
        </div>
        <div style={{ padding: '12px 14px', fontSize: '12px' }}>
          {status?.enabled && (
            <div style={{ color: 'var(--text-dim)', marginBottom: '10px' }}>{t('captures.hotHint')}</div>
          )}
          {status && !status.enabled && (
            <div style={{ color: 'var(--text-dim)', lineHeight: 1.8 }}>
              <div>{t('captures.disabledHint')}</div>
            </div>
          )}
          {status && status.enabled && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '18px', color: 'var(--text-muted)' }}>
              <span>
                {t('captures.dir')}: <code style={{ color: 'var(--accent)' }}>{status.dir}</code>
              </span>
              <span>
                {t('captures.retention')}: {status.retentionDays} {t('captures.days')}
              </span>
              <span>
                {t('captures.totalSize')}: {fmtBytes(status.totalBytes)} / {status.maxTotalMB} MB
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Browser: date chips on top → session list (left) + timeline (right) */}
      {status?.enabled && (
        <div
          className="card"
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            padding: 0, // edge-to-edge panes below manage their own padding
            overflow: 'hidden', // clip panes to the card radius
          }}
        >
          {dates.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '12px' }}>
              {t('captures.emptyDates')}
            </div>
          ) : (
            <>
              {/* Date selector row */}
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '8px',
                  alignItems: 'center',
                  padding: '10px 12px',
                  borderBottom: '1px solid var(--divider)',
                  flexShrink: 0,
                }}
              >
                {dates.map(d => (
                  <button
                    key={d.date}
                    className="btn btn-sm"
                    onClick={() => setSelectedDate(d.date)}
                    style={
                      d.date === selectedDate
                        ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                        : undefined
                    }
                    title={`${d.sessions} ${t('captures.sessionsUnit')} · ${fmtBytes(d.bytes)}`}
                  >
                    {d.date}
                    <span style={{ marginLeft: '6px', color: 'var(--text-dim)' }}>({d.sessions})</span>
                  </button>
                ))}
                {selectedDate && (
                  <button
                    className="btn btn-sm"
                    style={{ marginLeft: 'auto', color: '#ef4444' }}
                    onClick={() => handleDeleteDate(selectedDate)}
                  >
                    <Trash2 size={12} />
                    <span>{t('captures.deleteDate')}</span>
                  </button>
                )}
              </div>

              <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
                {/* Left rail: filter + session list of the selected day.
                    Width is user-resizable via the splitter; persisted.
                    No borderRight here — the list card below owns the pane
                    frame; a second line beside it read as a double rule. */}
                <div
                  style={{
                    width: railWidth,
                    flexShrink: 0,
                    padding: '10px',
                    display: 'flex',
                    flexDirection: 'column',
                    minHeight: 0,
                  }}
                >
                  {/* One card frames the whole scanning surface (filters +
                      list): the pane felt floaty in light themes when the
                      bordered inputs sat above borderless drifting rows.
                      Rows themselves stay frameless — hairline rules divide
                      them (list-group language), selection rides the 2px
                      left rail. */}
                  <div
                    style={{
                      flex: 1,
                      minHeight: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      border: '1px solid var(--card-border)',
                      borderRadius: 8,
                      background: 'var(--bg-elev)',
                      overflow: 'hidden',
                    }}
                  >
                  <div style={{ padding: '10px 10px 12px', flexShrink: 0, borderBottom: '1px solid var(--divider)' }}>
                    <input
                      type="text"
                      className="input"
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                      placeholder={t('captures.searchPlaceholder')}
                      style={{ width: '100%', fontSize: '12px', padding: '6px 10px' }}
                    />
                    <Combobox
                      value={apiKeyFilter}
                      onChange={setApiKeyFilter}
                      options={[
                        { value: '', label: t('captures.apiKeyAll') },
                        ...apiKeyOptions.map(k => ({ value: k.id, label: k.name })),
                      ]}
                      style={{ width: '100%', fontSize: '12px', padding: '6px 10px', marginTop: 6 }}
                    />
                  </div>
                  <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
                  {sessionsLoading && (
                    <div style={{ padding: '4px 0' }}>
                      {Array.from({ length: 7 }, (_, i) => (
                        <div
                          key={i}
                          className="ocr-skeleton-row"
                          style={{ height: 34, width: `${92 - (i % 3) * 10}%` }}
                        />
                      ))}
                    </div>
                  )}
                  {!sessionsLoading && visibleSessions.map((s, i) => (
                    <div
                      key={s.file}
                      className="capture-session-card"
                      data-selected={s.file === selectedFile || undefined}
                      onClick={() => setSelectedFile(s.file)}
                      title={
                        [
                          s.sessionId,
                          (s.apiKeys ?? [])
                            .map(k => t('captures.apiKeyTooltip', { name: k.name, id: k.id }))
                            .join('\n'),
                          s.preview || '',
                          fmtBytes(s.bytes),
                        ]
                          .filter(Boolean)
                          .join('\n')
                      }
                      style={{
                        padding: '8px 10px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        lineHeight: 1.4,
                        // Full-bleed list row: hairline between neighbors,
                        // 2px left rail marks the selection (transparent
                        // otherwise so text columns never shift).
                        borderTop: i > 0 ? '1px solid var(--divider)' : undefined,
                        background: s.file === selectedFile ? 'var(--chip-bg)' : undefined,
                        borderLeft: s.file === selectedFile ? '2px solid var(--accent)' : '2px solid transparent',
                      }}
                    >
                      {/* Row 1 — the scannable identity: status dot, the
                          first-message preview as the title (falls back to the
                          raw id), timestamp right-aligned on the same line.
                          Last-turn status dot: emerald = ok, red = error,
                          dim gray = unknown (archive has the request half
                          only — no gateway response was ever recorded). */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                        <span
                          title={
                            s.lastStatus === 'ok'
                              ? t('captures.lastOkTitle')
                              : s.lastStatus === 'error'
                                ? t('captures.lastErrorTitle')
                                : t('captures.lastUnknownTitle')
                          }
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            flexShrink: 0,
                            background:
                              s.lastStatus === 'ok'
                                ? 'var(--accent-emerald)'
                                : s.lastStatus === 'error'
                                  ? '#ef4444'
                                  : 'var(--text-dim)',
                            boxShadow:
                              s.lastStatus === 'error'
                                ? '0 0 6px rgba(239,68,68,0.5)'
                                : s.lastStatus === 'ok'
                                  ? '0 0 6px color-mix(in srgb, var(--accent-emerald) 40%, transparent)'
                                  : 'none',
                          }}
                        />
                        <span
                          className="capture-session-title"
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {unwrapHarnessText(s.preview ?? '') || s.sessionId}
                        </span>
                        <span
                          style={{
                            color: 'var(--text-dim)',
                            fontSize: '11px',
                            fontFamily: FONT_MONO,
                            flexShrink: 0,
                          }}
                        >
                          {fmtTime(s.mtimeMs)}
                        </span>
                      </div>
                      {/* Row 2 — machine detail + actions. paddingLeft 16px
                          aligns it under the title (dot 8 + gap 8). The id
                          renders in full and CSS ellipsis cuts it at the real
                          pixel boundary, so it claims every available column
                          width; skipped when it already IS the row-1 title;
                          action icons reveal on hover (capture-card-actions). */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          marginTop: '2px',
                          paddingLeft: '16px',
                          minWidth: 0,
                        }}
                      >
                        {s.preview && (
                          <span
                            style={{
                              fontFamily: FONT_MONO,
                              fontSize: '10.5px',
                              color: 'var(--text-dim)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              minWidth: 0,
                            }}
                          >
                            {s.sessionId}
                          </span>
                        )}
                        {s.apiKeys && s.apiKeys.length > 0 && (
                          <span
                            title={t('captures.apiKeyTooltip', { name: s.apiKeys[0].name, id: s.apiKeys[0].id })}
                            style={{
                              fontSize: '10px',
                              lineHeight: '14px',
                              padding: '1px 6px',
                              borderRadius: '4px',
                              background: 'color-mix(in srgb, var(--accent-emerald) 10%, transparent)',
                              border: '1px solid color-mix(in srgb, var(--accent-emerald) 25%, transparent)',
                              color: 'var(--accent-emerald)',
                              flexShrink: 0,
                            }}
                          >
                            {s.apiKeys[0].name}
                            {s.apiKeys.length > 1 ? ` +${s.apiKeys.length - 1}` : ''}
                          </span>
                        )}
                        {s.spanDates && s.spanDates.length > 1 && (
                          <span
                            title={t('captures.spansDays', { n: s.spanDates.length })}
                            style={{
                              fontSize: '10px',
                              lineHeight: '14px',
                              padding: '1px 6px',
                              borderRadius: '4px',
                              background: 'var(--hue-blue-soft)',
                              color: 'var(--hue-blue)',
                              flexShrink: 0,
                            }}
                          >
                            ⊕{s.spanDates.length}d
                            {/* This shard is NOT the conversation's opening day
                                (spanDates is newest-first, last = earliest). */}
                            {selectedDate !== s.spanDates[s.spanDates.length - 1] && (
                              <span style={{ opacity: 0.75 }}> · {t('captures.continuedFrom')}</span>
                            )}
                          </span>
                        )}
                        <span
                          className="capture-card-actions"
                          style={{
                            marginLeft: 'auto',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            flexShrink: 0,
                          }}
                        >
                          <span
                            role="button"
                            aria-label={t('captures.exportTitle')}
                            title={t('captures.exportTitle')}
                            onClick={e => {
                              e.stopPropagation();
                              setExportTarget(s);
                            }}
                            style={{
                              color: 'var(--text-dim)',
                              display: 'flex',
                              alignItems: 'center',
                              cursor: 'pointer',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
                            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
                          >
                            <Download size={13} />
                          </span>
                          <span
                            role="button"
                            aria-label={t('captures.deleteSession')}
                            title={t('captures.deleteSession')}
                            onClick={e => {
                              e.stopPropagation();
                              handleDeleteSession(s);
                            }}
                            style={{
                              color: 'var(--text-dim)',
                              display: 'flex',
                              alignItems: 'center',
                              cursor: 'pointer',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
                            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
                          >
                            <Trash2 size={13} />
                          </span>
                        </span>
                      </div>
                    </div>
                  ))}
                  {!sessionsLoading && visibleSessions.length === 0 && (
                    <div style={{ padding: '8px 10px', fontSize: '11px', color: 'var(--text-dim)' }}>
                      {q ? t('captures.noMatchSessions') : t('captures.emptySessions')}
                    </div>
                  )}
                  </div>
                  </div>
                </div>

                {/* Drag splitter: resize the rail (double-click = reset). */}
                <VSplitter
                  hot={railHot}
                  onResizeStart={onRailResizeStart}
                  onHotChange={setRailHot}
                  onReset={resetRailWidth}
                />

                {/* Main pane: session timeline */}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  {!selectedFile ? (
                    <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '12px' }}>
                      {t('captures.pickSession')}
                    </div>
                  ) : (
                    <>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          padding: '10px 16px',
                          borderBottom: '1px solid var(--divider)',
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{ fontSize: '13px', fontWeight: 600 }}>{t('captures.turnsTitle')}</span>
                        <span style={{ fontFamily: FONT_MONO, fontSize: '11px', color: 'var(--text-dim)' }}>
                          {selectedFile.replace(/\.jsonl$/, '')} · {totalTurns} {t('captures.turnsUnit')}
                        </span>
                        {fragments.length > 1 && (
                          <span
                            title={t('captures.stitchedHint', { n: fragments.length })}
                            style={{
                              fontSize: '10px',
                              lineHeight: '16px',
                              padding: '0 6px',
                              borderRadius: '4px',
                              background: 'var(--hue-blue-soft)',
                              color: 'var(--hue-blue)',
                            }}
                          >
                            ⊕ {fragments.length}d
                          </span>
                        )}
                        {totalLatencyMs > 0 && (
                          <span
                            title={t('captures.totalTimeHint', { n: turns.length })}
                            style={{ fontFamily: FONT_MONO, fontSize: '11px', color: 'var(--text-dim)' }}
                          >
                            · {t('captures.totalTime')} {fmtDur(totalLatencyMs)}
                          </span>
                        )}
                        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                          {/* View lens: raw-wire turn timeline vs reconstructed conversation replay. */}
                          <div
                            style={{
                              display: 'flex',
                              border: '1px solid var(--card-border)',
                              borderRadius: 6,
                              overflow: 'hidden',
                            }}
                          >
                            {(['timeline', 'chat'] as const).map(v => (
                              <button
                                key={v}
                                onClick={() => setMainView(v)}
                                style={{
                                  background: mainView === v ? 'var(--chip-bg)' : 'transparent',
                                  color: mainView === v ? 'var(--accent)' : 'var(--text-dim)',
                                  border: 'none',
                                  cursor: 'pointer',
                                  fontSize: '11.5px',
                                  padding: '4px 10px',
                                  minWidth: 64,
                                  textAlign: 'center',
                                }}
                              >
                                {v === 'timeline' ? t('captures.viewTimeline') : t('captures.viewChat')}
                              </button>
                            ))}
                          </div>
                          {/* Fullscreen reading for the conversation lens — the
                              session pane is narrow; long agent sessions deserve
                              the whole viewport. Below the wire drawer (z 210) so
                              raw-wire access keeps working from inside it. */}
                          {mainView === 'chat' && (
                            <button
                              className="btn btn-sm"
                              onClick={() => setChatFull(v => !v)}
                              title={chatFull ? t('captures.chatExitFullscreen') : t('captures.chatFullscreen')}
                            >
                              {chatFull ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                            </button>
                          )}
                          {/* Auto tail-refresh toggle for this detail pane —
                              same quiet re-read as the refresh button, skipped
                              while the turn drawer is open (see tailRefresh). */}
                          <button
                            className="btn btn-sm"
                            onClick={() => setAutoRefresh(v => !v)}
                            title={t('captures.autoRefreshHint')}
                            style={
                              autoRefresh
                                ? { color: 'var(--accent)', borderColor: 'var(--accent)' }
                                : undefined
                            }
                          >
                            <Zap size={12} />
                            <span>{t('captures.autoRefresh')}</span>
                          </button>
                          {/* Session-level refresh: re-read just this archive's
                              tail (cheap), vs the header button that reloads
                              status + dates + session list too. */}
                          <button
                            className="btn btn-sm"
                            onClick={() => loadRecords(selectedDate, selectedFile, mainView === 'chat' || bodiesLoaded)}
                            disabled={loading}
                            title={t('captures.refreshTurnsHint')}
                          >
                            <RefreshCw size={12} style={loading ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined} />
                            <span>{t('captures.refresh')}</span>
                          </button>
                        </div>
                      </div>
                      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 16px 14px' }}>
                        {loading && turns.length === 0 ? (
                          <TurnsSkeleton chat={mainView === 'chat'} />
                        ) : mainView === 'chat' ? (
                          <SessionTranscript
                            turns={turns}
                            fileTruncated={fileTruncated}
                            date={selectedDate}
                            onOpenTurn={idx => setSelectedTurnIdx(idx)}
                          />
                        ) : (
                        <>
                        {fileTruncated && (
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              fontSize: '11px',
                              color: 'var(--accent-amber)',
                              padding: '4px 0 8px',
                            }}
                          >
                            <AlertTriangle size={12} />
                            <span>{t('captures.fileTruncatedHint')}</span>
                          </div>
                        )}
                        <div style={{ position: 'relative', paddingLeft: 22 }}>
                          {/* Timeline spine */}
                          <div
                            style={{
                              position: 'absolute',
                              left: 4,
                              top: 10,
                              bottom: 10,
                              width: 2,
                              background: 'var(--card-border)',
                              borderRadius: 1,
                            }}
                          />
                          {turns.length === 0 && (
                            <div style={{ padding: '18px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '12px' }}>
                              {t('captures.emptyRecords')}
                            </div>
                          )}
                          {turns.map((turn, idx) => {
                            const turnStart = turn.clientRequest?.ts
                              ?? turn.upstreamRequest?.ts
                              ?? turn.gatewayResponse?.ts
                              ?? turn.upstreamResponse?.ts
                              ?? turn.decisionRequest?.ts;
                            const errEvent = turn.upstreamResponse?.status === 'error'
                              || turn.gatewayResponse?.status === 'error'
                              || !!turn.error;
                            // Day divider: only when the stitched timeline
                            // actually spans multiple date shards — a
                            // single-day session needs no per-day chrome.
                            // Turns render newest-first, so compare with the
                            // NEXT turn (later in wall time).
                            const multiDay = fragments.length > 1;
                            const prevTurn = turns[idx - 1];
                            const prevStart = prevTurn
                              ? (prevTurn.clientRequest?.ts
                                ?? prevTurn.upstreamRequest?.ts
                                ?? prevTurn.gatewayResponse?.ts
                                ?? prevTurn.upstreamResponse?.ts
                                ?? prevTurn.decisionRequest?.ts)
                              : undefined;
                            const dayChanged =
                              multiDay &&
                              turnStart !== undefined &&
                              (prevStart === undefined || fmtDay(prevStart) !== fmtDay(turnStart));
                            return (
                              <React.Fragment key={`${turn.traceId}-${idx}`}>
                                {dayChanged && (
                                  <div
                                    style={{
                                      position: 'relative',
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 8,
                                      margin: '8px 0 4px',
                                      color: 'var(--text-dim)',
                                      fontSize: '10.5px',
                                      fontFamily: FONT_MONO,
                                    }}
                                  >
                                    <span style={{ flex: 1, height: 1, background: 'var(--card-border)' }} />
                                    <span>{fmtDay(turnStart)}</span>
                                    <span style={{ flex: 1, height: 1, background: 'var(--card-border)' }} />
                                  </div>
                                )}
                              <div
                                onClick={() => openTurn(idx)}
                                style={{
                                  position: 'relative',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '10px',
                                  padding: '7px 10px',
                                  marginBottom: '2px',
                                  borderRadius: '6px',
                                  cursor: 'pointer',
                                  fontSize: '12px',
                                }}
                                onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-hover)')}
                                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                              >
                                <span
                                  style={{
                                    position: 'absolute',
                                    left: -22,
                                    top: 13,
                                    width: 8,
                                    height: 8,
                                    borderRadius: '50%',
                                    background: errEvent ? '#ef4444' : 'var(--accent-emerald)',
                                    boxShadow: '0 0 0 2px var(--card-bg)',
                                  }}
                                />
                                <span style={{ color: 'var(--text-muted)', fontFamily: FONT_MONO, flexShrink: 0 }}>
                                  {turnStart !== undefined ? fmtTime(turnStart) : ''}
                                </span>
                                <span
                                  className="badge"
                                  style={
                                    errEvent
                                      ? { background: 'rgba(239,68,68,0.12)', color: '#ef4444', flexShrink: 0 }
                                      : { background: 'color-mix(in srgb, var(--accent-emerald) 12%, transparent)', color: 'var(--accent-emerald)', flexShrink: 0 }
                                  }
                                >
                                  {errEvent ? t('captures.statusError') : t('captures.statusOk')}
                                </span>
                                <span style={{ fontWeight: 600 }}>
                                  {turn.model}
                                  {(() => {
                                    const upstreamModel = turn.upstreamRequest?.model ?? turn.upstreamResponse?.model;
                                    if (!upstreamModel || upstreamModel === turn.model) return null;
                                    return (
                                      <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>
                                        {' '}→ {upstreamModel}
                                      </span>
                                    );
                                  })()}
                                </span>
                                {/* Turn prompt — the LAST user message, stamped on
                                    the client-request event at write time so
                                    metadata-only reads render it. Absent for
                                    tool-result continuations (dim fallback). */}
                                <span
                                  title={turn.promptSummary || t('sessions.promptFallbackTip')}
                                  style={{
                                    flex: 1,
                                    minWidth: 0,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    color: turn.promptSummary ? 'var(--text-muted)' : 'var(--text-dim)',
                                  }}
                                >
                                  {turn.promptSummary || t('sessions.promptNoUser')}
                                </span>
                                {turn.upstreamRequest?.proxy && (
                                  <span
                                    className="badge"
                                    title={`${t('captures.viaProxy')}: ${turn.upstreamRequest.proxy}`}
                                    style={{
                                      background: 'var(--hue-blue-soft)',
                                      color: 'var(--hue-blue)',
                                      fontFamily: FONT_MONO,
                                      fontSize: '10px',
                                      flexShrink: 0,
                                    }}
                                  >
                                    ⇢ proxy
                                  </span>
                                )}
                                {turn.gatewayLatencyMs !== undefined && (
                                  <span title={`${turn.gatewayLatencyMs} ms`} style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: FONT_MONO, flexShrink: 0 }}>
                                    <ArrowDownRight size={11} strokeWidth={2.75} style={{ verticalAlign: '-1px', color: 'var(--text)' }} /> {fmtLatency(turn.gatewayLatencyMs)}
                                    <span title={[t('captures.timingTip'), legTimingTip(turn, 'gateway')].filter(Boolean).join(' · ')}>
                                      {legTimingText(turn, 'gateway')}
                                    </span>
                                  </span>
                                )}
                                {turn.upstreamLatencyMs !== undefined && (
                                  <span title={`${turn.upstreamLatencyMs} ms`} style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: FONT_MONO, flexShrink: 0 }}>
                                    <ArrowUpRight size={11} strokeWidth={2.75} style={{ verticalAlign: '-1px', color: 'var(--text)' }} /> {fmtLatency(turn.upstreamLatencyMs)}
                                    <span title={[t('captures.timingTip'), legTimingTip(turn, 'upstream')].filter(Boolean).join(' · ')}>
                                      {legTimingText(turn, 'upstream')}
                                    </span>
                                  </span>
                                )}
                                {/* L2 decision layer leg: one compact badge — latency inline,
                                    model + explanation in the tooltip. Click opens
                                    the drawer's decision tabs (full wire). */}
                                {turn.decisionRequest && (
                                  <span
                                    className="badge"
                                    onClick={() => openTurn(idx, 'decisionRequest')}
                                    title={`${t('captures.decisionBadge')} · ${turn.decisionRequest.model}${turn.decisionLatencyMs !== undefined ? ` · ${turn.decisionLatencyMs} ms` : ''} · ${t('captures.decisionHint')}`}
                                    style={{
                                      background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
                                      color: 'var(--accent)',
                                      fontFamily: FONT_MONO,
                                      fontSize: '10px',
                                      flexShrink: 0,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    <Scale size={10} style={{ verticalAlign: '-1px', marginRight: '3px' }} />
                                    {turn.decisionLatencyMs !== undefined ? fmtLatency(turn.decisionLatencyMs) : t('captures.decisionBadge')}
                                  </span>
                                )}
                              </div>
                              </React.Fragment>
                            );
                          })}
                        </div>
                        </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {selectedTurnIdx !== null && turns[selectedTurnIdx] && (
        <CaptureDrawer
          turn={drawerTurn ?? turns[selectedTurnIdx]}
          loading={drawerLoading}
          outOfWindow={drawerMiss}
          initialTab={initialDrawerTab}
          onClose={() => setSelectedTurnIdx(null)}
        />
      )}

      {chatFull && mainView === 'chat' &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 200,
              background: 'var(--bg)',
              display: 'flex',
              flexDirection: 'column',
              animation: 'ocr-fade-in 0.15s ease',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 18px',
                borderBottom: '1px solid var(--divider)',
                flexShrink: 0,
              }}
            >
              <span style={{ fontSize: '13px', fontWeight: 700 }}>{t('captures.viewChat')}</span>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: '11px',
                  color: 'var(--text-dim)',
                  wordBreak: 'break-all',
                }}
              >
                {sessions.find(s => s.file === selectedFile)?.sessionId ?? selectedFile}
              </span>
              <button
                className="btn btn-sm"
                style={{ marginLeft: 'auto', flexShrink: 0 }}
                onClick={() => setChatFull(false)}
                title={t('captures.chatExitFullscreen')}
              >
                <Minimize2 size={12} />
                <span>{t('captures.chatExitFullscreen')}</span>
              </button>
            </div>
            <div
              ref={chatFullScrollRef}
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                padding: '16px 24px',
              }}
            >
              {/* Reading column as a visible PAGE: frame + elevated fill give
                  the fullscreen view left/right edge lines — borderless, the
                  rounds floated in the --bg void with no boundary, and prose
                  lines stretched to the full viewport width. min-height keeps
                  the frame spanning the whole scrollport for short sessions;
                  the box grows past it for long ones. */}
              <div
                style={{
                  width: '100%',
                  maxWidth: 1200,
                  margin: '0 auto',
                  minHeight: '100%',
                  boxSizing: 'border-box',
                  border: '1px solid var(--card-border)',
                  borderRadius: 10,
                  background: 'var(--bg-elev)',
                  padding: '14px 18px',
                }}
              >
                <SessionTranscript
                  turns={turns}
                  fileTruncated={fileTruncated}
                  date={selectedDate}
                  expandAll
                  onOpenTurn={idx => setSelectedTurnIdx(idx)}
                />
              </div>
            </div>
            {/* Sibling of the scroll layer, absolute against the fixed root. */}
            <BackToTop scrollRef={chatFullScrollRef} />
          </div>,
          document.body
        )}

      {exportTarget && (
        <ExportDialog
          session={exportTarget}
          onClose={() => setExportTarget(null)}
          onConfirm={(exclude, includeImages) => {
            const s = exportTarget;
            setExportTarget(null);
            handleExport(s, exclude, includeImages);
          }}
        />
      )}
    </div>
  );
};

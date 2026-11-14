import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { Archive, RefreshCw, Trash2, X, AlertTriangle, Download, Copy, Check, Braces, Combine, FileText, Maximize2, Minimize2, Scale, Zap, ArrowDownRight, ArrowUpRight, Wrench, Terminal, Send, CirclePlus } from 'lucide-react';
import { buildCurl, buildCurlPosix, buildReplaySpec } from '../lib/curl';
import {
  api,
  type CaptureStatus,
  type CaptureDateRow,
  type CaptureSessionRow,
  type CaptureFragmentRow,
  type CaptureEvent,
  type CaptureRequestView,
  type CaptureTurnIndexEntry,
  type CaptureReplayResult,
  type CaptureReplayStreamEvent,
  type ReplaySpec,
} from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Switch } from '../components/Switch';
import { Combobox } from '../components/Combobox';
import { Pagination } from '../components/Pagination';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';
import { shortId, decodeRate, formatRate, fmtDur, fmtLatency } from '../lib/format';
import { copyToClipboard } from '../lib/clipboard';
import { useSplitterWidth, VSplitter } from '../components/Splitter';
import { strToU8, zipSync } from 'fflate';
import { isDesktopShell } from '../lib/download';
import { startDownload, startGeneratedDownload } from '../lib/download-manager';
import { SessionTranscript } from '../components/SessionTranscript';
import { Prose } from '../components/Prose';
import { BackToTop } from '../components/BackToTop';
import { findMediaTokens, mergeSseToNonStream, parseAssistantResponse, unwrapHarnessText } from '../lib/transcript';
import { DEFAULT_MAX_BODY_BYTES } from '../lib/defaults';
import { useBackdropDismiss } from '../lib/useBackdropDismiss';

import { FONT_MONO } from '../lib/fonts';
/**
 * Best-effort completion-token extraction from a captured response wire body.
 * Non-streaming JSON carries usage once; streaming SSE repeats it, and the
 * LAST occurrence is the cumulative total for both Anthropic (message_delta)
 * and OpenAI (final usage chunk). Hex-encoded non-UTF-8 bodies are skipped.
 */
const COMPLETION_TOKENS_RE = /"(?:completion_tokens|output_tokens)"\s*:\s*(\d+)/g;
const completionTokensFrom = (event?: CaptureEvent): number | null => {
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
 * Per-request streaming timing per leg, capture domain — the SAME TTFT /
 * decode-TPS vocabulary the trace domain uses, measured at the wire: the
 * response event's firstByteTs splits the leg's cycle latency into
 * wait-for-first-token (TTFT) and decode phases. Null when the leg never
 * streamed (buffered exchange) or the events predate the stamp — the chip
 * then renders its latency only, never a synthesized rate.
 */
const legTiming = (
  request: CaptureRequestView,
  side: 'upstream' | 'gateway'
): { ttftMs?: number; rate: number | null } | null => {
  const genMs = side === 'upstream' ? request.upstreamGenMs : request.gatewayGenMs;
  if (genMs === undefined) return null;
  const resp = side === 'upstream' ? request.upstreamResponse : request.clientResponse;
  const ttftMs = side === 'upstream' ? request.upstreamTtftMs : request.gatewayTtftMs;
  const tokens = completionTokensFrom(resp);
  return { ttftMs, rate: tokens !== null && tokens > 0 ? decodeRate(tokens, genMs) : null };
};

/**
 * Timing segments for one leg's chip: `· TTFT 3.0s · 52 tok/s`, each part
 * optional. Labels use fmtLatency smart units (sub-second ms → s → m s); the
 * chip's tooltip carries the exact raw ms (legTimingTip) since labels turn.
 */
const legTimingText = (request: CaptureRequestView, side: 'upstream' | 'gateway'): string => {
  const tr = legTiming(request, side);
  if (!tr) return '';
  const ttft = tr.ttftMs !== undefined ? ` · TTFT ${fmtLatency(tr.ttftMs)}` : '';
  const rate = tr.rate !== null ? ` · ${formatRate(tr.rate)} tok/s` : '';
  return ttft + rate;
};

/** Raw-ms appendix for the timing chip's tooltip: `TTFT 3002 ms`; '' when the
 *  leg never streamed — the tooltip then stays the static timing gloss. */
const legTimingTip = (request: CaptureRequestView, side: 'upstream' | 'gateway'): string => {
  const tr = legTiming(request, side);
  return tr?.ttftMs !== undefined ? `TTFT ${tr.ttftMs} ms` : '';
};

/** Compact inline timing for TIMELINE ROWS: decode rate only. TTFT and the
 *  raw-ms details move to the chip tooltip so a two-leg row stays narrow —
 *  the drawer header keeps the full inline text (width is uncontested there). */
const legRateText = (request: CaptureRequestView, side: 'upstream' | 'gateway'): string => {
  const tr = legTiming(request, side);
  return tr?.rate != null ? ` · ${formatRate(tr.rate)} tok/s` : '';
};

// Left-rail splitter bounds + persistence (captures page session list).
const RAIL_MIN = 240;
const RAIL_MAX = 640;
const RAIL_DEFAULT = 320;
const RAIL_WIDTH_KEY = 'ocr.captures.railWidth';
const AUTO_REFRESH_KEY = 'ocr.captures.autoRefresh';
// Detail-pane tail poll cadence. Deliberately unhurried: the refresh is a
// quiet in-place request-list replace, not a loading state.
const AUTO_REFRESH_INTERVAL_MS = 3000;
// Requests per detail page (wire events for a request always travel together:
// 2-4 per request). Pages count BACK from the newest end and the pager
// summary therefore counts REQUESTS, never prompt turns — a turn can span
// page boundaries. 50 requests keeps the first paint cheap.
const PAGE_REQUESTS = 50;
// Conversation lens reads history in 100-request batches (turn openers only, see
// bodies=chat). Smaller = faster first turns; larger = fewer window regrowth
// passes over the archive.
const CHAT_PAGE = 100;
const PAGE_SIZE_OPTIONS = [20, 50, 100, 200];

// Inbound-protocol badge (backend CaptureSessionRow.protocol): i18n key +
// hue per surface. Semantic coloring: the conversation surfaces (chat /
// Anthropic / Responses) take the THEME ACCENT — primary human traffic
// (the palette defines no purple hue; a `--hue-purple` var would silently
// fall back to accent anyway, so it is written explicitly). The decision
// surface shares the blue family with the per-request decision chips — the
// hue this UI already uses for informational/system-metadata chips
// (⇢ proxy, circled-plus day-span). Legacy archives without request lines
// stay unbadged.
const PROTOCOL_LABEL: Record<NonNullable<CaptureSessionRow['protocol']>, string> = {
  chat: 'captures.protocolChat',
  anthropic: 'captures.protocolAnthropic',
  responses: 'captures.protocolResponses',
  systemone: 'captures.protocolDecision',
};
const PROTOCOL_HUE: Record<NonNullable<CaptureSessionRow['protocol']>, { bg: string; fg: string }> = {
  chat: { bg: 'color-mix(in srgb, var(--accent) 12%, transparent)', fg: 'var(--accent)' },
  anthropic: { bg: 'color-mix(in srgb, var(--accent) 12%, transparent)', fg: 'var(--accent)' },
  responses: { bg: 'color-mix(in srgb, var(--accent) 12%, transparent)', fg: 'var(--accent)' },
  systemone: { bg: 'var(--hue-blue-soft)', fg: 'var(--hue-blue)' },
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/** Local YYYY-MM-DD of a request ts — the archive shard it physically landed in. */
function fmtDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Loading skeleton for the session pane — shimmer rows so a click gives
 *  instant structural feedback instead of a silent wait on the fetch. */
const RequestsSkeleton: React.FC<{ chat?: boolean }> = ({ chat }) => {
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
 * fallback for non-secure contexts), a JSON pretty/raw toggle offered only
 * when the content actually parses as JSON, and two reading aids for
 * completion responses — a merge view (streamed chunks folded into the
 * equivalent NON-STREAM response body) and a parsed render of the final
 * text (thinking / answer / tool calls). Defaults to RAW — this is a wire
 * capture, so the bytes as actually sent/received are the source of truth;
 * everything beyond that is an opt-in reading aid.
 */
export function JsonBlock({ value }: { value: unknown }) {
  const { t } = useI18n();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [formatted, setFormatted] = useState(false);
  // Non-wire view modes. 'merged' folds a streamed SSE body into the
  // equivalent non-stream response; 'parsed' renders the semantic final
  // text. Both are self-scoping: a toggle renders only when the wire text
  // qualifies (merged: SSE of a recognized completion dialect; parsed:
  // parses as a completion response via the transcript parser — headers
  // and request payloads never do), and an active mode silently falls
  // back to the wire view when the next body does not qualify.
  const [mode, setMode] = useState<'wire' | 'merged' | 'parsed'>('wire');
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
  const parsed = useMemo(() => (rawText ? parseAssistantResponse(rawText) : null), [rawText]);
  const merged = useMemo(() => (rawText ? mergeSseToNonStream(rawText) : null), [rawText]);
  const mergedText = useMemo(() => (merged ? JSON.stringify(merged, null, 2) : null), [merged]);
  // Plain-text form of the parsed view — what the copy button grabs.
  const parsedText = useMemo(() => {
    if (!parsed) return '';
    const sections: string[] = [];
    if (parsed.reasoning) sections.push(`[${t('captures.msgThinking')}]\n${parsed.reasoning}`);
    if (parsed.text) sections.push(parsed.text);
    for (const c of parsed.toolCalls)
      sections.push(`[${t('captures.toolCallLabel')}${c.name ? ` · ${c.name}` : ''}]\n${c.args}`);
    return sections.join('\n\n');
  }, [parsed, t]);

  if (value === undefined || value === null) return null;
  const text = formatted && pretty !== null ? pretty : rawText;
  const showMerged = mode === 'merged' && merged !== null;
  const showParsed = mode === 'parsed' && parsed !== null;
  const copyTarget = showParsed
    ? parsedText
    : showMerged && mergedText !== null
      ? mergedText
      : text;

  const handleCopy = async () => {
    const ok = await copyToClipboard(copyTarget);
    if (!ok) {
      toast.error(t('common.failed'));
      return;
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
    fontSize: 'var(--text-xs)',
    padding: '3px 8px',
    cursor: 'pointer',
    fontFamily: FONT_MONO,
  };
  const preStyle: React.CSSProperties = {
    margin: 0,
    padding: '12px 14px',
    background: 'var(--well-bg)',
    border: '1px solid var(--card-border)',
    borderRadius: '6px',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--leading-normal)',
    // Without this the UA default monospace (Courier New on Windows)
    // renders the JSON — match the standard chain used elsewhere here.
    fontFamily: FONT_MONO,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };
  // Section label rows above the parsed view's Prose blocks — the Prose
  // blocks own the collapse/expand; these only name the section.
  const sectionLabelStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 'var(--text-xs)',
    fontWeight: 'var(--font-bold)',
    color: 'var(--text-dim)',
    margin: '0 0 3px',
    letterSpacing: 'var(--tracking-label)',
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginBottom: 4 }}>
        {merged !== null && (
          <button
            style={{ ...btnStyle, color: showMerged ? 'var(--accent)' : 'var(--text-dim)' }}
            onClick={() => setMode(m => (m === 'merged' ? 'wire' : 'merged'))}
            title={t('captures.mergeHint')}
          >
            <Combine size={12} />
            {t('captures.merge')}
          </button>
        )}
        {parsed !== null && (
          <button
            style={{ ...btnStyle, color: showParsed ? 'var(--accent)' : 'var(--text-dim)' }}
            onClick={() => setMode(m => (m === 'parsed' ? 'wire' : 'parsed'))}
            title={t('captures.parseRenderHint')}
          >
            <FileText size={12} />
            {t('captures.parseRender')}
          </button>
        )}
        {pretty !== null && !showMerged && !showParsed && (
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
      {showMerged ? (
        <pre style={preStyle}>{mergedText}</pre>
      ) : showParsed && parsed ? (
        <>
          {parsed.reasoning && (
            <div style={{ marginBottom: 10 }}>
              <div style={sectionLabelStyle}>{t('captures.msgThinking')}</div>
              <Prose text={parsed.reasoning} clamp={8} color="var(--text-muted)" mono={false} />
            </div>
          )}
          {parsed.text && (
            <div style={{ marginBottom: parsed.toolCalls.length ? 10 : 0 }}>
              <Prose text={parsed.text} markdown clamp={8} viewTitle={t('captures.msgAssistant')} />
            </div>
          )}
          {parsed.toolCalls.map((c, i) => (
            <div key={i} style={{ marginBottom: i < parsed.toolCalls.length - 1 ? 10 : 0 }}>
              <div style={sectionLabelStyle}>
                <span className="badge badge-amber">
                  <Wrench size={9} style={{ flexShrink: 0 }} />
                  {t('captures.toolCallLabel')}
                </span>
                {c.name ? <span style={{ fontFamily: FONT_MONO }}>{c.name}</span> : null}
              </div>
              <Prose text={c.args} clamp={4} />
            </div>
          ))}
        </>
      ) : (
        <pre style={preStyle}>{text}</pre>
      )}
    </div>
  );
}

/**
 * One drawer tab = one PHASE of one EXCHANGE. The key is `exchangeId:phase`,
 * so every failover attempt / decision leg gets its own tab instead of
 * overwriting a fixed six-slot view (ADR-0024 `exchanges[]`).
 */
type DrawerTab = string;
/** Which leg the drawer should land on when opened from a timeline badge. */
type DrawerTabPreset = 'decision';

const TAB_LABEL_KEY: Record<string, string> = {
  'client:request': 'tabClientRequest',
  'client:response': 'tabClientResponse',
  'upstream:request': 'tabUpstreamRequest',
  'upstream:response': 'tabUpstreamResponse',
  'decision:request': 'tabDecisionRequest',
  'decision:response': 'tabDecisionResponse',
};

/**
 * Right-side detail drawer for one captured request (portal, Esc/overlay close).
 * Tabs keep the three bodies (inbound request / upstream request / response)
 * focused instead of one long scroll — the upstream tab is where you land only
 * when debugging compression/wire behavior, so it defaults to the inbound view.
 * With metadata-first list reads the drawer shell paints instantly and the
 * full wire bodies stream in via the per-request fetch (`loading`); `outOfWindow`
 * marks a request archived beyond the read window (bodies unrecoverable).
 */
const CaptureDrawer: React.FC<{
  request: CaptureRequestView;
  /** Request sequence number from the list metadata (readRequest may omit it). */
  requestNumber?: number;
  /** Full wire bodies are being fetched for this request. */
  loading?: boolean;
  /** Request's bodies fall outside the read window (long archive, tail kept). */
  outOfWindow?: boolean;
  /** Leg to land on when opened from a timeline badge (the decision layer's
   *  first exchange); defaults to the first tab = the inbound request. */
  initialTab?: DrawerTabPreset;
  onClose: () => void;
}> = ({ request, requestNumber, loading, outOfWindow, initialTab, onClose }) => {
  const { t } = useI18n();
  const focusBackdrop = useBackdropDismiss(onClose);
  const toast = useToast();
  const [tab, setTab] = useState<DrawerTab>('');
  useBodyScrollLock(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // One tab per phase of EVERY exchange, in wire order. `attempt > 1`
  // labels failover / retry hops so no leg is ever last-write-wins.
  const tabs = useMemo(() => {
    const out: {
      key: DrawerTab;
      label: string;
      ev?: CaptureEvent;
      leg: string;
      phase: 'request' | 'response';
    }[] = [];
    for (const ex of request.exchanges ?? []) {
      for (const phase of ['request', 'response'] as const) {
        const base = t(`captures.${TAB_LABEL_KEY[`${ex.leg}:${phase}`] ?? 'tabClientRequest'}`);
        out.push({
          key: `${ex.exchangeId}:${phase}`,
          label: ex.attempt > 1 ? `${base} #${ex.attempt}` : base,
          ev: ex[phase],
          leg: ex.leg,
          phase,
        });
      }
    }
    return out;
  }, [request.exchanges, t]);

  useEffect(() => {
    const wanted = initialTab === 'decision'
      ? tabs.find(x => x.leg === 'decision' && x.phase === 'request')?.key
      : undefined;
    setTab(wanted ?? tabs[0]?.key ?? '');
    // Keyed by the gateway request id: one request = one drawer, independent
    // of any caller-supplied correlation value.
  }, [request.requestId, initialTab, tabs]);

  const active = tabs.find(x => x.key === tab) ?? tabs[0];

  // The single timestamp the drawer shows in the header: pick the EARLIEST
  // event ts (client-request fires synchronously, upstream events may
  // arrive later — earliest is the request's t0).
  const headerTs = request.clientRequest?.ts
    ?? request.upstreamRequest?.ts
    ?? request.clientResponse?.ts
    ?? request.upstreamResponse?.ts;
  const hasError = request.error || active?.ev?.status === 'error';
  // Application attribution: any event of the request carries the same client
  // API-key identity (id + name only) once it is attached at capture time.
  const turnKey =
    request.clientRequest?.apiKey ??
    request.clientResponse?.apiKey ??
    request.upstreamRequest?.apiKey ??
    request.upstreamResponse?.apiKey;

  return createPortal(
    <div
      {...focusBackdrop}
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
          <span className={`badge ${hasError ? 'badge-danger' : 'badge-success'}`}>
            {hasError ? t('captures.statusError') : t('captures.statusOk')}
          </span>
          {request.turnIndex !== null && (
            <span
              className="badge"
              title={t('captures.turnSeqHint')}
              style={{ background: 'var(--chip-bg)', color: 'var(--text-muted)', fontFamily: FONT_MONO }}
            >
              {t('captures.turnOrdinal', { n: request.turnIndex })}
            </span>
          )}
          {requestNumber !== undefined && (
            <span
              className="badge"
              title={t('captures.requestSeqHint')}
              style={{ background: 'var(--chip-bg)', color: 'var(--text-dim)', fontFamily: FONT_MONO }}
            >
              #{requestNumber}
            </span>
          )}
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
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', fontFamily: FONT_MONO }}>
              {new Date(headerTs).toLocaleString()}
            </span>
          )}
          {/* RequestId — copy-on-click in the drawer header (kept out of the
              list rows: machine bookkeeping, rarely read inline). */}
          <span
            title={request.requestId}
            onClick={async () => {
              const ok = await copyToClipboard(request.requestId);
              if (ok) toast.success(t('captures.copied'));
              else toast.error(t('common.failed'));
            }}
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--text-dim)',
              fontFamily: FONT_MONO,
              cursor: 'copy',
            }}
          >
            {shortId(request.requestId)}
          </span>
          {/* Caller correlation id — the OTHER half of the identity pair
              (ADR-0021). Shown only when the caller supplied one and it
              differs from the gateway id; the `←` reads "this came from the
              client", so a row can be joined to the caller's own logs. */}
          {request.clientRequestId && request.clientRequestId !== request.requestId && (
            <span
              title={t('captures.clientRequestId')}
              onClick={async () => {
                const ok = await copyToClipboard(request.clientRequestId!);
                if (ok) toast.success(t('captures.copied'));
                else toast.error(t('common.failed'));
              }}
              style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--text-dim)',
                fontFamily: FONT_MONO,
                cursor: 'copy',
              }}
            >
              ← {shortId(request.clientRequestId)}
            </span>
          )}
          <span
            style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', fontFamily: FONT_MONO }}
            title={t('captures.inboundModel')}
          >
            {request.model}
          </span>
          {/* Upstream model actually executed (from the upstream exchange
              events) — shown as `inbound → upstream` when known and
              different, e.g. `auto → gpt-4o`. */}
          {(() => {
            const upstreamModel = request.upstreamRequest?.model ?? request.upstreamResponse?.model;
            if (!upstreamModel || upstreamModel === request.model) return null;
            return (
              <span
                style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', fontFamily: FONT_MONO }}
                title={t('captures.outboundModel')}
              >
                → {upstreamModel}
              </span>
            );
          })()}
          {/* Proxy badge — visible without opening the upstream tab. */}
          {request.upstreamRequest?.proxy && (
            <span
              className="badge"
              title={`${t('captures.viaProxy')}: ${request.upstreamRequest.proxy}`}
              style={{
                background: 'var(--hue-blue-soft)',
                color: 'var(--hue-blue)',
                fontFamily: FONT_MONO,
                fontSize: 'var(--text-2xs)',
              }}
            >
              ⇢ {request.upstreamRequest.proxy}
            </span>
          )}
          {/* Per-direction latency: gateway = client cycle, upstream =
              upstream cycle. Missing when one side never fired. */}
          {request.gatewayLatencyMs !== undefined && (
            <span
              title={`${t('captures.gatewayLatency')} · ${request.gatewayLatencyMs} ms`}
              style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', fontFamily: FONT_MONO }}
            >
              <ArrowDownRight size={12} strokeWidth={2.75} style={{ verticalAlign: '-1px', color: 'var(--text-main)' }} /> {fmtLatency(request.gatewayLatencyMs)}
              <span title={[t('captures.timingTip'), legTimingTip(request, 'gateway')].filter(Boolean).join(' · ')}>
                {legTimingText(request, 'gateway')}
              </span>
            </span>
          )}
          {request.upstreamLatencyMs !== undefined && (
            <span
              title={`${t('captures.upstreamLatency')} · ${request.upstreamLatencyMs} ms`}
              style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', fontFamily: FONT_MONO }}
            >
              <ArrowUpRight size={12} strokeWidth={2.75} style={{ verticalAlign: '-1px', color: 'var(--text-main)' }} /> {fmtLatency(request.upstreamLatencyMs)}
              <span title={[t('captures.timingTip'), legTimingTip(request, 'upstream')].filter(Boolean).join(' · ')}>
                {legTimingText(request, 'upstream')}
              </span>
            </span>
          )}
          {/* L2 decision layer leg badge: latency chip + the decision layer model, so the two
              upstream calls of one request are distinguishable at a glance. */}
          {request.decisionRequest && (
            <span
              className="badge"
              title={`${t('captures.decisionBadge')} · ${request.decisionRequest.model}${request.decisionLatencyMs !== undefined ? ` · ${request.decisionLatencyMs} ms` : ''}`}
              style={{
                background: 'var(--hue-blue-soft)',
                color: 'var(--hue-blue)',
                fontFamily: FONT_MONO,
                fontSize: 'var(--text-2xs)',
              }}
            >
              <Scale size={10} style={{ verticalAlign: '-1px', marginRight: '3px' }} />
              {t('captures.decisionBadge')}
              {request.decisionLatencyMs !== undefined && ` · ${fmtLatency(request.decisionLatencyMs)}`}
              {request.decisionRequest.model !== request.model && ` · ${request.decisionRequest.model}`}
            </span>
          )}
          <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label={t('common.close')}>
            <X size={14} />
          </button>
        </div>

        {/* Request prompt summary — anchors the drawer to its conversation request
            (the full text lives inside the clientRequest tab's wire JSON,
            far too buried for at-a-glance context). Hover shows the full
            summary; click copies it. Hidden when the request has no prompt. */}
        {request.promptSummary && (
          <div
            title={request.promptSummary}
            onClick={async () => {
              const ok = await copyToClipboard(request.promptSummary!);
              if (ok) toast.success(t('sessions.copiedPrompt'));
              else toast.error(t('sessions.copyFailed'));
            }}
            style={{
              padding: '6px 16px 10px',
              borderBottom: '1px solid var(--divider)',
              fontSize: 'var(--text-sm)',
              lineHeight: 'var(--leading-snug)',
              color: 'var(--text-muted)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              cursor: 'copy',
            }}
          >
            {request.promptSummary}
          </div>
        )}

        {/* Error banner */}
        {request.error && (
          <div
            style={{
              margin: '12px 16px 0',
              padding: '10px 12px',
              borderRadius: '6px',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              color: '#ef4444',
              fontSize: 'var(--text-sm)',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <AlertTriangle size={14} />
            <span>{request.error}</span>
          </div>
        )}

        {/* Tabs — one per exchange phase, including every failover hop */}
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
                  fontSize: 'var(--text-sm)',
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
                      fontSize: 'var(--text-xs)',
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
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>
              <RefreshCw size={14} style={{ animation: 'ocr-spin 0.8s linear infinite', verticalAlign: '-2px', marginRight: 6 }} />
              {t('captures.requestLoading')}
            </div>
          ) : !active?.ev ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>
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
                    fontSize: 'var(--text-xs)',
                    color: 'var(--accent-amber)',
                    padding: '0 0 10px',
                  }}
                >
                  <AlertTriangle size={12} />
                  <span>{t('captures.requestOutOfRange')}</span>
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
                    fontSize: 'var(--text-xs)',
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
const WireBlock: React.FC<{ event: CaptureEvent }> = ({ event }) => {
  const { t } = useI18n();
  const toast = useToast();
  const isResponse = event.phase === 'response';
  const [curlCopied, setCurlCopied] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [replay, setReplay] = useState<CaptureReplayResult | null>(null);
  const [replaySpec, setReplaySpec] = useState<ReplaySpec | null>(null);
  const statusLine = isResponse
    ? event.wire.responseLine || `HTTP/1.1 ${event.wire.status} ${event.wire.status === 0 ? 'NETWORK_ERROR' : ''}`.trim()
    : event.wire.requestLine;
  // One-click replay command for the request side (client leg replays
  // against this gateway, upstream leg against the provider); null when the
  // wire cannot be reconstructed (response side, hex body).
  const curl = isResponse ? null : buildCurl(event);
  const copyCurl = async () => {
    if (!curl) return;
    const ok = await copyToClipboard(curl);
    if (!ok) {
      toast.error(t('common.failed'));
      return;
    }
    setCurlCopied(true);
    toast.success(t('chat.curlCopied'));
    setTimeout(() => setCurlCopied(false), 1500);
  };

  const runReplay = async () => {
    const spec = buildReplaySpec(event);
    if (!spec || replaying) return;
    setReplaySpec(spec);
    // Open the dialog immediately in loading state; the body then fills in
    // chunk by chunk as the upstream stream arrives.
    setReplay({ status: 'loading' });
    setReplaying(true);
    const t0 = Date.now();
    let statusLine = '';
    let headers: Record<string, string> = {};
    let body = '';
    let truncated = false;
    let ttfbMs = 0;
    const flush = () => setReplay({ status: 'ok', statusLine, headers, body, truncated, ttfbMs, totalMs: Date.now() - t0 });
    try {
      await api.replayCaptureRequest(spec, (evt: CaptureReplayStreamEvent) => {
        if (evt.type === 'status') {
          statusLine = evt.statusLine;
          headers = evt.headers;
          ttfbMs = Date.now() - t0;
          flush();
        } else if (evt.type === 'chunk') {
          body += evt.text;
          flush();
        } else if (evt.type === 'end') {
          truncated = evt.truncated;
          flush();
        } else {
          setReplay({ status: 'error', message: evt.message });
          toast.error(evt.message);
        }
      });
    } catch (err: any) {
      const message = err?.message || t('captures.replayFailed');
      setReplay({ status: 'error', message });
      toast.error(message);
    } finally {
      setReplaying(false);
    }
  };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontFamily: FONT_MONO }}>
          {isResponse ? '← status line' : '→ request line'}
        </span>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {curl && (
            <button
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                background: 'var(--chip-bg)', border: '1px solid var(--card-border)',
                borderRadius: '4px', color: curlCopied ? 'var(--accent)' : 'var(--text-dim)',
                fontSize: 'var(--text-xs)', padding: '3px 8px', cursor: 'pointer', fontFamily: FONT_MONO,
              }}
              onClick={copyCurl}
              title={t('chat.copyCurl')}
            >
              {curlCopied ? <Check size={12} /> : <Terminal size={12} />}
              {curlCopied ? t('chat.curlCopied') : t('chat.copyCurl')}
            </button>
          )}
          {!isResponse && event.direction === 'upstream' && (
            <button
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                background: 'var(--chip-bg)', border: '1px solid var(--card-border)',
                borderRadius: '4px', color: replaying ? 'var(--accent)' : 'var(--text-dim)',
                fontSize: 'var(--text-xs)', padding: '3px 8px', cursor: 'pointer', fontFamily: FONT_MONO,
                opacity: replaying ? 0.6 : 1,
              }}
              onClick={() => void runReplay()}
              disabled={replaying}
              title={t('captures.replayHint')}
            >
              <Send size={12} />
              {replaying ? t('captures.replaying') : t('captures.replay')}
            </button>
          )}
        </div>
      </div>
      <pre
        style={{
          margin: 0,
          padding: '10px 12px',
          background: 'var(--well-bg)',
          border: '1px solid var(--card-border)',
          borderRadius: '6px',
          fontSize: 'var(--text-sm)',
          fontFamily: FONT_MONO,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: 'var(--text-main)',
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
            fontSize: 'var(--text-xs)',
            color: 'var(--text-dim)',
            fontFamily: FONT_MONO,
          }}
        >
          ⇢ {t('captures.viaProxy')}: {event.proxy}
        </div>
      )}
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', margin: '14px 0 6px', fontFamily: FONT_MONO }}>
        {isResponse ? '← response headers' : '→ request headers'}
      </div>
      <JsonBlock value={isResponse ? event.wire.responseHeaders : event.wire.requestHeaders} />
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', margin: '14px 0 6px', fontFamily: FONT_MONO }}>
        {isResponse ? '← response body' : '→ request body'}
      </div>
      <JsonBlock value={isResponse ? event.wire.responseBody : event.wire.requestBody} />
      {replay && replaySpec && createPortal(
        <ReplayResultDialog
          result={replay}
          curlPosix={buildCurlPosix(replaySpec)}
          onClose={() => setReplay(null)}
          onReplay={() => void runReplay()}
          busy={replaying}
        />,
        document.body
      )}
    </div>
  );
};

/**
 * Replay result modal: the one-shot upstream replay's response (status line,
 * headers, body) in an isolated dialog — the wire block behind stays
 * untouched, so re-runs never pollute the captured record view.
 */
const ReplayResultDialog: React.FC<{
  result: CaptureReplayResult;
  curlPosix: string;
  onClose: () => void;
  onReplay: () => void;
  busy: boolean;
}> = ({ result, curlPosix, onClose, onReplay, busy }) => {
  const { t } = useI18n();
  const toast = useToast();
  const backdrop = useBackdropDismiss(onClose);
  useBodyScrollLock(true);
  // Live elapsed clock while the stream is running; frozen at the final
  // totalMs once the stream ends.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const start = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Date.now() - start), 100);
    return () => clearInterval(id);
  }, [busy]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div
      {...backdrop}
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
          maxWidth: 720,
          maxHeight: '85vh',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
          animation: 'ocr-pop-in 0.18s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Send size={16} color="var(--accent)" />
          <span style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--font-bold)' }}>{t('captures.replayResult')}</span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
            <button
              className="btn btn-sm"
              onClick={onReplay}
              disabled={busy}
              title={t('captures.replayHint')}
            >
              <Send size={12} />
              <span>{busy ? t('captures.replaying') : t('captures.replay')}</span>
            </button>
            <button
              className="btn btn-sm"
              onClick={async () => {
                const ok = await copyToClipboard(curlPosix);
                if (ok) toast.success(t('chat.curlCopied'));
                else toast.error(t('chat.curlFailed'));
              }}
              title={t('captures.replayCopyCurlPosix')}
            >
              <Terminal size={12} />
              <span>cURL</span>
            </button>
            <button className="btn btn-sm" onClick={onClose} title={t('common.close')}>
              <X size={12} />
              <span>{t('common.close')}</span>
            </button>
          </span>
        </div>
        {result.status === 'ok' && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontFamily: FONT_MONO }}>
            {t('captures.replayTiming', { ttfb: result.ttfbMs, total: result.totalMs })}
          </div>
        )}
        {busy && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontFamily: FONT_MONO }}>
            {t('captures.replayElapsed', { ms: elapsed })}
          </div>
        )}
        <div style={{ overflow: 'auto', minHeight: 0 }}>
          {result.status === 'loading' ? (
            <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>
              <RefreshCw size={16} style={{ animation: 'ocr-spin 0.8s linear infinite', verticalAlign: '-3px', marginRight: 8 }} />
              {t('captures.replaying')}
            </div>
          ) : result.status === 'error' ? (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--accent-rose)', fontFamily: FONT_MONO, padding: '8px 12px', background: 'var(--well-bg)', border: '1px solid var(--card-border)', borderRadius: '6px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {result.message}
            </div>
          ) : (
            <>
              <pre
                style={{
                  margin: 0,
                  padding: '10px 12px',
                  background: 'var(--well-bg)',
                  border: '1px solid var(--card-border)',
                  borderRadius: '6px',
                  fontSize: 'var(--text-sm)',
                  fontFamily: FONT_MONO,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'var(--text-main)',
                }}
              >
                {result.statusLine}
              </pre>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', margin: '10px 0 6px', fontFamily: FONT_MONO }}>
                {t('captures.replayRespHeaders')}
              </div>
              <JsonBlock value={result.headers} />
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', margin: '10px 0 6px', fontFamily: FONT_MONO }}>
                {t('captures.replayRespBody')}
              </div>
              <JsonBlock value={result.body + (result.truncated ? '\n…' : '')} />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
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
  const rawBackdrop = useBackdropDismiss(onClose);
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
      {...rawBackdrop}
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
          <span style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--font-bold)' }}>{t('captures.exportOptionsTitle')}</span>
        </div>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 'var(--text-xs)',
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
                fontSize: 'var(--text-md)',
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
            fontSize: 'var(--text-md)',
            cursor: 'pointer',
            paddingTop: 2,
            borderTop: '1px dashed var(--card-border)',
          }}
        >
          <span>{t('captures.exportIncludeImages')}</span>
          <Switch checked={withImages} onChange={setWithImages} ariaLabel={t('captures.exportIncludeImages')} />
        </label>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
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
  const [requests, setTurns] = useState<CaptureRequestView[]>([]);
  const [, setEvents] = useState<CaptureEvent[]>([]);
  // Read-window totals, kept as SEPARATE units: `windowRequests` counts
  // REQUESTS (the pager's unit), `windowTurns` counts DISTINCT write-time
  // `turnIndex` values. Raw event lines are neither.
  const [windowRequests, setWindowRequests] = useState(0);
  const [windowTurns, setWindowTurns] = useState(0);
  const [fileTruncated, setFileTruncated] = useState(false);
  // Backward paging in REQUESTS: `page` is 1-based from the NEWEST end; the
  // backend answers the clamped page plus how many request pages the read
  // window holds. The tail poll only runs on page 1 — off page 1 the reader
  // is browsing history, and a newer request landing would shift every page
  // boundary.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_REQUESTS);
  // EXACT whole-archive summary: request count (header denominator + pager
  // total) and the user-prompt turn index for the selector. Display-only,
  // fetched once per selection, keyed by the immutable `turnIndex`.
  const [exactRequests, setExactRequests] = useState<number | null>(null);
  const [turnIndexEntries, setTurnIndexEntries] = useState<CaptureTurnIndexEntry[]>([]);
  // Turn selection by write-time `turnIndex` (null = all turns).
  const [focusTurn, setFocusTurn] = useState<number | null>(null);
  // Cross-midnight stitching: per-SHARD fragments ((date, file) pairs) the
  // displayed timeline was merged from (empty = single-archive session). A
  // conversation regrouped via conversationKey can span MANY files within
  // ONE date — fragments.length is a shard count, never a date count.
  const [fragments, setFragments] = useState<CaptureFragmentRow[]>([]);
  const [selectedRequestIdx, setSelectedRequestIdx] = useState<number | null>(null);
  // Tab the drawer should land on ("decisionRequest" when opened from the
  // decision badge); reset to undefined when the selection changes.
  const [initialDrawerTab, setInitialDrawerTab] = useState<DrawerTabPreset | undefined>(undefined);
  const openRequest = (idx: number, tab?: DrawerTabPreset) => {
    setInitialDrawerTab(tab);
    setSelectedRequestIdx(idx);
  };
  // Main-pane view mode: wire timeline (default) or the reconstructed
  // conversation replay. Always starts on the timeline — the chat lens
  // parses + renders every turn, so it should cost nothing until the
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
  // Metadata-first reads: the request list loads WITHOUT wire bodies (instant
  // paint); `bodiesLoaded` marks that the current `requests` carry the full
  // bodies (conversation lens / explicit full read). Drawer bodies are
  // fetched per request and cached per session (fetchedRequestsRef).
  const [bodiesLoaded, setBodiesLoaded] = useState(false);
  // Conversation lens: `requests` holds the WHOLE conversation (metadata + turn
  // opener request bodies + response bodies), accumulated newest→oldest.
  // Timeline requests are one page; chat requests are absolute-numbered and must be
  // swapped back when the lens returns to the timeline.
  const [chatLoaded, setChatLoaded] = useState(false);
  // The date/file pair the rendered `requests` were loaded for — a date-chip
  // click updates the live selection one render BEFORE the requests are
  // replaced, so per-request fetches must target this pair, not the live one.
  const [loadedFor, setLoadedFor] = useState<{ date: string; file: string }>({ date: '', file: '' });
  // Left-rail list: in-flight marker + monotonic read sequence — while a
  // date's list is loading the rail shows skeleton rows, never the stale
  // previous date's list nor a premature "no archives" empty state.
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const sessionsSeqRef = useRef(0);
  const [drawerRequest, setDrawerTurn] = useState<CaptureRequestView | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerMiss, setDrawerMiss] = useState(false);
  // Monotonic read sequence: a newer selection supersedes an in-flight read
  // (fast A→B clicks must never let A's late response clobber B's).
  const loadSeqRef = useRef(0);
  const fetchedRequestsRef = useRef(new Map<string, CaptureRequestView>());
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

  // Exact-tally cache key (`date/file`): the count endpoint scans the whole
  // archive, so a lens upgrade or refresh must not re-scan the same archive.
  const countedForRef = useRef('');
  // Header values belong to that archive; switching sessions must blank them
  // before the new summary resolves instead of showing the old tallies.
  const headerForRef = useRef('');

  const loadRecords = useCallback(
    async (date: string, file: string, wantBodies = false, wantedPage = 1, size = PAGE_REQUESTS): Promise<boolean> => {
      const seq = ++loadSeqRef.current;
      fetchedRequestsRef.current.clear();
      setDrawerTurn(null);
      setDrawerLoading(false);
      setDrawerMiss(false);
      setSelectedRequestIdx(null);
      setBodiesLoaded(false);
      setFocusTurn(null);
      // Immediate feedback: the previous session's rows drop right away and a
      // skeleton takes over — a click never waits silently on the fetch. The
      // metadata-first read (no wire bodies) keeps that wait to KBs.
      setTurns([]);
      setEvents([]);
      const headerKey = `${date}/${file}`;
      if (headerForRef.current !== headerKey) {
        headerForRef.current = '';
        setWindowRequests(0);
        setWindowTurns(0);
        setExactRequests(null);
        setTurnIndexEntries([]);
        setFragments([]);
        setFileTruncated(false);
      }
      if (!date || !file) {
        // Supersedes any in-flight read — its seq-guarded finally must not be
        // the one to clear `loading`, so clear it here or a deselect while a
        // load is in flight would stick the skeleton on forever.
        if (seq === loadSeqRef.current) setLoading(false);
        return false;
      }
      setLoading(true);
      setLoadedFor({ date, file });
      setPage(wantedPage);
      setPageSize(size);
      try {
        const res = await api.getCaptureEvents(date, file, size, wantBodies ? 'full' : 'none', true, wantedPage);
        if (seq !== loadSeqRef.current) return false; // superseded by a newer selection
        setTurns([...res.requests].reverse());
        setChatLoaded(false);
        setEvents(res.events);
        setWindowRequests(res.totalRequests);
        setWindowTurns(res.totalTurns);
        setFileTruncated(res.fileTruncated);
        setFragments(res.fragments ?? []);
        setBodiesLoaded(wantBodies);
        setPage(res.page);
      } catch (err) {
        console.error(err);
        return false; // the explicit refresh buttons are the retry path
      } finally {
        if (seq === loadSeqRef.current) setLoading(false);
      }
      // EXACT summary: the events read only knows the read window. This scan
      // yields the request denominator AND every prompt turn in the archive,
      // so the selector lists all turns on page 1 too. Display-only, after
      // paint; a stale answer for a superseded selection is dropped by seq.
      const key = `${date}/${file}`;
      if (countedForRef.current === key && headerForRef.current === key) return true;
      countedForRef.current = key;
      setExactRequests(null); // never show the previous archive's summary
      setTurnIndexEntries([]);
      try {
        const summary = await api.getCaptureSummary(date, file);
        if (seq === loadSeqRef.current && summary) {
          setExactRequests(summary.requests);
          setTurnIndexEntries(summary.turns);
          headerForRef.current = key;
        } else if (seq === loadSeqRef.current) {
          // Unavailable: let the next load retry instead of caching the miss.
          countedForRef.current = '';
        }
      } catch {
        if (seq === loadSeqRef.current) countedForRef.current = '';
        /* the header falls back to the window count */
      }
      return seq === loadSeqRef.current;
    },
    []
  );

  /** Page change: same archive, same lens state, different window slice. */
  const goToPage = useCallback(
    (next: number) => {
      if (!loadedFor.date || !loadedFor.file) return;
      loadRecords(loadedFor.date, loadedFor.file, bodiesLoaded || mainView === 'chat', next, pageSize);
    },
    [loadedFor, bodiesLoaded, mainView, pageSize, loadRecords]
  );

  /**
   * Conversation lens: load the WHOLE conversation, newest page first.
   * `bodies=chat` keeps only turn-opener request bodies + response bodies
   * (the replay accounts for every prompt without carrying multi-MB
   * continuation bodies). Each page's window grows, so request numbers are
   * re-anchored to the exact archive totals after every batch; turn numbers
   * come from the same summary index the selector uses.
   */
  const loadChatHistory = useCallback(
    async (date: string, file: string) => {
      if (!date || !file) {
        setTurns([]);
        setEvents([]);
        setLoading(false);
        setBodiesLoaded(false);
        setChatLoaded(false);
        return;
      }
      const seq = ++loadSeqRef.current;
      setLoading(true);
      setTurns([]);
      setEvents([]);
      setBodiesLoaded(false);
      setChatLoaded(false);
      setFocusTurn(null);
      setFileTruncated(false);
      const headerKey = `${date}/${file}`;
      if (headerForRef.current !== headerKey) {
        headerForRef.current = '';
        setWindowRequests(0);
        setWindowTurns(0);
        setExactRequests(null);
        setTurnIndexEntries([]);
        setFragments([]);
      }
      setLoadedFor({ date, file });
      setPage(1);
      try {
        const summary = await api.getCaptureSummary(date, file);
        if (seq !== loadSeqRef.current) return;
        countedForRef.current = `${date}/${file}`;
        if (summary) {
          headerForRef.current = `${date}/${file}`;
          setExactRequests(summary.requests);
          setTurnIndexEntries(summary.turns);
        }
        const acc: CaptureRequestView[] = [];
        const seen = new Set<string>();
        let archiveRequests = summary?.requests ?? null;
        let p = 1;
        let totalPages = 1;
        do {
          const res = await api.getCaptureEvents(date, file, CHAT_PAGE, 'chat', true, p);
          if (seq !== loadSeqRef.current) return;
          for (const t of res.requests.slice().reverse()) {
            const key = t.requestId;
            if (seen.has(key)) continue;
            seen.add(key);
            acc.push(t);
          }
          setFileTruncated(res.fileTruncated);
          setWindowRequests(res.totalRequests);
          setWindowTurns(res.totalTurns);
          // The walk's LAST window covers the whole conversation, so its count
          // is the archive total when the exact summary was unavailable.
          archiveRequests = res.totalRequests;
          totalPages = res.totalPages;
          p++;
        } while (p <= totalPages);
        // Re-anchor numbering ONCE after the walk: every page read grew the
        // window, so earlier pages' numbers are window-relative and stale, but
        // committing per page would make the transcript re-parse the whole
        // conversation once per page (it memoizes on the `requests` identity).
        let n = archiveRequests ?? 0;
        for (const t of acc) {
          if (!t.clientRequest) {
            delete t.requestNumber;
            continue;
          }
          // Absolute REQUEST ordinal only. Turn membership is the immutable
          // write-time `turnIndex` on the object — never re-derived here.
          t.requestNumber = n--;
        }
        setTurns(acc.slice());
        setChatLoaded(true);
        setLoading(false);
      } catch (err) {
        if (seq !== loadSeqRef.current) return;
        console.error(err);
        setLoading(false);
        toast.error(t('captures.loadFailed'));
      }
    },
    [toast, t]
  );

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
    // Lens switch / session switch is an explicit load:
    //   timeline → one metadata page (cheap, pager owns older history);
    //   chat     → the WHOLE conversation in bodies=chat batches (all turns).
    if (mainView === 'chat') loadChatHistory(selectedDate, selectedFile);
    else loadRecords(selectedDate, selectedFile, false, 1, pageSize);
    // Lens switch owns the initial fetch (and a `pageSize` change re-fires it
    // with the new size), so the pager only stores the choice — calling
    // loadRecords here as well issued two identical archive reads.
  }, [mainView, selectedDate, selectedFile, pageSize, loadChatHistory, loadRecords]);

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

  // Drawer bodies: metadata-first requests carry no wire bodies — fetch the
  // full request on open (cached per session so re-opening is instant). With
  // bodies already loaded (conversation lens) the local request is used as-is.
  useEffect(() => {
    if (selectedRequestIdx === null) {
      setDrawerTurn(null);
      setDrawerMiss(false);
      return;
    }
    const meta = requests[selectedRequestIdx];
    if (!meta) return;
    // The rendered requests belong to `loadedFor`, not necessarily to the live
    // selection — a date-chip click updates selectedDate a render before the
    // requests are replaced. Fetching against the live selection here would ask
    // the WRONG archive for bodies; wait until the load lands.
    if (loadedFor.date !== selectedDate || loadedFor.file !== selectedFile) return;
    if (bodiesLoaded) {
      setDrawerTurn(meta);
      setDrawerMiss(false);
      return;
    }
    const key = meta.requestId;
    const cached = fetchedRequestsRef.current.get(key);
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
      .getCaptureRequest(loadedFor.date, loadedFor.file, key)
      .then(res => {
        if (!alive) return;
        if (res) {
          fetchedRequestsRef.current.set(key, res);
          setDrawerTurn(res);
        } else {
          // Request archived beyond the read window — render the metadata-only
          // request plus an explanation instead of a silent blank.
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
  }, [selectedRequestIdx, requests, bodiesLoaded, loadedFor, selectedDate, selectedFile]);

  /**
   * Quiet tail refresh for the auto-poll: same request as the session-level
   * refresh button, but never disturbs the reader — no skeleton, no selection
   * reset, no loading flag. Skipped entirely while a request drawer is open, a
   * focused turn is active, a read is already in flight, the tab is hidden,
   * no archive is selected, or the reader is on an OLDER page (page 1 no
   * longer owns the list — a newer request landing would shift every page
   * boundary under them; the manual refresh buttons reset to the newest
   * page). On failure it stays silent — the next tick and the refresh
   * buttons are the retry paths.
   */
  const autoStateRef = useRef({
    loading,
    selectedRequestIdx,
    selectedDate,
    selectedFile,
    bodiesLoaded,
    chatLoaded,
    page,
    pageSize,
    focusTurn,
  });
  autoStateRef.current = {
    chatLoaded,
    loading,
    selectedRequestIdx,
    selectedDate,
    selectedFile,
    bodiesLoaded,
    page,
    pageSize,
    focusTurn,
  };
  const tailRefreshSeqRef = useRef(0);
  const tailRefresh = useCallback(async () => {
    const st = autoStateRef.current;
    if (!st.selectedFile || st.loading || st.selectedRequestIdx !== null || document.hidden || st.chatLoaded) return;
    if (st.page !== 1) return;
    // A focused turn is anchored to absolute request numbers; a new request
    // landing at the head would shift the array slice it maps onto.
    if (st.focusTurn !== null) return;
    const seq = ++tailRefreshSeqRef.current;
    try {
      const res = await api.getCaptureEvents(
        st.selectedDate,
        st.selectedFile,
        st.pageSize,
        st.bodiesLoaded ? 'full' : 'none'
      );
      if (seq !== tailRefreshSeqRef.current) return;
      // The user may have switched archives mid-flight — the late response
      // must not clobber the new selection's requests.
      const cur = autoStateRef.current;
      if (cur.selectedDate !== st.selectedDate || cur.selectedFile !== st.selectedFile) return;
      // A drawer opened while this tick was in flight — a new request landing at
      // the head shifts row indices and the drawer would silently re-resolve
      // to a different request. Skip rather than disturb the reader.
      if (cur.selectedRequestIdx !== null) return;
      if (cur.page !== 1) return;
      setTurns([...res.requests].reverse());
      setEvents(res.events);
      setWindowRequests(res.totalRequests);
      setWindowTurns(res.totalTurns);
      setFileTruncated(res.fileTruncated);
      setFragments(res.fragments ?? []);
      setBodiesLoaded(st.bodiesLoaded);
      setPage(res.page);
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
    // An explicit refresh must recount: the summary is cached per archive key,
    // so without this the header's exact requests/turns never grow after new
    // requests arrive (the window tally would update while the header stayed old).
    countedForRef.current = '';
    try {
      await loadStatus();
      await loadSessions(selectedDate, apiKeyFilter);
      // The conversation lens re-reads the whole conversation (it has no pager).
      if (selectedFile) {
        if (mainView === 'chat') await loadChatHistory(selectedDate, selectedFile);
        else await loadRecords(selectedDate, selectedFile, false, page, pageSize);
      }
    } finally {
      setRefreshing(false);
    }
  }, [loadStatus, loadSessions, loadRecords, loadChatHistory, selectedDate, apiKeyFilter, selectedFile, mainView, page, pageSize]);

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
    const jsonlName = `capture-${selectedDate}-${s.sessionId}.jsonl`;
    const zipName = jsonlName.replace(/\.jsonl$/, '.zip');
    const url = api.captureArchiveUrl(selectedDate, s.file, exclude.length ? exclude : undefined);

    if (!includeImages) {
      const result = await startDownload({ url, name: jsonlName, fallbackName: jsonlName });
      if (result.ok) {
        if (!isDesktopShell()) toast.success(t('captures.exported'));
      } else if (!result.canceled) {
        toast.error(result.error ?? t('common.failed'));
      }
      return;
    }

    // ZIP mode: the JSONL plus every offloaded payload it references
    // (deduped by sha). A media fetch failure skips that one file — the
    // archive text still exports complete with its [MEDIA …] placeholders.
    const result = await startGeneratedDownload(zipName, async (report, signal) => {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const entries: Record<string, Uint8Array> = { [jsonlName]: strToU8(text) };
      const wanted = new Set<string>();
      for (const m of findMediaTokens(text)) if (m.file) wanted.add(m.sha256);
      let loaded = 0;
      for (const sha of wanted) {
        try {
          const media = await fetch(`/api/admin/capture/${selectedDate}/media/${sha}`, { signal });
          if (!media.ok) continue;
          const token = findMediaTokens(text).find(x => x.sha256 === sha && x.file);
          const name = token?.file?.replace(/^media\//, '') ?? sha;
          const bytes = new Uint8Array(await media.arrayBuffer());
          entries[`media/${name}`] = bytes;
          loaded += bytes.byteLength;
          report(loaded, null);
        } catch {
          // fail-open per file, same doctrine as the recorder.
        }
      }
      return new Blob([zipSync(entries)], { type: 'application/zip' });
    });
    if (result.ok) {
      if (!isDesktopShell()) toast.success(t('captures.exported'));
    } else if (!result.canceled) {
      toast.error(result.error ?? t('common.failed'));
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
          setSelectedRequestIdx(null);
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

  // Header summary: sum of per-request gateway latency over the loaded tail
  // window. Idle gaps between requests are deliberately excluded — in long
  // client sessions the wall-clock span is dominated by think time.
  const totalLatencyMs = useMemo(() => {
    let sum = 0;
    for (const request of requests) sum += request.gatewayLatencyMs ?? request.upstreamLatencyMs ?? 0;
    return sum;
  }, [requests]);

  // Distinct DATE count of the stitched fragments. The day-span badge and the
  // dividers speak DATES, not shard files — same-day session-id churn merges
  // multiple files (conversationKey join) without crossing midnight, so the
  // raw fragment count would read as a bogus day count.
  const fragmentDates = useMemo(() => new Set(fragments.map(f => f.date)).size, [fragments]);

  // The backend numbers requests inside the READ WINDOW; the window is always
  // the conversation's newest tail, so the exact archive tally gives the
  // offset that requests `requestNumber` into a stable, conversation-wide
  // sequence. Chat requests are already re-anchored while accumulating, so their
  // offset is zero. Display-only — paging itself still walks the window.
  const requestOffset = chatLoaded ? 0 : exactRequests !== null ? Math.max(0, exactRequests - windowRequests) : 0;

  // Prompt turns come from the WHOLE-archive index, so the selector lists
  // every turn on every page. Focusing one maps its absolute request range
  // onto the loaded page; turns are contiguous, so the match is a slice
  // (newest row first — the same order as `requests`).
  // Focusing is a filter on the WRITE-TIME `turnIndex` — no absolute request
  // arithmetic, no binary search, no window-relative round numbers.
  const focusRange = useMemo(() => {
    if (focusTurn === null) return null;
    let startIdx = -1;
    let endIdx = -1;
    for (let i = 0; i < requests.length; i++) {
      if (requests[i].turnIndex !== focusTurn) continue;
      if (startIdx < 0) startIdx = i;
      endIdx = i;
    }
    return startIdx >= 0 ? { startIdx, endIdx } : null;
  }, [requests, focusTurn]);
  const shownRequests = useMemo(
    () => (focusRange ? requests.slice(focusRange.startIdx, focusRange.endIdx + 1) : requests),
    [requests, focusRange]
  );
  // Selector options: ALL prompt turns, newest first, keyed by their
  // immutable write-time ordinal. Built from the whole-archive index.
  // Selector options: ALL prompt turns, newest first. A turn can span pages,
  // so this list is built from the archive index, never from page metadata.
  const turnOptions = useMemo(
    () =>
      [...turnIndexEntries].reverse().map(r => {
        const prompt = r.prompt || t('captures.turnNoPrompt');
        const label = [
          t('captures.turnOrdinal', { n: r.turnIndex }),
          t('captures.turnRequests', { n: r.requests }),
          prompt.length > 48 ? `${prompt.slice(0, 48)}…` : prompt,
        ]
          .filter(Boolean)
          .join(' · ');
        return { value: String(r.turnIndex), label };
      }),
    [turnIndexEntries, t]
  );
  /**
   * Pick a prompt turn. The conversation lens already holds the whole
   * conversation, so it only narrows in place. The timeline lens pages: the
   * turn's NEWEST request determines the page, and focus is applied after the
   * page arrives because loadRecords clears it at the start of a read.
   */
  const selectTurn = useCallback(
    (v: string) => {
      if (!v) {
        setFocusTurn(null);
        return;
      }
      const ordinal = Number(v);
      const turn = turnIndexEntries.find(r => r.turnIndex === ordinal);
      if (!turn || !loadedFor.date || !loadedFor.file) {
        setFocusTurn(Number.isFinite(ordinal) ? ordinal : null);
        return;
      }
      if (mainView === 'chat') {
        setFocusTurn(ordinal);
        return;
      }
      const total = exactRequests ?? windowRequests;
      const target = total > 0 ? Math.max(1, Math.ceil((total - turn.lastRequest + 1) / pageSize)) : 1;
      if (target === page) {
        setFocusTurn(ordinal);
        return;
      }
      void loadRecords(
        loadedFor.date,
        loadedFor.file,
        bodiesLoaded,
        target,
        pageSize
      ).then(landed => {
        // A superseded read resolves false — never apply this turn's focus to
        // the archive the operator has since switched to.
        if (landed) setFocusTurn(ordinal);
      });
    },
    [turnIndexEntries, loadedFor, exactRequests, windowRequests, pageSize, page, bodiesLoaded, mainView, loadRecords]
  );

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
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
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
        <div style={{ padding: '12px 14px', fontSize: 'var(--text-sm)' }}>
          {status?.enabled && (
            <div style={{ color: 'var(--text-dim)', marginBottom: '10px' }}>{t('captures.hotHint')}</div>
          )}
          {status && !status.enabled && (
            <div style={{ color: 'var(--text-dim)', lineHeight: 'var(--leading-loose)' }}>
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

      {/* Browser: date chips on top → session list (left) + timeline (right).
          Always rendered — the toggle only controls RECORDING; existing
          archives stay browsable/exportable/deletable while capture is off. */}
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
            <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>
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
                      style={{ width: '100%', fontSize: 'var(--text-sm)', padding: '6px 10px' }}
                    />
                    <Combobox
                      value={apiKeyFilter}
                      onChange={setApiKeyFilter}
                      options={[
                        { value: '', label: t('captures.apiKeyAll') },
                        ...apiKeyOptions.map(k => ({ value: k.id, label: k.name })),
                      ]}
                      style={{ width: '100%', fontSize: 'var(--text-sm)', padding: '6px 10px', marginTop: 6 }}
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
                        fontSize: 'var(--text-sm)',
                        lineHeight: 'var(--leading-tight)',
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
                          Last-request status dot: emerald = ok, red = error,
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
                            fontWeight: 'var(--font-semibold)',
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
                            fontSize: 'var(--text-xs)',
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
                        {s.protocol && (
                          <span
                            title={t('captures.protocolTip', { protocol: t(PROTOCOL_LABEL[s.protocol]) })}
                            style={{
                              fontSize: 'var(--text-2xs)',
                              lineHeight: 'var(--leading-14)',
                              padding: '1px 6px',
                              borderRadius: '4px',
                              background: PROTOCOL_HUE[s.protocol].bg,
                              color: PROTOCOL_HUE[s.protocol].fg,
                              fontWeight: 'var(--font-semibold)',
                              flexShrink: 0,
                            }}
                          >
                            {t(PROTOCOL_LABEL[s.protocol])}
                          </span>
                        )}
                        {s.preview && (
                          <span
                            style={{
                              // The id is the row's only flexible cell: it
                              // claims the leftover width so the trailing
                              // chip column is anchored to the right edge.
                              // Without the grow the chips split the free
                              // space with the hover-action slot and drift
                              // into the middle of the row.
                              flex: 1,
                              fontFamily: FONT_MONO,
                              fontSize: 'var(--text-xs)',
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
                        {/* Trailing metadata chips pinned right: the app tag +
                            day-span badge align into a column across rows —
                            the id span above grows into the freed width, so
                            these chips never drift and never leave a gap on
                            the right. */}
                        <span
                          style={{
                            marginLeft: 'auto',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            flexShrink: 0,
                          }}
                        >
                          {s.apiKeys && s.apiKeys.length > 0 && (
                            <span
                              title={t('captures.apiKeyTooltip', { name: s.apiKeys[0].name, id: s.apiKeys[0].id })}
                              style={{
                                fontSize: 'var(--text-2xs)',
                                lineHeight: 'var(--leading-14)',
                                padding: '1px 6px',
                                borderRadius: '4px',
                                background: 'color-mix(in srgb, var(--accent-emerald) 10%, transparent)',
                                border: '1px solid color-mix(in srgb, var(--accent-emerald) 25%, transparent)',
                                color: 'var(--accent-emerald)',
                                flexShrink: 0,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                minWidth: 0,
                              }}
                            >
                              {/* Name capped, never width-fixed: short names
                                  ("默认") stay compact, long ones ellipsize at
                                  120px — the +N count and the full name (tooltip)
                                  always survive. */}
                              <span
                                style={{
                                  maxWidth: 120,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {s.apiKeys[0].name}
                              </span>
                              {s.apiKeys.length > 1 ? ` +${s.apiKeys.length - 1}` : ''}
                            </span>
                          )}
                          {s.spanDates && s.spanDates.length > 1 && (
                            <span
                              title={t('captures.spansDays', { n: s.spanDates.length })}
                              style={{
                                fontSize: 'var(--text-2xs)',
                                lineHeight: 'var(--leading-14)',
                                padding: '1px 6px',
                                borderRadius: '4px',
                                background: 'var(--hue-blue-soft)',
                                color: 'var(--hue-blue)',
                                flexShrink: 0,
                                // inline-flex so the token icon centres on the
                                // badge box, not on the text's ink: U+2295 sat
                                // ~1.5px low because its circle is anchored to
                                // the math axis and dips below the baseline.
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '3px',
                              }}
                            >
                              <CirclePlus size={10} aria-hidden />
                              {s.spanDates.length}d
                              {/* This shard is NOT the conversation's opening day
                                  (spanDates is newest-first, last = earliest). */}
                              {selectedDate !== s.spanDates[s.spanDates.length - 1] && (
                                <span style={{ opacity: 0.75 }}>· {t('captures.continuedFrom')}</span>
                              )}
                            </span>
                          )}
                        </span>
                        {/* Hover-revealed actions ride directly after the
                            chip column. The chips carry the row's ONE auto
                            spacer — a second marginLeft:auto here split the
                            free space in half, parking the chips mid-row
                            with a dead gap on the right. */}
                        <span
                          className="capture-card-actions"
                          style={{
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
                    <div style={{ padding: '8px 10px', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
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
                    <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>
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
                          // Header and pager are FIXED around the scrolling
                          // list; only the list may absorb the height loss.
                          flexShrink: 0,
                        }}
                      >
                        <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--font-semibold)' }}>{t('captures.detailTitle')}</span>
                        <span
                          title={
                            t('captures.requestsCountHint', {
                              shown: shownRequests.length,
                              total: exactRequests ?? windowRequests,
                            }) +
                            '\n' +
                            t('captures.turnsCountHint', {
                              turns: turnIndexEntries.length > 0 ? turnIndexEntries.length : windowTurns,
                            })
                          }
                          style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}
                        >
                          {selectedFile.replace(/\.jsonl$/, '')} · {exactRequests ?? '…'}{' '}
                          {t('captures.requestsUnit')} ·{' '}
                          {turnIndexEntries.length > 0
                            ? turnIndexEntries.length
                            : exactRequests === null
                              ? '…'
                              : windowTurns}{' '}
                          {t('captures.turnsUnit')}
                        </span>
                        {fragmentDates > 1 && (
                          <span
                            title={
                              t('captures.stitchedHint', { n: fragmentDates }) +
                              (fragments.length > fragmentDates
                                ? `\n${t('captures.stitchedFiles', { n: fragments.length })}`
                                : '')
                            }
                            style={{
                              fontSize: 'var(--text-2xs)',
                              lineHeight: 'var(--leading-16)',
                              padding: '0 6px',
                              borderRadius: '4px',
                              background: 'var(--hue-blue-soft)',
                              color: 'var(--hue-blue)',
                              // Same inline-flex box as the rail badge: the
                              // icon centres on the chip, never on the text
                              // ink (see the row badge above).
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '3px',
                              flexShrink: 0,
                            }}
                          >
                            <CirclePlus size={10} aria-hidden />
                            {fragmentDates}d
                          </span>
                        )}
                        {totalLatencyMs > 0 && (
                          <span
                            title={t('captures.totalTimeHint', { n: requests.length })}
                            style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}
                          >
                            · {t('captures.totalTime')} {fmtDur(totalLatencyMs)}
                          </span>
                        )}
                      </div>
                      {/* Timeline toolbar: turn filter + lens/actions. A
                          dedicated row keeps the session-identity header clean
                          and stops the selector from being pushed onto an
                          unpredictable second line at narrow widths. */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '8px 16px',
                          borderBottom: '1px solid var(--divider)',
                          flexWrap: 'wrap',
                          flexShrink: 0,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 'var(--text-2xs)',
                            color: 'var(--text-dim)',
                            flexShrink: 0,
                            textTransform: 'uppercase',
                            letterSpacing: '0.04em',
                          }}
                        >
                          {t('captures.turnsUnit')}
                        </span>
                        {/* Prompt-turn navigator: one user prompt plus every
                            request it drove. Options come from the WHOLE
                            archive index, so page 1 lists all turns; picking
                            one loads the page holding its newest request and
                            narrows the rows, "全部轮次" restores them. */}
                        <Combobox
                          value={focusTurn === null ? '' : String(focusTurn)}
                          onChange={selectTurn}
                          options={[{ value: '', label: t('captures.turnAll') }, ...turnOptions]}
                          panelMinWidth={420}
                          style={{ width: 340, maxWidth: '100%', flexShrink: 1, fontSize: 'var(--text-sm)', padding: '5px 10px' }}
                        />
                        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          {/* View lens: raw-wire request timeline vs reconstructed conversation replay. */}
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
                                  fontSize: 'var(--text-sm)',
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
                              while the request drawer is open (see tailRefresh). */}
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
                          {/* Session-level refresh: re-read the CURRENT page
                              (cheap), vs the header button that reloads
                              status + dates + session list too. */}
                          <button
                            className="btn btn-sm"
                            onClick={() =>
                              mainView === 'chat'
                                ? void loadChatHistory(selectedDate, selectedFile)
                                : goToPage(page)
                            }
                            disabled={loading}
                            title={t('captures.refreshRequestsHint')}
                          >
                            <RefreshCw size={12} style={loading ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined} />
                            <span>{t('captures.refresh')}</span>
                          </button>
                        </div>
                      </div>
                      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 16px 14px' }}>
                        {loading && requests.length === 0 ? (
                          <RequestsSkeleton chat={mainView === 'chat'} />
                        ) : mainView === 'chat' ? (
                          // Conversation replay carries NO pager: loadChatHistory
                          // loads the WHOLE conversation in bodies=chat batches,
                          // and this component renders its turns progressively.
                          // A page cut would slice a turn in half, so all turns
                          // are present and the turn selector narrows in place.
                          <SessionTranscript
                            requests={shownRequests}
                            fileTruncated={fileTruncated}
                            date={selectedDate}
                            onOpenRequest={i => openRequest(focusRange ? focusRange.startIdx + i : i)}
                          />
                        ) : (
                        <>
                        {fileTruncated && (
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              fontSize: 'var(--text-xs)',
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
                          {shownRequests.length === 0 && (
                            <div style={{ padding: '18px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>
                              {t('captures.emptyRecords')}
                            </div>
                          )}
                          {shownRequests.map((request, i) => {
                            // Global index into the page's `requests` — the drawer
                            // contract. Focus mode renders a slice, so the row
                            // index must be re-anchored to the turn's start.
                            const idx = focusRange ? focusRange.startIdx + i : i;
                            const turnStart = request.clientRequest?.ts
                              ?? request.upstreamRequest?.ts
                              ?? request.clientResponse?.ts
                              ?? request.upstreamResponse?.ts
                              ?? request.decisionRequest?.ts;
                            const errEvent = request.upstreamResponse?.status === 'error'
                              || request.clientResponse?.status === 'error'
                              || !!request.error;
                            // Day divider: only when the stitched timeline
                            // actually spans multiple DATES — shard-file
                            // churn within one date adds no dividers.
                            // Requests render newest-first, so compare with the
                            // NEXT request (later in wall time).
                            const multiDay = fragmentDates > 1;
                            const prevTurn = shownRequests[i - 1];
                            const prevStart = prevTurn
                              ? (prevTurn.clientRequest?.ts
                                ?? prevTurn.upstreamRequest?.ts
                                ?? prevTurn.clientResponse?.ts
                                ?? prevTurn.upstreamResponse?.ts
                                ?? prevTurn.decisionRequest?.ts)
                              : undefined;
                            const dayChanged =
                              multiDay &&
                              turnStart !== undefined &&
                              (prevStart === undefined || fmtDay(prevStart) !== fmtDay(turnStart));
                            return (
                              <React.Fragment key={request.requestId}>
                                {dayChanged && (
                                  <div
                                    style={{
                                      position: 'relative',
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 8,
                                      margin: '8px 0 4px',
                                      color: 'var(--text-dim)',
                                      fontSize: 'var(--text-xs)',
                                      fontFamily: FONT_MONO,
                                    }}
                                  >
                                    <span style={{ flex: 1, height: 1, background: 'var(--card-border)' }} />
                                    <span>{fmtDay(turnStart)}</span>
                                    <span style={{ flex: 1, height: 1, background: 'var(--card-border)' }} />
                                  </div>
                                )}
                              <div
                                onClick={() => openRequest(idx)}
                                style={{
                                  position: 'relative',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '10px',
                                  padding: '7px 10px',
                                  marginBottom: '2px',
                                  borderRadius: '6px',
                                  cursor: 'pointer',
                                  fontSize: 'var(--text-sm)',
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
                                  className={`badge ${errEvent ? 'badge-danger' : 'badge-success'}`}
                                  style={{ flexShrink: 0 }}
                                >
                                  {errEvent ? t('captures.statusError') : t('captures.statusOk')}
                                </span>
                                {/* TWO axes, never conflated: the WRITE-TIME
                                    `turnIndex` (one user prompt + every request
                                    it drove) and `requestNumber` (every client
                                    request, tool-loop continuations included). */}
                                {(() => {
                                  const turnOrdinal = request.turnIndex ?? undefined;
                                  return turnOrdinal !== undefined ? (
                                    <span
                                      className="badge"
                                      title={t('captures.turnSeqHint')}
                                      style={{
                                        flexShrink: 0,
                                        background: 'var(--chip-bg)',
                                        color: 'var(--text-muted)',
                                        fontFamily: FONT_MONO,
                                        fontSize: 'var(--text-2xs)',
                                      }}
                                    >
                                      {t('captures.turnOrdinal', { n: turnOrdinal })}
                                    </span>
                                  ) : null;
                                })()}
                                {request.requestNumber !== undefined && (
                                  <span
                                    className="badge"
                                    title={t('captures.requestSeqHint')}
                                    style={{
                                      flexShrink: 0,
                                      background: 'var(--chip-bg)',
                                      color: 'var(--text-dim)',
                                      fontFamily: FONT_MONO,
                                      fontSize: 'var(--text-2xs)',
                                    }}
                                  >
                                    #{request.requestNumber + requestOffset}
                                  </span>
                                )}
                                {/* Model: `inbound → upstream` renders only when the
                                    upstream id differs BEYOND a mechanical provider-prefix
                                    strip (`ark/x → x` is the same model — noise inline);
                                    the full pair stays in the tooltip. Width-capped and
                                    ellipsized so a long ref never starves the prompt or
                                    the timing chips. */}
                                {(() => {
                                  const upstreamModel = request.upstreamRequest?.model ?? request.upstreamResponse?.model;
                                  const prefixStripOnly =
                                    !!upstreamModel &&
                                    upstreamModel !== request.model &&
                                    request.model.endsWith(`/${upstreamModel}`);
                                  const showUpstream =
                                    !!upstreamModel && upstreamModel !== request.model && !prefixStripOnly;
                                  return (
                                    <span
                                      title={upstreamModel && upstreamModel !== request.model ? `${request.model} → ${upstreamModel}` : request.model}
                                      style={{
                                        fontWeight: 'var(--font-semibold)',
                                        flexShrink: 0,
                                        maxWidth: 240,
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                      }}
                                    >
                                      {request.model}
                                      {showUpstream && (
                                        <span style={{ fontWeight: 'var(--font-regular)', color: 'var(--text-dim)' }}>
                                          {' '}→ {upstreamModel}
                                        </span>
                                      )}
                                    </span>
                                  );
                                })()}
                                {/* Request prompt — the LAST user message, stamped on
                                    the client-request event at write time so
                                    metadata-only reads render it. No-prompt requests
                                    (tool-result continuations) render a bare dim
                                    wrench; the tooltip carries the explanation. */}
                                <span
                                  title={request.promptSummary || t('sessions.promptFallbackTip')}
                                  style={{
                                    flex: 1,
                                    minWidth: 0,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    color: request.promptSummary ? 'var(--text-muted)' : 'var(--text-dim)',
                                  }}
                                >
                                  {request.promptSummary ? (
                                    request.promptSummary
                                  ) : (
                                    <Wrench size={10} style={{ flexShrink: 0 }} />
                                  )}
                                </span>
                                {request.upstreamRequest?.proxy && (
                                  <span
                                    className="badge"
                                    title={`${t('captures.viaProxy')}: ${request.upstreamRequest.proxy}`}
                                    style={{
                                      background: 'var(--hue-blue-soft)',
                                      color: 'var(--hue-blue)',
                                      fontFamily: FONT_MONO,
                                      fontSize: 'var(--text-2xs)',
                                      flexShrink: 0,
                                    }}
                                  >
                                    ⇢ proxy
                                  </span>
                                )}
                                {/* Compact leg chips: latency + decode rate inline; TTFT,
                                    raw ms and the timing gloss move to the tooltip so a
                                    two-leg row stays narrow. */}
                                {request.gatewayLatencyMs !== undefined && (
                                  <span
                                    title={[
                                      `${t('captures.gatewayLatency')} · ${request.gatewayLatencyMs} ms`,
                                      legTimingTip(request, 'gateway'),
                                      t('captures.timingTip'),
                                    ].filter(Boolean).join('\n')}
                                    style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontFamily: FONT_MONO, flexShrink: 0 }}
                                  >
                                    <ArrowDownRight size={11} strokeWidth={2.75} style={{ verticalAlign: '-1px', color: 'var(--text-main)' }} /> {fmtLatency(request.gatewayLatencyMs)}{legRateText(request, 'gateway')}
                                  </span>
                                )}
                                {request.upstreamLatencyMs !== undefined && (
                                  <span
                                    title={[
                                      `${t('captures.upstreamLatency')} · ${request.upstreamLatencyMs} ms`,
                                      legTimingTip(request, 'upstream'),
                                      t('captures.timingTip'),
                                    ].filter(Boolean).join('\n')}
                                    style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontFamily: FONT_MONO, flexShrink: 0 }}
                                  >
                                    <ArrowUpRight size={11} strokeWidth={2.75} style={{ verticalAlign: '-1px', color: 'var(--text-main)' }} /> {fmtLatency(request.upstreamLatencyMs)}{legRateText(request, 'upstream')}
                                  </span>
                                )}
                                {/* L2 decision layer leg: one compact badge — latency inline,
                                    model + explanation in the tooltip. Click opens
                                    the drawer's decision tabs (full wire). */}
                                {request.decisionRequest && (
                                  <span
                                    className="badge"
                                    onClick={() => openRequest(idx, 'decision')}
                                    title={`${t('captures.decisionBadge')} · ${request.decisionRequest.model}${request.decisionLatencyMs !== undefined ? ` · ${request.decisionLatencyMs} ms` : ''} · ${t('captures.decisionHint')}`}
                                    style={{
                                      background: 'var(--hue-blue-soft)',
                                      color: 'var(--hue-blue)',
                                      fontFamily: FONT_MONO,
                                      fontSize: 'var(--text-2xs)',
                                      flexShrink: 0,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    <Scale size={10} style={{ verticalAlign: '-1px', marginRight: '3px' }} />
                                    {request.decisionLatencyMs !== undefined ? fmtLatency(request.decisionLatencyMs) : t('captures.decisionBadge')}
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
                      {/* Page bar — a FIXED footer of the detail pane, outside
                          the scrolling list, so the pager never scrolls away
                          with the rows (same layout as /models). Timeline lens
                          only: the conversation replay renders turns
                          progressively and has no pager. Pages count REQUESTS
                          BACK from the newest end, so `total` is the read
                          window's request count — the header additionally
                          shows the archive-wide exact request tally and the
                          window's user-prompt turn count. Off page 1 the tail
                          poll pauses (page boundaries would shift under the
                          reader). */}
                      {mainView === 'timeline' && requests.length > 0 && (
                        <div
                          style={{
                            flexShrink: 0,
                            padding: '0 16px 10px',
                            borderTop: '1px solid var(--divider)',
                            background: 'var(--card-bg)',
                          }}
                        >
                          <Pagination
                            page={page}
                            pageSize={pageSize}
                            total={exactRequests ?? windowRequests}
                            onChange={goToPage}
                            disabled={loading}
                            showSummary
                            summaryUnit={t('captures.requestsUnit')}
                            newestFirst
                            pageSizeOptions={PAGE_SIZE_OPTIONS}
                            onPageSizeChange={size => setPageSize(size)}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

      {selectedRequestIdx !== null && requests[selectedRequestIdx] && (
        <CaptureDrawer
          request={drawerRequest ?? requests[selectedRequestIdx]}
          requestNumber={
            requests[selectedRequestIdx]?.requestNumber !== undefined
              ? requests[selectedRequestIdx].requestNumber + requestOffset
              : undefined
          }
          loading={drawerLoading}
          outOfWindow={drawerMiss}
          initialTab={initialDrawerTab}
          onClose={() => setSelectedRequestIdx(null)}
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
              <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--font-bold)' }}>{t('captures.viewChat')}</span>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 'var(--text-xs)',
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
                  turns floated in the --bg void with no boundary, and prose
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
                  requests={shownRequests}
                  fileTruncated={fileTruncated}
                  date={selectedDate}
                  expandAll
                  onOpenRequest={i => openRequest(focusRange ? focusRange.startIdx + i : i)}
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

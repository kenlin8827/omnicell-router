import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { Archive, RefreshCw, Trash2, X, AlertTriangle, Download, Search, Copy, Check, Braces } from 'lucide-react';
import {
  api,
  type CaptureStatus,
  type CaptureDateRow,
  type CaptureSessionRow,
  type HttpExchangeEvent,
  type CaptureTurn,
} from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';
import { Switch } from '../components/Switch';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';
import { copyToClipboard, shortId } from '../lib/format';
import { useSplitterWidth, VSplitter } from '../components/Splitter';

// Left-rail splitter bounds + persistence (captures page session list).
const RAIL_MIN = 240;
const RAIL_MAX = 640;
const RAIL_DEFAULT = 320;
const RAIL_WIDTH_KEY = 'ocr.captures.railWidth';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

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
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid var(--card-border)',
    borderRadius: '4px',
    color: 'var(--text-dim)',
    fontSize: '11px',
    padding: '3px 8px',
    cursor: 'pointer',
    fontFamily: 'JetBrains Mono, monospace',
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
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid var(--card-border)',
          borderRadius: '6px',
          fontSize: '11px',
          lineHeight: 1.55,
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

type DrawerTab = 'clientRequest' | 'gatewayResponse' | 'upstreamRequest' | 'upstreamResponse';

/**
 * Right-side detail drawer for one captured turn (portal, Esc/overlay close).
 * Tabs keep the three bodies (inbound request / upstream request / response)
 * focused instead of one long scroll — the upstream tab is where you land only
 * when debugging compression/wire behavior, so it defaults to the inbound view.
 */
const CaptureDrawer: React.FC<{
  turn: CaptureTurn;
  onClose: () => void;
}> = ({ turn, onClose }) => {
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
    setTab('clientRequest');
    // Keyed by the client-request event id, not the traceId: a client that
    // reuses one traceId produces multiple turns sharing it.
  }, [turn.clientRequest?.id ?? turn.traceId]);

  // 4 wire-side tabs, one per HTTP exchange phase. The naming is symmetric:
  // direction (client | upstream) × phase (request | response) — the same
  // shape as the W3C / OpenTelemetry span model. Clicking a tab shows the
  // full wire dump (request line + headers + body OR response line + headers
  // + body) of that side. Empty tab = the corresponding exchange never
  // fired (e.g. gateway-response is missing when the gateway times out
  // before sending a reply).
  const tabs: { key: DrawerTab; label: string; ev?: HttpExchangeEvent }[] = [
    { key: 'clientRequest',    label: t('captures.tabClientRequest'),    ev: turn.clientRequest },
    { key: 'gatewayResponse',  label: t('captures.tabGatewayResponse'),  ev: turn.gatewayResponse },
    { key: 'upstreamRequest',  label: t('captures.tabUpstreamRequest'),  ev: turn.upstreamRequest },
    { key: 'upstreamResponse', label: t('captures.tabUpstreamResponse'), ev: turn.upstreamResponse },
  ];
  const active = tabs.find(x => x.key === tab)!;

  // The single timestamp the drawer shows in the header: pick the EARLIEST
  // event ts (client-request fires synchronously, upstream events may
  // arrive later — earliest is the turn's t0).
  const headerTs = turn.clientRequest?.ts
    ?? turn.upstreamRequest?.ts
    ?? turn.gatewayResponse?.ts
    ?? turn.upstreamResponse?.ts;
  const hasError = turn.error || active.ev?.status === 'error';

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 210,
        background: 'rgba(0, 0, 0, 0.75)',
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
            borderBottom: '1px solid var(--card-border)',
            flexWrap: 'wrap',
          }}
        >
          <span
            className="badge"
            style={
              hasError
                ? { background: 'rgba(239,68,68,0.12)', color: '#ef4444' }
                : { background: 'rgba(16,185,129,0.12)', color: 'var(--accent-emerald)' }
            }
          >
            {hasError ? t('captures.statusError') : t('captures.statusOk')}
          </span>
          {headerTs !== undefined && (
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
              {new Date(headerTs).toLocaleString()}
            </span>
          )}
          <span
            style={{ fontSize: '12px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}
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
                style={{ fontSize: '12px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}
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
                background: 'rgba(59,130,246,0.12)',
                color: '#60a5fa',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '10px',
              }}
            >
              ⇢ {turn.upstreamRequest.proxy}
            </span>
          )}
          {/* TraceId — the linkable key for joining this turn
              across capture events and the trace record. Head-truncated
              display; full value in tooltip, click copies it. */}
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
              fontFamily: 'JetBrains Mono, monospace',
              background: 'rgba(255,255,255,0.04)',
              padding: '2px 6px',
              borderRadius: '4px',
              cursor: 'copy',
            }}
          >
            trace:{shortId(turn.traceId)}
          </span>
          {/* Per-direction latency: gateway = client cycle, upstream =
              upstream cycle. Missing when one side never fired. */}
          {turn.gatewayLatencyMs !== undefined && (
            <span
              title={t('captures.gatewayLatency')}
              style={{ fontSize: '12px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}
            >
              ↳ {turn.gatewayLatencyMs} ms
            </span>
          )}
          {turn.upstreamLatencyMs !== undefined && (
            <span
              title={t('captures.upstreamLatency')}
              style={{ fontSize: '12px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}
            >
              ↗ {turn.upstreamLatencyMs} ms
            </span>
          )}
          <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>

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

        {/* Tabs — 4 wire-side views */}
        <div style={{ display: 'flex', gap: '4px', padding: '12px 16px 0', borderBottom: '1px solid var(--card-border)', flexWrap: 'wrap' }}>
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
                  fontFamily: 'JetBrains Mono, monospace',
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
          {!active.ev ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '12px' }}>
              {t('captures.tabEmpty')}
            </div>
          ) : (
            <>
              <WireBlock event={active.ev} />
              {active.ev.truncated && (
                <div
                  style={{
                    marginTop: 12,
                    padding: '8px 10px',
                    borderRadius: '6px',
                    background: 'rgba(245,158,11,0.08)',
                    border: '1px solid rgba(245,158,11,0.3)',
                    color: '#f59e0b',
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
      <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: 6, fontFamily: 'JetBrains Mono, monospace' }}>
        {isResponse ? '← status line' : '→ request line'}
      </div>
      <pre
        style={{
          margin: 0,
          padding: '10px 12px',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid var(--card-border)',
          borderRadius: '6px',
          fontSize: '12px',
          fontFamily: 'JetBrains Mono, monospace',
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
            fontFamily: 'JetBrains Mono, monospace',
          }}
        >
          ⇢ {t('captures.viaProxy')}: {event.proxy}
        </div>
      )}
      <div style={{ fontSize: '11px', color: 'var(--text-dim)', margin: '14px 0 6px', fontFamily: 'JetBrains Mono, monospace' }}>
        {isResponse ? '← response headers' : '→ request headers'}
      </div>
      <JsonBlock value={isResponse ? event.wire.responseHeaders : event.wire.requestHeaders} />
      <div style={{ fontSize: '11px', color: 'var(--text-dim)', margin: '14px 0 6px', fontFamily: 'JetBrains Mono, monospace' }}>
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
  onConfirm: (exclude: string[]) => void;
}> = ({ session, onClose, onConfirm }) => {
  const { t } = useI18n();
  const [keepReqIn, setKeepReqIn] = useState(true);
  const [keepReqOut, setKeepReqOut] = useState(true);
  const [keepResp, setKeepResp] = useState(true);
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
        background: 'rgba(0, 0, 0, 0.75)',
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
            fontFamily: 'JetBrains Mono, monospace',
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
        <div style={{ fontSize: '11.5px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
          {t('captures.exportOptionsHint')}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={() => onConfirm(exclude)}>
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
  const [totalLines, setTotalLines] = useState(0);
  const [fileTruncated, setFileTruncated] = useState(false);
  const [selectedTurnIdx, setSelectedTurnIdx] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [exportTarget, setExportTarget] = useState<CaptureSessionRow | null>(null);
  const [query, setQuery] = useState('');
  const [pendingFile, setPendingFile] = useState<string>('');
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

  const loadSessions = useCallback(async (date: string) => {
    if (!date) {
      setSessions([]);
      return;
    }
    try {
      const rows = await api.getCaptureSessions(date);
      setSessions(rows);
      setSelectedFile(prev => (prev && rows.some(r => r.file === prev) ? prev : ''));
    } catch (err) {
      console.error(err);
    }
  }, []);

  const loadRecords = useCallback(async (date: string, file: string) => {
    if (!date || !file) {
      setTurns([]);
      setEvents([]);
      return;
    }
    setLoading(true);
    try {
      const res = await api.getCaptureEvents(date, file);
      // Timeline renders newest-first: the read window is the file's tail, so
      // the most recent turn is the one worth seeing first. Reverse ONCE here
      // at state level so selectedTurnIdx / drawer / list keys stay consistent.
      setTurns([...res.turns].reverse());
      setEvents(res.events);
      setTotalLines(res.totalLines);
      setFileTruncated(res.fileTruncated);
      setSelectedTurnIdx(null);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    loadSessions(selectedDate);
    setSelectedFile('');
    setTurns([]);
    setEvents([]);
  }, [selectedDate, loadSessions]);

  useEffect(() => {
    loadRecords(selectedDate, selectedFile);
  }, [selectedDate, selectedFile, loadRecords]);

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
      const res: any = await api.saveConfig({
        ...cfg,
        capture: {
          retentionDays: 7,
          maxTotalMB: 512,
          maxBodyBytes: 65536,
          ...(cfg.capture || {}),
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

  const handleExport = async (s: CaptureSessionRow, exclude: string[] = []) => {
    if (!selectedDate) return;
    try {
      const blob = await api.exportCaptureArchive(selectedDate, s.file, exclude.length ? exclude : undefined);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `capture-${selectedDate}-${s.sessionId}.jsonl`;
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
        await loadSessions(selectedDate);
        await loadStatus();
      } else {
        toast.error(res.message || t('common.failed'));
      }
    } catch (err: any) {
      toast.error(err.message || t('common.failed'));
    }
  };

  // Session filter: id substring OR first-message preview, case-insensitive.
  const q = query.trim().toLowerCase();
  const visibleSessions = q
    ? sessions.filter(s => s.sessionId.toLowerCase().includes(q) || (s.preview || '').toLowerCase().includes(q))
    : sessions;

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
            <button className="btn btn-sm" onClick={loadStatus} disabled={loading}>
              <RefreshCw size={12} />
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
                  borderBottom: '1px solid var(--card-border)',
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
                    Width is user-resizable via the splitter; persisted. */}
                <div
                  style={{
                    width: railWidth,
                    flexShrink: 0,
                    borderRight: '1px solid var(--card-border)',
                    display: 'flex',
                    flexDirection: 'column',
                    minHeight: 0,
                  }}
                >
                  <div style={{ padding: '8px 10px 4px', flexShrink: 0 }}>
                    <input
                      type="text"
                      className="input"
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                      placeholder={t('captures.searchPlaceholder')}
                      style={{ width: '100%', fontSize: '12px', padding: '6px 10px' }}
                    />
                  </div>
                  <div style={{ overflowY: 'auto', padding: '0 4px 4px', flex: 1, minHeight: 0 }}>
                  {visibleSessions.map(s => (
                    <div
                      key={s.file}
                      onClick={() => setSelectedFile(s.file)}
                      title={s.preview ? `${s.sessionId}\n${s.preview}\n${fmtBytes(s.bytes)}` : `${s.sessionId}\n${fmtBytes(s.bytes)}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '7px 10px',
                        marginBottom: '3px',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        lineHeight: 1.4,
                        background: s.file === selectedFile ? 'rgba(255,255,255,0.06)' : undefined,
                        borderLeft: s.file === selectedFile ? '2px solid var(--accent)' : '2px solid transparent',
                      }}
                    >
                      {/* Last-turn status dot: emerald = ok, red = error,
                          dim gray = unknown (archive has the request half
                          only — no gateway response was ever recorded). */}
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
                                : 'rgba(255,255,255,0.18)',
                          boxShadow:
                            s.lastStatus === 'error'
                              ? '0 0 6px rgba(239,68,68,0.5)'
                              : s.lastStatus === 'ok'
                                ? '0 0 6px rgba(16,185,129,0.4)'
                                : 'none',
                        }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontFamily: 'JetBrains Mono, monospace',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {s.sessionId}
                        </div>
                        {s.preview && (
                          <div
                            style={{
                              fontSize: '11px',
                              color: 'var(--text-dim)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              marginTop: '1px',
                            }}
                          >
                            {s.preview}
                          </div>
                        )}
                      </div>
                      <span
                        style={{
                          color: 'var(--text-dim)',
                          fontSize: '11px',
                          fontFamily: 'JetBrains Mono, monospace',
                          flexShrink: 0,
                        }}
                      >
                        {fmtTime(s.mtimeMs)}
                      </span>
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
                          flexShrink: 0,
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
                          flexShrink: 0,
                          cursor: 'pointer',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
                        onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
                      >
                        <Trash2 size={13} />
                      </span>
                    </div>
                  ))}
                  {visibleSessions.length === 0 && (
                    <div style={{ padding: '8px', fontSize: '11px', color: 'var(--text-dim)' }}>
                      {q ? t('captures.noMatchSessions') : t('captures.emptySessions')}
                    </div>
                  )}
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
                          borderBottom: '1px solid var(--card-border)',
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{ fontSize: '13px', fontWeight: 600 }}>{t('captures.turnsTitle')}</span>
                        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', color: 'var(--text-dim)' }}>
                          {selectedFile.replace(/\.jsonl$/, '')} · {totalLines} {t('captures.turnsUnit')}
                        </span>
                      </div>
                      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 16px 14px' }}>
                        {fileTruncated && (
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              fontSize: '11px',
                              color: '#f59e0b',
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
                              ?? turn.upstreamResponse?.ts;
                            const errEvent = turn.upstreamResponse?.status === 'error'
                              || turn.gatewayResponse?.status === 'error'
                              || !!turn.error;
                            return (
                              <div
                                key={`${turn.traceId}-${idx}`}
                                onClick={() => setSelectedTurnIdx(idx)}
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
                                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
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
                                <span style={{ color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', flexShrink: 0 }}>
                                  {turnStart !== undefined ? fmtTime(turnStart) : ''}
                                </span>
                                <span
                                  className="badge"
                                  style={
                                    errEvent
                                      ? { background: 'rgba(239,68,68,0.12)', color: '#ef4444' }
                                      : { background: 'rgba(16,185,129,0.12)', color: 'var(--accent-emerald)' }
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
                                {turn.upstreamRequest?.proxy && (
                                  <span
                                    className="badge"
                                    title={`${t('captures.viaProxy')}: ${turn.upstreamRequest.proxy}`}
                                    style={{
                                      background: 'rgba(59,130,246,0.12)',
                                      color: '#60a5fa',
                                      fontFamily: 'JetBrains Mono, monospace',
                                      fontSize: '10px',
                                    }}
                                  >
                                    ⇢ proxy
                                  </span>
                                )}
                                <span
                                  title={`traceId=${turn.traceId}`}
                                  onClick={async () => {
                                    const ok = await copyToClipboard(turn.traceId);
                                    if (ok) toast.success(t('captures.copied'));
                                    else toast.error(t('common.failed'));
                                  }}
                                  style={{
                                    fontSize: '11px',
                                    color: 'var(--text-dim)',
                                    fontFamily: 'JetBrains Mono, monospace',
                                    background: 'rgba(255,255,255,0.04)',
                                    padding: '2px 6px',
                                    borderRadius: '4px',
                                    cursor: 'copy',
                                  }}
                                >
                                  trace:{shortId(turn.traceId)}
                                </span>
                                {turn.gatewayLatencyMs !== undefined && (
                                  <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                                    ↳ {turn.gatewayLatencyMs} ms
                                  </span>
                                )}
                                {turn.upstreamLatencyMs !== undefined && (
                                  <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                                    ↗ {turn.upstreamLatencyMs} ms
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
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
        <CaptureDrawer turn={turns[selectedTurnIdx]} onClose={() => setSelectedTurnIdx(null)} />
      )}

      {exportTarget && (
        <ExportDialog
          session={exportTarget}
          onClose={() => setExportTarget(null)}
          onConfirm={exclude => {
            const s = exportTarget;
            setExportTarget(null);
            handleExport(s, exclude);
          }}
        />
      )}
    </div>
  );
};

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ShieldCheck, Save, BookOpen, ChevronDown, ChevronLeft, ChevronRight, Plus, Trash2, Activity, Eraser, RefreshCw, Inbox, MonitorCog, Undo2, Terminal, Copy, FileText, Download, Image as ImageIcon, Maximize2, Minimize2 } from 'lucide-react';
import { api, type GatewayStatusResponse, type ProxyAccessEvent, type SystemProxyStatus } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Switch } from '../components/Switch';
import { InfoTip } from '../components/InfoTip';
import { Combobox, type ComboboxOption } from '../components/Combobox';
import { SegGroup } from '../components/SegGroup';
import { Drawer } from '../components/Drawer';
import { Prose, proseIsLong } from '../components/Prose';
import { modelRefBadge } from '../lib/modelRefBadge';
import { sortModelOptions } from '../lib/model-options';
import { DEFAULT_FORWARD_PROXY_PORT, DEFAULT_FORWARD_PROXY_HOST, DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS, PROXY_ACCESS_LOG_PERSIST_DAYS_MIN, PROXY_ACCESS_LOG_PERSIST_DAYS_MAX } from '../lib/defaults';

import { FONT_MONO } from '../lib/fonts';
/**
 * Proxy Access — the inbound forward proxy (HTTP_PROXY / HTTPS_PROXY server)
 * as a client access method under the Client Access nav group.
 *
 * Layout:
 *  Card 1 — configuration, ALWAYS visible (status chip + enable / port /
 *           bypass form; Export-CA + Save live in the header).
 *  Card 2 — the setup HELP rendered as a wizard: horizontal clickable stepper,
 *           click a step → its content panel shows; prev/next walk the flow.
 * The status chip polls /api/admin/status every 4s: running / failed /
 * enabled-pending-restart / disabled — a failed start stays visible (the
 * gateway itself never fails on it).
 */

interface ForwardProxyShape {
  enabled?: boolean;
  port?: number;
  /** Listen address — boot-frozen like port (shape of the listening socket). */
  host?: string;
  /** MITM CA directory — boot-frozen (cert material). */
  caDir?: string;
  bypassHosts?: (string | { host: string; viaProxy?: boolean })[];
  viaOutboundProxy?: boolean;
  unresolvedModel?: { onMiss?: string; hosts?: Record<string, string> };
  accessLog?: { enabled?: boolean; bodyBytes?: number; persist?: boolean; persistDays?: number };
}

const preStyle: React.CSSProperties = {
  margin: '6px 0 0 0',
  padding: '10px 12px',
  borderRadius: '8px',
  background: 'var(--well-bg)',
  border: '1px solid var(--card-border)',
  fontFamily: FONT_MONO,
  fontSize: 'var(--text-xs)',
  lineHeight: 'var(--leading-normal)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  color: 'var(--text-muted)',
};

const FONT_MONO_COLOR: React.CSSProperties = { fontFamily: FONT_MONO, whiteSpace: 'nowrap' };
const LOG_TH: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 10px',
  borderBottom: '1px solid var(--divider)',
  color: 'var(--text-dim)',
  fontWeight: 'var(--font-medium)',
  fontSize: 'var(--text-xs)',
  whiteSpace: 'nowrap',
};
const LOG_TD: React.CSSProperties = {
  padding: '5px 10px',
  borderBottom: '1px solid var(--divider)',
  verticalAlign: 'top',
  fontSize: 'var(--text-sm)',
};

/** Section header inside a .sub-card group — 11px bold dim, one tier under card titles. */
const SEC_TITLE: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  fontWeight: 'var(--font-bold)',
  color: 'var(--text-dim)',
  marginBottom: '12px',
  letterSpacing: 'var(--tracking-wide)',
};
const fmtBytes = (n: number): string => (n === 0 ? '0' : n < 1024 ? String(n) : `${(n / 1024).toFixed(1)}K`);

/**
 * The forward-proxy access log card (backend /api/admin/proxy-log). Lists
 * every NON-intercepted HTTP exchange and CONNECT tunnel decision, newest
 * first; a row click opens the detail drawer. Events persist as daily JSONL
 * files under <ocrHome>/forward-proxy/access-log/ (survive restarts); the
 * enabled/bodyBytes/persist knobs live in config.yaml `forwardProxy.accessLog`
 * (hot-applies on save).
 */
/** One collapsible section of the detail drawer (headers / body). When
 *  `onToggle` is given (content is long), an expand/collapse glyph sits at
 *  the summary's right edge, driving the same state as the in-content toggle. */
const DetailSection: React.FC<{
  title: string;
  children: React.ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
}> = ({ title, children, expanded, onToggle }) => {
  const { t } = useI18n();
  return (
    <details className="sub-card" open>
      <summary style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', listStyle: 'none' }}>
        <ChevronDown size={14} color="var(--text-dim)" style={{ flexShrink: 0 }} />
        <span style={{ ...SEC_TITLE, marginBottom: 0 }}>{title}</span>
        {onToggle && (
          <button
            type="button"
            onClick={e => { e.preventDefault(); e.stopPropagation(); onToggle(); }}
            title={expanded ? t('captures.collapse') : t('captures.expand')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', padding: '2px 4px', display: 'inline-flex', marginLeft: 'auto', flexShrink: 0 }}
          >
            {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        )}
      </summary>
      <div style={{ marginTop: '8px' }}>{children}</div>
    </details>
  );
};

/**
 * Drawer body of one proxy-log event: Request / Response tabs, each with
 * collapsible header and body sections. Keyed by event id so the tab choice
 * resets to Response (the side you usually read) per opened row.
 */
/**
 * JSON bodies arrive as one compact line — unreadable in the drawer. Parse
 * and re-stringify with 2-space indent when the text IS a JSON object/array;
 * anything else (HTML, truncated JSON) is returned untouched.
 */
const prettyIfJson = (text: string): string => {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return text;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return text;
  }
};

/** 16-bytes-per-row hex dump (offset / hex / ASCII gutter) — mirrors the backend format. */
const bytesToHexDump = (buf: Uint8Array): string => {
  const rows: string[] = [];
  for (let off = 0; off < buf.length; off += 16) {
    const slice = buf.subarray(off, off + 16);
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0'));
    const cells: string[] = [];
    for (let i = 0; i < 16; i += 8) cells.push(hex.slice(i, i + 8).join(' ').padEnd(23, ' '));
    const ascii = [...slice].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    rows.push(`${off.toString(16).padStart(8, '0')}  ${cells.join('  ')}  |${ascii}|`);
  }
  return rows.join('\n');
};

/** Parse a hex dump back into raw bytes (offset + ASCII gutter are prose). */
const hexDumpToBytes = (dump: string): Uint8Array => {
  const out: number[] = [];
  for (const line of dump.split('\n')) {
    const bar = line.indexOf('|');
    const hexPart = (bar >= 0 ? line.slice(0, bar) : line).replace(/^[0-9a-f]+\s*/, '').replace(/[^0-9a-f]/g, '');
    for (let i = 0; i + 1 < hexPart.length; i += 2) out.push(parseInt(hexPart.slice(i, i + 2), 16));
  }
  return new Uint8Array(out);
};
/** Image container sniffing from magic bytes; null when not a displayable image. */
const sniffImage = (b: Uint8Array): 'image/png' | 'image/gif' | 'image/jpeg' | 'image/webp' | 'image/bmp' | 'image/x-icon' | null => {
  const head = b.subarray(0, 12);
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'image/gif';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head[0] === 0x42 && head[1] === 0x4d) return 'image/bmp';
  if (head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01 && head[3] === 0x00) return 'image/x-icon';
  if (head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'image/webp';
  return null;
};

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico',
};

/**
 * Hex viewer for a binary captured body. Persisted bodies load their raw
 * bytes from the gateway (`file` ref → /api/admin/proxy-log/bodies/...);
 * non-persisted fallbacks arrive as an inline dump (`inlineDump`). The hex
 * dump is generated here either way. Top-right switch: hex ⇄ text (lossy
 * utf-8) ⇄ image preview when the magic bytes are a displayable container;
 * plus a download of the captured bytes.
 */
/** Collapsible section for a captured BINARY body. The toolbar (format hint
 *  + text/image/download controls) lives on the summary's right edge; the
 *  body is just the hex dump / decoded text / image preview. */
const HexSection: React.FC<{ title: string; file?: string; inlineDump?: string; mimeHint?: string; filename?: string }> = ({ title, file, inlineDump, mimeHint, filename }) => {
  const { t } = useI18n();
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    if (!file) return;
    let alive = true;
    setFileBytes(null);
    setLoadError(false);
    api
      .getProxyAccessBody(file)
      .then((buf) => {
        if (alive) setFileBytes(new Uint8Array(buf));
      })
      .catch(() => {
        if (alive) setLoadError(true);
      });
    return () => {
      alive = false;
    };
  }, [file]);
  const bytes = useMemo(() => {
    if (file) return fileBytes;
    return inlineDump ? hexDumpToBytes(inlineDump) : null;
  }, [file, fileBytes, inlineDump]);
  const mime = useMemo(() => (bytes ? sniffImage(bytes) : null), [bytes]);
  const [view, setView] = useState<'hex' | 'text' | 'img'>('hex');
  const text = useMemo(() => (view === 'text' && bytes ? new TextDecoder('utf-8', { fatal: false }).decode(bytes) : ''), [view, bytes]);
  const dataUrl = useMemo(
    () => (view === 'img' && mime && bytes ? `data:${mime};base64,${btoa(String.fromCharCode(...bytes))}` : ''),
    [view, mime, bytes]
  );
  const download = () => {
    if (!bytes) return;
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime ?? mimeHint ?? 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (filename?.split('/').pop() || 'body') + (EXT_BY_MIME[mime ?? ''] ?? '.bin');
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const btn: React.CSSProperties = {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--text-dim)',
    fontSize: 'var(--text-xs)',
    padding: '0 2px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
  };
  return (
    <details className="sub-card" open>
      <summary style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', listStyle: 'none' }}>
        <ChevronDown size={14} color="var(--text-dim)" style={{ flexShrink: 0 }} />
        <span style={{ ...SEC_TITLE, marginBottom: 0, flexShrink: 0 }}>{title}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 1, minWidth: 0 }}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('proxyLog.hexHint')}</span>
          <button
            type="button"
            style={btn}
            title={t('proxyLog.hexAsText')}
            onClick={e => { e.preventDefault(); e.stopPropagation(); setView(view === 'text' ? 'hex' : 'text'); }}
          >
            <FileText size={12} />
          </button>
          {mime && (
            <button
              type="button"
              style={btn}
              title={t('proxyLog.hexAsImage')}
              onClick={e => { e.preventDefault(); e.stopPropagation(); setView(view === 'img' ? 'hex' : 'img'); }}
            >
              <ImageIcon size={12} />
            </button>
          )}
          <button
            type="button"
            style={btn}
            title={t('proxyLog.hexDownload')}
            onClick={e => { e.preventDefault(); e.stopPropagation(); download(); }}
          >
            <Download size={12} />
          </button>
        </span>
      </summary>
      <div style={{ marginTop: '8px' }}>
        {file && !bytes && !loadError && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxyLog.hexLoading')}</div>}
        {loadError && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{t('proxyLog.hexLoadFailed')}</div>}
        {bytes && view === 'hex' && <Prose text={bytesToHexDump(bytes)} clamp={14} />}
        {bytes && view === 'text' && <Prose text={text || t('proxyLog.hexTextEmpty')} clamp={14} />}
        {bytes && view === 'img' && (
          <div style={{ padding: '8px', background: 'var(--well-bg)', border: '1px solid var(--card-border)', borderRadius: 6, textAlign: 'center' }}>
            <img src={dataUrl} alt={filename || 'captured body'} style={{ maxWidth: '100%', maxHeight: 320, imageRendering: 'auto' }} />
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: '4px' }}>
              {mime} · {bytes.length} B
            </div>
          </div>
        )}
      </div>
    </details>
  );
};


const ProxyAccessDetail: React.FC<{ ev: ProxyAccessEvent }> = ({ ev }) => {
  const { t } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState<'req' | 'res'>('res');

  /** Reconstruct the absolute request URL (port implied for 80/443). */
  const eventUrl = (): string => {
    if (ev.kind === 'connect') return `http://${ev.host}:${ev.port}`;
    const scheme = ev.port === 443 ? 'https' : 'http';
    const hostPort = ev.port === 443 || ev.port === 80 || !ev.port ? ev.host : `${ev.host}:${ev.port}`;
    return `${scheme}://${hostPort}${ev.path ?? ''}`;
  };

  const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

  const eventCurl = (): string => {
    const parts = [`curl -X ${ev.method ?? 'GET'}`, shellQuote(eventUrl())];
    for (const [k, v] of Object.entries(ev.requestHeaders ?? {})) {
      if (/^(host|content-length|accept-encoding)$/i.test(k)) continue;
      parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
    }
    if (typeof ev.requestBody === 'string' && ev.requestBody) parts.push(`--data-binary ${shellQuote(ev.requestBody)}`);
    return parts.join(' ');
  };

  const copy = async (text: string, okMsg: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(okMsg);
    } catch {
      toast.error(t('proxyLog.copyFailed'));
    }
  };

  const miniBtn: React.CSSProperties = {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--text-dim)',
    padding: '2px 4px',
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
  };

  const asText = (val: Record<string, string> | string | undefined): string | null =>
    val == null || val === '' || (typeof val === 'object' && Object.keys(val).length === 0)
      ? null
      : typeof val === 'string'
        ? prettyIfJson(val)
        : Object.entries(val).map(([k, v]) => `${k}: ${v}`).join('\n');
  const reqHeaders = asText(ev.requestHeaders);
  const resHeaders = asText(ev.responseHeaders);
  /** Per-section expansion, owned here so the header glyph and the Prose
   *  toggle stay in lockstep. Keyed by event via the component `key`. */
  const [exp, setExp] = useState({ reqH: false, reqB: false, resH: false, resB: false });
  const flip = (k: keyof typeof exp, v: boolean) => setExp(s => ({ ...s, [k]: v }));
  const empty = (
    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxyLog.captureEmpty')}</div>
  );
  const urlRow = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
      {ev.kind === 'http' && (
        <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', color: 'var(--text-main)', flexShrink: 0 }}>{ev.method}</span>
      )}
      <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={eventUrl()}>
        {eventUrl()}
      </span>
      <button type="button" style={miniBtn} title={t('proxyLog.copyUrl')} onClick={() => void copy(eventUrl(), t('proxyLog.urlCopied'))}>
        <Copy size={12} />
      </button>
      {ev.kind !== 'connect' && (
        <button type="button" style={miniBtn} title={t('proxyLog.copyCurl')} onClick={() => void copy(eventCurl(), t('proxyLog.curlCopied'))}>
          <Terminal size={12} />
        </button>
      )}
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {ev.note && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{ev.note}</div>}
      {ev.truncated && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{t('proxyLog.truncated')}</div>}
      {urlRow}
      {ev.kind === 'connect' ? (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxyLog.detailNone')}</div>
      ) : (
        <>
          <SegGroup
            value={tab}
            onChange={(v) => setTab(v as 'req' | 'res')}
            options={[
              { value: 'req', label: t('proxyLog.tabReq') },
              { value: 'res', label: t('proxyLog.tabRes') },
            ]}
          />
          {tab === 'req' ? (
            <>
              <DetailSection
                title={t('proxyLog.reqHeaders')}
                expanded={exp.reqH}
                onToggle={proseIsLong(reqHeaders ?? '', 10) ? () => flip('reqH', !exp.reqH) : undefined}
              >
                {reqHeaders ? <Prose text={reqHeaders} clamp={10} open={exp.reqH} onOpenChange={v => flip('reqH', v)} hideToggle /> : empty}
              </DetailSection>
              {ev.reqBodyFile || ev.reqBodyFormat === 'hex' ? (
                <HexSection
                  title={t('proxyLog.reqBody')}
                  file={ev.reqBodyFile}
                  inlineDump={ev.reqBodyFormat === 'hex' ? ev.requestBody : undefined}
                  mimeHint={ev.reqBodyMime}
                  filename={ev.path}
                />
              ) : asText(ev.requestBody) && (
                <DetailSection
                  title={t('proxyLog.reqBody')}
                  expanded={exp.reqB}
                  onToggle={proseIsLong(asText(ev.requestBody)!, 14) ? () => flip('reqB', !exp.reqB) : undefined}
                >
                  <Prose text={asText(ev.requestBody)!} clamp={14} open={exp.reqB} onOpenChange={v => flip('reqB', v)} hideToggle />
                </DetailSection>
              )}
            </>
          ) : (
            <>
              <DetailSection
                title={t('proxyLog.resHeaders')}
                expanded={exp.resH}
                onToggle={proseIsLong(resHeaders ?? '', 10) ? () => flip('resH', !exp.resH) : undefined}
              >
                {resHeaders ? <Prose text={resHeaders} clamp={10} open={exp.resH} onOpenChange={v => flip('resH', v)} hideToggle /> : empty}
              </DetailSection>
              {(ev.status === 204 || ev.status === 304) && (
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxyLog.noBodyStatus', { status: ev.status })}</div>
              )}
              {ev.resBodyFile || ev.resBodyFormat === 'hex' ? (
                <HexSection
                  title={t('proxyLog.resBody')}
                  file={ev.resBodyFile}
                  inlineDump={ev.resBodyFormat === 'hex' ? ev.responseBody : undefined}
                  mimeHint={ev.resBodyMime}
                  filename={ev.path}
                />
              ) : asText(ev.responseBody) && (
                <DetailSection
                  title={t('proxyLog.resBody')}
                  expanded={exp.resB}
                  onToggle={proseIsLong(asText(ev.responseBody)!, 14) ? () => flip('resB', !exp.resB) : undefined}
                >
                  <Prose text={asText(ev.responseBody)!} clamp={14} open={exp.resB} onOpenChange={v => flip('resB', v)} hideToggle />
                </DetailSection>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
};

/** The rendered request line: `METHOD host[:port]path` for http rows, `host:port` for CONNECT rows. */
const requestLine = (e: ProxyAccessEvent): string =>
  e.kind === 'http'
    ? `${e.method} ${e.host}${e.port !== 443 && e.port !== 80 ? `:${e.port}` : ''}${e.path ?? ''}`
    : `${e.host}:${e.port}`;

/** Case-insensitive glob (`*` / `?`) anchored to the whole string. */
const globToRe = (glob: string): RegExp =>
  new RegExp(
    `^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
    'i'
  );

/** Default kind filter: `http` — CONNECT rows are mostly duplicate tunnel-setup noise. */
const KIND_DEFAULT = 'http';

const ProxyAccessLogCard: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [events, setEvents] = useState<ProxyAccessEvent[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  /** Free-text filter over kind/method/host/path/status/note. */
  const [query, setQuery] = useState('');
  /** Advanced filters — each optional, AND-combined with the free-text query. `http` is the
   *  default kind: CONNECT rows are mostly duplicate tunnel-setup noise. */
  const [fKind, setFKind] = useState('http');
  const [fMethod, setFMethod] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fHost, setFHost] = useState('');
  const [fPath, setFPath] = useState('');
  /** Time sort direction — backend yields newest-first, so default is desc. */
  const [timeAsc, setTimeAsc] = useState(false);

  const selected = events.find((e) => e.id === openId) ?? null;
  /** Distinct method / status values present in the ring, for the filter dropdowns. */
  const fMethodOptions = useMemo(() => [...new Set(events.map(e => e.method).filter(Boolean) as string[])].sort(), [events]);
  const fStatusOptions = useMemo(
    () => [...new Set(events.filter(e => e.status != null).map(e => String(e.status)))].sort((a, b) => Number(a) - Number(b)),
    [events]
  );
  /** Distinct hosts with row counts, most active first. */
  const fHostOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events) if (e.host) counts.set(e.host, (counts.get(e.host) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [events]);
  const anyFilter = Boolean(query.trim() || (fKind && fKind !== KIND_DEFAULT) || fMethod || fStatus || fHost || fPath.trim());
  const resetFilters = useCallback(() => {
    setQuery(''); setFKind(KIND_DEFAULT); setFMethod(''); setFStatus(''); setFHost(''); setFPath('');
  }, []);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const p = fPath.trim().toLowerCase();
    const h = fHost.toLowerCase();
    const rows = events.filter((e) => {
      if (fKind && e.kind !== fKind) return false;
      if (fMethod && e.method !== fMethod) return false;
      if (fStatus && String(e.status ?? '') !== fStatus) return false;
      if (h && e.host.toLowerCase() !== h) return false;
      if (p && !(e.path ?? '').toLowerCase().includes(p)) return false;
      if (q) {
        // Request-line search: plain text = substring, glob metachars = anchored glob.
        const line = requestLine(e);
        const hit = /[*?]/.test(q) ? globToRe(q).test(line) : line.toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
    return timeAsc ? [...rows].sort((a, b) => a.ts - b.ts) : rows;
  }, [events, query, fKind, fMethod, fStatus, fHost, fPath, timeAsc]);
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getProxyAccessLog();
      setEvents(res.events);
      setEnabled(res.enabled);
    } catch {
      // Log endpoint is additive on older gateways; stay silent.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);
  useEffect(() => {
    if (!auto) return;
    const iv = setInterval(loadData, 4000);
    return () => clearInterval(iv);
  }, [auto, loadData]);

  const handleClear = useCallback(async () => {
    const ok = await confirmDialog({
      title: t('proxyLog.clearConfirmTitle'),
      description: t('proxyLog.clearConfirmDesc'),
      danger: true,
      confirmLabel: t('proxyLog.clear'),
    });
    if (!ok) return;
    try {
      await api.clearProxyAccessLog();
      toast.success(t('proxyLog.clearDone'));
      loadData();
    } catch (err: any) {
      toast.error(t('proxyLog.clear') + ': ' + (err?.message || err));
    }
  }, [confirmDialog, toast, t, loadData]);

  return (
    <div className="card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="card-header">
        <div className="card-title">
          <Activity size={18} color="var(--accent)" />
          <span>{t('proxyLog.title')}</span>
          <span
            className="badge"
            style={{
              fontSize: 'var(--text-2xs)',
              background: enabled ? 'color-mix(in srgb, var(--accent-emerald) 13%, transparent)' : 'var(--chip-bg)',
              color: enabled ? 'var(--accent-emerald)' : 'var(--text-dim)',
              border: '1px solid var(--divider)',
            }}
          >
            {enabled ? t('proxyLog.onChip') : t('proxyLog.offChip')}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button className={`btn btn-sm ${auto ? 'btn-primary' : ''}`} onClick={() => setAuto(a => !a)} title={t('proxyLog.autoHint')}>
            <RefreshCw size={12} />
            <span>{t('proxyLog.auto')}</span>
          </button>
          <button className="btn btn-sm" onClick={loadData} disabled={loading}>
            <RefreshCw size={12} style={loading ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined} />
            <span>{t('proxyLog.refresh')}</span>
          </button>
          <button className="btn btn-sm" onClick={handleClear} disabled={events.length === 0}>
            <Eraser size={12} />
            <span>{t('proxyLog.clear')}</span>
          </button>
        </div>
      </div>


      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)', padding: '0 14px 10px', flexShrink: 0 }}>
        {t('proxyLog.hint')}
      </div>
      <div style={{ padding: '0 14px 10px', flexShrink: 0, display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: '160px', fontSize: 'var(--text-sm)' }}
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          placeholder={t('proxyLog.search')}
        />
        <Combobox
          value={fKind}
          onChange={setFKind}
          clearable
          placeholder={t('proxyLog.fKind')}
          style={{ width: '112px' }}
          options={[{ value: 'http', label: t('proxyLog.kindHttp') }, { value: 'connect', label: t('proxyLog.kindConnect') }]}
        />
        <Combobox
          value={fMethod}
          onChange={setFMethod}
          clearable
          placeholder={t('proxyLog.fMethod')}
          style={{ width: '112px' }}
          options={fMethodOptions.map(m => ({ value: m, label: m }))}
        />
        <Combobox
          value={fStatus}
          onChange={setFStatus}
          clearable
          placeholder={t('proxyLog.fStatus')}
          style={{ width: '100px' }}
          options={fStatusOptions.map(s => ({ value: s, label: s }))}
        />
        <Combobox
          value={fHost}
          onChange={setFHost}
          clearable
          placeholder={t('proxyLog.fHost')}
          panelMinWidth={260}
          style={{ width: '180px' }}
          options={fHostOptions.map(([h, n]) => ({ value: h, label: h, meta: `${n}` }))}
        />
        <input
          className="input"
          style={{ width: '150px', fontSize: 'var(--text-sm)' }}
          value={fPath}
          onChange={(ev) => setFPath(ev.target.value)}
          placeholder={t('proxyLog.fPath')}
        />
        {anyFilter && (
          <button className="btn btn-sm" onClick={resetFilters}>
            {t('proxyLog.fReset')}
          </button>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        {events.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--text-dim)', fontSize: 'var(--text-md)', padding: '24px' }}>
            <Inbox size={24} />
            <span>{t('proxyLog.empty')}</span>
          </div>
        ) : visible.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 'var(--text-md)', padding: '24px' }}>
            <span>{t('proxyLog.noMatch')}</span>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
            <thead>
              <tr>
                <th style={LOG_TH}>
                  <button
                    onClick={() => setTimeAsc((a) => !a)}
                    title={t('proxyLog.sortTimeHint')}
                    style={{ all: 'unset', cursor: 'pointer', font: 'inherit', color: 'inherit' }}
                  >
                    {t('proxyLog.colTime')} {timeAsc ? '↑' : '↓'}
                  </button>
                </th>
                <th style={LOG_TH}>{t('proxyLog.colKind')}</th>
                <th style={LOG_TH}>{t('proxyLog.colRequest')}</th>
                <th style={LOG_TH}>{t('proxyLog.colStatus')}</th>
                <th style={LOG_TH}>{t('proxyLog.colMs')}</th>
                <th style={LOG_TH}>{t('proxyLog.colBytes')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => (
                <tr
                  key={e.id}
                  onClick={() => setOpenId(e.id)}
                  style={{ cursor: 'pointer', background: openId === e.id ? 'var(--well-bg)' : undefined }}
                >
                  <td style={{ ...LOG_TD, ...FONT_MONO_COLOR }}>{new Date(e.ts).toLocaleTimeString()}</td>
                  <td style={LOG_TD}>
                    <span className="badge" style={{ fontSize: 'var(--text-2xs)', border: '1px solid var(--divider)', color: e.kind === 'http' ? 'var(--accent)' : 'var(--text-dim)' }}>
                      {e.kind === 'http' ? t('proxyLog.kindHttp') : t('proxyLog.kindConnect')}
                    </span>
                  </td>
                  <td style={{ ...LOG_TD, maxWidth: '420px' }}>
                    <div style={{ fontFamily: FONT_MONO, wordBreak: 'break-all', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {requestLine(e)}
                    </div>
                  </td>
                  <td style={{ ...LOG_TD, ...FONT_MONO_COLOR, color: e.status && e.status >= 400 ? '#f87171' : undefined }}>
                    {e.kind === 'http' ? (e.status ?? '—') : '—'}
                  </td>
                  <td style={{ ...LOG_TD, ...FONT_MONO_COLOR }}>{e.durationMs ?? '—'}</td>
                  <td style={{ ...LOG_TD, ...FONT_MONO_COLOR, color: 'var(--text-dim)' }}>
                    {fmtBytes(e.reqBytes)}/{fmtBytes(e.respBytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <Drawer
          title={
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Activity size={17} color="var(--accent)" />
              <span>{t('proxyLog.detailTitle')}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', fontWeight: 'var(--font-regular)', color: 'var(--text-dim)' }}>
                {new Date(selected.ts).toLocaleString()}
              </span>
            </span>
          }
          onClose={() => setOpenId(null)}
          closeLabel={t('combobox.close')}
          width="min(760px, 94vw)"
        >
          <ProxyAccessDetail key={selected.id} ev={selected} />
        </Drawer>
      )}
    </div>
  );
};

const ENV_SNIPPETS = (server: string, caPath: string): Record<string, string> => ({
  PowerShell: `$env:HTTP_PROXY='${server}'\n$env:HTTPS_PROXY='${server}'\n$env:NO_PROXY='localhost,127.0.0.1'\n$env:NODE_EXTRA_CA_CERTS='${caPath}'`,
  cmd: `set HTTP_PROXY=${server}\r\nset HTTPS_PROXY=${server}\r\nset NO_PROXY=localhost,127.0.0.1\r\nset NODE_EXTRA_CA_CERTS=${caPath}`,
  sh: `export HTTP_PROXY=${server}\nexport HTTPS_PROXY=${server}\nexport NO_PROXY=localhost,127.0.0.1\nexport NODE_EXTRA_CA_CERTS='${caPath}'`,
});

/**
 * OS system-proxy ownership card: snapshot → point the OS at the inbound
 * forward proxy → one-click restore. WinINET / networksetup / gsettings per
 * platform (backend forward-proxy/system-proxy.ts); unsupported platforms
 * render an explanatory note only. Env snippets stay clipboard-only.
 */
const SystemProxyCard: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [st, setSt] = useState<SystemProxyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [shell, setShell] = useState('PowerShell');
  const [showEnv, setShowEnv] = useState(true);

  const load = useCallback(() => {
    api.getSystemProxy().then(setSt).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [load]);
  // First snapshot decides the env-snippet disclosure: whenever the OS switch
  // is NOT the active path (off / external / stale), the terminal snippets are
  // the primary access method — open them once; afterwards the user toggles.
  const envInitedRef = useRef(false);
  useEffect(() => {
    if (envInitedRef.current || !st?.supported) return;
    envInitedRef.current = true;
    setShowEnv(st.state !== 'on');
  }, [st]);

  const act = async (kind: 'enable' | 'disable') => {
    setBusy(true);
    try {
      setSt(kind === 'enable' ? await api.enableSystemProxy() : await api.disableSystemProxy());
    } catch (err: any) {
      toast.error((kind === 'enable' ? t('proxyLog.sysEnableBtn') : t('proxyLog.sysDisableBtn')) + ': ' + (err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  const stateKey: Record<string, string> = {
    on: 'proxyLog.sysStateOn',
    off: 'proxyLog.sysStateOff',
    external: 'proxyLog.sysStateExternal',
    stale: 'proxyLog.sysStateStale',
    unsupported: 'proxyLog.sysStateUnsupported',
  };
  const stateColor = st?.state === 'on' ? 'var(--accent-emerald)' : st?.state === 'stale' || st?.state === 'external' ? 'var(--accent-amber)' : 'var(--text-dim)';

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">
          <MonitorCog size={18} color="var(--accent)" />
          <span>{t('proxyLog.sysTitle')}</span>
          {st && (
            <span className="badge" style={{ fontSize: 'var(--text-2xs)', border: '1px solid var(--divider)', color: stateColor, background: 'var(--chip-bg)' }}>
              {t(stateKey[st.state] || 'proxyLog.sysStateOff')}
            </span>
          )}
        </div>
        {st?.supported && (
          <div style={{ display: 'flex', gap: '8px' }}>
            {st.state === 'stale' && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)', alignSelf: 'center' }}>{t('proxyLog.sysStaleHint')}</span>}
            <button className="btn btn-primary btn-sm" disabled={busy || st.state === 'on'} onClick={() => act('enable')}>
              <MonitorCog size={12} />
              <span>{t('proxyLog.sysEnableBtn')}</span>
            </button>
            <button className="btn btn-sm" disabled={busy || st.state === 'off'} onClick={() => act('disable')}>
              <Undo2 size={12} />
              <span>{st.state === 'stale' ? t('proxyLog.sysRestoreBtn') : t('proxyLog.sysDisableBtn')}</span>
            </button>
          </div>
        )}
      </div>

      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)', padding: '0 14px 10px' }}>
        {t('proxyLog.sysHint')}
      </div>

      {st?.supported && st.override && (
        <div style={{ padding: '0 14px 10px', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
          <span style={{ marginRight: '6px' }}>{t('proxyLog.sysOverrideLabel')}</span>
          <span style={{ fontFamily: FONT_MONO, wordBreak: 'break-all' }}>{st.override}</span>
        </div>
      )}

      {st?.supported ? (
        <div style={{ padding: '0 14px 14px' }}>
          <button className="btn btn-sm" onClick={() => setShowEnv(s => !s)}>
            <Terminal size={12} />
            <span>{t('proxyLog.sysEnvBtn')}</span>
          </button>
          {showEnv && (
            <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '720px' }}>
              <Combobox value={shell} onChange={setShell} options={['PowerShell', 'cmd', 'sh'].map(s => ({ value: s, label: s }))} style={{ width: '160px' }} />
              <pre style={{ ...preStyle, margin: 0 }}>{ENV_SNIPPETS(st.targetServer || `http://127.0.0.1:${DEFAULT_FORWARD_PROXY_PORT}`, st.caPath)[shell]}</pre>
              <button
                className="btn btn-sm"
                style={{ alignSelf: 'flex-start', gap: '6px' }}
                onClick={() => {
                  navigator.clipboard.writeText(ENV_SNIPPETS(st.targetServer || `http://127.0.0.1:${DEFAULT_FORWARD_PROXY_PORT}`, st.caPath)[shell]).then(
                    () => toast.success(t('proxyLog.sysCopied')),
                    () => toast.error(t('proxyLog.sysCopyFailed')),
                  );
                }}
              >
                <Copy size={12} />
                <span>{t('proxyLog.sysCopyBtn')}</span>
              </button>
            </div>
          )}
        </div>
      ) : (
        st && <div style={{ padding: '0 14px 14px', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxyLog.sysUnsupportedNote')}</div>
      )}
    </div>
  );
};

const stepCircle = (active: boolean): React.CSSProperties => ({
  width: '24px',
  height: '24px',
  borderRadius: '50%',
  background: active ? 'var(--btn-primary-bg)' : 'var(--surface-hover)',
  color: active ? 'var(--btn-primary-text)' : 'var(--text-dim)',
  fontSize: 'var(--text-sm)',
  fontWeight: 'var(--font-bold)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
});

export const ProxyAccessPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [fp, setFp] = useState<ForwardProxyShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<GatewayStatusResponse | null>(null);
  const [gatewayModels, setGatewayModels] = useState<{ id: string; kind?: string; members?: number; wire?: string }[]>([]);
  /** Current wizard step id */
  const [step, setStep] = useState('1');
  /** Page view tab: access configuration / system proxy / setup wizard / traffic log. */
  const [view, setView] = useState<'config' | 'sys' | 'wizard' | 'log'>('config');
  /** Config-tab fold state: the traffic-log and miss-policy groups (advanced) default collapsed. */
  const [fold, setFold] = useState({ log: false, miss: false });
  /** Bypass host rows — per-row egress choice (viaProxy) */
  const [bypassRows, setBypassRows] = useState<{ host: string; viaProxy: boolean }[]>([]);
  /** unresolvedModel host-override rows — per-row onMiss value. */
  const [missRows, setMissRows] = useState<{ host: string; onMiss: string }[]>([]);
  /** onMiss is ONE flat picker: the two verbs first, then the modelRef pool
   *  (including the `auto` alias = the default classifier cascade — unset
   *  and `auto` are equivalent, ADR-0003 §7a). Decision-wire models are
   *  dropped — no chat surface can address them, so an onMiss hit would
   *  always fail. A saved value outside the list is echoed first so the
   *  trigger never renders empty. MUST stay above the loading early-return:
   *  the mount effect below closes over these, and a const declared after a
   *  `return` never initializes in that render's closure (TDZ when touched). */
  const onMissOptions = (current: string): ComboboxOption[] => {
    const refs = sortModelOptions(
      gatewayModels
        .filter(m => m.wire !== 'systemone')
        .map(m => ({
          kind: m.kind,
          value: m.id,
          label: m.id,
          meta: m.kind === 'combo' && m.members !== undefined ? t('models.memberCount', { n: m.members }) : undefined,
          ...modelRefBadge(m.kind, t),
        }))
    );
    const all: ComboboxOption[] = [
      { value: 'fail', label: t('forwardProxy.unresolvedModeFail') },
      { value: 'direct', label: t('forwardProxy.unresolvedModeDirect') },
      ...refs,
    ];
    return current && !all.some(o => o.value === current) ? [{ value: current, label: current }, ...all] : all;
  };

  /** The config AS LOADED — the diff baseline for boot-frozen fields. The live
   *  `fp` state already contains the operator's edits, so the restart-warning
   *  diff must run against this snapshot, never against `fp` itself. */
  const bootSnapshot = useRef<ForwardProxyShape>({});
  useEffect(() => {
    api.getConfig().then(cfg => {
      const fpCfg = ((cfg as any).forwardProxy as ForwardProxyShape) || {};
      bootSnapshot.current = fpCfg;
      setFp(fpCfg);
      setBypassRows(
        (fpCfg.bypassHosts || []).map(e =>
          typeof e === 'string' ? { host: e, viaProxy: false } : { host: e.host || '', viaProxy: e.viaProxy === true }
        )
      );
      setMissRows(
        Object.entries(fpCfg.unresolvedModel?.hosts || {}).map(([host, onMiss]) => ({
          host,
          onMiss,
        }))
      );
      setLoading(false);
    }).catch(() => setLoading(false));
    api.listGatewayModels()
      .then(setGatewayModels)
      .catch(() => setGatewayModels([]));
  }, []);

  // Runtime status poll — the chip must reflect a FAILED start (the gateway
  // keeps serving; only the proxy is absent) as clearly as a running one.
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.getStatus()
        .then(s => { if (alive) setStatus(s); })
        .catch(() => {});
    };
    load();
    const iv = setInterval(load, 4000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const next = {
        forwardProxy: {
          ...(fp || {}),
          bypassHosts: bypassRows
            .filter(r => r.host.trim())
            .map(r => (r.viaProxy ? { host: r.host.trim(), viaProxy: true } : r.host.trim())),
          unresolvedModel: {
            onMiss: fp?.unresolvedModel?.onMiss || 'auto',
            hosts: Object.fromEntries(
              missRows
                .filter(r => r.host.trim() && r.onMiss.trim())
                .map(r => [r.host.trim().toLowerCase(), r.onMiss.trim()])
            ),
          },
        },
      };
      await api.saveConfig(next);
      // Only enabled / port / host / caDir shape the listening socket and CA
      // material — boot-frozen. Everything else on this page hot-applies
      // (bypassHosts / viaOutboundProxy / unresolvedModel re-read the runtime
      // ref per request), so the restart warning fires ONLY when one of them
      // actually changed.
      const boot = bootSnapshot.current;
      const saved = next.forwardProxy;
      const frozen = (v: unknown, fallback: unknown): unknown => (v === undefined || v === '' ? fallback : v);
      const bootFrozenChanged =
        frozen(boot.enabled, false) !== frozen(saved.enabled, false) ||
        frozen(boot.port, DEFAULT_FORWARD_PROXY_PORT) !== frozen(saved.port, DEFAULT_FORWARD_PROXY_PORT) ||
        frozen(boot.host, DEFAULT_FORWARD_PROXY_HOST) !== frozen(saved.host, DEFAULT_FORWARD_PROXY_HOST) ||
        frozen(boot.caDir, '') !== frozen(saved.caDir, '');
      if (bootFrozenChanged) toast.warning(t('forwardProxy.savedNotice'));
      else toast.success(t('forwardProxy.savedHotNotice'));
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading || !fp) {
    return <div style={{ color: 'var(--text-dim)' }}>Loading...</div>;
  }


  const port = fp.port || DEFAULT_FORWARD_PROXY_PORT;


  // ── status chip ──
  const fpStatus = status?.forwardProxy;
  let dotColor = 'var(--text-dim)';
  let statusText = t('forwardProxy.statusDisabled');
  if (fpStatus?.running) {
    dotColor = 'var(--accent-emerald)';
    statusText = t('forwardProxy.statusRunning', {
      host: fpStatus.host || DEFAULT_FORWARD_PROXY_HOST,
      port: String(fpStatus.port ?? port),
      time: fpStatus.startedAt ? new Date(fpStatus.startedAt).toLocaleTimeString() : '—',
    });
  } else if (fpStatus?.error) {
    dotColor = '#f87171';
    statusText = t('forwardProxy.statusError', { error: fpStatus.error });
  } else if (fpStatus?.enabled ?? (fp.enabled ?? false)) {
    dotColor = 'var(--accent-amber)';
    statusText = t('forwardProxy.statusRestartPending');
  }

  // ── help wizard steps (content only — configuration lives in the card above) ──
  // Wizard steps (display order — the i18n key numbers are historical: the old
  // "enable proxy" step was removed since enabling lives in the always-visible
  // config card above). Steps: 1 trust CA · 2 point clients · 3 verify.
  const steps: { id: string; title: string; body: React.ReactNode }[] = [
    {
      id: '1',
      title: t('forwardProxy.step2Title'),
      body: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div>{t('forwardProxy.helpStep2')}</div>
          <pre style={preStyle}>{t('forwardProxy.helpStep2Code')}</pre>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', whiteSpace: 'pre-line' }}>{t('forwardProxy.helpStep2Sys')}</div>
        </div>
      ),
    },
    {
      id: '2',
      title: t('forwardProxy.step3Title'),
      body: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div>{t('forwardProxy.helpStep3')}</div>
          <pre style={preStyle}>{t('forwardProxy.helpStep3Code', { port })}</pre>
        </div>
      ),
    },
    {
      id: '3',
      title: t('forwardProxy.step4Title'),
      body: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div>{t('forwardProxy.helpStep4')}</div>
          <pre style={preStyle}>{t('forwardProxy.helpStep4Code', { port })}</pre>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('forwardProxy.helpNotes')}</div>
        </div>
      ),
    },
  ];
  const stepIndex = Math.max(0, steps.findIndex(s => s.id === step));
  const active = steps[stepIndex];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', height: '100%' }}>
      {/* View tab bar — configuration vs traffic log (the log card unmounts
          when hidden, which also pauses its 4s poll) */}
      <div style={{ flexShrink: 0 }}>
        <SegGroup
          value={view}
          onChange={v => setView(v as 'config' | 'sys' | 'wizard' | 'log')}
          size="lg"
          options={[
            { value: 'config', label: t('proxyLog.tabConfig') },
            { value: 'sys', label: t('proxyLog.sysTitle') },
            { value: 'wizard', label: t('forwardProxy.helpTitle') },
            { value: 'log', label: t('proxyLog.tabLog') },
          ]}
        />
      </div>
      {view === 'config' ? (
      <>
      {/* One full-height card: the header row is a fixed flex-shrink:0 zone
          inside the card frame, only the body below scrolls — the border stays
          a complete rectangle instead of two stacked cards. */}
      <div className="card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }}>
        <div className="card-header" style={{ flexShrink: 0, padding: '20px 20px 12px', marginBottom: 0, borderBottom: '1px solid var(--divider)' }}>
          <div className="card-title">
            <ShieldCheck size={18} color="var(--accent)" />
            <span>{t('forwardProxy.title')}</span>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <a className="btn" href="/api/admin/proxy/ca" download style={{ gap: '6px' }}>
              {t('forwardProxy.caBtn')}
            </a>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              <Save size={14} />
              <span>{t('forwardProxy.saveBtn')}</span>
            </button>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px 20px' }}>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)', marginBottom: '12px', whiteSpace: 'pre-line' }}>
          {t('forwardProxy.hint')}
        </div>

        {/* Live runtime status chip */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: dotColor,
              boxShadow: dotColor !== 'var(--text-dim)' ? `0 0 8px ${dotColor}` : undefined,
              flexShrink: 0,
            }}
          />
          <span>{statusText}</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '640px' }}>
          {/* ── Section 1: listener & enable ── */}
          <div className="sub-card">
            <div style={SEC_TITLE}>{t('forwardProxy.secListener')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'var(--text-md)', cursor: 'pointer' }}>
                <span>{t('forwardProxy.enable')}</span>
                <Switch checked={fp.enabled ?? false} onChange={v => setFp({ ...fp, enabled: v })} />
              </label>
              <div>
                <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('forwardProxy.port')}</label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder={String(DEFAULT_FORWARD_PROXY_PORT)}
                  value={fp.port ?? ''}
                  onChange={e => {
                    const digits = e.target.value.replace(/[^0-9]/g, '');
                    setFp({ ...fp, port: digits === '' ? undefined : parseInt(digits, 10) });
                  }}
                  className="input"
                />
              </div>
            </div>
          </div>

          {/* ── Section 2: bypass hosts — per-row egress choice (direct tunnel vs via outbound proxy) ── */}
          <div className="sub-card">
            <div style={SEC_TITLE}>{t('forwardProxy.bypassHosts')}</div>
            <div>
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'var(--text-md)', cursor: 'pointer' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  {t('forwardProxy.viaOutboundProxy')}
                  <InfoTip text={t('forwardProxy.viaOutboundProxyHint')} />
                </span>
                <Switch checked={fp.viaOutboundProxy ?? false} onChange={v => setFp({ ...fp, viaOutboundProxy: v })} />
              </label>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '14px' }}>
              {bypassRows.map((row, idx) => (
                <div key={idx} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    type="text"
                    placeholder={t('forwardProxy.pattern')}
                    value={row.host}
                    onChange={e => {
                      const next = [...bypassRows];
                      next[idx] = { ...next[idx], host: e.target.value };
                      setBypassRows(next);
                    }}
                    className="input"
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0 }}>
                    <label
                      style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: 'var(--text-xs)', color: 'var(--text-dim)', cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >
                    <input
                      type="checkbox"
                      checked={row.viaProxy}
                      onChange={e => {
                        const next = [...bypassRows];
                        next[idx] = { ...next[idx], viaProxy: e.target.checked };
                        setBypassRows(next);
                      }}
                    />
                    {t('forwardProxy.bypassViaProxy')}
                  </label>
                    <InfoTip text={t('forwardProxy.bypassViaProxyHint')} />
                  </div>
                  <button
                    className="btn btn-danger btn-sm"
                    style={{ padding: '4px 8px' }}
                    onClick={() => setBypassRows(bypassRows.filter((_, i) => i !== idx))}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button
                className="btn btn-sm"
                style={{ alignSelf: 'flex-start', gap: '6px' }}
                onClick={() => setBypassRows([...bypassRows, { host: '', viaProxy: false }])}
              >
                <Plus size={14} />
                <span>{t('forwardProxy.addPattern')}</span>
              </button>
            </div>
          </div>

          {/* ── Section 3: traffic log (all switches hot-apply on save) — collapsible ── */}
          <details
            className="sub-card"
            open={fold.log}
            onToggle={e => setFold(f => ({ ...f, log: (e.target as HTMLDetailsElement).open }))}
          >
            <summary style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ChevronDown
                size={14}
                color="var(--text-dim)"
                style={{ flexShrink: 0, transform: fold.log ? 'none' : 'rotate(-90deg)', transition: 'transform 0.15s' }}
              />
              <span style={{ ...SEC_TITLE, marginBottom: 0 }}>{t('forwardProxy.secLog')}</span>
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '12px' }}>
              <div>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'var(--text-md)', cursor: 'pointer' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    {t('proxyLog.switch')}
                    <InfoTip text={t('proxyLog.switchHint')} />
                  </span>
                  <Switch checked={fp.accessLog?.enabled ?? true} onChange={v => setFp({ ...fp, accessLog: { ...(fp.accessLog || {}), enabled: v } })} />
                </label>
              </div>
              <div>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'var(--text-md)', cursor: 'pointer' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    {t('proxyLog.persistSwitch')}
                    <InfoTip text={t('proxyLog.persistHint')} />
                  </span>
                  <Switch checked={fp.accessLog?.persist ?? true} onChange={v => setFp({ ...fp, accessLog: { ...(fp.accessLog || {}), persist: v } })} />
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', flexShrink: 0 }}>{t('proxyLog.persistDays')}</span>
                  <input
                    type="number"
                    min={PROXY_ACCESS_LOG_PERSIST_DAYS_MIN}
                    max={PROXY_ACCESS_LOG_PERSIST_DAYS_MAX}
                    className="input"
                    style={{ width: '90px', fontSize: 'var(--text-sm)' }}
                    value={fp.accessLog?.persistDays ?? DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS}
                    onChange={e => {
                      const n = Math.min(PROXY_ACCESS_LOG_PERSIST_DAYS_MAX, Math.max(PROXY_ACCESS_LOG_PERSIST_DAYS_MIN, Math.floor(Number(e.target.value) || DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS)));
                      setFp({ ...fp, accessLog: { ...(fp.accessLog || {}), persistDays: n } });
                    }}
                  />
                </div>
              </div>
            </div>
          </details>

          {/* ── Section 4: unresolved model-name policy — MITM leg only (ADR-0003 §7a) — collapsible ── */}
          <details
            className="sub-card"
            open={fold.miss}
            onToggle={e => setFold(f => ({ ...f, miss: (e.target as HTMLDetailsElement).open }))}
          >
            <summary style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ChevronDown
                size={14}
                color="var(--text-dim)"
                style={{ flexShrink: 0, transform: fold.miss ? 'none' : 'rotate(-90deg)', transition: 'transform 0.15s' }}
              />
              <span style={{ ...SEC_TITLE, marginBottom: 0 }}>{t('forwardProxy.unresolvedTitle')}</span>
            </summary>
            <div style={{ marginTop: '12px' }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)', marginBottom: '10px', whiteSpace: 'pre-line' }}>
              {t('forwardProxy.unresolvedHint')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '520px' }}>
              <div>
                <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
                  {t('forwardProxy.unresolvedOnMiss')}
                </label>
                <Combobox
                  value={fp.unresolvedModel?.onMiss ?? 'auto'}
                  onChange={v =>
                    setFp({ ...fp, unresolvedModel: { ...fp.unresolvedModel, onMiss: v } })
                  }
                  options={onMissOptions(fp.unresolvedModel?.onMiss ?? 'auto')}
                  style={{ fontFamily: FONT_MONO }}
                />
              </div>
              <div>
                <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
                  {t('forwardProxy.unresolvedHosts')}
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {missRows.map((row, idx) => (
                    <div key={idx} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <input
                        type="text"
                        spellCheck={false}
                        placeholder={t('forwardProxy.unresolvedHostPlaceholder')}
                        value={row.host}
                        onChange={e => {
                          const next = [...missRows];
                          next[idx] = { ...next[idx], host: e.target.value };
                          setMissRows(next);
                        }}
                        className="input"
                        style={{ flex: 1, minWidth: 0 }}
                      />
                      <Combobox
                        value={row.onMiss}
                        onChange={v => {
                          const next = [...missRows];
                          next[idx] = { ...next[idx], onMiss: v };
                          setMissRows(next);
                        }}
                        options={onMissOptions(row.onMiss)}
                        style={{ flex: 1, minWidth: 0, fontFamily: FONT_MONO }}
                      />
                      <button
                        className="btn btn-danger btn-sm"
                        style={{ padding: '4px 8px' }}
                        onClick={() => setMissRows(missRows.filter((_, i) => i !== idx))}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    className="btn btn-sm"
                    style={{ alignSelf: 'flex-start', gap: '6px' }}
                    onClick={() => setMissRows([...missRows, { host: '', onMiss: 'auto' }])}
                  >
                    <Plus size={14} />
                    <span>{t('forwardProxy.addHost')}</span>
                  </button>
                </div>
              </div>
            </div>
            </div>
          </details>

          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
            {t('forwardProxy.caHint')} · {t('forwardProxy.hostNote')}
          </div>
          </div>
        </div>
      </div>
      </>
      ) : view === 'sys' ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <SystemProxyCard />
        </div>
      ) : view === 'wizard' ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* Setup wizard card (its own tab; the gap comes from the scroll
           region's flex column) */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <BookOpen size={18} color="var(--accent)" />
            <span>{t('forwardProxy.helpTitle')}</span>
          </div>
        </div>

        {!(fp.enabled ?? false) ? (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 'var(--leading-relaxed)', maxWidth: '640px' }}>
            {t('forwardProxy.wizardDisabledHint')}
          </div>
        ) : (
          <>
          {/* Horizontal clickable stepper */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '20px', overflowX: 'auto', paddingBottom: '4px' }}>
          {steps.map((s, i) => {
            const isActive = s.id === active.id;
            return (
              <React.Fragment key={s.id}>
                {i > 0 && <div style={{ width: '56px', height: '1px', background: 'var(--card-border)', flexShrink: 0 }} />}
                <button
                  onClick={() => setStep(s.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px 12px 6px 6px',
                    borderRadius: '999px',
                    cursor: 'pointer',
                    background: isActive ? 'var(--chip-bg)' : 'transparent',
                    border: isActive ? '1px solid var(--card-border)' : '1px solid transparent',
                    color: isActive ? 'var(--text-main)' : 'var(--text-muted)',
                    fontSize: 'var(--text-sm)',
                    fontWeight: isActive ? 'var(--font-semibold)' : 'var(--font-medium)',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  <span style={stepCircle(isActive)}>{s.id}</span>
                  <span>{s.title}</span>
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {/* Step content panel */}
        <div style={{ minHeight: '140px', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 'var(--leading-relaxed)', maxWidth: '760px' }}>
          {active.body}
        </div>

        {/* Wizard navigation */}
        <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', gap: '20px', marginTop: '20px', paddingTop: '14px', borderTop: '1px solid var(--divider)' }}>
          <button
            className="btn btn-sm"
            disabled={stepIndex <= 0}
            onClick={() => setStep(steps[Math.max(0, stepIndex - 1)].id)}
            style={{ gap: '6px' }}
          >
            <ChevronLeft size={13} />
            <span>{t('forwardProxy.wizardPrev')}</span>
          </button>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{stepIndex + 1} / {steps.length}</span>
          <button
            className="btn btn-sm"
            disabled={stepIndex >= steps.length - 1}
            onClick={() => setStep(steps[Math.min(steps.length - 1, stepIndex + 1)].id)}
            style={{ gap: '6px' }}
          >
            <span>{t('forwardProxy.wizardNext')}</span>
            <ChevronRight size={13} />
          </button>
        </div>
          </>
        )}
      </div>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <ProxyAccessLogCard />
        </div>
      )}
    </div>
  );
};
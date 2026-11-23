import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Activity, RefreshCw, Eraser, Copy, Download, FileDown, Maximize2, Minimize2, ChevronDown, Inbox, Terminal } from 'lucide-react';
import { api, type ProxyAccessEvent, type PluginTrafficEvent } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Combobox } from '../components/Combobox';
import { SegGroup } from '../components/SegGroup';
import { Pagination } from '../components/Pagination';
import { Drawer } from '../components/Drawer';
import { Prose, proseIsLong } from '../components/Prose';
import { applicableDecoders, decoderLabel, hexDumpToBytes, type DecoderContext, type SideDecoder } from '../lib/sideDecoders';
import { DEFAULT_TRAFFIC_BODY_PREVIEW_BYTES } from '../lib/defaults';
import { copyToClipboard } from '../lib/clipboard';
import { saveBlobAs, startDownload } from '../lib/download-manager';
import { FONT_MONO } from '../lib/fonts';
import { FONT_MONO_COLOR, SEC_TITLE } from '../lib/pageStyle';

/**
 * Traffic Log — the inbound forward proxy's own observation surface, a sibling
 * of the access SETTINGS page (ADR-0018): the rule table says what the proxy
 * will do, this page shows what it did, for every non-intercepted HTTP exchange
 * and CONNECT tunnel decision, newest first. One row click opens the detail
 * drawer, whose shell is shared by the client-gateway plugin feeds (Connect-RPC,
 * dissected) — one timeline, one filter set.
 *
 * Events persist as daily JSONL files under <ocrHome>/forward-proxy/access-log/
 * (survive restarts). The enabled / persist / persistDays knobs stay on the
 * settings page in config.yaml `forwardProxy.accessLog` (they are saved with the
 * forwardProxy section, not per-view); this page only reflects them (the ON/OFF
 * chip) and never writes config.
 */
/** Default rows per page — page 1 follows the live tail, so the default is generous. */
const PAGE_SIZE = 100;
const PAGE_SIZES = [20, 50, 100, 200];
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
const fmtBytes = (n: number): string => (n === 0 ? '0' : n < 1024 ? String(n) : `${(n / 1024).toFixed(1)}K`);
/** One collapsible section of the detail drawer (headers / body). When
 *  `onToggle` is given (content is long), an expand/collapse glyph sits at
 *  the summary's right edge, driving the same state as the in-content toggle.
 *  The body section instead overlays its glyph INSIDE the content frame
 *  (top-right corner), so the control sits on the very surface it expands. */
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
 * resets to Request (read the request first, then compare the response)
 * per opened row.
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

/**
 * ── shared exchange detail ────────────────────────────────────────────────
 * ONE renderer for every captured exchange, whatever produced it: the proxy
 * access log (HTTP/1, HTTP/2, CONNECT) and the client-gateway plugin feeds
 * (Connect-RPC, dissected). The row kind only decides how the MODEL is built —
 * the drawer shell (side tabs → collapsible sections → clamped prose →
 * expand glyph) is identical, so the two never drift apart again.
 */
export interface DetailSideModel {
  headersTitle: string;
  /** Pre-formatted `name: value` lines, or null when nothing was captured. */
  headers: string | null;
  bodyTitle: string;
  /** Captured window bytes — the input every decoder claims. */
  bytes?: Uint8Array | null;
  /** Full captured size, when the gateway knows it. Drives the size badge and
   *  the truncation state shown on the body title. */
  bodyBytes?: number;
  /** True when the capture itself stopped at the capability cap (the body on
   *  disk is already short — no amount of reading recovers the tail). */
  bodyTruncated?: boolean;
  /** Opaque body token: the drawer loads a preview from it and offers it as
   *  the download. One shape for every row, no storage detail. */
  bodyToken?: string;
  /** The inline `bytes` are only a first-paint prefix (a plugin feed ships a
   *  small hex preview); once the token resolves, its bytes replace them. */
  inlineIsPreview?: boolean;
  /** Plugin dissector layers for this side (server-side protocol knowledge). */
  layers?: { name: string; frames?: unknown[] }[];
  contentType?: string;
  /** Plugin whose dissector owns `layers` — shown as this side's decoder name. */
  decoderName?: string;
  /** Extra line above the body (e.g. "204 → no body by HTTP semantics"). */
  note?: string | null;
  /** Localized "nothing captured" text. */
  empty: string;
}

/** Bytes of a persisted core body, loaded on demand (capped by the capture
 *  config, so the full fetch is safe). */
const useBodyBytes = (token: string | undefined): { bytes: Uint8Array | null; error: boolean } => {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!token) return;
    let alive = true;
    setBytes(null);
    setError(false);
    api
      .getTrafficBody(token)
      .then((buf) => {
        if (alive) setBytes(new Uint8Array(buf));
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [token]);
  return { bytes, error };
};

/** Base filename for an export: the capture's own name, never a vendor verb. */
const exportBase = (side: DetailSideModel): string => {
  // The token encodes {kind, ref, decoder} — decode the ref for a stable,
  // vendor-neutral filename (`pa-…-req`, `cx-…-res`).
  try {
    const meta = JSON.parse(atob((side.bodyToken ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as { r?: string };
    const name = (meta.r ?? '').split('/').pop() ?? '';
    return name.replace(/\.[a-z0-9]+$/i, '') || 'body';
  } catch {
    return 'body';
  }
};

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
};

/**
 * One side's pane: headers section + body section. Owns its own expansion and
 * decoder choice; remounted per side via `key`, so switching tabs never
 * inherits the other side's fold state.
 *
 * The body is rendered through the decoder REGISTRY (lib/sideDecoders): hex is
 * the floor, and the default view is the most specific decoder that claims the
 * bytes — a plugin dissector tree, an image, JSON, or plain text.
 */
const DetailSidePane: React.FC<{ side: DetailSideModel }> = ({ side }) => {
  const { t } = useI18n();
  const toast = useToast();
  const [exp, setExp] = useState({ h: false, b: false });
  const flip = (k: keyof typeof exp, v: boolean): void => setExp((st) => ({ ...st, [k]: v }));
  const fileBytes = useBodyBytes(side.bodyToken);
  /**
   * Plugin feeds ship a tiny hex preview for first paint; the token addresses
   * the FULL capture. Once it resolves, prefer those bytes and cap what
   * reaches the DOM at the shared preview window — the rest stays one
   * download away (ADR-0017 §5), so a multi-megabyte body never lands here.
   */
  const tokenBytes = fileBytes.bytes;
  const preferToken = side.inlineIsPreview === true && tokenBytes !== null;
  const source: Uint8Array | null = (preferToken ? tokenBytes : (side.bytes ?? tokenBytes)) ?? null;
  // Memoized so the decoder list is not recomputed (and no view object is
  // reallocated) on every render: the slice is identity-stable across renders.
  const bytes = useMemo(
    () =>
      preferToken && source !== null && source.length > DEFAULT_TRAFFIC_BODY_PREVIEW_BYTES
        ? source.subarray(0, DEFAULT_TRAFFIC_BODY_PREVIEW_BYTES)
        : source,
    [source, preferToken]
  );
  const bodyBytes = side.bodyBytes ?? source?.length ?? 0;
  const windowed = Boolean(bytes && bodyBytes > bytes.length);
  const badgeParts: string[] = [];
  if (side.bodyBytes) badgeParts.push(fmtBytes(side.bodyBytes));
  if (side.bodyTruncated) badgeParts.push(t('proxyLog.truncated'));
  else if (windowed) badgeParts.push(t('proxyLog.previewWindowed'));
  const bodyBadge = badgeParts.length > 0 ? ` · ${badgeParts.join(' · ')}` : '';
  const ctx: DecoderContext = { bytes: bytes ?? null, bodyBytes, windowed, contentType: side.contentType, layers: side.layers, decoderName: side.decoderName };
  const decoders = useMemo(() => applicableDecoders(ctx), [bytes, bodyBytes, side.contentType, side.layers]);
  const [picked, setPicked] = useState<string | null>(null);
  /** Default = the most specific applicable decoder (hex when nothing claims). */
  const active = decoders.find((d) => d.id === picked) ?? decoders[0];
  const output = useMemo(() => {
    try {
      return active ? active.render(ctx) : null;
    } catch {
      return null;
    }
  }, [active, bytes, bodyBytes, side.contentType, side.layers]);
  const empty = <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{side.empty}</div>;
  return (
    <>
      <DetailSection
        title={side.headersTitle}
        expanded={exp.h}
        onToggle={proseIsLong(side.headers ?? '', 10) ? () => flip('h', !exp.h) : undefined}
      >
        {side.headers ? <Prose text={side.headers} clamp={10} open={exp.h} onOpenChange={(v) => flip('h', v)} hideToggle scrollClamp /> : empty}
      </DetailSection>
      <DetailSection title={`${side.bodyTitle}${bodyBadge}`} expanded={exp.b}>
        {(decoders.length > 1 || side.bodyToken || (output && output.kind !== 'none')) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
            {decoders.length > 1 && (
              <SegGroup
                size="lg"
                optionMinWidth={64}
                value={active?.id ?? ''}
                onChange={setPicked}
                options={decoders.map((d) => ({ value: d.id, label: decoderLabel(d, t) }))}
              />
            )}
            {/* Two downloads, two artifacts — never one ambiguous button:
                RAW     the captured bytes as they arrived (lossless, streamed
                        by the gateway, independent of any decoder);
                DECODED whatever the ACTIVE decoder rendered (frame tree /
                        text / image) — derived, and limited to the preview
                        window. */}
            <span style={{ display: 'inline-flex', gap: '6px', marginLeft: 'auto' }}>
              {side.bodyToken && (
                <button
                  type="button"
                  className="btn"
                  style={{ gap: '4px', display: 'inline-flex', alignItems: 'center' }}
                  onClick={() => {
                    void startDownload({
                      url: `/api/admin/traffic-body/${encodeURIComponent(side.bodyToken!)}`,
                      fallbackName: `${exportBase(side)}-raw.bin`,
                    });
                  }}
                >
                  <Download size={12} />
                  <span>{t('proxyLog.downloadRaw')}</span>
                </button>
              )}
              {output && output.kind !== 'none' && (
                <button
                  type="button"
                  className="btn"
                  style={{ gap: '4px', display: 'inline-flex', alignItems: 'center' }}
                  title={windowed ? t('proxyLog.exportWindowedHint') : t('proxyLog.exportDecodedHint')}
                  onClick={() => {
                    const base = exportBase(side);
                    if (output.kind === 'image') {
                      void saveBlobAs(`${base}-${active!.id}.${IMAGE_EXT[output.mime] ?? 'bin'}`, new Blob([output.bytes.slice().buffer as ArrayBuffer], { type: output.mime }));
                      return;
                    }
                    const ext = active!.id === 'hex' || active!.id === 'pdf' ? 'txt' : 'json';
                    void saveBlobAs(`${base}-${active!.id}.${ext}`, new Blob([output.text], { type: 'text/plain;charset=utf-8' }));
                  }}
                >
                  <FileDown size={12} />
                  <span>{t('proxyLog.exportDecoded')}</span>
                </button>
              )}
            </span>
          </div>
        )}
        {side.note && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: '6px' }}>{side.note}</div>}
        {fileBytes.error ? (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxyLog.hexLoadFailed')}</div>
        ) : output?.kind === 'image' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <img
              src={`data:${output.mime};base64,${btoa(String.fromCharCode(...output.bytes))}`}
              alt={side.bodyTitle}
              style={{ maxWidth: '100%', border: '1px solid var(--divider)', borderRadius: '4px' }}
            />
            {windowed && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{t('proxyLog.previewWindowed')}</div>}
          </div>
        ) : output?.kind === 'text' ? (
          <div style={{ position: 'relative' }}>
            <Prose text={output.text} clamp={14} open={exp.b} onOpenChange={(v) => flip('b', v)} hideToggle scrollClamp />
            {/* Overlay actions inside the content frame — they sit exactly on the
                surface they act on: copy what the active decoder rendered, and
                the expand toggle that owns this frame. */}
            <span style={{ position: 'absolute', top: 6, right: 6, zIndex: 1, display: 'inline-flex', gap: 4 }}>
              <button
                type="button"
                onClick={() => {
                  void copyToClipboard(output.text).then((ok) =>
                    ok ? toast.success(t('proxyLog.bodyCopied')) : toast.error(t('proxyLog.copyFailed')),
                  );
                }}
                title={t('proxyLog.copyBody')}
                style={{ background: 'var(--btn-bg)', border: '1px solid var(--divider)', borderRadius: 6, padding: '3px 5px', cursor: 'pointer', color: 'var(--text-dim)', display: 'inline-flex' }}
              >
                <Copy size={12} />
              </button>
              <button
                type="button"
                onClick={() => flip('b', !exp.b)}
                title={exp.b ? t('captures.collapse') : t('captures.expand')}
                style={{ background: 'var(--btn-bg)', border: '1px solid var(--divider)', borderRadius: 6, padding: '3px 5px', cursor: 'pointer', color: 'var(--text-dim)', display: 'inline-flex' }}
              >
                {exp.b ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
            </span>
          </div>
        ) : (
          empty
        )}
      </DetailSection>
    </>
  );
};

/** The drawer body itself: meta line(s) → side tabs → the active side's pane. */
const ExchangeDetail: React.FC<{
  meta: React.ReactNode;
  note?: string | null;
  warn?: string | null;
  req: DetailSideModel;
  res: DetailSideModel;
  defaultSide?: 'req' | 'res';
}> = ({ meta, note, warn, req, res, defaultSide = 'req' }) => {
  const { t } = useI18n();
  const [side, setSide] = useState<'req' | 'res'>(defaultSide);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {note && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{note}</div>}
      {warn && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{warn}</div>}
      {meta}
      <SegGroup
        size="lg"
        optionMinWidth={88}
        value={side}
        onChange={(v) => setSide(v as 'req' | 'res')}
        options={[
          { value: 'req', label: t('proxyLog.tabReq') },
          { value: 'res', label: t('proxyLog.tabRes') },
        ]}
      />
      <DetailSidePane key={side} side={side === 'req' ? req : res} />
    </div>
  );
};

const ProxyAccessDetail: React.FC<{ ev: ProxyAccessEvent }> = ({ ev }) => {
  const { t } = useI18n();
  const toast = useToast();

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
    if (await copyToClipboard(text)) toast.success(okMsg);
    else toast.error(t('proxyLog.copyFailed'));
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
  if (ev.kind === 'connect') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {ev.note && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{ev.note}</div>}
        {urlRow}
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxyLog.detailNone')}</div>
      </div>
    );
  }
  const emptyText = t('proxyLog.captureEmpty');
  /** Inline bodies arrive as text, or as a hex dump when the capture could not
   *  be treated as text — both are just bytes to the decoder registry. */
  const inlineBytes = (text: string | undefined, isHex: boolean | undefined): Uint8Array | null => {
    if (!text) return null;
    if (isHex) return hexDumpToBytes(text);
    return new TextEncoder().encode(text);
  };
  return (
    <ExchangeDetail
      note={ev.note}
      warn={ev.truncated ? t('proxyLog.truncated') : null}
      meta={urlRow}
      req={{
        headersTitle: t('proxyLog.reqHeaders'),
        headers: asText(ev.requestHeaders),
        bodyTitle: t('proxyLog.reqBody'),
        bytes: inlineBytes(ev.requestBody, ev.reqBodyFormat === 'hex'),
        bodyToken: ev.reqBodyToken,
        contentType: ev.requestHeaders?.['content-type'],
        empty: emptyText,
      }}
      res={{
        headersTitle: t('proxyLog.resHeaders'),
        headers: asText(ev.responseHeaders),
        bodyTitle: t('proxyLog.resBody'),
        bytes: inlineBytes(ev.responseBody, ev.resBodyFormat === 'hex'),
        bodyToken: ev.resBodyToken,
        contentType: ev.responseHeaders?.['content-type'],
        note: ev.status === 204 || ev.status === 304 ? t('proxyLog.noBodyStatus', { status: ev.status }) : null,
        empty: emptyText,
      }}
    />
  );
};

/** Case-insensitive glob (`*` / `?`) anchored to the whole string. */
const globToRe = (glob: string): RegExp =>
  new RegExp(
    `^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
    'i'
  );

/** Default kind filter: `http` — CONNECT rows are mostly duplicate tunnel-setup noise. */
const KIND_DEFAULT = 'http';

/**
 * Drawer body for one DISSECTED plugin exchange. Same shell as every other
 * row (ExchangeDetail): the dissector output simply arrives as this side's
 * `decoded` rendering, so the hex ⇄ decoded switch exists exactly where a
 * decoder recognized the bytes — and nowhere else.
 */
const PluginAccessDetail: React.FC<{ ev: PluginTrafficEvent; decoder: string }> = ({ ev, decoder }) => {
  const { t } = useI18n();
  const headerText = (bag: Record<string, string> | undefined): string | null =>
    bag && Object.keys(bag).length > 0
      ? Object.entries(bag).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`).join('\n')
      : null;
  const bytesOf = (hex: string | undefined): Uint8Array | null =>
    hex ? new Uint8Array((hex.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16))) : null;
  const layersOf = (side: 'req' | 'res'): { name: string; frames?: unknown[] }[] =>
    (ev.decoded?.layers ?? []).filter((l) => (l.side ?? 'req') === side).map((l) => ({ name: l.name, frames: l.frames }));
  const meta = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', color: 'var(--text-main)', flexShrink: 0 }}>{ev.method ?? 'GET'}</span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={`${ev.authority ?? ''}${ev.path ?? ''}`}>
          {ev.authority ?? ''}{ev.path ?? ''}
        </span>
      </div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>
        {ev.status ?? '—'} · {ev.durationMs ?? '—'}ms · {ev.leg ?? '—'} · {ev.reqContentType ?? '—'} → {ev.resContentType ?? '—'}
        <br />
        {t('proxyLog.capturedBy', { decoder })}
      </div>
    </div>
  );
  const emptyText = t('proxyLog.captureEmpty');
  return (
    <ExchangeDetail
      warn={ev.reqTruncated || ev.resTruncated ? t('proxyLog.bodyTruncated') : null}
      meta={meta}
      req={{
        headersTitle: t('proxyLog.reqHeaders'),
        headers: headerText(ev.reqHeaders),
        bodyTitle: t('proxyLog.reqBody'),
        bytes: bytesOf(ev.reqHex),
        bodyBytes: ev.reqBodyBytes,
        bodyTruncated: ev.reqTruncated,
        inlineIsPreview: true,
        layers: layersOf('req'),
        contentType: ev.reqContentType,
        decoderName: decoder,
        bodyToken: ev.reqBodyToken,
        empty: emptyText,
      }}
      res={{
        headersTitle: t('proxyLog.resHeaders'),
        headers: headerText(ev.resHeaders),
        bodyTitle: t('proxyLog.resBody'),
        bytes: bytesOf(ev.resHex),
        bodyBytes: ev.resBodyBytes,
        bodyTruncated: ev.resTruncated,
        inlineIsPreview: true,
        layers: layersOf('res'),
        contentType: ev.resContentType,
        decoderName: decoder,
        bodyToken: ev.resBodyToken,
        empty: emptyText,
      }}
    />
  );
};

/** One merged log row: either a proxy-access event (kind http/connect) or a
 *  client-gateway plugin's DISSECTED exchange (kind = the decoder/plugin id).
 *  One timeline, one filter set — the Wireshark-style decoder output is just a
 *  third kind in the same table, never a separate view. */
type UnifiedLogRow =
  | { rid: string; source: 'proxy'; isProxy: true; tsNum: number; ev: ProxyAccessEvent }
  | { rid: string; source: string; isProxy: false; tsNum: number; ev: PluginTrafficEvent };

/**
 * Row projection — the request is split into its Wireshark-ish parts so each
 * column carries exactly one fact: kind (transport family) / proto (wire
 * protocol) / host / method / path.
 */
/**
 * Three orthogonal axes, never one mixed column (Chrome DevTools' Type /
 * Protocol / Content-Type split; mitmproxy's flow detail):
 *
 *   kind  what kind of exchange this is   HTTP request | CONNECT tunnel | WS upgrade
 *   proto the NETWORK protocol            HTTP/1.1 | HTTP/2
 *   rpc   the RPC FRAMEWORK / wire convention above HTTP   — | ConnectRPC | gRPC
 *
 * ConnectRPC (Buf — the spelling is the vendor's own) is an RPC framework, not
 * an "application protocol" layer of its own: it defines path naming
 * (`/pkg.Service/Method`), the 5-byte streaming envelope, error mapping and
 * trailers, and runs that over plain HTTP with protobuf (or JSON) as the
 * message encoding. gRPC is the same shape of thing. Lumping them into the
 * proto column
 * an "application protocol" layer of its own: it defines path naming
 * (`/pkg.Service/Method`), the 5-byte streaming envelope, error mapping and
 * trailers, and runs that over plain HTTP with protobuf (or JSON) as the
 * message encoding. gRPC is the same shape of thing. Lumping them into the
 * proto column mixed an RPC convention with a transport; calling them
 * "application protocol" would collide
 * with "HTTP is the application layer"; and a bare `Connect` badge collides
 * with the `CONNECT` tunnel method in the kind column — hence `ConnectRPC`.
 */
/**
 * The ONE row identity both sides agree on: the persisted `id` when the feed
 * writes one, else the timestamp (rows predating ids). Deletion keys and the
 * React key both come from here — never a positional index, which shifts as
 * soon as a neighbour is deleted.
 */
const rowKey = (ev: ProxyAccessEvent | PluginTrafficEvent): string =>
  (ev as { id?: string }).id ?? (ev as { ts?: string }).ts ?? '';

const kindOf = (r: UnifiedLogRow): string => {
  if (r.isProxy) {
    if (r.ev.kind === 'connect') return 'connect';
    if (r.ev.wire === 'ws') return 'ws';
    return 'http';
  }
  return 'http';
};
const protoOf = (r: UnifiedLogRow): string =>
  r.isProxy ? (r.ev.wire === 'h2' ? 'h2' : 'h1') : String(r.ev.leg ?? '').startsWith('h2') ? 'h2' : 'h1';

/**
 * Application protocol above HTTP, with the payload encoding it carries.
 * Claimed, most reliable first: Connect frames the dissector actually framed,
 * a Connect/gRPC content type, or an RPC-shaped path (`/pkg.Service/Method`)
 * with a protobuf body — which is exactly Cursor's wire.
 */
const rpcOf = (r: UnifiedLogRow): { rpc: 'connect' | 'grpc' | null; enc: 'proto' | 'json' | null } => {
  // Proxy rows only expose their headers; gateway rows carry parsed content types.
  const ct = r.isProxy
    ? `${r.ev.requestHeaders?.['content-type'] ?? ''} ${r.ev.responseHeaders?.['content-type'] ?? ''}`
    : `${r.ev.reqContentType ?? ''} ${r.ev.resContentType ?? ''}`;
  const enc: 'proto' | 'json' | null = /application\/(connect\+|x-)?proto|application\/grpc/i.test(ct)
    ? 'proto'
    : /json/i.test(ct)
      ? 'json'
      : null;
  if (r.isProxy) return { rpc: null, enc };
  const layers = r.ev.decoded?.layers ?? [];
  if (layers.some((l) => l.name === 'connect-frames')) return { rpc: 'connect', enc };
  if (/application\/connect\+/i.test(ct)) return { rpc: 'connect', enc };
  if (/application\/grpc/i.test(ct)) return { rpc: 'grpc', enc };
  if (enc === 'proto' && /^\/[\w.]+\/[\w]+$/.test(pathOf(r))) return { rpc: 'connect', enc };
  return { rpc: null, enc };
};
const hostOf = (r: UnifiedLogRow): string => (r.isProxy ? r.ev.host : r.ev.authority ?? '');
const methodOf = (r: UnifiedLogRow): string | undefined => r.ev.method;
const pathOf = (r: UnifiedLogRow): string => r.ev.path ?? '';
/**
 * Request / response body sizes. Proxy rows count wire bytes (what the tap
 * saw); gateway rows count the captured body bytes (what landed on disk).
 * Two columns, one number each — a shared ↑/↓ cell forces the reader to
 * remember which side came first.
 */
const bodySizes = (r: UnifiedLogRow): { up: number; down: number } =>
  r.isProxy
    ? { up: r.ev.reqBytes, down: r.ev.respBytes }
    : { up: r.ev.reqBodyBytes ?? 0, down: r.ev.resBodyBytes ?? 0 };
/**
 * The decoder this row resolves to — the TOP of the fallback chain, i.e. what
 * the drawer will render by default. The rest of the chain (every decoder that
 * also claims the bytes) is offered as switches in the detail view; the list
 * column only answers "what does this row decode as".
 *
 * Chosen from the same registry over the same inputs the drawer uses, so the
 * column can never disagree with the detail view. Provider decoders show the
 * plugin's own name (`cursor-gateway`), built-ins their format (`Hex`, `JSON`, …).
 */
const rowDecoder = (r: UnifiedLogRow): SideDecoder | undefined => {
  const found = decodersOf(r);
  // Both sides claim independently; the response is the body you read, so it
  // wins a tie, and a more specific request decoder still beats a generic one.
  const resTop = found.res[0];
  const reqTop = found.req[0];
  if (resTop && reqTop) return resTop.rank >= reqTop.rank ? resTop : reqTop;
  return resTop ?? reqTop;
};

/** Decoders that claim THIS row, per side, most specific first. */
const decodersOf = (r: UnifiedLogRow): { req: SideDecoder[]; res: SideDecoder[] } => {
  const fromBytes = (bytes: Uint8Array | null, contentType?: string, layers?: { name: string }[]): SideDecoder[] =>
    applicableDecoders({ bytes, bodyBytes: bytes?.length, windowed: false, contentType, layers, decoderName: r.source });

  const proxyBytes = (text: string | undefined, isHex: boolean | undefined): Uint8Array | null => {
    if (!text) return null;
    return isHex ? hexDumpToBytes(text) : new TextEncoder().encode(text);
  };

  if (r.isProxy) {
    return {
      req: fromBytes(proxyBytes(r.ev.requestBody, r.ev.reqBodyFormat === 'hex'), r.ev.requestHeaders?.['content-type']),
      res: fromBytes(proxyBytes(r.ev.responseBody, r.ev.resBodyFormat === 'hex'), r.ev.responseHeaders?.['content-type']),
    };
  }
  const layers = r.ev.decoded?.layers ?? [];
  const hexOf = (h: string | undefined): Uint8Array | null =>
    h ? new Uint8Array((h.match(/.{2}/g) ?? []).map((c) => parseInt(c, 16))) : null;
  return {
    req: fromBytes(hexOf(r.ev.reqHex), r.ev.reqContentType, layers.filter((l) => (l.side ?? 'req') === 'req')),
    res: fromBytes(hexOf(r.ev.resHex), r.ev.resContentType, layers.filter((l) => (l.side ?? 'req') === 'res')),
  };
};

const rowStatus = (r: UnifiedLogRow): number | undefined => r.ev.status;
const rowDuration = (r: UnifiedLogRow): number | undefined => r.ev.durationMs;
const PROTO_LABEL_KEY: Record<string, string> = {
  h1: 'proxyLog.protoH1',
  h2: 'proxyLog.protoH2',
};
const KIND_LABEL_KEYS: Record<string, string> = {
  http: 'proxyLog.kindHttp',
  connect: 'proxyLog.kindConnect',
  ws: 'proxyLog.protoWs',
};

const TrafficLogCard: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [enabled, setEnabled] = useState(true);
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  /** Free-text filter over kind/method/host/path/status/note. */
  const [query, setQuery] = useState('');
  /** Advanced filters — each optional, AND-combined with the free-text query. `http` is the
   *  default kind: CONNECT rows are mostly duplicate tunnel-setup noise. */
  const [fKind, setFKind] = useState('http');
  /** Transport filter (HTTP/1.1 vs HTTP/2) — independent of kind and rpc. */
  const [fProto, setFProto] = useState('');
  const [fRpc, setFRpc] = useState('');
  const [fMethod, setFMethod] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fHost, setFHost] = useState('');
  const [fPath, setFPath] = useState('');
  /** Time sort direction — backend yields newest-first, so default is desc. */
  const [timeAsc, setTimeAsc] = useState(false);
  /** Client-side pagination. Page 1 follows the live tail (auto-refresh keeps
   *  landing there); any other page holds still and counts the rows that
   *  arrived since, so a refresh never yanks the operator off what they read. */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [heldTotal, setHeldTotal] = useState(0);
  const [newCount, setNewCount] = useState(0);
  /** History mode — page-numbered server scan over the PERSISTED day JSONL
   *  (the live ring above holds only the most recent rows). kind/method/
   *  status/host go to the backend; query/proto/rpc/path are live-view only. */
  const [mode, setMode] = useState<'live' | 'history'>('live');
  /** Federated rows — the backend merges every source, the console just maps. */
  const [rows, setRows] = useState<UnifiedLogRow[]>([]);
  /** History scope: the exact server-side total (live pages locally instead). */
  const [serverTotal, setServerTotal] = useState(0);

  /** The merged timeline — already interleaved by the backend, newest first. */
  const merged = rows;
  const selected = merged.find((r) => r.rid === openId) ?? null;
  /** Distinct method / status values present in the ring, for the filter dropdowns. */
  const fMethodOptions = useMemo(
    () => [...new Set(merged.map((r) => r.ev.method).filter(Boolean) as string[])].sort(),
    [merged]
  );
  const fStatusOptions = useMemo(
    () => [...new Set(merged.filter((r) => rowStatus(r) != null).map((r) => String(rowStatus(r))))].sort((a, b) => Number(a) - Number(b)),
    [merged]
  );
  /** Distinct hosts with row counts, most active first. */
  const fHostOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of merged) {
      const host = r.isProxy ? r.ev.host : r.ev.authority;
      if (host) counts.set(host, (counts.get(host) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [merged]);
  const anyFilter = Boolean(query.trim() || (fKind && fKind !== KIND_DEFAULT) || fProto || fRpc || fMethod || fStatus || fHost || fPath.trim());
  const resetFilters = useCallback(() => {
    setQuery(''); setFKind(KIND_DEFAULT); setFProto(''); setFMethod(''); setFStatus(''); setFHost(''); setFPath('');
  }, []);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const p = fPath.trim().toLowerCase();
    const h = fHost.toLowerCase();
    const rows = merged.filter((r) => {
      if (fKind && kindOf(r) !== fKind) return false;
      if (fProto && protoOf(r) !== fProto) return false;
      if (fRpc && rpcOf(r).rpc !== fRpc) return false;
      if (fMethod && methodOf(r) !== fMethod) return false;
      if (fStatus && String(rowStatus(r) ?? '') !== fStatus) return false;
      if (h && hostOf(r).toLowerCase() !== h) return false;
      if (p && !pathOf(r).toLowerCase().includes(p)) return false;
      if (q) {
        // Request-line search: plain text = substring, glob metachars = anchored glob.
        const line = `${methodOf(r) ?? ''} ${hostOf(r)}${pathOf(r)}`;
        const hit = /[*?]/.test(q) ? globToRe(q).test(line) : line.toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
    return timeAsc ? [...rows].sort((a, b) => a.tsNum - b.tsNum) : rows;
  }, [merged, query, fKind, fProto, fRpc, fMethod, fStatus, fHost, fPath, timeAsc]);
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  const pageRows = useMemo(() => visible.slice((page - 1) * pageSize, page * pageSize), [visible, page, pageSize]);
  /** What the table renders: the live page slice, or the server-returned history page. */
  /** Live pages `visible` locally; history's server page gets the same
   *  client-side filter pass for the free-text / proto / rpc / path dims. */
  const displayRows = mode === 'live' ? pageRows : visible;
  // A filter or sort change redefines what the rows ARE — back to page 1.
  useEffect(() => {
    setPage(1);
    setNewCount(0);
  }, [query, fKind, fProto, fRpc, fMethod, fStatus, fHost, fPath, timeAsc]);
  // Keep the current page inside bounds (LIVE only — its bounds are the
  // client-side row count; history's bounds live server-side, a client
  // "totalPages" there is always 1 because one page arrives at a time).
  useEffect(() => {
    if (mode === 'live' && page > totalPages) setPage(totalPages);
  }, [mode, page, totalPages]);
  useEffect(() => {
    if (page === 1) {
      setNewCount(0);
      setHeldTotal(merged.length);
    } else if (merged.length > heldTotal) {
      setNewCount(merged.length - heldTotal);
      setHeldTotal(merged.length);
    }
  }, [merged.length, page, heldTotal]);
  const goPage = useCallback((p: number) => {
    setPage(Math.min(Math.max(1, p), totalPages));
  }, [totalPages]);

  /** ONE read for BOTH scopes: the backend federates the sources behind
   *  `/api/admin/proxy-log` — live = ring + plugin tails (paged locally),
   *  history = the persisted federated scan (paged server-side). */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (mode === 'history') {
        const res = await api.getProxyTimeline({
          scope: 'history',
          page,
          limit: pageSize,
          kind: fKind || undefined,
          method: fMethod || undefined,
          status: fStatus || undefined,
          host: fHost || undefined,
        });
        setRows(res.rows.map((r, i) =>
          'ev' in r
            ? { rid: r.ev.id, source: 'proxy', isProxy: true as const, tsNum: r.ev.ts, ev: r.ev }
            : {
                rid: `p:${r.source}:${rowKey(r.ex)}:${i}`,
                source: r.source,
                isProxy: false as const,
                tsNum: Date.parse(r.ex.ts ?? '') || 0,
                ev: r.ex,
              }
        ));
        setServerTotal(res.total);
      } else {
        const res = await api.getProxyTimeline({ scope: 'live' });
        setRows(res.rows.map((r, i) =>
          'ev' in r
            ? { rid: r.ev.id, source: 'proxy', isProxy: true as const, tsNum: r.ev.ts, ev: r.ev }
            : {
                rid: `p:${r.source}:${rowKey(r.ex)}:${i}`,
                source: r.source,
                isProxy: false as const,
                tsNum: Date.parse(r.ex.ts ?? '') || 0,
                ev: r.ex,
              }
        ));
        setEnabled(res.enabled ?? true);
      }
    } catch {
      // Log endpoint is additive on older gateways; stay silent.
    } finally {
      setLoading(false);
    }
  }, [mode, page, pageSize, fKind, fMethod, fStatus, fHost]);

  // The scope/page/filter state IS the query: any change re-issues the read
  // (live refetches too — same 4s-cadence data, keeps manual refresh honest).
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!auto || mode !== 'live') return;
    const iv = setInterval(load, 4000);
    return () => clearInterval(iv);
  }, [auto, mode, load]);

  const switchMode = useCallback((m: 'live' | 'history') => {
    if (m === mode) return;
    setMode(m);
    setOpenId(null);
    setPage(1);
    setNewCount(0);
    setHeldTotal(0);
  }, [mode]);

  /**
   * Clear = the rows the current filter shows, scoped by the ACTIVE VIEW:
   *  live    — hide exactly those rows from the live view (ring removal + a
   *            live-only tombstone overlay for plugin tail rows). Nothing is
   *            deleted from disk, so History still lists them; that split is
   *            the contract (ADR-0017 §5), and the confirm says so.
   *  history — the console holds ONE server page, so keys can't express the
   *            scope; the same kind/method/status/host filter travels and the
   *            backend rewrites every matching PERSISTED row + body sidecar
   *            (proxy-log/history/delete). The live ring is untouched.
   */
  const handleClear = useCallback(async () => {
    if (mode === 'history') {
      const filters = {
        kind: fKind || undefined,
        method: fMethod || undefined,
        status: fStatus || undefined,
        host: fHost || undefined,
      };
      let total = 0;
      try {
        const probe = await api.getProxyTimeline({ scope: 'history', page: 1, limit: 1, ...filters });
        total = probe.total;
      } catch {
        // Probe failure never blocks the flow — the delete re-reports counts.
      }
      const ok = await confirmDialog({
        title: t('proxyLog.clearConfirmTitle'),
        description: [
          t('proxyLog.clearConfirmDesc'),
          t('proxyLog.clearPersistNote'),
          t('proxyLog.clearPersistScope', { count: total }),
        ].join('\n\n'),
        danger: true,
        confirmLabel: t('proxyLog.clear'),
      });
      if (!ok) return;
      try {
        const res = await api.deleteProxyHistory(filters);
        const n = res.deleted.proxy + Object.values(res.deleted.plugins).reduce((a, b) => a + b, 0);
        toast.success(t('proxyLog.clearDone', { count: n }));
        load();
      } catch (err) {
        toast.error(`${t('proxyLog.clear')}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (visible.length === 0) return;
    const ok = await confirmDialog({
      title: t('proxyLog.clearConfirmTitle'),
      description: t('proxyLog.clearLiveNote', { count: visible.length, total: merged.length }),
      danger: true,
      confirmLabel: t('proxyLog.clear'),
    });
    if (!ok) return;
    try {
      const proxy: { key: string; ts: number }[] = [];
      const plugins: Record<string, { key: string; ts: number }[]> = {};
      for (const r of visible) {
        const key = r.isProxy ? r.ev.id : rowKey(r.ev);
        const ts = r.tsNum > 0 ? r.tsNum : Date.now();
        if (r.isProxy) proxy.push({ key, ts });
        else (plugins[r.source] ??= []).push({ key, ts });
      }
      const res = await api.clearLiveTraffic({ proxy, plugins });
      const n = res.hidden.proxy + Object.values(res.hidden.plugins).reduce((a, b) => a + b, 0);
      toast.success(t('proxyLog.clearLiveDone', { count: n }));
      load();
    } catch (err) {
      toast.error(`${t('proxyLog.clear')}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [confirmDialog, toast, t, load, visible, merged.length, mode, fKind, fMethod, fStatus, fHost]);

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
          <SegGroup
            value={mode}
            onChange={(v) => switchMode(v as 'live' | 'history')}
            options={[
              { value: 'live', label: t('proxyLog.modeLive') },
              { value: 'history', label: t('proxyLog.modeHistory') },
            ]}
            size="sm"
          />
          <button className={`btn btn-sm ${auto ? 'btn-primary' : ''}`} onClick={() => setAuto(a => !a)} disabled={mode !== 'live'} title={t('proxyLog.autoHint')}>
            <RefreshCw size={12} />
            <span>{t('proxyLog.auto')}</span>
          </button>
          <button
            className="btn btn-sm"
            onClick={load}
            disabled={loading}
          >
            <RefreshCw size={12} style={loading ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined} />
            <span>{t('proxyLog.refresh')}</span>
          </button>
          <button
            className="btn btn-sm"
            onClick={handleClear}
            disabled={mode === 'live' ? visible.length === 0 : anyFilter ? false : serverTotal === 0}
            title={mode === 'history' ? t('proxyLog.clearPersistHint') : undefined}
          >
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
          title={mode === 'history' ? t('proxyLog.histFilterHint') : undefined}
          style={{ flex: 1, minWidth: '160px', fontSize: 'var(--text-sm)' }}
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          placeholder={t('proxyLog.search')}
        />
        <Combobox
          value={fProto}
          onChange={setFProto}
          clearable
          placeholder={t('proxyLog.fProto')}
          style={{ width: '112px' }}
          options={[
            { value: 'h1', label: t('proxyLog.protoH1') },
            { value: 'h2', label: t('proxyLog.protoH2') },
          ]}
        />
        <Combobox
          value={fRpc}
          onChange={setFRpc}
          clearable
          placeholder={t('proxyLog.fRpc')}
          style={{ width: '128px' }}
          options={[
            { value: 'connect', label: t('proxyLog.rpcConnect') },
            { value: 'grpc', label: t('proxyLog.rpcGrpc') },
          ]}
        />
        <Combobox
          value={fKind}
          onChange={setFKind}
          clearable
          placeholder={t('proxyLog.fKind')}
          style={{ width: '112px' }}
          options={[
            { value: 'http', label: t('proxyLog.kindHttp') },
            { value: 'connect', label: t('proxyLog.kindConnect') },
          ]}
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
          options={fHostOptions.map(([h, n]) => ({ value: h, label: h, meta: t('proxyLog.rowCount', { count: n }) }))}
        />
        <input
          className="input"
          title={mode === 'history' ? t('proxyLog.histFilterHint') : undefined}
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
        {(mode === 'live' ? merged.length === 0 : serverTotal === 0) ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--text-dim)', fontSize: 'var(--text-md)', padding: '24px' }}>
              <Inbox size={24} />
              <span>{t(mode === 'history' ? 'proxyLog.histEmpty' : 'proxyLog.empty')}</span>
            </div>
          ) : (mode === 'live' ? visible.length === 0 : rows.length === 0) ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 'var(--text-md)', padding: '24px' }}>
              <span>{t('proxyLog.noMatch')}</span>
            </div>
          ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
            <thead>
              <tr>
                <th style={{ ...LOG_TH, textAlign: 'center' }}>
                  <button
                    onClick={() => setTimeAsc((a) => !a)}
                    title={t('proxyLog.sortTimeHint')}
                    style={{ all: 'unset', cursor: 'pointer', font: 'inherit', color: 'inherit' }}
                  >
                    {t('proxyLog.colTime')} {timeAsc ? '↑' : '↓'}
                  </button>
                </th>
                <th style={{ ...LOG_TH, textAlign: 'center' }}>{t('proxyLog.colKind')}</th>
                <th style={{ ...LOG_TH, textAlign: 'center' }}>{t('proxyLog.colProto')}</th>
                <th style={LOG_TH}>{t('proxyLog.colHost')}</th>
                <th style={{ ...LOG_TH, textAlign: 'center' }}>{t('proxyLog.colMethod')}</th>
                <th style={LOG_TH}>{t('proxyLog.colPath')}</th>
                <th style={{ ...LOG_TH, textAlign: 'center' }}>{t('proxyLog.colStatus')}</th>
                <th style={{ ...LOG_TH, textAlign: 'center' }}>{t('proxyLog.colMs')}</th>
                <th style={{ ...LOG_TH, textAlign: 'center' }} title={t('proxyLog.colReqBytesHint')}>{t('proxyLog.colReqBytes')}</th>
                <th style={{ ...LOG_TH, textAlign: 'center' }} title={t('proxyLog.colResBytesHint')}>{t('proxyLog.colResBytes')}</th>
                <th style={{ ...LOG_TH, textAlign: 'center' }}>{t('proxyLog.colDecoder')}</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((r) => (
                <tr
                  key={r.rid}
                  onClick={() => setOpenId(r.rid)}
                  style={{ cursor: 'pointer', background: openId === r.rid ? 'var(--well-bg)' : undefined }}
                >
                  <td style={{ ...LOG_TD, ...FONT_MONO_COLOR, textAlign: 'center' }}>{new Date(r.tsNum).toLocaleTimeString()}</td>
                  <td style={{ ...LOG_TD, textAlign: 'center' }}>
                    <span className="badge" style={{ fontSize: 'var(--text-2xs)', border: '1px solid var(--divider)', color: kindOf(r) === 'http' ? 'var(--accent)' : 'var(--text-dim)' }}>
                      {t(KIND_LABEL_KEYS[kindOf(r)] ?? 'proxyLog.kindHttp')}
                    </span>
                  </td>
                  <td
                    style={{ ...LOG_TD, ...FONT_MONO_COLOR, textAlign: 'center', color: 'var(--text-dim)' }}
                    title={(() => {
                      // The RPC convention is a per-ROW fact with almost no
                      // variance (every gateway row is ConnectRPC), so it earns
                      // a tooltip instead of a column: transport · RPC · encoding.
                      const { rpc, enc } = rpcOf(r);
                      const parts = [t(PROTO_LABEL_KEY[protoOf(r)] ?? 'proxyLog.protoH1')];
                      if (rpc) parts.push(rpc === 'connect' ? t('proxyLog.rpcConnect') : t('proxyLog.rpcGrpc'));
                      if (enc) parts.push(t(`proxyLog.enc${enc === 'proto' ? 'Proto' : 'Json'}`));
                      return parts.join(' · ');
                    })()}
                  >
                    {t(PROTO_LABEL_KEY[protoOf(r)] ?? 'proxyLog.protoH1')}
                  </td>
                  <td style={{ ...LOG_TD, fontFamily: FONT_MONO, maxWidth: '190px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={hostOf(r)}>
                    {hostOf(r) || '—'}
                  </td>
                  <td
                    style={{ ...LOG_TD, ...FONT_MONO_COLOR, textAlign: 'center' }}
                    // An RPC row is always POST: the operation lives in the path,
                    // not in the HTTP verb. Say so where the confusion starts.
                    title={!r.isProxy && rpcOf(r).rpc ? t('proxyLog.rpcMethodHint') : undefined}
                  >
                    {methodOf(r) ?? '—'}
                  </td>
                  <td style={{ ...LOG_TD, fontFamily: FONT_MONO, maxWidth: '380px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={pathOf(r)}>
                    {pathOf(r) || '—'}
                  </td>
                  <td style={{ ...LOG_TD, ...FONT_MONO_COLOR, textAlign: 'center', color: rowStatus(r) && rowStatus(r)! >= 400 ? '#f87171' : undefined }}>
                    {rowStatus(r) ?? '—'}
                  </td>
                  <td style={{ ...LOG_TD, ...FONT_MONO_COLOR, textAlign: 'center' }}>{rowDuration(r) ?? '—'}</td>
                  <td style={{ ...LOG_TD, ...FONT_MONO_COLOR, color: 'var(--text-dim)', textAlign: 'center' }}>
                    {bodySizes(r).up ? fmtBytes(bodySizes(r).up) : '—'}
                  </td>
                  <td style={{ ...LOG_TD, ...FONT_MONO_COLOR, color: 'var(--text-dim)', textAlign: 'center' }}>
                    {bodySizes(r).down ? fmtBytes(bodySizes(r).down) : '—'}
                  </td>
                  <td style={{ ...LOG_TD, fontSize: 'var(--text-xs)', textAlign: 'center' }}>
                    {(() => {
                      const win = rowDecoder(r);
                      if (!win) return '—';
                      return (
                        <span
                          className="badge"
                          style={{
                            fontSize: 'var(--text-2xs)',
                            border: '1px solid var(--divider)',
                            color: win.id === 'hex' ? 'var(--text-dim)' : win.id === 'dissector' ? 'var(--accent)' : 'var(--text-main)',
                          }}
                          title={decodersOf(r).res.map((d) => decoderLabel(d, t)).join(' | ')}
                        >
                          {/* The column header already says "decoder", so the cell
                              carries the bare owner name — the qualified label
                              (`Decode (cursor)`) lives in the detail drawer only. */}
                          {win.labelOverride ?? t(win.labelKey)}
                        </span>
                      );
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pager — the shared Pagination bar (one layout everywhere), OUTSIDE
          the scroll layer. Live: page 1 follows the tail and the arrival count
          offers the jump back. History: server-computed pages over the exact
          filtered total — the same bar, real numbered pages. */}
      {mode === 'live' && merged.length > 0 && (
        <div style={{ position: 'relative', padding: '0 14px 12px', flexShrink: 0 }}>
          {/* The new-rows hint floats left of the shared bar; the bar itself
              stays a plain block child (exactly like /admin/models), so its
              auto-margin page buttons land flush right. */}
          {page > 1 && newCount > 0 && (
            <button
              className="btn btn-sm btn-primary"
              style={{ float: 'left', marginTop: 12, marginRight: 10 }}
              onClick={() => goPage(1)}
            >
              {t('proxyLog.newRows', { count: newCount })}
            </button>
          )}
          <Pagination
            page={page}
            pageSize={pageSize}
            total={visible.length}
            onChange={goPage}
            showSummary
            pageSizeOptions={PAGE_SIZES}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
          />
        </div>
      )}
      {mode === 'history' && serverTotal > 0 && (
        <div style={{ position: 'relative', padding: '0 14px 12px', flexShrink: 0 }}>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={serverTotal}
            onChange={setPage}
            showSummary
            pageSizeOptions={PAGE_SIZES}
            onPageSizeChange={setPageSize}
          />
        </div>
      )}

      {selected && (
        <Drawer
          title={
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Activity size={17} color="var(--accent)" />
              <span>{t('proxyLog.detailTitle')}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', fontWeight: 'var(--font-regular)', color: 'var(--text-dim)' }}>
                {new Date(selected.tsNum).toLocaleString()}
              </span>
            </span>
          }
          onClose={() => setOpenId(null)}
          closeLabel={t('combobox.close')}
          width="min(760px, 94vw)"
        >
          {selected.isProxy ? (
            <ProxyAccessDetail key={selected.rid} ev={selected.ev} />
          ) : (
            <PluginAccessDetail key={selected.rid} ev={selected.ev} decoder={selected.source} />
          )}
        </Drawer>
      )}
    </div>
  );
};

/** The page IS the card: the log is the whole surface, no tab bar above it. */
export const ProxyLogPage: React.FC = () => (
  <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
    <TrafficLogCard />
  </div>
);

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ShieldCheck, Save, BookOpen, ChevronDown, ChevronLeft, ChevronRight, Plus, Trash2, Activity, Eraser, RefreshCw, Inbox, MonitorCog, Undo2, Terminal, Copy, Download, FileDown, Maximize2, Minimize2, ArrowUp, ArrowDown, AlertTriangle } from 'lucide-react';
import { api, type GatewayStatusResponse, type ProxyAccessEvent, type SystemProxyStatus, type RuleIngress, type ForwardProxyRule, type HostDecision, type RuleWarning, type PluginTrafficEvent, type CaMeta } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Switch } from '../components/Switch';
import { InfoTip } from '../components/InfoTip';
import { Combobox, type ComboboxOption } from '../components/Combobox';
import { SegGroup } from '../components/SegGroup';
import { Pagination } from '../components/Pagination';
import { Drawer } from '../components/Drawer';
import { Prose, proseIsLong } from '../components/Prose';
import { applicableDecoders, decoderLabel, hexDumpToBytes, type DecoderContext, type SideDecoder } from '../lib/sideDecoders';
import { modelRefBadge } from '../lib/modelRefBadge';
import { copyToClipboard } from '../lib/clipboard';
import { sortModelOptions } from '../lib/model-options';
import { DEFAULT_FORWARD_PROXY_PORT, DEFAULT_FORWARD_PROXY_HOST, DEFAULT_FORWARD_PROXY_MAX_CONNECTIONS, DEFAULT_PROXY_ACCESS_LOG_PERSIST_DAYS, PROXY_ACCESS_LOG_PERSIST_DAYS_MIN, PROXY_ACCESS_LOG_PERSIST_DAYS_MAX } from '../lib/defaults';

import { FONT_MONO } from '../lib/fonts';

/** Default rows per page — page 1 follows the live tail, so the default is generous. */
const PAGE_SIZE = 100;
const PAGE_SIZES = [20, 50, 100, 200];
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
  /** The rule table (ADR-0018) — one ordered list, first match wins; each row is
   *  `{ match, ingress, egress }`: what happens at ingress and where the bytes exit. */
  rules?: ForwardProxyRule[];
  /** Concurrent inbound socket cap (default 512). Raw-YAML page only. */
  maxConnections?: number;
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

/**
 * The rule table (ADR-0018) is ONE grid: the head row and every rule row are
 * cells of the same template, so a column label can never drift off the field
 * it names (the ingress control is pinned, the match input takes the slack, and
 * the egress / actions tracks size to their widest row).
 */
const RULE_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '18px minmax(0, 1fr) 170px max-content max-content',
  columnGap: '6px',
  rowGap: '8px',
  alignItems: 'center',
};
/** Column label of that grid — dim, uppercase, never wrapping (it would re-flow the tracks). */
const RULE_HEAD: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  fontWeight: 'var(--font-semibold)',
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: 'var(--tracking-label)',
  whiteSpace: 'nowrap',
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
 * Inline advisory strip for the egress card (ADR-0018).
 * `warn` = the table cannot do what it says (no catch-all / proxy rules with the
 * outbound proxy off); `info` = the table is currently inert (listener off).
 */
const EgressNote: React.FC<{ tone: 'warn' | 'info'; text: string }> = ({ tone, text }) => (
  <div
    style={{
      display: 'flex',
      gap: '8px',
      alignItems: 'flex-start',
      padding: '8px 10px',
      marginBottom: '10px',
      borderRadius: '8px',
      border: `1px solid ${tone === 'warn' ? 'rgba(248,113,113,0.45)' : 'var(--card-border)'}`,
      background: tone === 'warn' ? 'rgba(248,113,113,0.10)' : 'var(--well-bg)',
      color: tone === 'warn' ? '#f87171' : 'var(--text-dim)',
      fontSize: 'var(--text-xs)',
      lineHeight: 1.5,
    }}
  >
    {tone === 'warn' && <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />}
    <span>{text}</span>
  </div>
);

/** Swap one rule with its neighbour. Order IS the semantics — this is the only
 *  way an operator can change which rule wins. */
function moveRule<T>(rules: T[], idx: number, delta: -1 | 1): T[] {
  const to = idx + delta;
  if (to < 0 || to >= rules.length) return rules;
  const next = [...rules];
  [next[idx], next[to]] = [next[to], next[idx]];
  return next;
}

/** New rules land BEFORE the catch-all — appended after it they would never
 *  match, which reads as "the feature is broken" rather than "you put it in the
 *  wrong place". The value is inherited from the catch-all so the common case
 *  (add an exception to the default posture) needs no second click. */
function insertRule<T extends { match: string }>(rules: T[], make: (catchAll: T | undefined) => T): T[] {
  const catchAllAt = rules.findIndex(r => r.match.trim() === '*');
  const row = make(catchAllAt >= 0 ? rules[catchAllAt] : undefined);
  if (catchAllAt < 0) return [...rules, row];
  const next = [...rules];
  next.splice(catchAllAt, 0, row);
  return next;
}

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
  /** Suffix on the body title (` · 1.2 KiB · preview truncated`). */
  bodyBadge?: string;
  /** Captured window bytes — the input every decoder claims. */
  bytes?: Uint8Array | null;
  /** Full captured size, when the gateway knows it. */
  bodyBytes?: number;
  /** Opaque body token: the drawer loads a preview from it and offers it as
   *  the download. One shape for every row, no storage detail. */
  bodyToken?: string;
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

/**
 * Two downloads, two artifacts — never one ambiguous button:
 *   RAW       the captured bytes as they arrived (lossless, streamed by the
 *             gateway, independent of any decoder);
 *   DECODED   whatever the ACTIVE decoder rendered (frame tree / text / image)
 *             — derived, and limited to the preview window.
 */
const saveBlob = (blob: Blob, filename: string): void => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
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
  const bytes = side.bytes ?? fileBytes.bytes;
  const bodyBytes = side.bodyBytes ?? bytes?.length ?? 0;
  const windowed = Boolean(bytes && bodyBytes > bytes.length);
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
      <DetailSection title={`${side.bodyTitle}${side.bodyBadge ?? ''}`} expanded={exp.b}>
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
            <span style={{ display: 'inline-flex', gap: '6px', marginLeft: 'auto' }}>
              {side.bodyToken && (
                <a className="btn" href={`/api/admin/traffic-body/${encodeURIComponent(side.bodyToken)}`} download style={{ gap: '4px', display: 'inline-flex', alignItems: 'center' }}>
                  <Download size={12} />
                  <span>{t('proxyLog.downloadRaw')}</span>
                </a>
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
                      saveBlob(new Blob([output.bytes.slice().buffer as ArrayBuffer], { type: output.mime }), `${base}-${active!.id}.${IMAGE_EXT[output.mime] ?? 'bin'}`);
                      return;
                    }
                    const ext = active!.id === 'hex' || active!.id === 'pdf' ? 'txt' : 'json';
                    saveBlob(new Blob([output.text], { type: 'text/plain;charset=utf-8' }), `${base}-${active!.id}.${ext}`);
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
  const badge = (total: number | undefined, truncated: boolean | undefined, window: string | undefined): string => {
    const parts: string[] = [];
    if (total && total > 0) parts.push(fmtBytes(total));
    if (truncated) parts.push(t('proxyLog.truncated'));
    else if (total && total > (window ? window.length / 2 : 0)) parts.push(t('proxyLog.previewWindowed'));
    return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
  };
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
        bodyBadge: badge(ev.reqBodyBytes, ev.reqTruncated, ev.reqHex),
        bytes: bytesOf(ev.reqHex),
        bodyBytes: ev.reqBodyBytes,
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
        bodyBadge: badge(ev.resBodyBytes, ev.resTruncated, ev.resHex),
        bytes: bytesOf(ev.resHex),
        bodyBytes: ev.resBodyBytes,
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

const ProxyAccessLogCard: React.FC = () => {
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
   * Clear = delete EXACTLY the rows on screen. The filter IS the scope: no
   * filter means everything, a filter means what it shows — and the confirm
   * states both counts so the blast radius is never a guess. Row KEYS travel
   * to the backend, not a predicate: the filter logic stays in this file, a
   * backend copy would drift into deleting rows nobody can see.
   */
  /**
   * Clear = delete rows. The scope follows the mode:
   *  live    — every matching row is resident locally, so "visible" IS the
   *            full filter scope; row keys travel to the backend (traffic-delete).
   *  history — the console only holds ONE server page, so keys can't express
   *            the scope; the SAME filter vocabulary travels instead and the
   *            backend deletes all matching persisted rows across all sources
   *            (proxy-log/history/delete). The exact count is fetched first so
   *            the confirm states the blast radius, never a guess.
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
      } catch (err: any) {
        toast.error(`${t('proxyLog.clear')}: ${err?.message || err}`);
      }
      return;
    }
    if (visible.length === 0) return;
    const ok = await confirmDialog({
      title: t('proxyLog.clearConfirmTitle'),
      description: [
        t('proxyLog.clearConfirmDesc'),
        t('proxyLog.clearScopeNote', { count: visible.length, total: merged.length }),
      ].join('\n\n'),
      danger: true,
      confirmLabel: t('proxyLog.clear'),
    });
    if (!ok) return;
    try {
      const proxy: string[] = [];
      const plugins: Record<string, string[]> = {};
      for (const r of visible) {
        const key = r.isProxy ? r.ev.id : rowKey(r.ev);
        if (r.isProxy) proxy.push(key);
        else (plugins[r.source] ??= []).push(key);
      }
      const res = await api.deleteTrafficRows({ proxy, plugins });
      const n =
        res.deleted.proxy + Object.values(res.deleted.plugins).reduce((a, b) => a + b, 0);
      toast.success(t('proxyLog.clearDone', { count: n }));
      load();
    } catch (err: any) {
      toast.error(`${t('proxyLog.clear')}: ${err?.message || err}`);
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
                  void copyToClipboard(
                    ENV_SNIPPETS(st.targetServer || `http://127.0.0.1:${DEFAULT_FORWARD_PROXY_PORT}`, st.caPath)[shell],
                  ).then((ok) =>
                    ok ? toast.success(t('proxyLog.sysCopied')) : toast.error(t('proxyLog.sysCopyFailed')),
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
  /** This install's CA path — interpolated into the wizard snippets so every
   *  example shows the real file instead of a placeholder. */
  const [caMeta, setCaMeta] = useState<CaMeta | null>(null);
  /** A failed `/ca/meta` (older gateway, offline console) must not strand the
   *  wizard on "Loading…": fall back to the documented `<ocrHome>` placeholder
   *  the help copy already uses, so every snippet still renders. */
  const [caMetaFailed, setCaMetaFailed] = useState(false);
  const [caDetailsOpen, setCaDetailsOpen] = useState(false);
  const [gatewayModels, setGatewayModels] = useState<{ id: string; kind?: string; members?: number; wire?: string }[]>([]);
  /** Current wizard step id */
  const [step, setStep] = useState('1');
  /** Page view tab: access configuration / system proxy / setup wizard / traffic log. */
  const [view, setView] = useState<'config' | 'sys' | 'wizard' | 'log'>('config');
  /** Config-tab fold state: the traffic-log and miss-policy groups (advanced) default collapsed. */
  const [fold, setFold] = useState({ log: false, miss: false });
  /** The rule table (ADR-0018). Order is the semantics — the ↑↓ buttons are the
   *  ONLY thing keeping it readable, not a convenience. */
  const [ruleRows, setRuleRows] = useState<ForwardProxyRule[]>([]);
  /** Lint + preview come from the backend resolvers (never a local re-implementation). */
  const [ruleWarnings, setRuleWarnings] = useState<RuleWarning[]>([]);
  const [probeHost, setProbeHost] = useState('');
  const [probeDecision, setProbeDecision] = useState<HostDecision | null>(null);
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
      setRuleRows(fpCfg.rules || []);
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

  useEffect(() => {
    let alive = true;
    api
      .getProxyCaMeta()
      .then(m => {
        if (alive) setCaMeta(m);
      })
      .catch(() => {
        if (alive) setCaMetaFailed(true);
      });
    return () => {
      alive = false;
    };
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

  // Lint + probe — one debounced call to the backend resolver (the same
  // function the proxy legs call, so the preview cannot disagree with reality).
  useEffect(() => {
    const host = probeHost.trim();
    const timer = setTimeout(() => {
      api
        .resolveForwardProxyRules({ host: host || undefined, rules: ruleRows })
        .then(r => {
          setRuleWarnings(r.warnings);
          setProbeDecision(r.decision);
        })
        .catch(() => {});
    }, 350);
    return () => clearTimeout(timer);
  }, [probeHost, ruleRows]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const next = {
        forwardProxy: {
          ...(fp || {}),
          // Blank rows never persist (an empty glob
          // would match nothing but still round-trip as noise); trimming matches
          // the backend normalizer, and rows already carry the full two-field
          // shape, so they persist as-is.
          rules: ruleRows
            .filter(r => r.match.trim())
            .map(r => ({ match: r.match.trim(), ingress: r.ingress, egress: r.egress })),
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
      // (rules / unresolvedModel re-read the runtime ref per request), so the
      // restart warning fires ONLY when a boot-frozen field actually changed.
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
  const ingressOptions: ComboboxOption[] = [
    // Full descriptions surface on OPTION HOVER via the app-wide [data-tip]
    // provider (the panel row carries them as `meta` — never rendered inline).
    { value: 'intercept', label: t('forwardProxy.ingressIntercept'), meta: t('forwardProxy.ruleDescIngressIntercept') },
    { value: 'passthrough', label: t('forwardProxy.ingressPassthrough'), meta: t('forwardProxy.ruleDescIngressPassthrough') },
    { value: 'reject', label: t('forwardProxy.ingressReject'), meta: t('forwardProxy.ruleDescIngressReject') },
  ];
  /** Translated label for a resolved exit (probe display) — RuleExit, not RuleIngress. */
  const exitLabel = (a: HostDecision['action']): string =>
    a === 'direct' ? t('forwardProxy.exitDirect')
      : a === 'proxy' ? t('forwardProxy.exitProxy')
        : t('forwardProxy.exitReject');
  /** The ingress half of a decision, in the SAME words as the row's dropdown —
   *  the probe must not invent a second name for what the operator just picked. */
  const ingressLabel = (tunnel: boolean): string =>
    tunnel ? t('forwardProxy.ingressPassthrough') : t('forwardProxy.ingressIntercept');
  /** Row-level lint sentence for EVERY code in the mirrored union. Banner-level
   *  codes return null (the note above the table already says it); the `never`
   *  assertion makes a new backend code a typecheck failure here rather than a
   *  silently wrong sentence. */
  const rowWarningText = (code: RuleWarning['code']): string | null => {
    switch (code) {
      case 'invalid-rule': return t('forwardProxy.ruleInvalid');
      case 'unreachable-rule': return t('forwardProxy.ruleUnreachable');
      case 'proxy-rule-without-proxy': return null;
      case 'no-catch-all': return null;
      default: {
        const unmapped: never = code;
        throw new Error(`unmapped rule warning: ${unmapped}`);
      }
    }
  };


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
  // System-store install snippets: one row per OS so the platform reads as a
  // tag and the command as code, instead of one pre-line text blob.
  const caPath = caMeta?.path ?? (caMetaFailed ? '<ocrHome>/forward-proxy/ca.pem' : undefined);
  const sysInstallRows: { os: string; cmd: string; hint?: string }[] = caPath
    ? [
        { os: 'Windows', cmd: t('forwardProxy.sysInstallWinCmd', { caPath }), hint: t('forwardProxy.sysInstallWinHint', { caPath }) },
        { os: 'macOS', cmd: t('forwardProxy.sysInstallMacCmd', { caPath }) },
        { os: 'Linux', cmd: t('forwardProxy.sysInstallLinuxCmd', { caPath }) },
      ]
    : [];

  const steps: { id: string; title: string; body: React.ReactNode }[] = [
    {
      id: '1',
      title: t('forwardProxy.step2Title'),
      body: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div>{t('forwardProxy.helpStep2')}</div>
          <pre style={preStyle}>{caPath ? t('forwardProxy.helpStep2Code', { caPath }) : t('common.loading')}</pre>
          {caPath ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('forwardProxy.sysInstallTitle')}</div>
              {sysInstallRows.map(row => (
                <div key={row.os} style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
                  <span
                    className="badge"
                    style={{
                      flexShrink: 0, minWidth: '60px', justifyContent: 'center',
                      textTransform: 'none', letterSpacing: 0,
                      color: 'var(--text-muted)', border: '1px solid var(--card-border)',
                    }}
                  >
                    {row.os}
                  </span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
                    <code style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', color: 'var(--text-main)', overflowWrap: 'anywhere' }}>{row.cmd}</code>
                    {row.hint && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>{row.hint}</div>}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('common.loading')}</div>
          )}
          {/* Verification details live in the trust step only: the path is
              already in every command above, the fingerprint matters exactly
              when the user is checking the root they just installed. */}
          {caMeta && (
            <details
              open={caDetailsOpen}
              onToggle={e => setCaDetailsOpen((e.target as HTMLDetailsElement).open)}
              style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}
            >
              <summary style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', listStyle: 'none' }}>
                <ChevronDown
                  size={12}
                  style={{ flexShrink: 0, transform: caDetailsOpen ? 'none' : 'rotate(-90deg)', transition: 'transform 0.15s' }}
                />
                <span>{t('forwardProxy.caCardDetails')}</span>
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                  <span style={{ minWidth: '96px' }}>{t('forwardProxy.caCardFingerprint')}</span>
                  <span style={{ fontFamily: FONT_MONO, color: 'var(--text-main)', wordBreak: 'break-all' }}>{caMeta.fingerprintSha256}</span>
                  <button
                    className="btn btn-sm btn-icon"
                    title={t('common.copy')}
                    style={{ flexShrink: 0 }}
                    onClick={() => void copyToClipboard(caMeta.fingerprintSha256).then(ok => { if (ok) toast.success(t('forwardProxy.caCardCopied')); })}
                  >
                    <Copy size={12} />
                  </button>
                </div>
                <div>{t('forwardProxy.caCardValidUntil', { date: new Date(caMeta.notAfter).toLocaleDateString() })}</div>
              </div>
            </details>
          )}
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
          <pre style={preStyle}>{caPath ? t('forwardProxy.helpStep4Code', { port, caPath }) : t('common.loading')}</pre>
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

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '720px' }}>
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
              <div>
                <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
                  {t('forwardProxy.maxConnections')}
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder={String(DEFAULT_FORWARD_PROXY_MAX_CONNECTIONS)}
                  value={fp.maxConnections ?? ''}
                  onChange={e => {
                    const digits = e.target.value.replace(/[^0-9]/g, '');
                    setFp({ ...fp, maxConnections: digits === '' ? undefined : parseInt(digits, 10) });
                  }}
                  className="input"
                />
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: '4px' }}>
                  {t('forwardProxy.maxConnectionsHint')}
                </div>
              </div>
            </div>
          </div>

          {/* ── Section 2: the rule table (ADR-0018) — ordered, first match wins ── */}
          <div className="sub-card">
            <div style={SEC_TITLE}>{t('forwardProxy.ruleTable')}</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: '12px', lineHeight: 1.5 }}>
              {t('forwardProxy.ruleTableHint')}
            </div>
            {fp.enabled !== true && <EgressNote tone="info" text={t('forwardProxy.ruleDormant')} />}
            {ruleWarnings.some(w => w.code === 'proxy-rule-without-proxy') && (
              <EgressNote tone="warn" text={t('forwardProxy.ruleProxyOff')} />
            )}
            {status?.forwardProxy?.upstreamInsecure === true && (
              <EgressNote tone="warn" text={t('forwardProxy.ruleUpstreamInsecure')} />
            )}
            {ruleWarnings.some(w => w.code === 'no-catch-all') && (
              <EgressNote tone="warn" text={t('forwardProxy.ruleNoCatchAll')} />
            )}
            {ruleRows.length > 0 && (
              <div style={RULE_GRID}>
                <span style={{ ...RULE_HEAD, textAlign: 'right' }}>#</span>
                <span style={RULE_HEAD}>{t('forwardProxy.ruleColMatch')}</span>
                <span style={RULE_HEAD}>{t('forwardProxy.ruleColIngress')}</span>
                <span style={RULE_HEAD}>{t('forwardProxy.ruleColEgress')}</span>
                {/* Right-aligned like the button group under it, so the label sits over the
                    icons instead of floating at the group's left edge. */}
                <span style={{ ...RULE_HEAD, textAlign: 'right' }}>{t('forwardProxy.ruleColActions')}</span>
                {ruleRows.map((row, idx) => {
                  const rowWarnings = ruleWarnings.filter(w => w.ruleIndex === idx);
                  return (
                    <React.Fragment key={idx}>
                      <span style={{ ...FONT_MONO_COLOR, textAlign: 'right', color: 'var(--text-dim)', fontSize: 'var(--text-xs)' }}>
                        {idx + 1}
                      </span>
                      <input
                        type="text"
                        placeholder={t('forwardProxy.pattern')}
                        value={row.match}
                        onChange={e => {
                          const next = [...ruleRows];
                          next[idx] = { ...next[idx], match: e.target.value };
                          setRuleRows(next);
                        }}
                        className="input"
                        style={rowWarnings.some(w => w.code === 'invalid-rule') ? { borderColor: '#f87171' } : undefined}
                      />
                      <Combobox
                        value={row.ingress}
                        hideMetaInTrigger
                        hoverMetaOnly
                        onChange={v => {
                          const next = [...ruleRows];
                          // A reject row never sends bytes anywhere, so its
                          // egress is pinned to direct (the toggle greys out).
                          next[idx] = { ...next[idx], ingress: v as RuleIngress, egress: v === 'reject' ? 'direct' : next[idx].egress };
                          setRuleRows(next);
                        }}
                        options={ingressOptions}
                      />
                      <label
                        style={{
                          display: 'flex', gap: '4px', alignItems: 'center',
                          fontSize: 'var(--text-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap',
                          cursor: row.ingress === 'reject' ? 'not-allowed' : 'pointer',
                          opacity: row.ingress === 'reject' ? 0.4 : 1,
                        }}
                        title={t('forwardProxy.ruleDescEgressProxy')}
                      >
                        <input
                          type="checkbox"
                          checked={row.egress === 'proxy'}
                          disabled={row.ingress === 'reject'}
                          onChange={e => {
                            const next = [...ruleRows];
                            next[idx] = { ...next[idx], egress: e.target.checked ? 'proxy' : 'direct' };
                            setRuleRows(next);
                          }}
                        />
                        {/* The toggle IS the row's egress field, so it reads in the
                            same two words the probe uses for an exit. */}
                        {row.egress === 'proxy' ? t('forwardProxy.exitProxy') : t('forwardProxy.exitDirect')}
                      </label>
                      <div style={{ display: 'flex', gap: '6px', justifySelf: 'end' }}>
                        <button
                          className="btn btn-sm"
                          style={{ padding: '4px 6px' }}
                          title={t('forwardProxy.ruleMoveUp')}
                          disabled={idx === 0}
                          onClick={() => setRuleRows(moveRule(ruleRows, idx, -1))}
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          className="btn btn-sm"
                          style={{ padding: '4px 6px' }}
                          title={t('forwardProxy.ruleMoveDown')}
                          disabled={idx === ruleRows.length - 1}
                          onClick={() => setRuleRows(moveRule(ruleRows, idx, 1))}
                        >
                          <ArrowDown size={14} />
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          style={{ padding: '4px 8px' }}
                          onClick={() => setRuleRows(ruleRows.filter((_, i) => i !== idx))}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      {rowWarnings.map((w, wi) => {
                        const text = rowWarningText(w.code);
                        if (!text) return null;
                        return (
                          <div
                            key={wi}
                            style={{ gridColumn: '1 / -1', marginTop: '-4px', marginLeft: '24px', fontSize: 'var(--text-xs)', color: '#f87171', lineHeight: 1.5 }}
                          >
                            {text}
                          </div>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </div>
            )}
            <button
              className="btn btn-sm"
              style={{ alignSelf: 'flex-start', gap: '6px', marginTop: ruleRows.length > 0 ? '10px' : 0 }}
              onClick={() => setRuleRows(insertRule(ruleRows, (c) => ({ match: '', ingress: 'intercept', egress: c?.egress ?? 'direct' })))}
            >
              <Plus size={14} />
              <span>{t('forwardProxy.ruleAdd')}</span>
            </button>
            {/* Probe — an ordered table is only readable if you can ask it a
                question, and the answer must come from the SAME resolver the
                proxy legs call (the backend), never a local re-implementation. */}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '14px', flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder={t('forwardProxy.ruleProbe')}
                value={probeHost}
                onChange={e => setProbeHost(e.target.value)}
                className="input"
                style={{ maxWidth: '260px' }}
              />
              {probeDecision && (
                <span style={{ ...FONT_MONO_COLOR, fontSize: 'var(--text-xs)', color: probeDecision.action === 'reject' ? '#f87171' : 'var(--text-muted)' }}>
                  {probeDecision.reason === 'rule'
                    ? t('forwardProxy.ruleProbeRule', {
                        action: exitLabel(probeDecision.action),
                        mode: ingressLabel(probeDecision.tunnel),
                        index: String((probeDecision.ruleIndex ?? 0) + 1),
                        match: probeDecision.match ?? '',
                      })
                    : t(
                        probeDecision.reason === 'loopback' ? 'forwardProxy.ruleProbeLoopback' : 'forwardProxy.ruleProbeFallback',
                        { action: exitLabel(probeDecision.action), mode: ingressLabel(probeDecision.tunnel) },
                      )}
                </span>
              )}
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
          {/* Step 1 tells the user to click "Export CA Certificate"; the
              wizard is its own tab, so the button must live here too. */}
          <a className="btn" href="/api/admin/proxy/ca" download>
            {t('forwardProxy.caBtn')}
          </a>
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
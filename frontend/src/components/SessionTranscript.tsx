/**
 * Conversation replay for the capture archive — renders the selected session
 * as harness-style ROUNDS: one user prompt opens a round (header), the HTTP
 * turns it drove (tool-call hops, thinking, results) are the collapsible
 * middle, and the converged answer is the tail. Reconstructed from the turn
 * wire bodies by lib/transcript; each step links to its raw wire drawer.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, Bot, ChevronDown, ChevronRight, Image as ImageIcon, Maximize2, Minimize2, User, Wrench } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';
import type { CaptureTurn } from '../lib/api';
import {
  buildTranscript,
  collapseMediaTokens,
  groupIntoRounds,
  splitMediaTokens,
  unwrapHarnessText,
  type TranscriptMedia,
  type TranscriptMessage,
  type TranscriptRound,
  type TranscriptToolCall,
  type TranscriptTurn,
  type TurnOutput,
} from '../lib/transcript';
import { shortId, fmtDur } from '../lib/format';

const MONO = "'JetBrains Mono', Consolas, 'Noto Sans SC', 'Microsoft YaHei', monospace";

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString();

const MD_PLUGINS = [remarkGfm];
// Captured answers may link out — never hijack the console's own tab.
// Remote <img> is never fetched: a model's markdown must not make the
// operator's browser hit a third-party origin (IP/UA leak, tracking pixel).
// The console's own media route is a same-origin relative path, so it stays.
const MD_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  img: ({ node: _node, src, ...props }) =>
    typeof src === 'string' && /^(?:https?:)?\/\//i.test(src) ? (
      <span style={{ color: 'var(--text-dim)', fontSize: '11px' }}>[image]</span>
    ) : (
      <img {...props} src={src} loading="lazy" />
    ),
};

/** Prose with line-clamp collapse; the toggle only appears for long bodies.
 *  markdown=true renders GFM (assistant answers) instead of the monospace
 *  pre-wrap well — clamp/expand behavior is identical, only the medium.
 *  open/hideToggle support a parent-owned toggle (ToolResultRow's header row)
 *  so the control can sit above the preview instead of under it. */
const Prose: React.FC<{
  text: string;
  clamp?: number;
  color?: string;
  bg?: string;
  border?: string;
  markdown?: boolean;
  open?: boolean;
  hideToggle?: boolean;
}> = ({
  text,
  clamp = 12,
  color,
  bg,
  border,
  markdown = false,
  open: openProp,
  hideToggle,
}) => {
  const { t } = useI18n();
  const [openState, setOpen] = useState(false);
  const open = openProp ?? openState;
  const long = useMemo(() => text.split('\n').length > clamp || text.length > clamp * 140, [text, clamp]);
  // Collapsed = line-clamp; expanded = full flow — the round's waterfall
  // panel owns vertical scrolling (two scroll layers, not three).
  const bodyStyle: React.CSSProperties =
    long && !open
      ? {
          display: '-webkit-box',
          WebkitLineClamp: clamp,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }
      : {};
  const shell: React.CSSProperties = {
    margin: 0,
    padding: '8px 10px',
    background: bg ?? 'var(--well-bg)',
    border: `1px solid ${border ?? 'var(--card-border)'}`,
    borderRadius: 6,
    fontSize: '12px',
    lineHeight: 1.6,
    color: color ?? 'var(--text)',
    wordBreak: 'break-word',
    ...bodyStyle,
  };
  return (
    <div>
      {markdown ? (
        <div className="md-well" style={shell}>
          <ReactMarkdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>
            {text}
          </ReactMarkdown>
        </div>
      ) : (
        <pre style={{ ...shell, fontFamily: MONO, whiteSpace: 'pre-wrap' }}>{text}</pre>
      )}
      {long && !hideToggle && (
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--accent)',
            cursor: 'pointer',
            fontSize: '11px',
            padding: '2px 4px',
            marginLeft: 2,
          }}
        >
          {open ? t('captures.collapse') : t('captures.expand')}
        </button>
      )}
    </div>
  );
};

/**
 * A scrubbed media payload rendered from its [MEDIA …] token. With a stored
 * file (token has `file=` + the archive date is known) it's a clickable
 * thumbnail served by GET /api/admin/capture/:date/media/:hash; otherwise a
 * grey badge stating the payload was omitted (storeMedia off / write failed).
 */
const ImageChip: React.FC<{ media: TranscriptMedia; date?: string }> = ({ media, date }) => {
  const { t } = useI18n();
  const url = media.file && date ? `/api/admin/capture/${date}/media/${media.sha256}` : null;
  if (!url) {
    return (
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          border: '1px dashed var(--card-border)',
          borderRadius: 6,
          padding: '3px 8px',
          margin: '3px 0',
          background: 'var(--chip-bg)',
          color: 'var(--text-muted)',
          fontSize: '11px',
        }}
        title={media.file ? t('captures.mediaDateMissing') : t('captures.mediaStoreOff')}
      >
        <ImageIcon size={12} />
        <span>
          {t('captures.mediaOmitted', { info: media.info })} · {shortId(media.sha256, 8)}
        </span>
      </div>
    );
  }
  return (
    <div style={{ margin: '4px 0' }}>
      <img
        src={url}
        alt={media.info}
        loading="lazy"
        onClick={e => {
          // The round header is a click-to-toggle surface — never let a
          // thumbnail click collapse the card while opening the full view.
          e.stopPropagation();
          window.open(url, '_blank', 'noopener');
        }}
        title={t('captures.mediaOpenHint')}
        style={{
          maxHeight: 240,
          maxWidth: '100%',
          borderRadius: 6,
          border: '1px solid var(--card-border)',
          cursor: 'zoom-in',
          display: 'block',
          background: 'var(--well-bg)',
        }}
      />
      <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: 2, fontFamily: MONO }}>
        {media.info} · {shortId(media.sha256, 10)}
      </div>
    </div>
  );
};

/** Prose with inline [MEDIA …] tokens surfaced as chips/thumbnails. */
const ProseWithMedia: React.FC<{ text: string; clamp?: number; color?: string; date?: string; open?: boolean; hideToggle?: boolean }> = ({
  text,
  clamp,
  color,
  date,
  open,
  hideToggle,
}) => {
  const segs = useMemo(() => splitMediaTokens(text), [text]);
  // Fast path: no tokens (the common case) — one plain Prose.
  if (segs.length === 1 && segs[0].kind === 'text') return <Prose text={text} clamp={clamp} color={color} open={open} hideToggle={hideToggle} />;
  return (
    <div>
      {segs.map((s, i) =>
        s.kind === 'media' ? (
          <ImageChip key={i} media={s.media} date={date} />
        ) : s.text.trim() ? (
          <Prose key={i} text={s.text} clamp={clamp} color={color} open={open} hideToggle={hideToggle} />
        ) : null
      )}
    </div>
  );
};

const prettyArgs = (args: string): string => {
  const s = args.trim();
  if (!s) return args;
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return args;
  }
};

const ToolCallCard: React.FC<{ call: TranscriptToolCall }> = ({ call }) => {
  const { t } = useI18n();
  // Args collapsed by default: a tool-heavy round stays a readable waterfall;
  // the name row is the toggle.
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        // Left-rule language matching user/assistant message rails — a full
        // amber box per call was the loudest element on screen despite being
        // the most frequent (hierarchy inversion).
        borderLeft: '2px solid color-mix(in srgb, var(--accent-amber) 45%, transparent)',
        paddingLeft: 8,
      }}
    >
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '11px', cursor: call.args ? 'pointer' : 'default' }}
      >
        {call.args ? (
          open ? <ChevronDown size={12} /> : <ChevronRight size={12} />
        ) : (
          <span style={{ width: 12, flexShrink: 0 }} />
        )}
        <span className="badge badge-amber">
          <Wrench size={9} style={{ flexShrink: 0 }} />
          {t('captures.toolCallLabel')}
        </span>
        <span style={{ fontWeight: 600, fontFamily: MONO }}>{call.name || '?'}</span>
        {call.id && (
          <span style={{ color: 'var(--text-dim)', fontFamily: MONO, fontSize: '10px' }}>{shortId(call.id, 10)}</span>
        )}
      </div>
      {open && call.args && (
        <div style={{ marginTop: 4 }}>
          <Prose text={prettyArgs(call.args)} clamp={6} />
        </div>
      )}
    </div>
  );
};

const RoleLabel: React.FC<{ label: string; color: string; icon?: React.ReactNode }> = ({ label, color, icon }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '11px', fontWeight: 700, color, marginBottom: 3, letterSpacing: 0.3 }}>
    {icon}
    {label}
  </div>
);

/** One message from the request-side delta (user / tool result / system). */
const MessageView: React.FC<{ msg: TranscriptMessage; date?: string }> = ({ msg, date }) => {
  const { t } = useI18n();
  const [sysOpen, setSysOpen] = useState(false);
  const text = msg.blocks
    .filter(b => b.kind === 'text')
    .map(b => (msg.role === 'user' ? unwrapHarnessText(b.text) : b.text))
    .join('\n\n');

  if (msg.role === 'system') {
    return (
      <div style={{ marginLeft: 12 }}>
        <button
          onClick={() => setSysOpen(o => !o)}
          style={{
            background: 'var(--chip-bg)',
            border: '1px solid var(--card-border)',
            borderRadius: 6,
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: '11px',
            padding: '4px 8px',
          }}
        >
          {t('captures.msgSystem')} · {sysOpen ? t('captures.collapse') : t('captures.expand')}
        </button>
        {sysOpen && text && (
          <div style={{ marginTop: 4 }}>
            <Prose text={text} clamp={40} color="var(--text-muted)" />
          </div>
        )}
      </div>
    );
  }

  if (msg.role === 'tool') {
    return (
      <div style={{ marginLeft: 12 }}>
        <ToolResultRow name={msg.toolName} blockText={text} date={date} />
      </div>
    );
  }

  const isUser = msg.role === 'user';
  return (
    <div
      style={{
        borderLeft: `2px solid ${isUser ? 'var(--accent)' : 'var(--accent-emerald)'}`,
        paddingLeft: 10,
        marginBottom: 6,
      }}
    >
      <RoleLabel
        label={isUser ? t('captures.msgUser') : msg.role === 'assistant' ? t('captures.msgAssistant') : t('captures.msgTool')}
        color={isUser ? 'var(--accent)' : 'var(--accent-emerald)'}
        icon={isUser ? <User size={12} /> : <Bot size={12} />}
      />
      {/* User prompts stay verbatim (harness text / media tokens); assistant
          echoes render as GFM like the live output they were. */}
      {text && (isUser ? <ProseWithMedia text={text} date={date} /> : <Prose text={text} markdown />)}
      {msg.blocks.filter(b => b.kind === 'tool_result').map((b, i) => (
        <div key={i} style={{ marginTop: 4 }}>
          <ToolResultRow name={msg.toolName} blockText={b.text} date={date} />
        </div>
      ))}
      {msg.toolCalls.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: text ? 10 : 0 }}>
          {msg.toolCalls.map((c, i) => (
            <ToolCallCard key={c.id || i} call={c} />
          ))}
        </div>
      )}
    </div>
  );
};

/** Collapsed-by-default tool output card shared by role=tool messages and tool_result parts.
 *  The header row itself is the toggle — same affordance as ToolCallCard —
 *  so "expand" sits above the preview instead of hiding under it. */
const ToolResultRow: React.FC<{ name?: string; blockText: string; date?: string }> = ({ name, blockText, date }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const long = blockText.split('\n').length > 6 || blockText.length > 6 * 140;
  return (
    <div>
      <div
        onClick={() => long && setOpen(o => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: '11px',
          color: 'var(--text-dim)',
          marginBottom: 3,
          cursor: long ? 'pointer' : 'default',
        }}
      >
        {long ? open ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <span style={{ width: 12, flexShrink: 0 }} />}
        <span className="badge" style={{ fontSize: '10px', marginRight: 6 }}>
          {t('captures.msgTool')}
        </span>
        {name && <span style={{ fontFamily: MONO, fontWeight: 600 }}>{name}</span>}
        {long && (
          <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: '11px' }}>
            {open ? t('captures.collapse') : t('captures.expand')}
          </span>
        )}
      </div>
      {blockText ? (
        <ProseWithMedia text={blockText} clamp={6} date={date} open={open} hideToggle />
      ) : (
        <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>—</div>
      )}
    </div>
  );
};

const OutputView: React.FC<{ out: TurnOutput }> = ({ out }) => {
  const { t } = useI18n();
  const [thinkOpen, setThinkOpen] = useState(false);
  return (
    <div style={{ borderLeft: '2px solid var(--accent-emerald)', paddingLeft: 10, marginBottom: 6 }}>
      <RoleLabel label={t('captures.msgAssistant')} color="var(--accent-emerald)" icon={<Bot size={12} />} />
      {out.reasoning && (
        <div style={{ marginBottom: 4 }}>
          <button
            onClick={() => setThinkOpen(o => !o)}
            style={{
              background: 'var(--chip-bg)',
              border: '1px solid var(--card-border)',
              borderRadius: 6,
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '11px',
              padding: '3px 8px',
            }}
          >
            {t('captures.msgThinking')} · {thinkOpen ? t('captures.collapse') : t('captures.expand')}
          </button>
          {thinkOpen && (
            <div style={{ marginTop: 4 }}>
              <Prose text={out.reasoning} clamp={20} color="var(--text-muted)" />
            </div>
          )}
        </div>
      )}
      {out.text && <Prose text={out.text} markdown />}
      {out.toolCalls.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: out.text || out.reasoning ? 10 : 0 }}>
          {out.toolCalls.map((c, i) => (
            <ToolCallCard key={c.id || i} call={c} />
          ))}
        </div>
      )}
    </div>
  );
};

const Note: React.FC<{ tone: 'warn' | 'dim'; text: string; title?: string }> = ({ tone, text, title }) => (
  <div
    title={title}
    style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 6,
      fontSize: '11px',
      color: tone === 'warn' ? 'var(--accent-amber)' : 'var(--text-dim)',
      margin: '2px 0',
    }}
  >
    <AlertTriangle size={12} style={{ marginTop: 2, flexShrink: 0 }} />
    <span>{text}</span>
  </div>
);

const TranscriptBlock: React.FC<{
  st: TranscriptTurn;
  label: string;
  date?: string;
  first?: boolean;
  onOpenTurn: (idx: number) => void;
}> = ({ st, label, date, first, onOpenTurn }) => {
  const { t } = useI18n();
  const { turn } = st;
  const err =
    turn.upstreamResponse?.status === 'error' || turn.gatewayResponse?.status === 'error' || !!turn.error;
  const upstreamModel = turn.upstreamRequest?.model ?? turn.upstreamResponse?.model;
  const silent = st.input.length === 0 && !st.output && !st.reqTruncated && !st.reqUnparsed && !st.diverged;

  return (
    <div
      style={{
        // List-row language (index.css list-group contract): steps share the
        // panel's single frame, separated by one hairline rule — a bordered
        // card per step was box-in-box wire-mesh noise.
        padding: '10px 2px',
        borderTop: first ? undefined : '1px solid var(--divider)',
      }}
    >
      {/* Turn header — same chip language as the timeline row; click opens the wire drawer. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: silent && !err ? 0 : 6 }}>
        <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)' }}>#{label}</span>
        {st.ts !== undefined && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: MONO }}>{fmtTime(st.ts)}</span>
        )}
        <span className={`badge ${err ? 'badge-danger' : 'badge-success'}`}>
          {err ? t('captures.statusError') : t('captures.statusOk')}
        </span>
        <span style={{ fontSize: '12px', fontWeight: 600 }}>
          {turn.model}
          {upstreamModel && upstreamModel !== turn.model && (
            <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}> → {upstreamModel}</span>
          )}
        </span>
        {turn.gatewayLatencyMs !== undefined && (
          <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: MONO }}>↳ {turn.gatewayLatencyMs} ms</span>
        )}
        {st.reqTruncated && (
          <span className="badge badge-warning" title={t('captures.reqTruncatedNote')} style={{ flexShrink: 0 }}>
            <AlertTriangle size={10} />
            {t('captures.truncatedBadge')}
          </span>
        )}
        <button
          className="btn btn-sm"
          style={{ marginLeft: 'auto' }}
          onClick={() => onOpenTurn(st.idx)}
          title={t('captures.turnRawBtn')}
        >
          {t('captures.turnRawBtn')}
        </button>
      </div>

      {st.diverged && <Note tone="warn" text={t('captures.divergedNote')} />}
      {st.reqUnparsed && <Note tone="dim" text={t('captures.reqUnparsedNote')} />}

      {st.input.map((m, i) => (
        <div key={i} style={{ marginBottom: 6 }}>
          <MessageView msg={m} date={date} />
        </div>
      ))}

      {st.output ? (
        <OutputView out={st.output} />
      ) : st.hasResponseBody ? (
        <Note tone="dim" text={t('captures.outputUnparsedNote')} />
      ) : null}

      {silent && (
        <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: err ? 4 : 0 }}>
          {err && turn.error ? String(turn.error).slice(0, 200) : t('captures.nothingNote')}
        </div>
      )}
    </div>
  );
};

/**
 * The round's converged tail answer — a persistent footer under the card
 * in BOTH states (collapsed: directly under the header; expanded: below the
 * step panel, outside it), and after the steps in the focus overlay. Falls
 * back to the final reasoning (DeepSeek-style thinking-only answers), else
 * a dim note.
 *
 * Owns the assistant-message block language (OutputView's 2px emerald rail
 * + 10px gutter + icon'd role line), so a caller only sets the block's LEFT
 * EDGE: place that edge on the surrounding assistant rail and the label, the
 * prose well and the rail all land on the assistant's own columns.
 */
const RoundTail: React.FC<{ round: TranscriptRound }> = ({ round }) => {
  const { t } = useI18n();
  const hasAnswer = !!(round.finalText || round.finalReasoning);
  return (
    <div
      style={{
        borderLeft: `2px solid ${hasAnswer ? 'var(--accent-emerald)' : 'var(--card-border)'}`,
        paddingLeft: 10,
      }}
    >
      {round.finalText ? (
        <>
          <RoleLabel label={t('captures.roundTailLabel')} color="var(--accent-emerald)" icon={<Bot size={12} />} />
          <Prose text={round.finalText} clamp={6} markdown />
          {round.finalToolCalls.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <Note tone="dim" text={t('captures.roundUnconvergedNote')} />
            </div>
          )}
        </>
      ) : round.finalReasoning ? (
        <>
          <RoleLabel label={t('captures.msgThinking')} color="var(--text-muted)" />
          <Prose text={round.finalReasoning} clamp={6} color="var(--text-muted)" />
          <div style={{ marginTop: 4 }}>
            <Note tone="dim" text={t('captures.roundUnconvergedNote')} />
          </div>
        </>
      ) : (
        <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
          {round.hasError || round.toolCallsIssued > 0
            ? t('captures.roundUnconvergedNote')
            : t('captures.nothingNote')}
        </div>
      )}
    </div>
  );
};

/**
 * One by-prompt round. Header band: bare disclosure triangle leads on the
 * LEFT (tree convention); the title row is ONE inline line — meta chips,
 * prompt (1-line ellipsis, expandable in place), step count. Collapsed
 * (default): header + tail answer — the Q→A skim. Expanded: the waterfall
 * of HTTP turns the prompt drove, held in an independent inset panel
 * (.sub-card language) that owns its own scrollbar capped at 60vh — an
 * expanded round never blows up the session scroll. The tail answer is a
 * persistent footer OUTSIDE the panel in both states — it closes the card
 * below the steps and stays within one short scroll.
 */
const RoundCard: React.FC<{
  round: TranscriptRound;
  ordinal: number;
  date?: string;
  /** Fullscreen reading opens every round; the pane default stays skim-mode. */
  defaultOpen?: boolean;
  /** Renders the ⛶ header button (absent inside the focus overlay itself). */
  onFocus?: () => void;
  onOpenTurn: (idx: number) => void;
}> = ({ round, ordinal, date, defaultOpen, onFocus, onOpenTurn }) => {
  const { t } = useI18n();
  // All rounds collapsed by default — the Q→A skim (header + tail answer)
  // covers the whole session; steps open on demand. In fullscreen reading
  // the point IS the steps, so they start open (still individually
  // collapsible — this only seeds the initial state).
  const [open, setOpen] = useState(defaultOpen ?? false);
  // Round title row: ONE inline line — meta chips, the prompt (1-line
  // ellipsis, full text on hover title), its expand toggle, step count.
  // Overflow is MEASURED horizontally (ResizeObserver), not guessed from
  // char counts — the pane is splitter-resizable and CJK wraps differently.
  const [promptOpen, setPromptOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const promptRef = useRef<HTMLSpanElement | null>(null);
  // Prompt text for the title row — 1-line ellipsis by default, expandable
  // in place. Scrubbed media tokens collapse to a short chip — the
  // thumbnail lives in the step view.
  const excerpt = useMemo(() => {
    if (!round.prompt) return '';
    return collapseMediaTokens(
      round.prompt.blocks
        .filter(b => b.kind === 'text')
        .map(b => unwrapHarnessText(b.text))
        .join('\n')
        .replace(/[ \t]+/g, ' ')
        .trim(),
      t('captures.mediaChip')
    );
  }, [round.prompt, t]);

  useEffect(() => {
    // Only the collapsed inline span needs measuring; while expanded the
    // full text is visible and the toggle stays reachable via promptOpen.
    if (promptOpen) return;
    const el = promptRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() =>
      setClipped(el.scrollWidth > el.clientWidth + 1)
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [excerpt, promptOpen]);

  return (
    <div
      style={{
        marginBottom: 12,
        border: '1px solid var(--card-border)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {/* Header band — the whole band toggles, so it stays quiet at rest and
          lights up on hover (the timeline-row language). A permanent
          --surface-hover fill read as a "selected" gray slab: it boxed the
          prompt in a hard-edged block and washed out the white text. */}
      <div
        className="round-header"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: '8px 12px',
          background: 'transparent',
          cursor: 'pointer',
          fontSize: '12px',
        }}
        onClick={() => setOpen(o => !o)}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-hover)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        {/* Bare disclosure triangle in a fixed 26px slot (tree convention) —
            the bordered square read as a checkbox; the whole band toggles. */}
        <span
          style={{
            width: 26,
            height: 26,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
            flexShrink: 0,
          }}
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Title row — one inline line: dot · round · time · prompt
              (ellipsis) · toggle · steps. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 26 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                flexShrink: 0,
                background: round.hasError ? '#ef4444' : 'var(--accent-emerald)',
              }}
            />
            <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)', flexShrink: 0 }}>{t('captures.roundOrdinal', { n: ordinal })}</span>
            {round.startTs !== undefined && (
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: MONO, flexShrink: 0 }}>{fmtTime(round.startTs)}</span>
            )}
            {excerpt && !promptOpen && (
              <span
                ref={promptRef}
                title={excerpt}
                className="round-prompt-excerpt"
                style={{
                  flex: 1,
                  minWidth: 0,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  fontWeight: 500,
                }}
              >
                {t('captures.msgUser')}: {excerpt}
              </span>
            )}
            {excerpt && (clipped || promptOpen) && (
              <button
                onClick={e => {
                  e.stopPropagation();
                  setPromptOpen(o => !o);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--accent)',
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: '2px 4px',
                  flexShrink: 0,
                }}
              >
                {promptOpen ? t('captures.collapse') : t('captures.expand')}
              </button>
            )}
            <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: MONO, marginLeft: excerpt && !promptOpen ? 0 : 'auto', flexShrink: 0 }}>
              {t('captures.roundStepsUnit', { n: round.steps.length })}
              {round.totalLatencyMs > 0 ? ` · ${fmtDur(round.totalLatencyMs)}` : ''}
            </span>
            {onFocus && (
              <button
                onClick={e => {
                  e.stopPropagation();
                  onFocus();
                }}
                title={t('captures.roundFocus')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-dim)',
                  cursor: 'pointer',
                  padding: 2,
                  display: 'flex',
                  flexShrink: 0,
                }}
              >
                <Maximize2 size={12} />
              </button>
            )}
          </div>
          {/* Expanded prompt — full text as a wrapped block under the row. */}
          {excerpt && promptOpen ? (
            <div
              className="round-prompt-excerpt"
              style={{
                marginTop: 5,
                fontWeight: 500,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                lineHeight: 1.5,
              }}
            >
              {t('captures.msgUser')}: {excerpt}
            </div>
          ) : !excerpt ? (
            <div style={{ marginTop: 5, color: 'var(--text-dim)', fontSize: '11px' }}>
              {t('captures.roundMidOpenNote')}
            </div>
          ) : null}
        </div>
      </div>

      {open && (
        /* Expanded: an independent inset panel (.sub-card language — bg-elev
           fill + one frame) with its own scrollbar; overscroll is contained
           so the wheel stops here instead of chaining to the outer session
           pane. Steps inside read as list rows, not boxes. */
        <div
          style={{
            margin: '10px 12px 12px',
            padding: '6px 10px',
            background: 'var(--bg-elev)',
            border: '1px solid var(--card-border)',
            borderRadius: 8,
            maxHeight: '60vh',
            overflowY: 'auto',
            overscrollBehavior: 'contain',
          }}
        >
          {/* Per-round truncation reminder — the gap is only visible inside
              the waterfall, so the explanation lives here (short line; the
              full capture-era note rides the hover title). */}
          {round.toolResultsSeen < round.toolCallsIssued && (
            <div style={{ padding: '4px 2px 2px' }}>
              <Note tone="warn" text={t('captures.resultsMissingShort')} title={t('captures.resultsMissingNote')} />
            </div>
          )}
          {round.steps.map((st, i) => (
            <TranscriptBlock
              key={`${st.turn.traceId}-${st.idx}`}
              st={st}
              label={`${ordinal}-${i + 1}`}
              date={date}
              first={i === 0}
              onOpenTurn={onOpenTurn}
            />
          ))}
        </div>
      )}
      {/* Tail answer — persistent card footer in BOTH states, outside the
          waterfall panel. RoundTail draws its own assistant rail, so this is
          only the block's LEFT EDGE: collapsed it sits on the prompt column
          (12 + 26 + 10 = 48); expanded it sits on the assistant rail inside
          the panel (panel inset 23 = margin 12 + border 1 + padding 10, plus
          the step row's own padding 2) — never on the panel's content edge,
          which would leave the conclusion 14px left of every assistant row. */}
      <div style={{ padding: open ? '0 23px 10px 25px' : '8px 12px 10px 48px' }}>
        <RoundTail round={round} />
      </div>
    </div>
  );
};

/**
 * Dedicated view for the focus overlay — deliberately NOT a wrapped RoundCard.
 * The pane card's header band exists to toggle collapse and to skim a list;
 * a focused round needs neither: the meta line is static, the prompt shows in
 * full (media renders as thumbnails, not the list's collapsed chip), and the
 * steps flow into the overlay's single scroll layer — no nested card frame,
 * no second 60vh viewport.
 */
const FocusRoundView: React.FC<{
  round: TranscriptRound;
  ordinal: number;
  date?: string;
  onOpenTurn: (idx: number) => void;
}> = ({ round, ordinal, date, onOpenTurn }) => {
  const { t } = useI18n();
  const promptText = useMemo(() => {
    if (!round.prompt) return '';
    return round.prompt.blocks
      .filter(b => b.kind === 'text')
      .map(b => unwrapHarnessText(b.text))
      .join('\n\n')
      .trim();
  }, [round.prompt]);
  return (
    <div style={{ fontSize: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            flexShrink: 0,
            background: round.hasError ? '#ef4444' : 'var(--accent-emerald)',
          }}
        />
        <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-dim)' }}>{t('captures.roundOrdinal', { n: ordinal })}</span>
        {round.startTs !== undefined && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: MONO }}>{fmtTime(round.startTs)}</span>
        )}
        {round.endTs !== undefined && round.endTs !== round.startTs && (
          <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: MONO }}>→ {fmtTime(round.endTs)}</span>
        )}
        <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: MONO, marginLeft: 'auto' }}>
          {t('captures.roundStepsUnit', { n: round.steps.length })}
          {round.totalLatencyMs > 0 ? ` · ${fmtDur(round.totalLatencyMs)}` : ''}
        </span>
      </div>
      {promptText ? (
        <div style={{ marginBottom: 10 }}>
          <RoleLabel label={t('captures.msgUser')} color="var(--accent)" icon={<User size={12} />} />
          <ProseWithMedia text={promptText} date={date} />
        </div>
      ) : (
        <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: 10 }}>
          {t('captures.roundMidOpenNote')}
        </div>
      )}
      {round.toolResultsSeen < round.toolCallsIssued && (
        <div style={{ marginBottom: 8 }}>
          <Note tone="warn" text={t('captures.resultsMissingShort')} title={t('captures.resultsMissingNote')} />
        </div>
      )}
      {round.steps.map((st, i) => (
        <TranscriptBlock
          key={`${st.turn.traceId}-${st.idx}`}
          st={st}
          label={`${ordinal}-${i + 1}`}
          date={date}
          onOpenTurn={onOpenTurn}
        />
      ))}
      {/* Conclusion bar — sticky to the overlay's bottom edge. Why sticky and
          not a flex footer outside the scroll layer: a short round has no
          scrollbar, and a hard-pinned bar would float at the screen bottom
          with a dead gap under the steps; sticky keeps it IN FLOW (right
          below the steps) until the waterfall actually overflows, then it
          rides the bottom edge so the answer stays readable while the steps
          scroll behind it — the same "answer always visible" contract the
          expanded card gets from its footer sitting outside the 60vh panel.
          Opaque bg + hairline rule read as a bar. This bar owns the bottom
          gap (20px, its own padding — the scroll container's is 0 so the two
          never stack); paddingLeft 2 puts the rail RoundTail draws on the
          steps' rails. */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          marginTop: 12,
          paddingTop: 12,
          paddingBottom: 20,
          paddingLeft: 2,
          background: 'var(--bg)',
          borderTop: '1px solid var(--divider)',
          // Ceiling: the tail prose is clamped to 6 lines, so this never
          // engages by default. Only a hand-expanded long answer hits it —
          // then the bar scrolls instead of pushing its own label off the
          // top of the viewport. Upgrade path if it ever bothers anyone:
          // cap the clamp inside the bar.
          maxHeight: '55vh',
          overflowY: 'auto',
        }}
      >
        <RoundTail round={round} />
      </div>
    </div>
  );
};

export const SessionTranscript: React.FC<{
  turns: CaptureTurn[];
  fileTruncated: boolean;
  /** Archive date dir (YYYY-MM-DD) — builds the media read URLs for chips. */
  date?: string;
  /** Fullscreen reading seeds every round open (pane default: collapsed). */
  expandAll?: boolean;
  onOpenTurn: (idx: number) => void;
}> = ({ turns, fileTruncated, date, expandAll, onOpenTurn }) => {
  const { t } = useI18n();
  const items = useMemo(() => buildTranscript(turns), [turns]);
  const rounds = useMemo(() => groupIntoRounds(items), [items]);
  // Single-round focus: one card owns the viewport, open by default. Index
  // into `rounds`; transient like the whole-session fullscreen (never
  // persisted, resets when the archive changes underneath us).
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  useBodyScrollLock(focusIdx !== null);
  useEffect(() => {
    setFocusIdx(null);
  }, [turns]);
  useEffect(() => {
    if (focusIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFocusIdx(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusIdx]);

  const anyContent = items.some(
    s => s.input.length > 0 || s.output || s.reqTruncated || s.reqUnparsed || s.diverged || s.hasResponseBody
  );
  // The missing-results reminder is NOT a session-level banner — it lives on
  // the affected rounds' waterfalls, where the gap is actually visible.

  return (
    <div style={{ fontSize: '12px' }}>
      {fileTruncated && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: '11px',
            color: 'var(--accent-amber)',
            padding: '0 0 10px',
          }}
        >
          <AlertTriangle size={12} />
          <span>{t('captures.fileTruncatedHint')}</span>
        </div>
      )}
      {rounds.length === 0 || !anyContent ? (
        <div style={{ padding: '18px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '12px' }}>
          {t('captures.chatEmpty')}
        </div>
      ) : (
        rounds.map((r, i) => (
          <RoundCard
            key={`${r.steps[0]?.turn.traceId ?? 'r'}-${i}`}
            round={r}
            ordinal={i + 1}
            date={date}
            defaultOpen={expandAll}
            onFocus={() => setFocusIdx(i)}
            onOpenTurn={onOpenTurn}
          />
        ))
      )}
      {focusIdx !== null &&
        rounds[focusIdx] &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 205,
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
              <span style={{ fontSize: '13px', fontWeight: 700 }}>
                {t('captures.roundFocus')} · {t('captures.roundOrdinal', { n: focusIdx + 1 })}
              </span>
              <button
                className="btn btn-sm"
                style={{ marginLeft: 'auto', flexShrink: 0 }}
                onClick={() => setFocusIdx(null)}
                title={t('captures.chatExitFullscreen')}
              >
                <Minimize2 size={12} />
                <span>{t('captures.chatExitFullscreen')}</span>
              </button>
            </div>
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                // Bottom inset 0: the conclusion bar inside carries the 20px
                // gap itself, so pinned and in-flow states measure the same.
                padding: '16px 24px 0',
                display: 'flex',
                justifyContent: 'center',
              }}
            >
              {/* Cap the reading column — full viewport WIDTH for a single
                  round would stretch every prose line past comfortable
                  measure; the win here is height + no competing cards. */}
              <div style={{ width: '100%', maxWidth: 980 }}>
                <FocusRoundView
                  round={rounds[focusIdx]}
                  ordinal={focusIdx + 1}
                  date={date}
                  onOpenTurn={onOpenTurn}
                />
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

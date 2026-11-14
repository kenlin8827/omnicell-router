/**
 * Conversation replay for the capture archive — renders the selected session
 * as user-prompt TURNS: one user prompt opens a turn (header), the HTTP
 * requests it drove (tool-call hops, thinking, results) are the collapsible
 * middle, and the converged answer is the tail. Turn membership is read from
 * the archive's write-time `turnIndex`; each step links to its raw wire drawer.
 */
import React, { useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Bot, ChevronDown, ChevronRight, ChevronsUpDown, Image as ImageIcon, Maximize2, Minimize2, Scale, User, Wrench } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';
import { BackToTop, ScrollToBottom } from './BackToTop';
import { Prose } from './Prose';
import type { CaptureRequestView } from '../lib/api';
import {
  buildTranscript,
  collapseMediaTokens,
  groupIntoTurns,
  isInjectionMessage,
  messageText,
  splitMediaTokens,
  unwrapHarnessText,
  type TranscriptMedia,
  type TranscriptMessage,
  type TranscriptTurn,
  type TranscriptToolCall,
  type TranscriptStep,
  type RequestOutput,
} from '../lib/transcript';
import { shortId, fmtDur, fmtLatency } from '../lib/format';
import { FONT_MONO } from '../lib/fonts';

const MONO = FONT_MONO;

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString();

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
          fontSize: 'var(--text-xs)',
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
          // The turn header is a click-to-toggle surface — never let a
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
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: 2, fontFamily: MONO }}>
        {media.info} · {shortId(media.sha256, 10)}
      </div>
    </div>
  );
};

/** Prose with inline [MEDIA …] tokens surfaced as chips/thumbnails. */
const ProseWithMedia: React.FC<{ text: string; clamp?: number; color?: string; mono?: boolean; date?: string; open?: boolean; hideToggle?: boolean }> = ({
  text,
  clamp,
  color,
  mono,
  date,
  open,
  hideToggle,
}) => {
  const segs = useMemo(() => splitMediaTokens(text), [text]);
  // Fast path: no tokens (the common case) — one plain Prose.
  if (segs.length === 1 && segs[0].kind === 'text') return <Prose text={text} clamp={clamp} color={color} mono={mono} open={open} hideToggle={hideToggle} />;
  return (
    <div>
      {segs.map((s, i) =>
        s.kind === 'media' ? (
          <ImageChip key={i} media={s.media} date={date} />
        ) : s.text.trim() ? (
          <Prose key={i} text={s.text} clamp={clamp} color={color} mono={mono} open={open} hideToggle={hideToggle} />
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
  // Args collapsed by default: a tool-heavy turn stays a readable waterfall;
  // the name row is the toggle.
  const [open, setOpen] = useSectionOpen('toolCall');
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
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', cursor: call.args ? 'pointer' : 'default' }}
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
        <span style={{ fontWeight: 'var(--font-semibold)', fontFamily: MONO }}>{call.name || '?'}</span>
        {call.id && (
          <span style={{ color: 'var(--text-dim)', fontFamily: MONO, fontSize: 'var(--text-2xs)' }}>{shortId(call.id, 10)}</span>
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
  <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', color, marginBottom: 3, letterSpacing: 'var(--tracking-label)' }}>
    {icon}
    {label}
  </div>
);

/** Shared pill-button language for the collapsed-by-default sections
 *  (system prompt / thinking / injected context) — one style, three users. */
const CHIP_BTN: React.CSSProperties = {
  background: 'var(--chip-bg)',
  border: '1px solid var(--card-border)',
  borderRadius: 6,
  color: 'var(--text-muted)',
  cursor: 'pointer',
  fontSize: 'var(--text-xs)',
  padding: '4px 8px',
};

// ------------------------------------------------- focus-overlay bulk expand
// The focus overlay's menu can force-open every section of a kind at once.
// Sections keep their private toggle OUTSIDE the overlay (ctx is null there —
// the pane cards and timeline must not inherit a stranger's bulk state).

type SectionKind = 'thinking' | 'toolCall' | 'toolResult' | 'context' | 'system' | 'answer' | 'finalAnswer';
const SECTION_KINDS: SectionKind[] = ['thinking', 'toolCall', 'toolResult', 'context', 'system', 'answer', 'finalAnswer'];

const ExpandCtx = React.createContext<{ open: Record<SectionKind, boolean>; rev: number } | null>(null);

/** A section's open state: private toggle, re-seeded whenever the focus
 *  overlay's bulk menu commits a change (rev bump). */
const useSectionOpen = (kind: SectionKind): [boolean, React.Dispatch<React.SetStateAction<boolean>>] => {
  const ctx = useContext(ExpandCtx);
  const [open, setOpen] = useState(false);
  const rev = ctx?.rev ?? 0;
  useEffect(() => {
    if (ctx) setOpen(ctx.open[kind]);
    // rev is the commit signal; ctx/open[kind] are read through it by design.
  }, [rev]);
  return [open, setOpen];
};

const ExpandMenu: React.FC<{
  open: Record<SectionKind, boolean>;
  onToggle: (k: SectionKind) => void;
  onAll: (v: boolean) => void;
}> = ({ open, onToggle, onAll }) => {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!show) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [show]);
  const labels: Record<SectionKind, string> = {
    thinking: t('captures.msgThinking'),
    toolCall: t('captures.toolCallLabel'),
    toolResult: t('captures.msgTool'),
    context: t('captures.injectedContext'),
    system: t('captures.msgSystem'),
    answer: t('captures.answerSection'),
    finalAnswer: t('captures.turnTailLabel'),
  };
  return (
    <div ref={ref} style={{ position: 'relative', marginLeft: 'auto', flexShrink: 0 }}>
      <button className="btn btn-sm" onClick={() => setShow(s => !s)} title={t('captures.expandSectionsHint')}>
        <ChevronsUpDown size={12} />
        <span>{t('captures.expandSectionsBtn')}</span>
      </button>
      {show && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            zIndex: 10,
            width: 190,
            background: 'var(--bg-elev)',
            border: '1px solid var(--card-border)',
            borderRadius: 8,
            padding: '6px 10px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          }}
        >
          {SECTION_KINDS.map(k => (
            <label
              key={k}
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', padding: '5px 2px', cursor: 'pointer' }}
            >
              <input type="checkbox" checked={open[k]} onChange={() => onToggle(k)} />
              {labels[k]}
            </label>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 4, paddingTop: 6, borderTop: '1px solid var(--divider)' }}>
            <button className="btn btn-sm" onClick={() => onAll(true)}>
              {t('captures.selectAll')}
            </button>
            <button className="btn btn-sm" onClick={() => onAll(false)}>
              {t('captures.clearAll')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Consecutive harness-injected user messages (system reminders, instruction
 * files, runtime-context snapshots) folded into ONE collapsed chip. They ride
 * the user channel but no human typed them — showing each as a full
 * user-role well buried the real conversation under walls of injected monospace.
 */
const ContextChip: React.FC<{ msgs: TranscriptMessage[] }> = ({ msgs }) => {
  const { t } = useI18n();
  const [open, setOpen] = useSectionOpen('context');
  return (
    <div style={{ marginLeft: 12, marginBottom: 6 }}>
      <button onClick={() => setOpen(o => !o)} style={CHIP_BTN}>
        {t('captures.injectedContext')} · {msgs.length} {t('captures.injectedSegments')} · {open ? t('captures.collapse') : t('captures.expand')}
      </button>
      {open &&
        msgs.map((m, i) => {
          const text = messageText(m);
          return text ? (
            <div key={i} style={{ marginTop: 4 }}>
              <Prose text={text} clamp={40} color="var(--text-muted)" mono={false} />
            </div>
          ) : null;
        })}
    </div>
  );
};

/** One message from the request-side delta (user / tool result / system). */
const MessageView: React.FC<{ msg: TranscriptMessage; date?: string }> = ({ msg, date }) => {
  const { t } = useI18n();
  const [sysOpen, setSysOpen] = useSectionOpen('system');
  // Only user text carries the harness envelope; assistant echoes stay verbatim.
  const text = msg.blocks
    .filter(b => b.kind === 'text')
    .map(b => (msg.role === 'user' ? unwrapHarnessText(b.text) : b.text))
    .join('\n\n');

  if (msg.role === 'system') {
    return (
      <div style={{ marginLeft: 12 }}>
        <button onClick={() => setSysOpen(o => !o)} style={CHIP_BTN}>
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
      {text && (isUser ? <ProseWithMedia text={text} date={date} mono={false} /> : <Prose text={text} markdown />)}
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
  const [open, setOpen] = useSectionOpen('toolResult');
  const long = blockText.split('\n').length > 6 || blockText.length > 6 * 140;
  return (
    <div>
      <div
        onClick={() => long && setOpen(o => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 'var(--text-xs)',
          color: 'var(--text-dim)',
          marginBottom: 3,
          cursor: long ? 'pointer' : 'default',
        }}
      >
        {long ? open ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <span style={{ width: 12, flexShrink: 0 }} />}
        <span className="badge" style={{ fontSize: 'var(--text-2xs)', marginRight: 6 }}>
          {t('captures.msgTool')}
        </span>
        {name && <span style={{ fontFamily: MONO, fontWeight: 'var(--font-semibold)' }}>{name}</span>}
        {long && (
          <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: 'var(--text-xs)' }}>
            {open ? t('captures.collapse') : t('captures.expand')}
          </span>
        )}
      </div>
      {blockText ? (
        <ProseWithMedia text={blockText} clamp={6} date={date} open={open} hideToggle />
      ) : (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>—</div>
      )}
    </div>
  );
};

const OutputView: React.FC<{ out: RequestOutput }> = ({ out }) => {
  const { t } = useI18n();
  const [thinkOpen, setThinkOpen] = useSectionOpen('thinking');
  const [ansOpen, setAnsOpen] = useSectionOpen('answer');
  return (
    <div style={{ borderLeft: '2px solid var(--accent-emerald)', paddingLeft: 10, marginBottom: 6 }}>
      <RoleLabel label={t('captures.msgAssistant')} color="var(--accent-emerald)" icon={<Bot size={12} />} />
      {out.reasoning && (
        <div style={{ marginBottom: 4 }}>
          <button
            onClick={() => setThinkOpen(o => !o)}
            style={{ ...CHIP_BTN, padding: '3px 8px' }}
          >
            {t('captures.msgThinking')} · {thinkOpen ? t('captures.collapse') : t('captures.expand')}
          </button>
          {thinkOpen && (
            <div style={{ marginTop: 4 }}>
              <Prose text={out.reasoning} clamp={20} color="var(--text-muted)" mono={false} />
            </div>
          )}
        </div>
      )}
      {out.text && (
        <Prose text={out.text} markdown open={ansOpen} onOpenChange={setAnsOpen} viewTitle={t('captures.msgAssistant')} />
      )}
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
      fontSize: 'var(--text-xs)',
      color: tone === 'warn' ? 'var(--accent-amber)' : 'var(--text-dim)',
      margin: '2px 0',
    }}
  >
    <AlertTriangle size={12} style={{ marginTop: 2, flexShrink: 0 }} />
    <span>{text}</span>
  </div>
);

const TranscriptBlock: React.FC<{
  st: TranscriptStep;
  label: string;
  date?: string;
  first?: boolean;
  /** The turn's prompt message — already shown at the turn top; skipped here. */
  skipPrompt?: TranscriptMessage | null;
  onOpenRequest: (idx: number) => void;
}> = ({ st, label, date, first, skipPrompt, onOpenRequest }) => {
  const { t } = useI18n();
  const { request } = st;
  const err =
    request.upstreamResponse?.status === 'error' || request.clientResponse?.status === 'error' || !!request.error;
  const upstreamModel = request.upstreamRequest?.model ?? request.upstreamResponse?.model;
  const input = skipPrompt ? st.input.filter(m => m !== skipPrompt) : st.input;
  // Consecutive harness-injection messages fold into one run → one chip.
  const runs: Array<{ ctx: boolean; msgs: TranscriptMessage[] }> = [];
  for (const m of input) {
    const ctx = isInjectionMessage(m);
    const last = runs[runs.length - 1];
    if (last && last.ctx === ctx) last.msgs.push(m);
    else runs.push({ ctx, msgs: [m] });
  }
  const silent = input.length === 0 && !st.output && !st.reqTruncated && !st.reqUnparsed && !st.diverged;

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
      {/* Request header — same chip language as the timeline row; click opens the wire drawer. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: silent && !err ? 0 : 6 }}>
        <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', color: 'var(--text-dim)' }}>#{label}</span>
        {st.ts !== undefined && (
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: MONO }}>{fmtTime(st.ts)}</span>
        )}
        <span className={`badge ${err ? 'badge-danger' : 'badge-success'}`}>
          {err ? t('captures.statusError') : t('captures.statusOk')}
        </span>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)' }}>
          {request.model}
          {upstreamModel && upstreamModel !== request.model && (
            <span style={{ fontWeight: 'var(--font-regular)', color: 'var(--text-dim)' }}> → {upstreamModel}</span>
          )}
        </span>
        {request.gatewayLatencyMs !== undefined && (
          <span title={`${request.gatewayLatencyMs} ms`} style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontFamily: MONO }}>↳ {fmtLatency(request.gatewayLatencyMs)}</span>
        )}
        {request.decisionRequest && (
          <span
            className="badge"
            title={`${t('captures.decisionBadge')} · ${request.decisionRequest.model}${request.decisionLatencyMs !== undefined ? ` · ${request.decisionLatencyMs} ms` : ''}`}
            style={{
              background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
              color: 'var(--accent)',
              fontFamily: MONO,
              fontSize: 'var(--text-2xs)',
              flexShrink: 0,
            }}
          >
            <Scale size={10} style={{ verticalAlign: '-1px', marginRight: '3px' }} />
            {t('captures.decisionBadge')}
            {request.decisionLatencyMs !== undefined && ` · ${fmtLatency(request.decisionLatencyMs)}`}
            {request.decisionRequest.model !== request.model && ` · ${request.decisionRequest.model}`}
          </span>
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
          onClick={() => onOpenRequest(st.idx)}
          title={t('captures.requestRawBtn')}
        >
          {t('captures.requestRawBtn')}
        </button>
      </div>

      {st.diverged && <Note tone="warn" text={t('captures.divergedNote')} />}
      {st.reqUnparsed && <Note tone="dim" text={t('captures.reqUnparsedNote')} />}

      {runs.map((run, i) =>
        run.ctx ? (
          <ContextChip key={`ctx-${i}`} msgs={run.msgs} />
        ) : (
          run.msgs.map((m, j) => (
            <div key={`${i}-${j}`} style={{ marginBottom: 6 }}>
              <MessageView msg={m} date={date} />
            </div>
          ))
        )
      )}

      {st.output ? (
        <OutputView out={st.output} />
      ) : st.hasResponseBody ? (
        <Note tone="dim" text={t('captures.outputUnparsedNote')} />
      ) : null}

      {silent && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: err ? 4 : 0 }}>
          {err && request.error ? String(request.error).slice(0, 200) : t('captures.nothingNote')}
        </div>
      )}
    </div>
  );
};

/**
 * The turn's converged tail answer — a persistent footer under the card
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
const TurnTail: React.FC<{ turn: TranscriptTurn }> = ({ turn }) => {
  const { t } = useI18n();
  const hasAnswer = !!(turn.finalText || turn.finalReasoning);
  // The tail answer joins the bulk-expand vocabulary: the focus overlay's
  // menu can force-open every "final answer" at once (the pane keeps a
  // private toggle — ctx is null there).
  const [tailOpen, setTailOpen] = useSectionOpen('finalAnswer');
  return (
    <div
      style={{
        borderLeft: `2px solid ${hasAnswer ? 'var(--accent-emerald)' : 'var(--card-border)'}`,
        paddingLeft: 10,
      }}
    >
      {turn.finalText ? (
        <>
          <RoleLabel label={t('captures.turnTailLabel')} color="var(--accent-emerald)" icon={<Bot size={12} />} />
          <Prose
            text={turn.finalText}
            clamp={6}
            markdown
            open={tailOpen}
            onOpenChange={setTailOpen}
            viewTitle={t('captures.turnTailLabel')}
          />
          {turn.finalToolCalls.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <Note tone="dim" text={t('captures.turnUnconvergedNote')} />
            </div>
          )}
        </>
      ) : turn.finalReasoning ? (
        <>
          <RoleLabel label={t('captures.msgThinking')} color="var(--text-muted)" />
          <Prose text={turn.finalReasoning} clamp={6} color="var(--text-muted)" mono={false} />
          <div style={{ marginTop: 4 }}>
            <Note tone="dim" text={t('captures.turnUnconvergedNote')} />
          </div>
        </>
      ) : (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
          {turn.hasError || turn.toolCallsIssued > 0
            ? t('captures.turnUnconvergedNote')
            : t('captures.nothingNote')}
        </div>
      )}
    </div>
  );
};

/**
 * One by-prompt turn. Header band: bare disclosure triangle leads on the
 * LEFT (tree convention); the title row is ONE inline line — meta chips,
 * prompt (1-line ellipsis, expandable in place), step count. Collapsed
 * (default): header + tail answer — the Q→A skim. Expanded: the waterfall
 * of HTTP requests the prompt drove, held in an independent inset panel
 * (.sub-card language) that owns its own scrollbar capped at 60vh — an
 * expanded turn never blows up the session scroll. The tail answer is a
 * persistent footer OUTSIDE the panel in both states — it closes the card
 * below the steps and stays within one short scroll.
 */
const TurnCard: React.FC<{
  turn: TranscriptTurn;
  ordinal: number;
  date?: string;
  /** First turn in the list — no hairline rule above it. */
  first?: boolean;
  /** Fullscreen reading opens every turn; the pane default stays skim-mode. */
  defaultOpen?: boolean;
  /** Renders the ⛶ header button (absent inside the focus overlay itself). */
  onFocus?: () => void;
  onOpenRequest: (idx: number) => void;
}> = ({ turn, ordinal, date, first, defaultOpen, onFocus, onOpenRequest }) => {
  const { t } = useI18n();
  // All turns collapsed by default — the Q→A skim (header + tail answer)
  // covers the whole session; steps open on demand. In fullscreen reading
  // the point IS the steps, so they start open (still individually
  // collapsible — this only seeds the initial state).
  const [open, setOpen] = useState(defaultOpen ?? false);
  // Turn title row: ONE inline line — meta chips, the prompt (1-line
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
    if (!turn.prompt) return '';
    return collapseMediaTokens(
      turn.prompt.blocks
        .filter(b => b.kind === 'text')
        .map(b => unwrapHarnessText(b.text))
        .join('\n')
        .replace(/[ \t]+/g, ' ')
        .trim(),
      t('captures.mediaChip')
    );
  }, [turn.prompt, t]);

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
        // Flat section, not a box: turns divide by one hairline rule (the
        // step rows' list-group language) — a bordered card per turn read
        // as a stack of pillowy wide-flat boxes inside the page column's
        // own frame (triple nesting). Breathing room comes from the header
        // and tail paddings around the rule.
        borderTop: first ? undefined : '1px solid var(--divider)',
      }}
    >
      {/* Header band — the whole band toggles. NO background fill and NO
          text lift on hover (operator calls: the gray slab boxed the prompt
          in a hard-edged block; the hover flicker across a long list read
          as noise) — the affordance is the cursor + disclosure triangle. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: '8px 12px',
          cursor: 'pointer',
          fontSize: 'var(--text-sm)',
        }}
        onClick={() => setOpen(o => !o)}
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
          {/* Title row — one inline line: dot · turn · time · prompt
              (ellipsis) · toggle · steps. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 26 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                flexShrink: 0,
                background: turn.hasError ? '#ef4444' : 'var(--accent-emerald)',
              }}
            />
            <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', color: 'var(--text-dim)', flexShrink: 0 }}>{t('captures.turnOrdinal', { n: ordinal })}</span>
            {turn.startTs !== undefined && (
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: MONO, flexShrink: 0 }}>{fmtTime(turn.startTs)}</span>
            )}
            {excerpt && !promptOpen && (
              <span
                ref={promptRef}
                title={excerpt}
                className="turn-prompt-excerpt"
                style={{
                  flex: 1,
                  minWidth: 0,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  fontWeight: 'var(--font-medium)',
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
                  fontSize: 'var(--text-xs)',
                  padding: '2px 4px',
                  flexShrink: 0,
                  // The toggle stays on the RIGHT in both states: collapsed,
                  // the flex:1 excerpt span pushes it there; expanded, that
                  // span unmounts, so the button must claim the auto margin
                  // itself — otherwise it drifts next to the time chip.
                  marginLeft: promptOpen ? 'auto' : undefined,
                }}
              >
                {promptOpen ? t('captures.collapse') : t('captures.expand')}
              </button>
            )}
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontFamily: MONO, marginLeft: excerpt ? 0 : 'auto', flexShrink: 0 }}>
              {t('captures.turnStepsUnit', { n: turn.steps.length })}
              {turn.totalLatencyMs > 0 ? ` · ${fmtDur(turn.totalLatencyMs)}` : ''}
            </span>
            {onFocus && (
              <button
                onClick={e => {
                  e.stopPropagation();
                  onFocus();
                }}
                title={t('captures.turnFocus')}
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
          {/* Expanded prompt — full text as a wrapped block under the row.
              No quiet-list class: reading text sits at the main color. */}
          {excerpt && promptOpen ? (
            <div
              style={{
                marginTop: 5,
                fontWeight: 'var(--font-medium)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                lineHeight: 'var(--leading-snug)',
              }}
            >
              {t('captures.msgUser')}: {excerpt}
            </div>
          ) : !excerpt ? (
            <div style={{ marginTop: 5, color: 'var(--text-dim)', fontSize: 'var(--text-xs)' }}>
              {t('captures.turnMidOpenNote')}
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
          {/* Per-turn truncation reminder — the gap is only visible inside
              the waterfall, so the explanation lives here (short line; the
              full capture-era note rides the hover title). */}
          {turn.toolResultsSeen < turn.toolCallsIssued && (
            <div style={{ padding: '4px 2px 2px' }}>
              <Note tone="warn" text={t('captures.resultsMissingShort')} title={t('captures.resultsMissingNote')} />
            </div>
          )}
          {turn.steps.map((st, i) => (
            <TranscriptBlock
              key={`${st.request.requestId}-${st.idx}`}
              st={st}
              label={`${ordinal}-${i + 1}`}
              date={date}
              first={i === 0}
              skipPrompt={turn.prompt}
              onOpenRequest={onOpenRequest}
            />
          ))}
        </div>
      )}
      {/* Tail answer — persistent card footer in BOTH states, outside the
          waterfall panel. TurnTail draws its own assistant rail, so this is
          only the block's LEFT EDGE: collapsed it sits on the prompt column
          (12 + 26 + 10 = 48); expanded it sits on the assistant rail inside
          the panel (panel inset 23 = margin 12 + border 1 + padding 10, plus
          the step row's own padding 2) — never on the panel's content edge,
          which would leave the conclusion 14px left of every assistant row. */}
      <div style={{ padding: open ? '0 23px 10px 25px' : '8px 12px 10px 48px' }}>
        <TurnTail turn={turn} />
      </div>
    </div>
  );
};

/**
 * Dedicated view for the focus overlay — deliberately NOT a wrapped TurnCard.
 * The pane card's header band exists to toggle collapse and to skim a list;
 * a focused turn needs neither: the meta line is static, the prompt shows in
 * full (media renders as thumbnails, not the list's collapsed chip), and the
 * steps flow into the overlay's single scroll layer — no nested card frame,
 * no second 60vh viewport.
 */
const FocusTurnView: React.FC<{
  turn: TranscriptTurn;
  ordinal: number;
  date?: string;
  onOpenRequest: (idx: number) => void;
}> = ({ turn, ordinal, date, onOpenRequest }) => {
  const { t } = useI18n();
  const promptText = useMemo(() => {
    if (!turn.prompt) return '';
    return turn.prompt.blocks
      .filter(b => b.kind === 'text')
      .map(b => unwrapHarnessText(b.text))
      .join('\n\n')
      .trim();
  }, [turn.prompt]);
  return (
    <div style={{ fontSize: 'var(--text-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            flexShrink: 0,
            background: turn.hasError ? '#ef4444' : 'var(--accent-emerald)',
          }}
        />
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-bold)', color: 'var(--text-dim)' }}>{t('captures.turnOrdinal', { n: ordinal })}</span>
        {turn.startTs !== undefined && (
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: MONO }}>{fmtTime(turn.startTs)}</span>
        )}
        {turn.endTs !== undefined && turn.endTs !== turn.startTs && (
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontFamily: MONO }}>→ {fmtTime(turn.endTs)}</span>
        )}
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontFamily: MONO, marginLeft: 'auto' }}>
          {t('captures.turnStepsUnit', { n: turn.steps.length })}
          {turn.totalLatencyMs > 0 ? ` · ${fmtDur(turn.totalLatencyMs)}` : ''}
        </span>
      </div>
      {promptText ? (
        <div style={{ marginBottom: 10 }}>
          <RoleLabel label={t('captures.msgUser')} color="var(--accent)" icon={<User size={12} />} />
          <ProseWithMedia text={promptText} date={date} mono={false} />
        </div>
      ) : (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: 10 }}>
          {t('captures.turnMidOpenNote')}
        </div>
      )}
      {turn.toolResultsSeen < turn.toolCallsIssued && (
        <div style={{ marginBottom: 8 }}>
          <Note tone="warn" text={t('captures.resultsMissingShort')} title={t('captures.resultsMissingNote')} />
        </div>
      )}
      {turn.steps.map((st, i) => (
        <TranscriptBlock
          key={`${st.request.requestId}-${st.idx}`}
          st={st}
          label={`${ordinal}-${i + 1}`}
          date={date}
          skipPrompt={turn.prompt}
          onOpenRequest={onOpenRequest}
        />
      ))}
      {/* Conclusion — plain in-flow tail of the waterfall, right after the
          steps (was sticky-pinned to the overlay's bottom edge; that kept the
          answer visible while the steps scrolled behind it, but read as a
          floating bar and hid where the page actually ends). The hairline top
          rule keeps the visual break from the steps; no opaque background is
          needed anymore — nothing scrolls past it. paddingLeft 2 puts the
          rail TurnTail draws on the steps' rails. It still owns the 20px
          bottom gap (its own padding — the page frame and the scroll
          container both end with 0, so the two never stack). */}
      <div
        style={{
          marginTop: 12,
          paddingTop: 12,
          paddingBottom: 20,
          paddingLeft: 2,
          borderTop: '1px solid var(--divider)',
        }}
      >
        <TurnTail turn={turn} />
      </div>
    </div>
  );
};

// Progressive turn rendering: paint the first page immediately, then pull
// in the next page whenever the sentinel below the last painted turn
// approaches the viewport. Long sessions never block on one giant render —
// the list loads in steps while the user reads downward.
const TURNS_PAGE = 20;

export const SessionTranscript: React.FC<{
  requests: CaptureRequestView[];
  fileTruncated: boolean;
  /** Archive date dir (YYYY-MM-DD) — builds the media read URLs for chips. */
  date?: string;
  /** Fullscreen reading seeds every turn open (pane default: collapsed). */
  expandAll?: boolean;
  onOpenRequest: (idx: number) => void;
}> = ({ requests, fileTruncated, date, expandAll, onOpenRequest }) => {
  const { t } = useI18n();
  // Transcript parsing (one JSON.parse per wire body) is the heaviest CPU
  // step of the lens — run it against the deferred requests so a session switch
  // paints the pane shell before the parse lands.
  const deferredRequests = useDeferredValue(requests);
  const items = useMemo(() => buildTranscript(deferredRequests), [deferredRequests]);
  const turns = useMemo(() => groupIntoTurns(items), [items]);
  const [visibleTurns, setVisibleTurns] = useState(TURNS_PAGE);
  useEffect(() => {
    setVisibleTurns(TURNS_PAGE);
  }, [requests]);
  const shown = useMemo(() => turns.slice(0, visibleTurns), [turns, visibleTurns]);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || visibleTurns >= turns.length) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisibleTurns(turns.length);
      return;
    }
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          setVisibleTurns(c => Math.min(c + TURNS_PAGE, turns.length));
        }
      },
      { rootMargin: '600px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visibleTurns, turns.length]);
  // Single-turn focus: one card owns the viewport, open by default. Index
  // into `turns`; transient like the whole-session fullscreen (never
  // persisted, resets when the archive changes underneath us).
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  // Bulk-expand menu (focus overlay only): committing a change bumps `secRev`,
  // which re-seeds every matching section inside the provider below.
  const [secOpen, setSecOpen] = useState<Record<SectionKind, boolean>>({
    thinking: false,
    toolCall: false,
    toolResult: false,
    context: false,
    system: false,
    answer: false,
    finalAnswer: false,
  });
  const [secRev, setSecRev] = useState(0);
  // Scroll layer of the focus overlay — feeds the back-to-top pill.
  const focusScrollRef = useRef<HTMLDivElement | null>(null);
  const toggleSec = (k: SectionKind) => {
    setSecOpen(s => ({ ...s, [k]: !s[k] }));
    setSecRev(r => r + 1);
  };
  const allSec = (v: boolean) => {
    setSecOpen(Object.fromEntries(SECTION_KINDS.map(k => [k, v])) as Record<SectionKind, boolean>);
    setSecRev(r => r + 1);
  };
  useBodyScrollLock(focusIdx !== null);
  useEffect(() => {
    setFocusIdx(null);
  }, [requests]);
  useEffect(() => {
    if (focusIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      // Any dialog stacked on top of this overlay (e.g. the answer reading
      // view) owns Escape first — close only the topmost layer.
      if (document.querySelector('[data-ocr-dialog]')) return;
      if (e.key === 'Escape') setFocusIdx(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusIdx]);

  const anyContent = items.some(
    s => s.input.length > 0 || s.output || s.reqTruncated || s.reqUnparsed || s.diverged || s.hasResponseBody
  );
  // The missing-results reminder is NOT a session-level banner — it lives on
  // the affected turns' waterfalls, where the gap is actually visible.

  return (
    <div style={{ fontSize: 'var(--text-sm)' }}>
      {fileTruncated && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 'var(--text-xs)',
            color: 'var(--accent-amber)',
            padding: '0 0 10px',
          }}
        >
          <AlertTriangle size={12} />
          <span>{t('captures.fileTruncatedHint')}</span>
        </div>
      )}
      {turns.length === 0 || !anyContent ? (
        <div style={{ padding: '18px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>
          {t('captures.chatEmpty')}
        </div>
      ) : (
        shown.map((r, i) => (
          <TurnCard
            key={`${r.steps[0]?.request.requestId ?? 'r'}-${i}`}
            turn={r}
            ordinal={r.turnIndex}
            date={date}
            first={i === 0}
            defaultOpen={expandAll}
            onFocus={() => setFocusIdx(i)}
            onOpenRequest={onOpenRequest}
          />
        ))
      )}
      {visibleTurns < turns.length && (
        <div
          ref={sentinelRef}
          style={{
            padding: '14px 0 20px',
            textAlign: 'center',
            color: 'var(--text-dim)',
            fontSize: 'var(--text-xs)',
          }}
        >
          {t('captures.loadingMoreTurns')}
        </div>
      )}
      {focusIdx !== null &&
        turns[focusIdx] &&
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
              <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--font-bold)' }}>
                {t('captures.turnFocus')} · {t('captures.turnOrdinal', { n: turns[focusIdx]?.turnIndex ?? focusIdx + 1 })}
              </span>
              <ExpandMenu open={secOpen} onToggle={toggleSec} onAll={allSec} />
              <button
                className="btn btn-sm"
                style={{ flexShrink: 0 }}
                onClick={() => setFocusIdx(null)}
                title={t('captures.chatExitFullscreen')}
              >
                <Minimize2 size={12} />
                <span>{t('captures.chatExitFullscreen')}</span>
              </button>
            </div>
            <div
              ref={focusScrollRef}
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                // Bottom inset 0: the in-flow conclusion tail inside carries
                // the 20px bottom gap itself (its own padding), so the page
                // frame's fill ends exactly where the content ends.
                padding: '16px 24px 0',
              }}
            >
              {/* Cap the reading column — full viewport WIDTH for a single
                  turn would stretch every prose line past comfortable
                  measure; the win here is height + no competing cards.
                  The column is a visible PAGE: frame + elevated fill give
                  the reading area left/right edge lines — borderless, the
                  content floated in the --bg void with no boundary. */}
              <ExpandCtx.Provider value={{ open: secOpen, rev: secRev }}>
                <div
                  style={{
                    width: '100%',
                    maxWidth: 980,
                    margin: '0 auto',
                    // Fill the scrollport even for short turns (frame spans
                    // the whole visible page) and GROW past it for long ones
                    // — flex-stretch pinned the box to viewport height and
                    // the steps leaked below its own bottom border.
                    minHeight: '100%',
                    boxSizing: 'border-box',
                    border: '1px solid var(--card-border)',
                    borderRadius: 10,
                    background: 'var(--bg-elev)',
                    padding: '14px 18px 0',
                  }}
                >
                  <FocusTurnView
                    turn={turns[focusIdx]}
                    ordinal={turns[focusIdx]?.turnIndex ?? focusIdx + 1}
                    date={date}
                    onOpenRequest={onOpenRequest}
                  />
                </div>
              </ExpandCtx.Provider>
            </div>
            {/* Siblings of the scroll layer, absolute against the fixed root. */}
            <BackToTop scrollRef={focusScrollRef} />
            <ScrollToBottom scrollRef={focusScrollRef} />
          </div>,
          document.body
        )}
    </div>
  );
};

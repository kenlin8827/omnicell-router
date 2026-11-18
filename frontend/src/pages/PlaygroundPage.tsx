/**
 * /playground — client-simulation playground for the gateway's two inference
 * protocol families, one menu entry and two tabs:
 *
 *  - chat tab: `POST /v1/chat/completions` — a multi-turn conversation that
 *    behaves like an external SDK client (inbound key validation + rate limits,
 *    per-key model access, the routing ladder, failover, capture, sessions).
 *  - decision tab: `POST /v1/systemone` — the System One decision wire: one
 *    `state` evaluated against typed `questions`, answered with values and
 *    probabilities. Served natively by a decision-wire provider or by protocol
 *    conversion through a chat model.
 *
 * Deliberately NOT a console API client: every request is sent over the real
 * client wire with the selected key as `Authorization: Bearer`, and the X-OCR
 * observation headers are surfaced so the routing decision can be verified from
 * the client side. Model wires come from the gateway catalog (single source:
 * backend/src/providers/wire.ts) — never re-derived here.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Bot, Check, ChevronRight, Clock, Copy, Eraser, Expand, Eye, EyeOff, Loader2, Maximize2, MessagesSquare, Minimize2, Plus, Save, Send, Shrink, Square, Trash2, User } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, type ApiKeyItem } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { InfoTip } from '../components/InfoTip';
import { Dialog } from '../components/Dialog';
import { useConfirm } from '../components/ConfirmProvider';
import { Combobox } from '../components/Combobox';
import { SegGroup } from '../components/SegGroup';
import { Switch } from '../components/Switch';
import { MD_COMPONENTS, MD_PLUGINS } from '../components/Prose';
import { copyToClipboard } from '../lib/clipboard';
import { FONT_MONO } from '../lib/fonts';
import type { PlaygroundPreset, PlaygroundPresetQuestion } from '../i18n/types';
import { decodeRate, formatRate } from '../lib/format';
import { EFFORT_LADDER, EFFORT_I18N_KEY, type ReasoningEffort } from '../lib/effort';

/** The observation header names — one place, so header and summary parsing
 *  read the SAME vocabulary (the summary frame reuses the header keys). */
const HDR = {
  tier: 'X-OCR-Tier',
  layer: 'X-OCR-Layer',
  model: 'X-OCR-Model',
  variant: 'X-OCR-Variant',
  failover: 'X-OCR-Failover',
  failoverPath: 'X-OCR-Failover-Path',
  retries: 'X-OCR-InPlace-Retries',
  breaker: 'X-OCR-Breaker-State',
  session: 'X-OCR-Session-ID',
  request: 'X-OCR-Request-ID',
  latency: 'X-OCR-Latency-MS',
  /** Gateway-measured decode window (first streamed chunk → stream end) —
   *  present only when the committed attempt streamed; the tok/s denominator. */
  genMs: 'X-OCR-Gen-MS',
  thinkRequested: 'X-OCR-Thinking-Requested',
  thinkActual: 'X-OCR-Thinking-Actual',
  thinkSource: 'X-OCR-Thinking-Source',
} as const;

/** Decision wire only: which limb served the call (native passthrough vs
 *  chat-model conversion). Absent on every other surface. */
const HDR_SYSTEMONE_UPSTREAM = 'X-OCR-Systemone-Upstream';

/** The presets live in the i18n dictionary — clone before they enter editable
 *  state so a form edit can never mutate the active language's table. */
const cloneDrafts = (drafts: QuestionDraft[]): QuestionDraft[] =>
  drafts.map((q) => ({ ...q, choices: q.choices.map((c) => ({ ...c })), levels: [...q.levels] }));

/** System prompt presets persisted in localStorage. */
interface PromptPreset { id: string; name: string; content: string }
const PROMPT_PRESETS_KEY = 'ocr_playground_prompt_presets';
const loadPromptPresets = (): PromptPreset[] => {
  try {
    const raw = localStorage.getItem(PROMPT_PRESETS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is PromptPreset => {
        if (typeof p !== 'object' || p == null) return false;
        const r = p as Record<string, unknown>;
        return typeof r.id === 'string' && typeof r.name === 'string' && typeof r.content === 'string';
      },
    );
  } catch {
    return [];
  }
};
const savePromptPresets = (presets: PromptPreset[]) => {
  try { localStorage.setItem(PROMPT_PRESETS_KEY, JSON.stringify(presets)); } catch { /* best-effort */ }
};

// ── playground multi-conversation persistence ───────────────────────────────
// All state lives in localStorage — zero backend involvement.  Each tab (chat
// and decision) owns an independent conversation list; the active conversation
// auto-saves on every meaningful state change and auto-restores on mount.

const PG_CHAT_KEY = 'ocr_playground_chats';
const PG_DECISION_KEY = 'ocr_playground_decisions';
const PG_TITLE_LEN = 48;
const PG_MAX_CONVERSATIONS = 50;

interface PgChatConversation {
  id: string;
  title: string;
  sessionId: string;
  turns: ChatTurn[];
  model: string;
  systemPrompt: string;
  draft: string;
  nextId: number;
  createdAt: number;
  updatedAt: number;
}

interface PgDecisionConversation {
  id: string;
  title: string;
  presetId: string;
  stateInput: string;
  questionDrafts: QuestionDraft[];
  createdAt: number;
  updatedAt: number;
}

/** Derive a display title from the first user turn (or the decision state). */
const chatTitle = (turns: ChatTurn[]): string => {
  const first = turns.find(t => t.role === 'user' && t.content);
  if (!first) return '';
  return first.content.slice(0, PG_TITLE_LEN).replace(/\n/g, ' ');
};


// ── chat store ──

const loadChatStore = (): { active: string; conversations: PgChatConversation[] } => {
  try {
    const raw = localStorage.getItem(PG_CHAT_KEY);
    if (!raw) return { active: '', conversations: [] };
    const parsed = JSON.parse(raw) as { active?: string; conversations?: unknown[] };
    const list = Array.isArray(parsed.conversations)
      ? (parsed.conversations as PgChatConversation[]).filter(
          c => c && typeof c.id === 'string' && typeof c.sessionId === 'string'
        )
      : [];
    return { active: typeof parsed.active === 'string' ? parsed.active : '', conversations: list };
  } catch { return { active: '', conversations: [] }; }
};

const saveChatStore = (active: string, conversations: PgChatConversation[]) => {
  try {
    const trimmed = conversations.slice(0, PG_MAX_CONVERSATIONS);
    localStorage.setItem(PG_CHAT_KEY, JSON.stringify({ active, conversations: trimmed }));
  } catch { /* best-effort */ }
};

// ── decision store ──

const loadDecisionStore = (): { active: string; conversations: PgDecisionConversation[] } => {
  try {
    const raw = localStorage.getItem(PG_DECISION_KEY);
    if (!raw) return { active: '', conversations: [] };
    const parsed = JSON.parse(raw) as { active?: string; conversations?: unknown[] };
    const list = Array.isArray(parsed.conversations)
      ? (parsed.conversations as PgDecisionConversation[]).filter(
          c => c && typeof c.id === 'string' && typeof c.stateInput === 'string'
        )
      : [];
    return { active: typeof parsed.active === 'string' ? parsed.active : '', conversations: list };
  } catch { return { active: '', conversations: [] }; }
};

const saveDecisionStore = (active: string, conversations: PgDecisionConversation[]) => {
  try {
    const trimmed = conversations.slice(0, PG_MAX_CONVERSATIONS);
    localStorage.setItem(PG_DECISION_KEY, JSON.stringify({ active, conversations: trimmed }));
  } catch { /* best-effort */ }
};

const mintPlaygroundSessionId = (): string => `pg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

/** A conversation that does not exist yet — the empty-store seed and the
 *  target of "new conversation". */
const emptyChatConversation = (): PgChatConversation => {
  const now = Date.now();
  return {
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
    title: '',
    sessionId: mintPlaygroundSessionId(),
    turns: [],
    model: 'auto',
    systemPrompt: '',
    draft: '',
    nextId: 1,
    createdAt: now,
    updatedAt: now,
  };
};

/** Store + an ACTIVE conversation that really exists in it. An empty store
 *  seeds one: the auto-save effect keys off the active id, so without a seeded
 *  conversation a first visit would never persist a single turn. */
const loadChatStoreWithActive = (): { active: string; conversations: PgChatConversation[] } => {
  const store = loadChatStore();
  const conversations = store.conversations.length > 0 ? store.conversations : [emptyChatConversation()];
  const active = conversations.some(c => c.id === store.active) ? store.active : conversations[0].id;
  return { active, conversations };
};

/** Decision-tab twin of `emptyChatConversation`: a fresh draft seeded from the
 *  given preset (undefined = blank preset fields). */
const emptyDecisionConversation = (preset?: PlaygroundPreset): PgDecisionConversation => {
  const now = Date.now();
  return {
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
    title: '',
    presetId: preset?.id ?? '',
    stateInput: preset?.state ?? '',
    questionDrafts: cloneDrafts(preset?.questions ?? []),
    createdAt: now,
    updatedAt: now,
  };
};

const loadDecisionStoreWithActive = (presets: PlaygroundPreset[]): {
  active: string;
  conversations: PgDecisionConversation[];
} => {
  const store = loadDecisionStore();
  const conversations = store.conversations.length > 0 ? store.conversations : [emptyDecisionConversation(presets[0])];
  const active = conversations.some(c => c.id === store.active) ? store.active : conversations[0].id;
  return { active, conversations };
};

interface TurnFacts {
  status: number;
  model?: string;
  tier?: string;
  layer?: string;
  variant?: string;
  failover?: string;
  failoverPath?: string;
  retries?: string;
  breaker?: string;
  sessionId?: string;
  requestId?: string;
  latencyMs?: string;
  /** Gateway-reported decode window; absent on buffered (non-streamed) turns. */
  genMs?: string;
  thinking?: string;
  thinkingSource?: string;
}

interface TurnUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface ChatTurn {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  /** Upstream `reasoning_content` — kept apart so the answer stays readable. */
  reasoning?: string;
  pending?: boolean;
  status?: number;
  error?: string;
  facts?: TurnFacts;
  usage?: TurnUsage;
  /** Raw bodies behind the turn's details drawer. */
  requestJson?: unknown;
  responseJson?: unknown;
}

/** Last decision-wire round trip (single result, replaced on each send). */
interface DecisionResult {
  status: number;
  ok: boolean;
  upstream?: string;
  facts: TurnFacts;
  body?: unknown;
  raw?: string;
  requestJson?: unknown;
}

/** System One question types (protocol: choice | noul | score). */
/** One editable question in the decision tab's builder — the preset shape from
 *  the i18n tables is the same contract, so no second type exists. */
type QuestionType = PlaygroundPresetQuestion['type'];
type QuestionDraft = PlaygroundPresetQuestion;

const newQuestionDraft = (n: number): QuestionDraft => ({
  id: `q${n}`,
  type: 'choice',
  instructions: '',
  choices: [{ key: '', desc: '' }],
  levels: ['', ''],
});

const nonEmpty = (v?: string | null): string | undefined => (v && v.trim() !== '' ? v : undefined);

/** The decision wire accepts a string | object | array state: decode JSON-looking
 *  input, otherwise send the raw text. One helper so the payload preview and the
 *  actual request can never disagree. */
const decodeState = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/** Merge a later fact source over an earlier one WITHOUT letting absent keys
 *  (readFacts reports `undefined`) erase what the headers already told us —
 *  the summary frame only carries completion facts, the headers carry routing. */
const mergeFacts = (base: TurnFacts, extra: TurnFacts): TurnFacts => {
  const out: TurnFacts = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
};

/** Build the per-turn fact block from ANY keyed source (headers or summary
 *  frame) — identical vocabulary, so one reader serves both legs. */
const readFacts = (get: (name: string) => string | undefined, status: number): TurnFacts => ({
  status,
  model: nonEmpty(get(HDR.model)),
  tier: nonEmpty(get(HDR.tier)),
  layer: nonEmpty(get(HDR.layer)),
  variant: nonEmpty(get(HDR.variant)),
  failover: nonEmpty(get(HDR.failover)),
  failoverPath: nonEmpty(get(HDR.failoverPath)),
  retries: nonEmpty(get(HDR.retries)),
  breaker: nonEmpty(get(HDR.breaker)),
  sessionId: nonEmpty(get(HDR.session)),
  requestId: nonEmpty(get(HDR.request)),
  latencyMs: nonEmpty(get(HDR.latency)),
  genMs: nonEmpty(get(HDR.genMs)),
  thinking: nonEmpty(get(HDR.thinkActual)) ?? nonEmpty(get(HDR.thinkRequested)),
  thinkingSource: nonEmpty(get(HDR.thinkSource)),
});

/** True when the browser can mask an ordinary text input. `type="text"` never
 *  matches Chrome's password heuristic, so the saved-credential dropdown and
 *  the "suggest a strong password" popup never appear over a pasted API key.
 *  Firefox lacks the property — there the field falls back to a real password
 *  input (popup returns, but the key is never shown in clear). */
const CAN_MASK_TEXT =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc');

const labelStyle: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  color: 'var(--text-dim)',
};

/** JSON well with an expand affordance: inline stays height-capped, the dialog
 *  shows the same text unclamped (fullscreen toggle for wide payloads). */
const JsonBlock: React.FC<{
  label?: string;
  bare?: boolean;
  /** Render as a `<details>` whose summary IS the label row, so the expand
   *  affordance sits on the same line as the caption instead of one below. */
  collapsible?: boolean;
  text: string;
  maxHeight?: number;
}> = ({ label, bare, collapsible, text, maxHeight }) => {
  const { t } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const copy = async () => {
    const ok = await copyToClipboard(text);
    if (!ok) {
      toast.error(t('chat.jsonCopyFailed'));
      return;
    }
    setCopied(true);
    toast.success(t('chat.jsonCopied'));
    window.setTimeout(() => setCopied(false), 1200);
  };
  const head = (
    // `inline-flex` (not flex): a block box inside <summary> pushes the native
    // disclosure triangle onto its own line; an inline-level box keeps the
    // marker beside the caption.
    <div
      style={{
        display: 'inline-flex',
        // width:100% is what right-aligns the affordance; flex lets it shrink
        // by the chevron's width inside a <summary>.
        flex: '1 1 auto',
        width: '100%',
        minWidth: 0,
        alignItems: 'center',
        justifyContent: bare ? 'flex-end' : 'space-between',
        gap: 8,
        marginBottom: 2,
      }}
    >
      {!bare && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{label}</span>}
      <button
        type="button"
        className="btn btn-sm"
        onClick={(e) => {
          // Inside a <summary> a click would also toggle the details.
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        title={t('chat.jsonExpand')}
        aria-label={t('chat.jsonExpand')}
      >
        <Maximize2 size={12} />
      </button>
    </div>
  );
  const well = <pre style={{ ...jsonWell, width: '100%', ...(maxHeight ? { maxHeight } : {}) }}>{text}</pre>;
  return (
    // Full width: the block is a flex item in narrow columns and would other-
    // wise shrink to its widest line, leaving the well half-empty.
    <div style={{ width: '100%', minWidth: 0 }}>
      {collapsible ? (
        // Own chevron instead of the native marker: the marker's placement
        // depends on the summary's first child being inline-level, which is
        // fragile once the head wraps.
        <details
          open={expanded}
          onToggle={(e) => setExpanded((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary style={{ cursor: 'pointer', listStyle: 'none', display: 'flex', alignItems: 'center' }}>
            <ChevronRight
              size={12}
              style={{ flexShrink: 0, marginRight: 2, transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'none' }}
            />
            {head}
          </summary>
          {well}
        </details>
      ) : (
        <>
          {head}
          {well}
        </>
      )}
      {open && (
        <Dialog
          title={label ?? ''}
          closeLabel={t('common.close')}
          width={960}
          full={full}
          onClose={() => {
            setOpen(false);
            setFull(false);
          }}
          headerActions={
            <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void copy()}
              title={t('chat.jsonCopy')}
              aria-label={t('chat.jsonCopy')}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setFull((f) => !f)}
              title={t('chat.jsonExpand')}
              aria-label={t('chat.jsonExpand')}
            >
              {full ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            </>
          }
        >
          {/* Direct child of the dialog body (a flex column): `flex: 1` fills
              the leftover height, `minHeight: 0` lets the well scroll instead
              of pushing the dialog past the viewport. */}
          <pre style={{ ...jsonWell, flex: full ? 1 : 'initial', minHeight: 0, width: '100%', maxHeight: 'none' }}>{text}</pre>
        </Dialog>
      )}
    </div>
  );
};

const chipStyle: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  lineHeight: 'var(--leading-snug)',
  padding: '0 6px',
  borderRadius: 999,
  border: '1px solid var(--card-border)',
  color: 'var(--text-dim)',
  whiteSpace: 'nowrap',
};

const jsonWell: React.CSSProperties = {
  margin: 0,
  padding: '6px 8px',
  maxHeight: 260,
  overflow: 'auto',
  background: 'var(--well-bg)',
  border: '1px solid var(--card-border)',
  borderRadius: 6,
  fontFamily: FONT_MONO,
  fontSize: 'var(--text-xs)',
  whiteSpace: 'pre-wrap',
  color: 'var(--text-dim)',
};

/** One observation fact. With `onOpen` the value becomes a link — used by the
 *  session chip to hand the gateway-minted id to /sessions, which searches
 *  session ids through its `?q=` filter, so the routing ladder behind a turn
 *  is one click away instead of a copy/paste round trip. */
const FactChip: React.FC<{ label: string; value: string; tip?: string; onOpen?: () => void }> = ({
  label,
  value,
  tip,
  onOpen,
}) => (
  <span style={chipStyle} title={tip ?? `${label}: ${value}`}>
    {label}{' '}
    {onOpen ? (
      <button
        type="button"
        onClick={onOpen}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          margin: 0,
          font: 'inherit',
          fontFamily: FONT_MONO,
          color: 'var(--text-main)',
          cursor: 'pointer',
          textDecoration: 'underline',
          textDecorationColor: 'var(--card-border)',
        }}
      >
        {value}
      </button>
    ) : (
      <span style={{ color: 'var(--text-main)', fontFamily: FONT_MONO }}>{value}</span>
    )}
  </span>
);

/** One conversation row. User text stays plain (pre-wrap, body font);
 *  assistant text renders GFM markdown through the shared sanitized component
 *  map (remote images are never fetched). */
const TurnBubble: React.FC<{ turn: ChatTurn }> = ({ turn }) => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const isUser = turn.role === 'user';
  const facts = turn.facts;
  // Per-message "expand": read one reply at full size when the inline bubble
  // squeezes long markdown or reasoning. Local to the row — the dialog is the
  // shared shell, so Esc/backdrop behaviour matches every other dialog.
  const [messageOpen, setMessageOpen] = useState(false);
  const [rowHover, setRowHover] = useState(false);
  // Decode-TPS from the gateway-measured window: completion tokens ÷ genMs,
  // the exact pair the console uses. A buffered turn carries no window, so the
  // chip shows '—' rather than a rate synthesized from client-side timing.
  const genMs = facts?.genMs !== undefined ? Number(facts.genMs) : undefined;
  const rate = turn.usage?.completion_tokens !== undefined ? decodeRate(turn.usage.completion_tokens, genMs) : null;
  // Friendly layer vocabulary for the chip; the raw enum stays in the wire
  // contract, the tooltip carries the full semantics.
  const layerLabel =
    facts?.layer === 'layer0'
      ? t('chat.layer0')
      : facts?.layer === 'entry'
        ? t('chat.layerEntry')
        : facts?.layer === 'layer2'
          ? t('chat.layer2')
          : facts?.layer;
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: isUser ? 'flex-end' : 'flex-start' }}
      onMouseEnter={() => setRowHover(true)}
      onMouseLeave={() => setRowHover(false)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
        {isUser ? <User size={12} /> : <Bot size={12} />}
        <span>{isUser ? t('chat.you') : t('chat.assistant')}</span>
        {turn.pending && <Loader2 size={11} style={{ animation: 'ocr-spin 0.8s linear infinite' }} />}
      </div>

      <div
        style={{
          position: 'relative',
          maxWidth: '88%',
          minWidth: 120,
          padding: '8px 12px',
          borderRadius: 10,
          background: isUser ? 'var(--accent-bg)' : 'var(--well-bg)',
          border: `1px solid ${isUser ? 'color-mix(in srgb, var(--accent) 35%, transparent)' : 'var(--card-border)'}`,
          fontSize: 'var(--text-md)',
          lineHeight: 'var(--leading-relaxed)',
          color: 'var(--text-main)',
          wordBreak: 'break-word',
        }}
      >
        {/* Top-right affordance inside the bubble corner: the bubble is the
            message card, so its controls live on it. */}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setMessageOpen(true)}
          title={t('chat.expandMessage')}
          aria-label={t('chat.expandMessage')}
          style={{
            position: 'absolute', top: 4, right: 4,
            // Above the message body (an error well or long markdown otherwise
            // paints over the glyph), and revealed on row hover only: the
            // affordance must never compete with the reply text.
            zIndex: 2,
            width: 20, height: 20, minHeight: 0, padding: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 5,
            background: 'var(--surface)',
            opacity: rowHover || messageOpen ? 0.75 : 0,
            pointerEvents: rowHover || messageOpen ? 'auto' : 'none',
            transition: 'opacity 0.15s ease',
          }}
        >
          <Maximize2 size={11} />
        </button>
        {turn.reasoning && (
          <details style={{ marginBottom: turn.content ? 8 : 0 }}>
            <summary style={{ cursor: 'pointer', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
              {t('chat.thinkingLabel')}
            </summary>
            <pre
              style={{
                margin: '6px 0 0',
                padding: '6px 8px',
                background: 'var(--well-bg)',
                border: '1px solid var(--card-border)',
                borderRadius: 6,
                fontFamily: FONT_MONO,
                fontSize: 'var(--text-xs)',
                whiteSpace: 'pre-wrap',
                color: 'var(--text-dim)',
              }}
            >
              {turn.reasoning}
            </pre>
          </details>
        )}

        {isUser ? (
          <div style={{ whiteSpace: 'pre-wrap' }}>{turn.content}</div>
        ) : turn.content ? (
          <div className="md-well">
            <ReactMarkdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>
              {turn.content}
            </ReactMarkdown>
          </div>
        ) : turn.pending ? (
          <span style={{ color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>{t('chat.pending')}</span>
        ) : null}

        {turn.error && (
          <pre
            style={{
              margin: turn.content ? '8px 0 0' : 0,
              padding: '6px 8px',
              borderRadius: 6,
              background: 'color-mix(in srgb, var(--accent-rose) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--accent-rose) 45%, transparent)',
              color: 'var(--accent-rose)',
              fontFamily: FONT_MONO,
              fontSize: 'var(--text-xs)',
              whiteSpace: 'pre-wrap',
            }}
          >
            {turn.error}
          </pre>
        )}
      </div>

      {!isUser && facts && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {facts.model && <FactChip label={t('chat.factModel')} value={facts.model} />}
          {facts.tier && <FactChip label={t('chat.factTier')} value={facts.tier} />}
          {facts.layer && layerLabel && (
            <FactChip label={t('chat.factLayer')} value={layerLabel} tip={t('chat.factLayerTip')} />
          )}
          {facts.latencyMs && <FactChip label={t('chat.factLatency')} value={`${facts.latencyMs} ms`} />}
          {turn.usage && (
            <FactChip label={t('chat.factRate')} value={formatRate(rate)} tip={t('chat.factRateTip')} />
          )}
          {facts.failover === 'true' && facts.failoverPath && facts.failoverPath.split(' -> ').length > 1 && (
            <FactChip label={t('chat.factFailover')} value={facts.failoverPath} />
          )}
          {facts.thinking && (
            <FactChip
              label={t('chat.factThinking')}
              value={facts.thinkingSource ? `${facts.thinking} · ${facts.thinkingSource}` : facts.thinking}
            />
          )}
          {facts.breaker && facts.breaker !== 'CLOSED' && <FactChip label={t('chat.factBreaker')} value={facts.breaker} />}
          {facts.requestId && <FactChip label={t('chat.factRequest')} value={facts.requestId} />}
          {facts.sessionId && (
            <FactChip
              label={t('chat.factSession')}
              value={facts.sessionId}
              tip={t('chat.factSessionTip')}
              onOpen={() => navigate(`/sessions?q=${encodeURIComponent(facts.sessionId!)}`)}
            />
          )}
          {turn.usage && (
            <FactChip
              label={t('chat.factTokens')}
              value={`${turn.usage.prompt_tokens ?? 0} / ${turn.usage.completion_tokens ?? 0} / ${turn.usage.total_tokens ?? 0}`}
            />
          )}
        </div>
      )}

      {!isUser && (turn.requestJson !== undefined || turn.responseJson !== undefined) && (
        <details style={{ maxWidth: '88%' }}>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('chat.detailsLabel')}</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {turn.requestJson !== undefined && (
              <div>
                <JsonBlock label={t('chat.reqLabel')} text={JSON.stringify(turn.requestJson, null, 2)} />
              </div>
            )}
            {turn.responseJson !== undefined && (
              <div>
                <JsonBlock label={t('chat.respLabel')} text={JSON.stringify(turn.responseJson, null, 2)} />
              </div>
            )}
          </div>
        </details>
      )}

      {messageOpen && (
        <Dialog
          title={isUser ? t('chat.you') : t('chat.assistant')}
          closeLabel={t('common.close')}
          width={960}
          onClose={() => setMessageOpen(false)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, fontSize: 'var(--text-md)', lineHeight: 'var(--leading-relaxed)', color: 'var(--text-main)' }}>
            {turn.reasoning && (
              <details open>
                <summary style={{ cursor: 'pointer', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                  {t('chat.thinkingLabel')}
                </summary>
                <pre style={{
                  margin: '6px 0 0', padding: '8px 10px',
                  background: 'var(--well-bg)', border: '1px solid var(--card-border)',
                  borderRadius: 6, fontFamily: FONT_MONO, fontSize: 'var(--text-xs)',
                  whiteSpace: 'pre-wrap', color: 'var(--text-dim)',
                  // A flex item's min-content is its longest token; without this
                  // the pre stretches past the dialog and its border clips the text.
                  minWidth: 0, width: '100%', maxWidth: '100%', boxSizing: 'border-box',
                  wordBreak: 'break-word', overflowWrap: 'anywhere',
                }}>
                  {turn.reasoning}
                </pre>
              </details>
            )}
            {isUser ? (
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{turn.content}</div>
            ) : turn.content ? (
              <div className="md-well">
                <ReactMarkdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>
                  {turn.content}
                </ReactMarkdown>
              </div>
            ) : null}
            {turn.error && (
              <pre style={{
                margin: 0, padding: '8px 10px', borderRadius: 6,
                background: 'color-mix(in srgb, var(--accent-rose) 12%, transparent)',
                border: '1px solid color-mix(in srgb, var(--accent-rose) 45%, transparent)',
                color: 'var(--accent-rose)', fontFamily: FONT_MONO,
                fontSize: 'var(--text-xs)', whiteSpace: 'pre-wrap',
                minWidth: 0, width: '100%', maxWidth: '100%', boxSizing: 'border-box',
                wordBreak: 'break-word', overflowWrap: 'anywhere',
              }}>
                {turn.error}
              </pre>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
};

/**
 * Decision-tab question builder — the three System One question types, each
 * with its own criteria editor. The builder owns NO validation: the page
 * validates once on send (so an in-progress row never blocks typing).
 */
const QuestionBuilder: React.FC<{
  drafts: QuestionDraft[];
  onChange: (next: QuestionDraft[]) => void;
}> = ({ drafts, onChange }) => {
  const { t } = useI18n();
  const patch = (index: number, p: Partial<QuestionDraft>) =>
    onChange(drafts.map((q, i) => (i === index ? { ...q, ...p } : q)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {drafts.map((q, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: 10,
            borderRadius: 8,
            border: '1px solid var(--card-border)',
            background: 'var(--well-bg)',
          }}
        >
          {/* Type first: it decides which detail blocks the row renders below,
              so it reads left-to-right as "what kind of answer, then its id". */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ width: 150, flexShrink: 0 }}>
              <Combobox
                value={q.type}
                onChange={(v) => patch(i, { type: v as QuestionType })}
                options={[
                  { value: 'choice', label: t('decision.typeChoice') },
                  { value: 'noul', label: t('decision.typeNoul') },
                  { value: 'score', label: t('decision.typeScore') },
                ]}
              />
            </div>
            <input
              className="input"
              value={q.id}
              onChange={(e) => patch(i, { id: e.target.value })}
              placeholder="q1"
              style={{ width: 130, fontSize: 'var(--text-sm)', fontFamily: FONT_MONO }}
            />
            <div style={{ flex: 1 }} />
            <button
              className="btn btn-sm"
              onClick={() => onChange(drafts.filter((_, j) => j !== i))}
              disabled={drafts.length <= 1}
              title={t('decision.removeQuestion')}
            >
              <Trash2 size={12} />
            </button>
          </div>

          <input
            className="input"
            value={q.instructions}
            onChange={(e) => patch(i, { instructions: e.target.value })}
            placeholder={t('decision.instructionsPlaceholder')}
            style={{ fontSize: 'var(--text-sm)' }}
          />

          {q.type === 'choice' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={labelStyle}>{t('decision.criteriaLabel')}</div>
              {q.choices.map((c, ci) => (
                <div key={ci} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    className="input"
                    value={c.key}
                    onChange={(e) =>
                      patch(i, { choices: q.choices.map((x, j) => (j === ci ? { ...x, key: e.target.value } : x)) })
                    }
                    placeholder={t('decision.optionKey')}
                    style={{ width: 130, fontSize: 'var(--text-sm)', fontFamily: FONT_MONO }}
                  />
                  <input
                    className="input"
                    value={c.desc}
                    onChange={(e) =>
                      patch(i, { choices: q.choices.map((x, j) => (j === ci ? { ...x, desc: e.target.value } : x)) })
                    }
                    placeholder={t('decision.optionDesc')}
                    style={{ flex: 1, fontSize: 'var(--text-sm)' }}
                  />
                  <button
                    className="btn btn-sm"
                    onClick={() => patch(i, { choices: q.choices.filter((_, j) => j !== ci) })}
                    disabled={q.choices.length <= 1}
                    aria-label={t('decision.removeQuestion')}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              <button
                className="btn btn-sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => patch(i, { choices: [...q.choices, { key: '', desc: '' }] })}
              >
                <Plus size={12} />
                <span>{t('decision.addOption')}</span>
              </button>
            </div>
          )}

          {q.type === 'score' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={labelStyle}>{t('decision.levelsLabel')}</div>
              {q.levels.map((level, li) => (
                <div key={li} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ ...labelStyle, width: 18, fontFamily: FONT_MONO }}>{li}</span>
                  <input
                    className="input"
                    value={level}
                    onChange={(e) =>
                      patch(i, { levels: q.levels.map((x, j) => (j === li ? e.target.value : x)) })
                    }
                    placeholder={t('decision.levelPlaceholder')}
                    style={{ flex: 1, fontSize: 'var(--text-sm)' }}
                  />
                  <button
                    className="btn btn-sm"
                    onClick={() => patch(i, { levels: q.levels.filter((_, j) => j !== li) })}
                    disabled={q.levels.length <= 2}
                    aria-label={t('decision.removeQuestion')}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              <button
                className="btn btn-sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => patch(i, { levels: [...q.levels, ''] })}
              >
                <Plus size={12} />
                <span>{t('decision.addLevel')}</span>
              </button>
            </div>
          )}

          {q.type === 'noul' && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-snug)' }}>{t('decision.noulHint')}</div>
          )}
        </div>
      ))}

      <button
        className="btn btn-sm"
        style={{ alignSelf: 'flex-start' }}
        onClick={() => onChange([...drafts, newQuestionDraft(drafts.length + 1)])}
      >
        <Plus size={12} />
        <span>{t('decision.addQuestion')}</span>
      </button>
    </div>
  );
};

/** `active` is false while Layout keeps this page mounted but hidden (the
 *  playground is not unmounted on navigation, so a running stream and the
 *  transcript survive a trip to another page). */
export const PlaygroundPage: React.FC<{ active?: boolean }> = ({ active = true }) => {
  const { t, dict } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const navigate = useNavigate();

  /** Language-aware classic use cases (i18n tables, not fixtures). */
  const presets = dict.playgroundPresets;

  const [mode, setMode] = useState<'chat' | 'decision'>('chat');

  // ── shared: client identity + model addressing ──────────────────────────
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [keySource, setKeySource] = useState<'configured' | 'manual'>('configured');
  const [keyId, setKeyId] = useState('');
  const [manualKey, setManualKey] = useState('');
  // The browser fills `type="password"` fields with a saved site credential on
  // mount no matter what `autoComplete` says. Kept readOnly until the user
  // actually focuses it: autofill skips readOnly fields, and by the time the
  // field is writable the fill attempt is already over.
  const [manualKeyEditable, setManualKeyEditable] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  /** The manual-key field must never match the browser's password heuristic,
   *  or Chrome drapes its saved-credential / "suggest a strong password" popup
   *  over the box. A plain `text` input (masked by CSS where supported, or
   *  revealed on demand) sidesteps it entirely. */
  const keyInputText = CAN_MASK_TEXT || keyVisible;
  const [model, setModel] = useState(() => {
    // The conversation the chat store will activate (its own `active`, else the
    // newest) — never a dangling id left behind by an interrupted save.
    const s = loadChatStore();
    const seed = s.conversations.find(c => c.id === s.active) ?? s.conversations[0];
    return seed?.model ?? 'auto';
  });
  const [modelOptions, setModelOptions] = useState<{ id: string; owned_by?: string }[]>([]);
  const [modelsFailed, setModelsFailed] = useState(false);
  /** id → resolved upstream wire (console catalog). The CHAT surface can only
   *  address non-`systemone` models, so the picker warns before a doomed call. */
  const [wireById, setWireById] = useState<Record<string, string>>({});
  /** id → supported effort levels (from console catalog). */
  const [effortsByModel, setEffortsByModel] = useState<Record<string, string[]>>({});

  // ── chat tab ────────────────────────────────────────────────────────────
  const [stream, setStream] = useState(true);
  const [showParams, setShowParams] = useState(false);
  const [temperature, setTemperature] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [effort, setEffort] = useState('');
  const [promptPresets, setPromptPresets] = useState<PromptPreset[]>(loadPromptPresets);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetDraftName, setPresetDraftName] = useState('');
  const [busy, setBusy] = useState(false);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [decisionHistoryOpen, setDecisionHistoryOpen] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  // Width preference: WIDE by default; the operator can switch to a narrow
  // (centered ~900px) column. Client-side view preference, persisted in
  // localStorage next to the conversation store.
  const [chatWide, setChatWide] = useState(() => {
    try { return localStorage.getItem('ocr_playground_wide') !== '0'; } catch { return true; }
  });
  const toggleChatWide = () => {
    setChatWide(v => {
      try { localStorage.setItem('ocr_playground_wide', v ? '0' : '1'); } catch { /* best-effort */ }
      return !v;
    });
  };
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Multi-conversation state: the store is loaded once WITH a guaranteed active
  // conversation, working fields drive the UI, and auto-save writes the active
  // conversation back on every change.
  const chatSeed = useMemo(loadChatStoreWithActive, []);
  const [chatConversations, setChatConversations] = useState<PgChatConversation[]>(chatSeed.conversations);
  const [activeChatId, setActiveChatId] = useState(chatSeed.active);
  const activeChat = chatConversations.find(c => c.id === activeChatId);
  const [turns, setTurns] = useState<ChatTurn[]>(() => activeChat?.turns ?? []);
  const [draft, setDraft] = useState(() => activeChat?.draft ?? '');
  const [systemPrompt, setSystemPrompt] = useState(() => activeChat?.systemPrompt ?? '');
  const nextIdRef = useRef(activeChat?.nextId ?? 1);
  /** Stable session identity for this playground tab: every request carries it
   *  as `x-session-id` so the gateway groups all turns into one observable
   *  session (visible on the Sessions page). Reset on new conversation. */
  const [playgroundSessionId, setPlaygroundSessionId] = useState(
    () => activeChat?.sessionId ?? mintPlaygroundSessionId()
  );

  // Auto-save: write the active chat conversation into the store on every change.
  useEffect(() => {
    if (!activeChatId) return;
    const now = Date.now();
    const updated = chatConversations.map(c =>
      c.id === activeChatId
        ? { ...c, turns, draft, systemPrompt, model, nextId: nextIdRef.current,
            sessionId: playgroundSessionId, title: chatTitle(turns) || c.title, updatedAt: now }
        : c
    );
    setChatConversations(updated);
    saveChatStore(activeChatId, updated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, draft, systemPrompt, model, playgroundSessionId, activeChatId]);

  /** Adopt a conversation's working fields. Persistence is the caller's job. */
  const adoptChatConversation = (conv: PgChatConversation) => {
    setActiveChatId(conv.id);
    setTurns(conv.turns);
    setDraft(conv.draft);
    setSystemPrompt(conv.systemPrompt);
    setModel(conv.model);
    nextIdRef.current = conv.nextId;
    setPlaygroundSessionId(conv.sessionId);
  };

  const newChatConversation = () => {
    const conv = emptyChatConversation();
    const next = [conv, ...chatConversations].slice(0, PG_MAX_CONVERSATIONS);
    setChatConversations(next);
    adoptChatConversation(conv);
    saveChatStore(conv.id, next);
  };

  const switchChatConversation = (id: string) => {
    const target = chatConversations.find(c => c.id === id);
    if (!target) return;
    adoptChatConversation(target);
    saveChatStore(id, chatConversations);
  };

  const deleteChatConversation = (id: string) => {
    const remaining = chatConversations.filter(c => c.id !== id);
    // The store always keeps one active conversation: deleting the last row
    // seeds a fresh empty one instead of leaving the page unpersisted.
    const next = remaining.length > 0 ? remaining : [emptyChatConversation()];
    setChatConversations(next);
    if (id === activeChatId) adoptChatConversation(next[0]);
    saveChatStore(id === activeChatId ? next[0].id : activeChatId, next);
  };

  // ── decision tab ────────────────────────────────────────────────────────
  // Decision tab: same seed rule as chat — the store always has an active
  // conversation, so an edited draft is persisted from the first keystroke.
  const decisionSeed = useMemo(() => loadDecisionStoreWithActive(presets), []);
  const [decisionConversations, setDecisionConversations] = useState<PgDecisionConversation[]>(
    decisionSeed.conversations
  );
  const [activeDecisionId, setActiveDecisionId] = useState(decisionSeed.active);
  const activeDecision = decisionConversations.find(c => c.id === activeDecisionId);
  const [presetId, setPresetId] = useState<string>(() => activeDecision?.presetId ?? (presets[0]?.id ?? ''));
  const [stateInput, setStateInput] = useState(() => activeDecision?.stateInput ?? (presets[0]?.state ?? ''));
  const [questionDrafts, setQuestionDrafts] = useState<QuestionDraft[]>(() =>
    activeDecision ? activeDecision.questionDrafts : cloneDrafts(presets[0]?.questions ?? [])
  );
  const [decision, setDecision] = useState<DecisionResult | null>(null);
  const [decisionError, setDecisionError] = useState<string | undefined>(undefined);
  const [decisionBusy, setDecisionBusy] = useState(false);

  // Auto-save: decision conversations.
  useEffect(() => {
    if (!activeDecisionId) return;
    const now = Date.now();
    const title = (stateInput || '').slice(0, PG_TITLE_LEN).replace(/\n/g, ' ');
    const updated = decisionConversations.map(c =>
      c.id === activeDecisionId
        ? { ...c, presetId, stateInput, questionDrafts, title: title || c.title, updatedAt: now }
        : c
    );
    setDecisionConversations(updated);
    saveDecisionStore(activeDecisionId, updated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetId, stateInput, questionDrafts, activeDecisionId]);

  /** Adopt a decision draft's working fields. Persistence is the caller's job. */
  const adoptDecisionConversation = (conv: PgDecisionConversation) => {
    setActiveDecisionId(conv.id);
    setPresetId(conv.presetId);
    setStateInput(conv.stateInput);
    setQuestionDrafts(cloneDrafts(conv.questionDrafts));
    setDecision(null);
    setDecisionError(undefined);
  };

  const newDecisionConversation = () => {
    const conv = emptyDecisionConversation(presets[0]);
    const next = [conv, ...decisionConversations].slice(0, PG_MAX_CONVERSATIONS);
    setDecisionConversations(next);
    adoptDecisionConversation(conv);
    saveDecisionStore(conv.id, next);
  };

  const switchDecisionConversation = (id: string) => {
    const target = decisionConversations.find(c => c.id === id);
    if (!target) return;
    adoptDecisionConversation(target);
    saveDecisionStore(id, decisionConversations);
  };

  const deleteDecisionConversation = (id: string) => {
    const remaining = decisionConversations.filter(c => c.id !== id);
    const next = remaining.length > 0 ? remaining : [emptyDecisionConversation(presets[0])];
    setDecisionConversations(next);
    if (id === activeDecisionId) adoptDecisionConversation(next[0]);
    saveDecisionStore(id === activeDecisionId ? next[0].id : activeDecisionId, next);
  };

  const activeKey = useMemo(() => {
    if (keySource === 'manual') return manualKey.trim();
    return keys.find((k) => k.id === keyId)?.key ?? '';
  }, [keySource, manualKey, keys, keyId]);

  /** Resolved wire of the typed model id. Unknown ids fail OPEN: the gateway
   *  stays the authority (a 404/5xx is a legitimate test result). */
  const selectedWire = wireById[model.trim()];
  const decisionWire = selectedWire === 'systemone';

  /** Re-activation after a hidden stretch (Layout keeps this page mounted):
   *  the console may have gained keys while we were away, and a transcript
   *  scroll offset does not survive `display: none` in every engine. The
   *  first activation is the mount — its effects already run. */
  const [activationSeq, setActivationSeq] = useState(0);
  const firstActivation = useRef(true);
  useEffect(() => {
    if (!active) return;
    if (firstActivation.current) {
      firstActivation.current = false;
      return;
    }
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setActivationSeq((n) => n + 1);
  }, [active]);

  // Configured keys — the console endpoint is the only place the plaintext key
  // is available (the list view masks it); this page re-uses that admin view
  // exactly like ApiKeysPage does.
  useEffect(() => {
    api
      .getApiKeys()
      .then((r) => {
        const list = r.keys || [];
        setKeys(list);
        const firstEnabled = list.find((k) => k.enabled);
        if (firstEnabled) setKeyId((cur) => cur || firstEnabled.id);
      })
      .catch(() => {});
  }, [activationSeq]);

  // Model picker source: the CLIENT view (/v1/models), i.e. exactly what the
  // selected key is allowed to address. Falls back to the console catalog when
  // no key is picked yet (or the key is rejected).
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/v1/models', {
          headers: activeKey ? { Authorization: `Bearer ${activeKey}` } : undefined,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { data?: { id: string; owned_by?: string }[] };
        if (!alive) return;
        setModelOptions(json.data || []);
        setModelsFailed(false);
      } catch {
        try {
          const fallback = await api.listGatewayModels();
          if (!alive) return;
          setModelOptions(fallback.map((m) => ({ id: m.id, owned_by: m.owned_by })));
          setModelsFailed(false);
        } catch {
          if (alive) {
            setModelOptions([]);
            setModelsFailed(true);
          }
        }
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [activeKey, activationSeq]);

  // Resolved upstream wire + effort levels per model id — read from the console
  // catalog, never re-derived from the provider's npm string here (that mapping
  // has exactly one owner: backend/src/providers/wire.ts).
  useEffect(() => {
    api
      .listGatewayModels()
      .then((rows) => {
        const wMap: Record<string, string> = {};
        const eMap: Record<string, string[]> = {};
        for (const row of rows) {
          if (row.wire) wMap[row.id] = row.wire;
          if (row.efforts?.length) eMap[row.id] = row.efforts;
        }
        setWireById(wMap);
        setEffortsByModel(eMap);
      })
      .catch(() => {});
  }, [activationSeq]);

  // New content (or a new turn) pins the transcript to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Esc restores the expanded chat (mirrors every fullscreen surface).
  useEffect(() => {
    if (!chatExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChatExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatExpanded]);

  const patchTurn = (id: number, patch: Partial<ChatTurn>) =>
    setTurns((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const buildRequestBody = (history: { role: string; content: string }[]) => {
    const body: Record<string, unknown> = { model: model.trim() || 'auto', messages: history };
    if (stream) {
      body.stream = true;
      // Ask for the usage frame the gateway otherwise drops — the turn's token
      // counters are part of what this page verifies.
      body.stream_options = { include_usage: true };
    }
    if (temperature.trim() !== '' && Number.isFinite(Number(temperature))) body.temperature = Number(temperature);
    if (maxTokens.trim() !== '' && Number.isInteger(Number(maxTokens))) body.max_tokens = Number(maxTokens);
    if (effort) body.reasoning_effort = effort;
    return body;
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (!activeKey) {
      toast.error(t('chat.noKey'));
      return;
    }
    if (decisionWire) {
      toast.error(t('chat.decisionBlocked'));
      return;
    }

    // History = every completed turn (errors and cancelled turns are dropped:
    // a failed attempt must not poison the next request).
    const history: { role: string; content: string }[] = [];
    if (systemPrompt.trim()) history.push({ role: 'system', content: systemPrompt.trim() });
    for (const turn of turns) {
      if (turn.error || turn.pending || !turn.content) continue;
      history.push({ role: turn.role, content: turn.content });
    }
    history.push({ role: 'user', content: text });

    const body = buildRequestBody(history);
    const userId = nextIdRef.current++;
    const assistantId = nextIdRef.current++;
    setTurns((prev) => [
      ...prev,
      { id: userId, role: 'user', content: text },
      { id: assistantId, role: 'assistant', content: '', pending: true, requestJson: body },
    ]);
    setDraft('');
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${activeKey}`, 'x-session-id': playgroundSessionId },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const facts = readFacts((n) => res.headers.get(n) ?? undefined, res.status);

      if (!res.ok) {
        const raw = await res.text();
        patchTurn(assistantId, { pending: false, status: res.status, facts, error: `HTTP ${res.status}\n${raw}` });
        return;
      }

      if (!stream || !res.body) {
        const json = (await res.json()) as {
          choices?: { message?: { content?: unknown; reasoning_content?: string } }[];
          usage?: TurnUsage;
        };
        const message = json.choices?.[0]?.message;
        const content = typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '');
        patchTurn(assistantId, {
          pending: false,
          content,
          reasoning: message?.reasoning_content,
          usage: json.usage,
          facts,
          responseJson: json,
        });
        return;
      }

      // Streaming: forward each `data:` frame into the bubble and fold the
      // trailing `: ocr-summary` comment into the same facts block.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let reasoning = '';
      let usage: TurnUsage | undefined;
      let summary: Record<string, string> = {};

      const handleFrame = (frame: string) => {
        for (const line of frame.split('\n')) {
          if (line.startsWith(': ocr-summary ')) {
            try {
              summary = JSON.parse(line.slice(': ocr-summary '.length)) as Record<string, string>;
            } catch {
              /* a malformed comment frame is not worth failing the turn */
            }
            continue;
          }
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const chunk = JSON.parse(payload) as {
              choices?: { delta?: { content?: string; reasoning_content?: string } }[];
              usage?: TurnUsage;
            };
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) content += delta.content;
            if (delta?.reasoning_content) reasoning += delta.reasoning_content;
            if (chunk.usage) usage = chunk.usage;
          } catch {
            /* partial/non-JSON frame — SSE parsers ignore it too */
          }
        }
        patchTurn(assistantId, {
          content,
          reasoning: reasoning || undefined,
          usage,
          facts: mergeFacts(facts, readFacts((n) => summary[n], res.status)),
        });
      };

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf('\n\n');
        while (idx >= 0) {
          handleFrame(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf('\n\n');
        }
      }
      if (buffer.trim()) handleFrame(buffer);

      patchTurn(assistantId, {
        pending: false,
        content,
        reasoning: reasoning || undefined,
        usage,
        facts: mergeFacts(facts, readFacts((n) => summary[n], res.status)),
        responseJson: { streamed: true, content, reasoning: reasoning || undefined, usage, summary },
      });
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError';
      patchTurn(assistantId, {
        pending: false,
        error: aborted ? t('chat.aborted') : String((err as Error)?.message ?? err),
      });
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const stop = () => abortRef.current?.abort();

  const clearAll = async () => {
    if (turns.length === 0) return;
    const ok = await confirmDialog({ title: t('chat.clear'), description: t('chat.clearConfirm'), danger: true });
    if (!ok) return;
    newChatConversation();
  };

  const copyCurl = async () => {
    const lastUser = [...turns].reverse().find((x) => x.role === 'user');
    const history = [{ role: 'user', content: lastUser?.content || t('chat.curlPlaceholder') }];
    const body = JSON.stringify(buildRequestBody(history));
    const curl = `curl -sS ${window.location.origin}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${activeKey || '<API_KEY>'}" \\
  -H "x-session-id: ${playgroundSessionId}" \\
  -d '${body}'`;
    const ok = await copyToClipboard(curl);
    if (ok) toast.success(t('chat.curlCopied'));
    else toast.error(t('chat.curlFailed'));
  };

  /** Best-effort question map from the builder (blank ids/rows skipped) — the
   *  preview uses it; send() validates first, so it never ships a silent drop. */
  const toQuestionPayload = (drafts: QuestionDraft[]) => {
    const out: Record<string, unknown> = {};
    for (const q of drafts) {
      const id = q.id.trim();
      if (!id) continue;
      const entry: Record<string, unknown> = { type: q.type };
      if (q.instructions.trim()) entry.instructions = q.instructions.trim();
      if (q.type === 'choice') {
        const criteria: Record<string, string> = {};
        for (const c of q.choices) if (c.key.trim()) criteria[c.key.trim()] = c.desc;
        entry.criteria = criteria;
      } else if (q.type === 'score') {
        entry.criteria = q.levels.map((l) => l.trim()).filter((l) => l !== '');
      }
      out[id] = entry;
    }
    return out;
  };

  /** Protocol preconditions the wire enforces with a 400 (see
   *  protocols/systemone/convert.ts validateSystemoneRequest). */
  const validateDrafts = (drafts: QuestionDraft[]): string | undefined => {
    const seen = new Set<string>();
    for (const q of drafts) {
      const id = q.id.trim();
      if (!id) return t('decision.questionIdMissing');
      if (seen.has(id)) return t('decision.questionDuplicateId');
      seen.add(id);
      if (q.type === 'choice' && q.choices.every((c) => !c.key.trim())) return t('decision.choiceNeedsOption');
      if (q.type === 'score' && q.levels.filter((l) => l.trim() !== '').length < 2) return t('decision.scoreNeedsLevels');
    }
    if (seen.size === 0) return t('decision.questionsInvalid');
    return undefined;
  };

  /** Apply a classic use case: replaces BOTH state and questions, and clears a
   *  stale error from the previous shape. */
  const applyPreset = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    setPresetId(preset.id);
    setStateInput(preset.state);
    setQuestionDrafts(cloneDrafts(preset.questions));
    setDecisionError(undefined);
  };

  /** The ONE place the decision body is assembled — the send path and the cURL
   *  copy read it, so what you copy is exactly what would be sent. */
  const buildDecisionRequest = ():
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; error: string } => {
    if (stateInput.trim() === '') return { ok: false, error: t('decision.stateRequired') };
    // The wire rejects a malformed question map with a 400 — catch it here so
    // an in-progress row costs no round trip.
    const invalid = validateDrafts(questionDrafts);
    if (invalid) return { ok: false, error: invalid };
    return {
      ok: true,
      body: {
        model: model.trim() || 'auto',
        // A plain-text state is legal on this wire (string | object | array).
        state: decodeState(stateInput),
        questions: toQuestionPayload(questionDrafts),
      },
    };
  };

  const copyDecisionCurl = async () => {
    const built = buildDecisionRequest();
    if (!built.ok) {
      setDecisionError(built.error);
      return;
    }
    const curl = `curl -sS ${window.location.origin}/v1/systemone \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${activeKey || '<API_KEY>'}" \\
  -H "x-session-id: ${playgroundSessionId}" \\
  -d '${JSON.stringify(built.body)}'`;
    const ok = await copyToClipboard(curl);
    if (ok) toast.success(t('chat.curlCopied'));
    else toast.error(t('chat.curlFailed'));
  };

  const sendDecision = async () => {
    if (decisionBusy) return;
    if (!activeKey) {
      toast.error(t('chat.noKey'));
      return;
    }
    const built = buildDecisionRequest();
    if (!built.ok) {
      setDecisionError(built.error);
      return;
    }
    const body = built.body;
    setDecisionBusy(true);
    setDecisionError(undefined);
    try {
      const res = await fetch('/v1/systemone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${activeKey}`, 'x-session-id': playgroundSessionId },
        body: JSON.stringify(body),
      });
      const facts = readFacts((n) => res.headers.get(n) ?? undefined, res.status);
      const upstream = res.headers.get(HDR_SYSTEMONE_UPSTREAM) ?? undefined;
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      setDecision({
        status: res.status,
        ok: res.ok,
        upstream,
        facts,
        body: parsed,
        raw: parsed === undefined ? text : undefined,
        requestJson: body,
      });
    } catch (err) {
      setDecisionError(String((err as Error)?.message ?? err));
    } finally {
      setDecisionBusy(false);
    }
  };

  const keyOptions = keys.map((k) => ({
    value: k.id,
    label: k.name,
    meta: k.enabled ? undefined : t('chat.keyDisabled'),
  }));

  /** Virtual ids (auto, tier aliases) route at runtime — any effort level is
   *  valid because the gateway resolves the real model per request. Concrete
   *  models report their own subset from the catalog endpoint. */
  const VIRTUAL_IDS: Record<string, true> = { auto: true, lite: true, plus: true, pro: true, ultra: true };
  const availableEfforts = useMemo(() => {
    const id = model.trim();
    if (VIRTUAL_IDS[id]) return [...EFFORT_LADDER];
    return effortsByModel[id] ?? [];
  }, [model, effortsByModel]);

  const savePreset = () => {
    const name = presetDraftName.trim();
    if (!name) { toast.error(t('chat.promptPresetNameRequired')); return; }
    const next: PromptPreset[] = [
      ...promptPresets.filter((p) => p.name !== name),
      { id: crypto.randomUUID(), name, content: systemPrompt },
    ];
    setPromptPresets(next);
    savePromptPresets(next);
    setPresetDraftName('');
    toast.success(t('chat.promptPresetSaved'));
  };

  const deletePreset = (id: string) => {
    const next = promptPresets.filter((p) => p.id !== id);
    setPromptPresets(next);
    savePromptPresets(next);
    toast.success(t('chat.promptPresetDeleted'));
  };

  const sendDisabled = busy || !draft.trim() || !activeKey || decisionWire;

  /** Shared chat-conversation list body — rendered by the in-page history
   *  dropdown AND the expanded overlay's own dropdown (the settings card that
   *  normally hosts it sits behind the overlay). One body, two placements. */
  const chatHistoryList = (
    <>
      {chatConversations.length === 0 && (
        <div style={{ padding: '8px 12px', fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>
          {t('chat.historyEmpty')}
        </div>
      )}
      {chatConversations.map(c => (
        <div
          key={c.id}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px',
            cursor: 'pointer', fontSize: 'var(--text-sm)',
            background: c.id === activeChatId ? 'var(--accent-bg, rgba(99,102,241,0.08))' : undefined,
          }}
          onClick={() => { switchChatConversation(c.id); setChatHistoryOpen(false); }}
        >
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.title || t('chat.historyUntitled')}
          </span>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', flexShrink: 0 }}>
            {c.turns.length} turns
          </span>
          <button
            className="btn btn-sm"
            style={{ padding: '2px 4px' }}
            title={t('chat.historyDelete')}
            onClick={(e) => { e.stopPropagation(); deleteChatConversation(c.id); }}
          >
            <Trash2 size={11} />
          </button>
        </div>
      ))}
    </>
  );

  // Layout: the tab row is page chrome and sits outside the scroll region. In
  // chat mode that region is `overflow: hidden`, so the chat card owns the
  // viewport and the transcript is the only scroller (same idiom as
  // LogsPage/CombosPage). In decision mode it scrolls, because the builder
  // (state + N question cards) is naturally tall — the result pane keeps its
  // natural height instead of being squeezed to a viewport-relative box.
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        height: '100%',
        minHeight: 0,
      }}
    >
      {/* Page-level tabs (top of the page, above both cards): the two wires
          share one client identity, so they are two views of one page. Sits
          OUTSIDE the scroll region below, so it never scrolls away. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, width: '100%', maxWidth: chatWide ? '100%' : 900, margin: '0 auto' }}>
        <SegGroup
          value={mode}
          onChange={(v) => setMode(v as 'chat' | 'decision')}
          size="lg"
          options={[
            { value: 'chat', label: t('chat.tabChat') },
            { value: 'decision', label: t('decision.tabDecision') },
          ]}
        />
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontFamily: FONT_MONO }}>
          {mode === 'chat' ? 'POST /v1/chat/completions' : 'POST /v1/systemone'}
        </span>
        {/* Session identity chip: lets the operator jump to Sessions page pre-filtered
            to this playground session. Shown at all times so the id is reachable even
            before the first request (copy+paste into Sessions search). */}
        <button
          type="button"
          onClick={() => navigate(`/sessions?q=${encodeURIComponent(playgroundSessionId)}`)}
          title={t('chat.factSessionTip')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 7px',
            borderRadius: 4,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            cursor: 'pointer',
            fontSize: 'var(--text-xs)',
            fontFamily: FONT_MONO,
            color: 'var(--text-dim)',
            userSelect: 'none',
            flexShrink: 0,
          }}
        >
          <span style={{ opacity: 0.6 }}>{t('chat.factSession')}</span>
          <span style={{ color: 'var(--accent)' }}>{playgroundSessionId}</span>
        </button>
        {/* Page-level width preference: it governs the tab row AND both cards,
            so it lives on the page chrome, not inside either card. */}
        <div style={{ flex: 1 }} />
        <button
          className="btn btn-sm"
          onClick={toggleChatWide}
          title={t(chatWide ? 'chat.narrow' : 'chat.wide')}
          aria-label={t(chatWide ? 'chat.narrow' : 'chat.wide')}
          style={{ padding: '4px 6px', flexShrink: 0 }}
        >
          {chatWide ? <Shrink size={14} /> : <Expand size={14} />}
        </button>
      </div>

      {/* Everything below the tabs scrolls in ITS OWN box: the mode switch is
          page chrome, not content, so it must stay out of the scroll region —
          no sticky needed. Chat keeps `overflow: hidden` here so its card fills
          the viewport and only the transcript scrolls. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          overflowY: mode === 'chat' ? 'hidden' : 'auto',
          paddingRight: 4,
        }}
      >
      <div className="card" style={{ flexShrink: 0, width: '100%', maxWidth: chatWide ? '100%' : 900, margin: '0 auto' }}>
        <div className="card-header">
          <div className="card-title">
            <MessagesSquare size={18} color="var(--accent)" />
            <span>{mode === 'chat' ? t('chat.title') : t('decision.title')}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {mode === 'chat' ? (
              <>
                <button className="btn btn-sm" onClick={() => void copyCurl()} title={t('chat.copyCurl')}>
                  <Copy size={13} />
                  <span>{t('chat.copyCurl')}</span>
                </button>
                <button className="btn btn-sm" onClick={() => void clearAll()} disabled={busy || turns.length === 0}>
                  <Eraser size={13} />
                  <span>{t('chat.clear')}</span>
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-sm" onClick={() => void copyDecisionCurl()} title={t('chat.copyCurl')}>
                  <Copy size={13} />
                  <span>{t('chat.copyCurl')}</span>
                </button>
                <button className="btn btn-sm" onClick={newDecisionConversation}>
                  <Plus size={13} />
                  <span>{t('decision.historyNew')}</span>
                </button>
                <button className="btn btn-sm" onClick={() => setDecisionHistoryOpen(v => !v)}>
                  <Clock size={13} />
                  <span>{t('decision.historyTitle')}</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* History dropdown — decision */}
        {mode === 'decision' && decisionHistoryOpen && (
          <div style={{
            border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)',
            padding: '6px 0', marginBottom: 10, maxHeight: 220, overflowY: 'auto',
          }}>
            {decisionConversations.length === 0 && (
              <div style={{ padding: '8px 12px', fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>
                {t('decision.historyEmpty')}
              </div>
            )}
            {decisionConversations.map(c => (
              <div
                key={c.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px',
                  cursor: 'pointer', fontSize: 'var(--text-sm)',
                  background: c.id === activeDecisionId ? 'var(--accent-bg, rgba(99,102,241,0.08))' : undefined,
                }}
                onClick={() => { switchDecisionConversation(c.id); setDecisionHistoryOpen(false); }}
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.title || t('decision.historyUntitled')}
                </span>
                <button
                  className="btn btn-sm"
                  style={{ padding: '2px 4px' }}
                  title={t('decision.historyDelete')}
                  onClick={(e) => { e.stopPropagation(); deleteDecisionConversation(c.id); }}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        )}


        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 260, flex: '1 1 260px' }}>
            <label style={labelStyle}>{t('chat.keyLabel')}</label>
            {/* One frame carries both zones: the field and the mode switch on
                its trailing edge (the switch swaps the control, so it belongs
                to the field, not to the label). The frame — not the inner field
                — owns the border and the focus ring (see .input-group). */}
            <div className="input-group" style={{ display: 'flex', width: '100%' }}>
              {keySource === 'configured' ? (
                <Combobox
                  value={keyId}
                  onChange={setKeyId}
                  options={keyOptions}
                  placeholder={t('chat.keyPlaceholder')}
                  forceFilter={keys.length > 8}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    width: 'auto',
                    border: 'none',
                    borderRadius: 0,
                    background: 'transparent',
                  }}
                />
              ) : (
                <>
                  <input
                    className="input"
                    type={keyInputText ? 'text' : 'password'}
                    readOnly={!keyInputText && !manualKeyEditable}
                    onFocus={keyInputText ? undefined : () => setManualKeyEditable(true)}
                    value={manualKey}
                    onChange={(e) => setManualKey(e.target.value)}
                    placeholder={t('chat.keyManualPlaceholder')}
                    autoComplete={keyInputText ? 'off' : 'new-password'}
                    spellCheck={false}
                    data-lpignore="true"
                    data-1p-ignore="true"
                    data-bwignore="true"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      width: 'auto',
                      fontSize: 'var(--text-sm)',
                      border: 'none',
                      borderRadius: 0,
                      background: 'transparent',
                      ...(CAN_MASK_TEXT && !keyVisible ? { WebkitTextSecurity: 'disc' as const } : {}),
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setKeyVisible((v) => !v)}
                    aria-pressed={keyVisible}
                    title={t(keyVisible ? 'chat.keyHide' : 'chat.keyShow')}
                    aria-label={t(keyVisible ? 'chat.keyHide' : 'chat.keyShow')}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--text-dim)',
                      padding: '0 8px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                    }}
                  >
                    {keyVisible ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </>
              )}
              <SegGroup
                value={keySource}
                onChange={(v) => setKeySource(v as 'configured' | 'manual')}
                size="sm"
                embedded="end"
                options={[
                  { value: 'configured', label: t('chat.keyConfigured') },
                  { value: 'manual', label: t('chat.keyManual') },
                ]}
              />
            </div>
            {keySource === 'configured' && keys.length === 0 && (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('chat.keyEmpty')}</div>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 230, flex: '1 1 230px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <label style={labelStyle}>{t('chat.modelLabel')}</label>
              {/* Tips live in the LABEL ROW, never as a standalone line under the
                  picker — a separate hint line grows this column and pushes the
                  stream-toggle column out of line. A decision-wire model is a
                  STATE (danger tip); a translated non-openai wire is context (info
                  tip); the two are mutually exclusive. */}
              {mode === 'chat' &&
                (decisionWire ? (
                  <InfoTip variant="danger" text={t('chat.decisionBlocked')} />
                ) : (
                  selectedWire &&
                  selectedWire !== 'openai' && <InfoTip variant="info" text={t('chat.wireHint', { wire: selectedWire })} />
                ))}
            </div>
            <Combobox
              value={model}
              onChange={(v) => setModel(v)}
              options={modelOptions.map((m) => {
                const wire = wireById[m.id];
                return {
                  value: m.id,
                  label: m.id,
                  meta: m.owned_by,
                  // 'openai' is the unremarkable default — badge only what
                  // changes how the request is served (translation / no chat at all).
                  badge: wire && wire !== 'openai' ? (wire === 'systemone' ? t('chat.wireSystemone') : wire) : undefined,
                  badgeColor: wire === 'systemone' ? 'var(--accent-rose)' : undefined,
                };
              })}
              placeholder={t('chat.modelPlaceholder')}
              panelMinWidth={320}
              style={{ width: '100%' }}
            />
            {modelsFailed && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{t('chat.modelsLoadFailed')}</div>}
          </div>

          {mode === 'chat' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 150 }}>
              <label style={labelStyle}>{t('chat.streamLabel')}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 34 }}>
                <Switch checked={stream} onChange={setStream} />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setShowParams((v) => !v)}
                  aria-expanded={showParams}
                >
                  {t('chat.paramsLabel')}
                </button>
              </div>
            </div>
          )}
        </div>

        {mode === 'chat' && showParams && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 14 }}>
            {/* Row 1: temperature, max_tokens, thinking level — inline */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, width: 140 }}>
                <label style={labelStyle}>{t('chat.temperatureLabel')}</label>
                <input
                  className="input"
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                  placeholder="0.7"
                  style={{ fontSize: 'var(--text-sm)', fontFamily: FONT_MONO }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, width: 140 }}>
                <label style={labelStyle}>{t('chat.maxTokensLabel')}</label>
                <input
                  className="input"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                  placeholder="1024"
                  style={{ fontSize: 'var(--text-sm)', fontFamily: FONT_MONO }}
                />
              </div>
              {availableEfforts.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, width: 200 }}>
                  <label style={labelStyle}>{t('chat.effortLabel')}</label>
                  <Combobox
                    value={effort}
                    onChange={setEffort}
                    options={[
                      { value: '', label: t('chat.effortPlaceholder') },
                      ...availableEfforts.map((e) => ({
                        value: e,
                        label: `${e} — ${t(`op.${EFFORT_I18N_KEY[e as ReasoningEffort]}`)}`,
                      })),
                    ]}
                    placeholder={t('chat.effortPlaceholder')}
                    style={{ width: '100%' }}
                  />
                </div>
              )}
            </div>
            {/* Row 2: system prompt — full width, preset picker in the label row */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={labelStyle}>{t('chat.systemLabel')}</label>
                <Combobox
                  value=""
                  onChange={(id) => {
                    const p = promptPresets.find((x) => x.id === id);
                    if (p) setSystemPrompt(p.content);
                  }}
                  options={promptPresets.map((p) => ({ value: p.id, label: p.name }))}
                  placeholder={t('chat.promptPresetLabel')}
                  disabled={promptPresets.length === 0}
                  style={{ width: 170 }}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => { setPresetDraftName(''); setPresetDialogOpen(true); }}
                  title={t('chat.promptPresetManage')}
                >
                  <Save size={13} />
                  <span>{t('chat.promptPresetManage')}</span>
                </button>
              </div>
              <textarea
                className="input"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={t('chat.systemPlaceholder')}
                rows={2}
                style={{ fontSize: 'var(--text-sm)', resize: 'vertical', lineHeight: 'var(--leading-snug)' }}
              />
            </div>
          </div>
        )}

        {mode === 'decision' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, width: 460, maxWidth: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <label style={labelStyle}>{t('decision.presetLabel')}</label>
                  {/* Hint lives in the tooltip, not in the row: the paragraph
                      used to steal the width the preset label needs. */}
                  <InfoTip text={t('decision.presetHint')} />
                </div>
                <Combobox
                  value={presetId}
                  onChange={applyPreset}
                  // A preset is a whole scenario (state + N questions of MIXED
                  // types), so the tag is a type COMBINATION, not one type:
                  // reads as the scenario's shape and explains why presets
                  // cannot be filtered by type.
                  options={presets.map((p) => {
                    const counts = new Map<string, number>();
                    p.questions.forEach((q) => counts.set(q.type, (counts.get(q.type) ?? 0) + 1));
                    const shape = [...counts].map(([type, n]) => `${type}×${n}`).join(' · ');
                    return { value: p.id, label: p.label, meta: shape };
                  })}
                  forceFilter={presets.length > 8}
                />
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <label style={labelStyle}>{t('decision.stateLabel')}</label>
              <textarea
                className="input"
                value={stateInput}
                onChange={(e) => setStateInput(e.target.value)}
                placeholder={t('decision.statePlaceholder')}
                rows={3}
                style={{ fontSize: 'var(--text-sm)', resize: 'vertical', lineHeight: 'var(--leading-snug)' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <label style={labelStyle}>{t('decision.questionsLabel')}</label>
                {/* Reference text (per-type criteria shape), not action guidance:
                    it belongs behind the info glyph, not in the flow. */}
                <InfoTip text={t('decision.footerHint')} />
              </div>
              <QuestionBuilder drafts={questionDrafts} onChange={setQuestionDrafts} />
              <JsonBlock
                collapsible
                label={t('decision.payloadPreview')}
                text={JSON.stringify(
                  { model: model.trim() || 'auto', state: decodeState(stateInput), questions: toQuestionPayload(questionDrafts) },
                  null,
                  2
                )}
                maxHeight={220}
              />
            </div>
            {/* Submit sits where the form ends: it commits state + questions,
                so a header-corner button made the user hunt for it. */}
            {/* Left-aligned: every other control in this column (the add-
                question button, the question rows) starts at the left edge,
                so the primary action lands where the eye already is. */}
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <button
                className="btn btn-primary"
                onClick={() => void sendDecision()}
                disabled={decisionBusy || !activeKey}
              >
                {decisionBusy ? (
                  <Loader2 size={13} style={{ animation: 'ocr-spin 0.8s linear infinite' }} />
                ) : (
                  <Send size={13} />
                )}
                <span>{t('decision.send')}</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {mode === 'chat' ? (
        <div
          className="card"
          style={chatExpanded ? {
            // Expanded chat: a fixed overlay covering the viewport, so the
            // transcript gets the whole screen. Esc (or the header toggle)
            // restores the in-page card.
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            borderRadius: 0,
            border: 'none',
            background: 'var(--bg)',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            margin: 0,
          } : {
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            flex: 1,
            minHeight: 260,
            // The card ITSELF is the reading surface: wide by default, an
            // optional centered 900px column on demand. Expanded mode ignores
            // this and takes the whole viewport.
            width: '100%',
            maxWidth: chatWide ? '100%' : 900,
            margin: '0 auto',
          }}
        >
          {/* Card header: left = chat identity, right = conversation actions.
              Same row in normal and expanded mode — in expanded mode it is the
              only chrome, so it must never duplicate. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>
              <MessagesSquare size={16} color="var(--accent)" />
              <span>{t('chat.cardTitle')}</span>
            </div>
            <div style={{ flex: 1 }} />
            <button className="btn btn-sm" onClick={newChatConversation}>
              <Plus size={13} />
              <span>{t('chat.historyNew')}</span>
            </button>
            <button className="btn btn-sm" onClick={() => setChatHistoryOpen(v => !v)}>
              <Clock size={13} />
              <span>{t('chat.historyTitle')}</span>
            </button>
            <button
              className="btn btn-sm"
              onClick={() => setChatExpanded(v => !v)}
              title={t(chatExpanded ? 'chat.collapse' : 'chat.expand')}
              aria-label={t(chatExpanded ? 'chat.collapse' : 'chat.expand')}
              style={{ padding: '4px 6px' }}
            >
              {chatExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </div>
          {chatHistoryOpen && (
            <div style={{
              border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)',
              padding: '6px 0', flexShrink: 0, maxHeight: 220, overflowY: 'auto',
            }}>
              {chatHistoryList}
            </div>
          )}
          <div
            ref={scrollRef}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              flex: 1,
              // minHeight:0 is what lets the transcript SHRINK instead of
              // pushing the composer out of the card — the classic flex overflow trap.
              minHeight: 0,
              overflowY: 'auto',
              paddingRight: 4,
            }}
          >
            {turns.length === 0 ? (
              <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-loose)', paddingTop: 120 }}>
                <div style={{ fontSize: 'var(--text-md)', color: 'var(--text-main)', marginBottom: 4 }}>{t('chat.emptyTitle')}</div>
                <div>{t('chat.emptyHint')}</div>
              </div>
            ) : (
              turns.map((turn) => <TurnBubble key={turn.id} turn={turn} />)
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', borderTop: '1px solid var(--card-border)', paddingTop: 12, flexShrink: 0 }}>
            <textarea
              className="input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter breaks the line. `isComposing` keeps
                // IME selection (Chinese/Japanese input) from firing a send.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={t('chat.composerPlaceholder')}
              rows={3}
              style={{ flex: 1, fontSize: 'var(--text-md)', resize: 'vertical', lineHeight: 'var(--leading-normal)' }}
            />
            {busy ? (
              <button className="btn btn-danger" onClick={stop} style={{ height: 36 }}>
                <Square size={13} />
                <span>{t('chat.stop')}</span>
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => void send()} disabled={sendDisabled} style={{ height: 36 }}>
                <Send size={13} />
                <span>{t('chat.send')}</span>
              </button>
            )}
          </div>
        </div>
      ) : (
        <div
          className="card"
          // Natural height: a long answers payload is never clipped to a
          // viewport-relative box — the page scrolls, not this card.
          style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: chatWide ? '100%' : 900, margin: '0 auto' }}
        >
          <div>
            {decisionError ? (
              <pre
                style={{
                  margin: 0,
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: 'color-mix(in srgb, var(--accent-rose) 12%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--accent-rose) 45%, transparent)',
                  color: 'var(--accent-rose)',
                  fontFamily: FONT_MONO,
                  fontSize: 'var(--text-xs)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {decisionError}
              </pre>
            ) : !decision ? (
              <div style={{ minHeight: 180, display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-loose)' }}>
                <div style={{ fontSize: 'var(--text-md)', color: 'var(--text-main)', marginBottom: 4 }}>{t('decision.emptyTitle')}</div>
                <div>{t('decision.emptyHint')}</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  <FactChip label={t('decision.factStatus')} value={String(decision.status)} />
                  {decision.facts.model && <FactChip label={t('chat.factModel')} value={decision.facts.model} />}
                  {decision.upstream && (
                    <FactChip
                      label={t('decision.factUpstream')}
                      value={decision.upstream === 'native' ? t('decision.upstreamNative') : t('decision.upstreamConverted')}
                    />
                  )}
                  {decision.facts.latencyMs && <FactChip label={t('chat.factLatency')} value={`${decision.facts.latencyMs} ms`} />}
                  {decision.facts.requestId && <FactChip label={t('chat.factRequest')} value={decision.facts.requestId} />}
                </div>
                <div>
                  <JsonBlock label={t('chat.reqLabel')} text={JSON.stringify(decision.requestJson, null, 2)} maxHeight={180} />
                </div>
                <div>
                  <JsonBlock
                    label={t('chat.respLabel')}
                    text={decision.body !== undefined ? JSON.stringify(decision.body, null, 2) : (decision.raw ?? '')}
                    maxHeight={520}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      </div>

      {/* System prompt preset manager dialog */}
      {presetDialogOpen && (
        <Dialog title={t('chat.promptPresetLabel')} onClose={() => setPresetDialogOpen(false)} closeLabel={t('common.close')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 360 }}>
            {/* Save current prompt as a new preset */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>
                {t('chat.promptPresetSave')}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="input"
                  value={presetDraftName}
                  onChange={(e) => setPresetDraftName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') savePreset(); }}
                  placeholder={t('chat.promptPresetName')}
                  style={{ flex: 1, fontSize: 'var(--text-sm)' }}
                  autoFocus
                />
                <button className="btn btn-primary btn-sm" onClick={savePreset}>
                  <Save size={13} />
                  <span>{t('common.save')}</span>
                </button>
              </div>
            </div>
            {/* Saved presets list */}
            {promptPresets.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--text-sm)', padding: '8px 0' }}>
                {t('chat.promptPresetEmpty')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {promptPresets.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      padding: '8px 10px',
                      background: 'var(--surface)',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-main)' }}>
                        {p.name}
                      </div>
                      <div
                        style={{
                          fontSize: 'var(--text-xs)',
                          color: 'var(--text-dim)',
                          marginTop: 2,
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {p.content || '—'}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setSystemPrompt(p.content);
                        setPresetDialogOpen(false);
                      }}
                      title={t('common.confirm')}
                    >
                      <Check size={13} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => deletePreset(p.id)}
                      title={t('chat.promptPresetDelete')}
                      style={{ color: 'var(--error)' }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
};

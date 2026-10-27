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
import { Bot, Check, ChevronRight, Copy, Eraser, Eye, EyeOff, Loader2, Maximize2, MessagesSquare, Minimize2, Plus, Send, Square, Trash2, User } from 'lucide-react';
import { api, type ApiKeyItem } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { InfoTip } from '../components/InfoTip';
import { Dialog } from '../components/Dialog';
import { useConfirm } from '../components/ConfirmProvider';
import { Combobox } from '../components/Combobox';
import { SegGroup } from '../components/SegGroup';
import { Switch } from '../components/Switch';
import { MD_COMPONENTS, MD_PLUGINS } from '../components/SessionTranscript';
import { copyToClipboard } from '../lib/format';
import { FONT_MONO } from '../lib/fonts';
import type { PlaygroundPresetQuestion } from '../i18n/types';

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
  trace: 'X-OCR-Trace-ID',
  latency: 'X-OCR-Latency-MS',
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
  traceId?: string;
  latencyMs?: string;
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
  traceId: nonEmpty(get(HDR.trace)),
  latencyMs: nonEmpty(get(HDR.latency)),
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
  fontSize: 11,
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
      {!bare && <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{label}</span>}
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
  fontSize: 10.5,
  lineHeight: 1.5,
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
  fontSize: 10.5,
  whiteSpace: 'pre-wrap',
  color: 'var(--text-dim)',
};

const FactChip: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <span style={chipStyle} title={`${label}: ${value}`}>
    {label} <span style={{ color: 'var(--text-main)', fontFamily: FONT_MONO }}>{value}</span>
  </span>
);

/** One conversation row. User text stays plain (pre-wrap, body font);
 *  assistant text renders GFM markdown through the shared sanitized component
 *  map (remote images are never fetched). */
const TurnBubble: React.FC<{ turn: ChatTurn }> = ({ turn }) => {
  const { t } = useI18n();
  const isUser = turn.role === 'user';
  const facts = turn.facts;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: isUser ? 'flex-end' : 'flex-start' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-dim)' }}>
        {isUser ? <User size={12} /> : <Bot size={12} />}
        <span>{isUser ? t('chat.you') : t('chat.assistant')}</span>
        {turn.pending && <Loader2 size={11} style={{ animation: 'ocr-spin 0.8s linear infinite' }} />}
      </div>

      <div
        style={{
          maxWidth: '88%',
          minWidth: 120,
          padding: '8px 12px',
          borderRadius: 10,
          background: isUser ? 'var(--accent-bg)' : 'var(--well-bg)',
          border: `1px solid ${isUser ? 'color-mix(in srgb, var(--accent) 35%, transparent)' : 'var(--card-border)'}`,
          fontSize: 12.5,
          lineHeight: 1.65,
          color: 'var(--text-main)',
          wordBreak: 'break-word',
        }}
      >
        {turn.reasoning && (
          <details style={{ marginBottom: turn.content ? 8 : 0 }}>
            <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text-dim)' }}>
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
                fontSize: 11,
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
          <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('chat.pending')}</span>
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
              fontSize: 11,
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
          {facts.layer && <FactChip label={t('chat.factLayer')} value={facts.layer} />}
          {facts.latencyMs && <FactChip label={t('chat.factLatency')} value={`${facts.latencyMs} ms`} />}
          {facts.failoverPath && <FactChip label={t('chat.factFailover')} value={facts.failoverPath} />}
          {facts.thinking && (
            <FactChip
              label={t('chat.factThinking')}
              value={facts.thinkingSource ? `${facts.thinking} · ${facts.thinkingSource}` : facts.thinking}
            />
          )}
          {facts.breaker && facts.breaker !== 'CLOSED' && <FactChip label={t('chat.factBreaker')} value={facts.breaker} />}
          {facts.traceId && <FactChip label={t('chat.factTrace')} value={facts.traceId} />}
          {facts.sessionId && <FactChip label={t('chat.factSession')} value={facts.sessionId} />}
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
          <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text-dim)' }}>{t('chat.detailsLabel')}</summary>
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
              style={{ width: 130, fontSize: 12, fontFamily: FONT_MONO }}
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
            style={{ fontSize: 12 }}
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
                    style={{ width: 130, fontSize: 12, fontFamily: FONT_MONO }}
                  />
                  <input
                    className="input"
                    value={c.desc}
                    onChange={(e) =>
                      patch(i, { choices: q.choices.map((x, j) => (j === ci ? { ...x, desc: e.target.value } : x)) })
                    }
                    placeholder={t('decision.optionDesc')}
                    style={{ flex: 1, fontSize: 12 }}
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
                    style={{ flex: 1, fontSize: 12 }}
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
            <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>{t('decision.noulHint')}</div>
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

export const PlaygroundPage: React.FC = () => {
  const { t, dict } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();

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
  const [model, setModel] = useState('auto');
  const [modelOptions, setModelOptions] = useState<{ id: string; owned_by?: string }[]>([]);
  const [modelsFailed, setModelsFailed] = useState(false);
  /** id → resolved upstream wire (console catalog). The CHAT surface can only
   *  address non-`systemone` models, so the picker warns before a doomed call. */
  const [wireById, setWireById] = useState<Record<string, string>>({});

  // ── chat tab ────────────────────────────────────────────────────────────
  const [stream, setStream] = useState(true);
  const [showParams, setShowParams] = useState(false);
  const [temperature, setTemperature] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nextIdRef = useRef(1);

  // ── decision tab ────────────────────────────────────────────────────────
  const [presetId, setPresetId] = useState<string>(presets[0]?.id ?? '');
  const [stateInput, setStateInput] = useState(presets[0]?.state ?? '');
  const [questionDrafts, setQuestionDrafts] = useState<QuestionDraft[]>(() =>
    cloneDrafts(presets[0]?.questions ?? [])
  );
  const [decision, setDecision] = useState<DecisionResult | null>(null);
  const [decisionError, setDecisionError] = useState<string | undefined>(undefined);
  const [decisionBusy, setDecisionBusy] = useState(false);

  const activeKey = useMemo(() => {
    if (keySource === 'manual') return manualKey.trim();
    return keys.find((k) => k.id === keyId)?.key ?? '';
  }, [keySource, manualKey, keys, keyId]);

  /** Resolved wire of the typed model id. Unknown ids fail OPEN: the gateway
   *  stays the authority (a 404/5xx is a legitimate test result). */
  const selectedWire = wireById[model.trim()];
  const decisionWire = selectedWire === 'systemone';

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
  }, []);

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
  }, [activeKey]);

  // Resolved upstream wire per model id — read from the console catalog, never
  // re-derived from the provider's npm string here (that mapping has exactly
  // one owner: backend/src/providers/wire.ts).
  useEffect(() => {
    api
      .listGatewayModels()
      .then((rows) => {
        const map: Record<string, string> = {};
        for (const row of rows) if (row.wire) map[row.id] = row.wire;
        setWireById(map);
      })
      .catch(() => {});
  }, []);

  // New content (or a new turn) pins the transcript to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

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
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${activeKey}` },
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
    setTurns([]);
  };

  const copyCurl = async () => {
    const lastUser = [...turns].reverse().find((x) => x.role === 'user');
    const history = [{ role: 'user', content: lastUser?.content || t('chat.curlPlaceholder') }];
    const body = JSON.stringify(buildRequestBody(history));
    const curl = `curl -sS ${window.location.origin}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${activeKey || '<API_KEY>'}" \\
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
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${activeKey}` },
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

  const sendDisabled = busy || !draft.trim() || !activeKey || decisionWire;
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <SegGroup
          value={mode}
          onChange={(v) => setMode(v as 'chat' | 'decision')}
          size="lg"
          options={[
            { value: 'chat', label: t('chat.tabChat') },
            { value: 'decision', label: t('decision.tabDecision') },
          ]}
        />
        <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: FONT_MONO }}>
          {mode === 'chat' ? 'POST /v1/chat/completions' : 'POST /v1/systemone'}
        </span>
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
      <div className="card" style={{ flexShrink: 0 }}>
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
              </>
            )}
          </div>
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: 14 }}>
          {mode === 'chat' ? t('chat.subtitle') : t('decision.subtitle')}
        </div>

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
                      fontSize: 12,
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
              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t('chat.keyEmpty')}</div>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 230, flex: '1 1 230px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <label style={labelStyle}>{t('chat.modelLabel')}</label>
              {/* A decision-wire model is a STATE, not a field error: an amber
                  glyph beside the label keeps the row's grid intact (the inline
                  red line used to push the stream-toggle column out of line). */}
              {mode === 'chat' && decisionWire && <InfoTip variant="danger" text={t('chat.decisionBlocked')} />}
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
            {modelsFailed && <div style={{ fontSize: 11, color: 'var(--accent-amber)' }}>{t('chat.modelsLoadFailed')}</div>}
            {mode === 'chat' &&
              !decisionWire &&
              selectedWire &&
              selectedWire !== 'openai' && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t('chat.wireHint', { wire: selectedWire })}</div>
              )}
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
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, width: 140 }}>
              <label style={labelStyle}>{t('chat.temperatureLabel')}</label>
              <input
                className="input"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                placeholder="0.7"
                style={{ fontSize: 12, fontFamily: FONT_MONO }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, width: 140 }}>
              <label style={labelStyle}>{t('chat.maxTokensLabel')}</label>
              <input
                className="input"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                placeholder="1024"
                style={{ fontSize: 12, fontFamily: FONT_MONO }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: '1 1 320px', minWidth: 260 }}>
              <label style={labelStyle}>{t('chat.systemLabel')}</label>
              <textarea
                className="input"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={t('chat.systemPlaceholder')}
                rows={2}
                style={{ fontSize: 12, resize: 'vertical', lineHeight: 1.5 }}
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
                style={{ fontSize: 12, resize: 'vertical', lineHeight: 1.5 }}
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
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 260 }}>
          <div
            ref={scrollRef}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              flex: 1,
              // minHeight:0 is what lets the transcript SHRINK instead of
              // pushing the composer out of the card — the classic flex overflow trap.
              minHeight: 0,
              overflowY: 'auto',
              paddingRight: 4,
            }}
          >
            {turns.length === 0 ? (
              <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.8 }}>
                <div style={{ fontSize: 13, color: 'var(--text-main)', marginBottom: 4 }}>{t('chat.emptyTitle')}</div>
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
              style={{ flex: 1, fontSize: 12.5, resize: 'vertical', lineHeight: 1.6 }}
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
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
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
                  fontSize: 11,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {decisionError}
              </pre>
            ) : !decision ? (
              <div style={{ minHeight: 180, display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center', color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.8 }}>
                <div style={{ fontSize: 13, color: 'var(--text-main)', marginBottom: 4 }}>{t('decision.emptyTitle')}</div>
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
                  {decision.facts.traceId && <FactChip label={t('chat.factTrace')} value={decision.facts.traceId} />}
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
    </div>
  );
};

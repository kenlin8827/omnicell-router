/**
 * /playground — client-simulation playground for the gateway's four inference
 * protocol surfaces, one menu entry:
 *
 *  - chat tab: ONE conversation view over the three CHAT-SHAPED wires selected
 *    by the protocol selector — `POST /v1/chat/completions`,
 *    `POST /v1/messages` (anthropic), `POST /v1/responses` (responses). The
 *    bubbles, the multi-turn history and the observation chips are shared; only
 *    the serialization differs, which is exactly what the selector exercises.
 *    Behaves like an external SDK client (inbound key validation + rate limits,
 *    per-key model access, the routing ladder, failover, capture, sessions).
 *  - decision tab: `POST /v1/systemone` — the System One decision wire: one
 *    `state` evaluated against typed `questions`, answered with values and
 *    probabilities. Served natively by a decision-wire provider or by protocol
 *    conversion through a chat model. Not a conversation, so it stays a MODE
 *    beside the three chat-shaped protocols rather than a fourth adapter.
 *
 * Deliberately NOT a console API client: every request is sent over the real
 * client wire with the selected key as `Authorization: Bearer`, and the X-OCR
 * observation headers are surfaced so the routing decision can be verified from
 * the client side. Model wires come from the gateway catalog (single source:
 * backend/src/providers/wire.ts) — never re-derived here.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Bot, Check, ChevronDown, ChevronRight, ChevronUp, Clock, Copy, Eraser, Expand, Eye, EyeOff, GitBranch, ImagePlus, Link2, Loader2, Pencil, RotateCcw, SlidersHorizontal, Sparkles, Undo2, Wrench, Maximize2, MessagesSquare, Minimize2, Plus, Save, Send, Shrink, Square, Trash2, User, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, type ApiKeyItem } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { InfoTip } from '../components/InfoTip';
import { Dialog } from '../components/Dialog';
import { useConfirm } from '../components/ConfirmProvider';
import { Combobox } from '../components/Combobox';
import { SegGroup } from '../components/SegGroup';
import { Drawer } from '../components/Drawer';
import { Switch } from '../components/Switch';
import { MD_COMPONENTS, MD_PLUGINS } from '../components/Prose';
import { copyToClipboard } from '../lib/clipboard';
import { FONT_MONO } from '../lib/fonts';
import type { PlaygroundPreset, PlaygroundPresetQuestion } from '../i18n/types';
import { decodeRate, formatRate } from '../lib/format';
import { EFFORT_LADDER, EFFORT_I18N_KEY, type ReasoningEffort } from '../lib/effort';
import {
  CHAT_PROTOCOLS,
  CHAT_PROTOCOL_BY_ID,
  asChatProtocolId,
  elideDataUrls,
  elideImagePayloads,
  formatBytes,
  hasUnansweredToolCalls,
  imageBytes,
  mergeUsage,
  parseWireImageInput,
  wireHistoryFromTurns,
  wireImageUrl,
  type ChatProtocolId,
  type WireImage,
  type WireMessage,
  type WireParams,
  type WireToolCall,
  type WireToolChoice,
  type WireToolDef,
  type WireToolResult,
  type WireUsage,
} from '../lib/playground-protocols';
import { PLAYGROUND_TOOLS, resetSandbox, runPlaygroundTool } from '../lib/playground-tools';

/** The observation header names — one place, so header and summary parsing
 *  read the SAME vocabulary (the summary frame reuses the header keys). */
const HDR = {
  tier: 'X-OCR-Tier',
  /** OUTBOUND protocol id of the served attempt — the provider protocol the
   *  gateway spoke, not the surface this page called. */
  protocol: 'X-OCR-Protocol',
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
/** How many tool rounds one turn may run before the playground stops driving
 *  the loop. A model that keeps calling tools would otherwise spin forever, and
 *  every round resends the whole history (attachments included). */
const PG_MAX_TOOL_ROUNDS = 5;

/** Every sandbox tool name, in panel order — the "select all" shortcut. */
const ALL_TOOL_NAMES = PLAYGROUND_TOOLS.map((tool) => tool.name);


/** Tools a fresh console session starts with: the READ-ONLY trio. An empty set
 *  is not a neutral default — it silently switches the tool path off, so the
 *  first prompt a new user tries exercises nothing and the panel looks
 *  configured while the request carries no `tools` at all. These three are
 *  enough for a model to look around the sandbox and produce tool cards, and
 *  none of them can mutate it; `write` / `edit` / `rm` stay off because a
 *  model reaching for them on a first run changes the tree the NEXT run reads,
 *  which is exactly the kind of hidden state a scratch surface must not grow. */
const DEFAULT_TOOL_NAMES = ['read', 'ls', 'grep'];

/** Tool arguments travel as a RAW JSON string (the wire carries text, not an
 *  object). Pretty-print when it parses; a truncated payload shows verbatim,
 *  which is precisely the case worth seeing. */
const prettyToolArgs = (raw: string): string => {
  if (!raw.trim()) return '{}';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

/** Longest one-line argument digest on a folded tool call. */
const TOOL_DIGEST_MAX = 96;

/** A call's arguments on ONE line, for the folded header row. A folded card has
 *  to say WHAT was called without spending four lines on `{ "path": "src" }`;
 *  the pretty-printed body is still one click away. Unparseable arguments (the
 *  exact case worth inspecting) fall through as raw text instead of throwing. */
const toolArgDigest = (raw: string): string => {
  const flat = (value: unknown): string => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return (text ?? '').replace(/\s+/g, ' ').trim();
  };
  const clip = (text: string): string =>
    text.length > TOOL_DIGEST_MAX ? `${text.slice(0, TOOL_DIGEST_MAX)}…` : text;
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return clip(raw.replace(/\s+/g, ' ').trim());
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return clip(flat(parsed)) || '{}';
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.length) return '{}';
  const parts = entries.map(([key, value]) => {
    const text = flat(value);
    return `${key}=${text.length > 40 ? `${text.slice(0, 40)}…` : text}`;
  });
  return clip(parts.join('  '));
};

const PG_TITLE_LEN = 48;
const PG_MAX_CONVERSATIONS = 50;
/** Per-attachment ceiling for browser-picked bytes. Anthropic's own API limit is
 *  5 MB per image; staying under it keeps the same attachment valid on every
 *  wire instead of failing only on the strictest one. */
const PG_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
/** Longest edge an attachment keeps. Larger images are downscaled before they
 *  are staged: base64 inflates bytes by 4/3 and the conversation resends every
 *  attachment on the next turn, so an untouched 4 MB screenshot becomes ~5.4 MB
 *  per turn and the gateway refuses the body (`FST_ERR_CTP_BODY_TOO_LARGE`).
 *  1568 px is the model-side convention — past it providers downscale anyway. */
const PG_IMAGE_MAX_EDGE = 1568;
/** Under this the re-encode costs more quality than it saves bytes. */
const PG_IMAGE_KEEP_BYTES = 700 * 1024;
/** Ceiling on attachments per turn — a browser-side sanity bound, not a wire
 *  rule (every wire accepts more; nobody wants to hand-pick twenty). */
const PG_MAX_IMAGES = 6;

/** The runtime knobs a conversation REMEMBERS: everything the request body is
 *  built from once the model and the system prompt are known. Stored with the
 *  transcript so a stored exchange can be replayed under the conditions that
 *  produced it — which is the only reason a playground keeps history at all —
 *  and copied verbatim by a fork.
 *
 *  `manualKey` is deliberately absent: a plaintext key never touches
 *  localStorage. The manual override is a page-level loan (the operator pasting
 *  a key from outside), not a property of the conversation, so `keyId` holds
 *  only the ID of a CONFIGURED key row. */
interface PgChatParams {
  stream: boolean;
  temperature: string;
  maxTokens: string;
  effort: string;
  /** Sandbox tool names, as checked in the panel. Names removed from
   *  `PLAYGROUND_TOOLS` later simply stop matching — see `toolDefs`. */
  tools: string[];
  toolChoice: WireToolChoice;
  parallelTools: boolean;
  autoRunTools: boolean;
}

const asWireToolChoice = (value: unknown): WireToolChoice =>
  value === 'required' || value === 'none' ? value : 'auto';

/** Narrow a stored snapshot to the shape the form accepts. A conversation saved
 *  before the knobs were recorded carries none, and `undefined` means "no
 *  opinion" — the page then keeps whatever the operator has set now instead of
 *  resetting a live form to invented defaults. A PARTIAL snapshot fills its own
 *  gaps from the same neutral defaults a fresh page starts with, so a truncated
 *  row cannot leave a knob undefined under a boolean-typed control. */
const sanitizeChatParams = (raw: unknown): PgChatParams | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Partial<PgChatParams>;
  return {
    stream: typeof p.stream === 'boolean' ? p.stream : true,
    temperature: typeof p.temperature === 'string' ? p.temperature : '',
    maxTokens: typeof p.maxTokens === 'string' ? p.maxTokens : '',
    effort: typeof p.effort === 'string' ? p.effort : '',
    // Unknown names are dropped against the CURRENT tool table: a sandbox tool
    // renamed or removed in a later release would otherwise sit in the count
    // ("all selected" never enabling, a stale selection never clearing) while
    // `toolDefs` silently filtered it out of the request.
    tools: Array.isArray(p.tools)
      ? p.tools.filter((name): name is string =>
        typeof name === 'string' && PLAYGROUND_TOOLS.some(tool => tool.name === name))
      : [...DEFAULT_TOOL_NAMES],
    toolChoice: asWireToolChoice(p.toolChoice),
    parallelTools: typeof p.parallelTools === 'boolean' ? p.parallelTools : true,
    autoRunTools: typeof p.autoRunTools === 'boolean' ? p.autoRunTools : true,
  };
};

interface PgChatConversation {
  id: string;
  title: string;
  sessionId: string;
  turns: ChatTurn[];
  model: string;
  /** Which chat-shaped surface this conversation speaks. Absent in stores written
   *  before the protocol selector existed — narrowed on load, never trusted. */
  protocol?: ChatProtocolId;
  systemPrompt: string;
  draft: string;
  /** Runtime knobs last used in this conversation (`PgChatParams`). Absent in
   *  stores written before the snapshot existed, and on a conversation that has
   *  never been active — adopting it then leaves the page's current settings
   *  alone rather than resetting them. */
  params?: PgChatParams;
  /** Configured key row this conversation last sent with. A reference, never a
   *  secret; restoring it is skipped when the row no longer exists. */
  keyId?: string;
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

/** Derive a display title from the first user turn (or the decision state).
 *  An image-only opening turn has no text to borrow, so the caller supplies the
 *  fallback label — a conversation started with a screenshot must not list as
 *  an empty row. */
const chatTitle = (turns: ChatTurn[], imageOnlyLabel: string): string => {
  const first = turns.find(t => t.role === 'user' && (t.content || t.images?.length));
  if (!first) return '';
  if (!first.content) return imageOnlyLabel;
  return first.content.slice(0, PG_TITLE_LEN).replace(/\n/g, ' ');
};

/** Conversation titles are a model-written SUMMARY of the exchange, not a cut
 *  of the first prompt: `chatTitle` stays as the pre-first-answer fallback the
 *  list renders, while the stored `title` is what the summarizer produced (or
 *  the operator typed). Both are bounded by `PG_TITLE_LEN` so a row never grows
 *  past its column. */
const TITLE_SYSTEM = `You name chat conversations. Reply with ONLY a title for the conversation the user gives you: one line, at most 8 words (at most 20 characters in CJK), written in the conversation's own language, no quotes, no trailing punctuation, no "Title:" prefix.`;
/** Transcript budget handed to the summarizer. The helper round rides on the
 *  operator's key, so a long conversation sends its head and its tail — topics
 *  live at the edges — instead of a copy of the whole history. */
const TITLE_INPUT_MAX = 6000;
const TITLE_TIMEOUT_MS = 20_000;
/** A title needs a handful of tokens; 200 leaves room for a reasoning model
 *  that spends part of the budget thinking before it answers. */
const TITLE_MAX_TOKENS = 200;

/** Cut the model's answer down to a title: one line, no wrapping quotes, no
 *  "Title:" prefix, no trailing sentence punctuation, capped at the same width
 *  the history row uses. */
const cleanTitle = (raw: string): string =>
  raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/^[\s"'`*#]+/, '')
    .replace(/^(title)\s*[:：]\s*/i, '')
    .replace(/[\s"'`*.,;:!?。！？，；：]+$/, '')
    .slice(0, PG_TITLE_LEN)
    .trim();

/** The summarizer's input: one `User:`/`Assistant:` line per non-empty turn,
 *  each clipped, joined, then head+tail bounded. Images contribute nothing —
 *  a title is about the topic, not the pixels. */
const titleTranscript = (messages: WireMessage[]): string => {
  const lines: string[] = [];
  for (const m of messages) {
    const text = m.content.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${text.slice(0, 500)}`);
  }
  const joined = lines.join('\n');
  if (joined.length <= TITLE_INPUT_MAX) return joined;
  const half = Math.floor(TITLE_INPUT_MAX / 2);
  return `${joined.slice(0, half)}\n…\n${joined.slice(-half)}`;
};

/** Read a picked file into an attachment. `FileReader` yields the data URL the
 *  wire eventually carries, so the base64 payload is split out here once rather
 *  than re-encoded per protocol. */
const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });

/**
 * Re-encode an attachment at `PG_IMAGE_MAX_EDGE`, in the browser, before it is
 * staged. JPEG for everything but PNG (PNG keeps its alpha and is what a
 * screenshot of text already is); a canvas failure falls back to the original
 * bytes — a big attachment is better than a lost one.
 */
const shrinkImage = async (dataUrl: string, mediaType: string): Promise<string> => {
  try {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const scale = Math.min(1, PG_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    if (scale === 1 && mediaType === 'image/png') {
      bitmap.close?.();
      return dataUrl;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close?.();
      return dataUrl;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    return mediaType === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.86);
  } catch {
    return dataUrl;
  }
};

const readImageFile = async (file: File): Promise<WireImage> => {
  const asDataUrl = await readAsDataUrl(file);
  const initial = /^data:([^;,]+);base64,(.*)$/.exec(asDataUrl);
  if (!initial) throw new Error('unsupported image encoding');
  const shrunk = file.size > PG_IMAGE_KEEP_BYTES ? await shrinkImage(asDataUrl, file.type || initial[1]!) : asDataUrl;
  const match = /^data:([^;,]+);base64,(.*)$/.exec(shrunk);
  if (!match) throw new Error('unsupported image encoding');
  return { kind: 'base64', mediaType: match[1]!, data: match[2]!, bytes: imageBytes({ kind: 'base64', mediaType: match[1]!, data: match[2]! }) };
};


// ── chat store ──

const loadChatStore = (): { active: string; conversations: PgChatConversation[] } => {
  try {
    const raw = localStorage.getItem(PG_CHAT_KEY);
    if (!raw) return { active: '', conversations: [] };
    const parsed = JSON.parse(raw) as { active?: string; conversations?: unknown[] };
    const list = Array.isArray(parsed.conversations)
      ? (parsed.conversations as PgChatConversation[])
        .filter(c => c && typeof c.id === 'string' && typeof c.sessionId === 'string')
        // A conversation saved before the selector existed carries no
        // `protocol`: narrow it rather than trusting the stored value. Same
        // for the runtime-knob snapshot and the key reference — a hand-edited
        // or truncated store must not reach a typed control.
        .map(c => ({
          ...c,
          protocol: asChatProtocolId(c.protocol),
          params: sanitizeChatParams(c.params),
          keyId: typeof c.keyId === 'string' ? c.keyId : undefined,
        }))
      : [];
    return { active: typeof parsed.active === 'string' ? parsed.active : '', conversations: list };
  } catch { return { active: '', conversations: [] }; }
};

const saveChatStore = (active: string, conversations: PgChatConversation[]) => {
  try {
    const trimmed = conversations.slice(0, PG_MAX_CONVERSATIONS);
    // Persist the receipt, not the bytes: one 3 MB attachment would blow the
    // ~5 MB localStorage quota and take every stored conversation with it
    // (setItem throws, and the catch below would silently discard the write).
    const storable = trimmed.map(c => ({
      ...c,
      turns: c.turns.map(t => (t.images?.length ? { ...t, images: elideImagePayloads(t.images) } : t)),
    }));
    localStorage.setItem(PG_CHAT_KEY, JSON.stringify({ active, conversations: storable }));
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
    protocol: 'openai-chat',
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

/** The conversation this page OPENS on — its own `active`, else the newest — so
 *  every working field (protocol, model, key, runtime knobs) seeds from the same
 *  row. A reload therefore restores the conditions the stored transcript was
 *  produced with, instead of resetting the form to bare defaults and letting the
 *  auto-save effect write those defaults over the real snapshot. Undefined only
 *  on a truly empty store, where `loadChatStoreWithActive` mints the seed. */
const seedChatConversation = (): PgChatConversation | undefined => {
  const store = loadChatStore();
  return store.conversations.find(c => c.id === store.active) ?? store.conversations[0];
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
  /** OUTBOUND protocol id the served attempt spoke (`openai-chat`, …). */
  protocol?: string;
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

/** The transcript's token counters — the adapter's normalized shape, so each
 *  wire's cache carrier (`cached_tokens`) lands in the same record. */
type TurnUsage = WireUsage;

interface ChatTurn {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  /** Images the user attached to this turn. Stored WITHOUT the bytes: a reload
   *  keeps the receipt (count + size) and shows a placeholder, never a
   *  megabyte of base64 inside localStorage. */
  images?: WireImage[];
  /** Upstream `reasoning_content` — kept apart so the answer stays readable. */
  reasoning?: string;
  pending?: boolean;
  status?: number;
  error?: string;
  facts?: TurnFacts;
  /** INBOUND protocol surface this assistant turn was requested through (the
   *  tab active at send time). A conversation can switch surfaces between
   *  turns, so it is recorded per turn instead of read from current state. */
  protocol?: ChatProtocolId;
  usage?: TurnUsage;
  /** Raw bodies behind the turn's details drawer. */
  requestJson?: unknown;
  responseJson?: unknown;
  /** Assistant turn: the tool calls the model asked for, `arguments` kept as the
   *  RAW JSON STRING the wire carried (a truncated payload is a real outcome
   *  worth seeing, so it is never parsed away). */
  toolCalls?: WireToolCall[];
  /** Outcomes of those calls, produced locally by the sandbox and handed back on
   *  the next round. Kept on the SAME turn as the calls so the transcript reads
   *  as one exchange: "asked for X, got Y". */
  toolResults?: WireToolResult[];
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
  protocol: nonEmpty(get(HDR.protocol)),
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

/** A drawer section heading. */
const settingsSectionStyle: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'],
  color: 'var(--text)',
};

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

/** One fact, one pill. A pill NEVER widens the row: it is a flex item that may
 *  shrink (`minWidth: 0`), and its value ellipsizes instead — a long request id
 *  used to push the whole chip row past the transcript and turn the reading
 *  column into a horizontal scroller. */
const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  maxWidth: '100%',
  minWidth: 0,
  fontSize: 'var(--text-xs)',
  lineHeight: 'var(--leading-snug)',
  padding: '0 6px',
  borderRadius: 999,
  border: '1px solid var(--card-border)',
  color: 'var(--text-dim)',
  whiteSpace: 'nowrap',
};

/** The value half of a pill: mono, clipped, full text in the pill's title. */
const chipValueStyle: React.CSSProperties = {
  color: 'var(--text-main)',
  fontFamily: FONT_MONO,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
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
const FactChip: React.FC<{
  label: string;
  value: string;
  tip?: string;
  onOpen?: () => void;
  /** Ceiling for the value, in px. Machine ids (request / session) are wider
   *  than anything readable at a glance, so each one caps itself: the pill keeps
   *  its label and first ~20 mono characters, the full value lives in the title.
   *  Omitted = the pill is exactly as wide as its content. */
  maxWidth?: number;
}> = ({ label, value, tip, onOpen, maxWidth }) => (
  <span style={chipStyle} title={tip ?? `${label}: ${value}`}>
    {label}
    {onOpen ? (
      <button
        type="button"
        onClick={onOpen}
        style={{
          ...chipValueStyle,
          ...(maxWidth !== undefined ? { maxWidth } : {}),
          background: 'none',
          border: 'none',
          padding: 0,
          margin: 0,
          font: 'inherit',
          fontFamily: FONT_MONO,
          cursor: 'pointer',
          textDecoration: 'underline',
          textDecorationColor: 'var(--card-border)',
        }}
      >
        {value}
      </button>
    ) : (
      <span style={{ ...chipValueStyle, ...(maxWidth !== undefined ? { maxWidth } : {}) }}>{value}</span>
    )}
  </span>
);

/** One tool call in the transcript. The header row IS the `<details>` summary —
 *  name, a one-line argument digest and the outcome — so a long agent loop
 *  reads as N lines instead of N JSON wells, which is what buried the answer
 *  whenever the model chained `ls`/`read` calls.
 *
 *  EVERY card starts folded — result present or not, success or error. The
 *  summary already carries the verdict (the ran / not-run / failed chip, rose on
 *  failure), so a body that opens itself only turns the transcript into a stack
 *  of JSON walls again; the reader opens the one call they came for. Only the
 *  fullscreen message passes `defaultOpen`. */
const ToolCallCard: React.FC<{
  call: WireToolCall;
  result?: WireToolResult;
  /** Fullscreen message: the reader asked for more, so the body starts open. */
  defaultOpen?: boolean;
  /** Turn-level bulk action; the card stays independently collapsible after it. */
  bulk?: { seq: number; open: boolean };
}> = ({ call, result, defaultOpen, bulk }) => {
  const { t } = useI18n();
  const args = prettyToolArgs(call.arguments);
  const failed = !!result && result.content.startsWith('error:');
  const [open, setOpen] = useState(() => !!defaultOpen);
  useEffect(() => {
    // `bulk` only changes when the turn-level toggle fires; a per-card click
    // never re-triggers the sync (which would fight the reader).
    if (bulk) setOpen(bulk.open);
  }, [bulk]);

  return (
    <details
      className="tool-call"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      style={{
        border: '1px solid var(--card-border)',
        borderRadius: 6,
        background: 'var(--well-bg)',
        fontFamily: FONT_MONO,
        fontSize: 'var(--text-xs)',
        maxWidth: '100%',
        minWidth: 0,
      }}
    >
      <summary
        title={args}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', minWidth: 0 }}
      >
        <ChevronRight
          size={11}
          style={{
            flexShrink: 0,
            color: 'var(--text-dim)',
            transition: 'transform 0.15s',
            transform: open ? 'rotate(90deg)' : 'none',
          }}
        />
        <Wrench size={11} color="var(--accent)" style={{ flexShrink: 0 }} />
        <span style={{ color: 'var(--accent)', flexShrink: 0 }}>{call.name || '—'}</span>
        <span
          style={{
            color: 'var(--text-dim)',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {toolArgDigest(call.arguments)}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            flexShrink: 0,
            color: failed ? 'var(--accent-rose)' : 'var(--text-dim)',
          }}
        >
          {result ? (failed ? t('chat.toolFailed') : t('chat.toolRan')) : t('chat.toolNotRun')}
        </span>
      </summary>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: '0 8px 6px',
          minWidth: 0,
        }}
      >
        <div
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
            color: 'var(--text-dim)',
            maxHeight: 160,
            overflowY: 'auto',
          }}
        >
          {args}
        </div>
        {result && (
          <div
            style={{
              paddingTop: 4,
              borderTop: '1px dashed var(--card-border)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflowWrap: 'anywhere',
              maxHeight: 220,
              overflowY: 'auto',
              color: failed ? 'var(--accent-rose)' : 'var(--text)',
            }}
          >
            {result.content}
          </div>
        )}
      </div>
    </details>
  );
};

/** The calls of one assistant turn, plus the bulk toggle that only appears once
 *  the loop is long enough to be worth folding. */
const ToolCallList: React.FC<{
  calls: WireToolCall[];
  results?: WireToolResult[];
  defaultOpen?: boolean;
}> = ({ calls, results, defaultOpen }) => {
  const { t } = useI18n();
  const [bulk, setBulk] = useState<{ seq: number; open: boolean }>();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: '100%', minWidth: 0 }}>
      {calls.map((call, i) => (
        <ToolCallCard
          key={call.id || i}
          call={call}
          result={results?.find((r) => r.id === call.id)}
          defaultOpen={defaultOpen}
          bulk={bulk}
        />
      ))}
      {calls.length > 2 && (
        <button
          type="button"
          className="btn btn-sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setBulk((b) => ({ seq: (b?.seq ?? 0) + 1, open: !(b?.open ?? false) }))}
        >
          <ChevronRight
            size={11}
            style={{ transform: bulk?.open ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s' }}
          />
          <span>{bulk?.open ? t('chat.toolsCollapseAll') : t('chat.toolsExpandAll')}</span>
        </button>
      )}
    </div>
  );
};

/** A user turn's attachments as one wrapping row. Extracted because BOTH
 *  surfaces need it: the bubble shows thumbnails, and the expanded dialog used
 *  to drop them entirely, so expanding an image-only message showed nothing.
 *  Size is clamped by `max` so the dialog's wider card does not blow a 3× image
 *  up into a wall. */
const TurnImageRow: React.FC<{ images: WireImage[]; max?: number }> = ({ images, max = 168 }) => {
  const { t } = useI18n();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {images.map((img, i) =>
        // A stored turn keeps only the receipt — the bytes were dropped before
        // the store write, so show what it was and how big.
        img.kind === 'base64' && !img.data ? (
          <span
            key={i}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '3px 7px', borderRadius: 5,
              border: '1px dashed var(--card-border)',
              fontSize: 'var(--text-xs)', color: 'var(--text-dim)',
              fontFamily: FONT_MONO,
            }}
          >
            {t('chat.imageNotStored', { size: formatBytes(imageBytes(img)) })}
          </span>
        ) : (
          <img
            key={i}
            src={wireImageUrl(img)}
            alt={t('chat.imageAlt')}
            style={{
              maxWidth: max, maxHeight: max, borderRadius: 6,
              border: '1px solid var(--card-border)', objectFit: 'contain',
              background: 'var(--well-bg)',
            }}
          />
        )
      )}
    </div>
  );
};

/** One conversation row. User text stays plain (pre-wrap, body font);
 *  assistant text renders GFM markdown through the shared sanitized component
 *  map (remote images are never fetched). */
/** One hover-revealed action on a bubble's top-right corner. */
interface TurnAction {
  key: string;
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
}

const TurnBubble: React.FC<{
  turn: ChatTurn;
  onRegenerate?: () => void;
  onFork?: () => void;
  onRevert?: () => void;
}> = ({ turn, onRegenerate, onFork, onRevert }) => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const isUser = turn.role === 'user';
  const facts = turn.facts;
  // Per-message "expand": read one reply at full size when the inline bubble
  // squeezes long markdown or reasoning. Local to the row — the dialog is the
  // shared shell, so Esc/backdrop behaviour matches every other dialog.
  const [messageOpen, setMessageOpen] = useState(false);
  const [rowHover, setRowHover] = useState(false);
  /** Copy affordance of the EXPANDED message: the dialog is the reading surface
   *  for a long reply, so taking the text out of it belongs there — that is what
   *  the header's copy button does (same slot, same behaviour as the JSON well's
   *  own dialog, which puts copy next to `×`). */
  const [copied, setCopied] = useState(false);
  const copyMessage = async () => {
    const ok = await copyToClipboard(turn.content);
    if (!ok) {
      toast.error(t('common.copyFailed'));
      return;
    }
    setCopied(true);
    toast.success(t('common.copied'));
    window.setTimeout(() => setCopied(false), 1200);
  };
  // Decode-TPS from the gateway-measured window: completion tokens ÷ genMs,
  // the exact pair the console uses. A buffered turn carries no window, so the
  // chip shows '—' rather than a rate synthesized from client-side timing.
  const genMs = facts?.genMs !== undefined ? Number(facts.genMs) : undefined;
  const rate = turn.usage?.completion_tokens !== undefined ? decodeRate(turn.usage.completion_tokens, genMs) : null;
  // Protocol chip, two-sided like the console's session column: the INBOUND
  // surface this turn was sent through (recorded at send time — the tab can
  // change between turns) → the OUTBOUND provider protocol the gateway
  // actually spoke. A converted turn therefore reads e.g.
  // `openai-responses → openai-chat`.
  const inboundProtocol = turn.protocol ? asChatProtocolId(turn.protocol) : undefined;
  const protocolValue = facts?.protocol
    ? inboundProtocol
      ? `${inboundProtocol} → ${facts.protocol}`
      : facts.protocol
    : undefined;
  // The corner is an ARRAY, not fixed slots: a turn offers a different set
  // depending on where it sits (the last turn has nothing after it to revert,
  // a pending turn offers nothing at all), and laying them out by index keeps
  // the gaps right without a per-button offset table. `regenerate` sits closest
  // to the expand glyph, `revert` furthest — it is the destructive one, so its
  // reach is the longest.
  const actions: TurnAction[] = [];
  if (onRegenerate) actions.push({ key: 'regen', icon: <RotateCcw size={11} />, title: t('chat.regenerate'), onClick: onRegenerate });
  if (onFork) actions.push({ key: 'fork', icon: <GitBranch size={11} />, title: t('chat.forkFrom'), onClick: onFork });
  if (onRevert) actions.push({ key: 'revert', icon: <Undo2 size={11} />, title: t('chat.revertTo'), onClick: onRevert });
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: isUser ? 'flex-end' : 'flex-start' }}
      onMouseEnter={() => setRowHover(true)}
      onMouseLeave={() => setRowHover(false)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minHeight: 20, fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
        {isUser ? <User size={12} /> : <Bot size={12} />}
        <span>{isUser ? t('chat.you') : t('chat.assistant')}</span>
        {turn.pending && <Loader2 size={11} style={{ animation: 'ocr-spin 0.8s linear infinite' }} />}
        {/* Hover actions live on the role line, NOT in the bubble corner: an
            absolutely-positioned top:4 button covered the first line of a
            short one-line prompt, because the bubble hugs its own text. */}
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 3,
          opacity: rowHover || messageOpen ? 0.75 : 0,
          pointerEvents: rowHover || messageOpen ? 'auto' : 'none',
          transition: 'opacity 0.15s ease',
        }}>
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              className="btn btn-sm"
              onClick={action.onClick}
              title={action.title}
              aria-label={action.title}
              style={{
                width: 20, height: 20, minHeight: 0, padding: 0,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 5,
              }}
            >
              {action.icon}
            </button>
          ))}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setMessageOpen(true)}
            title={t('chat.expandMessage')}
            aria-label={t('chat.expandMessage')}
            style={{
              width: 20, height: 20, minHeight: 0, padding: 0,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 5,
            }}
          >
            <Maximize2 size={11} />
          </button>
        </span>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {turn.images && turn.images.length > 0 && <TurnImageRow images={turn.images} />}
            {turn.content && <div style={{ whiteSpace: 'pre-wrap' }}>{turn.content}</div>}
          </div>
        ) : turn.content ? (
          <div className="md-well">
            <ReactMarkdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>
              {turn.content}
            </ReactMarkdown>
          </div>
        ) : turn.pending ? (
          <span style={{ color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>{t('chat.pending')}</span>
        ) : null}

        {!isUser && turn.toolCalls && turn.toolCalls.length > 0 && (
          <div style={{ marginTop: turn.content ? 8 : 0, maxWidth: '100%', minWidth: 0 }}>
            <ToolCallList calls={turn.toolCalls} results={turn.toolResults} />
          </div>
        )}

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

      {/* Facts carry the SAME 88% ceiling as the bubble above: they describe the
          message, so they wrap inside its width instead of running wider than
          the answer. Chips cap their own values on top of this. */}
      {!isUser && (facts || turn.usage || (!turn.pending && !turn.error)) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxWidth: '88%', minWidth: 0 }}>
          {facts?.model && <FactChip label={t('chat.factModel')} value={facts.model} maxWidth={220} />}
          {facts?.tier && <FactChip label={t('chat.factTier')} value={facts.tier} />}
          {protocolValue && (
            <FactChip label={t('chat.factProtocol')} value={protocolValue} tip={t('chat.factProtocolTip')} />
          )}
          {facts?.latencyMs && <FactChip label={t('chat.factLatency')} value={`${facts.latencyMs} ms`} />}
          {turn.usage && (
            <FactChip label={t('chat.factRate')} value={formatRate(rate)} tip={t('chat.factRateTip')} />
          )}
          {facts?.failover === 'true' && facts.failoverPath && facts.failoverPath.split(' -> ').length > 1 && (
            <FactChip label={t('chat.factFailover')} value={facts.failoverPath} maxWidth={240} />
          )}
          {facts?.thinking && (
            <FactChip
              label={t('chat.factThinking')}
              value={facts.thinkingSource ? `${facts.thinking} · ${facts.thinkingSource}` : facts.thinking}
              maxWidth={160}
            />
          )}
          {facts?.breaker && facts.breaker !== 'CLOSED' && <FactChip label={t('chat.factBreaker')} value={facts.breaker} />}
          {facts?.requestId && <FactChip label={t('chat.factRequest')} value={facts.requestId} maxWidth={150} />}
          {facts?.sessionId && (
            <FactChip
              label={t('chat.factSession')}
              value={facts.sessionId}
              tip={t('chat.factSessionTip')}
              onOpen={() => navigate(`/sessions?q=${encodeURIComponent(facts.sessionId!)}`)}
              maxWidth={140}
            />
          )}
          {turn.usage ? (
            <FactChip
              label={t('chat.factTokens')}
              value={`${turn.usage.prompt_tokens ?? 0} / ${turn.usage.completion_tokens ?? 0} / ${turn.usage.total_tokens ?? 0}`}
            />
          ) : (
            // A finished turn with no usage frame is a FACT worth showing: some
            // upstreams (and every plugin wire that does not report billing)
            // omit it, and a chip that silently vanishes reads as a console bug.
            !turn.pending &&
            !turn.error && (
              <FactChip label={t('chat.factTokens')} value="—" tip={t('chat.factTokensUnknown')} />
            )
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
          headerActions={
            // The dialog is where a long reply is actually READ, so the copy
            // that belongs to reading lives here: one click pastes the message
            // text elsewhere. Same slot as the JSON well's own dialog.
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void copyMessage()}
              title={t('chat.copyMessageText')}
              aria-label={t('chat.copyMessageText')}
              disabled={!turn.content}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, fontSize: 'var(--text-md)', lineHeight: 'var(--leading-relaxed)', color: 'var(--text-main)' }}>
            {isUser && turn.images && turn.images.length > 0 && (
              <TurnImageRow images={turn.images} max={320} />
            )}
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
            {/* The fullscreen shell exists to show MORE, so the tool cards it
                used to drop come back here with every body already open. */}
            {!isUser && turn.toolCalls && turn.toolCalls.length > 0 && (
              <ToolCallList calls={turn.toolCalls} results={turn.toolResults} defaultOpen />
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

  /** The row every working field below seeds from — read ONCE per mount, so the
   *  protocol, the model, the key and the runtime knobs all describe the SAME
   *  conversation the store is about to activate. */
  const [seedChat] = useState<PgChatConversation | undefined>(seedChatConversation);

  /** Which chat-shaped surface the chat tab speaks. `systemone` is deliberately
   *  not a value here: the decision wire is a single-shot question/answer shape
   *  with its own panel, so it stays a MODE (the tab row maps it to one option). */
  const [protocol, setProtocol] = useState<ChatProtocolId>(() => asChatProtocolId(seedChat?.protocol));

  // ── shared: client identity + model addressing ──────────────────────────
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [keySource, setKeySource] = useState<'configured' | 'manual'>('configured');
  /** Seeded from the opening conversation: the key a transcript was produced
   *  with is part of its conditions. Validated against the loaded key list when
   *  a conversation is ADOPTED — at mount the list is still empty, and dropping
   *  the stored id here would lose it for good. */
  const [keyId, setKeyId] = useState(() => seedChat?.keyId ?? '');
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
  const [model, setModel] = useState(() => seedChat?.model ?? 'auto');
  const [modelOptions, setModelOptions] = useState<{ id: string; owned_by?: string }[]>([]);
  const [modelsFailed, setModelsFailed] = useState(false);
  /** id → resolved upstream wire (console catalog). The CHAT surface can only
   *  address non-`systemone` models, so the picker warns before a doomed call. */
  const [wireById, setWireById] = useState<Record<string, string>>({});
  /** id → supported effort levels (from console catalog). */
  const [effortsByModel, setEffortsByModel] = useState<Record<string, string[]>>({});

  // ── chat tab ────────────────────────────────────────────────────────────
  // Every knob below seeds from the opening conversation's snapshot
  // (`PgChatParams`), so a reload returns to the settings that produced the
  // transcript on screen instead of writing the bare defaults over them. The
  // `??` fallback IS the fresh-page default: a store written before the
  // snapshot existed carries no opinion, and inventing one would be worse than
  // the defaults the panel documents.
  const seedParams = seedChat?.params;
  const [stream, setStream] = useState(() => seedParams?.stream ?? true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Tool panel state. The selection travels WITH the conversation: which tools a
  // transcript was produced with is part of its conditions (the sandbox files
  // they read are page state anyway). A fresh page still starts on the
  // read-only starter trio, never on an empty set.
  const [selectedTools, setSelectedTools] = useState<string[]>(() => seedParams?.tools ?? [...DEFAULT_TOOL_NAMES]);
  const [toolChoice, setToolChoice] = useState<WireToolChoice>(() => seedParams?.toolChoice ?? 'auto');
  const [parallelTools, setParallelTools] = useState(() => seedParams?.parallelTools ?? true);
  const [autoRunTools, setAutoRunTools] = useState(() => seedParams?.autoRunTools ?? true);
  const [temperature, setTemperature] = useState(() => seedParams?.temperature ?? '');
  const [maxTokens, setMaxTokens] = useState(() => seedParams?.maxTokens ?? '');
  const [effort, setEffort] = useState(() => seedParams?.effort ?? '');
  const [promptPresets, setPromptPresets] = useState<PromptPreset[]>(loadPromptPresets);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetDraftName, setPresetDraftName] = useState('');
  const [busy, setBusy] = useState(false);
  /** Attachments staged for the NEXT user turn. Deliberately NOT persisted with
   *  the draft: the bytes exist to be sent, and a reload has no use for them. */
  const [pendingImages, setPendingImages] = useState<WireImage[]>([]);
  const [imageUrlOpen, setImageUrlOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const imageInputRef = useRef<HTMLInputElement | null>(null);
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
  /** One number for every column that follows the wide/narrow preference — the
   *  tab row, the params card, the chat card in and out of fullscreen. NO
   *  ceiling on wide: a hard cap leaves a dead scrim rim on both sides of a
   *  fullscreen column, and the operator who chose wide chose long lines.
   *  Narrow keeps its readable 900px column; fullscreen adds the width toggle
   *  to the card header so switching stays one click away. */
  const chatMaxWidth = chatWide ? '100%' : 900;
  // Setup visibility: the key / model / stream row is tall enough to crowd the
  // transcript on a laptop, and it changes once per session at most. Collapsed
  // it leaves ONE summary line (protocol, endpoint, key, model); view state
  // only, persisted like the width preference.
  const [setupOpen, setSetupOpen] = useState(() => {
    try { return localStorage.getItem('ocr_playground_setup') !== '0'; } catch { return true; }
  });
  const toggleSetup = () => {
    setSetupOpen(v => {
      try { localStorage.setItem('ocr_playground_setup', v ? '0' : '1'); } catch { /* best-effort */ }
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

  /** Mirror for the async title work: a summary request resolves long after
   *  the operator may have switched conversations, so it reads the CURRENT
   *  store instead of a render-time closure. */
  const chatConversationsRef = useRef(chatConversations);
  chatConversationsRef.current = chatConversations;
  /** Conversation id whose title is being generated right now (row spinner). */
  const [titleBusyId, setTitleBusyId] = useState('');
  /** Open rename editor: the target conversation and the in-progress text. */
  const [renameDraft, setRenameDraft] = useState<{ id: string; title: string } | null>(null);

  // Auto-save: write the active chat conversation into the store. The state
  // sync stays pure (no timer inside a setState updater), and a single
  // persistence effect debounces 60fps streaming deltas while immediate actions
  // (new/switch/delete/fork/title) cancel any pending timer and flush right
  // away so a stale timer can never overwrite localStorage.
  const chatSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const immediateChatSaveRef = useRef(false);
  const chatStoreHydratedRef = useRef(false);
  const cancelPendingChatSave = () => {
    if (chatSaveTimerRef.current !== null) {
      clearTimeout(chatSaveTimerRef.current);
      chatSaveTimerRef.current = null;
    }
  };
  useEffect(() => {
    if (!activeChatId) return;
    const now = Date.now();
    const paramsSnapshot = currentChatParams();
    setChatConversations((prev) =>
      prev.map(c => {
        if (c.id !== activeChatId) return c;
        const oldLast = c.turns[c.turns.length - 1];
        const newLast = turns[turns.length - 1];
        const activity =
          turns.length !== c.turns.length ||
          (!!newLast && (!oldLast || newLast.id !== oldLast.id ||
            (newLast.content || '').length !== (oldLast?.content || '').length));
        return {
          ...c, turns, draft, systemPrompt, model, protocol, nextId: nextIdRef.current,
          params: paramsSnapshot, keyId,
          sessionId: playgroundSessionId, updatedAt: activity ? now : c.updatedAt,
        };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    turns, draft, systemPrompt, model, protocol, playgroundSessionId, activeChatId,
    stream, temperature, maxTokens, effort, selectedTools, toolChoice, parallelTools, autoRunTools, keyId,
  ]);
  useEffect(() => {
    if (!activeChatId) return;
    if (!chatStoreHydratedRef.current) {
      chatStoreHydratedRef.current = true;
      return;
    }
    cancelPendingChatSave();
    if (immediateChatSaveRef.current) {
      immediateChatSaveRef.current = false;
      saveChatStore(activeChatId, chatConversations);
      return;
    }
    chatSaveTimerRef.current = setTimeout(() => {
      chatSaveTimerRef.current = null;
      saveChatStore(activeChatId, chatConversations);
    }, 300);
    return cancelPendingChatSave;
  }, [chatConversations, activeChatId]);

  /** The page's CURRENT runtime setup as a snapshot a conversation can store.
   *  Read at call time (never memoized): the auto-save effect must write the
   *  value the operator just set, not one captured at render. */
  const currentChatParams = (): PgChatParams => ({
    stream,
    temperature,
    maxTokens,
    effort,
    tools: [...selectedTools],
    toolChoice,
    parallelTools,
    autoRunTools,
  });

  /** Push a conversation's snapshot into the form. `undefined` — an archive
   *  written before the snapshot existed, or a conversation that was never
   *  active — is a deliberate no-op: a missing snapshot must not wipe settings
   *  the operator is in the middle of tuning. */
  const applyChatParams = (params: PgChatParams | undefined) => {
    if (!params) return;
    setStream(params.stream);
    setTemperature(params.temperature);
    setMaxTokens(params.maxTokens);
    setEffort(params.effort);
    setSelectedTools([...params.tools]);
    setToolChoice(params.toolChoice);
    setParallelTools(params.parallelTools);
    setAutoRunTools(params.autoRunTools);
  };

  /** Abort any in-flight chat stream and drop queued rAF turn patches so an
   *  aborted conversation can never overwrite bubbles in another conversation. */
  const cancelActiveChatStream = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    if (patchTurnRaf.current !== null) {
      cancelAnimationFrame(patchTurnRaf.current);
      patchTurnRaf.current = null;
    }
    patchTurnPending.current.clear();
  };

  /** Adopt a conversation's working fields. Persistence is the caller's job. */
  const adoptChatConversation = (conv: PgChatConversation) => {
    cancelActiveChatStream();
    setActiveChatId(conv.id);
    setTurns(conv.turns);
    setDraft(conv.draft);
    setSystemPrompt(conv.systemPrompt);
    setModel(conv.model);
    setProtocol(asChatProtocolId(conv.protocol));
    // Replaying an exchange means replaying its conditions: the knobs travel
    // with the conversation. The KEY does not travel the same way — only a
    // configured row is restored, and only while that row still exists (a
    // deleted key would otherwise leave the picker on a dangling id and every
    // send failing with "no key"). The manual override is a page-level loan and
    // is never touched here.
    applyChatParams(conv.params);
    if (conv.keyId && keys.some(k => k.id === conv.keyId)) setKeyId(conv.keyId);
    // Attachments belong to the turn being composed, and they are never
    // persisted — adopting another conversation must not carry them over.
    setPendingImages([]);
    setImageUrl('');
    setImageUrlOpen(false);
    nextIdRef.current = conv.nextId;
    setPlaygroundSessionId(conv.sessionId);
  };

  const newChatConversation = () => {
    const conv: PgChatConversation = {
      ...emptyChatConversation(),
      // A new transcript keeps the CLIENT setup — the knobs and the key row are
      // how this operator talks to the gateway, not part of the topic. The
      // model and system prompt DO fall back to the neutral defaults
      // `emptyChatConversation` sets: a prompt written for another thread is
      // exactly what a "new conversation" is meant to escape.
      params: currentChatParams(),
      keyId,
    };
    const next = [conv, ...chatConversations].slice(0, PG_MAX_CONVERSATIONS);
    cancelPendingChatSave();
    immediateChatSaveRef.current = true;
    setChatConversations(next);
    adoptChatConversation(conv);
  };

  const switchChatConversation = (id: string) => {
    const target = chatConversations.find(c => c.id === id);
    if (!target) return;
    if (id !== activeChatId) {
      cancelPendingChatSave();
      immediateChatSaveRef.current = true;
    }
    adoptChatConversation(target);
    // A quiet swap reads as "nothing happened" when the transcript looks
    // similar; one toast names what the transcript now belongs to.
    toast.info(t('chat.historySwitched', {
      title: target.title || chatTitle(target.turns, t('chat.imageAlt')) || t('chat.historyUntitled'),
    }));
  };

  const deleteChatConversation = (id: string) => {
    const remaining = chatConversations.filter(c => c.id !== id);
    // The store always keeps one active conversation: deleting the last row
    // seeds a fresh empty one instead of leaving the page unpersisted.
    const next = remaining.length > 0 ? remaining : [emptyChatConversation()];
    cancelPendingChatSave();
    immediateChatSaveRef.current = true;
    setChatConversations(next);
    if (id === activeChatId) adoptChatConversation(next[0]);
  };

  /** Branch the transcript AT `index`: the turns up to and including it become a
   *  NEW conversation and the source keeps every turn it had, so a dead-end
   *  answer can be explored without giving the original thread up. The branch
   *  mints its own `sessionId` — `turnIndex` is a WRITE-TIME attribute allocated
   *  per session (ADR-0024), and reusing the id would put two sequences that
   *  both start at 0 on one Sessions row. `nextId` carries over: every id in the
   *  copied prefix is already below it, so the branch just keeps minting. */
  const forkChatConversation = (index: number) => {
    const source = chatConversations.find(c => c.id === activeChatId);
    const prefix = turns.slice(0, index + 1);
    // A titled source keeps its title plus a suffix (the branch is the same
    // topic); an untitled one borrows the same first-turn cut the history row
    // would otherwise derive on every render.
    const title = source?.title
      ? `${source.title}${t('chat.forkTitleSuffix')}`
      : chatTitle(prefix, t('chat.imageAlt'));
    const branch: PgChatConversation = {
      ...emptyChatConversation(),
      turns: prefix,
      title,
      model,
      protocol,
      systemPrompt,
      // A branch inherits the conditions, not just the text: the knobs and the
      // key row are copied so the fork sends the same request the source did.
      // The page state and the source row agree here by construction — every
      // knob change is written through to the ACTIVE conversation by the
      // auto-save effect, and only the active transcript can be forked.
      params: currentChatParams(),
      keyId,
      nextId: nextIdRef.current,
    };
    const next = [branch, ...chatConversations].slice(0, PG_MAX_CONVERSATIONS);
    cancelPendingChatSave();
    immediateChatSaveRef.current = true;
    setChatConversations(next);
    adoptChatConversation(branch);
    toast.success(t('chat.forkCreated', { title: title || t('chat.historyUntitled') }));
  };

  /** Truncate the transcript AT `index` — everything after it is gone. Confirmed
   *  because there is no undo: the auto-save effect overwrites the stored copy
   *  on the next render. The dialog points at "fork" for the non-destructive
   *  version of the same intent. `nextId` deliberately does NOT roll back: a
   *  reused turn id would collide with the React key of a message still mounted
   *  in the same transcript. */
  const revertChatConversation = async (index: number) => {
    if (busy) return;
    const dropped = turns.length - (index + 1);
    if (dropped <= 0) return;
    const ok = await confirmDialog({
      title: t('chat.revertConfirmTitle'),
      description: t('chat.revertConfirmDesc', { count: dropped }),
      danger: true,
    });
    if (!ok) return;
    setTurns(turns.slice(0, index + 1));
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
  /** Same manual-termination contract as the chat tab: a decision call can be
   *  stopped while it waits, so a hung upstream never locks the form. */
  const decisionAbortRef = useRef<AbortController | null>(null);

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
    decisionAbortRef.current?.abort();
    decisionAbortRef.current = null;
    setDecisionBusy(false);
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

  // List endpoint returns masked keys — plaintext is fetched per-id via reveal.
  const [revealedKey, setRevealedKey] = useState('');
  useEffect(() => {
    if (keySource === 'manual') {
      setRevealedKey('');
      return;
    }
    if (!keyId) {
      setRevealedKey('');
      return;
    }
    let alive = true;
    api
      .revealApiKey(keyId)
      .then((r) => {
        if (alive) setRevealedKey(r.key || '');
      })
      .catch(() => {
        if (alive) setRevealedKey('');
      });
    return () => {
      alive = false;
    };
  }, [keySource, keyId, activationSeq]);

  const activeKey = useMemo(() => {
    if (keySource === 'manual') return manualKey.trim();
    return revealedKey;
  }, [keySource, manualKey, revealedKey]);

  // Configured keys (masked). Plaintext is resolved via revealApiKey above.
  useEffect(() => {
    let alive = true;
    api
      .getApiKeys()
      .then((r) => {
        if (!alive) return;
        const list = r.keys || [];
        setKeys(list);
        const firstEnabled = list.find((k) => k.enabled);
        // Keep the current pick while it still EXISTS — a conversation restored
        // from the store can name a key row that has since been deleted, and a
        // dangling id leaves the picker showing a value no row offers while every
        // send fails with "no key". Falls back to the first enabled row.
        setKeyId((cur) => (list.some((k) => k.id === cur) ? cur : (firstEnabled?.id ?? cur)));
      })
      .catch(() => { });
    return () => {
      alive = false;
    };
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
    let alive = true;
    api
      .listGatewayModels()
      .then((rows) => {
        if (!alive) return;
        const wMap: Record<string, string> = {};
        const eMap: Record<string, string[]> = {};
        for (const row of rows) {
          if (row.wire) wMap[row.id] = row.wire;
          if (row.efforts?.length) eMap[row.id] = row.efforts;
        }
        setWireById(wMap);
        setEffortsByModel(eMap);
      })
      .catch(() => { });
    return () => {
      alive = false;
    };
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

  // Coalesce rapid SSE patches into one rAF paint — a 10k-delta stream must
  // not schedule 10k React reconciles (perf 🔴-09).
  const patchTurnRaf = useRef<number | null>(null);
  const patchTurnPending = useRef<Map<number, Partial<ChatTurn>>>(new Map());
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      decisionAbortRef.current?.abort();
      decisionAbortRef.current = null;
      if (patchTurnRaf.current !== null) {
        cancelAnimationFrame(patchTurnRaf.current);
        patchTurnRaf.current = null;
      }
      cancelPendingChatSave();
    };
  }, []);
  const patchTurn = (id: number, patch: Partial<ChatTurn>) => {
    const prev = patchTurnPending.current.get(id) ?? {};
    patchTurnPending.current.set(id, { ...prev, ...patch });
    if (patchTurnRaf.current !== null) return;
    patchTurnRaf.current = requestAnimationFrame(() => {
      patchTurnRaf.current = null;
      const batch = patchTurnPending.current;
      patchTurnPending.current = new Map();
      setTurns((prev) =>
        prev.map((x) => {
          const p = batch.get(x.id);
          return p ? { ...x, ...p } : x;
        }),
      );
    });
  };

  /** Write a title into the store via functional update so an async summary
   *  never clobbers uncommitted state updates or gets overwritten by a stale
   *  debounced auto-save timer. */
  const applyTitle = (convId: string, title: string) => {
    cancelPendingChatSave();
    immediateChatSaveRef.current = true;
    setChatConversations((prev) =>
      prev.map(c => (c.id === convId ? { ...c, title, updatedAt: Date.now() } : c)),
    );
  };

  /** Ask the same gateway, on the same key and wire, for a one-line summary of
   *  the conversation. Deliberately WITHOUT `x-session-id`: this is a helper
   *  call, not a turn of the observed conversation, so the gateway mints its own
   *  one-shot session — exactly the traffic the Sessions page hides by default.
   *  Resolves false on any failure; the caller decides whether to say so. */
  const generateTitle = async (
    convId: string,
    messages: WireMessage[],
    target: { model?: string; protocol: ChatProtocolId }
  ): Promise<boolean> => {
    const proto = CHAT_PROTOCOL_BY_ID[target.protocol];
    const transcript = titleTranscript(messages);
    if (!transcript || !activeKey) return false;
    const body = proto.buildBody([{ role: 'user', content: transcript }], TITLE_SYSTEM, {
      model: (target.model ?? '').trim() || 'auto',
      stream: false,
      temperature: 0.2,
      maxTokens: TITLE_MAX_TOKENS,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
    setTitleBusyId(convId);
    try {
      const res = await fetch(proto.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${activeKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return false;
      const title = cleanTitle(proto.decodeJson(await res.json()).content || '');
      if (!title) return false;
      applyTitle(convId, title);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      setTitleBusyId(prev => (prev === convId ? '' : prev));
    }
  };

  /** Name a conversation that has none yet — the first successful exchange is
   *  the point where a summary exists to name it by. Later turns leave the row
   *  alone: the operator renamed it, or can ask for a fresh summary explicitly. */
  const autoTitle = (
    convId: string,
    history: WireMessage[],
    answer: string,
    target: { model: string; protocol: ChatProtocolId }
  ) => {
    const conv = chatConversationsRef.current.find(c => c.id === convId);
    if (!conv || conv.title || !activeKey) return;
    void generateTitle(conv.id, [...history, { role: 'assistant', content: answer }], target);
  };

  /** Manual "regenerate from summary": the whole stored transcript, even for a
   *  conversation that is not the active one. A title is always deliberate
   *  here, so a failure is reported instead of silently keeping the old row. */
  const retitleConversation = async (conv: PgChatConversation) => {
    if (titleBusyId) return;
    if (!activeKey) {
      toast.error(t('chat.noKey'));
      return;
    }
    const messages: WireMessage[] = conv.turns
      .filter(turn => !turn.error && !turn.pending && turn.content)
      .map(turn => ({ role: turn.role, content: turn.content }));
    if (messages.length === 0) return;
    const ok = await generateTitle(conv.id, messages, {
      model: conv.model,
      protocol: asChatProtocolId(conv.protocol),
    });
    if (!ok) toast.error(t('chat.titleGenFailed'));
  };

  /** Commit the rename editor. Empty input is a no-op, not a wipe. */
  const commitRename = () => {
    if (!renameDraft) return;
    const title = renameDraft.title.trim().slice(0, PG_TITLE_LEN);
    if (title) applyTitle(renameDraft.id, title);
    setRenameDraft(null);
  };

  /** Stage browser-picked images (file dialog, paste, drop). Size and count are
   *  bounded HERE, before the operator can hit Send on a request that would be
   *  refused upstream; a rejected file never partially mutates the list. */
  const addImages = async (files: ArrayLike<File>) => {
    const picked = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (picked.length === 0) return;
    let count = pendingImages.length;
    for (const file of picked) {
      if (file.size > PG_IMAGE_MAX_BYTES) {
        toast.error(t('chat.imageTooLarge', { size: formatBytes(PG_IMAGE_MAX_BYTES) }));
        continue;
      }
      if (count >= PG_MAX_IMAGES) {
        toast.error(t('chat.imageTooMany', { n: PG_MAX_IMAGES }));
        break;
      }
      try {
        const img = await readImageFile(file);
        count += 1;
        setPendingImages(prev => (prev.length >= PG_MAX_IMAGES ? prev : [...prev, img]));
      } catch {
        toast.error(t('chat.imageUnreadable'));
      }
    }
  };

  /** Remote https? URLs stay `{ kind: 'url' }` (small, portable). A pasted
   *  `data:image/…;base64,…` is INLINE BYTES and must be stored as base64 —
   *  Anthropic rejects `source: { type: 'url', url: 'data:…' }`. */
  const addImageUrl = () => {
    const parsed = parseWireImageInput(imageUrl);
    if (!parsed) {
      toast.error(t('chat.imageUrlInvalid'));
      return;
    }
    if (pendingImages.length >= PG_MAX_IMAGES) {
      toast.error(t('chat.imageTooMany', { n: PG_MAX_IMAGES }));
      return;
    }
    setPendingImages(prev => [...prev, parsed]);
    setImageUrl('');
    setImageUrlOpen(false);
  };

  /** The selected surface's adapter — the page never spells a wire field itself. */
  const wire = CHAT_PROTOCOL_BY_ID[protocol];

  /** Checked tools, as wire definitions. Order follows the panel, so the emitted
   *  array is stable across rounds (a reordered tool list would invalidate the
   *  upstream's prompt cache on every turn). */
  const toolDefs = useMemo<WireToolDef[]>(
    () =>
      PLAYGROUND_TOOLS.filter((tool) => selectedTools.includes(tool.name)).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as unknown as Record<string, unknown>,
      })),
    [selectedTools]
  );

  /** Request parameters, re-spelled per wire by the adapter (chat
   *  `reasoning_effort` / `max_tokens` + `stream_options`, anthropic
   *  `output_config.effort` + top-level `system`, responses `reasoning.effort` +
   *  `instructions` + `max_output_tokens`). */
  const wireParams = (): WireParams => ({
    model: model.trim() || 'auto',
    stream,
    ...(temperature.trim() !== '' && Number.isFinite(Number(temperature))
      ? { temperature: Number(temperature) }
      : {}),
    ...(maxTokens.trim() !== '' && Number.isInteger(Number(maxTokens)) ? { maxTokens: Number(maxTokens) } : {}),
    ...(effort ? { effort } : {}),
    // Defined tools are re-spelled per wire by the adapter (chat
    // `tools[].function`, anthropic `tools[].input_schema`, responses flat
    // `tools[].{type,name,parameters}`), so the page hands over ONE shape.
    ...(toolDefs.length > 0 ? { tools: toolDefs, toolChoice, parallelTools } : {}),
  });

  /** ONE body builder for the send path AND the cURL preview: the sample the
   *  operator copies must be the request that is actually sent. */
  const buildRequestBody = (messages: WireMessage[], system: string) =>
    wire.buildBody(messages, system, wireParams());

  /** Wire history for the CURRENT turns. Pure builder lives in
   *  playground-protocols (`wireHistoryFromTurns`) so Anthropic/Responses
   *  never see orphan tool_use; unanswered calls are stripped there. */
  const buildHistory = (extra: WireMessage | undefined, source: ChatTurn[] = turns): WireMessage[] =>
    wireHistoryFromTurns(source, extra);

  /** One HTTP round. Patches the assistant turn as frames arrive and returns
   *  what the next round needs: the answer text (the following assistant turn
   *  must repeat it beside its calls) and the calls themselves. `null` means the
   *  round failed and the turn already carries the error. */
  const runRound = async (
    messages: WireMessage[],
    assistantId: number,
    controller: AbortController
  ): Promise<{ content: string; calls: WireToolCall[] } | null> => {
    const isCurrent = () => abortRef.current === controller;
    const body = buildRequestBody(messages, systemPrompt.trim());
    try {
      const res = await fetch(wire.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${activeKey}`, 'x-session-id': playgroundSessionId },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!isCurrent()) return null;
      const facts = readFacts((n) => res.headers.get(n) ?? undefined, res.status);

      if (!res.ok) {
        const raw = await res.text();
        if (!isCurrent()) return null;
        patchTurn(assistantId, { pending: false, status: res.status, facts, error: `HTTP ${res.status}\n${raw}` });
        return null;
      }

      if (!stream || !res.body) {
        const json: unknown = await res.json();
        if (!isCurrent()) return null;
        const answer = wire.decodeJson(json);
        // No text rescue here on purpose: repairing an upstream's leaked
        // tool-call markup is the upstream's job (ADR-0034), the gateway only
        // REPORTS it (`X-OCR-Tool-Markup-Leak`), and a parser in this page
        // would be a third dialect guess on top of the two that already failed.
        const rescued = { content: answer.content, calls: answer.toolCalls ?? [] };
        patchTurn(assistantId, {
          pending: false,
          content: rescued.content,
          reasoning: answer.reasoning,
          usage: answer.usage,
          facts,
          ...(rescued.calls.length ? { toolCalls: rescued.calls } : {}),
          responseJson: json,
        });
        return { content: rescued.content, calls: rescued.calls };
      }

      // Streaming: forward each `data:` frame into the bubble and fold the
      // trailing `: ocr-summary` comment into the same facts block.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // Tool arguments arrive as STRING FRAGMENTS in a wire-specific container
      // (chat `delta.tool_calls[].function.arguments`, anthropic
      // `input_json_delta.partial_json`, responses
      // `response.function_call_arguments.delta`), so assembly is stateful and
      // belongs to the adapter, not to the fold loop.
      const toolStream = wire.createToolStream();
      let buffer = '';
      let content = '';
      let reasoning = '';
      let usage: TurnUsage | undefined;
      let failure: string | undefined;
      let summary: Record<string, string> = {};

      const handleFrame = (frame: string) => {
        if (!isCurrent()) return;
        for (const rawLine of frame.split('\n')) {
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
          if (line.startsWith(': ocr-summary ')) {
            try {
              summary = JSON.parse(line.slice(': ocr-summary '.length)) as Record<string, string>;
            } catch {
              /* a malformed comment frame is not worth failing the turn */
            }
            continue;
          }
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload) as Record<string, unknown>;
            // The adapter owns the frame vocabulary: chat `choices[].delta`,
            // anthropic `content_block_delta` + `message_delta`, responses
            // `output_text.delta` / `reasoning_text.delta` / `response.completed`.
            const frame = wire.decodeFrame(parsed);
            if (frame?.text) content += frame.text;
            if (frame?.reasoning) reasoning += frame.reasoning;
            if (frame?.usage) usage = mergeUsage(usage, frame.usage);
            if (frame?.error) failure = frame.error;
            toolStream.push(parsed);
          } catch {
            /* partial/non-JSON frame — SSE parsers ignore it too */
          }
        }
        const calls = toolStream.calls();
        patchTurn(assistantId, {
          content,
          reasoning: reasoning || undefined,
          usage,
          ...(calls.length > 0 ? { toolCalls: calls } : {}),
          facts: mergeFacts(facts, readFacts((n) => summary[n], res.status)),
        });
      };

      for (; ;) {
        const { value, done } = await reader.read();
        if (!isCurrent()) return null;
        if (done) break;
        // Normalize CRLF on the concatenated buffer so a `\r\n\r\n` frame
        // boundary split across chunks (`...\r\n\r` + `\n`) stays intact.
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        let idx = buffer.indexOf('\n\n');
        while (idx >= 0) {
          handleFrame(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf('\n\n');
        }
      }
      buffer = (buffer + decoder.decode()).replace(/\r\n/g, '\n');
      if (buffer.trim()) handleFrame(buffer);
      if (!isCurrent()) return null;

      // Same rescue on the streaming leg: the fragments are assembled first, so
      // a markup block split across frames is whole by the time we look at it.
      const streamed = toolStream.calls();
      const rescued = { content, calls: streamed };
      patchTurn(assistantId, {
        pending: false,
        content: rescued.content,
        reasoning: reasoning || undefined,
        usage,
        ...(rescued.calls.length > 0 ? { toolCalls: rescued.calls } : {}),
        ...(failure ? { error: failure } : {}),
        facts: mergeFacts(facts, readFacts((n) => summary[n], res.status)),
        responseJson: {
          streamed: true,
          protocol,
          content: rescued.content,
          reasoning: reasoning || undefined,
          usage,
          toolCalls: rescued.calls,
          summary,
        },
      });
      if (failure) return null;
      return { content: rescued.content, calls: rescued.calls };
    } catch (err) {
      if (!isCurrent()) return null;
      const aborted = (err as Error)?.name === 'AbortError';
      patchTurn(assistantId, {
        pending: false,
        error: aborted ? t('chat.aborted') : String((err as Error)?.message ?? err),
      });
      return null;
    }
  };

  /** Runs rounds until the model stops asking for tools. `history` grows in
   *  place, so the caller keeps whatever the last round actually sent. */
  const runTurns = async (
    history: WireMessage[],
    controller: AbortController
  ): Promise<{ content: string; calls: WireToolCall[] } | null> => {
    let last: { content: string; calls: WireToolCall[] } | null = null;
    for (let round = 0; ; round += 1) {
      if (abortRef.current !== controller) return null;
      const assistantId = nextIdRef.current++;
      const body = buildRequestBody(history, systemPrompt.trim());
      setTurns((prev) => [
        ...prev,
        // The drawer shows the body that was ACTUALLY sent, minus the base64
        // blobs: a megabyte string in a JSON viewer is unreadable.
        { id: assistantId, role: 'assistant', content: '', pending: true, requestJson: elideDataUrls(body), protocol },
      ]);
      const outcome = await runRound(history, assistantId, controller);
      // A failed or superseded round ends the loop: there is nothing to hand back.
      if (!outcome || abortRef.current !== controller) return null;
      last = outcome;
      if (outcome.calls.length === 0) return last;
      if (!autoRunTools || round >= PG_MAX_TOOL_ROUNDS) return last;

      const results: WireToolResult[] = outcome.calls.map((call) => ({
        id: call.id,
        name: call.name,
        content: runPlaygroundTool(call.name, call.arguments),
      }));
      patchTurn(assistantId, { toolResults: results });
      // The next round must see BOTH the calls and their outcomes, in the
      // order the wire expects — that round-trip is the thing under test.
      history.push({ role: 'assistant', content: outcome.content, toolCalls: outcome.calls });
      history.push({ role: 'user', content: '', toolResults: results });
    }
  };

  const send = async () => {
    const text = draft.trim();
    const images = pendingImages;
    // An image-only turn is a legal request on every wire — the guard is "nothing
    // to say", not "no text".
    if ((!text && images.length === 0) || busy) return;
    if (!activeKey) {
      toast.error(t('chat.noKey'));
      return;
    }
    if (decisionWire) {
      toast.error(t('chat.decisionBlocked'));
      return;
    }
    // Anthropic/Responses reject a user turn after bare tool_use / function_call.
    if (hasUnansweredToolCalls(turns)) {
      toast.error(t('chat.toolPendingBlock'));
      return;
    }

    const history = buildHistory({ role: 'user', content: text, ...(images.length > 0 ? { images } : {}) });
    const userId = nextIdRef.current++;
    setTurns((prev) => [...prev, { id: userId, role: 'user', content: text, ...(images.length > 0 ? { images } : {}) }]);
    setDraft('');
    setPendingImages([]);
    setBusy(true);

    const convId = activeChatId;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const outcome = await runTurns(history, controller);
      // The exchange is committed: name the conversation once, from what the
      // model actually answered. A failed round returns null and leaves the
      // row to the pre-answer fallback.
      if (outcome) autoTitle(convId, history, outcome.content, { model, protocol });
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  };

  /** Re-send the last user turn: everything after it is dropped and the loop
   *  runs again. This is the only way out of a poisoned history — a reply that
   *  came back 200 with unparsed tool markup is stored and resent on every
   *  following request, so simply typing another message feeds the garbage
   *  back to the model and it keeps apologising instead of answering. */
  const regenerate = async () => {
    if (busy) return;
    const lastUser = turns.map((turn) => turn.role).lastIndexOf('user');
    if (lastUser < 0) return;
    if (!activeKey) {
      toast.error(t('chat.noKey'));
      return;
    }
    if (decisionWire) {
      toast.error(t('chat.decisionBlocked'));
      return;
    }
    // Regenerate drops the assistant reply (and any unanswered tools with it)
    // by slicing to the last user turn — no pending-tool guard needed here.
    const kept = turns.slice(0, lastUser + 1);
    setTurns(kept);
    setBusy(true);
    const convId = activeChatId;
    const controller = new AbortController();
    abortRef.current = controller;
    const history = buildHistory(undefined, kept);
    try {
      const outcome = await runTurns(history, controller);
      if (outcome) autoTitle(convId, history, outcome.content, { model, protocol });
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  };

  const stop = () => abortRef.current?.abort();

  const clearAll = async () => {
    if (turns.length === 0) return;
    const ok = await confirmDialog({ title: t('chat.clear'), description: t('chat.clearConfirm'), danger: true });
    if (!ok) return;
    newChatConversation();
  };

  /** Escape characters that have special meaning inside POSIX double quotes. */
  const escapeDoubleQuoted = (value: string) => value.replace(/[\\"$`]/g, '\\$&');

  const copyCurl = async () => {
    const lastUser = [...turns].reverse().find((x) => x.role === 'user');
    const messages: WireMessage[] = [
      {
        role: 'user',
        content: lastUser?.content || t('chat.curlPlaceholder'),
        ...(lastUser?.images?.length ? { images: lastUser.images } : {}),
      },
    ];
    // The preview elides attachment bytes for the same reason the drawer does;
    // a copied sample with a 3 MB data URL in it is not pasteable anyway.
    const body = JSON.stringify(elideDataUrls(buildRequestBody(messages, systemPrompt.trim()))).replace(/'/g, "'\\''");
    const curl = `curl -sS ${window.location.origin}${wire.path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${activeKey ? escapeDoubleQuoted(activeKey) : '<API_KEY>'}" \\
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
    const body = JSON.stringify(built.body).replace(/'/g, "'\\''");
    const curl = `curl -sS ${window.location.origin}/v1/systemone \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${activeKey ? escapeDoubleQuoted(activeKey) : '<API_KEY>'}" \\
  -H "x-session-id: ${playgroundSessionId}" \\
  -d '${body}'`;
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
    const controller = new AbortController();
    decisionAbortRef.current = controller;
    const isCurrent = () => decisionAbortRef.current === controller;
    try {
      const res = await fetch('/v1/systemone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${activeKey}`, 'x-session-id': playgroundSessionId },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      const facts = readFacts((n) => res.headers.get(n) ?? undefined, res.status);
      const upstream = res.headers.get(HDR_SYSTEMONE_UPSTREAM) ?? undefined;
      const text = await res.text();
      if (!isCurrent()) return;
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
      if (!isCurrent()) return;
      // An operator stop is a normal outcome, not a transport failure: say so
      // instead of surfacing the raw AbortError.
      const aborted = (err as Error)?.name === 'AbortError';
      setDecisionError(aborted ? t('chat.aborted') : String((err as Error)?.message ?? err));
    } finally {
      if (decisionAbortRef.current === controller) {
        decisionAbortRef.current = null;
        setDecisionBusy(false);
      }
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

  const sendDisabled =
    busy || (!draft.trim() && pendingImages.length === 0) || !activeKey || decisionWire;

  /** Shared chat-conversation list body — rendered by the history Dialog. Rows
   *  are recency-ordered: `updatedAt` is written by the turns effect, the
   *  summarizer and manual renames, so it tracks the LAST activity, and the
   *  list answers "what was I just working on" with the newest first. */
  const chatHistoryRows = [...chatConversations].sort((a, b) => b.updatedAt - a.updatedAt);
  const chatHistoryList = (
    <>
      {chatHistoryRows.length === 0 && (
        <div style={{ padding: '8px 12px', fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>
          {t('chat.historyEmpty')}
        </div>
      )}
      {chatHistoryRows.map(c => {
        const last = new Date(c.updatedAt);
        return (
          <div
            key={c.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
              cursor: 'pointer', fontSize: 'var(--text-sm)',
              background: c.id === activeChatId ? 'var(--accent-bg, rgba(99,102,241,0.08))' : undefined,
            }}
            onClick={() => { switchChatConversation(c.id); setChatHistoryOpen(false); }}
          >
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.title || chatTitle(c.turns, t('chat.imageAlt')) || t('chat.historyUntitled')}
            </span>
            {/* LAST-activity stamp — the visible form of the sort key. Full
              timestamp on hover. */}
            <span
              style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', flexShrink: 0, fontFamily: FONT_MONO }}
              title={last.toLocaleString()}
            >
              {last.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </span>
            {/* action buttons follow the stamp; each stopPropagation so a
              mis-click never switches the conversation */}
            <button
              className="btn btn-sm"
              style={{ padding: '2px 4px' }}
              title={t('chat.historyRetitle')}
              aria-label={t('chat.historyRetitle')}
              disabled={!!titleBusyId || !activeKey || c.turns.length === 0}
              onClick={(e) => { e.stopPropagation(); void retitleConversation(c); }}
            >
              {titleBusyId === c.id
                ? <Loader2 size={11} style={{ animation: 'ocr-spin 0.8s linear infinite' }} />
                : <Sparkles size={11} />}
            </button>
            <button
              className="btn btn-sm"
              style={{ padding: '2px 4px' }}
              title={t('chat.historyRename')}
              aria-label={t('chat.historyRename')}
              onClick={(e) => {
                e.stopPropagation();
                setRenameDraft({ id: c.id, title: c.title || chatTitle(c.turns, t('chat.imageAlt')) });
              }}
            >
              <Pencil size={11} />
            </button>
            <button
              className="btn btn-sm"
              style={{ padding: '2px 4px' }}
              title={t('chat.historyDelete')}
              onClick={(e) => { e.stopPropagation(); deleteChatConversation(c.id); }}
            >
              <Trash2 size={11} />
            </button>
          </div>
        );
      })}
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
      {/* Page-level tabs (top of the page, above both cards): TWO views, not
          four. `chat` vs `decision` is a STRUCTURE choice — a multi-turn
          conversation panel or a single-shot question/answer panel — while the
          wire a conversation speaks is a property OF that conversation, so the
          protocol control lives inside the chat card (right above the path it
          selects). Sits OUTSIDE the scroll region below, so it never scrolls
          away. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, width: '100%', maxWidth: chatMaxWidth, margin: '0 auto' }}>
        <SegGroup
          value={mode}
          onChange={(v) => setMode(v as 'chat' | 'decision')}
          size="lg"
          options={[
            { value: 'chat', label: t('chat.tabChat') },
            { value: 'decision', label: t('decision.tabDecision') },
          ]}
        />
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
        <div className="card" style={{ flexShrink: 0, width: '100%', maxWidth: chatMaxWidth, margin: '0 auto' }}>
          <div className="card-header">
            <div className="card-title">
              <MessagesSquare size={18} color="var(--accent)" />
              <span>{mode === 'chat' ? t('chat.title') : t('decision.title')}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {mode === 'chat' ? (
                <>
                  {/* Setup collapse: the key/model/stream row is set once and then
                    only eats transcript height. The chevron is the header's
                    entry point; the collapsed summary row is the second one. */}
                  <button
                    className="btn btn-sm"
                    onClick={toggleSetup}
                    title={t(setupOpen ? 'chat.setupCollapse' : 'chat.setupExpand')}
                    aria-label={t(setupOpen ? 'chat.setupCollapse' : 'chat.setupExpand')}
                    aria-expanded={setupOpen}
                    style={{ padding: '4px 6px' }}
                  >
                    {setupOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>
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

          {/* Which wire THIS conversation speaks — the one axis that differs between
            the three chat-shaped surfaces, so it lives beside the path it
            determines rather than as a peer of the page tabs. Per conversation,
            not per page: the value is stored with the conversation, so comparing
            one prompt across wires is a switch, not a retype. No label: each option
            names its own endpoint and the mono chip spells out exactly what the
            request will hit, so a "Protocol" caption would only restate them. */}
          {/* Vertical rhythm: the card header already owns a 12px bottom margin,
            so this row adds the SAME 12px below itself and none above — without
            the explicit bottom margin the next control row sits flush against
            it and the row looks pushed up against the header. */}
          {mode === 'chat' &&
            (setupOpen ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 0, marginBottom: 12 }}>
                <SegGroup
                  value={protocol}
                  onChange={(v) => setProtocol(asChatProtocolId(v))}
                  size="sm"
                  options={CHAT_PROTOCOLS.map((p) => ({ value: p.id, label: p.id }))}
                />
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontFamily: FONT_MONO }}>
                  POST {wire.path}
                </span>
              </div>
            ) : (
              // Collapsed: ONE line that still answers "what will this request be?"
              // — surface, endpoint, key, model. The whole row is the expand
              // affordance (same gesture as the header chevron).
              <button
                type="button"
                onClick={toggleSetup}
                title={t('chat.setupExpand')}
                style={{
                  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
                  width: '100%', marginBottom: 4, padding: '2px 0',
                  background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
                  fontSize: 'var(--text-xs)', color: 'var(--text-dim)',
                }}
              >
                <span style={{ fontFamily: FONT_MONO, color: 'var(--text-main)' }}>POST {wire.path}</span>
                <span>·</span>
                <span>{t('chat.keyLabel')}: {keySource === 'manual' ? t('chat.keyManual') : keyOptions.find((o) => o.value === keyId)?.label ?? t('chat.keyPlaceholder')}</span>
                <span>·</span>
                <span>
                  {t('chat.modelLabel')}: <span style={{ fontFamily: FONT_MONO }}>{model.trim() || 'auto'}</span>
                </span>
                <ChevronDown size={13} style={{ marginLeft: 'auto' }} />
              </button>
            ))}

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


          {/* Collapsed chat setup hides this row entirely; the decision tab has no
            collapse (its controls are always visible). */}
          {(mode !== 'chat' || setupOpen) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 260, flex: '1 1 260px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <label style={labelStyle}>{t('chat.keyLabel')}</label>
                  {/* Same convention as the model column: tips live in the LABEL ROW,
                  never as a standalone line under the field — a hint line grows
                  this column and pushes the model/stream columns out of line.
                  An empty key list is a STATE (warning tip), not help text. */}
                  {keySource === 'configured' && keys.length === 0 && (
                    <InfoTip variant="warning" text={t('chat.keyEmpty')} />
                  )}
                </div>
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
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 230, flex: '1 1 230px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <label style={labelStyle}>{t('chat.modelLabel')}</label>
                  {/* Tips live in the LABEL ROW, never as a standalone line under the
                  picker — a separate hint line grows this column and pushes the
                  stream-toggle column out of line. A decision-wire model is a
                  STATE (danger tip), a failed model-list load is a STATE (warning
                  tip), a translated non-openai wire is context (info tip); the
                  three are mutually exclusive, danger → warning → info. */}
                  {mode === 'chat' &&
                    (decisionWire ? (
                      <InfoTip variant="danger" text={t('chat.decisionBlocked')} />
                    ) : modelsFailed ? (
                      <InfoTip variant="warning" text={t('chat.modelsLoadFailed')} />
                    ) : (
                      selectedWire &&
                      selectedWire !== 'openai-chat' && <InfoTip variant="info" text={t('chat.wireHint', { wire: selectedWire })} />
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
                      badge: wire && wire !== 'openai-chat' ? (wire === 'systemone' ? t('chat.wireSystemone') : wire) : undefined,
                      badgeColor: wire === 'systemone' ? 'var(--accent-rose)' : undefined,
                    };
                  })}
                  placeholder={t('chat.modelPlaceholder')}
                  panelMinWidth={320}
                  style={{ width: '100%' }}
                />
              </div>

              {mode === 'chat' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 150 }}>
                  <label style={labelStyle}>{t('chat.streamLabel')}</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 34 }}>
                    <Switch checked={stream} onChange={setStream} />
                    {/* One entry point: params and tools are both "this
                    conversation's request shape", and a drawer keeps the
                    transcript from losing a third of its height. */}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setSettingsOpen(true)}
                      aria-expanded={settingsOpen}
                      title={t('chat.settingsTip')}
                    >
                      <SlidersHorizontal size={13} />
                      <span>{t('chat.settingsLabel')}</span>
                      {toolDefs.length > 0 && <span className="badge">{toolDefs.length}</span>}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {mode === 'chat' && settingsOpen && (
            <Drawer
              title={t('chat.settingsLabel')}
              onClose={() => setSettingsOpen(false)}
              closeLabel={t('common.close')}
              width="min(560px, 94vw)"
            >
              {/* Three numeric fields share one row; the system prompt spans the
                width; the tool grid reads as a grid. Every section that changes
                the request carries its own explanation. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={settingsSectionStyle}>{t('chat.paramsLabel')}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 14 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      <label style={labelStyle}>{t('chat.temperatureLabel')}</label>
                      <input
                        className="input"
                        value={temperature}
                        onChange={(e) => setTemperature(e.target.value)}
                        placeholder="0.7"
                        style={{ fontSize: 'var(--text-sm)', fontFamily: FONT_MONO }}
                      />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {/* The field name IS the label: it is the SELECTED wire's
                        spelling (`max_tokens` / `max_output_tokens`). */}
                      <label style={{ ...labelStyle, fontFamily: FONT_MONO }}>{wire.tokenCapField}</label>
                      <input
                        className="input"
                        value={maxTokens}
                        onChange={(e) => setMaxTokens(e.target.value)}
                        placeholder="1024"
                        style={{ fontSize: 'var(--text-sm)', fontFamily: FONT_MONO }}
                      />
                    </div>
                    {availableEfforts.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
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
                        />
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <label style={labelStyle}>{t('chat.systemLabel')}</label>
                      {/* The field owns the row; its helpers trail it. */}
                      <Combobox
                        value=""
                        onChange={(id) => {
                          const p = promptPresets.find((x) => x.id === id);
                          if (p) setSystemPrompt(p.content);
                        }}
                        options={promptPresets.map((p) => ({ value: p.id, label: p.name }))}
                        placeholder={t('chat.promptPresetLabel')}
                        disabled={promptPresets.length === 0}
                        style={{ width: 170, marginLeft: 'auto' }}
                      />
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setPresetDraftName('');
                          setPresetDialogOpen(true);
                        }}
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
                      rows={3}
                      style={{ fontSize: 'var(--text-sm)', resize: 'vertical', lineHeight: 'var(--leading-snug)' }}
                    />
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 14,
                    paddingTop: 18,
                    borderTop: '1px solid var(--card-border)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={settingsSectionStyle}>{t('chat.toolsLabel')}</div>
                    {/* The full reasoning is read once, so it lives behind the
                      icon; the drawer keeps one short line for the claim. */}
                    <InfoTip text={t('chat.toolSandboxHintTip')} />
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={selectedTools.length === ALL_TOOL_NAMES.length}
                        onClick={() => setSelectedTools([...ALL_TOOL_NAMES])}
                      >
                        {t('chat.toolSelectAll')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={selectedTools.length === 0}
                        onClick={() => setSelectedTools([])}
                      >
                        {t('chat.toolClearAll')}
                      </button>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px 14px' }}>
                    {PLAYGROUND_TOOLS.map((tool) => (
                      <label
                        key={tool.name}
                        title={tool.description}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 'var(--text-sm)',
                          fontFamily: FONT_MONO,
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedTools.includes(tool.name)}
                          onChange={(e) =>
                            setSelectedTools((prev) =>
                              e.target.checked ? [...prev, tool.name] : prev.filter((n) => n !== tool.name)
                            )
                          }
                          style={{ accentColor: 'var(--accent)' }}
                        />
                        <span>{tool.name}</span>
                      </label>
                    ))}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 18px', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {/* The field name IS the label — `tool_choice` is wire
                        vocabulary, not product copy. */}
                      <span style={{ ...labelStyle, fontFamily: FONT_MONO }}>{t('chat.toolChoiceLabel')}</span>
                      <SegGroup
                        value={toolChoice}
                        onChange={(v) => setToolChoice(v as WireToolChoice)}
                        size="sm"
                        options={[
                          { value: 'auto', label: t('chat.toolChoiceAuto') },
                          { value: 'required', label: t('chat.toolChoiceRequired') },
                          { value: 'none', label: t('chat.toolChoiceNone') },
                        ]}
                      />
                    </div>
                    <label
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--text-sm)', cursor: 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={parallelTools}
                        onChange={(e) => setParallelTools(e.target.checked)}
                        style={{ accentColor: 'var(--accent)' }}
                      />
                      <span style={{ fontFamily: FONT_MONO }}>parallel_tool_calls</span>
                    </label>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 18px', alignItems: 'center' }}>
                    <label
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--text-sm)', cursor: 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={autoRunTools}
                        onChange={(e) => setAutoRunTools(e.target.checked)}
                        style={{ accentColor: 'var(--accent)' }}
                      />
                      <span>{t('chat.toolAutoRun')}</span>
                    </label>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ marginLeft: 'auto' }}
                      onClick={() => {
                        resetSandbox();
                        // A reset that looks like a no-op is worse than none: the tree is
                        // invisible until a tool reads it, so confirm it happened.
                        toast.success(t('chat.toolSandboxResetDone'));
                      }}
                    >
                      {t('chat.toolSandboxReset')}
                    </button>
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('chat.toolSandboxHint')}</div>
                  {/* An empty selection is a REAL state of the request (no `tools`
                    field at all), not a neutral one — say so instead of letting
                    the panel look armed while every reply comes back plain. */}
                  {selectedTools.length === 0 && (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-rose)' }}>
                      {t('chat.toolNoneHint')}
                    </div>
                  )}
                </div>
              </div>
            </Drawer>
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
                {decisionBusy ? (
                  // Same contract as the chat composer: while the wire is
                  // waiting the action becomes a stop, so a hung upstream is
                  // never a locked form.
                  <button className="btn btn-danger" onClick={() => decisionAbortRef.current?.abort()}>
                    <Square size={13} />
                    <span>{t('chat.stop')}</span>
                  </button>
                ) : (
                  <button
                    className="btn btn-primary"
                    onClick={() => void sendDecision()}
                    disabled={!activeKey}
                  >
                    <Send size={13} />
                    <span>{t('decision.send')}</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Fullscreen: a scrim behind the card in BOTH width modes. Narrow needs
          it to separate the centered column from the page; wide keeps it so
          toggling wide/narrow never changes the modality of the mode (and the
          rim the 1600px cap leaves visible stays dimmed). Click = exit. */}
        {mode === 'chat' && chatExpanded && (
          <div
            aria-hidden
            onClick={() => setChatExpanded(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 59,
              background: 'color-mix(in srgb, var(--scrim) 80%, transparent)',
            }}
          />
        )}

        {mode === 'chat' ? (
          <div
            className="card"
            style={chatExpanded ? {
              // Expanded chat: a fixed overlay covering the viewport, so the
              // transcript gets the whole screen — but it still honors the
              // wide/narrow preference: `inset: 0` pins both sides, a capped
              // `maxWidth` + `margin: 0 auto` keeps the narrow column centered
              // instead of stretching line lengths across a 27" monitor. Esc
              // (or the header toggle) restores the in-page card.
              position: 'fixed',
              inset: 0,
              zIndex: 60,
              // No radius in either mode: a fullscreen sheet has no business
              // wearing rounded corners; the border + shadow carry the edge.
              borderRadius: 0,
              border: chatWide ? 'none' : '1px solid var(--card-border)',
              boxShadow: chatWide ? undefined : '0 20px 40px rgba(0,0,0,0.35)',
              background: 'var(--bg)',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              maxWidth: chatMaxWidth,
              margin: '0 auto',
            } : {
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              flex: 1,
              minHeight: 260,
              // The card ITSELF is the reading surface: wide by default, an
              // optional centered 900px column on demand; expanded keeps the
              // same preference (see the fixed-overlay branch above).
              width: '100%',
              maxWidth: chatMaxWidth,
              margin: '0 auto',
              // This card is a TOOLBAR + transcript, not a text card: the
              // global 22px inset above the chrome reads as dead space between
              // the params card and the actions row. The sides and bottom keep
              // the standard inset.
              paddingTop: 10,
            }}
            // Drop-to-attach: the whole card is the target, so a picture dragged
            // from the desktop lands wherever the pointer already is.
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void addImages(e.dataTransfer.files);
            }}
          >
            {/* Card header: left = chat identity, right = conversation actions.
              Same row in normal and expanded mode — in expanded mode it is the
              only chrome, so it must never duplicate. */}
            {/* The hairline separates chrome from the transcript: without it the
              first bubble sat flush against the actions row. Inset by the
              card's own padding, like every other intra-card divider. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, paddingBottom: 10, borderBottom: '1px solid var(--divider)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-sm)', color: 'var(--text-dim)', minWidth: 0 }}>
                <MessagesSquare size={16} color="var(--accent)" />
                {/* The chat card's own header names the CONVERSATION — the
                  summary title, else the first prompt, else the section label.
                  In expanded mode this row is the only chrome on screen. */}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {activeChat?.title || chatTitle(turns, t('chat.imageAlt')) || t('chat.cardTitle')}
                </span>
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
              {/* Fullscreen hides the page chrome, so the wide/narrow toggle —
                which decides THIS card's width — must ride along. In-page, the
                chrome button already serves it; no duplicate. */}
              {chatExpanded && (
                <button
                  className="btn btn-sm"
                  onClick={toggleChatWide}
                  title={t(chatWide ? 'chat.narrow' : 'chat.wide')}
                  aria-label={t(chatWide ? 'chat.narrow' : 'chat.wide')}
                  style={{ padding: '4px 6px' }}
                >
                  {chatWide ? <Shrink size={14} /> : <Expand size={14} />}
                </button>
              )}
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
            {/* History opens a MODAL, not an inline dropdown: the list can grow to
              PG_MAX_CONVERSATIONS rows, and an in-card sheet squeezed the
              transcript. Bounded both ways: 460px wide, the list body scrolls
              past ~10 rows (50vh) instead of stretching the dialog. */}
            {chatHistoryOpen && (
              <Dialog
                title={t('chat.historyTitle')}
                onClose={() => setChatHistoryOpen(false)}
                closeLabel={t('common.close')}
                width={560}
              >
                {/* Inside the dialog's own padding — no negative margins: they
                  made rows bleed past the card edge and clip their titles. */}
                <div style={{ maxHeight: '50vh', overflowY: 'auto', margin: '0 -4px' }}>
                  {chatHistoryList}
                </div>
              </Dialog>
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
                padding: '10px 4px 0 0',
              }}
            >
              {turns.length === 0 ? (
                <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-loose)', paddingTop: 120 }}>
                  <div style={{ fontSize: 'var(--text-md)', color: 'var(--text-main)', marginBottom: 4 }}>{t('chat.emptyTitle')}</div>
                  <div>{t('chat.emptyHint')}</div>
                </div>
              ) : (
                turns.map((turn, i) => (
                  <TurnBubble
                    key={turn.id}
                    turn={turn}
                    onRegenerate={
                      turn.role === 'assistant' && i === turns.length - 1 && !busy ? regenerate : undefined
                    }
                    // Fork is offered on EVERY turn (that is the point: branch
                    // between any two messages), revert only where something
                    // actually follows — on the last turn it would be a no-op.
                    onFork={busy ? undefined : () => forkChatConversation(i)}
                    onRevert={busy || i === turns.length - 1 ? undefined : () => revertChatConversation(i)}
                  />
                ))
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--card-border)', paddingTop: 12, flexShrink: 0 }}>
              {/* Attachment toolbar: every chat box keeps its attach controls and
                the staged attachments on one row ABOVE the input, so the input
                itself stays a clean writing surface and nothing sits next to
                the caret. */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <button
                  className="btn btn-ghost"
                  title={t('chat.attachImage')}
                  onClick={() => imageInputRef.current?.click()}
                  style={{ width: 30, height: 30, minHeight: 0, padding: 0 }}
                >
                  <ImagePlus size={14} />
                </button>
                <button
                  className="btn btn-ghost"
                  title={t('chat.imageUrlToggle')}
                  onClick={() => setImageUrlOpen(v => !v)}
                  style={{ width: 30, height: 30, minHeight: 0, padding: 0, color: imageUrlOpen ? 'var(--accent)' : undefined }}
                >
                  <Link2 size={14} />
                </button>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) void addImages(e.target.files);
                    // Reset so picking the SAME file twice still fires onChange.
                    e.target.value = '';
                  }}
                />
                {pendingImages.map((img, i) => (
                  <div key={i} style={{ position: 'relative', display: 'flex' }}>
                    <img
                      src={wireImageUrl(img)}
                      alt={t('chat.imageAlt')}
                      style={{ width: 52, height: 52, borderRadius: 6, objectFit: 'cover', border: '1px solid var(--card-border)', background: 'var(--well-bg)' }}
                    />
                    <button
                      className="btn btn-ghost"
                      title={t('chat.imageRemove')}
                      onClick={() => setPendingImages(prev => prev.filter((_, j) => j !== i))}
                      style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, minHeight: 0, padding: 0, borderRadius: 9, background: 'var(--surface)', border: '1px solid var(--card-border)' }}
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
                {imageUrlOpen && (
                  <input
                    className="input"
                    autoFocus
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addImageUrl();
                      }
                      if (e.key === 'Escape') setImageUrlOpen(false);
                    }}
                    placeholder={t('chat.imageUrlPlaceholder')}
                    style={{ flex: 1, minWidth: 220, height: 32, fontFamily: FONT_MONO, fontSize: 'var(--text-xs)' }}
                  />
                )}
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                <textarea
                  className="input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onPaste={(e) => {
                    // A copied screenshot arrives as a file, not as text — taking it
                    // from the clipboard is the fastest path to an attachment.
                    const files = Array.from(e.clipboardData.items)
                      .filter(it => it.kind === 'file' && it.type.startsWith('image/'))
                      .map(it => it.getAsFile())
                      .filter((f): f is File => f !== null);
                    if (files.length > 0) {
                      e.preventDefault();
                      void addImages(files);
                    }
                  }}
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
          </div>
        ) : (
          <div
            className="card"
            // Natural height: a long answers payload is never clipped to a
            // viewport-relative box — the page scrolls, not this card.
            style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: chatMaxWidth, margin: '0 auto' }}
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

      {/* Manual rename: the row's title is whatever the summarizer produced,
          so the operator always needs a way to overrule it. */}
      {renameDraft && (
        <Dialog
          title={t('chat.titleDialogTitle')}
          onClose={() => setRenameDraft(null)}
          closeLabel={t('common.close')}
          width={420}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <input
              className="input"
              autoFocus
              value={renameDraft.title}
              maxLength={PG_TITLE_LEN}
              placeholder={t('chat.titlePlaceholder')}
              onChange={(e) => setRenameDraft({ ...renameDraft, title: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn" onClick={() => setRenameDraft(null)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" onClick={commitRename}>{t('common.save')}</button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
};

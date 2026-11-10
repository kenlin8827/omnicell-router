import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultGatewayPort } from '../cli/clients/base.js';
import { loadConfig } from '../config/index.js';
import { INTERNAL_SESSION_PREFIX } from '../session/session-manager.js';
import { renameWithRetry } from '../utils/atomic-write.js';
import { harnessEnvDir } from './host/manifest.js';

/**
 * Description translation cache (ADR-0015 follow-up).
 *
 * Third-party `description` text is CONTENT, not UI copy: it can never live in the i18n tables. It is
 * translated on demand into the console's CURRENT language and cached as DERIVED data — deleting the
 * cache loses nothing, re-translating restores it. Keyed by `sha256(text):lang`, so an upstream edit
 * invalidates the entry by construction (no timestamps, no manual busting).
 *
 * The model call goes through this gateway's own OpenAI-compatible surface on loopback: translation
 * is just another routed request, so tiering/fallback/quotas apply instead of a second LLM client.
 * Only the description string leaves the process — never the skill body.
 */

/** Mirrors the console's UI languages (frontend i18n/languages.ts): the harness
 *  page translates third-party descriptions into the language the console is
 *  currently rendering, so a UI language ships → it becomes a target here in
 *  the same change. */
export type TranslationLang = 'zh' | 'en' | 'es' | 'fr' | 'de' | 'ja' | 'ko' | 'pt';

const SUPPORTED: TranslationLang[] = ['zh', 'en', 'es', 'fr', 'de', 'ja', 'ko', 'pt'];


/**
 * Target languages, labeled in English for the translation prompt (the model
 * reads the label, not the user).
 */
export const LANG_LABEL: Record<TranslationLang, string> = {
  zh: 'Simplified Chinese',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  ja: 'Japanese',
  ko: 'Korean',
  pt: 'Brazilian Portuguese',
};

interface CacheEntry {
  text: string;
  model: string;
  at: string;
  /** LEGACY, never written again: entries produced by the old budgeted translator carry this when
   *  the document's tail stayed in the source language. The cache key is the WHOLE body, so such an
   *  entry must read as a MISS — serving it would claim a full translation the cache never held. */
  truncated?: boolean;
}

/** One directory per KIND of translation. A README body and a one-line description must never share
 *  a store: they have different sizes, different lifetimes and different reasons to be dropped. */
type CacheKind = 'descriptions' | 'readme' | 'segments';

/**
 * The derived translation store: ONE FILE PER ENTRY, not one blob.
 *
 * The single `descriptions.json` this replaces was rewritten IN FULL on every write, so a 20 000-
 * character README made each later description translation carry a whole document; one corrupt byte
 * cost every language; and "drop this one page" meant hand-editing the blob. Entries are therefore
 * page-granular — `<sha256(text)>.<lang>.json` under the kind's directory — each written atomically
 * (temp + rename), so a crash costs at most the entry being written and nothing else.
 */
function entryPath(kind: CacheKind, hash: string, lang: string): string {
  return path.join(harnessEnvDir(), 'i18n', kind, `${hash}.${lang}.json`);
}

function readEntry(kind: CacheKind, hash: string, lang: string): CacheEntry | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(entryPath(kind, hash, lang), 'utf8')) as CacheEntry;
    return parsed && typeof parsed.text === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function writeEntry(kind: CacheKind, hash: string, lang: string, entry: CacheEntry): void {
  const file = entryPath(kind, hash, lang);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(entry), 'utf8');
  renameWithRetry(tmp, file);
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** The pre-split blob (`i18n/descriptions.json`), read at most once per process. */
let legacyBlob: Record<string, CacheEntry> | null | undefined;

/**
 * Read one entry out of the OLD single-file store and promote it on the spot.
 *
 * The cache is derived, so dropping it would be legal — but it is not free: every lost entry is a
 * model call the operator already paid for. Migration is therefore lazy and one-way: the first read
 * of an old entry writes its page-granular file, and the blob is never written again.
 */
function legacyEntry(kind: CacheKind, hash: string, lang: string): CacheEntry | null {
  if (legacyBlob === undefined) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(harnessEnvDir(), 'i18n', 'descriptions.json'), 'utf8')
      ) as { entries?: Record<string, CacheEntry> };
      legacyBlob = parsed?.entries ?? null;
    } catch {
      legacyBlob = null;
    }
  }
  if (!legacyBlob) return null;
  const key = kind === 'readme' ? `md:${hash}:${lang}` : `${hash}:${lang}`;
  const hit = legacyBlob[key];
  if (!hit || typeof hit.text !== 'string') return null;
  writeEntry(kind, hash, lang, hit);
  return hit;
}

/** Newest source of truth first, then the legacy blob. Never calls a model, never writes. */
function lookup(kind: CacheKind, text: string, lang: string): CacheEntry | null {
  const hash = hashText(text);
  return readEntry(kind, hash, lang) ?? legacyEntry(kind, hash, lang);
}

/** Persist one translated entry (the only writer in this module). */
function store(kind: CacheKind, source: string, lang: string, text: string, model: string): void {
  writeEntry(kind, hashText(source), lang, {
    text,
    model,
    at: new Date().toISOString(),
  });
  // Housekeeping rides on the writes: a store nobody writes to needs no sweep.
  maybePrune();
}

export function isSupportedLang(value: string): value is TranslationLang {
  return (SUPPORTED as string[]).includes(value);
}

/* ── housekeeping ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Eviction policy. The store is DERIVED, so dropping an entry costs a model call the next time that
 * page is opened — never correctness. Two rules, in this order:
 *  1. age — nobody opened this page in a quarter, so nobody is paying for its translation;
 *  2. size — the whole store stays under a budget; the OLDEST entries go first.
 * A crashed write leaves `*.tmp.<pid>.<ts>` files behind; those are swept after an hour.
 */
const GC_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const GC_MAX_BYTES = 32 * 1024 * 1024;
/** One sweep per hour per process: the store is read-mostly, and a sweep is a directory walk. */
const GC_THROTTLE_MS = 60 * 60 * 1000;
const TMP_MAX_AGE_MS = 60 * 60 * 1000;

const KINDS: CacheKind[] = ['descriptions', 'readme', 'segments'];

export interface PruneStats {
  removed: number;
  kept: number;
  bytes: number;
}

let lastPruneAt = 0;

interface StoredFile {
  file: string;
  size: number;
  mtimeMs: number;
}

function kindDir(kind: CacheKind): string {
  return path.join(harnessEnvDir(), 'i18n', kind);
}

function remove(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false; // already gone, or a permission the operator owns — never fatal
  }
}

function listStore(): StoredFile[] {
  const out: StoredFile[] = [];
  const now = Date.now();
  for (const kind of KINDS) {
    const dir = kindDir(kind);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue; // a store that was never written to
    }
    for (const name of names) {
      const file = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue; // removed by a concurrent sweep
      }
      if (!stat.isFile()) continue;
      if (!name.endsWith('.json')) {
        // A crash between write and rename leaves a temp file; it is garbage once it is old.
        if (name.includes('.tmp.') && now - stat.mtimeMs > TMP_MAX_AGE_MS) remove(file);
        continue;
      }
      out.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return out;
}

/**
 * The pre-split blob is only a migration SOURCE now — nothing writes it, so its mtime is the last
 * write of the build that still did. Once that is older than the age budget it is exactly as stale
 * as the entries the same policy already drops; leaving it would let it outlive every entry it
 * produced.
 */
function sweepLegacyBlob(maxAgeMs: number, now: number): boolean {
  if (maxAgeMs <= 0) return false;
  const file = path.join(harnessEnvDir(), 'i18n', 'descriptions.json');
  try {
    if (now - fs.statSync(file).mtimeMs <= maxAgeMs) return false;
  } catch {
    return false;
  }
  return remove(file);
}

/**
 * Sweep the derived store: expire by age, then trim by size (oldest first).
 *
 * Synchronous and bounded — it rides on a translation write (at most once an hour) and answers a
 * manual admin call. It never throws: housekeeping that can fail a user's translation is worse than
 * a store that stays too big for one more hour.
 */
export function pruneTranslationStore(opts: { maxAgeMs?: number; maxBytes?: number } = {}): PruneStats {
  const maxAgeMs = opts.maxAgeMs ?? GC_MAX_AGE_MS;
  const maxBytes = opts.maxBytes ?? GC_MAX_BYTES;
  const now = Date.now();
  let removed = 0;
  if (sweepLegacyBlob(maxAgeMs, now)) removed += 1;

  let survivors = listStore().filter((entry) => {
    if (maxAgeMs > 0 && now - entry.mtimeMs > maxAgeMs) {
      if (remove(entry.file)) removed += 1;
      return false;
    }
    return true;
  });

  let bytes = survivors.reduce((sum, entry) => sum + entry.size, 0);
  if (bytes > maxBytes) {
    survivors = [...survivors].sort((a, b) => a.mtimeMs - b.mtimeMs);
    while (bytes > maxBytes && survivors.length > 0) {
      const oldest = survivors.shift()!;
      if (remove(oldest.file)) {
        removed += 1;
        bytes -= oldest.size;
      }
    }
  }

  return { removed, kept: survivors.length, bytes: Math.max(bytes, 0) };
}

/** Throttled sweep after a write. Best effort: a failure must not fail the translation. */
function maybePrune(): void {
  if (Date.now() - lastPruneAt < GC_THROTTLE_MS) return;
  lastPruneAt = Date.now();
  try {
    pruneTranslationStore();
  } catch {
    /* housekeeping is not allowed to break a translation */
  }
}

/** Cached translation for this exact text+language, or null. Never calls a model. */
export function getCachedTranslation(text: string, lang: string): CacheEntry | null {
  return lookup('descriptions', text, lang);
}

/**
 * Cached translations for a batch of texts in one language — read-only, never calls a model.
 * The console uses it on mount so a previous visit's translations reappear without any spend, and
 * the detail dialog uses it with `kind: 'readme'` so a page translated yesterday opens translated.
 * A legacy partial README entry is skipped (see `CacheEntry.truncated`): the dialog must show the
 * published body, not a half-translated rendering, until a full one is stored.
 */
export function readCachedTranslations(
  texts: string[],
  lang: string,
  kind: CacheKind = 'descriptions'
): Record<string, { text: string; model: string }> {
  const out: Record<string, { text: string; model: string }> = {};
  for (const text of texts) {
    const hit = lookup(kind, text, lang);
    if (hit && !hit.truncated) {
      out[text] = { text: hit.text, model: hit.model };
    }
  }
  return out;
}

export interface TranslateResult {
  text: string;
  cached: boolean;
  model: string;
}

export type TranslateError = {
  code: 'no_api_key' | 'unsupported_lang' | 'upstream' | 'timeout';
  message: string;
};

/** First enabled gateway API key, for the gateway's own loopback calls (translation, probes). */
export function firstEnabledKey(): string | null {
  try {
    const keys = loadConfig().apiKeys ?? [];
    const found = keys.find((k) => k.enabled && k.key);
    return found?.key ?? null;
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT =
  'You translate short software-skill descriptions. Reply with the translation ONLY — no quotes, no ' +
  'explanations, no markdown. Preserve product names, code identifiers and file names verbatim. ' +
  'Keep it to one or two sentences.';

/**
 * Long-form copy needs a DIFFERENT contract: a README is a document, not a sentence. Asking the
 * description prompt to handle it would summarize a 3 000-word page into two sentences and call that
 * a translation.
 */
const MARKDOWN_SYSTEM_PROMPT =
  'You translate software documentation written in Markdown. Reply with the translated Markdown ONLY ' +
  '— no quotes, no explanations, no surrounding code fence. Preserve verbatim: fenced code blocks, ' +
  'inline code, URLs and links, HTML/badges, file paths, package names, CLI commands, and heading ' +
  'levels. Keep the document structure and list markers exactly as they are.';

/** Longest slice sent to the gateway in one call. A README is translated chunk by chunk: one giant
 *  request would sit on the 30 s deadline and lose everything when it expires. */
const MD_CHUNK_CHARS = 4_500;
/** Chunks in flight per document. Wall time is OUTPUT-bound — the serving model writes roughly 60
 *  tokens/s, so ~19 chunks of a 65 000-character README take two minutes at 3 in flight and under a
 *  minute at 8. The whole README is still translated (professional practice segments a document and
 *  translates every segment, never the opening third), and chunks are reassembled by document
 *  position, so completion order cannot reorder the page. */
const MD_CHUNK_POOL = 8;
/** Per-chunk attempts before the document fails. A 65 000-character README is ~19 chunks of real
 *  upstream work; one reset socket must not discard the other 18. Backoff is linear (600 ms, 1.2 s)
 *  because the common failures are transport resets and short bursts of throttling, not outages. */
const MD_CHUNK_ATTEMPTS = 3;
const MD_CHUNK_RETRY_MS = 600;
/** One gateway round-trip ceiling. A 4 500-character chunk is ~20 s of output; the margin covers a
 *  slow start, and the abort is what keeps a hung upstream from pinning a worker. */
const MD_CALL_TIMEOUT_MS = 30_000;
/** Whole-document ceiling. The slowest supported README (120 000 characters, ~27 chunks at 8 in
 *  flight) needs ~4 waves; five minutes leaves room for retries and throttling. A timeout is NOT a
 *  loss: every verified segment was already stored, so the next attempt resumes instead of
 *  re-paying. */
const MD_TOTAL_TIMEOUT_MS = 5 * 60_000;


/**
 * Tag verification, the cheap half of a CAT tool's QA pass: a translated segment must carry the same
 * structural markup as its source. A model that drops a heading, a list item, a table row or a link
 * has silently removed part of the document — the failure the "translation is incomplete" report
 * describes — so the segment is retried like a transport error instead of being stored.
 *
 * Counts are compared, not order (a translation may move a link inside a sentence), and trailing
 * sentence punctuation is stripped from URLs before comparing: a Chinese full stop routinely
 * replaces the ASCII one next to the same link.
 */
function segmentDefect(source: string, translated: string): string | null {
  const profile = (text: string) => ({
    headings: (text.match(/^#{1,6}\s/gm) ?? []).length,
    listItems: (text.match(/^\s*(?:[-*+]|\d+[.)])\s/gm) ?? []).length,
    tableRows: (text.match(/^\|/gm) ?? []).length,
    urls: (text.match(/https?:\/\/[^\s)\]>"'`]+/g) ?? [])
      .map((url) => url.replace(/[.,;:!?]+$/, ''))
      .sort()
      .join('\n'),
  });
  const want = profile(source);
  const got = profile(translated);
  if (got.headings !== want.headings) {
    return `heading count changed (${want.headings} → ${got.headings})`;
  }
  if (got.listItems !== want.listItems) {
    return `list-item count changed (${want.listItems} → ${got.listItems})`;
  }
  if (got.tableRows !== want.tableRows) {
    return `table-row count changed (${want.tableRows} → ${got.tableRows})`;
  }
  if (got.urls !== want.urls) return 'links changed or dropped';
  return null;
}


/**
 * Translation is a cheap, non-critical internal call, and WHICH model spends that quota is an
 * operator cost decision: `defaultModels.translation` (any gateway-visible modelRef — a tier alias
 * or a registered id) names the primary, and the `lite` alias stays as the tail. `auto` never
 * appears UNSOLICITED: it can escalate into the expensive tiers, and an internal call must not
 * have unbounded spend — a configured model that fails degrades to `lite`, and a failing `lite`
 * errors honestly instead of hunting for a pricier worker. An operator who explicitly writes
 * `auto` accepts that cost; config is the operator's own decision and is honored verbatim.
 *
 * The retry is a SECOND request with a different model ref — deliberately not a routing-level
 * cross-tier downgrade, which ADR-0014 forbids (a forced tier is a contract: the pipeline fails over
 * inside the tier, never jumps to another one). Retrying here keeps that contract intact.
 */
const TAIL_MODEL = 'lite';

/** Reserved internal-session ids (ADR-0015) — one shared session per purpose. */
const SESSION_TRANSLATION = `${INTERNAL_SESSION_PREFIX}translation`;
const SESSION_TRANSLATION_PROBE = `${INTERNAL_SESSION_PREFIX}translation-probe`;

/**
 * The attempt chain for a given configured value. Whitespace or a `lite` value collapses to the
 * tail alone; an empty string (a cleared picker) means "as if unset".
 */
function chainFor(configured: string | undefined): string[] {
  const trimmed = configured?.trim();
  if (!trimmed || trimmed === TAIL_MODEL) return [TAIL_MODEL];
  return [trimmed, TAIL_MODEL];
}

/**
 * The attempt chain from the SAVED config, resolved per call so a config edit applies without a
 * restart (loadConfig re-reads the YAML).
 */
export function translationChain(): string[] {
  let configured: string | undefined;
  try {
    configured = loadConfig().defaultModels?.translation;
  } catch {
    configured = undefined; // an unreadable config must not break a translation
  }
  return chainFor(configured);
}

/** One gateway round-trip for a fixed model ref. Errors are values, so the caller can retry. */
async function callGateway(
  key: string,
  model: string,
  text: string,
  lang: string,
  systemPrompt: string = SYSTEM_PROMPT,
  sessionId?: string,
  /** Per-round-trip ceiling; the document deadline hands a shorter one to the last attempts. */
  timeoutMs: number = MD_CALL_TIMEOUT_MS
): Promise<{ text: string; model: string } | { error: string }> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${defaultGatewayPort()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Target language: ${LANG_LABEL[lang as TranslationLang]}\n\n${text}` },
        ],
        // Pin the reserved internal-session namespace (ADR-0015) so these
        // loopback calls share one session instead of minting a fresh
        // cold_start session per call — the id IS the internal marker.
        ...(sessionId ? { router_options: { session_id: sessionId } } : {}),
      }),
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
  } catch (e) {
    return { error: `${model}: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!response.ok) {
    // The upstream body often names the real cause (unknown modelRef, empty tier pool, auth) —
    // carry a short snippet so a failing leg stays actionable instead of a bare status code.
    let detail = '';
    try {
      detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 200);
    } catch { /* body unreadable — the status code is the whole message */ }
    return { error: `${model}: gateway returned HTTP ${response.status}${detail ? ` — ${detail}` : ''}` };
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    model?: string;
  };
  const choice = payload.choices?.[0];
  const translated = choice?.message?.content?.trim();
  if (!translated) return { error: `${model}: empty translation from gateway` };
  // A cut answer is worse than a failed one: storing it would put a page that ends mid-sentence
  // behind a cache key that claims the whole document. The caller retries (or errors honestly).
  if (choice?.finish_reason === 'length') {
    return { error: `${model}: output hit the provider's token limit — the translation was cut` };
  }
  return { text: translated, model: payload.model || model };
}

/** Translate one description into `lang`; hits the cache first, then the gateway's own routing. */
export async function translateDescription(text: string, lang: string): Promise<TranslateResult | TranslateError> {
  if (!isSupportedLang(lang)) {
    return { code: 'unsupported_lang', message: `unsupported language '${lang}'` };
  }
  const cached = getCachedTranslation(text, lang);
  if (cached) return { text: cached.text, cached: true, model: cached.model };

  const key = firstEnabledKey();
  if (!key) {
    return { code: 'no_api_key', message: 'no enabled gateway API key — create one before translating' };
  }

  // Configured model (or the lite alias) first, then the single lite retry.
  const attempts = translationChain();
  const failures: string[] = [];
  for (const model of attempts) {
    const result = await callGateway(key, model, text, lang, SYSTEM_PROMPT, SESSION_TRANSLATION);
    if ('error' in result) {
      failures.push(result.error);
      continue;
    }
    store('descriptions', text, lang, result.text, result.model);
    return { text: result.text, cached: false, model: result.model };
  }

  return { code: 'upstream', message: failures.join(' | ') };
}

/** A Markdown document cut into prose runs and fenced-code runs, in document order. */
interface MarkdownRun {
  text: string;
  /** Fenced code is copied VERBATIM: a model that retypes a shell block introduces bugs. */
  code: boolean;
}

/**
 * Split a Markdown document into prose and fenced-code runs.
 *
 * `runs.map(r => r.text).join('\n')` reproduces the input byte for byte, so a partially translated
 * document still renders exactly like the original — the untranslated half is the ORIGINAL text,
 * never an empty hole.
 */
export function splitMarkdownRuns(markdown: string): MarkdownRun[] {
  const runs: MarkdownRun[] = [];
  let prose: string[] = [];
  let code: string[] = [];
  let inFence = false;
  const flushProse = () => {
    if (prose.length > 0) {
      runs.push({ text: prose.join('\n'), code: false });
      prose = [];
    }
  };
  for (const line of markdown.split('\n')) {
    // A fence opens and closes with the same marker at up to three spaces of indentation.
    const fence = /^\s{0,3}(```|~~~)/.test(line);
    if (inFence) {
      code.push(line);
      if (fence) {
        runs.push({ text: code.join('\n'), code: true });
        code = [];
        inFence = false;
      }
      continue;
    }
    if (fence) {
      flushProse();
      inFence = true;
      code = [line];
      continue;
    }
    prose.push(line);
  }
  // An unclosed fence runs to the end of the document; it is still code and still copied verbatim.
  if (code.length > 0) runs.push({ text: code.join('\n'), code: true });
  flushProse();
  return runs;
}

/** Prose → gateway-sized pieces, cut on paragraph boundaries (a lone oversized paragraph is sliced). */
export function chunkProse(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= max) {
      current = paragraph;
      continue;
    }
    for (let at = 0; at < paragraph.length; at += max) chunks.push(paragraph.slice(at, at + max));
    current = '';
  }
  if (current) chunks.push(current);
  return chunks;
}

export interface MarkdownTranslateResult {
  text: string;
  cached: boolean;
  model: string;
}

/**
 * Translate a Markdown document (a README) IN FULL: every prose run goes through the gateway chunk by
 * chunk, fenced code and blank lines are copied verbatim, and the pieces are rejoined in document
 * order. Segmentation exists because one gateway call holds a 30 s deadline and a whole README does
 * not fit in it — not because a tail is expendable.
 *
 * Two caches answer a repeat: the DOCUMENT entry (`i18n/readme/<sha256>.<lang>.json`, keyed by the
 * whole body) short-circuits the call, and the per-SEGMENT entries let a failed or timed-out run
 * resume from the chunks it already paid for. Either way, re-opening a dialog costs nothing.
 *
 * `refresh` is the operator saying the cached rendering is not good enough (a bad model answer):
 * skip the read and overwrite the entry on success. A failed run leaves the old entry untouched, so
 * a retry never costs them the translation they already have.
 *
 * `onProgress(done, total)` fires once with `(0, total)` when the chunk plan is known and after every
 * completed chunk. A README takes tens of seconds, so a caller with a UI to draw uses it; the plain
 * route ignores it.
 *
 * `timeoutMs` is the WHOLE-document ceiling (default `MD_TOTAL_TIMEOUT_MS`): chunks stop being
 * dispatched once it passes, in-flight calls get the remaining budget as their abort timeout, and
 * the run answers `code: 'timeout'`. Verified segments are already stored, so a retry resumes.
 */
export async function translateMarkdown(
  markdown: string,
  lang: string,
  opts: {
    refresh?: boolean;
    onProgress?: (done: number, total: number) => void;
    timeoutMs?: number;
  } = {}
): Promise<MarkdownTranslateResult | TranslateError> {
  const totalTimeoutMs = opts.timeoutMs ?? MD_TOTAL_TIMEOUT_MS;
  const deadline = Date.now() + totalTimeoutMs;
  if (!isSupportedLang(lang)) {
    return { code: 'unsupported_lang', message: `unsupported language '${lang}'` };
  }
  const runs = splitMarkdownRuns(markdown);

  // A legacy partial entry (written by the old budgeted translator) is a MISS: its key is the whole
  // document, so answering it would present an opening-third rendering as a finished translation.
  const hit = opts.refresh ? null : lookup('readme', markdown, lang);
  if (hit && !hit.truncated) {
    return { text: hit.text, cached: true, model: hit.model };
  }

  // Every prose run is planned; each is one or more gateway-sized chunks cut on paragraph
  // boundaries. A run is all-or-nothing: a failure rejects the whole document (an error the operator
  // can retry) rather than storing a rendering with one paragraph silently left in the source.
  const plan = new Map<number, string[]>();
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]!;
    if (run.code || run.text.trim() === '') continue;
    const chunks = chunkProse(run.text, MD_CHUNK_CHARS).filter((c) => c.trim() !== '');
    if (chunks.length > 0) plan.set(index, chunks);
  }

  if (plan.size === 0) {
    // Nothing translatable (a pure code block): the document IS the answer.
    return { text: markdown, cached: true, model: '' };
  }

  const key = firstEnabledKey();
  if (!key) {
    return { code: 'no_api_key', message: 'no enabled gateway API key — create one before translating' };
  }

  // Flatten to chunk tasks so every worker stays busy; results are keyed by (run, chunk) position.
  const tasks: { run: number; chunk: number; text: string }[] = [];
  for (const [run, chunks] of plan) {
    chunks.forEach((text, chunk) => tasks.push({ run, chunk, text }));
  }

  const translated = new Map<string, string>();
  let model = '';
  const failures: string[] = [];
  let cursor = 0;
  let done = 0;
  let timedOut = false;
  opts.onProgress?.(0, tasks.length);
  const worker = async () => {
    while (failures.length === 0) {
      const task = tasks[cursor++];
      if (!task) return;
      const remember = () => {
        done += 1;
        opts.onProgress?.(done, tasks.length);
      };
      // `refresh` means the operator rejected the rendering: segment memory must not answer with the
      // same text; the fresh chunks overwrite it below. Otherwise this is segment memory (the TM half
      // of the professional pipeline): a chunk translated by an earlier run — including one that
      // LATER failed on another chunk — is reused instead of paid for again. `readEntry`, not
      // `lookup`: the legacy description blob must never answer for README prose. Like a CAT tool's
      // memory, the key is the SOURCE text alone (no prompt version): a prompt improvement reuses
      // what was already approved until `refresh` re-translates the page over it.
      const segment = opts.refresh ? null : readEntry('segments', hashText(task.text), lang);
      if (segment && !segment.truncated) {
        translated.set(`${task.run}:${task.chunk}`, segment.text);
        remember();
        continue;
      }
      // A transport reset or a throttled upstream must not throw away the other chunks' work: retry
      // the chunk (the translation is idempotent) before failing the document. The whole call still
      // fails after the last attempt — a page with one paragraph silently in the source is worse.
      let result: { text: string; model: string } | { error: string } = { error: 'not attempted' };
      for (let attempt = 1; attempt <= MD_CHUNK_ATTEMPTS; attempt += 1) {
        // The whole-document deadline is enforced HERE, not by a single outer timer: a worker that
        // would start a fresh 30 s round-trip past the ceiling stops instead, and the calls already
        // in flight are cut with the remaining budget.
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          failures.push('translation deadline exceeded');
          timedOut = true;
          return;
        }
        result = await callGatewayOnce(key, task.text, lang, Math.min(MD_CALL_TIMEOUT_MS, remaining));
        if ('error' in result) {
          if (attempt < MD_CHUNK_ATTEMPTS) await delay(MD_CHUNK_RETRY_MS * attempt);
          continue;
        }
        // Tag verification: a segment that lost markup is not a translation of this source.
        const defect = segmentDefect(task.text, result.text);
        if (!defect) break;
        result = { error: `segment ${task.run}:${task.chunk} failed verification — ${defect}` };
        if (attempt < MD_CHUNK_ATTEMPTS) await delay(MD_CHUNK_RETRY_MS * attempt);
      }
      if ('error' in result) {
        failures.push(result.error);
        return;
      }
      // Store the verified segment IMMEDIATELY: a later chunk's failure must not lose this work.
      store('segments', task.text, lang, result.text, result.model);
      // First writer wins: chunks may span tiers (primary vs lite), and the run's reported model is
      // then the one that actually answered first instead of whichever worker finished last.
      if (!model) model = result.model;
      translated.set(`${task.run}:${task.chunk}`, result.text);
      remember();
    }
  };
  await Promise.all(Array.from({ length: Math.min(MD_CHUNK_POOL, tasks.length) }, worker));
  if (failures.length > 0) {
    return timedOut
      ? {
          code: 'timeout',
          message: `translation did not finish within ${Math.round(totalTimeoutMs / 1000)}s — finished segments are cached, retry to resume`,
        }
      : { code: 'upstream', message: failures.join(' | ') };
  }

  const out = runs
    .map((run, index) => {
      const chunks = plan.get(index);
      if (!chunks) return run.text;
      const parts = chunks.map((_, chunk) => translated.get(`${index}:${chunk}`));
      // Unreachable after the failure check above; keeping the run whole beats emitting a hole.
      if (parts.some((part) => part === undefined)) return run.text;
      return (parts as string[]).join('\n\n');
    })
    .join('\n');

  store('readme', markdown, lang, out, model);
  return { text: out, cached: false, model };
}

/** Configured model first, then the lite tail (same contract as a description). */
async function callGatewayOnce(
  key: string,
  text: string,
  lang: string,
  timeoutMs: number
): Promise<{ text: string; model: string } | { error: string }> {
  const failures: string[] = [];
  for (const model of translationChain()) {
    const result = await callGateway(key, model, text, lang, MARKDOWN_SYSTEM_PROMPT, SESSION_TRANSLATION, timeoutMs);
    if (!('error' in result)) return result;
    failures.push(result.error);
  }
  return { error: failures.join(' | ') };
}

/** Fixed one-line payload for the chain probe — description-shaped so the pinned system prompt
 *  stays in-distribution, small so a probe costs pennies. Exported for tests (they assert the
 *  probe never lands in the cache). */
export const PROBE_TEXT = 'Keeps installed skills tidy.';

export interface TranslationProbeAttempt {
  model: string;
  ok: boolean;
  error?: string;
}

export interface TranslationProbe {
  ok: boolean;
  /** The modelRef that actually answered (gateway-reported), when ok. */
  model?: string;
  chain: string[];
  latencyMs: number;
  attempts: TranslationProbeAttempt[];
  code?: 'no_api_key' | 'unsupported_lang' | 'upstream';
}

/**
 * Fire the REAL translation chain over a one-line payload — the power behind the console's
 * default-model "test" button. Same key resolution, same gateway round-trip, same attempt order
 * as a live translation; the ONLY difference is that the answer is never cached (a probe is a
 * diagnostic, not a translation). An explicit click is the explicit one-call spend.
 *
 * `overrideModel` carries the PICKER'S PENDING value so the operator tests BEFORE saving: given
 * → that value is the primary (an empty string = "as if unset" → the plain `lite` tail); omitted
 * → the chain comes from the saved config.
 */
export async function probeTranslationChain(lang = 'en', overrideModel?: string): Promise<TranslationProbe> {
  const chain = overrideModel === undefined ? translationChain() : chainFor(overrideModel);
  const started = Date.now();
  if (!isSupportedLang(lang)) {
    return { ok: false, chain, latencyMs: 0, attempts: [], code: 'unsupported_lang' };
  }
  const key = firstEnabledKey();
  if (!key) {
    return { ok: false, chain, latencyMs: 0, attempts: [], code: 'no_api_key' };
  }
  const attempts: TranslationProbeAttempt[] = [];
  for (const model of chain) {
    const result = await callGateway(key, model, PROBE_TEXT, lang, SYSTEM_PROMPT, SESSION_TRANSLATION_PROBE);
    if ('error' in result) {
      attempts.push({ model, ok: false, error: result.error });
      continue;
    }
    attempts.push({ model, ok: true });
    return { ok: true, model: result.model, chain, latencyMs: Date.now() - started, attempts };
  }
  return { ok: false, chain, latencyMs: Date.now() - started, attempts, code: 'upstream' };
}

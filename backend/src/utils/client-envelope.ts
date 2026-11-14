/**
 * Client-injected prompt envelopes — the DISPLAY normalizer for the console's
 * identification aids (session title, per-turn prompt summary, route-entry
 * snippet).
 *
 * Agent clients wrap human input in metadata tags before sending it, and the
 * vocabulary is per client, not per gateway: Cursor's agent emits a standalone
 * `<timestamp>11/8/2026, 8:53:57 PM GMT+8</timestamp>` message ahead of the
 * real turn, wraps the human text in `<user_query>…</user_query>`, and on
 * other turns opens with a whole context bundle as a standalone user message —
 * `<user_info>` (OS, shell, workspace path, terminal stores), then
 * `<agent_transcripts>`, `<rules>`, `<agent_skills>`, `<mcp_server_catalog>`,
 * `<hooks_context>`. Claude Code instead MIXES machinery and human text in
 * ONE message: a session-opening user message is `<system-reminder>` (git
 * attribution boilerplate) + the `/clear` command record + the human prompt
 * as sibling content parts (measured 2026-11-14, claude-cli/2.1.317, capture
 * archive session cc_c6a59aae…). Other harnesses ship their own
 * (`<environment_context>`, attachment blocks, …), and the next one will
 * invent another. Those bytes are the client's prompt and the gateway MUST
 * forward them untouched — but a summary that quotes them names the session
 * after a metadata dump and hides what the operator actually asked (the
 * observed defects: an entire console title that is one `<timestamp>` block,
 * one that opens with `<user_info> OS Version: …`, and one that is the raw
 * `<system-reminder>` attribution text).
 *
 * FOUR rules, in order — deliberately NOT one ever-growing tag list, because
 * a list can only recognize clients that already shipped:
 *  1. A transport wrapper, when present, IS the human content: the body of
 *     `<user_query>…</user_query>` is kept bare and the rest of that message is
 *     dropped. Clients that wrap their human turns this way get unknown context
 *     tags handled for free.
 *  2. Known metadata blocks (the evidence-backed list below, plus any tags a
 *     matched harness profile contributes — see utils/harness-profiles.ts) are
 *     dropped wherever they sit, so a mixed message keeps only its human part.
 *  3. A message that is NOTHING but XML-style blocks — no text outside them —
 *     is a client context envelope: blank it, whatever its tag names are. That
 *     is the rule that makes tomorrow's `<foo_state>` bundle behave like
 *     today's `<user_info>`.
 *  4. A message that OPENS with top-level blocks and carries its outside text
 *     only AFTER them is the prepend-machinery shape (Claude Code's mixed
 *     message, and any future harness that prepends context and appends the
 *     prompt): drop the head block-run, display the later text alone. The
 *     guard is structural, zero vocabulary — text BEFORE the first block
 *     disables it (a human "please analyze: <data>…" keeps everything), and
 *     a wrapper message still resolves through rule 1 first.
 *
 * The one cost of rules 3/4 is a human prompt that is itself pure markup (a
 * pasted `<div>…</div>`, or markup pasted ahead of a question): the display
 * form blanks or trims it. All consumers render ≤ 200-char identification
 * aids, so the intent line IS the better summary there; the raw bytes stay
 * untouched on the wire. Session titles additionally ask for
 * `keepUnknownEnvelope` on their last-resort pass, which keeps a tag-only
 * message instead of naming the session nothing; summaries and snippets stay
 * strict.
 *
 * Implementation is ONE linear scan, not a set of regex block matchers: these
 * run on the request path over arbitrary client bytes, and a `[\s\S]*?<\\/tag>`
 * matcher is quadratic on a document full of unclosed tags (measured 2026-11:
 * 300 KB of literal `<a>` cost ~5 s, and any pasted HTML page reaches that
 * shape). The scan also settles nesting honestly — a balanced same-name nest is
 * still an envelope.
 *
 * This helper yields the display form only; everything else is kept verbatim.
 *
 * NEVER feed the result back into routing, prompt hashing, session anchors,
 * conversation keys, capture or the upstream request: those consume the real
 * bytes the client sent, and rewriting them would change routing identity.
 */
import type { HarnessProfile } from './harness-profiles.js';

/**
 * Known metadata-only blocks: no human content, dropped from display text.
 * Cursor's context-bundle tags are matched at their own level; the inner rows
 * (`always_applied_workspace_rules`, `available_skills`,
 * `mcp_meta_tool_servers`) ride along with their parent, and are listed too so
 * a client that sends one standalone is still handled. This list is a fast
 * path, NOT the contract: rule 3 covers vocabulary that is not here yet.
 */
const KNOWN_METADATA: Record<string, true> = {
  timestamp: true,
  user_info: true,
  agent_transcripts: true,
  rules: true,
  agent_skills: true,
  available_skills: true,
  mcp_server_catalog: true,
  mcp_meta_tool_servers: true,
  hooks_context: true,
};

/** Own-key membership (a tag named `constructor` is not known metadata). */
const isKnownMetadata = (name: string): boolean => Object.hasOwn(KNOWN_METADATA, name);

/**
 * Transport wrappers: the inner text IS the human content, kept bare.
 *
 * A closed vocabulary on purpose. Rule 3 below blanks ANY tag-only message,
 * because a client envelope (Cursor's context bundle) is indistinguishable
 * from a human prompt wrapped in markup without knowing the client — naming
 * the wrappers is the safe side of that bet. Measured wrappers: Claude
 * Code's `<user_query>`; WorkBuddy 5.x wraps the whole prompt in
 * `<session>` (2026-11). A new client that wraps differently shows up as an
 * empty summary until its tag is listed here; its TITLE still resolves via
 * the last-resort unwrap below, so nothing is lost from the console.
 */
const WRAPPER_TAGS: Record<string, true> = {
  user_query: true,
  session: true,
};

/** Leftover wrapper tags inside a captured body (a nested wrapper, if any). */
const WRAPPER_TAGS_RE = /<\/?(?:user_query|session)>/gi;

/**
 * Display-budget ceiling. Every caller renders at most a 200-char snippet, so
 * the scan stops ACCUMULATING (never stops SCANNING — rule 3 needs the whole
 * message's verdict) once this much display text is gathered. A multi-megabyte
 * body therefore costs no more than this buffer, regardless of how many blocks
 * it contains.
 */
const MAX_DISPLAY_CHARS = 8_192;

/** `<[/]name attrs [/]>` anchored at the current position (sticky). */
const TAG_TOKEN_RE = /<(\/?)([A-Za-z_][\w.:-]*)(?:\s[^<>]*?)?(\/?)>/y;

interface OpenTag {
  name: string;
  /** Index of the opening '<' — the raw block source starts here. */
  start: number;
  /** Index just past the opening tag — the block body starts here. */
  bodyStart: number;
}

export interface DisplayPromptOptions {
  /**
   * Keep an UNRECOGNIZED tag-shell instead of blanking it. Session titles ask
   * for this on their last-resort pass (the session has no recognized human
   * text at all): a prompt that is nothing but markup is structurally
   * identical to a client envelope, and titling with the raw tags beats
   * titling with nothing. Known metadata blocks are stripped either way.
   */
  keepUnknownEnvelope?: boolean;
  /**
   * Harness vocabulary scoped to the client that sent THIS message (rule 2
   * contribution; see utils/harness-profiles.ts). `undefined` — unknown or
   * absent User-Agent — runs the global vocabulary only, so an unprofiled
   * client is exactly the pre-profile behavior plus the structural rules.
   */
  profile?: HarnessProfile;
}

/** Shared whitespace rule: `\s+` → one space, then trim. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Display form of a prompt: metadata envelopes stripped, human wrapper
 * unwrapped, prepend-machinery head run dropped, whitespace flattened.
 * Capped at `MAX_DISPLAY_CHARS` (every caller renders ≤ 200 chars); returns
 * '' when the message is only client metadata.
 */
export function displayPromptText(text: string, opts: DisplayPromptOptions = {}): string {
  const profile = opts.profile;

  // Profile-scoped machinery prefixes (Claude Code's SessionStart hook
  // output): a message whose OWN words open with the convention is harness
  // machinery end to end — no structural signal exists for these, so this
  // is the only rule that can blank them. Applies in the permissive pass
  // too: a machinery message must never be a session's last-resort title.
  if (profile && profile.machineryPrefixes.length > 0) {
    // Bounded prefix copy: these run on client-controlled bodies that can be
    // megabytes, and `trimStart()` on the whole string would copy all of it
    // just to test an anchored convention (no real hook banner has a 4 KB
    // whitespace leader).
    const head = text.slice(0, 4096).trimStart().slice(0, 64);
    for (const re of profile.machineryPrefixes) {
      if (re.test(head)) return '';
    }
  }

  // Rule 2 vocabulary: the global evidence-backed list plus the matched
  // harness profile's scoped tags (one combined probe, so the scanner stays
  // a single linear pass).
  const isMachineryTag = (name: string): boolean =>
    isKnownMetadata(name) || (profile?.metadataTags.has(name) ?? false);

  const chunks: string[] = [];
  let budget = MAX_DISPLAY_CHARS;
  let outsideNonEmpty = false;
  let structural = false;
  let wrapped = '';
  const stack: OpenTag[] = [];

  // Rule 4 bookkeeping (see the module doc): whether a TOP-LEVEL block has
  // opened at least once, whether outside text appeared BEFORE the first
  // one, and the outside text seen after the blocks. The post run carries
  // its OWN budget so the head block-run cannot starve it.
  let topLevelBlockSeen = false;
  let leadingOutsideText = false;
  const postChunks: string[] = [];
  let postBudget = MAX_DISPLAY_CHARS;

  const add = (chunk: string, outside: boolean): void => {
    if (!chunk) return;
    const significant = outside && /\S/.test(chunk);
    if (significant && !outsideNonEmpty) outsideNonEmpty = true;
    if (significant && !topLevelBlockSeen) leadingOutsideText = true;
    if (significant && topLevelBlockSeen && postBudget > 0) {
      // Rule 4 keeps its OWN budget on purpose: a multi-kilobyte head block
      // (Cursor's `<agent_transcripts>` is one) must not starve the human
      // tail that rule 4 exists to display, or the rule would fail exactly
      // on the messages that need it most.
      const keptPost = chunk.length <= postBudget ? chunk : chunk.slice(0, postBudget);
      postChunks.push(keptPost);
      postBudget -= keptPost.length;
    }
    if (budget <= 0) return;
    const kept = chunk.length <= budget ? chunk : chunk.slice(0, budget);
    chunks.push(kept);
    budget -= kept.length;
  };

  /** Rule 1: the first non-empty wrapper body wins the whole message. The body
   *  is sliced to the display budget BEFORE flattening: a 16 MB wrapped prompt
   *  must not allocate multi-megabyte intermediate strings (rule 3 only needs
   *  the accumulated display text, not the whole body). */
  const takeWrapper = (body: string): void => {
    if (wrapped) return;
    const flat = flatten(body.slice(0, MAX_DISPLAY_CHARS).replace(WRAPPER_TAGS_RE, ' '));
    if (flat) wrapped = flat;
  };

  let pos = 0;
  while (pos < text.length) {
    const lt = text.indexOf('<', pos);
    if (lt === -1) {
      if (stack.length === 0) add(text.slice(pos), true);
      break;
    }
    if (stack.length === 0) add(text.slice(pos, lt), true);
    TAG_TOKEN_RE.lastIndex = lt;
    const m = TAG_TOKEN_RE.exec(text);
    if (!m) {
      // A literal '<' (comparison, arrow, emoji) — plain text.
      if (stack.length === 0) add('<', true);
      pos = lt + 1;
      continue;
    }

    const raw = m[0];
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClosing = !closing && m[3] === '/';
    const end = lt + raw.length;

    if (closing) {
      let idx = stack.length - 1;
      while (idx >= 0 && stack[idx].name !== name) idx--;
      if (idx < 0) {
        // Stray closer: verbatim text when it sits outside any open block.
        if (stack.length === 0) add(raw, true);
        pos = end;
        continue;
      }
      const open = stack[idx];
      // Mismatched inner opens are discarded WITH their container.
      stack.length = idx;
      if (isMachineryTag(name)) {
        // Rule 2: dropped wherever it sits — global vocabulary plus any tags
        // the matched harness profile contributes.
      } else if (Object.hasOwn(WRAPPER_TAGS, name)) {
        // Capture at any depth, but never from inside client metadata (a
        // hook's `<user_query>` example is not this turn's prompt — scoped
        // metadata such as `<system-reminder>` counts too).
        if (!stack.some((t) => isMachineryTag(t.name))) {
          takeWrapper(text.slice(open.bodyStart, lt));
        }
      } else if (stack.length === 0) {
        // Unknown top-level block: rule 3 decides from "outside" text alone,
        // so its raw source is kept for the envelope pass.
        add(text.slice(open.start, end), false);
      }
      if (stack.length === 0) structural = true;
      pos = end;
      continue;
    }

    if (selfClosing) {
      // Self-closing rows carry no body; they mark structure, nothing else.
      if (stack.length === 0) {
        structural = true;
        if (!isMachineryTag(name)) add(raw, false);
      }
      pos = end;
      continue;
    }

    if (stack.length === 0) topLevelBlockSeen = true;
    stack.push({ name, start: lt, bodyStart: end });
    pos = end;
  }

  // Unterminated markup can never be a balanced envelope: keep the tail
  // verbatim (this is also what makes an unclosed-tag flood O(n) instead of
  // quadratic — the tail is sliced once, not rescanned per open tag).
  if (stack.length > 0) add(text.slice(stack[0].start), true);

  if (wrapped) return wrapped;
  // Rule 4 (prepend-machinery shape): the message OPENED with top-level
  // blocks, no text sat before the first one, and real text exists after
  // them — the head block-run is dropped and the later text is displayed
  // alone. Unterminated markup is unaffected in practice: its verbatim tail
  // (which includes the raw open tag) is the ONLY post text, so the return
  // value equals the verbatim fallback below either way.
  if (topLevelBlockSeen && !leadingOutsideText) {
    const postText = flatten(postChunks.join(' '));
    if (postText) return postText;
  }
  if (opts.keepUnknownEnvelope) {
    // Last resort (naming a conversation, never a summary): a LONE plain-text
    // block is a wrapper around human text — an unrecognized client tag such
    // as WorkBuddy's `<session>` before it was listed — so unwrap it instead
    // of either blanking the title or quoting raw tags. A bundle (several
    // sibling blocks) or a body that is itself markup stays a raw shell.
    const lone = loneWrapperBody(text, profile);
    if (lone) return lone;
    return flatten(chunks.join(' '));
  }
  // Rule 3: only tags, no outside text → a client envelope.
  if (!outsideNonEmpty && structural) return '';
  return flatten(chunks.join(' '));
}

/**
 * Body of a message that is exactly ONE top-level element with plain-text
 * content — the structural shape of a client wrapper. `undefined` for
 * anything else (bundles, nested markup, known metadata, known wrappers).
 *
 * String slicing, not a backtracking regex: this runs on client-controlled
 * bodies and the module's whole point is staying linear on hostile input.
 */
function loneWrapperBody(text: string, profile?: HarnessProfile): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('<') || !trimmed.endsWith('>')) return undefined;
  const openEnd = trimmed.indexOf('>');
  if (openEnd < 0) return undefined;
  const openName = trimmed.slice(1, openEnd).trim().split(/\s+/)[0].toLowerCase();
  if (!/^[a-z_][\w.:-]*$/.test(openName)) return undefined;
  if (
    Object.hasOwn(KNOWN_METADATA, openName) ||
    Object.hasOwn(WRAPPER_TAGS, openName) ||
    (profile?.metadataTags.has(openName) ?? false)
  ) {
    // Metadata and wrappers are NOT lone-wrapper candidates: a scoped
    // `<system-reminder>` body is machinery, never a last-resort title.
    return undefined;
  }
  const closeStart = trimmed.lastIndexOf('</');
  const closeEnd = trimmed.lastIndexOf('>');
  if (closeStart <= openEnd || closeEnd <= closeStart) return undefined;
  if (trimmed.slice(closeStart + 2, closeEnd).trim().toLowerCase() !== openName) return undefined;
  const body = trimmed.slice(openEnd + 1, closeStart);
  // Nested markup means a client bundle, not a wrapper around one prompt.
  if (!body.trim() || /<\/?[A-Za-z_][\w.:-]*(?:\s[^<>]*?)?\/?>/.test(body)) return undefined;
  return flatten(body) || undefined;
}

/**
 * First display text among candidate user messages (already in conversation
 * order), capped for a console snippet. Two passes, same rule as session
 * titles: strict first, so an UNRECOGNIZED envelope never outranks a later
 * human turn in the same request; then the permissive pass, so a prompt that
 * is itself markup still yields a title/snippet. Undefined when no candidate
 * carries any text at all.
 *
 * The ONE derivation behind the console session title, the per-turn prompt
 * summary and the capture-session preview — callers differ only in the cap
 * and in whether a harness profile is threaded through (the caller that saw
 * the request headers resolves it; readers of a stored body resolve it from
 * the archived wire headers the same way).
 */
export function firstDisplayText(
  texts: readonly string[],
  cap = 200,
  opts: DisplayPromptOptions = {}
): string | undefined {
  for (const keepUnknownEnvelope of [false, true]) {
    for (const text of texts) {
      const flat = displayPromptText(text, { ...opts, keepUnknownEnvelope });
      if (flat) return flat.length <= cap ? flat : flat.slice(0, cap - 1) + '…';
    }
  }
  return undefined;
}

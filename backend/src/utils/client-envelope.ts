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
 * `<hooks_context>`. Other harnesses ship their own (`<environment_context>`,
 * attachment blocks, …), and the next one will invent another. Those bytes are
 * the client's prompt and the gateway MUST forward them untouched — but a
 * summary that quotes them names the session after a metadata dump and hides
 * what the operator actually asked (the observed defects: an entire console
 * title that is one `<timestamp>` block, and one that opens with
 * `<user_info> OS Version: …`).
 *
 * Three rules, in order — deliberately NOT one ever-growing tag list, because
 * a list can only recognize clients that already shipped:
 *  1. A transport wrapper, when present, IS the human content: the body of
 *     `<user_query>…</user_query>` is kept bare and the rest of that message is
 *     dropped. Clients that wrap their human turns this way get unknown context
 *     tags handled for free.
 *  2. Known metadata blocks (the evidence-backed list below) are dropped
 *     wherever they sit, so a mixed message keeps only its human part.
 *  3. A message that is NOTHING but XML-style blocks — no text outside them —
 *     is a client context envelope: blank it, whatever its tag names are. That
 *     is the rule that makes tomorrow's `<foo_state>` bundle behave like
 *     today's `<user_info>`.
 *
 * The one cost of rule 3 is a human prompt that is itself pure markup (a pasted
 * `<div>…</div>`): the display form blanks it. Session titles therefore ask for
 * `keepUnknownEnvelope` on their last-resort pass, which keeps such a message
 * instead of naming the session nothing; summaries and snippets stay strict.
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

/** Transport wrapper: the inner text IS the human content, kept bare. */
const WRAPPER_TAG = 'user_query';

/** Leftover wrapper tags inside a captured body (a nested wrapper, if any). */
const WRAPPER_TAGS_RE = /<\/?user_query>/gi;

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
}

/** Shared whitespace rule: `\s+` → one space, then trim. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Display form of a prompt: metadata envelopes stripped, human wrapper
 * unwrapped, whitespace flattened. Capped at `MAX_DISPLAY_CHARS` (every caller
 * renders ≤ 200 chars); returns '' when the message is only client metadata.
 */
export function displayPromptText(text: string, opts: DisplayPromptOptions = {}): string {
  const chunks: string[] = [];
  let budget = MAX_DISPLAY_CHARS;
  let outsideNonEmpty = false;
  let structural = false;
  let wrapped = '';
  const stack: OpenTag[] = [];

  const add = (chunk: string, outside: boolean): void => {
    if (!chunk) return;
    if (outside && !outsideNonEmpty && /\S/.test(chunk)) outsideNonEmpty = true;
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
      if (isKnownMetadata(name)) {
        // Rule 2: dropped wherever it sits.
      } else if (name === WRAPPER_TAG) {
        // Capture at any depth, but never from inside known client metadata
        // (a hook's `<user_query>` example is not this turn's prompt).
        if (!stack.some((t) => isKnownMetadata(t.name))) {
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
        if (!isKnownMetadata(name)) add(raw, false);
      }
      pos = end;
      continue;
    }

    stack.push({ name, start: lt, bodyStart: end });
    pos = end;
  }

  // Unterminated markup can never be a balanced envelope: keep the tail
  // verbatim (this is also what makes an unclosed-tag flood O(n) instead of
  // quadratic — the tail is sliced once, not rescanned per open tag).
  if (stack.length > 0) add(text.slice(stack[0].start), true);

  if (wrapped) return wrapped;
  if (opts.keepUnknownEnvelope) return flatten(chunks.join(' '));
  // Rule 3: only tags, no outside text → a client envelope.
  if (!outsideNonEmpty && structural) return '';
  return flatten(chunks.join(' '));
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
 * summary and the capture-session preview — callers differ only in the cap.
 */
export function firstDisplayText(texts: readonly string[], cap = 200): string | undefined {
  for (const keepUnknownEnvelope of [false, true]) {
    for (const text of texts) {
      const flat = displayPromptText(text, { keepUnknownEnvelope });
      if (flat) return flat.length <= cap ? flat : flat.slice(0, cap - 1) + '…';
    }
  }
  return undefined;
}

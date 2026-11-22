/**
 * Scoped envelope vocabulary per agent harness — Layer 2 of the client
 * envelope resolution design (see docs/adr/0025-client-envelope-resolution.md).
 *
 * The structural rules in utils/client-envelope.ts are client-agnostic and
 * deliberately vocabulary-free: rule 3 blanks any tag-only message whatever
 * its tag names are, so a FUTURE harness needs no code change as long as it
 * ships its context as standalone envelope messages. But harnesses that MIX
 * machinery and human text in ONE message (Claude Code opens a turn with
 * `<system-reminder>` + a `/clear` command record + the human prompt as
 * sibling content parts) can only be separated by vocabulary — and that
 * vocabulary must never leak across clients: a Cursor user pasting a literal
 * `<command-name>` block into a question must keep it in the display.
 *
 * Hence the adapter shape: a User-Agent FINGERPRINT selects a profile, and
 * the profile's tag lists apply ONLY to requests from that client. The
 * fingerprint is spoofable by design of HTTP — this is display-only surface,
 * never routing state, so a forged UA costs at most a wrong session title.
 *
 * Evidence rule (same spirit as KNOWN_METADATA in client-envelope.ts): a tag
 * lands here only after it was measured on the wire from the real client;
 * speculative vocabulary stays out. Each entry cites where it was observed.
 */

/**
 * The vocabulary ONE harness contributes to the envelope normalizer. Tag
 * names are matched lowercased against the scanner's tag token (hyphens
 * allowed); prefix patterns are anchored at the START of the trimmed
 * message text and, when they match, blank the whole message — a matched
 * machinery message carries no human text at all.
 */
export interface HarnessProfile {
  /**
   * Tag names whose blocks are machinery (client-envelope rule 2, scoped):
   * dropped wherever they sit, bodies and all. NEVER wrappers — a wrapper
   * body is the human turn by definition.
   */
  readonly metadataTags: ReadonlySet<string>;
  /**
   * Anchored plain-text conventions that mark a WHOLE message as harness
   * machinery (hook outputs, banners). No structural signal exists for
   * these, so only the profile's client can be affected.
   */
  readonly machineryPrefixes: readonly RegExp[];
}

/**
 * Claude Code (Anthropic's CLI). Measured 2026-11-14, `claude-cli/2.1.317`
 * via OCR's own capture archive (`cc_c6a59aae…` session, POST /v1/messages):
 *
 * - `<system-reminder>…</system-reminder>` — client-injected guidance (git
 *   commit/PR attribution boilerplate, CLAUDE.md context). Never human text.
 * - `<local-command-caveat>`, `<command-name>`, `<command-message>`,
 *   `<command-args>`, `<local-command-stdout>` — the slash-command record
 *   Claude Code writes when the user runs `/clear` & friends locally: the
 *   command "was run directly, not sent as a request", recorded as context.
 * - `SessionStart:clear hook success: …` — SessionStart hook output injected
 *   as a standalone user message. Plain text, no tags, so only an anchored
 *   prefix pattern can recognize it. Other hook names (PreToolUse etc.) ride
 *   the same `Name:matcher hook status:` convention — add each only once
 *   measured on the wire.
 */
const CLAUDE_CODE_PROFILE: HarnessProfile = {
  metadataTags: new Set([
    'system-reminder',
    'local-command-caveat',
    'command-name',
    'command-message',
    'command-args',
    'local-command-stdout',
  ]),
  machineryPrefixes: [/^SessionStart:\S*\s+hook\s+(?:success|error|failure):/],
};

/** Fingerprint table — first match wins, evaluated against the raw UA. */
const PROFILE_MATCHERS: readonly { readonly match: RegExp; readonly profile: HarnessProfile }[] = [
  { match: /claude-cli\//i, profile: CLAUDE_CODE_PROFILE },
];

/**
 * Resolve a harness profile from the inbound User-Agent. `undefined` for
 * unknown/absent UAs — the caller then runs the global vocabulary only, so
 * an unprofiled client is exactly today's behavior plus the structural
 * rules. Pure function, no state: called per request on the display path.
 */
export function harnessProfileOf(userAgent: string | undefined): HarnessProfile | undefined {
  const ua = userAgent?.trim();
  if (!ua) return undefined;
  for (const entry of PROFILE_MATCHERS) {
    if (entry.match.test(ua)) return entry.profile;
  }
  return undefined;
}

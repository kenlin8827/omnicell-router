/**
 * Client-family classification — the ONE mapping from a client fingerprint (a
 * self-declared `x-ocr-client` hint, else the HTTP User-Agent) to a stable
 * client family for the console.
 *
 * Display-only: both inputs are client-forgeable and are deliberately never
 * identity/routing inputs (ADR-0002 resolves session identity zero-header,
 * anchored on the API-key application). The hint exists because a browser
 * webview strips a script-set `User-Agent` on `fetch` — see
 * `CLIENT_HINT_HEADER`. The family id is the machine key the sessions filter
 * and the console query string use; `label` is an English fallback shown when
 * the console has no localized name for the id. Product names (OpenCode,
 * Cursor, …) are proper nouns and are never translated.
 */
export interface ClientFamily {
  /** Stable machine id (`opencode`, `claude-code`, `pi`, …). Never localized. */
  id: string;
  /** English display label / fallback for unknown UAs. */
  label: string;
}

/**
 * Ordered first-match table. ORDER MATTERS: `pi` is ANCHORED and must be
 * tested before the generic `/anthropic/i` entry — a pi User-Agent embeds no
 * vendor name, but an unanchored `/pi/i` would match "Anthropic/…".
 */
const CLIENT_PATTERNS: [RegExp, string, string][] = [
  // The console's own playground page (frontend/src/pages/PlaygroundPage.tsx
  // sends `OmniCellRouter-Playground/<version>`). Before `pi` so the product
  // prefix can never be mistaken for a vendor SDK.
  [/omnicellrouter-playground/i, 'playground', 'Playground'],
  // pi agent — `pi/<version> (<platform>; <runtime>/<ver>; <arch>)` or `pi`.
  [/^pi(\/|\s|$)/i, 'pi', 'pi'],
  // Coding agents / CLIs
  [/opencode/i, 'opencode', 'OpenCode'],
  [/claude-cli|claude-code/i, 'claude-code', 'Claude Code'],
  [/chatgpt/i, 'chatgpt', 'ChatGPT'],
  [/codex/i, 'codex', 'Codex / ChatGPT'],
  [/cline/i, 'cline', 'Cline'],
  [/roo-?code/i, 'roo-code', 'Roo Code'],
  [/kilo-?code/i, 'kilo-code', 'Kilo Code'],
  [/cursor/i, 'cursor', 'Cursor'],
  [/windsurf/i, 'windsurf', 'Windsurf'],
  // Chat frontends
  [/cherrystudio/i, 'cherry-studio', 'Cherry Studio'],
  [/chatbox/i, 'chatbox', 'ChatBox'],
  [/lobe-?chat|lobehub/i, 'lobechat', 'LobeChat'],
  [/nextchat|chatgpt-?next-?web/i, 'nextchat', 'NextChat'],
  [/open-?webui/i, 'open-webui', 'Open WebUI'],
  [/librechat/i, 'librechat', 'LibreChat'],
  [/dify/i, 'dify', 'Dify'],
  [/fastgpt/i, 'fastgpt', 'FastGPT'],
  // IDE / editor integrations
  [/visual-?studio-?code|vscode/i, 'vscode', 'VS Code'],
  [/jetbrains/i, 'jetbrains', 'JetBrains'],
  // Official SDKs
  [/openai\/node/i, 'openai-node', 'OpenAI SDK (Node)'],
  [/openai\/python/i, 'openai-python', 'OpenAI SDK (Python)'],
  [/anthropic/i, 'anthropic-sdk', 'Anthropic SDK'],
  [/google-?genai|generativelanguage/i, 'google-genai', 'Google GenAI SDK'],
  // HTTP libraries (generic fallbacks for home-grown callers)
  [/python-?httpx/i, 'python-httpx', 'Python httpx'],
  [/python-?requests/i, 'python-requests', 'Python requests'],
  [/python-?urllib/i, 'python-urllib', 'Python urllib'],
  [/aiohttp/i, 'python-aiohttp', 'Python aiohttp'],
  [/okhttp/i, 'okhttp', 'OkHttp'],
  [/go-http-client/i, 'go-http', 'Go HTTP'],
  [/guzzle/i, 'guzzle', 'Guzzle'],
  [/\bdart\//i, 'dart', 'Dart'],
  [/axios/i, 'axios', 'Axios'],
  [/undici/i, 'undici', 'Node fetch (undici)'],
  // API tools
  [/postmanruntime/i, 'postman', 'Postman'],
  [/insomnia/i, 'insomnia', 'Insomnia'],
  [/\bcurl\/|libcurl/i, 'curl', 'curl'],
  [/wget/i, 'wget', 'Wget'],
];

/** Max length of an unrecognized UA token shown as the label. */
const UNKNOWN_LABEL_CAP = 32;

/** Family id for a User-Agent the table does not recognize. */
export const UNKNOWN_CLIENT_FAMILY_ID = 'unknown';

/**
 * Inbound header a client uses to declare its own identity, e.g.
 * `OmniCellRouter-Playground/<version>`.
 *
 * A browser webview strips a script-set `User-Agent` on `fetch` (the browser
 * sends its own instead — verified empirically), so the UA alone cannot carry
 * a self-declared id from a console page. A custom header survives, and it is
 * PREFERRED over the UA for family classification. Display-only, exactly like
 * the UA: forgeable, never an identity or routing input (ADR-0002).
 */
export const CLIENT_HINT_HEADER = 'x-ocr-client';

/**
 * The identification material ONE request carried: a self-declared hint
 * (`x-ocr-client`) and/or the raw inbound User-Agent. Either may be absent.
 */
export interface ClientFingerprint {
  /** Self-declared client id (`x-ocr-client`), e.g. `playground/0.8.5`. */
  hint?: string;
  /** Raw inbound `User-Agent` string. */
  userAgent?: string;
}

/**
 * Classify one User-Agent into a client family. Unknown UAs keep their leading
 * whitespace token (capped) as the label so the console never invents a client
 * that isn't there; the full raw UA stays in the chip tooltip.
 */
export function clientFamilyOf(ua: string): ClientFamily {
  for (const [pattern, id, label] of CLIENT_PATTERNS) {
    if (pattern.test(ua)) return { id, label };
  }
  const token = ua.trim().split(/\s+/)[0] ?? '';
  const label = token.length > UNKNOWN_LABEL_CAP ? `${token.slice(0, UNKNOWN_LABEL_CAP)}…` : token || '—';
  return { id: UNKNOWN_CLIENT_FAMILY_ID, label };
}

/**
 * One family as a session reports it: the family plus the raw fingerprints
 * that produced it (write order). The fingerprint list exists only so the
 * console chip can keep showing the exact value in its tooltip — it is never
 * an identity or a filter key (the family id is).
 */
export interface SessionClientFamily extends ClientFamily {
  /** The identifying strings: a self-declared hint or the raw UA, whichever
   *  classified the request (see `clientFamiliesOf`). */
  fingerprints: string[];
}

/**
 * Resolve ONE request's family. A self-declared hint wins when it names a
 * known family; otherwise the UA classifies, and an unrecognized hint is the
 * last resort. Returns the raw string that actually classified so the console
 * tooltip shows the value the family came from.
 */
function familyOfFingerprint(fp: ClientFingerprint): { family: ClientFamily; raw: string } | undefined {
  const hint = fp.hint?.trim();
  const ua = fp.userAgent?.trim();
  if (hint) {
    const declared = clientFamilyOf(hint);
    if (declared.id !== UNKNOWN_CLIENT_FAMILY_ID) return { family: declared, raw: hint };
  }
  if (ua) return { family: clientFamilyOf(ua), raw: ua };
  if (hint) return { family: clientFamilyOf(hint), raw: hint };
  return undefined;
}

/**
 * Distinct families across a session's per-request fingerprints, in write
 * order (first element = display anchor). Fingerprints of the same family
 * collapse to one entry that keeps every contributing value.
 */
export function clientFamiliesOf(fingerprints: readonly ClientFingerprint[]): SessionClientFamily[] {
  const byId = new Map<string, SessionClientFamily>();
  for (const fp of fingerprints) {
    const resolved = familyOfFingerprint(fp);
    if (!resolved) continue;
    const existing = byId.get(resolved.family.id);
    if (existing) {
      existing.fingerprints.push(resolved.raw);
      continue;
    }
    byId.set(resolved.family.id, { ...resolved.family, fingerprints: [resolved.raw] });
  }
  return [...byId.values()];
}

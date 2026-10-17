/**
 * Map an HTTP User-Agent string to a friendly client display name for the
 * console session table. Display-only: the UA is client-forgeable and is
 * deliberately never an identity/routing input (ADR-0002 resolves session
 * identity zero-header, anchored on the API-key application). Unknown UAs
 * fall back to the trimmed raw string so the UI never invents a client that
 * isn't there — the full raw value stays in the badge tooltip.
 */
const CLIENT_PATTERNS: [RegExp, string][] = [
  // Coding agents / CLIs
  [/opencode/i, 'OpenCode'],
  [/claude-cli|claude-code/i, 'Claude Code'],
  [/codex/i, 'Codex'],
  [/cline/i, 'Cline'],
  [/roo-?code/i, 'Roo Code'],
  [/kilo-?code/i, 'Kilo Code'],
  [/cursor/i, 'Cursor'],
  [/windsurf/i, 'Windsurf'],
  // Chat frontends
  [/cherrystudio/i, 'Cherry Studio'],
  [/chatbox/i, 'ChatBox'],
  [/lobe-?chat|lobehub/i, 'LobeChat'],
  [/nextchat|chatgpt-?next-?web/i, 'NextChat'],
  [/open-?webui/i, 'Open WebUI'],
  [/librechat/i, 'LibreChat'],
  [/dify/i, 'Dify'],
  [/fastgpt/i, 'FastGPT'],
  // IDE / editor integrations
  [/visual-?studio-?code|vscode/i, 'VS Code'],
  [/jetbrains/i, 'JetBrains'],
  // Official SDKs
  [/openai\/node/i, 'OpenAI SDK (Node)'],
  [/openai\/python/i, 'OpenAI SDK (Python)'],
  [/anthropic/i, 'Anthropic SDK'],
  [/google-?genai|generativelanguage/i, 'Google GenAI SDK'],
  // HTTP libraries (generic fallbacks for home-grown callers)
  [/python-?httpx/i, 'Python httpx'],
  [/python-?requests/i, 'Python requests'],
  [/python-?urllib/i, 'Python urllib'],
  [/aiohttp/i, 'Python aiohttp'],
  [/okhttp/i, 'OkHttp'],
  [/go-http-client/i, 'Go HTTP'],
  [/guzzle/i, 'Guzzle'],
  [/\bdart\//i, 'Dart'],
  [/axios/i, 'Axios'],
  [/undici/i, 'Node fetch (undici)'],
  // API tools
  [/postmanruntime/i, 'Postman'],
  [/insomnia/i, 'Insomnia'],
  [/\bcurl\/|libcurl/i, 'curl'],
  [/wget/i, 'Wget'],
];

/** Max length of an unrecognized UA shown as the badge label. */
const UNKNOWN_LABEL_CAP = 32;

export function clientDisplayName(ua: string): string {
  for (const [pattern, name] of CLIENT_PATTERNS) {
    if (pattern.test(ua)) return name;
  }
  const trimmed = ua.trim();
  return trimmed.length > UNKNOWN_LABEL_CAP
    ? `${trimmed.slice(0, UNKNOWN_LABEL_CAP)}…`
    : trimmed || '—';
}

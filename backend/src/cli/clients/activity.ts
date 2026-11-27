/**
 * Per-client activity ledger — the console Clients page's dynamic sort key.
 *
 * A pure in-memory map, two timestamps per client ADAPTER name (the roster
 * row key; there is no per-instance id — a family adapter is still one row):
 *
 * - `lastActiveAt` — stamped by the gateway's auth gate when an inference
 *   request arrives whose User-Agent fingerprints a known client CLI. The UA
 *   is forgeable and the fingerprint table is deliberately incomplete: this
 *   is DISPLAY-ONLY state (same doctrine as utils/harness-profiles.ts) — it
 *   never gates, rates or routes anything, so a spoofed or unknown UA costs
 *   at most a wrong card position.
 * - `lastSetupAt` — stamped when `setupClient()` hooks a client successfully
 *   (the hooking moment — first takeover or a re-hook alike), so a freshly
 *   hooked client floats up even before it has sent any traffic.
 *
 * Memory-only by design: a gateway restart clears activity, and the roster
 * falls back to `lastSetupAt` then the registry order. Nothing is persisted,
 * nothing leaves the process.
 */

const lastActiveAt = new Map<string, number>();
const lastSetupAt = new Map<string, number>();

/**
 * UA → client-adapter-name fingerprints — first match wins. Only confident,
 * observed wire spellings belong here (measured on real traffic, like the
 * harness-profiles evidence rule); a speculative entry mis-sorts a card.
 * Known CLI User-Agents not listed (kimi, openclaw, dsh, …) simply never
 * move in the sort — add each only once observed.
 */
const UA_MATCHERS: readonly { match: RegExp; client: string }[] = [
  { match: /claude-cli\//i, client: 'claude' },
  { match: /opencode\//i, client: 'opencode' },
  // ChatGPT Desktop and Codex CLI share the one Codex card / ~/.codex hook.
  { match: /chatgpt/i, client: 'codex' },
  { match: /codex/i, client: 'codex' },
];

/** Record that `name` was hooked (setup succeeded) at `at`. */
export function noteClientSetup(name: string, at = Date.now()): void {
  lastSetupAt.set(name, at);
}

/**
 * Stamp activity for the client a request's User-Agent fingerprints, if any.
 * Unknown / absent UAs are a no-op. Called per inference request — keep it
 * allocation-free on the miss path.
 */
export function noteClientActivityFromUserAgent(ua: string | undefined, at = Date.now()): void {
  if (!ua) return;
  for (const entry of UA_MATCHERS) {
    if (entry.match.test(ua)) {
      lastActiveAt.set(entry.client, at);
      return;
    }
  }
}

/** Activity timestamps for the clients the map knows about, keyed by adapter name. */
export function clientActivitySnapshot(): Record<string, { lastActiveAt?: number; lastSetupAt?: number }> {
  const out: Record<string, { lastActiveAt?: number; lastSetupAt?: number }> = {};
  for (const [name, at] of lastSetupAt) out[name] = { lastSetupAt: at };
  for (const [name, at] of lastActiveAt) out[name] = { ...out[name], lastActiveAt: at };
  return out;
}

/** Test reset — clears both maps (activity is process-local state). */
export function resetClientActivity(): void {
  lastActiveAt.clear();
  lastSetupAt.clear();
}

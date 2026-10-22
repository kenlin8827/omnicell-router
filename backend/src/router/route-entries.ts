import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TierLevel, ReasoningEffort } from '../types/router.js';
import { DEFAULT_ROUTE_ENTRIES_MAX } from '../config/defaults.js';
import { RouteEntriesConfig } from '../config/types.js';
import { getEnvPaths } from '../config/env.js';
import { loadConfig } from '../config/index.js';

/**
 * RouteEntry experience table — the persistent memory that replaced the
 * learning flywheel. One entry per NORMALIZED user prompt (sha256 prefix of
 * the whitespace-collapsed text): the tier (and optional effort) that served
 * it well, where it was seen, and how the knowledge was earned.
 *
 * Write whitelist (ADR-0011) — exactly three producers, nothing else:
 *   - 'l2_confident': a Layer 2 judge decision at/above the confidence bar,
 *     recorded after the turn actually served (the served tier is the truth).
 *   - 'correction'  : a retry escalation that the user accepted (the next
 *     message differed — see retry-escalation.ts); the escalated tier/effort
 *     is written back so the NEXT conversation asking the same prompt starts
 *     at the stronger setting.
 *   - 'human'       : a console edit. confidence 1.0, and it can NEVER be
 *     overwritten by the automatic producers (operator intent outranks
 *     observed evidence; delete the row instead).
 *
 * Storage: <envRoot>/data/route-entries.json, whole-file JSON with a debounced
 * save (2s) — the table is bounded (maxEntries LRU by updatedAt), so a full
 * rewrite stays cheap. Crash window loses at most the debounce window of
 * increments; every persisted byte stays consistent.
 *
 * Privacy: the snippet (first 200 chars of the prompt, display/edit aid only)
 * rides `routeEntries.snippetEnabled` (default ON — same default-visible +
 * explicit-opt-out stance as session attachOrigin; the flag turns OFF new
 * snippets without deleting stored ones).
 */

export type RouteEntrySource = 'l2_confident' | 'correction' | 'human';

export interface RouteEntry {
  /** sha256 hex prefix of the normalized prompt (see promptHashOf). */
  promptHash: string;
  tier: TierLevel;
  /** Optional reasoning-effort the entry carries (part of the experience). */
  effort?: ReasoningEffort;
  source: RouteEntrySource;
  /** Judge confidence, or 1.0 for correction/human rows. */
  confidence: number;
  /** Last-touched session ids, most recent first, capped at 20 (LRU bubble). */
  sessions: string[];
  hitCount: number;
  createdAt: number;
  /** Bumped on hit and on write — drives LRU eviction. */
  updatedAt: number;
  /** First 200 chars of the prompt (console display/edit aid; optional). */
  snippet?: string;
}

export interface RouteEntryUpsert {
  promptHash: string;
  tier: TierLevel;
  effort?: ReasoningEffort;
  source: RouteEntrySource;
  confidence: number;
  snippet?: string;
}

const SESSIONS_CAP = 20;
const SAVE_DEBOUNCE_MS = 2_000;
/** Layer 2 decisions at/above this confidence earn an entry (frozen design). */
export const L2_CONFIDENT_THRESHOLD = 0.85;

/** Collapse whitespace and trim: the normalization behind promptHashOf. */
export function normalizePrompt(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Stable prompt identity for the experience table and the retry detector:
 * sha256 of the whitespace-collapsed prompt, hex-prefixed to 16 chars
 * (64 bits — collision-negligible at the table's cap, half the storage).
 * Multimodal content joins its text parts first (same rule as the trace's
 * userPromptSummary).
 */
export function promptHashOf(userText: string): string {
  return crypto.createHash('sha256').update(normalizePrompt(userText), 'utf8').digest('hex').slice(0, 16);
}

interface RouteEntriesFile {
  version: 1;
  entries: Record<string, RouteEntry>;
}

/* ─── Live config gate (decision-capture pattern: console hot-apply) ─────── */

let liveConfig: RouteEntriesConfig | null = null;

/** Seed from disk config until a console save hot-applies a fresher node. */
export function applyRouteEntriesConfig(cfg?: RouteEntriesConfig): RouteEntriesConfig {
  liveConfig = { ...loadConfig().routeEntries, ...cfg };
  return liveConfig;
}

function gate(): RouteEntriesConfig {
  return liveConfig ?? applyRouteEntriesConfig();
}

/** Current gate snapshot (orchestrator + routes read through this). */
export function routeEntriesGate(): RouteEntriesConfig {
  return gate();
}

/* ─── Store ──────────────────────────────────────────────────────────────── */

export class RouteEntryStore {
  private entries = new Map<string, RouteEntry>();
  private filePath: string;
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(getEnvPaths().dataDir, 'route-entries.json');
  }

  /** Load once from disk (absent/corrupt file = empty table, never a throw). */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as RouteEntriesFile;
      for (const e of Object.values(parsed.entries ?? {})) {
        if (e && typeof e.promptHash === 'string' && e.tier) this.entries.set(e.promptHash, e);
      }
    } catch (err: any) {
      console.warn(`[RouteEntries] load failed, starting empty: ${err?.message}`);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, SAVE_DEBOUNCE_MS);
    // Never hold the process open for a debounce flush.
    (this.saveTimer as any)?.unref?.();
  }

  /** Flush immediately (also the test seam). */
  public saveNow(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const file: RouteEntriesFile = {
        version: 1,
        entries: Object.fromEntries(this.entries),
      };
      fs.writeFileSync(this.filePath, JSON.stringify(file, null, 2), 'utf8');
    } catch (err: any) {
      console.warn(`[RouteEntries] save failed: ${err?.message}`);
    }
  }

  /** Exact-hash lookup WITHOUT side effects (pure read for tests/routes). */
  public peek(promptHash: string): RouteEntry | undefined {
    this.ensureLoaded();
    return this.entries.get(promptHash);
  }

  /**
   * Experience hit: returns the entry and registers the touch — hitCount++
   * and the session id LRU-bubbled into `sessions` (cap 20). Lookup and
   * creation both register; that is the 1:m session↔entry bookkeeping.
   */
  public hit(promptHash: string, sessionId?: string): RouteEntry | undefined {
    this.ensureLoaded();
    const entry = this.entries.get(promptHash);
    if (!entry) return undefined;
    entry.hitCount += 1;
    entry.updatedAt = Date.now();
    if (sessionId) {
      entry.sessions = [sessionId, ...entry.sessions.filter((s) => s !== sessionId)].slice(0, SESSIONS_CAP);
    }
    this.scheduleSave();
    return entry;
  }

  /**
   * Whitelisted write. Priority: human > correction > l2_confident — a row
   * never loses certainty. Same-or-stronger source overwrites; a human row
   * is immutable to automatic producers (delete it explicitly instead).
   * Creation registers the originating session too.
   */
  public upsert(input: RouteEntryUpsert, sessionId?: string): RouteEntry {
    this.ensureLoaded();
    const existing = this.entries.get(input.promptHash);
    if (existing?.source === 'human' && input.source !== 'human') {
      return existing; // operator intent is immune to automatic rewrites
    }
    if (existing && SOURCE_RANK[existing.source] > SOURCE_RANK[input.source]) {
      return existing; // correction outranks l2_confident even when older
    }
    const now = Date.now();
    const entry: RouteEntry = existing
      ? {
          ...existing,
          tier: input.tier,
          effort: input.effort,
          source: input.source,
          confidence: input.source === 'human' ? 1.0 : input.confidence,
          // Snippet: first write wins; the flag gates NEW snippets only.
          snippet: existing.snippet ?? (gate().snippetEnabled === false ? undefined : input.snippet),
          updatedAt: now,
        }
      : {
          promptHash: input.promptHash,
          tier: input.tier,
          effort: input.effort,
          source: input.source,
          confidence: input.source === 'human' ? 1.0 : input.confidence,
          sessions: sessionId ? [sessionId] : [],
          hitCount: 0,
          createdAt: now,
          updatedAt: now,
          snippet: gate().snippetEnabled === false ? undefined : input.snippet,
        };
    if (sessionId && existing) {
      entry.sessions = [sessionId, ...entry.sessions.filter((s) => s !== sessionId)].slice(0, SESSIONS_CAP);
    }
    this.entries.set(input.promptHash, entry);
    this.evictToCap();
    this.scheduleSave();
    return entry;
  }

  /** Console edit — always lands as an immutable human row (confidence 1.0). */
  public humanEdit(promptHash: string, tier: TierLevel, effort?: ReasoningEffort, sessionId?: string): RouteEntry | undefined {
    this.ensureLoaded();
    const existing = this.entries.get(promptHash);
    if (!existing) return undefined;
    return this.upsert({ promptHash, tier, effort, source: 'human', confidence: 1.0 }, sessionId);
  }

  public remove(promptHash: string): boolean {
    this.ensureLoaded();
    const removed = this.entries.delete(promptHash);
    if (removed) this.scheduleSave();
    return removed;
  }

  /** Console bulk clear: wipe every learned row in one operator action (human rows included). */
  public clearAll(): number {
    this.ensureLoaded();
    const count = this.entries.size;
    this.entries.clear();
    if (count > 0) this.scheduleSave();
    return count;
  }

  /**
   * LRU eviction: drop lowest-updatedAt rows until within the cap. HUMAN rows
   * are exempt — operator intent outranks capacity pressure (ADR-0011 §2);
   * delete them explicitly instead. If every row is human the table may sit
   * above the cap until the operator prunes it — accepted trade-off.
   */
  private evictToCap(): void {
    const cap = gate().maxEntries ?? DEFAULT_ROUTE_ENTRIES_MAX;
    if (this.entries.size <= cap) return;
    const byAge = [...this.entries.values()]
      .filter((e) => e.source !== 'human')
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const e of byAge) {
      if (this.entries.size <= cap) break;
      this.entries.delete(e.promptHash);
    }
  }

  /** Console listing: text filter (snippet / hash / tier / session ids) + sort key — all DESC with updatedAt tiebreak. */
  public list(opts?: { limit?: number; offset?: number; q?: string; sort?: 'updatedAt' | 'hitCount' | 'sessionCount' }): { rows: RouteEntry[]; total: number } {
    this.ensureLoaded();
    const sort = opts?.sort ?? 'updatedAt';
    const score = (e: RouteEntry): number => (sort === 'sessionCount' ? e.sessions.length : e[sort]);
    let all = [...this.entries.values()].sort((a, b) => score(b) - score(a) || b.updatedAt - a.updatedAt);
    const q = opts?.q?.trim().toLowerCase();
    if (q) {
      all = all.filter(
        (e) =>
          (e.snippet ?? '').toLowerCase().includes(q) ||
          e.promptHash.includes(q) ||
          e.tier.includes(q) ||
          e.sessions.some((s) => s.toLowerCase().includes(q))
      );
    }
    const total = all.length;
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 100;
    return { rows: all.slice(offset, offset + limit), total };
  }

  /** Test seam: drop in-memory state + pending timer. */
  public resetForTests(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.entries.clear();
    this.loaded = false;
  }
}

/** Correction > l2_confident; human sits above both via the guard in upsert. */
const SOURCE_RANK: Record<RouteEntrySource, number> = {
  l2_confident: 0,
  correction: 1,
  human: 2,
};

let store: RouteEntryStore | null = null;

/** Process-wide store (binds to the ACTIVE environment's data dir at first use). */
export function getRouteEntryStore(): RouteEntryStore {
  if (!store) store = new RouteEntryStore();
  return store;
}

/** Test seam: swap the singleton for an isolated instance. */
export function setRouteEntryStoreForTests(s: RouteEntryStore | null): void {
  store = s;
}

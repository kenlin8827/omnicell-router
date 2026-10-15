import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WarnThrottle } from '../observability/warn-throttle.js';

/**
 * Response Tree Store — server-side conversation state for the Responses API
 * (POST /v1/responses, stateful `previous_response_id` mode).
 *
 * Design (gateway-owned stateful emulation):
 * - State belongs to the GATEWAY, not to any upstream provider. Clients send
 *   only a delta plus `previous_response_id`; the store walks the parent chain
 *   and rebuilds the full chat-completions message array. This keeps model
 *   switching and failover fully free (an OpenAI-owned store would pin the
 *   conversation to one provider and break on every ratchet escalation).
 * - Nodes form a TREE: branching (regenerate, fork from an older turn) is
 *   natural — two children of the same parent are two continuations.
 * - Each node remembers the routing sessionId it belonged to, giving the
 *   session layer an exact, client-supplied correlation key (zero ambiguity).
 *
 * Fail-visible rule: a `previous_response_id` that is not in the store
 * (TTL-expired, evicted, or post-restart) MUST surface as a 400 to the
 * client — never silently mint a fresh session. Resolve returns null and the
 * route maps that to an explicit error.
 *
 * Bounds: global FIFO cap + age-based sweep on append. Memory bounds are
 * constants (not product behavior); the ONLY config surface is whether the
 * tree also survives restarts via `enablePersistence` (wired from
 * `responses.persist` — default OFF).
 *
 * L2 recovery log (optional): append-only JSONL mirror of the node tree.
 *   afterResult ──> Map.set (L1, authoritative)
 *                 └─> JSONL append (L2, best-effort — a disk failure only
 *                     warns, NEVER fails the request)
 * boot          ──> read log → TTL filter → replay in createdAt order →
 *                   single cap sweep → atomic compaction (temp + rename)
 * L1 stays the truth: the log exists only to shorten restart amnesia to
 * "the last unflushed turn", which still falls into the 400 full-resend
 * degradation. No consistency problem (single writer, single process).
 */

const MAX_NODES = 20_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h, mirrors upstream store semantics loosely

/** Per-node serialized cap — oversized turns stay in L1 but never hit disk. */
const DEFAULT_MAX_NODE_BYTES = 256 * 1024;
/** Whole-log byte budget enforced at compaction (oldest-first trim). */
const DEFAULT_MAX_TOTAL_MB = 64;
/**
 * Naive cadence compaction: rewrite the log every N appends so stale lines
 * don't accumulate between boots. Ceiling: byte-based triggers would be
 * finer; upgrade path = compact when file bytes exceed a live-bytes ratio.
 */
const COMPACT_EVERY_APPENDS = 1000;

export interface RespNode {
  id: string;
  parent: string | null;
  /** Routing session this turn belonged to (exact session correlation). */
  sessionId: string;
  model: string;
  /** This turn's REQUEST delta, already converted to chat messages. */
  input: ChatMessageLite[];
  /** This turn's final assistant message (chat format). */
  assistant: ChatMessageLite;
  createdAt: number;
}

/** Minimal structural subset of ChatMessage (avoids a type-cycle with routes). */
export interface ChatMessageLite {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface RespStorePersistenceOptions {
  /** JSONL file path (caller resolves it per-environment, e.g. getEnvPaths().dataDir). */
  filePath: string;
  maxNodeBytes?: number;
  maxTotalMB?: number;
}

export interface RespStoreReplayStats {
  loaded: number;
  expired: number;
  /** Lines that failed parse or shape validation (torn tail, corruption). */
  malformed: number;
  /** Nodes above the per-node byte cap — skipped from the replayed state. */
  oversized: number;
}

interface PersistState {
  filePath: string;
  maxNodeBytes: number;
  maxTotalBytes: number;
  /** Serialized append queue — order-preserving, never rejects. */
  writeChain: Promise<void>;
  appendsSinceCompact: number;
  /** In-flight compaction — concurrent callers JOIN it instead of skipping (determinism for clear+compact callers). */
  compactPromise: Promise<void> | null;
}

export function newResponseId(): string {
  return 'resp_' + crypto.randomBytes(12).toString('hex');
}

/** Wire-format guard for replayed lines (JSON.parse gives `any`; the log is disk input). */
function nodeFromJson(raw: unknown): RespNode | null {
  const n = raw as Partial<RespNode> | null;
  if (
    !n ||
    typeof n.id !== 'string' ||
    (n.parent !== null && typeof n.parent !== 'string') ||
    typeof n.sessionId !== 'string' ||
    typeof n.model !== 'string' ||
    typeof n.createdAt !== 'number' ||
    !Array.isArray(n.input) ||
    !n.assistant ||
    typeof n.assistant !== 'object' ||
    n.assistant.role !== 'assistant' ||
    typeof n.assistant.content !== 'string'
  ) {
    return null;
  }
  return n as RespNode;
}

export class RespStore {
  private nodes = new Map<string, RespNode>();
  private persist?: PersistState;
  private readonly warns = new WarnThrottle();

  public append(node: RespNode): void {
    this.nodes.set(node.id, node);
    this.sweep();
    this.persistAppend(node);
  }

  public get(id: string): RespNode | undefined {
    return this.nodes.get(id);
  }

  public get size(): number {
    return this.nodes.size;
  }

  /**
   * Rebuild the full chat-completions message array for a turn that continues
   * from `parentId`, plus the sessionId that turn must bind to.
   * Returns null when the id is unknown (fail-visible at the route).
   */
  public buildMessages(parentId: string): { sessionId: string; messages: ChatMessageLite[] } | null {
    const parent = this.nodes.get(parentId);
    if (!parent) return null;

    // Walk root -> parent. Visited-set guards against theoretical cycles.
    const pathNodes: RespNode[] = [];
    const seen = new Set<string>();
    let cur: RespNode | undefined = parent;
    while (cur) {
      if (seen.has(cur.id)) return null; // corrupt chain: fail-visible
      seen.add(cur.id);
      pathNodes.push(cur);
      cur = cur.parent ? this.nodes.get(cur.parent) : undefined;
    }
    pathNodes.reverse();

    const messages: ChatMessageLite[] = [];
    for (const node of pathNodes) {
      messages.push(...node.input);
      messages.push(node.assistant);
    }
    return { sessionId: parent.sessionId, messages };
  }

  /**
   * FIFO + age sweep. Runs on append: a live conversation's nodes are always
   * the newest inserts, so eviction only ever touches dead conversations.
   * Insertion order == createdAt order as long as nodes enter chronologically
   * (true in-process; replay therefore inserts in createdAt order — red-team
   * R-2: out-of-order replay would evict LIVE nodes).
   */
  private sweep(): void {
    const now = Date.now();
    for (const [id, node] of this.nodes) {
      if (now - node.createdAt > MAX_AGE_MS) this.nodes.delete(id);
    }
    while (this.nodes.size > MAX_NODES) {
      const oldest = this.nodes.keys().next().value;
      if (oldest === undefined) break;
      this.nodes.delete(oldest);
    }
  }

  public clear(): void {
    this.nodes.clear();
    // A cleared store must not resurrect its conversations on next boot.
    if (this.persist) void this.compact();
  }

  /* ─── L2 recovery log ─────────────────────────────────────────────────── */

  /**
   * Attach the on-disk recovery log and replay whatever it holds. Synchronous
   * read/replay (boot-time only); writes stay queued best-effort. Never throws
   * for a missing file; an unreadable one warns and degrades to memory-only.
   * Call before the first `append` of the process for the log to be complete.
   */
  public enablePersistence(opts: RespStorePersistenceOptions): RespStoreReplayStats {
    if (this.persist) throw new Error('[resp-store] persistence already enabled');
    const stats: RespStoreReplayStats = { loaded: 0, expired: 0, malformed: 0, oversized: 0 };

    this.persist = {
      filePath: opts.filePath,
      maxNodeBytes: opts.maxNodeBytes ?? DEFAULT_MAX_NODE_BYTES,
      maxTotalBytes: (opts.maxTotalMB ?? DEFAULT_MAX_TOTAL_MB) * 1024 * 1024,
      writeChain: Promise.resolve(),
      appendsSinceCompact: 0,
      compactPromise: null,
    };

    try {
      fs.mkdirSync(path.dirname(opts.filePath), { recursive: true });
    } catch (err) {
      this.warns.warn('resp-store-mkdir', `[resp-store] cannot create log directory: ${(err as Error).message}`);
    }

    let raw = '';
    try {
      raw = fs.readFileSync(opts.filePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.warns.warn('resp-store-log-unreadable',
          `[resp-store] recovery log unreadable (${code ?? (err as Error).message}) — booting memory-only; new turns will rewrite the log.`);
      }
      return stats;
    }

    const now = Date.now();
    const replay: RespNode[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > this.persist.maxNodeBytes) {
        stats.oversized++;
        continue;
      }
      let node: RespNode | null = null;
      try {
        node = nodeFromJson(JSON.parse(line));
      } catch {
        stats.malformed++; // torn tail or corruption: skip-and-warn, never block boot
        continue;
      }
      if (!node) {
        stats.malformed++;
        continue;
      }
      if (now - node.createdAt > MAX_AGE_MS) {
        stats.expired++;
        continue;
      }
      replay.push(node);
    }

    // Chronological insert so Map insertion order stays == createdAt order
    // (the FIFO sweep depends on it). Single sweep after the bulk load —
    // per-append sweeps here would be O(n²) at the 20k cap.
    replay.sort((a, b) => a.createdAt - b.createdAt);
    for (const node of replay) {
      if (!this.nodes.has(node.id)) this.nodes.set(node.id, node);
    }
    stats.loaded = replay.length;
    this.sweep();

    if (stats.expired || stats.malformed || stats.oversized) {
      void this.compact(); // one-time rewrite so garbage does not linger until the next cadence
    }
    return stats;
  }

  /** Queue one serialized line. Fire-and-forget by contract: failures warn, never throw. */
  private persistAppend(node: RespNode): void {
    const p = this.persist;
    if (!p) return;
    let line: string;
    try {
      line = JSON.stringify(node) + '\n';
    } catch (err) {
      this.warns.warn('resp-store-serialize', `[resp-store] cannot serialize node for the recovery log: ${(err as Error).message}`);
      return;
    }
    const bytes = Buffer.byteLength(line);
    if (bytes > p.maxNodeBytes) {
      this.warns.warn('resp-store-oversized',
        `[resp-store] node ${node.id} (${bytes}B) exceeds the per-node cap — kept in memory only, it will not survive a restart.`);
      return;
    }
    p.appendsSinceCompact++;
    p.writeChain = p.writeChain
      .then(() => fs.promises.appendFile(p.filePath, line, { mode: 0o600 }))
      .catch((err) => {
        // Disk is an optimization target, never a request dependency.
        this.warns.warn('resp-store-write-failed',
          `[resp-store] recovery log write failed (${(err as Error).message}) — persistence degraded to memory-only until the next successful write.`);
      });
    if (p.appendsSinceCompact >= COMPACT_EVERY_APPENDS && !p.compactPromise) {
      p.appendsSinceCompact = 0;
      void this.compact();
    }
  }

  /**
   * Atomic rewrite of the log from live L1 state: TTL-passed nodes gone,
   * oldest-first trim to the byte budget, 0600, temp+rename. Concurrent
   * appends continue landing in the file between snapshot and rename; they
   * are all present in L1 too, and replay de-dupes by id on load, so a lost
   * or doubled tail line degrades at worst to the existing 400 path.
   */
  public async compact(): Promise<void> {
    const p = this.persist;
    if (!p) return;
    if (p.compactPromise) {
      await p.compactPromise; // join the in-flight rewrite — the file is current after it
      return;
    }
    const run = (async () => {
      try {
        await p.writeChain; // drain queued appends before rewriting
        const now = Date.now();
        const live = [...this.nodes.values()]
          .filter((n) => now - n.createdAt <= MAX_AGE_MS)
          .sort((a, b) => a.createdAt - b.createdAt);
        let budget = p.maxTotalBytes;
        const kept: string[] = [];
        for (let i = live.length - 1; i >= 0; i--) {
          const line = JSON.stringify(live[i]) + '\n';
          const bytes = Buffer.byteLength(line);
          if (bytes > p.maxNodeBytes) continue;
          if (bytes > budget) break;
          budget -= bytes;
          kept.unshift(line);
        }
        const tmp = `${p.filePath}.tmp`;
        await fs.promises.writeFile(tmp, kept.join(''), { mode: 0o600 });
        await fs.promises.rename(tmp, p.filePath);
        p.appendsSinceCompact = 0;
      } catch (err) {
        this.warns.warn('resp-store-compaction-failed',
          `[resp-store] recovery log compaction failed (${(err as Error).message}) — the old log file stays in effect.`);
      } finally {
        p.compactPromise = null;
      }
    })();
    p.compactPromise = run;
    await run;
  }

  /** Resolve once every queued append has run (errors already swallowed). Tests + shutdown. */
  public flushPersistence(): Promise<void> {
    return this.persist ? this.persist.writeChain : Promise.resolve();
  }
}

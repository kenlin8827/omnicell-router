import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WarnThrottle } from '../observability/warn-throttle.js';
import type { InputItem, OutputItem } from '../ir/types.js';
import type { ChatCompletionResponse, ChatMessage } from '../types/openai.js';
import { chatRequestToIR, chatResponseToIR } from '../ir/adapters/openai-chat.js';

/**
 * Gateway-owned Responses conversation tree. Every node stores canonical input
 * and output items, so continuation works across providers without reducing
 * reasoning, multimodal tool output or item ids to Chat Completions messages.
 */
const MAX_NODES = 20_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_NODE_BYTES = 256 * 1024;
const DEFAULT_MAX_TOTAL_MB = 64;
const COMPACT_EVERY_APPENDS = 1000;

export interface RespNode {
  v: 2;
  id: string;
  parent: string | null;
  sessionId: string;
  model: string;
  input: InputItem[];
  output: OutputItem[];
  createdAt: number;
}

export interface RespStorePersistenceOptions {
  filePath: string;
  maxNodeBytes?: number;
  maxTotalMB?: number;
}

export interface RespStoreReplayStats {
  loaded: number;
  expired: number;
  malformed: number;
  oversized: number;
}

interface PersistState {
  filePath: string;
  maxNodeBytes: number;
  maxTotalBytes: number;
  writeChain: Promise<void>;
  appendsSinceCompact: number;
  compactPromise: Promise<void> | null;
  compactDirty: boolean;
}

export function newResponseId(): string {
  return 'resp_' + crypto.randomBytes(12).toString('hex');
}

/** Explicit v1 recovery-log migration; the live store is IR-only. */
function nodeFromJson(raw: unknown): RespNode | null {
  const n = raw as Partial<RespNode> & {
    assistant?: { role: 'assistant'; content: string; tool_calls?: unknown[]; reasoning_content?: string; refusal?: string };
  };
  if (!n || typeof n.id !== 'string' || (n.parent !== null && typeof n.parent !== 'string') ||
    typeof n.sessionId !== 'string' || typeof n.model !== 'string' || typeof n.createdAt !== 'number' ||
    !Array.isArray(n.input)) return null;
  if (n.v === 2) return Array.isArray(n.output) ? n as RespNode : null;
  if (!n.assistant || n.assistant.role !== 'assistant' || typeof n.assistant.content !== 'string') return null;
  try {
    const input = chatRequestToIR({
      model: n.model, stream: false, messages: n.input as unknown as ChatMessage[],
    }).input;
    const legacy: ChatCompletionResponse = {
      id: n.id, object: 'chat.completion', created: Math.floor(n.createdAt / 1000), model: n.model,
      choices: [{
        index: 0, finish_reason: 'stop',
        message: {
          role: 'assistant', content: n.assistant.content,
          ...(n.assistant.tool_calls ? { tool_calls: n.assistant.tool_calls as ChatCompletionResponse['choices'][number]['message']['tool_calls'] } : {}),
          ...(n.assistant.reasoning_content ? { reasoning_content: n.assistant.reasoning_content } : {}),
          ...(n.assistant.refusal ? { refusal: n.assistant.refusal } : {}),
        },
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    return {
      v: 2, id: n.id, parent: n.parent, sessionId: n.sessionId, model: n.model,
      input, output: chatResponseToIR(legacy).output, createdAt: n.createdAt,
    };
  } catch {
    return null;
  }
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

  /** Rebuild canonical history through the parent, preserving item boundaries. */
  public buildInput(parentId: string): { sessionId: string; input: InputItem[] } | null {
    const parent = this.nodes.get(parentId);
    if (!parent) return null;
    const pathNodes: RespNode[] = [];
    const seen = new Set<string>();
    let cur: RespNode | undefined = parent;
    while (cur) {
      if (seen.has(cur.id)) return null;
      seen.add(cur.id);
      pathNodes.push(cur);
      cur = cur.parent ? this.nodes.get(cur.parent) : undefined;
    }
    pathNodes.reverse();
    const input: InputItem[] = [];
    for (const node of pathNodes) {
      input.push(...node.input, ...node.output);
    }
    return { sessionId: parent.sessionId, input };
  }

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
    if (this.persist) void this.compact();
  }

  /**
   * Purge every node of ONE session (console session delete). Chain nodes are
   * session-scoped by construction: a continuation inherits the parent's
   * `sessionId`, so a whole chain disappears together. Mirrors `clear()`'s
   * disk discipline — with persistence on, the recovery log is rewritten so
   * the purged conversation cannot be replayed on the next boot.
   *
   * Deleting the nodes is what makes the session delete durable: a surviving
   * node would rebuild its input and rebind `routerOptions.sessionId` on the
   * client's next `previous_response_id` turn, re-minting the session the
   * operator just deleted.
   */
  public deleteBySession(sessionId: string): number {
    let removed = 0;
    for (const [id, node] of this.nodes) {
      if (node.sessionId !== sessionId) continue;
      this.nodes.delete(id);
      removed++;
    }
    if (removed > 0 && this.persist) void this.compact();
    return removed;
  }

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
      compactDirty: false,
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
        stats.malformed++;
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
    replay.sort((a, b) => a.createdAt - b.createdAt);
    for (const node of replay) {
      if (!this.nodes.has(node.id)) this.nodes.set(node.id, node);
    }
    stats.loaded = replay.length;
    this.sweep();
    if (stats.expired || stats.malformed || stats.oversized) void this.compact();
    return stats;
  }

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
        this.warns.warn('resp-store-write-failed',
          `[resp-store] recovery log write failed (${(err as Error).message}) — persistence degraded to memory-only until the next successful write.`);
      });
    if (p.appendsSinceCompact >= COMPACT_EVERY_APPENDS && !p.compactPromise) {
      p.appendsSinceCompact = 0;
      void this.compact();
    }
  }

  public async compact(): Promise<void> {
    const p = this.persist;
    if (!p) return;
    p.compactDirty = true;
    if (p.compactPromise) {
      await p.compactPromise;
      return;
    }
    const run = (async () => {
      try {
        while (p.compactDirty) {
          p.compactDirty = false;
          // Serialize compaction onto `writeChain` so concurrent `appendFile`
          // calls queue after `rename` instead of being overwritten, and re-run
          // if a delete/clear arrives while a compaction step is in flight.
          const step = p.writeChain
            .then(async () => {
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
            })
            .catch((err) => {
              this.warns.warn('resp-store-compaction-failed',
                `[resp-store] recovery log compaction failed (${(err as Error).message}) — the old log file stays in effect.`);
            });
          p.writeChain = step;
          await step;
        }
      } finally {
        p.compactPromise = null;
      }
    })();
    p.compactPromise = run;
    await run;
  }

  public async flushPersistence(): Promise<void> {
    const p = this.persist;
    if (!p) return;
    while (true) {
      const target = p.compactPromise ?? p.writeChain;
      await target;
      if (!p.compactPromise && p.writeChain === target) return;
    }
  }
}

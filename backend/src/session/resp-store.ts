import crypto from 'node:crypto';

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
 * Bounds: global FIFO cap + age-based sweep on append. Local single-user
 * gateway scale — no config surface (constants below are memory bounds, not
 * product behavior).
 */

const MAX_NODES = 20_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h, mirrors upstream store semantics loosely

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

export function newResponseId(): string {
  return 'resp_' + crypto.randomBytes(12).toString('hex');
}

export class RespStore {
  private nodes = new Map<string, RespNode>();

  public append(node: RespNode): void {
    this.nodes.set(node.id, node);
    this.sweep();
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
    const path: RespNode[] = [];
    const seen = new Set<string>();
    let cur: RespNode | undefined = parent;
    while (cur) {
      if (seen.has(cur.id)) return null; // corrupt chain: fail-visible
      seen.add(cur.id);
      path.push(cur);
      cur = cur.parent ? this.nodes.get(cur.parent) : undefined;
    }
    path.reverse();

    const messages: ChatMessageLite[] = [];
    for (const node of path) {
      messages.push(...node.input);
      messages.push(node.assistant);
    }
    return { sessionId: parent.sessionId, messages };
  }

  /**
   * FIFO + age sweep. Runs on append: a live conversation's nodes are always
   * the newest inserts, so eviction only ever touches dead conversations.
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
  }
}

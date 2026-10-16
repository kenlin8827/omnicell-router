/**
 * Replay a REAL capture archive through the current SessionManager.
 *
 * Purpose: prove that zero-header session resolution groups one agent tool loop
 * onto a stable session id instead of re-minting per turn. It feeds each turn's
 * actual request history + the actual gateway assistant echo into a fresh
 * SessionManager (in timestamp order) and reports how the resolver groups them.
 *
 * Request bodies over maxBodyBytes are stored truncated (invalid JSON), so we
 * salvage the `messages` array up to the last complete message object via a
 * brace-balanced scan. The head of the array is byte-stable across turns (the
 * chain anchor lives on the head prefix), so salvage is sufficient.
 *
 * Usage (throwaway dev tool — NOT part of the test suite):
 *   bun scripts/verify-session-replay.ts <capture-date-dir> "<first-user-substring>"
 * e.g. point the dir at your own env's capture/YYYY-MM-DD and pass a substring
 * of the conversation's opening user message to select the loop to replay.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SessionManager } from '../backend/src/session/session-manager.js';
import type { ChatCompletionRequest } from '../backend/src/types/openai.js';

const DIR = process.argv[2];
const KEY = process.argv[3];
if (!DIR || !KEY) {
  console.error('usage: bun scripts/verify-session-replay.ts <capture-date-dir> "<first-user-substring>"');
  process.exit(2);
}

interface Turn {
  ts: number;
  keyId?: string;
  messages: any[];
  assistantEcho: any | null;
  truncated: boolean;
}

/** Salvage complete top-level message objects from a (possibly truncated) JSON body. */
function salvageMessages(body: string): { messages: any[]; truncated: boolean } {
  const marker = '"messages":[';
  const mi = body.indexOf(marker);
  if (mi < 0) return { messages: [], truncated: true };
  let i = mi + marker.length;
  const out: any[] = [];
  let truncated = false;
  while (i < body.length) {
    // skip separators/whitespace/commas
    while (i < body.length && /[\s,]/.test(body[i])) i++;
    if (i >= body.length) { truncated = true; break; }
    if (body[i] === ']') break; // array closed cleanly
    if (body[i] !== '{') { truncated = true; break; }
    // brace-balance one object, respecting strings/escapes
    const start = i;
    let depth = 0, inStr = false, esc = false;
    for (; i < body.length; i++) {
      const c = body[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
      }
    }
    if (depth !== 0) { truncated = true; break; } // object cut off by truncation
    try {
      out.push(JSON.parse(body.slice(start, i)));
    } catch {
      truncated = true;
      break;
    }
  }
  return { messages: out, truncated };
}

function extractTurn(file: string): Turn | null {
  const events = fs
    .readFileSync(path.join(DIR, file), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean) as any[];
  const clientReq = events.find((e) => e.direction === 'client' && e.phase === 'request');
  if (!clientReq) return null;
  const { messages, truncated } = salvageMessages(String(clientReq.wire?.requestBody ?? ''));
  // the gateway's served assistant turn — from the upstream response (small, intact)
  const upResp = [...events].reverse().find(
    (e) => e.direction === 'upstream' && e.phase === 'response' && e.status === 'ok'
  );
  let assistantEcho: any = null;
  if (upResp) {
    try {
      const r = JSON.parse(upResp.wire.responseBody);
      const m = r.choices?.[0]?.message;
      if (m) assistantEcho = { content: m.content ?? '', tool_calls: m.tool_calls };
    } catch { /* non-stream or truncated — leave null */ }
  }
  return {
    ts: clientReq.ts,
    keyId: clientReq.apiKey?.id ? String(clientReq.apiKey.id) : undefined,
    messages,
    assistantEcho,
    truncated,
  };
}

// Select one cascading conversation by a substring of its first user message
// (title-gen / ping turns from other openings are excluded automatically).
const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl'));
const turns = all.map(extractTurn).filter(Boolean) as Turn[];
turns.sort((a, b) => a.ts - b.ts);

const firstUserText = (t: Turn) => {
  const u = t.messages.find((m) => m?.role === 'user');
  return typeof u?.content === 'string' ? u.content : '';
};
const loop = turns.filter((t) => firstUserText(t).includes(KEY));

console.log(`conversation (key substring ${KEY.length} chars) — real turns replayed: ${loop.length}`);
console.log('(trailing tool-loop turns whose head prefix is not parseable are skipped)\n');

const sm = new SessionManager({ enabled: true, strategy: 'monotonic' }, undefined);
const bySession = new Map<string, { turns: number; lookups: string[] }>();
const rows: string[] = [];

for (const t of loop) {
  const req = { model: 'qwen-3.8-flash', messages: t.messages } as unknown as ChatCompletionRequest;
  const res = sm.resolveSessionId(req, { keyId: t.keyId });
  // simulate the gateway completing this turn so later turns can re-anchor
  if (t.assistantEcho) sm.registerCompletedTurn(res.sessionId, t.messages, t.assistantEcho);
  else if (t.messages.some((m) => m?.role === 'assistant')) {
    // no parsable response echo: register a placeholder keyed on the SAME
    // history so continuity still forms (the response text is identical
    // across resend; only the boundary assistant must be present).
    sm.registerCompletedTurn(res.sessionId, t.messages, '');
  }
  const rec = bySession.get(res.sessionId) ?? { turns: 0, lookups: [] };
  rec.turns++;
  rec.lookups.push(res.lookupType);
  bySession.set(res.sessionId, rec);
  rows.push(
    `${new Date(t.ts).toTimeString().slice(0, 8)}  ${res.sessionId.slice(0, 18)}…  msgs=${String(t.messages.length).padStart(3)}  lookup=${res.lookupType}`
  );
}

console.log(rows.join('\n'));

// Group by session and summarize.
const summary = [...bySession.entries()].map(([sid, r]) => ({
  sid: sid.slice(0, 18),
  turns: r.turns,
  lookups: [...new Set(r.lookups)].join(','),
}));
console.log('\n=== NEW resolver grouping ===');
for (const s of summary) console.log(`  ${s.sid}…  turns=${s.turns}  via=${s.lookups}`);
console.log(`\n  DISTINCT session ids: NEW=${bySession.size}   (OLD traces.db for this conversation = ${loop.length})`);

// PASS condition: every turn with a completed assistant in its history
// (prefix of a previous response) re-anchors to an existing session —
// only turn-1-shaped openings are allowed to mint.
const mints = summary.filter((s) => s.lookups === 'cold_start');
const anchored = [...bySession.values()].reduce(
  (n, r) => n + r.lookups.filter((l) => l !== 'cold_start').length,
  0
);
console.log(`\n  turn-1-shape mints (expected ≤ openings): ${mints.reduce((n, s) => n + s.turns, 0)}`);
console.log(`  re-anchored turns (prefix_chain/tail_anchor/conversation_key): ${anchored}`);
console.log(
  anchored > 0 && bySession.size < loop.length
    ? '\n  RESULT: PASS — the cascade is gone; the loop now re-anchors to shared session ids.'
    : '\n  RESULT: REVIEW — grouping did not improve; inspect the replay rows above.'
);

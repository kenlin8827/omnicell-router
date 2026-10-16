import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../src/session/session-manager.js';
import { ChatCompletionRequest } from '../src/types/openai.js';
import { RoutingDecision, TierLevel, TierModelConfig } from '../src/types/router.js';

describe('Monotonic Session Ratchet & Zero-Header Fingerprinting', () => {
  let sessionManager: SessionManager;

  const mockModelFinder = (tier: TierLevel): TierModelConfig => ({
    id: `mock-${tier}-model`,
    provider: `provider-${tier}`,
    realModel: `real-${tier}`,
    pricing: { input: 1, cacheRead: 0.1, output: 2 },
    supportsStreaming: true,
    supportsTools: true,
    supportsJsonSchema: true,
  });

  beforeEach(() => {
    sessionManager = new SessionManager({ enabled: true, strategy: 'monotonic' });
  });

  it('should track conversation across turns using Prefix Chain hash without any headers', () => {
    // Turn 1
    const req1: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'What is the speed of light?' }],
    };

    const resolve1 = sessionManager.resolveSessionId(req1);
    assert.strictEqual(resolve1.lookupType, 'cold_start');
    const sessionId1 = resolve1.sessionId;
    assert.ok(sessionId1.startsWith('sess_'));

    // Turn 1 completes with assistant reply
    const assistantReply1 = 'The speed of light in vacuum is approximately 299,792,458 meters per second.';
    sessionManager.registerCompletedTurn(sessionId1, req1.messages, assistantReply1);

    // Turn 2 (Client sends full conversation history, NO headers)
    const req2: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        { role: 'user', content: 'What is the speed of light?' },
        { role: 'assistant', content: assistantReply1 },
        { role: 'user', content: 'And in miles per second?' },
      ],
    };

    const resolve2 = sessionManager.resolveSessionId(req2);
    assert.strictEqual(resolve2.lookupType, 'prefix_chain', 'Should locate session via prefix chain hash of prior turn');
    assert.strictEqual(resolve2.sessionId, sessionId1, 'Session ID must match across turns');
  });

  it('should enforce Monotonic Ratchet: allow escalation, block downgrade, and preserve pinned model', () => {
    const sessionId = 'test-session-ratchet-1';

    // Turn 1: Simple greeting -> lite
    const decisionTurn1: RoutingDecision = {
      targetTier: 'lite',
      confidence: 0.95,
      reason: 'Simple greeting',
      needsSchemaValidation: false,
      features: {
        tokenCountEstimate: 5,
        hasCode: false,
        hasMathOrProof: false,
        hasMultiTurn: false,
        hasToolsOrSchema: false,
        complexityScore: 1.0,
      },
    };

    const r1 = sessionManager.applyRatchet(sessionId, decisionTurn1, mockModelFinder);
    assert.strictEqual(r1.finalDecision.targetTier, 'lite');
    assert.strictEqual(r1.session.pinnedModel, 'mock-lite-model');
    assert.strictEqual(r1.ratchetApplied, false);

    // Turn 2: Complex architecture task -> plus (Escalation triggered!)
    const decisionTurn2: RoutingDecision = {
      targetTier: 'plus',
      confidence: 0.90,
      reason: 'Complex distributed system refactoring',
      needsSchemaValidation: false,
      features: {
        tokenCountEstimate: 800,
        hasCode: true,
        hasMathOrProof: false,
        hasMultiTurn: true,
        hasToolsOrSchema: false,
        complexityScore: 6.0,
      },
    };

    const r2 = sessionManager.applyRatchet(sessionId, decisionTurn2, mockModelFinder);
    assert.strictEqual(r2.finalDecision.targetTier, 'plus', 'Should allow upward escalation to plus');
    assert.strictEqual(r2.session.maxTier, 'plus');
    assert.strictEqual(r2.session.pinnedModel, 'mock-plus-model');
    assert.strictEqual(r2.ratchetApplied, true);
    // Session rewrites overwrite code+params, not just the string
    assert.strictEqual(r2.finalDecision.reasonCode, 'session.escalated');
    assert.deepStrictEqual(r2.finalDecision.reasonParams, { from: 'lite', to: 'plus' });

    // Turn 3: User says short follow-up "OK thanks" -> classified in isolation as lite
    // Monotonic Ratchet must BLOCK downgrade to lite and keep plus with pinned model!
    const decisionTurn3: RoutingDecision = {
      targetTier: 'lite',
      confidence: 0.92,
      reason: 'Casual gratitude',
      needsSchemaValidation: false,
      features: {
        tokenCountEstimate: 3,
        hasCode: false,
        hasMathOrProof: false,
        hasMultiTurn: true,
        hasToolsOrSchema: false,
        complexityScore: 1.0,
      },
    };

    const r3 = sessionManager.applyRatchet(sessionId, decisionTurn3, mockModelFinder);
    assert.strictEqual(r3.finalDecision.targetTier, 'plus', 'Downgrade must be blocked! Locked to plus quality');
    assert.strictEqual(r3.session.pinnedModel, 'mock-plus-model', 'Must reuse pinned model to guarantee 100% KV cache hit');
    assert.strictEqual(r3.ratchetApplied, true, 'Ratchet applied flag must be true');
    assert.strictEqual(r3.finalDecision.reasonCode, 'session.ratchet', 'Downgrade interception carries the session.ratchet code');
    assert.ok(r3.finalDecision.reason.includes('Monotonic Ratchet'));
  });

  it('should respect explicit session headers when provided by client', () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Anything' }],
    };

    // Client passes custom header
    const resolve = sessionManager.resolveSessionId(req, {
      headers: { 'x-session-id': 'custom-enterprise-session-888' },
    });

    assert.strictEqual(resolve.lookupType, 'explicit_header');
    assert.strictEqual(resolve.sessionId, 'custom-enterprise-session-888');
  });

  it('should support OpenAI native request.user field as session identity', () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Anything' }],
      user: 'openai-user-guid-999',
    };

    const resolve = sessionManager.resolveSessionId(req);
    assert.strictEqual(resolve.lookupType, 'request_user');
    assert.strictEqual(resolve.sessionId, 'openai-user-guid-999');
  });

  it('must NEVER merge two cold-start conversations that share the same first message', () => {
    const reqA: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: '继续' }],
    };
    const reqB: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: '继续' }],
    };

    const resolveA = sessionManager.resolveSessionId(reqA);
    const resolveB = sessionManager.resolveSessionId(reqB);

    assert.strictEqual(resolveA.lookupType, 'cold_start');
    assert.strictEqual(resolveB.lookupType, 'cold_start');
    assert.notStrictEqual(
      resolveA.sessionId,
      resolveB.sessionId,
      'Identical first messages from the same key are distinct conversations — a turn-1-shaped resend always mints; the conversation key never merges before a completed exchange'
    );
  });

  it('should extract the embedded session UUID from the Claude Code metadata.user_id convention', () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Anything' }],
      // Claude Code sends: user_{hash}_account_{uuid}_session_{uuid}
      user: 'user_c03d325e349e0b47f2a8336e13d5eaf9d05c9efefc4806eb0b3b791d5d2bbc4e_account_7bb46d46-8baa-438c-a46c-1f53417c3f9b_session_6f978fa1-8a13-4a42-9f77-65bef0e6802f',
    };

    const resolve = sessionManager.resolveSessionId(req);
    assert.strictEqual(resolve.lookupType, 'embedded_user_id');
    assert.strictEqual(resolve.sessionId, 'cc_6f978fa1-8a13-4a42-9f77-65bef0e6802f');
  });

  it('must NOT promote ordinary user ids that merely contain "_session_" (loose-suffix false merge)', () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Anything' }],
      user: 'corp_alice_session_workstation7',
    };

    const resolve = sessionManager.resolveSessionId(req);
    assert.strictEqual(resolve.lookupType, 'request_user', 'Non-Claude-Code-shaped ids stay user-level');
    assert.strictEqual(resolve.sessionId, 'corp_alice_session_workstation7');
  });

  it('must distinguish pure tool-call assistant turns in anchor hashes (no headless false merge)', () => {
    const u1 = 'List the files';
    const tcX = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_A', type: 'function', function: { name: 'list_files', arguments: '{}' } }],
    };
    const tcY = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_B', type: 'function', function: { name: 'read_file', arguments: '{"p":"a"}' } }],
    };

    // Session A: first turn ended in a pure tool-call.
    const rA = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: u1 }] }
    );
    const sidA = rA.sessionId;
    sessionManager.registerCompletedTurn(sidA, [{ role: 'user', content: u1 }, tcX], 'done A');

    // Session B: same first user message, different pure tool-call. Without
    // full-fidelity hashing both chains would serialize identically and share
    // every anchor key.
    const rB = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: u1 }] }
    );
    const sidB = rB.sessionId;
    sessionManager.registerCompletedTurn(sidB, [{ role: 'user', content: u1 }, tcY], 'done B');

    // Replaying each history must return its OWN session — the lossy hash
    // would have merged both onto whichever registered last.
    const replayA = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: u1 }, tcX, { role: 'user', content: 'go on' }] }
    );
    assert.strictEqual(replayA.lookupType, 'prefix_chain');
    assert.strictEqual(replayA.sessionId, sidA, 'Replay of A must not land on B');

    const replayB = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: u1 }, tcY, { role: 'user', content: 'go on' }] }
    );
    assert.strictEqual(replayB.lookupType, 'prefix_chain');
    assert.strictEqual(replayB.sessionId, sidB, 'Replay of B must not land on A');
  });

  it('should treat a harness [system, user] turn-1 shape as cold start (no assistant in history)', () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        { role: 'system', content: 'You are a coding agent.' },
        { role: 'user', content: 'Fix the bug' },
      ],
    };

    const resolve = sessionManager.resolveSessionId(req);
    assert.strictEqual(resolve.lookupType, 'cold_start');
  });

  it('should re-anchor via tail anchors when the client truncates old turns (context-window trim)', () => {
    // Build a 3-turn conversation.
    const u1 = 'What is the speed of light?';
    const a1 = 'About 299,792,458 meters per second.';
    const u2 = 'And in miles per second?';
    const a2 = 'Approximately 186,282 miles per second.';
    const u3 = 'Who measured it first?';
    const a3 = 'Ole Rømer in 1676, using Io eclipse timings.';

    const r1 = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: u1 }] }
    );
    const sid = r1.sessionId;
    sessionManager.registerCompletedTurn(sid, [{ role: 'user', content: u1 }], a1);
    sessionManager.registerCompletedTurn(
      sid,
      [{ role: 'user', content: u1 }, { role: 'assistant', content: a1 }, { role: 'user', content: u2 }],
      a2
    );
    sessionManager.registerCompletedTurn(
      sid,
      [
        { role: 'user', content: u1 }, { role: 'assistant', content: a1 },
        { role: 'user', content: u2 }, { role: 'assistant', content: a2 },
        { role: 'user', content: u3 },
      ],
      a3
    );

    // Client dropped the first two turns to fit its context window and
    // resends the trailing two exchanges plus a new prompt.
    const truncated: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        { role: 'user', content: u2 },
        { role: 'assistant', content: a2 },
        { role: 'user', content: u3 },
        { role: 'assistant', content: a3 },
        { role: 'user', content: 'Thanks, cite the paper' },
      ],
    };

    const resolve = sessionManager.resolveSessionId(truncated);
    assert.strictEqual(resolve.lookupType, 'tail_anchor', 'Truncated history must match a registered tail window');
    assert.strictEqual(resolve.sessionId, sid, 'Truncated continuation must stay in the same session');

    // A single-exchange stub ([u3,a3,new]) no longer probes (windows are
    // length >= 3): accepted false split — it must open a FRESH session, not
    // merge into anything.
    const stub: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        { role: 'user', content: u3 },
        { role: 'assistant', content: a3 },
        { role: 'user', content: 'And in dollars?' },
      ],
    };
    const stubResolve = sessionManager.resolveSessionId(stub);
    assert.strictEqual(stubResolve.lookupType, 'cold_start', 'Below minimum window length: fail towards split');
    assert.notStrictEqual(stubResolve.sessionId, sid);
  });

  it('should re-anchor via the conversation key when only assistant bytes were rewritten (regeneration)', () => {
    const u1 = 'Design a rate limiter.';
    const a1v1 = 'Use a token bucket...';
    const a1v2 = 'A sliding-window counter is better...'; // regenerated, different bytes

    const r1 = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: u1 }] }
    );
    const sid = r1.sessionId;
    sessionManager.registerCompletedTurn(sid, [{ role: 'user', content: u1 }], a1v1);

    // The client discarded a1v1 and resends the SAME first user message with a
    // different assistant reply (regenerated / different provider earlier).
    // The conversation key has a SINGLE unambiguous candidate → rejoin it.
    const regenerated: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        { role: 'user', content: u1 },
        { role: 'assistant', content: a1v2 },
        { role: 'user', content: 'Now in Go, please.' },
      ],
    };

    const resolve = sessionManager.resolveSessionId(regenerated);
    assert.strictEqual(resolve.lookupType, 'conversation_key', 'Chain anchors miss on rewritten bytes; the conversation key must catch it');
    assert.strictEqual(resolve.sessionId, sid, 'Regenerated conversation stays in the same session');
  });

  it('should keep a branched continuation in the original session via chain anchors', () => {
    const u1 = 'Explain event loops.';
    const a1 = 'An event loop processes a queue...';
    const u2a = 'Compare with threads.';
    const a2 = 'Threads preempt; loops cooperate...';

    const r1 = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: u1 }] }
    );
    const sid = r1.sessionId;
    sessionManager.registerCompletedTurn(sid, [{ role: 'user', content: u1 }], a1);
    sessionManager.registerCompletedTurn(
      sid,
      [{ role: 'user', content: u1 }, { role: 'assistant', content: a1 }, { role: 'user', content: u2a }],
      a2
    );

    // The user edits/re-branches at turn 3: history keeps the shared head but
    // no registered prefix matches beyond it — the head-prefix chain anchor
    // still identifies the conversation.
    const branched: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        { role: 'user', content: u1 },
        { role: 'assistant', content: a1 },
        { role: 'user', content: u2a },
        { role: 'assistant', content: a2 },
        { role: 'user', content: 'Actually, compare with goroutines instead.' },
      ],
    };

    const resolve = sessionManager.resolveSessionId(branched);
    assert.strictEqual(resolve.lookupType, 'prefix_chain');
    assert.strictEqual(resolve.sessionId, sid);
  });

  it('must split (not false-merge) when the conversation key is ambiguous — two live sessions share a first message', () => {
    const hi = 'hi';
    const rA = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: hi }] }
    );
    const sidA = rA.sessionId;
    sessionManager.registerCompletedTurn(sidA, [{ role: 'user', content: hi }], 'Reply A');

    // Conversation B starts with the byte-identical first message (a turn-1
    // shaped resend → always a distinct mint).
    const rB = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: hi }] }
    );
    const sidB = rB.sessionId;
    assert.notStrictEqual(sidA, sidB);
    sessionManager.registerCompletedTurn(sidB, [{ role: 'user', content: hi }], 'Reply B');

    // A continues with rewritten assistant bytes: chain/tail anchors miss and
    // the conversation key is now ambiguous (claimed by both A and B). It must
    // cold start — attaching to sidB would be a false merge.
    const cont: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        { role: 'user', content: hi },
        { role: 'assistant', content: 'Rewritten reply bytes' },
        { role: 'user', content: 'next' },
      ],
    };
    const resolve = sessionManager.resolveSessionId(cont);
    assert.strictEqual(resolve.lookupType, 'cold_start', 'Ambiguous conversation key must not re-anchor');
    assert.notStrictEqual(resolve.sessionId, sidB, 'Must never merge into the other conversation');
    assert.notStrictEqual(resolve.sessionId, sidA, 'And never silently pick the first');
  });

  it('RE-ANCHORS a tool-call chain across client byte drift (the production 25-turn cascade)', () => {
    // The gateway's response carries the FULL tool-call object (pretty-printed
    // arguments, "type":"function"); the harness resends it re-serialized
    // (stripped "type", compacted argument JSON). Raw-object hashing missed
    // EVERY such boundary, so the whole tool loop re-minted a fresh session
    // each turn. The canonical serializer absorbs the drift so chain anchors
    // still hit.
    const u1 = 'Inspect the task state machine.';
    const gatewayAssistant = {
      role: 'assistant',
      content: '我先摸清代码。\n\n',
      tool_calls: [
        {
          id: 'call_0b13',
          type: 'function',
          function: { name: 'todo_write', arguments: '{\n  "todos": [ { "content": "定位状态流转", "status": "in_progress" } ]\n}' },
        },
      ],
    };

    const r1 = sessionManager.resolveSessionId({ model: 'auto', messages: [{ role: 'user', content: u1 }] });
    const sid = r1.sessionId;
    // Gateway registers the completed turn with the full assistant message
    // object (content + tool_calls) — NOT a content-only string.
    sessionManager.registerCompletedTurn(sid, [{ role: 'user', content: u1 }], gatewayAssistant);

    // Client resends the assistant turn re-serialized: no "type", compacted
    // (semantically identical) arguments JSON, plus a tool result.
    const resentAssistant = {
      role: 'assistant',
      content: '我先摸清代码。\n\n',
      tool_calls: [
        { id: 'call_0b13', function: { name: 'todo_write', arguments: '{"todos":[{"content":"定位状态流转","status":"in_progress"}]}' } },
      ],
    };
    const turn2: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        { role: 'user', content: u1 },
        resentAssistant,
        { role: 'tool', tool_call_id: 'call_0b13', content: 'Updated todo list.' },
        { role: 'user', content: 'continue' },
      ],
    };

    const resolve = sessionManager.resolveSessionId(turn2, { keyId: 'app-1' });
    assert.strictEqual(resolve.sessionId, sid, 'Tool-call byte drift must NOT split the session');
    assert.ok(
      resolve.lookupType === 'prefix_chain' || resolve.lookupType === 'tail_anchor',
      `Expected an anchor rejoin, got ${resolve.lookupType}`
    );
  });

  it('conversation key survives a gateway restart when persisted (disk snapshot reload)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-sess-'));
    const file = path.join(dir, 'sessions.json');
    try {
      const u1 = 'Persist me across restarts.';
      const mgr1 = new SessionManager({ enabled: true, strategy: 'monotonic' }, file);
      const r1 = mgr1.resolveSessionId({ model: 'auto', messages: [{ role: 'user', content: u1 }] }, { keyId: 'app-9' });
      const sid = r1.sessionId;
      // A regenerated (rewritten) assistant reply makes chain/tail anchors miss;
      // the conversation key must catch it — even from a fresh process.
      mgr1.registerCompletedTurn(sid, [{ role: 'user', content: u1 }], 'original reply bytes');
      mgr1.flushPersist();

      const mgr2 = new SessionManager({ enabled: true, strategy: 'monotonic' }, file);
      const regenerated = sessionRegen(u1, 'totally different regenerated reply', 'follow-up');
      const resolve = mgr2.resolveSessionId(regenerated, { keyId: 'app-9' });
      assert.strictEqual(resolve.lookupType, 'conversation_key');
      assert.strictEqual(resolve.sessionId, sid, 'Reloaded anchors/keys must rejoin the pre-restart session');
    } finally {
      rmrf(dir);
    }
  });

  it('scopes the conversation key to the API-key identity (same message, different key = different session)', () => {
    const u1 = 'Shared opening.';
    const a1 = 'reply';
    const rK1 = sessionManager.resolveSessionId({ model: 'auto', messages: [{ role: 'user', content: u1 }] }, { keyId: 'key-A' });
    sessionManager.registerCompletedTurn(rK1.sessionId, [{ role: 'user', content: u1 }], a1);

    // Same first user message, DIFFERENT api key: the content key differs, so
    // a regenerated continuation under key-B must NOT join key-A's session.
    const regenB = sessionRegen(u1, 'different reply', 'next');
    const resolveB = sessionManager.resolveSessionId(regenB, { keyId: 'key-B' });
    assert.strictEqual(resolveB.lookupType, 'cold_start', 'Different API key → different conversation key → no cross-key merge');
    assert.notStrictEqual(resolveB.sessionId, rK1.sessionId);
  });

  it('attaches immutable birth origin metadata (first-write-wins)', () => {
    const r = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: 'origin test' }] }
    );
    const sid = r.sessionId;
    sessionManager.applyRatchet(sid, {
      targetTier: 'lite',
      confidence: 0.9,
      reason: 'test',
      needsSchemaValidation: false,
      features: {
        tokenCountEstimate: 5,
        hasCode: false,
        hasMathOrProof: false,
        hasMultiTurn: false,
        hasToolsOrSchema: false,
        complexityScore: 1.0,
      },
    }, mockModelFinder);
    sessionManager.attachOrigin(sid, { wire: 'chat', lookupType: r.lookupType }, '1.2.3.4', 'origin test');
    // A later attach with different values must be ignored (no metadata drift).
    sessionManager.attachOrigin(sid, { wire: 'anthropic', lookupType: 'prefix_chain' }, '9.9.9.9', 'HACK');

    const s = sessionManager.getSession(sid)!;
    assert.deepStrictEqual(s.origin, { wire: 'chat', lookupType: 'cold_start', clientIp: '1.2.3.4' });
    assert.strictEqual(s.firstUserMessage, 'origin test');
  });

  it('should purge anchor keys on deleteSession so the conversation cannot re-anchor', () => {
    const u1 = 'Delete me later.';
    const a1 = 'Done.';

    const r1 = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: u1 }] }
    );
    const sid = r1.sessionId;
    // Materialize the session object the way real traffic does (applyRatchet
    // runs between resolve and registration on every request).
    sessionManager.applyRatchet(sid, {
      targetTier: 'lite',
      confidence: 0.9,
      reason: 'test',
      needsSchemaValidation: false,
      features: {
        tokenCountEstimate: 5,
        hasCode: false,
        hasMathOrProof: false,
        hasMultiTurn: false,
        hasToolsOrSchema: false,
        complexityScore: 1.0,
      },
    }, (tier) => ({
      id: `mock-${tier}-model`,
      provider: `provider-${tier}`,
      realModel: `real-${tier}`,
      pricing: { input: 1, cacheRead: 0.1, output: 2 },
      supportsStreaming: true,
      supportsTools: true,
      supportsJsonSchema: true,
    }));
    sessionManager.registerCompletedTurn(sid, [{ role: 'user', content: u1 }], a1);
    assert.strictEqual(sessionManager.deleteSession(sid), true);

    // A continuing client (full history, one exchange) must NOT re-link to the
    // deleted session: chain, tail AND conversation-key entries were all purged.
    const continuation: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        { role: 'user', content: u1 },
        { role: 'assistant', content: a1 },
        { role: 'user', content: 'Again?' },
      ],
    };
    const resolve = sessionManager.resolveSessionId(continuation);
    assert.strictEqual(resolve.lookupType, 'cold_start', 'Deleted session must not be re-anchorable');
    assert.notStrictEqual(resolve.sessionId, sid);
  });
});

// Helpers (module scope) ----------------------------------------------------

function sessionRegen(u1: string, assistantBytes: string, followup: string): ChatCompletionRequest {
  return {
    model: 'auto',
    messages: [
      { role: 'user', content: u1 },
      { role: 'assistant', content: assistantBytes },
      { role: 'user', content: followup },
    ],
  };
}

// Windows-safe cleanup: rmSync on a temp dir right after writes can EBUSY —
// retry a few times and never let teardown fail the file.
function rmrf(dir: string): void {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      /* retry */
    }
  }
}

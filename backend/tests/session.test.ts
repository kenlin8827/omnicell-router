import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
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

    const resolve1 = sessionManager.resolveSessionId(req1, '192.168.1.100');
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

    const resolve2 = sessionManager.resolveSessionId(req2, '192.168.1.100');
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
    const resolve = sessionManager.resolveSessionId(req, '127.0.0.1', {
      'x-session-id': 'custom-enterprise-session-888',
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

    const resolve = sessionManager.resolveSessionId(req, '127.0.0.1');
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

    const resolveA = sessionManager.resolveSessionId(reqA, '127.0.0.1');
    const resolveB = sessionManager.resolveSessionId(reqB, '127.0.0.1');

    assert.strictEqual(resolveA.lookupType, 'cold_start');
    assert.strictEqual(resolveB.lookupType, 'cold_start');
    assert.notStrictEqual(
      resolveA.sessionId,
      resolveB.sessionId,
      'Identical first messages from the same IP are distinct conversations — random mint entropy must separate them'
    );
  });

  it('should extract the embedded session UUID from the Claude Code metadata.user_id convention', () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Anything' }],
      // Claude Code sends: user_{hash}_account_{uuid}_session_{uuid}
      user: 'user_c03d325e349e0b47f2a8336e13d5eaf9d05c9efefc4806eb0b3b791d5d2bbc4e_account_7bb46d46-8baa-438c-a46c-1f53417c3f9b_session_6f978fa1-8a13-4a42-9f77-65bef0e6802f',
    };

    const resolve = sessionManager.resolveSessionId(req, '127.0.0.1');
    assert.strictEqual(resolve.lookupType, 'embedded_user_id');
    assert.strictEqual(resolve.sessionId, 'cc_6f978fa1-8a13-4a42-9f77-65bef0e6802f');
  });

  it('must NOT promote ordinary user ids that merely contain "_session_" (loose-suffix false merge)', () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Anything' }],
      user: 'corp_alice_session_workstation7',
    };

    const resolve = sessionManager.resolveSessionId(req, '127.0.0.1');
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
      { model: 'auto', messages: [{ role: 'user', content: u1 }] },
      '127.0.0.1'
    );
    const sidA = rA.sessionId;
    sessionManager.registerCompletedTurn(sidA, [{ role: 'user', content: u1 }, tcX], 'done A', '127.0.0.1');

    // Session B: same first user message, different pure tool-call. Without
    // full-fidelity hashing both chains would serialize identically and share
    // every anchor key.
    const rB = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: u1 }] },
      '127.0.0.1'
    );
    const sidB = rB.sessionId;
    sessionManager.registerCompletedTurn(sidB, [{ role: 'user', content: u1 }, tcY], 'done B', '127.0.0.1');

    // Replaying each history must return its OWN session — the lossy hash
    // would have merged both onto whichever registered last.
    const replayA = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: u1 }, tcX, { role: 'user', content: 'go on' }] },
      '127.0.0.1'
    );
    assert.strictEqual(replayA.lookupType, 'prefix_chain');
    assert.strictEqual(replayA.sessionId, sidA, 'Replay of A must not land on B');

    const replayB = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: u1 }, tcY, { role: 'user', content: 'go on' }] },
      '127.0.0.1'
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

    const resolve = sessionManager.resolveSessionId(req, '127.0.0.1');
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
      { model: 'auto', messages: [{ role: 'user', content: u1 }] },
      '127.0.0.1'
    );
    const sid = r1.sessionId;
    sessionManager.registerCompletedTurn(sid, [{ role: 'user', content: u1 }], a1, '127.0.0.1');
    sessionManager.registerCompletedTurn(
      sid,
      [{ role: 'user', content: u1 }, { role: 'assistant', content: a1 }, { role: 'user', content: u2 }],
      a2,
      '127.0.0.1'
    );
    sessionManager.registerCompletedTurn(
      sid,
      [
        { role: 'user', content: u1 }, { role: 'assistant', content: a1 },
        { role: 'user', content: u2 }, { role: 'assistant', content: a2 },
        { role: 'user', content: u3 },
      ],
      a3,
      '127.0.0.1'
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

    const resolve = sessionManager.resolveSessionId(truncated, '127.0.0.1');
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
    const stubResolve = sessionManager.resolveSessionId(stub, '127.0.0.1');
    assert.strictEqual(stubResolve.lookupType, 'cold_start', 'Below minimum window length: fail towards split');
    assert.notStrictEqual(stubResolve.sessionId, sid);
  });

  it('should re-anchor via the root map when only assistant bytes were rewritten (regeneration)', () => {
    const u1 = 'Design a rate limiter.';
    const a1v1 = 'Use a token bucket...';
    const a1v2 = 'A sliding-window counter is better...'; // regenerated, different bytes

    const r1 = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: u1 }] },
      '127.0.0.1'
    );
    const sid = r1.sessionId;
    sessionManager.registerCompletedTurn(sid, [{ role: 'user', content: u1 }], a1v1, '127.0.0.1');

    // The client discarded a1v1 and resends the SAME first user message with a
    // different assistant reply (regenerated / different provider earlier).
    const regenerated: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        { role: 'user', content: u1 },
        { role: 'assistant', content: a1v2 },
        { role: 'user', content: 'Now in Go, please.' },
      ],
    };

    const resolve = sessionManager.resolveSessionId(regenerated, '127.0.0.1');
    assert.strictEqual(resolve.lookupType, 'root_anchor', 'Chain anchors miss on rewritten bytes; the root key must catch it');
    assert.strictEqual(resolve.sessionId, sid, 'Regenerated conversation stays in the same session');
  });

  it('should keep a branched continuation in the original session via chain anchors', () => {
    const u1 = 'Explain event loops.';
    const a1 = 'An event loop processes a queue...';
    const u2a = 'Compare with threads.';
    const a2 = 'Threads preempt; loops cooperate...';

    const r1 = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: u1 }] },
      '127.0.0.1'
    );
    const sid = r1.sessionId;
    sessionManager.registerCompletedTurn(sid, [{ role: 'user', content: u1 }], a1, '127.0.0.1');
    sessionManager.registerCompletedTurn(
      sid,
      [{ role: 'user', content: u1 }, { role: 'assistant', content: a1 }, { role: 'user', content: u2a }],
      a2,
      '127.0.0.1'
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

    const resolve = sessionManager.resolveSessionId(branched, '127.0.0.1');
    assert.strictEqual(resolve.lookupType, 'prefix_chain');
    assert.strictEqual(resolve.sessionId, sid);
  });

  it('must tombstone an ambiguous root key instead of false-merging identical-first-message conversations', () => {
    const hi = 'hi';
    const rA = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: hi }] },
      '127.0.0.1'
    );
    const sidA = rA.sessionId;
    sessionManager.registerCompletedTurn(sidA, [{ role: 'user', content: hi }], 'Reply A', '127.0.0.1');

    // Conversation B starts with the byte-identical first message.
    const rB = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: hi }] },
      '127.0.0.1'
    );
    const sidB = rB.sessionId;
    assert.notStrictEqual(sidA, sidB);
    sessionManager.registerCompletedTurn(sidB, [{ role: 'user', content: hi }], 'Reply B', '127.0.0.1');

    // A continues with rewritten assistant bytes: chain/tail anchors miss and
    // the root key is now ambiguous (claimed by both A and B). It must cold
    // start — attaching to sidB would be a false merge.
    const cont: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        { role: 'user', content: hi },
        { role: 'assistant', content: 'Rewritten reply bytes' },
        { role: 'user', content: 'next' },
      ],
    };
    const resolve = sessionManager.resolveSessionId(cont, '127.0.0.1');
    assert.strictEqual(resolve.lookupType, 'cold_start', 'Ambiguous root key must not re-anchor');
    assert.notStrictEqual(resolve.sessionId, sidB, 'Must never merge into the other conversation');
  });

  it('attaches immutable birth origin metadata (first-write-wins)', () => {
    const r = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: 'origin test' }] },
      '1.2.3.4'
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

  it('should purge anchor keys on deleteSession so the conversation cannot re-anchor', () => {    const u1 = 'Delete me later.';
    const a1 = 'Done.';

    const r1 = sessionManager.resolveSessionId(
      { model: 'auto', messages: [{ role: 'user', content: u1 }] },
      '127.0.0.1'
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
    sessionManager.registerCompletedTurn(sid, [{ role: 'user', content: u1 }], a1, '127.0.0.1');
    assert.strictEqual(sessionManager.deleteSession(sid), true);

    // A continuing client (full history, one exchange) must NOT re-link to the
    // deleted session: chain, tail and root keys were all purged.
    const continuation: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        { role: 'user', content: u1 },
        { role: 'assistant', content: a1 },
        { role: 'user', content: 'Again?' },
      ],
    };
    const resolve = sessionManager.resolveSessionId(continuation, '127.0.0.1');
    assert.strictEqual(resolve.lookupType, 'cold_start', 'Deleted session must not be re-anchorable');
    assert.notStrictEqual(resolve.sessionId, sid);
  });
});

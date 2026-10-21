import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionResult } from '../src/types/router.js';
import { buildChatOcrHeaders, buildSystemoneOcrHeaders } from '../src/surfaces/ocr-headers.js';

/**
 * Unit coverage for the frozen X-OCR header sink (ProtocolSurface contract
 * §1.4). The header set is the wire protocol: key list, value formatting,
 * conditional semantics and the `?? / ||` stub defaults are all pinned here
 * so a future edit cannot silently drift a surface again.
 */

/** Full-but-default ExecutionResult fixture; only what the test varies is overridden. */
function chatResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    response: {} as ExecutionResult['response'],
    tierUsed: 'lite',
    modelUsed: 'mock-model',
    fallbackOccurred: false,
    latencyMs: 42,
    ...overrides,
  };
}

const BASE_13 = [
  'X-OCR-Tier',
  'X-OCR-Layer',
  'X-OCR-Model',
  'X-OCR-Failover',
  'X-OCR-Failover-Attempts',
  'X-OCR-Failover-Path',
  'X-OCR-InPlace-Retries',
  'X-OCR-Breaker-State',
  'X-OCR-Session-ID',
  'X-OCR-Session-Ratchet',
  'X-OCR-Session-Lookup',
  'X-OCR-Trace-ID',
  'X-OCR-Latency-MS',
];

describe('buildChatOcrHeaders — frozen base set', () => {
  it('1. plain result emits exactly the 13 base headers, in contract order', () => {
    const headers = buildChatOcrHeaders(chatResult(), 'auto');
    assert.deepStrictEqual(Object.keys(headers), BASE_13);
  });

  it('2. base values follow the frozen formatting rules', () => {
    const headers = buildChatOcrHeaders(
      chatResult({
        fallbackOccurred: true,
        layerUsed: 'layer2',
        failoverOccurred: true,
        failoverAttempts: 3,
        failoverPath: ['a/1', 'b/2', 'c/3'],
        inplaceRetries: 2,
        breakerState: 'HALF_OPEN',
        sessionId: 'sess-7',
        sessionRatchetApplied: true,
        sessionLookupType: 'prefix_chain',
        traceId: 'trace-7',
      }),
      'auto-lite'
    );
    assert.equal(headers['X-OCR-Tier'], 'lite-escalated');
    assert.equal(headers['X-OCR-Layer'], 'layer2');
    assert.equal(headers['X-OCR-Model'], 'mock-model');
    assert.equal(headers['X-OCR-Failover'], 'true');
    assert.equal(headers['X-OCR-Failover-Attempts'], '3');
    assert.equal(headers['X-OCR-Failover-Path'], 'a/1 -> b/2 -> c/3');
    assert.equal(headers['X-OCR-InPlace-Retries'], '2');
    assert.equal(headers['X-OCR-Breaker-State'], 'HALF_OPEN');
    assert.equal(headers['X-OCR-Session-ID'], 'sess-7');
    assert.equal(headers['X-OCR-Session-Ratchet'], 'true');
    assert.equal(headers['X-OCR-Session-Lookup'], 'prefix_chain');
    assert.equal(headers['X-OCR-Trace-ID'], 'trace-7');
    assert.equal(headers['X-OCR-Latency-MS'], '42');
  });

  it('3. X-OCR-Model chain is modelUsed || fallbackModel || auto (C-4)', () => {
    assert.equal(buildChatOcrHeaders(chatResult(), 'gate-model')['X-OCR-Model'], 'mock-model');
    assert.equal(
      buildChatOcrHeaders(chatResult({ modelUsed: '' }), 'gate-model')['X-OCR-Model'],
      'gate-model'
    );
    assert.equal(
      buildChatOcrHeaders(chatResult({ modelUsed: '' }), '')['X-OCR-Model'],
      'auto'
    );
  });
});

describe('buildChatOcrHeaders — conditional Thinking-* / Variant', () => {
  it('4. requestedEffort none or undefined suppresses all three Thinking headers', () => {
    for (const effort of ['none', undefined] as const) {
      const headers = buildChatOcrHeaders(
        chatResult({ requestedEffort: effort, actualEffort: effort, reasoningDegraded: true }),
        'auto'
      );
      assert.equal('X-OCR-Thinking-Requested' in headers, false, `requested=${effort}`);
      assert.equal('X-OCR-Thinking-Actual' in headers, false, `requested=${effort}`);
      assert.equal('X-OCR-Thinking-Degraded' in headers, false, `requested=${effort}`);
    }
  });

  it('5. requested effort adds exactly the three Thinking headers after the base set', () => {
    const headers = buildChatOcrHeaders(
      chatResult({ requestedEffort: 'low', actualEffort: 'medium', reasoningDegraded: true }),
      'auto'
    );
    assert.deepStrictEqual(Object.keys(headers).slice(BASE_13.length), [
      'X-OCR-Thinking-Requested',
      'X-OCR-Thinking-Actual',
      'X-OCR-Thinking-Degraded',
    ]);
    assert.equal(headers['X-OCR-Thinking-Requested'], 'low');
    assert.equal(headers['X-OCR-Thinking-Actual'], 'medium');
    assert.equal(headers['X-OCR-Thinking-Degraded'], 'true');
  });

  it('6. actualEffort falls back to requestedEffort; degraded defaults to false', () => {
    const headers = buildChatOcrHeaders(chatResult({ requestedEffort: 'high' }), 'auto');
    assert.equal(headers['X-OCR-Thinking-Actual'], 'high');
    assert.equal(headers['X-OCR-Thinking-Degraded'], 'false');
  });

  it('6b. effortSource appends X-OCR-Thinking-Source only when known (ADR-0012)', () => {
    const withSource = buildChatOcrHeaders(
      chatResult({ requestedEffort: 'high', actualEffort: 'high', effortSource: 'judge' }),
      'auto'
    );
    assert.equal(withSource['X-OCR-Thinking-Source'], 'judge');
    // No source knowledge → no header (pre-ADR executions stay byte-identical).
    const without = buildChatOcrHeaders(chatResult({ requestedEffort: 'high' }), 'auto');
    assert.equal('X-OCR-Thinking-Source' in without, false);
  });

  it('7. variantUsed appends X-OCR-Variant last; absent otherwise', () => {
    const withVariant = buildChatOcrHeaders(chatResult({ variantUsed: 'strong' }), 'auto');
    assert.equal(withVariant['X-OCR-Variant'], 'strong');
    assert.deepStrictEqual(Object.keys(withVariant).at(-1), 'X-OCR-Variant');
    assert.equal('X-OCR-Variant' in buildChatOcrHeaders(chatResult(), 'auto'), false);
  });

  it('8. thinking + variant combine: 17 keys total', () => {
    const headers = buildChatOcrHeaders(
      chatResult({ requestedEffort: 'low', actualEffort: 'low', variantUsed: 'quick' }),
      'auto'
    );
    assert.equal(Object.keys(headers).length, 17);
  });
});

describe('buildChatOcrHeaders — stub tolerance (frozen ?? / || defaults)', () => {
  it('9. partial stub result never throws and lands on contract defaults', () => {
    // Mirrors forward-proxy test stubs: fields beyond tier/model absent.
    const stub = { response: {}, tierUsed: 'plus', fallbackOccurred: false } as unknown as ExecutionResult;
    const headers = buildChatOcrHeaders(stub, 'stub-fallback');
    assert.equal(headers['X-OCR-Tier'], 'plus');
    assert.equal(headers['X-OCR-Layer'], 'layer0');
    assert.equal(headers['X-OCR-Model'], 'stub-fallback');
    assert.equal(headers['X-OCR-Failover'], 'false');
    assert.equal(headers['X-OCR-Failover-Attempts'], '1');
    assert.equal(headers['X-OCR-Failover-Path'], '');
    assert.equal(headers['X-OCR-InPlace-Retries'], '0');
    assert.equal(headers['X-OCR-Breaker-State'], 'CLOSED');
    assert.equal(headers['X-OCR-Session-ID'], '');
    assert.equal(headers['X-OCR-Session-Ratchet'], 'false');
    assert.equal(headers['X-OCR-Session-Lookup'], '');
    assert.equal(headers['X-OCR-Trace-ID'], '');
    assert.equal(headers['X-OCR-Latency-MS'], '0');
  });

  it('10. nearly-empty object still produces the 13 base keys without throwing', () => {
    const headers = buildChatOcrHeaders({} as unknown as ExecutionResult, 'gate');
    assert.deepStrictEqual(Object.keys(headers), BASE_13);
    assert.equal(headers['X-OCR-Model'], 'gate');
  });
});

describe('buildSystemoneOcrHeaders', () => {
  it('11. emits exactly the three decision-surface headers', () => {
    assert.deepStrictEqual(buildSystemoneOcrHeaders('native/plus-b', 'native', 17), {
      'X-OCR-Model': 'native/plus-b',
      'X-OCR-Systemone-Upstream': 'native',
      'X-OCR-Latency-MS': '17',
    });
    const converted = buildSystemoneOcrHeaders('chat/x', 'converted', 0);
    assert.deepStrictEqual(Object.keys(converted), [
      'X-OCR-Model',
      'X-OCR-Systemone-Upstream',
      'X-OCR-Latency-MS',
    ]);
    assert.equal(converted['X-OCR-Systemone-Upstream'], 'converted');
    assert.equal(converted['X-OCR-Latency-MS'], '0');
  });
});

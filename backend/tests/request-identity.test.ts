import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveClientRequestId,
  mintRequestId,
  mintExchangeId,
  buildTraceparent,
} from '../src/observability/request-identity.js';

/** Only `headers` is read by the resolver — a plain record is enough. */
function fakeReq(headers: Record<string, string | string[] | undefined>) {
  return { headers };
}

describe('resolveClientRequestId — boundary parsing only', () => {
  it('parses W3C traceparent (canonical source) down to the trace-id', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const res = resolveClientRequestId(fakeReq({ traceparent }));
    assert.equal(res.clientRequestId, '0af7651916cd43dd8448eb211c80319c');
    assert.equal(res.source, 'traceparent');
  });

  it('lowercases traceparent hex (OTel canonical form)', () => {
    const res = resolveClientRequestId(
      fakeReq({ traceparent: '00-AABBCC11DD22EE33FF44556677889900-BBBBBBBBBBBBBBBB-01' })
    );
    assert.equal(res.clientRequestId, 'aabbcc11dd22ee33ff44556677889900');
  });

  it('falls through to x-request-id when traceparent is malformed', () => {
    const res = resolveClientRequestId(
      fakeReq({ traceparent: 'not-a-valid-traceparent', 'x-request-id': 'req_abc123def456' })
    );
    assert.equal(res.clientRequestId, 'req_abc123def456');
    assert.equal(res.source, 'x-request-id');
  });

  it('falls through the de-facto header chain', () => {
    assert.equal(resolveClientRequestId(fakeReq({ 'x-trace-id': 'trace_abcdef' })).source, 'x-trace-id');
    assert.equal(
      resolveClientRequestId(fakeReq({ 'x-correlation-id': 'corr_1234' })).source,
      'x-correlation-id'
    );
    assert.equal(resolveClientRequestId(fakeReq({ 'request-id': 'r-1' })).source, 'request-id');
  });

  it('preserves a case-sensitive caller value byte-for-byte', () => {
    // NanoID / base64-ish ids are case-sensitive: any case folding would
    // silently break the correlation join.
    const mixed = 'V1StGXR8_Z5jdHi6B-myT';
    assert.equal(resolveClientRequestId(fakeReq({ 'x-request-id': mixed })).clientRequestId, mixed);
    assert.equal(
      resolveClientRequestId(fakeReq({ 'x-request-id': '550e8400-e29b-41d4-A716-446655440000' })).clientRequestId,
      '550e8400-e29b-41d4-A716-446655440000'
    );
  });

  it('priority: traceparent WINS over x-request-id', () => {
    const res = resolveClientRequestId(
      fakeReq({
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
        'x-request-id': 'should-not-be-used',
      })
    );
    assert.equal(res.source, 'traceparent');
    assert.equal(res.clientRequestId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('never invents a caller value (absent means absent)', () => {
    assert.deepEqual(resolveClientRequestId(fakeReq({})), {});
    assert.deepEqual(resolveClientRequestId(fakeReq({ 'x-request-id': '   ' })), {});
  });

  it('accepts a repeated header array (takes the first value)', () => {
    const res = resolveClientRequestId(fakeReq({ 'x-request-id': ['first', 'second'] }));
    assert.equal(res.clientRequestId, 'first');
  });
});

describe('mintRequestId / mintExchangeId — gateway-owned ids', () => {
  it('request ids are prefixed, 96-bit and unique across mints', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintRequestId()));
    assert.equal(ids.size, 200, 'no entropy collapse across 200 mints');
    for (const id of ids) assert.match(id, /^req_[0-9a-f]{24}$/);
  });

  it('exchange ids are 64-bit hex and unique across mints', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintExchangeId()));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, /^[0-9a-f]{16}$/);
  });

  it('a caller value can repeat while request ids stay distinct (the ADR-0021 invariant)', () => {
    // A client reusing one traceparent for a whole conversation is legal.
    const req = fakeReq({ traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' });
    const turns = [1, 2, 3].map(() => ({
      clientRequestId: resolveClientRequestId(req).clientRequestId,
      requestId: mintRequestId(),
    }));
    assert.equal(new Set(turns.map(t => t.clientRequestId)).size, 1, 'caller value repeats');
    assert.equal(new Set(turns.map(t => t.requestId)).size, 3, 'record keys do not');
  });
});

describe('buildTraceparent — outgoing wire helper', () => {
  it('produces a W3C-compliant traceparent', () => {
    assert.equal(
      buildTraceparent('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'),
      '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01'
    );
  });

  it('round-trips through the inbound parser', () => {
    const traceId = '1234567890abcdef1234567890abcdef';
    const tp = buildTraceparent(traceId, 'fedcba0987654321');
    assert.equal(resolveClientRequestId(fakeReq({ traceparent: tp })).clientRequestId, traceId);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OrderedRelay } from '../../src/forward-proxy/ordered-relay.js';

/**
 * The MITM leg holds the client's plaintext until its loopback hop is
 * connected. This is the contract that keeps the request head ahead of the
 * body: without it, chunks written to the not-yet-connected socket queue ahead
 * of the flushed head and the inner parser answers 400 to a request it never
 * assembled ("request failed with empty body (code 400)").
 */
describe('forward-proxy: ordered relay', () => {
  it('holds everything until attached, then delivers it in arrival order', () => {
    const relay = new OrderedRelay();
    const got: string[] = [];

    relay.push(Buffer.from('head\r\n\r\n'));
    relay.push(Buffer.from('body-1'));
    relay.push(Buffer.from('body-2'));
    assert.equal(relay.held, 3);
    // Nothing may escape before the sink exists — that is the whole point.
    assert.equal(got.length, 0);

    let attachedAfterFlush = false;
    relay.attach(
      (chunk) => got.push(chunk.toString()),
      () => {
        attachedAfterFlush = got.length === 3;
      },
    );

    assert.deepEqual(got, ['head\r\n\r\n', 'body-1', 'body-2']);
    assert.equal(relay.held, 0);
    assert.ok(attachedAfterFlush, 'the caller flips its state only after the backlog landed');

    // Once attached, chunks stream straight through — no reordering, no loss.
    relay.push(Buffer.from('body-3'));
    assert.deepEqual(got, ['head\r\n\r\n', 'body-1', 'body-2', 'body-3']);
    assert.equal(relay.held, 0);
  });

  it('snapshots the held bytes for a sniffer and never consumes them', () => {
    const relay = new OrderedRelay();
    relay.push(Buffer.from('PRI * HTTP/2.0'));
    relay.push(Buffer.from('\r\n\r\nSM\r\n\r\n'));
    assert.equal(relay.snapshot().toString(), 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');
    assert.equal(relay.held, 2, 'snapshot is a copy, the relay still holds both chunks');
    const got: string[] = [];
    relay.attach((chunk) => got.push(chunk.toString()));
    assert.equal(got.join(''), 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');
  });
});

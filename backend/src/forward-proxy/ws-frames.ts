/**
 * WebSocket frame observation (RFC 6455) — ADR-0020.
 *
 * The proxy relays WebSocket bytes verbatim: an upgrade is a single hop, so the
 * client's own handshake and frames are exactly what the origin must see, and
 * nothing is re-serialized or modified. That is a deliberate boundary — vendor
 * SEMANTICS on a claimed host belong to a client-gateway plugin (ADR-0017), not
 * to the core proxy.
 *
 * What the core still owes the operator is OBSERVATION: "the socket is open" is
 * not an answer when a realtime LLM API misbehaves. This module is a streaming,
 * allocation-light frame counter that rides the same chunks the relay forwards
 * — it never buffers a message, never rewrites a byte, and never throws on a
 * hostile stream (an unparseable tail simply stops the count).
 *
 * Directions: `c2s` = client → origin (masked per RFC 6455), `s2c` = origin →
 * client (unmasked). The mask bit is not enforced: this is an observer, not a
 * validator.
 */

export type WsDirection = 'c2s' | 's2c';

export interface WsObservation {
  frames: number;
  /** Data frames (opcode 1/2, continuation excluded) — one per message. */
  messages: number;
  text: number;
  binary: number;
  ping: number;
  pong: number;
  /** Close frame, when one was seen. */
  close?: { code?: number; reason?: string };
  /** Payload bytes (headers excluded), both directions. */
  payloadBytes: number;
  /** true = the frame budget ran out; the counters are a prefix, not a total. */
  truncated: boolean;
}

export interface WsObserver {
  push(dir: WsDirection, chunk: Buffer): void;
  observation(): WsObservation;
  /** One-line ledger suffix: `ws: 12 msg (9 text / 3 binary), 1 ping, close 1000`. */
  note(): string;
}

/** Frame budget: bounded CPU on a hostile or enormous stream. */
const MAX_OBSERVED_FRAMES = 10_000;
/** Per-direction buffer bound — a frame larger than this stops the count. */
const MAX_PENDING_BYTES = 1 << 20;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

interface DirectionState {
  buf: Buffer;
  frames: number;
  messages: number;
  text: number;
  binary: number;
  ping: number;
  pong: number;
  close?: { code?: number; reason?: string };
  payloadBytes: number;
  stopped: boolean;
}

function emptyState(): DirectionState {
  return { buf: Buffer.alloc(0), frames: 0, messages: 0, text: 0, binary: 0, ping: 0, pong: 0, payloadBytes: 0, stopped: false };
}

/** Consume every COMPLETE frame in `st.buf`; leave the partial tail in place. */
function drain(st: DirectionState, budget: () => boolean): void {
  while (!st.stopped) {
    const buf = st.buf;
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_PENDING_BYTES)) {
        st.stopped = true;
        return;
      }
      len = Number(big);
      offset = 10;
    }
    if (masked) offset += 4;
    if (buf.length < offset + len) {
      // Partial frame: keep buffering, but never without bound.
      if (st.buf.length > MAX_PENDING_BYTES) st.stopped = true;
      return;
    }
    if (!budget()) {
      st.stopped = true;
      return;
    }
    st.frames += 1;
    st.payloadBytes += len;
    if (opcode === OP_TEXT) {
      st.text += 1;
      st.messages += 1;
    } else if (opcode === OP_BINARY) {
      st.binary += 1;
      st.messages += 1;
    } else if (opcode === OP_PING) {
      st.ping += 1;
    } else if (opcode === OP_PONG) {
      st.pong += 1;
    } else if (opcode === OP_CLOSE) {
      const payload = buf.subarray(offset, offset + len);
      st.close = {
        ...(payload.length >= 2 ? { code: payload.readUInt16BE(0) } : {}),
        ...(payload.length > 2 ? { reason: payload.subarray(2).toString('utf8') } : {}),
      };
    } else if (opcode !== OP_CONTINUATION) {
      // Unknown opcode (reserved): keep the byte accounting, stop interpreting.
      st.stopped = true;
      return;
    }
    st.buf = buf.subarray(offset + len);
  }
}

export function createWsObserver(): WsObserver {
  const c2s = emptyState();
  const s2c = emptyState();
  let total = 0;
  let truncated = false;
  const budget = (): boolean => {
    total += 1;
    if (total > MAX_OBSERVED_FRAMES) {
      truncated = true;
      return false;
    }
    return true;
  };
  return {
    push(dir: WsDirection, chunk: Buffer): void {
      const st = dir === 'c2s' ? c2s : s2c;
      if (st.stopped) return;
      st.buf = st.buf.length ? Buffer.concat([st.buf, chunk]) : chunk;
      drain(st, budget);
    },
    observation(): WsObservation {
      return {
        frames: c2s.frames + s2c.frames,
        messages: c2s.messages + s2c.messages,
        text: c2s.text + s2c.text,
        binary: c2s.binary + s2c.binary,
        ping: c2s.ping + s2c.ping,
        pong: c2s.pong + s2c.pong,
        ...(c2s.close || s2c.close ? { close: c2s.close ?? s2c.close } : {}),
        payloadBytes: c2s.payloadBytes + s2c.payloadBytes,
        truncated: truncated || c2s.stopped || s2c.stopped,
      };
    },
    note(): string {
      const o = this.observation();
      if (o.frames === 0) return 'ws: no frames';
      const bits = [`ws: ${o.messages} msg (${o.text} text / ${o.binary} binary)`];
      if (o.ping) bits.push(`${o.ping} ping`);
      if (o.pong) bits.push(`${o.pong} pong`);
      if (o.close) bits.push(`close ${o.close.code ?? 'no code'}`);
      if (o.truncated) bits.push('truncated');
      return bits.join(', ');
    },
  };
}

/**
 * Minimal ClientHello SNI extractor + handshake peek.
 *
 * Bun's `node:tls` does not implement `SNICallback` (verified on 1.3.14), so
 * the MITM path cannot ask the TLS stack for the servername — we peek the raw
 * ClientHello off the CONNECT tunnel before handing the socket to the per-host
 * TLS server and read the `server_name` extension ourselves.
 *
 * `peekClientHello` answers the three questions CONNECT admission needs:
 *   - `isTls`    — is this a TLS handshake record at all? (false ⇒ the tunnel is
 *                  not ours to decrypt: SSH, IMAPS, a bespoke protocol, and the
 *                  proxy must relay it immediately instead of buffering);
 *   - `complete` — is the whole handshake record here yet? (false ⇒ read more);
 *   - `sni`      — the requested servername, when the hello carries one.
 *
 * A ClientHello WITHOUT SNI is still a ClientHello. The caller then uses the
 * CONNECT authority as the certificate identity — the only identity the client
 * gave us, and the ONLY option for an IP-literal target (RFC 6066 forbids an IP
 * in SNI, so such a client can never send one). Only a non-TLS stream or a
 * hello that never completes falls back to a blind tunnel.
 *
 * Never throws: the bytes are hostile input read off the network.
 */

export interface ClientHelloPeek {
  /** The buffer starts with a TLS handshake record (type 0x16, version major 0x03). */
  isTls: boolean;
  /** The whole handshake record is buffered (nothing more to wait for). */
  complete: boolean;
  /** The requested servername, when the hello carries a well-formed one. */
  sni?: string;
  /** Offered ALPN protocols, in client-preference order (e.g. ['h2','http/1.1']). */
  alpn?: string[];
}

function incomplete(): ClientHelloPeek {
  return { isTls: true, complete: false };
}

function complete(parsed?: { sni?: string; alpn?: string[] }): ClientHelloPeek {
  return {
    isTls: true,
    complete: true,
    ...(parsed?.sni ? { sni: parsed.sni } : {}),
    ...(parsed?.alpn?.length ? { alpn: parsed.alpn } : {}),
  };
}

/**
 * Walk a complete ClientHello handshake message and pull out the SNI hostname.
 * Every read is bounds-checked against `hs` — a truncated or hostile hello
 * yields `undefined` (⇒ authority identity), never a throw.
 */
function sniFromClientHello(hs: Buffer): { sni?: string; alpn?: string[] } {
  const out: { sni?: string; alpn?: string[] } = {};
  // handshake header(4) + client version(2) + random(32)
  let p = 4 + 2 + 32;
  if (p + 1 > hs.length) return out;
  const sidLen = hs[p];
  p += 1 + sidLen;
  if (p + 2 > hs.length) return out;
  const csLen = hs.readUInt16BE(p);
  p += 2 + csLen;
  if (p + 1 > hs.length) return out;
  const compLen = hs[p];
  p += 1 + compLen;
  if (p + 2 > hs.length) return out; // no extensions block
  const extLen = hs.readUInt16BE(p);
  p += 2;
  const extEnd = Math.min(p + extLen, hs.length);
  while (p + 4 <= extEnd) {
    const type = hs.readUInt16BE(p);
    const len = hs.readUInt16BE(p + 2);
    const data = p + 4;
    p = data + len;
    if (type === 0x0000) {
      // server_name: [listLen(2)][nameType(1)=0][nameLen(2)][name]
      if (data + 5 > hs.length) continue;
      const nameType = hs[data + 2];
      const nameLen = hs.readUInt16BE(data + 3);
      const nameStart = data + 5;
      if (nameType !== 0 || nameStart + nameLen > hs.length) continue;
      const name = hs.subarray(nameStart, nameStart + nameLen).toString('ascii');
      if (name) out.sni = name;
      continue;
    }
    if (type === 0x0010) {
      // ALPN: [listLen(2)] then [len(1)][protocol]…
      if (data + 2 > hs.length) continue;
      const listEnd = Math.min(data + 2 + hs.readUInt16BE(data), hs.length);
      let q = data + 2;
      const protocols: string[] = [];
      while (q < listEnd) {
        const plen = hs[q];
        q += 1;
        if (plen === 0 || q + plen > listEnd) break;
        protocols.push(hs.subarray(q, q + plen).toString('latin1'));
        q += plen;
      }
      if (protocols.length) out.alpn = protocols;
    }
  }
  return out;
}

/** Classify + (when possible) parse the first TLS record of a tunnel stream. */
export function peekClientHello(buf: Buffer): ClientHelloPeek {
  try {
    // A TLS handshake record is type 0x16 with major version 0x03 (SSLv3+).
    // One byte is enough to rule TLS out — a non-TLS tunnel must be relayed
    // immediately, never buffered waiting for a ClientHello that cannot come.
    if (buf.length < 2 || buf[0] !== 0x16 || buf[1] !== 0x03) return { isTls: false, complete: false };
    if (buf.length < 5) return incomplete();
    const recLen = buf.readUInt16BE(3);
    if (buf.length < 5 + recLen) return incomplete();
    const hs = buf.subarray(5, 5 + recLen);
    if (hs.length < 4) return complete();
    if (hs[0] !== 0x01) return complete(); // a complete record, but not a ClientHello
    return complete(sniFromClientHello(hs));
  } catch {
    return { isTls: true, complete: true };
  }
}


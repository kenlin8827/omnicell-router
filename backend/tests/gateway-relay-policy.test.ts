import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { buildGatewayHostSdk } from '../src/plugins/host.js';
import { setBootRules } from '../src/forward-proxy/egress.js';
import { RULE_REJECTED_MESSAGE } from '../src/forward-proxy/server.js';
import type { AccessTap } from '../src/forward-proxy/access-log.js';
import type { PluginManifest } from '../src/plugins/types.js';

/**
 * Client-gateway relay transport policy (ADR-0017 §3, ADR-0018 §3/§5).
 *
 * `relayUpstream` is the ONLY dial path a gateway plugin has, so the policy it
 * applies is a contract, not an implementation detail: the ADR-0018 ADMISSION
 * gate refuses a `reject` host with 403 BEFORE any dial (the egress lookup
 * cannot stand in for it — a `reject` row has no egress to honour, so the
 * forwarder would dial the host direct), the refusal is the forward proxy's own
 * envelope, and the returned `wire` names the leg the request ARRIVED on.
 *
 * Driven through real servers (an h1 front and an h2c front) — the same style
 * the forward-proxy suites use for their forwarders — against a port nothing
 * listens on, so a dial would be observable as a 502/connection failure rather
 * than the 403 refusal asserted here. The `secure` case is the exception: it
 * dials a REAL plain-http origin, because a hardcoded TLS scheme is only
 * observable as a failed handshake against one.
 */

type RelayResult = { wire: 'h1' | 'h2'; rejected?: true };

interface TapProbe extends AccessTap {
  finishes: number;
  status: number | undefined;
  notes: string[];
}

function tapProbe(): TapProbe {
  const probe: TapProbe = {
    finishes: 0,
    status: undefined,
    notes: [],
    onReqChunk() {},
    onResChunk() {},
    finish(status, _headers, note) {
      probe.finishes += 1;
      probe.status = status;
      if (note) probe.notes.push(note);
    },
  };
  return probe;
}

/** The relay only reads `id` (config lookup) — the rest is manifest surface. */
const MANIFEST: PluginManifest = {
  id: 'cursor-gateway',
  name: 'Cursor Gateway',
  version: '0.0.0-test',
  apiVersion: 1,
  type: 'client-gateway',
  wires: [],
  hosts: ['rejected.example'],
};

const REJECTED_HOST = 'rejected.example';
const REJECT_RULES = [{ match: REJECTED_HOST, ingress: 'reject' as const, egress: 'direct' as const }];

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
    setTimeout(resolve, 1000);
  });
}

/** A port nothing listens on: dialing it fails ECONNREFUSED → 502, never 403. */
async function closedPort(): Promise<number> {
  const srv = net.createServer();
  const port = await listen(srv);
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

function getH1(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/v1/relay' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
      // `proxyFail` closes the client transport once the envelope is on the
      // wire; a reset after a complete body is still a complete answer.
      res.on('error', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

function getH2(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(`http://127.0.0.1:${port}`);
    session.on('error', reject);
    const stream = session.request({ ':method': 'GET', ':path': '/v1/relay' });
    let status = 0;
    const chunks: Buffer[] = [];
    stream.on('response', (h) => {
      status = Number(h[':status']) || 0;
    });
    stream.on('data', (d: Buffer) => chunks.push(d));
    stream.on('error', reject);
    stream.on('close', () => {
      session.close();
      resolve({ status, body: Buffer.concat(chunks).toString() });
    });
    stream.end();
  });
}

describe('client-gateway relay: ADR-0018 admission gate', () => {
  // Safety net: the isolated runner starts every file in its own process, but
  // the boot rule table is module state and must never outlive this file.
  after(() => setBootRules(undefined));

  it('a reject row answers 403 before any dial and reports the arrival wire (h1)', async () => {
    setBootRules(REJECT_RULES);
    const port = await closedPort();
    const tap = tapProbe();
    const sdk = buildGatewayHostSdk(MANIFEST, process.cwd());
    let settle: (r: RelayResult) => void = () => {};
    const relayed = new Promise<RelayResult>((resolve) => (settle = resolve));
    const front = http.createServer((req, res) => {
      void sdk.relayUpstream(req, res, { host: REJECTED_HOST, port, path: '/v1/relay', tap }).then(settle);
    });
    const frontPort = await listen(front);
    try {
      const answer = await getH1(frontPort);
      const result = await relayed;

      // (iii) the client is answered by the gate, with the forward proxy's own
      // refusal envelope — NOT the 502 a dial to the closed port would yield.
      assert.equal(answer.status, 403);
      assert.equal(answer.body, RULE_REJECTED_MESSAGE);
      // (i) nothing was dialed: the ledger records the refusal, and only it.
      assert.equal(tap.status, 403, 'the ledger must record the refusal, not an upstream failure');
      // (ii) exactly one finish, carrying the gate's note.
      assert.equal(tap.finishes, 1, 'the tap must be finished exactly once');
      assert.deepEqual(tap.notes, ['rejected by rule']);
      // (iv) the leg the request arrived on, plus the refusal flag.
      assert.deepEqual(result, { wire: 'h1', rejected: true });
    } finally {
      await closeServer(front);
      setBootRules(undefined);
    }
  });

  it('a reject row answers 403 on the h2 leg too and reports wire: h2', async () => {
    setBootRules(REJECT_RULES);
    const port = await closedPort();
    const tap = tapProbe();
    const sdk = buildGatewayHostSdk(MANIFEST, process.cwd());
    let settle: (r: RelayResult) => void = () => {};
    const relayed = new Promise<RelayResult>((resolve) => (settle = resolve));
    const front = http2.createServer((req, res) => {
      void sdk
        .relayUpstream(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, {
          host: REJECTED_HOST,
          port,
          path: '/v1/relay',
          h2: true,
          tap,
        })
        .then(settle);
    });
    const frontPort = await listen(front);
    try {
      const answer = await getH2(frontPort);
      const result = await relayed;

      assert.equal(answer.status, 403);
      assert.equal(answer.body, RULE_REJECTED_MESSAGE);
      assert.equal(tap.status, 403);
      assert.equal(tap.finishes, 1);
      assert.deepEqual(tap.notes, ['rejected by rule']);
      // `wire` is the arrival leg, not a constant: an h2 arrival says so.
      assert.deepEqual(result, { wire: 'h2', rejected: true });
    } finally {
      await closeServer(front);
      setBootRules(undefined);
    }
  });

  it('secure: false relays to a plaintext origin — the dial scheme is the caller\'s claim', async () => {
    // No rule installed: this case is about the SCHEME, not the gate.
    setBootRules(undefined);
    const MARKER = 'plain-origin-marker';
    const origin = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${MARKER}:${req.url}`);
    });
    const originPort = await listen(origin);
    const tap = tapProbe();
    const sdk = buildGatewayHostSdk(MANIFEST, process.cwd());
    let settle: (r: RelayResult) => void = () => {};
    const relayed = new Promise<RelayResult>((resolve) => (settle = resolve));
    const front = http.createServer((req, res) => {
      void sdk
        .relayUpstream(req, res, { host: '127.0.0.1', port: originPort, path: '/echo', secure: false, tap })
        .then(settle);
    });
    const frontPort = await listen(front);
    try {
      const answer = await getH1(frontPort);
      const result = await relayed;

      // A hardcoded `secure: true` would open a TLS handshake against a plain
      // listener and answer 502 — the marker can only come back through an
      // `http` dial.
      assert.equal(answer.status, 200);
      assert.equal(answer.body, `${MARKER}:/echo`);
      assert.equal(tap.status, 200);
      assert.deepEqual(result, { wire: 'h1' });
    } finally {
      await closeServer(front);
      await closeServer(origin);
    }
  });
});

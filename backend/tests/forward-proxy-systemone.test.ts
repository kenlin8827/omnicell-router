/**
 * Step-4 MITM-leg suite for the System One decision surface.
 *
 * Pins:
 *  a) the MITM leg serves /v1/systemone end-to-end — fake chat upstream on
 *     a real 127.0.0.1 listener, converted typed answers, exactly
 *     the 3 X-OCR decision keys on the wire;
 *  b) the CAPTURE EXPLICIT-OFF GUARD — with requestCapture.enabled ON but
 *     requestCapture.systemone.enabled (the System One surface MASTER)
 *     explicitly FALSE, one systemone
 *     request on EACH leg produces ZERO http-exchange events on disk (the
 *     machine guard so the silenced path stays event-free; a live chat control
 *     request proves the recorder itself is on and its files readable);
 *  c) the capture opt-in — with systemone.enabled true (nested default;
 *     hot-applied here), each leg emits the FULL CHAIN: one paired client
 *     request/response event AND one paired upstream request/response event
 *     (the converted decision call — absolute-form line with host, span-
 *     paired, same trace/session, provider credential sanitized; no purpose
 *     tag), while a gate-denied 400 still emits ZERO (gates precede emission);
 *  d) per-surface error mapping on the MITM leg — the systemone envelope for
 *     invalid bodies, and the 'exempt' gate never 403s (a model a deny-mode
 *     key cannot use serves fine through the proxy).
 *
 * Harness patterns borrowed: systemone.test.ts (sandbox cwd + bun `serve`
 * fake chat upstream + real createServer/ProviderRegistry),
 * forward-proxy.test.ts (createProxyInterceptor over a live 127.0.0.1 http
 * server — the stub-inner-server route; the full CONNECT-MITM chain is
 * already covered there for the plumbing itself), capture-http.test.ts
 * (on-disk http-exchange event reader).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { serve } from 'bun';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config/index.js';
import { RouterConfig } from '../src/config/types.js';
import { createProxyInterceptor } from '../src/forward-proxy/interceptor.js';
import type { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { CaptureRecorder } from '../src/capture/recorder.js';

// ---------------------------------------------------------------------------
// Isolation: request-time paths re-read the disk config (systemone.defaultModel,
// auth snapshot) — chdir into a minimal sandbox BEFORE any server construction
// so the operator's real config.yaml never leaks in.
// ---------------------------------------------------------------------------
const originalCwd = process.cwd();
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-systemone-'));
fs.writeFileSync(path.join(sandboxRoot, 'config.yaml'), 'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\n');
process.chdir(sandboxRoot);

afterAll(() => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const CHAT_PROVIDERS = new WeakMap<object, any[]>();

function makeConfig(chatProviders: any[], models: any[], extra: Partial<RouterConfig> = {}): RouterConfig {
  const base = loadConfig();
  const config = {
    ...base,
    apiKeys: [],
    models,
    requestCapture: { ...base.requestCapture, enabled: false },
    session: { ...base.session, enabled: false },
    tracePersist: { ...base.tracePersist, enabled: false },
    ...extra,
  } as RouterConfig;
  CHAT_PROVIDERS.set(config, chatProviders);
  return config;
}

function bootServer(config: RouterConfig, mockMode = false) {
  return createServer(config, mockMode, undefined, undefined, CHAT_PROVIDERS.get(config) ?? []);
}

const REQ = {
  state: { ticket: 'T-9001', content: 'Refund window expired — needs a decision.' },
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { billing: 'payments/refunds', technical: 'bugs/outages' },
    },
    escalate: { type: 'noul', instructions: 'Needs immediate escalation?' },
  },
} as any;

// Fixed decision answers the fake chat upstream returns (wrapped in a chat
// completion; the decision surface synthesizes the typed answers from it).
const DECISION_ANSWERS = JSON.stringify({
  answers: {
    department: { choice: 'billing', probabilities: { billing: 0.94, technical: 0.06 }, confidence: 0.88 },
    escalate: { noul: 0.72 },
  },
});

/** Fake chat upstream serving the decision JSON on a real 127.0.0.1 listener. */
function startChatUpstream(received: any[]): ReturnType<typeof serve> {
  return serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      received.push(await req.json());
      return Response.json({
        id: 'chatcmpl-decision',
        object: 'chat.completion',
        created: 1700000000,
        model: 'jev-latest',
        choices: [{ index: 0, message: { role: 'assistant', content: DECISION_ANSWERS }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 133, completion_tokens: 10, total_tokens: 143 },
      });
    },
  });
}

function chatProviderConfig(port: number): { providers: any[]; models: any[] } {
  return {
    providers: [{ name: 'native-test', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test' }],
    models: [
      {
        id: 'native-test/jev',
        provider: 'native-test',
        upstreamModel: 'jev-latest',
        tier: 'lite',
        pricing: { input: 0, output: 0, cacheRead: 0 },
      },
    ],
  };
}

/** Live MITM-leg server: the REAL interceptor dispatching to the REAL orchestrator. */
async function mitmServer(orchestrator: PipelineOrchestrator): Promise<{ port: number; close: () => void }> {
  const intercept = createProxyInterceptor(orchestrator);
  const srv = http.createServer((req, res) => {
    void intercept(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('passthrough');
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { port: (srv.address() as net.AddressInfo).port, close: () => srv.close() };
}

function xOcrHeaderNames(res: Response): string[] {
  const names: string[] = [];
  res.headers.forEach((_v, k) => {
    if (k.toLowerCase().startsWith('x-ocr-')) names.push(k.toLowerCase());
  });
  return names.sort();
}

const SYSTEMONE_XOCR_KEYS = ['x-ocr-latency-ms', 'x-ocr-model', 'x-ocr-systemone-upstream'];

describe('systemone over the MITM leg', () => {
  test('converted decision serves typed answers with exactly the 3 X-OCR keys', async () => {
    const received: any[] = [];
    const upstream = startChatUpstream(received);
    try {
      const { providers, models } = chatProviderConfig(upstream.port);
      const { orchestrator } = bootServer(makeConfig(providers, models));
      const mitm = await mitmServer(orchestrator);
      try {
        const res = await fetch(`http://127.0.0.1:${mitm.port}/v1/systemone`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...REQ, model: 'native-test/jev' }),
        });
        expect(res.status).toBe(200);
        // Golden key set: exactly the 3 decision-surface headers, nothing else.
        expect(xOcrHeaderNames(res)).toEqual(SYSTEMONE_XOCR_KEYS);
        expect(res.headers.get('x-ocr-model')).toBe('native-test/jev');
        expect(res.headers.get('x-ocr-systemone-upstream')).toBe('converted');
        expect(res.headers.get('x-ocr-latency-ms')).toMatch(/^\d+$/);

        // Synthesized typed answers (converted path — no native passthrough).
        const body: any = await res.json();
        expect(body.answers.department.choice).toBe('billing');
        expect(body.answers.department.probabilities).toEqual({ billing: 0.94, technical: 0.06 });
        expect(body.answers.escalate.noul).toBe(0.72);

        // The upstream saw the decision chat call (converted contract): the
        // STATE/QUESTIONS payload rides inside the user message.
        expect(received.length).toBe(1);
        expect(received[0].model).toBe('jev-latest');
        expect(received[0].messages[0].role).toBe('system');
        expect(received[0].messages[1].content).toContain('T-9001');
      } finally {
        mitm.close();
      }
    } finally {
      upstream.stop(true);
    }
  });

  test('per-surface error mapping: invalid bodies get the systemone envelope', async () => {
    const received: any[] = [];
    const upstream = startChatUpstream(received);
    try {
      const { providers, models } = chatProviderConfig(upstream.port);
      const { orchestrator } = bootServer(makeConfig(providers, models));
      const mitm = await mitmServer(orchestrator);
      try {
        // Structurally invalid (but valid JSON): validateSystemoneRequest 400
        // through systemoneSurface.errorBody — verbatim message + code.
        const res = await fetch(`http://127.0.0.1:${mitm.port}/v1/systemone`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ questions: REQ.questions }),
        });
        expect(res.status).toBe(400);
        const j: any = await res.json();
        expect(j.error.message).toBe('Invalid request: "state" is required (string, object or array).');
        expect(j.error.type).toBe('invalid_request_error');
        expect(j.error.code).toBe('invalid_request_error');

        // Pre-dispatch non-JSON: 400 'Invalid JSON body' via the same envelope.
        const res2 = await fetch(`http://127.0.0.1:${mitm.port}/v1/systemone`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'not-json{{{',
        });
        expect(res2.status).toBe(400);
        const j2: any = await res2.json();
        expect(j2.error.message).toBe('Invalid JSON body');
        expect(j2.error.type).toBe('invalid_request_error');

        expect(received.length).toBe(0); // nothing reached the upstream
      } finally {
        mitm.close();
      }
    } finally {
      upstream.stop(true);
    }
  });

  test("'exempt' MITM gate never 403s — a key-denied model still serves over the proxy", async () => {
    const received: any[] = [];
    const upstream = startChatUpstream(received);
    try {
      const { providers, models } = chatProviderConfig(upstream.port);
      const config = makeConfig(providers, models);
      // A deny-mode key that cannot use native-test/jev: the Fastify leg MUST
      // 403 (proving the model really is denied for a 'key' gate), while the
      // MITM leg — 'exempt' by construction — MUST serve 200.
      config.apiKeys = [
        { name: 'no-jev', key: 'sk-no-jev', modelAccess: { mode: 'deny', models: ['native-test/jev'] } },
      ] as any;
      const { app, orchestrator } = bootServer(config);
      const mitm = await mitmServer(orchestrator);
      try {
        const viaKey = await app.inject({
          method: 'POST',
          url: '/v1/systemone',
          headers: { authorization: 'Bearer sk-no-jev' },
          payload: { ...REQ, model: 'native-test/jev' },
        });
        expect(viaKey.statusCode).toBe(403);
        expect(viaKey.json().error.code).toBe('model_not_allowed');

        const viaMitm = await fetch(`http://127.0.0.1:${mitm.port}/v1/systemone`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...REQ, model: 'native-test/jev' }),
        });
        expect(viaMitm.status).toBe(200); // gate no-op, never a 403
        expect(viaMitm.headers.get('x-ocr-systemone-upstream')).toBe('converted');
        await viaMitm.json();
      } finally {
        mitm.close();
      }
    } finally {
      upstream.stop(true);
    }
  });
});

describe('systemone capture explicit-OFF guard (requestCapture.systemone.enabled: false keeps the zero-event exemption)', () => {
  interface ExchangeEvent {
    eventType: string;
    direction: string;
    phase: string;
  }

  function readExchangeEvents(dir: string): ExchangeEvent[] {
    const day = path.join(dir, CaptureRecorder.localDateDir(new Date()));
    if (!fs.existsSync(day)) return [];
    const out: ExchangeEvent[] = [];
    for (const f of fs.readdirSync(day)) {
      for (const line of fs.readFileSync(path.join(day, f), 'utf8').split('\n').filter(Boolean)) {
        out.push(JSON.parse(line));
      }
    }
    return out;
  }

  function linesFor(dir: string, marker: string): string[] {
    const day = path.join(dir, CaptureRecorder.localDateDir(new Date()));
    if (!fs.existsSync(day)) return [];
    const out: string[] = [];
    for (const f of fs.readdirSync(day)) {
      for (const line of fs.readFileSync(path.join(day, f), 'utf8').split('\n').filter(Boolean)) {
        if (line.includes(marker)) out.push(line);
      }
    }
    return out;
  }

  async function waitUntil(pred: () => boolean, timeoutMs = 2500): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error('capture events did not settle within timeout');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  // The master/sub tree made the System One surface MASTER default ON under
  // the capture master, and it silences BOTH legs when off. This block pins
  // the SILENCED path: the config below sets
  // systemone.enabled false explicitly, keeping the
  // zero-events outcome on both legs. Assertions here are frozen by contract
  // — the opt-in path gets its own suite below (client-leg pair,
  // sanitization, gate ordering).
  test('requestCapture.enabled ON with systemone.enabled FALSE: zero http-exchange events on disk for BOTH systemone legs', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-sys-cap-'));
    const received: any[] = [];
    const upstream = startChatUpstream(received);
    try {
      const { providers, models } = chatProviderConfig(upstream.port);
      const stamp = Date.now();
      const CHAT_MARKER = `SYSCTL-CHAT-${stamp}`;
      const FASTIFY_MARKER = `SYSCTL-FASTIFY-${stamp}`;
      const MITM_MARKER = `SYSCTL-MITM-${stamp}`;
      // The decision conversion is a REAL registry.execute call now (no native
      // limb to bypass it), so every provider dials the fake upstream for
      // real — chat-dummy rides the same createServer provider-config seam
      // (test-only; production chat providers enter via registerProvider).
      const config = makeConfig(
        [
          ...providers,
          { name: 'chat-dummy', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: 'sk-dummy' },
        ],
        [
          ...models,
          {
            id: 'test/chat',
            provider: 'chat-dummy',
            upstreamModel: 'test-chat',
            // plus-tier: `auto` starts at the plus default, so the chat
            // control resolves a real candidate instead of an empty pool.
            tier: 'plus',
            pricing: { input: 0, output: 0, cacheRead: 0 },
          },
        ],
        {
          requestCapture: {
            enabled: true,
            dir: tmp,
            retentionDays: 7,
            maxTotalMB: 64,
            maxBodyBytes: 65536,
            systemone: { enabled: false },
          },
        }
      );
      const { app, orchestrator } = bootServer(config);
      const mitm = await mitmServer(orchestrator);
      try {
        // 1. Control: a chat turn MUST capture (2 client events) — proves the
        //    recorder is live and the on-disk reader works, so the zero below
        //    is the decision surface's exemption, not a silently off capture.
        const chat = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { 'content-type': 'application/json' },
          payload: { model: 'auto', messages: [{ role: 'user', content: CHAT_MARKER }] },
        });
        expect(chat.statusCode).toBe(200);
        await waitUntil(() => linesFor(tmp, CHAT_MARKER).length >= 2);

        // 2. Fastify leg: /v1/systemone answers 200 with the marker inside state.
        const fastSys = await app.inject({
          method: 'POST',
          url: '/v1/systemone',
          payload: { ...REQ, model: 'native-test/jev', state: { ...REQ.state, content: FASTIFY_MARKER } },
        });
        expect(fastSys.statusCode).toBe(200);
        expect(fastSys.json().answers.department.choice).toBe('billing');

        // 3. MITM leg: same decision wire through the interceptor.
        const mitmSys = await fetch(`http://127.0.0.1:${mitm.port}/v1/systemone`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...REQ, model: 'native-test/jev', state: { ...REQ.state, content: MITM_MARKER } }),
        });
        expect(mitmSys.status).toBe(200);
        await mitmSys.text();

        // Settle window past the chat control's events — a decision-surface
        // event, if one were ever wired, would land in the same timeframe.
        await new Promise((r) => setTimeout(r, 200));

        // ZERO events referencing either systemone request, in ANY direction.
        expect(linesFor(tmp, FASTIFY_MARKER).length).toBe(0);
        expect(linesFor(tmp, MITM_MARKER).length).toBe(0);

        // And machine-guarantee the totals: the chat control pair (2 client
        // events + its real upstream pair — the converted-era chat control
        // dials the fake upstream) and ZERO systemone events.
        const all = readExchangeEvents(tmp).filter((e) => e.eventType === 'http-exchange');
        expect(all.filter((e) => e.direction === 'client').length).toBe(2);
        expect(all.filter((e) => e.direction === 'upstream').length).toBe(2);
      } finally {
        mitm.close();
        await app.close();
      }
    } finally {
      upstream.stop(true);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('systemone full-chain capture opt-in (requestCapture.systemone.enabled)', () => {
  // Self-contained readers (the explicit-off guard block above is frozen by
  // contract, so its helpers stay with it): full parsed events + raw lines.
  interface EventRow {
    eventType: string;
    direction: 'client' | 'upstream';
    phase: 'request' | 'response';
    spanId: string;
    traceId: string;
    sessionId: string;
    model: string;
    status: string;
    wire: {
      requestLine: string;
      requestHeaders: Record<string, string>;
      requestBody: string;
      responseLine: string;
      status: number;
    };
  }

  function eventDir(dir: string): string {
    return path.join(dir, CaptureRecorder.localDateDir(new Date()));
  }

  function readAllEvents(dir: string): EventRow[] {
    const day = eventDir(dir);
    if (!fs.existsSync(day)) return [];
    const out: EventRow[] = [];
    for (const f of fs.readdirSync(day)) {
      for (const line of fs.readFileSync(path.join(day, f), 'utf8').split('\n').filter(Boolean)) {
        out.push(JSON.parse(line));
      }
    }
    return out;
  }

  function linesFor(dir: string, marker: string): string[] {
    const day = eventDir(dir);
    if (!fs.existsSync(day)) return [];
    const out: string[] = [];
    for (const f of fs.readdirSync(day)) {
      for (const line of fs.readFileSync(path.join(day, f), 'utf8').split('\n').filter(Boolean)) {
        if (line.includes(marker)) out.push(line);
      }
    }
    return out;
  }

  async function waitUntil(pred: () => boolean, timeoutMs = 2500): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error('capture events did not settle within timeout');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const CAPTURE_BASE = { retentionDays: 7, maxTotalMB: 64, maxBodyBytes: 65536 };
  const SECRET = 'sk-should-not-persist';

  // Full-chain capture: one paired client exchange AND one paired upstream
  // exchange (the native passthrough call), sharing the turn's trace/session.
  // (The upstream-leg exclusion was lifted by the chain-completeness mandate
  // — the capture contract now reads: client+upstream legs captured; FinOps/trace/
  // breaker-outcome/caching limbs still excluded.)
  function assertClientExchangePair(events: EventRow[], marker: string): { req: EventRow; resp: EventRow } {
    const exchange = events.filter((e) => e.eventType === 'http-exchange');
    const reqs = exchange.filter((e) => e.direction === 'client' && e.phase === 'request' && (e.wire?.requestBody ?? '').includes(marker));
    const resps = exchange.filter((e) => e.direction === 'client' && e.phase === 'response' && (e.wire?.requestBody ?? '').includes(marker));
    expect(reqs.length).toBe(1);
    expect(resps.length).toBe(1);
    const req = reqs[0];
    const resp = resps[0];
    expect(resp.spanId).toBe(req.spanId); // one exchange = one spanId, two events
    expect(req.traceId).toMatch(/^[0-9a-f]{32}$/); // minted — no client trace headers
    expect(resp.traceId).toBe(req.traceId);
    expect(req.sessionId).toBeTruthy();
    expect(resp.sessionId).toBe(req.sessionId);
    expect(req.wire.requestLine).toBe('POST /v1/systemone HTTP/1.1');
    expect(req.wire.requestHeaders.authorization).toBe('[REDACTED]');
    expect(req.model).toBe('native-test/jev');
    expect(resp.wire.status).toBe(200);
    expect(resp.wire.responseLine).toContain('200');

    // Upstream leg: the native passthrough POST {base}/systemone — absolute-
    // form request line (host visible), span-paired, same trace/session as
    // the client leg, provider credential redacted. No 'l2-decision' purpose:
    // within this surface's own turn the upstream leg is unambiguous.
    const upReqs = exchange.filter((e) => e.direction === 'upstream' && e.phase === 'request' && (e.wire?.requestBody ?? '').includes(marker));
    const upResps = exchange.filter((e) => e.direction === 'upstream' && e.phase === 'response');
    expect(upReqs.length).toBe(1);
    expect(upResps.length).toBe(1);
    const upReq = upReqs[0];
    const upResp = upResps[0];
    expect(upReq.wire.requestLine).toMatch(/^POST http:\/\/127\.0\.0\.1:\d+\/chat\/completions HTTP\/1\.1$/);
    expect(upReq.wire.requestHeaders.authorization).toBe('[REDACTED]'); // provider apiKey never persists
    expect(upResp.spanId).toBe(upReq.spanId);
    expect(upReq.traceId).toBe(req.traceId);
    expect(upResp.traceId).toBe(req.traceId);
    expect(upReq.sessionId).toBe(req.sessionId);
    expect(upResp.wire.status).toBe(200);
    expect((upReq as { purpose?: string }).purpose).toBeUndefined();
    return { req, resp };
  }

  test('MITM leg, systemone.enabled hot-applied ON: full chain — paired client + paired upstream events', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-sys-on-mitm-'));
    const received: any[] = [];
    const upstream = startChatUpstream(received);
    const MARKER = `SYSCTL-ON-MITM-${Date.now()}`;
    try {
      const { providers, models } = chatProviderConfig(upstream.port);
      const captureCfg = { ...CAPTURE_BASE, enabled: true, dir: tmp };
      const config = makeConfig(providers, models, { requestCapture: { ...captureCfg, systemone: { enabled: false } } });
      const { orchestrator } = bootServer(config);
      const recorder = orchestrator.getCaptureRecorder();
      // Hot-apply: the client-leg sub-switch flips ON without a restart
      // (constructed explicit-OFF above — the flip is the whole point).
      recorder.applyConfig({ ...captureCfg, systemone: { enabled: true } });
      expect(recorder.isSystemoneEnabled()).toBe(true);
      const mitm = await mitmServer(orchestrator);
      try {
        const res = await fetch(`http://127.0.0.1:${mitm.port}/v1/systemone`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({ ...REQ, model: 'native-test/jev', state: { ...REQ.state, content: MARKER } }),
        });
        expect(res.status).toBe(200);
        await res.json();

        await waitUntil(() => readAllEvents(tmp).filter((e) => e.phase === 'response').length >= 2);
        assertClientExchangePair(readAllEvents(tmp), MARKER);

        // Whole-file secret scan: only the [REDACTED] sentinel may persist.
        const all = fs.readdirSync(eventDir(tmp)).map((f) => fs.readFileSync(path.join(eventDir(tmp), f), 'utf8')).join('');
        expect(all.includes(SECRET)).toBe(false);
        expect(all.includes(MARKER)).toBe(true);
      } finally {
        mitm.close();
        recorder.applyConfig({ ...captureCfg, systemone: { enabled: false } }); // restore explicit OFF
      }
    } finally {
      upstream.stop(true);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('Fastify leg, systemone.enabled hot-applied ON: full chain — paired client + paired upstream events', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-sys-on-fastify-'));
    const received: any[] = [];
    const upstream = startChatUpstream(received);
    const MARKER = `SYSCTL-ON-FASTIFY-${Date.now()}`;
    try {
      const { providers, models } = chatProviderConfig(upstream.port);
      const captureCfg = { ...CAPTURE_BASE, enabled: true, dir: tmp };
      const config = makeConfig(providers, models, { requestCapture: { ...captureCfg, systemone: { enabled: false } } });
      const { app, orchestrator } = bootServer(config);
      const recorder = orchestrator.getCaptureRecorder();
      recorder.applyConfig({ ...captureCfg, systemone: { enabled: true } });
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/systemone',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
          payload: { ...REQ, model: 'native-test/jev', state: { ...REQ.state, content: MARKER } },
        });
        expect(res.statusCode).toBe(200);

        await waitUntil(() => readAllEvents(tmp).filter((e) => e.phase === 'response').length >= 2);
        assertClientExchangePair(readAllEvents(tmp), MARKER);

        const all = fs.readdirSync(eventDir(tmp)).map((f) => fs.readFileSync(path.join(eventDir(tmp), f), 'utf8')).join('');
        expect(all.includes(SECRET)).toBe(false);
        expect(all.includes(MARKER)).toBe(true);
      } finally {
        recorder.applyConfig({ ...captureCfg, systemone: { enabled: false } }); // restore explicit OFF
        await app.close();
      }
    } finally {
      upstream.stop(true);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('gate-denied 400 with systemone.enabled ON: zero events — emission lives behind ALL gates', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-sys-on-400-'));
    const received: any[] = [];
    const upstream = startChatUpstream(received);
    const OK_FASTIFY = `SYSCTL-ORDER-OK-F-${Date.now()}`;
    const OK_MITM = `SYSCTL-ORDER-OK-M-${Date.now()}`;
    const BAD_FASTIFY = `SYSCTL-ORDER-BAD-F-${Date.now()}`;
    const BAD_MITM = `SYSCTL-ORDER-BAD-M-${Date.now()}`;
    try {
      const { providers, models } = chatProviderConfig(upstream.port);
      const captureCfg = { ...CAPTURE_BASE, enabled: true, dir: tmp };
      const config = makeConfig(providers, models, { requestCapture: { ...captureCfg, systemone: { enabled: false } } });
      const { app, orchestrator } = bootServer(config);
      const recorder = orchestrator.getCaptureRecorder();
      recorder.applyConfig({ ...captureCfg, systemone: { enabled: true } });
      const mitm = await mitmServer(orchestrator);
      try {
        // Controls: valid decisions DO capture (pair each) — so the zero
        // below is proof of gate ORDERING, not of a silently off recorder.
        const good = await app.inject({
          method: 'POST',
          url: '/v1/systemone',
          payload: { ...REQ, model: 'native-test/jev', state: { ...REQ.state, content: OK_FASTIFY } },
        });
        expect(good.statusCode).toBe(200);
        const goodMitm = await fetch(`http://127.0.0.1:${mitm.port}/v1/systemone`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...REQ, model: 'native-test/jev', state: { ...REQ.state, content: OK_MITM } }),
        });
        expect(goodMitm.status).toBe(200);
        await goodMitm.text();
        await waitUntil(() => readAllEvents(tmp).filter((e) => e.phase === 'response').length >= 2);

        // Gate-denied: missing "questions" → validateSystemoneRequest 400,
        // which returns BEFORE the capture emit block.
        const bad = await app.inject({
          method: 'POST',
          url: '/v1/systemone',
          payload: { state: { content: BAD_FASTIFY } },
        });
        expect(bad.statusCode).toBe(400);
        const badMitm = await fetch(`http://127.0.0.1:${mitm.port}/v1/systemone`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state: { content: BAD_MITM } }),
        });
        expect(badMitm.status).toBe(400);
        await badMitm.text();

        // Settle past the controls (mirrors the guard test's window).
        await new Promise((r) => setTimeout(r, 200));

        expect(linesFor(tmp, BAD_FASTIFY).length).toBe(0);
        expect(linesFor(tmp, BAD_MITM).length).toBe(0);
        // Totals: ONLY the two control exchanges — each FULL-CHAIN now
        // (4 client events + 4 upstream events); the gate-denied 400s add
        // nothing, proving emission order sits behind ALL gates.
        const exchange = readAllEvents(tmp).filter((e) => e.eventType === 'http-exchange');
        expect(exchange.filter((e) => e.direction === 'client').length).toBe(4);
        expect(exchange.filter((e) => e.direction === 'upstream').length).toBe(4);
      } finally {
        mitm.close();
        recorder.applyConfig({ ...captureCfg, systemone: { enabled: false } }); // restore explicit OFF
        await app.close();
      }
    } finally {
      upstream.stop(true);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

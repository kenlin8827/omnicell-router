/**
 * Golden X-OCR header key-set matrix (contract step 3c, §4 "list ONE").
 *
 * One row per (wire × leg × stream) cell; every cell must expose EXACTLY
 * the same key set — the base 15 from surfaces/ocr-headers.ts, plus the
 * frozen conditionals when their trigger is present. Fastify leg: real
 * server + mockMode orchestrator (inject). MITM leg: createProxyInterceptor
 * on a live socket with a stub orchestrator — Δ-3 (5→full set) is the
 * approved convergence this golden guards against silent regressions.
 *
 * Step 4 extended HEADER_ROWS with the systemone rows (exactly 3 keys —
 * buildSystemoneOcrHeaders) on both legs; the decision wire bypasses
 * orchestrator.process, so those rows ride a dedicated real-registry server
 * (fake native upstream on 127.0.0.1) — the cell runner selects it via
 * `row.decision`.
 *
 * Variant-conditional (X-OCR-Variant): covered by the builder unit matrix
 * in ocr-headers.test.ts; reaching it over the wire needs a variants
 * registry fixture, which is out of scope here (noted per task).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { serve } from 'bun';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { createProxyInterceptor } from '../src/forward-proxy/interceptor.js';

const TEST_KEY = 'sk-ocr-surface-headers-test';
const BASE13 = [
  'x-ocr-tier',
  'x-ocr-layer',
  'x-ocr-model',
  'x-ocr-failover',
  'x-ocr-failover-attempts',
  'x-ocr-failover-path',
  'x-ocr-inplace-retries',
  'x-ocr-breaker-state',
  'x-ocr-session-id',
  'x-ocr-session-ratchet',
  'x-ocr-session-lookup',
  'x-ocr-trace-id',
  'x-ocr-latency-ms',
];
const THINKING3 = ['x-ocr-thinking-requested', 'x-ocr-thinking-actual', 'x-ocr-thinking-degraded'];
// ADR-0012: the real pipeline attributes every effort ask to its author —
// legs served by a REAL orchestrator (fastify rows) gain the source header;
// stub-fed harnesses (mitm rows) keep the 3-key set.
const THINKING4 = [...THINKING3, 'x-ocr-thinking-source'];
const sortedKeys = (...extra: string[]): string[] => [...BASE13, ...extra].sort();

type Leg = 'fastify' | 'mitm';
interface Row {
  name: string;
  leg: Leg;
  path: string;
  body: Record<string, unknown>;
  expected: string[];
  /** Decision-wire row: served by the dedicated real-registry harness, not the mock/stub chat harness. */
  decision?: boolean;
}

// The frozen decision-surface golden set (buildSystemoneOcrHeaders): exactly 3.
const SYS3 = ['x-ocr-latency-ms', 'x-ocr-model', 'x-ocr-systemone-upstream'].sort();

/** Build a request body for wire `path` with the given extras. */
const bodies = {
  chat: (extra: Record<string, unknown> = {}) => ({
    model: 'auto',
    messages: [{ role: 'user', content: 'header golden' }],
    ...extra,
  }),
  anthropic: (extra: Record<string, unknown> = {}) => ({
    model: 'auto',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'header golden' }],
    ...extra,
  }),
  responses: (extra: Record<string, unknown> = {}) => ({
    model: 'auto',
    input: 'header golden',
    ...extra,
  }),
  systemone: () => ({
    model: 'native-test/jev',
    state: { ticket: 'SYSHEAD', content: 'header golden' },
    questions: {
      route: { type: 'choice', instructions: 'Which queue?', criteria: { billing: 'payments', technical: 'bugs' } },
    },
  }),
};

// The frozen matrix. Step 4 appended the systemone rows (3-key golden set,
// decision harness) after the chat-family rows.
const HEADER_ROWS: Row[] = [
  { name: 'chat json/fastify', leg: 'fastify', path: '/v1/chat/completions', body: bodies.chat(), expected: sortedKeys() },
  { name: 'chat stream/fastify', leg: 'fastify', path: '/v1/chat/completions', body: { ...bodies.chat(), stream: true }, expected: sortedKeys() },
  { name: 'chat + effort/fastify', leg: 'fastify', path: '/v1/chat/completions', body: { ...bodies.chat(), reasoning_effort: 'high' }, expected: sortedKeys(...THINKING4) },
  { name: 'anthropic json/fastify', leg: 'fastify', path: '/v1/messages', body: bodies.anthropic(), expected: sortedKeys() },
  { name: 'anthropic stream/fastify', leg: 'fastify', path: '/v1/messages', body: { ...bodies.anthropic(), stream: true }, expected: sortedKeys() },
  { name: 'responses json/fastify', leg: 'fastify', path: '/v1/responses', body: bodies.responses(), expected: sortedKeys() },
  { name: 'responses stream/fastify', leg: 'fastify', path: '/v1/responses', body: { ...bodies.responses(), stream: true }, expected: sortedKeys() },
  { name: 'chat json/mitm', leg: 'mitm', path: '/v1/chat/completions', body: bodies.chat(), expected: sortedKeys() },
  { name: 'chat stream/mitm', leg: 'mitm', path: '/v1/chat/completions', body: { ...bodies.chat(), stream: true }, expected: sortedKeys() },
  { name: 'chat + effort/mitm', leg: 'mitm', path: '/v1/chat/completions', body: { ...bodies.chat(), reasoning_effort: 'high' }, expected: sortedKeys(...THINKING3) },
  { name: 'anthropic json/mitm', leg: 'mitm', path: '/v1/messages', body: bodies.anthropic(), expected: sortedKeys() },
  { name: 'anthropic stream/mitm', leg: 'mitm', path: '/v1/messages', body: { ...bodies.anthropic(), stream: true }, expected: sortedKeys() },
  { name: 'responses json/mitm', leg: 'mitm', path: '/v1/responses', body: bodies.responses(), expected: sortedKeys() },
  { name: 'responses stream/mitm', leg: 'mitm', path: '/v1/responses', body: { ...bodies.responses(), stream: true }, expected: sortedKeys() },
  { name: 'systemone json/fastify', leg: 'fastify', path: '/v1/systemone', body: bodies.systemone(), expected: SYS3, decision: true },
  { name: 'systemone json/mitm', leg: 'mitm', path: '/v1/systemone', body: bodies.systemone(), expected: SYS3, decision: true },
];

function xOcrKeys(headers: Headers | Record<string, unknown>): string[] {
  const names: string[] = [];
  if (headers instanceof Headers) {
    headers.forEach((_v, k) => names.push(k.toLowerCase()));
  } else {
    for (const k of Object.keys(headers)) names.push(k.toLowerCase());
  }
  return names.filter((k) => k.startsWith('x-ocr-')).sort();
}

/**
 * Stub ExecutionResult for the MITM leg — deliberately PARTIAL for the
 * plain rows (proves the builder's frozen ??/|| defaults, R-4: missing
 * optionals must still yield the full key set, never throw); the effort
 * row carries the thinking fields (same fields the Fastify leg's real
 * orchestrator sets for a reasoning request).
 */
function stubResult(effortRow: boolean): unknown {
  const base = {
    response: {
      id: 'mock-cmpl', object: 'chat.completion', created: 1, model: 'mock-1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
    tierUsed: 'lite',
    modelUsed: 'mock-1',
    fallbackOccurred: false,
    latencyMs: 1,
    sessionId: 'sess-1',
    traceId: 'trace-1',
    // Non-empty everywhere else, mirroring what the mockMode orchestrator
    // produces on the Fastify leg: the builder's '' defaults for missing
    // failoverPath/sessionLookupType get header-dropped by Bun's http on
    // the MITM wire (empty values are not sent), which would make the
    // cross-leg SET comparison meaningless. The partial-stub crash guard
    // (R-4 ??/|| defaults) is pinned separately in ocr-headers.test.ts.
    failoverPath: ['mock-1'],
    sessionLookupType: 'cold_start',
  };
  return effortRow
    ? { ...base, requestedEffort: 'high', actualEffort: 'medium', reasoningDegraded: true }
    : base;
}

let app: FastifyInstance;
let mitmPort = 0;
let mitmSrv: http.Server;

// Decision-row harness (step 4): a dedicated real-orchestrator server —
// native provider → fake upstream on 127.0.0.1 — because the decision
// pipeline bypasses orchestrator.process entirely (the chat stub/mock
// harnesses can never answer a systemone body).
let fakeUpstream: ReturnType<typeof serve>;
let soApp: FastifyInstance;
let soMitmPort = 0;
let soMitmSrv: http.Server;

// Mutable per-row MITM stub (tests in a file run sequentially): the row
// loop reassigns it before each fetch; the interceptor's closure reads it
// at request time.
let currentStub: unknown = stubResult(false);

async function fastifyKeys(row: Row): Promise<string[]> {
  const res = await (row.decision ? soApp : app).inject({
    method: 'POST',
    url: row.path,
    headers: { authorization: `Bearer ${TEST_KEY}`, 'content-type': 'application/json' },
    payload: row.body,
  });
  assert.equal(res.statusCode, 200, `${row.name}: fastify leg status`);
  return xOcrKeys(res.headers);
}

async function mitmKeys(row: Row): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${row.decision ? soMitmPort : mitmPort}${row.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(row.body),
  });
  assert.equal(res.status, 200, `${row.name}: mitm leg status`);
  await res.text(); // drain the body (SSE rows)
  return xOcrKeys(res.headers);
}

describe('surface-headers: X-OCR key-set golden matrix', () => {
  before(async () => {
    const config = loadConfig();
    config.host = '127.0.0.1';
    config.webAuth = { enabled: false };
    config.apiKeys = [
      {
        id: 'key-surface-headers',
        name: 'surface-headers fixture',
        key: TEST_KEY,
        role: 'user',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
    ];
    app = createServer(config, true).app; // mockMode

    const stubOrchestrator = {
      process: async () => currentStub,
    } as unknown as Parameters<typeof createProxyInterceptor>[0];
    const intercept = createProxyInterceptor(stubOrchestrator);
    mitmSrv = http.createServer((req, res) => {
      void intercept(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('passthrough');
        }
      });
    });
    await new Promise<void>((r) => mitmSrv.listen(0, '127.0.0.1', () => r()));
    mitmPort = (mitmSrv.address() as net.AddressInfo).port;

    // Decision rows: fake native upstream + a real createServer whose
    // orchestrator backs both the Fastify /v1/systemone route (table loop)
    // and a dedicated interceptor server for the MITM leg.
    fakeUpstream = serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        Response.json({
          model: 'jev-test',
          answers: { route: { type: 'choice', choice: 'billing', probabilities: { billing: 1 } } },
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
    });
    const soConfig = loadConfig();
    soConfig.host = '127.0.0.1';
    soConfig.webAuth = { enabled: false };
    soConfig.apiKeys = config.apiKeys;
    soConfig.providers = [
      {
        name: 'native-test',
        type: 'systemone',
        baseUrl: `http://127.0.0.1:${fakeUpstream.port}`,
        apiKey: 'sk-test',
      },
    ];
    soConfig.models = [
      {
        id: 'native-test/jev',
        provider: 'native-test',
        upstreamModel: 'jev-latest',
        tier: 'lite',
        pricing: { input: 0, output: 0, cacheRead: 0 },
      },
    ];
    soConfig.requestCapture = { ...soConfig.requestCapture, enabled: false };
    const so = createServer(soConfig);
    soApp = so.app;
    const soIntercept = createProxyInterceptor(so.orchestrator);
    soMitmSrv = http.createServer((req, res) => {
      void soIntercept(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('passthrough');
        }
      });
    });
    await new Promise<void>((r) => soMitmSrv.listen(0, '127.0.0.1', () => r()));
    soMitmPort = (soMitmSrv.address() as net.AddressInfo).port;
  });

  after(async () => {
    await app.close();
    await soApp.close();
    await new Promise<void>((r) => mitmSrv.close(() => r()));
    await new Promise<void>((r) => soMitmSrv.close(() => r()));
    fakeUpstream.stop(true);
  });

  for (const row of HEADER_ROWS) {
    it(`${row.name}: exact x-ocr-* key set`, async () => {
      currentStub = stubResult(row.expected.length > BASE13.length);
      const keys = row.leg === 'fastify' ? await fastifyKeys(row) : await mitmKeys(row);
      assert.deepEqual(keys, row.expected, `${row.name}: golden key set`);
    });
  }
});

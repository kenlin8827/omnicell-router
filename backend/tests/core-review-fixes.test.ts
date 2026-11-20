import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type http from 'node:http';
import { serve } from 'bun';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CanonicalRequest } from '../src/ir/types.js';
import { applyCompression } from '../src/compression/index.js';
import { injectCaveman } from '../src/compression/caveman.js';
import { compressToolOutputs } from '../src/compression/tool-output.js';
import { RespStore, type RespNode } from '../src/session/resp-store.js';
import { scanDirectives } from '../src/pipeline/directives.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { LLMProvider } from '../src/providers/base.js';
import type { ModelRegistration } from '../src/config/types.js';
import { createNodeHttpTransport } from '../src/surfaces/transport-node-http.js';
import { createFastifyTransport } from '../src/surfaces/transport-fastify.js';
import { writeWithBackpressure } from '../src/surfaces/transport-backpressure.js';
import { chatSurface } from '../src/surfaces/chat.js';
import { responsesSurface } from '../src/surfaces/responses.js';
import { emitClientRequest, setClientExchangeContext } from '../src/observability/http-exchange.js';
import { V1ToV2Migrate } from '../src/capture/migrate/steps/v1-to-v2.js';
import { clientRenderableDefs } from '../src/opencode/credentials/def-materialize.js';
import { responseIR } from './helpers/ir.js';

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('Module 3 review bug fixes', () => {
  it('1a. Headroom write-back fails open without mutating request.instructions when chatRequestToIR throws', async () => {
    const request: CanonicalRequest = {
      model: 'auto',
      stream: false,
      instructions: 'original instructions',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ],
    };
    const server = serve({
      port: 0,
      async fetch() {
        return Response.json({
          messages: [
            { role: 'system', content: 'mutated instructions' },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bad', content: 'x' }] },
          ],
          tokens_before: 20,
          tokens_after: 10,
          tokens_saved: 10,
          compression_ratio: 0.5,
        });
      },
    });
    try {
      const outcome = await applyCompression(request, {
        headroom: { enabled: true, url: `http://127.0.0.1:${server.port}`, timeoutMs: 1000 },
      });
      expect(outcome.headroom).toBeNull();
      expect(outcome.headroomSkippedReason).toBeTruthy();
      expect(request.instructions).toBe('original instructions');
    } finally {
      server.stop(true);
    }
  });

  it('2. compressToolOutputs and injectCaveman do not mutate cached RespNode objects in RespStore', () => {
    const store = new RespStore();
    const longGitStatus = 'On branch main\nChanges not staged for commit:\n  modified:   a.ts\n'.repeat(40);
    const node: RespNode = {
      v: 2,
      id: 'resp_1',
      parent: null,
      sessionId: 'sess_1',
      model: 'mock-1',
      input: [
        { type: 'message', role: 'system', content: [{ type: 'text', text: 'base system' }] },
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'status' }] },
        { type: 'tool_result', callId: 'call_1', content: [{ type: 'text', text: longGitStatus }] },
      ],
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
      createdAt: Date.now(),
    };
    store.append(node);

    const built = store.buildInput('resp_1')!;
    const request: CanonicalRequest = {
      model: 'auto',
      stream: false,
      input: [...built.input, { type: 'message', role: 'user', content: [{ type: 'text', text: 'next' }] }],
    };

    const stats = compressToolOutputs(request, true);
    expect(stats!.hits.length).toBeGreaterThan(0);
    expect(injectCaveman(request, 'full')).toBe(true);

    // Cached RespNode must remain completely untouched.
    const stored = store.get('resp_1')!;
    const storedSystem = stored.input[0];
    expect(storedSystem.type).toBe('message');
    if (storedSystem.type === 'message') {
      expect(storedSystem.content).toHaveLength(1);
      expect(storedSystem.content[0]).toEqual({ type: 'text', text: 'base system' });
    }
    const storedToolResult = stored.input[2];
    expect(storedToolResult.type).toBe('tool_result');
    if (storedToolResult.type === 'tool_result') {
      expect(storedToolResult.content[0]).toEqual({ type: 'text', text: longGitStatus });
    }
  });

  it('3. scanDirectives and PipelineOrchestrator scrub @ocr-* directives from request.instructions', async () => {
    const scan = scanDirectives(
      [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      '@ocr-',
      'Follow rules @ocr-tier-up and @ocr-typo',
    );
    expect(scan.instructions).toBe('Follow rules and');
    expect(scan.effective).toHaveLength(0);
    expect(scan.all.map((h) => h.action)).toEqual(['tier_up']);
    expect(scan.unknown.map((u) => u.token)).toEqual(['@ocr-typo']);

    // Verify orchestrator forwards scrubbed instructions to the provider.
    let seenRequest: CanonicalRequest | undefined;
    const provider: LLMProvider = {
      name: 'mock',
      createCompletion: async (req) => {
        seenRequest = req;
        return responseIR('ok', { model: 'mock/m1' });
      },
      createStream: async (req) => {
        seenRequest = req;
        const response = responseIR('ok', { model: 'mock/m1' });
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'response.completed' as const, response };
          },
        };
      },
    };
    const model: ModelRegistration = {
      id: 'mock/m1',
      provider: 'mock',
      upstreamModel: 'm1',
      tier: 'plus',
      wire: 'openai-chat',
      pricing: { input: 1, output: 1, cacheRead: 0.1 },
    };
    const registry = new ProviderRegistry({ models: [] } as any);
    registry.registerProvider('mock', provider);
    registry.registerModel(model);
    const orchestrator = new PipelineOrchestrator(
      {
        models: [model],
        providers: {},
        routing: { defaultTier: 'plus' },
      } as any,
      registry,
      { record: () => {} } as any,
    );

    await orchestrator.process({
      model: 'mock/m1',
      stream: false,
      instructions: 'System prompt @ocr-tier-ultra @ocr-unknown-token',
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(seenRequest).toBeDefined();
    expect(seenRequest!.instructions).not.toContain('@ocr-');
    expect(seenRequest!.instructions).toBe('System prompt');
  });

  it('4. RespStore.compact() does not overwrite concurrent appends or drop in-flight deletes', async () => {
    const dir = makeTmpDir('ocr-resp-race-');
    const file = path.join(dir, 'chain.jsonl');
    const store = new RespStore();
    store.enablePersistence({ filePath: file });

    const makeNode = (id: string, sessionId: string, createdAt: number): RespNode => ({
      v: 2,
      id,
      parent: null,
      sessionId,
      model: 'm',
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: id }] }],
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: `a-${id}` }] }],
      createdAt,
    });

    const base = Date.now();
    store.append(makeNode('r1', 'sess_a', base));
    store.append(makeNode('r2', 'sess_b', base + 1));
    await store.flushPersistence();

    // Pause compaction #1 after snapshot / inside writeFile so we can
    // deterministically interleave append() and deleteBySession().
    const origWriteFile = fs.promises.writeFile;
    let releaseFirstWrite!: () => void;
    let firstWriteEntered!: () => void;
    const enteredPromise = new Promise<void>((r) => { firstWriteEntered = r; });
    const gatePromise = new Promise<void>((r) => { releaseFirstWrite = r; });
    let writeCalls = 0;

    (fs.promises as any).writeFile = async (p: fs.PathLike, data: any, opts?: any) => {
      writeCalls++;
      if (writeCalls === 1) {
        firstWriteEntered();
        await gatePromise;
      }
      return origWriteFile.call(fs.promises, p, data, opts);
    };

    try {
      const compacting = store.compact();
      await enteredPromise;

      // While compaction #1 is in flight (snapshot already taken with r1, r2):
      // 1) Append r3 — must not be lost when compaction #1 renames tmp over file.
      // 2) Delete sess_a — must trigger a follow-up compaction so r1 does not resurrect.
      store.append(makeNode('r3', 'sess_c', base + 2));
      store.deleteBySession('sess_a');

      // Give unserialized appendFile a tick to land on disk before rename #1 (reproduces race).
      await new Promise((r) => setTimeout(r, 20));
      releaseFirstWrite();
      await compacting;
      await store.flushPersistence();
    } finally {
      (fs.promises as any).writeFile = origWriteFile;
    }

    const reloaded = new RespStore();
    reloaded.enablePersistence({ filePath: file });
    expect(reloaded.get('r1')).toBeUndefined();
    expect(reloaded.get('r2')).toBeDefined();
    expect(reloaded.get('r3')).toBeDefined();
  });

  it('5. node-http relayUpstream finalizes capture with 499 on premature client disconnect', () => {
    const req = new EventEmitter() as http.IncomingMessage;
    req.method = 'POST';
    req.url = '/v1/chat/completions';
    req.headers = {};
    (req as any).socket = { remoteAddress: '127.0.0.1', destroyed: false };

    const res = new EventEmitter() as http.ServerResponse;
    (res as any).writableEnded = false;
    (res as any).destroyed = false;
    (res as any).socket = { destroyed: false };
    (res as any).writeHead = () => res;
    (res as any).write = () => true;
    (res as any).end = () => { (res as any).writableEnded = true; return res; };
    (res as any).destroy = () => { (res as any).destroyed = true; return res; };
    (res as any).getHeader = () => undefined;

    const events: any[] = [];
    const recorder = {
      isEnabled: () => true,
      recordEvent: (ev: any) => { events.push(ev); },
    } as any;

    const transport = createNodeHttpTransport(req, res, true);
    const captureCtx = transport.captureProcessContext();
    const clientCtx = emitClientRequest({
      recorder,
      req: captureCtx.clientRequest,
      body: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      sessionId: 'sess_1',
      requestId: 'req_1',
      model: 'auto',
    });
    captureCtx.onClientExchange!(clientCtx);

    const upstream = new PassThrough();
    transport.relayUpstream!({
      statusCode: 200,
      statusMessage: 'OK',
      headers: { 'content-type': 'text/event-stream' },
      stream: upstream,
    });

    // Simulate premature client disconnect: res emits 'close' while !writableEnded.
    res.emit('close');

    const responseEvents = events.filter((e) => e.direction === 'client' && e.phase === 'response');
    expect(responseEvents).toHaveLength(1);
    expect(responseEvents[0].wire.status).toBe(499);
  });

  it('6a. writeWithBackpressure returns immediately when write() synchronously destroys response', async () => {
    const response = new EventEmitter() as http.ServerResponse;
    (response as any).destroyed = false;
    (response as any).writableEnded = false;
    response.write = (() => {
      (response as any).destroyed = true;
      response.emit('close');
      return false;
    }) as any;

    const started = Date.now();
    await writeWithBackpressure(response, 'chunk', () => {}, 500);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(150);
  });

  it('6b. Fastify and node-http transports treat destroyed response (with null socket) as client gone', () => {
    // Node-http transport
    const nReq = new EventEmitter() as http.IncomingMessage;
    nReq.method = 'POST';
    nReq.url = '/v1/chat/completions';
    nReq.headers = {};
    (nReq as any).socket = { remoteAddress: '127.0.0.1' };

    const nRes = new EventEmitter() as http.ServerResponse;
    (nRes as any).destroyed = true;
    (nRes as any).socket = null;
    (nRes as any).writableEnded = false;
    (nRes as any).writeHead = () => nRes;
    (nRes as any).end = () => nRes;
    (nRes as any).getHeader = () => undefined;

    const nEvents: any[] = [];
    const nRecorder = { isEnabled: () => true, recordEvent: (ev: any) => nEvents.push(ev) } as any;
    const nTransport = createNodeHttpTransport(nReq, nRes, true);
    const nCtx = emitClientRequest({
      recorder: nRecorder,
      req: nTransport.captureProcessContext().clientRequest,
      body: {},
      sessionId: 's1',
      requestId: 'r1',
      model: 'auto',
    });
    nTransport.captureProcessContext().onClientExchange!(nCtx);
    expect(nTransport.isClientGone()).toBe(true);
    nTransport.endSse();
    const nResp = nEvents.find((e) => e.direction === 'client' && e.phase === 'response');
    expect(nResp?.wire.status).toBe(499);

    // Fastify transport
    const raw = new EventEmitter() as http.ServerResponse;
    (raw as any).destroyed = true;
    (raw as any).socket = null;
    (raw as any).writableEnded = false;
    (raw as any).end = () => raw;

    const fReq = {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {},
      ip: '127.0.0.1',
      log: { error: () => {} },
    } as unknown as FastifyRequest;
    const fReply = {
      raw,
      statusCode: 200,
      header: () => fReply,
      getHeaders: () => ({}),
      getHeader: () => undefined,
      status: () => fReply,
      send: () => Promise.resolve(),
    } as unknown as FastifyReply;

    const fEvents: any[] = [];
    const fRecorder = { isEnabled: () => true, recordEvent: (ev: any) => fEvents.push(ev) } as any;
    const fCtx = emitClientRequest({
      recorder: fRecorder,
      req: fReq,
      body: {},
      sessionId: 's2',
      requestId: 'r2',
      model: 'auto',
    });
    setClientExchangeContext(fReq, fCtx);

    const fTransport = createFastifyTransport(fReq, fReply, {
      getRegistry: () => ({ getModel: () => undefined }) as any,
    });
    expect(fTransport.isClientGone()).toBe(true);
    fTransport.endSse();
    const fResp = fEvents.find((e) => e.direction === 'client' && e.phase === 'response');
    expect(fResp?.wire.status).toBe(499);
  });

  it('7. V1ToV2Migrate falls back to recorded pair instead of throwing on legacy Anthropic tool_result records', () => {
    const step = new V1ToV2Migrate();
    const line: Record<string, unknown> = {
      id: 'evt_1',
      ts: 1000,
      eventType: 'http-exchange',
      sessionId: 'sess_anth',
      direction: 'client',
      phase: 'request',
      spanId: 'span_1',
      promptMessageCount: 2,
      promptLastUserIdx: 1,
      wire: {
        requestBody: JSON.stringify({
          model: 'claude-3-5-sonnet',
          messages: [
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
          ],
        }),
      },
    };

    expect(() => step.begin({ filePath: 'test.jsonl', lines: [line] })).not.toThrow();
    const verdict = step.migrate(line, { filePath: 'test.jsonl', index: 0, total: 1 });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.line.turnIndex).toBe(1);
      expect(verdict.line.isPromptStart).toBe(true);
    }
  });

  it('8. chatSurface.parse and responsesSurface.parse gate errorCode on IrUnsupportedError', () => {
    // Non-IrUnsupportedError (TypeError from null message element) must not get unsupported_parameter.
    const chatBad = chatSurface.parse({ model: 'auto', messages: [null] });
    expect(chatBad.error).toBeTruthy();
    expect(chatBad.errorCode).toBeUndefined();

    // Real IrUnsupportedError in chatSurface still gets unsupported_parameter.
    const chatUnsupported = chatSurface.parse({
      model: 'auto',
      messages: [{ role: 'user', content: [{ type: 'unknown_part' }] }],
    });
    expect(chatUnsupported.error).toBeTruthy();
    expect(chatUnsupported.errorCode).toBe('unsupported_parameter');

    // Non-IrUnsupportedError in responsesSurface (e.g. a getter throwing plain Error).
    const throwingBody = {
      model: 'auto',
      get input() {
        throw new TypeError('unexpected runtime error');
      },
    };
    const respBad = responsesSurface.parse(throwingBody);
    expect(respBad.error).toBeTruthy();
    expect(respBad.errorCode).toBeUndefined();

    // Missing input in responsesSurface still throws IrUnsupportedError -> unsupported_parameter.
    const respMissing = responsesSurface.parse({ model: 'auto' });
    expect(respMissing.errorCode).toBe('unsupported_parameter');
  });

  it('9. stripSecretsFromDefNode redacts secret headers inside settings.headers', () => {
    const rendered = clientRenderableDefs({
      custom: {
        package: 'openai-chat',
        settings: {
          baseURL: 'https://relay.example.test/v1',
          apiKey: 'sk-secret-key',
          headers: {
            Authorization: 'Bearer sk-header-secret',
            'X-Api-Key': 'secret-2',
            'X-Custom-Header': 'keep-me',
          },
        },
      },
    });
    expect(rendered.custom.settings.apiKey).toBeUndefined();
    expect(rendered.custom.settings.headers.Authorization).toBe('[REDACTED]');
    expect(rendered.custom.settings.headers['X-Api-Key']).toBe('[REDACTED]');
    expect(rendered.custom.settings.headers['X-Custom-Header']).toBe('keep-me');
  });

  it('10. RespStore.flushPersistence() waits for queued compactDirty follow-up compaction', async () => {
    const dir = makeTmpDir('ocr-resp-flush-');
    const file = path.join(dir, 'chain.jsonl');
    const store = new RespStore();
    store.enablePersistence({ filePath: file });

    const makeNode = (id: string, sessionId: string, createdAt: number): RespNode => ({
      v: 2,
      id,
      parent: null,
      sessionId,
      model: 'm',
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: id }] }],
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: `a-${id}` }] }],
      createdAt,
    });

    const base = Date.now();
    store.append(makeNode('r1', 'sess_a', base));
    store.append(makeNode('r2', 'sess_b', base + 1));
    await store.flushPersistence();

    const origWriteFile = fs.promises.writeFile;
    let firstWriteEntered!: () => void;
    let releaseFirstWrite!: () => void;
    const enteredPromise = new Promise<void>((r) => { firstWriteEntered = r; });
    const gatePromise = new Promise<void>((r) => { releaseFirstWrite = r; });
    let writeCalls = 0;

    (fs.promises as any).writeFile = async (p: fs.PathLike, data: any, opts?: any) => {
      writeCalls++;
      if (writeCalls === 1) {
        firstWriteEntered();
        await gatePromise;
      } else if (writeCalls === 2) {
        await new Promise((r) => setTimeout(r, 40));
      }
      return origWriteFile.call(fs.promises, p, data, opts);
    };

    try {
      void store.compact();
      await enteredPromise;

      // Queue a follow-up compaction pass while pass #1 is in flight.
      store.deleteBySession('sess_a');

      const flushed = store.flushPersistence();
      releaseFirstWrite();
      await flushed;

      // Disk must already reflect the follow-up compaction (r1 purged).
      const reloaded = new RespStore();
      reloaded.enablePersistence({ filePath: file });
      expect(reloaded.get('r1')).toBeUndefined();
      expect(reloaded.get('r2')).toBeDefined();
    } finally {
      (fs.promises as any).writeFile = origWriteFile;
    }
  });

  it('11. Fastify and node-http relayUpstream finalize capture with 200 when pipe end() closes/destroys response', async () => {
    // 11a. Fastify: 'close' after writableEnded must not mark client gone, and
    // relayUpstream must finalize capture before pipe's onend destroys reply.raw.
    const raw = new EventEmitter() as http.ServerResponse;
    (raw as any).writableEnded = false;
    (raw as any).destroyed = false;
    (raw as any).socket = { destroyed: false };
    (raw as any).writeHead = () => raw;
    (raw as any).write = () => true;
    (raw as any).end = () => {
      (raw as any).writableEnded = true;
      raw.emit('close');
      (raw as any).destroyed = true;
      return raw;
    };
    (raw as any).destroy = () => { (raw as any).destroyed = true; return raw; };

    // Also verify writableEnded + close alone does not flip closed = true.
    const rawEndedOnly = new EventEmitter() as http.ServerResponse;
    (rawEndedOnly as any).writableEnded = true;
    (rawEndedOnly as any).destroyed = false;
    (rawEndedOnly as any).socket = { destroyed: false };
    const fReqEnded = {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {},
      ip: '127.0.0.1',
      log: { error: () => {} },
    } as unknown as FastifyRequest;
    const fReplyEnded = {
      raw: rawEndedOnly,
      statusCode: 200,
      header: () => fReplyEnded,
      getHeaders: () => ({}),
      getHeader: () => undefined,
      status: () => fReplyEnded,
      send: () => Promise.resolve(),
    } as unknown as FastifyReply;
    const fTransportEnded = createFastifyTransport(fReqEnded, fReplyEnded, {
      getRegistry: () => ({ getModel: () => undefined }) as any,
    });
    rawEndedOnly.emit('close');
    expect(fTransportEnded.isClientGone()).toBe(false);

    const fReq = {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {},
      ip: '127.0.0.1',
      log: { error: () => {} },
    } as unknown as FastifyRequest;
    const fReply = {
      raw,
      statusCode: 200,
      header: () => fReply,
      getHeaders: () => ({}),
      getHeader: () => undefined,
      status: () => fReply,
      send: () => Promise.resolve(),
    } as unknown as FastifyReply;

    const fEvents: any[] = [];
    const fRecorder = { isEnabled: () => true, recordEvent: (ev: any) => fEvents.push(ev) } as any;
    const fCtx = emitClientRequest({
      recorder: fRecorder,
      req: fReq,
      body: {},
      sessionId: 's_fast_relay',
      requestId: 'r_fast_relay',
      model: 'auto',
    });
    setClientExchangeContext(fReq, fCtx);

    const fTransport = createFastifyTransport(fReq, fReply, {
      getRegistry: () => ({ getModel: () => undefined }) as any,
    });
    const fUpstream = new PassThrough();
    fTransport.relayUpstream!({
      statusCode: 200,
      statusMessage: 'OK',
      headers: { 'content-type': 'text/plain' },
      stream: fUpstream,
    });
    fUpstream.end('ok');
    await new Promise((r) => setTimeout(r, 10));

    const fResp = fEvents.filter((e) => e.direction === 'client' && e.phase === 'response');
    expect(fResp).toHaveLength(1);
    expect(fResp[0].wire.status).toBe(200);

    // 11b. Node-http: relayUpstream must finalize capture before pipe's onend destroys res.
    const nReq = new EventEmitter() as http.IncomingMessage;
    nReq.method = 'POST';
    nReq.url = '/v1/chat/completions';
    nReq.headers = {};
    (nReq as any).socket = { remoteAddress: '127.0.0.1', destroyed: false };

    const nRes = new EventEmitter() as http.ServerResponse;
    (nRes as any).statusCode = 200;
    (nRes as any).statusMessage = 'OK';
    (nRes as any).writableEnded = false;
    (nRes as any).destroyed = false;
    (nRes as any).socket = { destroyed: false };
    (nRes as any).writeHead = (code: number, msg?: string) => {
      (nRes as any).statusCode = code;
      if (msg) (nRes as any).statusMessage = msg;
      return nRes;
    };
    (nRes as any).write = () => true;
    (nRes as any).end = () => {
      (nRes as any).writableEnded = true;
      (nRes as any).destroyed = true;
      nRes.emit('close');
      return nRes;
    };
    (nRes as any).destroy = () => { (nRes as any).destroyed = true; return nRes; };
    (nRes as any).getHeader = () => undefined;

    const nEvents: any[] = [];
    const nRecorder = { isEnabled: () => true, recordEvent: (ev: any) => nEvents.push(ev) } as any;
    const nTransport = createNodeHttpTransport(nReq, nRes, true);
    const nCapture = nTransport.captureProcessContext();
    const nCtx = emitClientRequest({
      recorder: nRecorder,
      req: nCapture.clientRequest,
      body: {},
      sessionId: 's_node_relay',
      requestId: 'r_node_relay',
      model: 'auto',
    });
    nCapture.onClientExchange!(nCtx);

    const nUpstream = new PassThrough();
    nTransport.relayUpstream!({
      statusCode: 200,
      statusMessage: 'OK',
      headers: { 'content-type': 'text/plain' },
      stream: nUpstream,
    });
    nUpstream.end('ok');
    await new Promise((r) => setTimeout(r, 10));

    const nResp = nEvents.filter((e) => e.direction === 'client' && e.phase === 'response');
    expect(nResp).toHaveLength(1);
    expect(nResp[0].wire.status).toBe(200);
  });
});

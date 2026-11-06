// cursor-gateway plugin tests — drives the gateway with a FAKE ClientGatewayHost
// (scripted chat() sink frames) and mock h1 req/res carrying Connect frames.
// Run: bun --no-env-file scripts/test-isolated.ts cursor-gateway
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClientGatewayHost, ClientGatewayPlugin, GatewayChatSink } from '../../backend/src/plugins/types.js';

// The cursor-gateway plugin sources live in the gitignored dev tree
// (/plugins/ is in .gitignore), so they are absent on a fresh clone / CI.
// Bun's node:test compat layer ignores the `skip` option (see
// opencode.test.ts), so registration is conditional instead: the plugin
// modules are imported dynamically inside the guard and the whole suite is
// only registered when the dev tree exists. Behavior is identical otherwise.
const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../plugins/cursor-gateway');
if (fs.existsSync(path.join(PLUGIN_DIR, 'plugin.json'))) {
  // Dynamic import: the plugin modules only exist in the gitignored dev tree
  // (plugin loading from a runtime tree) — a static import would throw at
  // module load on a fresh clone / CI before any test runs.
  const { createPlugin } = await import('../../plugins/cursor-gateway/index.js');
  const { cursorRoot, cursorTypes, decodeToObject, encodeFromObject } = await import('../../plugins/cursor-gateway/protos.js');
  const { FrameParser, decodeTrailer, encodeFrame } = await import('../../plugins/cursor-gateway/wire.js');

  const PATH_BIDI = '/aiserver.v1.ChatService/StreamUnifiedChatWithTools';
  const PATH_STREAM = '/aiserver.v1.ChatService/StreamUnifiedChat';
  const PATH_MODELS = '/aiserver.v1.AiService/AvailableModels';
  const PATH_UNKNOWN = '/aiserver.v1.AiService/SomeUnclaimedRpc';

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function reqEnvelopePayload(obj: Record<string, unknown>): Buffer {
    return encodeFromObject(cursorRoot(), cursorTypes.reqEnvelope, obj);
  }

  /** Interactive mock request: push() emits chunks as the "client" writes them. */
  class MockReq extends EventEmitter {
    method = 'POST';
    url: string;
    headers: Record<string, string> = { host: 'api2.cursor.sh' };

    constructor(url: string) {
      super();
      this.url = url;
    }

    push(chunk: Buffer | null): void {
      if (chunk === null) this.emit('end');
      else this.emit('data', chunk);
    }
  }

  /** Mock h1 response: collects written bytes; writeHead records status/headers. */
  class MockRes extends Writable {
    status = 0;
    headers: Record<string, unknown> = {};
    chunks: Buffer[] = [];

    writeHead(status: number, headers?: Record<string, unknown>): void {
      this.status = status;
      this.headers = headers ?? {};
    }

    override end(...args: Parameters<Writable['end']>): this {
      super.end(...args);
      return this;
    }

    override _write(chunk: Buffer, _enc: string, cb: (e?: Error | null) => void): void {
      this.chunks.push(chunk);
      cb();
    }
  }

  /** Parse a response buffer into Connect frames. */
  function framesOf(buf: Buffer): Array<{ endStream: boolean; payload: Buffer }> {
    const out: Array<{ endStream: boolean; payload: Buffer }> = [];
    const parser = new FrameParser((f) => out.push({ endStream: f.endStream, payload: f.payload }));
    parser.push(buf);
    return out;
  }

  /**
   * Fake host: each chat() call plays the next scripted turn and resolves the
   * returned promise after the sink terminal — deterministic turn gating.
   */
  function fakeHost(
    turns: Array<{ chunks: string[] }>,
    ocrHome: string,
    opts: {
      onChat?: (body: Record<string, unknown>, i: number) => void;
      config?: Record<string, unknown>;
      logs?: string[];
    } = {},
  ): ClientGatewayHost & { turnDone(i: number): Promise<void> } {
    const gates = turns.map(() => Promise.withResolvers<void>());
    let calls = 0;
    return {
      log(...args: unknown[]) {
        opts.logs?.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
      },
      ocrHome: () => ocrHome,
      config: () => ({ ...opts.config }),
      catalog: () => ({
        tiers: ['auto', 'lite', 'plus', 'pro', 'ultra'],
        models: [{ id: 'gpt-x', label: 'GPT X' }],
      }),
      turnDone: (i: number) => gates[i].promise,
      async chat(body, sink: GatewayChatSink) {
        const i = calls++;
        opts.onChat?.(body, i);
        const turn = turns[i];
        if (!turn) throw new Error(`unexpected chat call #${i + 1}`);
        for (const c of turn.chunks) sink.onChunk(c);
        sink.onEnd();
        gates[i].resolve();
      },
    };
  }

  const TEXT = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
  const TEXT2 = 'data: {"choices":[{"delta":{"content":" world"}}]}\n\n';
  const DONE = 'data: [DONE]\n\n';
  const TOOL_CALL_CHUNK =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}\n\n';

  /** Bidi client request frame: first StreamUnifiedChatRequest with a human turn. */
  function bidiRequestFrame(text: string, supportedTools: number[] = []): Buffer {
    return encodeFrame(reqEnvelopePayload({
      stream_unified_chat_request: {
        conversation: [{ text, type: 1 }],
        supported_tools: supportedTools,
        model_details: { model_id: 'gpt-x' },
      },
    }));
  }

  /** Bidi tool-result frame: ClientSideToolV2Result with read_file_result (oneof member 6). */
  function toolResultFrame(toolCallId: string, contents: string): Buffer {
    return encodeFrame(reqEnvelopePayload({
      client_side_tool_v2_result: {
        tool: 5, // CLIENT_SIDE_TOOL_V2_READ_FILE
        tool_call_id: toolCallId,
        read_file_result: { contents },
      },
    }));
  }

  /** Collect the text deltas at response path [2,1]. */
  function resTexts(buf: Buffer): string[] {
    const texts: string[] = [];
    for (const f of framesOf(buf)) {
      if (f.endStream) continue;
      const env = decodeToObject(cursorRoot(), cursorTypes.resEnvelope, f.payload);
      if (env.stream_unified_chat_response?.text) texts.push(env.stream_unified_chat_response.text);
    }
    return texts;
  }

  function resToolCalls(buf: Buffer): Array<Record<string, any>> {
    const calls: Array<Record<string, any>> = [];
    for (const f of framesOf(buf)) {
      if (f.endStream) continue;
      const env = decodeToObject(cursorRoot(), cursorTypes.resEnvelope, f.payload);
      if (env.client_side_tool_v2_call) calls.push(env.client_side_tool_v2_call);
    }
    return calls;
  }

  function tmpHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cursor-gw-'));
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  describe('cursor-gateway wire codec', () => {
    it('frame round-trip: flags, big-endian length, gzip flag handling', () => {
      const payload = Buffer.from('hello');
      const plain = framesOf(encodeFrame(payload));
      assert.equal(plain.length, 1);
      assert.equal(plain[0].endStream, false);
      assert.equal(plain[0].payload.toString(), 'hello');

      const gz = framesOf(encodeFrame(payload, { gzip: true }));
      assert.equal(gz[0].payload.toString(), 'hello', 'gzip flag is transparently gunzipped');

      const end = framesOf(encodeFrame(Buffer.from('{}'), { endStream: true }));
      assert.equal(end[0].endStream, true);
      assert.deepEqual(decodeTrailer(end[0].payload), {});
    });
  });

  describe('cursor-gateway StreamUnifiedChatWithTools (bidi agent loop)', () => {
    it('text-only turn: deltas decode at [2,1], terminal empty-trailer frame ends the stream', async () => {
      const plugin = createPlugin(fakeHost([{ chunks: [TEXT, TEXT2, DONE] }], tmpHome()));
      const req = new MockReq(PATH_BIDI);
      const res = new MockRes();
      const done = plugin.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      req.push(bidiRequestFrame('hi'));
      req.push(null);
      await done;

      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'application/connect+proto');
      assert.deepEqual(resTexts(Buffer.concat(res.chunks)), ['Hello', ' world']);
      const frames = framesOf(Buffer.concat(res.chunks));
      const last = frames[frames.length - 1];
      assert.equal(last.endStream, true, 'terminal 0x80 frame');
      assert.deepEqual(decodeTrailer(last.payload), {}, 'empty success trailer');
      assert.equal(frames.slice(0, -1).some((f) => f.endStream), false, 'no premature end-stream');
    });

    it('tool round-trip: tool_call frame encodes enum+name+raw_args; result frame triggers second chat with role:tool message', async () => {
      const bodies: Array<Record<string, unknown>> = [];
      const host = fakeHost(
        [
          { chunks: [TOOL_CALL_CHUNK, DONE] },
          { chunks: [TEXT2, DONE] },
        ],
        tmpHome(),
        { onChat: (b) => bodies.push(structuredClone(b)) },
      );
      const plugin = createPlugin(host);
      const req = new MockReq(PATH_BIDI);
      const res = new MockRes();
      const done = plugin.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);

      req.push(bidiRequestFrame('read a.ts', [5])); // 5 = CLIENT_SIDE_TOOL_V2_READ_FILE
      await host.turnDone(0); // first chat turn (tool_call emitted) finished
      // Client answers with the tool result → the loop must run a second turn.
      req.push(toolResultFrame('call_1', 'file contents'));
      req.push(null);
      await done;

      // Tool-call frame content.
      const call = resToolCalls(Buffer.concat(res.chunks))[0];
      assert.equal(call.tool, 5, 'tool enum value READ_FILE');
      assert.equal(call.name, 'read_file');
      assert.deepEqual(JSON.parse(call.raw_args), { path: 'a.ts' });
      assert.equal(call.tool_call_id, 'call_1');
      assert.equal(call.timeout_ms, undefined, 'timeout_ms omitted at the 0 default');

      // Second chat call carries the serialized tool result.
      assert.equal(bodies.length, 2, 'two host.chat calls');
      const toolMsg = bodies[1].messages?.find((m: Record<string, unknown>) => m.role === 'tool');
      assert.ok(toolMsg, 'role:tool message present');
      assert.equal(toolMsg.tool_call_id, 'call_1');
      const parsed = JSON.parse(toolMsg.content as string);
      assert.deepEqual(parsed.result.read_file_result, { contents: 'file contents' });

      // Final turn text + terminal trailer.
      assert.ok(resTexts(Buffer.concat(res.chunks)).includes(' world'));
      const frames = framesOf(Buffer.concat(res.chunks));
      assert.equal(frames[frames.length - 1].endStream, true);
      assert.deepEqual(decodeTrailer(frames[frames.length - 1].payload), {});
    });
  });

  describe('cursor-gateway operator config', () => {
    it('relayUnknownPaths:false answers an unimplemented trailer without relaying', async () => {
      const plugin = createPlugin(fakeHost([], tmpHome(), { config: { relayUnknownPaths: false } }));
      const req = new MockReq(PATH_UNKNOWN);
      const res = new MockRes();
      const done = plugin.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      req.push(encodeFrame(Buffer.alloc(0)));
      req.push(null);
      await done;

      // Exactly one local end-stream frame: nothing was proxied to an upstream host.
      const frames = framesOf(Buffer.concat(res.chunks));
      assert.equal(frames.length, 1, 'single local reply frame');
      assert.equal(frames[0].endStream, true, 'terminal 0x80 trailer');
      const trailer = decodeTrailer(frames[0].payload) as { error?: { code?: string; message?: string } };
      assert.equal(trailer.error?.code, 'unimplemented');
      assert.match(trailer.error?.message ?? '', /relayUnknownPaths=false/);
    });

    it('toolTimeoutMs:5000 stamps timeout_ms on the tool-call frame', async () => {
      const host = fakeHost(
        [
          { chunks: [TOOL_CALL_CHUNK, DONE] },
          { chunks: [TEXT2, DONE] },
        ],
        tmpHome(),
        { config: { toolTimeoutMs: 5000 } },
      );
      const plugin = createPlugin(host);
      const req = new MockReq(PATH_BIDI);
      const res = new MockRes();
      const done = plugin.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);

      req.push(bidiRequestFrame('read a.ts', [5]));
      await host.turnDone(0);
      req.push(toolResultFrame('call_1', 'file contents'));
      req.push(null);
      await done;

      const call = resToolCalls(Buffer.concat(res.chunks))[0];
      assert.equal(call.tool, 5);
      assert.equal(call.timeout_ms, 5000, 'configured timeout stamped on the call frame');
    });

    it('debugFrames:true traces inbound and outbound frames', async () => {
      const logs: string[] = [];
      const plugin = createPlugin(fakeHost(
        [{ chunks: [TEXT, DONE] }],
        tmpHome(),
        { config: { debugFrames: true }, logs },
      ));
      const req = new MockReq(PATH_BIDI);
      const res = new MockRes();
      const done = plugin.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      req.push(bidiRequestFrame('hi'));
      req.push(null);
      await done;

      assert.ok(logs.some((l) => l.startsWith('[frame] dir=in')), 'inbound frame traced');
      assert.ok(logs.some((l) => l.startsWith('[frame] dir=out')), 'outbound frame traced');
    });
  });

  describe('cursor-gateway StreamUnifiedChat (server-stream)', () => {
    it('bare response text rides top-level field 1', async () => {
      const plugin = createPlugin(fakeHost([{ chunks: [TEXT, DONE] }], tmpHome()));
      const req = Readable.from([encodeFrame(encodeFromObject(cursorRoot(), cursorTypes.req, {
        conversation: [{ text: 'hello', type: 1 }],
        model_details: { model_id: 'gpt-x' },
      }))]);
      (req as unknown as IncomingMessage).method = 'POST';
      (req as unknown as IncomingMessage).url = PATH_STREAM;
      const res = new MockRes();
      await plugin.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);

      const texts: string[] = [];
      for (const f of framesOf(Buffer.concat(res.chunks))) {
        if (f.endStream) continue;
        const bare = decodeToObject(cursorRoot(), cursorTypes.res, f.payload);
        if (bare.text) texts.push(bare.text);
      }
      assert.deepEqual(texts, ['Hello']);
    });
  });

  describe('cursor-gateway AvailableModels (unary)', () => {
    function advertised(res: MockRes): { names: string[]; modelNames: Array<Record<string, unknown>> } {
      const frames = framesOf(Buffer.concat(res.chunks));
      assert.equal(frames.length, 1, 'unary = one frame');
      assert.equal(frames[0].endStream, false);
      const obj = decodeToObject(cursorRoot(), cursorTypes.availableModelsRes, frames[0].payload);
      return { names: obj.model_names ?? [], modelNames: obj.models ?? [] };
    }

    it('models.json contract wins when present', async () => {
      const home = tmpHome();
      fs.mkdirSync(path.join(home, 'gateways', 'cursor'), { recursive: true });
      fs.writeFileSync(path.join(home, 'gateways', 'cursor', 'models.json'), JSON.stringify({ models: ['auto', 'my-model'] }));
      const plugin = createPlugin(fakeHost([], home));
      const req = Readable.from([encodeFrame(Buffer.alloc(0))]);
      (req as unknown as IncomingMessage).method = 'POST';
      (req as unknown as IncomingMessage).url = PATH_MODELS;
      const res = new MockRes();
      await plugin.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);

      const adv = advertised(res);
      assert.deepEqual(adv.names, ['auto', 'my-model']);
      // Both model_names (1) and models (2) are populated.
      assert.deepEqual(adv.modelNames.map((m) => m.name), ['auto', 'my-model']);
    });

    it('catalog fallback (tiers then model ids) when models.json is absent', async () => {
      const plugin = createPlugin(fakeHost([], tmpHome()));
      const req = Readable.from([encodeFrame(Buffer.alloc(0))]);
      (req as unknown as IncomingMessage).method = 'POST';
      (req as unknown as IncomingMessage).url = PATH_MODELS;
      const res = new MockRes();
      await plugin.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);

      assert.deepEqual(advertised(res).names, ['auto', 'lite', 'plus', 'pro', 'ultra', 'gpt-x']);
    });
  });

} else {
  describe('cursor-gateway (dev tree absent)', () => {
    it('skips the suite: /plugins/cursor-gateway is not present on this checkout', () => {
      assert.ok(!fs.existsSync(PLUGIN_DIR), 'dev tree appeared mid-run?');
    });
  });
}
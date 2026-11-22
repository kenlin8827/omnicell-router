import { afterEach, describe, expect, it } from 'bun:test';
import { serve } from 'bun';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import type { ModelRegistration, ProviderConfig } from '../../src/config/types.js';
import type { CanonicalRequest } from '../../src/ir/types.js';
import { isSelfBaseURL } from '../../src/utils/self-url.js';
import { assertAllowedUpstream, UpstreamUrlError } from '../../src/utils/upstream-url-guard.js';
import {
  createToolMarkupStreamRecovery,
  recoverToolMarkupText,
} from '../../src/providers/compat/tool-markup-recovery.js';
import { postProviderStream, readBoundedBodyText, STREAM_CAPTURE_CAP } from '../../src/providers/executors/http-stream.js';
import { postProviderJson } from '../../src/providers/executors/http-json.js';
import { OpenAIResponsesProvider } from '../../src/providers/executors/openai-responses.js';
import { OpenAIChatProvider } from '../../src/providers/executors/openai-chat.js';
import { AnthropicMessagesProvider } from '../../src/providers/executors/anthropic-messages.js';
import { GoogleGeminiProvider } from '../../src/providers/executors/google-gemini.js';
import { redactUpstreamBody } from '../../src/observability/upstream-body-redaction.js';
import {
  sanitizePlainHeadersForCapture,
  setCaptureSecretRedaction,
} from '../../src/observability/http-exchange.js';
import { claimPluginWires, isPluginWire } from '../../src/providers/plugin-wires.js';
import { canonicalProtocol } from '../../src/providers/protocol.js';
import { wireFor } from '../../src/providers/wire.js';
import {
  getModelServicePlugin,
  getModelServicePluginEntry,
  installPluginPackage,
  loadInstalledPlugins,
  pluginPresetCatalogEntries,
  pluginsRoot,
  uninstallPlugin,
} from '../../src/plugins/host.js';
import { DispatchingProvider } from '../../src/providers/executors/dispatch.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { toIR } from '../helpers/ir.js';

function toolRequest(
  tools: { name: string; parameters?: Record<string, unknown> }[] = [
    { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  ],
): CanonicalRequest {
  return {
    model: 'deepseek-v4-flash',
    stream: false,
    input: [],
    tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, parameters: tool.parameters } })),
  };
}

function makeModel(wire: ModelRegistration['wire'] = 'openai-chat'): ModelRegistration {
  return {
    id: 'p/m1',
    provider: 'p',
    upstreamModel: 'm1',
    tier: 'plus',
    wire,
    pricing: { input: 1, output: 2, cacheRead: 0.1 },
  };
}

describe('Module 2 review fixes', () => {
  afterEach(() => {
    claimPluginWires([]);
  });

  // ── 1. Self-URL & loopback bypasses ───────────────────────────────────────
  describe('1. self-url & upstream-url-guard loopback normalization', () => {
    it('detects IPv4-mapped IPv6 and trailing-dot localhost as self base URLs', () => {
      expect(isSelfBaseURL('http://[::ffff:127.0.0.1]:4000/v1', 4000)).toBe(true);
      expect(isSelfBaseURL('http://[::ffff:7f00:1]:4000/v1', 4000)).toBe(true);
      expect(isSelfBaseURL('http://localhost.:4000/v1', 4000)).toBe(true);
      expect(isSelfBaseURL('http://[::ffff:127.0.0.1]:11434/v1', 4000)).toBe(false);
    });

    it('assertAllowedUpstream refuses IPv4-mapped IPv6 and trailing-dot self-loops', () => {
      expect(() => assertAllowedUpstream('http://[::ffff:127.0.0.1]:4000/v1', 4000)).toThrow(UpstreamUrlError);
      expect(() => assertAllowedUpstream('http://localhost.:4000/v1', 4000)).toThrow(UpstreamUrlError);
    });
  });

  // ── 2. Userinfo rejection & IPv4-compatible / NAT64 IPv6 metadata blocking ─
  describe('2. upstream-url-guard userinfo and IPv6 embedded IPv4 blocking', () => {
    it('rejects embedded userinfo without leaking credentials in the error message', () => {
      for (const raw of [
        'https://user:s3cr3t@api.example.com/v1',
        'http://user:s3cr3t@127.0.0.1:4000/v1',
        'https://token-only@api.example.com/v1',
      ]) {
        let caught: unknown;
        try {
          assertAllowedUpstream(raw, 4000);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(UpstreamUrlError);
        expect((caught as Error).message).not.toContain('s3cr3t');
        expect((caught as Error).message).not.toContain('token-only');
      }
    });

    it('blocks IPv4-compatible IPv6 and NAT64 cloud-metadata literals', () => {
      for (const raw of [
        'http://[::a9fe:a9fe]/latest',
        'https://[::169.254.169.254]/latest',
        'http://[64:ff9b::a9fe:a9fe]/latest',
        'https://[64:ff9b::169.254.169.254]/latest',
        'https://[64:ff9b:1::a9fe:a9fe]/latest',
      ]) {
        let caught: unknown;
        try {
          assertAllowedUpstream(raw, 4000);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(UpstreamUrlError);
        expect((caught as UpstreamUrlError).reasonCode).toBe('metadata_target_refused');
      }
    });
  });

  // ── 3. Pipe-prefixed closing tags in tool-markup-recovery ─────────────────
  describe('3. tool-markup-recovery pipe-prefixed closing tags', () => {
    it('recovers calls with pipe-prefixed closing tags matched by TAG', () => {
      const asciiPipe = '<|invoke name="read"|><|parameter name="path"|>a.ts<|/parameter|><|/invoke|>';
      expect(recoverToolMarkupText(asciiPipe, toolRequest())).toEqual({
        text: '',
        calls: [{ name: 'read', arguments: '{"path":"a.ts"}' }],
      });

      const fullwidthPipe =
        '<｜DSML｜invoke name="read"｜><｜DSML｜parameter name="path"｜>b.ts<｜/DSML｜parameter｜><｜/DSML｜invoke｜>';
      expect(recoverToolMarkupText(fullwidthPipe, toolRequest())).toEqual({
        text: '',
        calls: [{ name: 'read', arguments: '{"path":"b.ts"}' }],
      });
    });
  });

  // ── 4. Streaming inline triple-backticks not misclassified as fenced block ─
  describe('4. tool-markup-recovery streaming inline triple-backticks', () => {
    it('does not stall or swallow subsequent tool calls after inline triple-backticks', () => {
      const recovery = createToolMarkupStreamRecovery(toolRequest());
      const out1 = recovery.push({
        type: 'response.output_text.delta',
        candidateIndex: 0,
        index: 0,
        partIndex: 0,
        text: 'use ```foo``` here\n',
      });
      const streamed1 = out1
        .filter((e) => e.type === 'response.output_text.delta')
        .map((e) => e.text)
        .join('');
      expect(streamed1).toBe('use ```foo``` here\n');

      recovery.push({
        type: 'response.output_text.delta',
        candidateIndex: 0,
        index: 0,
        partIndex: 0,
        text: '<｜invoke name="read"><｜parameter name="path">x.ts</｜parameter></｜invoke>',
      });
      const tail = recovery.finish({ type: 'response.completed', reason: 'stop' });
      const calls = tail.filter((e) => e.type === 'response.output_item.added' && e.item.type === 'tool_call');
      expect(calls).toHaveLength(1);
    });
  });

  // ── 5. Schema prototype checks, union array/object, string fallback, prefix ─
  describe('5. tool-markup-recovery schema and streaming prefix edge cases', () => {
    it('does not use prototype-chain `in` checks for required, additionalProperties, or arg names', () => {
      const reqRequiredProto = toolRequest([
        {
          name: 'op',
          parameters: { type: 'object', properties: { toString: { type: 'string' } }, required: ['toString'] },
        },
      ]);
      // Missing required `toString` must NOT pass via Object.prototype.toString.
      const emptyCall = '<｜invoke name="op"></｜invoke>';
      expect(recoverToolMarkupText(emptyCall, reqRequiredProto).calls).toEqual([]);

      // Providing legitimate param named `toString` must succeed (not collide with args prototype).
      const validProtoParam = '<｜invoke name="op"><｜parameter name="toString">ok</｜parameter></｜invoke>';
      expect(recoverToolMarkupText(validProtoParam, reqRequiredProto).calls).toEqual([
        { name: 'op', arguments: '{"toString":"ok"}' },
      ]);

      // Undeclared `toString` param must be rejected when additionalProperties is false.
      const reqStrict = toolRequest([
        {
          name: 'strictOp',
          parameters: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
        },
      ]);
      const extraProtoParam = '<｜invoke name="strictOp"><｜parameter name="toString">bad</｜parameter></｜invoke>';
      expect(recoverToolMarkupText(extraProtoParam, reqStrict).calls).toEqual([]);
    });

    it('accepts object values for union ["array", "object"] schemas', () => {
      const req = toolRequest([
        {
          name: 'set',
          parameters: {
            type: 'object',
            properties: {
              payload: { type: ['array', 'object'] },
            },
            required: ['payload'],
          },
        },
      ]);
      const text = '<｜invoke name="set"><｜parameter name="payload">{"k":1}</｜parameter></｜invoke>';
      expect(recoverToolMarkupText(text, req).calls).toEqual([
        { name: 'set', arguments: '{"payload":{"k":1}}' },
      ]);
    });

    it('treats numeric/boolean-looking raw text as string when schema is string and string attr is omitted', () => {
      const req = toolRequest([
        {
          name: 'lookup',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              flag: { type: 'string' },
            },
            required: ['id', 'flag'],
          },
        },
      ]);
      const text =
        '<｜invoke name="lookup"><｜parameter name="id">123</｜parameter><｜parameter name="flag">true</｜parameter></｜invoke>';
      expect(recoverToolMarkupText(text, req).calls).toEqual([
        { name: 'lookup', arguments: '{"id":"123","flag":"true"}' },
      ]);
    });

    it('does not stall streaming on non-DSML tags that share a prefix like <parameters> or <invoke_other>', () => {
      const recovery = createToolMarkupStreamRecovery(toolRequest());
      const out = recovery.push({
        type: 'response.output_text.delta',
        candidateIndex: 0,
        index: 0,
        partIndex: 0,
        text: '<parameters>hello</parameters> <invoke_other>world</invoke_other>',
      });
      const streamed = out
        .filter((e) => e.type === 'response.output_text.delta')
        .map((e) => e.text)
        .join('');
      expect(streamed).toBe('<parameters>hello</parameters> <invoke_other>world</invoke_other>');
    });
  });

  // ── 6. http-stream clean completion must not controller.abort() ───────────
  describe('6. http-stream clean completion abort behavior', () => {
    it('does not abort the fetch signal on clean [DONE] SSE or non-SSE JSON completion', async () => {
      const signals: AbortSignal[] = [];
      const origFetch = globalThis.fetch;
      const server = serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname.endsWith('/sse')) {
            return new Response(
              'data: {"ok":true}\n\ndata: [DONE]\n\n',
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }
          return Response.json({ ok: true });
        },
      });
      try {
        globalThis.fetch = ((input: any, init?: any) => {
          if (init?.signal) signals.push(init.signal);
          return origFetch(input, init);
        }) as typeof fetch;

        const makeStream = (path: string) =>
          postProviderStream({
            url: `http://127.0.0.1:${server.port}${path}`,
            headers: { 'Content-Type': 'application/json' },
            payload: {},
            model: makeModel(),
            provider: 'p',
            label: 'test',
            timeoutMs: 5000,
            idleTimeoutMs: 5000,
            createDecoder: () => ({
              terminated: true,
              push: () => [],
              finish: () => [{ type: 'response.completed', reason: 'stop' }],
            }),
            parseBuffered: () => ({
              id: 'r1',
              status: 'completed',
              reason: 'stop',
              output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
              usage: { inputTokens: 1, outputTokens: 1 },
            }),
          });

        for await (const _ of await makeStream('/sse')) void _;
        for await (const _ of await makeStream('/json')) void _;

        expect(signals).toHaveLength(2);
        expect(signals[0]!.aborted).toBe(false);
        expect(signals[1]!.aborted).toBe(false);
      } finally {
        globalThis.fetch = origFetch;
        server.stop(true);
      }
    });
  });

  // ── 7. http-stream & http-json error body idle timeout and size bound ─────
  describe('7. http-stream & http-json error body bounds', () => {
    it('enforces idleTimeoutMs when a non-2xx error body stalls', async () => {
      const server = serve({
        port: 0,
        fetch() {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('partial error'));
              // Never close — simulate stalled upstream error body.
            },
          });
          return new Response(stream, { status: 502 });
        },
      });
      try {
        const started = Date.now();
        await expect(
          postProviderStream({
            url: `http://127.0.0.1:${server.port}/err`,
            headers: { 'Content-Type': 'application/json' },
            payload: {},
            model: makeModel(),
            provider: 'p',
            label: 'test',
            timeoutMs: 10_000,
            idleTimeoutMs: 120,
            createDecoder: () => ({ terminated: true, push: () => [], finish: () => [] }),
            parseBuffered: () => { throw new Error('unused'); },
          }),
        ).rejects.toThrow(/idle/i);
        expect(Date.now() - started).toBeLessThan(2000);
      } finally {
        server.stop(true);
      }
    });

    it('bounds non-2xx error body reads in postProviderStream and postProviderJson', async () => {
      // Unit-level proof: readBoundedBodyText stops pulling at maxBytes.
      const unitChunk = new TextEncoder().encode('X'.repeat(1024));
      let pulled = 0;
      const unitRes = new Response(
        new ReadableStream({
          pull(controller) {
            pulled += 1;
            controller.enqueue(unitChunk);
          },
        }),
        { status: 500 },
      );
      const bounded = await readBoundedBodyText(unitRes, 4096);
      expect(bounded.length).toBe(4096);
      expect(pulled).toBeLessThanOrEqual(6);

      // End-to-end proof: an endless 500 body settles promptly once STREAM_CAPTURE_CAP is reached.
      const chunk = new TextEncoder().encode('E'.repeat(64 * 1024));
      const timers: ReturnType<typeof setInterval>[] = [];
      const server = serve({
        port: 0,
        fetch() {
          let timer: ReturnType<typeof setInterval> | undefined;
          const stream = new ReadableStream({
            start(controller) {
              timer = setInterval(() => {
                try {
                  controller.enqueue(chunk);
                } catch {
                  if (timer) clearInterval(timer);
                }
              }, 5);
              timers.push(timer);
            },
            cancel() {
              if (timer) clearInterval(timer);
            },
          });
          return new Response(stream, { status: 500 });
        },
      });
      try {
        await expect(
          postProviderStream({
            url: `http://127.0.0.1:${server.port}/huge-err`,
            headers: { 'Content-Type': 'application/json' },
            payload: {},
            model: makeModel(),
            provider: 'p',
            label: 'test',
            timeoutMs: 5000,
            idleTimeoutMs: 5000,
            createDecoder: () => ({ terminated: true, push: () => [], finish: () => [] }),
            parseBuffered: () => { throw new Error('unused'); },
          }),
        ).rejects.toThrow(/500/);

        await expect(
          postProviderJson({
            url: `http://127.0.0.1:${server.port}/huge-err`,
            headers: { 'Content-Type': 'application/json' },
            payload: {},
            model: makeModel(),
            provider: 'p',
            label: 'test',
            timeoutMs: 5000,
          }),
        ).rejects.toThrow(/500/);
      } finally {
        for (const t of timers) clearInterval(t);
        server.stop(true);
      }
    });
  });

  // ── 8. OpenAI Responses HTTP 200 status=failed redaction ──────────────────
  describe('8. openai-responses HTTP 200 failed-turn error redaction', () => {
    it('redacts echoed secrets from HTTP 200 status=failed errors on buffered and stream paths', async () => {
      const secret = 'sk-responses-echo-secret-987654321';
      const server = serve({
        port: 0,
        fetch: () =>
          Response.json({
            id: 'resp_fail',
            status: 'failed',
            output: [],
            error: { message: `bad Authorization: Bearer ${secret}` },
          }),
      });
      try {
        const provider = new OpenAIResponsesProvider({
          name: 'p',
          type: 'openai-responses',
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey: secret,
        });
        const req = toIR({ model: 'p/m1', messages: [{ role: 'user', content: 'hi' }] });
        const model = makeModel('openai-responses');

        for (const run of [
          () => provider.createCompletion(req, model),
          async () => {
            const stream = await provider.createStream(req, model);
            for await (const _ of stream) void _;
          },
        ]) {
          let err: any;
          try {
            await run();
          } catch (e) {
            err = e;
          }
          expect(err).toBeDefined();
          expect(String(err.message)).not.toContain(secret);
          expect(String(err.errorBody ?? '')).not.toContain(secret);
          expect(String(err.message)).toContain('[REDACTED]');
        }
      } finally {
        server.stop(true);
      }
    });
  });

  // ── 9. Observability redaction hardening ──────────────────────────────────
  describe('9. upstream-body-redaction & http-exchange redaction', () => {
    it('keeps capture secret redaction locked on even if setCaptureSecretRedaction(false) is called', () => {
      setCaptureSecretRedaction(false);
      const sanitized = sanitizePlainHeadersForCapture({ authorization: 'Bearer sk-never-leak-123456' });
      expect(sanitized['authorization']).toBe('[REDACTED]');
    });

    it('redacts Basic auth credentials and raw base64 payloads from headers', () => {
      const b64 = 'dXNlcjpzdXBlcnNlY3JldA==';
      const out = redactUpstreamBody(`invalid auth Basic ${b64} and raw ${b64}`, {
        Authorization: `Basic ${b64}`,
      });
      expect(out).not.toContain(b64);
      expect(out).toContain('[REDACTED]');

      const generic = redactUpstreamBody('upstream said Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==');
      expect(generic).not.toContain('QWxhZGRpbjpvcGVuIHNlc2FtZQ==');
      expect(generic).toContain('Basic [REDACTED]');
    });

    it('does not misclassify a headers map containing a "headers" or "maxChars" string key as options', () => {
      const secret = 'sk-ducktype-secret-123456';
      const out = redactUpstreamBody(`key was ${secret}`, {
        Authorization: `Bearer ${secret}`,
        headers: 'custom-header-value',
        maxChars: 'not-a-number',
      });
      expect(out).not.toContain(secret);
      expect(out).toContain('[REDACTED]');
    });
  });

  // ── 10. Protocol & plugin wire boundaries ─────────────────────────────────
  describe('10. wire, plugin-wires, protocol, and plugin preset normalization', () => {
    it('prevents plugins from claiming core wires and resolves core wires before plugin check', () => {
      claimPluginWires(['anthropic-messages', 'google-gemini', 'openai-chat', 'openai-responses', 'acme-wire']);
      expect(isPluginWire('anthropic-messages')).toBe(false);
      expect(isPluginWire('google-gemini')).toBe(false);
      expect(isPluginWire('openai-chat')).toBe(false);
      expect(isPluginWire('openai-responses')).toBe(false);
      expect(isPluginWire('acme-wire')).toBe(true);
      expect(wireFor('anthropic-messages')).toBe('anthropic-messages');
      expect(wireFor('google-gemini')).toBe('google-gemini');
      expect(wireFor('acme-wire')).toBe('acme-wire');
    });

    it('canonicalProtocol normalizes inbound surface alias "chat" to "openai-chat"', () => {
      expect(canonicalProtocol('chat')).toBe('openai-chat');
      expect(canonicalProtocol(' CHAT ')).toBe('openai-chat');
    });

    it('normalizes legacy preset protocol/npm spellings in pluginPresetCatalogEntries', async () => {
      const id = 'preset-norm-test';
      const providerId = 'preset-norm-provider';
      const zip = zipSync({
        'plugin.json': strToU8(
          JSON.stringify({
            id,
            name: 'Preset Norm',
            version: '1.0.0',
            apiVersion: 1,
            type: 'model-service',
            wires: [id],
            presets: [
              {
                presetId: 'p1',
                providerId,
                protocol: '@ai-sdk/openai-compatible',
                baseUrl: 'https://example.invalid/v1',
                displayName: 'Preset Norm',
              },
            ],
          }),
        ),
        'index.js': strToU8('export function createPlugin() { return { createProvider() {} }; }'),
      });
      try {
        installPluginPackage(zip);
        await loadInstalledPlugins();
        const entries = await pluginPresetCatalogEntries();
        const row = entries.find((e) => e.id === providerId);
        expect(row?.npm).toBe('openai-chat');
      } finally {
        try { await uninstallPlugin(id); } catch { /* ignore */ }
        rmSync(join(pluginsRoot(), `${id}.zip`), { force: true });
        rmSync(join(pluginsRoot(), 'unpacked', id), { recursive: true, force: true });
        await loadInstalledPlugins();
      }
    });
  });

  // ── 11. Provider header precedence & anthropic-beta merging ───────────────
  describe('11. provider header precedence and anthropic-beta preservation', () => {
    it('preserves prompt-caching-2024-07-31 when config.headers supplies anthropic-beta', async () => {
      let seenHeaders: Record<string, string> = {};
      const server = serve({
        port: 0,
        fetch(req) {
          seenHeaders = Object.fromEntries(req.headers.entries());
          return Response.json({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'm1',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      });
      try {
        const provider = new AnthropicMessagesProvider({
          name: 'p',
          type: 'anthropic-messages',
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey: 'sk-anth',
          headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
        });
        await provider.createCompletion(
          toIR({ model: 'p/m1', messages: [{ role: 'user', content: 'hi' }] }),
          makeModel('anthropic-messages'),
        );
        const beta = seenHeaders['anthropic-beta'] ?? '';
        expect(beta).toContain('prompt-caching-2024-07-31');
        expect(beta).toContain('interleaved-thinking-2025-05-14');
      } finally {
        server.stop(true);
      }
    });

    it('lets per-call credentials win over stale static auth headers in config.headers across all four providers', async () => {
      const seen: Record<string, Record<string, string>> = {};
      const server = serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          const h = Object.fromEntries(req.headers.entries());
          if (url.pathname.includes('/chat/completions')) {
            seen.chat = h;
            return Response.json({
              id: 'c1',
              object: 'chat.completion',
              created: 1,
              model: 'm1',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            });
          }
          if (url.pathname.includes('/responses')) {
            seen.responses = h;
            return Response.json({
              id: 'r1',
              status: 'completed',
              output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          }
          if (url.pathname.includes('/messages')) {
            seen.anthropic = h;
            return Response.json({
              id: 'm1',
              type: 'message',
              role: 'assistant',
              model: 'm1',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          }
          seen.google = h;
          return Response.json({
            candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          });
        },
      });
      try {
        const req = toIR({ model: 'p/m1', messages: [{ role: 'user', content: 'hi' }] });
        const cred = { key: 'fresh-per-call-key', keyHashPrefix: 'abcd1234', source: 'credential-store' as const };
        const base = `http://127.0.0.1:${server.port}/v1`;

        await new OpenAIChatProvider({
          name: 'p',
          type: 'openai-chat',
          baseUrl: base,
          apiKey: 'baked',
          headers: { authorization: 'Bearer stale-key' },
        }).createCompletion(req, makeModel('openai-chat'), undefined, cred);

        await new OpenAIResponsesProvider({
          name: 'p',
          type: 'openai-responses',
          baseUrl: base,
          apiKey: 'baked',
          headers: { Authorization: 'Bearer stale-key' },
        }).createCompletion(req, makeModel('openai-responses'), undefined, cred);

        await new AnthropicMessagesProvider({
          name: 'p',
          type: 'anthropic-messages',
          baseUrl: base,
          apiKey: 'baked',
          headers: { 'X-Api-Key': 'stale-key' },
        }).createCompletion(req, makeModel('anthropic-messages'), undefined, cred);

        await new GoogleGeminiProvider({
          name: 'p',
          type: 'google-gemini',
          baseUrl: base,
          apiKey: 'baked',
          headers: { 'X-Goog-Api-Key': 'stale-key' },
        }).createCompletion(req, makeModel('google-gemini'), undefined, cred);

        expect(seen.chat?.['authorization']).toBe('Bearer fresh-per-call-key');
        expect(seen.responses?.['authorization']).toBe('Bearer fresh-per-call-key');
        expect(seen.anthropic?.['x-api-key']).toBe('fresh-per-call-key');
        expect(seen.google?.['x-goog-api-key']).toBe('fresh-per-call-key');
      } finally {
        server.stop(true);
      }
    });
  });

  // ── 12. Pass-2: plugin core-wire hijack prevention ────────────────────────
  describe('12. plugin core-wire hijack prevention', () => {
    it('refuses plugin lookup and dispatch hijack for core wires', async () => {
      const id = 'core-wire-hijack-test';
      const zip = zipSync({
        'plugin.json': strToU8(
          JSON.stringify({
            id,
            name: 'Core Wire Hijack Test',
            version: '1.0.0',
            apiVersion: 1,
            type: 'model-service',
            wires: ['openai-chat', 'anthropic-messages', id],
          }),
        ),
        'index.js': strToU8(
          `export function createPlugin() {
            return {
              createProvider() {
                return {
                  name: 'hijack',
                  async createCompletion() {
                    throw new Error('PLUGIN_HIJACKED_CORE_WIRE');
                  },
                };
              },
            };
          }`,
        ),
      });
      const server = serve({
        port: 0,
        fetch() {
          return Response.json({
            id: 'c1',
            object: 'chat.completion',
            created: 1,
            model: 'm1',
            choices: [{ index: 0, message: { role: 'assistant', content: 'from-core' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        },
      });
      try {
        installPluginPackage(zip);
        await loadInstalledPlugins();

        expect(getModelServicePluginEntry('openai-chat')).toBeUndefined();
        expect(getModelServicePlugin('openai-chat')).toBeUndefined();
        expect(getModelServicePluginEntry('anthropic-messages')).toBeUndefined();
        expect(getModelServicePlugin(id)).toBeDefined();

        const baseUrl = `http://127.0.0.1:${server.port}/v1`;
        const providerCfg: ProviderConfig = {
          name: 'p',
          type: 'openai-chat',
          baseUrl,
          apiKey: 'sk-test',
        };
        const req = toIR({ model: 'p/m1', messages: [{ role: 'user', content: 'hi' }] });
        const model = makeModel('openai-chat');

        const dispatcher = new DispatchingProvider(providerCfg, { 'openai-chat': baseUrl });
        const dispatchRes = await dispatcher.createCompletion(req, model);
        expect(dispatchRes.output[0]).toMatchObject({
          type: 'message',
          content: [{ type: 'text', text: 'from-core' }],
        });

        const registry = new ProviderRegistry({ providers: [], models: [], tiers: {} } as any, false, [providerCfg]);
        const registeredProvider = (registry as any).providers.get('p');
        expect(registeredProvider).toBeInstanceOf(OpenAIChatProvider);
        const regRes = await registeredProvider!.createCompletion(req, model);
        expect(regRes.output[0]).toMatchObject({
          type: 'message',
          content: [{ type: 'text', text: 'from-core' }],
        });
      } finally {
        server.stop(true);
        try { await uninstallPlugin(id); } catch { /* ignore */ }
        rmSync(join(pluginsRoot(), `${id}.zip`), { force: true });
        rmSync(join(pluginsRoot(), 'unpacked', id), { recursive: true, force: true });
        await loadInstalledPlugins();
      }
    });
  });

  // ── 13. Pass-2: indented tilde fence split across streaming chunks ────────
  describe('13. tool-markup-recovery indented tilde fence split across chunks', () => {
    it('holds leading indent across chunk boundary so split `  ~~~` fence is not bypassed', () => {
      const recovery = createToolMarkupStreamRecovery(toolRequest());
      const out1 = recovery.push({
        type: 'response.output_text.delta',
        candidateIndex: 0,
        index: 0,
        partIndex: 0,
        text: '  ',
      });
      const out2 = recovery.push({
        type: 'response.output_text.delta',
        candidateIndex: 0,
        index: 0,
        partIndex: 0,
        text: '~~~\n<｜invoke name="read"><｜parameter name="path">x.ts</｜parameter></｜invoke>\n  ~~~\n',
      });
      const tail = recovery.finish({ type: 'response.completed', reason: 'stop' });
      const all = [...out1, ...out2, ...tail];
      const calls = all.filter((e) => e.type === 'response.output_item.added' && e.item.type === 'tool_call');
      const streamed = all
        .filter((e) => e.type === 'response.output_text.delta')
        .map((e) => e.text)
        .join('');
      expect(calls).toHaveLength(0);
      expect(streamed).toBe('  ~~~\n<｜invoke name="read"><｜parameter name="path">x.ts</｜parameter></｜invoke>\n  ~~~\n');
    });

    it('holds leading indent after newline across chunk boundary so split `intro\\n  ` + `~~~` stays fenced', () => {
      const recovery = createToolMarkupStreamRecovery(toolRequest());
      const out1 = recovery.push({
        type: 'response.output_text.delta',
        candidateIndex: 0,
        index: 0,
        partIndex: 0,
        text: 'intro\n  ',
      });
      const out2 = recovery.push({
        type: 'response.output_text.delta',
        candidateIndex: 0,
        index: 0,
        partIndex: 0,
        text: '~~~\n<｜invoke name="read"><｜parameter name="path">y.ts</｜parameter></｜invoke>\n  ~~~\n',
      });
      const tail = recovery.finish({ type: 'response.completed', reason: 'stop' });
      const all = [...out1, ...out2, ...tail];
      const calls = all.filter((e) => e.type === 'response.output_item.added' && e.item.type === 'tool_call');
      const streamed = all
        .filter((e) => e.type === 'response.output_text.delta')
        .map((e) => e.text)
        .join('');
      expect(calls).toHaveLength(0);
      expect(streamed).toBe('intro\n  ~~~\n<｜invoke name="read"><｜parameter name="path">y.ts</｜parameter></｜invoke>\n  ~~~\n');
    });
  });

  // ── 14. Pass-2: case-variant custom headers must not duplicate defaults ───
  describe('14. provider case-variant custom headers deduplication', () => {
    it('does not duplicate Content-Type, anthropic-version, or OpenAI-Organization across case variants', async () => {
      const seen: Record<string, Record<string, string>> = {};
      const server = serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          const h = Object.fromEntries(req.headers.entries());
          if (url.pathname.includes('/chat/completions')) {
            seen.chat = h;
            return Response.json({
              id: 'c1',
              object: 'chat.completion',
              created: 1,
              model: 'm1',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            });
          }
          if (url.pathname.includes('/responses')) {
            seen.responses = h;
            return Response.json({
              id: 'r1',
              status: 'completed',
              output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          }
          if (url.pathname.includes('/messages')) {
            seen.anthropic = h;
            return Response.json({
              id: 'm1',
              type: 'message',
              role: 'assistant',
              model: 'm1',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          }
          seen.google = h;
          return Response.json({
            candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          });
        },
      });
      try {
        const req = toIR({ model: 'p/m1', messages: [{ role: 'user', content: 'hi' }] });
        const base = `http://127.0.0.1:${server.port}/v1`;

        await new OpenAIChatProvider({
          name: 'p',
          type: 'openai-chat',
          baseUrl: base,
          apiKey: 'sk-1',
          organization: 'org-fresh',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'openai-organization': 'org-stale',
          },
        }).createCompletion(req, makeModel('openai-chat'));

        await new OpenAIResponsesProvider({
          name: 'p',
          type: 'openai-responses',
          baseUrl: base,
          apiKey: 'sk-1',
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }).createCompletion(req, makeModel('openai-responses'));

        await new AnthropicMessagesProvider({
          name: 'p',
          type: 'anthropic-messages',
          baseUrl: base,
          apiKey: 'sk-1',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'Anthropic-Version': '2024-01-01',
          },
        }).createCompletion(req, makeModel('anthropic-messages'));

        await new GoogleGeminiProvider({
          name: 'p',
          type: 'google-gemini',
          baseUrl: base,
          apiKey: 'sk-1',
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }).createCompletion(req, makeModel('google-gemini'));

        expect(seen.chat?.['content-type']).toBe('application/json; charset=utf-8');
        expect(seen.chat?.['openai-organization']).toBe('org-fresh');
        expect(seen.responses?.['content-type']).toBe('application/json; charset=utf-8');
        expect(seen.anthropic?.['content-type']).toBe('application/json; charset=utf-8');
        expect(seen.anthropic?.['anthropic-version']).toBe('2024-01-01');
        expect(seen.google?.['content-type']).toBe('application/json; charset=utf-8');
      } finally {
        server.stop(true);
      }
    });

    it('preserves custom auth headers when apiKey is empty/undefined and never sends Bearer undefined', async () => {
      const seen: Record<string, Record<string, string>> = {};
      const server = serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          const hdrs = Object.fromEntries(req.headers.entries());
          if (url.pathname.endsWith('/chat/completions')) {
            seen.chat = hdrs;
            return Response.json({ id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
          }
          if (url.pathname.endsWith('/responses')) {
            seen.responses = hdrs;
            return Response.json({ id: 'r1', model: 'm', status: 'completed', output: [] });
          }
          if (url.pathname.endsWith('/messages')) {
            seen.anthropic = hdrs;
            return Response.json({ id: 'a1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
          }
          seen.google = hdrs;
          return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
        },
      });
      try {
        const base = `http://127.0.0.1:${server.port}`;
        const req: CanonicalRequest = { input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
        await new OpenAIChatProvider({ name: 'p', type: 'openai-chat', baseUrl: base, apiKey: '', headers: { Authorization: 'Bearer custom-chat' } }).createCompletion(req, makeModel('openai-chat'));
        await new OpenAIResponsesProvider({ name: 'p', type: 'openai-responses', baseUrl: base, apiKey: undefined as unknown as string, headers: { Authorization: 'Bearer custom-resp' } }).createCompletion(req, makeModel('openai-responses'));
        await new AnthropicMessagesProvider({ name: 'p', type: 'anthropic-messages', baseUrl: base, apiKey: '', headers: { 'x-api-key': 'custom-anth' } }).createCompletion(req, makeModel('anthropic-messages'));
        await new GoogleGeminiProvider({ name: 'p', type: 'google-gemini', baseUrl: base, apiKey: undefined as unknown as string, headers: { 'x-goog-api-key': 'custom-goog' } }).createCompletion(req, makeModel('google-gemini'));

        expect(seen.chat?.authorization).toBe('Bearer custom-chat');
        expect(seen.responses?.authorization).toBe('Bearer custom-resp');
        expect(seen.anthropic?.['x-api-key']).toBe('custom-anth');
        expect(seen.google?.['x-goog-api-key']).toBe('custom-goog');
      } finally {
        server.stop(true);
      }
    });

    it('rejects 3xx redirects without following and maps non-JSON 200 responses to UpstreamError 502', async () => {
      let secretReached = false;
      const server = serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === '/redirect') {
            return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${server.port}/secret` } });
          }
          if (url.pathname === '/secret') {
            secretReached = true;
            return Response.json({ ok: true });
          }
          return new Response('<html>502 Bad Gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } });
        },
      });
      try {
        const base = `http://127.0.0.1:${server.port}`;
        await expect(postProviderJson({
          url: `${base}/redirect`,
          headers: { 'x-api-key': 'top-secret' },
          payload: {},
          model: makeModel(),
          provider: 'p',
          label: 'chat',
          timeoutMs: 5000,
        })).rejects.toMatchObject({ status: 302 });
        expect(secretReached).toBe(false);

        await expect(postProviderJson({
          url: `${base}/html`,
          headers: {},
          payload: {},
          model: makeModel(),
          provider: 'p',
          label: 'chat',
          timeoutMs: 5000,
        })).rejects.toMatchObject({ status: 502 });
      } finally {
        server.stop(true);
      }
    });

    it('uses max_completion_tokens for o1/o3/o4/gpt-5 models and omits stream_options when supportsStreamOptions is false', async () => {
      const bodies: Record<string, Record<string, unknown>> = {};
      const server = serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          const body = await req.json() as Record<string, unknown>;
          bodies[String(body.model)] = body;
          if (body.stream) {
            return new Response('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"legacy","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
              headers: { 'content-type': 'text/event-stream' },
            });
          }
          return Response.json({ id: 'c1', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
        },
      });
      try {
        const provider = new OpenAIChatProvider({
          name: 'p',
          type: 'openai-chat',
          baseUrl: `http://127.0.0.1:${server.port}`,
          apiKey: 'sk-1',
        });
        const req: CanonicalRequest = {
          input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          generation: { maxOutputTokens: 128 },
        };
        await provider.createCompletion(req, { ...makeModel('openai-chat'), upstreamModel: 'gpt-5' });
        await provider.createCompletion(req, { ...makeModel('openai-chat'), upstreamModel: 'deepseek-chat' });
        const stream = await provider.createStream(req, {
          ...makeModel('openai-chat'),
          upstreamModel: 'legacy-vllm',
          supportsStreamOptions: false,
        });
        for await (const _ of stream) { /* drain */ }

        expect(bodies['gpt-5']?.max_completion_tokens).toBe(128);
        expect(bodies['gpt-5']?.max_tokens).toBeUndefined();
        expect(bodies['deepseek-chat']?.max_tokens).toBe(128);
        expect(bodies['deepseek-chat']?.max_completion_tokens).toBeUndefined();
        expect(bodies['legacy-vllm']?.stream).toBe(true);
        expect(bodies['legacy-vllm']?.stream_options).toBeUndefined();
      } finally {
        server.stop(true);
      }
    });
  });
});

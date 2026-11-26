import { describe, expect, it } from 'bun:test';
import { serve } from 'bun';
import type { ModelRegistration } from '../../src/config/types.js';
import type { CanonicalRequest } from '../../src/ir/types.js';
import { canonicalToAnthropicPayload } from '../../src/ir/adapters/anthropic-messages.js';
import { canonicalToGooglePayload } from '../../src/ir/adapters/google-gemini.js';
import { chatRequestToIR } from '../../src/ir/adapters/openai-chat.js';
import { applyCompression } from '../../src/compression/index.js';
import { compressWithHeadroom } from '../../src/compression/headroom.js';
import { injectCaveman } from '../../src/compression/caveman.js';
import { compressToolOutputs } from '../../src/compression/tool-output.js';
import { compressBuildLog, compressGeneric, compressGitDiff, compressGrepHits } from '../../src/compression/compressors.js';
import { OpenAIChatProvider } from '../../src/providers/executors/openai-chat.js';
import { emitClientRequest } from '../../src/observability/http-exchange.js';
import { UpstreamEventContext } from '../../src/observability/upstream-events.js';

const model: ModelRegistration = {
  id: 'p/m', provider: 'p', upstreamModel: 'upstream-m', tier: 'plus',
  pricing: { input: 1, output: 1, cacheRead: 0.1 },
};

function toolRequest(text: string): CanonicalRequest {
  return {
    model: 'auto', stream: false,
    input: [
      { type: 'message', role: 'system', cache: { type: 'ephemeral' }, content: [{ type: 'text', text: 'system', cache: { type: 'ephemeral' } }] },
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'inspect' }] },
      { type: 'tool_call', id: 'call_1', callId: 'call_1', name: 'run', arguments: '{"command":"git status"}', signature: 'signed-call' },
      { type: 'tool_result', callId: 'call_1', cache: { type: 'ephemeral' }, content: [
        { type: 'text', text, cache: { type: 'ephemeral' } },
        { type: 'extension', protocol: 'fixture', payload: { opaque: true } },
      ] },
    ],
    tools: [{ type: 'function', function: {
      name: 'run', description: text, parameters: { type: 'object' }, cache: { type: 'ephemeral' },
    } }],
  };
}

describe('compression integrity and cache-prefix stability', () => {
  it('RTK changes only tool_result text parts', () => {
    const text = 'On branch main\nChanges not staged for commit:\n  modified:   a.ts\n'.repeat(40);
    const request = toolRequest(text);
    const before = structuredClone(request);
    const stats = compressToolOutputs(request, true);
    expect(stats!.hits.length).toBeGreaterThan(0);
    expect(request.input.slice(0, 3)).toEqual(before.input.slice(0, 3));
    expect(request.tools).toEqual(before.tools);
    const result = request.input[3];
    expect(result).toMatchObject({ type: 'tool_result', cache: { type: 'ephemeral' } });
    if (result?.type !== 'tool_result') throw new Error('tool result missing');
    expect(result.content[1]).toEqual(before.input[3].type === 'tool_result' ? before.input[3].content[1] : undefined);
    expect(result.content[0]).toMatchObject({ type: 'text', cache: { type: 'ephemeral' } });
    expect(result.content[0].type === 'text' ? result.content[0].text : '').toContain('[token-saver: git-status');
  });

  it('Caveman appends without reordering the existing prefix and stays idempotent', () => {
    const request: CanonicalRequest = {
      model: 'auto', stream: false,
      input: [
        { type: 'message', role: 'system', content: [{ type: 'text', text: 'original-system' }] },
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'original-user' }] },
      ],
    };
    expect(injectCaveman(request, 'full')).toBe(true);
    const first = canonicalToAnthropicPayload(request, model);
    const second = canonicalToAnthropicPayload(request, model);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.system[0].text.startsWith('original-system')).toBe(true);
    expect(first.messages[0].content[0].text).toBe('original-user');
    const snapshot = JSON.stringify(request);
    expect(injectCaveman(request, 'full')).toBe(false);
    expect(JSON.stringify(request)).toBe(snapshot);
  });

  it('Headroom IR projection failure is observable and leaves every input byte unchanged', async () => {
    const request: CanonicalRequest = {
      model: 'auto', stream: false,
      input: [{ type: 'item_reference', id: 'stored_item' }],
    };
    const before = JSON.stringify(request);
    const outcome = await applyCompression(request, {
      headroom: { enabled: true, url: 'http://127.0.0.1:9', timeoutMs: 10 },
    });
    expect(JSON.stringify(request)).toBe(before);
    expect(outcome.headroom).toBeNull();
    expect(outcome.headroomSkippedReason).toMatch(/item.reference/);
  });

  it('Headroom write-back folds the projected instructions instead of duplicating them', async () => {
    const request: CanonicalRequest = {
      model: 'auto', stream: false,
      instructions: 'be brief',
      input: [
        { type: 'message', role: 'system', content: [{ type: 'text', text: 'house rules' }] },
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ],
    };
    const server = serve({
      port: 0,
      async fetch(req) {
        const body = await req.json() as { messages: { role: string; content: string }[] };
        const messages = body.messages.map((message, index) =>
          index === 0 ? { ...message, content: 'be brief, compressed' } : message);
        return Response.json({
          messages, tokens_before: 10, tokens_after: 8, tokens_saved: 2, compression_ratio: 0.8,
        });
      },
    });
    try {
      const outcome = await applyCompression(request, {
        headroom: { enabled: true, url: `http://127.0.0.1:${server.port}`, timeoutMs: 1000 },
      });
      expect(outcome.headroom?.tokensSaved).toBe(2);
      expect(request.instructions).toBe('be brief, compressed');
      expect(request.input.map((item) => item.type === 'message' ? item.content : [])).toEqual([
        [{ type: 'text', text: 'house rules' }],
        [{ type: 'text', text: 'hello' }],
      ]);
      const anthropic = canonicalToAnthropicPayload(request, model);
      expect(anthropic.system[0].text).toBe('be brief, compressed\n\nhouse rules');
      const google = canonicalToGooglePayload(request, model);
      expect(google.systemInstruction.parts[0].text).toBe('be brief, compressed\n\nhouse rules');
    } finally {
      server.stop(true);
    }
  });

  it('Headroom write-back does not duplicate input system text when the sidecar keeps it', async () => {
    const request: CanonicalRequest = {
      model: 'auto', stream: false,
      instructions: 'be brief',
      input: [
        { type: 'message', role: 'system', content: [{ type: 'text', text: 'house rules' }] },
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ],
    };
    const server = serve({
      port: 0,
      async fetch(req) {
        const body = await req.json() as { messages: { role: string; content: string }[] };
        const messages = body.messages.map((message, index) =>
          index === 0 ? { ...message, content: 'be brief, compressed\n\nhouse rules' } : message);
        return Response.json({
          messages, tokens_before: 10, tokens_after: 8, tokens_saved: 2, compression_ratio: 0.8,
        });
      },
    });
    try {
      const outcome = await applyCompression(request, {
        headroom: { enabled: true, url: `http://127.0.0.1:${server.port}`, timeoutMs: 1000 },
      });
      expect(outcome.headroom?.tokensSaved).toBe(2);
      expect(request.instructions).toBe('be brief, compressed');
      expect(request.input.map((item) => item.type === 'message' ? item.content : [])).toEqual([
        [{ type: 'text', text: 'house rules' }],
        [{ type: 'text', text: 'hello' }],
      ]);
      const anthropic = canonicalToAnthropicPayload(request, model);
      expect(anthropic.system[0].text).toBe('be brief, compressed\n\nhouse rules');
    } finally {
      server.stop(true);
    }
  });

  it('Headroom non-200, malformed messages and compression_skipped all fail open', async () => {
    const original = [{ role: 'user' as const, content: 'keep this exact message' }];
    const cases = [
      { status: 503, body: { messages: [] } },
      { status: 200, body: { messages: [] } },
      { status: 200, body: { messages: original, compression_skipped: true } },
    ];
    for (const fixture of cases) {
      const server = serve({ port: 0, fetch: () => Response.json(fixture.body, { status: fixture.status }) });
      try {
        const messages = structuredClone(original);
        const result = await compressWithHeadroom(messages, 'm', {
          enabled: true, url: `http://127.0.0.1:${server.port}`, timeoutMs: 1000,
        });
        expect(result).toBeNull();
        expect(messages).toEqual(original);
      } finally {
        server.stop(true);
      }
    }
  });

  it('lossy tool summaries are explicitly marked and preserve their documented critical lines', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts', '@@ -1,2 +1,2 @@', '-const oldPath = "C:\\\\old";',
      '+const newPath = "C:\\\\new";', ...Array.from({ length: 100 }, () => ' context'),
    ].join('\n');
    expect(compressGitDiff(diff)).toContain('-const oldPath');
    expect(compressGitDiff(diff)).toContain('+const newPath');

    const build = [...Array.from({ length: 30 }, (_, index) => `npm warn deprecated pkg${index}`),
      'npm error code ERESOLVE', 'src/a.ts: error TS2304: Cannot find name.'].join('\n');
    expect(compressBuildLog(build)).toContain('npm error code ERESOLVE');
    expect(compressBuildLog(build)).toContain('error TS2304');

    const grep = 'C:\\src\\a.ts:12:const quoted = "value";\n'.repeat(20);
    expect(compressGrepHits(grep)).toContain('C:\\src\\a.ts (20)');
    expect(compressGeneric('same "quoted" line\nsame "quoted" line')).toContain('(×2)');

    const samples = [
      JSON.stringify({ command: 'printf "a b"', path: 'C:\\work\\a.ts', rows: Array.from({ length: 100 }, (_, i) => ({ i, value: `row-${i}` })) }, null, 2),
      Array.from({ length: 80 }, (_, i) => `printf "value ${i}" && test -f "C:\\work\\file-${i}.txt"`).join('\n'),
      Array.from({ length: 100 }, () => 'duplicate log line').join('\n'),
    ];
    for (const sample of samples) {
      const request = toolRequest(sample);
      compressToolOutputs(request, true);
      const result = request.input[3];
      const text = result?.type === 'tool_result' && result.content[0]?.type === 'text' ? result.content[0].text : '';
      if (text !== sample) expect(text.startsWith('[token-saver:')).toBe(true);
      expect(text.length).toBeLessThanOrEqual(sample.length);
    }
  });
});

describe('capture remains on the two original protocol wires', () => {
  it('client capture predates compression while upstream capture is the actual compressed Chat payload', async () => {
    const longOutput = 'On branch main\nChanges not staged for commit:\n  modified:   a.ts\n'.repeat(40);
    const clientBody = {
      model: 'auto', stream: false,
      messages: [
        { role: 'user', content: 'status' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: longOutput },
      ],
      client_extension: { preserved: true },
      router_options: { force_tier: 'pro' },
    };
    const events: any[] = [];
    const recorder = { recordEvent: async (event: any) => { events.push(structuredClone(event)); } } as any;
    emitClientRequest({
      recorder,
      req: { method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'Bearer client-secret' } },
      body: clientBody, sessionId: 'sess_wire', requestId: 'req_wire', model: 'auto',
    });
    const request = chatRequestToIR(clientBody as any);
    await applyCompression(request, { rtk: { enabled: true } });

    let received: any;
    const responseBody = JSON.stringify({
      id: 'chatcmpl_wire', object: 'chat.completion', created: 1, model: 'upstream-m',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
    const server = serve({
      port: 0,
      async fetch(req) {
        received = await req.json();
        return new Response(responseBody, { headers: { 'content-type': 'application/json' } });
      },
    });
    try {
      const provider = new OpenAIChatProvider({
        name: 'p', type: 'openai-chat', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'sk-upstream-secret',
      });
      await provider.createCompletion(request, model, new UpstreamEventContext({
        recorder, sessionId: 'sess_wire', requestId: 'req_wire', model: 'auto',
      }));
      expect(events.map((event) => `${event.direction}/${event.phase}`)).toEqual([
        'client/request', 'upstream/request', 'upstream/response',
      ]);
      const client = events[0];
      const upstream = events[1];
      const clientWire = JSON.parse(client.wire.requestBody);
      const upstreamWire = JSON.parse(upstream.wire.requestBody);
      expect(client.wire.requestBody).toBe(JSON.stringify(clientBody));
      expect(clientWire.client_extension).toEqual({ preserved: true });
      expect(clientWire.messages[2].content).toBe(longOutput);
      expect(clientWire.input).toBeUndefined();
      expect(client.wire.requestHeaders.authorization).toBe('[REDACTED]');
      expect(upstreamWire.messages[2].content).toContain('[token-saver: git-status');
      expect(upstreamWire.messages[2].content).not.toBe(longOutput);
      expect(upstreamWire.client_extension).toBeUndefined();
      expect(upstreamWire.router_options).toBeUndefined();
      expect(upstream.wire.requestHeaders.authorization).toBe('[REDACTED]');
      expect(received).toEqual(upstreamWire);
      expect(events[2].wire.responseBody).toBe(responseBody);
    } finally {
      server.stop(true);
    }
  });
});

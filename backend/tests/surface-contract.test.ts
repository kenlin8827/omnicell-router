import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import { chatSurface } from '../src/surfaces/chat.js';
import { runChatSurface } from '../src/surfaces/chat-pipeline.js';
import { INFERENCE_ROUTE_PATHS, SURFACES, detectSurface } from '../src/surfaces/table.js';
import { __resetResponsesSurfaceForTests } from '../src/surfaces/responses.js';
import type { ChatCompletionChunk, ChatCompletionRequest } from '../src/types/openai.js';
import type { ExecutionResult } from '../src/types/router.js';
import type { ChatSurface, SurfacePathContext, TransportContext } from '../src/surfaces/types.js';

/**
 * CONFORMANCE suite for the protocol-surface table (surfaces/table.ts).
 *
 * WHY THIS EXISTS: adding a client protocol is supposed to be "append one
 * table row" — but the row only carries its own fields, and the shared
 * pipeline silently consults members the row did not mention (the metered
 * path set, detectSuffix, encodeChunk/afterResult exclusivity, the stream
 * terminator, the error-envelope family). Every one of those is today a
 * convention that lives in a comment. This suite turns them into executable
 * obligations: each wire must REGISTER its expectations in WIRE_SPEC below,
 * and an unregistered wire fails the suite with a message naming exactly the
 * decision its author still owes.
 *
 * It deliberately does NOT pin the table's membership (four wires is not a
 * law) and does NOT re-assert wire byte identity — that stays the job of the
 * per-wire surface and forward-proxy suites. This file only checks the
 * contract BETWEEN a surface and the machinery that dispatches it.
 */

/** Per-wire expectations a new wire must state before it may join the table. */
interface WireSpec {
  /** A body this wire must accept, lowered to the canonical IR. */
  validBody(): Record<string, unknown>;
  /** A body this wire must reject, plus the exact 400 text it owes the client. */
  invalidBody(): Record<string, unknown>;
  invalidBodyError: string;
  /** Status a bare Error (no statusCode) collapses to — the wire's own floor. */
  fallbackStatus: number;
  /**
   * Half-open [min,max) window of orchestrator-tagged statuses this wire
   * passes through untouched. NOT uniform: responses forwards 4xx only and
   * turns a tagged 5xx into its own 502 upstream_error, so the window is a
   * wire property a new wire must state.
   */
  passthroughStatuses: [number, number];
  /** Message the floor envelope carries when the thrown error has none. */
  fallbackMessage: string;
  /** The frame that must be LAST on this wire's streamed leg. */
  isTerminalFrame(frame: string): boolean;
}

const WIRE_SPEC: Record<string, WireSpec> = {
  chat: {
    validBody: () => ({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    invalidBody: () => ({ model: 'auto', messages: 'not-an-array' }),
    invalidBodyError: 'Invalid request: "messages" array is required.',
    fallbackStatus: 500,
    fallbackMessage: 'Internal Router Error',
    passthroughStatuses: [400, 600],
    isTerminalFrame: (f) => f === 'data: [DONE]\n\n',
  },
  anthropic: {
    validBody: () => ({
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      system: 'be brief',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }),
    invalidBody: () => ({}),
    invalidBodyError: 'Invalid request: "messages" array is required.',
    fallbackStatus: 500,
    fallbackMessage: 'Internal Router Error',
    passthroughStatuses: [400, 600],
    // The Anthropic wire has no [DONE] sentinel — message_stop is the terminator.
    isTerminalFrame: (f) => f.startsWith('event: message_stop'),
  },
  responses: {
    validBody: () => ({ model: 'gpt-5', input: 'hi' }),
    invalidBody: () => ({ model: 'gpt-5' }),
    invalidBodyError: 'Invalid request: "input" is required.',
    fallbackStatus: 502,
    fallbackMessage: 'Upstream execution failed.',
    // This wire forwards a tagged 4xx and rewrites a tagged 5xx into its own
    // 502 upstream_error — the one error-policy asymmetry among the three.
    passthroughStatuses: [400, 500],
    isTerminalFrame: (f) => f.startsWith('event: response.completed'),
  },
};

// ---- fixtures ---------------------------------------------------------------

const canonicalResponse = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'upstream-deployment-name',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

function stubResult(modelUsed: string): ExecutionResult {
  return {
    response: canonicalResponse as never,
    tierUsed: 'lite',
    modelUsed,
    fallbackOccurred: false,
    latencyMs: 1,
    sessionId: 'sess-contract',
    requestId: 'trace-contract',
  };
}

/** Transport double: records the op sequence so terminal-send rules are checkable. */
function makeFakeTransport(url = '/v1/inference') {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const record = (op: string, ...args: unknown[]) => calls.push({ op, args });
  const t: TransportContext = {
    method: 'POST',
    url,
    headers: { 'user-agent': 'surface-contract' },
    clientIp: '127.0.0.1',
    access: {
      kind: 'key',
      keyName: 'contract-key',
      policy: undefined,
      enforce: (model) => {
        record('enforce', model);
        return true;
      },
    },
    captureProcessContext: () => {
      record('captureProcessContext');
      return { fastifyRequest: { __fake: true } as unknown as FastifyRequest };
    },
    relayUpstream: (up) => record('relayUpstream', up),
    sendJson: (status, payload, headers) => record('sendJson', status, payload, headers),
    beginSse: (headers) => record('beginSse', headers),
    writeSseChunk: (chunk) => record('writeSseChunk', chunk),
    endSse: () => record('endSse'),
    isClientGone: () => false,
    logError: (err, message) => record('logError', err, message),
  };
  return { t, calls, ops: () => calls.map((c) => c.op) };
}

interface ProcessArgs {
  request: ChatCompletionRequest;
  ctx: Record<string, unknown>;
  relay: unknown;
}

function makeStubOrchestrator(behavior: { result?: ExecutionResult; throwOn?: unknown; chunks?: ChatCompletionChunk[] } = {}) {
  const seen: ProcessArgs[] = [];
  const orchestrator = {
    process: async (request: ChatCompletionRequest, ctx: Record<string, unknown>, relay?: { onChunk(c: ChatCompletionChunk): void }) => {
      seen.push({ request, ctx: ctx ?? {}, relay });
      if (behavior.throwOn !== undefined) throw behavior.throwOn;
      for (const chunk of behavior.chunks ?? []) relay?.onChunk(chunk);
      return behavior.result ?? stubResult('served-model');
    },
  } as unknown as Parameters<typeof runChatSurface>[2];
  return { orchestrator, seen };
}

const isChatFamily = (s: (typeof SURFACES)[number]): s is ChatSurface => s.exec === 'chat-pipeline';

/** Every frame must be a well-formed SSE block: a field line plus the blank-line terminator. */
function assertWellFormedFrame(frame: string, where: string): void {
  assert.equal(typeof frame, 'string', `${where}: frames must be strings`);
  assert.ok(frame.endsWith('\n\n'), `${where}: frame must end the event with a blank line: ${JSON.stringify(frame.slice(0, 60))}`);
  assert.ok(/^(data: |event: |:)/.test(frame), `${where}: frame must start with a field or comment line: ${JSON.stringify(frame.slice(0, 60))}`);
}

/** Payload of the `data:` line of an SSE frame ('' when the frame carries none). */
function dataPayload(frame: string): string {
  const line = frame.split('\n').find((l) => l.startsWith('data: '));
  return line ? line.slice('data: '.length) : '';
}

// ---- 1. the table's own shape ----------------------------------------------

describe('surface table — row-level shape', () => {
  it('every row belongs to exactly one executor family and answers the members that executor calls', () => {
    for (const s of SURFACES) {
      if (isChatFamily(s)) {
        for (const member of ['parse', 'encodeJson', 'encodeStream', 'errorBody', 'executionError'] as const) {
          assert.equal(typeof s[member], 'function', `${s.wire}.${member} must exist — chat-pipeline calls it`);
        }
      } else {
        assert.equal(s.exec, 'decision-pipeline', `${s.wire} has an exec value dispatchSurface does not know`);
        assert.equal(typeof s.errorBody, 'function', `${s.wire}.errorBody must exist — decision-pipeline calls it`);
      }
    }
  });

  it('routePath is absolute and unique; detectSuffix is lowercase and covers routePath', () => {
    const seenPath = new Set<string>();
    const seenWire = new Set<string>();
    for (const s of SURFACES) {
      assertRowShape(s);
      assert.ok(!seenPath.has(s.routePath), `${s.wire}.routePath duplicated in the table: ${s.routePath}`);
      seenPath.add(s.routePath);
      assert.ok(!seenWire.has(s.wire), `wire '${s.wire}' appears twice in the table`);
      seenWire.add(s.wire);
    }
  });

  it('detectSuffix values are mutually non-overlapping (the table comment claims it; here it is enforced)', () => {
    assertSuffixesDisjoint(SURFACES);
  });

  it('detection agrees with registration on every routePath — query stripped, any prefix, any case', () => {
    for (const s of SURFACES) {
      assert.equal(detectSurface(s.routePath)?.wire, s.wire, `${s.wire}: its own routePath must resolve to itself`);
      assert.equal(detectSurface(`${s.routePath}?key=x`)?.wire, s.wire, `${s.wire}: query must not break detection`);
      assert.equal(detectSurface(s.routePath.toUpperCase())?.wire, s.wire, `${s.wire}: detection is case-insensitive`);
      assert.ok(INFERENCE_ROUTE_PATHS.has(s.routePath), `${s.wire}: routePath is absent from the metered inference set — its traffic would route and bill but never hit a rate-limit window`);
    }
    for (const junk of ['', '/', '/v1/chat/completion', '/v1/chat/completions/extra', '/api/admin/models', '/systemoneX']) {
      assert.equal(detectSurface(junk), null, `'${junk}' must not be claimed by any surface`);
    }
  });
});

// ---- 2. parse lowers to the canonical IR -----------------------------------

describe('surface parse — the IR handshake', () => {
  const JUNK_BODIES: unknown[] = [undefined, null, 0, '', 'x', true, NaN, [], [1], () => 0];

  it('every wire survives a junk battery: no throw, exactly one of error/request, non-empty message', () => {
    __resetResponsesSurfaceForTests();
    for (const s of SURFACES) {
      if (!isChatFamily(s)) continue;
      for (const body of JUNK_BODIES) {
        let parsed;
        try {
          parsed = s.parse(body);
        } catch (err) {
          assert.fail(`${s.wire}.parse threw on ${typeof body}: a throwing parse escapes the pipeline's 400 channel and answers 500 instead`);
        }
        const hasError = parsed.error !== undefined;
        const hasRequest = parsed.request !== undefined;
        assert.notEqual(hasError, hasRequest, `${s.wire}: exactly one of error/request must be set (saw error=${hasError}, request=${hasRequest})`);
        if (hasError) {
          assert.equal(typeof parsed.error, 'string');
          assert.ok((parsed.error as string).length > 0, `${s.wire}: an empty error string would answer 400 with no message`);
        }
      }
    }
  });

  it('the registered valid body lowers to an IR the pipeline downstream can route', () => {
    __resetResponsesSurfaceForTests();
    for (const s of SURFACES.filter(isChatFamily)) {
      const spec = specFor(s);
      const parsed = s.parse(spec.validBody());
      assert.equal(parsed.error, undefined, `${s.wire}: registered valid body was rejected — ${parsed.error}`);
      const request = parsed.request!;
      assert.ok(Array.isArray(request.messages) && request.messages.length > 0, `${s.wire}: IR must carry a non-empty messages array`);
      for (const m of request.messages) {
        assert.equal(typeof m?.role, 'string', `${s.wire}: every IR message needs a role (session identity and scrubbing read it)`);
      }
      if (request.model !== undefined) {
        assert.equal(typeof request.model, 'string', `${s.wire}: model must stay a string in the IR`);
      }
    }
  });

  it('the registered invalid body answers with the stated text through the 400 channel', async () => {
    __resetResponsesSurfaceForTests();
    for (const s of SURFACES.filter(isChatFamily)) {
      const spec = specFor(s);
      const { t, calls, ops } = makeFakeTransport();
      const { orchestrator, seen } = makeStubOrchestrator();
      await runChatSurface(t, s, orchestrator, spec.invalidBody());
      assert.deepEqual(ops(), ['sendJson'], `${s.wire}: rejected body must terminate with exactly one send, before the gate`);
      const [status, body] = calls[0]!.args;
      assert.equal(status, 400, `${s.wire}: rejected body must be 400`);
      assert.deepEqual(messageOf(body), spec.invalidBodyError, `${s.wire}: the 400 text is part of the wire contract`);
      assert.equal(seen.length, 0, `${s.wire}: a rejected body must never reach the orchestrator (no capture, no cost)`);
    }
  });
});

// ---- 3. the error-envelope family ------------------------------------------

describe('surface error envelopes', () => {
  it('errorBody carries the message and classifies 4xx/5xx per the wire', () => {
    for (const s of SURFACES) {
      for (const status of [400, 404, 429, 500, 503]) {
        const body = s.errorBody(status, `msg-${status}`);
        assert.equal(messageOf(body), `msg-${status}`, `${s.wire}: errorBody must round-trip the message at ${status}`);
        assert.ok(JSON.stringify(body).length > 0, `${s.wire}: errorBody must be JSON-serializable`);
        const type = typeOf(body);
        if (isChatFamily(s) && s.wire === 'responses') {
          // This wire pins type=invalid_request_error at EVERY status (documented quirk).
          assert.equal(type, 'invalid_request_error', `${s.wire}: type is pinned on this wire`);
        } else {
          assert.equal(type, status >= 500 ? 'api_error' : 'invalid_request_error', `${s.wire}: status ${status} classification drifted`);
        }
      }
    }
  });

  it('executionError never yields an out-of-range or non-integer status', () => {
    const JUNK_ERRORS: unknown[] = [
      undefined,
      null,
      'boom',
      new Error('plain'),
      {},
      { statusCode: 200 },
      { statusCode: 302 },
      { statusCode: 400.5 },
      { statusCode: '500' },
      { statusCode: 600 },
      { statusCode: 999 },
      { statusCode: -1 },
      { statusCode: Number.NaN },
    ];
    for (const s of SURFACES) {
      if (!isChatFamily(s)) continue;
      const spec = specFor(s);
      for (const err of JUNK_ERRORS) {
        let mapped;
        try {
          mapped = s.executionError(err);
        } catch (thrown) {
          assert.fail(`${s.wire}: executionError threw on ${JSON.stringify(err)} — the pipeline's catch would then answer nothing at all`);
        }
        assert.ok(Number.isInteger(mapped.status), `${s.wire}: status must be an integer (saw ${String(mapped.status)} for ${JSON.stringify(err)})`);
        assert.ok(
          mapped.status >= 400 && mapped.status < 600,
          `${s.wire}: status ${mapped.status} is not an HTTP error status — Fastify would throw while writing it`
        );
        assert.ok(JSON.stringify(mapped.body) !== undefined, `${s.wire}: error body must serialize`);
      }
      // The floor: a bare Error collapses to the wire's own default status and message.
      const floor = s.executionError(new Error(''));
      assert.equal(floor.status, spec.fallbackStatus, `${s.wire}: documented fallback status`);
      assert.equal(messageOf(floor.body), spec.fallbackMessage, `${s.wire}: documented fallback message`);
      // Explicit status pass-through — but the pass-through RANGE is per-wire:
      // chat/anthropic honour any 4xx/5xx the orchestrator tagged, responses
      // only honours 4xx and rewrites a tagged 5xx into its own 502
      // upstream_error. Asserting one shared range would have been a fiction.
      const [lo, hi] = spec.passthroughStatuses;
      for (const status of [400, 404, 429, 500, 503]) {
        const expectPassThrough = status >= lo && status < hi;
        const mapped = s.executionError({ statusCode: status, message: 'x' });
        assert.equal(
          mapped.status,
          expectPassThrough ? status : spec.fallbackStatus,
          `${s.wire}: statusCode ${status} must ${expectPassThrough ? 'pass through' : `collapse to ${spec.fallbackStatus}`}`
        );
      }
    }
  });

  it('CHARACTERIZATION (known gap): the responses 4xx branch can emit an envelope with no message', () => {
    // responses.executionError's 4xx branch sends `message: e?.message` with no
    // fallback, so an error carrying a statusCode but no message produces
    // {error:{type,code}} — the client sees an error with nothing to read.
    // Pinned deliberately: fix it (one `|| 'Bad request.'`) and this test must
    // be deleted, which is how the gap stops being invisible.
    const responses = SURFACES.find((s) => s.wire === 'responses')! as ChatSurface;
    const body = responses.executionError({ statusCode: 404 }).body as { error: Record<string, unknown> };
    assert.equal(body.error.message, undefined, 'gap present — if this assertion fails, delete this test');
  });
});

// ---- 4. terminal-send discipline through the pipeline ----------------------

describe('pipeline terminal send — per wire', () => {
  it('a non-streaming turn sends exactly one JSON body and never touches SSE', async () => {
    __resetResponsesSurfaceForTests();
    for (const s of SURFACES.filter(isChatFamily)) {
      const spec = specFor(s);
      const { t, calls, ops } = makeFakeTransport();
      const { orchestrator } = makeStubOrchestrator();
      await runChatSurface(t, s, orchestrator, { ...spec.validBody(), stream: false });
      assert.deepEqual(ops(), ['enforce', 'captureProcessContext', 'sendJson'], `${s.wire}: exactly one terminal send`);
      assert.equal(calls[2]!.args[0], 200, `${s.wire}: success must be 200`);
    }
  });

  it('a streaming turn opens the stream once, writes well-formed frames, and ends on the registered terminator', async () => {
    __resetResponsesSurfaceForTests();
    for (const s of SURFACES.filter(isChatFamily)) {
      const spec = specFor(s);
      const { t, calls, ops } = makeFakeTransport();
      const { orchestrator } = makeStubOrchestrator();
      await runChatSurface(t, s, orchestrator, { ...spec.validBody(), stream: true });

      const opsList = ops();
      assert.equal(opsList.filter((op) => op === 'beginSse').length, 1, `${s.wire}: exactly one beginSse`);
      assert.equal(opsList.filter((op) => op === 'endSse').length, 1, `${s.wire}: exactly one endSse`);
      assert.ok(!opsList.includes('sendJson'), `${s.wire}: a JSON body after SSE headers would be a second terminal send on one wire`);
      assert.ok(opsList.indexOf('beginSse') < opsList.lastIndexOf('endSse'), `${s.wire}: endSse must close the opened stream`);

      const frames = calls.filter((c) => c.op === 'writeSseChunk').map((c) => c.args[0] as string);
      assertFramesContract(frames, s.wire, spec);
    }
  });

  it('execution failure answers exactly once through the wire policy', async () => {
    __resetResponsesSurfaceForTests();
    for (const s of SURFACES.filter(isChatFamily)) {
      const spec = specFor(s);
      const { t, calls, ops } = makeFakeTransport();
      const { orchestrator } = makeStubOrchestrator({ throwOn: new Error('upstream exploded') });
      await runChatSurface(t, s, orchestrator, { ...spec.validBody(), stream: false });
      assert.deepEqual(ops(), ['enforce', 'captureProcessContext', 'logError', 'sendJson'], `${s.wire}: one log + one terminal send`);
      assert.equal(calls[3]!.args[0], spec.fallbackStatus, `${s.wire}: a bare Error must map to the wire's floor status`);
      assert.equal(messageOf(calls[3]!.args[1]), 'upstream exploded', `${s.wire}: the thrown message must reach the client`);
    }
  });

  it('a hook that runs before the first byte sees the state parse returned (continuation ids)', async () => {
    __resetResponsesSurfaceForTests();
    // The pipeline calls afterResult strictly before the terminal send; a
    // surface that mints its response id there must then see that SAME id in
    // the encoded body, or its continuation chain breaks client-side.
    const responses = SURFACES.find((s) => s.wire === 'responses')! as ChatSurface;
    assert.equal(typeof responses.afterResult, 'function', 'responses must carry the hook this test exists for');
    const parsed = responses.parse({ model: 'gpt-5', input: 'hi' });
    const before = (parsed.state as { respId?: string } | undefined)?.respId ?? '';
    responses.afterResult!(stubResult('served-model'), parsed.state);
    const state = parsed.state as { respId: string };
    assert.ok(state.respId && state.respId !== before, `${responses.wire}: afterResult must mint the id into the parse-returned state`);
    const encoded = responses.encodeJson(stubResult('served-model'), state) as { id?: string };
    assert.equal(encoded.id, state.respId, `${responses.wire}: the minted id must be the one the client is handed`);
  });
});

// ---- 5. the relayed (chunk-by-chunk) leg ------------------------------------

describe('relay leg — chunk-shaped wires', () => {
  it('encodeChunk returns string|null (never undefined), rewrites model, and gates usage frames', () => {
    for (const s of SURFACES.filter(isChatFamily)) {
      if (!s.encodeChunk) continue;
      const battery: ChatCompletionChunk[] = [
        { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'upstream-deployment-name', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
        { id: 'c2', object: 'chat.completion.chunk', created: 1, model: 'upstream-deployment-name', choices: [] },
        { id: 'c3', object: 'chat.completion.chunk', created: 1, model: 'upstream-deployment-name', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } as unknown as ChatCompletionChunk,
      ];
      for (const includeUsage of [false, true]) {
        for (const chunk of battery) {
          const frame = s.encodeChunk(chunk, { model: 'served-model', includeUsage });
          // `undefined` would slip past the pipeline's `!== null` guard and
          // write the literal text "undefined" into the client's stream.
          assert.ok(
            frame === null || typeof frame === 'string',
            `${s.wire}: encodeChunk must return string or null, saw ${String(frame)}`
          );
          if (frame === null) continue;
          assertWellFormedFrame(frame, `${s.wire} relay frame`);
          const payload = JSON.parse(dataPayload(frame)) as { model?: string; usage?: unknown };
          assert.equal(payload.model, 'served-model', `${s.wire}: every relayed frame must carry the gateway-served id, not the upstream deployment name`);
        }
      }
      const usageOnly: ChatCompletionChunk = {
        id: 'c4',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'upstream-deployment-name',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      } as unknown as ChatCompletionChunk;
      assert.equal(s.encodeChunk(usageOnly, { model: 'served-model', includeUsage: false }), null, `${s.wire}: an unrequested usage frame must be dropped (strict clients reject unknown frames)`);
      assert.notEqual(s.encodeChunk(usageOnly, { model: 'served-model', includeUsage: true }), null, `${s.wire}: a requested usage frame must be forwarded (FinOps-visible)`);
    }
  });

  it('a relay writes the summary comment BEFORE [DONE] and closes exactly once', async () => {
    const frames: ChatCompletionChunk[] = [
      { id: 'r1', object: 'chat.completion.chunk', created: 1, model: 'upstream-deployment-name', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
      { id: 'r2', object: 'chat.completion.chunk', created: 1, model: 'upstream-deployment-name', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] },
    ];
    const { t, calls, ops } = makeFakeTransport();
    const { orchestrator } = makeStubOrchestrator({ chunks: frames });
    await runChatSurface(t, chatSurface, orchestrator, { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true });

    const opsList = ops();
    assert.equal(opsList.filter((op) => op === 'beginSse').length, 1, 'relay opens the stream once, at the first byte');
    assert.ok(!opsList.includes('sendJson'), 'relay leg must never also send a JSON body');
    const written = calls.filter((c) => c.op === 'writeSseChunk').map((c) => c.args[0] as string);
    for (const f of written) assertWellFormedFrame(f, 'relay summary leg');
    assert.equal(written[written.length - 1], 'data: [DONE]\n\n', 'stream must close on [DONE]');
    const summaryIndex = written.findIndex((f) => f.startsWith(': ocr-summary '));
    assert.ok(summaryIndex >= 0, 'a streamed turn must carry the completion-time summary frame');
    assert.ok(summaryIndex < written.length - 1, 'the summary frame must precede [DONE] — most parsers stop reading at [DONE]');
    assert.ok(written[0]!.startsWith('data: {'), 'the first relayed frame is the upstream chunk, framed for this wire');
  });

  it('a surface with an afterResult hook is never handed a relay (the hook must run before the first byte)', async () => {
    __resetResponsesSurfaceForTests();
    for (const s of SURFACES.filter(isChatFamily)) {
      const { t } = makeFakeTransport();
      const { orchestrator, seen } = makeStubOrchestrator();
      await runChatSurface(t, s, orchestrator, { ...(s === chatSurface ? { model: 'auto', messages: [{ role: 'user', content: 'hi' }] } : { model: 'gpt-5', input: 'hi' }), stream: true });
      const relay = seen[0]?.relay;
      if (s.afterResult) {
        assert.equal(relay, undefined, `${s.wire}: afterResult and the relayed leg are mutually exclusive — silently keeping both would drop the hook and the state it mints`);
      } else if (s.encodeChunk) {
        assert.ok(relay, `${s.wire}: a chunk-shaped wire with no hook must be offered the relay (streamed turn)`);
      }
    }
  });
});

// ---- 6. the path-context hook (URL-addressed wires) -------------------------

describe('parse path context', () => {
  it('the pipeline hands parse the request path and query', async () => {
    const seen: Array<SurfacePathContext | undefined> = [];
    const probe: ChatSurface = {
      ...chatSurface,
      wire: 'chat',
      parse(body: unknown, pathCtx?: SurfacePathContext) {
        seen.push(pathCtx);
        return chatSurface.parse(body);
      },
    };
    const { t } = makeFakeTransport('/v1beta/models/gemini-2.5-pro:generateContent?key=abc');
    const { orchestrator } = makeStubOrchestrator();
    await runChatSurface(t, probe, orchestrator, { model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.path, '/v1beta/models/gemini-2.5-pro:generateContent', 'a wire that addresses its model in the URL must be able to read it');
    assert.equal(seen[0]!.query, 'key=abc');
  });
});

/**
 * Per-row invariants the dispatch machinery depends on. detectSurface
 * lowercases the request path before matching, so an uppercase detectSuffix
 * would never match: Fastify would serve the route while the gateway's own
 * MITM leg blind-tunnels that traffic past every gate, meter and policy.
 */
function assertRowShape(row: { wire: string; routePath: string; detectSuffix: string }): void {
  assert.ok(row.routePath.startsWith('/'), `${row.wire}.routePath must be absolute`);
  assert.equal(row.routePath, row.routePath.toLowerCase(), `${row.wire}.routePath must be lowercase (Fastify matching)`);
  assert.equal(row.detectSuffix, row.detectSuffix.toLowerCase(), `${row.wire}.detectSuffix can never match if it is not lowercase`);
  assert.ok(
    row.routePath.endsWith(row.detectSuffix),
    `${row.wire}: routePath must end with detectSuffix, else the gateway serves a path its own MITM leg would not claim`
  );
}

/**
 * No detectSuffix may swallow another: detection returns the FIRST table row
 * whose suffix matches, so an overlapping pair silently gives one wire the
 * other's traffic — and which one wins depends on table order, not on intent.
 */
function assertSuffixesDisjoint(rows: readonly { wire: string; detectSuffix: string }[]): void {
  for (const a of rows) {
    for (const b of rows) {
      if (a === b) continue;
      assert.ok(
        !b.detectSuffix.endsWith(a.detectSuffix),
        `'${b.detectSuffix}' (${b.wire}) ends with '${a.detectSuffix}' (${a.wire}): one request path would claim two surfaces, and detection order would decide the wire`
      );
    }
  }
}

/** The streamed-leg frame contract every wire owes its client. */
function assertFramesContract(frames: string[], wire: string, spec: WireSpec): void {
  assert.ok(frames.length > 0, `${wire}: a streaming turn must write at least one frame`);
  for (const f of frames) assertWellFormedFrame(f, `${wire} frame`);
  for (const f of frames) {
    const payload = dataPayload(f);
    if (payload && payload !== '[DONE]') {
      try {
        JSON.parse(payload);
      } catch {
        assert.fail(`${wire}: a data: frame must carry JSON (${payload.slice(0, 60)})`);
      }
    }
  }
  const last = frames[frames.length - 1]!;
  assert.ok(spec.isTerminalFrame(last), `${wire}: stream must end on this wire's terminator, saw ${JSON.stringify(last.slice(0, 60))}`);
}

// ---- 7. this suite's own teeth --------------------------------------------

describe('the suite rejects a half-registered wire (what a new protocol will hit)', () => {
  // A Gemini-shaped row, deliberately incomplete: the point is not that these
  // fakes are correct protocols but that the suite refuses to grade an
  // unregistered wire as passing.
  const unregistered: ChatSurface = {
    ...chatSurface,
    wire: 'chat',
    detectSuffix: '/completions',
    routePath: '/v1beta/models/Gemini-Pro:generateContent',
  };

  it('a detectSuffix that swallows an existing wire is caught', () => {
    assert.throws(
      () => assertSuffixesDisjoint([chatSurface, unregistered]),
      /ends with/
    );
  });

  it('a routePath that is not lowercase is caught (Fastify would serve it, detectSurface would not claim it)', () => {
    assert.throws(() => assertRowShape(unregistered), /must be lowercase/);
    assert.throws(() => assertRowShape({ ...chatSurface, detectSuffix: '/CHAT/COMPLETIONS' }), /detectSuffix can never match/);
    assert.throws(
      () => assertRowShape({ ...chatSurface, routePath: '/api/chat/completions', detectSuffix: '/v1/chat/completions' }),
      /must end with detectSuffix/
    );
  });

  it('a wire with no WIRE_SPEC entry fails with the instruction, not a bare undefined access', () => {
    assert.throws(
      () => specFor({ ...chatSurface, wire: 'gemini' } as unknown as ChatSurface),
      /wire 'gemini' is in the SURFACES table but not in WIRE_SPEC/
    );
  });

  it('a streamed leg that never ends its stream is caught', () => {
    assert.throws(
      () => assertFramesContract(['data: {"id":"a"}\n\n'], 'gemini', WIRE_SPEC.chat),
      /terminator/
    );
    assert.throws(() => assertFramesContract(['data: {"id":"a"}'], 'gemini', WIRE_SPEC.chat), /blank line/);
    assert.throws(() => assertFramesContract(['{"id":"a"}\n\n'], 'gemini', WIRE_SPEC.chat), /field or comment/);
    assert.throws(() => assertFramesContract([], 'gemini', WIRE_SPEC.chat), /at least one frame/);
  });
});

// ---- helpers ---------------------------------------------------------------

function specFor(s: ChatSurface): WireSpec {
  const spec = WIRE_SPEC[s.wire];
  assert.ok(
    spec,
    `wire '${s.wire}' is in the SURFACES table but not in WIRE_SPEC (backend/tests/surface-contract.test.ts). State its contract there: a valid body, the rejection text it owes, its executionError floor, and the frame that must end its stream.`
  );
  return spec;
}

function messageOf(body: unknown): unknown {
  const carrier = (body as { error?: unknown } | undefined)?.error;
  if (typeof carrier === 'string') return carrier;
  return (carrier as { message?: unknown } | undefined)?.message;
}

function typeOf(body: unknown): unknown {
  return (body as { error?: { type?: unknown } } | undefined)?.error?.type;
}

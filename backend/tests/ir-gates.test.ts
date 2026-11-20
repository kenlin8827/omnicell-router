import { describe, expect, test } from 'bun:test';
import type { ModelRegistration } from '../src/config/types.js';
import { anthropicRequestToIR, canonicalToAnthropicPayload, canonicalToAnthropicResponse } from '../src/ir/adapters/anthropic-messages.js';
import { irToChatRequest, irToChatResponse } from '../src/ir/adapters/openai-chat.js';
import { canonicalToGooglePayload } from '../src/ir/adapters/google-gemini.js';
import { canonicalToResponsesPayload } from '../src/ir/adapters/openai-responses.js';
import { canonicalToResponsesObject } from '../src/ir/adapters/openai-responses-output.js';
import { IrUnsupportedError } from '../src/ir/errors.js';
import { canonicalResponseToEvents } from '../src/ir/stream.js';
import { ChatEventEncoder } from '../src/ir/adapters/openai-chat-stream.js';
import { assertCanonicalRequestSupported } from '../src/ir/validate.js';
import type { CanonicalRequest, CanonicalResponse } from '../src/ir/types.js';

const model = { id: 'm', upstreamModel: 'upstream' } as ModelRegistration;
const input: CanonicalRequest['input'] = [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }];

function request(extra: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return { model: 'auto', stream: false, input, ...extra };
}

function response(output: CanonicalResponse['output']): CanonicalResponse {
  return { status: 'completed', output, usage: { inputTokens: 1, outputTokens: 1 } };
}

describe('IR fail-visible request gates', () => {
  test('emits Responses logprobs controls and rejects fields with no faithful target', () => {
    const payload = canonicalToResponsesPayload(request({ logprobs: true, topLogprobs: 4 }), model);
    expect(payload.top_logprobs).toBe(4);
    expect(payload.include).toContain('message.output_text.logprobs');
    expect(() => canonicalToResponsesPayload(request({ logitBias: { 1: -1 } }), model)).toThrow(IrUnsupportedError);
    expect(() => canonicalToGooglePayload(request({ include: ['message.output_text.logprobs'] }), model)).toThrow(/include/);
    expect(() => irToChatRequest(request({ include: [] }), 'upstream')).toThrow(/include/);
  });

  test('preserves tool errors only on Anthropic and rejects foreign cache markers', () => {
    const toolInput: CanonicalRequest['input'] = [{
      type: 'tool_result', callId: 'call_1', isError: true, content: [{ type: 'text', text: 'failed' }],
    }];
    const anthropic = canonicalToAnthropicPayload(request({ input: toolInput }), model);
    expect(anthropic.messages[0].content[0].is_error).toBe(true);
    expect(() => canonicalToGooglePayload(request({ input: toolInput }), model)).toThrow(/error marker/);
    expect(() => irToChatRequest(request({ input: toolInput }), 'upstream')).toThrow(/error marker/);

    const cached: CanonicalRequest['input'] = [{
      type: 'message', role: 'user', content: [{ type: 'text', text: 'x', cache: { raw: { mode: 'explicit' } } }],
    }];
    expect(() => canonicalToAnthropicPayload(request({ input: cached }), model)).toThrow(/foreign raw cache/);
  });

  test('Responses request gate rejects foreign signatures but still accepts encrypted reasoning', () => {
    const signed = request({
      input: [
        ...input,
        { type: 'reasoning', text: 'think', signature: 'sig-from-gemini' },
      ],
    });
    expect(() => assertCanonicalRequestSupported(signed, 'openai-responses')).toThrow(IrUnsupportedError);
    expect(() => canonicalToResponsesPayload(signed, model)).toThrow(/foreign reasoning signature/);

    const toolSigned = request({
      input: [
        ...input,
        { type: 'tool_call', id: 'fc_1', callId: 'call_1', name: 'ls', arguments: '{}', signature: 'sig' },
      ],
    });
    expect(() => assertCanonicalRequestSupported(toolSigned, 'openai-responses')).toThrow(/tool-call signature/);

    const encrypted = request({
      input: [
        ...input,
        { type: 'reasoning', text: 'think', encrypted: 'opaque' },
      ],
    });
    expect(() => assertCanonicalRequestSupported(encrypted, 'openai-responses')).not.toThrow();
    const payload = canonicalToResponsesPayload(encrypted, model);
    const reasoning = payload.input.find((item: { type?: string }) => item.type === 'reasoning');
    expect(reasoning?.encrypted_content).toBe('opaque');
  });
});

describe('IR fail-visible response and stream gates', () => {
  test('rejects lossy annotations, logprobs and extra candidates', () => {
    const annotated = response([{
      type: 'message', role: 'assistant', content: [{
        type: 'text', text: 'source', annotations: [{ type: 'url_citation', url: 'https://example.test' }],
      }],
    }]);
    expect(() => irToChatResponse(annotated, 'c', 'm')).toThrow(IrUnsupportedError);
    expect(() => canonicalToAnthropicResponse(annotated, 'm')).toThrow(IrUnsupportedError);

    const withLogprobs = response([{
      type: 'message', role: 'assistant', content: [{
        type: 'text', text: 'token', logprobs: [{ token: 'token', logprob: -0.1 }],
      }],
    }]);
    expect(() => irToChatResponse(withLogprobs, 'c', 'm')).toThrow(/log probabilities/);
    expect(() => {
      const encoder = new ChatEventEncoder();
      for (const event of canonicalResponseToEvents(withLogprobs)) encoder.encode(event, 'm');
    }).toThrow(/log probabilities/);

    const multiple = response([]);
    multiple.candidates = [
      { index: 0, status: 'completed', output: [] },
      { index: 1, status: 'completed', output: [] },
    ];
    expect(() => canonicalToResponsesObject(multiple, { respId: 'r' }, 'm')).toThrow(/multiple candidates/);
    expect(() => canonicalToAnthropicResponse(multiple, 'm')).toThrow(/multiple candidates/);
    expect(irToChatResponse(multiple, 'c', 'm').choices).toHaveLength(2);
  });

  test('replays signed Responses reasoning instead of dropping its signature', () => {
    const wire = canonicalToResponsesObject(response([{
      type: 'reasoning', id: 'rs_1', text: 'think', signature: 'signed', encrypted: 'opaque',
    }]), { respId: 'resp_1' }, 'm') as any;
    expect(wire.output[0].signature).toBe('signed');
    expect(wire.output[0].encrypted_content).toBe('opaque');
  });
});

describe('Anthropic system cache snapshots', () => {
  test('replays every original block and its own cache breakpoint', () => {
    const ir = anthropicRequestToIR({
      model: 'auto', max_tokens: 32,
      system: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'third' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const payload = canonicalToAnthropicPayload(ir, model);
    expect(payload.system).toHaveLength(3);
    expect(payload.system[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(payload.system.map((block: any) => block.text)).toEqual(['first', 'second', 'third']);
  });

  test('falls back to a deterministic merged block after instructions change', () => {
    const ir = anthropicRequestToIR({
      model: 'auto', max_tokens: 32,
      system: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    ir.instructions = `rewritten\n\n${ir.instructions}`;
    const payload = canonicalToAnthropicPayload(ir, model);
    expect(payload.system).toHaveLength(1);
    expect(payload.system[0].text).toBe('rewritten\n\nfirst\n\nsecond');
    expect(payload.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});

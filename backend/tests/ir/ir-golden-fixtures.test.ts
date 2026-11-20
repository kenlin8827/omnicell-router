import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import type { CanonicalResponse, StreamEvent } from '../../src/ir/types.js';
import { OpenAIResponsesStreamDecoder } from '../../src/ir/adapters/openai-responses-stream.js';
import { AnthropicMessagesStreamDecoder } from '../../src/ir/adapters/anthropic-messages-stream.js';
import { GoogleGeminiStreamDecoder } from '../../src/ir/adapters/google-gemini-stream.js';
import { createEventAccumulator } from '../../src/ir/stream.js';
import { ChatStreamDecoder } from '../../src/ir/adapters/openai-chat-stream.js';

type Protocol = 'chat' | 'responses' | 'anthropic' | 'google';
type Decoder = { push(frame: any): StreamEvent[]; finish(): StreamEvent[] };

const fixtureRoot = path.join(import.meta.dir, '..', 'fixtures', 'ir');

function decode(protocol: Protocol, frames: unknown[]): CanonicalResponse {
  const decoder: Decoder = protocol === 'chat' ? new ChatStreamDecoder() as Decoder
    : protocol === 'responses' ? new OpenAIResponsesStreamDecoder()
      : protocol === 'anthropic' ? new AnthropicMessagesStreamDecoder()
        : new GoogleGeminiStreamDecoder();
  const accumulator = createEventAccumulator();
  for (const frame of frames) {
    for (const event of decoder.push(frame)) accumulator.push(event);
  }
  for (const event of decoder.finish()) accumulator.push(event);
  return accumulator.finish();
}

describe('sanitized golden IR stream corpus', () => {
  for (const protocol of ['chat', 'responses', 'anthropic', 'google'] as Protocol[]) {
    it(`${protocol} preserves text, terminal status and cached usage`, () => {
      const file = path.join(fixtureRoot, `${protocol}-stream.json`);
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toMatch(/authorization|api[-_]?key|sk-[a-z0-9]/i);
      const response = decode(protocol, JSON.parse(source));
      expect(response.status).toBe('completed');
      expect(response.usage.cachedInputTokens).toBe(4);
      expect(response.output).toHaveLength(1);
      expect(response.output[0]).toMatchObject({
        type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hello' }],
      });
    });
  }
});

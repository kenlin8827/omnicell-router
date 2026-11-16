import { describe, expect, it } from 'bun:test';
import { loadConfig } from '../src/config/index.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { UNANSWERED_TOOL_CONTENT, repairToolCallPairing } from '../src/pipeline/tool-pairing.js';
import type { LLMProvider } from '../src/providers/base.js';
import type { ChatCompletionRequest, ChatCompletionResponse, ChatMessage } from '../src/types/openai.js';
import type { ModelRegistration, RouterConfig } from '../src/config/types.js';

/**
 * Tool-call pairing normalization (ADR-0008 §9). Chat-completions requires
 * every `tool_calls` entry to be answered by exactly one `tool` message before
 * the next non-tool message, and rejects a `tool` message that answers
 * nothing. DeepSeek fails the WHOLE request otherwise ("insufficient tool
 * messages following tool_calls message"). Clients break the contract on their
 * own — cancelled tool run, aborted turn, client-side compaction, a reply
 * appended twice — so the pipeline normalizes the canonical chain instead of
 * forwarding an invalid history.
 */

const user = (content: string): ChatMessage => ({ role: 'user', content });
const reply = (content: string, tool_call_id: string): ChatMessage => ({ role: 'tool', content, tool_call_id });
const assistantCalls = (ids: string[]): ChatMessage => ({
  role: 'assistant',
  content: '',
  tool_calls: ids.map((id) => ({ id, type: 'function' as const, function: { name: 'read', arguments: '{}' } })),
});
const shape = (messages: ChatMessage[]) => messages.map((m) => [m.role, m.tool_call_id ?? null]);

describe('tool-pairing: repairToolCallPairing', () => {
  it('closes a cancelled call before the user message that follows it', () => {
    const repaired = repairToolCallPairing([user('open the file'), assistantCalls(['call_1']), user('never mind')]);
    expect(shape(repaired.messages)).toEqual([
      ['user', null],
      ['assistant', null],
      ['tool', 'call_1'],
      ['user', null],
    ]);
    expect(repaired.messages[2]!.content).toBe(UNANSWERED_TOOL_CONTENT);
    expect(repaired).toMatchObject({ synthesized: 1, duplicates: 0, orphans: 0 });
  });

  it('closes an unanswered call of a parallel batch without touching the answered one', () => {
    const repaired = repairToolCallPairing([user('go'), assistantCalls(['call_1', 'call_2']), reply('B', 'call_2')]);
    expect(shape(repaired.messages).slice(2)).toEqual([
      ['tool', 'call_2'],
      ['tool', 'call_1'],
    ]);
    expect(repaired.synthesized).toBe(1);
  });

  it('closes calls at the end of the chain (nothing may follow the last unanswered turn)', () => {
    const repaired = repairToolCallPairing([user('go'), assistantCalls(['call_1'])]);
    expect(shape(repaired.messages).slice(2)).toEqual([['tool', 'call_1']]);
  });

  it('drops a second reply for the same call id (upstream rejects duplicates)', () => {
    const repaired = repairToolCallPairing([
      user('go'),
      assistantCalls(['call_1']),
      reply('first', 'call_1'),
      reply('second', 'call_1'),
    ]);
    expect(shape(repaired.messages).slice(2)).toEqual([['tool', 'call_1']]);
    expect(repaired.messages[2]!.content).toBe('first');
    expect(repaired).toMatchObject({ synthesized: 0, duplicates: 1, orphans: 0 });
  });

  it('drops a reply whose call id no assistant message declared', () => {
    const repaired = repairToolCallPairing([reply('ghost', 'call_x'), user('go')]);
    expect(shape(repaired.messages)).toEqual([['user', null]]);
    expect(repaired).toMatchObject({ synthesized: 0, duplicates: 0, orphans: 1 });
  });

  it('leaves a conforming conversation untouched (same array instance)', () => {
    const clean = [user('go'), assistantCalls(['call_1']), reply('A', 'call_1'), user('thanks')];
    const repaired = repairToolCallPairing(clean);
    expect(repaired.messages).toBe(clean);
    expect(repaired).toMatchObject({ synthesized: 0, duplicates: 0, orphans: 0 });
  });
});

describe('tool-pairing: the orchestrator repairs the forwarded payload', () => {
  const model: ModelRegistration = {
    id: 'p1/alpha',
    provider: 'p1',
    upstreamModel: 'alpha',
    tier: 'plus',
    isDefaultInTier: true,
    pricing: { input: 1, output: 2, cacheRead: 0.1 },
  };

  function fixture(): { orchestrator: PipelineOrchestrator; seen: ChatCompletionRequest[] } {
    const base = loadConfig();
    const config = {
      ...base,
      models: [],
      tiers: base.tiers ?? {},
      session: { enabled: true, strategy: 'monotonic', ttlSeconds: 3600, maxSessions: 100 },
    } as unknown as RouterConfig;
    const registry = new ProviderRegistry(config, false);
    registry.setAutoRefreshTierMatch(false);
    const seen: ChatCompletionRequest[] = [];
    const stub: LLMProvider = {
      name: 'p1',
      async createCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        seen.push(structuredClone(req));
        return {
          id: 'ok',
          object: 'chat.completion',
          created: 1,
          model: 'alpha',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        } as ChatCompletionResponse;
      },
    };
    registry.registerProvider('p1', stub, []);
    registry.registerModel(model, true);
    return { orchestrator: new PipelineOrchestrator(config, registry, new FinOpsTracker()), seen };
  }

  it('inserts the missing tool reply before forwarding to the upstream', async () => {
    const { orchestrator, seen } = fixture();
    const target = {
      model: 'p1/alpha',
      messages: [user('read the file'), assistantCalls(['call_1']), user('never mind')],
    } as ChatCompletionRequest;

    await orchestrator.process(target);

    expect(seen).toHaveLength(1);
    expect(shape(seen[0]!.messages)).toEqual([
      ['user', null],
      ['assistant', null],
      ['tool', 'call_1'],
      ['user', null],
    ]);
    // The caller's own array is never mutated: capture and the session chain
    // index the bytes the client actually sent.
    expect(target.messages).toHaveLength(3);
  });

  it('forwards an already-valid chain byte-for-byte', async () => {
    const { orchestrator, seen } = fixture();
    await orchestrator.process({
      model: 'p1/alpha',
      messages: [user('go'), assistantCalls(['call_1']), reply('A', 'call_1'), user('thanks')],
    } as ChatCompletionRequest);

    expect(seen).toHaveLength(1);
    expect(shape(seen[0]!.messages)).toEqual([
      ['user', null],
      ['assistant', null],
      ['tool', 'call_1'],
      ['user', null],
    ]);
  });
});

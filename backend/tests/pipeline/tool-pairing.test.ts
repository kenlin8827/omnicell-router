import { describe, expect, it } from 'bun:test';
import { loadConfig } from '../../src/config/index.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { FinOpsTracker } from '../../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../../src/pipeline/orchestrator.js';
import { UNANSWERED_TOOL_CONTENT, repairToolCallPairing } from '../../src/pipeline/tool-pairing.js';
import type { LLMProvider } from '../../src/providers/base.js';
import type { CanonicalRequest, InputItem } from '../../src/ir/types.js';
import type { ModelRegistration, RouterConfig } from '../../src/config/types.js';
import { responseIR } from '../helpers/ir.js';

/**
 * Tool-call pairing normalization (ADR-0008 §9). Every canonical tool_call
 * must have exactly one tool_result before the next non-tool input item.
 * Clients break the contract on their own — cancelled tool run, aborted turn,
 * client-side compaction, a reply appended twice — so the pipeline normalizes
 * the canonical chain instead of forwarding an invalid history.
 */

const user = (content: string): InputItem => ({
  type: 'message', role: 'user', content: [{ type: 'text', text: content }],
});
const reply = (content: string, callId: string): InputItem => ({
  type: 'tool_result', callId, content: [{ type: 'text', text: content }],
});
const assistantCalls = (ids: string[]): InputItem[] => ids.map((id) => ({
  type: 'tool_call', id, callId: id, name: 'read', arguments: '{}',
}));
const shape = (input: InputItem[]) => input.map((item) => [
  item.type === 'message' ? item.role : item.type,
  item.type === 'tool_result' ? item.callId : null,
]);
const textOf = (item: InputItem | undefined): string | undefined =>
  item?.type === 'tool_result' && item.content[0]?.type === 'text' ? item.content[0].text : undefined;

describe('tool-pairing: repairToolCallPairing', () => {
  it('closes a cancelled call before the user message that follows it', () => {
    const repaired = repairToolCallPairing([user('open the file'), ...assistantCalls(['call_1']), user('never mind')]);
    expect(shape(repaired.input)).toEqual([
      ['user', null],
      ['tool_call', null],
      ['tool_result', 'call_1'],
      ['user', null],
    ]);
    expect(textOf(repaired.input[2])).toBe(UNANSWERED_TOOL_CONTENT);
    expect(repaired).toMatchObject({ synthesized: 1, duplicates: 0, orphans: 0 });
  });

  it('closes an unanswered call of a parallel batch without touching the answered one', () => {
    const repaired = repairToolCallPairing([user('go'), ...assistantCalls(['call_1', 'call_2']), reply('B', 'call_2')]);
    expect(shape(repaired.input).slice(3)).toEqual([
      ['tool_result', 'call_2'],
      ['tool_result', 'call_1'],
    ]);
    expect(repaired.synthesized).toBe(1);
  });

  it('closes calls at the end of the chain (nothing may follow the last unanswered turn)', () => {
    const repaired = repairToolCallPairing([user('go'), ...assistantCalls(['call_1'])]);
    expect(shape(repaired.input).slice(2)).toEqual([['tool_result', 'call_1']]);
  });

  it('drops a second reply for the same call id (upstream rejects duplicates)', () => {
    const repaired = repairToolCallPairing([
      user('go'),
      ...assistantCalls(['call_1']),
      reply('first', 'call_1'),
      reply('second', 'call_1'),
    ]);
    expect(shape(repaired.input).slice(2)).toEqual([['tool_result', 'call_1']]);
    expect(textOf(repaired.input[2])).toBe('first');
    expect(repaired).toMatchObject({ synthesized: 0, duplicates: 1, orphans: 0 });
  });

  it('drops a reply whose call id no assistant message declared', () => {
    const repaired = repairToolCallPairing([reply('ghost', 'call_x'), user('go')]);
    expect(shape(repaired.input)).toEqual([['user', null]]);
    expect(repaired).toMatchObject({ synthesized: 0, duplicates: 0, orphans: 1 });
  });

  it('leaves a conforming conversation untouched (same array instance)', () => {
    const clean = [user('go'), ...assistantCalls(['call_1']), reply('A', 'call_1'), user('thanks')];
    const repaired = repairToolCallPairing(clean);
    expect(repaired.input).toBe(clean);
    expect(repaired).toMatchObject({ synthesized: 0, duplicates: 0, orphans: 0 });
  });

  it('preserves multi-turn parallel tool_calls with reasoning without splitting the second turn', () => {
    const clean: InputItem[] = [
      user('inspect files'),
      { type: 'reasoning', text: 'turn 1 thinking' },
      ...assistantCalls(['call_1', 'call_2']),
      reply('R1', 'call_1'),
      reply('R2', 'call_2'),
      { type: 'reasoning', text: 'turn 2 thinking' },
      ...assistantCalls(['call_3', 'call_4']),
      reply('R3', 'call_3'),
      reply('R4', 'call_4'),
    ];
    const repaired = repairToolCallPairing(clean);
    expect(repaired.input).toBe(clean);
    expect(repaired).toMatchObject({ synthesized: 0, duplicates: 0, orphans: 0 });
  });

  it('still flushes an abandoned parallel call from a partially answered turn when a new turn starts', () => {
    const repaired = repairToolCallPairing([
      user('go'),
      ...assistantCalls(['call_1', 'call_2']),
      reply('R1', 'call_1'),
      ...assistantCalls(['call_3', 'call_4']),
      reply('R3', 'call_3'),
      reply('R4', 'call_4'),
    ]);
    expect(shape(repaired.input)).toEqual([
      ['user', null],
      ['tool_call', null],
      ['tool_call', null],
      ['tool_result', 'call_1'],
      ['tool_result', 'call_2'],
      ['tool_call', null],
      ['tool_call', null],
      ['tool_result', 'call_3'],
      ['tool_result', 'call_4'],
    ]);
    expect(repaired).toMatchObject({ synthesized: 1, duplicates: 0, orphans: 0 });
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

  function fixture(): { orchestrator: PipelineOrchestrator; seen: CanonicalRequest[] } {
    const base = loadConfig();
    const config = {
      ...base,
      models: [],
      tiers: base.tiers ?? {},
      session: { enabled: true, strategy: 'monotonic', ttlSeconds: 3600, maxSessions: 100 },
    } as unknown as RouterConfig;
    const registry = new ProviderRegistry(config, false);
    registry.setAutoRefreshMembers(false);
    const seen: CanonicalRequest[] = [];
    const stub: LLMProvider = {
      name: 'p1',
      async createCompletion(req: CanonicalRequest) {
        seen.push(structuredClone(req));
        return responseIR('ok', { id: 'ok', model: 'alpha' });
      },
    };
    registry.registerProvider('p1', stub, []);
    registry.registerModel(model, true);
    return { orchestrator: new PipelineOrchestrator(config, registry, new FinOpsTracker()), seen };
  }

  it('inserts the missing tool reply before forwarding to the upstream', async () => {
    const { orchestrator, seen } = fixture();
    const target: CanonicalRequest = {
      model: 'p1/alpha',
      input: [user('read the file'), ...assistantCalls(['call_1']), user('never mind')],
    };

    await orchestrator.process(target);

    expect(seen).toHaveLength(1);
    expect(shape(seen[0]!.input)).toEqual([
      ['user', null],
      ['tool_call', null],
      ['tool_result', 'call_1'],
      ['user', null],
    ]);
    // The caller's own array is never mutated: capture and the session chain
    // index the items the client actually sent.
    expect(target.input).toHaveLength(3);
  });

  it('forwards an already-valid chain byte-for-byte', async () => {
    const { orchestrator, seen } = fixture();
    await orchestrator.process({
      model: 'p1/alpha',
      input: [user('go'), ...assistantCalls(['call_1']), reply('A', 'call_1'), user('thanks')],
    });

    expect(seen).toHaveLength(1);
    expect(shape(seen[0]!.input)).toEqual([
      ['user', null],
      ['tool_call', null],
      ['tool_result', 'call_1'],
      ['user', null],
    ]);
  });
});

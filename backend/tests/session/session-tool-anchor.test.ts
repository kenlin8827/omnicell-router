import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/index.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { FinOpsTracker } from '../../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../../src/pipeline/orchestrator.js';
import type { LLMProvider } from '../../src/providers/base.js';
import type { ChatCompletionRequest, ChatCompletionResponse, ChatMessage } from '../../src/types/openai.js';
import type { ModelRegistration, RouterConfig } from '../../src/config/types.js';
import { processIR, responseIR } from '../helpers/ir.js';

/**
 * Zero-header session continuity across a long agent tool loop, driven through
 * the REAL orchestrator pipeline (a stub provider answers every turn with a
 * tool call — no network).
 *
 * Regression for the pre-compression fingerprint snapshot. `SessionManager`
 * hashes `name`, `tool_call_id` and the canonical tool-call envelope, but the
 * orchestrator used to snapshot the request as a role+content-only copy, so
 * every registered boundary whose prefix contained a tool message was indexed
 * in a shape the client's fuller resend could never reproduce. Only the
 * opening boundaries (the prefixes that hold no tool message yet) stayed
 * matchable, and the probes only examine a window of the MOST RECENT
 * boundaries (`MAX_CHAIN_PROBES` 32, `MAX_TAIL_PROBES` 256) — once a tool loop
 * pushed the opening boundary out of both windows, every turn cold-started and
 * `/admin/sessions` grew one row per request.
 */

const model: ModelRegistration = {
  id: 'p1/tooly',
  provider: 'p1',
  upstreamModel: 'tooly',
  tier: 'plus',
  isDefaultInTier: true,
  pricing: { input: 1, output: 2, cacheRead: 0.1 },
};

/**
 * Enough tool exchanges that the opening boundary leaves BOTH probe windows:
 * 32 chain boundaries and 256 tail windows (~42 boundaries at 6 windows each).
 */
const EXCHANGES = 60;

function makeOrchestrator(): PipelineOrchestrator {
  const base = loadConfig();
  const config = {
    ...base,
    models: [],
    tiers: base.tiers ?? {},
    session: { enabled: true, strategy: 'monotonic', ttlSeconds: 3600, maxSessions: 100 },
  } as unknown as RouterConfig;
  const registry = new ProviderRegistry(config, false);
  registry.setAutoRefreshMembers(false);
  let served = 0;
  const provider: LLMProvider = {
    name: 'p1',
    async createCompletion() {
      served += 1;
      const id = `call_${served}`;
      return responseIR('', {
        id: `ok-${id}`, model: 'tooly', reason: 'tool_calls',
        output: [{
          type: 'tool_call', id, callId: id, name: 'read_file',
          arguments: `{\n  "path": "file-${served}.ts"\n}`,
        }],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });
    },
  };
  registry.registerProvider('p1', provider);
  registry.registerModel(model, true);
  return new PipelineOrchestrator(config, registry, new FinOpsTracker());
}

/** The served tool call as the client resends it: no `type`, compact arguments. */
function clientAssistant(n: number): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: `call_${n}`, function: { name: 'read_file', arguments: `{"path":"file-${n}.ts"}` } }],
  };
}

const toolResult = (n: number): ChatMessage => ({
  role: 'tool',
  tool_call_id: `call_${n}`,
  content: `export const x${n} = ${n};`,
});

const sys: ChatMessage = { role: 'system', content: 'You are a coding agent.' };
const firstUser: ChatMessage = { role: 'user', content: 'Read src/index.ts and summarize it.' };

const turn = (messages: ChatMessage[]): ChatCompletionRequest => ({ model: 'p1/tooly', messages });

describe('agent tool loop keeps one session across many turns', () => {
  it('re-anchors every continuation whose history already carries tool messages', async () => {
    const orchestrator = makeOrchestrator();

    const first = await processIR(orchestrator, turn([sys, firstUser]));
    assert.strictEqual(first.sessionLookupType, 'cold_start');

    // A second conversation sharing the byte-identical opening (the
    // boilerplate-opening shape harnesses actually send) claims the same
    // conversation key, so the key is ambiguous and only the byte-exact
    // anchors can hold a conversation together — the situation that produced
    // the session churn.
    const sibling = await processIR(orchestrator,
      turn([{ role: 'system', content: 'You are a different agent.' }, firstUser])
    );
    assert.notStrictEqual(sibling.sessionId, first.sessionId);

    const history: ChatMessage[] = [sys, firstUser];
    for (let n = 1; n <= EXCHANGES; n++) {
      history.push(clientAssistant(n), toolResult(n));
      const result = await processIR(orchestrator, turn([...history, { role: 'user', content: `continue ${n}` }]));
      assert.strictEqual(result.sessionId, first.sessionId, `turn ${n} must re-anchor the same session`);
      if (n === EXCHANGES) {
        assert.ok(
          ['prefix_chain', 'tail_anchor'].includes(result.sessionLookupType),
          `turn ${n} must re-anchor through a byte-exact anchor, got '${result.sessionLookupType}'`
        );
      }
    }
  });
});

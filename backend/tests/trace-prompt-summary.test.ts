import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { ChatCompletionRequest, ChatCompletionMessage } from '../src/types/openai.js';

/**
 * Trace `request.userPromptSummary` names the user message THAT TRIGGERED the
 * turn. A tool-result continuation turn carries the whole history, so its last
 * user message is the PREVIOUS turn's prompt — recording it again makes every
 * continuation row in the console's request detail read as a duplicate. The
 * orchestrator blanks the summary when the last user message's index already
 * existed at the session's previous turn (clients append; a genuinely new user
 * message lands at or past the previous messageCount).
 */

const config = loadConfig();
const registry = new ProviderRegistry(config, true); // mockMode
const orchestrator = new PipelineOrchestrator(config, registry, new FinOpsTracker());

const user = (text: string): ChatCompletionMessage => ({ role: 'user', content: text });
const assistant = (text: string): ChatCompletionMessage => ({ role: 'assistant', content: text });
const tool = (text: string): ChatCompletionMessage => ({ role: 'tool', content: text, tool_call_id: 'tc-1' });

async function turn(...messages: ChatCompletionMessage[]) {
  const req: ChatCompletionRequest = { model: 'auto', messages };
  return orchestrator.process(req);
}

function lastTrace() {
  return orchestrator.getTraceTracker().getRecentTraces({ limit: 1 }).data[0];
}

describe('trace userPromptSummary — continuation turns carry no duplicate prompt', () => {
  it('turn 1 records its user message; a tool continuation blanks the summary; the next fresh user message records again', async () => {
    const r1 = await turn(user('有这么复杂吗？点击一下看看'));
    assert.ok(r1.sessionId);
    assert.equal(lastTrace()?.request.userPromptSummary, '有这么复杂吗？点击一下看看');

    // Continuation: history + assistant tool call + tool result, NO new user
    // message. The last user message is turn 1's — already-recorded — so the
    // summary must come back empty (the console renders its wrench fallback).
    await turn(
      user('有这么复杂吗？点击一下看看'),
      assistant('mock reply'),
      tool('tool output'),
    );
    assert.equal(lastTrace()?.request.userPromptSummary, '');

    // A genuinely new user message appended to the same history records again.
    await turn(
      user('有这么复杂吗？点击一下看看'),
      assistant('mock reply'),
      tool('tool output'),
      user('再来一个追问'),
    );
    assert.equal(lastTrace()?.request.userPromptSummary, '再来一个追问');
  });
});

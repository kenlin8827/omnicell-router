import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnthropicPayload, buildGooglePayload, buildResponsesPayload } from '../helpers/ir.js';
import { ChatCompletionRequest } from '../../src/types/openai.js';
import { ReasoningEffort } from '../../src/types/router.js';

const baseModel = { id: 'm', upstreamModel: 'up' } as any;

/**
 * These tests prove the contract that the orchestrator relies on:
 * after a reasoning-effort downgrade, the value written back onto
 * normalizedRequest.reasoning_effort is what the provider payload
 * builder sees — and the builder produces an upstream payload that
 * matches the DOWNGRADED level, not the original client request.
 *
 * The orchestrator's post-execution recompute (which may further
 * downgrade against the actually-served model) is tested separately
 * in reasoning-effort-e2e.test.ts.
 */
describe('Effort downgrade → provider payload: link contract', () => {
  // For each (requested, downgraded) pair, build the payload directly
  // and assert the upstream-side field uses `downgraded`, not `requested`.
  const cases: Array<{
    requested: ReasoningEffort;
    downgraded: ReasoningEffort;
    anthropicExpected: { thinking?: { type: string; budget_tokens: number } };
    googleExpected: { thinkingConfig?: { thinkingBudget: number; includeThoughts: boolean } };
    responsesExpected: { reasoning?: { effort?: ReasoningEffort; max_tokens?: number } };
  }> = [
    {
      requested: 'xhigh',
      downgraded: 'high',
      anthropicExpected: { thinking: { type: 'enabled', budget_tokens: 16384 } },
      googleExpected: { thinkingConfig: { thinkingBudget: 16384, includeThoughts: true } },
      responsesExpected: { reasoning: { effort: 'high' } },
    },
    {
      requested: 'xhigh',
      downgraded: 'medium',
      anthropicExpected: { thinking: { type: 'enabled', budget_tokens: 4096 } },
      googleExpected: { thinkingConfig: { thinkingBudget: 4096, includeThoughts: true } },
      responsesExpected: { reasoning: { effort: 'medium' } },
    },
    {
      requested: 'high',
      downgraded: 'low',
      anthropicExpected: { thinking: { type: 'enabled', budget_tokens: 1024 } },
      googleExpected: { thinkingConfig: { thinkingBudget: 1024, includeThoughts: true } },
      responsesExpected: { reasoning: { effort: 'low' } },
    },
    {
      // `max` (Anthropic top tier) requested, downgraded to `high` (the
      // model's actual top). Verifies the full vocabulary works end-to-end
      // through every provider's payload builder.
      requested: 'max',
      downgraded: 'high',
      anthropicExpected: { thinking: { type: 'enabled', budget_tokens: 16384 } },
      googleExpected: { thinkingConfig: { thinkingBudget: 16384, includeThoughts: true } },
      responsesExpected: { reasoning: { effort: 'high' } },
    },
  ];

  for (const c of cases) {
    it(`Anthropic: downgraded ${c.requested}→${c.downgraded} → budget_tokens matches ${c.downgraded}`, () => {
      const p = buildAnthropicPayload(
        { ...baseReq(), reasoning_effort: c.downgraded } as ChatCompletionRequest,
        baseModel
      ) as any;
      assert.deepStrictEqual(p.thinking, c.anthropicExpected.thinking);
    });
    it(`Google: downgraded ${c.requested}→${c.downgraded} → thinkingBudget matches ${c.downgraded}`, () => {
      const p = buildGooglePayload(
        { ...baseReq(), reasoning_effort: c.downgraded } as ChatCompletionRequest,
        baseModel
      ) as any;
      assert.deepStrictEqual(p.generationConfig.thinkingConfig, c.googleExpected.thinkingConfig);
    });
    it(`Responses: downgraded ${c.requested}→${c.downgraded} → reasoning.effort matches ${c.downgraded}`, () => {
      const p = buildResponsesPayload(
        { ...baseReq(), reasoning_effort: c.downgraded } as ChatCompletionRequest,
        baseModel
      ) as any;
      assert.deepStrictEqual(p.reasoning, c.responsesExpected.reasoning);
    });
  }
});

function baseReq(): ChatCompletionRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: 'test' }],
  } as ChatCompletionRequest;
}
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterEngine } from '../src/router/index.js';
import { ChatCompletionRequest } from '../src/types/openai.js';
import { effortFromThinkingBudget } from '../src/types/router.js';
import { toIR } from './helpers/ir.js';

const route = (request: ChatCompletionRequest) => RouterEngine.routeAsync(toIR(request));

describe('Zero-Hardcoding Model-Driven Semantic Router', () => {
  it('should respect client force_tier override', async () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Anything' }],
      router_options: { force_tier: 'pro' },
    };
    const decision = await route(req);
    assert.strictEqual(decision.targetTier, 'pro');
    assert.strictEqual(decision.confidence, 1.0);
    assert.strictEqual(decision.layerUsed, 'layer0');
  });

  it('should flag structured-output requests for the schema-assertion cascade', async () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Extract contact info and return as JSON.' }],
      response_format: { type: 'json_object' },
    };

    const decision = await route(req);
    assert.strictEqual(decision.needsSchemaValidation, true);
  });

  it('does not arm the schema cascade from tools alone (no JSON contract to assert)', async () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Read a file and answer.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        },
      ],
    };

    const decision = await route(req);
    assert.strictEqual(decision.needsSchemaValidation, false);
  });

  it('should default safely to plus quality when no decision layer answers, never degrading to lite tier', async () => {
    // Ultra-short query (P=NP?) with no decision layer configured
    const req1: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'P=NP?' }],
    };
    const dec1 = await route(req1);
    assert.strictEqual(dec1.targetTier, 'plus', 'Must default to Plus quality baseline, never degraded to Lite!');
    assert.strictEqual(dec1.layerUsed, 'layer0');

    // Another short query
    const req2: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Compose a sonnet' }],
    };
    const dec2 = await route(req2);
    assert.strictEqual(dec2.targetTier, 'plus', 'Must default to Plus quality baseline!');
  });
});

describe('thinking budget → effort translation', () => {
  it('maps budget thresholds onto the ladder', () => {
    assert.strictEqual(effortFromThinkingBudget(0), 'none');
    assert.strictEqual(effortFromThinkingBudget(1024), 'low');
    assert.strictEqual(effortFromThinkingBudget(1025), 'medium');
    assert.strictEqual(effortFromThinkingBudget(4096), 'medium');
    assert.strictEqual(effortFromThinkingBudget(4097), 'high');
    assert.strictEqual(effortFromThinkingBudget(16384), 'high');
    assert.strictEqual(effortFromThinkingBudget(16385), 'xhigh');
  });
});

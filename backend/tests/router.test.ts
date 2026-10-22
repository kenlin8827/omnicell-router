import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterEngine } from '../src/router/index.js';
import { ChatCompletionRequest } from '../src/types/openai.js';

describe('Zero-Hardcoding Model-Driven Semantic Router', () => {
  it('should respect client force_tier override', async () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Anything' }],
      router_options: { force_tier: 'pro' },
    };
    const decision = await RouterEngine.routeAsync(req);
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

    const decision = await RouterEngine.routeAsync(req);
    assert.strictEqual(decision.needsSchemaValidation, true);
  });

  it('should default safely to plus quality when no decision layer answers, never degrading to lite tier', async () => {
    // Ultra-short query (P=NP?) with no decision layer configured
    const req1: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'P=NP?' }],
    };
    const dec1 = await RouterEngine.routeAsync(req1);
    assert.strictEqual(dec1.targetTier, 'plus', 'Must default to Plus quality baseline, never degraded to Lite!');
    assert.strictEqual(dec1.layerUsed, 'layer0');

    // Another short query
    const req2: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Compose a sonnet' }],
    };
    const dec2 = await RouterEngine.routeAsync(req2);
    assert.strictEqual(dec2.targetTier, 'plus', 'Must default to Plus quality baseline!');
  });
});

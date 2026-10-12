import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { FinOpsTracker } from '../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';
import { ChatCompletionRequest } from '../src/types/openai.js';

describe('End-to-End Pipeline & FinOps Orchestration', () => {
  const config = loadConfig();
  const registry = new ProviderRegistry(config, true); // mockMode = true
  const tracker = new FinOpsTracker();
  const orchestrator = new PipelineOrchestrator(config, registry, tracker);

  it('1. Simple chitchat should execute on Lite tier and record token usage', async () => {
    const req: ChatCompletionRequest = {
      model: 'auto-lite',
      messages: [{ role: 'user', content: 'hello there' }],
    };

    const result = await orchestrator.process(req);
    assert.strictEqual(result.tierUsed, 'lite');
    // Cost accounting was stripped from the execution contract; only routing
    // facts remain on the result.
    assert.ok(result.latencyMs >= 0);
  });

  it('2. Structured schema task with passing lite tier output completes without fallback', async () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Extract entities in JSON format.' }],
      response_format: { type: 'json_object' },
    };

    const result = await orchestrator.process(req);
    assert.strictEqual(result.tierUsed, 'lite');
    assert.strictEqual(result.fallbackOccurred, false);
  });

  it('3. Structured task with lite tier syntax error silently escalates to plus', async () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Strict schema extraction.' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'StrictTest',
          schema: {
            type: 'object',
            required: ['mandatory_key_that_fails_on_fast_tier'],
            properties: {
              mandatory_key_that_fails_on_fast_tier: { type: 'string' },
            },
          },
        },
      },
    };

    const result = await orchestrator.process(req);
    assert.strictEqual(result.fallbackOccurred, true);
    assert.strictEqual(result.tierUsed, 'plus');
    assert.ok(result.fallbackReason?.includes('Missing required key'));
  });

  it('4. FinOpsTracker correctly aggregates requests and token counters', () => {
    const stats = tracker.getStats();
    assert.ok(stats.totalRequests >= 3);
    assert.ok(stats.fallbackCount >= 1);
    assert.ok(stats.tokens.totalInputTokens > 0);
    assert.ok(stats.tokens.totalOutputTokens > 0);
  });
});

describe('Bare upstream-name resolution (explicit-model pass-through)', () => {
  // Isolated registry + tracker so the shared-instance describe above (and
  // its FinOps assertions) stay untouched.
  const config = loadConfig();
  const registry = new ProviderRegistry(
    {
      ...config,
      providers: [
        { name: 'alpha', type: 'openai-compatible', baseUrl: 'https://alpha.example.com/v1', apiKey: 'x' },
        { name: 'beta', type: 'openai-compatible', baseUrl: 'https://beta.example.com/v1', apiKey: 'x' },
      ],
    } as any,
    true // mockMode = true
  );
  const tracker = new FinOpsTracker();
  const orchestrator = new PipelineOrchestrator(config, registry, tracker);

  const mk = (id: string, provider: string, tier: 'lite' | 'plus', input: number): any => ({
    id,
    provider,
    upstreamModel: 'qwen-test-flash',
    tier,
    isDefaultInTier: false,
    pricing: { input, cacheRead: input * 0.25, output: input * 4 },
  });
  // Two providers expose the SAME upstream name; beta is cheaper → primary.
  registry.registerModel(mk('alpha/qwen-test-flash', 'alpha', 'lite', 2.0));
  registry.registerModel(mk('beta/qwen-test-flash', 'beta', 'lite', 1.0));

  it('resolves a bare upstream name to the registered model (cheapest first)', async () => {
    const result = await orchestrator.process({
      model: 'qwen-test-flash',
      messages: [{ role: 'user', content: 'hello' }],
    } as ChatCompletionRequest);
    assert.strictEqual(result.modelUsed, 'beta/qwen-test-flash');
    assert.strictEqual(result.tierUsed, 'lite');
  });

  // B2: bare-name host pinning reads ONLY the MITM leg's clientRequest
  // headers (the original dialed host after TLS termination). These cases
  // therefore pass a clientRequest-shaped context — the pre-B2 shape
  // (`headers: { host }`) is what a native-leg FORGER could control, so it
  // is no longer a pinning input (see the negative test below).
  const mitmCtx = (host: string) => ({
    clientRequest: { method: 'POST', headers: { host } },
  });

  it('pins the provider via the MITM target host when the client dialed it', async () => {
    const result = await orchestrator.process(
      {
        model: 'qwen-test-flash',
        messages: [{ role: 'user', content: 'hello' }],
      } as ChatCompletionRequest,
      mitmCtx('alpha.example.com')
    );
    // alpha is pricier, but the request was addressed to its endpoint.
    assert.strictEqual(result.modelUsed, 'alpha/qwen-test-flash');
  });

  it('host matching is case- and port-insensitive', async () => {
    const result = await orchestrator.process(
      {
        model: 'qwen-test-flash',
        messages: [{ role: 'user', content: 'hello' }],
      } as ChatCompletionRequest,
      mitmCtx('ALPHA.Example.com:443')
    );
    assert.strictEqual(result.modelUsed, 'alpha/qwen-test-flash');
  });

  it('falls back to cheapest-first when the target host matches no provider', async () => {
    const result = await orchestrator.process(
      {
        model: 'qwen-test-flash',
        messages: [{ role: 'user', content: 'hello' }],
      } as ChatCompletionRequest,
      mitmCtx('unknown-gateway-host.example.net')
    );
    assert.strictEqual(result.modelUsed, 'beta/qwen-test-flash');
  });

  it('does NOT pin from the native-leg headers.host — a forged Host cannot steer resolution', async () => {
    // B2 negative: the Fastify-shaped context carries client-controlled
    // `headers`. Claiming alpha (the pricier same-name sibling) there must
    // change nothing — resolution stays cheapest-hit-first (beta).
    const result = await orchestrator.process(
      {
        model: 'qwen-test-flash',
        messages: [{ role: 'user', content: 'hello' }],
      } as ChatCompletionRequest,
      { headers: { host: 'alpha.example.com' } }
    );
    assert.strictEqual(result.modelUsed, 'beta/qwen-test-flash');
  });

  it('defense-in-depth: bare-name resolution honors a tier-level DENY entry (403)', async () => {
    // B1: `auto-lite` is a TIER entry — id matching alone cannot see it.
    // The explicit-model check must pass explicitModel.tier so the denied
    // lite-tier model fails closed here (403) instead of being served by
    // the pool filter finding zero candidates.
    await assert.rejects(
      () =>
        orchestrator.process(
          {
            model: 'qwen-test-flash',
            messages: [{ role: 'user', content: 'hello' }],
          } as ChatCompletionRequest,
          { modelAccess: { mode: 'deny', models: ['auto-lite'] } }
        ),
      (err: any) => {
        assert.match(err.message, /API key model policy denies model 'beta\/qwen-test-flash'/);
        assert.strictEqual(err.statusCode, 403);
        return true;
      }
    );
  });

  it('keeps the classifier contract for an unregistered bare name', async () => {
    const result = await orchestrator.process({
      model: 'no-such-upstream-name',
      messages: [{ role: 'user', content: 'hello' }],
    } as ChatCompletionRequest);
    assert.notStrictEqual(result.modelUsed, 'no-such-upstream-name');
  });
});

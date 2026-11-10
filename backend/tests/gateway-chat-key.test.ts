/**
 * Gateway-driven completions and their bound API key (ADR-0017 §5).
 *
 * ONLY OCR-routed completions reach this seam — vendor-native traffic is
 * relayed byte-verbatim upstream and never needs a key. The tests pin the
 * consumer-visible consequences of the policy: inbound `apiKeys[].limits`
 * deny with 429, `modelAccess` denies with 403, an unusable binding fails
 * closed with 401, and NO identity at all refuses the OCR turn (passthrough
 * still works because it does not enter the seam).
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGatewayChatServices } from '../src/surfaces/gateway-chat.js';
import { RateLimiter, apiKeySubject, setRateLimiterForTests } from '../src/ratelimit/rate-limiter.js';
import type { ApiKeyConfig, RouterConfig } from '../src/config/types.js';
import type { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';

// File-scoped sandbox: the event ledger / config paths must never touch the
// operator's live OCR home.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-gateway-key-'));
process.env.OCR_HOME = TEST_HOME;
process.env.OCR_ENV = 'default';

const KEY_ID = 'key-gateway-bound';

function apiKey(over: Partial<ApiKeyConfig> = {}): ApiKeyConfig {
  return {
    id: KEY_ID,
    name: 'Cursor Gateway',
    key: 'sk-ocr-gateway-bound',
    enabled: true,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/** Registry double: one allowed model, nothing else resolves. */
function registry() {
  return {
    getAllModels: () => [],
    getModel: (id: string) => (id === 'allowed/model' ? { id, tier: 'pro' } : undefined),
    resolveCombo: () => [],
    resolveVariantRef: () => null,
    getCredentialChain: () => [],
  };
}

function harness(keys: ApiKeyConfig[]) {
  const cfg = { apiKeys: keys } as unknown as RouterConfig;
  const limiter = new RateLimiter();
  limiter.reload(cfg);
  setRateLimiterForTests(limiter);

  let dispatched = 0;
  const orchestrator = {
    getRegistry: registry,
    process: async () => {
      dispatched++;
      throw new Error('sentinel: dispatch reached');
    },
  } as unknown as PipelineOrchestrator;

  const events: Array<{ status: number; payload: unknown; headers?: Record<string, string> }> = [];
  const sink = {
    onChunk: () => {},
    onJson: (status: number, payload: unknown, headers?: Record<string, string>) => {
      events.push({ status, payload, headers });
    },
    onEnd: () => {},
  };
  const service = buildGatewayChatServices(orchestrator, (id) => keys.find((k) => k.id === id));
  return { service, sink, events, dispatched: () => dispatched, limiter };
}

const body = (model: string) => ({
  model,
  stream: false,
  messages: [{ role: 'user', content: 'hello' }],
});

describe('gateway chat key binding', () => {
  beforeEach(() => {
    setRateLimiterForTests(undefined);
  });

  it('fails closed when the bound key id no longer resolves', async () => {
    const h = harness([]);
    await h.service.run(body('allowed/model'), h.sink, undefined, { keyId: KEY_ID });
    expect(h.dispatched()).toBe(0);
    expect(h.events).toHaveLength(1);
    expect(h.events[0].status).toBe(401);
    expect((h.events[0].payload as { error: { code: string } }).error.code).toBe('invalid_api_key');
  });

  it('refuses OCR routing when no key identity exists (passthrough is unaffected)', async () => {
    const h = harness([apiKey()]);
    await h.service.run(body('denied/model'), h.sink, undefined, {});
    expect(h.dispatched()).toBe(0);
    expect(h.events).toHaveLength(1);
    expect(h.events[0].status).toBe(401);
    expect((h.events[0].payload as { error: { code: string } }).error.code).toBe('invalid_api_key');
  });

  it('enforces the bound key’s inbound request window (429 + Retry-After)', async () => {
    const key = apiKey({ limits: [{ window: '1m', requests: 1 }] });
    const h = harness([key]);
    h.limiter.tryDispatch(apiKeySubject(KEY_ID)); // consume the only slot
    await h.service.run(body('allowed/model'), h.sink, undefined, { keyId: KEY_ID });
    expect(h.dispatched()).toBe(0);
    expect(h.events[0].status).toBe(429);
    expect(Number(h.events[0].headers?.['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('applies the bound key’s model access policy', async () => {
    const key = apiKey({ modelAccess: { mode: 'allow', models: ['allowed/model'] } });
    const h = harness([key]);
    await h.service.run(body('denied/model'), h.sink, undefined, { keyId: KEY_ID });
    expect(h.dispatched()).toBe(0);
    expect(h.events[0].status).toBe(403);
    expect((h.events[0].payload as { error: { code: string } }).error.code).toBe('model_not_allowed');
  });

  it('dispatches an admitted, policy-allowed turn', async () => {
    const key = apiKey({ modelAccess: { mode: 'allow', models: ['allowed/model'] } });
    const h = harness([key]);
    await h.service.run(body('allowed/model'), h.sink, undefined, { keyId: KEY_ID });
    expect(h.dispatched()).toBe(1);
  });
});

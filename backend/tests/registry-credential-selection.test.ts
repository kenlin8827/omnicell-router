import { describe, it, expect } from 'bun:test';
import { ProviderRegistry } from '../src/providers/registry.js';
import { UpstreamError } from '../src/resilience/error-classifier.js';
import { keyHashPrefix } from '../src/opencode/credentials/index.js';
import type { LLMProvider, CallCredential } from '../src/providers/base.js';
import type { ModelRegistration, RouterConfig } from '../src/config/types.js';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../src/types/openai.js';

/**
 * Registry-level credential selection + error attribution.
 *
 * Coverage:
 *  (d) usedCredentialKeyHashPrefix is stamped centrally on failures with the USED
 *      credential's prefix (selector hit → that credential; no selector → chain
 *      head = the boot-baked key) and the original error class/shape is
 *      preserved untouched;
 *  (c) no-selector calls pass NO credential down (executors keep using the
 *      baked key) and chain-less providers behave exactly like before — no
 *      stamp, no selector resolution;
 *  selector hygiene: an unknown prefix fails loudly BEFORE the executor runs.
 */

const cred = (key: string, label?: string): CallCredential => ({
  key,
  keyHashPrefix: keyHashPrefix(key),
  label: label ?? key,
});
const chain = [cred('sk-one', 'acct-1'), cred('sk-two', 'acct-2')];

const request: ChatCompletionRequest = {
  model: 'p/m1',
  messages: [{ role: 'user', content: 'hi' }],
};

const model: ModelRegistration = {
  id: 'p/m1',
  provider: 'p',
  upstreamModel: 'm1',
  tier: 'plus',
  pricing: { input: 1, output: 2, cacheRead: 0.1 },
};

function makeRegistry(): ProviderRegistry {
  const config = {
    port: 3000,
    host: '127.0.0.1',
    circuitBreaker: { enabled: false },
    models: [model],
    tiers: {},
  } as unknown as RouterConfig;
  const registry = new ProviderRegistry(config, false);
  registry.setAutoRefreshTierMatch(false); // no disk re-reads in tests
  return registry;
}

/** Stub provider recording the 4th createCompletion argument (the credential). */
function makeStub(behavior?: (credential?: CallCredential) => Promise<ChatCompletionResponse>) {
  const seen: (CallCredential | undefined)[] = [];
  const provider: LLMProvider = {
    name: 'p',
    async createCompletion(_req, _model, _ctx, credential) {
      seen.push(credential);
      if (behavior) return behavior(credential);
      return {
        id: 'ok',
        object: 'chat.completion',
        created: 1,
        model: 'm1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      } as ChatCompletionResponse;
    },
  };
  return { provider, seen };
}

const okResponse = async (): Promise<ChatCompletionResponse> =>
  ({ id: 'ok', object: 'chat.completion', created: 1, model: 'm1', choices: [] }) as ChatCompletionResponse;

describe('(c) no-selector path stays backward compatible', () => {
  it('executor receives NO credential (baked config.apiKey path) and the response passes through', async () => {
    const registry = makeRegistry();
    const { provider, seen } = makeStub(okResponse);
    registry.registerProvider('p', provider, chain);
    const res = await registry.execute(request, model);
    expect(seen).toEqual([undefined]); // default = undefined, NOT the chain head
    expect(res.id).toBe('ok');
  });

  it('chain-less provider: no credential, no stamp on failure', async () => {
    const registry = makeRegistry();
    const boom = new UpstreamError({ message: 'upstream down', status: 503, provider: 'p', modelId: 'p/m1' });
    const { provider, seen } = makeStub(async () => {
      throw boom;
    });
    registry.registerProvider('p', provider); // no chain argument
    await expect(registry.execute(request, model)).rejects.toBe(boom);
    expect(seen).toEqual([undefined]);
    expect((boom as { usedCredentialKeyHashPrefix?: string }).usedCredentialKeyHashPrefix).toBeUndefined();
  });
});

describe('selector resolution from the registered chain', () => {
  it('a known keyHashPrefix selects exactly that credential for the executor', async () => {
    const registry = makeRegistry();
    const { provider, seen } = makeStub(okResponse);
    registry.registerProvider('p', provider, chain);
    await registry.execute(request, model, undefined, chain[1]!.keyHashPrefix);
    expect(seen).toEqual([chain[1]]);
  });

  it('an unknown prefix fails LOUDLY before the executor runs (stale credential state)', async () => {
    const registry = makeRegistry();
    const { provider, seen } = makeStub(okResponse);
    registry.registerProvider('p', provider, chain);
    await expect(registry.execute(request, model, undefined, 'nope00000000')).rejects.toThrow(
      /Unknown credential selector 'nope00000000' for provider 'p'/
    );
    expect(seen).toEqual([]);
  });

  it('getActiveCredential returns the chain head; undefined without a chain', () => {
    const registry = makeRegistry();
    registry.registerProvider('p', makeStub(okResponse).provider, chain);
    registry.registerProvider('bare', makeStub(okResponse).provider);
    expect(registry.getActiveCredential('p')).toBe(chain[0]);
    expect(registry.getCredentialChain('p')).toBe(chain);
    expect(registry.getActiveCredential('bare')).toBeUndefined();
    expect(registry.getCredentialChain('bare')).toBeUndefined();
  });
});

describe('(d) central error attribution — usedCredentialKeyHashPrefix', () => {
  it('no-selector failure stamps the chain head (the boot-baked identity)', async () => {
    const registry = makeRegistry();
    const boom = new UpstreamError({ message: 'invalid key', status: 401, provider: 'p', modelId: 'p/m1' });
    const { provider } = makeStub(async () => {
      throw boom;
    });
    registry.registerProvider('p', provider, chain);
    await expect(registry.execute(request, model)).rejects.toBe(boom); // same instance, unchanged shape
    expect(boom instanceof UpstreamError).toBe(true);
    expect(boom.status).toBe(401);
    expect(boom.message).toBe('invalid key');
    expect(boom.usedCredentialKeyHashPrefix).toBe(chain[0]!.keyHashPrefix);
  });

  it('selector-path failure stamps the SELECTED credential, not the head', async () => {
    const registry = makeRegistry();
    const boom = new UpstreamError({ message: 'quota', status: 429, provider: 'p', modelId: 'p/m1' });
    const { provider } = makeStub(async () => {
      throw boom;
    });
    registry.registerProvider('p', provider, chain);
    await expect(registry.execute(request, model, undefined, chain[1]!.keyHashPrefix)).rejects.toBe(boom);
    expect(boom.usedCredentialKeyHashPrefix).toBe(chain[1]!.keyHashPrefix);
  });

  it('non-UpstreamError throws are stamped too — class/shape preserved', async () => {
    const registry = makeRegistry();
    const plain = new TypeError('socket hang up');
    const { provider } = makeStub(async () => {
      throw plain;
    });
    registry.registerProvider('p', provider, chain);
    await expect(registry.execute(request, model)).rejects.toBe(plain);
    expect(plain instanceof TypeError).toBe(true);
    expect((plain as TypeError & { usedCredentialKeyHashPrefix?: string }).usedCredentialKeyHashPrefix).toBe(
      chain[0]!.keyHashPrefix
    );
  });

  it('display-safe only — the full raw key never enters the stamp', async () => {
    const registry = makeRegistry();
    const boom = new UpstreamError({ message: 'x', status: 500 });
    const { provider } = makeStub(async () => {
      throw boom;
    });
    registry.registerProvider('p', provider, chain);
    await expect(registry.execute(request, model)).rejects.toBe(boom);
    expect(boom.usedCredentialKeyHashPrefix).toBe(keyHashPrefix('sk-one'));
    expect(boom.usedCredentialKeyHashPrefix!.length).toBe(12);
    expect(boom.usedCredentialKeyHashPrefix).not.toContain('sk-one');
  });
});

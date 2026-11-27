import { describe, expect, it } from 'bun:test';
import { migrateProvidersDoc, migrateOverridesDoc } from '../../src/opencode/migrate/engine.js';
import { pickDialWire } from '../../src/providers/dial-wire.js';
import type { CanonicalRequest } from '../../src/ir/types.js';

describe('providers.json v1→v2 protocols hop', () => {
  it('lifts package/npm to protocols and drops retired keys', () => {
    const next = migrateProvidersDoc({
      version: 1,
      updated: 1,
      providers: {
        openai: {
          name: 'OpenAI',
          package: 'openai-chat',
          models: {
            'gpt-4o': { provider: { npm: 'openai-responses' } },
          },
        },
      },
    });
    expect(next.version).toBe(2);
    const node = (next.providers as any).openai;
    expect(node.protocols).toEqual(['openai-chat']);
    expect(node.package).toBeUndefined();
    expect(node.npm).toBeUndefined();
    expect(node.models['gpt-4o'].provider.protocols).toEqual(['openai-responses']);
    expect(node.models['gpt-4o'].provider.npm).toBeUndefined();
  });
});

describe('overrides.json v1→v2 protocols hop', () => {
  it('lifts npm to protocols', () => {
    const next = migrateOverridesDoc({
      version: 1,
      updated: 1,
      models: {
        'openai||gpt-4o': { npm: 'openai-responses', name: 'GPT' },
      },
    });
    expect(next.version).toBe(2);
    const entry = (next.models as any)['openai||gpt-4o'];
    expect(entry.protocols).toEqual(['openai-responses']);
    expect(entry.npm).toBeUndefined();
    expect(entry.name).toBe('GPT');
  });
});

describe('prefer-native dial', () => {
  const baseReq = {
    model: 'm',
    input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  } as CanonicalRequest;

  it('prefers inbound surface when listed', () => {
    expect(pickDialWire(['openai-chat', 'openai-responses'], 'openai-responses', baseReq)).toBe(
      'openai-responses',
    );
  });

  it('falls back to declaration order when inbound absent', () => {
    expect(pickDialWire(['openai-chat', 'openai-responses'], undefined, baseReq)).toBe('openai-chat');
  });

  it('escalates past protocols[0] when inbound is absent but only a later wire admits the request', () => {
    // Custom tools are refused on anthropic-messages; prefer-native must dial
    // openai-responses even when anthropic is declared first (boot primary).
    const withCustomTool = {
      ...baseReq,
      tools: [{ type: 'custom', name: 'shell', description: 'x' }],
    } as CanonicalRequest;
    expect(
      pickDialWire(['anthropic-messages', 'openai-responses'], undefined, withCustomTool),
    ).toBe('openai-responses');
  });
});

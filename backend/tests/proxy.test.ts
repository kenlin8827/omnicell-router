import { describe, expect, test, beforeEach, beforeAll, afterAll } from 'bun:test';
import { initProxyConfig, isLoopbackUrl, resolveProxyUrl, proxiedFetch } from '../src/utils/proxy.js';
import { ProxyConfig } from '../src/config/types.js';

describe('isLoopbackUrl', () => {
  test('matches loopback hosts', () => {
    expect(isLoopbackUrl('http://localhost:49374/api')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:3000/v1')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.55:3000/v1')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:3000/v1')).toBe(true);
    expect(isLoopbackUrl('http://app.localhost/v1')).toBe(true);
  });

  test('does not match public hosts (and tolerates garbage)', () => {
    expect(isLoopbackUrl('https://api.anthropic.com/v1/messages')).toBe(false);
    expect(isLoopbackUrl('https://openrouter.ai/api/v1/models')).toBe(false);
    expect(isLoopbackUrl('http://192.168.1.10:11434')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });
});

describe('resolveProxyUrl', () => {
  const anthropicCall = { provider: 'anthropic', model: 'claude-3-5-haiku-20241022' };
  const deepseekCall = { provider: 'deepseek', model: 'deepseek-chat' };
  const openaiCall = { provider: 'openai', model: 'gpt-4o-mini' };

  beforeEach(() => initProxyConfig(undefined));

  test('no config / no url configured = direct', () => {
    expect(resolveProxyUrl('https://api.anthropic.com/v1/messages', anthropicCall)).toBeUndefined();
    initProxyConfig({});
    expect(resolveProxyUrl('https://api.anthropic.com/v1/messages', anthropicCall)).toBeUndefined();
    initProxyConfig({ url: '  ' });
    expect(resolveProxyUrl('https://api.anthropic.com/v1/messages')).toBeUndefined();
  });

  test('global url applies to all non-loopback calls (incl. unlisted infra syncs)', () => {
    initProxyConfig({ enabled: true, url: 'http://proxy:8080' } as ProxyConfig);
    expect(resolveProxyUrl('https://api.anthropic.com/v1/messages', anthropicCall)).toBe('http://proxy:8080');
    expect(resolveProxyUrl('https://models.dev/api.json')).toBe('http://proxy:8080');
  });

  test('proxy is OFF by default (enabled unset/false), even with url configured', () => {
    initProxyConfig({ url: 'http://proxy:8080' } as ProxyConfig);
    expect(resolveProxyUrl('https://api.anthropic.com/v1/messages', anthropicCall)).toBeUndefined();
    expect(resolveProxyUrl('https://models.dev/api.json')).toBeUndefined();
    initProxyConfig({ enabled: false, url: 'http://proxy:8080' } as ProxyConfig);
    expect(resolveProxyUrl('https://api.anthropic.com/v1/messages', anthropicCall)).toBeUndefined();
  });

  test('enabled=true opts in to proxying', () => {
    initProxyConfig({ enabled: true, url: 'http://proxy:8080' } as ProxyConfig);
    expect(resolveProxyUrl('https://api.anthropic.com/v1/messages', anthropicCall)).toBe('http://proxy:8080');
    expect(resolveProxyUrl('https://models.dev/api.json')).toBe('http://proxy:8080');
  });

  test('loopback targets are never proxied even with a global proxy', () => {
    initProxyConfig({ enabled: true, url: 'http://proxy:8080' } as ProxyConfig);
    expect(resolveProxyUrl('http://127.0.0.1:49374/api/provider')).toBeUndefined();
    expect(resolveProxyUrl('http://localhost:11434/v1/chat/completions', { provider: 'ollama', model: 'llama3' })).toBeUndefined();
  });

  test('provider-level pattern (provider/*) matches every model of that provider', () => {
    initProxyConfig({ enabled: true, url: 'http://proxy:8080', includes: ['anthropic/*'] } as ProxyConfig);
    expect(resolveProxyUrl('https://api.anthropic.com/v1/messages', anthropicCall)).toBe('http://proxy:8080');
    expect(resolveProxyUrl('https://api.anthropic.com/v1/messages', { provider: 'anthropic', model: 'claude-opus-4' })).toBe('http://proxy:8080');
    expect(resolveProxyUrl('https://api.deepseek.com/v1/chat/completions', deepseekCall)).toBeUndefined();
  });

  test('model-level patterns: */model-* across providers and bare model-* on the id', () => {
    initProxyConfig({ enabled: true, url: 'http://proxy:8080', includes: ['*/claude-*'] } as ProxyConfig);
    expect(resolveProxyUrl('https://api.anthropic.com/v1/messages', anthropicCall)).toBe('http://proxy:8080');
    expect(resolveProxyUrl('https://api.deepseek.com/v1/chat/completions', deepseekCall)).toBeUndefined();

    initProxyConfig({ enabled: true, url: 'http://proxy:8080', includes: ['claude-*'] } as ProxyConfig);
    expect(resolveProxyUrl('https://api.anthropic.com/v1/messages', anthropicCall)).toBe('http://proxy:8080');
  });

  test('bare provider name (no wildcard) works via composite substring', () => {
    initProxyConfig({ enabled: true, url: 'http://proxy:8080', includes: ['anthropic'] } as ProxyConfig);
    expect(resolveProxyUrl('https://api.anthropic.com/v1/messages', anthropicCall)).toBe('http://proxy:8080');
    expect(resolveProxyUrl('https://api.deepseek.com/v1/chat/completions', deepseekCall)).toBeUndefined();
  });

  test('excludes force direct even when a global proxy is set', () => {
    initProxyConfig({ enabled: true, url: 'http://proxy:8080', excludes: ['deepseek/*', 'gpt-4o-mini'] } as ProxyConfig);
    expect(resolveProxyUrl('https://api.deepseek.com/v1/chat/completions', deepseekCall)).toBeUndefined();
    expect(resolveProxyUrl('https://api.openai.com/v1/chat/completions', openaiCall)).toBeUndefined();
    expect(resolveProxyUrl('https://api.anthropic.com/v1/messages', anthropicCall)).toBe('http://proxy:8080');
  });

  test('both lists set: excludes checked first, includes gate the rest', () => {
    initProxyConfig({ enabled: true, url: 'http://proxy:8080', includes: ['anthropic/*'], excludes: ['*/claude-opus-*'] } as ProxyConfig);
    expect(resolveProxyUrl('https://api.anthropic.com/v1/messages', { provider: 'anthropic', model: 'claude-3-5-haiku' })).toBe('http://proxy:8080');
    expect(resolveProxyUrl('https://api.anthropic.com/v1/messages', { provider: 'anthropic', model: 'claude-opus-4-1' })).toBeUndefined();
    expect(resolveProxyUrl('https://api.openai.com/v1/chat/completions', openaiCall)).toBeUndefined();
  });

  test('non-empty includes list sends unlisted infra calls (catalog sync) direct', () => {
    initProxyConfig({ enabled: true, url: 'http://proxy:8080', includes: ['anthropic/*'] } as ProxyConfig);
    expect(resolveProxyUrl('https://models.dev/api.json')).toBeUndefined();
    expect(resolveProxyUrl('https://openrouter.ai/api/v1/models')).toBeUndefined();
  });

  test('excludes alone does not block unlisted infra calls', () => {
    initProxyConfig({ enabled: true, url: 'http://proxy:8080', excludes: ['deepseek/*'] } as ProxyConfig);
    expect(resolveProxyUrl('https://models.dev/api.json')).toBe('http://proxy:8080');
  });

  test('layer2 judge participates via its own provider/model', () => {
    initProxyConfig({ enabled: true, url: 'http://proxy:8080', includes: ['openrouter/*'] } as ProxyConfig);
    expect(resolveProxyUrl('https://openrouter.ai/api/v1/chat/completions', { provider: 'openrouter', model: 'mistral-7b' })).toBe('http://proxy:8080');
    // Layer 2 rides the native System One wire (ADR-0014), not a vendor SDK call.
    expect(resolveProxyUrl('https://api.typesafe.ai/v1/systemone', { provider: 'typesafe', model: 'typesafe/jev' })).toBeUndefined();
  });

  test('invalid proxy.url falls back to direct (warn, never throw)', () => {
    initProxyConfig({ enabled: true, url: 'not a url' } as ProxyConfig);
    expect(resolveProxyUrl('https://api.anthropic.com/v1/messages', anthropicCall)).toBeUndefined();
    initProxyConfig({ enabled: true, url: 'ftp://127.0.0.1:1080' } as ProxyConfig);
    expect(resolveProxyUrl('https://api.anthropic.com/v1/messages', anthropicCall)).toBeUndefined();
  });
});

describe('proxiedFetch against an authenticated mock proxy', () => {
  const EXPECTED = 'Basic ' + Buffer.from('alice:secret').toString('base64');
  let listener: any;
  let seen: Array<{ firstLine: string; auth: string | null }> = [];

  beforeAll(() => {
    listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(socket: any, data: any) {
          const text = data.toString('utf8');
          const firstLine = text.split('\r\n')[0] || '';
          const auth = /proxy-authorization:\s*(.*)/i.exec(text)?.[1]?.trim() || null;
          seen.push({ firstLine, auth });
          if (firstLine.startsWith('CONNECT')) {
            socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
            setTimeout(() => socket.end(), 200);
          } else if (/^(GET|POST)/.test(firstLine)) {
            socket.write(
              auth === EXPECTED
                ? 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{"proxied":true}'
                : 'HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
            );
          }
        },
      },
    });
  });

  afterAll(() => listener?.stop(true));
  beforeEach(() => initProxyConfig(undefined));

  test('user:pass@ in proxy.url → Proxy-Authorization sent, proxied response passes through', async () => {
    initProxyConfig({ enabled: true, url: `http://alice:secret@127.0.0.1:${listener.port}` } as ProxyConfig);
    const res = await proxiedFetch('http://192.0.2.1:9/x');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ proxied: true });
    expect(seen.at(-1)!.auth).toBe(EXPECTED);
  });

  test('no credentials → upstream 407 surfaces to the caller', async () => {
    initProxyConfig({ enabled: true, url: `http://127.0.0.1:${listener.port}` } as ProxyConfig);
    const res = await proxiedFetch('http://192.0.2.1:9/x');
    expect(res.status).toBe(407);
  });

  test('CONNECT (https target) carries Proxy-Authorization too', async () => {
    initProxyConfig({ enabled: true, url: `http://alice:secret@127.0.0.1:${listener.port}` } as ProxyConfig);
    await proxiedFetch('https://192.0.2.1:9/x', { signal: AbortSignal.timeout(4000) }).catch(() => undefined);
    expect(seen.some(s => s.firstLine.startsWith('CONNECT') && s.auth === EXPECTED)).toBe(true);
  });
});

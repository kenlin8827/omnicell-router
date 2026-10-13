import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { probeProvider } from '../src/opencode/probe.js';

/**
 * Security P3-5 — the console probe's upstream error echo: a hostile/misbugged
 * upstream repeats the SUBMITTED key (Authorization header) in its error body.
 * probe.ts must redact the key BEFORE the 300-char truncation (same rule as
 * the opencode v2 store's http() — redactBodySecrets reused, exported once).
 * A real loopback echo server exercises the full proxiedFetch path (loopback
 * targets are never proxied — utils/proxy.ts rule 1 — so this is proxy-safe).
 */

const KEY = 'sk-probe-LEAKTEST-0123456789abcdef';
let url = '';
let server: ReturnType<typeof Bun.serve> | null = null;

function containsKeyWindow(s: string): boolean {
  for (let i = 0; i + 8 <= KEY.length; i++) if (s.includes(KEY.slice(i, i + 8))) return true;
  return false;
}

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const auth = req.headers.get('authorization') ?? '';
      const key = auth.replace(/^Bearer\s+/i, '');
      // echo with the key pushed NEAR the truncation boundary (pre-fix leak band)
      const body = JSON.stringify({ error: `${'x'.repeat(250)}${key}-tail-padding-xxxx-yyyy-zzzz` });
      return new Response(body, { status: 400, headers: { 'content-type': 'application/json' } });
    },
  });
  url = `http://127.0.0.1:${server.port}/v1`;
});

afterAll(() => {
  server?.stop();
});

describe('probe error-body echo containment (security P3-5)', () => {
  it('openai wire: 400 echo of the submitted key never reaches the probe result', async () => {
    const res = await probeProvider({ baseURL: url, apiKey: KEY, model: 'm1', kind: 'openai' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('HTTP 400'); // diagnostic limb survives
    expect(containsKeyWindow(res.error ?? '')).toBe(false);
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it('the redacted marker is present — containment actually happened, not accidental absence', async () => {
    const res = await probeProvider({ baseURL: url, apiKey: KEY, model: 'm1', kind: 'openai' });
    expect(res.error).toContain('[redacted]');
  });

  it('short non-secret echoes (< REDACT_MIN_LEN) keep the diagnostic text intact', async () => {
    const res = await probeProvider({ baseURL: url, apiKey: 'k', model: 'm1', kind: 'openai' });
    // 'k' cannot be meaningfully redacted (not a secret floor) — body stays readable
    expect(res.error).toContain('HTTP 400');
    expect(res.error).toContain('-tail-padding-xxxx-yyyy-zzzz');
  });
});

describe('probe url-error hint (DashScope model↔endpoint mismatch)', () => {
  it('400 "url error, please check url" carries the model-type hint, not a baseURL guess', async () => {
    const s = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response(
          JSON.stringify({
            error: { message: 'url error, please check url! For details, see: https://www.alibabacloud.com/help/en/model-studio/error-code' },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        ),
    });
    try {
      const res = await probeProvider({ baseURL: `http://127.0.0.1:${s.port}/v1`, apiKey: 'k', model: 'vid-1', kind: 'openai' });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('端点与模型类型不匹配');
      // raw upstream echo still rides along for diagnosis
      expect(res.error).toContain('url error');
    } finally {
      s.stop();
    }
  });
});

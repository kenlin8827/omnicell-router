import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { probeProvider } from '../../src/opencode/probe.js';

/**
 * Region-refusal classification (status 400 + FAILED_PRECONDITION). Google's
 * Gemini API answers an unsupported egress region with its own wording, which
 * must land on the same `regionBlocked` limb as the OpenAI/Anthropic-style
 * "country, region, or territory" text — the console label is the operator's
 * only hint that the fix is an egress/region choice, not the model or key.
 * Real loopback server, same pattern as probe-404-hint.test.ts.
 */

let base = '';
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.includes('/google')) {
        return new Response(
          JSON.stringify({
            error: { code: 400, message: 'User location is not supported for the API use.', status: 'FAILED_PRECONDITION' },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          error: { message: 'Country, region, or territory not supported', type: 'invalid_request_error' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop();
});

describe('probe region-refusal limbs', () => {
  it('Google FAILED_PRECONDITION body on the gemini wire classifies regionBlocked', async () => {
    const res = await probeProvider({
      baseURL: `${base}/google/v1beta`,
      apiKey: 'k',
      model: 'gemini-x',
      kind: 'google-gemini',
    });
    expect(res.ok).toBe(false);
    expect(res.httpStatus).toBe(400);
    expect(res.hintCode).toBe('regionBlocked');
    expect(res.modelScoped).toBe(false); // the region gate is provider-wide, never model-scoped
    expect(res.upstreamBody).toContain('User location is not supported');
  });

  it('the OpenAI-style wording keeps classifying regionBlocked', async () => {
    const res = await probeProvider({ baseURL: `${base}/openai/v1`, apiKey: 'k', model: 'm1', kind: 'openai-chat' });
    expect(res.ok).toBe(false);
    expect(res.httpStatus).toBe(400);
    expect(res.hintCode).toBe('regionBlocked');
  });
});

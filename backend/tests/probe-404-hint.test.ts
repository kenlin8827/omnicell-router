import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { probeProvider, structuredApiError } from '../src/opencode/probe.js';

/**
 * 404 raw-body policy (product decision 2026-10-14): a 404 never carries a
 * hint limb — the echoed upstream body IS the diagnosis (structured JSON for a
 * business rejection like Ark's ModelNotOpen, gateway HTML for a truly missing
 * mount). The status still splits on modelScoped: structured body = the
 * endpoint answered and rejected only THIS model (provider-level test may
 * rotate); gateway body = provider-wide failure (no rotation). Real loopback
 * server, same pattern as probe-redaction.test.ts.
 */

let base = '';
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.includes('ark')) {
        // Ark-style business 404: endpoint alive, model-level failure.
        return new Response(
          JSON.stringify({
            error: { code: 'ModelNotOpen', message: 'Your account [123] has not opened this model' },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }
      // Gateway-style 404: the mount itself does not exist.
      return new Response('<html><head><title>404 Not Found</title></head><body>nginx</body></html>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop();
});

describe('probe 404 machine limbs (i18n contract: no human text on the wire)', () => {
  it('structured upstream 404 (Ark ModelNotOpen): no hintCode — the echoed JSON is the diagnosis', async () => {
    const res = await probeProvider({ baseURL: `${base}/ark/v1`, apiKey: 'k', model: 'glm-x', kind: 'openai' });
    expect(res.ok).toBe(false);
    expect(res.httpStatus).toBe(404);
    expect(res.hintCode).toBe('businessRejected'); // category label only — no cause guess
    expect(res.upstreamBody).toContain('ModelNotOpen'); // the upstream's own error body carries the truth
    expect(res.modelScoped).toBe(true); // rotation flag: safe to try the next model
  });

  it('gateway/HTML 404: same shape — raw body echoed, modelScoped stays false', async () => {
    const res = await probeProvider({ baseURL: `${base}/gateway/v1`, apiKey: 'k', model: 'm1', kind: 'openai' });
    expect(res.ok).toBe(false);
    expect(res.httpStatus).toBe(404);
    expect(res.hintCode).toBe('endpointNotFound'); // gateway-shaped 404 — factual label, no "/v1" speculation
    expect(res.upstreamBody).toContain('nginx'); // gateway body echoed verbatim
    expect(res.modelScoped).toBe(false); // gateway 404 is provider-wide — no rotation
  });
});

describe('structuredApiError shape detection', () => {
  it('accepts OpenAI/Ark nested, Anthropic type=error, and flat code+message bodies', () => {
    expect(structuredApiError('{"error":{"code":"UnsupportedModel","message":"m"}}')).toEqual({ code: 'UnsupportedModel' });
    expect(structuredApiError('{"type":"error","error":{"type":"not_found_error"}}')).toEqual({ code: undefined });
    expect(structuredApiError('{"code":"ResourceNotFound","message":"nope"}')).toEqual({ code: 'ResourceNotFound' });
  });

  it('rejects HTML, empty, non-error JSON and truncated bodies', () => {
    expect(structuredApiError('<html>404</html>')).toBeNull();
    expect(structuredApiError('')).toBeNull();
    expect(structuredApiError('{"models":["a","b"]}')).toBeNull();
    expect(structuredApiError('{"error":{"code":"X","mess')).toBeNull(); // truncated JSON
  });
});

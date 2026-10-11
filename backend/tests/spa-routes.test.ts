import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';

/**
 * Regression guard: the console is wildcard-served under /admin/ so ANY React
 * page — present or future — returns 200 text/html on a DIRECT request
 * (browser refresh / deep link) instead of 401 (auth hook) or 404. This was
 * the /proxy-access incident. Also pins: router precedence keeps
 * /admin/assets/* on the static handler (never HTML), and `/` redirects
 * into the console.
 */
describe('SPA route serving (refresh-safe deep links)', () => {
  it('every /admin/* path serves 200 text/html', async () => {
    const { app } = createServer(loadConfig(), true);
    for (const route of [
      '/admin',
      '/admin/',
      '/admin/tiers',
      '/admin/sessions',
      '/admin/proxy-access',
      '/admin/some-future-page',
    ]) {
      const res = await app.inject({ method: 'GET', url: route });
      assert.equal(res.statusCode, 200, `${route} returned ${res.statusCode}`);
      assert.ok(
        String(res.headers['content-type']).includes('text/html'),
        `${route} content-type: ${res.headers['content-type']}`
      );
    }
  });

  it('/admin/assets/* stays on the static handler (no HTML fallback)', async () => {
    const { app } = createServer(loadConfig(), true);
    const res = await app.inject({ method: 'GET', url: '/admin/assets/definitely-not-a-file.js' });
    assert.equal(res.statusCode, 404);
    assert.ok(!String(res.headers['content-type']).includes('text/html'));
  });

  it('`/` 301-redirects to the console prefix', async () => {
    const { app } = createServer(loadConfig(), true);
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 301);
    assert.equal(res.headers.location, '/admin/');
  });
});

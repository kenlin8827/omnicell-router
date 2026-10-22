import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadConfig, saveConfig, getConfigPath } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { validateModelAccess } from '../src/auth/api-keys.js';
import {
  getModelAccessPolicy,
  isModelAllowed,
  checkRequestedModel,
  makeModelAccessGuard,
} from '../src/auth/model-access.js';
import { RouterConfig } from '../src/config/types.js';

describe('Per-key model access policy (auth/model-access.ts)', () => {
  describe('pure helpers', () => {
    it('getModelAccessPolicy: undefined for absent/malformed policy, extracted otherwise', () => {
      assert.strictEqual(getModelAccessPolicy(undefined), undefined);
      assert.strictEqual(getModelAccessPolicy({} as any), undefined);
      assert.strictEqual(getModelAccessPolicy({ modelAccess: undefined } as any), undefined);
      assert.strictEqual(getModelAccessPolicy({ modelAccess: { mode: 'weird', models: ['x'] } } as any), undefined);
      assert.strictEqual(getModelAccessPolicy({ modelAccess: { mode: 'allow' } } as any), undefined);
      assert.deepStrictEqual(
        getModelAccessPolicy({ role: 'user', modelAccess: { mode: 'deny', models: ['a', 42, ''] } } as any).models,
        ['a'],
        'non-string / empty entries are dropped'
      );
      const policy = getModelAccessPolicy({ role: 'user', modelAccess: { mode: 'allow', models: ['m1'] } } as any);
      assert.deepStrictEqual(policy, { mode: 'allow', models: ['m1'] });
    });

    it('isModelAllowed: allow = only listed; deny = everything except listed', () => {
      const allow = { mode: 'allow' as const, models: ['m1', 'm2'] };
      const deny = { mode: 'deny' as const, models: ['m1'] };
      assert.strictEqual(isModelAllowed('m1', allow), true);
      assert.strictEqual(isModelAllowed('m3', allow), false);
      assert.strictEqual(isModelAllowed('m1', deny), false);
      assert.strictEqual(isModelAllowed('m3', deny), true);
      assert.strictEqual(isModelAllowed('anything', undefined), true);
    });

    it('isModelAllowed: * wildcard entries (prefix / suffix / bare)', () => {
      const prefix = { mode: 'allow' as const, models: ['zhipu/*'] };
      assert.strictEqual(isModelAllowed('zhipu/glm-5.3', prefix), true);
      assert.strictEqual(isModelAllowed('openai/gpt-4', prefix), false);
      assert.strictEqual(isModelAllowed('zhipu', prefix), false, 'pattern requires the separator');

      const suffix = { mode: 'deny' as const, models: ['*-ultra'] };
      assert.strictEqual(isModelAllowed('mock-ultra', suffix), false);
      assert.strictEqual(isModelAllowed('mock-ultra-2', suffix), true, 'no trailing * — suffix anchored');
      assert.strictEqual(isModelAllowed('mock-plus', suffix), true);

      const bare = { mode: 'allow' as const, models: ['*'] };
      assert.strictEqual(isModelAllowed('anything/anywhere', bare), true, 'bare * matches everything');

      const mid = { mode: 'allow' as const, models: ['mock-*-plus'] };
      assert.strictEqual(isModelAllowed('mock-a-b-plus', mid), true);
      assert.strictEqual(isModelAllowed('mock-plus', mid), false);
    });

    it('isModelAllowed: tier-alias entries expand tier-wide (deny plus ⇒ all plus models)', () => {
      const denyPlus = { mode: 'deny' as const, models: ['plus'] };
      assert.strictEqual(isModelAllowed('mock-plus', denyPlus, 'plus'), false, 'tier expansion blocks plus models');
      assert.strictEqual(isModelAllowed('mock-lite', denyPlus, 'lite'), true);
      assert.strictEqual(isModelAllowed('mock-plus', denyPlus), true, 'without tier hint the entry stays literal (back-compat)');

      const allowPlus = { mode: 'allow' as const, models: ['plus'] };
      assert.strictEqual(isModelAllowed('mock-plus', allowPlus, 'plus'), true, 'allow plus admits plus tier');
      assert.strictEqual(isModelAllowed('mock-lite', allowPlus, 'lite'), false);

      // bare `auto` has no tier meaning — literal (non-)match only
      const denyBare = { mode: 'deny' as const, models: ['auto'] };
      assert.strictEqual(isModelAllowed('mock-plus', denyBare, 'plus'), true);
    });

    it('checkRequestedModel: explicit tier-alias request denied when its tier entry is listed', () => {
      const denyUltra = { mode: 'deny' as const, models: ['ultra'] };
      assert.deepStrictEqual(checkRequestedModel('ultra', denyUltra, () => []), { ok: false, denied: ['ultra'] });
      assert.deepStrictEqual(checkRequestedModel('pro', denyUltra, () => []), { ok: true });
      assert.deepStrictEqual(checkRequestedModel('ultra', { mode: 'allow', models: ['ultra'] }, () => []), { ok: true });
    });

    it('checkRequestedModel: auto* passthrough, explicit verdicts, variant→base, combo all-members', () => {
      const allow = { mode: 'allow' as const, models: ['base', 'member-a'] };
      const deny = { mode: 'deny' as const, models: ['evil'] };

      // Deny mode: unlisted virtual entries pass (pool filter is the backstop)
      const denyNothing = { mode: 'deny' as const, models: ['evil'] };
      for (const m of ['auto', 'lite', 'plus', 'pro', 'ultra']) {
        assert.deepStrictEqual(checkRequestedModel(m, denyNothing, () => []), { ok: true });
      }
      // Allow mode: virtual entries must be NAMED by the whitelist
      assert.deepStrictEqual(checkRequestedModel('auto', allow, () => []), { ok: false, denied: ['auto'] });
      assert.deepStrictEqual(checkRequestedModel('lite', allow, () => []), { ok: false, denied: ['lite'] });
      assert.deepStrictEqual(
        checkRequestedModel('auto', { mode: 'allow', models: ['auto', 'base'] }, () => []),
        { ok: true },
        'explicitly listed auto is usable'
      );
      assert.deepStrictEqual(
        checkRequestedModel('plus', { mode: 'allow', models: ['plus', 'ultra'] }, () => []),
        { ok: true },
        'explicitly listed tier alias is usable'
      );

      // Explicit ids
      assert.deepStrictEqual(checkRequestedModel('base', allow, () => []), { ok: true });
      assert.deepStrictEqual(checkRequestedModel('other', allow, () => []), { ok: false, denied: ['other'] });
      assert.deepStrictEqual(checkRequestedModel('evil', deny, () => []), { ok: false, denied: ['evil'] });
      assert.deepStrictEqual(checkRequestedModel('fine', deny, () => []), { ok: true });

      // Variant syntax resolves to the base physical id (tier-aware)
      assert.deepStrictEqual(
        checkRequestedModel('base#high', allow, () => [], (id) => (id === 'base#high' ? { id: 'base', tier: 'plus' } : undefined)),
        { ok: true }
      );

      // Combo: allowed only when EVERY member passes (tier-aware)
      const members = () => [
        { id: 'member-a', tier: 'plus' },
        { id: 'member-b', tier: 'lite' },
      ];
      assert.deepStrictEqual(checkRequestedModel('my-combo', allow, members), { ok: false, denied: ['member-b'] });
      assert.deepStrictEqual(
        checkRequestedModel('my-combo', { mode: 'allow', models: ['member-a', 'member-b'] }, members),
        { ok: true }
      );
      // tier expansion applies to combo members: deny plus blocks lite member
      assert.deepStrictEqual(
        checkRequestedModel('my-combo', { mode: 'deny', models: ['lite'] }, members),
        { ok: false, denied: ['member-b'] },
        'deny plus tier-denies the lite member'
      );

      // No policy → everything passes
      assert.deepStrictEqual(checkRequestedModel('anything', undefined, () => ['x']), { ok: true });
    });

    it('makeModelAccessGuard: 403 shape via a fastify-like reply mock', () => {
      const guard = makeModelAccessGuard({
        getModel: (id) => (id === 'ok-model' ? { tier: 'plus' } : undefined),
        resolveCombo: () => [],
        resolveVariantRef: () => null,
      });
      const replies: any[] = [];
      const reply = { status: (code: number) => { replies.push(code); return { send: (b: any) => replies.push(b) }; } };
      const req = { authInfo: { keyConfig: { name: 'K', role: 'user', modelAccess: { mode: 'allow', models: ['ok-model'] } } } };
      assert.strictEqual(guard(req, reply, 'ok-model'), true);
      assert.strictEqual(replies.length, 0, 'allowed model → no reply sent');
      assert.strictEqual(guard(req, reply, 'nope'), false);
      assert.strictEqual(replies[0], 403);
      assert.strictEqual(replies[1].error.code, 'model_not_allowed');
    });

    it('validateModelAccess: shape checks, dedup, empty-allow rejection', () => {
      assert.deepStrictEqual(validateModelAccess(undefined), {});
      assert.ok(validateModelAccess('nope').error);
      assert.ok(validateModelAccess({ mode: 'x', models: ['a'] }).error);
      assert.ok(validateModelAccess({ mode: 'allow', models: 'a' }).error);
      assert.ok(validateModelAccess({ mode: 'allow', models: [] }).error, 'empty allow-list would lock the key out');
      const ok = validateModelAccess({ mode: 'deny', models: [' b ', 'a', 'b'] });
      assert.ok(!ok.error);
      assert.deepStrictEqual(ok.value, { mode: 'deny', models: ['b', 'a'] }, 'trimmed + deduped');
      // deny-with-empty-list is permissive-by-design (denies nothing) — accepted
      const denyEmpty = validateModelAccess({ mode: 'deny', models: [] });
      assert.ok(!denyEmpty.error);
      assert.deepStrictEqual(denyEmpty.value, { mode: 'deny', models: [] });
      // wildcard entries accepted; unsafe chars rejected
      const wildcard = validateModelAccess({ mode: 'allow', models: ['zhipu/*', 'mock-*'] });
      assert.ok(!wildcard.error);
      assert.deepStrictEqual(wildcard.value, { mode: 'allow', models: ['zhipu/*', 'mock-*'] });
      for (const bad of ['a b', 'a;b', 'a|b', 'a$b', '(x)']) {
        assert.ok(validateModelAccess({ mode: 'deny', models: [bad] }).error, `entry '${bad}' must be rejected`);
      }
    });
  });

  describe('HTTP integration (mockMode)', () => {
    // With models: [] the mockMode registry seeds deterministic tier models
    // (mock-lite / mock-plus / mock-pro / mock-ultra) — machine-independent ids.
    const ALLOWED = 'mock-lite';
    const DENIED = 'mock-ultra';

    const buildConfig = (): RouterConfig => ({
      ...loadConfig(),
      host: '127.0.0.1', // loopback: webAuth forced gate stays off (console endpoints stay anonymous)
      webAuth: { enabled: false }, // tests read the operator's live config.yaml via loadConfig() — never inherit its login gate
      models: [],
      adminApiKey: 'ma-master-key',
      apiKeys: [
        {
          id: 'key-allow',
          name: 'Allow-listed client',
          key: 'sk-ocr-test-allow',
            enabled: true,
          createdAt: new Date().toISOString(),
          modelAccess: { mode: 'allow', models: [ALLOWED] },
        },
        {
          id: 'key-deny',
          name: 'Deny-listed client',
          key: 'sk-ocr-test-deny',
            enabled: true,
          createdAt: new Date().toISOString(),
          modelAccess: { mode: 'deny', models: [DENIED] },
        },
        {
          id: 'key-pattern',
          name: 'Pattern allow client',
          key: 'sk-ocr-test-pattern',
            enabled: true,
          createdAt: new Date().toISOString(),
          modelAccess: { mode: 'allow', models: ['mock-p*'] },
        },
      ],
    });

    const { app } = createServer(buildConfig(), true);

    it('GET /v1/models with allow-listed key returns ONLY the allowed model (virtual auto gated too)', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer sk-ocr-test-allow' } });
      assert.strictEqual(res.statusCode, 200);
      const ids: string[] = JSON.parse(res.body).data.map((m: any) => m.id);
      assert.ok(ids.includes(ALLOWED), 'allowed model visible');
      assert.ok(!ids.includes('mock-plus'), 'other physical models hidden');
      assert.ok(!ids.includes('auto'), 'unlisted virtual auto is NOT part of the whitelist view');
      const entry = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer sk-ocr-test-allow' },
        payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(entry.statusCode, 403, 'unlisted auto rejected at entry in allow mode');
    });

    it('allow mode listing auto explicitly re-enables the virtual entry', async () => {
      const cfg: RouterConfig = {
        ...buildConfig(),
        apiKeys: [
          {
            id: 'key-allow-auto',
            name: 'Allow with auto',
            key: 'sk-ocr-test-allow-auto',
                enabled: true,
            createdAt: new Date().toISOString(),
            // Every tier whitelisted + auto: whichever tier the classifier
            // lands in, the pool has an allowed model → deterministic 200.
            modelAccess: { mode: 'allow', models: ['auto', 'mock-lite', 'mock-plus', 'mock-pro', 'mock-ultra'] },
          },
        ],
      };
      const { app: app2 } = createServer(cfg, true);
      const list = await app2.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer sk-ocr-test-allow-auto' } });
      const ids: string[] = JSON.parse(list.body).data.map((m: any) => m.id);
      assert.ok(ids.includes('auto'), 'listed auto visible');
      const served = await app2.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer sk-ocr-test-allow-auto' },
        payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(served.statusCode, 200, 'auto routes within the whitelist');
    });

    it('allow mode auto widens across tiers when the classifier tier holds no allowed model', async () => {
      const cfg: RouterConfig = {
        ...buildConfig(),
        apiKeys: [
          {
            id: 'key-allow-plus-only',
            name: 'Allow auto + plus only',
            key: 'sk-ocr-test-allow-plus-only',
                enabled: true,
            createdAt: new Date().toISOString(),
            modelAccess: { mode: 'allow', models: ['auto', 'mock-plus'] },
          },
        ],
      };
      const { app: app2 } = createServer(cfg, true);
      // Whatever tier the classifier picks for "hi" (lite or plus), the
      // widened pool must serve the whitelisted mock-plus → deterministic 200.
      const served = await app2.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer sk-ocr-test-allow-plus-only' },
        payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(served.statusCode, 200, 'bare auto widens to the whitelisted tier');
      assert.strictEqual(JSON.parse(served.body).model, 'mock-plus');
    });

    it('allow mode listing ONLY auto yields a deterministic policy 403 (no physical model admitted)', async () => {
      const cfg: RouterConfig = {
        ...buildConfig(),
        apiKeys: [
          {
            id: 'key-allow-auto-only',
            name: 'Allow auto only',
            key: 'sk-ocr-test-allow-auto-only',
                enabled: true,
            createdAt: new Date().toISOString(),
            modelAccess: { mode: 'allow', models: ['auto'] },
          },
        ],
      };
      const { app: app2 } = createServer(cfg, true);
      const served = await app2.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer sk-ocr-test-allow-auto-only' },
        payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(served.statusCode, 403, 'entry passes but the pool is empty — policy 403');
    });

    it('GET /v1/models anonymous keeps the legacy FULL listing (any source)', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/models' });
      assert.strictEqual(res.statusCode, 200);
      const ids: string[] = JSON.parse(res.body).data.map((m: any) => m.id);
      assert.ok(ids.includes('mock-plus') && ids.includes(ALLOWED), 'anonymous sees everything');
      // Non-loopback source is equally tolerated — no source restriction.
      const remote = await app.inject({
        method: 'GET',
        url: '/v1/models',
        remoteAddress: '10.0.0.99',
      });
      assert.strictEqual(remote.statusCode, 200);
      const remoteIds: string[] = JSON.parse(remote.body).data.map((m: any) => m.id);
      assert.ok(remoteIds.includes(ALLOWED), 'remote anonymous also sees everything');
    });

    it('GET /api/admin/gateway-models serves the console picker with the FULL catalog', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/gateway-models' });
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.status, 'ok');
      const ids: string[] = body.models.map((m: any) => m.id);
      assert.ok(ids.includes('auto') && ids.includes('mock-plus'), 'console picker sees the full catalog');
      const mockPlus = body.models.find((m: any) => m.id === 'mock-plus');
      assert.ok(Array.isArray(mockPlus.tiers) && mockPlus.tiers.includes('plus'), 'membership set included for picker meta (no single fixed tier)');
    });

    it('GET /api/admin/api-keys/:id/models mirrors /v1/models: combo rows carry the all-members gate', async () => {
      // key-allow (allow-list: mock-lite only) comes from buildConfig(). The
      // console key view reads listApiKeys() → loadConfig() = the ON-DISK
      // default-env config, NOT the object handed to createServer, so the
      // fixture must be persisted first — and the shared sandbox file restored
      // byte-for-byte afterward (the isolated runner gives every test file the
      // same OCR_HOME; an unrestored write leaks into every later file).
      const cfg: RouterConfig = {
        ...buildConfig(),
        combos: [
          { id: 'ma-combo-ok', selection: 'priority', models: ['mock-lite'] },
          { id: 'ma-combo-partial', selection: 'priority', models: ['mock-lite', 'mock-ultra'] },
        ],
      };
      const configPath = getConfigPath();
      const diskBefore = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
      try {
        const saved = saveConfig(cfg);
        assert.ok(saved.success, `fixture save failed: ${saved.error}`);
        const { app: app2 } = createServer(cfg, true);
        const res = await app2.inject({ method: 'GET', url: '/api/admin/api-keys/key-allow/models' });
        assert.strictEqual(res.statusCode, 200);
        const rows: any[] = JSON.parse(res.body).models;
        const ok = rows.find((m) => m.id === 'ma-combo-ok');
        const partial = rows.find((m) => m.id === 'ma-combo-partial');
        assert.ok(ok && partial, 'combo rows surface in the key view');
        assert.strictEqual(ok.virtual, false, 'combos are selectable concrete entries, not auto* virtuals');
        assert.strictEqual(ok.allowed, true, 'every member allowed → combo allowed');
        assert.strictEqual(partial.allowed, false, 'one denied member blocks the whole combo (entry-gate parity)');
        // Registered rows keep their per-model verdicts alongside the new groups.
        assert.strictEqual(rows.find((m) => m.id === 'mock-lite').allowed, true);
        assert.strictEqual(rows.find((m) => m.id === 'mock-ultra').allowed, false);
        // Order mirrors /v1/models: virtual auto* precede combos and registered rows.
        assert.ok(rows[0].virtual === true, 'virtual auto* rows lead the view');
      } finally {
        // Restore (Windows can transiently EBUSY freshly-written files — retry
        // a few times; a failed restore must not fail the file, only warn).
        const wait = (ms: number) =>
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            if (diskBefore === null) fs.rmSync(configPath, { force: true });
            else fs.writeFileSync(configPath, diskBefore, 'utf8');
            break;
          } catch (err) {
            if (attempt === 4) console.warn('model-access fixture: config.yaml restore failed:', err);
            else wait(50);
          }
        }
      }
    });

    it('GET /v1/models with an INVALID key errors 401 instead of degrading to the full list', async () => {
      // listen+fetch loop on purpose: bun's light-my-request inject is
      // unreliable for preHandler-401 responses (minimal repro: ERR_HEADERS_SENT
      // on GET and POST alike); real HTTP handles it cleanly.
      const { app: authApp } = createServer(buildConfig(), true);
      await authApp.listen({ port: 0, host: '127.0.0.1' });
      try {
        const url = `http://127.0.0.1:${(authApp.server.address() as any).port}/v1/models`;
        for (const key of ['sk-ocr-wrong-key', 'garbage']) {
          const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
          assert.strictEqual(res.status, 401, `invalid key '${key}' must not see the catalog`);
          assert.strictEqual(((await res.json()) as any).error.code, 'invalid_api_key');
        }
        const lookup = await fetch(`${url}/${ALLOWED}`, { headers: { authorization: 'Bearer sk-ocr-wrong-key' } });
        assert.strictEqual(lookup.status, 401, 'single lookup requires a valid key too');
      } finally {
        await authApp.close();
      }
    });

    it('GET /v1/models with deny-listed key hides only the denied model', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer sk-ocr-test-deny' } });
      const ids: string[] = JSON.parse(res.body).data.map((m: any) => m.id);
      assert.ok(!ids.includes(DENIED));
      assert.ok(ids.includes('mock-plus'));
    });

    it('GET /v1/models/:model returns 404 (not 403) for models hidden from the key', async () => {
      const res = await app.inject({ method: 'GET', url: `/v1/models/${DENIED}`, headers: { authorization: 'Bearer sk-ocr-test-allow' } });
      assert.strictEqual(res.statusCode, 404, 'existence must not leak');
    });

    it('POST /v1/chat/completions: explicit denied model → 403 model_not_allowed', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer sk-ocr-test-allow' },
        payload: { model: 'mock-plus', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(res.statusCode, 403);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error.code, 'model_not_allowed');
    });

    it('POST /v1/chat/completions: allowed model passes the gate (mock execution)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer sk-ocr-test-allow' },
        payload: { model: ALLOWED, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(res.statusCode, 200);
    });

    it('admin/master key bypasses model policy', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer ma-master-key' } });
      const ids: string[] = JSON.parse(res.body).data.map((m: any) => m.id);
      assert.ok(ids.includes('mock-plus'), 'master key sees everything');
    });

    it('wildcard allow pattern mock-p* admits mock-plus/mock-pro, denies the rest', async () => {
      const list = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer sk-ocr-test-pattern' } });
      const ids: string[] = JSON.parse(list.body).data.map((m: any) => m.id);
      assert.ok(ids.includes('mock-plus') && ids.includes('mock-pro'), 'pattern-matched models visible');
      assert.ok(!ids.includes('mock-lite') && !ids.includes('mock-ultra'), 'non-matching models hidden');

      const denied = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer sk-ocr-test-pattern' },
        payload: { model: 'mock-lite', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(denied.statusCode, 403, 'pattern allow-list rejects non-matching model');

      const allowed = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer sk-ocr-test-pattern' },
        payload: { model: 'mock-plus', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(allowed.statusCode, 200, 'pattern-matched model executes');
    });

    // Runtime key sync (UI policy edit → wire without restart) is covered by
    // saveConfig's single sync point + live smoke verification — the HTTP
    // path can't be tested here because key CRUD persists to the REAL
    // config.yaml on this machine.

    it('GET /v1/models and :model hide a virtual auto* id whose tier is denied', async () => {
      const denyKeyConfig: RouterConfig = {
        ...buildConfig(),
        apiKeys: [
          {
            id: 'key-deny-tier',
            name: 'Tier deny client',
            key: 'sk-ocr-test-deny-tier',
                enabled: true,
            createdAt: new Date().toISOString(),
            modelAccess: { mode: 'deny', models: ['ultra'] },
          },
        ],
      };
      const { app: app2 } = createServer(denyKeyConfig, true);
      const list = await app2.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer sk-ocr-test-deny-tier' } });
      const ids: string[] = JSON.parse(list.body).data.map((m: any) => m.id);
      assert.ok(!ids.includes('ultra'), 'denied-tier virtual row hidden');
      assert.ok(ids.includes('plus'), 'other virtual tiers untouched');
      assert.ok(!ids.includes('mock-ultra'), 'tier expansion hides the ultra physical model too');

      const lookup = await app2.inject({ method: 'GET', url: '/v1/models/ultra', headers: { authorization: 'Bearer sk-ocr-test-deny-tier' } });
      assert.strictEqual(lookup.statusCode, 404, 'denied virtual id 404s on lookup');

      const entry = await app2.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer sk-ocr-test-deny-tier' },
        payload: { model: 'ultra', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(entry.statusCode, 403, 'explicit ultra request rejected at entry');

      const served = await app2.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer sk-ocr-test-deny-tier' },
        payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(served.statusCode, 200);
      assert.notStrictEqual(served.headers['x-ocr-model'], 'mock-ultra', 'auto routing must never serve the denied tier');
    });
  });
});

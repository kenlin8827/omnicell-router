import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildConfigEntry,
  buildEffectivePlan,
  clampTtl,
  probePair,
  runDslProbe,
  sanitizeProbePath,
} from '../src/quota/engine.js';
import { MINIMAX_ADAPTER } from '../src/quota/adapters/minimax.js';
import { QuotaProber, type QuotaRegistryView } from '../src/quota/prober.js';
import { QuotaSnapshotStore, setQuotaStoreForTests } from '../src/quota/store.js';
import { QuotaEventLog, setQuotaEventLogForTests } from '../src/quota/events.js';
import { CircuitBreakerManager } from '../src/resilience/circuit-breaker-manager.js';
import { CredentialStateStore } from '../src/resilience/credential-state.js';
import { ErrorClassifier } from '../src/resilience/error-classifier.js';
import { TraceTracker } from '../src/trace/tracker.js';
import type { RouterConfig } from '../src/config/types.js';
import type { CredentialPaths } from '../src/opencode/credentials/paths.js';
import type { QuotaProbeConfigEntry } from '../src/quota/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function sandboxPaths(tag: string): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ocr-${tag}-`));
  return {
    configDir: path.join(dir, 'config', 'opencode'),
    dataDir: path.join(dir, 'data', 'opencode'),
    authJsonPath: path.join(dir, 'data', 'opencode', 'auth.json'),
    opencodeDbPath: path.join(dir, 'data', 'opencode', 'opencode.db'),
    installedVersionPath: path.join(dir, 'config', 'opencode', 'installed.version'),
    ocrHome: path.join(dir, 'ocr-home'),
    serviceJsonCandidates: [path.join(dir, 'config', 'opencode', 'service.json')],
  } as CredentialPaths;
}

const fetchStub = (handler: (url: string, init: any) => { status: number; body?: unknown; headers?: Record<string, string> }): typeof fetch =>
  (async (url: any, init: any) => {
    const res = handler(String(url), init);
    return new Response(res.body === undefined ? '' : JSON.stringify(res.body), {
      status: res.status,
      headers: res.headers,
    });
  }) as typeof fetch;

const baseCfg = (over: Partial<RouterConfig> = {}): RouterConfig => ({ quota: {}, ...over } as unknown as RouterConfig);

// ─── Iron rules (L-d only) ──────────────────────────────────────────────────

describe('quota iron rules (config layer)', () => {
  const origin = 'https://gateway.example.com/v1';

  it('sanitizeProbePath: containment + rejects', () => {
    assert.equal(sanitizeProbePath('/billing/credits', origin), 'https://gateway.example.com/billing/credits');
    assert.equal(sanitizeProbePath('../etc', origin), null);
    assert.equal(sanitizeProbePath('//evil.com/x', origin), null);
    assert.equal(sanitizeProbePath('/a@b', origin), null);
    assert.equal(sanitizeProbePath('https://other.com/x', origin), null);
    // Resolution is origin-pinned by construction (relUrl path-joined onto the
    // provider base); an escape attempt that survives the string checks is
    // caught by the post-resolution origin comparison.
    assert.equal(sanitizeProbePath('/x', 'https://api.example.com/v1'), 'https://api.example.com/x');
    assert.equal(sanitizeProbePath('/x', undefined), null); // no origin anchor
  });

  it('covered provider REQUIRES the explicit override field (rule 4d)', () => {
    const raw: QuotaProbeConfigEntry = { url: '/x', windows: { form: 'static', windows: [{ name: 'W', used: { path: 'u' } }] } };
    const silent = buildConfigEntry('deepseek', 0, raw, 'https://api.deepseek.com', ['deepseek']);
    assert.match(silent.error ?? '', /override/);
    const named = buildConfigEntry('deepseek', 0, { ...raw, override: 'deepseek' }, 'https://api.deepseek.com', ['deepseek']);
    assert.ok(named.entry);
    assert.equal(named.entry!.auth, 'bearer'); // inference reuse forced (rule 4b)
    assert.equal(named.entry!.builtin, false);
    assert.match(named.entry!.id, /^override:deepseek$/);
    assert.equal(named.entry!.forkedFrom, 'builtin:deepseek'); // lineage default
  });

  it('override must name a real built-in; unknown keys / method / absolute auth rejected', () => {
    const raw: QuotaProbeConfigEntry = { url: '/x', windows: { form: 'static', windows: [{ name: 'W', used: { path: 'u' } }] } };
    assert.match(buildConfigEntry('deepseek', 0, { ...raw, override: 'nope' }, 'https://api.deepseek.com', ['deepseek']).error ?? '', /matches no built-in/);
    assert.match(buildConfigEntry('mygw', 0, { ...raw, method: 'POST' } as any, origin, []).error ?? '', /unknown key/);
  });

  it('cacheTtl clamps to [60s, 24h]', () => {
    assert.equal(clampTtl(1), QUOTA_TTL_FLOOR);
    assert.equal(clampTtl(999 * 3_600_000), QUOTA_TTL_CEIL);
    assert.equal(clampTtl(undefined), 15 * 60_000);
  });
});
const QUOTA_TTL_FLOOR = 60_000;
const QUOTA_TTL_CEIL = 24 * 3_600_000;

// ─── Effective plan merge ───────────────────────────────────────────────────

describe('quota effective plan', () => {
  it('release coverage lists every built-in entry (and only built-ins pass validation)', () => {
    const plan = buildEffectivePlan(undefined, () => undefined);
    const ids = new Set(plan.byProvider.keys());
    assert.ok(ids.has('deepseek'), 'deepseek covered');
    assert.ok(ids.has('kimi-code-plan-cn'), 'kimi code plan cn covered');
    assert.ok(!ids.has('maisuitx'), 'long-tail providers are NOT covered out of the box');
    assert.ok(!ids.has('qoder'), 'qoder is not in the OCR catalog — must never be covered');
    assert.equal(plan.rejected.length, 0, 'the built-in table must validate clean');
  });

  it('adapters own their ids absolutely; DSL table covers the rest', () => {
    const plan = buildEffectivePlan(undefined, () => undefined);
    assert.equal(plan.byProvider.get('minimax')?.kind, 'adapter');
    assert.equal(plan.byProvider.get('minimax-cn-coding-plan')?.kind, 'adapter');
    assert.equal(plan.byProvider.get('deepseek')?.kind, 'dsl');
    assert.ok(plan.byProvider.size >= 9, `release coverage present (got ${plan.byProvider.size})`);
  });

  it('config cannot override an adapter-covered provider (v1); it replaces DSL entries only via override', () => {
    const plan = buildEffectivePlan(
      {
        minimax: [{ url: '/x', windows: { form: 'static', windows: [{ name: 'W', used: { path: 'u' } }] } }],
        openrouter: [{ url: '/credits', override: 'openrouter', windows: { form: 'static', windows: [{ name: 'W', used: { path: 'u' } }] } }],
      } as Record<string, QuotaProbeConfigEntry[]>,
      (pid) => (pid === 'openrouter' ? 'https://openrouter.ai/api/v1' : undefined)
    );
    assert.equal(plan.byProvider.get('minimax')?.kind, 'adapter', 'config entry dropped, adapter stays');
    assert.ok(plan.rejected.some((r) => r.id === 'minimax'));
    const or = plan.byProvider.get('openrouter');
    assert.equal(or?.kind, 'dsl');
    assert.equal(or?.kind === 'dsl' ? or.entry.id : '', 'override:openrouter');
    assert.equal(or?.kind === 'dsl' ? or.entry.url : '', 'https://openrouter.ai/credits');
  });

  it('a long-tail provider gets a config entry with no built-in at all', () => {
    const plan = buildEffectivePlan(
      { 'maisuitx': [{ url: '/api/usage', windows: { form: 'static', windows: [{ name: 'Credits', remaining: { path: 'left' }, total: { path: 'cap' } }] } }] } as Record<string, QuotaProbeConfigEntry[]>,
      () => 'http://192.168.18.10:20180/v1'
    );
    const t = plan.byProvider.get('maisuitx');
    assert.equal(t?.kind, 'dsl');
    assert.equal(t?.kind === 'dsl' ? t.entry.url : '', 'http://192.168.18.10:20180/api/usage');
  });
});

// ─── Probe execution ────────────────────────────────────────────────────────

describe('quota probe execution', () => {
  it('runDslProbe: bearer auth, successIf, windows, header + 429 split', async () => {
    const plan = buildEffectivePlan(undefined, () => undefined);
    const entry = (plan.byProvider.get('openrouter') as any).entry;
    let seenAuth = '';
    const f = (async (url: any, init: any) => {
      seenAuth = init.headers.Authorization;
      return new Response(JSON.stringify({ usage: 3, limit: 10, limit_remaining: 7 }), { status: 200 });
    }) as typeof fetch;
    const r = await runDslProbe(entry, { key: 'sk-or-test', providerId: 'openrouter', prefix: 'p', fetchImpl: f });
    assert.equal(seenAuth, 'Bearer sk-or-test');
    assert.equal(r.outcome.ok, true);
    assert.equal(r.rateLimited, false);

    const f429 = fetchStub(() => ({ status: 429 }));
    const r429 = await runDslProbe(entry, { key: 'k', providerId: 'openrouter', prefix: 'p', fetchImpl: f429 });
    assert.equal(r429.rateLimited, true);
    assert.equal(r429.outcome.ok, false);

    const f401 = fetchStub(() => ({ status: 401 }));
    const r401 = await runDslProbe(entry, { key: 'k', providerId: 'openrouter', prefix: 'p', fetchImpl: f401 });
    assert.equal(r401.outcome.ok, false);
    assert.equal(r401.outcome.ok ? '' : r401.outcome.reason, 'auth');
  });

  it('probePair lands a snapshot on success and marks staleness (keeps values) on failure', async () => {
    const tmp = sandboxPaths('quota-engine');
    const store = new QuotaSnapshotStore({ paths: tmp, now: () => 1000 });
    setQuotaStoreForTests(store);
    try {
      const plan = buildEffectivePlan(undefined, () => undefined);
      const target = plan.byProvider.get('deepseek')!;
      const ok = await probePair(target, {
        providerId: 'deepseek',
        key: 'sk-test',
        prefix: 'K1',
        fetchImpl: fetchStub(() => ({ status: 200, body: { balance_infos: [{ currency: 'CNY', total_balance: '5' }] } })),
      });
      assert.equal(ok.outcome.ok, true);
      assert.equal(store.get('deepseek', 'K1')?.windows[0].name, 'Balance (CNY)');

      const bad = await probePair(target, {
        providerId: 'deepseek',
        key: 'sk-test',
        prefix: 'K1',
        fetchImpl: fetchStub(() => ({ status: 500 })),
      });
      assert.equal(bad.outcome.ok, false);
      const snap = store.get('deepseek', 'K1')!;
      assert.equal(snap.windows.length, 1, 'failure keeps the old snapshot');
      assert.ok(snap.lastFailureAt !== undefined, 'failure stamps staleness');
    } finally {
      setQuotaStoreForTests(undefined);
      fs.rmSync(path.dirname(tmp.ocrHome), { recursive: true, force: true });
    }
  });

  it('probePair records the raw http exchange on success and on every failure class (memory-only)', async () => {
    const tmp = sandboxPaths('quota-http');
    const store = new QuotaSnapshotStore({ paths: tmp, now: () => 1000 });
    setQuotaStoreForTests(store);
    try {
      const target = buildEffectivePlan(undefined, () => undefined).byProvider.get('deepseek')!;
      const balanceBody = { balance_infos: [{ currency: 'CNY', total_balance: '5' }] };

      const ok = await probePair(target, {
        providerId: 'deepseek',
        key: 'sk-test',
        prefix: 'KH',
        fetchImpl: fetchStub(() => ({ status: 200, body: balanceBody })),
      });
      assert.equal(ok.outcome.ok, true);
      const http = store.getLastHttp('deepseek#KH')!;
      assert.ok(http, 'success records the raw exchange');
      assert.equal(http.ok, true);
      assert.equal(http.status, 200);
      assert.match(http.url, /\/user\/balance$/);
      assert.deepEqual(http.body, balanceBody);
      assert.ok(typeof http.durationMs === 'number' && http.durationMs >= 0, 'exchange carries a duration');

      await probePair(target, { providerId: 'deepseek', key: 'sk-test', prefix: 'KH', fetchImpl: fetchStub(() => ({ status: 500 })) });
      const bad = store.getLastHttp('deepseek#KH')!;
      assert.equal(bad.ok, false, 'a failing attempt replaces the capture');
      assert.equal(bad.status, 500);
      assert.equal(bad.error, undefined, 'an HTTP 500 IS a response — not a transport failure');

      await probePair(target, {
        providerId: 'deepseek',
        key: 'sk-test',
        prefix: 'KH',
        fetchImpl: (async () => {
          throw new Error('connection reset');
        }) as typeof fetch,
      });
      const net = store.getLastHttp('deepseek#KH')!;
      assert.equal(net.ok, false);
      assert.equal(net.error, 'network');
      assert.equal(net.status, undefined, 'no response existed at all');

      // Capture churn never touches the snapshot: the first success survives.
      assert.equal(store.get('deepseek', 'KH')?.windows[0].name, 'Balance (CNY)');
    } finally {
      setQuotaStoreForTests(undefined);
      fs.rmSync(path.dirname(tmp.ocrHome), { recursive: true, force: true });
    }
  });
});

// ─── MiniMax code adapter (L-c) ─────────────────────────────────────────────

describe('minimax quota adapter', () => {
  const tokenPlanBody = {
    base_resp: { status_code: 0, status_msg: 'ok' },
    model_remains: [
      {
        model_name: 'MiniMax-M2',
        current_interval_total_count: 100,
        current_interval_usage_count: 30,
        current_weekly_total_count: 500,
        current_weekly_usage_count: 100,
        remains_time: 60_000,
      },
    ],
  };

  it('token_plan semantics: counts are USED', async () => {
    const urls: string[] = [];
    const r = await MINIMAX_ADAPTER.probe({
      providerId: 'minimax',
      key: 'k',
      now: () => 1_000_000,
      fetchImpl: (async (u: any) => {
        urls.push(String(u));
        return new Response(JSON.stringify(tokenPlanBody), { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(r.ok, true);
    assert.equal(urls.length, 1, 'first URL succeeded, no fallback');
    const w = (r as any).windows;
    assert.equal(w.find((x: any) => x.name === 'MiniMax M2 (5h)').used, 30);
    assert.equal(w.find((x: any) => x.name === 'MiniMax M2 (5h)').total, 100);
    assert.equal(w.find((x: any) => x.name === 'MiniMax M2 (5h)').resetAt, 1_060_000, 'remains_time is RELATIVE to probe time');
  });

  it('coding_plan semantics: counts are REMAINING (the inverted mapping)', async () => {
    const r = await MINIMAX_ADAPTER.probe({
      providerId: 'minimax-cn',
      key: 'k',
      now: () => 1_000_000,
      fetchImpl: fetchStub(() => ({
        status: 200,
        body: {
          base_resp: { status_code: 0 },
          model_remains: [
            { modelName: 'MiniMax-M*', currentIntervalTotalCount: 40, currentIntervalUsageCount: 10 },
          ],
        },
      })),
    });
    assert.equal(r.ok, true);
    const w = (r as any).windows.find((x: any) => x.name === 'M-series (5h)');
    // coding_plan counts mean REMAINING: 10 left of 40 => used 30.
    assert.equal(w.used, 30);
    assert.equal(w.total, 40);
  });

  it('percent-only M-series bucket synthesizes on a 100 scale', async () => {
    const r = await MINIMAX_ADAPTER.probe({
      providerId: 'minimax',
      key: 'k',
      fetchImpl: fetchStub(() => ({
        status: 200,
        body: {
          base_resp: { status_code: 0 },
          model_remains: [{ model_name: 'MiniMax-M*', current_interval_remaining_percent: 62.5 }],
        },
      })),
    });
    assert.equal(r.ok, true);
    const w = (r as any).windows[0];
    assert.equal(w.total, 100);
    assert.equal(w.used, 37.5);
  });

  it('multi-URL fallback on 404; auth verdict does NOT fall back', async () => {
    const urls: string[] = [];
    let n = 0;
    const r = await MINIMAX_ADAPTER.probe({
      providerId: 'minimax',
      key: 'k',
      fetchImpl: (async (u: any) => {
        urls.push(String(u));
        n++;
        if (n === 1) return new Response('nope', { status: 404 });
        return new Response(JSON.stringify(tokenPlanBody), { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(r.ok, true);
    assert.equal(urls.length, 2, 'fell back to the second URL');

    const r401 = await MINIMAX_ADAPTER.probe({
      providerId: 'minimax',
      key: 'k',
      fetchImpl: fetchStub(() => ({ status: 401 })),
    });
    assert.equal(r401.ok, false);
    assert.equal((r401 as any).reason, 'auth');
  });

  it('envelope error (base_resp.status_code != 0) is a failure at HTTP 200', async () => {
    const r = await MINIMAX_ADAPTER.probe({
      providerId: 'minimax',
      key: 'k',
      fetchImpl: fetchStub(() => ({ status: 200, body: { base_resp: { status_code: 1002, status_msg: 'rate limited' } } })),
    });
    assert.equal(r.ok, false);
  });
});

// ─── Prober: activation follows credentials ─────────────────────────────────

function fakeRegistry(chains: Record<string, { keyHashPrefix: string; key: string }[]>): QuotaRegistryView {
  return {
    getCredentialChain: (pid) => chains[pid],
    getProviderApiKey: () => undefined,
    getProviderBaseUrl: () => undefined,
  };
}

describe('quota prober scheduling', () => {
  it('a covered provider with a credential is scheduled immediately; no credential = no probe', async () => {
    const tmp = sandboxPaths('quota-prober');
    const store = new QuotaSnapshotStore({ paths: tmp, now: () => Date.now() });
    setQuotaStoreForTests(store);
    try {
      let calls = 0;
      const prober = new QuotaProber({
        registry: fakeRegistry({ deepseek: [{ keyHashPrefix: 'K1', key: 'sk-1' }] }),
        config: () => baseCfg(),
        fetchImpl: (async () => {
          calls++;
          return new Response(JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '1' }] }), { status: 200 });
        }) as typeof fetch,
      });
      const due = prober.planProbes(1000);
      assert.deepEqual(due.map((p) => `${p.providerId}#${p.keyHashPrefix}`), ['deepseek#K1']);
      // Uncovered providers never appear:
      assert.ok(!due.some((p) => p.providerId === 'openrouter'));
      await prober.tick(2000);
      assert.equal(calls, 1);
      assert.ok(store.get('deepseek', 'K1'));
      // Second tick: not due again (TTL armed).
      const again = prober.planProbes(2100);
      assert.equal(again.length, 0);
    } finally {
      setQuotaStoreForTests(undefined);
      fs.rmSync(path.dirname(tmp.ocrHome), { recursive: true, force: true });
    }
  });

  it('a 429 arms the ENGINE-LEVEL global backoff gate (not a per-entry field)', async () => {
    const tmp = sandboxPaths('quota-429');
    setQuotaStoreForTests(new QuotaSnapshotStore({ paths: tmp }));
    try {
      let calls = 0;
      const prober = new QuotaProber({
        registry: fakeRegistry({ deepseek: [{ keyHashPrefix: 'K1', key: 'sk-1' }] }),
        config: () => baseCfg(),
        fetchImpl: (async () => {
          calls++;
          return new Response('', { status: 429 });
        }) as typeof fetch,
        now: () => 10_000,
      });
      await prober.tick(10_000);
      assert.equal(calls, 1);
      assert.ok(prober.getRateLimitedUntil() > 10_000, 'global gate armed');
      assert.equal(prober.planProbes(11_000).length, 0, 'gate pauses the whole scheduler');
    } finally {
      setQuotaStoreForTests(undefined);
      fs.rmSync(path.dirname(tmp.ocrHome), { recursive: true, force: true });
    }
  });

  it('a 429 on the ADAPTER path also arms the engine-level global gate', async () => {
    const tmp = sandboxPaths('quota-429-adapter');
    setQuotaStoreForTests(new QuotaSnapshotStore({ paths: tmp }));
    try {
      let calls = 0;
      const prober = new QuotaProber({
        registry: fakeRegistry({ minimax: [{ keyHashPrefix: 'K1', key: 'sk-1' }] }),
        config: () => baseCfg(),
        fetchImpl: (async () => {
          calls++;
          return new Response('', { status: 429 });
        }) as typeof fetch,
        now: () => 10_000,
      });
      await prober.tick(10_000);
      assert.equal(calls, 1);
      assert.ok(prober.getRateLimitedUntil() > 10_000, 'global gate armed from adapter 429');
      assert.equal(prober.planProbes(11_000).length, 0, 'gate pauses the whole scheduler');
    } finally {
      setQuotaStoreForTests(undefined);
      fs.rmSync(path.dirname(tmp.ocrHome), { recursive: true, force: true });
    }
  });

  it('quota.enabled:false is honored live — the kill switch needs no restart', async () => {
    const tmp = sandboxPaths('quota-killswitch');
    setQuotaStoreForTests(new QuotaSnapshotStore({ paths: tmp }));
    try {
      let calls = 0;
      const cfg = baseCfg();
      const prober = new QuotaProber({
        registry: fakeRegistry({ deepseek: [{ keyHashPrefix: 'K1', key: 'sk-1' }] }),
        config: () => cfg,
        fetchImpl: (async () => {
          calls++;
          return new Response('{}', { status: 200 });
        }) as typeof fetch,
      });
      // Saved off (boot default enabled) — probing schedules normally.
      assert.equal(prober.planProbes(1000).length, 1);
      // Config save flips the switch: planning and ticking stop immediately.
      cfg.quota = { ...cfg.quota, enabled: false };
      assert.equal(prober.planProbes(1000).length, 0, 'disabled engine plans nothing');
      await prober.tick(1000);
      assert.equal(calls, 0, 'disabled engine makes no outbound calls');
      // And back on: resumes without a restart.
      cfg.quota = { ...cfg.quota, enabled: true };
      assert.equal(prober.planProbes(1000).length, 1, 're-enabled engine schedules again');
    } finally {
      setQuotaStoreForTests(undefined);
      fs.rmSync(path.dirname(tmp.ocrHome), { recursive: true, force: true });
    }
  });

  it('reloadConfig rebuilds the plan (save-path hot-sync target of syncRuntimeAuthView)', () => {
    const tmp = sandboxPaths('quota-reload');
    setQuotaStoreForTests(new QuotaSnapshotStore({ paths: tmp }));
    try {
      const cfg = baseCfg();
      const prober = new QuotaProber({
        registry: fakeRegistry({}),
        config: () => cfg,
      });
      assert.ok(prober.getPlan().byProvider.get('maisuitx') === undefined);
      (cfg as any).quotaProbes = {
        maisuitx: [{ url: '/api/usage', windows: { form: 'static', windows: [{ name: 'W', used: { path: 'u' } }] } }],
      };
      (cfg as any).providers = [{ name: 'maisuitx', baseUrl: 'http://192.168.18.10:20180/v1' }];
      // buildEffectivePlan resolves the origin through the registry view;
      // a bare registry (no providerConfigs) refuses the entry — correct.
      prober.reloadConfig();
      assert.ok(prober.getPlan().rejected.some((r) => r.id.startsWith('maisuitx')), 'no inference origin -> rejected loudly');
    } finally {
      setQuotaStoreForTests(undefined);
      fs.rmSync(path.dirname(tmp.ocrHome), { recursive: true, force: true });
    }
  });

  // ─── Manual refresh: bounded probe INSIDE the request ────────────────────

  const okFetch = (onCall: () => void): typeof fetch =>
    (async () => {
      onCall();
      return new Response(JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '1' }] }), { status: 200 });
    }) as typeof fetch;

  it('refreshNow probes inside the request and lands the snapshot before it resolves', async () => {
    const tmp = sandboxPaths('quota-refresh-now');
    const store = new QuotaSnapshotStore({ paths: tmp });
    setQuotaStoreForTests(store);
    try {
      let calls = 0;
      const prober = new QuotaProber({
        registry: fakeRegistry({ deepseek: [{ keyHashPrefix: 'K1', key: 'sk-1' }] }),
        config: () => baseCfg(),
        fetchImpl: okFetch(() => calls++),
        now: () => 10_000,
      });
      const report = await prober.refreshNow();
      assert.deepEqual(report, { probed: 1, pending: 0, rateLimited: false, disabled: false, busy: false });
      assert.equal(calls, 1);
      assert.ok(store.get('deepseek', 'K1'), 'snapshot already landed when the request answered');
      // The cycle armed the due date exactly like a tick — no double probe.
      assert.equal(prober.planProbes(10_100).length, 0);
      // The user's worst case: manual refresh, then the tick fires one second
      // later. It plans ZERO candidates — no outbound request, no rate limit.
      assert.equal((await prober.tick(10_001)).probed, 0, 'the tick right after a manual cycle probes nothing');
      assert.equal(calls, 1);
    } finally {
      setQuotaStoreForTests(undefined);
      fs.rmSync(path.dirname(tmp.ocrHome), { recursive: true, force: true });
    }
  });

  it('refreshNow is uncapped (the per-tick cap only bounds ticks)', async () => {
    const tmp = sandboxPaths('quota-refresh-uncapped');
    setQuotaStoreForTests(new QuotaSnapshotStore({ paths: tmp }));
    try {
      const chains = Array.from({ length: 7 }, (_, i) => ({ keyHashPrefix: `K${i}`, key: `sk-${i}` }));
      let calls = 0;
      const prober = new QuotaProber({
        registry: fakeRegistry({ deepseek: chains }),
        config: () => baseCfg(),
        fetchImpl: okFetch(() => calls++),
        now: () => 10_000,
      });
      assert.equal((await prober.tick(10_000)).probed, 6, 'tick honors MAX_PER_TICK');
      const report = await prober.refreshNow();
      assert.equal(report.probed, 7, 'manual refresh probes every covered pair');
      assert.equal(calls, 13);
    } finally {
      setQuotaStoreForTests(undefined);
      fs.rmSync(path.dirname(tmp.ocrHome), { recursive: true, force: true });
    }
  });

  it('refreshNow narrows to ONE pair when an identity is given', async () => {
    const tmp = sandboxPaths('quota-refresh-pair');
    setQuotaStoreForTests(new QuotaSnapshotStore({ paths: tmp }));
    try {
      let calls = 0;
      const prober = new QuotaProber({
        registry: fakeRegistry({
          deepseek: [
            { keyHashPrefix: 'K1', key: 'sk-1' },
            { keyHashPrefix: 'K2', key: 'sk-2' },
          ],
        }),
        config: () => baseCfg(),
        fetchImpl: okFetch(() => calls++),
        now: () => 10_000,
      });
      const report = await prober.refreshNow({ providerId: 'deepseek', keyHashPrefix: 'K2' });
      assert.equal(report.probed, 1);
      assert.equal(calls, 1);
      assert.equal(prober.planProbes(10_100).length, 1, 'the untouched pair stays due');
    } finally {
      setQuotaStoreForTests(undefined);
      fs.rmSync(path.dirname(tmp.ocrHome), { recursive: true, force: true });
    }
  });

  it('refreshNow refuses when the engine-level 429 gate is armed', async () => {
    const tmp = sandboxPaths('quota-refresh-gate');
    setQuotaStoreForTests(new QuotaSnapshotStore({ paths: tmp }));
    try {
      let calls = 0;
      const prober = new QuotaProber({
        registry: fakeRegistry({ deepseek: [{ keyHashPrefix: 'K1', key: 'sk-1' }] }),
        config: () => baseCfg(),
        fetchImpl: (async () => {
          calls++;
          return new Response('', { status: 429 });
        }) as typeof fetch,
        now: () => 10_000,
      });
      await prober.tick(10_000);
      assert.equal(calls, 1);
      const report = await prober.refreshNow();
      assert.deepEqual(
        report,
        { probed: 0, pending: 0, rateLimited: true, disabled: false, busy: false },
        'the armed gate refuses the manual cycle without clearing it'
      );
      assert.equal(calls, 1, 'no outbound call while gated');
      assert.equal(prober.planProbes(10_100).length, 0, 'the gate still pauses scheduling');
    } finally {
      setQuotaStoreForTests(undefined);
      fs.rmSync(path.dirname(tmp.ocrHome), { recursive: true, force: true });
    }
  });

  it('refreshNow refused by the kill switch leaves the schedule untouched', async () => {
    const tmp = sandboxPaths('quota-refresh-disabled');
    setQuotaStoreForTests(new QuotaSnapshotStore({ paths: tmp }));
    try {
      let calls = 0;
      let enabled = true;
      const prober = new QuotaProber({
        registry: fakeRegistry({ deepseek: [{ keyHashPrefix: 'K1', key: 'sk-1' }] }),
        config: () => ({ quota: { enabled } }) as unknown as RouterConfig,
        fetchImpl: okFetch(() => calls++),
        now: () => 10_000,
      });
      await prober.tick(10_000);
      assert.equal(calls, 1);
      // The pair now carries a due date. Turning the prober off and pressing
      // refresh must answer `disabled` WITHOUT clearing it — otherwise the
      // whole plan would fall due at once when the switch comes back on.
      enabled = false;
      assert.deepEqual(await prober.refreshNow(), {
        probed: 0,
        pending: 0,
        rateLimited: false,
        disabled: true,
        busy: false,
      });
      enabled = true;
      assert.equal(prober.planProbes(10_000).length, 0, 'the refused refresh did not rewrite due dates');
      assert.equal(calls, 1, 'nothing was probed while disabled');
    } finally {
      setQuotaStoreForTests(undefined);
      fs.rmSync(path.dirname(tmp.ocrHome), { recursive: true, force: true });
    }
  });

  it('a mid-cycle 429 stops the manual cycle and leaves the rest due', async () => {
    const tmp = sandboxPaths('quota-refresh-midcycle-429');
    setQuotaStoreForTests(new QuotaSnapshotStore({ paths: tmp }));
    try {
      let calls = 0;
      const prober = new QuotaProber({
        registry: fakeRegistry({
          deepseek: [
            { keyHashPrefix: 'K1', key: 'sk-1' },
            { keyHashPrefix: 'K2', key: 'sk-2' },
            { keyHashPrefix: 'K3', key: 'sk-3' },
          ],
        }),
        config: () => baseCfg(),
        fetchImpl: (async () => {
          calls++;
          return calls === 2
            ? new Response('', { status: 429 })
            : new Response(JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '1' }] }), { status: 200 });
        }) as typeof fetch,
        now: () => 10_000,
      });
      const report = await prober.refreshNow();
      assert.deepEqual(report, { probed: 2, pending: 1, rateLimited: true, disabled: false, busy: false });
      assert.equal(calls, 2, 'stopped at the 429 — the third pair was never attempted');
      assert.ok(prober.getRateLimitedUntil() > 10_000);
    } finally {
      setQuotaStoreForTests(undefined);
      fs.rmSync(path.dirname(tmp.ocrHome), { recursive: true, force: true });
    }
  });

  it('a tick firing during a manual refresh SKIPS — the two never run concurrently', async () => {
    const tmp = sandboxPaths('quota-refresh-exclusive');
    setQuotaStoreForTests(new QuotaSnapshotStore({ paths: tmp }));
    try {
      let calls = 0;
      const prober = new QuotaProber({
        registry: fakeRegistry({ deepseek: [{ keyHashPrefix: 'K1', key: 'sk-1' }] }),
        config: () => baseCfg(),
        fetchImpl: okFetch(() => calls++),
        now: () => 10_000,
      });
      const manual = prober.refreshNow();
      // The slot is taken synchronously → the tick must skip, not queue.
      const skipped = await prober.tick(10_000);
      assert.equal(skipped.probed, 0, 'tick skipped: due state survives, no queued cycle');
      assert.deepEqual(await manual, { probed: 1, pending: 0, rateLimited: false, disabled: false, busy: false });
      assert.equal(calls, 1, 'exactly one probe — no double-probe from the skipped tick');
    } finally {
      setQuotaStoreForTests(undefined);
      fs.rmSync(path.dirname(tmp.ocrHome), { recursive: true, force: true });
    }
  });

  it('a manual refresh that finds the slot busy answers busy instead of hanging', async () => {
    const tmp = sandboxPaths('quota-refresh-busy');
    setQuotaStoreForTests(new QuotaSnapshotStore({ paths: tmp }));
    try {
      let calls = 0;
      const prober = new QuotaProber({
        registry: fakeRegistry({ deepseek: [{ keyHashPrefix: 'K1', key: 'sk-1' }] }),
        config: () => baseCfg(),
        fetchImpl: okFetch(() => calls++),
        now: () => 10_000,
      });
      const first = prober.refreshNow();
      // Budget 0 → the waiter must not block on the in-flight cycle.
      const second = await prober.refreshNow({ budgetMs: 0 });
      assert.deepEqual(second, { probed: 0, pending: 0, rateLimited: false, disabled: false, busy: true });
      assert.equal((await first).probed, 1);
      assert.equal(calls, 1, 'the busy answer probed nothing');
    } finally {
      setQuotaStoreForTests(undefined);
      fs.rmSync(path.dirname(tmp.ocrHome), { recursive: true, force: true });
    }
  });

  it('refreshNow stops at its budget and leaves the rest due for the next tick', async () => {
    const tmp = sandboxPaths('quota-refresh-budget');
    setQuotaStoreForTests(new QuotaSnapshotStore({ paths: tmp }));
    try {
      let calls = 0;
      const prober = new QuotaProber({
        registry: fakeRegistry({ deepseek: [{ keyHashPrefix: 'K1', key: 'sk-1' }] }),
        config: () => baseCfg(),
        fetchImpl: okFetch(() => calls++),
        now: () => 10_000,
      });
      const report = await prober.refreshNow({ budgetMs: 0 });
      assert.deepEqual(report, { probed: 0, pending: 1, rateLimited: false, disabled: false, busy: false });
      assert.equal(calls, 0);
      assert.equal(prober.planProbes(10_100).length, 1, 'the pair is still due → the tick picks it up');
    } finally {
      setQuotaStoreForTests(undefined);
      fs.rmSync(path.dirname(tmp.ocrHome), { recursive: true, force: true });
    }
  });
});

// ─── Linkage: QUOTA diagnosis -> quota_events (manager join point) ─────────

describe('quota events linkage', () => {
  it('recordFailureScoped emits one quota event per QUOTA diagnosis (and none for other classes)', () => {
    const log = new QuotaEventLog();
    setQuotaEventLogForTests(log);
    try {
      const tmp = sandboxPaths('quota-link');
      const credentialState = new CredentialStateStore({ paths: tmp });
      const manager = new CircuitBreakerManager(
        { enabled: true, failureThreshold: 3, slidingWindowSize: 20, failureRateThreshold: 0.5, initialCooldownMs: 1000, maxCooldownMs: 50_000, cooldownMultiplier: 2, quotaCooldownMs: 60_000, halfOpenMaxProbes: 1 },
        () => 1_000_000,
        credentialState
      );
      const diag = ErrorClassifier.classify({ status: 402, message: 'Insufficient Balance', usedCredentialKeyHashPrefix: 'K9' }, 'p/x', 'p');
      assert.equal(diag.category, 'QUOTA_EXHAUSTED');
      manager.recordFailureScoped('p/x', diag, 'p', 'K9');
      const other = ErrorClassifier.classify({ status: 500, message: 'boom' }, 'p/x', 'p');
      manager.recordFailureScoped('p/x', other, 'p', 'K9');

      const events = log.list();
      assert.equal(events.length, 1, 'only the QUOTA diagnosis emitted');
      assert.equal(events[0].providerId, 'p');
      assert.equal(events[0].keyHashPrefix, 'K9');
      assert.equal(events[0].reasonCode, 'quota-exhausted');

      // Rule OFF: tripping stops, the LEDGER KEEPS EMITTING (event plane !=
      // policy plane).
      const mgrOff = new CircuitBreakerManager(
        { enabled: true, failureThreshold: 3, slidingWindowSize: 20, failureRateThreshold: 0.5, initialCooldownMs: 1000, maxCooldownMs: 50_000, cooldownMultiplier: 2, quotaCooldownMs: 60_000, halfOpenMaxProbes: 1, rules: { trip: { quota: { enabled: false, cooldownMs: 60_000, scope: 'credential' } } } as any },
        () => 1_000_000,
        new CredentialStateStore({ paths: tmp })
      );
      mgrOff.recordFailureScoped('p/x', diag, 'p', 'K9');
      assert.equal(log.list().length, 2, 'quota trip OFF still emits ledger events');
      fs.rmSync(path.dirname(tmp.ocrHome), { recursive: true, force: true });
    } finally {
      setQuotaEventLogForTests(undefined);
    }
  });
});

// ─── Trace attribution (step 1): per-pair aggregation ──────────────────────

describe('trace per-pair aggregation', () => {
  it('GROUP BY (provider, prefix) skips unattributed turns', () => {
    const t = new TraceTracker(100, undefined);
    const mk = (provider: string, prefix: string | undefined, cost: number) => ({
      traceId: `tr-${provider}-${prefix}-${cost}`,
      sessionId: 's',
      turnNumber: 1,
      timestamp: Date.now(),
      request: { model: 'm', userPromptSummary: '', messageCount: 1, hasSystemPrompt: false, hasToolsOrSchema: false },
      routing: { layerUsed: 'layer0', targetTier: 'lite', confidence: 1, reason: 'x', sessionRatchetApplied: false },
      execution: { modelUsed: 'm', provider, credentialKeyHashPrefix: prefix, tierUsed: 'lite', latencyMs: 5, fallbackOccurred: false },
      finops: { inputTokens: 10, outputTokens: 1, cachedTokens: 0, costUsd: cost },
    } as any);
    t.record(mk('p1', 'AAA', 0.1));
    t.record(mk('p1', 'AAA', 0.2));
    t.record(mk('p1', 'BBB', 0.3));
    t.record(mk('p2', 'AAA', 0.4));
    t.record(mk('p3', undefined, 0.5));
    const rows = t.getCredentialPairUsageStats();
    assert.equal(rows.length, 3, 'only attributed pairs');
    const a = rows.find((r) => r.provider === 'p1' && r.keyHashPrefix === 'AAA')!;
    assert.equal(a.requests, 2);
    assert.equal(a.costUsd, 0.3);
  });
});

// ─── Console surface (GET /api/admin/quota) — wire-shape smoke ─────────────

describe('quota console surface', () => {
  it('GET /api/admin/quota answers the pairs contract even with no prober', async () => {
    const { createServer } = await import('../src/server.js');
    const { loadConfig } = await import('../src/config/index.js');
    const { app } = createServer(loadConfig(), true);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/admin/quota' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.status, 'ok');
      assert.equal(body.enabled, false, 'prober is a boot (index.ts) singleton — absent here');
      for (const key of ['coverage', 'rejected', 'pairs', 'events']) {
        assert.ok(Array.isArray(body[key]), `${key} must be an array`);
      }
      // Mock-mode registry pairs must be shape-valid rows.
      for (const p of body.pairs) {
        assert.equal(typeof p.providerId, 'string');
        assert.equal(typeof p.keyHashPrefix, 'string');
        assert.equal(typeof p.covered, 'boolean');
        if (p.quota) assert.ok(['probed', 'declared', 'unverified', 'stale'].includes(p.quota.badge));
        // A store machine id must never surface as a display name (it used to
        // leak as a UUID through the credentialId fallback); an unnamed
        // credential carries the masked key instead.
        if (p.label !== undefined) {
          assert.ok(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(p.label), `label looks like a credentialId uuid: ${p.label}`);
        }
        if (p.maskedKey !== undefined) assert.equal(typeof p.maskedKey, 'string');
      }
    } finally {
      await app.close();
    }
  });

  it('POST /api/admin/quota/refresh reports quota_disabled with no live prober', async () => {
    const { createServer } = await import('../src/server.js');
    const { loadConfig } = await import('../src/config/index.js');
    const { app } = createServer(loadConfig(), true);
    try {
      const res = await app.inject({ method: 'POST', url: '/api/admin/quota/refresh', payload: {} });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.success, false);
      assert.equal(body.reasonCode, 'quota_disabled');
    } finally {
      await app.close();
    }
  });
});

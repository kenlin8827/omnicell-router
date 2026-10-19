import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialPaths } from '../src/opencode/credentials/paths.js';
import { ocrCredentialsFile } from '../src/opencode/credentials/paths.js';
import { DbOpener, OpencodeV2Store, resolveServiceConfigForPaths } from '../src/opencode/credentials/opencode-v2-store.js';
import {
  CapabilityUnsupportedError,
  IntegrationUnmatchedError,
  WriteFailedError,
  keyHashPrefix,
} from '../src/opencode/credentials/types.js';

const ALL_COLS = ['id', 'integration_id', 'label', 'value', 'active', 'time_created', 'time_updated'];

function fakeDb(rows: unknown[] = [], counter?: { loads: number }): DbOpener {
  return async () => ({
    query(sql: string) {
      return {
        all: () => {
          if (sql.includes('table_info')) return ALL_COLS.map((c) => ({ name: c }));
          if (counter && /FROM credential/.test(sql)) counter.loads += 1;
          return rows;
        },
      };
    },
    close() {
      // nothing to release
    },
  });
}

interface Call {
  url: string;
  method: string;
  auth: string;
  body: unknown;
}

function makeFetch(handler: (call: Call, index: number) => { status: number; json?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    // tests always pass plain-object headers; cast mirrors that contract.
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: String(input),
      method: String(init?.method ?? 'GET'),
      auth: headers.Authorization ?? '',
      body: init?.body ? JSON.parse(String(init?.body)) : undefined,
    };
    calls.push(call);
    const res = handler(call, calls.length - 1);
    return new Response(JSON.stringify(res.json ?? {}), { status: res.status });
  };
  return { fetchImpl, calls };
}

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cred-v2w-'));
  const paths: CredentialPaths = {
    configDir: path.join(dir, 'config', 'opencode'),
    dataDir: path.join(dir, 'data', 'opencode'),
    authJsonPath: path.join(dir, 'data', 'opencode', 'auth.json'),
    opencodeDbPath: path.join(dir, 'data', 'opencode', 'opencode.db'),
    installedVersionPath: path.join(dir, 'config', 'opencode', 'installed.version'),
    ocrHome: path.join(dir, 'ocr-home'),
    serviceJsonCandidates: [path.join(dir, 'config', 'opencode', 'service.json')],
  };
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.mkdirSync(paths.dataDir, { recursive: true });
  return paths;
}

function writeServiceJson(paths: CredentialPaths, data: unknown): string {
  const file = paths.serviceJsonCandidates![0]!;
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

const basic = (pw: string) => 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64');

const INTEGRATIONS = { data: [{ id: 'Anthropic', connections: [{ id: 'conn-1', label: '••••', method: 'key' }] }] };

async function makeStore(opts: {
  paths: CredentialPaths;
  writable?: boolean;
  fetchImpl: typeof fetch;
  rows?: unknown[];
  loads?: { loads: number };
  runServiceStatus?: () => Promise<string | null>;
}) {
  return OpencodeV2Store.create({
    paths: opts.paths,
    writable: opts.writable ?? true,
    fetchImpl: opts.fetchImpl,
    env: {}, // fully hermetic: no OPENCODE_SERVER_* leakage from the ambient shell
    sleep: async () => {}, // instant reload-poll backoff
    openDatabase: fakeDb(opts.rows ?? [], opts.loads),
    ...(opts.runServiceStatus ? { runServiceStatus: opts.runServiceStatus } : {}),
  });
}

describe('OpencodeV2Store writes (HTTP mock against the opencode v2 service)', () => {
  it('connectKey resolves the integration, POSTs the key, and invalidates the view', async () => {
    const paths = sandboxPaths();
    writeServiceJson(paths, { password: 'pw1', port: 4100 });
    const { fetchImpl, calls } = makeFetch((call) => {
      if (call.method === 'GET' && call.url.endsWith('/api/integration')) return { status: 200, json: INTEGRATIONS };
      return { status: 200, json: { credential: { id: 'cred_new' } } };
    });
    const loads = { loads: 0 };
    const store = await makeStore({ paths, fetchImpl, loads });

    const meta = await store.connectKey('anthropic', 'sk-connect-key-123456', 'laptop');
    expect(calls.map((c) => `${c.method} ${c.url.replace('http://127.0.0.1:4100', '')}`)).toEqual([
      'GET /api/integration',
      'POST /api/integration/Anthropic/connect/key', // case-insensitive match routes the SERVICE id
    ]);
    expect(calls[0]!.auth).toBe(basic('pw1'));
    expect(calls[1]!.body).toEqual({ key: 'sk-connect-key-123456', label: 'laptop' });
    expect(meta).toMatchObject({ id: 'cred_new', providerId: 'anthropic', type: 'api', active: true, routable: true });
    expect(meta.keyHashPrefix).toBe(keyHashPrefix('sk-connect-key-123456'));
    // explicit invalidate on console write forces the next read to re-query (no zombie keys)
    store.listCredentials('anthropic');
    expect(loads.loads).toBe(2);
  });

  it('activate / rename / disconnect hit the live-probed per-credential routes', async () => {
    const paths = sandboxPaths();
    writeServiceJson(paths, { password: 'pw1', port: 4100 });
    const { fetchImpl, calls } = makeFetch(() => ({ status: 200, json: { ok: true } }));
    const store = await makeStore({ paths, fetchImpl });

    await store.activate('cred_1');
    await store.rename('cred_1', 'rotated');
    await store.disconnect('cred_1');

    expect(calls.map((c) => `${c.method} /${c.url.split('/api/')[1]}`)).toEqual([
      'POST /credential/cred_1/activate',
      'PATCH /credential/cred_1',
      'DELETE /credential/cred_1',
    ]);
    expect(calls[1]!.body).toEqual({ label: 'rotated' });
    // the documented credential COLLECTION routes 404 on 2.0.15 — must never be called
    for (const c of calls) expect(c.url).not.toMatch(/\/api\/credential\/?$/);
  });

  it('activate / rename / disconnect each invalidate the cached view AFTER the post-write row lookup (Decision 3: ANY console action)', async () => {
    const paths = sandboxPaths();
    writeServiceJson(paths, { password: 'pw1', port: 4100 });
    const { fetchImpl } = makeFetch(() => ({ status: 200, json: { ok: true } }));
    const loads = { loads: 0 };
    const row = {
      id: 'c1',
      integration_id: 'anthropic',
      label: null,
      value: JSON.stringify({ type: 'key', key: 'sk-invalidate-order' }),
      active: 1,
      time_created: 1,
      time_updated: 1,
    };
    const store = await makeStore({ paths, fetchImpl, loads, rows: [row] });
    const afterBind = loads.loads; // create() eager load
    store.listCredentials('anthropic');
    expect(loads.loads).toBe(afterBind); // cached within TTL
    let baseline = loads.loads;
    for (const op of [
      () => store.activate('c1'),
      () => store.rename('c1', 'rotated'),
      () => store.disconnect('c1'),
    ]) {
      await op();
      // findRow must serve from the CACHED view: an invalidate BEFORE the
      // lookup (wrong order) would re-query mid-write.
      expect(loads.loads).toBe(baseline);
      store.listCredentials('anthropic');
      // exactly one re-query proves invalidate() ran AFTER the lookup.
      expect(loads.loads).toBe(baseline + 1);
      baseline += 1;
    }
  });

  it('providerId without an integration match: escalated reload rounds, re-resolve, still typed error (no key POST)', async () => {
    // A miss is no longer immediately terminal: the store asks the service to
    // re-read config (a just-written def only registers on reload — live-probe
    // 2.0.15) and re-checks, escalating a SECOND reload+poll round because a
    // reload queued behind another caller's can read config before our def-write
    // lands (observed). Transport-retry semantics are unchanged: the key itself
    // is NEVER re-POSTed against an unmatched id.
    const paths = sandboxPaths();
    writeServiceJson(paths, { password: 'pw1', port: 4100 });
    const { fetchImpl, calls } = makeFetch(() => ({ status: 200, json: { data: [{ id: 'openai' }] } }));
    const store = await makeStore({ paths, fetchImpl });
    let err: unknown;
    try {
      await store.connectKey('anthropic', 'sk-1');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IntegrationUnmatchedError);
    expect((err as IntegrationUnmatchedError).knownIntegrationIds).toEqual(['openai']);
    // initial registry read + both escalated reload rounds' polls (1 + 3 + 3)
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(7);
    // the only POSTs are the two escalated config reloads — never the key
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts.every((p) => p.url.includes('/api/location/reload'))).toBe(true);
  });

  it('write failure re-reads service.json (password rotation + port drift) and retries once', async () => {
    const paths = sandboxPaths();
    const file = writeServiceJson(paths, { password: 'pw1', port: 4100 });
    const { fetchImpl, calls } = makeFetch((call, index) => {
      if (call.method === 'GET') return { status: 200, json: INTEGRATIONS };
      if (index === 1) {
        fs.writeFileSync(file, JSON.stringify({ password: 'pw2', port: 4200 })); // rotate between attempts
        return { status: 500, json: { error: 'boom' } };
      }
      return { status: 200, json: { id: 'cred_after_rotation' } };
    });
    const store = await makeStore({ paths, fetchImpl });
    const meta = await store.connectKey('anthropic', 'sk-rotate-key-9');
    expect(meta.id).toBe('cred_after_rotation');
    expect(calls[1]!.url).toContain(':4100');
    expect(calls[1]!.auth).toBe(basic('pw1'));
    expect(calls[2]!.url).toContain(':4200'); // fresh service.json picked up the new port
    expect(calls[2]!.auth).toBe(basic('pw2')); // and the rotated password
  });

  it('second failure surfaces WriteFailedError — NEVER falls back to OcrStore', async () => {
    const paths = sandboxPaths();
    writeServiceJson(paths, { password: 'pw1', port: 4100 });
    const { fetchImpl, calls } = makeFetch((call) => {
      if (call.method === 'GET') return { status: 200, json: INTEGRATIONS };
      return { status: 500 };
    });
    const store = await makeStore({ paths, fetchImpl });
    let err: unknown;
    try {
      await store.connectKey('anthropic', 'sk-1');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WriteFailedError);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2); // one retry only
    expect(fs.existsSync(ocrCredentialsFile(paths))).toBe(false); // no silent fork into OcrStore
  });

  it('no service config at all fails loudly without any fetch', async () => {
    const paths = sandboxPaths();
    const { fetchImpl, calls } = makeFetch(() => ({ status: 200 }));
    const store = await makeStore({ paths, fetchImpl });
    let err: unknown;
    try {
      await store.activate('cred_1');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WriteFailedError);
    expect(calls).toHaveLength(0);
  });

  it('OpencodeV2Store-readonly refuses every write with cli-absent-db-present but reads normally', async () => {
    const paths = sandboxPaths();
    writeServiceJson(paths, { password: 'pw1', port: 4100 });
    const row = {
      id: 'c1',
      integration_id: 'anthropic',
      label: null,
      value: JSON.stringify({ type: 'key', key: 'sk-readonly' }),
      active: 1,
      time_created: 1,
      time_updated: 1,
    };
    const { fetchImpl, calls } = makeFetch(() => ({ status: 200 }));
    const store = await makeStore({ paths, writable: false, fetchImpl, rows: [row] });
    expect(store.kind).toBe('opencode-v2-readonly');
    expect(store.resolveKey('anthropic')?.key).toBe('sk-readonly');
    expect(store.capabilities.activate).toBe(false);
    expect(store.capabilities.rename).toBe(false);

    for (const op of [
      () => store.connectKey('anthropic', 'sk-x'),
      () => store.activate('c1'),
      () => store.rename('c1', 'x'),
      () => store.disconnect('c1'),
    ]) {
      let err: unknown;
      try {
        await op();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CapabilityUnsupportedError);
      expect((err as CapabilityUnsupportedError).reason).toBe('cli-absent-db-present');
    }
    expect(calls).toHaveLength(0); // no HTTP write attempts at all
  });

  it('OAuth is capability-refused on the opencode v2 store too', async () => {
    const paths = sandboxPaths();
    const { fetchImpl } = makeFetch(() => ({ status: 200 }));
    const store = await makeStore({ paths, fetchImpl });
    for (const op of [() => store.beginOAuth('anthropic'), () => store.completeOAuth('anthropic')]) {
      let err: unknown;
      try {
        await op();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CapabilityUnsupportedError);
    }
    expect(store.capabilities.oauth).toBe(false);
  });
});

describe('service target policy (security P2-1)', () => {
  it('non-loopback HTTP: every HTTP call refused BEFORE fetch, reason insecure_remote_target; sqlite reads unaffected', async () => {
    const paths = sandboxPaths();
    writeServiceJson(paths, { password: 'pw', baseUrl: 'http://stale-remote.test:4100' });
    const { fetchImpl, calls } = makeFetch(() => ({ status: 200 }));
    const row = {
      id: 'c1',
      integration_id: 'anthropic',
      label: null,
      value: JSON.stringify({ type: 'key', key: 'sk-remote-read' }),
      active: 1,
      time_created: 1,
      time_updated: 1,
    };
    const store = await makeStore({ paths, fetchImpl, rows: [row] });
    // READS unaffected (sqlite path never touches HTTP)
    expect(store.resolveKey('anthropic')?.key).toBe('sk-remote-read');
    let err: unknown;
    try {
      await store.connectKey('anthropic', 'sk-never-exfiltrated');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WriteFailedError);
    expect((err as Error).message).toContain('insecure_remote_target');
    expect(calls).toHaveLength(0); // refused before ANY fetch (no Basic password on cleartext either)
  });

  it('non-loopback HTTPS: allowed, targetPolicy remote_tls, LOUD warn on resolution', async () => {
    const paths = sandboxPaths();
    writeServiceJson(paths, { password: 'pw', baseUrl: 'https://managed.test/oc' });
    const warns: string[] = [];
    const actualWarn = console.warn;
    console.warn = (...a: unknown[]) => {
      warns.push(a.join(' '));
    };
    try {
      const cfg = resolveServiceConfigForPaths(paths, {});
      expect(cfg?.targetPolicy).toBe('remote_tls');
      expect(cfg?.baseUrl).toBe('https://managed.test/oc');
      expect(warns.some((w) => w.includes('NON-LOOPBACK over HTTPS'))).toBe(true);
    } finally {
      console.warn = actualWarn;
    }
    const { fetchImpl, calls } = makeFetch((call) =>
      call.method === 'GET' ? { status: 200, json: { data: [{ id: 'anthropic' }] } } : { status: 200, json: { id: 'c-new' } }
    );
    const store = await makeStore({ paths, fetchImpl });
    const meta = await store.connectKey('anthropic', 'sk-https-remote-ok');
    expect(meta.id).toBe('c-new');
    expect(calls.length).toBeGreaterThan(0); // https remote IS contacted
  });

  it('loopback (127.0.0.1 via port field) unchanged: allowed, no policy flag', () => {
    const paths = sandboxPaths();
    writeServiceJson(paths, { password: 'pw', port: 4100 });
    const cfg = resolveServiceConfigForPaths(paths, {});
    expect(cfg?.targetPolicy).toBe('loopback');
    expect(cfg?.baseUrl).toBe('http://127.0.0.1:4100');
  });

  it('injected env WITHOUT url never falls through to real process.env (paths.ts sole-env-read contract)', () => {
    const paths = sandboxPaths();
    writeServiceJson(paths, { password: 'pw-only' }); // no port/baseUrl in the file
    const sentinel = process.env.OPENCODE_SERVER_URL;
    process.env.OPENCODE_SERVER_URL = 'http://ambient-leak.test:9999';
    try {
      const cfg = resolveServiceConfigForPaths(paths, { OPENCODE_SERVER_PASSWORD: 'pw-only' });
      // injected env has the password but NO url -> explicit loopback default,
      // NEVER the ambient OPENCODE_SERVER_URL (the old OpenCodeConnector leak)
      expect(cfg?.baseUrl).toBe('http://127.0.0.1:49374');
      expect(cfg?.targetPolicy).toBe('loopback');
      // an injected url IS honored
      const withUrl = resolveServiceConfigForPaths(paths, {
        OPENCODE_SERVER_PASSWORD: 'pw-only',
        OPENCODE_SERVER_URL: 'http://127.0.0.1:5555',
      });
      expect(withUrl?.baseUrl).toBe('http://127.0.0.1:5555');
    } finally {
      if (sentinel === undefined) delete process.env.OPENCODE_SERVER_URL;
      else process.env.OPENCODE_SERVER_URL = sentinel;
    }
  });
});

describe('opencode v2 http hardening (security P3-3/P3-4 + P3-13)', () => {
  it('SELECT carries a deterministic ORDER BY (active first, newest updated first)', async () => {
    const paths = sandboxPaths();
    writeServiceJson(paths, { password: 'pw', port: 4100 });
    const sqls: string[] = [];
    const opener: DbOpener = async () => ({
      query(sql: string) {
        return {
          all: () => {
            sqls.push(sql);
            return /FROM credential/.test(sql) ? [] : ALL_COLS.map((c) => ({ name: c }));
          },
        };
      },
      close() {
        // no-op
      },
    });
    await OpencodeV2Store.create({ paths, env: {}, openDatabase: opener });
    expect(sqls.some((s) => /FROM credential ORDER BY active DESC, time_updated DESC/.test(s))).toBe(true);
  });

  it('every admin-served call carries an AbortSignal timeout; a timed-out fetch surfaces WriteFailedError reason timeout', async () => {
    const paths = sandboxPaths();
    writeServiceJson(paths, { password: 'pw', port: 4100 });
    const signals: unknown[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      signals.push((init as RequestInit).signal);
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    };
    const store = await makeStore({ paths, fetchImpl });
    let err: unknown;
    try {
      await store.connectKey('anthropic', 'sk-timeout-key');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WriteFailedError);
    expect((err as Error).message).toContain('timeout');
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true); // bounded — no indefinite hang
  });

  it('a 3xx response is refused (redirect_refused), never followed with the key', async () => {
    const paths = sandboxPaths();
    writeServiceJson(paths, { password: 'pw', port: 4100 });
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      urls.push(String(input));
      if (String(init?.method ?? 'GET') === 'GET') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'anthropic' }] }) } as unknown as Response;
      }
      return { ok: false, status: 302, text: async () => '' } as unknown as Response;
    };
    const store = await makeStore({ paths, fetchImpl });
    let err: unknown;
    try {
      await store.connectKey('anthropic', 'sk-redirect-key');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WriteFailedError);
    expect((err as Error).message).toContain('redirect_refused');
    // no second POST to a redirect target — retry hits the SAME url, redirect never dereferenced
    expect(urls.filter((u) => u.includes('connect/key')).every((u) => u.includes('127.0.0.1:4100'))).toBe(true);
  });

  it('redirect/manual + signal are set on the request init (write-path contract)', async () => {
    const paths = sandboxPaths();
    writeServiceJson(paths, { password: 'pw', port: 4100 });
    const inits: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      inits.push(init as RequestInit);
      return new Response('', { status: 200 });
    };
    const store = await makeStore({ paths, fetchImpl });
    await store.activate('c1');
    expect(inits.length).toBeGreaterThan(0);
    expect(inits.every((i) => i.redirect === 'manual')).toBe(true);
    expect(inits.every((i) => i.signal instanceof AbortSignal)).toBe(true);
  });
});

describe('write-path service discovery fallback (opencode 2.0.32 service.json carries {password, env} only)', () => {
  it('no explicit url: DELETE consults `opencode service status` and hits the live port', async () => {
    const paths = sandboxPaths();
    writeServiceJson(paths, { password: 'pw', env: { HTTPS_PROXY: 'http://127.0.0.1:10000' } }); // no port/baseUrl
    const { fetchImpl, calls } = makeFetch(() => ({ status: 200, json: { ok: true } }));
    let statusRuns = 0;
    const store = await makeStore({
      paths,
      fetchImpl,
      runServiceStatus: async () => {
        statusRuns += 1;
        return 'http://127.0.0.1:45278';
      },
    });
    await store.disconnect('cred_live');
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toBe('http://127.0.0.1:45278/api/credential/cred_live');
    expect(statusRuns).toBe(1); // one attempt, one CLI probe — no polling storm
  });

  it('CLI probe failure keeps the legacy default — the fallback only widens reachability', async () => {
    const paths = sandboxPaths();
    writeServiceJson(paths, { password: 'pw' }); // no url anywhere
    const { fetchImpl, calls } = makeFetch(() => ({ status: 200, json: { ok: true } }));
    const store = await makeStore({ paths, fetchImpl, runServiceStatus: async () => null });
    await store.disconnect('cred_fallback');
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toBe('http://127.0.0.1:49374/api/credential/cred_fallback');
  });

  it('explicit port in service.json bypasses the CLI probe entirely', async () => {
    const paths = sandboxPaths();
    writeServiceJson(paths, { password: 'pw', port: 4100 });
    const { fetchImpl, calls } = makeFetch(() => ({ status: 200, json: { ok: true } }));
    let statusRuns = 0;
    const store = await makeStore({
      paths,
      fetchImpl,
      runServiceStatus: async () => {
        statusRuns += 1;
        return 'http://127.0.0.1:45278';
      },
    });
    await store.disconnect('cred_explicit');
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toBe('http://127.0.0.1:4100/api/credential/cred_explicit');
    expect(statusRuns).toBe(0);
  });
});

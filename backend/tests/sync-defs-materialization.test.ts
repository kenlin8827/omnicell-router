import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CredentialPaths } from '../src/opencode/credentials/paths.js';
import { OcrStore } from '../src/opencode/credentials/ocr-store.js';
import { initCredentialSync, pushFromOcr, runCredentialSync, setSyncAutoToggle, stopCredentialSync } from '../src/opencode/credentials/sync.js';
import { readProviderDefsFile, writeProviderDefs, getProviderDefsPath } from '../src/opencode/provider-defs.js';

function seedDefs(p: CredentialPaths, providers: Record<string, unknown>): void {
  writeProviderDefs(providers as Record<string, any>, p);
}

/**
 * Def materialization — the def half of the v2 sync client's write direction.
 * REPLACE contract: the defs file's `providers` map replaces the client jsonc
 * `providers` node verbatim (extra client-side nodes are deleted; slot-outer
 * comments survive, slot-inner comments die). Honesty contract of the sink:
 * an id the service never resolves is a LOUD failure — entry failed, local key
 * kept, never a silent success — and materialization itself never clobbers an
 * unparsable client config.
 */

let tmpDirs: string[] = [];

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-defmat-'));
  tmpDirs.push(dir);
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

function withService(p: CredentialPaths): CredentialPaths {
  fs.writeFileSync(p.serviceJsonCandidates![0]!, JSON.stringify({ password: 'pw', port: 4100 }));
  return p;
}

function withDb(p: CredentialPaths): CredentialPaths {
  fs.writeFileSync(p.opencodeDbPath, 'fake-db-bytes');
  return p;
}

const fakeDb = () => async () => ({
  query(sql: string) {
    return {
      all: () =>
        sql.includes('table_info')
          ? ['id', 'integration_id', 'label', 'value', 'active', 'time_created', 'time_updated'].map((c) => ({
              name: c,
            }))
          : [],
    };
  },
  close() {
    // no-op
  },
});

function clientJsoncPath(p: CredentialPaths): string {
  return path.join(p.configDir, 'opencode.jsonc');
}

function readJsoncRaw(p: CredentialPaths): string {
  return fs.readFileSync(clientJsoncPath(p), 'utf8');
}

function writeClientJsonc(p: CredentialPaths, text: string): void {
  fs.writeFileSync(clientJsoncPath(p), text, 'utf8');
}

beforeEach(() => {
  tmpDirs = [];
});

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows EBUSY right after writes — best effort
    }
  }
});

describe('def materialization (v2 write direction)', () => {
  it('REPLACEs the client providers slot: extra client-side nodes are deleted, slot-outer content survives', async () => {
    const p = withDb(withService(sandboxPaths()));
    seedDefs(p, {
      acme: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://acme.test/v1' } },
      zhipu: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://z.test/v1' } },
    });
    writeClientJsonc(
      p,
      [
        '// top comment survives the render',
        '{',
        '  "model": "some/model",',
        '  "providers": {',
        '    "acme": { "package": "stale" },',
        '    "zhipu": { "package": "stale" },',
        '    "legacy-extra": { "package": "must-be-deleted" }',
        '  }',
        '}',
      ].join('\n')
    );
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    await ocr.connectKey('acme', 'sk-acme-push-1');
    const posts: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET');
      if (method === 'GET') {
        return new Response(JSON.stringify({ data: ['acme', 'zhipu'].map((id) => ({ id, connections: [] })) }), {
          status: 200,
        });
      }
      posts.push(url);
      return new Response(JSON.stringify({ credential: { id: 'c-new' } }), { status: 200 });
    };

    const outcome = await pushFromOcr('opencode-v2', ocr, { paths: p, fetchImpl, openDatabase: fakeDb(), now: () => 1 });
    expect(outcome.ok).toBe(true);
    expect(outcome.defsMaterialized).toBe(2);
    expect(outcome.pushed).toBe(1);

    const raw = readJsoncRaw(p);
    const parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
    expect(Object.keys(parsed.providers).sort()).toEqual(['acme', 'zhipu']); // legacy-extra deleted
    expect(parsed.providers.acme.settings.baseURL).toBe('https://acme.test/v1'); // verbatim render
    expect(parsed.model).toBe('some/model'); // slot-outer survives
    expect(raw).toContain('// top comment survives the render');
  });

  it('built-in providers travel as keys only; only the client-unknown relay gets a config node', async () => {
    const p = withDb(withService(sandboxPaths()));
    seedDefs(p, {
      deepseek: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://api.deepseek.com' } },
      maisuitx: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'http://192.168.18.10:20180/v3' } },
    });
    writeClientJsonc(p, '{ "model": "x" }');
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    await ocr.connectKey('deepseek', 'sk-deepseek');
    await ocr.connectKey('maisuitx', 'sk-relay');

    // /api/provider answers with integrationID only for the CLIENT's own catalog
    // (deepseek) — the relay has no integration, so it is custom by definition.
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (String(init?.method ?? 'GET') === 'GET') {
        if (url.includes('/api/provider')) {
          return new Response(
            JSON.stringify({ data: [{ id: 'deepseek', integrationID: 'deepseek' }, { id: 'maisuitx' }] }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({ data: [{ id: 'deepseek', connections: [] }, { id: 'maisuitx', connections: [] }] }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ credential: { id: 'c-1' } }), { status: 200 });
    };

    // runCredentialSync is the recorded path (the badge reads the recorded run).
    const { write: outcome } = await runCredentialSync('opencode-v2', 'write', ocr, {
      paths: p,
      fetchImpl,
      openDatabase: fakeDb(),
      now: () => 1,
    });
    expect(outcome!.ok).toBe(true);
    expect(outcome!.defsSkippedBuiltIn).toEqual(['deepseek']);
    expect(outcome!.defsMaterialized).toBe(1);
    const parsed = JSON.parse(readJsoncRaw(p).replace(/^\s*\/\/.*$/gm, ''));
    expect(Object.keys(parsed.providers)).toEqual(['maisuitx']);

    // The badge compares the SAME render set: no drift right after the run.
    const { credentialSyncStatusView } = await import('../src/opencode/credentials/sync.js');
    const view = credentialSyncStatusView({ paths: p });
    expect(view.clients.find((c) => c.id === 'opencode-v2')?.defsDrift).toBe(false);
  });

  it('a wire the client has no package for is substituted in the client copy only (book untouched)', async () => {
    const p = withDb(withService(sandboxPaths()));
    const typesafeDef = {
      package: '@opencode/ai/providers/typesafe',
      settings: { baseURL: 'https://ark.cn-beijing.volces.com/api/v3' },
      models: { 'doubao-1': { name: 'doubao-1' } },
    };
    seedDefs(p, { ark: typesafeDef });
    writeClientJsonc(p, '{ "model": "x" }');
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    await ocr.connectKey('ark', 'sk-ark');

    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(init?.method ?? 'GET') === 'GET') {
        // the client does NOT define ark (no integration) → the node is written
        return new Response(JSON.stringify({ data: [{ id: 'ark', connections: [] }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ credential: { id: 'c-1' } }), { status: 200 });
    };
    const outcome = await pushFromOcr('opencode-v2', ocr, { paths: p, fetchImpl, openDatabase: fakeDb(), now: () => 1 });
    expect(outcome.ok).toBe(true);

    const parsed = JSON.parse(readJsoncRaw(p).replace(/^\s*\/\/.*$/gm, ''));
    // client copy: loadable package, everything else preserved verbatim
    expect(parsed.providers.ark.package).toBe('@opencode/ai/providers/openai-compatible');
    expect(parsed.providers.ark.settings.baseURL).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(parsed.providers.ark.models).toEqual({ 'doubao-1': { name: 'doubao-1' } });
    // the book keeps the authored def — OCR's own wire inference is unaffected
    expect(readProviderDefsFile(p)!.providers.ark).toEqual(typesafeDef);
  });

  it('unparsable client jsonc is refused, never clobbered — loud entry failure, byte-identical file', async () => {
    const p = withDb(withService(sandboxPaths()));
    seedDefs(p, {
      acme: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://acme.test/v1' } },
    });
    writeClientJsonc(p, '{ corrupt');
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    await ocr.connectKey('acme', 'sk-acme-push-2');

    const outcome = await pushFromOcr('opencode-v2', ocr, { paths: p, openDatabase: fakeDb(), now: () => 1 });
    expect(outcome.ok).toBe(false);
    expect(outcome.entries[0]?.action).toBe('failed');
    expect(outcome.entries[0]?.reason).toContain('materialization');
    expect(readJsoncRaw(p)).toBe('{ corrupt'); // byte-identical — refuse-don't-clobber
  });

  it('no db = no v2 client: existing push semantics preserved, jsonc never created', async () => {
    const empty = sandboxPaths(); // no db, no service.json, no keys
    const none = await pushFromOcr('opencode-v2', new OcrStore({ paths: empty, now: () => 1 }), { paths: empty });
    expect(none).toMatchObject({ ok: true, pushed: 0 });
    expect(none.defsMaterialized).toBeUndefined();
    expect(fs.existsSync(clientJsoncPath(empty))).toBe(false); // no materialization without a client

    const p = sandboxPaths(); // keys but no db and no service.json
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    await ocr.connectKey('anthropic', 'sk-orphan-2');
    const down = await pushFromOcr('opencode-v2', ocr, { paths: p });
    expect(down).toMatchObject({ ok: false, precondition: 'service_unreachable' });
    expect(fs.existsSync(clientJsoncPath(p))).toBe(false);
  });

  it('sink honesty contract: an id the service never resolves is a loud failure — key kept, no connect/key POST', async () => {
    const p = withDb(withService(sandboxPaths()));
    seedDefs(p, {
      ghost: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://g.test/v1' } },
    });
    writeClientJsonc(p, '{}');
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    await ocr.connectKey('ghost', 'sk-ghost-keep-1');

    const connectPosts: string[] = [];
    const reloadPosts: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET');
      if (method === 'GET') {
        return new Response(JSON.stringify({ data: [] }), { status: 200 }); // registry never knows 'ghost'
      }
      if (url.includes('/api/location/reload')) {
        reloadPosts.push(url);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      connectPosts.push(url);
      return new Response(JSON.stringify({ credential: { id: 'c-new' } }), { status: 200 });
    };

    const outcome = await pushFromOcr('opencode-v2', ocr, { paths: p, fetchImpl, openDatabase: fakeDb(), now: () => 1 });
    expect(outcome.ok).toBe(false);
    expect(outcome.entries[0]?.provider).toBe('ghost');
    expect(outcome.entries[0]?.action).toBe('failed');
    expect(connectPosts).toHaveLength(0); // refused at the id gate — never a fake push
    expect(reloadPosts.length).toBeGreaterThan(0); // the self-heal was genuinely attempted
    expect(readJsoncRaw(p)).toContain('ghost'); // client copy converged even though the service refused
    // THE contract: the OCR file is the truth — the local entry is kept
    const ocrFile = JSON.parse(fs.readFileSync(path.join(p.ocrHome, 'credentials.json'), 'utf8'));
    expect(ocrFile.providers.ghost).toHaveLength(1);
  }, 20000); // reload self-heal rounds + poll sleeps exceed the 5s default

  it('materialize -> reload self-heal -> first key push lands for a brand-new custom provider', async () => {
    const p = withDb(withService(sandboxPaths()));
    seedDefs(p, {
      newguy: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://n.test/v1' } },
    });
    writeClientJsonc(p, '{}');
    const ocr = new OcrStore({ paths: p, now: () => 1 });
    await ocr.connectKey('newguy', 'sk-newguy-1');

    let seen = false; // the service "re-reads" its config on reload
    const connectPosts: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET');
      if (method === 'GET') {
        return new Response(JSON.stringify({ data: seen ? [{ id: 'newguy', connections: [] }] : [] }), {
          status: 200,
        });
      }
      if (url.includes('/api/location/reload')) {
        seen = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      connectPosts.push(url);
      return new Response(JSON.stringify({ credential: { id: 'c-new' } }), { status: 200 });
    };

    const outcome = await pushFromOcr('opencode-v2', ocr, { paths: p, fetchImpl, openDatabase: fakeDb(), now: () => 1 });
    expect(outcome.ok).toBe(true);
    expect(outcome.pushed).toBe(1);
    expect(connectPosts.some((u) => u.includes('/api/integration/newguy/connect/key'))).toBe(true);
    expect(readJsoncRaw(p)).toContain('newguy'); // materialized before the push
  });

  it('defs mutations trigger the debounced auto-write — def changes converge without touching credentials', async () => {
    const p = withDb(withService(sandboxPaths()));
    seedDefs(p, {
      acme: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://acme.test/v1' } },
    });
    writeClientJsonc(p, '{}');
    const fetchCalls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET');
      if (method === 'GET') {
        return new Response(JSON.stringify({ data: [{ id: 'acme', connections: [] }] }), { status: 200 });
      }
      fetchCalls.push(url);
      return new Response(JSON.stringify({ credential: { id: 'c-new' } }), { status: 200 });
    };
    const ocr = new OcrStore({ paths: p, now: () => 1 });

    await initCredentialSync(ocr, {
      paths: p,
      fetchImpl,
      openDatabase: fakeDb(),
      now: () => 1,
      writeDebounceMs: 20,
    });
    try {
      setSyncAutoToggle('opencode-v2', 'write', true, { paths: p });
      // A DEFS mutation (no credential change) — the defs mutation hook fires
      // the same debounced auto-write the credential mutation hook uses.
      writeProviderDefs(
        {
          ...readProviderDefsFile(p)!.providers,
          newguy: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://n.test/v1' } },
        },
        p
      );
      await new Promise((r) => setTimeout(r, 150)); // debounce + materialize
      expect(readJsoncRaw(p)).toContain('newguy'); // auto-write materialized the def change
    } finally {
      stopCredentialSync();
    }
  }, 10000);

  it('a MISSING defs book is never treated as empty — client providers survive byte-identically', async () => {
    // "absent" != "empty": REPLACE over an unreadable book would delete every
    // client node and claim success. Absent + a populated client slot = refuse.
    const p = withDb(withService(sandboxPaths())); // no providers.json seeded at all
    expect(readProviderDefsFile(p)).toBeNull();
    const clientText = ['{', '  "providers": { "user-defined": { "package": "x" } }', '}'].join('\n');
    writeClientJsonc(p, clientText);

    const outcome = await pushFromOcr('opencode-v2', new OcrStore({ paths: p, now: () => 1 }), {
      paths: p,
      openDatabase: fakeDb(),
      now: () => 1,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.entries[0]?.action).toBe('failed');
    expect(outcome.entries[0]?.reason).toContain('refusing to REPLACE');
    expect(readJsoncRaw(p)).toBe(clientText); // untouched
    expect(fs.existsSync(`${clientJsoncPath(p)}.bak.ocr-defs`)).toBe(false); // nothing to back up
  });

  it('a CORRUPT defs book is refused the same way (never a silent empty REPLACE)', async () => {
    const p = withDb(withService(sandboxPaths()));
    fs.mkdirSync(path.dirname(getProviderDefsPath(p)), { recursive: true });
    fs.writeFileSync(getProviderDefsPath(p), '{ not json', 'utf8');
    expect(readProviderDefsFile(p)).toBeNull();
    const clientText = ['{', '  "providers": { "acme": { "package": "stale" } }', '}'].join('\n');
    writeClientJsonc(p, clientText);

    const outcome = await pushFromOcr('opencode-v2', new OcrStore({ paths: p, now: () => 1 }), {
      paths: p,
      openDatabase: fakeDb(),
      now: () => 1,
    });
    expect(outcome.ok).toBe(false);
    expect(readJsoncRaw(p)).toBe(clientText);
  });

  it('a valid but EMPTY defs book still REPLACEs (def delete propagation is kept)', async () => {
    const p = withDb(withService(sandboxPaths()));
    seedDefs(p, {}); // the operator deleted every provider
    writeClientJsonc(p, ['{', '  "providers": { "gone": { "package": "x" } }', '}'].join('\n'));

    const outcome = await pushFromOcr('opencode-v2', new OcrStore({ paths: p, now: () => 1 }), {
      paths: p,
      openDatabase: fakeDb(),
      now: () => 1,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.defsChanged).toBe(true);
    const parsed = JSON.parse(readJsoncRaw(p));
    // Every rendered node is gone; an empty slot is removed, not left as `{}`.
    expect(parsed.providers).toBeUndefined();
    // the pre-sync client file is preserved for the operator
    expect(fs.readFileSync(`${clientJsoncPath(p)}.bak.ocr-defs`, 'utf8')).toContain('gone');
  });

  it('a CHANGED def-only render reloads the service once; an unchanged render never does', async () => {
    const p = withDb(withService(sandboxPaths()));
    seedDefs(p, {
      acme: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://acme.test/v1' } },
    });
    writeClientJsonc(p, '{}');
    const reloadPosts: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (String(init?.method ?? 'GET') === 'POST' && url.includes('/api/location/reload')) reloadPosts.push(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const ocr = new OcrStore({ paths: p, now: () => 1 }); // no keys: a pure def-only change

    const first = await pushFromOcr('opencode-v2', ocr, { paths: p, fetchImpl, openDatabase: fakeDb(), now: () => 1 });
    expect(first.ok).toBe(true);
    expect(first.defsMaterialized).toBe(1);
    expect(first.defsChanged).toBe(true);
    expect(first.defsReloaded).toBe(true); // def-only changes reach a RUNNING service
    expect(reloadPosts).toHaveLength(1);

    const second = await pushFromOcr('opencode-v2', ocr, { paths: p, fetchImpl, openDatabase: fakeDb(), now: () => 2 });
    expect(second.defsChanged).toBe(false);
    expect(second.defsReloaded).toBeUndefined();
    expect(reloadPosts).toHaveLength(1); // no change = no reload cost
  });

  it('writes the client config the client actually uses: opencode.json is never shadowed by a stray .jsonc', async () => {
    const p = withDb(withService(sandboxPaths()));
    seedDefs(p, {
      acme: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://acme.test/v1' } },
    });
    const jsonPath = path.join(p.configDir, 'opencode.json');
    fs.writeFileSync(jsonPath, '{}', 'utf8');

    const outcome = await pushFromOcr('opencode-v2', new OcrStore({ paths: p, now: () => 1 }), {
      paths: p,
      openDatabase: fakeDb(),
      now: () => 1,
    });
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(jsonPath, 'utf8')).providers.acme.settings.baseURL).toBe('https://acme.test/v1');
    expect(fs.existsSync(path.join(p.configDir, 'opencode.jsonc'))).toBe(false); // no stray second config
  });
});

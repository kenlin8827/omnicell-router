import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evalSuccessIf, resolveWindows, validateEntry } from '../src/quota/dsl.js';
import { BUILTIN_QUOTA_DECLARATIONS } from '../src/quota/declarations.js';
import { QuotaSnapshotStore } from '../src/quota/store.js';
import { QuotaProbeEntry } from '../src/quota/types.js';
import { ErrorClassifier } from '../src/resilience/error-classifier.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const entryById = (id: string): QuotaProbeEntry => {
  const e = BUILTIN_QUOTA_DECLARATIONS.find((x) => x.id === id);
  assert.ok(e, `built-in entry '${id}' must exist`);
  return e!;
};

/** Run one entry over a synthetic body; headers default to empty. */
const run = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  resolveWindows(entryById(id), body, (h) => headers[h.toLowerCase()] ?? null);

const mkEntry = (over: Partial<QuotaProbeEntry>): QuotaProbeEntry => ({
  id: 't',
  providerId: 't',
  url: 'https://example.com/x',
  auth: 'bearer',
  windows: { form: 'static', windows: [{ name: 'W', used: { path: 'u' }, total: { path: 't' } }] },
  builtin: true,
  ...over,
});

// ─── DSL constructs (each of the 12) ────────────────────────────────────────

describe('quota DSL constructs', () => {
  it('static form: 2-of-3 derivation (used + total -> remaining pct)', () => {
    const r = run('openrouter', { usage: 10, limit: 100, limit_remaining: 90 });
    const w = r.windows.find((x) => x.name === 'Credits')!;
    assert.equal(w.used, 10);
    assert.equal(w.total, 100);
    assert.equal(w.remainingPct, 90);
    assert.equal(w.unlimited, false);
  });

  it('static form: null total reads as unlimited (presence, not a value predicate)', () => {
    const r = run('openrouter', { usage: 5, limit: null, limit_remaining: null });
    const w = r.windows.find((x) => x.name === 'Credits')!;
    // total null + used present -> unlimited true, remainingPct null (no cap).
    assert.equal(w.total, null);
    assert.equal(w.used, 5);
    assert.equal(w.unlimited, true);
    assert.equal(w.remainingPct, null);
  });

  it('firstOf: prefers the first path that resolves', () => {
    const entry = mkEntry({
      windows: {
        form: 'static',
        windows: [{ name: 'X', used: { firstOf: [{ path: 'a' }, { path: 'b' }] }, total: { literal: 100 } }],
      },
    });
    const r = resolveWindows(entry, { b: 42 }, () => null);
    assert.equal(r.windows[0].used, 42);
  });

  it('scale + invertOf: percent from a 0..1 ratio flipped to remaining', () => {
    const entry = mkEntry({
      windows: {
        form: 'static',
        windows: [
          {
            name: 'Ratio',
            // value 0.25 -> scale 100 -> 25 (used) ; then a sibling percent window
            remaining: { path: 'usedRatio', scale: 100, invertOf: 100 },
            total: { literal: 100 },
          },
        ],
      },
    });
    const r = resolveWindows(entry, { usedRatio: 0.25 }, () => null);
    // invertOf(100) - (0.25*100=25) = 75 remaining.
    assert.equal(r.windows[0].remainingPct, 75);
  });

  it('where: each item gated on membership (in)', () => {
    const r = run('zhipuai', {
      data: {
        level: 'pro',
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 20, nextResetTime: 1700000000000 },
          { type: 'NOISE', unit: 3, number: 1, percentage: 99, nextResetTime: 0 },
        ],
      },
    });
    assert.equal(r.windows.length, 1, 'the NOISE row is filtered by where');
    assert.equal(r.windows[0].name, 'Session (5h)');
    assert.equal(r.windows[0].used, 20);
    assert.equal(r.windows[0].remainingPct, 80);
    assert.equal(r.windows[0].resetAt, 1700000000000);
    assert.equal(r.plan, 'GLM pro');
  });

  it('nameTemplate + enumMap: interpolation and fallback', () => {
    const r = run('zhipuai', {
      data: {
        level: 'lite',
        limits: [{ type: 'CREDIT_LIMIT', unit: 9, number: 30, percentage: 0 }],
      },
    });
    assert.equal(r.windows[0].name, 'Limit (30)', 'unmapped unit falls back to template');
    assert.equal(r.windows[0].unlimited, false);
  });

  it('eachObject form: keys enumerated, window name from @key enumMap', () => {
    const r = run('opencode', {
      usage: {
        rolling: { percent: 30, resetsAt: 1700000000000 },
        weekly: { percent: 75, resetsAt: 1700000900000 },
        monthly: { percent: 10, resetsAt: '2026-11-01T00:00:00Z' },
      },
    });
    assert.equal(r.windows.length, 3);
    const weekly = r.windows.find((x) => x.name === 'Weekly')!;
    assert.equal(weekly.used, 75);
    assert.equal(weekly.total, 100);
    assert.equal(weekly.remainingPct, 25);
    const monthly = r.windows.find((x) => x.name === 'Monthly')!;
    assert.equal(monthly.resetAt, Date.parse('2026-11-01T00:00:00Z'));
  });

  it('time construct: seconds/millis/ISO/date-only magnitude detection', () => {
    // 10-digit epoch seconds must be *1000; 13-digit ms passes through.
    const entry = mkEntry({
      windows: {
        form: 'static',
        windows: [
          { name: 'A', used: { literal: 0 }, total: { literal: 100 }, resetAt: { path: 'sec', time: true } },
          { name: 'B', used: { literal: 0 }, total: { literal: 100 }, resetAt: { path: 'ms', time: true } },
        ],
      },
    });
    const r = resolveWindows(entry, { sec: 1700000000, ms: 1700000000000 }, () => null);
    assert.equal(r.windows.find((x) => x.name === 'A')!.resetAt, 1700000000000);
    assert.equal(r.windows.find((x) => x.name === 'B')!.resetAt, 1700000000000);
  });

  it('source: headers — numeric read from a response header', () => {
    const entry = mkEntry({
      windows: { form: 'static', windows: [{ name: 'H', used: { header: 'x-used' }, total: { header: 'x-total' } }] },
    });
    const r = resolveWindows(entry, {}, (h) => ({ 'x-used': '3', 'x-total': '10' })[h.toLowerCase()] ?? null);
    assert.equal(r.windows[0].used, 3);
    assert.equal(r.windows[0].total, 10);
    assert.equal(r.windows[0].remainingPct, 70);
  });

  it('deepseek (each, currency template): credit pool at 100%', () => {
    const r = run('deepseek', {
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '12.50', granted_balance: '0', topped_up_balance: '12.50' }],
    });
    assert.equal(r.windows.length, 1);
    assert.equal(r.windows[0].name, 'Balance (CNY)');
    assert.equal(r.windows[0].used, 0);
    assert.equal(r.windows[0].total, 12.5);
    assert.equal(r.windows[0].remainingPct, 100);
    assert.equal(r.windows[0].unlimited, false);
  });

  it('kimi: object usage.* with where-gate; enumMap plan name', () => {
    const r = run('kimi-code-plan-cn', {
      usage: { limit: 1000, used: 400, remaining: 600, resetTime: 1700000000000 },
      limits: [],
      user: { membership: { level: 'LEVEL_ADVANCED' } },
    });
    assert.equal(r.plan, 'Allegro');
    const weekly = r.windows.find((x) => x.name === 'Weekly')!;
    assert.equal(weekly.used, 400);
    assert.equal(weekly.total, 1000);
    assert.equal(weekly.remainingPct, 60);
  });

  it('kimi: limits[0] yields the 5h session window (string values, ISO reset)', () => {
    const r = run('kimi-code-plan-cn', {
      usage: { limit: '2048', used: '214', remaining: '1834', resetTime: '2026-01-09T15:23:13.716Z' },
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '200', used: '139', remaining: '61', resetTime: '2026-01-06T13:33:02.717Z' },
        },
      ],
      user: { membership: { level: 'LEVEL_BASIC' } },
    });
    const session = r.windows.find((x) => x.nameCode === 'session5h')!;
    assert.ok(session, 'the 300-minute limits row surfaces as the 5h session window');
    assert.equal(session.used, 139);
    assert.equal(session.total, 200);
    assert.equal(session.remainingPct, 30.5);
    assert.equal(session.resetAt, Date.parse('2026-01-06T13:33:02.717Z'));
    // The fixed 7-day window still resolves alongside it (string values coerce).
    const weekly = r.windows.find((x) => x.nameCode === 'weekly7d')!;
    assert.equal(weekly.total, 2048);
  });

  it('kimi: a non-300-minute limits row never wears the session name', () => {
    const r = run('kimi-code-plan-cn', {
      usage: { limit: 100, used: 10 },
      limits: [
        { window: { duration: 10080, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 50, used: 5 } },
      ],
    });
    assert.equal(r.windows.length, 1, 'only the weekly window resolves');
    assert.equal(r.windows[0].nameCode, 'weekly7d');
  });

  it('kimi: descriptor-only 5h row (no detail) drops instead of fabricating', () => {
    const r = run('kimi-code-plan-cn', {
      usage: { limit: 100, used: 10 },
      limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } }],
    });
    assert.equal(r.windows.length, 1, 'no usable fields -> no window, honest absence');
    assert.equal(r.windows[0].nameCode, 'weekly7d');
  });

  it('vercel: total_used + balance -> derived total, percent bar', () => {
    const r = run('vercel', { total_used: '4.50', balance: '95.50' });
    const w = r.windows[0];
    assert.equal(w.used, 4.5);
    assert.equal(w.total, 100);
    assert.equal(w.remainingPct, 95.5);
  });

  it('successIf: single equality gate', () => {
    const entry = mkEntry({ windows: { form: 'static', windows: [{ name: 'W', used: { path: 'u' } }] }, successIf: { path: 'code', eq: 0 } });
    assert.equal(evalSuccessIf(entry, { code: 0, u: 5 }), true);
    assert.equal(evalSuccessIf(entry, { code: 1, u: 5 }), false);
  });

  it('deduplicates colliding window names with an index suffix', () => {
    const entry = mkEntry({
      windows: { form: 'static', windows: [{ name: 'W', used: { path: 'a' }, total: { literal: 10 } }, { name: 'W', used: { path: 'b' }, total: { literal: 10 } }] },
    });
    const r = resolveWindows(entry, { a: 1, b: 2 }, () => null);
    assert.deepEqual(r.windows.map((x) => x.name), ['W', 'W #2']);
  });

  it('nameCode/enumCode: enumMap hit rides the i18n code; argPath value rides as nameArg', () => {
    const r = run('zhipuai', {
      data: { level: 'pro', limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 20, nextResetTime: 1700000000000 }] },
    });
    const w = r.windows[0];
    assert.equal(w.name, 'Session (5h)');
    assert.equal(w.nameCode, 'sessionHours');
    assert.equal(w.nameArg, '5', 'argPath resolves against the bound item (display-only)');
  });

  it('nameCode/enumCode: enumMap miss falls back to fallback + generic code, arg kept', () => {
    const r = run('zhipuai', {
      data: { limits: [{ type: 'CREDIT_LIMIT', unit: 9, number: 30, percentage: 0 }] },
    });
    assert.equal(r.windows[0].name, 'Limit (30)');
    assert.equal(r.windows[0].nameCode, 'limit', 'miss uses the nameSpec code, not the enum key');
    assert.equal(r.windows[0].nameArg, '30');
  });

  it('nameCode: eachObject @key enumCode maps object keys to codes; unmapped keys carry no code', () => {
    const r = run('opencode', {
      usage: {
        rolling: { percent: 10 },
        weekly: { percent: 20 },
        quarterly: { percent: 30 },
      },
    });
    const byName = Object.fromEntries(r.windows.map((w) => [w.name, w]));
    assert.equal(byName['Rolling'].nameCode, 'rolling');
    assert.equal(byName['Weekly'].nameCode, 'weekly');
    assert.equal(byName['quarterly'].nameCode, undefined, 'unmapped key shows verbatim, codeless');
  });

  it('nameCode: template code + argPath (deepseek currency) and static passthrough (openrouter)', () => {
    const ds = run('deepseek', { balance_infos: [{ currency: 'USD', total_balance: '7' }] });
    assert.equal(ds.windows[0].name, 'Balance (USD)');
    assert.equal(ds.windows[0].nameCode, 'balance');
    assert.equal(ds.windows[0].nameArg, 'USD');
    const or = run('openrouter', { usage: 1, limit: 2 });
    assert.equal(or.windows[0].nameCode, 'credits', 'static window nameCode passes through');
    assert.equal(or.windows[0].nameArg, undefined);
  });

  it('argPath miss: unresolvable path yields no nameArg (window unaffected)', () => {
    const entry = mkEntry({
      windows: {
        form: 'static',
        windows: [
          { nameSpec: { template: 'Pool', code: 'pool', argPath: 'currency' }, used: { path: 'u' }, total: { literal: 10 } },
        ],
      },
    });
    const r = resolveWindows(entry, { u: 1 }, () => null);
    assert.equal(r.windows[0].name, 'Pool');
    assert.equal(r.windows[0].nameCode, 'pool');
    assert.equal(r.windows[0].nameArg, undefined);
  });

  it('name code validation: enumCode with a non-string value / unknown name keys reject the entry', () => {
    const badCode = mkEntry({
      windows: {
        form: 'static',
        windows: [{ nameSpec: { from: 'f', enumMap: { a: 'A' }, enumCode: { a: 5 } as any, fallback: 'F' }, used: { path: 'u' } }],
      },
    });
    assert.match(validateEntry(badCode) ?? '', /enumCode\[a\] must be a string/);
    const badKey = mkEntry({
      windows: {
        form: 'static',
        windows: [{ nameSpec: { template: 'T', i18nKey: 'x' } as any, used: { path: 'u' } }],
      },
    });
    assert.match(validateEntry(badKey) ?? '', /unknown name key/);
  });
});

// ─── Loader validation: the five banned classes ─────────────────────────────

describe('quota DSL loader validation (banned classes)', () => {
  it('arithmetic expression smuggled as an unknown field key -> reject', () => {
    const bad = mkEntry({
      windows: { form: 'static', windows: [{ name: 'W', used: { path: 'a', add: 5 } as any }] },
    });
    assert.match(validateEntry(bad) ?? '', /unknown field key/);
  });

  it('value-comparison predicate in where -> reject', () => {
    const bad = mkEntry({
      windows: { form: 'static', windows: [{ name: 'W', used: { path: 'a', gt: 3 } as any }] },
    });
    assert.match(validateEntry(bad) ?? '', /unknown field key/);
  });

  it('where with a gt operator -> reject (banned predicate)', () => {
    const bad = mkEntry({
      windows: { form: 'static', windows: [{ name: 'W', where: { path: 'a', gt: 3 } as any, used: { path: 'b' } }] },
    });
    assert.match(validateEntry(bad) ?? '', /unknown where key/);
  });

  it('where with two operators set -> reject', () => {
    const bad = mkEntry({
      windows: { form: 'static', windows: [{ name: 'W', where: { path: 'a', eq: 1, in: [1, 2] }, used: { path: 'b' } }] },
    });
    assert.match(validateEntry(bad) ?? '', /exactly one of exists\/eq\/in/);
  });

  it('header value interpolation -> reject', () => {
    const bad = mkEntry({ headers: { 'X-Key': '{secret}' } });
    assert.match(validateEntry(bad) ?? '', /interpolation \(banned/);
  });

  it('method field (multi-URL / POST class) -> reject', () => {
    const bad = mkEntry({ url: 'https://x' });
    (bad as any).method = 'POST';
    assert.match(validateEntry(bad) ?? '', /unknown/);
  });

  it('nested firstOf -> reject', () => {
    const bad = mkEntry({
      windows: { form: 'static', windows: [{ name: 'W', used: { firstOf: [{ firstOf: [{ path: 'a' }] }] } }] },
    });
    assert.match(validateEntry(bad) ?? '', /nested firstOf/);
  });

  it('path traversal marker -> reject', () => {
    const bad = mkEntry({
      windows: { form: 'static', windows: [{ name: 'W', used: { path: '../../etc' } }] },
    });
    assert.match(validateEntry(bad) ?? '', /traversal/);
  });

  it('prototype-path access is neutralized during resolve', () => {
    const entry = mkEntry({
      windows: { form: 'static', windows: [{ name: 'W', used: { path: '__proto__.polluted' }, total: { literal: 1 } }] },
    });
    (Object.prototype as any).polluted = 999;
    try {
      const r = resolveWindows(entry, {}, () => null);
      // The window may still exist (built from the literal total), but the
      // polluted path must resolve to NOTHING — never 999.
      assert.equal(r.windows[0]?.used ?? null, null, 'prototype pollution path never resolves to a value');
    } finally {
      delete (Object.prototype as any).polluted;
    }
  });

  it('a valid entry passes validation', () => {
    assert.equal(validateEntry(mkEntry({})), null);
  });
});

// ─── QuotaSnapshotStore: staleness discipline ───────────────────────────────

describe('quota snapshot store', () => {
  it('badge state: fresh -> probed, past ttl -> stale, failure keeps old values', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-quota-'));
    const store = new QuotaSnapshotStore({ paths: { ocrHome: tmp } as any, now: () => 1_000_000 });
    store.put({
      providerId: 'p',
      keyHashPrefix: 'abc',
      windows: [{ name: 'W', used: 1, total: 10, remainingPct: 90, resetAt: null, unlimited: false }],
      source: 'probed',
      verifiedAt: 1_000_000,
      entryId: 'p',
    });
    assert.equal(store.badgeState('p', 'abc', 60_000, 1_000_000 + 1000), 'probed');
    assert.equal(store.badgeState('p', 'abc', 60_000, 1_000_000 + 61_000), 'stale');
    // Failure: old values survive, staleness flag flips.
    store.markFailure('p', 'abc');
    const snap = store.get('p', 'abc')!;
    assert.equal(snap.windows.length, 1, 'failure never clears the snapshot');
    assert.equal(store.badgeState('p', 'abc', 60_000, 1_000_000), 'stale');
    // declared source renders the `declared` badge.
    store.put({ providerId: 'd', keyHashPrefix: 'x', windows: [], source: 'declared', verifiedAt: 0, entryId: 'd' });
    assert.equal(store.badgeState('d', 'x', 60_000, 1_000_000), 'declared');
    // unknown pair -> unverified.
    assert.equal(store.badgeState('none', 'z', 60_000, 1_000_000), 'unverified');
    store.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('round-trips through the durable file (load-once re-read)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-quota-'));
    const paths = { ocrHome: tmp } as any;
    const a = new QuotaSnapshotStore({ paths, now: () => 5 });
    a.put({ providerId: 'p', keyHashPrefix: 'k', windows: [{ name: 'W', used: 0, total: 1, remainingPct: 100, resetAt: null, unlimited: false }], source: 'probed', verifiedAt: 5, entryId: 'p' });
    a.flush();
    const b = new QuotaSnapshotStore({ paths });
    assert.equal(b.get('p', 'k')?.windows[0].name, 'W');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('putMeasured: fills absence, refreshes measured, refuses probed/forked/declared', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-quota-'));
    const store = new QuotaSnapshotStore({ paths: { ocrHome: tmp } as any, now: () => 1_000_000 });
    const mk = (source: string, entryId: string) => ({
      providerId: 'p',
      keyHashPrefix: 'k',
      windows: [{ name: 'W', used: 1, total: 10, remainingPct: 90, resetAt: null, unlimited: false }],
      source: source as any,
      verifiedAt: 100,
      entryId,
    });
    // Absent pair accepts the passive write.
    assert.equal(store.putMeasured(mk('measured', 'headers')), true);
    assert.equal(store.get('p', 'k')?.entryId, 'headers');
    // Measured refreshes its own kind.
    assert.equal(store.putMeasured(mk('measured', 'headers')), true);
    // Endpoint-verified knowledge of every flavor outranks the passive channel.
    for (const [source, entryId] of [
      ['probed', 'deepseek'],
      ['forked', 'override:x'],
      ['declared', 'plan-cap'],
    ] as const) {
      store.put(mk(source, entryId));
      assert.equal(store.putMeasured(mk('measured', 'headers')), false, `${source} outranks measured`);
      assert.equal(store.get('p', 'k')?.source, source, 'existing snapshot untouched');
      assert.equal(store.get('p', 'k')?.entryId, entryId);
    }
    // Cleared pair accepts again (absence is not endpoint knowledge).
    store.clear('p', 'k');
    assert.equal(store.putMeasured(mk('measured', 'headers')), true);
    store.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('recordHttp/getLastHttp: memory-only ring of one, never persisted', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-quota-'));
    const paths = { ocrHome: tmp } as any;
    const a = new QuotaSnapshotStore({ paths, now: () => 1_000_000 });
    a.recordHttp('p#k', { url: 'https://x.example/usage', status: 200, ok: true, body: { secret: 1 } });
    assert.equal(a.getLastHttp('p#k')?.status, 200);
    a.recordHttp('p#k', { url: 'https://x.example/usage', status: 500, ok: false });
    assert.equal(a.getLastHttp('p#k')?.ok, false, 'ring of one: the latest exchange replaces');
    assert.equal(a.getLastHttp('other#k'), undefined, 'unknown pair has nothing');
    // Snapshots persist; the raw capture must not.
    a.put({ providerId: 'p', keyHashPrefix: 'k', windows: [], source: 'probed', verifiedAt: 1, entryId: 'p' });
    a.flush();
    const raw = fs.readFileSync(a.filePath, 'utf8');
    assert.ok(raw.includes('"p#k"'), 'snapshot file holds the pair');
    assert.ok(!raw.includes('https://x.example/usage'), 'capture never reaches the snapshot file');
    // A fresh process on the same paths: snapshots reload, capture is gone.
    const b = new QuotaSnapshotStore({ paths });
    assert.ok(b.get('p', 'k'), 'snapshot reloads');
    assert.equal(b.getLastHttp('p#k'), undefined, 'memory-only: no capture until the next probe');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ─── Error classifier: CN ceiling markers (linkage) ─────────────────────────

describe('error classifier quota markers', () => {
  it('CN quota / session-cap wording classifies as QUOTA_EXHAUSTED', () => {
    const a = ErrorClassifier.classify({ message: '您的额度已用完' }, 'p/m', 'p');
    assert.equal(a.category, 'QUOTA_EXHAUSTED');
    const b = ErrorClassifier.classify({ message: '触发会话频控，请稍后再试' }, 'p/m', 'p');
    assert.equal(b.category, 'QUOTA_EXHAUSTED');
    const c = ErrorClassifier.classify({ message: 'Allocated quota exceeded' }, 'p/m', 'p');
    assert.equal(c.category, 'QUOTA_EXHAUSTED');
  });
});

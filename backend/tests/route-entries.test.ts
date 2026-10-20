import { describe, it, beforeEach, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RouteEntryStore,
  applyRouteEntriesConfig,
  normalizePrompt,
  promptHashOf,
  setRouteEntryStoreForTests,
} from '../src/router/route-entries.js';

/**
 * RouteEntry experience table (ADR-0011) — store semantics on an isolated
 * temp file: normalization/hash stability, the write-priority ladder
 * (human > correction > l2_confident), session LRU bookkeeping, snippet
 * gating and cap eviction. The module-level gate is pointed at explicit
 * values so the operator's real config can never leak into a run.
 */

let dir = '';

describe('prompt identity', () => {
  it('normalizes whitespace and hashes stably', () => {
    assert.equal(normalizePrompt('  a \n\t b  '), 'a b');
    const h1 = promptHashOf('What is the capital of France?');
    const h2 = promptHashOf('  What   is\nthe capital of France?  ');
    assert.equal(h1, h2);
    assert.equal(h1.length, 16);
    assert.notEqual(h1, promptHashOf('What is the capital of Germany?'));
  });
});

describe('RouteEntryStore', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-route-entries-'));
    setRouteEntryStoreForTests(null);
    applyRouteEntriesConfig({ enabled: true, snippetEnabled: true, maxEntries: 5000 });
  });

  afterAll(() => {
    setRouteEntryStoreForTests(null);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sandbox */ }
  });

  function newStore(): RouteEntryStore {
    return new RouteEntryStore(path.join(dir, `re-${Math.random().toString(36).slice(2)}.json`));
  }

  it('upsert creates, hit counts and bubbles sessions (LRU cap 20)', () => {
    const store = newStore();
    const hash = promptHashOf('write me a distributed lock in Go');
    store.upsert({ promptHash: hash, tier: 'plus', source: 'l2_confident', confidence: 0.9 }, 's1');
    for (let i = 2; i <= 25; i++) store.hit(hash, `s${i}`);
    const entry = store.peek(hash)!;
    assert.equal(entry.hitCount, 24); // creation doesn't count, 24 hits did
    assert.equal(entry.sessions.length, 20);
    assert.equal(entry.sessions[0], 's25'); // most recent first
    assert.ok(!entry.sessions.includes('s1')); // evicted from the LRU tail
    // Creation also registered: hit from a fresh store round-trips the file.
    store.saveNow();
    const reloaded = new RouteEntryStore((store as unknown as { filePath: string }).filePath);
    assert.equal(reloaded.peek(hash)!.hitCount, 24);
  });

  it('correction outranks l2_confident; human is immune to automatic writes', () => {
    const store = newStore();
    const hash = 'h-correction';
    store.upsert({ promptHash: hash, tier: 'plus', source: 'l2_confident', confidence: 0.88 });
    store.upsert({ promptHash: hash, tier: 'pro', source: 'correction', confidence: 1.0 });
    assert.equal(store.peek(hash)!.tier, 'pro');
    assert.equal(store.peek(hash)!.source, 'correction');
    // l2_confident can NOT drag a correction row back down.
    store.upsert({ promptHash: hash, tier: 'plus', source: 'l2_confident', confidence: 0.99 });
    assert.equal(store.peek(hash)!.tier, 'pro');
    // Human edit freezes the row against every automatic producer.
    store.humanEdit(hash, 'ultra');
    const human = store.peek(hash)!;
    assert.equal(human.source, 'human');
    assert.equal(human.confidence, 1.0);
    store.upsert({ promptHash: hash, tier: 'lite', source: 'correction', confidence: 1.0 });
    assert.equal(store.peek(hash)!.tier, 'ultra');
    // …but another human edit (console) may still change it, and remove clears it.
    store.humanEdit(hash, 'lite');
    assert.equal(store.peek(hash)!.tier, 'lite');
    assert.ok(store.remove(hash));
    assert.equal(store.peek(hash), undefined);
  });

  it('snippet follows snippetEnabled for NEW rows; stored snippets survive the switch', () => {
    const store = newStore();
    const on = store.upsert({ promptHash: 'h1', tier: 'plus', source: 'l2_confident', confidence: 0.9, snippet: 'hello world' });
    assert.equal(on.snippet, 'hello world');
    applyRouteEntriesConfig({ snippetEnabled: false });
    const off = store.upsert({ promptHash: 'h2', tier: 'plus', source: 'l2_confident', confidence: 0.9, snippet: 'secret-ish' });
    assert.equal(off.snippet, undefined);
    // existing snippet is untouched by the flag (gates NEW snippets only)
    const bumped = store.upsert({ promptHash: 'h1', tier: 'pro', source: 'correction', confidence: 1.0, snippet: 'ignored' });
    assert.equal(bumped.snippet, 'hello world');
    applyRouteEntriesConfig({ snippetEnabled: true });
  });

  it('evicts lowest-updatedAt rows beyond maxEntries', () => {
    applyRouteEntriesConfig({ maxEntries: 3 });
    const store = newStore();
    for (let i = 0; i < 5; i++) {
      store.upsert({ promptHash: `h${i}`, tier: 'plus', source: 'l2_confident', confidence: 0.9 });
      // give each row a distinct updatedAt
      const e = store.peek(`h${i}`)!;
      e.updatedAt = 1000 + i;
    }
    assert.equal(store.list().total, 3);
    assert.ok(store.peek('h0') === undefined); // oldest evicted
    assert.ok(store.peek('h4') !== undefined);
    applyRouteEntriesConfig({ maxEntries: 5000 });
  });

  it('humanEdit on an unknown hash is a no-op (no ghost rows from the console)', () => {
    const store = newStore();
    assert.equal(store.humanEdit('missing', 'pro'), undefined);
    assert.equal(store.list().total, 0);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RespNode, RespStore } from '../../src/session/resp-store.js';

/**
 * L2 recovery-log tests for RespStore:
 * restart round-trip, TTL/malformed/oversized replay filters, fail-soft
 * writes, compaction budgets, clear non-resurrection. Every store here is a
 * standalone instance — the surface singleton is untouched.
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-resp-persist-'));
}

function node(id: string, parent: string | null, content: string, createdAt = Date.now(), sessionId = 'sess_t'): RespNode {
  return {
    v: 2,
    id,
    parent,
    sessionId,
    model: 'mock-model',
    input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: content }] }],
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: `a-${content}` }] }],
    createdAt,
  };
}

function texts(items: RespNode['input']): string[] {
  return items.map((item) => item.type === 'message'
    ? item.content.map((part) => part.type === 'text' ? part.text : '').join('')
    : '');
}

describe('RespStore L2 recovery log', () => {
  it('survives a simulated restart: chain + tree branches rebuild', async () => {
    const file = path.join(tmpDir(), 'chain.jsonl');
    const a = new RespStore();
    a.enablePersistence({ filePath: file });
    a.append(node('r1', null, 'one'));
    a.append(node('r2', 'r1', 'two'));
    a.append(node('r3', 'r1', 'two-alt')); // branch from the same parent
    await a.flushPersistence();

    const b = new RespStore();
    const stats = b.enablePersistence({ filePath: file });
    assert.strictEqual(stats.loaded, 3);
    assert.strictEqual(stats.malformed, 0);

    const rebuilt = b.buildInput('r2');
    assert.ok(rebuilt);
    // The rebuilt canonical input includes the parent's delta and assistant output.
    assert.deepStrictEqual(texts(rebuilt.input), ['one', 'a-one', 'two', 'a-two']);
    const alt = b.buildInput('r3');
    assert.ok(alt);
    assert.strictEqual(alt.input.length, 4); // tree branch intact
    assert.strictEqual(texts(alt.input)[2], 'two-alt');
  });

  it('replay drops TTL-expired nodes', async () => {
    const file = path.join(tmpDir(), 'chain.jsonl');
    const fresh = JSON.stringify(node('r1', null, 'ok'));
    const stale = JSON.stringify(node('r2', 'r1', 'old', Date.now() - 25 * 60 * 60 * 1000));
    fs.writeFileSync(file, `${fresh}\n${stale}\n`);

    const s = new RespStore();
    const stats = s.enablePersistence({ filePath: file });
    assert.strictEqual(stats.loaded, 1);
    assert.strictEqual(stats.expired, 1);
    assert.strictEqual(s.get('r2'), undefined);
  });

  it('torn or corrupt lines are skipped, never block boot', () => {
    const file = path.join(tmpDir(), 'chain.jsonl');
    const good = JSON.stringify(node('r1', null, 'ok'));
    fs.writeFileSync(file, [good, 'not json at all', '{"id":"ra'].join('\n') + '\n'); // torn tail (crash mid-append)

    const s = new RespStore();
    const stats = s.enablePersistence({ filePath: file });
    assert.strictEqual(stats.loaded, 1);
    assert.strictEqual(stats.malformed, 2);
    assert.ok(s.get('r1'));
  });

  it('oversized nodes: runtime skip (L1 keeps them) and replay skip', async () => {
    const file = path.join(tmpDir(), 'chain.jsonl');
    const s = new RespStore();
    s.enablePersistence({ filePath: file, maxNodeBytes: 400 });
    s.append(node('small', null, 'fits'));
    s.append(node('big', 'small', 'x'.repeat(5000)));
    await s.flushPersistence();

    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.includes('"small"'));
    assert.ok(!raw.includes('"big"'));
    assert.ok(s.buildInput('small')); // L1 unaffected by the skip

    const t = new RespStore();
    const stats = t.enablePersistence({ filePath: file, maxNodeBytes: 400 });
    assert.strictEqual(stats.loaded, 1);
    assert.strictEqual(stats.oversized, 0); // line never made it to disk
  });

  it('a failing disk write never fails the request path', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'chain.jsonl');
    fs.mkdirSync(file); // path occupied by a DIRECTORY: reads and appends both fail

    const s = new RespStore();
    const stats = s.enablePersistence({ filePath: file }); // must not throw
    assert.strictEqual(stats.loaded, 0);
    s.append(node('r1', null, 'ok')); // must not throw
    await s.flushPersistence(); // must resolve despite the failed write
    assert.ok(s.buildInput('r1')); // L1 is the authority
  });

  it('compaction trims to the byte budget (oldest first)', async () => {
    const file = path.join(tmpDir(), 'chain.jsonl');
    const s = new RespStore();
    const createdAt = Date.now();
    const first = node('r1', null, 'one', createdAt);
    const second = node('r2', 'r1', 'two', createdAt + 1);
    const third = node('r3', 'r2', 'three', createdAt + 2);
    const retainedBytes = [second, third]
      .reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry) + '\n'), 0);
    // Fit exactly the newest two records, independent of canonical field sizes.
    s.enablePersistence({ filePath: file, maxTotalMB: retainedBytes / (1024 * 1024) });
    s.append(first);
    s.append(second);
    s.append(third);
    await s.flushPersistence();
    await s.compact();

    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.includes('"id":"r3"'), 'newest survives the budget trim');
    assert.ok(!raw.includes('"id":"r1"'), 'oldest is trimmed first');

    const t = new RespStore();
    assert.strictEqual(t.enablePersistence({ filePath: file }).loaded, 2);
  });

  it('clear() does not resurrect conversations on the next boot', async () => {
    const file = path.join(tmpDir(), 'chain.jsonl');
    const s = new RespStore();
    s.enablePersistence({ filePath: file });
    s.append(node('r1', null, 'one'));
    await s.flushPersistence();
    s.clear();
    await s.compact(); // joins the clear-triggered rewrite deterministically

    const t = new RespStore();
    assert.strictEqual(t.enablePersistence({ filePath: file }).loaded, 0);
  });

  it('deleteBySession purges ONE session (memory + recovery log), leaving other chains intact', async () => {
    const file = path.join(tmpDir(), 'chain.jsonl');
    const s = new RespStore();
    s.enablePersistence({ filePath: file });
    s.append(node('r1', null, 'one', Date.now(), 'sess_a'));
    s.append(node('r2', 'r1', 'two', Date.now(), 'sess_a'));
    s.append(node('r9', null, 'other', Date.now(), 'sess_b'));
    await s.flushPersistence();

    assert.strictEqual(s.deleteBySession('sess_a'), 2);
    assert.strictEqual(s.size, 1);
    assert.equal(s.buildInput('r2'), null, 'the purged chain cannot resolve a parent');
    assert.ok(s.buildInput('r9'), 'another session\'s chain is untouched');
    assert.strictEqual(s.deleteBySession('sess_a'), 0, 'idempotent');

    // The purge compacts fire-and-forget; `compact()` joins the in-flight run
    // deterministically (it awaits the same promise the purge started).
    await s.compact();

    const t = new RespStore();
    assert.deepStrictEqual(
      [t.enablePersistence({ filePath: file }).loaded, t.get('r9')?.id],
      [1, 'r9'],
      'the purged conversation is not replayed on the next boot',
    );
  });
});

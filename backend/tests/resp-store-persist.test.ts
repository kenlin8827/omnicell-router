import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RespNode, RespStore } from '../src/session/resp-store.js';

/**
 * L2 recovery-log tests for RespStore (ADR-0015 amendment 2026-10-13):
 * restart round-trip, TTL/malformed/oversized replay filters, fail-soft
 * writes, compaction budgets, clear non-resurrection. Every store here is a
 * standalone instance — the surface singleton is untouched.
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-resp-persist-'));
}

function node(id: string, parent: string | null, content: string, createdAt = Date.now()): RespNode {
  return {
    id,
    parent,
    sessionId: 'sess_t',
    model: 'mock-model',
    input: [{ role: 'user', content }],
    assistant: { role: 'assistant', content: `a-${content}` },
    createdAt,
  };
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

    const rebuilt = b.buildMessages('r2');
    assert.ok(rebuilt);
    // buildMessages(parentId) returns everything THROUGH the parent turn
    // (its input delta AND its assistant reply); the caller appends the
    // current turn's delta on top — frozen step-3b semantics.
    assert.deepStrictEqual(
      rebuilt.messages.map((m) => `${m.role}:${m.content}`),
      ['user:one', 'assistant:a-one', 'user:two', 'assistant:a-two']
    );
    const alt = b.buildMessages('r3');
    assert.ok(alt);
    assert.strictEqual(alt.messages.length, 4); // tree branch intact
    assert.strictEqual(alt.messages[2].content, 'two-alt');
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
    assert.ok(s.buildMessages('small')); // L1 unaffected by the skip

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
    assert.ok(s.buildMessages('r1')); // L1 is the authority
  });

  it('compaction trims to the byte budget (oldest first)', async () => {
    const file = path.join(tmpDir(), 'chain.jsonl');
    const s = new RespStore();
    // ~524B budget: three ~220B lines cannot all fit — the oldest must go.
    s.enablePersistence({ filePath: file, maxTotalMB: 0.0005 });
    s.append(node('r1', null, 'one'));
    s.append(node('r2', 'r1', 'two'));
    s.append(node('r3', 'r2', 'three'));
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
});

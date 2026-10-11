import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FlywheelDataset } from '../src/flywheel/dataset.js';
import { FLYWHEEL_SCHEMA_VERSION, FlywheelRecord } from '../src/flywheel/schema.js';

/**
 * Regression tests for the dataset reader's byte-offset integrity: line
 * offsets are FILE BYTE offsets, so the indexing pass must split chunks and
 * lines in bytes, never in JS string positions — prompts are multibyte UTF-8
 * and the two diverge the moment non-ASCII text appears. When they diverged,
 * every row after the first non-ASCII character failed to re-read in
 * `readRow()` and silently vanished from the console list while `total` still
 * counted it ("3 samples, empty list").
 */
describe('FlywheelDataset byte-offset integrity (multibyte prompts)', () => {
  const tmpDir = path.resolve(process.cwd(), './data/test_fw_dataset');
  const datasetPath = path.join(tmpDir, 'flywheel.jsonl');
  // Mirror of the private READ_CHUNK in dataset.ts — the boundary craft below
  // depends on the exact first-chunk size.
  const READ_CHUNK = 4 * 1024 * 1024;

  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRecord(i: number, prompt: string) {
    return {
      v: FLYWHEEL_SCHEMA_VERSION,
      id: `rec_${i}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, i % 60)).toISOString(),
      input: {
        userPrompt: prompt,
        featureVector: [0.1 * i, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
        featureNames: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'],
        tokenCount: 100 + i,
        turnCount: 1,
      },
      decision: { targetTier: 'plus', confidence: 0.4, layerUsed: 'layer0', reason: 'baseline' },
      execution: {
        tierUsed: 'plus',
        modelUsed: 'test-model',
        fallbackOccurred: false,
        costUsd: 0.001,
        latencyMs: 100,
        isSynthetic: false,
      },
      label: { tier: 'plus', source: 'observed_execution', confidence: 0.5, overridden: false, isNegativeForLite: false },
      trainable: true,
    } satisfies FlywheelRecord;
  }

  const QUERY = { limit: 25, offset: 0, tier: 'any' as const, source: 'any' as const, includeSynthetic: false, trainableOnly: false };

  it('returns every row of a multibyte dataset and round-trips prompts exactly', () => {
    const lines = [
      JSON.stringify(makeRecord(0, '你好，请帮我写一个快速排序算法')),
      JSON.stringify(makeRecord(1, '解释一下 TypeScript 的类型体操 —— 比如 conditional types')),
      JSON.stringify(makeRecord(2, 'plain ASCII prompt')),
    ];
    fs.writeFileSync(datasetPath, lines.join('\n') + '\n', 'utf8');

    const ds = new FlywheelDataset(datasetPath);
    const res = ds.query(QUERY);

    assert.strictEqual(res.total, 3);
    assert.strictEqual(res.rows.length, 3, 'rows must not be dropped for multibyte content');
    // newest-first
    assert.strictEqual(res.rows[0].userPrompt, 'plain ASCII prompt');
    assert.strictEqual(res.rows[1].userPrompt, '解释一下 TypeScript 的类型体操 —— 比如 conditional types');
    assert.strictEqual(res.rows[2].userPrompt, '你好，请帮我写一个快速排序算法');
  });

  it('keeps the last row readable when the file ends with a torn line', () => {
    const lines = [
      JSON.stringify(makeRecord(0, '第一条中文记录')),
      JSON.stringify(makeRecord(1, '第二条中文记录')),
    ];
    fs.writeFileSync(datasetPath, lines.join('\n') + '\n', 'utf8');
    // crash mid-append: a half-written line with no trailing newline
    fs.appendFileSync(datasetPath, '{"v":2,"id":"torn_trunc', 'utf8');

    const ds = new FlywheelDataset(datasetPath);
    const res = ds.query(QUERY);

    assert.strictEqual(res.total, 2);
    assert.strictEqual(res.rows.length, 2, 'torn tail must not glue onto the last record');
    assert.strictEqual(res.rows[0].id, 'rec_1');
    assert.strictEqual(res.rows[0].userPrompt, '第二条中文记录');
  });

  it('survives a chunk boundary that splits a multibyte character mid-sequence', () => {
    // Deterministic boundary craft: the LAST byte of the first 4 MiB
    // READ_CHUNK read is the LEAD byte of a 3-byte Chinese character, so its
    // continuation bytes land in the second chunk. The old string-based carry
    // decoded the two halves independently (U+FFFD) and drifted every later
    // offset; the byte-based reader must reunite them and keep every row.
    const lines: string[] = [];
    let offset = 0; // byte offset of the next line start
    let i = 0;
    const push = (prompt: string): void => {
      const s = JSON.stringify(makeRecord(i, prompt));
      lines.push(s);
      offset += Buffer.byteLength(s, 'utf8') + 1; // + '\n'
      i++;
    };
    // ASCII filler up to just before the boundary.
    while (offset < READ_CHUNK - 4096) push(`filler ascii row #${i}`);

    // The straddling record: pad with ASCII so the '中' lead byte lands
    // exactly on READ_CHUNK - 1. Every char before it is ASCII, so the string
    // index of '中' equals its byte offset within the line.
    let straddlePrompt = '';
    for (;;) {
      const leadIdx = JSON.stringify(makeRecord(i, '中')).indexOf('中');
      const pad = READ_CHUNK - 1 - offset - leadIdx;
      if (pad >= 0) {
        straddlePrompt = 'a'.repeat(pad) + '中' + 'b'.repeat(3);
        push(straddlePrompt);
        break;
      }
      push(`filler ascii row #${i}`);
    }
    // Multibyte rows past the boundary pin offset continuity after the split.
    while (offset < READ_CHUNK + 256 * 1024) push(`边界之后的中文行 #${i}`);
    fs.writeFileSync(datasetPath, lines.join('\n') + '\n', 'utf8');

    // Byte-level pin of the fixture shape — assert the split, don't assume it.
    const raw = fs.readFileSync(datasetPath);
    assert.strictEqual(raw[READ_CHUNK - 1], 0xe4, 'last byte of chunk 1 must be the lead byte of 中');
    assert.ok(raw[READ_CHUNK] >= 0x80 && raw[READ_CHUNK + 1] >= 0x80, 'continuation bytes of 中 must sit in chunk 2');

    const n = lines.length;
    const ds = new FlywheelDataset(datasetPath);
    const first = ds.query({ ...QUERY, limit: 500, offset: 0 });
    assert.strictEqual(first.total, n, 'no row may vanish across the split boundary');

    // Walk every page: no prompt may carry U+FFFD, and the record whose
    // character straddles the boundary must round-trip exactly.
    let seen = 0;
    let straddleExact = false;
    for (let off = 0; off < n; off += 500) {
      const page = ds.query({ ...QUERY, limit: 500, offset: off });
      assert.strictEqual(page.rows.length, Math.min(500, n - off));
      for (const row of page.rows) {
        assert.ok(!row.userPrompt.includes('\uFFFD'), 'no replacement chars — the split character was reunited across chunks');
        if (row.userPrompt === straddlePrompt) straddleExact = true;
      }
      seen += page.rows.length;
    }
    assert.strictEqual(seen, n);
    assert.ok(straddleExact, 'the straddling record round-trips byte-exactly');

    // deep page on a fully-indexed large file — past the offset, the oldest
    // rows come back first (the walk is newest-first)
    const deep = ds.query({ ...QUERY, limit: 3, offset: n - 3 });
    assert.strictEqual(deep.rows.length, 3);
    assert.deepStrictEqual(deep.rows.map(r => r.id), ['rec_2', 'rec_1', 'rec_0']);

    // incremental append after the initial cold pass
    fs.appendFileSync(datasetPath, JSON.stringify(makeRecord(n, '增量追加的中文记录')) + '\n', 'utf8');
    const after = ds.query({ ...QUERY, limit: 5 });
    assert.strictEqual(after.total, n + 1);
    assert.strictEqual(after.rows[0].userPrompt, '增量追加的中文记录');
  });
});

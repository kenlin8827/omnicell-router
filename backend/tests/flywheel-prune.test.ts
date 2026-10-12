import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyRetention,
  deleteRecordsById,
  planPrune,
  pruneDataset,
  pruneLabelOverlay,
  resetDataset,
  rotateBackups,
  labelsPathFor,
  sidecarPathFor,
} from '../src/flywheel/prune.js';
import { FlywheelCollector } from '../src/flywheel/collector.js';
import { FlywheelDataset } from '../src/flywheel/dataset.js';
import { FlywheelTrainer } from '../src/flywheel/trainer.js';
import { FLYWHEEL_SCHEMA_VERSION } from '../src/flywheel/schema.js';

/**
 * Engine-level acceptance tests for the flywheel lifecycle engine (design doc
 * QA-1): dry-run purity, byte-identical survivors, the D3 backup matrix,
 * sidecar append, overlay orphan purge on all four paths, and the retention
 * semantics (age cutoff, size trim oldest-first, default-off backward
 * compat, negative clamp, unparseable-ts kept, missing-file no-op).
 */

const tmpDir = path.resolve(process.cwd(), './data/test_fw_prune');
const datasetPath = path.join(tmpDir, 'flywheel.jsonl');
const labelsPath = labelsPathFor(datasetPath);
const sidecarPath = sidecarPathFor(datasetPath);

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Minimal v2 record with a controllable id / age / synthetic flag. */
function v2(id: string, opts: { days?: number; synthetic?: boolean; prompt?: string } = {}): Record<string, unknown> {
  return {
    v: FLYWHEEL_SCHEMA_VERSION,
    id,
    timestamp: daysAgoISO(opts.days ?? 0),
    input: {
      userPrompt: opts.prompt ?? `prompt ${id}`,
      featureVector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
      featureNames: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'],
      tokenCount: 10,
      turnCount: 1,
    },
    decision: { targetTier: 'plus', confidence: 0.4, layerUsed: 'layer0', reason: 'baseline' },
    execution: {
      tierUsed: 'plus',
      modelUsed: 'test-model',
      fallbackOccurred: false,
      latencyMs: 100,
      isSynthetic: opts.synthetic === true,
    },
    label: { tier: 'plus', source: 'observed_execution', confidence: 0.5, overridden: false, isNegativeForLite: false },
    trainable: true,
  };
}

/** Legacy v1 row — no feature vector, not prune-legacy-eligible by default. */
function v1(id: string): Record<string, unknown> {
  return {
    v: 1,
    id,
    timestamp: daysAgoISO(0),
    userPrompt: `legacy ${id}`,
    tokenCount: 5,
    routing: { targetTier: 'lite', layerUsed: 'layer0' },
    execution: { tierUsed: 'lite', modelUsed: 'test-model', fallbackOccurred: false },
    label: { labelSource: 'observed_execution' },
  };
}

function writeDataset(lines: string[]): string {
  const raw = lines.join('\n') + '\n';
  fs.writeFileSync(datasetPath, raw, 'utf8');
  return raw;
}

function readOverlay(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
  } catch {
    return {};
  }
}

function writeOverlay(map: Record<string, unknown>): void {
  fs.writeFileSync(labelsPath, JSON.stringify(map, null, 2), 'utf8');
}

const labelEntry = { tier: 'pro', updatedAt: '2026-01-01T00:00:00.000Z' };

describe('flywheel prune engine (QA-1)', () => {
  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- planPrune: pure, zero fs --------------------------------------------

  it('planPrune is a pure planner: counts, keeps survivors verbatim, touches no fs', () => {
    const dupLine = line(v2('dup'));
    const lines = [
      dupLine,
      line(v2('synth', { synthetic: true })),
      'not json at all',
      line(v1('old')),
      dupLine, // same id + content again
    ];
    const before = fs.readdirSync(tmpDir);
    const plan = planPrune(lines, { dropSynthetic: true, dropDuplicates: true, dropLegacy: false });

    assert.strictEqual(plan.total, 5);
    assert.deepStrictEqual(plan.dropped, { synthetic: 1, duplicate: 1, legacy: 0, malformed: 1 });
    // Survivor lines are the ORIGINAL string instances, byte-for-byte.
    assert.deepStrictEqual(plan.keptLines, [lines[0], lines[3]]);
    assert.ok(plan.keptIds.has('dup') && plan.keptIds.has('old'));
    assert.deepStrictEqual(fs.readdirSync(tmpDir), before, 'planner wrote nothing');
  });

  it('planPrune with every flag off drops only malformed lines', () => {
    const lines = [line(v2('a', { synthetic: true })), line(v1('b')), 'garbage!!', line(v2('a'))];
    const plan = planPrune(lines, { dropSynthetic: false, dropDuplicates: false, dropLegacy: false });
    assert.strictEqual(plan.total, 4);
    assert.deepStrictEqual(plan.dropped, { synthetic: 0, duplicate: 0, legacy: 0, malformed: 1 });
    assert.strictEqual(plan.keptLines.length, 3);
  });

  // ---- pruneDataset: dry-run vs apply ---------------------------------------

  it('prune preview performs zero writes and leaves mtime untouched', () => {
    const raw = writeDataset([line(v2('k')), line(v2('s', { synthetic: true }))]);
    const mtimeBefore = fs.statSync(datasetPath).mtimeMs;

    const preview = pruneDataset(datasetPath, { dropSynthetic: true, dropDuplicates: true, dropLegacy: false }, false);
    assert.ok(preview);
    assert.strictEqual(preview.applied, false);
    assert.strictEqual(preview.total, 2);
    assert.strictEqual(preview.kept, 1);
    assert.strictEqual(preview.dropped.synthetic, 1);
    assert.strictEqual(preview.backupPath, null);
    assert.strictEqual(fs.statSync(datasetPath).mtimeMs, mtimeBefore, 'dry-run must not touch mtime');
    assert.strictEqual(fs.readFileSync(datasetPath, 'utf8'), raw);
    assert.strictEqual(fs.readdirSync(tmpDir).length, 1, 'no backup/sidecar/tmp files');
  });

  it('prune apply rewrites with survivors byte-identical and a full .bak of the original', () => {
    const lines = [line(v2('keep1')), line(v2('syn', { synthetic: true })), line(v2('keep2'))];
    const raw = writeDataset(lines);

    const res = pruneDataset(datasetPath, { dropSynthetic: true, dropDuplicates: true, dropLegacy: false }, true);
    assert.ok(res && res.applied === true);
    assert.strictEqual(res.backupPath && fs.readFileSync(res.backupPath, 'utf8'), raw, '.bak is the original file');
    assert.strictEqual(fs.readFileSync(datasetPath, 'utf8'), [lines[0], lines[2]].join('\n') + '\n');
  });

  it('nothing-to-prune apply: no rewrite, no backup, mtime untouched, applied false', () => {
    writeDataset([line(v2('a')), line(v2('b'))]);
    const mtimeBefore = fs.statSync(datasetPath).mtimeMs;
    const res = pruneDataset(datasetPath, { dropSynthetic: true, dropDuplicates: true, dropLegacy: false }, true);
    assert.ok(res);
    assert.strictEqual(res.applied, false);
    assert.strictEqual(res.backupPath, null);
    assert.strictEqual(fs.statSync(datasetPath).mtimeMs, mtimeBefore);
  });

  it('pruneDataset returns null when the dataset file is missing', () => {
    const res = pruneDataset(datasetPath, { dropSynthetic: true, dropDuplicates: true, dropLegacy: false }, true);
    assert.strictEqual(res, null);
    assert.strictEqual(fs.readdirSync(tmpDir).length, 0, 'no-op left no files behind');
  });

  it('prune apply purges orphaned overlay entries for dropped ids', () => {
    writeDataset([line(v2('alive')), line(v2('dead', { synthetic: true })), line(v2('ghostly', { synthetic: true }))]);
    writeOverlay({ alive: labelEntry, dead: labelEntry, ghostly: labelEntry });
    const res = pruneDataset(datasetPath, { dropSynthetic: true, dropDuplicates: true, dropLegacy: false }, true);
    assert.ok(res);
    assert.strictEqual(res.removedLabels, 2);
    assert.deepStrictEqual(readOverlay(), { alive: labelEntry });
  });

  // ---- rotation ----------------------------------------------------------------

  it('rotateBackups keeps exactly the newest 3 .bak-<ts> siblings and spares other files', () => {
    fs.writeFileSync(datasetPath, 'x\n', 'utf8');
    for (const ts of [100, 200, 300, 400, 500]) {
      fs.writeFileSync(`${datasetPath}.bak-${ts}`, 'x\n', 'utf8');
    }
    fs.writeFileSync(sidecarPath, 'x\n', 'utf8'); // must survive rotation
    fs.writeFileSync(labelsPath, '{}', 'utf8');

    rotateBackups(datasetPath, 3);
    const survivors = fs.readdirSync(tmpDir).filter((n) => n.includes('.bak-')).sort();
    assert.deepStrictEqual(survivors, [
      'flywheel.jsonl.bak-300',
      'flywheel.jsonl.bak-400',
      'flywheel.jsonl.bak-500',
    ]);
    assert.ok(fs.existsSync(sidecarPath));
    assert.ok(fs.existsSync(labelsPath));
  });

  // ---- batch delete -------------------------------------------------------------

  it('deleteRecordsById is partial-success + idempotent, sidecar holds removed lines verbatim', () => {
    const lines = [line(v2('a')), line(v2('b')), line(v2('c'))];
    writeDataset(lines);
    writeOverlay({ a: labelEntry, b: labelEntry });

    const first = deleteRecordsById(datasetPath, ['b', 'nope', 'b']); // server dedupes; ids repeated anyway
    assert.strictEqual(first.deleted, 1);
    assert.deepStrictEqual(first.notFound, ['nope']);
    assert.strictEqual(first.removedLabels, 1, 'overlay purged the dead id');
    assert.strictEqual(first.sidecarPath, sidecarPath);
    assert.ok(first.rewrote);
    assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), lines[1] + '\n', 'sidecar byte-identical');
    assert.strictEqual(fs.readFileSync(datasetPath, 'utf8'), [lines[0], lines[2]].join('\n') + '\n');
    assert.deepStrictEqual(readOverlay(), { a: labelEntry });

    // Idempotent re-delete: zero writes, zero sidecar growth, all notFound.
    const mtime = fs.statSync(datasetPath).mtimeMs;
    const second = deleteRecordsById(datasetPath, ['b']);
    assert.strictEqual(second.deleted, 0);
    assert.deepStrictEqual(second.notFound, ['b']);
    assert.strictEqual(second.rewrote, false);
    assert.strictEqual(fs.statSync(datasetPath).mtimeMs, mtime);
    assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), lines[1] + '\n', 'sidecar unchanged');
  });

  it('deleteRecordsById removes every duplicate line sharing a deleted id', () => {
    const dup = line(v2('twice'));
    writeDataset([dup, line(v2('other')), dup]);
    const res = deleteRecordsById(datasetPath, ['twice']);
    assert.strictEqual(res.deleted, 2);
    assert.strictEqual(res.rewrote, true);
  });

  it('deleteRecordsById on a missing dataset: every id notFound, zero writes', () => {
    const res = deleteRecordsById(datasetPath, ['ghost']);
    assert.strictEqual(res.deleted, 0);
    assert.deepStrictEqual(res.notFound, ['ghost']);
    assert.strictEqual(res.rewrote, false);
    assert.strictEqual(fs.readdirSync(tmpDir).length, 0);
  });

  it('deleteRecordsById keeps malformed lines verbatim (delete is not hygiene)', () => {
    writeDataset([line(v2('a')), 'garbage not json']);
    const res = deleteRecordsById(datasetPath, ['a']);
    assert.strictEqual(res.deleted, 1);
    assert.strictEqual(fs.readFileSync(datasetPath, 'utf8'), 'garbage not json\n');
  });

  // ---- reset ---------------------------------------------------------------------

  it('resetDataset archives dataset + non-empty overlay, empties both, keeps everything else', () => {
    const raw = writeDataset([line(v2('a')), line(v2('b'))]);
    const overlayRaw = JSON.stringify({ a: labelEntry, b: labelEntry }, null, 2);
    fs.writeFileSync(labelsPath, overlayRaw, 'utf8');

    const res = resetDataset(datasetPath);
    assert.strictEqual(res.removedRecords, 2);
    assert.strictEqual(res.removedLabels, 2);
    assert.ok(res.backupPath && fs.readFileSync(res.backupPath, 'utf8') === raw);
    assert.ok(res.labelsBackupPath && fs.readFileSync(res.labelsBackupPath, 'utf8') === overlayRaw);
    assert.strictEqual(fs.statSync(datasetPath).size, 0, 'dataset emptied');
    assert.deepStrictEqual(readOverlay(), {});
  });

  it('resetDataset skips backup for an empty/absent overlay and is idempotent on an empty dataset', () => {
    writeDataset([line(v2('a'))]);
    fs.writeFileSync(labelsPath, '{}', 'utf8'); // present but empty
    const overlayMtime = fs.statSync(labelsPath).mtimeMs;

    const first = resetDataset(datasetPath);
    assert.strictEqual(first.labelsBackupPath, null, 'empty overlay must not be archived');
    assert.strictEqual(fs.statSync(labelsPath).mtimeMs, overlayMtime, 'empty overlay must not be rewritten');

    const second = resetDataset(datasetPath);
    assert.strictEqual(second.removedRecords, 0);
    assert.strictEqual(second.backupPath, null);
    assert.strictEqual(second.labelsBackupPath, null);
    assert.strictEqual(second.datasetRewrote, false);
    // Only one dataset .bak (from the first reset) on disk.
    assert.strictEqual(fs.readdirSync(tmpDir).filter((n) => n.includes('.bak-')).length, 1);
  });

  it('resetDataset on a missing dataset still clears a non-empty overlay', () => {
    writeOverlay({ z: labelEntry });
    const res = resetDataset(datasetPath);
    assert.strictEqual(res.removedRecords, 0);
    assert.strictEqual(res.backupPath, null);
    assert.strictEqual(res.removedLabels, 1);
    assert.ok(res.labelsBackupPath);
    assert.deepStrictEqual(readOverlay(), {});
  });

  // ---- labels overlay purge --------------------------------------------------------

  it('pruneLabelOverlay: null clears all, a Set keeps survivors, corrupt/missing are untouched', () => {
    writeOverlay({ a: labelEntry, b: labelEntry, c: labelEntry });
    assert.strictEqual(pruneLabelOverlay(labelsPath, new Set(['a', 'c'])), 1);
    assert.deepStrictEqual(readOverlay(), { a: labelEntry, c: labelEntry });

    assert.strictEqual(pruneLabelOverlay(labelsPath, null), 2);
    assert.deepStrictEqual(readOverlay(), {});

    // no-op paths: zero writes when nothing is doomed
    const mtime = fs.statSync(labelsPath).mtimeMs;
    assert.strictEqual(pruneLabelOverlay(labelsPath, new Set(['a'])), 0);
    assert.strictEqual(fs.statSync(labelsPath).mtimeMs, mtime);

    // corrupt overlay: never rewritten by a targeted purge (bytes are data)
    fs.writeFileSync(labelsPath, 'corrupt!!', 'utf8');
    const before = fs.readFileSync(labelsPath, 'utf8');
    assert.strictEqual(pruneLabelOverlay(labelsPath, new Set()), 0);
    assert.strictEqual(fs.readFileSync(labelsPath, 'utf8'), before);

    assert.strictEqual(pruneLabelOverlay(path.join(tmpDir, 'missing.json'), new Set()), 0);
  });

  // ---- retention ----------------------------------------------------------------------

  it('retention: both knobs off (0) is a no-op even with expired rows (backward compat)', () => {
    const raw = writeDataset([line(v2('ancient', { days: 365 })), line(v2('fresh'))]);
    const mtime = fs.statSync(datasetPath).mtimeMs;
    for (const cfg of [{ retentionDays: 0, maxFileSizeMB: 0 }, { retentionDays: -5, maxFileSizeMB: -9 }]) {
      const res = applyRetention(datasetPath, cfg);
      assert.strictEqual(res.removed, 0);
      assert.strictEqual(res.rewrote, false);
    }
    assert.strictEqual(fs.statSync(datasetPath).mtimeMs, mtime);
    assert.strictEqual(fs.readFileSync(datasetPath, 'utf8'), raw);
    assert.strictEqual(fs.readdirSync(tmpDir).length, 1, 'retention writes no backups/sidecars');
  });

  it('retention age pass: expired dropped, fresh kept, unparseable-ts kept, malformed kept', () => {
    const unparseable = { ...v2('weird'), timestamp: 'total-garbage' };
    const lines = [
      line(v2('ancient', { days: 30 })),
      line(v2('fresh', { days: 1 })),
      line(unparseable),
      'malformed!!',
    ];
    writeDataset(lines);
    writeOverlay({ ancient: labelEntry, fresh: labelEntry });

    const res = applyRetention(datasetPath, { retentionDays: 7, maxFileSizeMB: 0 });
    assert.strictEqual(res.removed, 1);
    assert.strictEqual(res.removedLabels, 1, 'overlay orphan purged alongside the record');
    assert.deepStrictEqual(readOverlay(), { fresh: labelEntry });
    assert.strictEqual(fs.readFileSync(datasetPath, 'utf8'), [lines[1], lines[2], lines[3]].join('\n') + '\n');
    assert.strictEqual(fs.readdirSync(tmpDir).filter((n) => n.includes('.bak-')).length, 0, 'D3: sweep writes no backup');
  });

  it('retention size pass: trims oldest-first down to the cap', () => {
    const lines = [line(v2('oldest', { days: 3 })), line(v2('mid', { days: 2 })), line(v2('newest', { days: 1 }))];
    writeDataset(lines);
    const bytesOf = (s: string) => Buffer.byteLength(s, 'utf8') + 1; // stored line + newline
    // Cap that fits exactly the two newest rows → only 'oldest' goes.
    const capMB = (bytesOf(lines[1]) + bytesOf(lines[2])) / (1024 * 1024);

    const res = applyRetention(datasetPath, { retentionDays: 0, maxFileSizeMB: capMB });
    assert.strictEqual(res.removed, 1);
    assert.strictEqual(fs.readFileSync(datasetPath, 'utf8'), [lines[1], lines[2]].join('\n') + '\n');
  });

  it('retention: combined age + size runs in ONE rewrite pass', () => {
    const lines = [
      line(v2('ancient', { days: 30 })), // dies in the age pass
      line(v2('old', { days: 3 })),
      line(v2('mid', { days: 2 })),
      line(v2('newest', { days: 1 })),
    ];
    writeDataset(lines);
    const bytesOf = (s: string) => Buffer.byteLength(s, 'utf8') + 1;
    // After age drops 'ancient', cap fits only the two newest → size pass eats 'old'.
    const capMB = (bytesOf(lines[2]) + bytesOf(lines[3])) / (1024 * 1024);

    const res = applyRetention(datasetPath, { retentionDays: 7, maxFileSizeMB: capMB });
    assert.strictEqual(res.removed, 2);
    assert.strictEqual(fs.readFileSync(datasetPath, 'utf8'), [lines[2], lines[3]].join('\n') + '\n');
  });

  it('retention on a missing dataset is a silent no-op', () => {
    const res = applyRetention(datasetPath, { retentionDays: 1, maxFileSizeMB: 1 });
    assert.deepStrictEqual(res, { removed: 0, removedLabels: 0, rewrote: false });
  });

  // ---- collector integration (BE-4) ---------------------------------------------------

  it('collector boot sweep deletes expired records when enabled and records retention state', () => {
    const freshLine = line(v2('fresh', { days: 1 })); // captured once — timestamps drift per call
    writeDataset([line(v2('ancient', { days: 30 })), freshLine]);
    writeOverlay({ ancient: labelEntry, fresh: labelEntry });

    const collector = new FlywheelCollector({ enabled: true, datasetPath, retentionDays: 7 });
    const state = collector.getRetentionState();
    assert.strictEqual(state.enabled, true);
    assert.strictEqual(state.retentionDays, 7);
    assert.strictEqual(state.maxFileSizeMB, 0);
    assert.ok(state.lastSweepAt, 'boot sweep stamped lastSweepAt');
    assert.strictEqual(state.lastRemoved, 1);
    assert.strictEqual(fs.readFileSync(datasetPath, 'utf8'), freshLine + '\n');
    assert.deepStrictEqual(readOverlay(), { fresh: labelEntry });
  });

  it('collector with disabled knobs performs zero fs writes (backward compat) and never deletes on disable', () => {
    const raw = writeDataset([line(v2('ancient', { days: 365 }))]);
    const mtime = fs.statSync(datasetPath).mtimeMs;

    new FlywheelCollector({ enabled: true, datasetPath }); // knobs unset
    new FlywheelCollector({ enabled: true, datasetPath, retentionDays: 0, maxFileSizeMB: 0 });
    const disabledButKnobbed = new FlywheelCollector({ enabled: false, datasetPath, retentionDays: 1 });
    assert.strictEqual(disabledButKnobbed.getRetentionState().enabled, false, 'collector off = sweep off');

    assert.strictEqual(fs.statSync(datasetPath).mtimeMs, mtime);
    assert.strictEqual(fs.readFileSync(datasetPath, 'utf8'), raw);
    assert.strictEqual(fs.readdirSync(tmpDir).length, 1, 'no sweep artifacts');
  });

  it('collector clamps negative retention knobs to 0 (disabled) with a single warn', () => {
    writeDataset([line(v2('any'))]);
    const collector = new FlywheelCollector({ enabled: true, datasetPath, retentionDays: -7, maxFileSizeMB: -2 });
    const state = collector.getRetentionState();
    assert.strictEqual(state.retentionDays, 0);
    assert.strictEqual(state.maxFileSizeMB, 0);
    assert.strictEqual(state.enabled, false, 'clamped knobs leave retention disabled');
    assert.strictEqual(state.lastSweepAt, null, 'no sweep ran for clamped-off knobs');
  });
});

/**
 * Gap-closing regressions beyond the initial engine suite: garbage (non-finite
 * / non-numeric) retention knobs, unparseable-timestamp protection in the
 * SIZE pass, zero-write guarantees when nothing is eligible, backup rotation
 * wired into the real prune/reset ops (not just the rotateBackups unit),
 * unreadable-overlay behaviour on delete/reset, sidecar accumulation across
 * calls, and the reader/rewriter coexistence that replaced the cached fd
 * (the Windows rename-EPERM platform deviation) at FlywheelDataset level.
 */
describe('flywheel lifecycle engine — gap closures', () => {
  const dir2 = path.resolve(process.cwd(), './data/test_fw_prune2');
  const ds2 = path.join(dir2, 'flywheel.jsonl');
  const labels2 = labelsPathFor(ds2);
  const sidecar2 = sidecarPathFor(ds2);

  beforeEach(() => {
    fs.rmSync(dir2, { recursive: true, force: true });
    fs.mkdirSync(dir2, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir2, { recursive: true, force: true });
  });

  function put(lines: string[]): string {
    const raw = lines.join('\n') + '\n';
    fs.writeFileSync(ds2, raw, 'utf8');
    return raw;
  }

  function putOverlay(map: unknown): void {
    fs.writeFileSync(labels2, JSON.stringify(map, null, 2), 'utf8');
  }

  const bytesOf = (s: string) => Buffer.byteLength(s, 'utf8') + 1; // stored line + newline

  // ---- retention knob hardening (D4 backward compat, garbage inputs) ----------

  it('engine ignores garbage retention knobs (NaN / Infinity / non-numeric strings) — zero writes', () => {
    put([line(v2('ancient', { days: 400 })), line(v2('fresh'))]);
    const mtime = fs.statSync(ds2).mtimeMs;
    const garbage: Array<{ retentionDays: unknown; maxFileSizeMB: unknown }> = [
      { retentionDays: NaN, maxFileSizeMB: NaN },
      { retentionDays: Infinity, maxFileSizeMB: -Infinity },
      { retentionDays: '7', maxFileSizeMB: '1' }, // YAML can hand a string through
    ];
    for (const cfg of garbage) {
      const res = applyRetention(ds2, cfg as never);
      assert.deepStrictEqual(res, { removed: 0, removedLabels: 0, rewrote: false }, `garbage ${JSON.stringify(String(cfg.retentionDays))} must be off`);
    }
    assert.strictEqual(fs.statSync(ds2).mtimeMs, mtime, 'a 400-day-old row survived garbage config');
    assert.strictEqual(fs.readdirSync(dir2).length, 1, 'zero artifacts');
  });

  it('collector clamps garbage knob values (NaN / Infinity / string) to disabled; expired rows survive', () => {
    put([line(v2('ancient', { days: 400 }))]);
    const mtime = fs.statSync(ds2).mtimeMs;
    const cases: Array<Record<string, unknown>> = [
      { retentionDays: NaN },
      { maxFileSizeMB: Number.POSITIVE_INFINITY },
      { retentionDays: '7' },
    ];
    for (const extra of cases) {
      const collector = new FlywheelCollector({ enabled: true, datasetPath: ds2, ...extra } as never);
      const st = collector.getRetentionState();
      assert.strictEqual(st.retentionDays, 0);
      assert.strictEqual(st.maxFileSizeMB, 0);
      assert.strictEqual(st.enabled, false, 'garbage knobs never activate the sweep');
      assert.strictEqual(st.lastSweepAt, null);
    }
    assert.strictEqual(fs.statSync(ds2).mtimeMs, mtime);
    assert.strictEqual(fs.readdirSync(dir2).length, 1, 'no sweep artifacts');
  });

  it('collector survives a failing boot sweep (dataset path is a directory): warn, no throw, no stamp', () => {
    // readFileSync on a directory throws EISDIR — the BE-4 acceptance says
    // sweep failures only console.warn and the timer must survive.
    fs.mkdirSync(ds2, { recursive: true });
    const collector = new FlywheelCollector({ enabled: true, datasetPath: ds2, retentionDays: 1 });
    const st = collector.getRetentionState();
    assert.strictEqual(st.enabled, true, 'knobs stay set — a failed sweep is not a config reset');
    assert.strictEqual(st.lastSweepAt, null, 'a failed sweep stamps nothing');
    // If this ever throws or half-constructs, the assertions above are moot
    // — reaching them IS the proof the constructor swallowed the EISDIR.
  });

  // ---- retention pass ordering / eligibility ------------------------------------

  it('retention SIZE pass treats unparseable timestamps as newest and keeps them; dated rows trim first', () => {
    const weird = line({ ...v2('weird'), timestamp: 'not-a-date' });
    const rows = [line(v2('old', { days: 5 })), line(v2('mid', { days: 2 })), weird];
    put(rows);
    // Cap that fits ONLY the unparseable row: age knob off, so the trim order
    // (oldest date → newest date → unparseable last) is the whole story.
    const capMB = bytesOf(weird) / (1024 * 1024);

    const res = applyRetention(ds2, { retentionDays: 0, maxFileSizeMB: capMB });
    assert.strictEqual(res.removed, 2);
    assert.strictEqual(fs.readFileSync(ds2, 'utf8'), weird + '\n', 'unparseable-ts row is never the first casualty');
  });

  it('retention with active knobs but nothing eligible writes NOTHING (dataset, overlay, mtime)', () => {
    put([line(v2('fresh', { days: 1 }))]);
    putOverlay({ fresh: labelEntry });
    const dMtime = fs.statSync(ds2).mtimeMs;
    const lMtime = fs.statSync(labels2).mtimeMs;

    const res = applyRetention(ds2, { retentionDays: 3650, maxFileSizeMB: 1024 });
    assert.deepStrictEqual(res, { removed: 0, removedLabels: 0, rewrote: false });
    assert.strictEqual(fs.statSync(ds2).mtimeMs, dMtime);
    assert.strictEqual(fs.statSync(labels2).mtimeMs, lMtime, 'the early return must precede the overlay purge too');
    assert.strictEqual(fs.readdirSync(dir2).length, 2, 'no backup/sidecar/tmp appeared');
  });

  // ---- backup rotation wired into the real ops (D3, BE-1) ------------------------

  it('prune apply rotates stale .bak siblings to keep-3 (not just the rotateBackups unit)', () => {
    const raw = put([line(v2('ok')), line(v2('syn', { synthetic: true }))]);
    for (const ts of ['1', '2', '3']) fs.writeFileSync(`${ds2}.bak-${ts}`, 'stale\n', 'utf8');

    const res = pruneDataset(ds2, { dropSynthetic: true, dropDuplicates: true, dropLegacy: false }, true);
    assert.ok(res?.applied === true);
    assert.ok(res.backupPath && fs.existsSync(res.backupPath));
    assert.strictEqual(fs.readFileSync(res.backupPath, 'utf8'), raw, "this call's backup is the pre-rewrite snapshot");
    assert.ok(fs.existsSync(`${ds2}.bak-2`) && fs.existsSync(`${ds2}.bak-3`), 'the 2 next-newest survive');
    assert.ok(!fs.existsSync(`${ds2}.bak-1`), 'the oldest was rotated out');
  });

  it('reset rotates stale label-overlay backups to keep-3 as well', () => {
    put([line(v2('a'))]);
    putOverlay({ a: labelEntry });
    for (const ts of ['1', '2', '3']) fs.writeFileSync(`${labels2}.bak-${ts}`, '{}', 'utf8');

    const res = resetDataset(ds2);
    assert.ok(res.labelsBackupPath && fs.existsSync(res.labelsBackupPath));
    const labelBackups = fs.readdirSync(dir2).filter((n) => n.startsWith('flywheel.jsonl.labels.json.bak-'));
    assert.strictEqual(labelBackups.length, 3, 'one old backup rotated out');
    assert.ok(!labelBackups.includes('flywheel.jsonl.labels.json.bak-1'));
  });

  // ---- unreadable overlay: bytes are data (cp-dataloss) ---------------------------

  it('reset archives an unparseable overlay VERBATIM, clears it, and counts no labels', () => {
    put([line(v2('a'))]);
    fs.writeFileSync(labels2, 'corrupt!!', 'utf8');

    const res = resetDataset(ds2);
    assert.strictEqual(res.removedRecords, 1);
    assert.strictEqual(res.removedLabels, 0, 'unparseable entries cannot be counted, but still land in the backup');
    assert.ok(res.labelsBackupPath);
    assert.strictEqual(fs.readFileSync(res.labelsBackupPath, 'utf8'), 'corrupt!!', 'raw bytes archived, not a reformat');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(labels2, 'utf8')), {}, 'overlay left in the reader-compatible empty shape');
  });

  it('delete rewrites the dataset even when the overlay is unreadable — bytes untouched, removedLabels 0', () => {
    const rows = [line(v2('a')), line(v2('b'))];
    put(rows);
    fs.writeFileSync(labels2, 'corrupt!!', 'utf8');

    const res = deleteRecordsById(ds2, ['a']);
    assert.strictEqual(res.deleted, 1);
    assert.strictEqual(res.rewrote, true);
    assert.strictEqual(res.removedLabels, 0);
    assert.strictEqual(fs.readFileSync(labels2, 'utf8'), 'corrupt!!', 'a targeted purge never rewrites bytes it cannot read');
    assert.strictEqual(fs.readFileSync(ds2, 'utf8'), rows[1] + '\n');
  });

  // ---- sidecar semantics ------------------------------------------------------------

  it('sidecar accumulates across successive delete calls, verbatim, in call order', () => {
    const rows = [line(v2('a')), line(v2('b')), line(v2('c'))];
    put(rows);
    deleteRecordsById(ds2, ['b']);
    deleteRecordsById(ds2, ['a']);
    assert.strictEqual(fs.readFileSync(sidecar2, 'utf8'), rows[1] + '\n' + rows[0] + '\n', 'restore = append back in order');
    assert.strictEqual(fs.readFileSync(ds2, 'utf8'), rows[2] + '\n');
  });

  // ---- D9 on the size pass: regression pin for finding F1 (fixed: applyRetention rebuilds keptIds from the final keptRows) -------

  it('retention SIZE pass purges overlay orphans for size-trimmed ids (D9)', () => {
    const rows = [line(v2('old', { days: 5 })), line(v2('fresh', { days: 1 }))];
    put(rows);
    putOverlay({ old: labelEntry, fresh: labelEntry });
    const capMB = bytesOf(rows[1]) / (1024 * 1024); // size pass trims exactly the oldest row

    const res = applyRetention(ds2, { retentionDays: 0, maxFileSizeMB: capMB });
    assert.strictEqual(res.removed, 1, 'premise: the size pass trimmed the oldest row');
    assert.strictEqual(res.removedLabels, 1, 'D9: a removed record must leave the overlay');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(labels2, 'utf8')), { fresh: labelEntry });
  });

  // ---- reader/rewriter coexistence: the no-cached-fd deviation + inode guard ---------

  it('live FlywheelDataset never blocks a rewrite; an equal-size external replace re-indexes', () => {
    const alive = line(v2('alive', { prompt: 'keep-aaaa prompt' }));
    put([alive, line(v2('syn', { synthetic: true }))]);

    const ds = new FlywheelDataset(ds2);
    const Q = { limit: 10, offset: 0, tier: 'any' as const, source: 'any' as const, includeSynthetic: false, trainableOnly: false };
    assert.strictEqual(ds.query(Q).total, 1); // indexes now — the OLD code cached an fd here

    // Rewrite while the reader is alive: with a cached fd this rename would
    // fail EPERM on Windows — the open-per-read deviation must keep it green.
    const res = pruneDataset(ds2, { dropSynthetic: true, dropDuplicates: true, dropLegacy: false }, true);
    assert.ok(res?.applied === true, 'prune rename succeeded over a live reader instance');

    // Equal-size external replacement (offline-CLI style): a pure size check
    // is blind to this — only the inode guard can detect it (BE-2 acceptance).
    const before = fs.readFileSync(ds2, 'utf8');
    const replacement = before.replace('keep-aaaa', 'swap-bbbb');
    assert.strictEqual(Buffer.byteLength(replacement, 'utf8'), Buffer.byteLength(before, 'utf8'), 'equal-size premise');
    fs.writeFileSync(`${ds2}.external`, replacement, 'utf8');
    fs.renameSync(`${ds2}.external`, ds2);

    assert.strictEqual(ds.query({ ...Q, search: 'swap-bbbb' }).total, 1, 're-indexed from the swapped inode');
    assert.strictEqual(ds.query({ ...Q, search: 'keep-aaaa' }).total, 0, 'no stale byte offsets survive');
  });
});

/**
 * The 409 predicate the three new lifecycle routes (and the existing relabel /
 * rollback routes) all read. The HTTP-level skip in flywheel-http.test.ts is
 * acceptable only because this pins the state machine deterministically:
 * train() marks status='training' synchronously before its single await, so a
 * second call in the same tick is rejected without racing the sync loop.
 */
describe('FlywheelTrainer re-entrancy — the shared 409 predicate', () => {
  const dir3 = path.resolve(process.cwd(), './data/test_fw_guard');

  beforeEach(() => {
    fs.rmSync(dir3, { recursive: true, force: true });
    fs.mkdirSync(dir3, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir3, { recursive: true, force: true });
  });

  it('a second train() is rejected synchronously while a run is in flight; the guard releases after', async () => {
    const ds = new FlywheelDataset(path.join(dir3, 'flywheel.jsonl')); // file absent → empty pool
    const trainer = new FlywheelTrainer(ds, path.join(dir3, 'layer1-classifier.json'));

    const first = trainer.train(); // sync prologue sets status='training' before its one await
    const second = await trainer.train();
    assert.strictEqual(second.started, false);
    assert.match(second.error || '', /already in progress/);
    assert.strictEqual(second.state.status, 'training', 'the exact value every route 409 guard tests');
    assert.strictEqual(trainer.isTraining(), true);

    const firstRes = await first; // the run proceeds and fails fast on the empty pool
    assert.match(firstRes.error || '', /No trainable samples/);
    assert.strictEqual(trainer.isTraining(), false, 'guard releases — routes 409 only mid-run');
  });
});

/**
 * QA-3 CLI smoke for BE-6: scripts/flywheel-prune.ts is now a thin wrapper
 * over pruneDataset(). The spawn gets its own sandbox cwd holding a minimal
 * config.yaml (the same placeholder shape scripts/test-isolated.ts creates),
 * so loadConfig() resolves the dataset path under the temp dir — never the
 * operator's real config.
 */
describe('flywheel-prune CLI wrapper (BE-6 / QA-3 smoke)', () => {
  const cliDir = path.resolve(process.cwd(), './data/test_fw_cli');
  const cliDataset = path.join(cliDir, 'flywheel.jsonl');
  const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/flywheel-prune.ts');

  beforeEach(() => {
    fs.rmSync(cliDir, { recursive: true, force: true });
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(
      path.join(cliDir, 'config.yaml'),
      'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\nflywheel:\n  datasetPath: ./flywheel.jsonl\n',
      'utf8'
    );
  });

  afterEach(() => {
    fs.rmSync(cliDir, { recursive: true, force: true });
  });

  function runCli(args: string[]): { out: string; code: number } {
    const proc = spawnSync(process.execPath, [scriptPath, ...args], { cwd: cliDir, encoding: 'utf8' });
    return { out: `${proc.stdout ?? ''}${proc.stderr ?? ''}`, code: proc.status ?? 1 };
  }

  it('dry-run prints the table and writes nothing; --apply rewrites with .bak; re-apply is a no-op', () => {
    const l0 = line(v2('c1'));
    const l1 = line(v2('c2', { synthetic: true }));
    const l2 = line(v2('c3'));
    const raw = put(l0, l1, l2);

    const dry = runCli([]);
    assert.strictEqual(dry.code, 0, dry.out);
    assert.match(dry.out, /lines read\s+: 3/);
    assert.match(dry.out, /kept\s+: 2/);
    assert.match(dry.out, /dropped synthetic: 1/);
    assert.match(dry.out, /Dry run/);
    assert.strictEqual(fs.readFileSync(cliDataset, 'utf8'), raw, 'dry-run performed zero writes');
    assert.strictEqual(fs.readdirSync(cliDir).filter((n) => n.includes('.bak-')).length, 0);

    const applied = runCli(['--apply']);
    assert.strictEqual(applied.code, 0, applied.out);
    assert.match(applied.out, /✓ Pruned\. Backup: /);
    assert.strictEqual(fs.readFileSync(cliDataset, 'utf8'), [l0, l2].join('\n') + '\n', 'survivors verbatim');
    const baks = fs.readdirSync(cliDir).filter((n) => n.includes('.bak-'));
    assert.strictEqual(baks.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(cliDir, baks[0]), 'utf8'), raw, '.bak holds the original file');

    const again = runCli(['--apply']);
    assert.strictEqual(again.code, 0, again.out);
    assert.match(again.out, /Nothing to prune\./);
    assert.strictEqual(fs.readdirSync(cliDir).filter((n) => n.includes('.bak-')).length, 1, 'no-op apply wrote no second backup');
  });

  it('no dataset file: prints the path, exits 0, creates nothing', () => {
    const run = runCli([]);
    assert.strictEqual(run.code, 0, run.out);
    assert.match(run.out, /No dataset at/);
    assert.ok(!fs.existsSync(cliDataset), 'the CLI must not create the dataset');
  });

  // local put with variadic lines, scoped to the CLI fixture
  function put(...lines: string[]): string {
    const raw = lines.join('\n') + '\n';
    fs.writeFileSync(cliDataset, raw, 'utf8');
    return raw;
  }
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { FlywheelTrainer } from '../src/flywheel/trainer.js';
import { labelsPathFor } from '../src/flywheel/prune.js';

/**
 * HTTP-level contract tests for the flywheel console endpoints, driven through
 * the REAL server (mock inference upstream): a live chat completion flows down
 * the actual orchestrator into the collector, then every endpoint is exercised
 * against what it recorded — status codes, error envelopes and the
 * relabel→query round-trip included.
 */
describe('Flywheel console API (server integration)', () => {
  const tmpDir = path.resolve(process.cwd(), './data/test_fw_http');
  const datasetPath = path.join(tmpDir, 'flywheel.jsonl');
  const TEST_KEY = 'sk-ocr-flywheel-http-test';
  const authHeaders = (): Record<string, string> => ({ authorization: `Bearer ${TEST_KEY}` });

  const config = loadConfig();
  config.host = '127.0.0.1';
  config.webAuth = { enabled: false };
  config.flywheel = { enabled: true, datasetPath, logUserPrompt: true };
  const { app } = createServer(config, true);

  before(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let recordedId: string | null = null;

  it('chat completion through the orchestrator lands in the dataset (stats endpoint)', async () => {
    const res = await app.inject({
      headers: authHeaders(),
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'flywheel integration probe' }] },
    });
    assert.strictEqual(res.statusCode, 200);

    const stats = await app.inject({ method: 'GET', url: '/api/admin/flywheel/stats' });
    assert.strictEqual(stats.statusCode, 200);
    const body = JSON.parse(stats.body);
    assert.ok(body.total >= 1, `expected at least one recorded row, got ${body.total}`);
    assert.ok(Array.isArray(body.tiers) && body.tiers.length === 4);
    // mock-mode upstreams carry mock-* ids — the collector must flag them.
    assert.strictEqual(body.synthetic, body.total);

    const samples = await app.inject({ method: 'GET', url: '/api/admin/flywheel/samples?includeSynthetic=true&limit=5' });
    assert.strictEqual(samples.statusCode, 200);
    const sb = JSON.parse(samples.body);
    assert.ok(sb.rows.length >= 1);
    assert.ok(sb.rows[0].id, 'row carries an id');
    assert.ok(sb.rows[0].input ?? sb.rows[0].userPrompt !== undefined, 'row is materialized');
    recordedId = sb.rows[0].id;
  });

  it('relabelling: valid tier persists, unknown id 404s, bad tier 400s', async () => {
    assert.ok(recordedId, 'previous test must have recorded a row');

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/admin/flywheel/samples/${encodeURIComponent(recordedId!)}`,
      payload: { tier: 'pro' },
    });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(JSON.parse(ok.body).label.tier, 'pro');
    assert.strictEqual(JSON.parse(ok.body).label.source, 'human');

    // Mock-mode rows are flagged synthetic and hidden by default — human
    // filtering must therefore include them explicitly.
    const filtered = await app.inject({ method: 'GET', url: '/api/admin/flywheel/samples?source=human&includeSynthetic=true' });
    assert.strictEqual(JSON.parse(filtered.body).total, 1);

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/admin/flywheel/samples/does-not-exist',
      payload: { tier: 'lite' },
    });
    assert.strictEqual(missing.statusCode, 404);

    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/admin/flywheel/samples/${encodeURIComponent(recordedId!)}`,
      payload: { tier: 'turbo' },
    });
    assert.strictEqual(bad.statusCode, 400);
  });

  it('training endpoints: state shape, empty-pool 400, rollback 404, labels reset', async () => {
    const state = await app.inject({ method: 'GET', url: '/api/admin/flywheel/training' });
    assert.strictEqual(state.statusCode, 200);
    const st = JSON.parse(state.body);
    assert.ok(['idle', 'training', 'success', 'failed'].includes(st.status));
    assert.strictEqual(typeof st.model.routingConsumesModel, 'boolean');
    assert.strictEqual(typeof st.model.featureDimensions, 'number');

    // Mock rows are synthetic and (being mock fixtures) excluded from training;
    // the pool is empty, so the run must fail with a 400 and a clear reason.
    const train = await app.inject({
      method: 'POST',
      url: '/api/admin/flywheel/training',
      payload: {},
    });
    assert.strictEqual(train.statusCode, 400);
    assert.match(JSON.parse(train.body).error, /No trainable samples/);

    const rb = await app.inject({ method: 'POST', url: '/api/admin/flywheel/model/rollback' });
    assert.strictEqual(rb.statusCode, 404);

    const cleared = await app.inject({ method: 'DELETE', url: '/api/admin/flywheel/labels' });
    assert.strictEqual(cleared.statusCode, 200);
    assert.strictEqual(JSON.parse(cleared.body).cleared, 1);

    const afterClear = await app.inject({ method: 'GET', url: '/api/admin/flywheel/samples?source=human&includeSynthetic=true' });
    assert.strictEqual(JSON.parse(afterClear.body).total, 0);
  });
});

/**
 * Lifecycle contracts (design doc §3.1–§3.4, QA-2): prune preview/apply,
 * batch delete partial-success, typed-confirmation reset, overlay orphan
 * purge, `dataset.invalidate()` visibility through the SAME server instance,
 * and the BE-2 inode guard.
 */
describe('Flywheel lifecycle API (prune / batch delete / reset)', () => {
  const tmpDir = path.resolve(process.cwd(), './data/test_fw_life');
  const datasetPath = path.join(tmpDir, 'flywheel.jsonl');
  const labelsPath = `${datasetPath}.labels.json`;
  const sidecarPath = `${datasetPath}.deleted.jsonl`;
  const modelPath = path.join(tmpDir, 'layer1-classifier.json');

  const config = loadConfig();
  config.host = '127.0.0.1';
  config.webAuth = { enabled: false };
  config.flywheel = { enabled: true, datasetPath, logUserPrompt: true };
  // Point the Layer 1 model at the temp dir so reset can prove D8: a data
  // lifecycle op must never touch deployed weights.
  config.classifier = { ...config.classifier, localModel: { ...config.classifier?.localModel, modelPath } };
  const { app } = createServer(config, true);

  function v2line(id: string, prompt: string, opts: { synthetic?: boolean } = {}): string {
    return JSON.stringify({
      v: 2,
      id,
      timestamp: new Date().toISOString(),
      input: {
        userPrompt: prompt,
        featureVector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
        featureNames: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'],
        tokenCount: 10,
        turnCount: 1,
      },
      decision: { targetTier: 'plus', confidence: 0.5, layerUsed: 'layer0', reason: 'seed' },
      execution: {
        tierUsed: 'plus',
        modelUsed: 'test-model',
        fallbackOccurred: false,
        latencyMs: 50,
        isSynthetic: opts.synthetic === true,
      },
      label: { tier: 'plus', source: 'observed_execution', confidence: 0.5, overridden: false, isNegativeForLite: false },
      trainable: true,
    });
  }

  // Six physical lines: 5 indexable records + 1 malformed line. The prune
  // planner counts LINES (6); the dataset index counts RECORDS (5) — both
  // numbers are asserted below because they answer different questions.
  const keepLine = v2line('life_keep', 'inode-old-marker keep row');
  const deleteLine = v2line('life_delete', 'doomed row');
  const legacyLine = JSON.stringify({
    id: 'life_legacy',
    timestamp: new Date().toISOString(),
    userPrompt: 'legacy v1 prompt',
    routing: { targetTier: 'lite', layerUsed: 'layer0' },
    execution: { tierUsed: 'lite', modelUsed: 'test-model', fallbackOccurred: false },
    label: { labelSource: 'observed_execution' },
  });
  const seedLines = [keepLine, v2line('life_synth', 'bench traffic', { synthetic: true }), keepLine, legacyLine, 'not json at all', deleteLine];

  before(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(modelPath, JSON.stringify({ base: 'weights' }), 'utf8');
    // The trainer's automatic pre-training backup sibling — reset must leave
    // this untouched too (D8: a data op never touches deployed weights,
    // current or previous).
    fs.writeFileSync(`${modelPath}.previous`, JSON.stringify({ prev: 'old-weights' }), 'utf8');
    fs.writeFileSync(datasetPath, seedLines.join('\n') + '\n', 'utf8');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET stats carries the additive retention block (knobs unset = off)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/flywheel/stats' });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepStrictEqual(body.retention, {
      retentionDays: 0,
      maxFileSizeMB: 0,
      enabled: false,
      lastSweepAt: null,
      lastRemoved: null,
    });
    assert.strictEqual(body.total, 4, 'index counts records: the v1 line and the malformed line are skipped');
  });

  it('POST prune default is dry-run: counts reported, zero writes, mtime untouched', async () => {
    const mtimeBefore = fs.statSync(datasetPath).mtimeMs;
    const rawBefore = fs.readFileSync(datasetPath, 'utf8');

    const res = await app.inject({ method: 'POST', url: '/api/admin/flywheel/prune', payload: {} });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.applied, false);
    assert.strictEqual(body.total, 6);
    assert.strictEqual(body.kept, 3);
    assert.deepStrictEqual(body.dropped, { synthetic: 1, duplicate: 1, malformed: 1 });
    assert.strictEqual(body.removedLabels, 0);
    assert.strictEqual(body.backupPath, null);
    assert.strictEqual(fs.statSync(datasetPath).mtimeMs, mtimeBefore);
    assert.strictEqual(fs.readFileSync(datasetPath, 'utf8'), rawBefore);
  });

  it('POST prune rejects present-but-non-boolean flags with 400', async () => {
    for (const payload of [{ apply: 'yes' }, { dropSynthetic: 1 }, { dropDuplicates: null }, { apply: null }]) {
      const res = await app.inject({ method: 'POST', url: '/api/admin/flywheel/prune', payload });
      assert.strictEqual(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
      assert.match(JSON.parse(res.body).error, /must be a boolean/);
    }
  });

  it('POST prune apply rewrites with .bak backup and the live index sees it (invalidate)', async () => {
    const rawBefore = fs.readFileSync(datasetPath, 'utf8');
    const res = await app.inject({ method: 'POST', url: '/api/admin/flywheel/prune', payload: { apply: true } });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.applied, true);
    assert.strictEqual(body.kept, 3, 'preview↔apply count parity');
    assert.deepStrictEqual(body.dropped, { synthetic: 1, duplicate: 1, malformed: 1 });
    assert.ok(body.backupPath && fs.existsSync(body.backupPath));
    assert.strictEqual(fs.readFileSync(body.backupPath, 'utf8'), rawBefore);
    assert.strictEqual(fs.readFileSync(datasetPath, 'utf8'), [keepLine, legacyLine, deleteLine].join('\n') + '\n');

    // Same-instance visibility: no re-start, no manual invalidate. The v1
    // line survives the rewrite verbatim but never enters the index (no v1
    // reader), so the index counts keep + delete only.
    const stats = await app.inject({ method: 'GET', url: '/api/admin/flywheel/stats' });
    assert.strictEqual(JSON.parse(stats.body).total, 2);

    // Second apply: nothing left to drop → applied:false, no second backup.
    const again = await app.inject({ method: 'POST', url: '/api/admin/flywheel/prune', payload: { apply: true } });
    assert.strictEqual(JSON.parse(again.body).applied, false);
    assert.strictEqual(JSON.parse(again.body).backupPath, null);
  });

  it('POST samples/delete: partial success, label orphan purge, sidecar verbatim, invalidate visible', async () => {
    const label = await app.inject({
      method: 'PATCH',
      url: '/api/admin/flywheel/samples/life_delete',
      payload: { tier: 'pro' },
    });
    assert.strictEqual(label.statusCode, 200);

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/flywheel/samples/delete',
      payload: { ids: ['life_delete', 'ghost-id'] },
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.deleted, 1);
    assert.deepStrictEqual(body.notFound, ['ghost-id']);
    assert.strictEqual(body.removedLabels, 1, 'overlay entry for the dead id purged');
    assert.strictEqual(body.sidecarPath, sidecarPath);
    assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), deleteLine + '\n', 'sidecar byte-identical');

    const gone = await app.inject({ method: 'GET', url: '/api/admin/flywheel/samples?search=life_delete' });
    assert.strictEqual(JSON.parse(gone.body).total, 0, 'live index reflects the deletion');
    const stats = await app.inject({ method: 'GET', url: '/api/admin/flywheel/stats' });
    const st = JSON.parse(stats.body);
    assert.strictEqual(st.total, 1);
    assert.strictEqual(st.humanLabeled, 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(labelsPath, 'utf8')), {});
  });

  it('POST samples/delete input validation: empty / non-array / >1000 / missing ids all 400', async () => {
    const bad: unknown[] = [{ ids: [] }, { ids: 'life_keep' }, { ids: ['life_keep', 7] }, { ids: [''] }, {}, { ids: Array.from({ length: 1001 }, (_, i) => `id-${i}`) }];
    for (const payload of bad) {
      const res = await app.inject({ method: 'POST', url: '/api/admin/flywheel/samples/delete', payload });
      assert.strictEqual(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
    }
    const datasetIntact = fs.readFileSync(datasetPath, 'utf8');
    assert.strictEqual(datasetIntact, [keepLine, legacyLine].join('\n') + '\n', '400s performed zero writes');
  });

  it('inode guard: an equal-size external rewrite is picked up by the live index', async () => {
    // Offline-CLI style replacement: same byte length (swap 3 chars for 3),
    // atomic tmp+rename — pure shrink detection CANNOT see this; only the
    // inode guard can (design doc D5).
    const raw = fs.readFileSync(datasetPath, 'utf8');
    const replacement = raw.replace('inode-old', 'inode-new');
    assert.strictEqual(Buffer.byteLength(replacement, 'utf8'), Buffer.byteLength(raw, 'utf8'), 'equal-size premise');
    const tmp = `${datasetPath}.external`;
    fs.writeFileSync(tmp, replacement, 'utf8');
    fs.renameSync(tmp, datasetPath);

    const found = await app.inject({ method: 'GET', url: '/api/admin/flywheel/samples?search=inode-new' });
    assert.strictEqual(JSON.parse(found.body).total, 1, 're-indexed from the new inode');
    const stale = await app.inject({ method: 'GET', url: '/api/admin/flywheel/samples?search=inode-old' });
    assert.strictEqual(JSON.parse(stale.body).total, 0, 'old offsets are gone, not half-live');
  });

  // Flag mapping: `dropSynthetic: body.dropSynthetic !== false` defaults ON —
  // a preview with dropSynthetic:false pins that mapping explicitly on a file
  // whose only synthetic row is gone (already pruned by an earlier step).
  // Zero writes: later reset counts unaffected.
  it('POST prune maps body flags without inverting the split defaults (preview)', async () => {
    const raw = fs.readFileSync(datasetPath, 'utf8');
    const baksBefore = fs.readdirSync(tmpDir).filter((n) => n.includes('.bak-')).length;

    const res = await app.inject({ method: 'POST', url: '/api/admin/flywheel/prune', payload: { dropSynthetic: false, dropDuplicates: true } });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.applied, false);
    // Two lines remain by now (keep + the pre-v2 line): nothing is droppable.
    assert.strictEqual(body.total, 2);
    assert.strictEqual(body.kept, 2);
    assert.deepStrictEqual(body.dropped, { synthetic: 0, duplicate: 0, malformed: 0 });
    assert.strictEqual(fs.readFileSync(datasetPath, 'utf8'), raw, 'preview writes nothing');
    assert.strictEqual(fs.readdirSync(tmpDir).filter((n) => n.includes('.bak-')).length, baksBefore);
  });

  it('POST reset enforces the confirm word exactly (400 message verbatim)', async () => {
    for (const payload of [{}, { confirm: 'reset' }, { confirm: 'RESET ' }, { confirm: 1 }, { confirm: null }]) {
      const res = await app.inject({ method: 'POST', url: '/api/admin/flywheel/reset', payload });
      assert.strictEqual(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
      assert.strictEqual(
        JSON.parse(res.body).error,
        'Body must include { "confirm": "RESET" } (exact, case-sensitive).'
      );
    }
  });

  it('POST reset clears dataset + overlay with double backup, model untouched, idempotent re-reset', async () => {
    // Non-empty overlay on purpose: reset must archive it (D3/D8).
    const label = await app.inject({ method: 'PATCH', url: '/api/admin/flywheel/samples/life_keep', payload: { tier: 'ultra' } });
    assert.strictEqual(label.statusCode, 200);

    const modelStatBefore = fs.statSync(modelPath);
    const prevStatBefore = fs.statSync(`${modelPath}.previous`);
    const rawBefore = fs.readFileSync(datasetPath, 'utf8');

    const res = await app.inject({ method: 'POST', url: '/api/admin/flywheel/reset', payload: { confirm: 'RESET' } });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.removedRecords, 2);
    assert.strictEqual(body.removedLabels, 1);
    assert.ok(body.backupPath && fs.readFileSync(body.backupPath, 'utf8') === rawBefore);
    assert.ok(body.labelsBackupPath && fs.existsSync(body.labelsBackupPath));
    assert.strictEqual(body.modelUntouched, true);

    assert.strictEqual(fs.statSync(datasetPath).size, 0, 'dataset emptied');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(labelsPath, 'utf8')), {}, 'overlay cleared');
    const modelStatAfter = fs.statSync(modelPath);
    assert.strictEqual(modelStatAfter.mtimeMs, modelStatBefore.mtimeMs, 'weights file not even touched');
    assert.strictEqual(fs.readFileSync(modelPath, 'utf8'), JSON.stringify({ base: 'weights' }));
    // D8 names BOTH weight files: the automatic pre-training backup must
    // survive a data reset byte-for-byte (rollback stays possible).
    const prevStatAfter = fs.statSync(`${modelPath}.previous`);
    assert.strictEqual(prevStatAfter.mtimeMs, prevStatBefore.mtimeMs, '.previous weight backup not even touched');
    assert.strictEqual(fs.readFileSync(`${modelPath}.previous`, 'utf8'), JSON.stringify({ prev: 'old-weights' }));

    // Same-instance visibility: summary must now read zero.
    const stats = await app.inject({ method: 'GET', url: '/api/admin/flywheel/stats' });
    const st = JSON.parse(stats.body);
    assert.strictEqual(st.total, 0);
    assert.strictEqual(st.humanLabeled, 0);

    // Idempotent re-reset: nothing removed, no new backups.
    const again = await app.inject({ method: 'POST', url: '/api/admin/flywheel/reset', payload: { confirm: 'RESET' } });
    const b2 = JSON.parse(again.body);
    assert.strictEqual(b2.removedRecords, 0);
    assert.strictEqual(b2.backupPath, null);
    assert.strictEqual(b2.labelsBackupPath, null);
  });

  // 409-while-training: reaching a real mid-training state through inject()
  // would race the sync training loop's single setImmediate gap (trainer.ts
  // only yields once per run). Instead the guard is exercised at the seam the
  // routes actually read — FlywheelTrainer.prototype.isTraining() — on a
  // DEDICATED app instance, so the seed describe's server is never affected:
  // every destructive endpoint's check order (validation → 409 → engine) and
  // exact §3 error strings are pinned deterministically. Zero writes asserted,
  // so a mis-ordered guard that deletes anyway before 409ing would fail here.
  it('destructive POSTs 409 while training — guard order + error strings + zero writes', async () => {
    const lifeDir = path.resolve(process.cwd(), './data/test_fw_409');
    fs.rmSync(lifeDir, { recursive: true, force: true });
    fs.mkdirSync(lifeDir, { recursive: true });
    const guardDataset = path.join(lifeDir, 'flywheel.jsonl');
    const guardRaw = [v2line('g_keep', 'guard row')].join('\n') + '\n';
    fs.writeFileSync(guardDataset, guardRaw, 'utf8');
    // A readable overlay with one live entry — the 409 paths must not purge it.
    fs.writeFileSync(labelsPathFor(guardDataset), JSON.stringify({ g_keep: { tier: 'pro', updatedAt: '2026-01-01T00:00:00.000Z' } }), 'utf8');

    const cfg = loadConfig();
    cfg.host = '127.0.0.1';
    cfg.webAuth = { enabled: false };
    cfg.flywheel = { enabled: true, datasetPath: guardDataset, logUserPrompt: true };
    const original = FlywheelTrainer.prototype.isTraining;
    let guard = false;
    FlywheelTrainer.prototype.isTraining = function (this: FlywheelTrainer) {
      return guard || original.call(this);
    };
    try {
      const { app: guardApp } = createServer(cfg, true);
      const routes: Array<{ name: string; url: string; payload: Record<string, unknown>; want: string }> = [
        { name: 'prune', url: '/api/admin/flywheel/prune', payload: { apply: true }, want: 'A training run is in progress; pruning is paused.' },
        { name: 'delete', url: '/api/admin/flywheel/samples/delete', payload: { ids: ['g_keep'] }, want: 'A training run is in progress; deletion is paused.' },
        { name: 'reset', url: '/api/admin/flywheel/reset', payload: { confirm: 'RESET' }, want: 'A training run is in progress; reset is paused.' },
      ];
      guard = true;
      for (const r of routes) {
        const res = await guardApp.inject({ method: 'POST', url: r.url, payload: r.payload });
        assert.strictEqual(res.statusCode, 409, `${r.name} must 409 while training`);
        assert.strictEqual(JSON.parse(res.body).error, r.want, `${r.name} §3 error string`);
      }
      // Validation precedes the guard: a malformed body is still a 400 even
      // mid-training (cheap rejection before touching the trainer state).
      const bad = await guardApp.inject({ method: 'POST', url: '/api/admin/flywheel/samples/delete', payload: { ids: [] } });
      assert.strictEqual(bad.statusCode, 400, 'input validation runs before the 409 check');

      // Zero writes behind the guard.
      assert.strictEqual(fs.readFileSync(guardDataset, 'utf8'), guardRaw, 'dataset intact through all three 409s');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(labelsPathFor(guardDataset), 'utf8')), { g_keep: { tier: 'pro', updatedAt: '2026-01-01T00:00:00.000Z' } }, 'overlay intact');
      assert.strictEqual(fs.readdirSync(lifeDir).filter((n) => n.includes('.bak-') || n.includes('.deleted.jsonl')).length, 0, 'no backups/sidecars');

      // Guard releases when training ends: the same requests now succeed.
      guard = false;
      const ok = await guardApp.inject({ method: 'POST', url: '/api/admin/flywheel/samples/delete', payload: { ids: ['g_keep'] } });
      assert.strictEqual(ok.statusCode, 200);
      assert.strictEqual(JSON.parse(ok.body).deleted, 1);
      await guardApp.close();
    } finally {
      FlywheelTrainer.prototype.isTraining = original;
      fs.rmSync(lifeDir, { recursive: true, force: true });
    }
  });

  it('POST samples/delete accepts exactly the 1000-id cap (boundary)', async () => {
    const raw = fs.readFileSync(datasetPath, 'utf8');
    const ids = Array.from({ length: 1000 }, (_, i) => `absent-id-${i}`);
    const res = await app.inject({ method: 'POST', url: '/api/admin/flywheel/samples/delete', payload: { ids } });
    assert.strictEqual(res.statusCode, 200, '1000 is inside the cap; only >1000 400s');
    const body = JSON.parse(res.body);
    assert.strictEqual(body.deleted, 0);
    assert.strictEqual(body.notFound.length, 1000, 'every absent id reported');
    assert.strictEqual(fs.readFileSync(datasetPath, 'utf8'), raw, 'all-absent batch rewrote nothing');
  });
});

/** Shared codes on a server whose dataset file never exists: prune 404s, delete/reset are idempotent 200s. */
describe('Flywheel lifecycle API with no dataset file', () => {
  const tmpDir = path.resolve(process.cwd(), './data/test_fw_nods');
  const datasetPath = path.join(tmpDir, 'flywheel.jsonl');

  const config = loadConfig();
  config.host = '127.0.0.1';
  config.webAuth = { enabled: false };
  config.flywheel = { enabled: true, datasetPath, logUserPrompt: true };
  const { app } = createServer(config, true);

  before(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    // Deliberately NO dataset file.
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST prune 404s with the dataset path in the error envelope', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/flywheel/prune', payload: {} });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(JSON.parse(res.body).error, `No dataset file at ${datasetPath}`);
  });

  it('POST samples/delete reports every id as notFound with zero writes', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/flywheel/samples/delete', payload: { ids: ['x', 'y'] } });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.deleted, 0);
    assert.deepStrictEqual(body.notFound, ['x', 'y']);
    assert.ok(!fs.existsSync(`${datasetPath}.deleted.jsonl`), 'no sidecar written');
  });

  it('POST reset is idempotent on a missing dataset', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/flywheel/reset', payload: { confirm: 'RESET' } });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.removedRecords, 0);
    assert.strictEqual(body.backupPath, null);
    assert.strictEqual(body.labelsBackupPath, null);
    assert.strictEqual(body.modelUntouched, true);
    assert.ok(!fs.existsSync(datasetPath), 'reset did not create the dataset file');
  });
});

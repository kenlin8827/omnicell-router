import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FlywheelDataset } from '../src/flywheel/dataset.js';
import { FlywheelTrainer } from '../src/flywheel/trainer.js';
import { FlywheelCollector } from '../src/flywheel/collector.js';
import { FLYWHEEL_SCHEMA_VERSION, migrateRecord } from '../src/flywheel/schema.js';
import { DEFAULT_BASE_MODEL, Layer1Classifier } from '../src/router/layer1-classifier.js';
import { ChatCompletionRequest } from '../src/types/openai.js';
import { RoutingDecision } from '../src/types/router.js';

/**
 * Covers the flywheel loop end to end: v2 capture → legacy migration →
 * operator relabelling → training pool materialization → a real training run
 * that persists Layer 1 weights.
 */
describe('Flywheel dataset + training pipeline', () => {
  const tmpDir = path.resolve(process.cwd(), './data/test_fw_pipeline');
  const datasetPath = path.join(tmpDir, 'flywheel.jsonl');
  const modelPath = path.join(tmpDir, 'layer1-classifier.json');

  const decision = (targetTier: any): RoutingDecision => ({
    targetTier,
    confidence: 0.3,
    layerUsed: 'layer1',
    reason: 'Safe quality-first fallback',
    needsSchemaValidation: false,
    features: {
      tokenCountEstimate: 10, hasCode: false, hasMathOrProof: false,
      hasMultiTurn: false, hasToolsOrSchema: false, complexityScore: 4,
    },
  });

  const request = (content: string): ChatCompletionRequest => ({
    model: 'auto',
    messages: [{ role: 'user', content }],
  });

  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    Layer1Classifier.resetToBaseModel();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const seed = async (rows: Array<{ id: string; target: any; served: any; prompt: string; model?: string; fallback?: boolean }>) => {
    const collector = new FlywheelCollector({ enabled: true, datasetPath });
    for (const r of rows) {
      await collector.record({
        requestId: r.id,
        request: request(r.prompt),
        decision: decision(r.target),
        tierUsed: r.served,
        modelUsed: r.model || 'anthropic/claude-sonnet',
        fallbackOccurred: r.fallback === true,
        fallbackReason: r.fallback ? 'upstream 500' : undefined,
        latencyMs: 400,
      });
    }
    return new FlywheelDataset(datasetPath);
  };

  it('treats a pre-v2 line as malformed (no v1 reader)', () => {
    const legacy = {
      id: 'old-1',
      userPrompt: 'hi',
      routing: { targetTier: 'plus' },
      label: { labelSource: 'layer1_confident' },
    };
    assert.strictEqual(migrateRecord(legacy), null);
  });

  it('survives malformed dataset lines', () => {
    fs.writeFileSync(
      datasetPath,
      '{"id":"ok","v":2,"input":{"userPrompt":"x"}}\nnot json at all\n\n{"broken":\n',
      'utf8'
    );
    const ds = new FlywheelDataset(datasetPath);
    assert.strictEqual(ds.summary().total, 1);
  });

  it('summarizes, filters and paginates the dataset', async () => {
    const ds = await seed([
      { id: 'a', target: 'plus', served: 'lite', prompt: 'short greeting' },
      { id: 'b', target: 'lite', served: 'plus', prompt: 'implement a red-black tree', fallback: true },
      { id: 'c', target: 'lite', served: 'lite', prompt: 'mock traffic', model: 'mock-plus' },
    ]);

    const s = ds.summary();
    assert.strictEqual(s.total, 3);
    assert.strictEqual(s.synthetic, 1, 'mock-* fixture is auto-flagged');
    assert.strictEqual(s.trainable, 2, 'synthetic rows never enter the pool');

    const onlyLite = ds.query({ tier: 'lite' });
    assert.strictEqual(onlyLite.total, 1, 'synthetic row hidden by default');

    const withSynthetic = ds.query({ tier: 'lite', includeSynthetic: true });
    assert.strictEqual(withSynthetic.total, 2);

    const page = ds.query({ limit: 1, offset: 1, includeSynthetic: true });
    assert.strictEqual(page.rows.length, 1);
    assert.strictEqual(page.total, 3);
    assert.strictEqual(page.offset, 1);

    assert.strictEqual(ds.query({ search: 'red-black' }).total, 1);
    assert.strictEqual(ds.query({ trainableOnly: true }).total, 2);

    // Human relabels must be visible to tier/source filters even though the
    // index columns still hold the observed values.
    ds.setLabel('a', 'ultra');
    assert.strictEqual(ds.query({ tier: 'ultra', source: 'human' }).total, 1);
    assert.strictEqual(ds.query({ tier: 'ultra' }).total, 1);
    assert.strictEqual(ds.query({ source: 'human' }).total, 1);
    assert.strictEqual(ds.setLabel('a', null)?.tier, 'lite');
    assert.strictEqual(ds.query({ tier: 'ultra', source: 'human' }).total, 0);
  });

  it('relabelling writes an overlay and never rewrites the dataset', async () => {
    const ds = await seed([{ id: 'x', target: 'lite', served: 'lite', prompt: 'ambiguous case' }]);
    const before = fs.readFileSync(datasetPath, 'utf8');

    const updated = ds.setLabel('x', 'ultra');
    assert.strictEqual(updated?.tier, 'ultra');
    assert.strictEqual(updated?.source, 'human');
    assert.strictEqual(updated?.confidence, 1);

    // Append-only dataset is byte-identical.
    assert.strictEqual(fs.readFileSync(datasetPath, 'utf8'), before);
    assert.ok(fs.existsSync(ds.getLabelsPath()), 'overlay sidecar written');

    // A fresh reader picks the overlay up.
    assert.strictEqual(new FlywheelDataset(datasetPath).query({}).rows[0].label.tier, 'ultra');
    assert.strictEqual(ds.summary().humanLabeled, 1);

    // Clearing restores the observed label.
    assert.strictEqual(ds.setLabel('x', null)?.tier, 'lite');
    assert.strictEqual(ds.setLabel('nope', 'pro'), null);

    assert.strictEqual(ds.clearOverrides(), 0);
  });

  it('materializes only trainable, trustworthy samples', async () => {
    const ds = await seed([
      { id: 'a', target: 'lite', served: 'lite', prompt: 'hello' },
      { id: 'b', target: 'lite', served: 'pro', prompt: 'prove fermat', fallback: true },
      { id: 'c', target: 'lite', served: 'lite', prompt: 'mock', model: 'mock-lite' },
    ]);

    const pool = ds.trainingSamples();
    assert.strictEqual(pool.samples.length, 2, 'synthetic row dropped');
    assert.strictEqual(pool.skipped.synthetic, 1);
    assert.strictEqual(pool.featureDimensions, DEFAULT_BASE_MODEL.featureDimensions);
    assert.deepStrictEqual(pool.samples.map((s) => s.targetTier).sort(), ['lite', 'pro']);

    // Human labels survive the minSource floor.
    ds.setLabel('a', 'ultra');
    const afterLabel = ds.trainingSamples();
    assert.ok(afterLabel.samples.some((s) => s.targetTier === 'ultra'));
  });

  it('trains Layer 1 and persists the weights', async () => {
    const rows: Array<any> = [];
    // Two structurally distinct clusters so the fit is not degenerate.
    for (let i = 0; i < 20; i++) {
      rows.push({ id: `easy-${i}`, target: 'lite', served: 'lite', prompt: 'hi' });
      rows.push({ id: `hard-${i}`, target: 'pro', served: 'pro', prompt: 'Prove that the halting problem is undecidable'.repeat(6) });
    }
    const ds = await seed(rows);

    // Production always runs Layer1Classifier.init() at boot, which writes the
    // base scaffold to disk before any training can happen. Replicate that
    // ordering so the pre-training backup has something real to snapshot.
    await Layer1Classifier.init({ enabled: true, modelPath });

    const trainer = new FlywheelTrainer(ds, modelPath);
    assert.strictEqual(trainer.isTraining(), false);
    assert.strictEqual(trainer.modelInfo().isBaseModel, true, 'no model file yet');

    const outcome = await trainer.train({ epochs: 120, lr: 0.3 });
    assert.strictEqual(outcome.started, true, outcome.error);
    assert.ok(outcome.report);
    assert.strictEqual(outcome.report.trainedSamples, 40);
    assert.strictEqual(outcome.report.accuracy > 0.9, true, `accuracy was ${outcome.report.accuracy}`);

    // Persisted, and no longer the base scaffold.
    assert.ok(fs.existsSync(modelPath));
    const saved = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    assert.strictEqual(saved.isBaseModel, false);
    assert.strictEqual(saved.sampleCount, 40);
    assert.ok(saved.lastTrainedAt);
    assert.strictEqual(trainer.getState().status, 'success');
    assert.ok(trainer.getState().lastTrainedAt);

    // The pre-training backup exists and rollback restores it.
    assert.strictEqual(trainer.modelInfo().previousModelExists, true);
    assert.strictEqual(trainer.rollback(), true);
    const rolledBack = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    assert.strictEqual(rolledBack.isBaseModel, true, 'pre-training weights were the base scaffold');

    // Retrain (backup = base again, since disk holds the rolled-back scaffold),
    // then train once more WITHOUT rolling back in between: now the backup is
    // the first trained version, and rollback returns there instead of base.
    assert.strictEqual((await trainer.train({ epochs: 120, lr: 0.3 })).started, true);
    assert.strictEqual((await trainer.train({ epochs: 120, lr: 0.3 })).started, true);
    assert.strictEqual(trainer.rollback(), true);
    const afterRollback = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    assert.strictEqual(afterRollback.isBaseModel, false, 'backup tracks the weights being replaced');
    assert.strictEqual(afterRollback.sampleCount, 40);
  });

  it('reports whether the router consumes trained weights', async () => {
    const ds = await seed([
      { id: 'a', target: 'lite', served: 'lite', prompt: 'hello' },
      { id: 'b', target: 'pro', served: 'pro', prompt: 'derive the Navier-Stokes existence problem' },
    ]);
    const gated = new FlywheelTrainer(ds, modelPath, undefined, false);
    assert.strictEqual(gated.modelInfo().routingConsumesModel, false);
    const open = new FlywheelTrainer(ds, modelPath, undefined, true);
    assert.strictEqual(open.modelInfo().routingConsumesModel, true);
    // Default constructor (no flag) reports false — an unconfigured gate is closed.
    assert.strictEqual(new FlywheelTrainer(ds, modelPath).modelInfo().routingConsumesModel, false);
  });

  it('refuses to train an empty pool and serializes concurrent runs', async () => {
    fs.writeFileSync(datasetPath, '', 'utf8');
    const ds = new FlywheelDataset(datasetPath);

    const trainer = new FlywheelTrainer(ds, modelPath);
    const empty = await trainer.train();
    assert.strictEqual(empty.started, true);
    assert.match(empty.error || '', /No trainable samples/);
    assert.strictEqual(trainer.getState().status, 'failed');

    const seeded = await seed([
      { id: 'a', target: 'lite', served: 'lite', prompt: 'hello' },
      { id: 'b', target: 'pro', served: 'pro', prompt: 'derive the Navier-Stokes existence problem' },
    ]);
    const t2 = new FlywheelTrainer(seeded, modelPath);
    const [first, second] = await Promise.all([t2.train({ epochs: 50 }), t2.train({ epochs: 50 })]);
    const started = [first, second].filter((r) => r.started);
    assert.strictEqual(started.length, 1, 'only one run may be in flight');
    const rejected = [first, second].find((r) => !r.started)!;
    assert.match(rejected.error || '', /already in progress/);
  });
});

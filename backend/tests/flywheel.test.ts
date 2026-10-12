import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Layer1Classifier, DEFAULT_BASE_MODEL } from '../src/router/layer1-classifier.js';

import { RouterEngine } from '../src/router/index.js';
import { FlywheelCollector } from '../src/flywheel/collector.js';
import { FLYWHEEL_SCHEMA_VERSION } from '../src/flywheel/schema.js';
import { ChatCompletionRequest } from '../src/types/openai.js';

describe('Layer 1 & Layer 2 Routing and Data Flywheel', () => {
  const testFlywheelPath = path.resolve(process.cwd(), './data/test_flywheel.jsonl');
  const testModelPath = path.resolve(process.cwd(), './models/test_layer1_classifier.json');

  beforeEach(() => {
    if (fs.existsSync(testFlywheelPath)) {
      fs.unlinkSync(testFlywheelPath);
    }
    if (fs.existsSync(testModelPath)) {
      fs.unlinkSync(testModelPath);
    }
  });

  afterEach(() => {
    Layer1Classifier.resetToBaseModel();
    if (fs.existsSync(testFlywheelPath)) {
      fs.unlinkSync(testFlywheelPath);
    }
    if (fs.existsSync(testModelPath)) {
      fs.unlinkSync(testModelPath);
    }
  });

  it('Layer 1 should auto-initialize empty base model scaffold with guaranteed low confidence (< 0.85)', async () => {
    // Initialize with a test path that does not exist yet
    await Layer1Classifier.init({ enabled: true, modelPath: testModelPath });

    // 1. Verify file was physically created on disk
    assert.ok(fs.existsSync(testModelPath), 'Base model file should be auto-created on disk');
    assert.strictEqual(Layer1Classifier.isBaseModel(), true, 'Should be flagged as base model');

    // 2. Perform forward pass on general prompt (not structured protocol)
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Explain quantum computing' }],
    };

    const pred = Layer1Classifier.predict(req, { enabled: true, confidenceThreshold: 0.85 });

    // Mathematical guarantees of untrained base model:
    assert.strictEqual(pred.isConfident, false, 'Untrained base model confidence must be insufficient');
    assert.ok(pred.confidence < 0.40, `Confidence ${pred.confidence} should be near uniform 0.33`);
    assert.strictEqual(pred.isBaseModel, true);
    assert.strictEqual(pred.reasonCode, 'l1.base_scaffold', 'Reason code should identify base model scaffold');
  });

  it('RouterEngine.routeAsync should cascade untrained base model to Layer 2, never short-circuiting', async () => {
    // Reset to base model
    await Layer1Classifier.init({ enabled: true, modelPath: testModelPath });

    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
    };

    const decision = await RouterEngine.routeAsync(req, {
      localModel: { enabled: true, confidenceThreshold: 0.85 },
      // Layer 2 not enabled in this unit test -> cascades to default safe plus baseline
    });

    // Layer 1 didn't claim high confidence -> gracefully passed to default/Layer 2
    assert.strictEqual(decision.targetTier, 'plus');
    assert.strictEqual(decision.layerUsed, 'layer1');
    assert.ok(decision.confidence < 0.50);
  });

  it('Layer 1 Layer1Classifier can be trained in-place from samples to produce confident predictions', async () => {
    await Layer1Classifier.init({ enabled: true, modelPath: testModelPath });

    // Generate training samples for Fast vs Reasoning
    const reqFast: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const reqReasoning: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        { role: 'system', content: 'Complex logic thinking system' },
        { role: 'user', content: '```python\ndef solve_np_hard(): pass\n```\n' + 'x = y + z; '.repeat(50) },
      ],
    };

    const featFast = Layer1Classifier.extractFeatures(reqFast).vector;
    const featReasoning = Layer1Classifier.extractFeatures(reqReasoning).vector;

    const samples = [
      ...Array(20).fill({ features: featFast, targetTier: 'lite' as const }),
      ...Array(20).fill({ features: featReasoning, targetTier: 'pro' as const }),
    ];

    const trainRes = Layer1Classifier.train(samples, { epochs: 100, lr: 0.2 });
    assert.strictEqual(trainRes.trainedSamples, 40);
    assert.ok(trainRes.accuracy > 0.80, `Trained accuracy should be high: ${trainRes.accuracy}`);
    assert.strictEqual(Layer1Classifier.isBaseModel(), false, 'Model is now trained, no longer empty base');

    // Predict on reqReasoning with low threshold
    const predAfterTrain = Layer1Classifier.predict(reqReasoning, { enabled: true, confidenceThreshold: 0.50 });
    assert.strictEqual(predAfterTrain.isConfident, true);
    assert.strictEqual(predAfterTrain.targetTier, 'pro');
  });

  it('Layer 1 Layer1Classifier should produce calibrated probabilities and respect confidence gating for schema tasks', () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Generate JSON data' }],
      response_format: { type: 'json_object' },
    };

    // 1. High confidence threshold (e.g. 0.99) -> isConfident = false
    const predStrict = Layer1Classifier.predict(req, { enabled: true, confidenceThreshold: 0.99 });
    assert.strictEqual(predStrict.isConfident, false);
    assert.strictEqual(predStrict.targetTier, 'lite');
    assert.ok(predStrict.probabilities.lite > 0.5);

    // 2. Realistic threshold (0.70) -> isConfident = true
    const predNormal = Layer1Classifier.predict(req, { enabled: true, confidenceThreshold: 0.70 });
    assert.strictEqual(predNormal.isConfident, true);
    assert.strictEqual(predNormal.targetTier, 'lite');
  });

  it('FlywheelCollector should log samples and record negative sample flag on schema fallback', async () => {
    const collector = new FlywheelCollector({
      enabled: true,
      datasetPath: testFlywheelPath,
      logUserPrompt: true,
    });

    const dummyReq: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Extract invoice json data' }],
    };

    // Record sample 1: successful Lite tier run
    await collector.record({
      requestId: 'test-req-1',
      request: dummyReq,
      decision: {
        targetTier: 'lite',
        confidence: 0.9,
        layerUsed: 'layer0',
        reason: 'Fast rule',
        needsSchemaValidation: true,
        features: {
          tokenCountEstimate: 20,
          hasCode: false,
          hasMathOrProof: false,
          hasMultiTurn: false,
          hasToolsOrSchema: true,
          complexityScore: 2.0,
        },
      },
      tierUsed: 'lite',
      modelUsed: 'mock-lite',
      fallbackOccurred: false,
      latencyMs: 120,
    });

    // Record sample 2: Lite tier schema assertion failed -> Escalated fallback to plus
    await collector.record({
      requestId: 'test-req-2',
      request: dummyReq,
      decision: {
        targetTier: 'lite',
        confidence: 0.85,
        layerUsed: 'layer0',
        reason: 'Initial guess',
        needsSchemaValidation: true,
        features: {
          tokenCountEstimate: 50,
          hasCode: false,
          hasMathOrProof: false,
          hasMultiTurn: false,
          hasToolsOrSchema: true,
          complexityScore: 3.5,
        },
      },
      tierUsed: 'plus',
      modelUsed: 'mock-plus',
      fallbackOccurred: true,
      fallbackReason: 'Missing field: invoiceNumber',
      latencyMs: 850,
    });

    const stats = collector.getStats();
    assert.strictEqual(stats.totalSamples, 2);
    assert.strictEqual(stats.fallbackCount, 1);
    assert.strictEqual(stats.tierDistribution.lite, 1);
    assert.strictEqual(stats.tierDistribution.plus, 1);

    // Verify written file content
    assert.ok(fs.existsSync(testFlywheelPath));
    const content = fs.readFileSync(testFlywheelPath, 'utf8').trim().split('\n');
    assert.strictEqual(content.length, 2);

    // Schema v2: the label records the tier that actually SERVED the request,
    // and the decision reason is kept as the provenance signal.
    const record2 = JSON.parse(content[1]);
    assert.strictEqual(record2.v, FLYWHEEL_SCHEMA_VERSION);
    assert.strictEqual(record2.id, 'test-req-2');
    assert.strictEqual(record2.label.isNegativeForLite, true);
    assert.strictEqual(record2.label.tier, 'plus');
    assert.strictEqual(record2.label.source, 'runtime_fallback');
    assert.strictEqual(record2.label.overridden, true); // wanted lite, served plus
    assert.strictEqual(record2.decision.reason, 'Initial guess');
    // The trainer's input: 8 structural features captured at request time.
    assert.strictEqual(record2.input.featureVector.length, DEFAULT_BASE_MODEL.featureDimensions);
    assert.deepStrictEqual(record2.input.featureNames, DEFAULT_BASE_MODEL.featureNames);
    // mock-* fixtures are auto-flagged so they never reach the training pool.
    assert.strictEqual(record2.execution.isSynthetic, true);
  });

  it('FlywheelCollector v2 labels from the tier that served, not the tier requested', async () => {
    const collector = new FlywheelCollector({ enabled: true, datasetPath: testFlywheelPath });
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Refactor the auth middleware' }],
    };

    await collector.record({
      requestId: 'v2-override',
      request: req,
      decision: {
        targetTier: 'ultra',
        confidence: 0.25,
        layerUsed: 'layer1',
        reason: 'Safe quality-first fallback',
        needsSchemaValidation: false,
        features: {
          tokenCountEstimate: 8, hasCode: true, hasMathOrProof: false,
          hasMultiTurn: false, hasToolsOrSchema: false, complexityScore: 4,
        },
      },
      tierUsed: 'plus', // the session ratchet clamped it below the request
      modelUsed: 'anthropic/claude-sonnet',
      fallbackOccurred: false,
      latencyMs: 1200,
    });

    const rows = fs.readFileSync(testFlywheelPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const rec = rows.find((r) => r.id === 'v2-override');
    assert.ok(rec, 'record should be written');
    // v1 copied decision.targetTier into the label, which silently erased the
    // single most informative field in the dataset.
    assert.strictEqual(rec.label.tier, 'plus');
    assert.strictEqual(rec.decision.targetTier, 'ultra');
    assert.strictEqual(rec.label.overridden, true);
    assert.strictEqual(rec.label.source, 'observed_execution');
    assert.strictEqual(rec.execution.isSynthetic, false);
  });
});

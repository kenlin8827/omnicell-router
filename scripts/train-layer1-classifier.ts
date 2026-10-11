/**
 * CLI front-end for the learning flywheel's training stage.
 *
 * Delegates to FlywheelDataset + FlywheelTrainer — the same modules the console
 * API uses — so a CLI run and a console-triggered run cannot drift apart.
 *
 * (This script previously re-implemented its own JSONL parsing: it rebuilt a
 * synthetic request from the stored prompt text and re-extracted features from
 * it, which silently produced wrong vectors for truncated/redacted rows, and it
 * read the v1 `label.groundTruthTier` self-copy as ground truth.)
 */
import path from 'node:path';
import { loadConfig } from '../backend/src/config/index.js';
import { FlywheelDataset } from '../backend/src/flywheel/dataset.js';
import { FlywheelTrainer } from '../backend/src/flywheel/trainer.js';
import { FLYWHEEL_TIERS } from '../backend/src/flywheel/schema.js';

async function main() {
  console.log('============================================================');
  console.log('🧠 OCR (OpenCode Router) Layer 1 Classifier Trainer (Learning Flywheel)');
  console.log('============================================================\n');

  const config = loadConfig();
  const datasetPath = path.resolve(
    process.cwd(),
    config.flywheel?.datasetPath || './data/flywheel.jsonl'
  );
  const modelPath =
    config.classifier?.localModel?.modelPath ||
    path.resolve(process.cwd(), 'models/layer1-classifier.json');

  const dataset = new FlywheelDataset(datasetPath);
  const trainer = new FlywheelTrainer(dataset, modelPath);
  const summary = dataset.summary();

  console.log(`📂 Dataset : ${datasetPath}`);
  console.log(`🧠 Model   : ${modelPath}`);
  console.log(`📝 Records : ${summary.total} (trainable ${summary.trainable}, test traffic ${summary.synthetic})`);

  if (summary.total === 0) {
    console.log('\n⚠️ Dataset is empty. Send some gateway traffic first.');
    return;
  }
  if (summary.trainable === 0) {
    console.log('\n⚠️ No trainable samples.');
    console.log('💡 Trainable rows need BOTH a feature vector and a label.');
    console.log('   Legacy v1 rows kept only a truncated prompt, so their 8 features');
    console.log('   cannot be reconstructed — they stay visible in the console but are');
    console.log('   never trained on. Collect traffic under schema v2 to fill the pool.');
    return;
  }

  console.log('\n⏳ Running micro-tensor softmax cross-entropy gradient descent (L2 regularized)...');
  const outcome = await trainer.train({ balanceClasses: true, epochs: 200, lr: 0.15 });

  if (outcome.error || !outcome.report) {
    console.error(`\n❌ Training failed: ${outcome.error ?? 'unknown error'}\n`);
    process.exitCode = 1;
    return;
  }

  const r = outcome.report;
  console.log('\n============================================================');
  console.log('✅ Layer 1 model training complete!');
  console.log('============================================================');
  console.log(`👉 Total Trained Samples : ${r.trainedSamples}`);
  console.log(`👉 Final Converged Loss  : ${r.finalLoss}`);
  console.log(`👉 Training Set Accuracy : ${(r.accuracy * 100).toFixed(1)}%`);
  console.log(`👉 Duration              : ${r.durationMs} ms`);
  console.log(`👉 Class Mix             : ${FLYWHEEL_TIERS.map((t) => `${t}:${r.classDistribution[t] ?? 0}`).join('  ')}`);
  console.log(`👉 Model Output Path     : ${r.modelPath}`);
  console.log('============================================================');

  const skipped = Object.entries(r.skipped)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join('  ');
  if (skipped) console.log(`⏭️  Skipped              : ${skipped}`);

  console.log('\n⚡ Effective immediately — set classifier.localModel.enabled=true to route on it.');
  console.log('   (The base scaffold always stays below the confidence threshold.)\n');
}

main().catch(err => {
  console.error('Training failed:', err);
  process.exit(1);
});

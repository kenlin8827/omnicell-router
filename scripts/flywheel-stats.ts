/**
 * CLI analytics for the learning flywheel dataset.
 *
 * Reads through FlywheelDataset so the numbers match what the console shows,
 * including the v1→v2 migration and the operator-label overlay.
 */
import path from 'node:path';
import { loadConfig } from '../backend/src/config/index.js';
import { FlywheelDataset } from '../backend/src/flywheel/dataset.js';
import { FLYWHEEL_TIERS } from '../backend/src/flywheel/schema.js';

function pct(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '0.0%';
}

function main() {
  const config = loadConfig();
  const filePath = path.resolve(process.cwd(), config.flywheel?.datasetPath || './data/flywheel.jsonl');
  const dataset = new FlywheelDataset(filePath);
  const s = dataset.summary();

  console.log(`\n======================================================`);
  console.log(`📊 OCR (OpenCode Router) — Learning Flywheel Analytics`);
  console.log(`======================================================`);
  console.log(`📂 Dataset : ${s.datasetPath}`);
  console.log(`🏷️  Labels  : ${s.labelsPath}`);
  console.log(`📝 Total Records   : ${s.total}`);
  console.log(`🧠 Trainable      : ${s.trainable}`);
  console.log(`🖐️  Human Labeled  : ${s.humanLabeled}`);
  console.log(`🧪 Test Traffic   : ${s.synthetic}`);
  console.log(`⬜ Unlabeled      : ${s.unlabeled}`);
  if (s.firstTimestamp && s.lastTimestamp) {
    console.log(`🕒 Span           : ${s.firstTimestamp} → ${s.lastTimestamp}`);
  }

  console.log(`\n--- Trainable Label Distribution ---`);
  for (const tier of FLYWHEEL_TIERS) {
    const n = s.trainableByTier[tier] || 0;
    console.log(`  • ${tier}: ${n} (${pct(n, s.trainable)} of pool)`);
  }

  console.log(`\n--- Label Provenance ---`);
  for (const [source, n] of Object.entries(s.sourceDistribution)) {
    console.log(`  • ${source}: ${n} (${pct(n, s.total)})`);
  }

  if (s.synthetic > 0) {
    console.log(
      `\n⚠️  ${s.synthetic} bench/test rows are excluded from training by default.`
    );
    console.log('   Pass --include-synthetic in the console, or scrub the dataset.');
  }
  if (s.unlabeled > 0) {
    console.log(`\n⚠️  ${s.unlabeled} rows carry no usable label and cannot be trained on.`);
  }
  console.log(`======================================================\n`);
}

main();

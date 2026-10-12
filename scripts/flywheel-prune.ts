/**
 * Prune the learning-flywheel dataset — thin CLI wrapper over the shared
 * lifecycle engine (backend/src/flywheel/prune.ts), which the HTTP console
 * and the collector's retention sweep use too. Flags and output format are
 * preserved from the original standalone script; the engine adds backup
 * rotation (newest 3) and the labels-overlay orphan purge.
 *
 * Two things make a dataset unusable and neither is fixable in code:
 *   1. bench/test traffic — `bun test` appends its fixtures to the same
 *      append-only file the gateway writes (the collector keys off a
 *      config.flywheel.enabled that the test process reads from disk);
 *   2. duplicate ids — a retried request appends the same id again.
 *
 * The dataset is append-only under normal operation, so pruning rewrites it
 * atomically: everything that survives is copied byte-for-byte, and the
 * previous file is backed up next to it. Dry-run is the default — pass
 * --apply to write. While the gateway is running prefer the console's
 * POST /api/admin/flywheel/prune (it invalidates the live index immediately;
 * the inode guard self-heals after an offline rewrite, but the console is
 * one round-trip).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../backend/src/config/index.js';
import { pruneDataset } from '../backend/src/flywheel/prune.js';

function main() {
  const args = new Set(process.argv.slice(2));
  const opts = {
    apply: args.has('--apply'),
    dropSynthetic: !args.has('--keep-synthetic'),
    dropDuplicates: !args.has('--keep-duplicates'),
    // Schema v1 rows carry no feature vector and can never be trained on, so
    // once the v2 pool has real data they are dead weight. Off by default:
    // they are still the only record of past routing decisions.
    dropLegacy: args.has('--drop-legacy'),
  };

  const config = loadConfig();
  const datasetPath = path.resolve(process.cwd(), config.flywheel?.datasetPath || './data/flywheel.jsonl');

  if (!fs.existsSync(datasetPath)) {
    console.log(`[Flywheel] No dataset at ${datasetPath}.`);
    return;
  }

  const result = pruneDataset(datasetPath, opts, opts.apply);
  if (!result) return; // vanished between the existence check and the read

  console.log(`\n[Flywheel] ${datasetPath}`);
  console.log(`  lines read      : ${result.total}`);
  console.log(`  kept            : ${result.kept}`);
  if (opts.dropSynthetic) console.log(`  dropped synthetic: ${result.dropped.synthetic}`);
  if (opts.dropLegacy) console.log(`  dropped legacy v1: ${result.dropped.legacy}`);
  if (opts.dropDuplicates) console.log(`  dropped duplicate: ${result.dropped.duplicate}`);
  if (result.dropped.malformed) console.log(`  dropped malformed: ${result.dropped.malformed}`);

  if (result.total === result.kept) {
    console.log('\n  Nothing to prune.\n');
    return;
  }

  if (!result.applied) {
    console.log('\n  Dry run — pass --apply to rewrite the dataset.');
    console.log('  The previous file is always backed up next to it.\n');
    return;
  }

  console.log(`\n  ✓ Pruned. Backup: ${result.backupPath}`);
  console.log(`    (delete the backup once the dataset looks right)\n`);
}

main();

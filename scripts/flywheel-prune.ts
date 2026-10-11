/**
 * Prune the learning-flywheel dataset.
 *
 * Two things make a dataset unusable and neither is fixable in code:
 *   1. bench/test traffic — `bun test` appends its fixtures to the same
 *      append-only file the gateway writes (the collector keys off a
 *      config.flywheel.enabled that the test process reads from disk);
 *   2. duplicate ids — a retried request appends the same id again.
 *
 * The dataset is append-only by design, so pruning rewrites it atomically:
 * everything that survives is copied byte-for-byte, and the removed lines are
 * backed up next to the file. Dry-run is the default — pass --apply to write.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../backend/src/config/index.js';
import { FLYWHEEL_SCHEMA_VERSION, detectSynthetic, migrateRecord } from '../backend/src/flywheel/schema.js';

interface Options {
  apply: boolean;
  dropSynthetic: boolean;
  dropDuplicates: boolean;
  dropLegacy: boolean;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const opts: Options = {
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

  const raw = fs.readFileSync(datasetPath, 'utf8');
  const lines = raw.split('\n');
  const kept: string[] = [];
  const seenIds = new Set<string>();
  let droppedSynthetic = 0;
  let droppedDuplicate = 0;
  let droppedMalformed = 0;
  let droppedLegacy = 0;
  let total = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    total++;

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      droppedMalformed++;
      continue;
    }

    // Reuse the collector's own detector so a prune can never disagree with
    // what the console labels as test traffic.
    const isSynthetic =
      parsed?.execution?.isSynthetic === true ||
      detectSynthetic(String(parsed?.id ?? ''), String(parsed?.execution?.modelUsed ?? ''), parsed?.execution?.fallbackReason);

    if (opts.dropSynthetic && isSynthetic) {
      droppedSynthetic++;
      continue;
    }

    if (opts.dropLegacy && parsed?.v !== FLYWHEEL_SCHEMA_VERSION) {
      droppedLegacy++;
      continue;
    }

    if (opts.dropDuplicates) {
      const migrated = migrateRecord(parsed);
      const id = migrated?.id ?? trimmed;
      if (seenIds.has(id)) {
        droppedDuplicate++;
        continue;
      }
      seenIds.add(id);
    }

    kept.push(trimmed);
  }

  console.log(`\n[Flywheel] ${datasetPath}`);
  console.log(`  lines read      : ${total}`);
  console.log(`  kept            : ${kept.length}`);
  if (opts.dropSynthetic) console.log(`  dropped synthetic: ${droppedSynthetic}`);
  if (opts.dropLegacy) console.log(`  dropped legacy v1: ${droppedLegacy}`);
  if (opts.dropDuplicates) console.log(`  dropped duplicate: ${droppedDuplicate}`);
  if (droppedMalformed) console.log(`  dropped malformed: ${droppedMalformed}`);

  if (kept.length === total) {
    console.log('\n  Nothing to prune.\n');
    return;
  }

  if (!opts.apply) {
    console.log('\n  Dry run — pass --apply to rewrite the dataset.');
    console.log('  The previous file is always backed up next to it.\n');
    return;
  }

  const backupPath = `${datasetPath}.bak-${Date.now()}`;
  fs.writeFileSync(backupPath, raw, 'utf8');
  const tmp = `${datasetPath}.tmp`;
  fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
  fs.renameSync(tmp, datasetPath);

  console.log(`\n  ✓ Pruned. Backup: ${backupPath}`);
  console.log(`    (delete the backup once the dataset looks right)\n`);
}

main();

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { getEnvRootDir } from '../config/env.js';
import type { Layer2DecisionConfig } from '../config/types.js';

/**
 * Decision-capture SINK for the Layer 2 System One decision layer. Nothing else
 * records what the DECISION decided, which is exactly the raw material two
 * future capabilities need:
 *   - distilling converted chat-model judgments into a native decision model
 *   - calibrating the "uncalibrated self-report" confidence
 *
 * Deferred data cannot be recovered, so the sink exists from day one — but it
 * is OPT-IN behind a SINGLE-KEY gate: `classifier.layer2.collectEnabled`. The
 * old three-tier chain (capture.enabled × systemoneEnabled × l2DecisionEnabled)
 * is retired — the capture master switch no longer involves this sink; the
 * capture page never shows these rows either. `state` carries user
 * conversation content, so the default stays OFF. Nothing consumes the file
 * yet by design; the trainer for native decision models is deliberately out
 * of scope until real traffic exists to train on.
 *
 * Size cap: once the dataset passes 64 MB sampling PAUSES (warn once per
 * process) — a runaway jsonl must not fill the operator's disk unnoticed.
 * Deleting/rotating the file resumes writes.
 *
 * Gating lives HERE, not in the decision layer: callers stay dumb and just hand over
 * the decided row. Console config saves hot-apply via applyConfig (called
 * beside CaptureRecorder.applyConfig in routes/console.ts, fed the
 * classifier.layer2 node) — no restart.
 *
 * Correlation note: rows carry no requestId (the decision layer sits below the layer
 * that mints one). Join with trace records by timestamp proximity when an
 * accuracy evaluation is built — or thread requestId through routeAsync in a
 * future change.
 */

export interface DecisionCaptureRecord {
  v: 1;
  ts: string;
  source: 'layer2_decision';
  model: string;
  provider: string;
  /** Which limb served the decision layer call ('native' passthrough or 'converted'). */
  upstreamKind: 'converted' | 'native';
  /** The exact System One state the decision layer evaluated (user content — opt-in). */
  state: unknown;
  tier: string;
  confidence: number;
  latencyMs: number;
}

// Fixed dataset path, relative to the ACTIVE ENVIRONMENT's root (see
// applyConfig): the trainer-side contract reads this exact file, so unlike
// the retired decisionCapture block it is no longer a config knob. The path
// resolves against the env root (env.ts getEnvPaths). Upgrade path if it ever
// must move: add a classifier.layer2.collectDatasetPath key next to the gate.
const DATASET_PATH = './data/layer2-decisions.jsonl';

// Hard ceiling for the dataset: past this, sampling pauses (see capWarned).
const MAX_DATASET_BYTES = 64 * 1024 * 1024;

let captureConfig: { enabled: boolean; datasetPath: string } | null = null;
let capWarned = false;

/**
 * Derive the gate from the classifier.layer2 config node: the sink writes
 * only when `collectEnabled` is literally true (single key; absent/false =
 * closed). Called by the console save paths and lazily to seed from disk
 * config.
 */
export function applyConfig(cfg?: Layer2DecisionConfig): { enabled: boolean; datasetPath: string } {
  const enabled = cfg?.collectEnabled === true;
  const datasetPath = path.resolve(getEnvRootDir(), DATASET_PATH);
  captureConfig = { enabled, datasetPath };
  if (enabled) {
    const dir = path.dirname(datasetPath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        // Sink failures must never touch routing — handled at append time too.
      }
    }
  }
  return captureConfig;
}

/**
 * Pure size-capacity check (exported as the test seam — no 64 MB fixtures).
 * A missing file counts as empty. Past the cap the first caller warns ONCE
 * per process and every later caller is told "no capacity" until the file
 * shrinks (delete/rotate) or the process restarts.
 */
export function datasetHasCapacity(datasetPath: string, maxBytes: number = MAX_DATASET_BYTES): boolean {
  let size = 0;
  try {
    size = fs.statSync(datasetPath).size;
  } catch {
    size = 0; // absent = fresh
  }
  if (size > maxBytes) {
    if (!capWarned) {
      capWarned = true;
      console.warn(
        '[layer2-decisions] 64MB cap reached, sampling paused — delete or rotate data/layer2-decisions.jsonl to resume (warns once per process).'
      );
    }
    return false;
  }
  return true;
}

/** Current gate state; seeded from the disk config until a hot apply lands. */
function getConfig(): { enabled: boolean; datasetPath: string } {
  return captureConfig ?? applyConfig(loadConfig().classifier?.layer2);
}

/** Append one decided decision. Fire-and-forget: capture is observability, so
 *  every failure degrades to a warn, never an error thrown into routing. */
export function captureDecision(record: Omit<DecisionCaptureRecord, 'v' | 'ts' | 'source'>): void {
  const config = getConfig();
  if (!config.enabled) return;
  // Stat-then-append races a few rows past the cap under concurrency —
  // acceptable: the cap bounds disk usage, it is not a hard record ledger.
  if (!datasetHasCapacity(config.datasetPath)) return;
  const line =
    JSON.stringify({ v: 1, ts: new Date().toISOString(), source: 'layer2_decision', ...record } satisfies DecisionCaptureRecord) + '\n';
  fs.promises
    .appendFile(config.datasetPath, line, 'utf8')
    .catch((err: any) => console.warn(`[Layer2Decision] decision capture write failed: ${err?.message}`));
}

/** Test seam: drop the cached gate so the next call re-seeds from disk, and
 *  allow the once-per-process cap warning to fire again. */
export function resetDecisionCaptureConfig(): void {
  captureConfig = null;
  capWarned = false;
}

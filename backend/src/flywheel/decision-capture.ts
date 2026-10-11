import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { Layer2JudgeConfig } from '../config/types.js';

/**
 * Decision-capture sink for the Layer 2 System One judge — the missing half
 * of the L2 capability loop. The flywheel records what EXECUTED (so Layer 1
 * can be retrained); nothing records what the JUDGE decided, which is exactly
 * the raw material two future capabilities need:
 *   - distilling converted chat-model judgments into a native decision model
 *   - calibrating the "uncalibrated self-report" confidence
 *
 * Deferred data cannot be recovered, so the sink exists from day one — but it
 * is OPT-IN (default off, like the full-capture proxy): `state` carries user
 * conversation content. Nothing consumes the file yet by design; the trainer
 * for native decision models is deliberately out of scope until real traffic
 * exists to train on.
 *
 * Correlation note: rows carry no requestId (the judge sits below the layer
 * that mints one). Join with flywheel rows by timestamp proximity when an
 * accuracy-vs-execution evaluation is built — or thread requestId through
 * routeAsync in a future change.
 */

export interface DecisionCaptureRecord {
  v: 1;
  ts: string;
  source: 'layer2_judge';
  model: string;
  provider: string;
  upstreamKind: 'native' | 'converted';
  /** The exact System One state the judge evaluated (user content — opt-in). */
  state: unknown;
  tier: string;
  confidence: number;
  latencyMs: number;
}

/** One-shot config freeze: first capture attempt pins the disk config, like
 *  RoutingDecisionCache — a console change to the capture toggle restarts to
 *  apply, matching every other classifier-layer setting. */
let captureConfig: { enabled: boolean; datasetPath: string } | null = null;

function getConfig(): { enabled: boolean; datasetPath: string } {
  if (!captureConfig) {
    const dc = (loadConfig().classifier?.layer2 as Layer2JudgeConfig | undefined)?.decisionCapture;
    captureConfig = {
      enabled: dc?.enabled === true,
      datasetPath: path.resolve(process.cwd(), dc?.datasetPath || './data/layer2-decisions.jsonl'),
    };
    if (captureConfig.enabled) {
      const dir = path.dirname(captureConfig.datasetPath);
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch {
          // Sink failures must never touch routing — handled at append time too.
        }
      }
    }
  }
  return captureConfig;
}

/** Append one judged decision. Fire-and-forget: capture is observability, so
 *  every failure degrades to a warn, never an error thrown into routing. */
export function captureDecision(record: Omit<DecisionCaptureRecord, 'v' | 'ts' | 'source'>): void {
  const config = getConfig();
  if (!config.enabled) return;
  const line =
    JSON.stringify({ v: 1, ts: new Date().toISOString(), source: 'layer2_judge', ...record } satisfies DecisionCaptureRecord) + '\n';
  fs.promises
    .appendFile(config.datasetPath, line, 'utf8')
    .catch((err: any) => console.warn(`[Layer2Judge] decision capture write failed: ${err?.message}`));
}

/** Test seam: drop the frozen config so the next call re-reads the disk. */
export function resetDecisionCaptureConfig(): void {
  captureConfig = null;
}
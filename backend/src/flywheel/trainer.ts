/**
 * The training stage of the learning flywheel — retraining the Layer 1
 * micro-classifier from what the collector gathered and the console labelled.
 *
 * The optimizer itself already existed (`Layer1Classifier.train` — softmax
 * cross-entropy with L2). What was missing is the stage that closes the loop:
 * dataset → eligible samples → train → persist to
 * `models/layer1-classifier.json` → hot-swap the in-memory weights, so the next
 * request routes on a better Layer 1 and the flywheel collects better samples.
 *
 * `Layer1Classifier.train` is a synchronous CPU loop and blocks the event loop
 * while it runs. Measured on the dev machine (8 features, 4 classes, 150
 * epochs): 265 ms @ 5k samples, 640 ms @ 20k — a single sub-second stall, which
 * is why the hard ceiling exists and why no worker thread was added yet. If the
 * ceiling ever rises, move the loop into a worker first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Layer1Classifier, Layer1ModelWeights, DEFAULT_BASE_MODEL } from '../router/layer1-classifier.js';
import { FlywheelDataset } from './dataset.js';
import { TierLevel } from '../types/router.js';

export type TrainingStatus = 'idle' | 'training' | 'success' | 'failed';

export interface TrainingReport {
  trainedSamples: number;
  skipped: Record<string, number>;
  classDistribution: Record<string, number>;
  finalLoss: number;
  accuracy: number;
  epochs: number;
  lr: number;
  l2: number;
  balanced: boolean;
  durationMs: number;
  modelPath: string;
}

export interface TrainingState {
  status: TrainingStatus;
  lastStartedAt: string | null;
  lastTrainedAt: string | null;
  lastDurationMs: number | null;
  lastResult: TrainingReport | null;
  error: string | null;
}

export interface TrainOptions {
  epochs?: number;
  lr?: number;
  l2?: number;
  maxSamples?: number;
  /** Resample minority tiers up to the majority count so `ultra` is learnable. */
  balanceClasses?: boolean;
  includeSynthetic?: boolean;
  minLabelSource?: 'human' | 'runtime_fallback' | 'observed_execution';
}

/** Hard ceiling on the synchronous training loop's work. */
const HARD_SAMPLE_CEILING = 20000;

export interface ModelInfo {
  modelPath: string;
  exists: boolean;
  isBaseModel: boolean;
  sampleCount: number;
  lastTrainedAt: string | null;
  featureDimensions: number;
  classes: TierLevel[];
  /** Whether the router's confidence gate actually consumes trained weights
   *  (classifier.localModel.enabled in the orchestrator's config snapshot).
   *  Training with this false updates the weights but changes NO routing. */
  routingConsumesModel: boolean;
  /** Path of the automatic pre-training backup (previous weights), if any. */
  previousModelPath: string;
  previousModelExists: boolean;
}

export class FlywheelTrainer {
  private dataset: FlywheelDataset;
  private modelPath: string;
  /** Deployment-level sample budget (`flywheel.maxSamples`); a request body may override per run. */
  private defaultMaxSamples: number | undefined;
  /** Whether the router gate is open for trained weights (mirrors classifier.localModel.enabled). */
  private routingEnabled: boolean;
  private state: TrainingState = {
    status: 'idle',
    lastStartedAt: null,
    lastTrainedAt: null,
    lastDurationMs: null,
    lastResult: null,
    error: null,
  };

  constructor(
    dataset: FlywheelDataset,
    modelPath?: string,
    defaultMaxSamples?: number,
    routingEnabled?: boolean
  ) {
    this.dataset = dataset;
    this.modelPath = modelPath || path.resolve(process.cwd(), 'models/layer1-classifier.json');
    this.defaultMaxSamples = defaultMaxSamples;
    this.routingEnabled = routingEnabled === true;
  }

  private get previousModelPath(): string {
    return `${this.modelPath}.previous`;
  }

  public getState(): TrainingState {
    return { ...this.state };
  }

  /** True while a run is in flight — the console disables its button on this. */
  public isTraining(): boolean {
    return this.state.status === 'training';
  }

  /** Current on-disk model metadata, for the console header. */
  public modelInfo(): ModelInfo {
    let weights: Layer1ModelWeights | null = null;
    try {
      weights = JSON.parse(fs.readFileSync(this.modelPath, 'utf8'));
    } catch {
      weights = null;
    }
    const model = weights || (DEFAULT_BASE_MODEL as Layer1ModelWeights);
    return {
      modelPath: this.modelPath,
      exists: weights !== null,
      isBaseModel: model.isBaseModel !== false,
      sampleCount: model.sampleCount || 0,
      lastTrainedAt: model.lastTrainedAt || this.state.lastTrainedAt,
      featureDimensions: model.featureDimensions || DEFAULT_BASE_MODEL.featureDimensions,
      classes: model.classes || DEFAULT_BASE_MODEL.classes,
      routingConsumesModel: this.routingEnabled,
      previousModelPath: this.previousModelPath,
      previousModelExists: fs.existsSync(this.previousModelPath),
    };
  }

  /**
   * Restore the automatic pre-training backup (the weights this model had
   * before the last successful run) and hot-reload them into this process.
   * Returns false when no backup exists — the caller maps that to 404.
   */
  public rollback(): boolean {
    if (!fs.existsSync(this.previousModelPath)) return false;
    fs.copyFileSync(this.previousModelPath, this.modelPath);
    // Reload the in-memory weights too: within a single gateway process the
    // static classifier is the live routing brain, not the file.
    Layer1Classifier.reload(this.modelPath);
    this.state = { ...this.state, lastResult: null, error: null };
    return true;
  }

  /**
   * Kick off a training run. Returns 409-equivalent state when one is already
   * in flight — the guard lives here, not only in the UI, so a second tab or a
   * direct API call cannot double-schedule a run.
   */
  public async train(options: TrainOptions = {}): Promise<{ started: boolean; state: TrainingState; report?: TrainingReport; error?: string }> {
    if (this.isTraining()) {
      return { started: false, state: this.getState(), error: 'A training run is already in progress.' };
    }

    this.state = { ...this.state, status: 'training', lastStartedAt: new Date().toISOString(), error: null };

    // Yield once so the HTTP response that triggered this leaves the event loop
    // before the synchronous training loop takes it over.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const startedAt = Date.now();
    try {
      const report = this.runSync(options);
      this.state = {
        ...this.state,
        status: 'success',
        lastTrainedAt: new Date().toISOString(),
        lastDurationMs: Date.now() - startedAt,
        lastResult: report,
        error: null,
      };
      return { started: true, state: this.getState(), report };
    } catch (err: any) {
      this.state = {
        ...this.state,
        status: 'failed',
        lastDurationMs: Date.now() - startedAt,
        error: err?.message || String(err),
      };
      return { started: true, state: this.getState(), error: this.state.error || 'Training failed.' };
    }
  }

  private runSync(options: TrainOptions): TrainingReport {
    const { samples, featureDimensions, skipped } = this.dataset.trainingSamples({
      includeSynthetic: options.includeSynthetic,
      minSource: options.minLabelSource,
    });

    if (samples.length === 0) {
      throw new Error(
        'No trainable samples. The dataset has no labelled rows with a feature vector ' +
          '(legacy v1 rows predate the feature vector and cannot be back-filled).'
      );
    }

    if (featureDimensions !== DEFAULT_BASE_MODEL.featureDimensions) {
      throw new Error(
        `Feature dimension mismatch: dataset has ${featureDimensions}, the model expects ${DEFAULT_BASE_MODEL.featureDimensions}.`
      );
    }

    // Balance by default: routing data is inherently class-skewed (the router
    // loves `plus`), and an unbalanced run mostly learns the prior. Callers
    // that genuinely want raw distribution can opt out explicitly.
    const balanced = options.balanceClasses !== false;
    let trainSamples = samples;
    if (balanced) {
      const byTier: Record<string, typeof samples> = {};
      for (const s of samples) (byTier[s.targetTier] ||= []).push(s);
      const maxCount = Math.max(...Object.values(byTier).map((g) => g.length));
      trainSamples = [];
      for (const group of Object.values(byTier)) {
        for (let i = 0; i < maxCount; i++) {
          trainSamples.push(group[i % group.length]);
        }
      }
    }

    const maxSamples = Math.min(
      options.maxSamples ?? this.defaultMaxSamples ?? HARD_SAMPLE_CEILING,
      HARD_SAMPLE_CEILING
    );
    if (trainSamples.length > maxSamples) {
      // Deterministic stride sample — keeps the class mix instead of taking a
      // prefix, which would drop every minority class.
      const stride = trainSamples.length / maxSamples;
      const thinned: typeof trainSamples = [];
      for (let i = 0; i < maxSamples; i++) thinned.push(trainSamples[Math.floor(i * stride)]);
      trainSamples = thinned;
    }

    const epochs = options.epochs ?? 150;
    const lr = options.lr ?? 0.1;
    const l2 = options.l2 ?? 0.005;

    const startedAt = Date.now();
    // Snapshot the current weights before overwriting them: the only way back
    // from a bad run is the file this gateway served until a moment ago.
    if (fs.existsSync(this.modelPath)) {
      fs.copyFileSync(this.modelPath, this.previousModelPath);
    }
    const result = Layer1Classifier.train(trainSamples, { epochs, lr, l2 });
    // `train()` already swapped the in-memory weights; persist them so the next
    // gateway boot loads the trained model instead of the base scaffold.
    Layer1Classifier.saveModel(Layer1Classifier.getLoadedModel(), this.modelPath);

    const classDistribution: Record<string, number> = {};
    for (const s of trainSamples) classDistribution[s.targetTier] = (classDistribution[s.targetTier] || 0) + 1;

    return {
      trainedSamples: result.trainedSamples,
      skipped,
      classDistribution,
      finalLoss: result.finalLoss,
      accuracy: result.accuracy,
      epochs,
      lr,
      l2,
      balanced,
      durationMs: Date.now() - startedAt,
      modelPath: this.modelPath,
    };
  }
}

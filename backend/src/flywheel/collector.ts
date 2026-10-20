import fs from 'node:fs';
import path from 'node:path';
import { RoutingDecision, TierLevel } from '../types/router.js';
import { ChatCompletionRequest } from '../types/openai.js';
import { FlywheelConfig } from '../config/types.js';
import { getEnvRootDir } from '../config/env.js';
import { Layer1Classifier } from '../router/layer1-classifier.js';
import { applyRetention } from './prune.js';
import {
  FLYWHEEL_SCHEMA_VERSION,
  FlywheelRecord,
  deriveDefaultLabel,
  detectSynthetic,
} from './schema.js';

export interface FlywheelStats {
  totalSamples: number;
  tierDistribution: Record<string, number>;
  layerDistribution: Record<'layer0' | 'layer1' | 'layer2', number>;
  fallbackCount: number;
}

/** Retention sweep bookkeeping surfaced on GET /api/admin/flywheel/stats. */
export interface FlywheelRetentionState {
  retentionDays: number;
  maxFileSizeMB: number;
  enabled: boolean;
  lastSweepAt: string | null;
  lastRemoved: number | null;
}

/**
 * Clamp a retention knob: 0/undefined = disabled (backward compat); negative
 * or otherwise unusable values clamp to 0 with one warn (design doc D4 — the
 * knobs are restart-scoped, so construction is the single validation point).
 */
function clampRetentionKnob(key: string, value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) {
    console.warn(`[Flywheel] Invalid flywheel.${key}=${String(value)} — clamped to 0 (disabled).`);
    return 0;
  }
  return value;
}

export class FlywheelCollector {
  private config: FlywheelConfig;
  private datasetPath: string;
  private retentionDays: number;
  private maxFileSizeMB: number;
  private retentionTimer?: ReturnType<typeof setInterval>;
  private retentionState: { lastSweepAt: string | null; lastRemoved: number | null } = {
    lastSweepAt: null,
    lastRemoved: null,
  };
  private runtimeArmed = false;
  private stats: FlywheelStats = {
    totalSamples: 0,
    tierDistribution: {},
    layerDistribution: { layer0: 0, layer1: 0, layer2: 0 },
    fallbackCount: 0,
  };

  constructor(config?: FlywheelConfig) {
    // Default matches DEFAULT_CONFIG.flywheel: opt-in. Tests that build an
    // orchestrator with a hand-rolled config object (no `flywheel` field) must
    // not silently start collecting into the production dataset path.
    this.config = config ?? { enabled: false, datasetPath: './data/flywheel.jsonl' };
    // Relative dataset paths resolve against the ACTIVE ENVIRONMENT's root
    // (<home>/envs/<name>), so "./data/flywheel.jsonl" always lands inside the
    // book-set that is running — never in the shell's cwd.
    this.datasetPath = path.resolve(getEnvRootDir(), this.config.datasetPath || './data/flywheel.jsonl');
    this.ensureDirectory();

    // Retention sweep (design doc D4, exact CaptureRecorder pattern): only
    // when collection is enabled AND a knob is set; disabled knobs mean zero
    // fs writes, and disabling never deletes anything.
    this.retentionDays = clampRetentionKnob('retentionDays', this.config.retentionDays);
    this.maxFileSizeMB = clampRetentionKnob('maxFileSizeMB', this.config.maxFileSizeMB);
    if (this.config.enabled && this.retentionActive()) {
      this.runRetentionSweep();
      this.startRetentionTimer();
    }
    // Booted enabled = the runtime side effects above are already armed;
    // booted disabled they arm lazily on the first record() after a
    // hot-applied config save flips the gate (see armRuntime).
    this.runtimeArmed = this.config.enabled === true;
  }

  /** Live collection gate — a config-save flip applies without a restart. */
  public isEnabled(): boolean {
    return this.config.enabled === true;
  }

  /**
   * One-shot lazy arming for a collector that booted disabled and was
   * hot-enabled through the config save path (the console collection
   * toggle): create the dataset directory and arm the retention sweep +
   * timer exactly as the constructor would have. Idempotent; no-op when
   * booted enabled.
   */
  private armRuntime(): void {
    if (this.runtimeArmed) return;
    this.runtimeArmed = true;
    this.ensureDirectory();
    if (this.retentionActive()) {
      this.runRetentionSweep();
      this.startRetentionTimer();
    }
  }

  private retentionActive(): boolean {
    return this.retentionDays > 0 || this.maxFileSizeMB > 0;
  }

  /**
   * Boot + hourly retention sweep body. Failures only warn — the timer must
   * survive a bad pass (same posture as CaptureRecorder.sweep). The sweep
   * never consults the trainer: sync fs means it cannot interleave with the
   * training loop, and landing in a setImmediate gap merely re-indexes before
   * trainingSamples() (design doc D5).
   */
  private runRetentionSweep(): void {
    // Hot-applied gate: a hot-disabled collector pauses retention too. The
    // sweep must never keep deleting while getRetentionState() reports the
    // retention block as disabled — and this matches the boot-disabled
    // posture (zero fs writes) the constructor promises.
    if (!this.config.enabled) return;
    try {
      const outcome = applyRetention(this.datasetPath, {
        retentionDays: this.retentionDays,
        maxFileSizeMB: this.maxFileSizeMB,
      });
      this.retentionState = { lastSweepAt: new Date().toISOString(), lastRemoved: outcome.removed };
    } catch (err: any) {
      console.warn(`[Flywheel] Retention sweep failed on ${this.datasetPath}: ${err?.message || String(err)}`);
    }
  }

  /** Idempotent hourly retention sweep timer (unref'd, never blocks exit). */
  private startRetentionTimer(): void {
    if (this.retentionTimer) return;
    this.retentionTimer = setInterval(() => this.runRetentionSweep(), 3_600_000);
    this.retentionTimer.unref?.();
  }

  /** Effective knobs + last sweep outcome, for the stats endpoint. */
  public getRetentionState(): FlywheelRetentionState {
    return {
      retentionDays: this.retentionDays,
      maxFileSizeMB: this.maxFileSizeMB,
      enabled: this.config.enabled === true && this.retentionActive(),
      ...this.retentionState,
    };
  }

  private ensureDirectory(): void {
    if (!this.config.enabled) return;
    const dir = path.dirname(this.datasetPath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        // Ignore mkdir errors
      }
    }
  }

  /**
   * Record one end-to-end execution turn into the data flywheel dataset.
   *
   * The feature vector is captured HERE, at request time, because the 8
   * features the trainer consumes are computed from the full request and
   * cannot be reconstructed later from a truncated (or redacted) prompt.
   */
  public async record(params: {
    requestId: string;
    request: ChatCompletionRequest;
    decision: RoutingDecision;
    tierUsed: TierLevel;
    modelUsed: string;
    fallbackOccurred: boolean;
    fallbackReason?: string;
    latencyMs: number;
    /** Test-bench traffic marker; overrides the built-in fingerprint heuristic. */
    synthetic?: boolean;
  }): Promise<void> {
    if (!this.config.enabled) return;

    // Hot-applied enable (booted disabled, gate flipped via a config save):
    // arm the directory + retention side effects on first use.
    this.armRuntime();

    // Redaction and truncation only affect the human-readable copy — the
    // feature vector below is what training actually consumes, so a redacted
    // dataset still trains fine.
    const messages = params.request.messages || [];
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    let promptText = typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg?.content)
        ? lastUserMsg.content.map(p => p.text || '').join(' ')
        : '';

    if (this.config.logUserPrompt === false) {
      promptText = `[PROMPT_REDACTED_${params.decision.features.tokenCountEstimate}_TOKENS]`;
    } else if (promptText.length > 2000) {
      promptText = promptText.slice(0, 2000) + '...[TRUNCATED]';
    }

    const extracted = Layer1Classifier.extractFeatures(params.request);

    // The label is what actually SERVED the request, not what the router
    // asked for. Copying `decision.targetTier` into the label (the v1 bug)
    // made every non-fallback row self-labelled and erased the strongest
    // signal in the dataset: 73% of rows had targetTier != tierUsed.
    const isSynthetic = params.synthetic ?? detectSynthetic(params.requestId, params.modelUsed, params.fallbackReason);
    const targetTier = params.decision.targetTier;

    const record: FlywheelRecord = {
      v: FLYWHEEL_SCHEMA_VERSION,
      id: params.requestId,
      timestamp: new Date().toISOString(),
      input: {
        userPrompt: promptText,
        featureVector: extracted.vector,
        featureNames: extracted.featureNames,
        tokenCount: extracted.metrics.tokenCount,
        turnCount: extracted.metrics.turnCount,
      },
      decision: {
        targetTier,
        confidence: params.decision.confidence,
        layerUsed: params.decision.layerUsed || 'layer0',
        reason: params.decision.reason || '',
        reasonCode: params.decision.reasonCode,
        reasonParams: params.decision.reasonParams,
      },
      execution: {
        tierUsed: params.tierUsed,
        modelUsed: params.modelUsed,
        fallbackOccurred: params.fallbackOccurred,
        fallbackReason: params.fallbackReason,
        latencyMs: params.latencyMs,
        isSynthetic,
      },
      label: deriveDefaultLabel({
        targetTier,
        tierUsed: params.tierUsed,
        fallbackOccurred: params.fallbackOccurred,
      }),
    };

    // Update memory stats
    this.stats.totalSamples++;
    if (record.label.tier) {
      this.stats.tierDistribution[record.label.tier] = (this.stats.tierDistribution[record.label.tier] || 0) + 1;
    }
    const layer = record.decision.layerUsed;
    this.stats.layerDistribution[layer]++;
    if (params.fallbackOccurred) {
      this.stats.fallbackCount++;
    }

    // Asynchronously append to JSONL file
    try {
      const line = JSON.stringify(record) + '\n';
      await fs.promises.appendFile(this.datasetPath, line, 'utf8');
    } catch (err: any) {
      console.warn(`[Flywheel] Failed to write sample to ${this.datasetPath}: ${err.message}`);
    }
  }

  /** In-memory counters for the current process lifetime (reset on restart). */
  public getStats(): FlywheelStats {
    return { ...this.stats };
  }

  public getDatasetPath(): string {
    return this.datasetPath;
  }
}

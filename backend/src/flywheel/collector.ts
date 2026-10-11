import fs from 'node:fs';
import path from 'node:path';
import { RoutingDecision, TierLevel } from '../types/router.js';
import { ChatCompletionRequest } from '../types/openai.js';
import { FlywheelConfig } from '../config/types.js';
import { Layer1Classifier } from '../router/layer1-classifier.js';
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

export class FlywheelCollector {
  private config: FlywheelConfig;
  private datasetPath: string;
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
    this.datasetPath = path.resolve(process.cwd(), this.config.datasetPath || './data/flywheel.jsonl');
    this.ensureDirectory();
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
   * cannot be reconstructed later from a truncated (or redacted) prompt —
   * which is exactly why the legacy v1 rows are not trainable.
   */
  public async record(params: {
    requestId: string;
    request: ChatCompletionRequest;
    decision: RoutingDecision;
    tierUsed: TierLevel;
    modelUsed: string;
    fallbackOccurred: boolean;
    fallbackReason?: string;
    costUsd: number;
    latencyMs: number;
    /** Test-bench traffic marker; overrides the built-in fingerprint heuristic. */
    synthetic?: boolean;
  }): Promise<void> {
    if (!this.config.enabled) return;

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
      },
      execution: {
        tierUsed: params.tierUsed,
        modelUsed: params.modelUsed,
        fallbackOccurred: params.fallbackOccurred,
        fallbackReason: params.fallbackReason,
        costUsd: params.costUsd,
        latencyMs: params.latencyMs,
        isSynthetic,
      },
      label: deriveDefaultLabel({
        targetTier,
        tierUsed: params.tierUsed,
        fallbackOccurred: params.fallbackOccurred,
      }),
      trainable: true,
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

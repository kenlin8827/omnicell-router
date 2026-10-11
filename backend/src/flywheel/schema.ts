/**
 * Flywheel dataset schema (v2) — the on-disk contract between the collector,
 * the training pipeline and the console.
 *
 * v1 stored five derived booleans (`hasCode`, `complexityScore`, …) that the
 * trainer cannot consume: `Layer1Classifier.train()` needs the 8-dimensional
 * vector produced by `Layer1Classifier.extractFeatures()`. v2 stores THAT
 * vector, so a record is trainable the moment it is written.
 *
 * A v1 record cannot be upgraded into a trainable one — the 8 features are
 * computed from the full ChatCompletionRequest, while v1 only kept a possibly
 * truncated (or redacted) prompt string. `migrateRecord` therefore marks such
 * records `trainable: false` instead of fabricating a vector.
 */
import { TierLevel } from '../types/router.js';

export const FLYWHEEL_SCHEMA_VERSION = 2;

export const FLYWHEEL_TIERS: TierLevel[] = ['lite', 'plus', 'pro', 'ultra'];

/** Where the training label came from, strongest last. */
export type FlywheelLabelSource =
  | 'human' // a console operator relabelled the sample
  | 'runtime_fallback' // the requested tier failed and was escalated — observed proof
  | 'observed_execution' // the tier that actually served the request
  | 'unlabeled'; // no trustworthy label yet

export interface FlywheelLabel {
  /** Training target. null = not trainable yet (see `FlywheelRecord.trainable`). */
  tier: TierLevel | null;
  source: FlywheelLabelSource;
  /** 0..1 — how much the label can be trusted. Drives sample weighting in the UI. */
  confidence: number;
  /** True when the router wanted a different tier than the one that served. */
  overridden: boolean;
  /** True when the cheaper-than-target tier could not handle the request. */
  isNegativeForLite: boolean;
  /** Set by console relabelling. */
  updatedAt?: string;
}

export interface FlywheelRecord {
  /** schemaVersion — 2 for everything this module writes. */
  v: number;
  id: string;
  timestamp: string;
  input: {
    userPrompt: string;
    /** The 8 features `Layer1Classifier.train()` consumes, in featureNames order. */
    featureVector: number[] | null;
    featureNames: string[];
    tokenCount: number;
    turnCount: number;
  };
  decision: {
    targetTier: TierLevel;
    confidence: number;
    layerUsed: 'layer0' | 'layer1' | 'layer2';
    /** Verbatim routing reason — the provenance signal that identifies the real mechanism. */
    reason: string;
  };
  execution: {
    tierUsed: TierLevel;
    modelUsed: string;
    fallbackOccurred: boolean;
    fallbackReason?: string;
    costUsd: number;
    latencyMs: number;
    /** Bench/test traffic — excluded from training by default. */
    isSynthetic: boolean;
  };
  label: FlywheelLabel;
  /** v1 legacy only: true when the record predates the schema bump. */
  trainable: boolean;
}

export interface LabelOverride {
  tier: TierLevel;
  updatedAt: string;
}

/** id -> operator label. Kept beside the append-only dataset so relabelling never rewrites history. */
export type LabelOverrideMap = Record<string, LabelOverride>;

export function isTier(value: unknown): value is TierLevel {
  return typeof value === 'string' && (FLYWHEEL_TIERS as string[]).includes(value);
}

export function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * The label a record carries when no operator override is in place: the tier
 * that actually SERVED the request, never the tier the router asked for.
 *
 * Single source of truth for that rule — the collector writes it at capture
 * time and the dataset re-derives it whenever an override is removed, so
 * "clear label" always lands back on the observed value rather than on a
 * stale human label.
 */
export function deriveDefaultLabel(params: {
  targetTier: TierLevel | string;
  tierUsed: TierLevel | string;
  fallbackOccurred: boolean;
}): FlywheelLabel {
  const tier = isTier(params.tierUsed) ? params.tierUsed : null;
  return {
    tier,
    source: params.fallbackOccurred ? 'runtime_fallback' : 'observed_execution',
    confidence: params.fallbackOccurred ? 0.9 : 0.5,
    overridden: tier !== null && params.targetTier !== params.tierUsed,
    isNegativeForLite: params.fallbackOccurred,
  };
}

/**
 * Bench/test traffic detector.
 *
 * The flywheel is opt-in (default off) and forced off under `bun test`
 * (NODE_ENV=test), but if collection is ever on, `bun test` would append its
 * fixtures to the production dataset. These three signals are the
 * unmistakable fingerprints the test-suite leaves behind (see
 * backend/tests/flywheel.test.ts and the tier-pool tests); they are checked
 * narrowly so real traffic is never swept up with them.
 */
export function detectSynthetic(id: string, modelUsed: string, fallbackReason?: string): boolean {
  if (/^mock/i.test(id) || /^mock/i.test(modelUsed)) return true;
  if (modelUsed === 'always-downgrade') return true;
  if (fallbackReason && /mandatory_key_that_fails_on/i.test(fallbackReason)) return true;
  return false;
}

/** Tiers that shipped before the 4-tier vocabulary replaced them. */
function normalizeLegacyTier(value: unknown): TierLevel | null {
  if (isTier(value)) return value;
  return null;
}

/**
 * Bring any record — v2 native or v1 legacy — up to the current shape.
 * Never throws on malformed input: a dataset line that cannot be parsed is a
 * logging concern, not a reason to break the console.
 *
 * The v1 branch below is a deliberate safety net, NOT unfinished migration
 * code. Schema v1 predates the feature vector, so such rows can never be
 * trained on; what this branch buys is that they stay VISIBLE (tagged
 * `trainable: false`, surfaced as "legacy · untrainable" in the console)
 * instead of silently vanishing when an old or restored dataset shows up.
 * Delete it once no v1 dataset can reach the gateway — and if you do, delete
 * `trainable` from the interface and the console badge with it, so an
 * unexpected shape still fails loudly rather than by omission.
 */
export function migrateRecord(raw: any): FlywheelRecord | null {
  if (!raw || typeof raw !== 'object') return null;

  const isV2 = raw.v === FLYWHEEL_SCHEMA_VERSION && raw.input !== undefined;

  if (isV2) {
    const exec = raw.execution || {};
    const label = raw.label || {};
    return {
      v: FLYWHEEL_SCHEMA_VERSION,
      id: str(raw.id, `anon_${Date.now()}`),
      timestamp: str(raw.timestamp, new Date().toISOString()),
      input: {
        userPrompt: str(raw.input.userPrompt),
        featureVector: Array.isArray(raw.input.featureVector) ? raw.input.featureVector.map((n: any) => num(n)) : null,
        featureNames: Array.isArray(raw.input.featureNames) ? raw.input.featureNames.map((s: any) => str(s)) : [],
        tokenCount: num(raw.input.tokenCount),
        turnCount: num(raw.input.turnCount),
      },
      decision: {
        targetTier: normalizeLegacyTier(raw.decision?.targetTier) || 'plus',
        confidence: num(raw.decision?.confidence),
        layerUsed: ['layer0', 'layer1', 'layer2'].includes(raw.decision?.layerUsed) ? raw.decision.layerUsed : 'layer0',
        reason: str(raw.decision?.reason),
      },
      execution: {
        tierUsed: normalizeLegacyTier(exec.tierUsed) || normalizeLegacyTier(raw.decision?.targetTier) || 'plus',
        modelUsed: str(exec.modelUsed),
        fallbackOccurred: exec.fallbackOccurred === true,
        fallbackReason: str(exec.fallbackReason) || undefined,
        costUsd: num(exec.costUsd),
        latencyMs: num(exec.latencyMs),
        isSynthetic: exec.isSynthetic === true || detectSynthetic(str(raw.id), str(exec.modelUsed), exec.fallbackReason),
      },
      label: {
        tier: isTier(label.tier) ? label.tier : null,
        source: (['human', 'runtime_fallback', 'observed_execution', 'unlabeled'] as string[]).includes(label.source)
          ? label.source
          : 'unlabeled',
        confidence: num(label.confidence),
        overridden: label.overridden === true,
        isNegativeForLite: label.isNegativeForLite === true,
        updatedAt: str(label.updatedAt) || undefined,
      },
      trainable: raw.trainable !== false,
    };
  }

  // ---- v1 legacy (safety net — see the note on migrateRecord) ----------
  // No featureVector exists and none can be reconstructed: the 8 features come
  // from the full request, and v1 kept only a truncated/redacted prompt.
  const legacyLabel = raw.label || {};
  const routing = raw.routing || {};
  const exec = raw.execution || {};
  const legacySource = str(legacyLabel.labelSource, 'layer0_lite');
  const modelUsed = str(exec.modelUsed);
  const id = str(raw.id, `anon_${Date.now()}`);
  const fallbackReason = str(exec.fallbackReason) || undefined;
  const tierUsed = normalizeLegacyTier(exec.tierUsed);
  const targetTier = normalizeLegacyTier(routing.targetTier);

  // Map the legacy label sources onto the v2 provenance vocabulary. The old
  // names misdescribed their mechanism (e.g. `layer1_confident` was emitted for
  // the safe quality-first fallback, not for a confident short-circuit), so
  // only the two that actually carried evidence are upgraded.
  let source: FlywheelLabelSource = 'unlabeled';
  let tier: TierLevel | null = null;
  let confidence = 0;
  if (legacySource === 'runtime_fallback' && tierUsed) {
    source = 'runtime_fallback';
    tier = tierUsed;
    confidence = 0.9;
  } else if (tierUsed) {
    source = 'observed_execution';
    tier = tierUsed;
    confidence = 0.5;
  }

  return {
    v: FLYWHEEL_SCHEMA_VERSION,
    id,
    timestamp: str(raw.timestamp, new Date(0).toISOString()),
    input: {
      userPrompt: str(raw.userPrompt),
      featureVector: null,
      featureNames: [],
      tokenCount: num(raw.tokenCount),
      turnCount: 0,
    },
    decision: {
      targetTier: targetTier || tierUsed || 'plus',
      confidence: num(routing.confidence),
      layerUsed: ['layer0', 'layer1', 'layer2'].includes(routing.layerUsed) ? routing.layerUsed : 'layer0',
      reason: '',
    },
    execution: {
      tierUsed: tierUsed || targetTier || 'plus',
      modelUsed,
      fallbackOccurred: exec.fallbackOccurred === true,
      fallbackReason,
      costUsd: num(exec.costUsd),
      latencyMs: num(exec.latencyMs),
      isSynthetic: detectSynthetic(id, modelUsed, fallbackReason),
    },
    label: {
      tier,
      source,
      confidence,
      overridden: !!(targetTier && tierUsed && targetTier !== tierUsed),
      isNegativeForLite: exec.fallbackOccurred === true,
    },
    trainable: false,
  };
}

/**
 * Flywheel dataset schema (v2) — the on-disk contract between the collector,
 * the training pipeline and the console.
 *
 * v1 stored five derived booleans (`hasCode`, `complexityScore`, …) that the
 * trainer cannot consume: `Layer1Classifier.train()` needs the 8-dimensional
 * vector produced by `Layer1Classifier.extractFeatures()`. v2 stores THAT
 * vector, so a record is trainable the moment it is written. There is no v1
 * reader: a v1 line parses as malformed and is dropped with a warning
 * (0.0.1 — no dataset outside this install ever existed).
 */
import { ReasonParams, TierLevel } from '../types/router.js';

export const FLYWHEEL_SCHEMA_VERSION = 2;

export const FLYWHEEL_TIERS: TierLevel[] = ['lite', 'plus', 'pro', 'ultra'];

/** Where the training label came from, strongest last. */
export type FlywheelLabelSource =
  | 'human' // a console operator relabelled the sample
  | 'runtime_fallback' // the requested tier failed and was escalated — observed proof
  | 'observed_execution' // the tier that actually served the request
  | 'unlabeled'; // no trustworthy label yet

export interface FlywheelLabel {
  /** Training target. null = not labelled yet. */
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
    /**
     * Machine-readable reason vocabulary. Optional both ways: rows written
     * before it existed parse with `undefined` — no data migration.
     */
    reasonCode?: string;
    reasonParams?: ReasonParams;
  };
  execution: {
    tierUsed: TierLevel;
    modelUsed: string;
    fallbackOccurred: boolean;
    fallbackReason?: string;
    latencyMs: number;
    /** Bench/test traffic — excluded from training by default. */
    isSynthetic: boolean;
  };
  label: FlywheelLabel;
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

/**
 * Disk rows are external input: accept the params object only property by
 * property, dropping values that are not primitives. Absent/invalid →
 * undefined, so rows without the field parse unchanged.
 */
function optReasonParams(value: unknown): ReasonParams | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: ReasonParams = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/**
 * Parse one dataset line into the current shape. Never throws on malformed
 * input: a line that cannot be parsed is a logging concern, not a reason to
 * break the console. There is no v1 reader (0.0.1 — no dataset outside this
 * install ever existed): a pre-v2 line returns null and the caller counts it
 * as malformed.
 */
export function migrateRecord(raw: any): FlywheelRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.v !== FLYWHEEL_SCHEMA_VERSION || raw.input === undefined) return null;

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
      targetTier: isTier(raw.decision?.targetTier) ? raw.decision.targetTier : 'plus',
      confidence: num(raw.decision?.confidence),
      layerUsed: ['layer0', 'layer1', 'layer2'].includes(raw.decision?.layerUsed) ? raw.decision.layerUsed : 'layer0',
      reason: str(raw.decision?.reason),
      reasonCode: str(raw.decision?.reasonCode) || undefined,
      reasonParams: optReasonParams(raw.decision?.reasonParams),
    },
    execution: {
      tierUsed: isTier(exec.tierUsed) ? exec.tierUsed : isTier(raw.decision?.targetTier) ? raw.decision.targetTier : 'plus',
      modelUsed: str(exec.modelUsed),
      fallbackOccurred: exec.fallbackOccurred === true,
      fallbackReason: str(exec.fallbackReason) || undefined,
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
  };
}

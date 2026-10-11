/**
 * Read/query/relabel side of the flywheel dataset — built for MILLIONS of rows.
 *
 * Architecture (why not "parse the whole file into objects"):
 *   A million-row dataset is ~800 MB of JSON; materializing it as JS objects
 *   costs gigabytes and re-parsing it after every single gateway append is
 *   quadratic in practice. Instead the dataset keeps a COLUMNAR INDEX of just
 *   the fields that filtering, aggregation and training need (byte offset,
 *   timestamp, feature vector, tier, label source, flags), backed by typed
 *   arrays — roughly 200 MB of flat memory per million rows. Full records are
 *   read back lazily: a page of samples triggers ~limit random single-line
 *   reads, nothing more.
 *
 *   The index advances incrementally: `ensureIndexed()` only parses bytes past
 *   the last complete line it saw, so steady-state cost per gateway append is
 *   one small tail read. A full rebuild (first visit to a pre-existing large
 *   file, or after a prune/truncate) is the only expensive path; `warmup()`
 *   walks that down in event-loop-friendly slices.
 *
 * The dataset file itself stays append-only JSONL; relabelling writes a
 * sidecar overlay keyed by record id, so nothing here mutates recorded
 * history.
 */
import fs from 'node:fs';
import path from 'node:path';
import { TierLevel } from '../types/router.js';
import {
  FlywheelRecord,
  LabelOverride,
  LabelOverrideMap,
  FlywheelLabelSource,
  FLYWHEEL_TIERS,
  deriveDefaultLabel,
  isTier,
  migrateRecord,
} from './schema.js';
import { DEFAULT_BASE_MODEL } from '../router/layer1-classifier.js';

export interface DatasetSummary {
  total: number;
  trainable: number;
  synthetic: number;
  humanLabeled: number;
  unlabeled: number;
  trainableByTier: Record<string, number>;
  sourceDistribution: Record<string, number>;
  datasetPath: string;
  labelsPath: string;
  fileBytes: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
}

export interface SampleQuery {
  limit?: number;
  offset?: number;
  tier?: TierLevel | 'none' | 'any';
  source?: FlywheelLabelSource | 'any';
  includeSynthetic?: boolean;
  trainableOnly?: boolean;
  search?: string;
}

export interface SampleRow {
  id: string;
  timestamp: string;
  userPrompt: string;
  tokenCount: number;
  featureVector: number[] | null;
  decision: FlywheelRecord['decision'];
  execution: FlywheelRecord['execution'];
  label: FlywheelRecord['label'];
  trainable: boolean;
}

// ---- index flag bits ------------------------------------------------------
const F_SYNTHETIC = 1 << 0;
const F_FALLBACK = 1 << 1;
const F_HAS_VECTOR = 1 << 2; // row carried a usable 8-dim feature vector
const F_TRAINABLE = 1 << 3; // v2 row (v1 rows can never be trained on)
const TIER_NONE = 255;
const SRC_UNLABELED = 3; // index of 'unlabeled' in SOURCE_ORDER

const SOURCE_ORDER: FlywheelLabelSource[] = ['human', 'runtime_fallback', 'observed_execution', 'unlabeled'];
const VECTOR_DIMS = DEFAULT_BASE_MODEL.featureDimensions; // index stores exactly this many dims

const READ_CHUNK = 4 * 1024 * 1024; // 4 MB tail-read chunks
const WARMUP_SLICE_BYTES = 8 * 1024 * 1024; // event-loop budget per warmup slice

interface IndexEntry {
  idx: number;
}

export class FlywheelDataset {
  private datasetPath: string;
  private labelsPath: string;

  // ---- columnar index (parallel arrays, length = this.n) ----
  private n = 0;
  private cap = 0;
  private ids: string[] = [];
  private idToIdx = new Map<string, IndexEntry>();
  private offsets = new Float64Array(0); // line start byte offset (Float64: files can exceed 2^32)
  private tsMs = new Float64Array(0); // record timestamp as epoch ms
  private vectors = new Float64Array(0); // n * VECTOR_DIMS, row-major
  private tierIdx = new Uint8Array(0); // FLYWHEEL_TIERS index, TIER_NONE = unlabelled
  private srcIdx = new Uint8Array(0); // SOURCE_ORDER index
  private flags = new Uint8Array(0);
  private modelPool: string[] = [];
  private modelIdx = new Int32Array(0); // index into modelPool
  private promptPrefix: string[] = []; // first 48 chars, lowercased, for search

  private indexedBytes = 0; // bytes of the dataset file already reflected in the index
  private fd: number | null = null;
  private indexVersion = 0; // bumped on every index change (summary cache key)

  private overrides: LabelOverrideMap = {};
  private labelsLoaded = false;
  private summaryCache: { version: number; value: DatasetSummary } | null = null;

  constructor(datasetPath: string) {
    this.datasetPath = datasetPath;
    this.labelsPath = `${datasetPath}.labels.json`;
  }

  public getDatasetPath(): string {
    return this.datasetPath;
  }

  public getLabelsPath(): string {
    return this.labelsPath;
  }

  /** Drop all in-memory state; the next access re-reads from scratch. */
  public invalidate(): void {
    this.n = 0;
    this.cap = 0;
    this.ids = [];
    this.idToIdx.clear();
    this.offsets = new Float64Array(0);
    this.tsMs = new Float64Array(0);
    this.vectors = new Float64Array(0);
    this.tierIdx = new Uint8Array(0);
    this.srcIdx = new Uint8Array(0);
    this.flags = new Uint8Array(0);
    this.modelPool = [];
    this.modelIdx = new Int32Array(0);
    this.promptPrefix = [];
    this.indexedBytes = 0;
    this.indexVersion++;
    this.summaryCache = null;
    this.labelsLoaded = false;
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* already closed */ }
      this.fd = null;
    }
  }

  /**
   * Index the dataset to completion, synchronously. Cheap when the index is
   * current (only new bytes are parsed); expensive only on a cold start over a
   * large pre-existing file. The HTTP layer should prefer `warmup()`.
   */
  public ensureIndexed(): void {
    this.loadOverrides();
    const size = this.fileSize();
    if (size < this.indexedBytes) {
      // File shrank (pruned / truncated / replaced) — start over.
      const keepLabels = this.labelsLoaded;
      this.invalidate();
      this.labelsLoaded = keepLabels;
      this.loadOverrides();
    }
    if (size === this.indexedBytes) return;

    if (this.fd === null) {
      try {
        this.fd = fs.openSync(this.datasetPath, 'r');
      } catch {
        return; // file vanished between stat and open
      }
    }

    const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, size - this.indexedBytes));
    let carry = ''; // unterminated tail of the previous chunk
    let readFrom = this.indexedBytes;
    while (readFrom < size) {
      const want = Math.min(buf.length, size - readFrom);
      let got = 0;
      try {
        got = fs.readSync(this.fd, buf, 0, want, readFrom);
      } catch {
        break;
      }
      if (got <= 0) break;
      const chunk = carry + buf.toString('utf8', 0, got);
      // Only complete lines are consumed; the tail (if any) waits for more bytes.
      const lastNewline = chunk.lastIndexOf('\n');
      if (lastNewline === -1) {
        carry = chunk;
        readFrom += got;
        continue;
      }
      const complete = chunk.slice(0, lastNewline + 1);
      // The block starts where the previous carry ended: file offset of the
      // first line = current read position minus the carry we prepended.
      const blockFileStart = readFrom - carry.length;
      carry = chunk.slice(lastNewline + 1);
      this.indexLines(complete, blockFileStart);
      readFrom += got;
      this.indexedBytes = readFrom - carry.length;
    }
    this.indexVersion++;
    this.summaryCache = null;
  }

  /**
   * Walk a cold start down in event-loop-friendly slices. Resolves once the
   * index covers the whole file. Safe to call repeatedly / concurrently —
   * concurrent callers just await the same walk.
   */
  private warmupPromise: Promise<void> | null = null;
  public warmup(): Promise<void> {
    if (this.warmupPromise) return this.warmupPromise;
    this.warmupPromise = (async () => {
      for (;;) {
        this.ensureIndexed();
        if (this.fileSize() <= this.indexedBytes) break;
        // Parse at most one slice per macrotask so HTTP traffic interleaves.
        const before = this.indexedBytes;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (this.indexedBytes === before) break; // no progress (read error) — bail out
      }
    })().finally(() => {
      this.warmupPromise = null;
    });
    return this.warmupPromise;
  }

  private fileSize(): number {
    try {
      return fs.statSync(this.datasetPath).size;
    } catch {
      return 0;
    }
  }

  /** Parse a block of complete newline-terminated lines into the index. */
  private indexLines(block: string, blockStartOffset: number): void {
    let lineStart = 0;
    for (;;) {
      const nl = block.indexOf('\n', lineStart);
      if (nl === -1) break;
      const line = block.slice(lineStart, nl).trim();
      this.indexOne(line, blockStartOffset + lineStart);
      lineStart = nl + 1;
    }
  }

  private indexOne(line: string, byteOffset: number): void {
    if (!line) return;
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      return; // torn/malformed line — skip, never break the console
    }
    const rec = migrateRecord(raw);
    if (!rec) return;

    if (this.n === this.cap) this.grow();
    const i = this.n++;

    this.ids.push(rec.id);
    this.idToIdx.set(rec.id, { idx: i }); // last write wins: relabel targets the newest row
    this.offsets[i] = byteOffset;
    this.tsMs[i] = Date.parse(rec.timestamp) || 0;

    const t = rec.label.tier;
    this.tierIdx[i] = t ? FLYWHEEL_TIERS.indexOf(t) : TIER_NONE;
    this.srcIdx[i] = Math.max(0, SOURCE_ORDER.indexOf(rec.label.source));

    let f = 0;
    if (rec.execution.isSynthetic) f |= F_SYNTHETIC;
    if (rec.execution.fallbackOccurred) f |= F_FALLBACK;
    if (rec.trainable && rec.input.featureVector && rec.input.featureVector.length === VECTOR_DIMS) {
      f |= F_HAS_VECTOR;
      for (let d = 0; d < VECTOR_DIMS; d++) this.vectors[i * VECTOR_DIMS + d] = rec.input.featureVector[d];
    }
    if (f & F_HAS_VECTOR) f |= F_TRAINABLE;
    this.flags[i] = f;

    const model = rec.execution.modelUsed;
    let mi = this.modelPool.indexOf(model);
    if (mi === -1) {
      this.modelPool.push(model);
      mi = this.modelPool.length - 1;
    }
    this.modelIdx[i] = mi;
    this.promptPrefix.push(rec.input.userPrompt.slice(0, 48).toLowerCase());
  }

  private grow(): void {
    const newCap = this.cap === 0 ? 1024 : this.cap * 2;
    const offsets = new Float64Array(newCap); offsets.set(this.offsets.subarray(0, this.n));
    const tsMs = new Float64Array(newCap); tsMs.set(this.tsMs.subarray(0, this.n));
    const vectors = new Float64Array(newCap * VECTOR_DIMS); vectors.set(this.vectors.subarray(0, this.n * VECTOR_DIMS));
    const tierIdx = new Uint8Array(newCap); tierIdx.set(this.tierIdx.subarray(0, this.n));
    const srcIdx = new Uint8Array(newCap); srcIdx.set(this.srcIdx.subarray(0, this.n));
    const flags = new Uint8Array(newCap); flags.set(this.flags.subarray(0, this.n));
    const modelIdx = new Int32Array(newCap); modelIdx.set(this.modelIdx.subarray(0, this.n));
    this.offsets = offsets; this.tsMs = tsMs; this.vectors = vectors;
    this.tierIdx = tierIdx; this.srcIdx = srcIdx; this.flags = flags; this.modelIdx = modelIdx;
    this.cap = newCap;
  }

  // ---- overrides -----------------------------------------------------------

  private loadOverrides(): void {
    if (this.labelsLoaded) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.labelsPath, 'utf8'));
      const out: LabelOverrideMap = {};
      for (const [id, value] of Object.entries(parsed || {})) {
        const v = value as any;
        if (v && isTier(v.tier)) out[id] = { tier: v.tier, updatedAt: String(v.updatedAt || '') };
      }
      this.overrides = out;
    } catch {
      this.overrides = {};
    }
    this.labelsLoaded = true;
  }

  private writeOverrides(): void {
    const dir = path.dirname(this.labelsPath);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
    }
    // Atomic swap: a crash mid-write must not corrupt the label history.
    const tmp = `${this.labelsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.overrides, null, 2), 'utf8');
    fs.renameSync(tmp, this.labelsPath);
  }

  /** Effective label for row i: the overlay if present, else the observed derivation. */
  private effectiveLabel(i: number): FlywheelRecord['label'] {
    const observed = deriveDefaultLabel({
      targetTier: FLYWHEEL_TIERS[this.tierIdx[i]] ?? 'plus',
      tierUsed: FLYWHEEL_TIERS[this.tierIdx[i]] ?? 'plus',
      fallbackOccurred: (this.flags[i] & F_FALLBACK) !== 0,
    });
    const override = this.overrides[this.ids[i]];
    if (!override) return observed;
    return {
      ...observed,
      tier: override.tier,
      source: 'human',
      confidence: 1,
      updatedAt: override.updatedAt,
    };
  }

  /**
   * Set or clear an operator label. Returns the row's effective label after
   * the change (human override or re-derived observation), or null when the
   * id does not exist in the dataset. Targets the most recent row with that id.
   */
  public setLabel(id: string, tier: TierLevel | null): FlywheelRecord['label'] | null {
    this.ensureIndexed();
    const entry = this.idToIdx.get(id);
    if (!entry) return null;
    if (tier === null) {
      delete this.overrides[id];
    } else {
      if (!isTier(tier)) throw new Error(`Invalid tier: ${String(tier)}`);
      this.overrides[id] = { tier, updatedAt: new Date().toISOString() };
    }
    this.writeOverrides();
    return this.effectiveLabel(entry.idx);
  }

  /** Clear every operator label (does not touch the append-only dataset). */
  public clearOverrides(): number {
    this.ensureIndexed();
    const count = Object.keys(this.overrides).length;
    this.overrides = {};
    this.writeOverrides();
    return count;
  }

  // ---- random row access ---------------------------------------------------

  /** Read one full record back off disk by index position (lazy detail). */
  private readRow(i: number): FlywheelRecord | null {
    this.ensureIndexed();
    if (i < 0 || i >= this.n) return null;
    const start = this.offsets[i];
    const end = i + 1 < this.n ? this.offsets[i + 1] : this.fileSize();
    const len = Math.max(0, end - start);
    if (len === 0 || len > 4 * 1024 * 1024) return null;
    if (this.fd === null) {
      try { this.fd = fs.openSync(this.datasetPath, 'r'); } catch { return null; }
    }
    const buf = Buffer.allocUnsafe(len);
    try {
      const got = fs.readSync(this.fd, buf, 0, len, start);
      const raw = JSON.parse(buf.toString('utf8', 0, got).trim());
      const rec = migrateRecord(raw);
      return rec ? { ...rec, label: this.effectiveLabel(i) } : null;
    } catch {
      return null;
    }
  }

  // ---- summary -------------------------------------------------------------

  public summary(): DatasetSummary {
    this.ensureIndexed();
    if (this.summaryCache && this.summaryCache.version === this.indexVersion) {
      return this.summaryCache.value;
    }

    const trainableByTier: Record<string, number> = {};
    const sourceDistribution: Record<string, number> = {};
    let trainable = 0;
    let synthetic = 0;
    let humanLabeled = 0;
    let unlabeled = 0;
    let minTs = Infinity;
    let maxTs = -Infinity;

    for (let i = 0; i < this.n; i++) {
      const f = this.flags[i];
      if (f & F_SYNTHETIC) synthetic++;
      const label = this.effectiveLabel(i);
      if (label.source === 'human') humanLabeled++;
      sourceDistribution[label.source] = (sourceDistribution[label.source] || 0) + 1;
      if (label.tier) {
        if ((f & F_TRAINABLE) && !(f & F_SYNTHETIC)) {
          trainable++;
          trainableByTier[label.tier] = (trainableByTier[label.tier] || 0) + 1;
        }
      } else {
        unlabeled++;
      }
      if (this.tsMs[i] < minTs) minTs = this.tsMs[i];
      if (this.tsMs[i] > maxTs) maxTs = this.tsMs[i];
    }

    const value: DatasetSummary = {
      total: this.n,
      trainable,
      synthetic,
      humanLabeled,
      unlabeled,
      trainableByTier,
      sourceDistribution,
      datasetPath: this.datasetPath,
      labelsPath: this.labelsPath,
      fileBytes: this.fileSize(),
      firstTimestamp: Number.isFinite(minTs) ? new Date(minTs).toISOString() : null,
      lastTimestamp: Number.isFinite(maxTs) ? new Date(maxTs).toISOString() : null,
    };
    this.summaryCache = { version: this.indexVersion, value };
    return value;
  }

  // ---- query ----------------------------------------------------------------

  /** Effective tier for row i — the overlay if present, else the indexed value. */
  private effTier(i: number): TierLevel | null {
    const o = this.overrides[this.ids[i]];
    if (o) return o.tier;
    return this.tierIdx[i] === TIER_NONE ? null : FLYWHEEL_TIERS[this.tierIdx[i]];
  }

  /** Effective label source for row i — 'human' when an overlay exists. */
  private effSource(i: number): FlywheelLabelSource {
    return this.overrides[this.ids[i]] ? 'human' : SOURCE_ORDER[this.srcIdx[i]];
  }

  private matchesIndex(i: number, q: SampleQuery): boolean {
    const f = this.flags[i];
    if (!q.includeSynthetic && f & F_SYNTHETIC) return false;
    if (q.trainableOnly && !(f & F_TRAINABLE && !(f & F_SYNTHETIC) && this.effTier(i) !== null)) return false;

    // Tier/source filtering MUST consult the effective (overlay-aware) values:
    // a human relabel changes both without touching the index columns. The
    // lookup is skipped entirely while no overrides exist — the common case.
    if (q.tier && q.tier !== 'any') {
      const t = Object.keys(this.overrides).length > 0 ? this.effTier(i) : (this.tierIdx[i] === TIER_NONE ? null : FLYWHEEL_TIERS[this.tierIdx[i]]);
      if (q.tier === 'none') {
        if (t !== null) return false;
      } else if (t !== q.tier) return false;
    }
    if (q.source && q.source !== 'any') {
      const s = Object.keys(this.overrides).length > 0 ? this.effSource(i) : SOURCE_ORDER[this.srcIdx[i]];
      if (s !== q.source) return false;
    }

    if (q.search) {
      const needle = q.search.toLowerCase();
      const model = this.modelPool[this.modelIdx[i]] || '';
      if (
        !this.ids[i].toLowerCase().includes(needle) &&
        !model.toLowerCase().includes(needle) &&
        !this.promptPrefix[i].includes(needle)
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Filter over the columnar index (fast, no file I/O), then materialize only
   * the returned page by reading those lines back off disk. Rows come back in
   * append order, newest last-position first — for gateway traffic the append
   * order IS the chronological order.
   */
  public query(query: SampleQuery = {}): { rows: SampleRow[]; total: number; offset: number; limit: number } {
    this.ensureIndexed();
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const offset = Math.max(query.offset ?? 0, 0);

    // Walk newest-first (append order reversed). The full pass is required for
    // an exact `total`; over the columnar index this is a few typed-array
    // comparisons per row, not file I/O.
    const pageIdx: number[] = [];
    let total = 0;
    for (let i = this.n - 1; i >= 0; i--) {
      if (!this.matchesIndex(i, query)) continue;
      if (total >= offset && pageIdx.length < limit) pageIdx.push(i);
      total++;
    }

    const rows: SampleRow[] = [];
    for (const i of pageIdx) {
      const rec = this.readRow(i);
      if (!rec) continue;
      rows.push({
        id: rec.id,
        timestamp: rec.timestamp,
        userPrompt: rec.input.userPrompt,
        tokenCount: rec.input.tokenCount,
        featureVector: rec.input.featureVector,
        decision: rec.decision,
        execution: rec.execution,
        label: rec.label,
        trainable: rec.trainable,
      });
    }

    return { rows, total, offset, limit };
  }

  // ---- training pool ---------------------------------------------------------

  /**
   * Materialize trainable samples straight from the index — no file I/O at
   * all, the feature vectors are columns. Synthetic rows, unlabelled rows and
   * rows whose feature vector is missing (every legacy v1 row) are dropped
   * here, so the console and the trainer always agree on the eligible pool.
   */
  public trainingSamples(options: { includeSynthetic?: boolean; minSource?: FlywheelLabelSource } = {}): {
    samples: Array<{ features: number[]; targetTier: TierLevel }>;
    featureDimensions: number;
    skipped: Record<string, number>;
  } {
    this.ensureIndexed();
    const skipped: Record<string, number> = {
      synthetic: 0,
      unlabelled: 0,
      missingVector: 0,
      weakSource: 0,
      badDimension: 0,
    };
    const samples: Array<{ features: number[]; targetTier: TierLevel }> = [];

    const sourceRank: Record<FlywheelLabelSource, number> = {
      human: 3,
      runtime_fallback: 2,
      observed_execution: 1,
      unlabeled: 0,
    };
    const minRank = sourceRank[options.minSource ?? 'observed_execution'];

    for (let i = 0; i < this.n; i++) {
      const f = this.flags[i];
      if (f & F_SYNTHETIC && !options.includeSynthetic) {
        skipped.synthetic++;
        continue;
      }
      const label = this.effectiveLabel(i);
      if (!label.tier) {
        skipped.unlabelled++;
        continue;
      }
      if (sourceRank[label.source] < minRank) {
        skipped.weakSource++;
        continue;
      }
      if (!(f & F_HAS_VECTOR)) {
        skipped.missingVector++;
        continue;
      }
      const features = Array.from(this.vectors.subarray(i * VECTOR_DIMS, (i + 1) * VECTOR_DIMS));
      if (features.length !== VECTOR_DIMS) {
        skipped.badDimension++;
        continue;
      }
      samples.push({ features, targetTier: label.tier });
    }

    return { samples, featureDimensions: VECTOR_DIMS, skipped };
  }
}

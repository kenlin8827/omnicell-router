/**
 * Flywheel dataset lifecycle engine — the single implementation of the four
 * sanctioned deletion operations (prune, retention sweep, batch delete, reset),
 * shared by the HTTP console, the hourly collector sweep and the offline CLI.
 * Spec: docs/design/flywheel-deletion.md (D1–D3, D9).
 *
 * Invariants (red-lines R1–R3):
 *   - A record is never mutated: whole-line discard only, survivor lines are
 *     copied byte-for-byte verbatim.
 *   - Every rewrite is atomic tmp+rename, so a reader never sees a partial file.
 *   - Backup matrix: prune/reset write a full `.bak-<ts>` (rotated, newest 3);
 *     batch delete appends removed lines verbatim to the `.deleted.jsonl`
 *     sidecar (O(deleted), restore = append back); the retention sweep writes
 *     nothing — bounded disk IS the feature, and the knobs are default-off.
 *   - Every removal path purges dead ids from the labels overlay, so the
 *     overlay never accumulates orphans keyed to removed records (D9).
 *
 * SYNC-STALL CEILING (marked, cp-marked): a rewrite reads and writes the whole
 * file synchronously — roughly 1–3 s at ~800 MB. Same trade-off as the sync
 * training loop (trainer.ts:11-15): HTTP calls are explicit operator actions
 * and the automated sweep is hourly, so the stall is rare and intentional.
 * Upgrade path if the ceiling is ever hit: move the rewrite into a worker
 * thread / streaming copy.
 *
 * No lock is needed (D2): rewrites are fully synchronous and JS is
 * single-threaded, so no in-process writer can interleave with one. External
 * rewrites (offline CLI, timer sweep) swap the inode and are picked up by the
 * inode guard in dataset.ts `ensureIndexed()`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FlywheelRecord, detectSynthetic, migrateRecord } from './schema.js';

// ---- shared path conventions ------------------------------------------------

/** Sidecar overlay path for human label corrections — mirrors FlywheelDataset. */
export function labelsPathFor(datasetPath: string): string {
  return `${datasetPath}.labels.json`;
}

/** Backup sidecar for batch-deleted lines (D3): removed rows land here verbatim. */
export function sidecarPathFor(datasetPath: string): string {
  return `${datasetPath}.deleted.jsonl`;
}

// ---- prune planning (pure, zero fs) ------------------------------------------

export interface PruneOptions {
  dropSynthetic: boolean;
  dropDuplicates: boolean;

}

export interface PruneCounters {
  synthetic: number;
  duplicate: number;
  malformed: number;
}

export interface PrunePlan {
  total: number;
  keptLines: string[];
  removedLines: string[];
  /** Ids of surviving records — drives the labels-overlay orphan purge. */
  keptIds: Set<string>;
  dropped: PruneCounters;
}

/**
 * Pure prune planner — no fs at all, so a preview can never write. Decision
 * order is identical to the historic CLI: synthetic → duplicate; malformed
 * (unparseable) lines are dropped unconditionally — hygiene IS prune's job
 * (D4). Valid-JSON lines that are not records are kept verbatim (CLI parity).
 */
export function planPrune(lines: string[], opts: PruneOptions): PrunePlan {
  const keptLines: string[] = [];
  const removedLines: string[] = [];
  const keptIds = new Set<string>();
  const seenIds = new Set<string>();
  const dropped: PruneCounters = { synthetic: 0, duplicate: 0, malformed: 0 };
  let total = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue; // blank lines never count and never survive a rewrite
    total++;

    // JSON.parse output is untyped by nature; every access below is optional-
    // chained or coerced, and the duplicate/kept-id path goes through
    // migrateRecord, which validates property by property.
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      dropped.malformed++;
      removedLines.push(line);
      continue;
    }

    // Reuse the collector's own detector so a prune can never disagree with
    // what the console labels as test traffic. migrateRecord validates
    // property by property; a pre-v2 line comes back null and is kept
    // verbatim unless a drop option applies.
    const exec = parsed?.execution;
    const isSynthetic =
      exec?.isSynthetic === true ||
      detectSynthetic(String(parsed?.id ?? ''), String(exec?.modelUsed ?? ''), exec?.fallbackReason);

    if (opts.dropSynthetic && isSynthetic) {
      dropped.synthetic++;
      removedLines.push(line);
      continue;
    }

    const rec = migrateRecord(parsed);
    const id = rec?.id ?? trimmed;
    if (opts.dropDuplicates && seenIds.has(id)) {
      dropped.duplicate++;
      removedLines.push(line);
      continue;
    }
    seenIds.add(id);
    keptLines.push(line);
    if (rec) keptIds.add(rec.id);
  }

  return { total, keptLines, removedLines, keptIds, dropped };
}

export interface PruneOutcome {
  total: number;
  kept: number;
  dropped: PruneCounters;
  /** true only when apply was requested AND something was actually dropped (§3.1). */
  applied: boolean;
  backupPath: string | null;
  removedLabels: number;
}

/**
 * Prune one dataset file (CLI + HTTP share this). `apply: false` is pure
 * preview. Nothing-to-prune → no rewrite, no backup, mtime untouched,
 * `applied: false`. Returns null when the dataset file does not exist
 * (caller decides 404 vs no-op).
 */
export function pruneDataset(datasetPath: string, opts: PruneOptions, apply: boolean): PruneOutcome | null {
  const read = readDatasetLines(datasetPath);
  if (!read) return null;
  const plan = planPrune(read.lines, opts);
  if (!apply || plan.removedLines.length === 0) {
    return {
      total: plan.total,
      kept: plan.keptLines.length,
      dropped: plan.dropped,
      applied: false,
      backupPath: null,
      removedLabels: 0,
    };
  }
  const res = writeRewrite(datasetPath, plan.keptLines, plan.removedLines, { backup: true, rotateKeep: 3 });
  const removedLabels = pruneLabelOverlay(labelsPathFor(datasetPath), plan.keptIds);
  return {
    total: res.total,
    kept: res.kept,
    dropped: plan.dropped,
    applied: res.rewrote,
    backupPath: res.backupPath,
    removedLabels,
  };
}

// ---- core rewrite primitives --------------------------------------------------

export interface RewriteResult {
  total: number;
  kept: number;
  removed: number;
  rewrote: boolean;
  backupPath: string | null;
}

interface RewriteOptions {
  /** Copy the pre-rewrite file to `<path>.bak-<ts>` before swapping. */
  backup?: boolean;
  /** Backups to keep after writing one (default 3). */
  rotateKeep?: number;
  /** Removed lines are appended verbatim to this file before the swap. */
  sidecarPath?: string | null;
}

/**
 * Generic filter-and-rewrite (D2): `filter` is consulted once per non-blank
 * line, in file order; a false verdict discards the line verbatim (into the
 * sidecar when one is configured). Nothing removed → zero writes.
 */
export function rewriteDataset(
  datasetPath: string,
  filter: (line: string) => boolean,
  opts: RewriteOptions = {}
): RewriteResult {
  const read = readDatasetLines(datasetPath);
  if (!read) return { total: 0, kept: 0, removed: 0, rewrote: false, backupPath: null };
  const kept: string[] = [];
  const removed: string[] = [];
  for (const line of read.lines) {
    if (line.trim() === '') continue;
    (filter(line) ? kept : removed).push(line);
  }
  return writeRewrite(datasetPath, kept, removed, opts);
}

/** Sync spin wait — the whole rewrite is synchronous (D2); Atomics.wait is Node's only timer-free sleep. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Atomic tmp→target swap with a bounded retry. Windows rejects renaming over
 * a file an AV/indexer handle momentarily holds open (intermittent EPERM /
 * EACCES / EBUSY sharing violations — reproduced ~1/40 runs on the dev host).
 * Up to 4 backoff sleeps (10/20/30/40 ms) keeps the engine fully synchronous
 * and the stall operator-invisible. On exhaustion: tmp is cleaned, the
 * original file is untouched, and the error is rethrown fail-loud (R3 stays
 * all-or-nothing). Marked ceiling (cp-marked): upgrade path is platform
 * share-flags or a queued writer if contention ever turns chronic.
 */
function atomicSwap(tmp: string, target: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (err: any) {
      const transient = ['EPERM', 'EACCES', 'EBUSY'].includes(err?.code);
      if (!transient || attempt >= 4) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* tmp never materialised */
        }
        throw err;
      }
      sleepSync(10 * (attempt + 1));
    }
  }
}

/**
 * The single writer. Order matters for fail-safety: backup first, sidecar
 * before the swap (a failed rewrite must never lose the removed lines — a
 * re-run re-deletes idempotently), tmp+rename last. The original file is only
 * ever replaced by an atomic rename, so a throw leaves it untouched.
 */
function writeRewrite(
  datasetPath: string,
  kept: string[],
  removed: string[],
  opts: RewriteOptions
): RewriteResult {
  const result: RewriteResult = {
    total: kept.length + removed.length,
    kept: kept.length,
    removed: removed.length,
    rewrote: false,
    backupPath: null,
  };
  if (removed.length === 0) return result; // nothing to prune — leave mtime untouched

  if (opts.backup) {
    result.backupPath = `${datasetPath}.bak-${Date.now()}`;
    fs.copyFileSync(datasetPath, result.backupPath);
    rotateBackups(datasetPath, opts.rotateKeep ?? 3);
  }
  if (opts.sidecarPath && removed.length) {
    fs.appendFileSync(opts.sidecarPath, removed.join('\n') + '\n', 'utf8');
  }

  // Unique tmp name: the gateway process and the offline CLI can rewrite the
  // same dataset concurrently; rename is atomic per file, so the last writer
  // wins wholesale and never interleaves two partial outputs.
  const tmp = `${datasetPath}.tmp-${process.pid}`;
  const content = kept.length ? kept.join('\n') + '\n' : '';
  try {
    fs.writeFileSync(tmp, content, 'utf8');
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* tmp never materialised */
    }
    throw err;
  }
  atomicSwap(tmp, datasetPath);
  result.rewrote = true;
  return result;
}

/** Read dataset as physical lines; null when the file does not exist. */
function readDatasetLines(datasetPath: string): { raw: string; lines: string[] } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(datasetPath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  const lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { raw, lines };
}

/** Parse + migrate one line, swallowing both failures (delete ops never classify). */
function migrateQuiet(line: string): FlywheelRecord | null {
  try {
    return migrateRecord(JSON.parse(line.trim()));
  } catch {
    return null;
  }
}

/**
 * Delete all but the newest `keep` `<path>.bak-<ts>` siblings (rotation keeps
 * `.bak` churn bounded — design risk table). Best-effort: a failed unlink
 * leaves one stale backup, which must never fail an operation whose backup
 * already landed.
 */
export function rotateBackups(datasetPath: string, keep = 3): void {
  const dir = path.dirname(datasetPath);
  const prefix = `${path.basename(datasetPath)}.bak-`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const backups = names
    .filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
    .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
  for (const stale of backups.slice(keep)) {
    try {
      fs.rmSync(path.join(dir, stale), { force: true });
    } catch {
      /* best effort — see docstring */
    }
  }
}

// ---- op 2: batch delete by ids (D7) -------------------------------------------

export interface DeleteOutcome {
  deleted: number;
  /** Requested ids with no line in the dataset — in request order, deduped. */
  notFound: string[];
  removedLabels: number;
  sidecarPath: string;
  rewrote: boolean;
}

/**
 * Partial-success + idempotent batch delete: every line whose record id is in
 * `ids` is discarded (all duplicates of a deleted id go — whole-record
 * discard), the removed lines are appended verbatim to the sidecar, and the
 * labels overlay is purged down to the surviving ids (which also sweeps up
 * pre-existing orphans keyed to ids that died earlier).
 * Missing dataset file → every id is notFound, zero writes.
 */
export function deleteRecordsById(datasetPath: string, ids: string[]): DeleteOutcome {
  const wanted = new Set(ids);
  const found = new Set<string>();
  const keptIds = new Set<string>();
  const sidecarPath = sidecarPathFor(datasetPath);
  const res = rewriteDataset(
    datasetPath,
    (line) => {
      const rec = migrateQuiet(line);
      if (!rec) return true; // malformed / not a record — no id, never matches
      if (wanted.has(rec.id)) {
        found.add(rec.id);
        return false;
      }
      keptIds.add(rec.id);
      return true;
    },
    { sidecarPath }
  );
  const removedLabels = res.rewrote ? pruneLabelOverlay(labelsPathFor(datasetPath), keptIds) : 0;
  return {
    deleted: res.removed,
    notFound: [...wanted].filter((id) => !found.has(id)),
    removedLabels,
    sidecarPath,
    rewrote: res.rewrote,
  };
}

// ---- op 3: reset (D8) ----------------------------------------------------------

export interface ResetOutcome {
  removedRecords: number;
  removedLabels: number;
  backupPath: string | null;
  labelsBackupPath: string | null;
  /** true when the dataset file itself was rewritten (route invalidates on it). */
  datasetRewrote: boolean;
}

/**
 * Empty the dataset and clear the labels overlay; both are archived as
 * `.bak-<ts>` before the swap (the overlay only when non-empty — D3). Never
 * touches the trained model files: data lifecycle ≠ deployed weights (D8).
 * Missing/empty dataset → zero removals, no backup, no write (idempotent).
 */
export function resetDataset(datasetPath: string): ResetOutcome {
  const outcome: ResetOutcome = {
    removedRecords: 0,
    removedLabels: 0,
    backupPath: null,
    labelsBackupPath: null,
    datasetRewrote: false,
  };

  const read = readDatasetLines(datasetPath);
  if (read) {
    const content = read.lines.filter((l) => l.trim() !== '');
    if (content.length > 0) {
      const res = writeRewrite(datasetPath, [], content, { backup: true, rotateKeep: 3 });
      outcome.removedRecords = res.removed;
      outcome.backupPath = res.backupPath;
      outcome.datasetRewrote = res.rewrote;
    }
  }

  // Labels overlay: archive the raw bytes verbatim (even a corrupt file is
  // data), then clear. A `{}`-shaped overlay is "empty": no backup, no write.
  const labelsPath = labelsPathFor(datasetPath);
  let raw: string | null;
  try {
    raw = fs.readFileSync(labelsPath, 'utf8');
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
    raw = null;
  }
  if (raw !== null && raw.trim() !== '') {
    let entries: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries = parsed as Record<string, unknown>;
    } catch {
      /* unparseable overlay: removedLabels stays 0, the bytes still get archived */
    }
    const nonEmpty = entries === null ? raw.trim() !== '{}' : Object.keys(entries).length > 0;
    if (nonEmpty) {
      outcome.labelsBackupPath = `${labelsPath}.bak-${Date.now()}`;
      fs.copyFileSync(labelsPath, outcome.labelsBackupPath);
      rotateBackups(labelsPath);
      if (entries) outcome.removedLabels = Object.keys(entries).length;
      writeOverlayJson(labelsPath, {});
    }
  }
  return outcome;
}

// ---- op 1b/4: retention sweep (D4) ---------------------------------------------

export interface RetentionConfig {
  retentionDays: number;
  maxFileSizeMB: number;
}

export interface RetentionOutcome {
  removed: number;
  removedLabels: number;
  rewrote: boolean;
}

/**
 * One combined rewrite: the age pass runs first (drop records whose
 * `timestamp` is older than retentionDays), then the size pass trims
 * oldest-first until the file fits maxFileSizeMB. A record with an
 * unparseable timestamp is ALWAYS kept (and treated as newest for the size
 * pass); malformed lines are kept too — hygiene is prune's job (D4).
 * NO backup is written (D3: retention is the only zero-backup path; the
 * knobs are default-off to guard it). Zero removals or both knobs off →
 * zero fs writes.
 */
export function applyRetention(datasetPath: string, cfg: RetentionConfig): RetentionOutcome {
  const days = Math.max(0, Number.isFinite(cfg.retentionDays) ? cfg.retentionDays : 0);
  const mb = Math.max(0, Number.isFinite(cfg.maxFileSizeMB) ? cfg.maxFileSizeMB : 0);
  if (days === 0 && mb === 0) return { removed: 0, removedLabels: 0, rewrote: false };

  const read = readDatasetLines(datasetPath);
  if (!read) return { removed: 0, removedLabels: 0, rewrote: false };

  interface Row {
    line: string;
    bytes: number; // stored line + its newline
    ts: number; // parsed ms, Infinity when unparseable (kept, never trimmed first)
    id: string | null; // record id when the line migrated cleanly
  }
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : -Infinity;
  const survivors: Row[] = [];
  const removedLines: string[] = [];

  for (const line of read.lines) {
    if (line.trim() === '') continue;
    const rec = migrateQuiet(line);
    const parsedTs = rec ? Date.parse(rec.timestamp) : NaN;
    const ts = Number.isFinite(parsedTs) ? parsedTs : Infinity;
    if (rec && ts < cutoff) {
      removedLines.push(line);
      continue; // age pass
    }
    survivors.push({ line, bytes: Buffer.byteLength(line, 'utf8') + 1, ts, id: rec?.id ?? null });
  }

  let keptRows = survivors;
  if (mb > 0) {
    const maxBytes = mb * 1024 * 1024;
    let totalBytes = survivors.reduce((sum, r) => sum + r.bytes, 0);
    if (totalBytes > maxBytes) {
      const byAge = [...survivors].sort((a, b) => a.ts - b.ts); // Infinity sorts last
      const dropped = new Set<Row>();
      for (const row of byAge) {
        if (totalBytes <= maxBytes) break;
        dropped.add(row);
        totalBytes -= row.bytes;
      }
      for (const row of dropped) removedLines.push(row.line);
      keptRows = survivors.filter((r) => !dropped.has(r));
    }
  }

  if (removedLines.length === 0) return { removed: 0, removedLabels: 0, rewrote: false };

  // D9 purge must see the FINAL survivor set: the size pass trims rows after
  // the age pass, so keptIds is rebuilt from keptRows — ids collected before
  // the trim would keep size-removed labels alive as orphans (finding F1).
  const keptIds = new Set<string>();
  for (const row of keptRows) if (row.id !== null) keptIds.add(row.id);

  const res = writeRewrite(datasetPath, keptRows.map((r) => r.line), removedLines, {});
  const removedLabels = pruneLabelOverlay(labelsPathFor(datasetPath), keptIds);
  return { removed: res.removed, removedLabels, rewrote: res.rewrote };
}

// ---- labels overlay purge (D9, shared by all four paths) -----------------------

/**
 * Atomically rewrite the labels overlay. `keepIds === null` clears every
 * entry (reset); a Set keeps only entries whose id is still alive in the
 * dataset. Missing or unparseable overlay → zero writes (the dataset reader
 * already ignores a corrupt overlay; deleting targeted entries from bytes we
 * cannot interpret would be data loss). Returns entries removed.
 */
export function pruneLabelOverlay(labelsPath: string, keepIds: Set<string> | null): number {
  let parsed: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(labelsPath, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 0;
    parsed = obj as Record<string, unknown>;
  } catch {
    return 0;
  }
  const ids = Object.keys(parsed);
  const doomed = keepIds === null ? ids : ids.filter((id) => !keepIds.has(id));
  if (doomed.length === 0) return 0;
  const survivors: Record<string, unknown> = {};
  if (keepIds !== null) {
    for (const [id, value] of Object.entries(parsed)) {
      if (keepIds.has(id)) survivors[id] = value;
    }
  }
  writeOverlayJson(labelsPath, survivors);
  return doomed.length;
}

/** Atomic overlay swap in the exact format FlywheelDataset.writeOverrides uses. */
function writeOverlayJson(labelsPath: string, map: Record<string, unknown>): void {
  const dir = path.dirname(labelsPath);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* best effort — the write below surfaces a real problem */
    }
  }
  const tmp = `${labelsPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* tmp never materialised */
    }
    throw err;
  }
  atomicSwap(tmp, labelsPath);
}

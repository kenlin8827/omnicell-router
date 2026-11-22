import * as fs from 'node:fs';
import * as path from 'node:path';
import { CAPTURE_MIGRATORS } from './registry.js';
import {
  LEGACY_UNMARKED_SCHEMA,
  type CaptureArchiveMigrator,
  type CaptureFileMigrationResult,
  type CaptureLineMigration,
  type CaptureMigratorFactory,
  type CaptureMigratorFilePlan,
  type CaptureRootMigrationSummary,
} from './migrator.js';

/**
 * Capture archive migration engine (ADR-0008 section 5, ADR-0024 section 8).
 *
 * The live `capture/` root evolves IN PLACE: when `CAPTURE_SCHEMA` moves to
 * N+1, a step class is registered in `registry.ts` and the boot + hourly
 * sweeps rewrite COLD files line by line, hop by hop, always through the
 * step the registry reports for `(from, to)`. Readers stay strict
 * single-shape: a line that never reached the target schema is rejected by
 * the archive-line validator, never silently normalized.
 *
 * Schema 1 is the unmarked baseline (no `schema` field at all), so the only
 * place a version is INFERRED is the chain entry point below — and only for
 * a line that claims no version at all.
 *
 * A line the engine cannot even parse is carried over BYTE-FOR-BYTE instead
 * of failing the file: one rotten line must never cost a reader the other
 * thousand good ones. `unreadable` in the summary counts them, so the loss is
 * reported rather than hidden.
 */

/** Files modified within this window are considered hot and skipped. */
const HOT_FILE_MS = 10 * 60_000;

/** The version a line claims, or `undefined` when it claims none. */
export function schemaOf(line: Record<string, unknown>): number | undefined {
  const claimed = line.schema;
  if (typeof claimed === 'undefined') return undefined;
  return typeof claimed === 'number' && Number.isInteger(claimed) ? claimed : undefined;
}

/** The schema-less terminal marker that closes a sealed shard. */
function isOverflowMarker(line: Record<string, unknown>): boolean {
  return line.eventType === 'archive-overflow';
}

/**
 * Build a fresh chain of step instances. Factories (not instances) are
 * registered precisely so this is safe: a step's `begin()` state belongs to
 * one file and one pass, and the engine calls `begin()` per HOP, with the
 * file in the shape THAT hop will migrate.
 */
export function prepareMigrationChain(
  chain: readonly CaptureMigratorFactory[] = CAPTURE_MIGRATORS,
): CaptureArchiveMigrator[] {
  return chain.map(factory => factory());
}

/** Resolve the step for one hop, or explain why the chain has a gap. */
function stepFor(
  steps: readonly CaptureArchiveMigrator[],
  v: number,
): CaptureArchiveMigrator | string {
  const step = steps.find(m => m.from === v && m.to === v + 1);
  return step ?? `no migrator registered for schema ${v} -> ${v + 1}`;
}

/**
 * Walk ONE line to `target`, planning each hop over a single-line file. Used
 * by tests and ad-hoc tooling; the file-level pass walks every line of a hop
 * together so a step can reason about its neighbours.
 */
function walkCaptureLine(
  raw: Record<string, unknown>,
  target: number,
  steps: readonly CaptureArchiveMigrator[],
): CaptureLineMigration {
  if (typeof raw.schema !== 'undefined' && schemaOf(raw) === undefined) {
    return { ok: false, reason: 'line schema is not an integer' };
  }
  const start = schemaOf(raw) ?? LEGACY_UNMARKED_SCHEMA;
  if (start > target) {
    return { ok: false, reason: `line schema ${start} is newer than target ${target}` };
  }
  let line = raw;
  for (let v = start; v < target; v++) {
    const step = stepFor(steps, v);
    if (typeof step === 'string') return { ok: false, reason: step };
    // The hop plans what it is about to migrate — not the disk shape a
    // previous hop already left behind.
    const plan: CaptureMigratorFilePlan = { lines: [line] };
    step.begin?.(plan);
    const verdict = step.migrate(line, { lines: plan.lines, index: 0 });
    if (!verdict || verdict.ok !== true) {
      return { ok: false, reason: verdict?.reason ?? `migrator ${v} -> ${v + 1} returned no verdict` };
    }
    line = {
      ...verdict.line,
      schema: step.to,
      // Provenance, not decoration: a migrated line says which schema it was
      // WRITTEN at, so a reconstructed turn identity is never mistaken for an
      // admission-gate stamp. The first hop wins (migrated 1 -> 3 stays 1).
      migratedFrom: line.migratedFrom ?? step.from,
    };
  }
  return { ok: true, line };
}

/** Single-line convenience wrapper (tests, ad-hoc tooling). */
export function migrateCaptureLine(
  raw: Record<string, unknown>,
  target: number,
  chain: readonly CaptureMigratorFactory[] = CAPTURE_MIGRATORS,
): CaptureLineMigration {
  return walkCaptureLine(raw, target, prepareMigrationChain(chain));
}

/** One parsed shard line: the bytes, the object, and what it claims. */
interface Slot {
  raw: string;
  line?: Record<string, unknown>;
  /** Chain entry version for an archive event; unset for markers/blank. */
  version?: number;
  /** Carried over untouched: a marker, a blank line, or unparseable bytes. */
  verbatim?: boolean;
}

/**
 * Migrate ONE archive file. Whole-file discipline: every line either
 * migrates cleanly or the file is left EXACTLY as it was — readers never
 * observe a partially migrated archive. The rewrite is atomic (temp file
 * in the same directory, then rename over the original).
 *
 * Line vocabulary mirrors the reader's:
 * - a `schema`-stamped JSON object — walked up the chain;
 * - an unmarked `http-exchange` object — schema 1, walked from the baseline;
 * - the unmarked terminal `archive-overflow` marker — copied verbatim;
 * - anything else (unparseable text, unknown unmarked shapes) — whole file
 *   rejected.
 */
export async function migrateArchiveFile(
  filePath: string,
  target: number,
  opts?: { chain?: readonly CaptureMigratorFactory[]; hotMs?: number },
): Promise<CaptureFileMigrationResult> {
  const chain = opts?.chain ?? CAPTURE_MIGRATORS;
  const hotMs = opts?.hotMs ?? HOT_FILE_MS;

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return { status: 'rejected', reason: 'stat failed' };
  }
  // A sub-millisecond FUTURE mtime (timestamp rounding, not a time machine)
  // clamps to age 0, so `hotMs: 0` means "process everything" without a
  // rounding flip-flop.
  const age = Math.max(0, Date.now() - stat.mtimeMs);
  if (age < hotMs) return { status: 'hot' };

  let text: string;
  try {
    text = await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return { status: 'rejected', reason: 'read failed' };
  }

  const rawLines = text.split('\n');
  const slots: Slot[] = [];
  const objects: Record<string, unknown>[] = [];
  const objectIndex: number[] = [];
  /** Current schema of each entry in `objects` — advanced hop by hop. */
  const objectVersions: number[] = [];
  let unreadable = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    // Preserve the trailing (or embedded) empty line structure byte-for-byte.
    if (raw === '') {
      slots.push({ raw, verbatim: true });
      objectIndex.push(-1);
      continue;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      // Rotten bytes. There is nothing to migrate, but there is also nothing
      // to gain by failing the file: the byte is carried over as-is and the
      // reader skips it exactly as it skipped it before.
      slots.push({ raw, verbatim: true });
      objectIndex.push(-1);
      unreadable++;
      continue;
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      slots.push({ raw, verbatim: true });
      objectIndex.push(-1);
      unreadable++;
      continue;
    }
    const rec = obj as Record<string, unknown>;
    const claimed = schemaOf(rec);
    if (typeof rec.schema !== 'undefined' && claimed === undefined) {
      slots.push({ raw, verbatim: true });
      objectIndex.push(-1);
      unreadable++;
      continue;
    }
    if (claimed === undefined && (isOverflowMarker(rec) || rec.eventType !== 'http-exchange')) {
      // A terminal marker, or a shape written before this chain could name
      // it: metadata, not an archive event. Copied verbatim.
      slots.push({ raw, verbatim: true });
      objectIndex.push(-1);
      continue;
    }
    slots.push({ raw, line: rec, version: claimed ?? LEGACY_UNMARKED_SCHEMA });
    objectIndex.push(objects.length);
    objects.push(rec);
    objectVersions.push(claimed ?? LEGACY_UNMARKED_SCHEMA);
  }

  const pending = slots.some(s => s.version !== undefined && s.version !== target);
  if (!pending) return { status: 'untouched', unreadable };

  // No down-migration: a line NEWER than the target belongs to a newer build
  // and this pass must not touch it (same forward-compat posture as
  // `traces.db`).
  for (let i = 0; i < objectVersions.length; i++) {
    if (objectVersions[i] > target) {
      return { status: 'rejected', reason: `line schema ${objectVersions[i]} is newer than target ${target}` };
    }
  }

  const steps = prepareMigrationChain(chain);
  const working = objects.slice();
  const lowest = Math.min(...objectVersions);

  // HOP BY HOP over the whole file: the plan a step's `begin()` receives is
  // the shape that step will actually migrate, so a second hop never plans
  // against the disk shape the first hop already replaced.
  for (let v = lowest; v < target; v++) {
    const step = stepFor(steps, v);
    if (typeof step === 'string') return { status: 'rejected', reason: step };
    // ONE snapshot per hop: `begin()` and every `migrate()` call of this hop
    // see the same file — the shape this hop is about to rewrite, never a
    // blend of half its own output. A step that needs a neighbour's post-hop
    // shape derives it in `begin()`; it must not be able to observe the
    // rewrite happening underneath it.
    const input = working.slice();
    step.begin?.({ lines: input });
    for (let i = 0; i < working.length; i++) {
      if (objectVersions[i] !== v) continue;
      const verdict = step.migrate(input[i], { lines: input, index: i });
      if (!verdict || verdict.ok !== true) {
        return {
          status: 'rejected',
          reason: `${verdict?.reason ?? `migrator ${v} -> ${v + 1} returned no verdict`}`,
        };
      }
      working[i] = {
        ...verdict.line,
        schema: step.to,
        // Provenance, not decoration: see `walkCaptureLine`.
        migratedFrom: working[i].migratedFrom ?? step.from,
      };
      objectVersions[i] = step.to;
    }
  }

  const out: string[] = [];
  let migrated = 0;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot.verbatim || !slot.line || slot.version === target) {
      out.push(slot.raw);
      continue;
    }
    out.push(JSON.stringify(working[objectIndex[i]]));
    migrated++;
  }
  if (migrated === 0) return { status: 'untouched', unreadable };

  const tmp = `${filePath}.migrating`;
  try {
    await fs.promises.writeFile(tmp, out.join('\n'), 'utf8');
    // Re-check the original right before the swap. The pass read it moments
    // ago and the writer appends to the very same shard, so a rewrite over a
    // changed file would silently drop those appended bytes. Backing off is
    // always safe: the file keeps its old shape and readers keep rejecting it
    // until a later pass converts it.
    const now = await fs.promises.stat(filePath);
    if (now.size !== stat.size || now.mtimeMs !== stat.mtimeMs) {
      await fs.promises.unlink(tmp).catch(() => {});
      return { status: 'hot' };
    }
    await fs.promises.rename(tmp, filePath);
  } catch (e) {
    await fs.promises.unlink(tmp).catch(() => {});
    return { status: 'rejected', reason: `rewrite failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { status: 'migrated', lines: migrated, unreadable };
}

/**
 * Walk the whole live root (`<root>/<YYYY-MM-DD>/*.jsonl`) and migrate every
 * cold file. Fail-open per file: an error abandons that file for the next
 * pass and never throws.
 */
export async function migrateArchiveRoot(
  root: string,
  target: number,
  opts?: { chain?: readonly CaptureMigratorFactory[]; hotMs?: number },
): Promise<CaptureRootMigrationSummary> {
  const summary: CaptureRootMigrationSummary = { files: 0, lines: 0, hot: 0, rejected: 0, unreadable: 0 };
  if ((opts?.chain ?? CAPTURE_MIGRATORS).length === 0) return summary;

  let dates: string[];
  try {
    dates = (await fs.promises.readdir(root)).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n));
  } catch {
    return summary;
  }
  for (const date of dates) {
    let names: string[];
    try {
      names = await fs.promises.readdir(path.join(root, date));
    } catch {
      continue;
    }
    for (const name of names) {
      // Only JSONL shards; the media/ offload is content-addressed and
      // schema-agnostic.
      if (!name.endsWith('.jsonl')) continue;
      const res = await migrateArchiveFile(path.join(root, date, name), target, opts).catch(
        (): CaptureFileMigrationResult | null => null,
      );
      if (!res || res.status === 'rejected') summary.rejected++;
      else if (res.status === 'hot') summary.hot++;
      else {
        summary.unreadable += res.unreadable ?? 0;
        if (res.status === 'migrated') {
          summary.files++;
          summary.lines += res.lines;
        }
      }
    }
  }
  return summary;
}

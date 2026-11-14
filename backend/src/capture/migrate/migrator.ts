/**
 * One migration step of the capture archive chain — the contract every
 * `V{N}ToV{N+1}Migrate` class implements (ADR-0008 section 5).
 *
 * A step is a CLASS, one per hop, one file per class under `steps/`. The
 * engine resolves a hop by asking the registered steps for
 * `from === current && to === current + 1`; there is no global switch.
 */

/**
 * What a step may look at beyond the single line: the whole shard, in file
 * order, IN THE SHAPE THIS HOP WILL MIGRATE. The engine calls `begin()` per
 * hop, so a step never plans against a shape a previous hop already replaced.
 * `lines` is a SNAPSHOT taken at the start of the hop: every `migrate()` call
 * of that hop sees the same array, so a step can never observe its own
 * half-finished rewrite. A step that needs file-scoped facts (an attempt
 * ordinal, the previous request's shape) derives them in `begin()` and keeps
 * them in instance state — the engine hands it a FRESH instance per file, so
 * two archives never share state.
 */
export interface CaptureMigratorFilePlan {
  /** Every JSON-object line of the shard this hop is about to rewrite. */
  readonly lines: readonly Record<string, unknown>[];
}

export interface CaptureMigratorLineContext extends CaptureMigratorFilePlan {
  /** Position of this line inside `lines`. */
  readonly index: number;
}

export type CaptureMigratorVerdict =
  | { ok: true; line: Record<string, unknown> }
  /**
   * The line cannot be represented at the target schema. The engine then
   * leaves the WHOLE file byte-identical — a file is never partially
   * migrated, so no reader can meet a half-converted archive.
   */
  | { ok: false; reason: string };

export abstract class CaptureArchiveMigrator {
  /** Source schema of this hop. */
  abstract readonly from: number;
  /** Target schema of this hop; the engine stamps it on the result. */
  abstract readonly to: number;

  /**
   * Plan the file before the first `migrate()` call of THIS hop. Optional: a
   * purely line-local step omits it. Called on a fresh instance per file,
   * once per hop, with the file in the shape this hop is about to rewrite.
   */
  begin?(plan: CaptureMigratorFilePlan): void;

  /**
   * Migrate ONE line from `from` to `to`. Payload fields only — the engine
   * stamps the new `schema` (and the `migratedFrom` provenance) itself, so a
   * step cannot forget or forge either.
   */
  abstract migrate(
    line: Record<string, unknown>,
    ctx: CaptureMigratorLineContext,
  ): CaptureMigratorVerdict;
}

/**
 * A registered step is a FACTORY, not an instance: the engine builds a fresh
 * chain per file, so per-file state (see `begin`) is never shared between two
 * archives or two concurrent passes.
 */
export type CaptureMigratorFactory = () => CaptureArchiveMigrator;

/**
 * Schema 1 shipped before the archive stamped its own version — every
 * schema-1 line simply has no `schema` field. The MIGRATION ENGINE reads an
 * unmarked line as version 1; readers still reject it (ADR-0024).
 */
export const LEGACY_UNMARKED_SCHEMA = 1;

export type CaptureLineMigration =
  | { ok: true; line: Record<string, unknown> }
  | { ok: false; reason: string };

export type CaptureFileMigrationResult =
  /** Every line already at the target — nothing written. */
  | { status: 'untouched'; unreadable?: number }
  /** Rewritten atomically; `lines` rows moved up the chain. */
  | { status: 'migrated'; lines: number; unreadable: number }
  /** Recently modified (an active append target) — left for a later pass. */
  | { status: 'hot' }
  /** Left exactly as it was: a line could not be migrated or trusted. */
  | { status: 'rejected'; reason: string };

export interface CaptureRootMigrationSummary {
  /** Files rewritten atomically. */
  files: number;
  /** Lines moved up the chain across those files. */
  lines: number;
  /** Active append targets skipped this pass. */
  hot: number;
  /** Files left in place (unmigratable line or I/O error). */
  rejected: number;
  /**
   * Lines carried over byte-for-byte because they are not parseable JSON.
   * Reported, never hidden: this is the only data a pass cannot recover.
   */
  unreadable: number;
}

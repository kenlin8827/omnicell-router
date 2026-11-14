/**
 * Capture archive schema evolution (ADR-0008 section 5, ADR-0024 section 8).
 *
 * - `migrator.ts` — the step contract (`CaptureArchiveMigrator`: `from`,
 *   `to`, optional `begin()` planning, `migrate()` per line) and the shared
 *   result types.
 * - `engine.ts` — chain walk, whole-file discipline, atomic rewrite.
 * - `registry.ts` — the ordered chain, resolved hop by hop by `(from, to)`.
 * - `steps/v1-to-v2.ts` — the one real hop shipped today.
 *
 * There is no side channel and no parking lot: a migration pass is the ONLY
 * way old data evolves, and it must leave every line it can read in a shape
 * the current reader accepts. Nothing is ever moved out of the live root.
 */
export * from './migrator.js';
export * from './registry.js';
export * from './engine.js';
export * from './steps/v1-to-v2.js';

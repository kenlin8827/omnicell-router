import type { CaptureMigratorFactory } from './migrator.js';
import { V1ToV2Migrate } from './steps/v1-to-v2.js';

/**
 * The ordered migration chain for the live `capture/` root — the same
 * one-shot, no-compat-branch ladder `traces.db` follows with `DB_VERSION`
 * (ADR-0008 section 5, ADR-0024 section 8).
 *
 * ONE STEP, ONE FILE: each hop is a class in its own file under `steps/`
 * (`steps/v2-to-v3.ts` exports `V2ToV3Migrate`), registered here in order.
 * The engine (`engine.ts`) resolves a hop by `(from, to)` and refuses any
 * gap or skip — a missing step is an error, never a best-effort guess.
 *
 * Registered as FACTORIES: the engine builds a fresh chain per file, so a
 * step's per-file planning state (`begin`) is never shared between archives
 * or between two concurrent passes.
 */
export const CAPTURE_MIGRATORS: readonly CaptureMigratorFactory[] = [
  () => new V1ToV2Migrate(),
  // () => new V2ToV3Migrate(),  <- register in order when schema 3 lands
];

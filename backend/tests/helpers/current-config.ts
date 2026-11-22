import { SCHEMA_VERSION } from '../../src/config/schema.js';

/**
 * Force a test config body onto the CURRENT schema version.
 *
 * `loadConfig()` accepts exactly one `schemaVersion` (ADR-0016) and silently
 * loads built-in defaults for anything else — no migration, no warning beyond
 * one line. A fixture that pins a retired number therefore turns its whole
 * assertion set into "defaults win", which surfaces as unrelated-looking red
 * tests after a schema bump. Fixtures keep their readable `schemaVersion:`
 * header; the writer rewrites it, so a bump never needs a fixture sweep.
 */
export function currentYaml(body: string): string {
  return /^schemaVersion: \d+$/m.test(body)
    ? body.replace(/^schemaVersion: \d+$/m, `schemaVersion: ${SCHEMA_VERSION}`)
    : `schemaVersion: ${SCHEMA_VERSION}\n${body}`;
}

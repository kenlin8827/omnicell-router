/**
 * JSON-document schema hop for OCR-owned books (providers.json, overrides.json).
 * Same doctrine as capture migrate: one class per (from → to), rewrite atomically
 * at boot; after the hop the on-disk schema is clean (ADR-0010).
 */

export interface JsonDocumentMigrator {
  readonly from: number;
  readonly to: number;
  /** Transform the parsed document. Must not leave retired protocol-slot keys. */
  migrate(doc: Record<string, unknown>): Record<string, unknown>;
}

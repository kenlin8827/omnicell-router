import fs from 'node:fs';
import { hashFile, hashTree } from '../hash.js';
import type { CopyRecord } from '../types.js';

/**
 * Content drift for one recorded copy — the SINGLE read-side algorithm table (ADR-0015 §D8).
 *
 * The fingerprint algorithm must match the one the WRITER recorded with, and that depends on the
 * copy's SHAPE, not on a convention:
 *  - a skill copy is a directory → `hashTree`;
 *  - a config copy (MCP server entry, opencode `plugin[]`) is a single FILE → `hashFile`.
 *
 * `hashTree` on a file path walks nothing and returns the empty-tree digest (`e3b0c442…`, 0 files),
 * so using it uniformly marks EVERY config copy dirty — both in the inventory (`dirty`) and in the
 * removal plan (a `discardLocalEdits` prompt for a file nobody edited). That is a state lie, which
 * is precisely what `placement`/`state` exist to avoid.
 *
 * Both readers (`planRemove`, `inventory.copyState`) call this, so they cannot drift apart. Callers
 * must not call it for an `external` copy: that `path` is an identity token, not a location.
 *
 * Throws when `abs` cannot be stat'ed (gone, or not a readable path) — each caller maps that to its
 * own honest answer (`missing` in the inventory, `dirty` in a removal plan).
 */
export function copyDrift(copy: CopyRecord, abs: string): boolean {
  const recorded = copy.contentHash;
  return fs.statSync(abs).isFile() ? hashFile(abs) !== recorded : hashTree(abs).hash !== recorded;
}

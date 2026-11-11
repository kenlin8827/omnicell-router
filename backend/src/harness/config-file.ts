import fs from 'node:fs';
import { createBackup, safeWriteJson } from '../cli/clients/base.js';

/**
 * Read/write one runtime config file with the house safety contract (ADR-0015 §D5, gate 2).
 *
 * Shared by the two write paths that MUTATE an existing config member — the plugin writer's
 * `plugin[]` merge and removal's `drop-entry` / `drop-server` ops — so a member is removed with
 * exactly the discipline that added it: parse plain JSON only (a JSONC file would lose its comments
 * in a round-trip), snapshot with `createBackup` (`.bak.ocr`), then an atomic rename.
 *
 * The merge paths that may also CREATE a file (`writers/mcp.ts`) keep their own reader: their
 * contract answers `{}` for an absent file, which is the wrong answer for a removal.
 */

export type ConfigRead =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; reason: string };

export function readConfigJson(file: string): ConfigRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, reason: `cannot read config: ${e instanceof Error ? e.message : e}` };
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'config root is not a JSON object' };
    }
    return { ok: true, config: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'config is not valid plain JSON; refusing a lossy rewrite' };
  }
}

/**
 * Snapshot then atomically write. A failure leaves the original file untouched: `createBackup` runs
 * first, `safeWriteJson` renames only after a complete write.
 */
export function writeConfigJson(file: string, config: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  try {
    createBackup(file);
    safeWriteJson(file, config);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Resolve a dot-path container inside a parsed config (`dsh.profile.bundles`, `mcp.servers`).
 * Returns the leaf value when every intermediate segment is a plain object; a scalar, an array or
 * an absent segment answers undefined. Flat keys contain no dot, so their resolution is unchanged.
 */
export function valueAtPath(config: Record<string, unknown>, path: string): unknown {
  let node: unknown = config;
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** The ARRAY at a dot-path container, or undefined when the leaf is absent/not an array. */
export function arrayAtPath(config: Record<string, unknown>, path: string): unknown[] | undefined {
  const leaf = valueAtPath(config, path);
  return Array.isArray(leaf) ? leaf : undefined;
}

/**
 * Replace the array at a dot-path container. Every intermediate segment must already be a plain
 * object — this never creates a path (a removal edits what the runtime wrote).
 */
export function setArrayAtPath(
  config: Record<string, unknown>,
  path: string,
  next: unknown[]
): boolean {
  const parts = path.split('.');
  let node: Record<string, unknown> = config;
  for (const part of parts.slice(0, -1)) {
    const child = node[part];
    if (!child || typeof child !== 'object' || Array.isArray(child)) return false;
    node = child as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1]!;
  if (!Array.isArray(node[leaf])) return false;
  node[leaf] = next;
  return true;
}

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { validatePluginManifest } from './manifest.js';
import type { PluginManifest } from './types.js';

/**
 * Staging the APP-OWNED package tier (`<ocrHome>/plugins/bundled`).
 *
 * Plugins are OPTIONAL and are NEVER distributed (ADR-0032): no release artifact
 * — installer, portable exe, npm tarball — carries a package zip, so nothing is
 * seeded on a normal install and a fresh OCR home has an empty `bundled/`.
 *
 * The tier itself still exists, with unchanged semantics (ADR-0017): a package
 * placed there is app-owned, wins precedence over an operator install, cannot be
 * shadowed by an upload, and is tombstoned (not deleted) on uninstall.
 *
 * Staging runs ONLY when `OCR_BUNDLED_PLUGIN_SRC` names a directory explicitly —
 * tests that exercise the tier, and an operator/downstream build that deliberately
 * hands the app a package set. There is NO default source: promoting whatever
 * happens to sit in a checkout's `.plugin-dist/` would make a source run silently
 * app-owned, which is exactly the state an optional plugin must never enter by
 * accident.
 *
 * Rules this module holds to:
 *  - BYTES are the version: an identical file is left untouched, so the
 *    package mtime (and therefore `ensureUnpacked`'s stamp) does not change on
 *    every boot and plugins are not re-extracted for nothing.
 *  - ONE copy per id inside `bundled/`: a renamed artifact must not leave the
 *    previous file claiming the same id — file names sort, so the loser would
 *    be picked deterministically-but-wrongly.
 *  - A package whose manifest does not validate is NOT seeded. A half-written
 *    artifact would otherwise become a broken app-owned package that shadows a
 *    working operator install.
 *  - Tombstones are untouched: `disabled.json` is the operator's ledger, and a
 *    re-seeded package stays disabled until they say otherwise.
 */

/** Where an explicitly staged package set lives, or undefined when there is
 *  nothing to stage — which is the NORMAL case: no release ships packages
 *  (ADR-0032), so a default source does not exist.
 *
 *  `OCR_BUNDLED_PLUGIN_SRC` is the only way in: tests point it at their own
 *  artifacts, and a downstream build that deliberately wants app-owned packages
 *  can too. A dev tree disables staging outright: `OCR_PLUGIN_SRC_DIR` means the
 *  operator is EDITING sources, and copying a packaged set over the tree under
 *  edit is the one thing that must never happen. */
export function bundledPluginSourceDir(): string | undefined {
  if (process.env.OCR_PLUGIN_SRC_DIR?.trim()) return undefined;
  const explicit = process.env.OCR_BUNDLED_PLUGIN_SRC?.trim();
  return explicit ? resolve(explicit) : undefined;
}

function readManifestFromBytes(bytes: Uint8Array): PluginManifest {
  const files = unzipSync(bytes);
  const raw = files['plugin.json'];
  if (!raw) throw new Error('package root lacks plugin.json');
  const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
  validatePluginManifest(parsed, 'invalid plugin.json');
  return parsed as PluginManifest;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export interface SeedResult {
  /** Manifest ids written this pass (new, or a different version than on disk). */
  seeded: string[];
  /** Packages already present byte-for-byte. */
  unchanged: number;
  /** Where the artifacts came from, when seeding was attempted. */
  source?: string;
}

/** Copy the explicitly staged artifacts into the app-owned tier. Idempotent:
 *  safe to run on every plugin-host rebuild (boot, install, enable/disable).
 *  A no-op — the normal case — when `bundledPluginSourceDir()` returns nothing. */
export function seedBundledPlugins(bundledDir: string): SeedResult {
  const source = bundledPluginSourceDir();
  const result: SeedResult = { seeded: [], unchanged: 0, source };
  if (!source || !existsSync(source)) return result;
  let names: string[];
  try {
    names = readdirSync(source).filter((n) => /\.zip$/i.test(n)).sort();
  } catch {
    return result;
  }
  if (names.length === 0) return result;
  mkdirSync(bundledDir, { recursive: true });
  for (const name of names) {
    let bytes: Uint8Array;
    let manifest: PluginManifest;
    try {
      bytes = new Uint8Array(readFileSync(join(source, name)));
      manifest = readManifestFromBytes(bytes);
    } catch (err) {
      // A build artifact that does not parse is a packaging bug, not operator
      // state: say so and move on rather than making the tier un-loadable.
      console.warn(`[OCR] plugins: not seeding ${name} — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const dest = join(bundledDir, name);
    if (existsSync(dest)) {
      try {
        if (sameBytes(new Uint8Array(readFileSync(dest)), bytes)) {
          result.unchanged += 1;
          continue;
        }
      } catch {
        // unreadable destination: overwrite it below
      }
    }
    writeFileSync(dest, bytes);
    // Drop every OTHER file in the app-owned root claiming this id (a renamed
    // artifact from a previous release). Discovery sorts by file name, so a
    // leftover copy would win or lose by accident.
    try {
      for (const other of readdirSync(bundledDir).filter((n) => /\.zip$/i.test(n))) {
        if (other === name) continue;
        const otherPath = join(bundledDir, other);
        try {
          if (readManifestFromBytes(new Uint8Array(readFileSync(otherPath))).id === manifest.id) {
            rmSync(otherPath, { force: true });
          }
        } catch {
          // unreadable sibling: not ours to judge
        }
      }
    } catch {
      // readdir raced a concurrent seed — the caller reloads anyway
    }
    result.seeded.push(manifest.id);
  }
  return result;
}

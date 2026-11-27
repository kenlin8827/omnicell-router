/**
 * Run registered JSON-document hops on an OCR-owned book until currentVersion.
 * Whole-file discipline: parse → hop chain → atomic temp+rename.
 */

import fs from 'node:fs';
import path from 'node:path';
import { renameWithRetry } from '../../utils/atomic-write.js';
import type { JsonDocumentMigrator } from './migrator.js';
import { ProvidersV1ToV2Migrate } from './steps/providers-v1-to-v2.js';
import { OverridesV1ToV2Migrate } from './steps/overrides-v1-to-v2.js';

export const PROVIDERS_SCHEMA = 2;
export const OVERRIDES_SCHEMA = 2;

const PROVIDERS_STEPS: JsonDocumentMigrator[] = [new ProvidersV1ToV2Migrate()];
const OVERRIDES_STEPS: JsonDocumentMigrator[] = [new OverridesV1ToV2Migrate()];

function stepFor(steps: JsonDocumentMigrator[], from: number): JsonDocumentMigrator | undefined {
  return steps.find((s) => s.from === from && s.to === from + 1);
}

function migrateDoc(
  doc: Record<string, unknown>,
  steps: JsonDocumentMigrator[],
  currentVersion: number,
): Record<string, unknown> {
  let version = typeof doc.version === 'number' ? doc.version : 0;
  let next = doc;
  while (version < currentVersion) {
    const step = stepFor(steps, version);
    if (!step) {
      throw new Error(`no migrator registered for schema ${version} -> ${version + 1}`);
    }
    next = step.migrate(next);
    version = step.to;
  }
  return next;
}

function rewriteFile(
  filePath: string,
  steps: JsonDocumentMigrator[],
  currentVersion: number,
): { migrated: boolean; from?: number } {
  if (!fs.existsSync(filePath)) return { migrated: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { migrated: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { migrated: false };
  const doc = parsed as Record<string, unknown>;
  const from = typeof doc.version === 'number' ? doc.version : 0;
  if (from === currentVersion) return { migrated: false, from };
  if (from > currentVersion) {
    throw new Error(`${filePath}: unsupported future schema version ${from} (current ${currentVersion})`);
  }
  const next = migrateDoc(doc, steps, currentVersion);
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.migrate.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameWithRetry(tmp, filePath);
  return { migrated: true, from };
}

/** Boot: rewrite providers.json through the hop chain to PROVIDERS_SCHEMA. */
export function migrateProvidersFile(filePath: string): { migrated: boolean; from?: number } {
  return rewriteFile(filePath, PROVIDERS_STEPS, PROVIDERS_SCHEMA);
}

/** Boot: rewrite overrides.json through the hop chain to OVERRIDES_SCHEMA. */
export function migrateOverridesFile(filePath: string): { migrated: boolean; from?: number } {
  return rewriteFile(filePath, OVERRIDES_STEPS, OVERRIDES_SCHEMA);
}

/** Test helper: run providers hops in memory. */
export function migrateProvidersDoc(doc: Record<string, unknown>): Record<string, unknown> {
  return migrateDoc(doc, PROVIDERS_STEPS, PROVIDERS_SCHEMA);
}

/** Test helper: run overrides hops in memory. */
export function migrateOverridesDoc(doc: Record<string, unknown>): Record<string, unknown> {
  return migrateDoc(doc, OVERRIDES_STEPS, OVERRIDES_SCHEMA);
}

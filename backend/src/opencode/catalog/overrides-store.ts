import fs from 'node:fs';
import path from 'node:path';
import type { CatalogCost, CatalogLimit, CatalogModalities, CatalogTier } from './types.js';
import { getOcrStorePath } from './ocr-store.js';

/**
 * Aggregate override store (~/.opencode-router/catalog/overrides.json).
 *
 * Field-level overrides applied LAST on the aggregated catalog (ocr.json) —
 * this is the landing spot for edits made in the OCR Catalog viewer, which
 * targets the AGGREGATION (not opencode.jsonc definitions, not custom.json).
 * Key is `${providerId}||${modelId}` (model ids may contain '/').
 */

export interface OverrideEntry {
  name?: string;
  cost?: CatalogCost;
  limit?: CatalogLimit;
  modalities?: CatalogModalities;
  tool_call?: boolean;
  reasoning?: boolean;
  /**
   * Explicit OCR tier assignment. `null` in an upsert payload = clear the
   * key (fall back to the boot heuristic); absent = keep the stored value.
   */
  tier?: CatalogTier | null;
}

export interface OverrideStore {
  version: 1;
  updated: number;
  models: Record<string, OverrideEntry>;
}

export const overrideKey = (providerId: string, modelId: string): string => `${providerId}||${modelId}`;

export function getOverridesStorePath(): string {
  return path.join(path.dirname(getOcrStorePath()), 'overrides.json');
}

export function readOverridesStore(): OverrideStore | null {
  try {
    const file = getOverridesStorePath();
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as OverrideStore;
    if (parsed?.version !== 1 || typeof parsed.models !== 'object' || parsed.models === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getOverride(providerId: string, modelId: string): OverrideEntry | undefined {
  return readOverridesStore()?.models[overrideKey(providerId, modelId)];
}

function persist(store: OverrideStore): void {
  const file = getOverridesStorePath();
  store.updated = Date.now();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
  fs.renameSync(tmp, file);
}

export function upsertOverride(providerId: string, modelId: string, entry: OverrideEntry): { success: boolean; error?: string } {
  try {
    const store: OverrideStore = readOverridesStore() ?? { version: 1, updated: 0, models: {} };
    const merged: OverrideEntry = { ...(store.models[overrideKey(providerId, modelId)] ?? {}) };
    if (entry.name !== undefined) merged.name = entry.name;
    if (entry.cost) merged.cost = { ...(merged.cost ?? {}), ...entry.cost };
    if (entry.limit) merged.limit = { ...(merged.limit ?? {}), ...entry.limit };
    if (entry.modalities) merged.modalities = entry.modalities;
    if (entry.tool_call !== undefined) merged.tool_call = entry.tool_call;
    if (entry.reasoning !== undefined) merged.reasoning = entry.reasoning;
    if (entry.tier !== undefined) {
      if (entry.tier === null) delete merged.tier;
      else merged.tier = entry.tier;
    }
    store.models[overrideKey(providerId, modelId)] = merged;
    persist(store);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
}

export function removeOverride(providerId: string, modelId: string): { success: boolean; error?: string } {
  try {
    const store = readOverridesStore();
    const key = overrideKey(providerId, modelId);
    if (!store?.models[key]) return { success: false, error: 'no override for this model' };
    delete store.models[key];
    persist(store);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
}

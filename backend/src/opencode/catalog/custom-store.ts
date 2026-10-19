import fs from 'node:fs';
import path from 'node:path';
import type { CatalogModel } from './types.js';
import { getOcrStorePath } from './ocr-store.js';
import { matchesGlobPattern } from '../user-config.js';

/**
 * Custom-pull store (~/.onecast-router/catalog/custom.json).
 *
 * Models pulled for CREDENTIAL-ONLY providers (auth.json entry without an
 * defs-file definition) — they have no defs node to write into, so the
 * pulled lists land here and feed the aggregation as the 'custom' source
 * (after config defs, entry-creating like the baseline). Merge is add-only:
 * a model id already present for a provider is never overwritten.
 */

export interface CustomProviderEntry {
  name?: string;
  npm?: string;
  api?: string;
  models: CatalogModel[];
}

export interface CustomModelStore {
  version: 1;
  updated: number;
  providers: Record<string, CustomProviderEntry>;
}

export function getCustomStorePath(): string {
  return path.join(path.dirname(getOcrStorePath()), 'custom.json');
}

export function readCustomStore(): CustomModelStore | null {
  try {
    const file = getCustomStorePath();
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as CustomModelStore;
    if (parsed?.version !== 1 || typeof parsed.providers !== 'object' || parsed.providers === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Merge (add-only) one provider's pulled models into the store. */
export function upsertCustomProviderModels(
  providerId: string,
  meta: { name?: string; npm?: string; api?: string },
  models: CatalogModel[],
): number {
  try {
    const file = getCustomStorePath();
    const store: CustomModelStore = readCustomStore() ?? { version: 1, updated: 0, providers: {} };
    const entry: CustomProviderEntry = store.providers[providerId] ?? { models: [] };
    if (meta.name && !entry.name) entry.name = meta.name;
    if (meta.npm && !entry.npm) entry.npm = meta.npm;
    if (meta.api && !entry.api) entry.api = meta.api;
    const byId = new Map(entry.models.map((m) => [m.id, m]));
    let added = 0;
    for (const m of models) {
      if (byId.has(m.id)) continue; // add-only
      byId.set(m.id, m);
      added++;
    }
    entry.models = [...byId.values()];
    store.providers[providerId] = entry;
    store.updated = Date.now();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, file);
    return added;
  } catch {
    return 0;
  }
}

export function removeCustomProvider(providerId: string): void {
  try {
    const store = readCustomStore();
    if (!store?.providers[providerId]) return;
    delete store.providers[providerId];
    store.updated = Date.now();
    const file = getCustomStorePath();
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // best effort
  }
}

export function getCustomProviderModels(providerId: string): CatalogModel[] {
  return readCustomStore()?.providers[providerId]?.models ?? [];
}

export function upsertCustomModel(providerId: string, model: CatalogModel): { success: boolean; error?: string } {
  try {
    const file = getCustomStorePath();
    const store: CustomModelStore = readCustomStore() ?? { version: 1, updated: 0, providers: {} };
    const entry: CustomProviderEntry = store.providers[providerId] ?? { models: [] };
    const byId = new Map(entry.models.map((m) => [m.id, m]));
    byId.set(model.id, model);
    entry.models = [...byId.values()];
    store.providers[providerId] = entry;
    store.updated = Date.now();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, file);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
}

/**
 * Clear models from a provider's custom-store entry — mirrors clearProviderModels
 * semantics (no pattern → all, pattern → glob matches). Fails when the provider
 * has no custom-store entry at all (same 404 signal as an unknown jsonc node),
 * but succeeds with removed: 0 when the entry exists and nothing matches.
 */
export function clearCustomModels(
  providerId: string,
  pattern?: string,
): { success: boolean; removed?: number; error?: string } {
  try {
    const store = readCustomStore();
    const entry = store?.providers[providerId];
    if (!store || !entry) {
      return { success: false, error: `Provider '${providerId}' has no models in the custom store` };
    }
    const trimmed = pattern?.trim();
    const keep = trimmed ? entry.models.filter((m) => !matchesGlobPattern(trimmed, m.id)) : [];
    const removed = entry.models.length - keep.length;
    if (removed === 0) return { success: true, removed: 0 };
    entry.models = keep;
    store.updated = Date.now();
    const file = getCustomStorePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, file);
    return { success: true, removed };
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
}

export function removeCustomModel(providerId: string, modelId: string): { success: boolean; error?: string } {
  try {
    const store = readCustomStore();
    const entry = store?.providers[providerId];
    if (!entry || !entry.models.some((m) => m.id === modelId)) {
      return { success: false, error: `Model '${modelId}' not found in the custom store` };
    }
    entry.models = entry.models.filter((m) => m.id !== modelId);
    store!.providers[providerId] = entry;
    store!.updated = Date.now();
    const file = getCustomStorePath();
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, file);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
}

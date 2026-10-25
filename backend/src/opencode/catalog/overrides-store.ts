import fs from 'node:fs';
import path from 'node:path';
import type { CatalogCost, CatalogLimit, CatalogModalities } from './types.js';
import { getOcrStorePath } from './ocr-store.js';
import type { ReasoningEffort } from '../../types/router.js';
import { renameWithRetry } from '../../utils/atomic-write.js';

/**
 * Aggregate override store (~/.omnicell-router/catalog/overrides.json).
 *
 * Field-level overrides applied LAST on the aggregated catalog (ocr.json) —
 * this is the landing spot for edits made in the OCR Catalog viewer, which
 * targets the AGGREGATION (not the defs-file nodes themselves).
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
   * Hidden from CLIENT-facing catalogs (`/v1/models`, `/v1/catalog.json`): the
   * model stays in the aggregate (the console catalog viewer and /models still
   * list it so it can be unhidden) but boot-direct keeps it out of the routing
   * pool, so no client request can be pinned to it. Written by the overrides
   * layer (`OverrideEntry.disabled`) and, for hand-written configs, carried
   * over from a def-level `disabled` flag.
   */
  disabled?: boolean;
  /** Manual correction of the tri-state sampling-parameter capability flag (real behavior of a reseller's custom models, which catalog sources cannot cover). */
  temperature?: boolean;
  /**
   * Tri-state developer-role capability override (`true` = the upstream
   * accepts OpenAI `developer` messages — passthrough verbatim; undefined /
   * false = the openai wire rewrites `developer` → `system`). No catalog
   * source publishes role support, so this is override-only.
   */
  supportsDeveloperRole?: boolean;
  /**
   * Explicit thinking-level list (subset of EFFORT_LADDER). Materialized at
   * aggregation into `reasoningOptions=[{type:'effort',values}]` (empty array
   * → `[{type:'toggle'}]` = no explicit level control), which boot-direct's
   * effortLadderFor resolves into supportedReasoningEfforts.
   */
  reasoningEfforts?: ReasoningEffort[];
  /** Model-default thinking level; `null` clears the override (follow the catalog/def). */
  defaultEffort?: ReasoningEffort | null;
  /** Model-level AI-SDK package override — decides the wire protocol (boot-direct wire resolution). */
  npm?: string;
  /** Named thinking-level variants (UI short shape `{id, effort}` — materialized to the def shape at aggregation). */
  variants?: { id: string; effort: string }[];
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
  renameWithRetry(tmp, file);
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
    if (entry.temperature !== undefined) merged.temperature = entry.temperature;
    if (entry.supportsDeveloperRole !== undefined) merged.supportsDeveloperRole = entry.supportsDeveloperRole;
    if (entry.disabled !== undefined) merged.disabled = entry.disabled;
    if (entry.reasoningEfforts !== undefined) merged.reasoningEfforts = entry.reasoningEfforts;
    if (entry.npm !== undefined) merged.npm = entry.npm;
    if (entry.defaultEffort !== undefined) {
      if (entry.defaultEffort === null) delete merged.defaultEffort;
      else merged.defaultEffort = entry.defaultEffort;
    }
    if (entry.variants !== undefined) merged.variants = entry.variants;
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

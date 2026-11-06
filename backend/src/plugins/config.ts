import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { PluginConfigField } from './types.js';
import { pluginsRoot } from './host.js';

/**
 * Plugin-level operator configuration (ADR-0017).
 *
 * Three sources, strictly separated:
 * - `plugin.json` `configSchema` DECLARES the fields (flat primitives only —
 *   the console renders the settings form generically from this; no JSON
 *   Schema engine, that would invite arbitrary UI complexity into the
 *   plugin protocol).
 * - `<pluginsRoot()>/config/<id>.json` STORES operator-set values. Plugin
 *   parameters never touch config.yaml (ADR-0016: that schema is frozen —
 *   plugin lifecycle state lives with the plugin artifacts, like
 *   registrations.json / disabled.json).
 * - the host MERGES (defaults ← stored, validated per field; unknown keys
 *   dropped, wrong-typed keys fall back to default with a warning) and hands
 *   the result to the plugin via its host SDK `config()`.
 *
 * The merged result is cached per plugin id; the cache is invalidated on
 * every plugin reload (so hand-edited artifacts are picked up) and updated
 * on console writes (which also fire the plugin's optional onConfigChange).
 */

export type PluginConfigValues = Record<string, unknown>;

const configCache = new Map<string, PluginConfigValues>();

export function pluginConfigPath(id: string): string {
  return path.join(pluginsRoot(), 'config', `${id}.json`);
}

/** Raw stored values; a corrupt artifact degrades to empty (never throws). */
export function readStoredConfig(id: string): PluginConfigValues {
  try {
    const raw = JSON.parse(readFileSync(pluginConfigPath(id), 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as PluginConfigValues) : {};
  } catch {
    return {};
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Merge defaults ← stored, validated field-by-field. Unknown keys are
 *  dropped; a wrong-typed value falls back to the field default with a
 *  warning — a bad artifact must never crash a plugin load. */
export function validatePluginConfig(
  schema: PluginConfigField[] | undefined,
  stored: PluginConfigValues
): { values: PluginConfigValues; warnings: string[] } {
  const warnings: string[] = [];
  const values: PluginConfigValues = {};
  if (!schema?.length) {
    // No declared fields: nothing is configurable, so stored junk never
    // reaches the plugin through config().
    if (Object.keys(stored).length > 0) warnings.push('config: plugin declares no configurable fields — stored values ignored');
    return { values, warnings };
  }
  const known = new Set(schema.map((f) => f.key));
  for (const key of Object.keys(stored)) {
    if (!known.has(key)) warnings.push(`config: unknown key '${key}' dropped`);
  }
  for (const field of schema) {
    const has = stored[field.key] !== undefined;
    const v = stored[field.key];
    let ok = false;
    switch (field.type) {
      case 'string':
        ok = has && typeof v === 'string' && v.length > 0;
        break;
      case 'number': {
        ok = has && typeof v === 'number' && Number.isFinite(v) && (field.min === undefined || v >= field.min) && (field.max === undefined || v <= field.max);
        break;
      }
      case 'boolean':
        ok = has && typeof v === 'boolean';
        break;
      case 'string[]':
        ok = has && isStringArray(v);
        break;
      case 'enum':
        ok = has && typeof v === 'string' && !!field.values?.includes(v);
        break;
    }
    if (ok) {
      values[field.key] = v;
    } else {
      if (has) warnings.push(`config: '${field.key}' failed ${field.type} validation — using default`);
      values[field.key] = field.default !== undefined ? field.default : field.type === 'boolean' ? false : field.type === 'number' ? 0 : field.type === 'string[]' ? [] : field.type === 'enum' ? (field.values?.[0] ?? '') : '';
    }
  }
  return { values, warnings };
}

/** Merged config for one plugin (cached; invalidatePluginConfigCache clears). */
export function mergedPluginConfig(id: string, schema: PluginConfigField[] | undefined): PluginConfigValues {
  const cached = configCache.get(id);
  if (cached) return cached;
  const { values } = validatePluginConfig(schema, readStoredConfig(id));
  configCache.set(id, values);
  return values;
}

/** Validate + persist operator values; returns the merged result. */
export function writePluginConfig(
  id: string,
  schema: PluginConfigField[] | undefined,
  values: PluginConfigValues
): { values: PluginConfigValues; warnings: string[] } {
  const result = validatePluginConfig(schema, values);
  const file = pluginConfigPath(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Store ONLY the operator's effective keys (post-validation) — defaults stay in
  // the manifest, never duplicated into the artifact.
  const stored: PluginConfigValues = {};
  for (const field of schema ?? []) {
    const v = result.values[field.key];
    if (v === undefined) continue;
    // Reference compare works for primitives; arrays need a deep compare or
    // a default-equal string[] is always persisted, duplicating the manifest.
    if (Array.isArray(field.default) ? JSON.stringify(v) === JSON.stringify(field.default) : v === field.default) continue;
    stored[field.key] = v;
  }
  fs.writeFileSync(file, JSON.stringify(stored, null, 2) + '\n', 'utf8');
  configCache.set(id, result.values);
  return result;
}

/** Forget cached merges (plugin reload re-reads artifacts). */
export function invalidatePluginConfigCache(id?: string): void {
  if (id) configCache.delete(id);
  else configCache.clear();
}

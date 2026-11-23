import type { PluginConfigFieldInfo, PluginConfigSectionInfo } from './api';
import { EFFORT_LADDER } from './effort';
import { LANG_TO_BCP47 } from '../i18n/languages';

/**
 * Rendering semantics for a plugin's operator-facing `configSchema` (ADR-0017
 * §7). The console renders that schema generically — it has no idea what a
 * `previewBytes` or a `modelMode` means — so the only rules that live here are
 * the ones the protocol carries:
 *
 * - `title` / `desc` / `enumLabels` are locale texts (plain string or BCP-47
 *   keyed map), resolved against the active UI language;
 * - `visibleWhen` is a DISPLAY predicate. It never touches the value: a hidden
 *   field still holds its draft entry and is still validated + merged on save,
 *   so switching a mode back never discards what the operator entered;
 * - `configSections` groups fields under declared headings (grouping only —
 *   never layout, never tabs).
 */

/**
 * Pick a localized title/desc/enum label. Same fallback chain as the manifest
 * description column: manifest keys are BCP-47 ('zh-CN'/'en-US') while the UI
 * Lang is the short code ('zh'/'en'), so translate first, then fall back
 * en-US/en, then the first available locale.
 */
export function pickLocaleText(text: string | Record<string, string> | undefined, lang: string): string | undefined {
  if (!text) return undefined;
  if (typeof text === 'string') return text;
  const key = LANG_TO_BCP47[lang as keyof typeof LANG_TO_BCP47];
  return text[key] ?? text['en-US'] ?? text['en'] ?? Object.values(text)[0];
}

/** Draft values as the console holds them: enum/string/number as raw text,
 *  booleans as booleans. Only boolean and enum values are ever compared here. */
export type PluginConfigDraft = Record<string, string | boolean>;

/** Does this field match an expected condition value? Booleans compare as
 *  booleans; enum/draft strings compare as text (the draft keeps enum values
 *  verbatim, so no coercion surprises). */
const matches = (actual: string | boolean | undefined, expected: string | boolean): boolean =>
  typeof expected === 'boolean' ? actual === expected : String(actual ?? '') === expected;

/**
 * Should the console render this field right now? `visibleWhen` is a single
 * sibling condition (`equals` or `in`) — deliberately not an expression: the
 * protocol carries no evaluation, and the backend rejects references it cannot
 * resolve (unknown field, non-discrete target, cyclic chains).
 */
export function isFieldVisible(field: PluginConfigFieldInfo, draft: PluginConfigDraft): boolean {
  const when = field.visibleWhen;
  if (!when) return true;
  const actual = draft[when.key];
  if (when.in) return when.in.some((expected) => matches(actual, expected));
  return when.equals !== undefined && matches(actual, when.equals);
}

/** One rendered block of the settings form. `id: null` is the leading ungrouped
 *  block (fields that name no section). Heading text is returned UNRESOLVED so
 *  the caller localizes it with its own active language. */
export interface PluginConfigGroup {
  id: string | null;
  title?: string | Record<string, string>;
  advanced: boolean;
  fields: PluginConfigFieldInfo[];
}

/**
 * The fields a plugin settings drawer renders for the current view.
 *
 * `mode: 'quick'` is a DISPLAY subset (`essential` only), and it exists only
 * when the schema marks something essential: a plugin that marks none has one
 * view, and must render ALL its drawer fields. Filtering by `essential` anyway
 * is what emptied the drawer for every gateway plugin (none declare it) — the
 * operator saw a Save button and no settings at all.
 *
 * Placement is the manifest's call: `card` fields belong to the Client Hub card
 * and `none` fields are dead config, though the latter is the backend's audit's
 * business, not the renderer's; the `apiKey` control is card state by contract
 * and is never repeated here.
 */
export function drawerFields(
  schema: PluginConfigFieldInfo[],
  mode: 'quick' | 'advanced'
): PluginConfigFieldInfo[] {
  const quick = mode === 'quick' && schema.some((field) => field.essential === true);
  return schema
    .filter((field) => (field.placement ?? 'drawer') === 'drawer' && field.control !== 'apiKey')
    .filter((field) => (quick ? field.essential === true : true));
}

/**
 * Bucket the VISIBLE fields into their declared sections, in declaration order.
 *
 * Two rules that keep the form honest:
 * - a section whose every field is hidden right now renders nothing at all — no
 *   empty heading left dangling by a `visibleWhen`;
 * - ungrouped fields come first, so a plugin that declares no sections (or only
 *   groups a tail of "advanced" settings) still reads top-down.
 * A field naming an undeclared section falls back to the ungrouped block (the
 * backend rejects that manifest, so this is belt-and-braces for a stale build).
 */
export function groupVisibleFields(
  schema: PluginConfigFieldInfo[],
  sections: PluginConfigSectionInfo[],
  draft: PluginConfigDraft
): PluginConfigGroup[] {
  const buckets = new Map<string | null, PluginConfigFieldInfo[]>([[null, []]]);
  for (const section of sections) buckets.set(section.id, []);
  for (const field of schema) {
    if (!isFieldVisible(field, draft)) continue;
    const bucket = field.section !== undefined ? buckets.get(field.section) : undefined;
    (bucket ?? (buckets.get(null) as PluginConfigFieldInfo[])).push(field);
  }
  const groups: PluginConfigGroup[] = [];
  const top = buckets.get(null) ?? [];
  if (top.length > 0) groups.push({ id: null, advanced: false, fields: top });
  for (const section of sections) {
    const fields = buckets.get(section.id) ?? [];
    if (fields.length === 0) continue;
    groups.push({ id: section.id, title: section.title, advanced: section.advanced === true, fields });
  }
  return groups;
}

/**
 * The vocabulary one gateway card must speak: the enum value persisted for the
 * UI's "Default" and the schema field holding the picked key's `apiKeys[].id`.
 * Both are DECLARED by the manifest (ADR-0017 §7). The shipped gateways agree
 * on the key field (`accountKeyId`) and on the unset spelling (`default`), but
 * both are per-manifest — a future gateway may name the field or the value
 * anything. Hardcoding either makes a save silently lose the value: the host
 * drops an unknown key and falls back on a failed enum, with a warning.
 */
export interface GatewayVocabulary {
  /** Enum value the UI's "Default" mode persists (the manifest's own unset
   *  spelling, `default` on the shipped gateways) — unrelated to the
   *  console's draft value. */
  unsetMode: string;
  /** Schema field carrying the picked key id; '' = the gateway has no
   *  `apiKey` control and the card persists no binding. */
  keyField: string;
}

export function gatewayVocabulary(schema: PluginConfigFieldInfo[]): GatewayVocabulary {
  const mode = schema.find((field) => field.key === 'modelListMode');
  const key = schema.find((field) => field.control === 'apiKey');
  return {
    // `custom` / `follow` are the two labeled states; the remaining declared
    // value is the gateway's "unset" spelling.
    unsetMode: mode?.values?.find((value) => value !== 'custom' && value !== 'follow') ?? 'default',
    keyField: key?.key ?? '',
  };
}

/** The Client Hub card's model-catalog draft for one gateway. */
export interface GatewayCfgDraft extends GatewayVocabulary {
  model: string;
  forceModel: boolean;
  catalogReplace: boolean;
  /** Namespace the appended OCR entries under `ocr/` (append mode only). */
  catalogPrefix: boolean;
  /** UI-level mode; `gatewayModeValue` maps `default` to the plugin's spelling. */
  modelListMode: 'default' | 'custom' | 'follow';
  models: string[];
  /** `apiKeys[].id` held by the plugin's key field ('' = unbound). */
  boundKeyId: string;
  /** Original values, so a save never drops unrelated plugin settings. */
  values: Record<string, unknown>;
}

/** The gateway-catalog keys the shared card editor renders itself. They are
 *  core gateway vocabulary (same meaning for every gateway and already typed
 *  on `GatewayCfgDraft`), and manifests mark them `card` so the plugin drawer
 *  hides them. Any OTHER `card` field is plugin-declared and rendered by the
 *  card's generic block. */
export const SHARED_GATEWAY_CARD_KEYS: Record<string, true> = {
  model: true,
  forceModel: true,
  modelListMode: true,
  models: true,
  catalogReplace: true,
  catalogPrefix: true,
};

/** Shared card keys that make up the model-LIST editor (mode / snapshot /
 *  replace / prefix). A gateway that declares none of them has no list to
 *  edit — its card must not render the block at all. */
export const GATEWAY_MODEL_LIST_KEYS = ['modelListMode', 'models', 'catalogReplace', 'catalogPrefix'] as const;

/** What the shared catalog editor should draw for one gateway: the list block
 *  and the routing-default row are each DECLARED, never assumed. */
export function gatewayCardShape(schema: PluginConfigFieldInfo[]): { modelList: boolean; routingDefault: boolean } {
  const declared = new Set(schema.map((field) => field.key));
  return {
    modelList: GATEWAY_MODEL_LIST_KEYS.some((key) => declared.has(key)),
    routingDefault: declared.has('model') || declared.has('forceModel'),
  };
}

/** One row of an `aliases` field: a client model id mapped onto the model the
 *  gateway actually serves, optionally at a pinned thinking level. The stored
 *  spelling is `clientId=target[@effort][#label]` (the same string a
 *  hand-written config carries). */
export interface AliasRow {
  clientId: string;
  target: string;
  /** Pinned thinking level ('' = the client's own value passes through). */
  effort: string;
  label: string;
}

export function parseAliasSpec(spec: string): AliasRow | undefined {
  const eq = spec.indexOf('=');
  if (eq <= 0) return undefined;
  const clientId = spec.slice(0, eq).trim();
  const rest = spec.slice(eq + 1);
  const hash = rest.indexOf('#');
  const served = (hash === -1 ? rest : rest.slice(0, hash)).trim();
  const label = hash === -1 ? '' : rest.slice(hash + 1).trim();
  if (!clientId || !served) return undefined;
  // A TRAILING `@<ladder value>` is the level pin; any other `@` belongs to
  // the model id (the gateway's parser applies the same rule).
  let target = served;
  let effort = '';
  const at = served.lastIndexOf('@');
  if (at > 0) {
    const token = served.slice(at + 1).trim().toLowerCase();
    if ((EFFORT_LADDER as readonly string[]).includes(token)) {
      effort = token;
      target = served.slice(0, at).trim();
    }
  }
  if (!target) return undefined;
  return { clientId, target, effort, label };
}

/** Rows from stored specs, dropping entries that could never match. */
export function parseAliasRows(specs: readonly string[]): AliasRow[] {
  return specs.map(parseAliasSpec).filter((row): row is AliasRow => row !== undefined);
}

/** Client model ids a wildcard pattern selects (`*` = any run of characters,
 *  everything else literal, case-insensitive). Used by the alias table's batch
 *  add: `gemini-4*` fills one row per matching id the client reported. */
export function matchAliasPattern(pattern: string, ids: readonly string[]): string[] {
  const text = pattern.trim();
  if (!text) return [];
  const source = text
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const re = new RegExp(`^${source}$`, 'i');
  return ids.filter((id) => re.test(id));
}

/** Stored spec for one edited row; '' for a row that is not yet complete. */
export function formatAliasSpec(row: AliasRow): string {
  const clientId = row.clientId.trim();
  const target = row.target.trim();
  if (!clientId || !target) return '';
  const label = row.label.trim();
  const effort = row.effort.trim();
  const level = effort ? `@${effort}` : '';
  return label ? `${clientId}=${target}${level}#${label}` : `${clientId}=${target}${level}`;
}

export function parseGatewayCfg(
  values: Record<string, unknown>,
  vocabulary: GatewayVocabulary
): GatewayCfgDraft {
  const modelListMode =
    values.modelListMode === 'custom' || values.modelListMode === 'follow'
      ? values.modelListMode
      : 'default';
  const bound = vocabulary.keyField ? values[vocabulary.keyField] : undefined;
  return {
    ...vocabulary,
    model: String(values.model ?? 'auto').replace(/^ocr\//, ''),
    forceModel: values.forceModel === true,
    catalogReplace: values.catalogReplace === true,
    catalogPrefix: values.catalogPrefix === true,
    modelListMode,
    models: Array.isArray(values.models)
      ? values.models.map((id) => String(id).replace(/^ocr\//, ''))
      : [],
    boundKeyId: typeof bound === 'string' ? bound : '',
    values,
  };
}

/** Persisted enum value for a UI mode: `default` is console vocabulary, while
 *  `custom` and `follow` are declared by both gateways. */
export function gatewayModeValue(
  vocabulary: GatewayVocabulary,
  mode: GatewayCfgDraft['modelListMode']
): string {
  return mode === 'default' ? vocabulary.unsetMode : mode;
}

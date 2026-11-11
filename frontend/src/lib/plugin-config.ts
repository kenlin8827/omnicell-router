import type { PluginConfigFieldInfo, PluginConfigSectionInfo } from './api';
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
 * UI's "None" and the schema field holding the picked key's `apiKeys[].id`.
 * Both are DECLARED by the manifest (ADR-0017 §7). The shipped gateways agree
 * on the key field (`accountKeyId`) but not on the unset spelling (`all` on
 * cursor-gateway, `none` on qoder-gateway), and a future gateway may name the
 * field anything. Hardcoding either spelling makes a save silently lose the
 * value: the host drops an unknown key and falls back on a failed enum, with a
 * warning.
 */
export interface GatewayVocabulary {
  /** Enum value the UI's "None" mode persists (`all`, `none`, …). */
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
    unsetMode: mode?.values?.find((value) => value !== 'custom' && value !== 'follow') ?? 'none',
    keyField: key?.key ?? '',
  };
}

/** The Client Hub card's model-catalog draft for one gateway. */
export interface GatewayCfgDraft extends GatewayVocabulary {
  model: string;
  forceModel: boolean;
  catalogReplace: boolean;
  /** UI-level mode; `gatewayModeValue` maps `none` to the plugin's spelling. */
  modelListMode: 'none' | 'custom' | 'follow';
  models: string[];
  /** `apiKeys[].id` held by the plugin's key field ('' = unbound). */
  boundKeyId: string;
  /** Original values, so a save never drops unrelated plugin settings. */
  values: Record<string, unknown>;
}

export function parseGatewayCfg(
  values: Record<string, unknown>,
  vocabulary: GatewayVocabulary
): GatewayCfgDraft {
  const modelListMode =
    values.modelListMode === 'custom' || values.modelListMode === 'follow'
      ? values.modelListMode
      : 'none';
  const bound = vocabulary.keyField ? values[vocabulary.keyField] : undefined;
  return {
    ...vocabulary,
    model: String(values.model ?? 'auto').replace(/^ocr\//, ''),
    forceModel: values.forceModel === true,
    catalogReplace: values.catalogReplace === true,
    modelListMode,
    models: Array.isArray(values.models)
      ? values.models.map((id) => String(id).replace(/^ocr\//, ''))
      : [],
    boundKeyId: typeof bound === 'string' ? bound : '',
    values,
  };
}

/** Persisted enum value for a UI mode: `none` is console vocabulary, while
 *  `custom` and `follow` are declared by both gateways. */
export function gatewayModeValue(
  vocabulary: GatewayVocabulary,
  mode: GatewayCfgDraft['modelListMode']
): string {
  return mode === 'none' ? vocabulary.unsetMode : mode;
}

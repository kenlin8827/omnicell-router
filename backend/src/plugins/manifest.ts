/**
 * ONE manifest validator shared by the runtime loader (plugins/host.ts) and
 * the packager (scripts/build-plugins.ts). plugin.json IS the single manifest
 * truth, so build time and load time must enforce the same contract — a
 * manifest that passes `plugins:build` must never fail at load, and vice
 * versa. `label` prefixes every error (the packager passes the plugin dir,
 * the runtime its own context).
 *
 * Strictest-union semantics: client-gateway manifests may omit `wires` (their
 * extension point is claimed SNI hosts; the runtime view reads `wires ?? []`),
 * every other shape rule holds for both plugin types.
 */
/** Contract version the CURRENT host implements. v1 is the FIRST plugin
 *  mechanism: there is no legacy or forward compatibility — a package must
 *  declare EXACTLY this value, anything else is an illegal package (ADR-0017
 *  §6). A deliberate compatibility window can only be added later, together
 *  with the test matrix that proves it. */
export const SUPPORTED_PLUGIN_API = 1;

/** Reject a package built for any other contract version. Called at INSTALL
 *  (before anything touches disk) and at LOAD (packages already on disk). */
export function assertSupportedPluginApi(apiVersion: number): void {
  if (apiVersion !== SUPPORTED_PLUGIN_API) {
    throw new Error(
      `plugin apiVersion ${apiVersion} does not match this host's plugin contract (${SUPPORTED_PLUGIN_API}) — rebuild the package with the current packager`
    );
  }
}

/** A plugin id is a PATH COMPONENT — `<pluginsRoot>/<id>.zip`,
 *  `<pluginsRoot>/unpacked/<id>/`, `<pluginsRoot>/bundled/<id>.zip` — so the
 *  manifest id is a slug: lowercase alphanumerics and dashes, starting
 *  alphanumeric. This is the ONE guard for that shape (the host's lifecycle
 *  routes call it too). Without it a hostile package steers those paths with
 *  `../..` (write AND recursive delete outside the plugins root), and the
 *  `ocr-` shipped-package reservation would be bypassable by casing on a
 *  case-insensitive filesystem. */
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*$/;

export function isValidPluginId(id: unknown): id is string {
  return typeof id === 'string' && PLUGIN_ID.test(id);
}

export function validatePluginManifest(manifest: unknown, label: string): void {
  const fail = (msg: string): never => {
    throw new Error(`${label}: ${msg}`);
  };
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) fail('not an object');
  const m = manifest as Record<string, unknown>;
  if (typeof m.id !== 'string' || !m.id) fail('id must be a non-empty string');
  else if (!isValidPluginId(m.id)) {
    fail(`id '${m.id}' must be a lowercase slug (a-z, 0-9, '-') — it is used as a plugin directory name`);
  }
  if (typeof m.name !== 'string' || !m.name) fail('name must be a non-empty string');
  if (typeof m.version !== 'string' || !m.version) fail('version must be a non-empty string');
  if (typeof m.apiVersion !== 'number' || !Number.isInteger(m.apiVersion) || m.apiVersion < 1) {
    fail('apiVersion must be a positive integer (the plugin contract version, currently 1)');
  }
  if (m.type !== 'model-service' && m.type !== 'client-gateway') {
    fail(`unknown plugin type '${String(m.type)}'`);
  }
  // wires is model-service's wire list and stays EMPTY/absent for a
  // client-gateway — the two types are separate extension axes, so neither is
  // validated with the other's rule.
  if (m.wires !== undefined && (!Array.isArray(m.wires) || !m.wires.every((w) => typeof w === 'string' && w))) {
    fail('wires must be a string array');
  }
  if (m.type === 'model-service' && (!Array.isArray(m.wires) || m.wires.length === 0)) {
    fail('a model-service manifest needs a non-empty wires array');
  }
  if (m.hosts !== undefined && (!Array.isArray(m.hosts) || !m.hosts.every((h) => typeof h === 'string' && h))) {
    fail('hosts must be a string array');
  }
  if (m.type === 'client-gateway' && (!Array.isArray(m.hosts) || m.hosts.length === 0)) {
    fail('a client-gateway manifest needs a non-empty hosts array');
  }
  // Flat primitives only (ADR-0017 §7): a malformed schema fails loudly
  // instead of degrading silently in the console's generic form.
  if (m.configSchema !== undefined) validateConfigSchema(m.configSchema, label, m.configSections);
  if (m.configSections !== undefined && m.configSchema === undefined) {
    fail('configSections without configSchema groups nothing');
  }
  if (m.logo !== undefined && typeof m.logo !== 'string') fail('logo must be a string');
  if (
    m.description !== undefined &&
    typeof m.description !== 'string' &&
    (typeof m.description !== 'object' || m.description === null)
  ) {
    fail('description must be a string or locale map');
  }
  if (m.presets !== undefined) {
    if (!Array.isArray(m.presets)) fail('presets must be an array');
    for (const preset of m.presets as unknown[]) {
      if (typeof preset !== 'object' || preset === null) fail('preset must be an object');
      const p = preset as Record<string, unknown>;
      if (typeof p.presetId !== 'string' || !p.presetId) fail('preset.presetId must be a non-empty string');
      if (typeof p.providerId !== 'string' || !p.providerId) fail('preset.providerId must be a non-empty string');
      if (typeof p.npm !== 'string' || !p.npm) fail('preset.npm must be a non-empty string');
      if (typeof p.baseUrl !== 'string' || !p.baseUrl) fail('preset.baseUrl must be a non-empty string');
      if (
        p.displayName !== undefined &&
        typeof p.displayName !== 'string' &&
        (typeof p.displayName !== 'object' || p.displayName === null)
      ) {
        fail('preset.displayName must be a string or locale map');
      }
    }
  }
}

const CONFIG_FIELD_TYPES: Record<string, true> = { string: true, number: true, boolean: true, 'string[]': true, enum: true };

/** Closed console widget vocabulary → the field types each control can drive.
 *  A new widget is a CONSOLE capability (added here, in the renderer and in the
 *  ADR), never something a plugin can invent. */
const CONFIG_CONTROLS: Record<string, Record<string, true>> = {
  text: { string: true },
  textarea: { string: true, 'string[]': true },
  model: { string: true },
  models: { 'string[]': true },
  // A short closed choice rendered as joined buttons instead of a dropdown --
  // the console's own mode switches (none / custom / follow) use the same shape.
  segmented: { enum: true },
  // The stable id of a gateway API key (the label/meta come from the live key
  // list); stored as a plain string so the plugin never receives the secret.
  apiKey: { string: true },
};

/** `title`/`desc` follow the manifest locale-map convention: a plain string or
 *  a BCP-47 keyed map of strings. */
function isTextOrLocaleMap(v: unknown): boolean {
  if (typeof v === 'string') return true;
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((text) => typeof text === 'string')
  );
}

/** A declared `default` must already be valid for its own type: the merge
 *  falls back silently on a wrong-typed stored value, so a wrong-typed DEFAULT
 *  would hand the plugin a value its own schema forbids. Returns the complaint
 *  or null when the default is fine. */
function defaultComplaint(field: Record<string, unknown>): string | null {
  const d = field.default;
  switch (field.type) {
    case 'boolean':
      return typeof d === 'boolean' ? null : 'must be a boolean';
    case 'number':
      if (typeof d !== 'number' || !Number.isFinite(d)) return 'must be a finite number';
      if (typeof field.min === 'number' && d < field.min) return `must be >= min (${field.min})`;
      if (typeof field.max === 'number' && d > field.max) return `must be <= max (${field.max})`;
      return null;
    case 'string':
      return typeof d === 'string' ? null : 'must be a string';
    case 'string[]':
      return Array.isArray(d) && d.every((x) => typeof x === 'string') ? null : 'must be a string array';
    case 'enum':
      return typeof d === 'string' && (field.values as string[]).includes(d)
        ? null
        : 'must be one of the declared enum values';
    default:
      return null;
  }
}

/** Validate one plugin's `configSchema` (flat primitive fields, ADR-0017 §7)
 *  and, when given, its `configSections` grouping. */
export function validateConfigSchema(schema: unknown, label: string, sections?: unknown): void {
  const fail = (msg: string): never => {
    throw new Error(`${label}: ${msg}`);
  };
  if (!Array.isArray(schema)) fail('configSchema must be an array');
  const seen = new Set<string>();
  for (const field of schema as Array<Record<string, unknown>>) {
    if (!field || typeof field !== 'object') fail('configSchema field must be an object');
    if (typeof field.key !== 'string' || !field.key) fail('every configSchema field needs a non-empty key');
    // checked above — TS cannot narrow the property access through `fail`
    const key = field.key as string;
    if (seen.has(key)) fail(`duplicate configSchema key '${key}'`);
    seen.add(key);
    if (typeof field.type !== 'string' || CONFIG_FIELD_TYPES[field.type] !== true) {
      fail(`'${field.key}' has unknown configSchema type '${String(field.type)}'`);
    }
    if (field.type === 'enum' && (!Array.isArray(field.values) || field.values.length === 0 || !field.values.every((v) => typeof v === 'string'))) {
      fail(`enum '${field.key}' needs a non-empty string values[]`);
    }
    // The label/description and the numeric bounds are DATA the console renders
    // and coerces against. They are declared in the same block as `key`, so an
    // unvalidated wrong type here would break the form (or the number bounds)
    // silently after a successful install — the opposite of this validator's
    // promise.
    for (const prop of ['title', 'desc'] as const) {
      if (field[prop] !== undefined && !isTextOrLocaleMap(field[prop])) {
        fail(`'${key}' ${prop} must be a string or a locale map of strings`);
      }
    }
    for (const prop of ['min', 'max'] as const) {
      if (field[prop] !== undefined && typeof field[prop] !== 'number') fail(`'${key}' ${prop} must be a number`);
    }
    if (field.default !== undefined) {
      const complaint = defaultComplaint(field);
      if (complaint !== null) fail(`'${key}' default ${complaint}`);
    }
    if (field.control !== undefined) {
      const drives = typeof field.control === 'string' ? CONFIG_CONTROLS[field.control] : undefined;
      if (!drives) fail(`'${key}' has unknown control '${String(field.control)}'`);
      if ((drives as Record<string, true>)[field.type as string] !== true) {
        fail(`'${key}' control '${String(field.control)}' cannot drive a ${String(field.type)} field`);
      }
    }
    if (field.enumLabels !== undefined) {
      if (field.type !== 'enum') fail(`'${key}' enumLabels is only meaningful on an enum field`);
      const labels = field.enumLabels;
      if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) {
        fail(`'${key}' enumLabels must be an object keyed by value`);
      }
      const declared = new Set((field.values as string[] | undefined) ?? []);
      for (const [value, text] of Object.entries(labels as Record<string, unknown>)) {
        if (!declared.has(value)) fail(`'${key}' enumLabels names undeclared value '${value}'`);
        if (!isTextOrLocaleMap(text)) fail(`'${key}' enumLabels['${value}'] must be a string or a locale map of strings`);
      }
    }
  }

  // Second pass — `visibleWhen` names a SIBLING field, so a forward reference is
  // legal and the target must already be validated above. Display-only: the
  // merge never reads this, but a wrong reference would silently show a field
  // that can never apply (or hide one forever), which is exactly the silent
  // degradation this validator exists to prevent.
  const fields = schema as Array<Record<string, unknown>>;
  const byKey = new Map<string, Record<string, unknown>>();
  for (const field of fields) byKey.set(field.key as string, field);
  for (const field of fields) {
    if (field.visibleWhen === undefined) continue;
    const key = field.key as string;
    const when = field.visibleWhen as Record<string, unknown> | null;
    if (typeof when !== 'object' || when === null || Array.isArray(when)) {
      fail(`'${key}' visibleWhen must be an object`);
    }
    const cond = when as { key?: unknown; equals?: unknown; in?: unknown };
    if (typeof cond.key !== 'string' || !cond.key) fail(`'${key}' visibleWhen needs a field key`);
    if (cond.key === key) fail(`'${key}' visibleWhen cannot reference itself`);
    const target = byKey.get(cond.key as string);
    if (!target) fail(`'${key}' visibleWhen references unknown field '${String(cond.key)}'`);
    const allowed = discreteValues(target as Record<string, unknown>);
    if (allowed === null) {
      fail(`'${key}' visibleWhen references '${String(cond.key)}', which is not an enum or boolean field`);
    }
    const hasEquals = cond.equals !== undefined;
    const hasIn = cond.in !== undefined;
    if (hasEquals === hasIn) fail(`'${key}' visibleWhen needs exactly one of equals / in`);
    if (hasEquals && !(allowed as Set<unknown>).has(cond.equals)) {
      fail(`'${key}' visibleWhen equals ${JSON.stringify(cond.equals)}, which '${String(cond.key)}' never holds`);
    }
    if (hasIn) {
      const list = cond.in;
      if (!Array.isArray(list) || list.length === 0) fail(`'${key}' visibleWhen.in must be a non-empty array`);
      for (const value of list as unknown[]) {
        if (!(allowed as Set<unknown>).has(value)) {
          fail(`'${key}' visibleWhen.in names ${JSON.stringify(value)}, which '${String(cond.key)}' never holds`);
        }
      }
    }
  }
  assertNoVisibilityCycle(fields, fail);
  if (sections !== undefined) validateSections(sections, fields, fail);
}

/** `configSections` is grouping only (no layout, no tabs): ids must be unique,
 *  every `field.section` must name one of them, and the titles follow the same
 *  locale-map convention as everything else. A dangling reference would put a
 *  field in a group nobody renders, so it fails at install instead. */
function validateSections(
  sections: unknown,
  fields: Array<Record<string, unknown>>,
  fail: (msg: string) => never
): void {
  if (!Array.isArray(sections)) fail('configSections must be an array');
  const ids = new Set<string>();
  const referenced = new Set<string>();
  for (const section of sections as Array<Record<string, unknown>>) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) fail('configSections entry must be an object');
    if (typeof section.id !== 'string' || !section.id) fail('every configSections entry needs a non-empty id');
    const id = section.id as string;
    if (ids.has(id)) fail(`duplicate configSections id '${id}'`);
    ids.add(id);
    if (section.title !== undefined && !isTextOrLocaleMap(section.title)) {
      fail(`section '${id}' title must be a string or a locale map of strings`);
    }
    if (section.advanced !== undefined && typeof section.advanced !== 'boolean') {
      fail(`section '${id}' advanced must be a boolean`);
    }
  }
  for (const field of fields) {
    if (field.section === undefined) continue;
    if (typeof field.section !== 'string' || !field.section) fail(`'${String(field.key)}' section must be a non-empty string`);
    if (!ids.has(field.section as string)) {
      fail(`'${String(field.key)}' names unknown configSections id '${String(field.section)}'`);
    }
    referenced.add(field.section as string);
  }
  // A declared group nothing references is either a typo in a field or dead
  // declaration — both render as a heading that never appears, so they fail here.
  for (const id of ids) {
    if (!referenced.has(id)) fail(`configSections id '${id}' is not referenced by any field`);
  }
}

/** The value domain of a condition target: an enum's declared values, or
 *  booleans. Anything else has no discrete values to test against. */
function discreteValues(field: Record<string, unknown>): Set<unknown> | null {
  if (field.type === 'enum') return new Set((field.values as string[] | undefined) ?? []);
  if (field.type === 'boolean') return new Set([true, false]);
  return null;
}

/** `visibleWhen` chains must not cycle: 'A while B' plus 'B while A' could never
 *  both be shown, so the form would silently lose a field. */
function assertNoVisibilityCycle(fields: Array<Record<string, unknown>>, fail: (msg: string) => never): void {
  const edge = new Map<string, string>();
  for (const field of fields) {
    const when = field.visibleWhen as { key?: unknown } | null | undefined;
    if (when && typeof when.key === 'string') edge.set(field.key as string, when.key);
  }
  const state = new Map<string, 1 | 2>();
  const visit = (key: string): void => {
    const seen = state.get(key);
    if (seen === 2) return;
    if (seen === 1) fail(`visibleWhen cycle through '${key}'`);
    state.set(key, 1);
    const next = edge.get(key);
    if (next !== undefined) visit(next);
    state.set(key, 2);
  };
  for (const key of edge.keys()) visit(key);
}

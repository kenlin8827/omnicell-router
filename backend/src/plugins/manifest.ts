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
export function validatePluginManifest(manifest: unknown, label: string): void {
  const fail = (msg: string): never => {
    throw new Error(`${label}: ${msg}`);
  };
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) fail('not an object');
  const m = manifest as Record<string, unknown>;
  if (typeof m.id !== 'string' || !m.id) fail('id must be a non-empty string');
  if (typeof m.name !== 'string' || !m.name) fail('name must be a non-empty string');
  if (typeof m.version !== 'string' || !m.version) fail('version must be a non-empty string');
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
  // Flat primitives only (ADR-0017 §6): a malformed schema fails loudly
  // instead of degrading silently in the console's generic form.
  if (m.configSchema !== undefined) validateConfigSchema(m.configSchema, label);
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

/** Validate one plugin's `configSchema` (flat primitive fields, ADR-0017 §6). */
export function validateConfigSchema(schema: unknown, label: string): void {
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
  }
}

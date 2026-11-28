import '../helpers/sandbox-home.js';
import { describe, it, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { getConfigPath, loadConfig, saveConfig, saveRawConfig, upgradeConfigFile } from '../../src/config/index.js';
import { SCHEMA_VERSION } from '../../src/config/schema.js';
import { canonicalizeSelectionValues } from '../../src/providers/selection.js';
import { currentYaml } from '../helpers/current-config.js';

/**
 * Selection strategy vocabulary is canonical at EVERY boundary.
 *
 * There is no legacy alias: only `priority` / `weighted_round_robin` /
 * `round_robin` are strategies, and any other value — absent, a typo, or the
 * retired `weighted` spelling of the old weighted-RANDOM draw — is the default
 * `priority`. The boundaries enforce that so no path can carry or persist a
 * fourth spelling:
 *
 *   - runtime read   (loadConfig)   — runtime consumers see canonical values;
 *   - visual save    (saveConfig)   — a stale console tab cannot re-persist it;
 *   - raw-YAML save  (saveRawConfig)— a hand-pasted value is normalized, and
 *                                     the draft is rewritten instead of being
 *                                     written back verbatim.
 *
 * An ABSENT `selection` stays absent (it already means the default) — the
 * canonicalizer never invents config the operator did not write.
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-selection-vocab-'));

afterAll(() => {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
      return;
    } catch {
      /* Windows can hold a temp dir busy right after YAML writes — retry, never fail the file. */
    }
  }
});

function load(yaml: string): ReturnType<typeof loadConfig> {
  const p = path.join(sandbox, `cfg-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(p, currentYaml(yaml), 'utf8');
  return loadConfig(p);
}

function seedActiveConfig(body: string): string {
  const cfgPath = getConfigPath();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, currentYaml(body), 'utf8');
  return cfgPath;
}

const TIERS_AND_COMBO_YAML = `routing:
  tiers:
    plus:
      selection: weighted
  combos:
    - id: c1
      selection: weighted
      models:
        - p/a
`;

describe('selection vocabulary — runtime read boundary', () => {
  it('loadConfig resolves the retired "weighted" spelling to the default priority', () => {
    const c = load(TIERS_AND_COMBO_YAML);
    expect(c.tiers?.plus?.selection).toBe('priority');
    expect(c.combos?.[0].selection).toBe('priority');
  });

  it('passes canonical values through and defaults unknown spellings', () => {
    const c = load(`routing:
  tiers:
    plus:
      selection: round_robin
    pro:
      selection: not-a-strategy
`);
    expect(c.tiers?.plus?.selection).toBe('round_robin');
    expect(c.tiers?.pro?.selection).toBe('priority');
  });

  it('leaves an absent selection absent (the default is implicit)', () => {
    const c = load('routing:\n  tiers:\n    plus:\n      members: []\n');
    expect(c.tiers?.plus?.selection).toBeUndefined();
  });
});

describe('selection vocabulary — visual save boundary', () => {
  it('saveConfig canonicalizes a stale payload before it reaches disk', () => {
    const cfgPath = seedActiveConfig('client:\n  port: 4711\n  apiKeys: []\n');

    const result = saveConfig({
      tiers: { plus: { selection: 'weighted', members: [{ pattern: 'p/a', weight: 2 }] } },
      combos: [{ id: 'c1', selection: 'weighted', models: ['p/a'] }],
    } as any);
    expect(result.success).toBe(true);

    const raw = fs.readFileSync(cfgPath, 'utf8');
    expect(raw).not.toMatch(/selection: weighted\b/);
    const disk = parse(raw) as Record<string, any>;
    expect(disk.routing.tiers.plus.selection).toBe('priority');
    expect(disk.routing.combos[0].selection).toBe('priority');
    // Sibling data is untouched by the vocabulary normalization.
    expect(disk.routing.tiers.plus.members).toEqual([{ pattern: 'p/a', weight: 2 }]);
  });

  it('saveConfig strips the runtime-only `exact` marker from tier members', () => {
    const cfgPath = seedActiveConfig('client:\n  port: 4811\n  apiKeys: []\n');
    const result = saveConfig({
      tiers: {
        plus: {
          members: [
            { pattern: 'p/a', weight: 2, exact: true },
            { pattern: 'p/b', exact: true },
            { pattern: 'p/c', effortMap: { low: 'high' }, exact: true },
          ],
        },
      },
    } as any);
    expect(result.success).toBe(true);
    const disk = parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, any>;
    const members = disk.routing.tiers.plus.members;
    // `exact` is derived by markExactFullIds at projection time; a round-trip
    // that echoed committed rules back must not freeze it into the file.
    expect(members).toEqual([
      { pattern: 'p/a', weight: 2 },
      { pattern: 'p/b' },
      { pattern: 'p/c', effortMap: { low: 'high' } },
    ]);
    for (const rule of members) expect(rule).not.toHaveProperty('exact');
  });
});

describe('selection vocabulary — boot upgrade', () => {
  it('upgradeConfigFile rewrites both v6 weighted spellings to v7 weighted_round_robin', () => {
    const cfgPath = getConfigPath();
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(
      cfgPath,
      `schemaVersion: 6
routing:
  tiers:
    plus:
      selection: weighted
    pro:
      selection: round_robin
  combos:
    - id: c1
      selection: weighted
      models:
        - p/a
`,
      'utf8'
    );

    const result = upgradeConfigFile();
    expect(result.migrated).toBe(true);
    expect(result.fromVersion).toBe(6);

    const raw = fs.readFileSync(cfgPath, 'utf8');
    expect(raw).not.toMatch(/selection: weighted\b/);
    const disk = parse(raw) as Record<string, any>;
    expect(disk.schemaVersion).toBe(SCHEMA_VERSION);
    expect(disk.routing.tiers.plus.selection).toBe('weighted_round_robin');
    // The old `round_robin` was weighted slots, so it must not silently become equal turns.
    expect(disk.routing.tiers.pro.selection).toBe('weighted_round_robin');
    expect(disk.routing.combos[0].selection).toBe('weighted_round_robin');
    // The runtime view reads the migrated vocabulary — no alias involved.
    expect(loadConfig(cfgPath).tiers?.plus?.selection).toBe('weighted_round_robin');
  });

  it('upgradeConfigFile leaves an already-current file untouched', () => {
    const cfgPath = seedActiveConfig('client:\n  port: 4716\n  apiKeys: []\n');
    const before = fs.readFileSync(cfgPath, 'utf8');
    const result = upgradeConfigFile();
    expect(result.migrated).toBe(false);
    expect(fs.readFileSync(cfgPath, 'utf8')).toBe(before);
  });
});

describe('selection vocabulary — raw-YAML save boundary', () => {
  it('saveRawConfig canonicalizes a current-version draft instead of writing it verbatim', () => {
    const cfgPath = seedActiveConfig('client:\n  port: 4713\n  apiKeys: []\n');

    const draft = currentYaml(TIERS_AND_COMBO_YAML);
    const result = saveRawConfig(draft);
    expect(result.success).toBe(true);

    const raw = fs.readFileSync(cfgPath, 'utf8');
    expect(raw).not.toMatch(/selection: weighted\b/);
    const disk = parse(raw) as Record<string, any>;
    expect(disk.routing.tiers.plus.selection).toBe('priority');
    expect(disk.routing.combos[0].selection).toBe('priority');
  });

  it('saveRawConfig still writes a clean current-version draft verbatim', () => {
    const cfgPath = seedActiveConfig('client:\n  port: 4714\n  apiKeys: []\n');
    const draft = currentYaml(`client:
  port: 4715
  apiKeys: []
routing:
  tiers:
    plus:
      selection: round_robin
`);
    expect(saveRawConfig(draft).success).toBe(true);
    // Byte-identical: the canonicalization path must not start rewriting clean
    // drafts (comments included).
    expect(fs.readFileSync(cfgPath, 'utf8')).toBe(draft);
  });
});

describe('canonicalizeSelectionValues', () => {
  it('rewrites every present non-canonical value and reports the change', () => {
    const container: Record<string, any> = {
      tiers: {
        plus: { selection: 'weighted' },
        pro: { selection: 'round_robin' },
        lite: { selection: 'not-a-strategy' },
        ultra: {},
        exclude: ['nope/*'],
      },
      combos: [{ selection: 'weighted' }, { selection: 'priority' }, 'not-an-object'],
    };
    expect(canonicalizeSelectionValues(container)).toBe(true);
    expect(container.tiers.plus.selection).toBe('priority');
    expect(container.tiers.pro.selection).toBe('round_robin');
    expect(container.tiers.lite.selection).toBe('priority');
    // Absent stays absent — the canonicalizer never materializes a field.
    expect(container.tiers.ultra.selection).toBeUndefined();
    expect(container.combos[0].selection).toBe('priority');
    expect(container.combos[1].selection).toBe('priority');
    // Second pass is a no-op — idempotent, so repeated saves never churn.
    expect(canonicalizeSelectionValues(container)).toBe(false);
  });

  it('tolerates absent / non-object containers and never invents fields', () => {
    expect(canonicalizeSelectionValues(undefined)).toBe(false);
    expect(canonicalizeSelectionValues(null)).toBe(false);
    expect(canonicalizeSelectionValues([])).toBe(false);
    expect(canonicalizeSelectionValues({ tiers: 42, combos: 'x' })).toBe(false);
    const empty: Record<string, any> = {};
    expect(canonicalizeSelectionValues(empty)).toBe(false);
    expect(Object.keys(empty)).toEqual([]);
  });
});
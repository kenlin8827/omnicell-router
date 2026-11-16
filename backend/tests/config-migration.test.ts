/**
 * Config schema evolution tests (ADR-0016).
 *
 * The v0 fixture is FROZEN: it is a byte-stable anchor of the legacy flat
 * layout. When a future schema version v2 ships, these tests gain new cases —
 * the v0 fixture and its expectations are NEVER edited (the chain
 * v0→v1→v2 must keep transforming it identically or the release breaks).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'yaml';
import {
  migrateConfig,
  toRuntimeConfig,
  toDiskConfig,
  toRuntimePath,
  SCHEMA_VERSION,
  type DiskConfig,
} from '../src/config/schema.js';
import type { RouterConfig } from '../src/config/types.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const V0_FLAT_YAML = readFileSync(path.join(FIXTURES_DIR, 'config-v0.yaml'), 'utf8');

describe('config schema evolution (ADR-0016)', () => {
  it('migrates the frozen v0 fixture to v1: grouped, versioned, master key dropped', () => {
    const { disk, fromVersion, warnings, tooNew } = migrateConfig(parse(V0_FLAT_YAML));
    assert.equal(tooNew, false);
    assert.equal(fromVersion, 0);
    assert.equal(disk.schemaVersion, SCHEMA_VERSION);

    // Groups exist; the flat legacy keys are gone from disk.
    const d = disk as Record<string, unknown>;
    for (const group of ['client', 'protocol', 'routing', 'upstream', 'resilience', 'ops']) {
      assert.ok(d[group] && typeof d[group] === 'object', `group ${group} materialized`);
    }
    for (const legacy of ['port', 'host', 'webAuth', 'apiKeys', 'tiers', 'fallback', 'adminApiKey', 'clientProfileMemory', 'circuitBreaker', 'catalog']) {
      assert.equal(legacy in d, false, `flat key ${legacy} must not survive on disk`);
    }

    // Renames landed.
    const routing = d.routing as Record<string, unknown>;
    assert.equal(routing.strategy, 'cost'); // was flat `routing.mode`
    assert.ok('profileMemory' in routing); // was flat `clientProfileMemory`
    const retry = (d.resilience as Record<string, unknown>).retry as Record<string, unknown>;
    assert.deepEqual(retry.escalation, { enabled: true, maxRetries: 2, escalateTier: 'pro', injectErrorContext: false }); // was flat `fallback`
    assert.equal('adminApiKey' in d, false);

    // One warning per announced change, master-key notice included.
    assert.ok(warnings.some((w) => w.includes('adminApiKey')));
    assert.ok(warnings.some((w) => w.includes('routing.strategy')));
  });

  it('expanded v1 runtime view preserves every v0 value', () => {
    const { disk } = migrateConfig(parse(V0_FLAT_YAML));
    const flat = toRuntimeConfig(disk) as unknown as RouterConfig;

    assert.equal(flat.port, 4000);
    assert.equal(flat.host, '127.0.0.1');
    assert.deepEqual(flat.webAuth, { enabled: true, username: 'admin', passwordHash: 'scrypt$aa$bb' });
    assert.equal(flat.apiKeys?.[0].key, 'sk-ocr-key-1');
    assert.equal(flat.rateLimit?.inboundGraceMs, 1200);
    assert.equal(flat.routing?.mode, 'cost');
    assert.deepEqual(flat.tiers?.exclude, ['blocked/*']);
    assert.equal(flat.classifier?.layer2?.enabled, true);
    assert.equal(flat.session?.strategy, 'sticky');
    assert.equal(flat.routeEntries?.maxEntries, 900);
    assert.equal(flat.systemone?.defaultModel, 'openai/gpt-4o-mini');
    assert.equal(flat.responses?.persist, true);
    assert.equal(flat.combos?.[0].id, 'daily-driver');
    // The model-profile bookkeeping (`profile`/`bindings`) is stripped by the
    // v1→v2 step — the entry keeps only the live form-memory fields.
    assert.deepEqual(flat.clientProfileMemory, { Cursor: {} });
    assert.deepEqual(flat.fallback, { enabled: true, maxRetries: 2, escalateTier: 'pro', injectErrorContext: false });
    assert.equal(flat.proxy?.url, 'http://127.0.0.1:7890');
    assert.deepEqual(flat.credentials?.anthropic, [{ keyHashPrefix: 'abcdef123456' }]);
    // The v1 `enabled:false` flag is rewritten by the v2→v3 step into the
    // provider-transport axis; the retired key never survives on disk.
    assert.deepEqual(flat.streaming, { upstream: { mode: 'buffered' } });
    assert.equal(flat.compression?.rtk?.enabled, true);
    assert.equal(flat.circuitBreaker?.failureThreshold, 5);
    assert.equal(flat.retry?.inplace?.maxAttempts, 2);
    assert.equal(flat.retry?.failover?.maxAttempts, 3);
    assert.equal(flat.requestCapture?.enabled, true);
    assert.equal(flat.tracePersist?.retentionDays, 14);
    assert.equal(flat.catalog?.syncIntervalMs, 43200000);
    assert.equal(flat.quota?.intervalMs, 30000);
    assert.equal(flat.opencode?.url, 'http://127.0.0.1:4096');
    assert.equal(flat.defaultModels?.translation, 'plus');
  });

  it('a file targeting a newer schema refuses to load (fail-safe, "upgrade OCR")', () => {
    const { tooNew, fromVersion } = migrateConfig({ schemaVersion: SCHEMA_VERSION + 1, client: {} });
    assert.equal(tooNew, true);
    assert.equal(fromVersion, SCHEMA_VERSION + 1);
  });

  it('round-trip: toDiskConfig ∘ toRuntimeConfig is the identity on the migrated v1 view', () => {
    const { disk } = migrateConfig(parse(V0_FLAT_YAML));
    const flat = toRuntimeConfig(disk) as unknown as RouterConfig;
    const redisk = { schemaVersion: SCHEMA_VERSION, ...toDiskConfig(flat) };
    assert.deepEqual(redisk, disk);
  });

  it('an unknown/junk v0 file migrates to a minimal valid v1 skeleton', () => {
    const { disk, warnings, tooNew } = migrateConfig({ garbage: [1, 2], adminApiKey: 'x' });
    assert.equal(tooNew, false);
    assert.equal(disk.schemaVersion, SCHEMA_VERSION);
    assert.ok(warnings.length > 0);
    // The legacy master key is RENAMED and survives under client.adminKey;
    // every other unmapped key never re-persists.
    assert.deepEqual(Object.keys(disk).sort(), ['client', 'schemaVersion']);
    assert.equal((disk as Record<string, Record<string, string>>).client.adminKey, 'x');
  });

  it('toRuntimePath translates disk field paths to runtime comment keys', () => {
    assert.equal(toRuntimePath('client.port'), 'port');
    assert.equal(toRuntimePath('client.adminKey'), 'adminKey');
    assert.equal(toRuntimePath('routing.strategy'), 'routing.mode');
    assert.equal(toRuntimePath('routing.tiers.lite.members'), 'tiers.lite.members');
    assert.equal(toRuntimePath('resilience.retry.escalation.maxRetries'), 'fallback.maxRetries');
    assert.equal(toRuntimePath('resilience.retry.inplace.backoffMs'), 'retry.inplace.backoffMs');
    assert.equal(toRuntimePath('resilience.circuitBreaker.shadow'), 'circuitBreaker.shadow');
    assert.equal(toRuntimePath('ops.catalog.autoPullPatterns.openai'), 'catalog.autoPullPatterns.openai');
    assert.equal(toRuntimePath('schemaVersion'), '');
  });

  it('v1 → v2: the model-profile section and its bookkeeping vanish (ADR-0031)', () => {
    const v1 = {
      schemaVersion: 1,
      routing: {
        strategy: 'cost',
        modelProfiles: [{ id: 'deep', slots: { flash: 'lite' } }],
        profileMemory: {
          pi: { profile: 'deep', bindings: { runner: 'flash' }, agentModels: { runner: 'lite' }, apiKeyId: 'key-1' },
          omp: { profile: '', bindings: {}, models: { main: 'auto' } },
        },
      },
    };
    const { disk, fromVersion, warnings } = migrateConfig(v1);
    assert.equal(fromVersion, 1);
    assert.equal(disk.schemaVersion, SCHEMA_VERSION);
    const routing = (disk as Record<string, Record<string, unknown>>).routing;
    assert.equal('modelProfiles' in routing, false, 'the retired section must not survive on disk');
    assert.deepEqual(routing.profileMemory, {
      pi: { agentModels: { runner: 'lite' }, apiKeyId: 'key-1' },
      omp: { models: { main: 'auto' } },
    });
    // The layout drops the move row, so the key can never re-persist.
    assert.equal(toRuntimePath('routing.modelProfiles'), 'routing.modelProfiles');
    assert.ok(warnings.some((w) => w.includes('model-profile')));
  });

  it('v2 → v3: the single streaming flag becomes two axes, exactly preserving behavior', () => {
    const { disk, fromVersion, warnings } = migrateConfig({
      schemaVersion: 2,
      upstream: { streaming: { enabled: false }, proxy: { url: 'http://127.0.0.1:7890' } },
    });
    assert.equal(fromVersion, 2);
    assert.equal(disk.schemaVersion, SCHEMA_VERSION);
    const upstream = (disk as Record<string, Record<string, unknown>>).upstream;
    const streaming = upstream.streaming as Record<string, unknown>;
    assert.equal('enabled' in streaming, false, 'the retired flag must not survive on disk');
    assert.deepEqual(streaming.upstream, { mode: 'buffered' });
    assert.deepEqual(upstream.proxy, { url: 'http://127.0.0.1:7890' });

    // `enabled: true` meant the v3 defaults — nothing is written for it.
    const enabled = migrateConfig({ schemaVersion: 2, upstream: { streaming: { enabled: true } } }).disk as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepEqual(enabled.upstream.streaming, {});

    // Newer intent at the new path wins over the legacy flag.
    const both = migrateConfig({
      schemaVersion: 2,
      upstream: { streaming: { enabled: false, upstream: { mode: 'follow' } } },
    }).disk as Record<string, Record<string, unknown>>;
    assert.deepEqual((both.upstream.streaming as Record<string, unknown>).upstream, { mode: 'follow' });
    assert.ok(warnings.some((w) => w.includes('streaming.client.mode')));
  });

  it('v3 → v4: the form-memory "none" spelling becomes "default", nothing else moves', () => {
    const { disk, fromVersion, warnings } = migrateConfig({
      schemaVersion: 3,
      routing: {
        profileMemory: {
          opencode: { modelMode: 'none', extraModels: ['gpt-5'], virtualModels: [] },
          pi: { modelMode: 'custom', models: { main: 'auto' } },
          grok: { modelMode: 'follow' },
        },
      },
    });
    assert.equal(fromVersion, 3);
    assert.equal(disk.schemaVersion, SCHEMA_VERSION);
    const memory = (disk as Record<string, Record<string, Record<string, Record<string, unknown>>>>).routing.profileMemory;
    assert.equal(memory.opencode.modelMode, 'default');
    // Sibling snapshot fields are untouched — only the enum spelling moved.
    assert.deepEqual(memory.opencode.extraModels, ['gpt-5']);
    assert.deepEqual(memory.opencode.virtualModels, []);
    assert.equal(memory.pi.modelMode, 'custom');
    assert.deepEqual(memory.pi.models, { main: 'auto' });
    assert.equal(memory.grok.modelMode, 'follow');
    assert.ok(warnings.some((w) => w.includes('modelMode')));

    // Unknown spellings are left to loadConfig's cleaners, never rewritten.
    const weird = migrateConfig({
      schemaVersion: 3,
      routing: { profileMemory: { opencode: { modelMode: 'weird' } } },
    }).disk as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
    assert.equal(weird.routing.profileMemory.opencode.modelMode, 'weird');

    // An absent memory tree is never created by the step.
    const empty = migrateConfig({ schemaVersion: 3, client: { port: 4700 } }).disk as Record<string, Record<string, unknown>>;
    assert.equal('profileMemory' in ((empty.routing ?? {}) as Record<string, unknown>), false);
  });
});

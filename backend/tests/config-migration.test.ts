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
    assert.equal(flat.forwardProxy?.unresolvedModel?.onMiss, 'direct');
    assert.equal(flat.routing?.mode, 'cost');
    assert.deepEqual(flat.tiers?.exclude, ['blocked/*']);
    assert.equal(flat.classifier?.layer2?.enabled, true);
    assert.equal(flat.session?.strategy, 'sticky');
    assert.equal(flat.routeEntries?.maxEntries, 900);
    assert.equal(flat.systemone?.defaultModel, 'openai/gpt-4o-mini');
    assert.equal(flat.responses?.persist, true);
    assert.equal(flat.combos?.[0].id, 'daily-driver');
    assert.deepEqual(flat.clientProfileMemory, { Cursor: { profile: 'fast' } });
    assert.deepEqual(flat.fallback, { enabled: true, maxRetries: 2, escalateTier: 'pro', injectErrorContext: false });
    assert.equal(flat.proxy?.url, 'http://127.0.0.1:7890');
    assert.deepEqual(flat.credentials?.anthropic, [{ keyHashPrefix: 'abcdef123456' }]);
    assert.equal(flat.streaming?.enabled, false);
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
});

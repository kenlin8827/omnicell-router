import '../helpers/sandbox-home.js';
import { describe, it, expect, afterAll, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../../src/config/index.js';
import { DEFAULT_AUTO_RESYNC_FOLLOW_CATALOGS, FOLLOW_CATALOG_KEY_DEBOUNCE_MS } from '../../src/config/defaults.js';
import { migrateConfig, toDiskConfig, SCHEMA_VERSION } from '../../src/config/schema.js';
import { currentYaml } from '../helpers/current-config.js';
import {
  _resetFollowCatalogSyncForTests,
  getFollowCatalogSyncState,
  isFollowCatalogAutoResyncEnabled,
  requestFollowCatalogSync,
  retryFollowCatalogPending,
  stampClientProfileMemory,
  clearClientProfileMemory,
} from '../../src/cli/clients/follow-catalog-sync.js';

/**
 * schemaVersion 6 — `client.autoResyncFollowCatalogs` layout row + kill switch.
 * Also covers the in-process sync module's enablement and memory stamp helpers
 * (full setupClient integration needs a hooked adapter fixture; that lives
 * elsewhere).
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-follow-sync-'));

afterAll(() => {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
      return;
    } catch {
      /* Windows busy temp — retry */
    }
  }
});

function load(yaml: string): ReturnType<typeof loadConfig> {
  const p = path.join(sandbox, `cfg-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(p, currentYaml(yaml), 'utf8');
  return loadConfig(p);
}

describe('client.autoResyncFollowCatalogs — schema v6', () => {
  it('defaults to ON when the section is absent', () => {
    const c = load('client:\n  port: 3999\n');
    expect(c.autoResyncFollowCatalogs).toBe(DEFAULT_AUTO_RESYNC_FOLLOW_CATALOGS);
    expect(c.autoResyncFollowCatalogs).toBe(true);
  });

  it('honours an explicit false', () => {
    const c = load('client:\n  port: 3999\n  autoResyncFollowCatalogs: false\n');
    expect(c.autoResyncFollowCatalogs).toBe(false);
  });

  it('round-trips through toDiskConfig / migrateConfig', () => {
    const disk = toDiskConfig({
      port: 3999,
      autoResyncFollowCatalogs: false,
    } as any);
    expect((disk as any).client?.autoResyncFollowCatalogs).toBe(false);
    const migrated = migrateConfig({ schemaVersion: 5, client: { port: 3999 } });
    expect(migrated.disk.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.fromVersion).toBe(5);
    const twice = migrateConfig(migrated.disk);
    expect(twice.fromVersion).toBe(SCHEMA_VERSION);
  });
});

describe('follow-catalog-sync module', () => {
  beforeEach(() => {
    _resetFollowCatalogSyncForTests();
  });

  it('reports enabled from config (default ON)', () => {
    expect(isFollowCatalogAutoResyncEnabled()).toBe(loadConfig().autoResyncFollowCatalogs !== false);
    const state = getFollowCatalogSyncState();
    expect(state.enabled).toBe(isFollowCatalogAutoResyncEnabled());
    expect(Array.isArray(state.pending)).toBe(true);
    expect(Array.isArray(state.failed)).toBe(true);
    expect(Array.isArray(state.issues)).toBe(true);
  });

  it('stamps and clears clientProfileMemory', () => {
    stampClientProfileMemory('opencode', {
      modelMode: 'follow',
      apiKeyId: 'key-1',
    });
    expect(loadConfig().clientProfileMemory?.opencode?.modelMode).toBe('follow');
    expect(loadConfig().clientProfileMemory?.opencode?.apiKeyId).toBe('key-1');
    clearClientProfileMemory('opencode');
    expect(loadConfig().clientProfileMemory?.opencode).toBeUndefined();
  });

  it('requestFollowCatalogSync is a no-op schedule when kill switch is off', async () => {
    const prev = loadConfig().autoResyncFollowCatalogs;
    saveConfig({ autoResyncFollowCatalogs: false });
    try {
      expect(isFollowCatalogAutoResyncEnabled()).toBe(false);
      requestFollowCatalogSync({ reason: 'pool' });
      // Debounce fires async; give it a tick then assert no crash / empty pending.
      await Bun.sleep(50);
      expect(getFollowCatalogSyncState().pending).toEqual([]);
    } finally {
      saveConfig({ autoResyncFollowCatalogs: prev });
    }
  });

  it('a single key edit stays key-scoped; several coalesce into one pool pass', async () => {
    const prev = loadConfig().autoResyncFollowCatalogs;
    saveConfig({ autoResyncFollowCatalogs: true });
    try {
      requestFollowCatalogSync({ reason: 'key', keyId: 'solo' });
      await Bun.sleep(FOLLOW_CATALOG_KEY_DEBOUNCE_MS + 150);
      expect(getFollowCatalogSyncState().lastRun?.reason).toBe('key');
      expect(getFollowCatalogSyncState().lastRun?.keyId).toBe('solo');

      // A dropped earlier keyId is the bug this pins: the debounce Set must
      // survive both adds, so two edits widen to a pool pass rather than
      // scheduling the last key only.
      requestFollowCatalogSync({ reason: 'key', keyId: 'first' });
      requestFollowCatalogSync({ reason: 'key', keyId: 'second' });
      await Bun.sleep(FOLLOW_CATALOG_KEY_DEBOUNCE_MS + 150);
      expect(getFollowCatalogSyncState().lastRun?.reason).toBe('pool');
      expect(getFollowCatalogSyncState().lastRun?.keyId).toBeUndefined();
    } finally {
      saveConfig({ autoResyncFollowCatalogs: prev });
    }
  });

  it('an empty retry answers a zero run instead of a full pass', async () => {
    // No issues are open, so a pass must not be scheduled at all: a full pool
    // pass would re-setup every follow client and, with the registry unset in
    // this process, would surface as registry_unavailable.
    const run = await retryFollowCatalogPending();
    expect(run.synced).toBe(0);
    expect(run.skipped).toBe(0);
    expect(run.failed).toBe(0);
    expect(run.errors).toEqual([]);
    expect(getFollowCatalogSyncState().lastRun).toBeUndefined();
  });
});

import '../helpers/sandbox-home.js';
import { describe, it, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { getConfigPath, loadConfig, resolveBodyLimits, saveConfig } from '../../src/config/index.js';
import {
  ADMIN_MAX_BODY_BYTES,
  BODY_LIMIT_MAX_BYTES,
  BODY_LIMIT_MIN_BYTES,
  GATEWAY_MAX_BODY_BYTES,
} from '../../src/config/defaults.js';
import { migrateConfig, toDiskConfig, SCHEMA_VERSION } from '../../src/config/schema.js';
import { currentYaml } from '../helpers/current-config.js';

/**
 * The body caps as an OPERATOR KNOB (ADR-0008, schemaVersion 5).
 *
 * Two failure modes this locks shut, both silent:
 *
 * 1. A disk section that is not a layout row is DROPPED on the way in and on the
 *    way out (`toDiskConfig`/`toRuntimeConfig` iterate only the bound rows). The
 *    console would then show a value that never reloads, and a hand-edited
 *    `client.bodyLimits` would do nothing — the knob reads as broken config.
 * 2. A byte cap is a trust boundary: a negative or zero value admitted from a
 *    number input would refuse EVERY request (or admit an unbounded one), and a
 *    silly-large value turns the memory guard off. So the resolver clamps into
 *    [BODY_LIMIT_MIN_BYTES, BODY_LIMIT_MAX_BYTES] and falls back to the shipped
 *    constant on junk — it never coerces a typo into a policy.
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-body-limits-'));

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

describe('client.bodyLimits — defaults and clamping', () => {
  it('defaults to the shipped tier constants when the section is absent', () => {
    const c = load('client:\n  port: 3999\n');
    expect(c.bodyLimits).toEqual({
      maxBytes: GATEWAY_MAX_BODY_BYTES,
      adminMaxBytes: ADMIN_MAX_BODY_BYTES,
    });
  });

  it('honours a value inside the legal band', () => {
    const c = load(`client:\n  port: 3999\n  bodyLimits:\n    maxBytes: ${2 * 1024 * 1024}\n`);
    expect(c.bodyLimits?.maxBytes).toBe(2 * 1024 * 1024);
    // An untouched sibling keeps its own default, never the neighbour's value.
    expect(c.bodyLimits?.adminMaxBytes).toBe(ADMIN_MAX_BODY_BYTES);
  });

  it('clamps below the floor instead of refusing every request', () => {
    const c = load('client:\n  port: 3999\n  bodyLimits:\n    maxBytes: 1024\n    adminMaxBytes: 0\n');
    expect(c.bodyLimits?.maxBytes).toBe(BODY_LIMIT_MIN_BYTES);
    expect(c.bodyLimits?.adminMaxBytes).toBe(BODY_LIMIT_MIN_BYTES);
  });

  it('clamps above the ceiling instead of disabling the memory guard', () => {
    const c = load(`client:\n  port: 3999\n  bodyLimits:\n    maxBytes: ${2 * 1024 * 1024 * 1024}\n`);
    expect(c.bodyLimits?.maxBytes).toBe(BODY_LIMIT_MAX_BYTES);
  });

  it('falls back to the shipped constant on junk rather than guessing', () => {
    for (const junk of ['"lots"', 'abc', 'null', '[]', '{}']) {
      const c = load(`client:\n  port: 3999\n  bodyLimits:\n    maxBytes: ${junk}\n`);
      expect(c.bodyLimits?.maxBytes).toBe(GATEWAY_MAX_BODY_BYTES);
    }
    // A non-object section is not a section at all.
    expect(resolveBodyLimits({ bodyLimits: 42 }).maxBytes).toBe(GATEWAY_MAX_BODY_BYTES);
    expect(resolveBodyLimits(undefined).adminMaxBytes).toBe(ADMIN_MAX_BODY_BYTES);
  });

  it('rounds a fractional byte count instead of rejecting the config', () => {
    const c = load('client:\n  port: 3999\n  bodyLimits:\n    maxBytes: 1048576.7\n');
    expect(c.bodyLimits?.maxBytes).toBe(1048577);
  });
});

describe('client.bodyLimits — disk layout and migration', () => {
  it('persists under client.bodyLimits and reloads identically', () => {
    // The row in SECTION_MOVES_V5 is the only thing standing between this knob and
    // silence: an unbound key vanishes in BOTH directions, so the console would
    // report a save that never came back.
    const cfgPath = getConfigPath();
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, currentYaml('schemaVersion: 3\nclient:\n  port: 4712\n  apiKeys: []\n'), 'utf8');

    expect(saveConfig({ bodyLimits: { maxBytes: 8 * 1024 * 1024, adminMaxBytes: 2 * 1024 * 1024 } }).success).toBe(true);

    const disk = parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, any>;
    expect(disk.client?.bodyLimits?.maxBytes).toBe(8 * 1024 * 1024);
    expect(disk.client?.bodyLimits?.adminMaxBytes).toBe(2 * 1024 * 1024);
    const reloaded = loadConfig(cfgPath);
    expect(reloaded.bodyLimits).toEqual({ maxBytes: 8 * 1024 * 1024, adminMaxBytes: 2 * 1024 * 1024 });
  });

  it('v4 → v5 stamps the version, warns once, and invents no section', () => {
    const { disk, fromVersion, warnings, tooNew } = migrateConfig({
      schemaVersion: 4,
      client: { port: 4705 },
    });
    expect(tooNew).toBe(false);
    expect(fromVersion).toBe(4);
    expect(disk.schemaVersion).toBe(SCHEMA_VERSION);
    // Identity migration on purpose: materialising an empty `bodyLimits` would make
    // every migrated file claim an explicit cap the operator never chose, and the
    // console would render defaults as user edits.
    const client = (disk as Record<string, any>).client;
    expect('bodyLimits' in client).toBe(false);
    expect(warnings.some((w) => w.includes('client.bodyLimits'))).toBe(true);
    expect(warnings.filter((w) => w.includes('client.bodyLimits'))).toHaveLength(1);
  });

  it('v4 → v5 leaves an existing bodyLimits tree byte-identical', () => {
    const source = {
      schemaVersion: 4,
      client: { port: 4705, bodyLimits: { maxBytes: 4194304 } },
    };
    const { disk } = migrateConfig(structuredClone(source));
    expect((disk as Record<string, any>).client.bodyLimits).toEqual({ maxBytes: 4194304 });
    // Idempotence: re-running the chain on the migrated file is a no-op, and the
    // section survives the disk -> runtime -> disk loop unchanged, which is what
    // makes a console save safe on an already-migrated file.
    const twice = migrateConfig(structuredClone(disk));
    expect(twice.fromVersion).toBe(SCHEMA_VERSION);
    expect(twice.warnings).toEqual([]);
    expect((twice.disk as Record<string, any>).client.bodyLimits).toEqual({ maxBytes: 4194304 });
    expect(toDiskConfig({ ...loadConfigFromDisk(disk), bodyLimits: { maxBytes: 4194304 } })).toMatchObject({
      client: { bodyLimits: { maxBytes: 4194304 } },
    });
  });

  it('a v5 file with an out-of-band cap still loads, clamped at the resolver', () => {
    // The band is enforced by the resolver, not the migration, so a file written by
    // a future (or hand-edited) release degrades to a legal value instead of being
    // silently replaced by defaults.
    const c = load('client:\n  port: 3999\n  bodyLimits:\n    maxBytes: 16\n');
    expect(c.bodyLimits?.maxBytes).toBe(BODY_LIMIT_MIN_BYTES);
    expect(c.port).toBe(3999);
  });
});

function loadConfigFromDisk(disk: Record<string, unknown>): unknown {
  const p = path.join(sandbox, `mig-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(p, currentYaml(stringifyClient(disk)), 'utf8');
  return loadConfig(p);
}

function stringifyClient(disk: Record<string, unknown>): string {
  const client = disk.client as Record<string, unknown>;
  const lines = [`client:\n  port: ${client.port}`];
  if (client.bodyLimits) lines.push(`  bodyLimits:\n    maxBytes: ${(client.bodyLimits as any).maxBytes}`);
  return lines.join('\n');
}

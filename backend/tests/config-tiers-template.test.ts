import { describe, it, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'yaml';
import { loadConfig, defaultConfigYaml } from '../src/config/index.js';
import { resolveTierMembers } from '../src/providers/member-match.js';
import type { TierLevel } from '../src/types/router.js';

/**
 * Lock for "the shipped tier defaults are EMPTY pools — members are
 * operator-curated".
 *
 *   1. DEFAULT_CONFIG.tiers = four empty tier shells (lite / plus / pro /
 *      ultra, no members anywhere) and defaultConfigYaml() ships exactly
 *      that, so a brand-new config.yaml starts pool-less (configured=false
 *      → empty pools + the boot-direct warning, `auto` cannot route);
 *   2. loadConfig() falls back to those shells when the file has NO
 *      `tiers:` section (absent or null) — deleting the section gets the
 *      empty defaults back on the next load;
 *   3. an explicit `tiers: {}` stays `{}`, and a file that carries
 *      `members` keeps its committed lists UNTOUCHED (whole-object
 *      replacement, never merged).
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-tiers-template-'));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function writeConfig(name: string, content: string): string {
  const p = path.join(sandbox, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

const TIERS = ['lite', 'plus', 'pro', 'ultra'] as const;

describe('defaultConfigYaml — the template ships EMPTY pools', () => {
  it('ships 4 tiers x no members (lite/plus/pro/ultra; configured=false)', () => {
    const doc = parse(defaultConfigYaml()) as any;
    expect(Object.keys(doc.tiers)).toEqual([...TIERS]);
    for (const t of TIERS) expect(doc.tiers[t]).toEqual({});
    const resolved = resolveTierMembers(doc.tiers);
    expect(resolved.configured).toBe(false);
    for (const t of TIERS) expect(resolved.tiers[t]).toEqual([]);
  });

  it('the generated template round-trips through loadConfig still pool-less', () => {
    // Simulates first run: ensureDefaultConfigFile() writes defaultConfigYaml()
    // to disk, the gateway then boots on loadConfig() of that file.
    const p = writeConfig('fresh.yaml', defaultConfigYaml());
    const resolved = resolveTierMembers(loadConfig(p).tiers);
    expect(resolved.configured).toBe(false);
    for (const t of TIERS) expect(resolved.tiers[t]).toEqual([]);
  });
});

describe('loadConfig tiers fallback — absent section restores the empty shells', () => {
  it('no `tiers:` section at all → four empty shells, no members anywhere', () => {
    const p = writeConfig('no-tiers.yaml', 'port: 3999\nhost: 127.0.0.1\n');
    const cfg = loadConfig(p);
    expect(Object.keys(cfg.tiers ?? {})).toEqual([...TIERS]);
    for (const t of TIERS) expect(cfg.tiers?.[t]?.members).toBeUndefined();
    expect(resolveTierMembers(cfg.tiers).configured).toBe(false);
  });

  it('`tiers:` written empty (null value) → empty shells too', () => {
    const p = writeConfig('null-tiers.yaml', 'port: 3999\ntiers:\n');
    const cfg = loadConfig(p);
    expect(Object.keys(cfg.tiers ?? {})).toEqual([...TIERS]);
    expect(resolveTierMembers(cfg.tiers).configured).toBe(false);
    for (const t of TIERS) expect(resolveTierMembers(cfg.tiers).tiers[t]).toEqual([]);
  });

  it('explicit `tiers: {}` stays {} — no members anywhere (boot warns, does not seed)', () => {
    const p = writeConfig('empty-tiers.yaml', 'port: 3999\ntiers: {}\n');
    const cfg = loadConfig(p);
    expect(cfg.tiers).toEqual({});
    expect(resolveTierMembers(cfg.tiers).configured).toBe(false);
    for (const t of TIERS) expect(resolveTierMembers(cfg.tiers).tiers[t]).toEqual([]);
  });

  it('committed member lists are never merged with or replaced by the template', () => {
    const p = writeConfig(
      'mine.yaml',
      ['port: 3999', 'tiers:', '  lite:', '    members:', '      - pattern: "mine/*"', '  pro:', '    members:', '      - pattern: "other/thing"', ''].join('\n')
    );
    const cfg = loadConfig(p);
    expect(cfg.tiers?.lite?.members).toEqual([{ pattern: 'mine/*' }]);
    expect(cfg.tiers?.pro?.members).toEqual([{ pattern: 'other/thing' }]);
    expect(cfg.tiers?.plus?.members).toBeUndefined(); // untouched: absent, NOT backfilled
    expect(cfg.tiers?.ultra?.members).toBeUndefined();
  });
});

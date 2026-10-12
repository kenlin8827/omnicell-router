import { describe, it, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'yaml';
import { loadConfig, defaultConfigYaml } from '../src/config/index.js';
import { resolveTierMembers } from '../src/providers/member-match.js';
import type { TierLevel } from '../src/types/router.js';

/**
 * Lock for "the default tier members live only in the config template".
 *
 *   1. DEFAULT_CONFIG.tiers = one glob per tier (haiku / sonnet / opus /
 *      fable, lite→ultra) and defaultConfigYaml() ships exactly that, so
 *      a brand-new config.yaml starts with committed member lists;
 *   2. loadConfig() falls back to the template when the file has NO `tiers:`
 *      section (absent or empty) — deleting the section gets the defaults
 *      back on the next load;
 *   3. an explicit `tiers: {}` is the operator's own choice — it stays `{}`
 *      (configured=false → empty pools + boot-direct warning), and a file
 *      that carries `members` keeps its committed lists UNTOUCHED (whole-
 *      object replacement, never merged with the template).
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-tiers-template-'));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function writeConfig(name: string, content: string): string {
  const p = path.join(sandbox, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

const TIERS = ['lite', 'plus', 'pro', 'ultra'] as const;
const EXPECTED_GLOBS: Record<TierLevel, string> = {
  lite: '*haiku*',
  plus: '*sonnet*',
  pro: '*opus*',
  ultra: '*fable*',
};

describe('defaultConfigYaml — the template IS the first-boot seed', () => {
  it('ships 4 tiers x exactly 1 glob member (lite→ultra: haiku/sonnet/opus/fable)', () => {
    const doc = parse(defaultConfigYaml()) as any;
    expect(Object.keys(doc.tiers)).toEqual([...TIERS]);
    for (const t of TIERS) {
      expect(doc.tiers[t].members).toEqual([{ pattern: EXPECTED_GLOBS[t] }]);
    }
    expect(resolveTierMembers(doc.tiers).configured).toBe(true);
  });

  it('the generated template round-trips through loadConfig with the same lists', () => {
    // Simulates first run: ensureDefaultConfigFile() writes defaultConfigYaml()
    // to disk, the gateway then boots on loadConfig() of that file.
    const p = writeConfig('fresh.yaml', defaultConfigYaml());
    const resolved = resolveTierMembers(loadConfig(p).tiers);
    expect(resolved.configured).toBe(true);
    for (const t of TIERS) expect(resolved.tiers[t]).toEqual([{ pattern: EXPECTED_GLOBS[t] }]);
  });
});

describe('loadConfig tiers fallback — absent section restores the template', () => {
  it('no `tiers:` section at all → template defaults', () => {
    const p = writeConfig('no-tiers.yaml', 'port: 3999\nhost: 127.0.0.1\n');
    const cfg = loadConfig(p);
    for (const t of TIERS) expect(cfg.tiers?.[t]?.members).toEqual([{ pattern: EXPECTED_GLOBS[t] }]);
  });

  it('`tiers:` written empty (null value) → template defaults too', () => {
    const p = writeConfig('null-tiers.yaml', 'port: 3999\ntiers:\n');
    expect(loadConfig(p).tiers?.lite?.members).toEqual([{ pattern: '*haiku*' }]);
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

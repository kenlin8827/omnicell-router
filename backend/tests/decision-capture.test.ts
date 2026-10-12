import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import {
  applyConfig,
  captureDecision,
  datasetHasCapacity,
  resetDecisionCaptureConfig,
} from '../src/flywheel/decision-capture.js';

// ---------------------------------------------------------------------------
// Dataset-sink gate (config restructure): the L2 judge's decision sink writes
// on the SINGLE key classifier.layer2.collectEnabled — the old three-tier
// chain (capture.enabled × systemoneEnabled × l2DecisionEnabled) is deleted
// and the capture master no longer involves this sink. Plus: the 64MB size
// cap, and the load-time migration warns for the retired keys/section.
// ---------------------------------------------------------------------------
const originalCwd = process.cwd();
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-decision-capture-'));
// Config resolves from OCR_HOME (never the cwd) — isolate both the config and
// the dataset sink inside a throwaway home, exactly like the isolated runner.
process.env.OCR_HOME = path.join(sandbox, 'home');
const ENV_DIR = path.join(process.env.OCR_HOME, 'envs', 'default');
fs.mkdirSync(ENV_DIR, { recursive: true });
fs.writeFileSync(path.join(ENV_DIR, 'config.yaml'), 'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\n');
fs.writeFileSync(path.join(ENV_DIR, 'env.json'), JSON.stringify({ name: 'default', type: 'regular', schemaVersion: 1 }));
process.chdir(sandbox);

const DATASET = () => path.join(ENV_DIR, 'data', 'layer2-decisions.jsonl');
const flush = () => new Promise((r) => setTimeout(r, 50)); // appendFile is fire-and-forget
const sample = {
  model: 'p/jev',
  provider: 'p',
  upstreamKind: 'native' as const,
  state: 'user: hi',
  tier: 'plus',
  confidence: 0.5,
  latencyMs: 1,
};

function clearDataset(): void {
  fs.rmSync(path.join(ENV_DIR, 'data'), { recursive: true, force: true });
}

function writeConfig(yaml: string): void {
  fs.writeFileSync(path.join(ENV_DIR, 'config.yaml'), yaml);
}

/** Run fn with console.warn captured; returns [result, warnings]. */
function withWarnings<T>(fn: () => T): [T, string[]] {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
  try {
    return [fn(), warnings];
  } finally {
    console.warn = originalWarn;
  }
}

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  resetDecisionCaptureConfig();
  clearDataset();
  writeConfig('port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\n');
});

describe('dataset gate truth table (single key classifier.layer2.collectEnabled)', () => {
  const combos: Array<[{ collectEnabled?: boolean } | undefined, boolean]> = [
    [{ collectEnabled: true }, true],
    [{ collectEnabled: false }, false],
    [{} as { collectEnabled?: boolean }, false], // absent = closed (=== true gate)
    [undefined, false], // no config node at all → gate closed
  ];
  for (const [cfg, expected] of combos) {
    test(`collectEnabled=${String(cfg?.collectEnabled)} (cfg=${cfg === undefined ? 'undefined' : 'node'}) → ${expected ? 'writes' : 'silent'}`, async () => {
      applyConfig(cfg);
      captureDecision(sample);
      await flush();
      expect(fs.existsSync(DATASET())).toBe(expected);
      if (expected) {
        const rows = fs.readFileSync(DATASET(), 'utf8').trim().split('\n');
        expect(rows.length).toBe(1);
        const row = JSON.parse(rows[0]);
        expect(row.source).toBe('layer2_judge');
        expect(row.tier).toBe('plus');
      }
    });
  }

  test('capture master keys no longer drive the sink (enabled:false + collectEnabled:true still writes; collectEnabled absent never writes)', async () => {
    // The old three-tier inputs are gone from the gate: a requestCapture
    // section OFF (or absent entirely) must NOT suppress the dataset sink.
    writeConfig(
      'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\nrequestCapture:\n  enabled: false\nclassifier:\n  layer2:\n    collectEnabled: true\n'
    );
    resetDecisionCaptureConfig();
    captureDecision(sample);
    await flush();
    expect(fs.existsSync(DATASET())).toBe(true);
  });
});

describe('hot-apply parity (applyConfig twice, no restart)', () => {
  test('ON → OFF → ON flips take effect immediately', async () => {
    applyConfig({ collectEnabled: true });
    captureDecision(sample);
    await flush();
    expect(fs.readFileSync(DATASET(), 'utf8').trim().split('\n').length).toBe(1);

    // Console save flips collectEnabled off: next decision must not land.
    applyConfig({ collectEnabled: false });
    captureDecision(sample);
    await flush();
    expect(fs.readFileSync(DATASET(), 'utf8').trim().split('\n').length).toBe(1);

    // And back on — writes resume, still without a restart.
    applyConfig({ collectEnabled: true });
    captureDecision(sample);
    await flush();
    expect(fs.readFileSync(DATASET(), 'utf8').trim().split('\n').length).toBe(2);
  });
});

describe('64MB dataset cap', () => {
  test('datasetHasCapacity: absent file has capacity; over fake cap does not', () => {
    const missing = path.join(sandbox, 'nope.jsonl');
    expect(datasetHasCapacity(missing)).toBe(true);
    const small = path.join(sandbox, 'small.jsonl');
    fs.writeFileSync(small, 'x'.repeat(300));
    try {
      expect(datasetHasCapacity(small)).toBe(true); // under the REAL 64MB ceiling
      expect(datasetHasCapacity(small, 256)).toBe(false); // fake ceiling — the testable seam
      // At exactly the cap the file still fits (strict >).
      fs.writeFileSync(small, 'y'.repeat(256));
      expect(datasetHasCapacity(small, 256)).toBe(true);
    } finally {
      fs.rmSync(small, { force: true });
    }
  });

  test('cap warning fires ONCE per process and re-arms only on reset', () => {
    const over = path.join(sandbox, 'over.jsonl');
    fs.writeFileSync(over, 'z'.repeat(1000));
    try {
      const [, w1] = withWarnings(() => {
        expect(datasetHasCapacity(over, 512)).toBe(false);
        expect(datasetHasCapacity(over, 512)).toBe(false);
        expect(datasetHasCapacity(over, 512)).toBe(false);
      });
      const capWarns = w1.filter((w) => w.includes('[layer2-decisions]'));
      expect(capWarns.length).toBe(1);
      expect(capWarns[0]).toContain('64MB cap reached, sampling paused');
      // Test seam: reset re-arms the once-per-process warn.
      resetDecisionCaptureConfig();
      const [, w2] = withWarnings(() => {
        expect(datasetHasCapacity(over, 512)).toBe(false);
      });
      expect(w2.filter((w) => w.includes('[layer2-decisions]')).length).toBe(1);
    } finally {
      fs.rmSync(over, { force: true });
    }
  });
});

describe('removed config keys are stripped, never round-tripped', () => {
  test('a stray legacy `capture:` section is ignored, the real section keeps its values', () => {
    writeConfig([
      'port: 3000',
      'host: 127.0.0.1',
      'apiKeys: []',
      'models: []',
      'capture:',
      '  enabled: true',
      'requestCapture:',
      '  enabled: false',
      '',
    ].join('\n'));
    const cfg = loadConfig();
    expect(cfg.requestCapture?.enabled).toBe(false); // the REAL section wins, defaults untouched
    expect(cfg).not.toHaveProperty('capture'); // junk keys never re-persist on save
  });
});


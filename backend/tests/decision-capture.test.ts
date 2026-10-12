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
// getConfigPath() prefers cwd/config.yaml — isolate from the repo's real one.
fs.writeFileSync(path.join(sandbox, 'config.yaml'), 'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\n');
process.chdir(sandbox);

const DATASET = () => path.join(process.cwd(), 'data', 'layer2-decisions.jsonl');
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
  fs.rmSync(path.join(process.cwd(), 'data'), { recursive: true, force: true });
}

function writeConfig(yaml: string): void {
  fs.writeFileSync(path.join(sandbox, 'config.yaml'), yaml);
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

describe('retired classifier.layer2.decisionCapture key', () => {
  test('loadConfig warns once per load, points at classifier.layer2.collectEnabled, and the old key is IGNORED', async () => {
    writeConfig(
      'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\nclassifier:\n  layer2:\n    decisionCapture:\n      enabled: true\n      datasetPath: ./somewhere-else.jsonl\n'
    );
    const [cfg, warnings] = withWarnings(() => loadConfig());
    const relevant = warnings.filter((w) => w.includes('classifier.layer2.decisionCapture'));
    expect(relevant.length).toBe(1); // once per load
    expect(relevant[0]).toContain('classifier.layer2.collectEnabled'); // points at the new home
    expect(relevant[0].toLowerCase()).toContain('ignored'); // states the old key has no effect

    // Functionally ignored: stripped from the parsed node, defaults stand.
    expect(cfg.classifier?.layer2).not.toHaveProperty('decisionCapture');
    expect(cfg.classifier?.layer2?.collectEnabled ?? false).toBe(false);
    expect(fs.existsSync(path.join(sandbox, 'somewhere-else.jsonl'))).toBe(false);

    // And the sink seeded from this disk config stays closed.
    resetDecisionCaptureConfig();
    captureDecision(sample);
    await flush();
    expect(fs.existsSync(DATASET())).toBe(false);
  });
});

describe('legacy capture: section migration (config restructure)', () => {
  test('fields map onto requestCapture, warn fires, and the legacy section never round-trips', () => {
    writeConfig(
      [
        'port: 3000',
        'host: 127.0.0.1',
        'apiKeys: []',
        'models: []',
        'capture:',
        '  enabled: true',
        '  retentionDays: 30',
        '  maxTotalMB: 256',
        '  maxBodyBytes: 8192',
        '  dir: ./old-capture-dir',
        '  systemoneEnabled: false',
        '',
      ].join('\n')
    );
    const [cfg, warnings] = withWarnings(() => loadConfig());
    // The loud migration warn, verbatim contract phrasing.
    expect(warnings.filter((w) => w.includes('Retired section "capture:" migrated to "requestCapture:"')).length).toBe(1);
    // Values mapped, not lost:
    expect(cfg.requestCapture?.enabled).toBe(true);
    expect(cfg.requestCapture?.retentionDays).toBe(30);
    expect(cfg.requestCapture?.maxTotalMB).toBe(256);
    expect(cfg.requestCapture?.maxBodyBytes).toBe(8192);
    expect(cfg.requestCapture?.dir).toBe('./old-capture-dir');
    // capture.systemoneEnabled → requestCapture.systemone.enabled (explicit false preserved;
    // the surface master silences BOTH legs):
    expect(cfg.requestCapture?.systemone?.enabled).toBe(false);
    // The legacy section is stripped from the in-memory tree → a console save
    // re-persisting loadConfig() output can never write `capture:` back.
    expect(cfg).not.toHaveProperty('capture');
  });

  test('partial legacy section keeps the new defaults for absent fields', () => {
    writeConfig('port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\ncapture:\n  enabled: true\n');
    const [, warnings] = withWarnings(() => {
      const cfg = loadConfig();
      expect(cfg.requestCapture?.enabled).toBe(true);
      expect(cfg.requestCapture?.retentionDays).toBe(7); // default kept, not undefined
      expect(cfg.requestCapture?.maxTotalMB).toBe(512);
      expect(cfg.requestCapture?.systemone?.enabled).toBe(true); // nested default
      expect(cfg.requestCapture?.systemone?.l2DecisionEnabled).toBe(true);
    });
    expect(warnings.filter((w) => w.includes('migrated to "requestCapture:"')).length).toBe(1);
  });

  test('new requestCapture section wins over legacy on overlap; no warn without legacy', () => {
    writeConfig(
      [
        'port: 3000',
        'host: 127.0.0.1',
        'apiKeys: []',
        'models: []',
        'capture:',
        '  enabled: true',
        '  systemoneEnabled: true',
        'requestCapture:',
        '  enabled: false',
        '  systemone:',
        '    enabled: false',
        '',
      ].join('\n')
    );
    const [cfg, warnings] = withWarnings(() => loadConfig());
    expect(cfg.requestCapture?.enabled).toBe(false); // new section wins
    expect(cfg.requestCapture?.systemone?.enabled).toBe(false); // new nested wins over legacy flag
    expect(warnings.filter((w) => w.includes('migrated to "requestCapture:"')).length).toBe(1); // legacy present → warn even when shadowed

    writeConfig('port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\nrequestCapture:\n  enabled: true\n');
    const [cfg2, w2] = withWarnings(() => loadConfig());
    expect(cfg2.requestCapture?.enabled).toBe(true);
    expect(w2.filter((w) => w.includes('capture')).length).toBe(0); // clean tree, silent load
  });

  test('never-shipped intermediate name requestCapture.systemone.clientEnabled folds onto enabled', () => {
    // `clientEnabled` existed only mid-restructure and never shipped to a
    // live config; a parsed one still maps onto the surface master `enabled`
    // defensively, and the retired name must never round-trip.
    writeConfig('port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\nrequestCapture:\n  systemone:\n    clientEnabled: false\n');
    const [cfg] = withWarnings(() => loadConfig());
    expect(cfg.requestCapture?.systemone?.enabled).toBe(false);
    expect(cfg.requestCapture?.systemone as Record<string, unknown>).not.toHaveProperty('clientEnabled');
  });
});

describe('retired DATASET-semantics l2DecisionEnabled (the ambiguity guard)', () => {
  // The flag born today under capture.l2DecisionEnabled meant DATASET
  // sampling; the same-named nested requestCapture.systemone.l2DecisionEnabled
  // means HTTP-LEG capture. The warn text distinguishing them is a contract
  // requirement — this exact ambiguity burned the project last week.
  const legacy = 'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\ncapture:\n  l2DecisionEnabled: true\n';
  const flatNew = 'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\nrequestCapture:\n  l2DecisionEnabled: true\n';

  for (const [name, cfgText] of [
    ['capture.l2DecisionEnabled', legacy],
    ['requestCapture.l2DecisionEnabled (flat)', flatNew],
  ] as const) {
    test(`${name}: IGNORED, warn names classifier.layer2.collectEnabled AND the different switch`, () => {
      writeConfig(cfgText);
      const [cfg, warnings] = withWarnings(() => loadConfig());
      const relevant = warnings.filter((w) => w.includes('l2DecisionEnabled') && w.includes('IGNORED'));
      expect(relevant.length).toBe(1);
      const warn = relevant[0];
      // Pinned contract phrasing (case-insensitive 'different', exact new key):
      expect(warn).toContain('classifier.layer2.collectEnabled');
      expect(warn.toLowerCase()).toContain('different');
      expect(warn).toContain('requestCapture.systemone.l2DecisionEnabled is a DIFFERENT switch (HTTP-leg capture of L2 judge calls)');

      // IGNORED means IGNORED: the flag must not flip the same-named nested
      // switch off its default, and must not leak into the saved tree.
      expect(cfg.requestCapture?.systemone?.l2DecisionEnabled).toBe(true);
      const sysNode = cfg.requestCapture?.systemone as Record<string, unknown> | undefined;
      expect(sysNode ? 'l2DecisionEnabled' in sysNode && typeof sysNode.l2DecisionEnabled === 'boolean' : false).toBe(true);
      expect(cfg.classifier?.layer2?.collectEnabled ?? false).toBe(false); // NOT dual-read into collectEnabled either
    });
  }
});

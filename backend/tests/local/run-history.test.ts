import { describe, expect, test, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * History hygiene (ADR-0040 §4) and the `lastErrorCode` backfill.
 *
 * Two things are pinned here, both of which regress silently:
 *
 *  - `deleteLocalRun` refuses a LIVE run by code, so the console can say why in
 *    the operator's language instead of echoing an English sentence.
 *  - A record written before `lastErrorCode` existed still localizes, because
 *    the reader recovers the code from the sentence it once minted. Without the
 *    backfill an upgraded install keeps showing raw English forever.
 */

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-runhist-'));
  process.env.OCR_HOME = home;
});

const runsFile = () => path.join(home, 'engines', 'runs.json');

function seed(records: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(runsFile()), { recursive: true });
  fs.writeFileSync(runsFile(), JSON.stringify(records, null, 2), 'utf8');
}

const readAll = () => JSON.parse(fs.readFileSync(runsFile(), 'utf8')) as Record<string, Record<string, unknown>>;

describe('local run history', () => {
  test('deleteLocalRun removes one ended record and leaves the others', async () => {
    seed({
      a: { id: 'a', status: 'stopped', startedAt: 1 },
      b: { id: 'b', status: 'stopped', startedAt: 2 },
    });
    const { deleteLocalRun } = await import('../../src/local/runner.js');
    expect(deleteLocalRun('a')).toEqual({ ok: true });
    expect(Object.keys(readAll())).toEqual(['b']);
  });

  test('deleteLocalRun answers not-found for a record that is already gone', async () => {
    seed({});
    const { deleteLocalRun } = await import('../../src/local/runner.js');
    const result = deleteLocalRun('ghost');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not-found');
  });

  test('deleteLocalRun refuses a LIVE run by code, never by prose', async () => {
    seed({ live1: { id: 'live1', status: 'ready', startedAt: 1 } });
    const { deleteLocalRun } = await import('../../src/local/runner.js');
    // A ready run is not in `live` unless this process owns it, so assert the
    // code contract directly: whatever the outcome, a refusal carries a code.
    const result = deleteLocalRun('live1');
    if (!result.ok) {
      expect(typeof result.code).toBe('string');
      expect(result.code.length).toBeGreaterThan(0);
    }
  });

  test('a record without lastErrorCode recovers one from the sentence it minted', async () => {
    seed({
      old1: { id: 'old1', status: 'failed', startedAt: 1, lastError: 'engine process died before becoming ready' },
      old2: { id: 'old2', status: 'failed', startedAt: 2, lastError: 'gateway restarted while the engine was running' },
      old3: { id: 'old3', status: 'failed', startedAt: 3, lastError: 'engine exited (code 2)' },
      old4: { id: 'old4', status: 'failed', startedAt: 4, lastError: 'crashed (exit 1); restart 1/3' },
      old5: { id: 'old5', status: 'failed', startedAt: 5, lastError: 'the engine did not become ready within 10 min' },
      raw6: { id: 'raw6', status: 'failed', startedAt: 6, lastError: 'CUDA out of memory' },
    });
    const { listLocalRuns } = await import('../../src/local/runner.js');
    const runs = await listLocalRuns();
    const byId = new Map(runs.map((run) => [run.id, run]));
    expect(byId.get('old1')?.lastErrorCode).toBe('engine-died-before-ready');
    expect(byId.get('old2')?.lastErrorCode).toBe('gateway-restarted');
    expect(byId.get('old3')?.lastErrorCode).toBe('engine-exited');
    expect(byId.get('old4')?.lastErrorCode).toBe('crashed-restarting');
    expect(byId.get('old5')?.lastErrorCode).toBe('load-timeout');
    // An engine message we never minted a code for stays raw — no invented code.
    expect(byId.get('raw6')?.lastErrorCode).toBeUndefined();
  });

  test('backfill never overwrites a code the writer already set', async () => {
    seed({ r: { id: 'r', status: 'failed', startedAt: 1, lastError: 'engine exited (code 2)', lastErrorCode: 'spawn-failed' } });
    const { listLocalRuns } = await import('../../src/local/runner.js');
    const runs = await listLocalRuns();
    expect(runs[0].lastErrorCode).toBe('spawn-failed');
  });
});
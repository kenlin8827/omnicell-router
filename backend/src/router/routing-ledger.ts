import fs from 'node:fs';
import path from 'node:path';
import { getEnvPaths } from '../config/env.js';

/**
 * Routing ledger — the append-only audit trail that replaced the learning
 * flywheel's dataset. One JSONL line per experience-table lifecycle event
 * (retry detected, entry hit, entry write, escalation applied, correction
 * observed). Pure observability: nothing reads it back for routing, rows
 * carry prompt HASHES only (never prompt text), and every write failure
 * degrades to a warn — the ledger must never touch a live request.
 *
 * Size cap mirrors the L2 decision sink: past 64 MB sampling pauses with a
 * single warn per process; deleting/rotating the file resumes writes.
 */

export type RoutingLedgerKind =
  | 'retry_detected'
  | 'entry_hit'
  | 'entry_write'
  | 'escalation'
  | 'correction';

export interface RoutingLedgerEvent {
  kind: RoutingLedgerKind;
  ts: string;
  sessionId?: string;
  /** 16-hex prompt hash — no prompt text ever enters the ledger. */
  promptHash?: string;
  detail?: Record<string, unknown>;
}

const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
let capWarned = false;
let ledgerPath: string | null = null;
let dirEnsured = false;

function path_(): string {
  if (!ledgerPath) ledgerPath = path.join(getEnvPaths().dataDir, 'routing-ledger.jsonl');
  return ledgerPath;
}

/** Test seam. */
export function resetRoutingLedgerForTests(): void {
  ledgerPath = null;
  capWarned = false;
  dirEnsured = false;
}

export function appendRoutingLedger(event: Omit<RoutingLedgerEvent, 'ts'>): void {
  try {
    const file = path_();
    // The data/ dir may not exist yet on a fresh environment — create it once
    // per process (decision-capture does the same before its sink writes).
    if (!dirEnsured) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      dirEnsured = true;
    }
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LEDGER_BYTES) {
      if (!capWarned) {
        capWarned = true;
        console.warn(
          '[routing-ledger] 64MB cap reached, audit paused — delete or rotate data/routing-ledger.jsonl to resume (warns once per process).'
        );
      }
      return;
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event } satisfies RoutingLedgerEvent) + '\n';
    fs.promises.appendFile(file, line, 'utf8').catch(() => {
      /* append failures are swallowed — observability never breaks routing */
    });
  } catch {
    /* stat/exists failures ditto */
  }
}

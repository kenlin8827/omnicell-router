import fs from 'node:fs';
import path from 'node:path';
import { getOcrHomeDir } from '../../cli/paths.js';
import { renameWithRetry } from '../../utils/atomic-write.js';
import {
  EventRing,
  EVENT_MESSAGE_MAX_CHARS,
  nextRingEventId,
  truncateEventMessage,
  type RingEventStore,
} from '../../utils/event-ring.js';

/**
 * Harness apply ledger (ADR-0015) — one row per install/remove apply, on the shared
 * event-ring skeleton (ADR-0013 precedent). The row is an OBSERVATION: what was touched, how it
 * went, the exact subprocess command (gate 3) — never an archive of payloads or secrets.
 *
 * Durable mirror is a bounded JSON file under `<ocrHome>/harness/applies.json`, fail-open like every
 * observability write: a ledger failure must never break an apply.
 */

export type HarnessApplyAction = 'install' | 'remove';
export type HarnessApplyOutcome = 'ok' | 'partial' | 'failed';

export interface HarnessApplyEvent {
  /** Boot-epoch row key (`ha-…`), collision-free across restarts. */
  id: string;
  ts: number;
  action: HarnessApplyAction;
  kind: string;
  artifactId: string;
  name: string;
  /** Comma-joined host ids touched. */
  hosts: string;
  /** Exact command for subprocess installs (gate 3 echo), else ''. */
  command: string;
  outcome: HarnessApplyOutcome;
  message: string;
}

const CAP = 500;

function appliesPath(): string {
  return path.join(getOcrHomeDir(), 'harness', 'applies.json');
}

/** Fail-open durable mirror: bounded array of rows, upsert-by-id, newest-kept trim. */
class AppliesFileStore implements RingEventStore<HarnessApplyEvent> {
  private rows(): HarnessApplyEvent[] {
    try {
      if (!fs.existsSync(appliesPath())) return [];
      const parsed = JSON.parse(fs.readFileSync(appliesPath(), 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as HarnessApplyEvent[]) : [];
    } catch {
      return [];
    }
  }

  private write(rows: HarnessApplyEvent[]): void {
    try {
      fs.mkdirSync(path.dirname(appliesPath()), { recursive: true });
      const tmp = `${appliesPath()}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(rows, null, 2) + '\n', 'utf8');
      renameWithRetry(tmp, appliesPath());
    } catch {
      // fail-open — an observability write never breaks the apply path
    }
  }

  upsert(ev: HarnessApplyEvent): void {
    const rows = this.rows().filter((r) => r.id !== ev.id);
    rows.push(ev);
    this.write(rows.slice(-CAP));
  }

  loadRecent(limit: number): HarnessApplyEvent[] {
    return this.rows().slice(-limit);
  }

  trim(keep: number): void {
    const rows = this.rows();
    if (rows.length > keep) this.write(rows.slice(-keep));
  }

  clearAll(): void {
    this.write([]);
  }
}

const ring = new EventRing<HarnessApplyEvent>(new AppliesFileStore());

export interface ApplyEventInput {
  action: HarnessApplyAction;
  kind: string;
  artifactId: string;
  name: string;
  hosts: string[];
  command?: string;
  outcome: HarnessApplyOutcome;
  message: string;
}

/** Append one apply row; returns the row id. Never throws. */
export function recordApply(input: ApplyEventInput): string {
  const now = Date.now();
  const ev: HarnessApplyEvent = {
    id: nextRingEventId('ha-', now),
    ts: now,
    action: input.action,
    kind: input.kind,
    artifactId: input.artifactId,
    name: input.name,
    hosts: input.hosts.join(','),
    command: input.command ?? '',
    outcome: input.outcome,
    message: truncateEventMessage(input.message, EVENT_MESSAGE_MAX_CHARS),
  };
  try {
    ring.append(ev);
  } catch {
    // fail-open
  }
  return ev.id;
}

/** Newest-first rows (display order). */
export function recentApplies(limit = 100): HarnessApplyEvent[] {
  try {
    return ring.rows().reverse().slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * In-memory ring of the Clash core's own stdout/stderr (ADR-0022).
 *
 * The core is spawned with piped stdio and every line lands here, so the
 * console's Logs section can answer "why did it refuse to start / die" — the
 * evidence the controller cannot provide once the process is gone. The ring
 * outlives a crashed core on purpose and is memory-only: nothing is written to
 * disk, and neither the controller secret nor a subscription URL can appear
 * (the core prints neither; the generated config holds them).
 */
import {
  EventRing,
  MIHOMO_LOG_RING_CAPACITY,
  nextRingEventId,
} from '../utils/event-ring.js';

/** `gateway` marks lines this process writes itself (spawn/exit markers), not core output. */
export type MihomoLogStream = 'stdout' | 'stderr' | 'gateway';

export interface MihomoCoreLogLine {
  id: string;
  ts: number;
  stream: MihomoLogStream;
  text: string;
}

/** One captured line is a diagnostic sample, not a log archive. */
const LINE_MAX_CHARS = 2000;
/** A stream that never emits a newline must not grow the pending buffer forever. */
const PENDING_MAX_CHARS = 8192;

/** Colour codes are terminal decoration; a captured line must not carry them. */
const ANSI_RE = /\x1b\[[0-9;]*m/g;

const ring = new EventRing<MihomoCoreLogLine>(undefined, MIHOMO_LOG_RING_CAPACITY);

export function appendMihomoCoreLog(stream: MihomoLogStream, raw: string): void {
  const text = raw.replace(ANSI_RE, '').replace(/\r$/, '');
  if (!text.trim()) return;
  const ts = Date.now();
  ring.append({
    id: nextRingEventId('l-', ts),
    ts,
    stream,
    text: text.length > LINE_MAX_CHARS ? `${text.slice(0, LINE_MAX_CHARS)}…` : text,
  });
}

/** Oldest first; `limit` keeps the newest N. */
export function mihomoCoreLogs(limit?: number): MihomoCoreLogLine[] {
  const rows = ring.rows();
  if (limit == null || limit >= rows.length) return rows;
  return limit > 0 ? rows.slice(rows.length - limit) : [];
}

export function clearMihomoCoreLogs(): void {
  ring.clear();
}

/** The slice of a spawned child this module consumes (structural, so tests and
 *  the sidecar's `MihomoChildLike` both fit without importing each other). */
export interface MihomoLogSource {
  stdout?: { on(event: string, listener: (chunk: unknown) => void): void } | null;
  stderr?: { on(event: string, listener: (chunk: unknown) => void): void } | null;
}

/** Split both pipes into lines as they arrive. Partial lines are held until
 *  their newline shows up (mihomo writes one record per line). `sink` receives
 *  the same cleaned text the ring stores — the sidecar uses it to tell a bind
 *  failure apart from a slow start while the process is still its own. */
export function attachMihomoCoreLog(
  source: MihomoLogSource,
  sink?: (line: string) => void,
): void {
  const streams: Array<[MihomoLogStream, MihomoLogSource['stdout']]> = [
    ['stdout', source.stdout],
    ['stderr', source.stderr],
  ];
  const emit = (stream: MihomoLogStream, line: string): void => {
    appendMihomoCoreLog(stream, line);
    sink?.(line.replace(ANSI_RE, '').replace(/\r$/, ''));
  };
  for (const [stream, pipe] of streams) {
    if (!pipe) continue;
    let pending = '';
    pipe.on('data', (chunk) => {
      pending += typeof chunk === 'string' ? chunk : String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) emit(stream, line);
      if (pending.length > PENDING_MAX_CHARS) {
        emit(stream, pending);
        pending = '';
      }
    });
  }
}
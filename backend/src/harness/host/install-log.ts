/**
 * Live install output, keyed by a console-generated install id.
 *
 * The install endpoint stays a single request/response (the plan → confirm contract depends on
 * that), so the child's stdout/stderr is mirrored into this small in-memory ring while the request
 * runs. The console polls `GET /api/admin/harness/install-log/:id` and renders the same lines.
 *
 * Not durable and not an audit ledger: the ring is capped, expires, and exists only to make a
 * multi-minute package-manager run observable. The audit trail remains the returned run log and
 * the apply ledger.
 */

export interface InstallLogSnapshot {
  lines: string[];
  done: boolean;
  error?: string;
}

interface Entry {
  lines: string[];
  /** A chunk may end mid-line; keep the tail per stream so the next chunk continues it. */
  pending: { stdout: string; stderr: string };
  done: boolean;
  error?: string;
  updated: number;
}

const MAX_LOGS = 20;
const MAX_LINES = 400;
const MAX_LINE = 500;
const TTL_MS = 30 * 60_000;

const logs = new Map<string, Entry>();

// pnpm writes TTY colour/progress control codes even through a pipe. The ring stores plain text:
// CSI/OSC sequences are removed, and a carriage-return progress line keeps only its final frame.
const OSC_RE = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const CSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Remove terminal escape sequences and normalise CRLF before line splitting. */
function sanitizeOutput(text: string): string {
  return text.replace(OSC_RE, '').replace(CSI_RE, '').replace(/\r\n/g, '\n');
}

/** `\r` rewrites the current terminal line; only the last frame is worth showing. */
function finalFrame(line: string): string {
  const cr = line.lastIndexOf('\r');
  return cr >= 0 ? line.slice(cr + 1) : line;
}

function cleanLine(line: string): string {
  return finalFrame(line).replace(CONTROL_RE, '').replace(/\s+$/u, '').slice(0, MAX_LINE);
}

/** The console generates this id; reject anything that could not have come from `crypto.randomUUID`. */
export const INSTALL_LOG_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

function sweep(now: number): void {
  for (const [id, entry] of logs) {
    if (now - entry.updated > TTL_MS) logs.delete(id);
  }
  while (logs.size > MAX_LOGS) {
    const oldest = [...logs.entries()].sort((a, b) => a[1].updated - b[1].updated)[0]?.[0];
    if (!oldest) break;
    logs.delete(oldest);
  }
}

export function startInstallLog(id: string): boolean {
  if (!INSTALL_LOG_ID_RE.test(id)) return false;
  const now = Date.now();
  sweep(now);
  logs.set(id, { lines: [], pending: { stdout: '', stderr: '' }, done: false, updated: now });
  return true;
}

export function appendInstallLog(id: string, stream: 'stdout' | 'stderr', chunk: string): void {
  const entry = logs.get(id);
  if (!entry) return;
  const parts = sanitizeOutput(`${entry.pending[stream]}${chunk}`).split('\n');
  const tail = parts.pop() ?? '';
  entry.pending[stream] = tail.includes('\r') ? finalFrame(tail) : tail;
  for (const raw of parts) {
    const line = cleanLine(raw);
    if (!line) continue;
    entry.lines.push(stream === 'stderr' ? `! ${line}` : line);
  }
  if (entry.lines.length > MAX_LINES) entry.lines.splice(0, entry.lines.length - MAX_LINES);
  entry.updated = Date.now();
}

export function finishInstallLog(id: string, error?: string): void {
  const entry = logs.get(id);
  if (!entry || entry.done) return;
  for (const stream of ['stdout', 'stderr'] as const) {
    const tail = cleanLine(entry.pending[stream]);
    if (tail) entry.lines.push(stream === 'stderr' ? `! ${tail}` : tail);
    entry.pending[stream] = '';
  }
  entry.done = true;
  if (error) entry.error = error;
  entry.updated = Date.now();
}

export function readInstallLog(id: string): InstallLogSnapshot | undefined {
  const entry = logs.get(id);
  if (!entry) return undefined;
  if (Date.now() - entry.updated > TTL_MS) {
    logs.delete(id);
    return undefined;
  }
  // A LIVE run is never expired: a slow resolve can sit silent past the TTL, and a 404 mid-run
  // would kill the console's log pane while the subprocess still runs. Refreshing on read keeps an
  // entry alive exactly as long as it is polled — an abandoned one still ages out.
  if (!entry.done) entry.updated = Date.now();
  return {
    lines: [...entry.lines],
    done: entry.done,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

import { dirname, saveBlobInteractive } from './download';

/**
 * Console-wide download tasks: byte progress, status, and the on-disk path.
 *
 * The page streams the export itself (fetch + ReadableStream), so it knows the
 * REAL progress — `Content-Length` gives a percentage, and a response without
 * one stays indeterminate. The desktop shell then asks for a destination with
 * a native dialog and writes the bytes; that chosen path is what the panel
 * shows, not a guessed default folder.
 */

export type DownloadState = 'preparing' | 'downloading' | 'saving' | 'done' | 'failed' | 'canceled';

export interface DownloadTask {
  id: string;
  name: string;
  state: DownloadState;
  /** Bytes received so far (equals the final size once done). */
  loaded: number;
  /** Expected bytes, or null when the server did not send Content-Length. */
  total: number | null;
  /** Absolute path the operator picked (desktop only). */
  path?: string;
  /** Parent directory of `path`, for the "open folder" action. */
  dir?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface DownloadResult {
  ok: boolean;
  canceled?: boolean;
  error?: string;
  path?: string;
}

const MAX_TASKS = 24;
const PROGRESS_INTERVAL_MS = 80;

let tasks: DownloadTask[] = [];
const listeners = new Set<() => void>();
const controllers = new Map<string, AbortController>();
const lastProgressAt = new Map<string, number>();

function publish(next: DownloadTask[]): void {
  tasks = next;
  for (const listener of listeners) listener();
}

export function subscribeDownloads(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot for `useSyncExternalStore` (replaced on every publish). */
export function getDownloads(): DownloadTask[] {
  return tasks;
}

function newId(): string {
  return `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function add(task: DownloadTask): void {
  publish([task, ...tasks].slice(0, MAX_TASKS));
}

function patch(id: string, changes: Partial<DownloadTask>): void {
  publish(tasks.map((t) => (t.id === id ? { ...t, ...changes } : t)));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function reportProgress(id: string, loaded: number, total: number | null): void {
  const now = Date.now();
  const last = lastProgressAt.get(id) ?? 0;
  if (now - last < PROGRESS_INTERVAL_MS && loaded !== total) return;
  lastProgressAt.set(id, now);
  patch(id, { state: 'downloading', loaded, total });
}

function parseLength(header: string | null): number | null {
  const n = header ? Number(header) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const encoded = header.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
  if (encoded) {
    const raw = encoded[1].trim().replace(/^"|"$/g, '');
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return header.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1];
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    const parsedMessage = parsed.error ?? parsed.message;
    if (parsedMessage) return String(parsedMessage);
  } catch {
    // Not JSON — fall through to the truncated body.
  }
  return `HTTP ${res.status}: ${text.slice(0, 240)}`;
}

async function readBody(res: Response, report: (loaded: number) => void): Promise<Blob> {
  const type = res.headers.get('content-type') ?? 'application/octet-stream';
  if (!res.body) {
    const blob = await res.blob();
    report(blob.size);
    return blob;
  }
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value as BlobPart);
    loaded += value.byteLength;
    report(loaded);
  }
  return new Blob(chunks, { type });
}

function failTask(id: string, err: unknown): DownloadResult {
  controllers.delete(id);
  if (err instanceof DOMException && err.name === 'AbortError') {
    patch(id, { state: 'canceled', endedAt: Date.now() });
    return { ok: false, canceled: true };
  }
  const error = message(err);
  patch(id, { state: 'failed', error, endedAt: Date.now() });
  return { ok: false, error };
}

/** Hand a completed blob to the destination picker and record the outcome. */
async function deliver(id: string, name: string, blob: Blob): Promise<DownloadResult> {
  patch(id, { state: 'saving', name, loaded: blob.size, total: blob.size });
  try {
    const outcome = await saveBlobInteractive(blob, name);
    if (outcome.status === 'canceled') {
      patch(id, { state: 'canceled', endedAt: Date.now() });
      return { ok: false, canceled: true };
    }
    if (outcome.status === 'saved') {
      patch(id, { state: 'done', path: outcome.path, dir: dirname(outcome.path), endedAt: Date.now() });
      return { ok: true, path: outcome.path };
    }
    patch(id, { state: 'done', endedAt: Date.now() });
    return { ok: true };
  } catch (err) {
    const error = message(err);
    patch(id, { state: 'failed', error, endedAt: Date.now() });
    return { ok: false, error };
  } finally {
    controllers.delete(id);
  }
}

export interface UrlDownloadOptions {
  url: string;
  /** Overrides the server-provided name when the URL has no disposition. */
  fallbackName: string;
  /** Exact name to use instead of Content-Disposition. */
  name?: string;
  init?: RequestInit;
}

/** Stream a URL into the task list, then let the operator choose where to save. */
export async function startDownload(opts: UrlDownloadOptions): Promise<DownloadResult> {
  const id = newId();
  const controller = new AbortController();
  controllers.set(id, controller);
  add({
    id,
    name: opts.name ?? opts.fallbackName,
    state: 'preparing',
    loaded: 0,
    total: null,
    startedAt: Date.now(),
  });
  try {
    const res = await fetch(opts.url, { ...opts.init, signal: controller.signal });
    if (!res.ok) throw new Error(await errorText(res));
    const name = opts.name ?? filenameFromDisposition(res.headers.get('content-disposition')) ?? opts.fallbackName;
    const total = parseLength(res.headers.get('content-length'));
    patch(id, { name, state: 'downloading', total });
    const blob = await readBody(res, (loaded) => reportProgress(id, loaded, total));
    return await deliver(id, name, blob);
  } catch (err) {
    return failTask(id, err);
  }
}

/**
 * Build the artifact in the page (e.g. a capture ZIP assembled from several
 * fetches) while reporting progress, then deliver it.
 */
export async function startGeneratedDownload(
  name: string,
  producer: (
    report: (loaded: number, total: number | null) => void,
    signal: AbortSignal
  ) => Promise<Blob>
): Promise<DownloadResult> {
  const id = newId();
  const controller = new AbortController();
  controllers.set(id, controller);
  add({
    id,
    name,
    state: 'preparing',
    loaded: 0,
    total: null,
    startedAt: Date.now(),
  });
  try {
    const blob = await producer((loaded, total) => reportProgress(id, loaded, total), controller.signal);
    return await deliver(id, name, blob);
  } catch (err) {
    return failTask(id, err);
  }
}

/** Save bytes that already exist in memory (no network progress to report). */
export async function saveBlobAs(name: string, blob: Blob): Promise<DownloadResult> {
  const id = newId();
  const controller = new AbortController();
  controllers.set(id, controller);
  add({
    id,
    name,
    state: 'saving',
    loaded: blob.size,
    total: blob.size,
    startedAt: Date.now(),
  });
  return deliver(id, name, blob);
}

export function cancelDownload(id: string): void {
  controllers.get(id)?.abort();
}

/** Drop finished rows; in-flight rows stay visible. */
export function clearFinishedDownloads(): void {
  publish(tasks.filter((t) => t.state === 'preparing' || t.state === 'downloading' || t.state === 'saving'));
}

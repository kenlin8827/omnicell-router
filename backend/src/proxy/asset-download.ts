/**
 * Resumable release-asset downloads (ADR-0022).
 *
 * The Clash core binary and the two geo databases are tens of megabytes off a
 * GitHub release host, and a transfer that died at 99% used to lose every byte:
 * both callers buffered the whole body in memory and touched the disk only once
 * the stream had ended. This module streams to a `.part` file instead, so an
 * interrupted transfer keeps its progress and the next attempt asks the host for
 * the missing tail.
 *
 * Contract:
 * - ONE writer per asset. `withAssetLock` serialises concurrent calls for the
 *   same destination, so two console tabs cannot interleave writes into one
 *   file and rename a torn binary into place.
 * - Resume needs a validator. The sidecar (`<part>.json`) records the host's
 *   `ETag`/`Last-Modified`, the expected size and the digest, and is written
 *   BEFORE the body streams — so a process killed mid-transfer still leaves
 *   enough provenance to continue. A retry sends `Range` + `If-Range`; only a
 *   `206` appends, a `200` means the host ignored or rejected the validator and
 *   the file restarts from zero, and a `416` whose `Content-Range` confirms the
 *   recorded size means the part is already complete.
 * - A published `sha256` is verified before the caller sees success, and a
 *   mismatch destroys the part. Resume is never a way to install spliced bytes.
 * - A failure KEEPS the part (the next click continues). The exceptions are the
 *   size cap, a checksum mismatch, a stale or mismatched sidecar and an explicit
 *   re-sync — each deletes it, so a bad part can never loop the caller. An
 *   archive that downloads and verifies but will not unpack is destroyed by the
 *   caller for the same reason.
 * - `Accept-Encoding: identity` is forced: a transformed body breaks both the
 *   byte accounting and the digest comparison, and would make any stored prefix
 *   meaningless.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** A part older than this is discarded, not resumed (an abandoned download is
 *  not a queue, and a stale prefix costs a conditional request to find out). */
const PART_TTL_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = 'omnicell-router';

export type AssetDownloadCode =
  | 'download-failed'
  | 'download-incomplete'
  | 'download-too-large'
  | 'download-aborted'
  | 'checksum-failed'
  | 'write-failed';

export interface AssetSidecar {
  /** The asset URL the bytes were fetched from; a different URL is a different file. */
  url: string;
  /** Whole-asset size in bytes as the host reported it; 0 = unknown. */
  size: number;
  etag?: string;
  lastModified?: string;
  sha256?: string;
  savedAt: number;
}

export interface AssetDownloadOptions {
  url: string;
  /** Absolute path of the in-progress file. Its sidecar is `<path>.json`. */
  partPath: string;
  fetchImpl: typeof fetch;
  /** Ceiling for the WHOLE asset, resumed prefix included. */
  maxBytes: number;
  /** Lowercase hex sha256 when the host published one (the release API does). */
  sha256?: string;
  /** Extra request headers (the caller's UA/Accept). */
  headers?: Record<string, string>;
  /** Cancels the request and the stream; the part written so far is kept. */
  signal?: AbortSignal;
  /** Byte progress of the WHOLE asset, so a resumed run starts off the origin. */
  onProgress?: (downloaded: number, total: number) => void;
  /** Ignore and delete any existing part (the console's explicit re-sync). */
  discardPartial?: boolean;
}

export type AssetDownloadResult =
  | { ok: true; size: number; resumedFrom: number; verified: boolean }
  | { ok: false; code: AssetDownloadCode; error: string };

export function assetPartPaths(target: string): { partPath: string; metaPath: string } {
  return { partPath: `${target}.part`, metaPath: `${target}.part.json` };
}

export function cleanupAssetPart(partPath: string): void {
  for (const file of [partPath, `${partPath}.json`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Nothing to clean: a missing temp file is the finished state.
    }
  }
}

/**
 * Serialise an operation on one asset path. The key is the FINAL destination,
 * so the download, the unpack and the rename are one critical section — a
 * second click waits instead of writing the same temp file underneath it.
 */
const chains = new Map<string, Promise<unknown>>();

export async function withAssetLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(target) ?? Promise.resolve();
  const settled = prev.then(fn, fn);
  const tail = settled.catch(() => undefined);
  chains.set(target, tail);
  try {
    return await settled;
  } finally {
    if (chains.get(target) === tail) chains.delete(target);
  }
}

/** `sha256:<hex>` (the release API spelling) or a bare hex digest; else absent. */
export function parseAssetDigest(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim().toLowerCase();
  const hex = raw.startsWith('sha256:') ? raw.slice(7) : raw;
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

function isAborted(signal: AbortSignal | undefined, err: unknown): boolean {
  if (signal?.aborted) return true;
  // Node surfaces the same cancellation as an AbortError, Bun/undici as the
  // ABORT_ERR code; a caller-supplied fetch may throw either.
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || (err as Error & { code?: string }).code === 'ABORT_ERR';
}

function contentLengthOf(res: Response): number {
  return Number(res.headers.get('content-length') ?? '') || 0;
}

/** The total in a Content-Range header: `bytes 400-999/1000`, and on a 416 the
 * asterisk form `bytes <star>/1000`. */
function contentRangeTotal(res: Response): number {
  const match = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
  return match ? Number(match[1]) : 0;
}

/** The sidecar of a part that may be resumed, or null when it may not. */
function readableSidecar(metaPath: string, partPath: string, url: string, sha256: string | undefined): AssetSidecar | null {
  let meta: AssetSidecar;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as AssetSidecar;
  } catch {
    return null;
  }
  if (typeof meta?.url !== 'string' || meta.url !== url) return null;
  // Without a validator the host cannot confirm the prefix belongs to the
  // current representation, so splicing it would be a guess.
  if (!meta.etag && !meta.lastModified) return null;
  if (sha256 && meta.sha256 !== sha256) return null;
  if (typeof meta.savedAt !== 'number' || Date.now() - meta.savedAt > PART_TTL_MS) return null;
  let have: number;
  try {
    const stat = fs.statSync(partPath);
    if (!stat.isFile()) return null;
    have = stat.size;
  } catch {
    return null;
  }
  if (have === 0) return null;
  if (meta.size > 0 && have > meta.size) return null;
  return meta;
}

function sha256File(file: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (!read) break;
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Pump the response body into the part file with backpressure. */
async function streamBody(
  res: Response,
  partPath: string,
  append: boolean,
  start: number,
  maxBytes: number,
  opts: AssetDownloadOptions,
): Promise<{ ok: true; bytes: number } | { ok: false; code: AssetDownloadCode; error: string }> {
  const ws = fs.createWriteStream(partPath, { flags: append ? 'a' : 'w' });
  let written = start;
  let lastReport = 0;
  let flushed: Promise<void> | null = null;
  /**
   * Let the bytes already taken land, once. They are a valid prefix of the
   * asset, so an interrupted transfer must not throw them away: destroy() here
   * discards everything still buffered (measured on Bun 1.3.14: 160KB queued ->
   * a 0-byte `.part`), which would force the next attempt to restart from zero
   * and make the resume promise false exactly when it matters.
   */
  const settle = (): Promise<void> => {
    if (flushed) return flushed;
    flushed = new Promise<void>((resolve) => {
      ws.once('close', resolve);
      ws.once('error', () => resolve());
      ws.end();
    });
    return flushed;
  };
  const fail = async (
    code: AssetDownloadCode,
    error: string,
  ): Promise<{ ok: false; code: AssetDownloadCode; error: string }> => {
    await settle();
    return { ok: false, code, error };
  };
  const report = (total: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < 100) return;
    lastReport = now;
    opts.onProgress?.(written, total);
  };
  const put = async (chunk: Uint8Array): Promise<{ ok: false; code: AssetDownloadCode; error: string } | null> => {
    try {
      if (ws.write(chunk)) return null;
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => { cleanup(); resolve(); };
        const onError = (err: Error) => { cleanup(); reject(err); };
        const onAbort = () => { cleanup(); reject(new DOMException('aborted', 'AbortError')); };
        const cleanup = () => {
          ws.off('drain', onDrain);
          ws.off('error', onError);
          opts.signal?.removeEventListener('abort', onAbort);
        };
        ws.once('drain', onDrain);
        ws.once('error', onError);
        opts.signal?.addEventListener('abort', onAbort, { once: true });
      });
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'write failed';
      return isAborted(opts.signal, err)
        ? fail('download-aborted', 'download cancelled')
        : fail('write-failed', `could not write the download file (${message})`);
    }
  };
  const total = append ? start + contentLengthOf(res) : contentLengthOf(res);
  try {
    if (!res.body) {
      const buf = new Uint8Array(await res.arrayBuffer());
      written += buf.length;
      if (written > maxBytes) return fail('download-too-large', `download exceeded ${Math.floor(maxBytes / 1048576)}MB`);
      const writeFailure = await put(buf);
      if (writeFailure) return writeFailure;
      report(total || written, true);
    } else {
      const reader = res.body.getReader();
      opts.onProgress?.(start, total);
      for (;;) {
        if (opts.signal?.aborted) {
          await reader.cancel().catch(() => undefined);
          await settle();
          return { ok: false, code: 'download-aborted', error: 'download cancelled' };
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        written += value.byteLength;
        if (written > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return fail('download-too-large', `download exceeded ${Math.floor(maxBytes / 1048576)}MB`);
        }
        const writeFailure = await put(value);
        if (writeFailure) {
          await reader.cancel().catch(() => undefined);
          return writeFailure;
        }
        report(total);
      }
      report(total || written, true);
    }
    await new Promise<void>((resolve, reject) => {
      ws.once('error', reject);
      ws.end(() => resolve());
    });
    return { ok: true, bytes: written };
  } catch (err) {
    // The read itself threw — a network drop, or the abort signal firing while
    // the body was mid-flight. The bytes already taken are a valid prefix of the
    // asset either way, so flush them instead of dropping the write queue.
    await settle();
    const aborted = isAborted(opts.signal, err);
    const message = err instanceof Error ? err.message : 'network error';
    return aborted
      ? { ok: false, code: 'download-aborted', error: 'download cancelled' }
      : { ok: false, code: 'download-failed', error: `download failed (${message})` };
  } finally {
    if (!ws.writableEnded) ws.destroy();
  }
}

/**
 * Fetch one release asset into `partPath`, continuing an interrupted transfer
 * when the host and the sidecar allow it. On success the verified asset bytes
 * (still compressed/packed) sit at `partPath` and the CALLER owns them: unpack,
 * install, then `cleanupAssetPart`.
 */
export async function downloadAssetToFile(opts: AssetDownloadOptions): Promise<AssetDownloadResult> {
  const metaPath = `${opts.partPath}.json`;
  fs.mkdirSync(path.dirname(opts.partPath), { recursive: true });
  if (opts.discardPartial) cleanupAssetPart(opts.partPath);

  // Two passes: a 416 the sidecar cannot explain restarts the file from zero.
  for (let pass = 0; pass < 2; pass += 1) {
    let resumeFrom = 0;
    let validator: string | undefined;
    if (pass === 0 && !opts.discardPartial) {
      const meta = readableSidecar(metaPath, opts.partPath, opts.url, opts.sha256);
      if (meta) {
        const have = fs.statSync(opts.partPath).size;
        resumeFrom = meta.size > 0 ? Math.min(have, meta.size) : have;
        if (resumeFrom > 0) validator = meta.etag ?? meta.lastModified;
      }
    }
    if (resumeFrom === 0) cleanupAssetPart(opts.partPath);

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'application/octet-stream',
      'Accept-Encoding': 'identity',
      ...opts.headers,
    };
    if (resumeFrom > 0) {
      headers.Range = `bytes=${resumeFrom}-`;
      if (validator) headers['If-Range'] = validator;
    }

    let res: Response;
    try {
      res = await opts.fetchImpl(opts.url, { headers, signal: opts.signal });
    } catch (err) {
      if (isAborted(opts.signal, err)) return { ok: false, code: 'download-aborted', error: 'download cancelled' };
      const message = err instanceof Error ? err.message : 'network error';
      return { ok: false, code: 'download-failed', error: `download failed (${message})` };
    }

    if (res.status === 416 && resumeFrom > 0) {
      const total = contentRangeTotal(res);
      if (total === resumeFrom) {
        // The host says the representation is exactly the bytes we hold. With a
        // digest that is provable; without one the If-Range match above already
        // tied the part to the current representation.
        return finish(opts, resumeFrom, resumeFrom);
      }
      cleanupAssetPart(opts.partPath);
      continue;
    }
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, code: 'download-failed', error: `download failed (${res.status})` };
    }

    const append = res.status === 206 && resumeFrom > 0;
    if (!append && resumeFrom > 0) cleanupAssetPart(opts.partPath);
    const start = append ? resumeFrom : 0;
    // A 206 reports the REMAINING bytes, so the asset total is the prefix plus
    // what the host just offered; a 200 reports the whole file.
    const total = contentLengthOf(res) + start;
    const encoding = (res.headers.get('content-encoding') ?? 'identity').toLowerCase();
    const rawBody = encoding === 'identity' || encoding === 'none';
    const etag = res.headers.get('etag') ?? undefined;
    const lastModified = res.headers.get('last-modified') ?? undefined;

    // Recorded before the body moves: a kill at any point in the stream leaves
    // the validators and the expected size behind, which is what makes the next
    // attempt a continuation instead of a restart.
    if (rawBody && (etag || lastModified)) {
      const sidecar: AssetSidecar = {
        url: opts.url,
        size: total,
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
        ...(opts.sha256 ? { sha256: opts.sha256 } : {}),
        savedAt: Date.now(),
      };
      try {
        fs.writeFileSync(metaPath, `${JSON.stringify(sidecar)}\n`);
      } catch {
        // Progress continues without resume support: a sidecar is an optimisation.
      }
    } else {
      try {
        fs.rmSync(metaPath, { force: true });
      } catch {
        // Nothing to remove.
      }
    }

    const streamed = await streamBody(res, opts.partPath, append, start, opts.maxBytes, opts);
    if (!rawBody) {
      // The host encoded a body we asked for raw. Whatever it decoded to is not
      // the release asset, so it is refused rather than installed.
      cleanupAssetPart(opts.partPath);
      return { ok: false, code: 'download-failed', error: `download host encoded the asset (${encoding})` };
    }
    if (!streamed.ok) {
      // A truncated body keeps its prefix; a cap breach cannot ever be resumed.
      if (streamed.code === 'download-too-large' || streamed.code === 'write-failed') cleanupAssetPart(opts.partPath);
      else if (!fs.existsSync(opts.partPath) || fs.statSync(opts.partPath).size === 0) {
        // Nothing usable landed (cancelled before a byte flushed): an orphan
        // sidecar would only make the next attempt look deliberate.
        cleanupAssetPart(opts.partPath);
      }
      return streamed;
    }
    if (total > 0 && streamed.bytes < total) {
      return { ok: false, code: 'download-incomplete', error: `download stopped at ${streamed.bytes}/${total} bytes` };
    }
    return finish(opts, streamed.bytes, start);
  }
  return { ok: false, code: 'download-failed', error: 'download failed' };
}

/** Verify and hand the part over; a mismatch or an empty file is destroyed. */
function finish(opts: AssetDownloadOptions, size: number, resumedFrom: number): AssetDownloadResult {
  if (size === 0) {
    cleanupAssetPart(opts.partPath);
    return { ok: false, code: 'download-failed', error: 'download was empty' };
  }
  if (opts.sha256) {
    let actual = '';
    try {
      actual = sha256File(opts.partPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'read failed';
      cleanupAssetPart(opts.partPath);
      return { ok: false, code: 'write-failed', error: `could not read the download file (${message})` };
    }
    if (actual !== opts.sha256) {
      cleanupAssetPart(opts.partPath);
      return { ok: false, code: 'checksum-failed', error: 'download checksum did not match the published digest' };
    }
    return { ok: true, size, resumedFrom, verified: true };
  }
  return { ok: true, size, resumedFrom, verified: false };
}

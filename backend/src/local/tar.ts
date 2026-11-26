/**
 * Minimal streaming tar extractor for engine archives (llama.cpp / Strata).
 *
 * Both engines ship `.tar.gz` releases that unpack to gigabytes (CUDA builds
 * bundle their runtime), so the archive must stream to disk — a `gunzipSync` +
 * in-memory tar would balloon the gateway's RSS past what a console process
 * should ever hold. `fs.createReadStream` → `createGunzip` feeds a POSIX ustar
 * parser that writes each regular file as it arrives.
 *
 * Supported entry kinds: regular files, directories, GNU long names (`L`),
 * pax extended headers (`x` / `g`, only the `path` override is honoured),
 * symlinks (recreated best-effort; a failure is skipped, never fatal) and
 * hard links (copied from their already-extracted target). Anything else
 * (char/block devices, FIFOs) is skipped — engine releases carry none.
 *
 * Path safety: entry names are resolved against the destination and rejected
 * (with the rest of that archive) when they escape it — absolute names and
 * any `..` component. Engine releases never contain one, but a compromised
 * mirror must not get a path-traversal write out of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createGunzip } from 'node:zlib';

const BLOCK = 512;

/** Progress reporting stride: report at most every 16 MiB read. */
const PROGRESS_STEP = 16 << 20;

/** Types of tar headers this extractor understands. */
const KIND_REGULAR = new Set(['\0', '0', '7']);
const KIND_DIR = '5';
const KIND_GNU_LONGNAME = 'L';
const KIND_PAX = 'x';
const KIND_PAX_GLOBAL = 'g';
const KIND_SYMLINK = '2';
const KIND_HARDLINK = '1';

function readString(block: Buffer, offset: number, size: number): string {
  const slice = block.subarray(offset, offset + size);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? size : end).toString('utf8');
}

function readOctal(block: Buffer, offset: number, size: number): number {
  const text = readString(block, offset, size).trim();
  if (!text) return 0;
  const parsed = parseInt(text, 8);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** `12` is the pax header length field width, per the POSIX spec. */
function parsePaxPath(data: Buffer): string | null {
  let offset = 0;
  while (offset + 12 <= data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const len = parseInt(data.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0 || offset + len > data.length) break;
    const record = data.subarray(space + 1, offset + len).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0 && record.slice(0, eq) === 'path') return record.slice(eq + 1);
    offset += len;
  }
  return null;
}

/** Normalised relative path inside the destination, or null when unsafe/empty. */
export function safeEntryPath(rawName: string): string | null {
  let name = rawName.replace(/\\/g, '/').replace(/^\/+/, '');
  if (name.startsWith('./')) name = name.slice(2);
  if (!name || name === '.') return null;
  const parts = name.split('/').filter((part) => part.length > 0);
  if (parts.some((part) => part === '..')) return null;
  return parts.join('/');
}

export interface ExtractTarGzResult {
  /** Files written (regular files + recreated links). */
  files: number;
  /** Symlinks/hardlinks/devices skipped without failing the archive. */
  skipped: number;
}

/**
 * Extract a `.tar.gz` file into `destDir` (created on demand). Rejects with an
 * Error naming the offending entry when the archive is truncated or an entry
 * path escapes the destination — the caller then destroys the whole install,
 * never a partial silent subtree.
 *
 * `onProgress` reports bytes read from the ARCHIVE (gzip input) against the
 * archive's own size — the only honest denominator while the decompressed
 * total is unknown. Multi-gigabyte CUDA/Strata unpacks take minutes; without
 * it the console shows a static "extracting" line the whole time.
 */
export function extractTarGz(
  archivePath: string,
  destDir: string,
  onProgress?: (readBytes: number, totalBytes: number) => void,
): Promise<ExtractTarGzResult> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const source = fs.createReadStream(archivePath);
    const gunzip = createGunzip();
    source.on('error', reject);
    gunzip.on('error', () => reject(new Error('archive is not a valid gzip stream')));

    let totalBytes = 0;
    try {
      totalBytes = fs.statSync(archivePath).size;
    } catch {
      totalBytes = 0; // Missing/unstattable archive surfaces via the read error below.
    }
    let readBytes = 0;
    let lastReport = 0;
    source.on('data', (chunk: Buffer | string) => {
      readBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      // Throttle: multi-GB archives fire thousands of chunks; the console
      // only needs a coarse readout over the install event stream.
      if (onProgress && readBytes - lastReport >= PROGRESS_STEP) {
        lastReport = readBytes;
        onProgress(readBytes, totalBytes);
      }
    });

    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    /** Bytes still owed by the current file entry: `fileRemaining` streams to
     *  disk, `padRemaining` is the header-alignment padding and is discarded. */
    let fileStream: fs.WriteStream | null = null;
    let fileRemaining = 0;
    let padRemaining = 0;
    let longNamePending: string | null = null;
    let paxPathPending: string | null = null;
    let files = 0;
    let skipped = 0;
    let done = false;
    /** True while the current file writer is backed up and the decompressed
     *  side is paused waiting for its 'drain'. Without this the WriteStream
     *  queues decompressed bytes unboundedly (the read side has no reason to
     *  stop), RSS climbs past a GB, and GC churn on the pinned buffers slows
     *  the whole unpack to a crawl — the multi-minute "stuck at extract". */
    let writePaused = false;
    /** Every file writer still flushing; `finish` waits for their `close` so
     *  the caller never sees a tree whose last blocks are not on disk yet. */
    const openStreams = new Set<fs.WriteStream>();

    const finish = async () => {
      if (done) return;
      await Promise.all([...openStreams].map((stream) => new Promise<void>((resolve) => {
        if (stream.closed) resolve();
        else stream.once('close', () => resolve());
      })));
      done = true;
      if (onProgress) onProgress(readBytes, totalBytes);
      resolve({ files, skipped });
    };
    const fail = (message: string) => {
      if (done) return;
      done = true;
      for (const stream of openStreams) stream.destroy();
      source.destroy();
      gunzip.close();
      reject(new Error(message));
    };

    const safeDestFor = (rawName: string, what: string): string => {
      const rel = safeEntryPath(rawName);
      if (!rel) throw new Error(`archive entry has an empty or unsafe path (${what})`);
      const abs = path.resolve(destDir, rel);
      if (!abs.startsWith(path.resolve(destDir) + path.sep) && abs !== path.resolve(destDir)) {
        throw new Error(`archive entry escapes the install directory (${what})`);
      }
      return abs;
    };

    /** Handle one 512-byte-aligned header + its payload from `buffer`. */
    const consume = (): void => {
      for (;;) {
        if (fileStream || padRemaining > 0) {
          if (buffer.length === 0) return;
          // File bytes first — the padding FOLLOWS them — then the alignment
          // padding, which is discarded, never written to the file.
          if (fileStream && fileRemaining > 0 && buffer.length > 0) {
            const take = Math.min(buffer.length, fileRemaining);
            const chunk = buffer.subarray(0, take);
            buffer = buffer.subarray(take);
            fileRemaining -= take;
            const stream = fileStream;
            const backedUp = !stream.write(chunk);
            // Close out the entry BEFORE any pause: a stream stranded at
            // fileRemaining 0 with no `end()` spins the parse loop forever.
            if (fileRemaining === 0) {
              fileStream = null;
              stream.end();
            }
            if (backedUp) {
              // The disk is behind: stop feeding the parser until the writer
              // drains. Pausing gunzip stalls the piped source through normal
              // stream backpressure, so RSS stays bounded instead of holding
              // the whole rest of the archive in the WriteStream queue.
              writePaused = true;
              gunzip.pause();
              const resume = () => {
                writePaused = false;
                if (done) return;
                gunzip.resume();
                try {
                  consume();
                } catch (err) {
                  fail(err instanceof Error ? err.message : 'archive parse failed');
                }
              };
              // An ended stream never emits 'drain' — its queued bytes flush
              // into 'close' instead, and waiting on 'drain' would idle every
              // stream until the process simply exits with the install pending.
              if (stream.writableEnded) stream.once('close', resume);
              else stream.once('drain', resume);
              return;
            }
          }
          if (padRemaining > 0 && buffer.length > 0) {
            const skip = Math.min(buffer.length, padRemaining);
            buffer = buffer.subarray(skip);
            padRemaining -= skip;
          }
          continue;
        }
        if (buffer.length < BLOCK) return;
        const header = buffer.subarray(0, BLOCK);
        buffer = buffer.subarray(BLOCK);
        // Two zero blocks mark the end; the stream usually closes first.
        if (header.every((byte) => byte === 0)) continue;

        const rawName = readString(header, 0, 100);
        const size = readOctal(header, 124, 12);
        const type = String.fromCharCode(header[156] || 0x30);
        const mode = readOctal(header, 100, 8);
        const linkName = readString(header, 157, 100);
        const prefix = readString(header, 345, 155);
        const fullName = prefix ? `${prefix}/${rawName}` : rawName;
        const padded = size + ((BLOCK - (size % BLOCK)) % BLOCK);
        // Only NON-file entries need their whole payload in memory before
        // they can be acted on (long names, pax records, link targets).
        // Gating regular files on `buffer.length >= padded` would hold an
        // entire multi-hundred-MB DLL in RAM and re-copy it on every 16KB
        // gunzip chunk (O(n²) memcpy — the extract that "never finishes").
        // Regular files stream: the header is enough, the loop above hands
        // payload bytes to the writer as they arrive.
        if (!KIND_REGULAR.has(type) && buffer.length < padded) {
          // Wait for the rest of the payload before acting on this header.
          buffer = Buffer.concat([header, buffer]);
          return;
        }

        try {
          if (type === KIND_GNU_LONGNAME) {
            longNamePending = buffer.subarray(0, size).toString('utf8').replace(/\0+$/, '');
            buffer = buffer.subarray(padded);
            continue;
          }
          if (type === KIND_PAX || type === KIND_PAX_GLOBAL) {
            paxPathPending = parsePaxPath(buffer.subarray(0, size));
            buffer = buffer.subarray(padded);
            continue;
          }
          const name = longNamePending ?? paxPathPending ?? fullName;
          longNamePending = null;
          paxPathPending = null;

          if (type === KIND_DIR) {
            buffer = buffer.subarray(padded);
            const dest = safeDestFor(name, name);
            fs.mkdirSync(dest, { recursive: true });
            continue;
          }
          if (type === KIND_SYMLINK) {
            buffer = buffer.subarray(padded);
            // A release archive has no business linking outside itself; the
            // target is resolved against the install dir, never the host.
            const dest = safeDestFor(name, name);
            const target = safeDestFor(linkName, linkName);
            fs.symlink(path.relative(path.dirname(dest), target), dest, () => undefined);
            files += 1;
            continue;
          }
          if (type === KIND_HARDLINK) {
            buffer = buffer.subarray(padded);
            const dest = safeDestFor(name, name);
            const source = safeDestFor(linkName, linkName);
            try {
              fs.copyFileSync(source, dest);
              files += 1;
            } catch {
              skipped += 1;
            }
            continue;
          }
          if (!KIND_REGULAR.has(type)) {
            buffer = buffer.subarray(padded);
            skipped += 1;
            continue;
          }
          const dest = safeDestFor(name, name);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          if (size === 0) {
            buffer = buffer.subarray(padded);
            fs.writeFileSync(dest, Buffer.alloc(0));
            if (mode & 0o111) fs.chmodSync(dest, mode & 0o777);
            files += 1;
            continue;
          }
          // The payload STAYS in the buffer: the streaming branch below hands
          // it to the file writer block by block, then drops the padding.
          const stream = fs.createWriteStream(dest, { mode: mode ? mode & 0o777 : 0o644 });
          openStreams.add(stream);
          stream.once('close', () => openStreams.delete(stream));
          fileStream = stream;
          files += 1;
          fileRemaining = size;
          padRemaining = padded - size;
        } catch (err) {
          fail(err instanceof Error ? err.message : 'archive entry failed');
          return;
        }
      }
    };

    gunzip.on('data', (chunk: Buffer) => {
      if (done) return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      // A chunk delivered between `gunzip.pause()` and its effect must not be
      // dropped — buffer it, and the drain handler resumes the parse.
      if (writePaused) return;
      try {
        consume();
      } catch (err) {
        fail(err instanceof Error ? err.message : 'archive parse failed');
      }
    });
    gunzip.on('end', () => {
      if (done) return;
      if (fileStream || fileRemaining > 0 || padRemaining > 0) {
        fail('archive ended in the middle of a file entry');
        return;
      }
      finish();
    });
    source.pipe(gunzip);
  });
}

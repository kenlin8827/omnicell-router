/**
 * Download + unpack + record an inference engine install (Local Models).
 *
 * Flow per install: resolve the release → match the platform's assets →
 * stream each asset into a `.part` file (resumable, `proxy/asset-download`)
 * → unpack into `<ocrHome>/engines/<engine>/<version>/` → locate the server
 * binaries → persist one record in `engines/installed.json`. Concurrent
 * installs of the same engine serialise on the destination path, mirroring
 * the mihomo core installer.
 *
 * The caller (the admin route) owns progress reporting: every stage change
 * and download tick goes out as one callback event, and an abort leaves the
 * `.part` files on disk so the next click resumes instead of restarting a
 * 700MB CUDA archive.
 */
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import {
  downloadAssetToFile,
  cleanupAssetPart,
  withAssetLock,
} from '../proxy/asset-download.js';
import {
  engineById,
  engineInstallKey,
  engineInstallRoot,
  readInstalledEngines,
  writeInstalledEngines,
  type EngineDef,
  type InstalledEngine,
} from './engines.js';
import { extractTarGz, safeEntryPath } from './tar.js';

/** A 4GB ceiling: the biggest current engine asset is ~0.8GB compressed. */
const MAX_ASSET_BYTES = 4 * 1024 * 1024 * 1024;
const USER_AGENT = 'omnicell-router';

export type InstallStage = 'resolve' | 'download' | 'extract' | 'finalize';

export type InstallEvent =
  | { type: 'stage'; stage: 'resolve' }
  | { type: 'resolve'; tag: string; version: string }
  | { type: 'stage'; stage: 'download'; asset: string; assetIndex: number; assetTotal: number }
  | { type: 'download-start'; asset: string; total: number }
  | { type: 'progress'; asset: string; downloaded: number; total: number }
  | { type: 'stage'; stage: 'extract'; asset: string; assetIndex: number; assetTotal: number }
  | { type: 'stage'; stage: 'finalize' };

export interface InstallEngineOptions {
  /** Any registered engine id; `engineById` is the validator, so this stays a
   *  plain string and a new engine needs no change here (ADR-0039). */
  engineId: string;
  /** Build target id from the engine catalog; defaults to the first target. */
  target?: string;
  /** Specific release tag; absent = newest usable release. */
  version?: string;
  signal?: AbortSignal;
  onEvent?: (event: InstallEvent) => void;
}

export type InstallEngineResult =
  | {
    ok: true;
    installed: InstalledEngine;
    resumedFrom: number;
    /** Install directory of the build this one replaced (an upgrade, never a
     *  fresh install). Present only while it still exists; the caller sweeps
     *  it once it has established that nothing is running from it. */
    supersededDir?: string;
  }
  | { ok: false; code: string; error: string };

/** `<root>/downloads/<asset>.part` — staged beside, never inside, a version dir. */
function partPathFor(asset: string): string {
  return path.join(engineInstallRoot(), 'downloads', `${asset}.part`);
}

/** Release asset download URL (canonical GitHub spelling, tag-encoded). */
function assetUrl(repo: string, tag: string, asset: string): string {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}

/** Look for the engine's server binaries among the unpacked files. */
function findBinaries(engine: EngineDef, installDir: string): string[] {
  const wanted = new Set(engine.binaryNames.map((name) => name.toLowerCase()));
  const found: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const base = entry.name.toLowerCase().replace(/\.(exe|bat|cmd)$/i, '');
      if (wanted.has(base)) found.push(abs);
    }
  };
  visit(installDir, 0);
  return found;
}

/** Extract one downloaded asset into the install dir (tar.gz or zip). */
function extractAsset(
  asset: string,
  partPath: string,
  installDir: string,
  onProgress?: (readBytes: number, totalBytes: number) => void,
): Promise<void> {
  if (asset.endsWith('.tar.gz') || asset.endsWith('.tgz')) {
    return extractTarGz(partPath, installDir, onProgress).then(() => undefined);
  }
  if (asset.endsWith('.zip')) {
    // Buffered: Windows archives ship as zip (llama.cpp builds, Strata's
    // control bundle). A one-shot buffer, not a steady cost.
    const packed = unzipSync(new Uint8Array(fs.readFileSync(partPath)));
    for (const [name, bytes] of Object.entries(packed)) {
      if (name.endsWith('/')) {
        const dir = safeEntryPath(name);
        if (dir) fs.mkdirSync(path.join(installDir, dir), { recursive: true });
        continue;
      }
      const rel = safeEntryPath(name);
      if (!rel) continue;
      const dest = path.join(installDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
    }
    return Promise.resolve();
  }
  // Unknown packaging: install the file as-is (single-binary archives).
  const rel = safeEntryPath(asset) ?? 'engine-binary';
  const dest = path.join(installDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(partPath, dest);
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  return Promise.resolve();
}

/**
 * Download and unpack one companion archive — an asset that belongs somewhere
 * OTHER than the engine install directory (Strata's Python front-end lands in
 * the shared runtime directory, versioned with the engine build). Same staging
 * rules as a main asset: resumable `.part`, the destination is cleared only
 * after the download has completed, and an unpack failure drops the part so
 * the next attempt refetches instead of replaying a corrupt archive.
 *
 * @returns the failure result to propagate, or null on success.
 */
async function installCompanion(
  engine: EngineDef,
  tag: string,
  asset: string,
  dest: string,
  position: { assetIndex: number; assetTotal: number },
  emit: (event: InstallEvent) => void,
  signal?: AbortSignal,
): Promise<{ ok: false; code: string; error: string } | null> {
  emit({ type: 'stage', stage: 'download', asset, ...position });
  const partPath = partPathFor(asset);
  const downloaded = await downloadAssetToFile({
    url: assetUrl(engine.repo, tag, asset),
    partPath,
    fetchImpl: fetch,
    maxBytes: MAX_ASSET_BYTES,
    headers: { 'User-Agent': USER_AGENT },
    ...(signal ? { signal } : {}),
    onProgress: (downloadedBytes, total) => {
      emit({ type: 'progress', asset, downloaded: downloadedBytes, total });
    },
  });
  if (!downloaded.ok) {
    return { ok: false, code: downloaded.code, error: `${engine.name} ${asset}: ${downloaded.error}` };
  }
  emit({ type: 'stage', stage: 'extract', asset, ...position });
  try {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    await extractAsset(asset, partPath, dest, (read, total) => {
      emit({ type: 'progress', asset, downloaded: read, total });
    });
  } catch (err) {
    cleanupAssetPart(partPath);
    const message = err instanceof Error ? err.message : 'unpack failed';
    return { ok: false, code: 'unpack-failed', error: `${engine.name} ${asset}: ${message}` };
  }
  cleanupAssetPart(partPath);
  return null;
}

export async function installEngine(opts: InstallEngineOptions): Promise<InstallEngineResult> {
  const engine = engineById(opts.engineId);
  if (!engine) return { ok: false, code: 'unknown-engine', error: `unknown engine '${opts.engineId}'` };
  const targets = engine.targets(process.platform, process.arch);
  if (targets.length === 0) {
    return { ok: false, code: 'unsupported-platform', error: `no ${engine.name} build for ${process.platform}/${process.arch}` };
  }
  const target = targets.find((item) => item.id === opts.target) ?? targets[0];
  const emit = (event: InstallEvent) => opts.onEvent?.(event);

  // Serialise per engine+target: a CUDA reinstall and a first CPU install of
  // the SAME engine share no files and may run side by side.
  return withAssetLock(path.join(engineInstallRoot(), opts.engineId, target.id), async () => {
    emit({ type: 'stage', stage: 'resolve' });
    let release: { tag: string; assets: string[] };
    try {
      release = await engine.resolveRelease(fetch, opts.signal);
    } catch (err) {
      const aborted = opts.signal?.aborted;
      const message = err instanceof Error ? err.message : 'release lookup failed';
      return { ok: false, code: aborted ? 'download-aborted' : 'release-lookup-failed', error: message };
    }
    if (opts.version && opts.version !== release.tag) {
      return { ok: false, code: 'version-missing', error: `${engine.name} ${opts.version} is not the offered release (${release.tag})` };
    }
    const matched = engine.matchAssets({
      platform: process.platform,
      arch: process.arch,
      targetId: target.id,
      tag: release.tag,
      assets: release.assets,
    });
    if (!matched) {
      return { ok: false, code: 'asset-missing', error: `release ${release.tag} has no ${engine.name} asset for target '${target.id}'` };
    }
    emit({ type: 'resolve', tag: release.tag, version: matched.version });

    const installDir = path.join(engineInstallRoot(), engine.id, `${matched.version}-${target.id}`);
    const started = Date.now();
    let resumedTotal = 0;
    let extractedOnce = false;
    try {
      for (let assetIndex = 0; assetIndex < matched.assets.length; assetIndex += 1) {
        const asset = matched.assets[assetIndex];
        // Position in a multi-asset install (llama.cpp CUDA = main archive +
        // cudart): without it the second asset's 0→100% looks like the install
        // restarted.
        const position = { assetIndex: assetIndex + 1, assetTotal: matched.assets.length };
        emit({ type: 'stage', stage: 'download', asset, ...position });
        const partPath = partPathFor(asset);
        const downloaded = await downloadAssetToFile({
          url: assetUrl(engine.repo, release.tag, asset),
          partPath,
          fetchImpl: fetch,
          maxBytes: MAX_ASSET_BYTES,
          headers: { 'User-Agent': USER_AGENT },
          ...(opts.signal ? { signal: opts.signal } : {}),
          onProgress: (downloadedBytes, total) => {
            emit({ type: 'progress', asset, downloaded: downloadedBytes, total });
          },
        });
        if (!downloaded.ok) {
          return { ok: false, code: downloaded.code, error: `${engine.name} ${asset}: ${downloaded.error}` };
        }
        resumedTotal += downloaded.resumedFrom;
        emit({ type: 'stage', stage: 'extract', asset, ...position });
        try {
          // Clear once, before the FIRST asset lands: a multi-asset install
          // (llama.cpp CUDA = main archive + cudart runtime) unpacks both into
          // the same fresh directory.
          if (!extractedOnce) {
            fs.rmSync(installDir, { recursive: true, force: true });
            fs.mkdirSync(installDir, { recursive: true });
            extractedOnce = true;
          }
          await extractAsset(asset, partPath, installDir, (read, total) => {
            // Same event shape as the download leg: stage stays 'extract'
            // (stamped above), downloaded/total become archive-read bytes.
            emit({ type: 'progress', asset, downloaded: read, total });
          });
        } catch (err) {
          // An archive that downloads but will not unpack is dead weight: drop
          // the part so the next attempt refetches instead of replaying it.
          cleanupAssetPart(partPath);
          fs.rmSync(installDir, { recursive: true, force: true });
          const message = err instanceof Error ? err.message : 'unpack failed';
          return { ok: false, code: 'unpack-failed', error: `${engine.name} ${asset}: ${message}` };
        }
        cleanupAssetPart(partPath);
      }
      const companions = matched.companions ?? [];
      for (let i = 0; i < companions.length; i += 1) {
        const companion = companions[i];
        // Companion legs extend the SAME position counter, so a strata install
        // reads "1/2, 2/2" instead of the front-end restarting the bar at 1/1.
        const position = {
          assetIndex: matched.assets.length + i + 1,
          assetTotal: matched.assets.length + companions.length,
        };
        const failed = await installCompanion(engine, release.tag, companion.asset, companion.dest, position, emit, opts.signal);
        if (failed) return failed;
      }
    } catch (err) {
      if (opts.signal?.aborted) return { ok: false, code: 'download-aborted', error: 'download cancelled' };
      const message = err instanceof Error ? err.message : 'install failed';
      return { ok: false, code: 'install-failed', error: message };
    }

    emit({ type: 'stage', stage: 'finalize' });
    if (process.platform !== 'win32') {
      // tar modes may arrive masked; make anything executable-looking runnable.
      try {
        for (const binary of findBinaries(engine, installDir)) fs.chmodSync(binary, 0o755);
      } catch {
        // A non-executable binary surfaces at launch, not here.
      }
    }
    const binaries = findBinaries(engine, installDir);
    const installed: InstalledEngine = {
      engine: engine.id,
      version: matched.version,
      target: target.id,
      installDir,
      binaries,
      installedAt: Date.now(),
    };
    let supersededDir: string | null = null;
    try {
      const state = readInstalledEngines();
      const key = engineInstallKey(engine.id, target.id);
      // An UPGRADE shares the state key with the build it replaces (the key is
      // engine:target, never engine:version), so the outgoing record is the only
      // pointer to a version directory that becomes unreachable at this write.
      // Report it instead of deleting here: whether that directory may go is
      // run knowledge (a live engine may be serving its binary), and this module
      // deliberately knows nothing about runs.
      const previous = state[key];
      if (
        previous
        && path.resolve(previous.installDir) !== path.resolve(installDir)
        && fs.existsSync(previous.installDir)
      ) {
        supersededDir = previous.installDir;
      }
      state[key] = installed;
      writeInstalledEngines(state);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'state write failed';
      return { ok: false, code: 'install-failed', error: `engine installed but the record write failed (${message})` };
    }
    void started;
    return {
      ok: true,
      installed,
      resumedFrom: resumedTotal,
      ...(supersededDir ? { supersededDir } : {}),
    };
  });
}

/**
 * Delete the version directory an upgrade replaced, unless a caller-supplied
 * check says something still needs it.
 *
 * The install record is keyed `engine:target` (never `engine:version`), so an
 * upgrade overwrites the only pointer to the outgoing directory: it survives as
 * an orphan — hundreds of MB per CUDA build — that no UI can reach or remove.
 * Settling the state record IS the upgrade; this is the second half.
 *
 * `inUse` is the caller's knowledge (the route asks the runner), so this module
 * stays run-agnostic. A skipped directory is only wasted disk, never a broken
 * install: the record already points at the new build.
 *
 * @returns true when the directory was deleted.
 */
export function pruneSupersededInstall(
  dir: string | undefined,
  inUse: (candidate: string) => boolean = () => false,
): boolean {
  if (!dir) return false;
  // Only ever delete inside the engines root: the path comes from a record we
  // wrote, but a corrupt one must not aim the deletion at an arbitrary folder.
  const root = path.resolve(engineInstallRoot());
  const target = path.resolve(dir);
  if (!target.startsWith(root + path.sep)) return false;
  if (path.basename(target) === path.basename(root)) return false;
  // Nothing there to reclaim (an interrupted sweep, or an upgrade whose old
  // directory was already removed by hand). Explicit, so callers can tell
  // "swept it" from "there was nothing to sweep".
  if (!fs.existsSync(target)) return false;
  try {
    if (inUse(target)) return false;
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch {
    return false;
  }
}

/** Remove one engine install (one build target) and its state record. */
export function uninstallEngine(engineId: string, target: string): { ok: boolean; error?: string } {
  const state = readInstalledEngines();
  const key = engineInstallKey(engineId, target);
  const record = state[key];
  if (!record) return { ok: false, error: 'engine is not installed' };
  // Only ever delete inside the engines root — the record is a file we wrote,
  // but a corrupt one must not point the deletion at an arbitrary directory.
  const root = path.resolve(engineInstallRoot());
  const dir = path.resolve(record.installDir);
  if (!dir.startsWith(root + path.sep)) {
    return { ok: false, error: 'install record points outside the engines root; remove it manually' };
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'delete failed';
    return { ok: false, error: `could not delete the install directory (${message})` };
  }
  delete state[key];
  try {
    writeInstalledEngines(state);
  } catch {
    // Directory gone; a failed state write only leaves a stale row.
  }
  return { ok: true };
}

/**
 * Engine registry for the Local Models console (llama.cpp / Strata).
 *
 * An ENGINE is a locally-installed inference server the gateway can reach over
 * its OpenAI-compatible HTTP API. This module owns the per-engine catalog:
 * which build targets exist for the running platform/arch, how a target maps
 * onto GitHub release assets, and how the newest usable release is resolved.
 * The download/unpack/state half lives in `install.ts`.
 *
 * Asset realities this is written against (checked 2026-11):
 * - llama.cpp (`ggml-org/llama.cpp`): binaries ride PRERELEASE tags (`b12722`);
 *   the stable `v*` tags (`v1.1.0`) carry ONLY a `nightly-tag.txt` pointer
 *   file and no binaries at all. A release therefore counts only when it
 *   ships a `llama-<tag>-bin-*` asset — a fresh stable tag sits at the TOP of
 *   the release list and would otherwise shadow every `b*` build behind its
 *   pointer file. A target resolves by exact asset name `llama-<tag>-bin-<asset>`
 *   over the release list, first binary release wins. CUDA targets need a
 *   SECOND asset (`cudart-*`) downloaded alongside the main one; its Windows
 *   spelling has no tag while the Ubuntu one does.
 * - Strata (`Niko1221/Strata`): one stable `latest` release; engine assets are
 *   `strata-engine-<engineVer>-<os>-<arch>-<backend>[-<variant>].tar.gz` where
 *   the engine version is INDEPENDENT of the release tag — it is parsed out of
 *   the matched asset name. The control bundle (`strata-control-<engineVer>-<os>-<arch>`)
 *   is the front-end and is installed beside it, not into the engine directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getOcrHomeDir } from '../cli/paths.js';
import { githubHeaders } from '../harness/common/github.js';
import type { EngineFieldSpec, EngineProfileGroup, EngineRunControls, EngineRuntime, EngineServeVerdict } from './engine-runtime.js';
import type { GgufMeta } from './gguf.js';
import { LLAMACPP_RUNTIME } from './llamacpp.js';
import { STRATA_RUNTIME, strataRuntimeDir } from './strata.js';

/**
 * Known engine ids keep their autocomplete, but any registry id is accepted:
 * adding an engine must not require editing a union in three files (catalog,
 * routes, console). The registry below is the single source of truth.
 */
export type EngineId = 'llamacpp' | 'strata' | (string & {});

/** The machine facts a target recommendation reads (detect.ts builds it). */
export interface EngineDetectSummary {
  platform: string;
  arch: string;
  /** An NVIDIA driver answered nvidia-smi. */
  nvidia: boolean;
  /** Driver-reported CUDA major version (0 without an NVIDIA stack). */
  cudaMajor: number;
  /** A ROCm/HIP userspace was found. */
  amdRocm: boolean;
  /** A Vulkan loader was found. */
  vulkan: boolean;
}

/** Where a dependency check's result came from. */
export type EngineDep = 'nvidia-driver' | 'vulkan' | 'amd-rocm' | 'intel-sycl' | 'apple-metal' | 'cpu';

export interface EngineTarget {
  /** Stable id the console sends back (`vulkan-x64`, `cuda12`, `hip-rdna3`). */
  id: string;
  /** Backend family, for grouping and dep detection (`cuda`, `vulkan`, …). */
  backend: string;
  label: string;
  /** Dependency ids that must check OK before this target is recommended. */
  requires: EngineDep[];
  /** Approximate download size in bytes, 0 when unknown (console display only). */
  approxBytes: number;
}

export interface EngineDef {
  id: EngineId;
  name: string;
  repo: string;
  /** One-line description the console shows on the engine card. */
  description: string;
  /**
   * i18n key of that description, when the console should translate it. The
   * engine supplies it, so the console never picks a sentence by engine NAME —
   * a new engine gets its own card text by declaring it here (ADR-0039).
   */
  descriptionKey?: string;
  /** Main server binary names to look for after unpacking. */
  binaryNames: string[];
  targets: (platform: NodeJS.Platform, arch: string) => EngineTarget[];
  /**
   * Match the release assets for one target. `assets` are the release's asset
   * names; returns the download URLs' asset names (main first) plus the
   * engine version, or null when the target has no asset in this release.
   */
  matchAssets: (ctx: AssetMatchContext) => MatchedAssets | null;
  /** Release listing shape differs per engine (prerelease stream vs latest). */
  resolveRelease: (fetchImpl: typeof fetch, signal?: AbortSignal) => Promise<ResolvedRelease>;
  /**
   * Tags the console's version picker offers, newest first. Optional: a single
   * stable channel needs nothing but `resolveRelease`. Present where the tag
   * IS the version choice (llama.cpp's nightly `b*` stream) — the route must
   * not know which engines those are.
   */
  listTags?: (fetchImpl: typeof fetch, signal?: AbortSignal) => Promise<string[]>;
  /**
   * How this engine is LAUNCHED: file gate, placement authority, argv, and the
   * operator profile it needs. Absent means the engine is install-only (the
   * console lists it but the run page never offers it).
   */
  runtime?: EngineRuntime;
  /** Default build target for this machine; null = nothing detected. */
  recommendTarget?: (detect: EngineDetectSummary) => string | null;
}

export interface AssetMatchContext {
  platform: NodeJS.Platform;
  arch: string;
  targetId: string;
  /** Release tag (`b12722`, `v0.2.21`). */
  tag: string;
  /** Asset names present in the release. */
  assets: string[];
}

export interface MatchedAssets {
  /** Asset names to download, main binary archive first. */
  assets: string[];
  /** Engine version to record (`b12722`, `0.1.67`). */
  version: string;
  /**
   * Archives extracted somewhere other than the engine install directory.
   * Strata's control bundle (the Python front-end) lands in the gateway's
   * runtime directory, once, shared by every build target.
   */
  companions?: { asset: string; dest: string }[];
}

export interface ResolvedRelease {
  tag: string;
  assets: string[];
}

const MB = 1024 * 1024;

/**
 * A llama.cpp release only counts when it carries real binaries: the stable
 * `v*` tags ship ONLY a `nightly-tag.txt` pointer, and a mid-upload release
 * may have no asset yet — either would otherwise win the release walk over
 * the `b*` build every target matcher needs.
 */
const llamaReleaseHasBinaries = (tag: string, assets: string[]): boolean =>
  tag !== '' && assets.some((name) => name.startsWith(`llama-${tag}-bin-`));

const LLAMACPP_ASSET_BYTES: Record<string, number> = {
  // Measured sizes of recent nightly assets; refreshed targets fall back to 0.
  'win-cpu-x64.zip': 24 * MB,
  'win-cpu-arm64.zip': 12 * MB,
  'win-vulkan-x64.zip': 37 * MB,
  'win-vulkan-arm64.zip': 25 * MB,
  'win-cuda-12.4-x64.zip': 342 * MB,
  'win-cuda-13.5-x64.zip': 215 * MB,
  'win-cuda-13.5-arm64.zip': 203 * MB,
  'win-rocm-10.0-x64.zip': 272 * MB,
  'win-sycl-x64.zip': 165 * MB,
  'ubuntu-x64.tar.gz': 22 * MB,
  'ubuntu-arm64.tar.gz': 18 * MB,
  'ubuntu-vulkan-x64.tar.gz': 35 * MB,
  'ubuntu-vulkan-arm64.tar.gz': 28 * MB,
  'ubuntu-cuda-12.8-x64.tar.gz': 210 * MB,
  'ubuntu-cuda-13.5-x64.tar.gz': 214 * MB,
  'ubuntu-cuda-13.5-arm64.tar.gz': 209 * MB,
  'ubuntu-rocm-10.0-x64.tar.gz': 264 * MB,
  'ubuntu-sycl-fp16-x64.tar.gz': 66 * MB,
  'macos-arm64.tar.gz': 16 * MB,
  'macos-x64.tar.gz': 11 * MB,
};

const STRATA_ASSET_BYTES: Record<string, number> = {
  'windows-x86_64-cuda-cuda12': 719 * MB,
  'windows-x86_64-cuda-cuda13': 471 * MB,
  'windows-x86_64-hip-rdna2': 159 * MB,
  'windows-x86_64-hip-rdna3': 210 * MB,
  'windows-x86_64-hip-rx9070': 512 * MB,
  'linux-x86_64-cuda-cuda12': 746 * MB,
  'linux-x86_64-cuda-cuda13': 565 * MB,
  'linux-x86_64-hip-halo': 257 * MB,
  'linux-x86_64-hip-rx6000': 183 * MB,
  'linux-x86_64-hip-rx7900': 263 * MB,
  'linux-x86_64-hip-rx9070': 608 * MB,
  'linux-x86_64-sycl': 180 * MB,
  'linux-aarch64-cuda-cuda13': 557 * MB,
  'macos-arm64-metal': 3 * MB,
};

const LLAMACPP: EngineDef = {
  id: 'llamacpp',
  name: 'llama.cpp',
  repo: 'ggml-org/llama.cpp',
  description: 'llama-server speaks the OpenAI-compatible API; CPU/Vulkan/CUDA/ROCm/SYCL/Metal backends',
  descriptionKey: 'localModels.descLlamacpp',
  binaryNames: ['llama-server', 'llama-cli'],
  targets: (platform, arch) => {
    if (platform === 'win32') {
      const targets: EngineTarget[] = [
        { id: 'cpu', backend: 'cpu', label: 'CPU', requires: ['cpu'], approxBytes: LLAMACPP_ASSET_BYTES[`win-cpu-${arch}.zip`] ?? 0 },
        { id: 'vulkan', backend: 'vulkan', label: 'Vulkan', requires: ['vulkan'], approxBytes: LLAMACPP_ASSET_BYTES[`win-vulkan-${arch}.zip`] ?? 0 },
      ];
      if (arch === 'x64') {
        targets.push(
          { id: 'cuda-12.4', backend: 'cuda', label: 'CUDA 12.4', requires: ['nvidia-driver'], approxBytes: LLAMACPP_ASSET_BYTES['win-cuda-12.4-x64.zip'] ?? 0 },
          { id: 'cuda-13.5', backend: 'cuda', label: 'CUDA 13.5', requires: ['nvidia-driver'], approxBytes: LLAMACPP_ASSET_BYTES['win-cuda-13.5-x64.zip'] ?? 0 },
          { id: 'rocm-10.0', backend: 'rocm', label: 'ROCm 10.0 (AMD)', requires: ['amd-rocm'], approxBytes: LLAMACPP_ASSET_BYTES['win-rocm-10.0-x64.zip'] ?? 0 },
          { id: 'sycl', backend: 'sycl', label: 'SYCL (Intel)', requires: ['intel-sycl'], approxBytes: LLAMACPP_ASSET_BYTES['win-sycl-x64.zip'] ?? 0 },
        );
      } else {
        targets.push(
          { id: 'cuda-13.5', backend: 'cuda', label: 'CUDA 13.5', requires: ['nvidia-driver'], approxBytes: LLAMACPP_ASSET_BYTES['win-cuda-13.5-arm64.zip'] ?? 0 },
        );
      }
      return targets;
    }
    if (platform === 'linux') {
      const targets: EngineTarget[] = [
        { id: 'cpu', backend: 'cpu', label: 'CPU', requires: ['cpu'], approxBytes: LLAMACPP_ASSET_BYTES[`ubuntu-${arch}.tar.gz`] ?? 0 },
        { id: 'vulkan', backend: 'vulkan', label: 'Vulkan', requires: ['vulkan'], approxBytes: LLAMACPP_ASSET_BYTES[`ubuntu-vulkan-${arch}.tar.gz`] ?? 0 },
      ];
      if (arch === 'x64') {
        targets.push(
          { id: 'cuda-12.8', backend: 'cuda', label: 'CUDA 12.8', requires: ['nvidia-driver'], approxBytes: LLAMACPP_ASSET_BYTES['ubuntu-cuda-12.8-x64.tar.gz'] ?? 0 },
          { id: 'cuda-13.5', backend: 'cuda', label: 'CUDA 13.5', requires: ['nvidia-driver'], approxBytes: LLAMACPP_ASSET_BYTES['ubuntu-cuda-13.5-x64.tar.gz'] ?? 0 },
          { id: 'rocm-10.0', backend: 'rocm', label: 'ROCm 10.0 (AMD)', requires: ['amd-rocm'], approxBytes: LLAMACPP_ASSET_BYTES['ubuntu-rocm-10.0-x64.tar.gz'] ?? 0 },
          { id: 'sycl', backend: 'sycl', label: 'SYCL (Intel)', requires: ['intel-sycl'], approxBytes: LLAMACPP_ASSET_BYTES['ubuntu-sycl-fp16-x64.tar.gz'] ?? 0 },
        );
      } else {
        targets.push(
          { id: 'cuda-13.5', backend: 'cuda', label: 'CUDA 13.5', requires: ['nvidia-driver'], approxBytes: LLAMACPP_ASSET_BYTES['ubuntu-cuda-13.5-arm64.tar.gz'] ?? 0 },
        );
      }
      return targets;
    }
    if (platform === 'darwin') {
      return [
        { id: 'metal', backend: 'metal', label: 'Metal (Apple Silicon / AMD)', requires: ['apple-metal'], approxBytes: LLAMACPP_ASSET_BYTES[`macos-${arch}.tar.gz`] ?? 0 },
      ];
    }
    return [];
  },
  matchAssets: ({ platform, arch, targetId, tag, assets }) => {
    const asset = llamaAssetFor(platform, arch, targetId);
    if (!asset) return null;
    const main = `llama-${tag}-bin-${asset.file}`;
    if (!assets.includes(main)) return null;
    const downloads = [main];
    if (asset.cudart) {
      // Windows cudart assets have no tag in the name; Ubuntu ones do.
      const cudart = platform === 'win32' ? asset.cudart : asset.cudart.replace('{tag}', tag);
      if (assets.includes(cudart)) downloads.push(cudart);
    }
    return { assets: downloads, version: tag };
  },
  resolveRelease: async (fetchImpl, signal) => {
    // The binaries ride prerelease `b*` tags; `/releases/latest` points at the
    // stable tag, which ships only a nightly pointer file. Walk the list and
    // take the first release carrying REAL binaries — a pointer-only (or
    // still-uploading) release is skipped, and the target matcher rejects any
    // target the picked release has no asset for.
    const res = await fetchImpl('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30', {
      headers: githubHeaders(),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      throw new Error(`llama.cpp release lookup failed (${res.status})`);
    }
    const list = (await res.json()) as Array<{ tag_name?: unknown; assets?: Array<{ name?: unknown }> }>;
    for (const release of Array.isArray(list) ? list : []) {
      const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
      const assets = Array.isArray(release.assets)
        ? release.assets.map((a) => (typeof a.name === 'string' ? a.name : '')).filter(Boolean)
        : [];
      if (llamaReleaseHasBinaries(tag, assets)) return { tag, assets };
    }
    throw new Error('llama.cpp release list has no binary release');
  },
  listTags: async (fetchImpl, signal) => {
    // Nightly `b*` tags ARE the version choice here, so the picker offers the
    // recent stream — minus any tag no target could install from (a stable
    // `v*` tag ships only the nightly pointer file). Asset availability per
    // tag is re-checked on install.
    try {
      const res = await fetchImpl('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15', {
        headers: githubHeaders(),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) return [];
      const list = (await res.json()) as Array<{ tag_name?: unknown; assets?: Array<{ name?: unknown }> }>;
      return (Array.isArray(list) ? list : [])
        .filter((release) => {
          const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
          const assets = Array.isArray(release.assets)
            ? release.assets.map((a) => (typeof a.name === 'string' ? a.name : '')).filter(Boolean)
            : [];
          return llamaReleaseHasBinaries(tag, assets);
        })
        .map((release) => release.tag_name as string);
    } catch {
      return [];
    }
  },
  runtime: LLAMACPP_RUNTIME,
  recommendTarget: ({ platform, arch, nvidia, cudaMajor, amdRocm, vulkan }) => {
    if (platform === 'darwin') return 'metal';
    if (nvidia) {
      // CUDA 13 drivers run the 13.5 builds; older drivers get the 12.x pair.
      if (arch === 'arm64') return 'cuda-13.5';
      return cudaMajor >= 13 ? 'cuda-13.5' : `cuda-${platform === 'win32' ? '12.4' : '12.8'}`;
    }
    if (amdRocm) return 'rocm-10.0';
    if (vulkan) return 'vulkan';
    return 'cpu';
  },
};

/** llama.cpp asset spelling for one platform/arch/target; null = unsupported. */
function llamaAssetFor(platform: NodeJS.Platform, arch: string, targetId: string): { file: string; cudart?: string } | null {
  if (platform === 'win32') {
    if (targetId === 'cpu') return { file: `win-cpu-${arch}.zip` };
    if (targetId === 'vulkan') return { file: `win-vulkan-${arch}.zip` };
    if (arch === 'x64' && targetId === 'cuda-12.4') return { file: 'win-cuda-12.4-x64.zip', cudart: 'cudart-llama-bin-win-cuda-12.4-x64.zip' };
    if (targetId === 'cuda-13.5') return { file: `win-cuda-13.5-${arch}.zip`, cudart: `cudart-llama-bin-win-cuda-13.5-${arch}.zip` };
    if (arch === 'x64' && targetId === 'rocm-10.0') return { file: 'win-rocm-10.0-x64.zip' };
    if (arch === 'x64' && targetId === 'sycl') return { file: 'win-sycl-x64.zip' };
    return null;
  }
  if (platform === 'linux') {
    if (targetId === 'cpu') return { file: `ubuntu-${arch}.tar.gz` };
    if (targetId === 'vulkan') return { file: `ubuntu-vulkan-${arch}.tar.gz` };
    if (arch === 'x64' && targetId === 'cuda-12.8') return { file: 'ubuntu-cuda-12.8-x64.tar.gz', cudart: 'cudart-llama-b{tag}-bin-ubuntu-cuda-12.8-x64.tar.gz' };
    if (targetId === 'cuda-13.5') return { file: `ubuntu-cuda-13.5-${arch}.tar.gz`, cudart: `cudart-llama-b{tag}-bin-ubuntu-cuda-13.5-${arch}.tar.gz` };
    if (arch === 'x64' && targetId === 'rocm-10.0') return { file: 'ubuntu-rocm-10.0-x64.tar.gz' };
    if (arch === 'x64' && targetId === 'sycl') return { file: 'ubuntu-sycl-fp16-x64.tar.gz' };
    return null;
  }
  if (platform === 'darwin') {
    if (targetId === 'metal') return { file: `macos-${arch}.tar.gz` };
    return null;
  }
  return null;
}

const STRATA: EngineDef = {
  id: 'strata',
  name: 'Strata',
  repo: 'Niko1221/Strata',
  description: 'MoE expert-offload engine that runs huge models on small VRAM; OpenAI/Anthropic-compatible API',
  descriptionKey: 'localModels.descStrata',
  binaryNames: ['strata-engine', 'strata', 'strata-control'],
  targets: (platform, arch) => {
    if (platform === 'darwin') {
      if (arch !== 'arm64') return [];
      return [
        { id: 'metal', backend: 'metal', label: 'Metal (Apple Silicon)', requires: ['apple-metal'], approxBytes: STRATA_ASSET_BYTES['macos-arm64-metal'] ?? 0 },
      ];
    }
    const osTag = platform === 'win32' ? 'windows-x86_64' : arch === 'x64' ? 'linux-x86_64' : arch === 'arm64' ? 'linux-aarch64' : null;
    if (!osTag) return [];
    const ids: string[] = platform === 'win32'
      ? ['cuda12', 'cuda13', 'hip-rdna2', 'hip-rdna3', 'hip-rx9070']
      : arch === 'x64'
        ? ['cuda12', 'cuda13', 'hip-halo', 'hip-rx6000', 'hip-rx7900', 'hip-rx9070', 'sycl']
        : ['cuda13'];
    return ids.map((id) => {
      const backend = id.startsWith('cuda') ? 'cuda' : id.startsWith('hip') ? 'rocm' : 'sycl';
      const requires: EngineDep[] = backend === 'cuda' ? ['nvidia-driver'] : backend === 'rocm' ? ['amd-rocm'] : ['intel-sycl'];
      // Byte-table keys use the asset tail (`cuda-cuda13`), not the target id.
      const tail = id.startsWith('cuda') ? `cuda-${id}` : id;
      return { id, backend, label: strataTargetLabel(id), requires, approxBytes: STRATA_ASSET_BYTES[`${osTag}-${tail}`] ?? 0 };
    });
  },
  matchAssets: ({ platform, arch, targetId, assets }) => {
    const osTag = platform === 'win32' ? 'windows-x86_64' : platform === 'darwin' ? (arch === 'arm64' ? 'macos-arm64' : null) : arch === 'x64' ? 'linux-x86_64' : arch === 'arm64' ? 'linux-aarch64' : null;
    if (!osTag) return null;
    // Asset tail is `<backend>[-<variant>]`: CUDA ids carry BOTH (`cuda-cuda13`
    // for target `cuda13`), hip/sycl/metal ids are already the full tail.
    const tail = targetId.startsWith('cuda') ? `cuda-${targetId}` : targetId;
    const suffix = `-${osTag}-${tail}.tar.gz`;
    const name = assets.find((asset) => asset.startsWith('strata-engine-') && asset.endsWith(suffix));
    if (!name) return null;
    // strata-engine-0.1.67-<os>-<arch>-<backend>[-<variant>].tar.gz → 0.1.67
    const version = name.slice('strata-engine-'.length, name.length - suffix.length);
    // The front-end is a separate archive on the same release, versioned with
    // the engine (0.1.69 control next to the 0.1.69 engine). Windows ships a
    // zip; every other target a tar.gz. Absent on a release → the engine
    // still installs, and launch names the missing front-end.
    const controlExt = osTag.startsWith('windows') ? 'zip' : 'tar.gz';
    const control = `strata-control-${version}-${osTag}.${controlExt}`;
    return {
      assets: [name],
      version,
      ...(assets.includes(control) ? { companions: [{ asset: control, dest: strataRuntimeDir() }] } : {}),
    };
  },
  resolveRelease: async (fetchImpl, signal) => {
    const res = await fetchImpl('https://api.github.com/repos/Niko1221/Strata/releases/latest', {
      headers: githubHeaders(),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      throw new Error(`Strata release lookup failed (${res.status})`);
    }
    const release = (await res.json()) as { tag_name?: unknown; assets?: Array<{ name?: unknown }> };
    const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
    const assets = Array.isArray(release.assets)
      ? release.assets.map((a) => (typeof a.name === 'string' ? a.name : '')).filter(Boolean)
      : [];
    if (!tag) throw new Error('Strata release has no tag');
    return { tag, assets };
  },
  runtime: STRATA_RUNTIME,
  recommendTarget: ({ platform, arch, nvidia, cudaMajor }) => {
    if (platform === 'darwin') return arch === 'arm64' ? 'metal' : null;
    if (!nvidia) return null;
    // Strata's arm64 Linux build only exists for CUDA 13.
    return arch === 'arm64' ? (cudaMajor >= 13 ? 'cuda13' : null) : cudaMajor >= 13 ? 'cuda13' : 'cuda12';
  },
};

function strataTargetLabel(id: string): string {
  if (id === 'cuda12') return 'CUDA 12';
  if (id === 'cuda13') return 'CUDA 13';
  if (id === 'sycl') return 'SYCL (Intel Arc)';
  if (id === 'hip-halo') return 'ROCm (Strix Halo)';
  if (id === 'hip-rdna2') return 'ROCm (RDNA2)';
  if (id === 'hip-rdna3') return 'ROCm (RDNA3)';
  if (id.startsWith('hip-')) return `ROCm (${id.slice(4).toUpperCase()})`;
  return id;
}

/* ------------------------------------------------------------------------- *
 * The registry
 * ------------------------------------------------------------------------- */

/**
 * Live engine registry, in console order. Core engines are registered at import
 * time; a new engine (in-tree, a plugin, or a test double) calls
 * `registerEngine` and EVERY consumer — file gating, the run console, the plan
 * endpoint, target recommendations — picks it up without another edit. That is
 * the whole point of ADR-0039.
 */
const ENGINE_REGISTRY: EngineDef[] = [LLAMACPP, STRATA];

/** The registry as the catalog endpoint reads it. Mutated by `registerEngine`. */
export const ENGINES: EngineDef[] = ENGINE_REGISTRY;

export function engineById(id: string): EngineDef | null {
  return ENGINE_REGISTRY.find((engine) => engine.id === id) ?? null;
}

/** Add (or replace by id) one engine definition. */
export function registerEngine(engine: EngineDef): void {
  const at = ENGINE_REGISTRY.findIndex((existing) => existing.id === engine.id);
  if (at >= 0) ENGINE_REGISTRY[at] = engine;
  else ENGINE_REGISTRY.push(engine);
}

/** Drop one engine from the registry (test teardown; no route exposes this). */
export function unregisterEngine(id: string): boolean {
  const at = ENGINE_REGISTRY.findIndex((engine) => engine.id === id);
  if (at < 0) return false;
  ENGINE_REGISTRY.splice(at, 1);
  return true;
}

/** Every engine the gateway can launch (install-only entries excluded). */
export function launchableEngines(): EngineDef[] {
  return ENGINE_REGISTRY.filter((engine) => !!engine.runtime);
}

/* ------------------------------------------------------------------------- *
 * File → engine support
 * ------------------------------------------------------------------------- */

/** One engine's verdict about one file, plus the aggregate `runnable` list. */
export interface EngineSupport {
  /** Engines that can serve this file through the gateway's runner. */
  runnable: string[];
  /** True when the checkpoint declares routed experts (MoE). */
  moe: boolean;
  /**
   * Per-engine verdict, keyed by engine id — the console reads `serves`,
   * `family` and `reason` here, so no shared shape has to name an engine.
   */
  engines: Record<string, EngineServeVerdict>;
}

/**
 * Which engines can run one local file, given its parsed header and the
 * operator's stored profiles. Every answer comes from the engine's own
 * `runtime.serves()` — this function holds NO engine names, so a newly
 * registered engine (or a StubEngine test double) participates automatically.
 */
export function engineSupportFor(
  filePath: string,
  meta: GgufMeta | null,
  profiles: Record<string, unknown> = {}
): EngineSupport {
  const verdicts: Record<string, EngineServeVerdict> = {};
  const runnable: string[] = [];
  for (const engine of launchableEngines()) {
    const verdict = engine.runtime!.serves({ modelPath: filePath, meta, profile: profiles[engine.id] });
    verdicts[engine.id] = verdict;
    if (verdict.serves) runnable.push(engine.id);
  }
  return {
    runnable,
    moe: (meta?.experts ?? 0) > 0,
    engines: verdicts,
  };
}

/** The serialisable half of a runtime the console renders (functions stripped). */
export interface EngineRuntimeInfo {
  /** Who resolves ctx/ngl: the gateway planner or the engine itself. */
  placement: 'gateway' | 'engine';
  /** Which shared run controls this engine takes. */
  accepts: EngineRunControls;
  /** Operator profile inputs; null = this engine needs none. */
  profile: { intro: string; groups: EngineProfileGroup[] } | null;
  /** Installation-level setup inputs (ADR-0039 §10); absent = nothing to set up. */
  setup?: { intro: string; fields: EngineFieldSpec[] };
}

export function engineRuntimeInfo(engine: EngineDef): EngineRuntimeInfo | null {
  const runtime = engine.runtime;
  if (!runtime) return null;
  return {
    placement: runtime.placement,
    accepts: runtime.accepts,
    profile: runtime.profile ? { intro: runtime.profile.intro, groups: runtime.profile.groups } : null,
    ...(runtime.setup ? { setup: { intro: runtime.setup.intro, fields: runtime.setup.fields } } : {}),
  };
}

/** Default build target per engine for this machine. Keys ARE the registry's. */
export function recommendTargets(detect: EngineDetectSummary): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const engine of ENGINES) {
    out[engine.id] = engine.recommendTarget ? engine.recommendTarget(detect) : null;
  }
  return out;
}

/** Availability of one build target in the engine's current release. */
export interface EngineTargetAvailability {
  available: boolean;
  /** Engine version parsed from the matched asset (Strata ≠ release tag). */
  version?: string;
}

/** The release probe the console renders per engine card. */
export interface EngineAvailability {
  id: EngineId;
  /** Resolved release tag (`b12728`, `v0.2.22`); absent when the lookup failed. */
  tag?: string;
  /** Per catalog target of THIS platform; absent when the lookup failed. */
  targets?: Record<string, EngineTargetAvailability>;
  error?: string;
}

/**
 * Resolve the engine's current release and report which catalog targets it
 * actually ships — a target chip whose asset is missing is rendered disabled
 * instead of failing the install click after the operator committed to it.
 */
export async function probeEngineAvailability(engine: EngineDef, fetchImpl: typeof fetch = fetch): Promise<EngineAvailability> {
  let release: ResolvedRelease;
  try {
    release = await engine.resolveRelease(fetchImpl);
  } catch (err) {
    return { id: engine.id, error: err instanceof Error ? err.message : 'release lookup failed' };
  }
  const targets: Record<string, EngineTargetAvailability> = {};
  for (const target of engine.targets(process.platform, process.arch)) {
    const matched = engine.matchAssets({
      platform: process.platform,
      arch: process.arch,
      targetId: target.id,
      tag: release.tag,
      assets: release.assets,
    });
    targets[target.id] = matched
      ? { available: true, ...(matched.version !== release.tag ? { version: matched.version } : {}) }
      : { available: false };
  }
  return { id: engine.id, tag: release.tag, targets };
}

/** Install root: `<ocrHome>/engines/<engineId>/<version>/`. */
export function engineInstallRoot(): string {
  return path.join(getOcrHomeDir(), 'engines');
}

/** The persisted per-install record (`engines/installed.json`). */
export interface InstalledEngine {
  engine: EngineId;
  version: string;
  target: string;
  installDir: string;
  /** Absolute paths of usable server binaries found after unpacking. */
  binaries: string[];
  installedAt: number;
}

/**
 * State key for one install: `<engineId>:<target>` — an engine may keep
 * several build targets side by side (a CPU fallback next to the GPU build),
 * and the run console picks among them at launch time. Legacy rows keyed by
 * the bare engine id are normalised on READ (`record.engine + ':' + record.target`
 * is the same key their install wrote).
 */
export function engineInstallKey(engineId: string, target: string): string {
  return `${engineId}:${target}`;
}

export function engineStateFile(): string {
  return path.join(engineInstallRoot(), 'installed.json');
}

export function readInstalledEngines(): Record<string, InstalledEngine> {
  try {
    const parsed = JSON.parse(fs.readFileSync(engineStateFile(), 'utf8')) as Record<string, InstalledEngine>;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, InstalledEngine> = {};
    for (const [key, record] of Object.entries(parsed)) {
      if (!record || typeof record !== 'object' || !record.engine || !record.target) continue;
      out[key.includes(':') ? key : engineInstallKey(record.engine, record.target)] = record;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeInstalledEngines(state: Record<string, InstalledEngine>): void {
  fs.mkdirSync(engineInstallRoot(), { recursive: true });
  fs.writeFileSync(engineStateFile(), `${JSON.stringify(state, null, 2)}\n`);
}

/** Installs of one engine (every target), sorted by target id. */
export function installedEnginesFor(engineId: string): InstalledEngine[] {
  return Object.values(readInstalledEngines())
    .filter((record) => record.engine === engineId)
    .sort((a, b) => a.target.localeCompare(b.target));
}

/** One install by engine + target, when present. */
export function installedEngineFor(engineId: string, target: string): InstalledEngine | null {
  return readInstalledEngines()[engineInstallKey(engineId, target)] ?? null;
}

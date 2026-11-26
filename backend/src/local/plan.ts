/**
 * Placement planner for the Local Models run console (the automatic-layer-plan
 * panel).
 *
 * Given one model file (size + parsed GGUF header) and one machine reading
 * (VRAM, RAM), the planner answers: how many transformer layers fit in VRAM,
 * what the KV cache costs at a chosen context, what spills to RAM, and what
 * the disk ends up streaming. The output drives BOTH the console's bars and
 * the runner's `-ngl` argument, so the picture the operator confirms is the
 * launch that actually happens.
 *
 * Everything here is an ESTIMATE — the UI labels every number as estimated.
 * The model is a
 * uniform per-layer weight split (embedding/output ride with the on-GPU
 * share) plus a KV term from the header's attention geometry; llama.cpp's own
 * allocator decides the truth at load time.
 */
import os from 'node:os';
import type { GgufMeta } from './gguf.js';

/** Fraction of detected VRAM the planner may budget — the rest belongs to the
 *  desktop, the engine runtime and the allocator's slack. The console's
 *  resource switch ("leave room" vs "full performance") picks between the two;
 *  both stay here so the plan preview and the runner never disagree. */
const VRAM_BUDGET_RATIO = 0.92;
const VRAM_BUDGET_RATIO_PERFORMANCE = 0.97;
/** Engine/runtime resident cost charged to VRAM before weights (bytes). */
const GPU_RUNTIME_BYTES = 400 * 1024 * 1024;
/** RAM kept for the OS and the gateway itself; the plan may not spend it. */
const RAM_RESERVE_BYTES = 4 * 1024 * 1024 * 1024;
const RAM_RESERVE_PERFORMANCE_BYTES = 2 * 1024 * 1024 * 1024;

/** Context ladder for the Auto pick — the largest step that does not push the
 *  KV cache past its budget share wins. Capped at the model's own ceiling. */
export const CTX_LADDER = [8192, 16384, 32768, 65536, 131072] as const;

/** Rough decode bandwidth (GB/s) per residency tier, for the speed estimate. */
const BANDWIDTH_GBPS = { vram: 250, split: 110, ram: 50 } as const;

export interface PlanInput {
  /** Model file size in bytes (the weights the loader maps). */
  sizeBytes: number;
  meta: GgufMeta | null;
  /** Total discrete VRAM in MiB (absent = no GPU reading). */
  vramMb?: number;
  /** System RAM in bytes (os.totalmem when the caller does not override). */
  ramBytes?: number;
  /** Engine target backend (`cpu`, `vulkan`, `cuda`, …); `cpu` never layers. */
  backend: string;
  /** Requested context length (tokens). */
  ctx: number;
  /** KV cache element bytes: 2 for f16, ~1.125 for q8_0 (byte + scales). */
  kvElemBytes?: number;
  /** Operator-pinned GPU layer count; when set it replaces the budget-derived
   *  split (the budget still shows in the bars, so an oversized pick reads as
   *  the overcommit it is). Clamped to the declared layer count. */
  gpuLayersOverride?: number;
  /** Resource mode: true (default) reserves headroom for the desktop and OS;
   *  false budgets nearly everything for the model. */
  headroom?: boolean;
}

export interface PlacementPlan {
  backend: string;
  /** Transformer layers the header declared (0 when unparsed). */
  layers: number;
  /** Layers placed on the GPU — the `-ngl` value the runner passes. */
  gpuLayers: number;
  /** True when every layer fits in VRAM (gpuLayers covers the model). */
  fullGpu: boolean;
  ctx: number;
  /** KV cache cost at `ctx` (bytes). */
  kvBytes: number;
  /** Estimated bytes resident in VRAM (weights share + KV + runtime). */
  vramBytes: number;
  vramTotalBytes: number;
  /** Estimated bytes resident in RAM (the offloaded weight share). */
  ramBytes: number;
  ramTotalBytes: number;
  /** RAM the plan refused to spend (the resource switch's reserve), so the
   *  console's detail line never hardcodes the figure. */
  ramReserveBytes: number;
  /** True when weights exceed VRAM+RAM budget and mmap streams from disk. */
  diskStreamed: boolean;
  /** Rough decode speed (tokens/s) — bandwidth over bytes touched per token. */
  estTokPerSec: number;
  /** The model's own context ceiling, when the header declared one. */
  maxCtx?: number;
}

/** KV bytes per token from the header geometry; falls back to an embd guess. */
function kvBytesPerToken(meta: GgufMeta | null, layers: number, elemBytes: number): number {
  if (!meta) return 0;
  const headDim = meta.headDim ?? (meta.heads && meta.embedding ? meta.embedding / meta.heads : 128);
  const kvHeads = meta.kvHeads ?? meta.heads ?? 0;
  if (!kvHeads || !headDim || !layers) return 0;
  // K and V per token per layer.
  return layers * kvHeads * headDim * 2 * elemBytes;
}

/**
 * Decode-side bytes one token touches: the resident weight share. A MoE
 * checkpoint activates `expertsUsed / experts` of its routed expert mass;
 * without the expert geometry the full file is touched.
 */
function bytesTouchedPerToken(sizeBytes: number, meta: GgufMeta | null): number {
  if (meta?.experts && meta.expertsUsed && meta.experts > meta.expertsUsed) {
    // Expert weights dominate an MoE file (~85-95% of bytes); treat the active
    // fraction as expertsUsed/experts of 90% of the file plus the shared 10%.
    return sizeBytes * (0.1 + 0.9 * (meta.expertsUsed / meta.experts));
  }
  return sizeBytes;
}

export function planPlacement(input: PlanInput): PlacementPlan {
  const layers = input.meta?.layers ?? 0;
  const ctx = Math.max(256, Math.floor(input.ctx));
  const kvElem = input.kvElemBytes ?? 2;
  const vramTotal = input.vramMb ? input.vramMb * 1024 * 1024 : 0;
  const ramTotal = input.ramBytes ?? os.totalmem();
  const kvBytes = kvBytesPerToken(input.meta, layers, kvElem) * ctx;
  const isCpu = input.backend === 'cpu' || vramTotal <= 0;
  const perLayer = layers > 0 ? input.sizeBytes / layers : input.sizeBytes;
  const vramRatio = input.headroom === false ? VRAM_BUDGET_RATIO_PERFORMANCE : VRAM_BUDGET_RATIO;
  const ramReserve = input.headroom === false ? RAM_RESERVE_PERFORMANCE_BYTES : RAM_RESERVE_BYTES;

  let gpuLayers = 0;
  if (!isCpu && layers > 0) {
    if (input.gpuLayersOverride != null) {
      // The operator pinned the split — honor it as-is (clamped); the bars
      // still charge it against the budget, so an overcommit is visible.
      gpuLayers = Math.max(0, Math.min(layers, Math.floor(input.gpuLayersOverride)));
    } else {
      const vramBudget = vramTotal * vramRatio;
      // KV rides with the GPU residency when any layer is on the GPU.
      const forWeights = vramBudget - GPU_RUNTIME_BYTES - kvBytes;
      gpuLayers = Math.max(0, Math.min(layers, Math.floor(forWeights / perLayer)));
    }
  }
  const fullGpu = !isCpu && layers > 0 && gpuLayers >= layers;
  const gpuWeightBytes = fullGpu ? input.sizeBytes : gpuLayers * perLayer;
  const ramWeightBytes = input.sizeBytes - gpuWeightBytes;
  const vramBytes = isCpu ? 0 : gpuWeightBytes + kvBytes + GPU_RUNTIME_BYTES;
  // KV stays on the GPU whenever any layer is offloaded; a CPU-only run pays
  // for it in RAM.
  const ramBytes = ramWeightBytes + (isCpu ? kvBytes : 0);
  const ramBudget = Math.max(0, ramTotal - ramReserve);
  const diskStreamed = ramWeightBytes > ramBudget;

  const touched = bytesTouchedPerToken(input.sizeBytes, input.meta);
  const bandwidth = fullGpu ? BANDWIDTH_GBPS.vram : isCpu ? BANDWIDTH_GBPS.ram : BANDWIDTH_GBPS.split;
  const estTokPerSec = Math.max(1, Math.round(bandwidth / Math.max(0.3, touched / 1e9)));

  return {
    backend: input.backend,
    layers,
    gpuLayers: isCpu ? 0 : gpuLayers,
    fullGpu,
    ctx,
    kvBytes,
    vramBytes,
    vramTotalBytes: vramTotal,
    ramBytes,
    ramTotalBytes: ramTotal,
    ramReserveBytes: ramReserve,
    diskStreamed,
    estTokPerSec,
    ...(input.meta?.maxCtx ? { maxCtx: input.meta.maxCtx } : {}),
  };
}

/** KV element-size note: q8_0 stores a byte plus per-block scales (~1.125). */
export const KV_ELEM_F16 = 2;
export const KV_ELEM_Q8_0 = 1.125;

/**
 * The auto context pick: the largest ladder step (clamped to the model's
 * ceiling) whose KV cache stays under a quarter of the VRAM budget — or, on a
 * CPU/RAM placement, under a tenth of spendable RAM. Always at least 8192.
 */
export function autoCtx(input: Omit<PlanInput, 'ctx'>): number {
  const ceiling = input.meta?.maxCtx ?? 32768;
  const ramReserve = input.headroom === false ? RAM_RESERVE_PERFORMANCE_BYTES : RAM_RESERVE_BYTES;
  const vramRatio = input.headroom === false ? VRAM_BUDGET_RATIO_PERFORMANCE : VRAM_BUDGET_RATIO;
  let pick: number = CTX_LADDER[0];
  for (const step of CTX_LADDER) {
    if (step > ceiling) break;
    const plan = planPlacement({ ...input, ctx: step });
    const budget = plan.vramTotalBytes > 0 && plan.gpuLayers > 0
      ? plan.vramTotalBytes * vramRatio * 0.25
      : Math.max(0, plan.ramTotalBytes - ramReserve) * 0.1;
    if (plan.kvBytes <= budget) pick = step;
    else break;
  }
  return Math.min(pick, ceiling);
}

/** The `-ngl` argument a plan maps to: 999 is llama.cpp's "every layer". */
export function nglForPlan(plan: PlacementPlan): number {
  if (plan.backend === 'cpu') return 0;
  return plan.fullGpu ? 999 : plan.gpuLayers;
}

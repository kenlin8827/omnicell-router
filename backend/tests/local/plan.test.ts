/**
 * planPlacement / autoCtx / nglForPlan: the automatic-layer-plan math. The console
 * preview and the runner's launch resolve through these same functions
 * (ADR-0037 §4), so the layer split, the ctx ladder and the `-ngl` mapping
 * are pinned here.
 */
import { describe, expect, test } from 'bun:test';
import { autoCtx, nglForPlan, planPlacement, KV_ELEM_Q8_0, type PlanInput } from '../../src/local/plan.js';
import type { GgufMeta } from '../../src/local/gguf.js';

const GB = 1024 ** 3;

const LLAMA32: GgufMeta = {
  ok: true,
  arch: 'llama',
  layers: 32,
  maxCtx: 131072,
  embedding: 4096,
  heads: 32,
  kvHeads: 8,
  headDim: 128,
};

function input(over: Partial<PlanInput>): PlanInput {
  return {
    sizeBytes: 4 * GB,
    meta: LLAMA32,
    ramBytes: 32 * GB,
    backend: 'vulkan',
    ctx: 8192,
    ...over,
  };
}

describe('planPlacement', () => {
  test('a model that fits VRAM places every layer on the GPU', () => {
    const plan = planPlacement(input({ vramMb: 12288 }));
    expect(plan.fullGpu).toBe(true);
    expect(plan.gpuLayers).toBe(32);
    expect(plan.ramBytes).toBe(0);
    expect(plan.diskStreamed).toBe(false);
    expect(nglForPlan(plan)).toBe(999);
  });

  test('short VRAM splits layers between GPU and RAM', () => {
    // 16 GB over 48 layers ≈ 350 MB/layer; 12 GB VRAM fits only a share.
    const meta: GgufMeta = { ...LLAMA32, layers: 48 };
    const plan = planPlacement(input({ sizeBytes: 16 * GB, meta, vramMb: 12288 }));
    expect(plan.fullGpu).toBe(false);
    expect(plan.gpuLayers).toBeGreaterThan(0);
    expect(plan.gpuLayers).toBeLessThan(48);
    expect(plan.ramBytes).toBeGreaterThan(0);
    expect(plan.diskStreamed).toBe(false);
    expect(nglForPlan(plan)).toBe(plan.gpuLayers);
  });

  test('the cpu backend never layers: everything in RAM, ngl 0', () => {
    const plan = planPlacement(input({ backend: 'cpu' }));
    expect(plan.gpuLayers).toBe(0);
    expect(plan.fullGpu).toBe(false);
    expect(plan.vramBytes).toBe(0);
    expect(plan.ramBytes).toBeGreaterThan(0);
    expect(nglForPlan(plan)).toBe(0);
  });

  test('an operator-pinned gpuLayersOverride replaces the budget split', () => {
    const meta: GgufMeta = { ...LLAMA32, layers: 48 };
    const plan = planPlacement(input({ sizeBytes: 16 * GB, meta, vramMb: 12288, gpuLayersOverride: 10 }));
    expect(plan.gpuLayers).toBe(10);
    expect(plan.fullGpu).toBe(false);
    // The remaining 38 layers spill to RAM.
    expect(plan.ramBytes).toBeGreaterThan(0);
    expect(plan.vramBytes).toBeGreaterThan(0);
    expect(nglForPlan(plan)).toBe(10);
  });

  test('the override is clamped to the declared layer count', () => {
    // Tiny VRAM, but the operator insists on more layers than the model has.
    const plan = planPlacement(input({ vramMb: 4096, gpuLayersOverride: 999 }));
    expect(plan.gpuLayers).toBe(32);
    expect(plan.fullGpu).toBe(true);
    expect(nglForPlan(plan)).toBe(999);
  });

  test('the cpu backend ignores the override', () => {
    const plan = planPlacement(input({ backend: 'cpu', gpuLayersOverride: 10 }));
    expect(plan.gpuLayers).toBe(0);
    expect(nglForPlan(plan)).toBe(0);
  });

  test('weights beyond the RAM budget stream from disk', () => {
    const plan = planPlacement(input({ backend: 'cpu', sizeBytes: 40 * GB }));
    expect(plan.diskStreamed).toBe(true);
  });

  test('the KV cache grows with ctx and shrinks with q8', () => {
    const f16 = planPlacement(input({ ctx: 32768 }));
    const q8 = planPlacement(input({ ctx: 32768, kvElemBytes: KV_ELEM_Q8_0 }));
    expect(f16.kvBytes).toBeGreaterThan(q8.kvBytes);
    // layers × kvHeads × headDim × 2 (K+V) × elem × ctx.
    expect(f16.kvBytes).toBe(32 * 8 * 128 * 2 * 2 * 32768);
  });

  test('an unparsed header still plans by file size alone', () => {
    const plan = planPlacement(input({ meta: null, vramMb: 12288 }));
    expect(plan.layers).toBe(0);
    expect(plan.gpuLayers).toBe(0);
    expect(plan.kvBytes).toBe(0);
    expect(plan.diskStreamed).toBe(false);
  });

  test('a MoE checkpoint estimates speed from the active expert share', () => {
    const dense = planPlacement(input({ vramMb: 12288 }));
    const moe = planPlacement(input({
      vramMb: 12288,
      meta: { ...LLAMA32, experts: 128, expertsUsed: 8 },
    }));
    expect(moe.estTokPerSec).toBeGreaterThan(dense.estTokPerSec);
  });
});

describe('autoCtx', () => {
  /** autoCtx takes the input without a ctx (it IS the ctx picker). */
  const seed = (over: Partial<PlanInput>): Omit<PlanInput, 'ctx'> => {
    const seeded = input(over);
    return {
      sizeBytes: seeded.sizeBytes,
      meta: seeded.meta,
      ramBytes: seeded.ramBytes,
      backend: seeded.backend,
      ...(seeded.vramMb != null ? { vramMb: seeded.vramMb } : {}),
    };
  };

  test('picks a ladder step within the model ceiling', () => {
    const ctx = autoCtx(seed({ vramMb: 12288 }));
    expect(ctx).toBeGreaterThanOrEqual(8192);
    expect(ctx).toBeLessThanOrEqual(LLAMA32.maxCtx!);
  });

  test('never exceeds the model ceiling', () => {
    const meta: GgufMeta = { ...LLAMA32, maxCtx: 16384 };
    expect(autoCtx(seed({ meta }))).toBeLessThanOrEqual(16384);
  });

  test('a huge KV geometry backs off to a smaller rung', () => {
    const wide: GgufMeta = { ...LLAMA32, layers: 80, kvHeads: 64, headDim: 256, maxCtx: 131072 };
    const small: GgufMeta = { ...LLAMA32, layers: 12, kvHeads: 1, headDim: 64, maxCtx: 131072 };
    const wideCtx = autoCtx(seed({ meta: wide }));
    const smallCtx = autoCtx(seed({ meta: small }));
    expect(wideCtx).toBeLessThan(smallCtx);
    expect(wideCtx).toBeGreaterThanOrEqual(8192);
  });
});

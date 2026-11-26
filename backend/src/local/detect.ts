/**
 * Local dependency detection for the Local Models console.
 *
 * The console asks "can this machine run a GPU engine, and which one?" — this
 * module answers with a check list plus a per-engine recommended target:
 * - `nvidia-smi` → NVIDIA GPUs, driver version and the driver's max CUDA
 *   version (parsed from the banner, the same place nvidia-smi prints it).
 * - `vulkaninfo` → a Vulkan loader on PATH (driver + loader installed).
 * - `rocminfo` → an AMD ROCm userspace (Linux/Windows HIP runtimes).
 * - `clinfo` → an OpenCL runtime, the weakest signal for an Intel SYCL stack.
 * - macOS → Metal is part of the OS; no probe exists to fail.
 * - CPU is always available as the last resort (llama.cpp only).
 *
 * Everything runs with short timeouts and swallows failures: a missing tool
 * is a `not-found` check row, never an error response. Results are reports —
 * the console decides what to offer; `recommend()` only proposes.
 */
import { execFile } from 'node:child_process';
import type { EngineDetectSummary } from './engines.js';

export interface DepCheck {
  id: string;
  ok: boolean;
  label: string;
  /** Human-readable detail (`NVIDIA GeForce RTX 4070 · driver 566.36 · CUDA 12.7`). */
  detail: string;
}

export interface DetectReport {
  platform: string;
  arch: string;
  /** Discrete GPUs as printed by the vendor tools (may be empty). */
  gpus: string[];
  /** Driver-reported max CUDA version (`12.7`), absent without an NVIDIA stack. */
  cudaVersion?: string;
  /** Total discrete VRAM in MiB (NVIDIA only), for model-fit hints. */
  vramMb?: number;
  /** Currently FREE discrete VRAM in MiB (NVIDIA only) — the machine panel's
   *  "available" readout. */
  vramFreeMb?: number;
  checks: DepCheck[];
}

function run(command: string, args: string[], timeoutMs = 6000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        resolve({ ok: !err, stdout: typeof stdout === 'string' ? stdout : '' });
      });
    } catch {
      resolve({ ok: false, stdout: '' });
    }
  });
}

async function detectNvidia(): Promise<{ present: boolean; gpus: string[]; driver: string; cudaVersion?: string; vramMb?: number; vramFreeMb?: number }> {
  const res = await run('nvidia-smi', []);
  if (!res.ok || !res.stdout.trim()) return { present: false, gpus: [], driver: '' };
  const out = res.stdout;
  const driver = /\bDriver Version:\s*([0-9.]+)/.exec(out)?.[1] ?? '';
  const cudaVersion = /\bCUDA Version:\s*([0-9.]+)/.exec(out)?.[1];
  const gpus: string[] = [];
  for (const line of out.split('\n')) {
    // The process table also names GPUs; only the device rows start with an
    // index. Match the `0  NVIDIA GeForce ...` shape before the MiB columns.
    const match = /^\s*(\d+)\s+(\S[^|]*?)\s{2,}[\d.]+MiB/.exec(line);
    if (match) gpus.push(match[2].trim());
  }
  if (gpus.length === 0 && /NVIDIA/i.test(out)) gpus.push('NVIDIA GPU');
  // Fit-hint metric: sum every GPU's frame buffer (csv keeps the parse dull).
  const vram = await run('nvidia-smi', ['--query-gpu=memory.total,memory.free', '--format=csv,noheader,nounits'], 6000);
  let vramMb: number | undefined;
  let vramFreeMb: number | undefined;
  if (vram.ok) {
    for (const line of vram.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [totalRaw, freeRaw] = line.split(',');
      const total = Number(totalRaw?.trim());
      const free = Number(freeRaw?.trim());
      // A full card reports 0 free. That is a reading, not a missing probe —
      // dropping it hides the one case the run page warns about.
      if (!Number.isFinite(total) || total <= 0) continue;
      vramMb = (vramMb ?? 0) + total;
      if (Number.isFinite(free) && free >= 0) vramFreeMb = (vramFreeMb ?? 0) + free;
    }
  }
  return { present: gpus.length > 0, gpus, driver, ...(cudaVersion ? { cudaVersion } : {}), ...(vramMb != null ? { vramMb } : {}), ...(vramFreeMb != null ? { vramFreeMb } : {}) };
}

async function detectVulkan(): Promise<boolean> {
  const res = await run('vulkaninfo', ['--summary'], 8000);
  return res.ok && /GPU/i.test(res.stdout);
}

async function detectRocm(): Promise<{ present: boolean; gpus: string[] }> {
  const res = await run('rocminfo', [], 8000);
  if (!res.ok) return { present: false, gpus: [] };
  const gpus: string[] = [];
  for (const line of res.stdout.split('\n')) {
    const match = /Marketing Name:\s*(.+)/.exec(line);
    if (match && /AMD|Advanced Micro/i.test(res.stdout)) gpus.push(match[1].trim());
  }
  return { present: true, gpus: gpus.slice(0, 4) };
}

async function detectCl(): Promise<boolean> {
  const res = await run('clinfo', [], 8000);
  return res.ok && /Device Name/i.test(res.stdout);
}

/** Probe the machine once and return the raw report. */
export async function detectDependencies(): Promise<DetectReport> {
  const [nvidia, vulkan, rocm, cl] = await Promise.all([detectNvidia(), detectVulkan(), detectRocm(), detectCl()]);
  const isMac = process.platform === 'darwin';
  const checks: DepCheck[] = [];
  const gpus: string[] = [...nvidia.gpus, ...rocm.gpus];

  checks.push({
    id: 'nvidia-driver',
    ok: nvidia.present,
    label: 'NVIDIA GPU / driver',
    detail: nvidia.present
      ? `${nvidia.gpus.join(', ')}${nvidia.driver ? ` · driver ${nvidia.driver}` : ''}${nvidia.cudaVersion ? ` · CUDA ${nvidia.cudaVersion}` : ''}`
      : 'nvidia-smi not found',
  });
  if (!isMac) {
    checks.push({ id: 'vulkan', ok: vulkan, label: 'Vulkan runtime', detail: vulkan ? 'vulkaninfo reports a GPU' : 'vulkaninfo not found' });
    checks.push({
      id: 'amd-rocm',
      ok: rocm.present,
      label: 'AMD ROCm / HIP',
      detail: rocm.present ? (rocm.gpus.join(', ') || 'rocminfo present') : 'rocminfo not found',
    });
    checks.push({ id: 'intel-sycl', ok: cl, label: 'Intel SYCL / OpenCL', detail: cl ? 'clinfo reports a device' : 'clinfo not found' });
  } else {
    checks.push({ id: 'apple-metal', ok: true, label: 'Metal', detail: 'built into macOS' });
  }
  checks.push({ id: 'cpu', ok: true, label: 'CPU', detail: `${process.arch} ${process.platform}` });

  return {
    platform: process.platform,
    arch: process.arch,
    gpus,
    ...(nvidia.cudaVersion ? { cudaVersion: nvidia.cudaVersion } : {}),
    ...(nvidia.vramMb != null ? { vramMb: nvidia.vramMb } : {}),
    ...(nvidia.vramFreeMb != null ? { vramFreeMb: nvidia.vramFreeMb } : {}),
    checks,
  };
}

/**
 * The machine facts a per-engine target recommendation reads (ADR-0039: the
 * recommendation lives on the ENGINE, so this stays a neutral summary).
 */
export function summarizeDetect(report: DetectReport): EngineDetectSummary {
  const ok = (id: string) => report.checks.some((check) => check.id === id && check.ok);
  const cudaMajor = report.cudaVersion ? Number(report.cudaVersion.split('.')[0]) || 0 : 0;
  return {
    platform: report.platform,
    arch: report.arch,
    nvidia: ok('nvidia-driver'),
    cudaMajor,
    amdRocm: ok('amd-rocm'),
    vulkan: ok('vulkan'),
  };
}

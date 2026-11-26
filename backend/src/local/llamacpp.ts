/**
 * llama.cpp runtime — the reference implementation of `EngineRuntime`.
 *
 * llama-server is the permissive engine: any GGUF, gateway-owned placement
 * (`-ngl N` is literally the plan made literal), and every shared run control
 * maps onto a flag. It therefore declares `placement: 'gateway'`, no profile,
 * and one leg — which is also the smallest possible runtime, and the shape a
 * new engine can copy when it has nothing engine-specific to ask the operator.
 */
import path from 'node:path';
import type { EngineLeg, EngineRuntime } from './engine-runtime.js';

/** The run-option slice llama.cpp's argv reads. */
export interface LlamaRunOptionsLike {
  flashAttn: boolean;
  kvCacheQ8: boolean;
  reasoning: boolean;
  threads: number;
  extraArgs: string[];
}

export interface LlamaLaunchFacts {
  port: number;
  host: string;
  ctx: number;
  ngl: number;
  /** The operator-chosen model name (ADR-0038 §7) — served as `--alias`. */
  servedName?: string;
  options: LlamaRunOptionsLike;
}

/** llama-server argument list for one launch — the plan made literal. */
export function llamaServerArgs(run: LlamaLaunchFacts, modelPath: string): string[] {
  const args = [
    '-m', modelPath,
    '--host', run.host,
    '--port', String(run.port),
    '-c', String(run.ctx),
    '-ngl', String(run.ngl),
    // Verbosity 4 keeps the device enumeration and memory breakdown in the
    // log ring (recent llama.cpp builds print them only at -lv ≥ 4); the
    // console's log viewer is how operators verify GPU offload.
    '-lv', '4',
  ];
  // The server answers as the operator's name, so its /v1/models and the
  // gateway's `local/<name>` registration never disagree.
  if (run.servedName) args.push('--alias', run.servedName);
  if (run.options.flashAttn) args.push('--flash-attn', 'on');
  if (run.options.kvCacheQ8) args.push('--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0');
  if (run.options.reasoning) args.push('--jinja', '--reasoning-format', 'auto');
  if (run.options.threads > 0) args.push('-t', String(run.options.threads));
  args.push(...run.options.extraArgs);
  return args;
}

export const LLAMACPP_RUNTIME: EngineRuntime = {
  // The layer planner computes the split; `-ngl` is how it is handed over.
  placement: 'gateway',
  accepts: { ngl: true, threads: true, flashAttn: true, kv: true, reasoning: true, spec: false, vision: false },
  serves: ({ modelPath }) => (
    modelPath.toLowerCase().endsWith('.gguf')
      ? { serves: true, family: true }
      : { serves: false, reason: 'llama.cpp loads GGUF checkpoints; this file is not one, so this engine cannot serve it' }
  ),
  legs: async (facts) => {
    const leg: EngineLeg = {
      key: facts.runId,
      cmd: facts.binary,
      args: llamaServerArgs(
        { port: facts.port, host: facts.host, ctx: facts.ctx, ngl: facts.ngl, ...(facts.servedName ? { servedName: facts.servedName } : {}), options: facts.options },
        facts.modelPath,
      ),
      cwd: path.dirname(facts.binary),
      aux: false,
    };
    return [leg];
  },
};

/** Directory a llama.cpp binary's runtime DLLs live in. */
export function llamacppCwd(binary: string): string {
  return path.dirname(binary);
}

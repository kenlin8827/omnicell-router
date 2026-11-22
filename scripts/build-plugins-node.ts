/**
 * Node fallback for the plugin packager: `scripts/build-plugins.ts` driven
 * under Node by shimming `Bun.build` with esbuild. The permanent path stays
 * `bun run plugins:build`; this exists because a dev machine without Bun
 * could not refresh `.plugin-dist` at all, and a stale zip is worse than a
 * differently-bundled one (it seeds a package whose parts no longer match
 * the manifests in `plugins/`).
 *
 * Same options the packager passes (target node / format esm / one entry);
 * one addition — a `createRequire` banner, because a CJS dependency doing a
 * dynamic `require('process')` compiles to a THROWING shim in esbuild's ESM
 * output while Bun resolves it statically. The banner gives that shim a real
 * `require`; the packer's own `import.meta.require` ban still holds (the
 * banner spells `createRequire`, which Node 18+ supports).
 *
 * Byte caveat: artifacts built here differ from Bun-built ones. Expected —
 * `plugins:check` is platform-pinned by design (see build-plugins.ts header),
 * and `.plugin-dist` is a local build output, never committed.
 */
import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

type BunBuildOptions = {
  entrypoints: string[];
  outdir: string;
  target: 'node';
  format: 'esm';
  sourcemap: 'none';
};

const runtime = globalThis as unknown as { Bun?: { build?: unknown } };
runtime.Bun = {
  ...(runtime.Bun ?? {}),
  build: async (options: BunBuildOptions) => {
    const result = await esbuild.build({
      entryPoints: options.entrypoints,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node18',
      sourcemap: false,
      splitting: false,
      write: true,
      outdir: options.outdir,
      logLevel: 'silent',
      absWorkingDir: process.cwd(),
      banner: {
        js: "import { createRequire as __ocrCreateRequire } from 'node:module';\nconst require = __ocrCreateRequire(import.meta.url);",
      },
    });
    // pack.ts reads the emitted file from outdir; with write:true esbuild
    // reports no outputFiles, so list what landed there instead.
    const outputs = readdirSync(options.outdir)
      .filter((name) => !name.endsWith('.map'))
      .map((name) => ({ path: join(options.outdir, name) }));
    return {
      success: result.errors.length === 0,
      logs: [...result.errors, ...result.warnings].map((m) => ({ message: m.text })),
      outputs,
    };
  },
};

await import('./build-plugins.js');

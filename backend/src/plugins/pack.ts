import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { zipSync, type Zippable } from 'fflate';

/**
 * The ONE plugin packager: `scripts/build-plugins.ts` writes its zips with it
 * and the console's package export (`GET /api/admin/plugins/:id/package`)
 * zips a dev-tree plugin with it. Sharing the walker means an exported dev
 * plugin is the same bytes `plugins:build` would have written — a download
 * round-trips through Install, and `plugins:check` still catches drift.
 *
 * A package is SELF-CONTAINED: the entry is bundled (third-party imports
 * inlined) into ONE ESM module. The runtime never gets to resolve bare
 * specifiers from disk — the release sidecar is a `bun build --compile`
 * binary, and compiled executables only resolve packages from the embedded
 * snapshot (ADR-0017 §6). Source files and `node_modules` therefore never
 * ship: they would be dead weight at best, and a source-only package is
 * actively refused by the host loader.
 */

/** Entry name every package carries (host.ts prefers it for packaged plugins). */
export const PACKAGE_ENTRY = 'index.js';

/** Source entry candidates, dev-tree priority order. */
const SOURCE_ENTRIES = ['index.ts', 'index.js'] as const;

/**
 * Fixed entry mtime for every packaged file. Without it fflate stamps the
 * CURRENT time into the zip (2-second DOS resolution), so two runs seconds
 * apart produce different bytes — which makes `--check` (and any byte-level
 * drift guard) fail unconditionally. A fixed stamp makes the package
 * reproducible: same sources ⇒ same bytes, forever.
 */
const ZIP_ENTRY_MTIME = new Date('2000-01-01T00:00:00Z');

/** Files that are INLINED into the bundle and must not ship twice. */
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/i;
/** Directories that never belong in a package (deps are bundled; tests are dev-only). */
const SKIPPED_DIRS: Record<string, true> = { node_modules: true, tests: true };
/** Module-type marker every package carries. The entry is ESM, and a bare
 *  `.js` file is only ESM by DEFAULT from Node 20.19 / 22.7 on (syntax
 *  detection); on the Node >= 18 releases the README also supports, a `.js`
 *  without this file is parsed as CommonJS and dies on the first `export`.
 *  Bun ignores it, so one marker serves every runtime.
 *
 *  A source `package.json` is NOT shipped (see `collectPluginAssets`): the
 *  bundle is self-contained, so its dependency list would be a lie, and its
 *  `type` could contradict the ESM output. */
const PACKAGE_MANIFEST = 'package.json';
const PACKAGE_MANIFEST_BODY = `${JSON.stringify({ type: 'module' }, null, 2)}\n`;

interface BunBuildResult {
  success: boolean;
  outputs: { path: string }[];
  logs: { message?: string }[];
}

type BunBuildFn = (options: {
  entrypoints: string[];
  outdir: string;
  /** 'node' — a BUNDLED plugin must run on the Node entry point too, not just
   *  the Bun sidecar (see the target comment in `bundlePluginDir`). */
  target: 'node';
  format: 'esm';
  sourcemap: 'none';
}) => Promise<BunBuildResult>;

/** Import/require spellings the bundler emits for a module it did NOT inline.
 *  A wrapped import list (`import {`\n`  a,`\n`} from "pkg"`) puts the specifier
 *  on its own `} from` line, and a dynamic `import("pkg")` carries no static
 *  from-clause at all — both are scanned, or the external-dependency guard
 *  silently passes a package that cannot load on a compiled host. */
const MODULE_SPECIFIER_PATTERNS = [
  /^\s*import\s*["']([^"']+)["']/,
  /^\s*(?:import|export)[^"']*\bfrom\s*["']([^"']+)["']/,
  /^\s*\}?\s*from\s*["']([^"']+)["']/,
  /^\s*(?:[^=\n]+?=\s*)?__require\(\s*["']([^"']+)["']\s*\)/,
  /\bimport\(\s*["']([^"']+)["']\s*\)/,
] as const;

const BUILTIN_MODULE = new Set(builtinModules);

/** Bare specifiers the bundle still needs at RUNTIME. A compiled host can only
 *  resolve Node builtins; anything else here means the package will fail on a
 *  user's machine, so packaging refuses it instead. */
export function externalSpecifiers(bundle: string): string[] {
  const found = new Set<string>();
  for (const line of bundle.split('\n')) {
    for (const pattern of MODULE_SPECIFIER_PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('node:') || BUILTIN_MODULE.has(specifier)) continue;
      found.add(specifier);
    }
  }
  return [...found];
}

/** Bun's bundler is a runtime API, present only under Bun (the packaged plugin
 *  runtime). A missing runtime is a hard failure: the fallback (shipping source
 *  with unresolved bare imports) is exactly the artifact that cannot load. */
function bunBuild(): BunBuildFn {
  // Bun is not in the node tsconfig's globals; the named cast keeps the one
  // unchecked access in a single, explainable place.
  const runtime = globalThis as unknown as { Bun?: { build?: BunBuildFn } };
  const fn = runtime.Bun?.build;
  if (!fn) throw new Error('plugin bundling requires the Bun runtime (Bun.build unavailable)');
  return fn;
}

/** Files one plugin ships next to the bundle — the whole dir minus editor
 *  junk, sources, dev-only directories and stale package copies. Symlinks are
 *  skipped rather than followed: this walker also runs behind an HTTP route,
 *  where following a link would turn export into an arbitrary-file read. The
 *  root `package.json` is replaced by the module-type marker, never shipped. */
export function collectPluginAssets(dir: string): Zippable {
  const out: Zippable = {};
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    // SORTED: the zip entry order (hence the bytes) must never depend on the
    // filesystem's enumeration order — `plugins:check` compares bytes.
    for (const name of readdirSync(abs).sort()) {
      if (name === '.' || name === '..' || name.startsWith('.')) continue;
      const child = rel ? `${rel}/${name}` : name;
      const childAbs = join(abs, name);
      const stat = lstatSync(childAbs);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        // At ANY depth: dependencies are bundled into the entry and tests are
        // dev-only, so neither can be resolved (or is wanted) at runtime.
        if (SKIPPED_DIRS[name]) continue;
        walk(child);
        continue;
      }
      // Sources are inlined at ANY depth (the flattening drops their paths
      // anyway); at the root `index.js`/`*.zip` are also stale byproducts —
      // the bundle replaces the entry, and a package copy inside the source
      // tree would ship itself.
      if (SOURCE_FILE.test(name)) continue;
      if (!rel && (name === PACKAGE_ENTRY || name === PACKAGE_MANIFEST || /\.zip$/i.test(name))) continue;
      out[child] = [new Uint8Array(readFileSync(childAbs)), { mtime: ZIP_ENTRY_MTIME }];
    }
  };
  walk('');
  return out;
}

/** Bun stamps every bundled module with a `// <path>` header rendered
 *  relative to the PROCESS CWD, so identical sources would otherwise package
 *  to different bytes depending on where the host was launched (breaking
 *  `plugins:check` and the export byte-identity contract). The paths carry no
 *  runtime meaning — sourcemaps are off — so the comment lines are dropped.
 *  The path may contain SPACES (`C:\Users\John Doe\…`) — and, when the build
 *  runs inside the plugin dir, it is a BARE file name (`index.ts`) with no
 *  separator at all. Both forms are matched: a single whitespace-delimited
 *  token, or anything carrying a path separator. The narrow `\S+`-only form
 *  silently left the header in place on such machines, which reintroduced the
 *  cwd-dependent bytes this strip exists to remove. */
const BUNDLE_PATH_COMMENT = /^\/\/(?: \S+|[^\n]*[\\/][^\n]*)\.(?:js|ts|tsx|jsx|mjs|cjs|json)\r?\n/gm;

/** Bun's own module loader is the ONLY place this exists — see the target
 *  choice in `bundlePluginDir`. */
const BUN_ONLY_RUNTIME_API = /\bimport\.meta\.require\b/;

/** Bun.build rejects with an AggregateError whose per-module diagnostics
 *  (including `Could not resolve: ...`) live on a non-enumerable `errors`
 *  array; the bare message is just "Bundle failed", useless to a plugin
 *  author. Flatten those messages into the thrown error. */
function buildErrorDetail(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'errors' in err && Array.isArray(err.errors)) {
    const messages = err.errors.map((item: unknown) =>
      typeof item === 'object' && item !== null && 'message' in item ? String(item.message) : String(item)
    );
    if (messages.length > 0) return messages.join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}

/** Bundle one plugin into a single self-contained ESM entry and zip it with
 *  its runtime assets. Deterministic: fixed entry mtimes, unbundled sources
 *  excluded, no absolute build paths in the output. */
export async function bundlePluginDir(dir: string): Promise<Uint8Array> {
  const entry = SOURCE_ENTRIES.map((name) => join(dir, name)).find((file) => existsSync(file));
  if (!entry) throw new Error(`plugin entry missing (expected ${SOURCE_ENTRIES.join(' or ')})`);
  const outdir = mkdtempSync(join(tmpdir(), 'ocr-plugin-build-'));
  try {
    let result: BunBuildResult;
    try {
      result = await bunBuild()({
        entrypoints: [entry],
        outdir,
        // NODE, not `bun`: the host runs on both (the compiled-Bun sidecar and
        // `node backend/dist/index.js`, which the README supports from Node 18).
        // A `bun` target emits `var __require = import.meta.require` for CJS
        // interop inside inlined dependencies — a BUN-ONLY API, so the package
        // loaded fine under Bun and died on Node with `__require is not a
        // function`. The `node` target's output runs unchanged on both.
        target: 'node',
        format: 'esm',
        sourcemap: 'none',
      });
    } catch (err) {
      throw new Error(`plugin bundle failed: ${buildErrorDetail(err)}`);
    }
    if (!result.success) {
      const why = result.logs.map((log) => log.message ?? String(log)).join('; ');
      throw new Error(`plugin bundle failed: ${why || 'unknown build error'}`);
    }
    const outputs = result.outputs.map((o) => o.path);
    const output = outputs.find((file) => basename(file) === PACKAGE_ENTRY);
    if (!output) throw new Error(`plugin bundle produced no ${PACKAGE_ENTRY}`);
    // A second output (a split chunk, an emitted asset) is NOT shipped — the
    // package would reference a file that is not in it. Refuse instead of
    // silently dropping it.
    const extra = outputs.filter((file) => file !== output).map((file) => basename(file));
    if (extra.length > 0) {
      throw new Error(
        `plugin bundle produced extra files (${extra.join(', ')}); a package ships exactly one ${PACKAGE_ENTRY} plus the plugin's own assets — inline whatever produced them`
      );
    }
    const files = collectPluginAssets(dir);
    const bundleText = new TextDecoder().decode(readFileSync(output)).replace(BUNDLE_PATH_COMMENT, '');
    // Belt and braces for the target above: `import.meta.require` exists only
    // under Bun (`target: 'bun'` injects it for CJS interop), so a package
    // carrying it must never ship — it would load under the sidecar and throw
    // on the Node entry point.
    if (BUN_ONLY_RUNTIME_API.test(bundleText)) {
      throw new Error(
        'plugin bundle references import.meta.require (Bun-only); the package must run on the Node runtime too — replace `createRequire(import.meta.url)` / dynamic require with a static import'
      );
    }
    const external = externalSpecifiers(bundleText);
    if (external.length > 0) {
      throw new Error(
        `plugin bundle still references external packages (${external.join(', ')}); a compiled host cannot resolve them at runtime — import them statically (or ship the asset) so the packager can inline them`
      );
    }
    files[PACKAGE_ENTRY] = [new TextEncoder().encode(bundleText), { mtime: ZIP_ENTRY_MTIME }];
    files[PACKAGE_MANIFEST] = [new TextEncoder().encode(PACKAGE_MANIFEST_BODY), { mtime: ZIP_ENTRY_MTIME }];
    return zipSync(files);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

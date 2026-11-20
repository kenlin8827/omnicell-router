import fs from 'node:fs';
import type { CredentialPaths } from './paths.js';
import { resolveOpencodeConfigPath } from './paths.js';
import { CLIENT_COMPATIBLE_PACKAGE, readJsonc } from '../user-config.js';
import { currentPackageFor, opencodePackageFor } from '../provider-package.js';
import { wireFor, type CoreWireKind } from '../../providers/wire.js';
import { isPluginWire } from '../../providers/plugin-wires.js';
import { clientDefNodes, writeDefSlot } from '../provider-def-adapters.js';
import { readProviderDefsFile } from '../provider-defs.js';

export interface DefMaterializeOutcome {
  ok: boolean;
  /** provider nodes rendered into the client jsonc `providers` slot. */
  rendered: number;
  /**
   * Defs the client defines itself (its own integration catalog) and therefore
   * did NOT receive a config node — their keys alone carry them. Recorded so the
   * drift badge compares the same render set a push would.
   */
  skippedBuiltIn: string[];
  /**
   * True when the client slot actually had to be rewritten (target map differs
   * from what the client already had). Drives the reload decision: an unchanged
   * render must never cost a service reload.
   */
  changed: boolean;
  detail?: string;
}

/** Pre-sync capture of the operator's client config (refreshed on every change). */
const CLIENT_BACKUP_SUFFIX = '.bak.ocr-defs';

/**
 * Does the client's `providers` slot differ from what a push would render?
 *
 * The ONE comparison in the codebase: `materializeDefs` decides whether to
 * write with it, and the sync status view decides the `defsDrift` badge with it,
 * so the badge can never disagree with what a push would do. Order-sensitive by
 * intent — the defs file is the order truth (the console grid renders in its
 * sequence), so an order change IS a change. The render set is the book minus the
 * ids the CLIENT defines itself (see renderTarget) — a custom provider's def is
 * always written, a built-in one travels as keys only.
 */
export function defsRenderChanged(
  clientNodes: unknown,
  providers: Record<string, any>,
  skippedBuiltIn: readonly string[] = []
): boolean {
  const current =
    typeof clientNodes === 'object' && clientNodes !== null && !Array.isArray(clientNodes) ? clientNodes : null;
  const target = clientRenderableDefs(renderTarget(providers, skippedBuiltIn));
  // "nothing to render, nothing in the client" is a match — not a rewrite.
  if (current === null && Object.keys(target).length === 0) return false;
  return JSON.stringify(current) !== JSON.stringify(target);
}

/**
 * Client support for a package, per OCR's wire vocabulary — a ONE-LINE switch-back.
 *
 * The client's `package` strings are a closed set, and a wire it has no package
 * for cannot be served by it at all. `systemone` (TypeSafe decision protocol) is
 * that case today: the SDK module exists (`typesafe-ai`) but exposes only
 * `experimental.evaluation`, and the client's config loader knows no such
 * segment, so a node carrying it would be dead weight. The book keeps the def
 * exactly as authored (OCR's own wire inference still reads `systemone`); only
 * the CLIENT copy is substituted, and the substitution is recorded here rather
 * than probed at runtime — the client registers a model from the node's `models`
 * map whether or not the package resolves, so a probe would answer "fine" for a
 * package that cannot serve a request.
 *
 * When a future client ships the segment, change the value (or delete the entry)
 * and every def switches back on the next push — no data edits, no other code.
 * The substitute answers only "can the client LOAD it"; whether the upstream
 * speaks that protocol is a vendor fact (ark does, api.typesafe.ai does not).
 */
const CLIENT_PACKAGE_FALLBACK: Partial<Record<CoreWireKind, string>> = {
  systemone: CLIENT_COMPATIBLE_PACKAGE,
};

/** The package the client loads for a wire it has no SDK segment for. Core
 *  wires declare theirs above; EVERY plugin wire has none by definition (the
 *  transport is vendored inside the plugin), so the substitution is derived
 *  from `isPluginWire` rather than spelled per vendor here. */
function clientPackageFallbackFor(wire: string): string | undefined {
  const declared = CLIENT_PACKAGE_FALLBACK[wire as CoreWireKind];
  if (declared) return declared;
  return isPluginWire(wire) ? CLIENT_COMPATIBLE_PACKAGE : undefined;
}

/**
 * Translate every retired package spelling in a node (provider package +
 * model-level provider packages) to the OCR protocol id. The book may predate
 * the vocabulary retirement; the client copy is mapped to the SDK package
 * afterwards and must never carry a retired spelling.
 */
function currentPackageNode(node: any): any {
  let out = node;
  if (typeof node?.package === 'string') {
    const pkg = currentPackageFor(node.package);
    if (pkg !== node.package) out = { ...out, package: pkg };
  }
  const models = out?.models;
  if (models && typeof models === 'object') {
    let changed = false;
    const next: Record<string, any> = {};
    for (const [mid, model] of Object.entries(models)) {
      const provider = (model as any)?.provider;
      if (provider && typeof provider.package === 'string') {
        const pkg = currentPackageFor(provider.package);
        if (pkg !== provider.package) {
          next[mid] = { ...(model as any), provider: { ...provider, package: pkg } };
          changed = true;
          continue;
        }
      }
      next[mid] = model;
    }
    if (changed) out = { ...out, models: next };
  }
  return out;
}
/**
 * The map a push writes: the render set with client-unloadable packages
 * substituted (see CLIENT_PACKAGE_FALLBACK). Deterministic from the book, so the
 * drift badge and the write compare the exact same thing.
 */
/** Strip credential-bearing fields before a client-facing materialization. */
function stripSecretsFromDefNode(node: any): any {
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, any> = { ...node };
  if (out.settings && typeof out.settings === 'object') {
    const { apiKey: _k, ...rest } = out.settings;
    out.settings = rest;
  }
  if (out.options && typeof out.options === 'object') {
    const { apiKey: _k, ...rest } = out.options;
    out.options = rest;
  }
  const redactHeaders = (headers: Record<string, unknown> | undefined) => {
    if (!headers || typeof headers !== 'object') return headers;
    return Object.fromEntries(
      Object.entries(headers).map(([k, v]) =>
        /authorization|api[-_]?key|-key\b|token|secret|cookie|password|credential|bearer|signature|x-auth|proxy-auth|\bauth\b|\bkey\b/i.test(
          k,
        )
          ? [k, '[REDACTED]']
          : [k, v],
      ),
    );
  };
  if (out.headers) out.headers = redactHeaders(out.headers);
  if (out.settings?.headers) {
    out.settings = { ...out.settings, headers: redactHeaders(out.settings.headers) };
  }
  if (out.options?.headers) {
    out.options = { ...out.options, headers: redactHeaders(out.options.headers) };
  }
  if (out.models && typeof out.models === 'object') {
    const nextModels: Record<string, any> = {};
    for (const [mid, model] of Object.entries(out.models)) {
      nextModels[mid] = stripSecretsFromDefNode(model);
    }
    out.models = nextModels;
  }
  return out;
}

function resolveClientPackage(pkg: string): string {
  const normalized = currentPackageFor(pkg);
  const fallback = clientPackageFallbackFor(wireFor(normalized));
  return opencodePackageFor(fallback ?? normalized);
}

export function clientRenderableDefs(providers: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [id, rawNode] of Object.entries(providers)) {
    const node = currentPackageNode(rawNode);
    out[id] = opencodePackageNode(stripSecretsFromDefNode(node));
  }
  return out;
}

/**
 * The client file speaks opencode's SDK package vocabulary, not OCR's protocol
 * ids: translate provider- and model-level packages on the way out (the
 * inverse table lives in `provider-package.ts`).
 */
function opencodePackageNode(node: any): any {
  let out = node;
  if (typeof node?.package === 'string') {
    out = { ...out, package: resolveClientPackage(node.package) };
  }
  if (node?.models && typeof node.models === 'object') {
    let changed = false;
    const models: Record<string, any> = {};
    for (const [mid, model] of Object.entries(node.models)) {
      const provider = (model as any)?.provider;
      if (provider && typeof provider.package === 'string') {
        models[mid] = { ...(model as any), provider: { ...provider, package: resolveClientPackage(provider.package) } };
        changed = true;
        continue;
      }
      models[mid] = model;
    }
    if (changed) out = { ...out, models };
  }
  return out;
}

/**
 * What a push would actually write: the book MINUS the ids the client defines
 * itself. Built-in providers need no config node (their package/baseURL/models
 * come from the client's integration catalog) — only their keys travel. A relay
 * or any other id the catalog does not know is custom and must be written.
 */
function renderTarget(
  providers: Record<string, any>,
  skippedBuiltIn: readonly string[]
): Record<string, any> {
  if (skippedBuiltIn.length === 0) return providers;
  const skip = new Set(skippedBuiltIn);
  const out: Record<string, any> = {};
  for (const [id, node] of Object.entries(providers)) if (!skip.has(id)) out[id] = node;
  return out;
}

/**
 * Materialize the OCR defs file into the opencode client's config — the def
 * half of the v2 sync client's write direction (the key half lives in sync.ts).
 *
 * REPLACE semantics: the defs file's `providers` map REPLACES the whole jsonc
 * `providers` node VERBATIM — an identity render, never re-shaped through the
 * def builder (fields the builder does not know would be silently dropped; the
 * defs file already stores the v2 file spelling). Comment-preserving text-level
 * edit: comments OUTSIDE the slot survive; comments inside the slot die with
 * the render. The pre-sync file is kept as `<config><.bak.ocr-defs>`.
 *
 * Failure doctrine: an unparsable client jsonc is REFUSED, never clobbered
 * (we could not preserve what we cannot parse); a MISSING defs book is refused
 * too when the client slot holds nodes — "absent" is not "empty", and REPLACE
 * over an unreadable book would delete client defs we cannot reproduce. A
 * genuinely empty (but valid) defs book still REPLACEs: that is def delete
 * propagation. A missing jsonc is created — that is the point of the write.
 */
export function materializeDefs(
  paths: CredentialPaths,
  configPathOverride?: string,
  opts: { clientDefinedIds?: ReadonlySet<string> } = {}
): DefMaterializeOutcome {
  const configPath = configPathOverride ?? resolveOpencodeConfigPath(paths);
  const clientConfig = fs.existsSync(configPath) ? readJsonc(configPath) : undefined;
  if (fs.existsSync(configPath) && clientConfig === undefined) {
    return {
      ok: false,
      rendered: 0,
      skippedBuiltIn: [],
      changed: false,
      detail: `opencode.jsonc unparsable — refusing to materialize (never clobber what cannot be parsed): ${configPath}`,
    };
  }
  const clientNodes = clientDefNodes(clientConfig);

  const file = readProviderDefsFile(paths);
  if (!file) {
    // Missing / corrupt / wrong-version defs book. Distinguishing this from
    // `providers: {}` is the whole guard: REPLACE over an unreadable book
    // would silently delete every provider node in the client config.
    const existingNodes = clientNodes ? Object.keys(clientNodes).length : 0;
    if (existingNodes > 0) {
      return {
        ok: false,
        rendered: 0,
        skippedBuiltIn: [],
        changed: false,
        detail: `provider defs file missing or unreadable — refusing to REPLACE ${existingNodes} client provider node(s): ${configPath}`,
      };
    }
    return { ok: true, rendered: 0, skippedBuiltIn: [], changed: false }; // nothing to render, nothing to destroy
  }

  const skippedBuiltIn = file.providers && opts.clientDefinedIds
    ? Object.keys(file.providers).filter((id) => opts.clientDefinedIds!.has(id))
    : [];
  const providers = clientRenderableDefs(renderTarget(file.providers, skippedBuiltIn));
  const rendered = Object.keys(providers).length;
  const changed = defsRenderChanged(clientNodes, providers);
  if (!changed) return { ok: true, rendered, skippedBuiltIn, changed: false };
  // Refresh the pre-sync copy on EVERY change (the CLI setup backup doctrine):
  // a stale first-capture .bak would be useless for the wipe the operator
  // actually needs to undo. Best-effort — a backup failure never blocks the
  // converge (the defs book is the truth and is still intact on disk).
  try {
    // Create the backup with owner-only mode from the first byte — copyFileSync
    // inherits the source mode (often 0644) and leaves a wide window before
    // chmod. wx fails if a stale backup already exists; unlink then retry.
    const backup = `${configPath}${CLIENT_BACKUP_SUFFIX}`;
    const payload = fs.readFileSync(configPath);
    const writeBackup = () => {
      const fd = fs.openSync(backup, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, payload);
      } finally {
        fs.closeSync(fd);
      }
    };
    try {
      writeBackup();
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      fs.unlinkSync(backup);
      writeBackup();
    }
    try {
      fs.chmodSync(backup, 0o600);
    } catch {
      /* Windows chmod is advisory */
    }
  } catch {
    // missing client file (first write) / unreadable — nothing to preserve
  }
  try {
    // The adapter layer owns the layout: REPLACE the canonical slot (comments
    // outside it survive).
    writeDefSlot(configPath, providers);
    return { ok: true, rendered, skippedBuiltIn, changed: true };
  } catch (e) {
    return {
      ok: false,
      rendered: 0,
      skippedBuiltIn: [],
      changed: false,
      detail: `opencode.jsonc materialization write failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

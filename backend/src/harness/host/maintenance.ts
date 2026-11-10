import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getOcrHomeDir } from '../../cli/paths.js';
import { resolveEnvName } from '../../config/env.js';
import { arrayAtPath, readConfigJson, setArrayAtPath, valueAtPath, writeConfigJson } from '../config-file.js';
import { parsePluginSpec } from './discover.js';
import { HOST_ADAPTERS, adapterFor, isPluginHost, isMcpHost } from './adapters/index.js';
import { defaultExec, type ExecImpl } from './writers/plugin.js';
import { echoArgv, MCP_CLI_TIMEOUT_MS } from './writers/mcp.js';
import { mcpContainerAt, readMcpLandingFile } from './mcp-entry.js';
import { recordApply } from './ledger.js';
import { claimOwner, readManifest, releaseClaim, writeManifest } from './manifest.js';
import { skillRoots } from './inventory.js';
import { copyDrift } from './drift.js';
import type { ArtifactRecord, CopyRecord, DiscoveredRemoval, HarnessHostId, HarnessScope } from '../types.js';

/**
 * Maintenance writes for harness artifacts (ADR-0015 §D5).
 *
 * The op follows the artifact's LANDING SHAPE, never its provenance — that is the whole design:
 *
 *   file tree / loose file   → move-to-trash   (reversible through the trash)
 *   config array entry       → drop-entry      (`plugin[]`, pi `packages[]`: one string)
 *   config object member     → drop-server     (an MCP server inside `mcp`)
 *   package, no declaration  → prune-record    (nothing of ours to touch)
 *
 * Provenance decides nothing here: a discovered row and a tracked copy of the same package land in
 * the same place and are removed by the same op. What the shape DOES decide is what may be destroyed:
 * a copy whose `path` is the runtime's own CONFIG FILE must never be trashed — moving
 * `opencode.json` to the trash would delete every other server and plugin in it, which is why a
 * config landing is removed member-by-member here instead.
 *
 * A plan may span SEVERAL artifacts, because uninstall is a location-level choice in the console: the
 * operator ticks individual `(host, path)` positions, which usually belong to different artifacts.
 * The whole plan is one transaction — trash snapshot per moved directory, manifest pruning only after
 * every filesystem write succeeded, and a stale plan is refused rather than re-interpreted.
 *
 * Ownership guard for a directory with no manifest entry is ROOT CONTAINMENT: it must sit directly
 * under a known skills root, otherwise a crafted request could delete anything on disk.
 */

export interface RemoveTarget {
  scope: 'global' | 'project';
  host: string;
  path: string;
  /** Per-profile runtime store (DSH): the profile this target was read from. */
  profile?: string;
}

export interface RemoveItem {
  /** `null` = a copy that already existed on this machine (no manifest entry). */
  artifactId: string | null;
  copies: RemoveTarget[];
  /**
   * Present for a discovered row: the runtime's own record, as the discovery scan read it. When set
   * it is authoritative — `copies` is then display-only, because a package's `path` is an identity
   * token and there is no location to reconcile.
   */
  removal?: DiscoveredRemoval;
}

export interface PlanAction {
  /**
   * `move-to-trash` (a path we own), `prune-only` (the copy or member is already gone), `prune-record`
   * (package-manager-owned with no declaration file to edit), `drop-entry` (one string inside a JSON
   * array), `drop-server` (one member of a JSON object, e.g. a server in `mcp`), or `cli-remove`
   * (a CLI-materialized landing: the runtime's own remove verb runs, §D8.13).
   */
  op: 'move-to-trash' | 'prune-only' | 'prune-record' | 'drop-entry' | 'drop-server' | 'cli-remove';
  /** The runtime's own remove command, for a `cli-remove` op — echoed by the plan, run by the apply. */
  cli?: { echo: string; runs: { command: string; args: string[] }[]; timeoutMs?: number };
  /** Project-scope CLI verbs locate their landing by the subprocess's working directory. */
  cwd?: string;
  /** The manifest copy key: a resolved path, or the identity token for an `external` copy. */
  path: string;
  /** The config file a `drop-*` op edits — display + the write target. */
  file?: string;
  /** Container inside `file` (`plugin` / `packages` / `mcp`). */
  container?: string;
  /** The exact member removed: an array element (`drop-entry`) or an object key (`drop-server`). */
  entry?: string;
  host: string;
  artifactId: string | null;
  beforeHash?: string;
  dirty: boolean;
  exists: boolean;
}

export interface RemovePlan {
  planId: string;
  action: 'remove';
  artifactIds: string[];
  actions: PlanAction[];
  /**
   * Copies whose `path` is an identity token, not a location (`CopyRecord.external`). Their removal
   * edits the runtime's own declaration when the host catalog names one; otherwise it can only prune
   * this gateway's record, and the plan says so verbatim.
   */
  external: { path: string; host: string }[];
  blocked: { path: string; code: 'foreign' | 'unknown-copy' | 'not-found' | 'unreadable'; message: string }[];
  warnings: { code: 'dirty-copy'; message: string; path: string }[];
  createdAt: number;
}

const PLAN_TTL_MS = 10 * 60_000;
const plans = new Map<string, RemovePlan>();

/**
 * Match a requested target against a recorded copy.
 *
 * An `external` copy's `path` is an identity token (`<canonicalKey>#<harness>`), NOT a location:
 * `path.resolve` would prepend the process cwd and turn the match into a cwd-dependent guess — the
 * same plan would prune the record from one directory and refuse it from another. Tokens are
 * therefore compared verbatim; real paths keep the resolved comparison (both sides normalized).
 */
function matchesCopy(copy: CopyRecord, targetPath: string): boolean {
  return copy.external === true ? copy.path === targetPath : path.resolve(copy.path) === path.resolve(targetPath);
}

/** Recorded form of a copy path: token as-is, real path resolved — the single key for `removed`. */
function copyKey(copy: CopyRecord): string {
  return copy.external === true ? copy.path : path.resolve(copy.path);
}

function trashRoot(): string {
  return path.join(getOcrHomeDir(), 'harness', 'trash');
}

/**
 * Directories a `trash-path` removal may touch: the known skills roots plus every plugin loose
 * directory the host catalog declares.
 *
 * The descriptor arrives from the console, so it cannot be trusted on its own — without this guard a
 * crafted request could name any path on disk and move it. It is a containment rule, not a
 * provenance rule: both roots accept a copy the manifest has never heard of.
 */
function removableRoots(projectRoot: string = process.cwd()): Set<string> {
  const out = new Set(skillRoots(projectRoot).map((r) => path.resolve(r.root)));
  // Every plugin loose directory the adapters declare, for BOTH scopes and every spelling in a
  // host's version ladder (opencode v2 `plugins/`, v1 `plugin/`) — a discovered loose file is
  // removable only when its directory is one of these.
  //
  // BOTH scopes stay in this guard: a copy recorded under either scope must stay removable, and
  // losing a scope here would strand real state on disk.
  const ctx = { projectRoot };
  for (const adapter of HOST_ADAPTERS) {
    if (!isPluginHost(adapter)) continue;
    for (const scope of ['global', 'project'] as const) {
      for (const dir of adapter.looseDirs(ctx, scope)) out.add(path.resolve(dir));
    }
  }
  return out;
}

function fingerprint(abs: string): { mtimeMs: number; bytes: number } | null {
  try {
    const stat = fs.statSync(abs);
    return { mtimeMs: stat.mtimeMs, bytes: stat.size };
  } catch {
    return null;
  }
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, plan] of plans) {
    if (now - plan.createdAt > PLAN_TTL_MS) plans.delete(id);
  }
}

/**
 * Where a tracked copy actually landed, when that landing is a CONFIG FILE rather than a path of our
 * own.
 *
 * Answered from the KIND + the host adaptation, never by re-resolving the landing against this
 * process's cwd: `adapter.configPath` / `adapter.writeTarget` answer for the CURRENT working directory,
 * while the copy was written under whatever root the install named — comparing them would mark a
 * project-scope copy as "not a config" and trash the runtime's whole configuration.
 *
 * By construction every MCP copy and every non-`external` plugin copy IS a config member: the
 * writers have no other landing for those shapes.
 */
function configLanding(
  copy: CopyRecord,
  artifact: ArtifactRecord
): { file: string; containers: string[]; serverKey?: string } | null {
  const abs = path.resolve(copy.path);
  if (artifact.kind === 'mcp') {
    // The MCP writer merges the artifact's name as the server key inside the adapter's container.
    const adapter = adapterFor(copy.host);
    return { file: abs, containers: [isMcpHost(adapter) ? adapter.container : 'mcp'], serverKey: artifact.name };
  }
  if (artifact.kind === 'plugin') {
    // A package-manager landing is recorded `external` (a token, handled before this point); a
    // non-external plugin copy can only be a config-array member. Every container spelling the
    // host's adapter declares is tried: the copy may predate a key rename (`plugin` → `plugins`).
    const adapter = adapterFor(copy.host);
    const containers = isPluginHost(adapter) ? adapter.containers() : [];
    if (containers.length === 0) return null;
    return { file: abs, containers };
  }
  return null;
}

/**
 * Config files a discovered-row `drop-*` descriptor may name for one host + scope.
 *
 * The descriptor arrives from the console, so it cannot be trusted on its own: without this check a
 * crafted request could point `drop-entry`/`drop-server` at ANY JSON file on disk and have the apply
 * rewrite it. The answer comes from the adapter's own read surfaces, never from the request.
 */
function dropTargets(
  host: HarnessHostId | undefined,
  scope: HarnessScope,
  projectRoot: string | undefined
): Set<string> {
  const out = new Set<string>();
  if (!host) return out;
  const adapter = adapterFor(host);
  if (!adapter) return out;
  const ctx = { projectRoot: projectRoot ?? process.cwd() };
  if (isMcpHost(adapter)) {
    const landing = adapter.configPath(ctx, scope);
    if (landing.ok) out.add(path.resolve(landing.path));
  }
  if (isPluginHost(adapter)) {
    for (const source of adapter.readSources(ctx, scope)) {
      // A loose DIRECTORY holds files, never a JSON container a drop op could edit.
      if (source.kind !== 'loose-dir') out.add(path.resolve(source.path));
    }
    for (const declared of adapter.declarations(ctx, scope)) out.add(path.resolve(declared.file));
  }
  return out;
}

/**
 * The declaration files a package-manager landing reads (pi's `settings.json`, DSH's per-profile
 * `package.json`), when the adapter names any. Every EXISTING file is returned: a version ladder
 * may list a v2 path and a legacy fallback, and a per-profile runtime has one file per profile.
 */
function declaredFiles(
  host: HarnessHostId,
  scope: HarnessScope,
  projectRoot: string | undefined
): { file: string; container: string }[] {
  const adapter = adapterFor(host);
  if (!isPluginHost(adapter)) return [];
  const declarations = adapter.declarations({ projectRoot: projectRoot ?? process.cwd() }, scope);
  // A per-profile runtime (DSH) records one declaration per profile. Its declaration inverse must
  // visit ALL of them: an artifact installed in two profiles is one row, and dropping only the
  // console's default profile would leave the other copy live.
  return declarations.filter((d) => fs.existsSync(d.file)).map((d) => ({ file: d.file, container: d.key }));
}

/**
 * The runtime's own package-removal verb for a declared dependency, when the host has one.
 *
 * A declaration edit alone is not a package-manager uninstall: it unhooks the bundle but leaves the
 * dependency and its bytes in place. DSH's `removeBundle` does both (deselect, then `pnpm remove`),
 * so the plan runs this command alone. `null` = the host has no such surface (pi's
 * `packages[]` removal is declaration-only); `error` = the surface exists but is unavailable now.
 */
function pluginRemoveSpec(
  host: HarnessHostId,
  name: string,
  scope: HarnessScope,
  profile: string | undefined
): { command: string; args: string[]; timeoutMs?: number } | { error: string } | null {
  const adapter = adapterFor(host);
  if (!isPluginHost(adapter) || !adapter.pluginRemoveArgs) return null;
  const spec = adapter.pluginRemoveArgs(name, scope, profile);
  return spec.ok
    ? {
        command: spec.command,
        args: spec.args,
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      }
    : { error: spec.reason };
}

/** True when one of the host's declarations still lists the package as a dependency. */
function dependencyInstalled(
  host: HarnessHostId,
  scope: HarnessScope,
  profile: string | undefined,
  entry: string,
  projectRoot: string | undefined
): boolean {
  const adapter = adapterFor(host);
  if (!isPluginHost(adapter)) return false;
  for (const declaration of adapter.declarations({ projectRoot: projectRoot ?? process.cwd() }, scope)) {
    if (profile && path.basename(path.dirname(declaration.file)) !== profile) continue;
    if (!fs.existsSync(declaration.file)) continue;
    const parsed = readConfigJson(declaration.file);
    if (!parsed.ok) continue;
    const deps = valueAtPath(parsed.config, 'dependencies');
    if (deps && typeof deps === 'object' && !Array.isArray(deps) && Object.hasOwn(deps, entry)) return true;
  }
  return false;
}

/**
 * Array members that still carry this artifact.
 *
 * The exact rule is the canonicalKey. It cannot be the only rule: a `manual:` artifact's key names
 * the package the way the operator typed it, while the array holds the grammar the runtime writes
 * (`npm:<name>`), so the recorded display NAME is the fallback — and it only applies when no exact
 * match exists, so two scoped packages that share a short name are never both removed.
 *
 * Empty = the runtime already forgot the install, so the record is all that is left to prune;
 * `null` = the file cannot be parsed, and a JSON rewrite would be lossy — refused, never guessed.
 */
function matchingEntries(
  file: string,
  containers: string[],
  artifact: ArtifactRecord
): { container: string; entries: string[] }[] | null {
  if (!fs.existsSync(file)) return [];
  const parsed = readConfigJson(file);
  if (!parsed.ok) return null;
  const found: { container: string; entries: string[] }[] = [];
  for (const container of containers) {
    const arr = arrayAtPath(parsed.config, container);
    if (!arr) continue;
    const entries = arr.filter((entry): entry is string => typeof entry === 'string');
    const exact = entries.filter((entry) => parsePluginSpec(entry)?.canonicalKey === artifact.canonicalKey);
    const chosen =
      exact.length > 0
        ? exact
        : entries.filter((entry) => {
            const spec = parsePluginSpec(entry);
            return entry === artifact.name || spec?.name === artifact.name;
          });
    if (chosen.length > 0) found.push({ container, entries: chosen });
  }
  return found;
}

/** Build a dry-run removal plan over one or more artifacts. Writes nothing. */
export function planRemove(items: RemoveItem[], opts?: { projectRoot?: string }): RemovePlan | { error: string } {
  pruneExpired();
  const manifest = readManifest();
  const roots = new Set(skillRoots(opts?.projectRoot).map((r) => path.resolve(r.root)));
  const envName = resolveEnvName();

  const actions: PlanAction[] = [];
  const blocked: RemovePlan['blocked'] = [];
  const warnings: RemovePlan['warnings'] = [];
  const external: RemovePlan['external'] = [];
  const artifactIds = new Set<string>();

  for (const item of items) {
    const artifact = item.artifactId
      ? manifest.artifacts.find((a) => a.id === item.artifactId)
      : undefined;
    if (item.artifactId && !artifact) {
      blocked.push({ path: '', code: 'not-found', message: `unknown artifact '${item.artifactId}'` });
      continue;
    }
    if (artifact) artifactIds.add(artifact.id);

    // A discovered row: the runtime's own record IS the target, so the descriptor decides the op and
    // there is no copy of ours to reconcile.
    if (item.removal) {
      const removal = item.removal;
      if (removal.op === 'trash-path') {
        const abs = path.resolve(removal.path);
        if (!removableRoots(opts?.projectRoot).has(path.dirname(abs))) {
          blocked.push({ path: abs, code: 'not-found', message: 'not directly under a known artifact root' });
          continue;
        }
        const owner = claimOwner(abs);
        if (owner && owner !== envName) {
          blocked.push({ path: abs, code: 'foreign', message: `owned by environment '${owner}'` });
          continue;
        }
        if (!fs.existsSync(abs)) {
          blocked.push({ path: abs, code: 'not-found', message: 'file does not exist' });
          continue;
        }
        actions.push({
          op: 'move-to-trash',
          path: abs,
          host: item.copies[0]?.host ?? '',
          artifactId: null,
          dirty: false,
          exists: true,
        });
        continue;
      }
      if (removal.op === 'plugin-remove') {
        // An installed package that is not in the selected bundle list (DSH disabled bundle). The
        // vendor's remove verb owns both records, so this is one CLI action, not a file edit.
        const scope = item.copies[0]?.scope ?? 'global';
        const profile = removal.profile ?? item.copies[0]?.profile;
        if (!dependencyInstalled(removal.host, scope, profile, removal.entry, opts?.projectRoot)) {
          blocked.push({
            path: removal.entry,
            code: 'not-found',
            message: `'${removal.entry}' is not a dependency in profile '${profile ?? 'default'}'`,
          });
          continue;
        }
        const remove = pluginRemoveSpec(removal.host, removal.entry, scope, profile);
        if (!remove) {
          blocked.push({ path: removal.entry, code: 'not-found', message: `host '${removal.host}' has no package-removal verb` });
          continue;
        }
        if ('error' in remove) {
          blocked.push({ path: removal.entry, code: 'not-found', message: remove.error });
          continue;
        }
        actions.push({
          op: 'cli-remove',
          path: `${removal.host}:${removal.entry}`,
          host: removal.host,
          artifactId: null,
          dirty: false,
          exists: false,
          entry: removal.entry,
          cli: {
            echo: echoArgv(remove.command, remove.args),
            runs: [{ command: remove.command, args: remove.args }],
            ...(remove.timeoutMs === undefined ? {} : { timeoutMs: remove.timeoutMs }),
          },
        });
        continue;
      }
      if (removal.op === 'cli-remove') {
        // CLI-materialized landing (§D8.13): the inverse is the runtime's own remove verb. Presence
        // is checked on the landing file (read-only), so an already-gone server answers prune-only
        // instead of a CLI run that would report "not found".
        const adapter = adapterFor(removal.host);
        const cliSpec = adapter && isMcpHost(adapter) ? adapter.mcpCliSpec?.() ?? null : null;
        if (!adapter || !isMcpHost(adapter) || !cliSpec) {
          blocked.push({ path: '', code: 'not-found', message: `host '${removal.host}' has no CLI-materialized MCP landing` });
          continue;
        }
        // The descriptor carries no scope of its own — the picked copies do (a discovered row's
        // copy mirrors its source scope). Project landings resolve under the page's project root.
        const removeScope = item.copies[0]?.scope ?? 'global';
        const landing = adapter.configPath({ projectRoot: opts?.projectRoot ?? process.cwd() }, removeScope);
        const file = landing.ok ? landing.path : '';
        let present = false;
        if (file) {
          const parsedLanding = readMcpLandingFile(file, adapter.mcpLandingFormat?.() ?? 'json');
          if (parsedLanding.ok) {
            // Dot-path aware: openclaw nests its servers at `mcp.servers`.
            const container = mcpContainerAt(parsedLanding.config, adapter.container);
            present = !!container && removal.entry in container;
          }
        }
        if (!present) {
          actions.push({
            op: 'prune-only',
            path: file || removal.host,
            host: removal.host,
            artifactId: item.artifactId ?? null,
            dirty: false,
            exists: false,
          });
          continue;
        }
        const remove = cliSpec.removeArgs(removal.entry, removeScope);
        if (!remove.ok) {
          blocked.push({ path: file, code: 'not-found', message: remove.reason });
          continue;
        }
        actions.push({
          op: 'cli-remove',
          path: file,
          host: removal.host,
          artifactId: item.artifactId ?? null,
          dirty: false,
          exists: true,
          entry: removal.entry,
          cli: { echo: echoArgv(cliSpec.command, remove.args), runs: [{ command: cliSpec.command, args: remove.args }] },
          ...(removeScope === 'project' && opts?.projectRoot ? { cwd: opts.projectRoot } : {}),
        });
        continue;
      }
      const descriptorHost = item.copies[0]?.host as HarnessHostId | undefined;
      const descriptorScope = item.copies[0]?.scope ?? 'global';
      if (!descriptorHost || !dropTargets(descriptorHost, descriptorScope, opts?.projectRoot).has(path.resolve(removal.file))) {
        blocked.push({ path: removal.file, code: 'not-found', message: "not a config landing of the row's host" });
        continue;
      }
      const parsed = fs.existsSync(removal.file) ? readConfigJson(removal.file) : null;
      if (parsed === null) {
        blocked.push({ path: removal.file, code: 'not-found', message: 'config file does not exist' });
        continue;
      }
      if (!parsed.ok) {
        blocked.push({ path: removal.file, code: 'unreadable', message: parsed.reason });
        continue;
      }
      // Two config shapes, one rule: the descriptor names the member and the container it was ACTUALLY
      // found in. `drop-entry` empties an array slot; `drop-server` drops an object member (an MCP
      // server key), and its siblings keep their place. Container lookup is dot-path aware (openclaw
      // `mcp.servers`), identical for every flat spelling.
      const container = mcpContainerAt(parsed.config, removal.container);
      const isServer = removal.op === 'drop-server';
      const present = isServer
        ? !!container && removal.entry in container
        : (arrayAtPath(parsed.config, removal.container) ?? []).includes(removal.entry);
      if (!present) {
        blocked.push({
          path: removal.file,
          code: 'not-found',
          message: `'${removal.entry}' is no longer in ${removal.container}${isServer ? '' : '[]'}`,
        });
        continue;
      }
      const pluginRemove =
        descriptorHost && removal.op === 'drop-entry'
          ? pluginRemoveSpec(descriptorHost, removal.entry, descriptorScope, item.copies[0]?.profile)
          : null;
      if (pluginRemove && 'error' in pluginRemove) {
        blocked.push({ path: removal.file, code: 'not-found', message: pluginRemove.error });
        continue;
      }
      if (pluginRemove) {
        // The vendor's remove verb is `removeBundle`: it deselects the bundle AND removes the
        // dependency. Repeating the declaration edit here would race that command on the same
        // package.json (and could hide an orphaned dependency if pnpm then failed).
        actions.push({
          op: 'cli-remove',
          path: path.resolve(removal.file),
          host: descriptorHost!,
          artifactId: null,
          dirty: false,
          // The file is the declaration, not the package location; the apply must not fingerprint it.
          exists: false,
          entry: removal.entry,
          cli: {
            echo: echoArgv(pluginRemove.command, pluginRemove.args),
            runs: [{ command: pluginRemove.command, args: pluginRemove.args }],
            ...(pluginRemove.timeoutMs === undefined ? {} : { timeoutMs: pluginRemove.timeoutMs }),
          },
        });
        continue;
      }
      actions.push({
        op: removal.op,
        path: path.resolve(removal.file),
        file: removal.file,
        container: removal.container,
        entry: removal.entry,
        host: item.copies[0]?.host ?? '',
        artifactId: null,
        dirty: false,
        exists: true,
      });
      continue;
    }

    for (const target of item.copies) {
      // Identity-token copies are matched VERBATIM (before any `path.resolve`), so the plan never
      // depends on the process cwd — see `matchesCopy`.
      const copy: CopyRecord | undefined = artifact?.copies.find((c) => matchesCopy(c, target.path));

      if (artifact && !copy) {
        blocked.push({ path: target.path, code: 'unknown-copy', message: 'not a copy recorded for this artifact' });
        continue;
      }

      // Package-manager-owned copy: `path` is an identity token and no claim exists. Its real undo is
      // the runtime's own declaration (`settings.json` `packages[]`), so the plan drops that entry
      // when the host catalog names the file — the same op a discovered row of the same package gets.
      if (copy?.external === true) {
        // A CLI-materialized MCP copy (§D8.13) has no declaration file — its inverse IS the
        // runtime's own remove verb.
        const adapter0 = adapterFor(copy.host);
        const cliSpec = artifact?.kind === 'mcp' && adapter0 && isMcpHost(adapter0) ? adapter0.mcpCliSpec?.() ?? null : null;
        if (cliSpec && artifact) {
          const remove = cliSpec.removeArgs(artifact.name, copy.scope);
          if (!remove.ok) {
            blocked.push({ path: copy.path, code: 'not-found', message: remove.reason });
            continue;
          }
          actions.push({
            op: 'cli-remove',
            path: copy.path,
            host: copy.host,
            artifactId: item.artifactId ?? null,
            dirty: false,
            // The token is not a location: nothing to stat, and the apply must not fingerprint it.
            exists: false,
            entry: artifact.name,
            cli: { echo: echoArgv(cliSpec.command, remove.args), runs: [{ command: cliSpec.command, args: remove.args }] },
            ...(copy.scope === 'project' && (copy.projectRoot ?? opts?.projectRoot)
              ? { cwd: copy.projectRoot ?? opts?.projectRoot }
              : {}),
          });
          external.push({ path: copy.path, host: copy.host });
          continue;
        }
        const pluginRemove =
          artifact?.kind === 'plugin'
            ? pluginRemoveSpec(copy.host, artifact.name, copy.scope, copy.profile)
            : null;
        if (pluginRemove && 'error' in pluginRemove) {
          blocked.push({ path: copy.path, code: 'not-found', message: pluginRemove.error });
          continue;
        }
        if (pluginRemove && artifact) {
          // `removeBundle` owns BOTH records: it deselects the bundle and runs `pnpm remove`. A
          // manual drop first would make the command re-add nothing but leave the dependency if pnpm
          // failed — the exact half-state this path must not create. Resolved BEFORE the declaration
          // scan: that scan is the fallback for hosts without a removal verb, and for a per-profile
          // runtime it visits EVERY profile's manifest — an unrelated corrupt one must not block a
          // removal this verb performs on its own profile alone.
          actions.push({
            op: 'cli-remove',
            path: copy.path,
            host: copy.host,
            artifactId: item.artifactId ?? null,
            dirty: false,
            exists: false,
            entry: artifact.name,
            cli: {
              echo: echoArgv(pluginRemove.command, pluginRemove.args),
              runs: [{ command: pluginRemove.command, args: pluginRemove.args }],
              ...(pluginRemove.timeoutMs === undefined ? {} : { timeoutMs: pluginRemove.timeoutMs }),
            },
          });
          external.push({ path: copy.path, host: copy.host });
          continue;
        }
        const declarations = artifact ? declaredFiles(copy.host, copy.scope, copy.projectRoot ?? opts?.projectRoot) : [];
        const drops: { file: string; container: string; entry: string }[] = [];
        let unreadable: string | null = null;
        for (const declaration of declarations) {
          const keys = matchingEntries(declaration.file, [declaration.container], artifact!);
          if (keys === null) {
            unreadable = declaration.file;
            break;
          }
          for (const group of keys) {
            for (const entry of group.entries) {
              drops.push({ file: declaration.file, container: group.container, entry });
            }
          }
        }
        if (unreadable) {
          blocked.push({ path: unreadable, code: 'unreadable', message: `cannot parse ${unreadable}; refusing a lossy rewrite` });
          continue;
        }
        if (drops.length > 0) {
          for (const drop of drops) {
            actions.push({
              op: 'drop-entry',
              path: copy.path,
              file: drop.file,
              container: drop.container,
              entry: drop.entry,
              host: copy.host,
              artifactId: item.artifactId ?? null,
              dirty: false,
              // The token is not a location: nothing to stat, and the apply must not fingerprint it.
              exists: false,
            });
          }
          external.push({ path: copy.path, host: copy.host });
          continue;
        }
        actions.push({
          op: 'prune-record',
          path: copy.path,
          host: copy.host,
          artifactId: item.artifactId ?? null,
          dirty: false,
          exists: false,
        });
        external.push({ path: copy.path, host: copy.host });
        continue;
      }

      const abs = path.resolve(target.path);
      if (!artifact && !roots.has(path.dirname(abs))) {
        blocked.push({ path: abs, code: 'not-found', message: 'not directly under a known skills root' });
        continue;
      }
      const owner = claimOwner(abs);
      if (owner && owner !== envName) {
        blocked.push({ path: abs, code: 'foreign', message: `owned by environment '${owner}'` });
        continue;
      }

      // A config landing is edited member-by-member: trashing the file would take every other
      // server/plugin recorded in it with it (ADR-0015 §D5).
      const landing = copy && artifact ? configLanding(copy, artifact) : null;
      if (landing && artifact) {
        // The file is gone: nothing to edit, so the record is all that is left.
        if (!fs.existsSync(landing.file)) {
          actions.push({
            op: 'prune-only',
            path: abs,
            host: copy!.host,
            artifactId: item.artifactId ?? null,
            beforeHash: copy!.contentHash,
            dirty: false,
            exists: false,
          });
          continue;
        }
        if (landing.serverKey) {
          const parsed = readConfigJson(landing.file);
          if (!parsed.ok) {
            blocked.push({ path: landing.file, code: 'unreadable', message: parsed.reason });
            continue;
          }
          const container = mcpContainerAt(parsed.config, landing.containers[0]!);
          const present = !!container && landing.serverKey in container;
          actions.push({
            op: present ? 'drop-server' : 'prune-only',
            path: abs,
            file: landing.file,
            container: landing.containers[0]!,
            entry: landing.serverKey,
            host: copy!.host,
            artifactId: item.artifactId ?? null,
            beforeHash: copy!.contentHash,
            dirty: false,
            // `prune-only` moves NOTHING (apply would rename anything marked `exists`), so only the
            // drop op keeps the true flag — it needs it for the stale check, not for a move.
            exists: present,
          });
          continue;
        }
        const keys = matchingEntries(landing.file, landing.containers, artifact);
        if (keys === null) {
          blocked.push({ path: landing.file, code: 'unreadable', message: `cannot parse ${landing.file}; refusing a lossy rewrite` });
          continue;
        }
        if (keys.length === 0) {
          // The runtime's array no longer holds this spec (hand-removed, or version drift): the only
          // thing left is our record, and `prune-only` is exactly that claim. `exists: false` because
          // a prune performs no filesystem op — the config file must survive untouched.
          actions.push({
            op: 'prune-only',
            path: abs,
            host: copy!.host,
            artifactId: item.artifactId ?? null,
            beforeHash: copy!.contentHash,
            dirty: false,
            exists: false,
          });
          continue;
        }
        for (const group of keys) {
          for (const entry of group.entries) {
            actions.push({
              op: 'drop-entry',
              path: abs,
              file: landing.file,
              container: group.container,
              entry,
              host: copy!.host,
              artifactId: item.artifactId ?? null,
              beforeHash: copy!.contentHash,
              dirty: false,
              exists: true,
            });
          }
        }
        continue;
      }

      const exists = fs.existsSync(abs);
      if (!exists && !copy) {
        blocked.push({ path: abs, code: 'not-found', message: 'directory does not exist' });
        continue;
      }
      let dirty = false;
      if (exists && copy) {
        try {
          // `copyDrift` picks the hash the WRITER used for this copy's shape (file vs directory);
          // hashing a config file as a tree would report every MCP/plugin copy as edited.
          dirty = copyDrift(copy, abs);
        } catch {
          dirty = true;
        }
      }
      actions.push({
        op: exists ? 'move-to-trash' : 'prune-only',
        path: abs,
        host: copy?.host ?? target.host,
        artifactId: item.artifactId ?? null,
        beforeHash: copy?.contentHash,
        dirty,
        exists,
      });
      if (dirty) warnings.push({ code: 'dirty-copy', message: 'copy has local edits', path: abs });
    }
  }

  if (actions.length === 0) return { error: blocked[0]?.message ?? 'nothing to remove' };

  const planId = crypto
    .createHash('sha256')
    .update(`${[...artifactIds].join(',')}|${actions.map((a) => a.path).join('|')}|${Date.now()}`)
    .digest('hex')
    .slice(0, 24);

  const plan: RemovePlan = {
    planId,
    action: 'remove',
    artifactIds: [...artifactIds],
    actions,
    external,
    blocked,
    warnings,
    createdAt: Date.now(),
  };
  plans.set(planId, plan);
  return plan;
}

export type ApplyResult =
  | {
      ok: true;
      removed: string[];
      trashDir: string | null;
      prunedArtifacts: string[];
      /** Plain-language note when the plan edited a runtime's own record instead of moving a path. */
      message?: string;
    }
  | { ok: false; code: 'plan_unknown' | 'plan_stale' | 'dirty_copy' | 'apply_failed'; message: string };

/** Remove one string from a JSON array, refusing anything a JSON round-trip would mangle. */
function applyDropEntry(file: string, container: string, entry: string): { ok: true } | { ok: false; reason: string } {
  const parsed = readConfigJson(file);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const arr = arrayAtPath(parsed.config, container);
  if (!arr) return { ok: false, reason: `${container} is not an array in ${file}` };
  const next = arr.filter((value) => value !== entry);
  if (next.length === arr.length) return { ok: false, reason: `'${entry}' is no longer in ${container}[]` };
  if (!setArrayAtPath(parsed.config, container, next)) {
    return { ok: false, reason: `${container} is not an array in ${file}` };
  }
  return writeConfigJson(file, parsed.config);
}

/** Delete one member of a JSON object (an MCP server inside `mcp`). */
function applyDropServer(file: string, container: string, serverKey: string): { ok: true } | { ok: false; reason: string } {
  const parsed = readConfigJson(file);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const obj = mcpContainerAt(parsed.config, container);
  if (!obj) {
    return { ok: false, reason: `${container} is not an object in ${file}` };
  }
  if (!(serverKey in obj)) {
    return { ok: false, reason: `'${serverKey}' is no longer in ${container}` };
  }
  delete obj[serverKey];
  return writeConfigJson(file, parsed.config);
}

/**
 * Honest wording shared by the apply result and the ledger row.
 *
 * `declared` distinguishes the two real outcomes: the runtime's own declaration was edited (the
 * package stops loading, the bytes stay), or no declaration file exists and only this gateway's
 * record could be dropped. Neither is "uninstalled from disk", and naming a `pi uninstall` / `npm
 * uninstall` command would invent a contract this gateway does not own.
 */
function externalPruneMessage(count: number, declared: boolean): string {
  return declared
    ? `removed ${count} package declaration(s) from the runtime's own config; the package bytes stay in its store`
    : `pruned ${count} package-manager-owned record(s); no declaration file was found, so the package is untouched`;
}

/**
 * Execute a removal plan. The manifest is written only after every filesystem write succeeded, so a
 * failure leaves the artifacts recorded rather than orphaned.
 *
 * `drop-entry` / `drop-server` edit a runtime's config file through `createBackup` + `safeWriteJson`
 * — the same discipline that wrote the member — and never release the path's claim: the file still
 */
export async function applyRemove(planId: string, opts: { discardLocalEdits?: boolean; execImpl?: ExecImpl } = {}): Promise<ApplyResult> {
  pruneExpired();
  const plan = plans.get(planId);
  if (!plan) return { ok: false, code: 'plan_unknown', message: 'plan expired or never existed' };

  for (const action of plan.actions) {
    if (!action.exists) continue;
    const fp = fingerprint(action.path);
    if (!fp) return { ok: false, code: 'plan_stale', message: `${action.path} disappeared after planning` };
  }
  if (plan.warnings.length > 0 && !opts.discardLocalEdits) {
    return {
      ok: false,
      code: 'dirty_copy',
      message: 'copies have local edits — resend with discardLocalEdits to move them to trash anyway',
    };
  }

  const run = opts.execImpl ?? defaultExec;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trashDir = path.join(trashRoot(), `${stamp}-${plan.planId.slice(0, 8)}`);
  const removed: string[] = [];
  let moved = false;
  let dropEntryCount = 0;
  let dropServerCount = 0;
  let cliRemoveCount = 0;

  for (const action of plan.actions) {
    if (action.op === 'cli-remove') {
      // The runtime's own remove verb (§D8.13): the echoed argv runs verbatim. The copy's token is
      // pushed to `removed` either way, so the manifest record drops out — the store truth lives
      // with the runtime, and a "not found" answer from the CLI means the record was already stale.
      if (action.cli) {
        for (const step of action.cli.runs) {
          const result = await run(step.command, step.args, action.cli.timeoutMs ?? MCP_CLI_TIMEOUT_MS, action.cwd);
          if (result.code !== 0) {
            return { ok: false, code: 'apply_failed', message: `${action.cli.echo} exited ${result.code}: ${result.stderr.slice(0, 200)}` };
          }
        }
      }
      cliRemoveCount += 1;
      removed.push(action.path);
      continue;
    }
    if (action.op === 'drop-entry' || action.op === 'drop-server') {
      const result =
        action.op === 'drop-entry'
          ? applyDropEntry(action.file!, action.container!, action.entry!)
          : applyDropServer(action.file!, action.container!, action.entry!);
      if (!result.ok) {
        // Earlier moves stay in the trash (recoverable) and the manifest is NOT pruned, so the record
        // still points at what happened — the same failure discipline the move path already had.
        return { ok: false, code: 'apply_failed', message: `${action.file}: ${result.reason}` };
      }
      if (action.op === 'drop-entry') dropEntryCount += 1;
      else dropServerCount += 1;
      removed.push(action.path);
      continue;
    }
    if (action.op !== 'prune-record') {
      if (action.exists) {
        fs.mkdirSync(trashDir, { recursive: true });
        const hostTag = action.host.replace(/[^\w.-]+/g, '-') || 'unknown';
        // The host label is caller-shaped (a discovered row's descriptor carries it), so it is
        // flattened to a safe file-name token before it joins the trash path — a `../` in it would
        // otherwise land the moved directory outside the trash.
        const dest = path.join(trashDir, `${hostTag}-${path.basename(action.path)}`);
        try {
          fs.renameSync(action.path, dest);
        } catch {
          // Cross-device or locked target: copy then remove, still reversible via trash.
          fs.cpSync(action.path, dest, { recursive: true });
          fs.rmSync(action.path, { recursive: true, force: true });
        }
        moved = true;
      }
      // The claim belongs to the PATH, so it is released only when the path itself was destroyed.
      // A config member edit leaves the file in place (and it usually holds other artifacts), and a
      // prune touches nothing at all.
      if (action.op === 'move-to-trash') releaseClaim(action.path);
    }
    removed.push(action.path);
  }

  const manifest = readManifest();
  // Snapshot the records BEFORE pruning: the ledger row needs kind/name, which the pruned manifest
  // no longer carries.
  const applied = plan.artifactIds
    .map((id) => manifest.artifacts.find((artifact) => artifact.id === id))
    .filter((artifact): artifact is ArtifactRecord => artifact !== undefined);

  const prunedArtifacts: string[] = [];
  manifest.artifacts = manifest.artifacts
    .map((artifact: ArtifactRecord) => {
      if (!plan.artifactIds.includes(artifact.id)) return artifact;
      // `removed` holds the same key form as the recorded copies: a resolved path for a real copy,
      // the identity token verbatim for a config / `prune-record` action — so an external copy drops
      // out of the record the same way, with no cwd dependency on either side.
      const remaining = artifact.copies.filter((copy) => !removed.includes(copyKey(copy)));
      if (remaining.length === 0) {
        prunedArtifacts.push(artifact.id);
        return { ...artifact, copies: [] };
      }
      return { ...artifact, copies: remaining };
    })
    .filter((artifact: ArtifactRecord) => artifact.copies.length > 0);
  writeManifest(manifest);
  plans.delete(planId);

  for (const artifact of applied) {
    const touched = plan.actions.filter((action) => action.artifactId === artifact.id);
    if (touched.length === 0) continue;
    const ops = new Set(touched.map((action) => action.op));
    const message =
      ops.size === 1 && ops.has('prune-record')
        ? externalPruneMessage(touched.length, false)
        : ops.size === 1 && (ops.has('drop-entry') || ops.has('drop-server'))
          ? `removed ${touched.length} config member(s)`
          : `removed ${touched.length} copy record(s)`;
    recordApply({
      action: 'remove',
      kind: artifact.kind,
      artifactId: artifact.id,
      name: artifact.name,
      hosts: [...new Set(touched.map((action) => action.host))],
      outcome: 'ok',
      message,
    });
  }

  const parts: string[] = [];
  if (dropEntryCount + dropServerCount > 0) {
    parts.push(`removed ${dropEntryCount + dropServerCount} config member(s); the file keeps its other entries`);
  }
  if (plan.external.length > 0) {
    const declared = plan.actions.some((action) => action.op === 'drop-entry' && action.exists === false);
    parts.push(externalPruneMessage(plan.external.length, declared));
  }
  if (cliRemoveCount > 0) {
    parts.push(`removed ${cliRemoveCount} server(s) through the host's own CLI`);
  }
  const message = parts.length > 0 ? parts.join('; ') : undefined;

  return { ok: true, removed, trashDir: moved ? trashDir : null, prunedArtifacts, ...(message ? { message } : {}) };
}

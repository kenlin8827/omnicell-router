import fs from 'node:fs';
import { hashFile, sha256 } from '../../hash.js';
import { adapterFor, isMcpHost } from '../adapters/index.js';
import { claimPath, readManifest, releaseClaim, writeManifest } from '../manifest.js';
import type { McpLaunch } from '../../spi.js';
import type { InstallSkipped } from './skill.js';
import { createBackup, safeWriteJson } from '../../../cli/clients/base.js';
import type { HarnessHostId, HarnessScope, Pin, TrustTier } from '../../types.js';
import { mcpServerNameError, mcpContainerAt, ensureMcpContainer, readMcpLandingFile, secretReference, type McpEntrySpec } from '../mcp-entry.js';
import { defaultExec, type ExecImpl } from './plugin.js';

/**
 * MCP kind writer (ADR-0015 §8) — CONFIG MERGE, never overwrite.
 *
 * The two data-loss gates, enforced here:
 *  - gate 2 (no silent merge): `planMcp` computes the exact added/changed keys per host file; the
 *    orchestrator refuses to apply until the caller confirms. A file that cannot be round-tripped as
 *    plain JSON (comments, trailing garbage) is REFUSED, not rewritten — stringify-after-parse would
 *    silently drop hand-written comments.
 *  - gate 4 (secrets are named by default): a launch carries key NAMES, and the merge materializes
 *    the host's own secret REFERENCE for the operator to satisfy in their runtime (ADR-0006 stays
 *    untouched): `{env:KEY}` for opencode, `${KEY}` for pi/omp. A value the operator typed
 *    into the registry-driven form is the ONE exception (2026-11-01 amendment): it is written
 *    verbatim into the runtime's config, and it never reaches the manifest, the ledger or any read
 *    answer.
 *
 * The entry itself is host-shaped, never assumed: the adapter answers `mcpEntrySpec()` (opencode's
 * `{type, command[], environment}` vs the `mcpServers` spelling of pi/omp) and
 * `mcpNamePattern()` (pi refuses a dot, omp allows it) — a host whose grammar the requested name
 * does not satisfy is REFUSED as a target, because writing the key anyway would produce a config
 * the runtime itself rejects.
 *
 * A third write mode (§D8.13 amendment) shares these gates: a CLI-materialized landing (claude,
 * codex) READS the runtime's config file but never reserializes it — the plan composes the
 * runtime's own add command (echoed, gate 2/3), apply runs it, and the copy is recorded
 * `external` because the runtime's store, not a file hash, is the truth.
 */

export interface McpApplyRequest {
  sourceId: string;
  /** `<sourceId>:<ref>` — the manifest canonicalKey. */
  canonicalKey: string;
  /** Server key inside the host's MCP container (normalized, stable identifier). */
  name: string;
  /** The source's one-line description; persisted so the installed row is not a nameless entry. */
  description?: string | null;
  launch: McpLaunch;
  trust: TrustTier;
  /** Adapter provenance (an npm source pins `dist.integrity`); absent = a manual entry, recorded
   *  as `adopted` rather than given an invented pin. */
  pin?: Pin;
  /** Listing surfaces recorded with the manifest (writer source first); absent = `[sourceId]`. */
  listedOn?: string[];
  hosts: HarnessHostId[];
  scope: HarnessScope;
  projectRoot?: string;
  /** Test seam: the executor the CLI landing spawns (`defaultExec` when absent). */
  execImpl?: ExecImpl;
}

export interface McpTargetPlan {
  host: HarnessHostId;
  file: string;
  exists: boolean;
  /** Container key the servers merge into, from the host adapter (`mcp`). */
  container?: string;
  /** Refusal for THIS host — apply skips it, the rest proceed. */
  refused?: string;
  /** Server keys the merge would add / change (gate 2). */
  addedKeys: string[];
  changedKeys: string[];
  /**
   * CLI-materialized landing (§D8.13): the runtime's own commands this apply runs — echoed here
   * for gate 2/3 and executed verbatim on confirm (an EDIT over an existing server runs the
   * runtime's remove verb before the add). The file above is only the read surface.
   */
  cli?: { echo: string; runs: { command: string; args: string[] }[] };
  /** Display-only echo of `cli`, at the key the console already renders (plugin plans use it). */
  echo?: string;
}


export type McpPlan = { ok: true; targets: McpTargetPlan[] } | { ok: false; code: 'bad_request'; message: string };

export type McpApplyResult =
  | {
      ok: true;
      artifactId: string;
      name: string;
      /** Hosts whose config received the server entry. */
      copies: { host: string; path: string }[];
      skipped: InstallSkipped[];
    }
  | { ok: false; code: 'no_target' | 'exists' | 'foreign' | 'bad_request' | 'upstream'; message: string; skipped?: InstallSkipped[] };


/**
 * The env/header map for one launch: a value the operator typed is written verbatim, every other
 * key becomes the host's secret reference (`{env:KEY}` / `${KEY}`). Keys are the union of the named
 * keys and the typed values, so a value can never be dropped by forgetting to name its key.
 */
function valueMap(
  keys: string[] | undefined,
  values: Record<string, string> | undefined,
  spec: McpEntrySpec
): Record<string, string> {
  const names = [...new Set([...(keys ?? []), ...Object.keys(values ?? {})])];
  return Object.fromEntries(
    names.map((key) => {
      const typed = values?.[key];
      return [key, typeof typed === 'string' && typed.length > 0 ? typed : secretReference(key, spec.secretRef)];
    })
  );
}

/** The host-shaped entry for one launch. Values reference the operator's environment by default. */
function desiredEntry(launch: McpLaunch, spec: McpEntrySpec): Record<string, unknown> {
  if (spec.shape === 'mcpServers') {
    if ('command' in launch) {
      const env = valueMap(launch.envKeys, launch.envValues, spec);
      return {
        command: launch.command,
        ...(launch.args && launch.args.length > 0 ? { args: [...launch.args] } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    }
    const headers = valueMap(launch.headerKeys, launch.headerValues, spec);
    return { url: launch.url, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
  }
  if ('command' in launch) {
    return {
      type: 'local',
      command: [launch.command, ...(launch.args ?? [])],
      enabled: true,
      environment: valueMap(launch.envKeys, launch.envValues, spec),
    };
  }
  return {
    type: 'remote',
    url: launch.url,
    enabled: true,
    headers: valueMap(launch.headerKeys, launch.headerValues, spec),
  };
}

/** Key-order-insensitive equality — a re-merged identical server must read as a no-op. */
function sameEntry(a: unknown, b: unknown): boolean {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
          .map(([k, v]) => [k, stable(v)])
      );
    }
    return value;
  };
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

/**
 * Gate-2/3 echo of one argv: each word as the shell would need it, so the operator confirms a
 * command that reads exactly like the one apply spawns.
 */
export function echoArgv(command: string, args: string[]): string {
  const quote = (word: string) => (/[\s"'`$&|<>();*?[\]{}~#\\]/.test(word) ? `'${word.replaceAll("'", `'\\''`)}'` : word);
  return [command, ...args.map(quote)].join(' ');
}

/**
 * The gate-3 echo with operator-typed secret values masked, for anything PERSISTED (ledger,
 * skip messages, hashes).
 *
 * Gate 2 must stay verbatim — the operator is confirming the exact command about to run. A ledger
 * row is not that confirmation: it outlives the request and is readable from the console, so a
 * value the operator typed into the form must never be reproduced there (ADR-0015 gate 4).
 */
export function redactSecrets(echo: string, launch: McpLaunch): string {
  const values = Object.values(('command' in launch ? launch.envValues : launch.headerValues) ?? {});
  let out = echo;
  for (const value of values) {
    if (typeof value === 'string' && value) out = out.split(value).join('***');
  }
  return out;
}

export function planMcp(req: McpApplyRequest): McpPlan {
  const targets: McpTargetPlan[] = [];
  for (const host of req.hosts) {
    const adapter = adapterFor(host);
    if (!isMcpHost(adapter)) {
      targets.push({
        host,
        file: '',
        exists: false,
        refused: `host '${host}' has no verified MCP landing`,
        addedKeys: [],
        changedKeys: [],
      });
      continue;
    }
    const landing = adapter.configPath({ projectRoot: req.projectRoot ?? process.cwd() }, req.scope);
    if (!landing.ok) {
      targets.push({ host, file: '', exists: false, refused: landing.reason, addedKeys: [], changedKeys: [] });
      continue;
    }
    // Scope capability gate (ADR-0015 §D2): the capability surface — not any one writer — owns
    // "can this scope land here". Codex is the case: it SHIPS a project config.toml (so
    // `configPath` answers ok) but `codex mcp add` has no project-scope grammar, so a project
    // request must be refused before the plan claims a write path it does not have.
    if (!adapter.supportedScopes('mcp').includes(req.scope)) {
      targets.push({
        host,
        file: '',
        exists: false,
        refused: `host '${host}' declares no ${req.scope}-scope MCP landing`,
        addedKeys: [],
        changedKeys: [],
      });
      continue;
    }
    // A host whose own grammar rejects this name is refused as a target: the merge would otherwise
    // write a key the runtime fails to load, which reads as "installed" in the console forever.
    const nameError = mcpServerNameError(req.name, adapter.mcpNamePattern());
    if (nameError) {
      targets.push({ host, file: landing.path, exists: false, refused: nameError, addedKeys: [], changedKeys: [] });
      continue;
    }
    const spec = adapter.mcpEntrySpec();
    const exists = fs.existsSync(landing.path);
    const parsed = readMcpLandingFile(landing.path, adapter.mcpLandingFormat?.() ?? 'json');
    if (adapter.mcpLiteralEnv?.()) {
      // No expansion in this runtime's config: an unnamed secret would land as a dead literal, so
      // the plan refuses it (gate 2) instead of writing a reference nothing will ever resolve.
      const keys = 'command' in req.launch ? req.launch.envKeys : req.launch.headerKeys;
      const values = 'command' in req.launch ? req.launch.envValues : req.launch.headerValues;
      const unnamed = (keys ?? []).filter((key) => typeof values?.[key] !== 'string' || values[key] === '');
      if (unnamed.length > 0) {
        targets.push({
          host,
          file: landing.path,
          exists,
          refused: `${host} env/header values are literal (no \${KEY} expansion) — provide a value for '${unnamed[0]}'`,
          addedKeys: [],
          changedKeys: [],
        });
        continue;
      }
    }
    if (!parsed.ok) {
      targets.push({ host, file: landing.path, exists, refused: parsed.reason, addedKeys: [], changedKeys: [] });
      continue;
    }
    const cliSpec = adapter.mcpCliSpec?.() ?? null;
    if (!cliSpec && (adapter.mcpLandingFormat?.() ?? 'json') === 'json5') {
      // A JSON5 config's only legal writer is the runtime's own CLI: a file merge would drop
      // hand-written comments wholesale (§D8.13), so the plan refuses instead.
      targets.push({
        host,
        file: landing.path,
        exists,
        refused: `host '${host}' keeps MCP servers in a JSON5 config — only its own CLI may write it`,
        addedKeys: [],
        changedKeys: [],
      });
      continue;
    }
    // Dot-path aware: openclaw nests its servers at `mcp.servers`.
    const container = mcpContainerAt(parsed.config, adapter.container);
    const existing =
      container && typeof container === 'object' && !Array.isArray(container)
        ? container[req.name]
        : undefined;
    const desired = desiredEntry(req.launch, spec);
    const addedKeys = existing === undefined ? [req.name] : [];
    const changedKeys = existing !== undefined && !sameEntry(existing, desired) ? [req.name] : [];
    if (cliSpec) {
      // CLI-materialized landing: the command IS the write, so its argv is composed at PLAN time —
      // a grammar refusal (literal-only env, no headers) surfaces at gate 2, not after confirm.
      const add = cliSpec.addArgs(req.launch, req.name, req.scope);
      if (!add.ok) {
        targets.push({ host, file: landing.path, exists, container: adapter.container, refused: add.reason, addedKeys: [], changedKeys: [] });
        continue;
      }
      targets.push({
        host,
        file: landing.path,
        exists,
        container: adapter.container,
        addedKeys,
        changedKeys,
        cli: { echo: echoArgv(cliSpec.command, add.args), runs: [{ command: cliSpec.command, args: add.args }] },
        echo: echoArgv(cliSpec.command, add.args),
      });
      continue;
    }
    targets.push({
      host,
      file: landing.path,
      exists,
      container: adapter.container,
      refused: undefined,
      addedKeys,
      changedKeys,
    });
  }
  return { ok: true, targets };
}

/** A CLI landing's subprocess gets the same bounded wait a package-manager install gets. */
export const MCP_CLI_TIMEOUT_MS = 120_000;

export async function applyMcp(req: McpApplyRequest): Promise<McpApplyResult> {
  const plan = planMcp(req);
  if (!plan.ok) return { ok: false, code: plan.code, message: plan.message };
  const artifactId = `mcp:${req.canonicalKey}`;
  const run = req.execImpl ?? defaultExec;

  const copies: { host: string; path: string; external?: boolean; projectRoot?: string }[] = [];
  const skipped: InstallSkipped[] = [];
  const hashedFiles: { path: string; hash: string; mtimeMs: number; bytes: number }[] = [];
  let firstCliEcho: string | undefined;
  for (const target of plan.targets) {
    if (target.refused) {
      skipped.push({ host: target.host, code: 'bad_request', message: target.refused });
      continue;
    }
    const adapter = adapterFor(target.host);
    if (!isMcpHost(adapter)) {
      skipped.push({ host: target.host, code: 'bad_request', message: `host '${target.host}' has no verified MCP landing` });
      continue;
    }
    if (target.cli) {
      // Gate 3: the argv was echoed in the plan and confirmed; it runs verbatim against the
      // runtime's own store — no file of ours exists, so the copy is recorded `external` (the
      // identity token is the manifest key; the ledger row's echoed command is the audit trail).
      let cliFailed = false;
      // Scope-aware CLIs (claude `--scope project`, grok `-s project`) locate the project landing
      // by the subprocess's cwd — running from the gateway's own cwd would write a stray repo.
      const cliCwd = req.scope === 'project' ? req.projectRoot : undefined;
      for (const step of target.cli.runs) {
        const result = await run(step.command, step.args, MCP_CLI_TIMEOUT_MS, cliCwd);
        if (!firstCliEcho) firstCliEcho = target.cli.echo;
        if (result.code !== 0) {
          skipped.push({
            host: target.host,
            code: 'upstream',
            message: `${redactSecrets(target.cli.echo, req.launch)} exited ${result.code}: ${result.stderr.slice(0, 200)}`,
          });
          cliFailed = true;
          break;
        }
      }
      // A failed CLI run installed nothing — recording an external copy would make the manifest
      // claim a landing that does not exist.
      // The identity token cannot attribute the copy to a project — `projectRoot` is the only
      // marker a later project-scoped page has (mirrors the plugin writer's external copies).
      if (!cliFailed)
        copies.push({
          host: target.host,
          path: `${req.canonicalKey}#${target.host}`,
          external: true,
          ...(req.scope === 'project' && req.projectRoot ? { projectRoot: req.projectRoot } : {}),
        });
      continue;
    }
    // One materialized path, one owning environment (§D4): a shared config file is claimed like any
    // other write target, so two OCR envs cannot interleave merges into one file.
    const claim = claimPath(target.file, artifactId);
    if (!claim.ok) {
      skipped.push({ host: target.host, code: 'foreign', message: `${target.file} is claimed by environment '${claim.env}'` });
      continue;
    }
    const parsed = readMcpLandingFile(target.file, adapter.mcpLandingFormat?.() ?? 'json');
    if (!parsed.ok) {
      // Nothing was written, so the claim taken above must not outlive this skip.
      releaseClaim(target.file);
      skipped.push({ host: target.host, code: 'bad_request', message: parsed.reason });
      continue;
    }
    const key = target.container ?? 'mcp';
    // Dot-path aware (openclaw `mcp.servers`); a scalar already sitting on the path is the
    // runtime's own state — refuse rather than overwrite it.
    const container = ensureMcpContainer(parsed.config, key);
    if (!container) {
      releaseClaim(target.file);
      skipped.push({ host: target.host, code: 'bad_request', message: `'${key}' is not an object in ${target.file}` });
      continue;
    }
    container[req.name] = desiredEntry(req.launch, adapter.mcpEntrySpec());
    try {
      // ADR-0015 transactional apply: snapshot the pre-image BEFORE touching the target, then the
      // house atomic rename (retries around Windows rename flakiness included).
      createBackup(target.file);
      safeWriteJson(target.file, parsed.config);
    } catch (e) {
      skipped.push({ host: target.host, code: 'upstream', message: e instanceof Error ? e.message : String(e) });
      releaseClaim(target.file);
      continue;
    }
    const stat = fs.statSync(target.file);
    hashedFiles.push({ path: target.file, hash: hashFile(target.file), mtimeMs: stat.mtimeMs, bytes: stat.size });
    copies.push({
      host: target.host,
      path: target.file,
      ...(req.scope === 'project' && req.projectRoot ? { projectRoot: req.projectRoot } : {}),
    });
  }
  if (copies.length === 0) {
    return { ok: false, code: skipped[0]?.code ?? 'no_target', message: skipped.map((s) => `${s.host}: ${s.message}`).join('; ') || 'no host config to merge into', skipped };
  }

  const manifest = readManifest();
  const now = new Date().toISOString();
  const previous = manifest.artifacts.find((a) => a.id === artifactId);
  const kept = (previous?.copies ?? []).filter((c) => !copies.some((item) => item.path === c.path));
  // A config merge hashes OUR file; a CLI landing has none — a digest of the echoed command is the
  // record. Hashed, never stored verbatim: the argv may carry an operator-typed secret value.
  const contentHash = hashedFiles[0]?.hash ?? `cli:${sha256(firstCliEcho ?? req.canonicalKey)}`;
  manifest.artifacts = [
    ...manifest.artifacts.filter((a) => a.id !== artifactId),
    {
      id: artifactId,
      canonicalKey: req.canonicalKey,
      kind: 'mcp',
      name: req.name,
      ...(req.description ? { description: req.description } : {}),
      sourceId: req.sourceId,
      ref: req.canonicalKey.slice(req.sourceId.length + 1),
      pin: req.pin ?? { adopted: true },
      contentHash,
      listedOn: req.listedOn ?? [req.sourceId],
      trust: req.trust,
      copies: [
        ...kept,
        ...copies.map((item) => {
          // Match the recorded hash by path — copies mixes external CLI landings (no hash) with
          // file merges, so positional indexing against hashedFiles would misassign hashes.
          const merged = hashedFiles.find((h) => h.path === item.path);
          return {
            scope: req.scope,
            host: item.host as HarnessHostId,
            rootId: 'default',
            path: item.path,
            ...(item.external ? { external: true } : {}),
            ...(item.projectRoot ? { projectRoot: item.projectRoot } : {}),
            contentHash: merged?.hash ?? contentHash,
            placement: 'materialized' as const,
            // The fast-path fingerprint the inventory compares against: without it every MCP copy
            // re-hashes the host's whole config file on every scan.
            ...(merged ? { mtimeMs: merged.mtimeMs, bytes: merged.bytes } : {}),
            installedAt: now,
          };
        }),
      ],
    },
  ];
  writeManifest(manifest);

  return { ok: true, artifactId, name: req.name, copies, skipped };
}

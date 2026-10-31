import fs from 'node:fs';
import path from 'node:path';
import { resolveEnvName } from '../../config/env.js';
import { hashFile } from '../hash.js';
import { writeConfigJson } from '../config-file.js';
import { defaultExec } from './writers/plugin.js';
import { echoArgv, MCP_CLI_TIMEOUT_MS } from './writers/mcp.js';
import { adapterFor, isMcpHost } from './adapters/index.js';
import { claimOwner, readManifest, writeManifest } from './manifest.js';
import { recordApply } from './ledger.js';
import {
  INVALID_MCP_LAUNCH,
  mcpEntryForLaunch,
  mcpLaunchFromEntry,
  mcpStdioTransportError,
  readMcpLandingFile,
  sameMcpEntry,
  validMcpLaunch,
  type McpEntrySpec,
} from './mcp-entry.js';
import type { McpTargetPlan } from './writers/mcp.js';
import type { McpLaunch } from '../spi.js';
import type { ArtifactRecord, HarnessHostId, HarnessScope } from '../types.js';

/**
 * MCP server EDIT (ADR-0015 §D8 amendment, 2026-11-01).
 *
 * The merge writer installs an entry; this module changes one that already exists — whether OCR
 * installed it (a manifest copy) or the runtime's own config carried it (a discovered row). The
 * write discipline is the removal path's, not the install path's: the file is the runtime's whole
 * config, so it is read as the host declares (plain JSON, or TOML for a CLI-materialized landing),
 * never lossily rewritten, backed up, and written atomically.
 *
 * A CLI-materialized landing (§D8.13: claude, codex) NEVER edits the file — the config is
 * read-only observation there, and the edit re-runs the runtime's own verbs (remove, then add),
 * each echoed in the gate-2 plan.
 *
 * Gates:
 *  - gate 2 — `confirm` is required for every real change; the plan names the exact file, container
 *    and server key before anything is written. An identical entry answers `changed: false` and
 *    writes nothing, so re-submitting the form is free.
 *  - gate 4 — the request carries key NAMES, plus a value only when the operator typed one into the
 *    registry-driven form. An existing env/header value whose key survives is preserved rather than
 *    rewritten to a reference, and no read answer ever carries a stored value (only the key names,
 *    and which of them are already set).
 *  - ownership — a config file claimed by ANOTHER environment is refused. An unclaimed file (the
 *    runtime's own config) is editable: that is the same rule removal applies to discovered rows.
 */

export interface McpEntryRequest {
  host: HarnessHostId;
  scope: HarnessScope;
  name: string;
  /** Project root for `project` scope; defaults to this process's cwd (threaded for tests). */
  projectRoot?: string;
}

export interface McpEditRequest extends McpEntryRequest {
  launch: McpLaunch;
  /** The manifest record to keep in sync. Absent = a discovered entry (no record to update). */
  artifactId?: string;
  /** Gate 2 acknowledgement; without it nothing is written. */
  confirm?: boolean;
  /** Test seam: the executor the CLI landing spawns (`defaultExec` when absent). */
  execImpl?: (command: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export type McpEntryFailure = { ok: false; code: 'bad_request' | 'not_found'; message: string };

export type McpEntryReadResult =
  | {
      ok: true;
      host: HarnessHostId;
      name: string;
      file: string;
      container: string;
      launch: McpLaunch;
      /** Keys that already hold a value (a literal or a `{file:...}` reference) — names only. */
      setKeys: string[];
    }
  | McpEntryFailure;

export type McpEditResult =
  | {
      ok: true;
      changed: boolean;
      host: HarnessHostId;
      name: string;
      file: string;
      container: string;
      artifactId: string | null;
    }
  | { ok: false; code: 'bad_request' | 'not_found' | 'foreign' | 'confirm_required'; message: string; plan?: McpTargetPlan[] };

/** The file, container and entry spelling an MCP server lives in, or the reason this host/scope has none. */
function landingFor(
  host: HarnessHostId,
  scope: HarnessScope,
  projectRoot: string
): { ok: true; file: string; container: string; spec: McpEntrySpec; format: 'json' | 'toml' } | { ok: false; message: string } {
  const adapter = adapterFor(host);
  if (!isMcpHost(adapter)) return { ok: false, message: `host '${host}' has no verified MCP landing` };
  const landing = adapter.configPath({ projectRoot }, scope);
  if (!landing.ok) return { ok: false, message: landing.reason };
  return {
    ok: true,
    file: path.resolve(landing.path),
    container: adapter.container,
    spec: adapter.mcpEntrySpec(),
    format: adapter.mcpLandingFormat?.() ?? 'json',
  };
}

function locate(req: McpEntryRequest): McpEntryReadResult {
  // The name is an EXISTING key here, not a key being created: the install grammar (`[\w.-]+`) guards
  // a new object key, while a runtime may legally store a hand-written one with other characters.
  if (!req.name.trim()) return { ok: false, code: 'bad_request', message: 'server name is required' };
  const landing = landingFor(req.host, req.scope, req.projectRoot ?? process.cwd());
  if (!landing.ok) return { ok: false, code: 'bad_request', message: landing.message };
  if (!fs.existsSync(landing.file)) {
    return { ok: false, code: 'not_found', message: `config file ${landing.file} does not exist` };
  }
  const parsed = readMcpLandingFile(landing.file, landing.format);
  if (!parsed.ok) return { ok: false, code: 'bad_request', message: parsed.reason };
  const container = parsed.config[landing.container];
  if (!container || typeof container !== 'object' || Array.isArray(container)) {
    return { ok: false, code: 'not_found', message: `${landing.file} has no '${landing.container}' object` };
  }
  if (!(req.name in (container as Record<string, unknown>))) {
    return { ok: false, code: 'not_found', message: `server '${req.name}' is not in ${landing.file}` };
  }
  const read = mcpLaunchFromEntry((container as Record<string, unknown>)[req.name]);
  if (!read.ok) return { ok: false, code: 'bad_request', message: read.reason };
  return {
    ok: true,
    host: req.host,
    name: req.name,
    file: landing.file,
    container: landing.container,
    launch: read.launch,
    setKeys: read.setKeys,
  };
}

/** Read one existing server's launch (key NAMES only). Writes nothing. */
export function readMcpEntry(req: McpEntryRequest): McpEntryReadResult {
  return locate(req);
}

/**
 * The manifest record whose copy is this exact file + server, when one exists.
 *
 * Answered by `name` + host + resolved path, never by the request's claim alone: a caller may omit
 * `artifactId` (a discovered row legitimately has none), and an id that names a different record is
 * a bad request rather than an excuse to rewrite the wrong hash. A CLI-materialized copy has no
 * file path — its `path` is the `external` identity token — so a host match alone claims it.
 */
function recordFor(
  artifacts: ArtifactRecord[],
  req: McpEditRequest,
  file: string
): { ok: true; record?: ArtifactRecord } | { ok: false; message: string } {
  const abs = path.resolve(file);
  const owners = artifacts.filter(
    (artifact) =>
      artifact.kind === 'mcp' &&
      artifact.name === req.name &&
      artifact.copies.some(
        (copy) => copy.host === req.host && (copy.external === true || path.resolve(copy.path) === abs)
      )
  );
  if (req.artifactId) {
    const record = owners.find((artifact) => artifact.id === req.artifactId);
    if (!record) {
      return { ok: false, message: `artifact '${req.artifactId}' has no '${req.name}' copy on ${file}` };
    }
    return { ok: true, record };
  }
  return { ok: true, ...(owners[0] ? { record: owners[0] } : {}) };
}

/** Change one server's launch in place. Plan → confirm → write; a no-op change writes nothing. */
export async function editMcpServer(req: McpEditRequest): Promise<McpEditResult> {
  if (req.scope !== 'global' && req.scope !== 'project') {
    return { ok: false, code: 'bad_request', message: `invalid scope '${String(req.scope)}'` };
  }
  if (!validMcpLaunch(req.launch)) return { ok: false, code: 'bad_request', message: INVALID_MCP_LAUNCH };
  // An edited entry lands in a host that reads it over stdio; an HTTP transport flag belongs to a
  // remote (url) entry, never to this shape.
  const transportError = mcpStdioTransportError(req.launch);
  if (transportError) return { ok: false, code: 'bad_request', message: transportError };
  const editAdapter = adapterFor(req.host);
  if (editAdapter && isMcpHost(editAdapter) && editAdapter.mcpLiteralEnv?.()) {
    // No expansion in this runtime's config: an unnamed secret would land as a dead literal.
    const keys = 'command' in req.launch ? req.launch.envKeys : req.launch.headerKeys;
    const values = 'command' in req.launch ? req.launch.envValues : req.launch.headerValues;
    const unnamed = (keys ?? []).filter((key) => typeof values?.[key] !== 'string' || values[key] === '');
    if (unnamed.length > 0) {
      return {
        ok: false,
        code: 'bad_request',
        message: `${req.host} env/header values are literal (no \${KEY} expansion) — provide a value for '${unnamed[0]}'`,
      };
    }
  }
  const located = locate(req);
  if (!located.ok) return located;

  const landing = landingFor(located.host, req.scope, req.projectRoot ?? process.cwd());
  if (!landing.ok) return { ok: false, code: 'bad_request', message: landing.message };
  const parsed = readMcpLandingFile(located.file, landing.format);
  if (!parsed.ok) return { ok: false, code: 'bad_request', message: parsed.reason };
  const container = parsed.config[located.container] as Record<string, unknown>;
  const existing = container[located.name];
  // The entry SPELLING is the host's: opencode's `{type, command[], environment}` vs the
  // `mcpServers` `{command, args, env}`. Composing with the wrong one would write a server every
  // other runtime reads as broken.
  const next = mcpEntryForLaunch(existing, req.launch, landing.spec);

  if (sameMcpEntry(existing, next)) {
    return {
      ok: true,
      changed: false,
      host: located.host,
      name: located.name,
      file: located.file,
      container: located.container,
      artifactId: null,
    };
  }

  const manifest = readManifest();
  const owned = recordFor(manifest.artifacts, req, located.file);
  if (!owned.ok) return { ok: false, code: 'bad_request', message: owned.message };
  const record = owned.record;

  const adapterForEdit = adapterFor(located.host);
  const cliSpec = isMcpHost(adapterForEdit) ? adapterForEdit.mcpCliSpec?.() ?? null : null;
  if (cliSpec) {
    // CLI-materialized landing: the file is read-only observation, so the edit re-runs the
    // runtime's own verbs — remove (when the server already exists) then add. The config file is
    // never claimed or reserialized; the runtime's store stays the truth (§D8.13).
    const runs: { command: string; args: string[] }[] = [];
    if (existing !== undefined) {
      const remove = cliSpec.removeArgs(located.name, req.scope);
      if (!remove.ok) return { ok: false, code: 'bad_request', message: remove.reason };
      runs.push({ command: cliSpec.command, args: remove.args });
    }
    const add = cliSpec.addArgs(req.launch, located.name, req.scope);
    if (!add.ok) return { ok: false, code: 'bad_request', message: add.reason };
    runs.push({ command: cliSpec.command, args: add.args });
    const echo = runs.map((step) => echoArgv(step.command, step.args)).join(' && ');
    if (!req.confirm) {
      return {
        ok: false,
        code: 'confirm_required',
        message: `editing '${located.name}' runs the host's own CLI — confirm to apply`,
        plan: [
          {
            host: located.host,
            file: located.file,
            exists: true,
            container: located.container,
            addedKeys: [],
            changedKeys: [located.name],
            cli: { echo, runs },
          },
        ],
      };
    }
    for (const step of runs) {
      const result = await (req.execImpl ?? defaultExec)(step.command, step.args, MCP_CLI_TIMEOUT_MS);
      if (result.code !== 0) {
        return { ok: false, code: 'bad_request', message: `${echo} exited ${result.code}: ${result.stderr.slice(0, 200)}` };
      }
    }
    recordApply({
      action: 'edit',
      kind: 'mcp',
      artifactId: record?.id ?? `mcp:${located.host}|${located.name}`,
      name: located.name,
      hosts: [located.host],
      outcome: 'ok',
      message: echo,
    });
    return {
      ok: true,
      changed: true,
      host: located.host,
      name: located.name,
      file: located.file,
      container: located.container,
      artifactId: record?.id ?? null,
    };
  }

  // A config file claimed by ANOTHER environment is transfer-only. An unclaimed file is the
  // runtime's own config — editing it is observation, not taking ownership (the removal rule).
  const owner = claimOwner(located.file);
  if (owner && owner !== resolveEnvName()) {
    return { ok: false, code: 'foreign', message: `${located.file} is claimed by environment '${owner}'` };
  }

  if (!req.confirm) {
    return {
      ok: false,
      code: 'confirm_required',
      message: `editing '${located.name}' rewrites one member of ${located.file} — confirm to apply`,
      plan: [
        {
          host: located.host,
          file: located.file,
          exists: true,
          container: located.container,
          addedKeys: [],
          changedKeys: [located.name],
        },
      ],
    };
  }

  parsed.config[located.container] = { ...container, [located.name]: next };
  const written = writeConfigJson(located.file, parsed.config);
  if (!written.ok) return { ok: false, code: 'bad_request', message: written.reason };

  const hash = hashFile(located.file);
  if (record) {
    const abs = path.resolve(located.file);
    record.copies = record.copies.map((copy) =>
      copy.host === located.host && path.resolve(copy.path) === abs ? { ...copy, contentHash: hash } : copy
    );
    record.contentHash = hash;
    writeManifest(manifest);
  }

  recordApply({
    action: 'edit',
    kind: 'mcp',
    artifactId: record?.id ?? `mcp:${located.host}|${located.name}`,
    name: located.name,
    hosts: [located.host],
    outcome: 'ok',
    message: `edited the launch in ${located.file}; the file keeps its other entries`,
  });

  return {
    ok: true,
    changed: true,
    host: located.host,
    name: located.name,
    file: located.file,
    container: located.container,
    artifactId: record?.id ?? null,
  };
}

import { getAdapter } from './registry.js';
import { recordApply } from './ledger.js';
import { adapterFor, type PluginHost } from './adapters/index.js';
import { probeArtifact, type ProbeResult } from './probe.js';
import type { McpTargetPlan } from './writers/mcp.js';
import { applyMcp, planMcp } from './writers/mcp.js';
import type { PluginTargetPlan } from './writers/plugin.js';
import { applyPlugin, planPlugin, safeSpec } from './writers/plugin.js';
import type { ExecImpl } from './writers/plugin.js';
import type { McpLaunch, ResolveFailureCode, ResolveOptions } from '../spi.js';
import { applySkill, type InstallSkipped } from './writers/skill.js';
import type { HarnessHostId, HarnessKind, HarnessScope, Pin, TrustTier } from '../types.js';

/**
 * Install orchestrator (ADR-0015 §8): source adapter → normalized payload → kind writer.
 *
 * The orchestrator owns vocabulary only — key parsing and failure mapping. Network lives in the
 * source adapter, disk in the writer; adding a marketplace or an artifact kind never widens this
 * file beyond dispatch.
 *
 * Key grammar: `<sourceId>:<ref>` with an optional `#detail` pin on the ref
 * (e.g. `github:owner/repo#skill-dir`). A request may instead carry the legacy `repo` +
 * `skillDir` fields, which compose into the same key. The manual escape hatch (§D6) skips resolve
 * entirely: `manualPayload` IS the payload, keyed `manual:<name>`.
 *
 * MCP writes follow plan → confirm → apply (gate 1/2): without `confirm`, a kind-'mcp' request
 * answers `confirm_required` with the per-host merge plan (added/changed keys) and touches nothing.
 *
 * Plugins are harness-bound (ADR-0015 §D2): the request must name exactly ONE host, which becomes
 * the artifact's `harness` dimension (`plugin:<harness>:<canonicalKey>`), not just a landing path.
 */

export interface InstallRequest {
  sourceId?: string;
  /** Canonical key `<sourceId>:<ref>[#detail]`; wins over `repo`+`skillDir` when both are given. */
  key?: string;
  /** Legacy/compat fields: `owner/repo` + optional skill directory (github source). */
  repo?: string;
  skillDir?: string;
  kind?: HarnessKind;
  /** Manual source payload (ADR-0015 §D6) — `kind` must be `mcp`; key becomes `manual:<name>`. */
  manualPayload?: { name: string; launch: McpLaunch };
  /** Manual plugin spec (ADR-0015 §D6) — `kind` must be `plugin`; key becomes `manual:<spec>`. */
  manualSpec?: string;
  /** Confirm gate for config-merging kinds. Without it, `kind: 'mcp'` returns the plan only. */
  confirm?: boolean;
  /** Injectable process runner for plugin subprocess installs. */
  execImpl?: ExecImpl;
  /** Landing hosts. `kind: 'plugin'` requires EXACTLY one — the harness is part of its identity. */
  hosts: HarnessHostId[];
  /**
   * Landing scope. The signature keeps the full union as the SEAM for project support, but the admin
   * route refuses anything outside `ENABLED_SCOPES` (`harness/scopes.ts`) — today `global` only — so
   * no request from the product can land inside a repository (ADR-0015 §D2 "Scope").
   */
  scope: HarnessScope;
  /**
   * Other surfaces the operator found this artifact on, besides the one that writes it (`pi-dev` for
   * a package browsed in the Pi catalog, whose install runs through `npm`). The writer source is
   * always recorded first; ids are grammar-checked, deduped and capped, never looked up.
   */
  listedOn?: string[];
  fetchImpl?: typeof fetch;
  /** Project root for `project` scope; defaults to this process's cwd (threaded for tests). */
  projectRoot?: string;
  /**
   * GIT-BACKED plugin identity (ADR-0015 §D9 amendment): `repo` + the plugin/marketplace names the
   * source's own manifest declares. When present, the harness's NATIVE chain installs it — no
   * payload is resolved, no tarball is fetched, no config array is written.
   */
  marketplace?: { repo: string; plugin: string; name: string };
}

/** Upper bound on the recorded listing surfaces: a row is browsed on a handful of catalogs, and an
 *  unbounded array would be a manifest field a request could grow without limit. */
const LISTED_ON_MAX = 8;

/**
 * The listing surfaces one record keeps, writer source first.
 *
 * The id grammar is checked but the source REGISTRY is not: the console's chips are built from the
 * registry, so an id that names nothing narrows nothing — it can never fabricate a chip or a label.
 * The writer source goes first so a record's own provenance never depends on what the caller claimed.
 */
function composeListedOn(writer: string, extra: string[] | undefined): string[] {
  const ids = [writer, ...(extra ?? [])].filter((id) => /^[a-z][\w-]*$/.test(id));
  return [...new Set(ids)].slice(0, LISTED_ON_MAX);
}

export type InstallResult =
  | {
      ok: true;
      artifactId: string;
      name: string;
      storeRef?: string;
      commitSha?: string;
      files?: number;
      bytes?: number;
      copies: { host: string; path?: string }[];
      skipped: InstallSkipped[];
      /** Post-apply verification — placement upgrades live in the manifest copies. */
      probe?: ProbeResult;
    }
  | {
      ok: false;
      code: InstallFailureCode;
      message: string;
      candidates?: string[];
      skipped?: InstallSkipped[];
      /** Per-host merge plan for `confirm_required` (MCP gate 2: show the exact keys). */
      plan?: McpTargetPlan[] | PluginTargetPlan[];
    };

export type InstallFailureCode =
  | 'bad_request'
  | ResolveFailureCode
  | 'confirm_required'
  | 'invalid_name'
  | 'no_target'
  | 'exists'
  | 'foreign';

/** Shape-validate a manual launch BEFORE any writer sees it — a primitive would 500 in desiredEntry. */
function validLaunch(launch: unknown): launch is McpLaunch {
  if (!launch || typeof launch !== 'object') return false;
  const l = launch as Record<string, unknown>;
  const stringArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (typeof l.command === 'string' && l.command.trim() !== '') {
    return (l.args === undefined || stringArray(l.args)) && (l.envKeys === undefined || stringArray(l.envKeys));
  }
  if (typeof l.url === 'string' && l.url.trim() !== '') {
    return (
      (l.transport === undefined || ['http', 'sse', 'stdio'].includes(l.transport as string)) &&
      (l.headerKeys === undefined || stringArray(l.headerKeys))
    );
  }
  return false;
}

/** Compose the canonical key from either request shape; validates the `#detail` segment. */
function composeKey(req: InstallRequest): { ok: true; key: string; kind: HarnessKind } | { ok: false; message: string } {
  const kind = req.kind ?? 'skill';
  if (req.manualPayload) {
    if (kind !== 'mcp') return { ok: false, message: 'manualPayload currently serves kind mcp only' };
    const name = req.manualPayload.name.trim();
    if (!name || !/^[\w.-]+$/.test(name)) return { ok: false, message: `invalid server name '${req.manualPayload.name}'` };
    // A server name becomes an object KEY in the runtime's config. `__proto__` is not a key: an
    // assignment to it rewrites the prototype, `JSON.stringify` then omits the entry, and the apply
    // would report success over a config that never received the server.
    if (['__proto__', 'prototype', 'constructor'].includes(name)) {
      return { ok: false, message: `reserved server name '${name}'` };
    }
    if (!validLaunch(req.manualPayload.launch)) {
      return { ok: false, message: 'invalid manual launch: expected {command, args?, envKeys?} or {url, transport?, headerKeys?}' };
    }
    return { ok: true, key: `manual:${name}`, kind };
  }
  if (req.manualSpec) {
    if (kind !== 'plugin') return { ok: false, message: 'manualSpec serves kind plugin only' };
    if (!safeSpec(req.manualSpec)) return { ok: false, message: `invalid package spec '${req.manualSpec}'` };
    return { ok: true, key: `manual:${req.manualSpec}`, kind };
  }
  if (req.key) {
    if (!/^[a-z][\w-]*:[\s\S]+$/.test(req.key)) {
      return { ok: false, message: `invalid key '${req.key}' (expected <sourceId>:<ref>)` };
    }
    // A `..` segment in the ref would resolve outside the store when an adapter later joins it
    // into a path (`node_modules/<name>`, a landing directory).
    if (req.key.includes('..')) return { ok: false, message: `invalid key '${req.key}'` };
    return { ok: true, key: req.key, kind };
  }
  const dir = req.skillDir?.trim().replace(/^\/+|\/+$/g, '') || '';
  if (dir && !/^[\w./-]+$/.test(dir)) {
    return { ok: false, message: `invalid skill directory '${dir}'` };
  }
  if (dir && dir.split('/').includes('..')) {
    return { ok: false, message: `invalid skill directory '${dir}'` };
  }
  if (!req.repo) return { ok: false, message: 'repo or key is required' };
  return { ok: true, key: `github:${req.repo}${dir ? `#${dir}` : ''}`, kind };
}

export async function installArtifact(req: InstallRequest): Promise<InstallResult> {
  if (!Array.isArray(req.hosts) || req.hosts.length === 0) {
    return { ok: false, code: 'bad_request', message: 'hosts[] must not be empty' };
  }
  if (req.scope !== 'global' && req.scope !== 'project') {
    return { ok: false, code: 'bad_request', message: `invalid scope '${String(req.scope)}'` };
  }
  const composed = composeKey(req);
  if (!composed.ok) return { ok: false, code: 'bad_request', message: composed.message };
  const { key, kind } = composed;
  // An plugin is code against ONE runtime's plugin API: exactly one harness per install, and the
  // harness is part of the artifact id. Two harnesses = two installs, never one multi-host copy.
  if (kind === 'plugin' && req.hosts.length !== 1) {
    return { ok: false, code: 'bad_request', message: 'plugin installs target exactly one harness' };
  }

  const sep = key.indexOf(':');
  const sourceId = key.slice(0, sep);
  const ref = key.slice(sep + 1);
  /** Discovery facets travel with the record: the writer source plus wherever it was browsed. */
  const listedOn = composeListedOn(sourceId, req.listedOn);
  const adapter = getAdapter(sourceId);

  let canonicalKey: string;
  let payloadName: string;
  let launch: McpLaunch | undefined;
  let skillFiles: { path: string; data: Buffer }[] | undefined;
  /** Plugin package spec (what the writer inserts verbatim); set only by an plugin payload. */
  let extSpec: string | undefined;
  let storeKey: string | undefined;
  let pin: Pin | undefined;
  /** Resolved one-line description; travels to the manifest so installed rows are not blank. */
  let description: string | null | undefined;
  let trust: TrustTier;

  if (req.manualPayload) {
    trust = 'manual';
    canonicalKey = key;
    payloadName = req.manualPayload.name.trim();
    launch = req.manualPayload.launch;
  } else if (req.manualSpec) {
    trust = 'manual';
    canonicalKey = key;
    payloadName = req.manualSpec;
  } else if (req.marketplace && kind === 'plugin') {
    // Native marketplace install: the runtime owns the clone, so there is no payload to resolve.
    // The chain itself is planned/echoed by the plugin writer (gate 3), never invented here.
    const identity = req.marketplace;
    if (
      typeof identity.repo !== 'string' ||
      typeof identity.plugin !== 'string' ||
      typeof identity.name !== 'string' ||
      !identity.repo ||
      !identity.plugin ||
      !identity.name
    ) {
      return { ok: false, code: 'bad_request', message: 'marketplace requires {repo, plugin, name}' };
    }
    const harness = req.hosts[0]!;
    const hostAdapter = adapterFor(harness);
    const chain = (hostAdapter as Partial<PluginHost>)?.marketplaceSpec?.() ?? null;
    if (!chain) {
      return { ok: false, code: 'bad_request', message: `harness '${harness}' declares no native marketplace install form` };
    }
    trust = 'community';
    canonicalKey = key;
    payloadName = identity.plugin;
  } else {
    if (!adapter) {
      return { ok: false, code: 'unsupported_source', message: `no install adapter for source '${sourceId}'` };
    }
    if (!adapter.kinds.includes(kind)) {
      return { ok: false, code: 'unsupported_kind', message: `source '${sourceId}' cannot resolve kind '${kind}'` };
    }
    // A source may declare the harnesses its artifacts serve (ADR-0015 §D2). An plugin is
    // harness-bound by nature, so a source that does not serve THIS runtime cannot produce its code.
    if (kind === 'plugin' && adapter.hosts) {
      const harness = req.hosts[0]!;
      if (!adapter.hosts.includes(harness)) {
        return {
          ok: false,
          code: 'unsupported_source',
          message: `source '${sourceId}' does not serve plugins for harness '${harness}'`,
        };
      }
    }
    const opts: ResolveOptions = req.fetchImpl ? { fetchImpl: req.fetchImpl } : {};
    const resolved = await adapter.resolve(ref, kind, opts);
    if (!resolved.ok) {
      return { ok: false, code: resolved.code, message: resolved.message, candidates: resolved.candidates };
    }
    trust = adapter.trust;
    canonicalKey = resolved.canonicalKey;
    payloadName = resolved.payload.name;
    storeKey = resolved.storeKey;
    pin = resolved.pin;
    description = resolved.description ?? null;
    if (resolved.payload.kind === 'mcp') launch = resolved.payload.launch;
    else if (resolved.payload.kind === 'skill') skillFiles = resolved.payload.files;
    else extSpec = resolved.payload.spec;
  }
  switch (kind) {
    case 'skill': {
      if (!skillFiles || !pin) return { ok: false, code: 'bad_request', message: 'skill dispatch without a skill payload' };
      const applied = applySkill({
        sourceId,
        canonicalKey,
        rawName: payloadName,
        storeKey: storeKey ?? `${sourceId}__${payloadName}`,
        files: skillFiles,
        pin,
        trust,
        listedOn,
        hosts: req.hosts,
        scope: req.scope,
        projectRoot: req.projectRoot,
      });
      if (!applied.ok) {
        recordApply({
          action: 'install', kind: 'skill', artifactId: `skill:${canonicalKey}`, name: payloadName,
          hosts: req.hosts, outcome: 'failed', message: applied.message,
        });
        return { ok: false, code: applied.code, message: applied.message, skipped: applied.skipped };
      }
      const outcome = applied.skipped.length > 0 ? 'partial' : 'ok';
      recordApply({
        action: 'install', kind: 'skill', artifactId: applied.artifactId, name: applied.name,
        hosts: applied.copies.map((c) => c.host),
        outcome,
        message: outcome === 'partial' ? applied.skipped.map((s) => `${s.host}: ${s.message}`).join('; ') : `${applied.files} files, ${applied.bytes} bytes`,
      });
      const commitSha = 'git' in pin ? pin.git.commitSha : undefined;
      const probe = probeArtifact(applied.artifactId) ?? undefined;
      return { ...applied, commitSha, probe };
    }
    case 'mcp': {
      if (!launch) return { ok: false, code: 'bad_request', message: 'mcp dispatch without a launch spec' };
      const mcpReq = {
        sourceId,
        canonicalKey,
        name: payloadName,
        ...(description ? { description } : {}),
        launch,
        trust,
        // Adapter provenance travels to the manifest (the same rule the plugin path applies);
        // a manual entry has none, and the writer records `adopted` for it.
        pin: pin ?? { adopted: true },
        listedOn,
        hosts: req.hosts,
        scope: req.scope,
        projectRoot: req.projectRoot,
      };
      // Gate 1/2 — plan → confirm → apply. Without confirmation, NOTHING is written.
      if (!req.confirm) {
        const plan = planMcp(mcpReq);
        if (!plan.ok) return { ok: false, code: 'bad_request', message: plan.message };
        return {
          ok: false,
          code: 'confirm_required',
          message: `MCP install merges into ${plan.targets.filter((t) => !t.refused).length} config file(s) — confirm to apply`,
          plan: plan.targets,
        };
      }
      const applied = applyMcp(mcpReq);
      if (!applied.ok) {
        recordApply({
          action: 'install', kind: 'mcp', artifactId: `mcp:${canonicalKey}`, name: payloadName,
          hosts: req.hosts, outcome: 'failed', message: applied.message,
        });
        return { ok: false, code: applied.code, message: applied.message, skipped: applied.skipped };
      }
      recordApply({
        action: 'install', kind: 'mcp', artifactId: applied.artifactId, name: applied.name,
        hosts: applied.copies.map((c) => c.host),
        outcome: applied.skipped.length > 0 ? 'partial' : 'ok',
        message: applied.skipped.length > 0 ? applied.skipped.map((s) => `${s.host}: ${s.message}`).join('; ') : `merged into ${applied.copies.length} config file(s)`,
      });
      const probe = probeArtifact(applied.artifactId) ?? undefined;
      return { ...applied, skipped: applied.skipped, probe };
    }
    case 'plugin': {
      const harness = req.hosts[0]!;
      const extReq = {
        sourceId,
        canonicalKey,
        // `manualSpec` IS the spec; an adapter payload answers the concrete pinned spec separately.
        spec: extSpec ?? payloadName,
        ...(description ? { description } : {}),
        trust,
        listedOn,
        // Adapter provenance travels to the manifest; a manual spec has none, so the writer records
        // `adopted` rather than an invented pin.
        pin: pin ?? { adopted: true },
        harness,
        scope: req.scope,
        projectRoot: req.projectRoot,
        execImpl: req.execImpl,
        // A git-backed row names the runtime's own marketplace identity; the writer plans the
        // native chain from it (and ignores `spec`, which stays the plugin name for the record).
        ...(req.marketplace ? { marketplace: req.marketplace } : {}),
      };
      // Gate 1/3 — plan → confirm → apply; the plan echoes the EXACT third-party command(s).
      if (!req.confirm) {
        const plan = planPlugin(extReq);
        if (!plan.ok) return { ok: false, code: 'bad_request', message: plan.message };
        return {
          ok: false,
          code: 'confirm_required',
          // An interactive chain (cursor/kimi) can never be spawned: the gate shows the command and
          // says so, instead of asking for a confirmation whose apply would only refuse.
          message: plan.targets.some((t) => t.op === 'manual')
            ? "this runtime installs plugins only from inside a session — run the shown command there"
            : req.marketplace
              ? "plugin install runs the runtime's own marketplace command(s) — confirm to apply"
              : 'plugin install executes third-party code (npm lifecycle scripts) — confirm to apply',
          plan: plan.targets,
        };
      }
      const applied = await applyPlugin(extReq);
      if (!applied.ok) {
        recordApply({
          action: 'install', kind: 'plugin', artifactId: `plugin:${harness}:${canonicalKey}`, name: payloadName,
          hosts: [harness], command: applied.runs?.[0]?.command ?? '',
          outcome: 'failed', message: applied.message,
        });
        return { ok: false, code: applied.code, message: applied.message, skipped: applied.skipped };
      }
      recordApply({
        action: 'install', kind: 'plugin', artifactId: applied.artifactId, name: applied.name,
        hosts: [harness],
        command: applied.runs[0]?.command ?? '',
        outcome: applied.skipped.length > 0 ? 'partial' : 'ok',
        message: applied.runs.length > 0
          ? applied.runs.map((r) => `${r.host}: exit ${r.code}`).join('; ')
          : `merged into ${applied.copies.length} config file(s)`,
      });
      const probe = probeArtifact(applied.artifactId) ?? undefined;
      return { ...applied, skipped: applied.skipped, probe };
    }
    default:
      return { ok: false, code: 'unsupported_kind', message: `no writer for kind '${kind}'` };
  }
}

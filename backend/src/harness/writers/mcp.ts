import fs from 'node:fs';
import { hashFile } from '../hash.js';
import { adapterFor, isMcpHost } from '../adapters/index.js';
import { claimPath, readManifest, releaseClaim, writeManifest } from '../manifest.js';
import type { McpLaunch } from '../spi.js';
import type { InstallSkipped } from './skill.js';
import { createBackup, safeWriteJson } from '../../cli/clients/base.js';
import type { HarnessHostId, HarnessScope, Pin, TrustTier } from '../types.js';

/**
 * MCP kind writer (ADR-0015 §8) — CONFIG MERGE, never overwrite.
 *
 * The two data-loss gates, enforced here:
 *  - gate 2 (no silent merge): `planMcp` computes the exact added/changed keys per host file; the
 *    orchestrator refuses to apply until the caller confirms. A file that cannot be round-tripped as
 *    plain JSON (comments, trailing garbage) is REFUSED, not rewritten — stringify-after-parse would
 *    silently drop hand-written comments.
 *  - gate 4 (secrets are named, not stored): env/header values never reach this module — the launch
 *    carries key NAMES only, and the merge materializes `{env:KEY}` references for the operator to
 *    satisfy in their own runtime (ADR-0006 stays untouched).
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

const BOM = '\uFEFF';

/** The opencode-shaped entry for one launch. Values reference the operator's environment. */
function desiredEntry(launch: McpLaunch): Record<string, unknown> {
  if ('command' in launch) {
    return {
      type: 'local',
      command: [launch.command, ...(launch.args ?? [])],
      enabled: true,
      environment: Object.fromEntries((launch.envKeys ?? []).map((key) => [key, `{env:${key}}`])),
    };
  }
  return {
    type: 'remote',
    url: launch.url,
    enabled: true,
    headers: Object.fromEntries((launch.headerKeys ?? []).map((key) => [key, `{env:${key}}`])),
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

/** Read + validate one config file. Refuses anything a JSON round-trip would silently mangle. */
function readPlainJson(file: string, exists: boolean): { ok: true; config: Record<string, unknown> } | { ok: false; reason: string } {
  if (!exists) return { ok: true, config: {} };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, reason: `cannot read config: ${e instanceof Error ? e.message : e}` };
  }
  if (text.startsWith(BOM)) text = text.slice(1);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'config root is not a JSON object' };
    }
    return { ok: true, config: parsed as Record<string, unknown> };
  } catch {
    const commentish = /(^|[^:"'\\])\/\/|\/\*/.test(text);
    return {
      ok: false,
      reason: commentish
        ? 'config contains comments (JSONC) — a JSON rewrite would drop them; refusing'
        : 'config is not valid JSON; refusing',
    };
  }
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
    const exists = fs.existsSync(landing.path);
    const parsed = readPlainJson(landing.path, exists);
    if (!parsed.ok) {
      targets.push({ host, file: landing.path, exists, refused: parsed.reason, addedKeys: [], changedKeys: [] });
      continue;
    }
    const container = parsed.config[adapter.container];
    const existing =
      container && typeof container === 'object' && !Array.isArray(container)
        ? (container as Record<string, unknown>)[req.name]
        : undefined;
    const desired = desiredEntry(req.launch);
    targets.push({
      host,
      file: landing.path,
      exists,
      container: adapter.container,
      refused: undefined,
      addedKeys: existing === undefined ? [req.name] : [],
      changedKeys: existing !== undefined && !sameEntry(existing, desired) ? [req.name] : [],
    });
  }
  return { ok: true, targets };
}

export function applyMcp(req: McpApplyRequest): McpApplyResult {
  const plan = planMcp(req);
  if (!plan.ok) return { ok: false, code: plan.code, message: plan.message };
  const artifactId = `mcp:${req.canonicalKey}`;

  const copies: { host: string; path: string }[] = [];
  const skipped: InstallSkipped[] = [];
  const hashedFiles: { path: string; hash: string }[] = [];
  for (const target of plan.targets) {
    if (target.refused) {
      skipped.push({ host: target.host, code: 'bad_request', message: target.refused });
      continue;
    }
    // One materialized path, one owning environment (§D4): a shared config file is claimed like any
    // other write target, so two OCR envs cannot interleave merges into one file.
    const claim = claimPath(target.file, artifactId);
    if (!claim.ok) {
      skipped.push({ host: target.host, code: 'foreign', message: `${target.file} is claimed by environment '${claim.env}'` });
      continue;
    }
    const parsed = readPlainJson(target.file, target.exists);
    if (!parsed.ok) {
      // Nothing was written, so the claim taken above must not outlive this skip.
      releaseClaim(target.file);
      skipped.push({ host: target.host, code: 'bad_request', message: parsed.reason });
      continue;
    }
    const key = target.container ?? 'mcp';
    const container =
      parsed.config[key] && typeof parsed.config[key] === 'object' && !Array.isArray(parsed.config[key])
        ? (parsed.config[key] as Record<string, unknown>)
        : (parsed.config[key] = {});
    container[req.name] = desiredEntry(req.launch);
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
    hashedFiles.push({ path: target.file, hash: hashFile(target.file) });
    copies.push({ host: target.host, path: target.file });
  }
  if (copies.length === 0) {
    return { ok: false, code: skipped[0]?.code ?? 'no_target', message: skipped.map((s) => `${s.host}: ${s.message}`).join('; ') || 'no host config to merge into', skipped };
  }

  const manifest = readManifest();
  const now = new Date().toISOString();
  const previous = manifest.artifacts.find((a) => a.id === artifactId);
  const kept = (previous?.copies ?? []).filter((c) => !copies.some((item) => item.path === c.path));
  const contentHash = hashedFiles[0]!.hash;
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
        ...copies.map((item, i) => ({
          scope: req.scope,
          host: item.host as HarnessHostId,
          rootId: 'default',
          path: item.path,
          contentHash: hashedFiles[i]!.hash,
          placement: 'materialized' as const,
          installedAt: now,
        })),
      ],
    },
  ];
  writeManifest(manifest);

  return { ok: true, artifactId, name: req.name, copies, skipped };
}

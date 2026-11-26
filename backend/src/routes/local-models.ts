/**
 * Admin routes for local inference engines (the console's Local Models page).
 *
 * Mounted under /api/admin/local-models/*, so the console auth preHandler
 * covers them. Install streams NDJSON like the mihomo core installer:
 * `stage`/`progress` events, then exactly one `result`.
 */
import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { detectDependencies, summarizeDetect, type DetectReport } from '../local/detect.js';
import {
  ENGINES,
  engineById,
  engineRuntimeInfo,
  installedEnginesFor,
  launchableEngines,
  probeEngineAvailability,
  recommendTargets,
  type EngineAvailability,
} from '../local/engines.js';
import { fetchHfModelFiles, groupHfShards, hfEndpoint, isValidRepoId, searchHfModels } from '../local/hf.js';
import {
  downloadHfModel,
  downloadHfModelGroup,
  importLocalModels,
  listInstalledModels,
  modelsDiskUsage,
  readInstalledModels,
  profileFor,
  removeHfModel,
  setEngineProfile,
  setModelName,
  type ModelDownloadEvent,
} from '../local/model-store.js';
import { loadConfig } from '../config/index.js';
import { localModelId } from '../local/local-provider.js';
import { requestPoolRefresh } from '../providers/pool-refresh.js';
import { installEngine, pruneSupersededInstall, uninstallEngine, type InstallEvent } from '../local/install.js';
import { autoCtx, nglForPlan, planPlacement, CTX_LADDER, KV_ELEM_Q8_0 } from '../local/plan.js';
import {
  deleteLocalRun,
  getLocalRun,
  listLocalRuns,
  pruneLocalRuns,
  restoreLocalRuns,
  runLogs,
  startLocalRun,
  stopLocalRun,
  DEFAULT_RUN_OPTIONS,
  type LocalRunOptions,
} from '../local/runner.js';
import { buildLogs, listBuildJobs, startBuildJob } from '../local/build-jobs.js';
import { allStats, dropStats, statsFor, statsRunIds } from '../local/run-stats.js';
import {
  defaultModelsDir,
  readLocalModelSettings,
  resolveHfEndpoint,
  resolveHfToken,
  resolveModelsDir,
  writeLocalModelSettings,
} from '../local/settings.js';

/**
 * Live installs keyed by leg (`engine:<id>`). A walked-away client fires no
 * disconnect the hijacked NDJSON response can observe (same Bun behaviour the
 * mihomo installer documents), so the console's explicit cancel call is the
 * only reliable stop signal.
 */
const liveTransfers = new Map<string, AbortController>();

function startEngineTransfer(raw: ServerResponse, leg: string): {
  signal: AbortSignal;
  send: (evt: Record<string, unknown>) => void;
  finish: () => void;
} {
  let closed = false;
  const abort = new AbortController();
  liveTransfers.set(leg, abort);
  raw.on('close', () => {
    closed = true;
    if (!raw.writableEnded) abort.abort(new Error('client disconnected'));
  });
  return {
    signal: abort.signal,
    send: (evt) => {
      if (closed) return;
      try {
        raw.write(`${JSON.stringify(evt)}\n`);
      } catch {
        closed = true;
      }
    },
    finish: () => {
      liveTransfers.delete(leg);
      if (!raw.writableEnded) raw.end();
    },
  };
}

function installEventToPayload(event: InstallEvent): Record<string, unknown> {
  return event as unknown as Record<string, unknown>;
}

/**
 * Whether a run still pins a binary inside `dir`.
 *
 * A run records the ABSOLUTE binary path in `runs.json`, so both a live engine
 * and a merely recorded one keep their build: deleting a running engine's
 * binary fails on Windows and would leave an un-restartable process on POSIX.
 */
async function engineDirInUse(dir: string): Promise<boolean> {
  try {
    const runs = await listLocalRuns();
    return runs.some((run) => (
      typeof run.binary === 'string'
      && run.binary.length > 0
      && path.resolve(run.binary).startsWith(dir + path.sep)
    ));
  } catch {
    // An unreadable run list must not license a delete.
    return true;
  }
}

function modelEventToPayload(event: ModelDownloadEvent): Record<string, unknown> {
  return event as unknown as Record<string, unknown>;
}

export function registerLocalModelRoutes(app: FastifyInstance): void {
  // Catalog + install state: everything the engine cards render in one read.
  // `installs` carries EVERY build target installed for the engine (a CPU
  // fallback beside the GPU build) — the run console picks among them.
  app.get('/api/admin/local-models/engines', async () => {
    return {
      status: 'ok' as const,
      platform: process.platform,
      arch: process.arch,
      engines: ENGINES.map((engine) => ({
        id: engine.id,
        name: engine.name,
        repo: engine.repo,
        description: engine.description,
        ...(engine.descriptionKey ? { descriptionKey: engine.descriptionKey } : {}),
        binaryNames: engine.binaryNames,
        targets: engine.targets(process.platform, process.arch),
        installs: installedEnginesFor(engine.id),
        // The console renders the run form FROM this block: placement owner,
        // which shared controls the build takes, and the operator profile's
        // field schema. A new engine needs no console change (ADR-0039).
        runtime: engineRuntimeInfo(engine),
      })),
    };
  });

  // Dependency probe + per-engine default target. Runs vendor CLIs with short
  // timeouts; a missing tool is a failed check row, never an error.
  app.post('/api/admin/local-models/detect', async () => {
    const report = await detectDependencies();
    // The recommendation is per-engine catalog data: adding an engine with a
    // `recommendTarget` automatically extends this map (ADR-0039).
    return { status: 'ok' as const, report, recommended: recommendTargets(summarizeDetect(report)) };
  });

  // Release availability: which catalog targets the CURRENT release actually
  // ships, per engine. The console disables the chips with no asset instead of
  // letting the install click discover it. Cached briefly — GitHub rate limits
  // are shared across every console on this host.
  let availabilityCache: { at: number; rows: EngineAvailability[] } | null = null;
  app.get('/api/admin/local-models/engines/availability', async () => {
    if (availabilityCache && Date.now() - availabilityCache.at < 600_000) {
      return { status: 'ok' as const, checkedAt: availabilityCache.at, engines: availabilityCache.rows };
    }
    const rows = await Promise.all(ENGINES.map((engine) => probeEngineAvailability(engine)));
    availabilityCache = { at: Date.now(), rows };
    return { status: 'ok' as const, checkedAt: availabilityCache.at, engines: rows };
  });

  // Recent release tags for the version picker. llama.cpp walks its prerelease
  // stream; Strata has one stable channel, so a single tag comes back.
  app.get('/api/admin/local-models/engines/:id/releases', async (req, reply) => {
    const engine = engineById(String((req.params as { id?: string }).id ?? ''));
    if (!engine) return reply.status(404).send({ status: 'error', message: 'unknown engine' });
    try {
      // Version choice is the engine's business: a nightly-tag engine ships
      // `listTags`, a single-channel engine answers with its one release tag.
      const tags = engine.listTags
        ? await engine.listTags(fetch)
        : [(await engine.resolveRelease(fetch)).tag];
      return { status: 'ok', tags };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'release lookup failed';
      return { status: 'error', message };
    }
  });

  // Streaming install. One NDJSON leg per engine, so a llama.cpp download and
  // a Strata download can run side by side while two clicks on the SAME engine
  // serialise inside the installer's lock.
  app.post('/api/admin/local-models/engines/:id/install', async (req, reply) => {
    const engineId = String((req.params as { id?: string }).id ?? '');
    if (!engineById(engineId)) {
      return reply.status(404).send({ status: 'error', message: 'unknown engine' });
    }
    const body = (req.body ?? {}) as { target?: unknown; version?: unknown };
    const target = typeof body.target === 'string' && body.target.trim() ? body.target.trim() : undefined;
    const version = typeof body.version === 'string' && body.version.trim() ? body.version.trim() : undefined;

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    // The leg names the engine AND the build target: a CUDA install and a CPU
    // install of the same engine are independent transfers.
    const leg = `engine:${engineId}:${target ?? 'auto'}`;
    const t = startEngineTransfer(raw, leg);
    let lastProgress = 0;
    try {
      const result = await installEngine({
        engineId,
        ...(target ? { target } : {}),
        ...(version ? { version } : {}),
        signal: t.signal,
        onEvent: (event) => {
          // Coalesce byte ticks to one per 100ms; stage events always pass.
          if (event.type === 'progress') {
            const now = Date.now();
            if (now - lastProgress < 100 && event.downloaded !== event.total) return;
            lastProgress = now;
          }
          t.send(installEventToPayload(event));
        },
      });
      // The upgrade sweep runs BEFORE the result goes out, so a `refresh()`
      // triggered by that result can never resurrect the old version row: by
      // then the record and the directory agree.
      if (result.ok && result.supersededDir) {
        // The usage probe is async (it health-checks live runs), so the
        // decision is resolved here and handed over: the sweep itself stays
        // synchronous and completes before the result is reported.
        const keep = await engineDirInUse(path.resolve(result.supersededDir));
        pruneSupersededInstall(result.supersededDir, () => keep);
      }
      // `supersededDir` is internal housekeeping (the console renders only
      // `installed`), so it never rides the wire.
      const payload: Record<string, unknown> = { ...result };
      delete payload.supersededDir;
      t.send({ type: 'result', status: result.ok ? 'ok' : 'error', ...payload });
    } catch (err) {
      const aborted = t.signal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      t.send({ type: 'result', status: 'error', ok: false, code: aborted ? 'download-aborted' : 'install-failed', error: aborted ? 'download cancelled' : message });
    }
    t.finish();
  });

  // Cancel a transfer the operator walked away from (keepalive fetch on page
  // leave). The .part files stay staged; the next click resumes.
  app.post('/api/admin/local-models/engines/transfers/cancel', async (req) => {
    const leg = typeof (req.body as { leg?: unknown } | null)?.leg === 'string'
      ? (req.body as { leg: string }).leg
      : '';
    const controller = liveTransfers.get(leg);
    if (!controller) return { status: 'ok', cancelled: false };
    controller.abort(new Error('cancelled by the console'));
    return { status: 'ok', cancelled: true };
  });

  app.delete('/api/admin/local-models/engines/:id', async (req, reply) => {
    const engineId = String((req.params as { id?: string }).id ?? '');
    if (!engineById(engineId)) {
      return reply.status(404).send({ status: 'error', message: 'unknown engine' });
    }
    const target = String((req.query as { target?: unknown }).target ?? '').trim();
    if (!target) {
      return reply.status(400).send({ status: 'error', message: 'target is required (an engine may have several installs)' });
    }
    const result = uninstallEngine(engineId, target);
    if (!result.ok) return reply.status(400).send({ status: 'error', message: result.error ?? 'uninstall failed' });
    return { status: 'ok' };
  });

  // ---- HuggingFace marketplace ------------------------------------------

  // Model-card search (GGUF-serving repos, most-downloaded first). Failures
  // degrade to an empty list + message instead of a 5xx: a rate-limited Hub
  // must still render the rest of the page.
  app.get('/api/admin/local-models/hf/search', async (req) => {
    const query = String((req.query as { q?: unknown }).q ?? '');
    const limit = Number((req.query as { limit?: unknown }).limit ?? 24);
    try {
      const models = await searchHfModels(query, Number.isFinite(limit) ? limit : 24);
      return { status: 'ok' as const, models, endpoint: hfEndpoint() };
    } catch (err) {
      return { status: 'ok' as const, models: [], endpoint: hfEndpoint(), message: err instanceof Error ? err.message : 'search failed' };
    }
  });

  // The file tree of one repo: every GGUF with real byte size + LFS sha256,
  // which the quant picker and the download verifier both need. Split-weight
  // shards collapse into ONE entry anchored at shard 1 (`shardCount` + the
  // `parts` list the group download sends back) with the summed byte size —
  // a shard is never a downloadable unit of its own.
  app.get('/api/admin/local-models/hf/model', async (req, reply) => {
    const repo = String((req.query as { id?: unknown }).id ?? '');
    if (!isValidRepoId(repo)) {
      return reply.status(400).send({ status: 'error', message: 'invalid model id' });
    }
    try {
      const files = await fetchHfModelFiles(repo);
      const grouped = groupHfShards(files).map((group) => {
        if (group.parts.length === 1) return group.primary;
        const { sha256: _shardSha, ...primary } = group.primary;
        return {
          ...primary,
          size: group.totalSize,
          shardCount: group.parts.length,
          parts: group.parts.map((part) => ({ path: part.path, size: part.size, ...(part.sha256 ? { sha256: part.sha256 } : {}) })),
        };
      });
      return { status: 'ok' as const, repo, files: grouped };
    } catch (err) {
      return reply.status(502).send({ status: 'error', message: err instanceof Error ? err.message : 'tree lookup failed' });
    }
  });

  // Installed model list + disk usage in one read (the management card).
  app.get('/api/admin/local-models/models', async () => {
    return { status: 'ok' as const, models: listInstalledModels(), diskUsageBytes: modelsDiskUsage() };
  });

  // Streaming model download. One NDJSON leg per file (`model:<repo>/<file>`)
  // so several quant downloads run side by side; cancel goes through the
  // shared transfers map (the /engines/transfers/cancel route above). The
  // caller passes the tree API's size + LFS sha256 so a finished download is
  // verified before it becomes a registry row (spliced resume is refused).
  // A split-weight model arrives as `files` (every shard, shard 1 first) and
  // registers ONE row anchored at shard 1; the leg names that anchor.
  app.post('/api/admin/local-models/models/download', async (req, reply) => {
    const body = (req.body ?? {}) as { repo?: unknown; filename?: unknown; size?: unknown; sha256?: unknown; files?: unknown };
    const repo = typeof body.repo === 'string' ? body.repo : '';
    const filename = typeof body.filename === 'string' ? body.filename : '';
    const groupParts = Array.isArray(body.files)
      ? body.files
          .map((part) => {
            const row = (part ?? {}) as { path?: unknown; size?: unknown; sha256?: unknown };
            return {
              path: typeof row.path === 'string' ? row.path : '',
              size: typeof row.size === 'number' && Number.isFinite(row.size) && row.size > 0 ? row.size : undefined,
              sha256: typeof row.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(row.sha256) ? row.sha256.toLowerCase() : undefined,
            };
          })
          .filter((part) => part.path)
      : [];
    if (!repo || (groupParts.length < 2 && !filename)) {
      return reply.status(400).send({ status: 'error', message: 'repo and filename (or files) are required' });
    }
    const size = typeof body.size === 'number' && Number.isFinite(body.size) && body.size > 0 ? body.size : undefined;
    const sha256 = typeof body.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(body.sha256) ? body.sha256.toLowerCase() : undefined;

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    const anchor = groupParts.length >= 2 ? groupParts[0].path : filename;
    const leg = `model:${repo}/${anchor}`;
    const t = startEngineTransfer(raw, leg);
    let lastProgress = 0;
    try {
      const onEvent = (event: ModelDownloadEvent) => {
        if (event.type === 'progress') {
          const now = Date.now();
          if (now - lastProgress < 100 && event.downloaded !== event.total) return;
          lastProgress = now;
        }
        t.send(modelEventToPayload(event));
      };
      const result = groupParts.length >= 2
        ? await downloadHfModelGroup({ repo, parts: groupParts, signal: t.signal, onEvent })
        : await downloadHfModel({
            repo,
            filename,
            ...(size != null ? { size } : {}),
            ...(sha256 ? { sha256 } : {}),
            signal: t.signal,
            onEvent,
          });
      t.send({
        type: 'result',
        status: result.ok ? 'ok' : 'error',
        ...(result.ok
          ? { installed: result.installed, resumedFrom: result.resumedFrom }
          : { code: result.code, error: result.error }),
      });
      // A new row is a new routable `local/<id>` (ADR-0038 §6) — resync now so
      // /v1/models and the pool see it without a restart.
      if (result.ok) requestPoolRefresh();
    } catch (err) {
      const aborted = t.signal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      t.send({ type: 'result', status: 'error', code: aborted ? 'download-aborted' : 'install-failed', error: aborted ? 'download cancelled' : message });
    }
    t.finish();
  });

  // Import .gguf files that already exist on this machine. `path` is one file
  // or a directory (walked shallowly); records point at the original files —
  // nothing is copied, and deleting an imported row keeps the file on disk.
  app.post('/api/admin/local-models/models/import', async (req, reply) => {
    const body = (req.body ?? {}) as { path?: unknown };
    const target = typeof body.path === 'string' ? body.path.trim() : '';
    if (!target) {
      return reply.status(400).send({ status: 'error', message: 'path is required' });
    }
    const result = importLocalModels(target);
    if (result.imported.length > 0) requestPoolRefresh();
    return {
      status: 'ok' as const,
      imported: result.imported,
      skipped: result.skipped,
      errors: result.errors,
    };
  });

  app.delete('/api/admin/local-models/models/:id', async (req) => {
    const id = String((req.params as { id?: string }).id ?? '');
    const result = removeHfModel(id);
    if (!result.ok) {
      return { status: 'error', message: result.error ?? 'remove failed' };
    }
    // The model universe is part of the routable pool (ADR-0038 §6): drop the
    // `local/<id>` registration now instead of at the next restart.
    requestPoolRefresh();
    return { status: 'ok' };
  });

  // ---- Operator launch profiles (ADR-0038 §4 → ADR-0039) ----------------
  // Some engines' command lines need inputs no GGUF header carries (Strata: a
  // compiled pack, the MTP draft head, optionally a PLE table and an expert
  // binary), so the profile is operator data stored ON the model record, keyed
  // by engine. The engine's runtime owns validation; this route is a transport.
  // Setting one is what turns a family-matching engine from a badge into a
  // runnable choice.
  const putProfile = async (req: { params: unknown; body: unknown }, reply: import('fastify').FastifyReply, engineId: string) => {
    const id = String((req.params as { id?: string }).id ?? '');
    if (!engineById(engineId)) {
      return reply.status(404).send({ status: 'error', message: `unknown engine '${engineId}'` });
    }
    const body = (req.body ?? {}) as { profile?: unknown };
    const raw = body.profile ?? req.body;
    const result = setEngineProfile(id, engineId, raw);
    if (!result.ok) {
      return reply.status(400).send({ status: 'error', code: result.code, message: result.error });
    }
    requestPoolRefresh();
    return { status: 'ok' as const, model: result.model };
  };

  const deleteProfile = async (req: { params: unknown }, engineId: string) => {
    const id = String((req.params as { id?: string }).id ?? '');
    const result = setEngineProfile(id, engineId, null);
    if (!result.ok) return { status: 'error' as const, code: result.code, message: result.error };
    requestPoolRefresh();
    return { status: 'ok' as const, model: result.model };
  };

  app.put<{ Params: { id: string; engine: string } }>('/api/admin/local-models/models/:id/profiles/:engine', async (req, reply) =>
    putProfile(req, reply, String(req.params.engine ?? ''))
  );

  app.delete<{ Params: { id: string; engine: string } }>('/api/admin/local-models/models/:id/profiles/:engine', async (req) =>
    deleteProfile(req, String(req.params.engine ?? ''))
  );

  // Strata's original spelling, kept so an older console build keeps working.
  app.put('/api/admin/local-models/models/:id/strata', async (req, reply) => putProfile(req, reply, 'strata'));

  app.delete('/api/admin/local-models/models/:id/strata', async (req) => deleteProfile(req, 'strata'));

  // ---- Operator model name (ADR-0038 §7) ---------------------------------
  // The name becomes the tail of the gateway id: `local/<name>` instead of
  // `local/<repo>/<file>`. Renaming (or clearing) RETIRES the old id, so the
  // answer names every config spot still pointing at it — tier member pins,
  // combos, key policies, gateway-internal model picks. Nothing is rewritten:
  // the operator moves those references deliberately (loud, never silent).
  app.put('/api/admin/local-models/models/:id/name', async (req, reply) => {
    const id = String((req.params as { id?: string }).id ?? '');
    const body = (req.body ?? {}) as { name?: unknown };
    const before = readInstalledModels()[id];
    if (!before) return reply.status(404).send({ status: 'error', message: 'model is not installed' });
    const previousGatewayId = localModelId(before);
    const result = setModelName(id, body.name);
    if (!result.ok) {
      return reply.status(400).send({ status: 'error', code: result.code, message: result.error });
    }
    const gatewayId = localModelId(result.model);
    const references: { kind: 'tier' | 'combo' | 'key' | 'setting'; ref: string }[] = [];
    if (gatewayId !== previousGatewayId) {
      const config = loadConfig();
      for (const tier of ['lite', 'plus', 'pro', 'ultra'] as const) {
        for (const rule of config.tiers?.[tier]?.members ?? []) {
          if (rule.pattern === previousGatewayId) references.push({ kind: 'tier', ref: `${tier}: ${rule.pattern}` });
        }
      }
      for (const pattern of config.tiers?.exclude ?? []) {
        if (pattern === previousGatewayId) references.push({ kind: 'tier', ref: `exclude: ${pattern}` });
      }
      for (const combo of config.combos ?? []) {
        const hit = combo.models.some((member) => (typeof member === 'string' ? member : member.id) === previousGatewayId);
        if (hit) references.push({ kind: 'combo', ref: combo.id });
      }
      for (const key of config.apiKeys ?? []) {
        if (key.modelAccess?.models?.includes(previousGatewayId)) {
          references.push({ kind: 'key', ref: `${key.name} (${key.id})` });
        }
      }
      if (config.classifier?.layer2?.model === previousGatewayId) references.push({ kind: 'setting', ref: 'classifier.layer2.model' });
      if (config.systemone?.defaultModel === previousGatewayId) references.push({ kind: 'setting', ref: 'systemone.defaultModel' });
      if (config.defaultModels?.translation === previousGatewayId) references.push({ kind: 'setting', ref: 'defaultModels.translation' });
    }
    // The registration id changed: the pool must re-list this model under the
    // new `local/<name>` now, not at the next restart (ADR-0038 §6).
    requestPoolRefresh();
    return {
      status: 'ok' as const,
      model: result.model,
      gatewayId,
      ...(gatewayId !== previousGatewayId ? { previousGatewayId } : {}),
      references,
    };
  });

  // ---- Settings (mirror / token / storage dir) ---------------------------

  // One read for the settings page: every effective value plus where it came
  // from, so the UI can badge "page config / environment variable / default".
  // The token is never returned in clear — just whether one is set and its last
  // 4 chars.
  app.get('/api/admin/local-models/settings', async () => {
    const stored = readLocalModelSettings();
    const endpoint = resolveHfEndpoint();
    const token = resolveHfToken();
    const dir = resolveModelsDir();
    return {
      status: 'ok' as const,
      hfEndpoint: endpoint.url,
      hfEndpointSource: endpoint.source,
      hfEndpointStored: stored.hfEndpoint ?? '',
      hfTokenSet: token.source !== 'none',
      hfTokenSource: token.source,
      hfTokenHint: token.token ? `••••${token.token.slice(-4)}` : '',
      modelsDir: dir.dir,
      modelsDirSource: dir.source,
      defaultModelsDir: defaultModelsDir(),
      /** Engine-level setup values per engine id (ADR-0039 §10), validated on
       *  write by the owning engine's `setup.normalize`. */
      engineSetup: stored.engineSetup ?? {},
      /** The path each engine uses when nothing is pinned — the console shows
       *  these in the setup form, so the operator sees the directory a launch
       *  will use. Computed by each engine's own setup.resolve. */
      engineSetupResolved: Object.fromEntries(
        ENGINES.flatMap((engine) => {
          const resolve = engine.runtime?.setup?.resolve;
          if (!resolve) return [];
          const resolved = resolve({ binary: installedEnginesFor(engine.id)[0]?.binaries[0] });
          return Object.keys(resolved).length > 0 ? [[engine.id, resolved]] : [];
        })
      ),
    };
  });

  // Partial update: omitted keys stay unchanged; an explicit empty string
  // clears a field (falling back to env/default). The token field uses the
  // same rule but the UI only ever sends it when the operator typed a new
  // one, so an accidental clear means deliberately saving an empty field.
  app.put('/api/admin/local-models/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const stored = readLocalModelSettings();
    if (typeof body.hfEndpoint === 'string') {
      const value = body.hfEndpoint.trim().replace(/\/+$/, '');
      if (value && !/^https?:\/\//i.test(value)) {
        return reply.status(400).send({ status: 'error', message: 'mirror URL must start with http:// or https://' });
      }
      if (value) stored.hfEndpoint = value;
      else delete stored.hfEndpoint;
    }
    if (typeof body.hfToken === 'string') {
      const value = body.hfToken.trim();
      if (value) stored.hfToken = value;
      else delete stored.hfToken;
    }
    if (typeof body.modelsDir === 'string') {
      const value = body.modelsDir.trim();
      if (value) stored.modelsDir = value;
      else delete stored.modelsDir;
    }
    // Engine setup (ADR-0039 §10): per-engine string maps, validated by the
    // OWNING engine's normalize — the route knows no field names. An empty
    // object clears that engine's setup.
    if (body.engineSetup !== undefined) {
      if (!body.engineSetup || typeof body.engineSetup !== 'object' || Array.isArray(body.engineSetup)) {
        return reply.status(400).send({ status: 'error', message: 'engineSetup must be an object keyed by engine id' });
      }
      const next = { ...(stored.engineSetup ?? {}) };
      for (const [engineId, raw] of Object.entries(body.engineSetup as Record<string, unknown>)) {
        const engine = engineById(engineId);
        const spec = engine?.runtime?.setup;
        if (!engine || !spec) {
          return reply.status(400).send({ status: 'error', message: `engine '${engineId}' takes no setup` });
        }
        const normalized = spec.normalize(raw);
        if (!normalized.ok) {
          return reply.status(400).send({ status: 'error', message: normalized.error });
        }
        if (Object.keys(normalized.setup).length > 0) next[engineId] = normalized.setup;
        else delete next[engineId];
      }
      if (Object.keys(next).length > 0) stored.engineSetup = next;
      else delete stored.engineSetup;
    }
    try {
      writeLocalModelSettings(stored);
    } catch (err) {
      return reply.status(500).send({ status: 'error', message: err instanceof Error ? err.message : 'could not save settings' });
    }
    return { status: 'ok' };
  });

  // Latency probe for the mirror presets (and any custom URL): a HEAD to the
  // base URL with a 4s cap. Server-side on purpose — a browser fetch would
  // trip the mirrors' CORS; round-trip time is what the picker sorts by.
  app.post('/api/admin/local-models/settings/mirrors/ping', async (req) => {
    const raw = typeof (req.body as { url?: unknown } | null)?.url === 'string'
      ? (req.body as { url: string }).url.trim()
      : '';
    if (!/^https?:\/\//i.test(raw)) {
      return { status: 'error', message: 'invalid URL' };
    }
    const started = Date.now();
    try {
      const res = await fetch(raw, {
        method: 'HEAD',
        headers: { 'User-Agent': 'omnicell-router' },
        signal: AbortSignal.timeout(4000),
      });
      await res.body?.cancel().catch(() => undefined);
      return { status: 'ok' as const, ok: true, ms: Date.now() - started, code: res.status };
    } catch (err) {
      return { status: 'ok' as const, ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : 'ping failed' };
    }
  });

  // ---- Server-side directory browser (the console's folder picker) -------

  // One listing per call: dirs always, .gguf files when `files=1`. No path on
  // Windows enumerates drives (the picker's start screen); elsewhere it falls
  // back to the home directory. Read-only — names and types, nothing else.
  app.get('/api/admin/local-models/fs', async (req, reply) => {
    const raw = String((req.query as { path?: unknown }).path ?? '').trim();
    const wantFiles = String((req.query as { files?: unknown }).files ?? '') === '1';

    const listDir = (dir: string): { status: 'ok'; path: string; parent: string | null; entries: Array<{ name: string; path: string; type: 'dir' | 'file' }> } | { status: 'error'; message: string } => {
      let resolved: string;
      try {
        resolved = path.resolve(dir);
      } catch {
        return { status: 'error', message: 'invalid path' };
      }
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(resolved, { withFileTypes: true });
      } catch (err) {
        return { status: 'error', message: err instanceof Error ? err.message : 'could not read the directory' };
      }
      const entries: Array<{ name: string; path: string; type: 'dir' | 'file' }> = [];
      for (const d of dirents) {
        try {
          if (d.isDirectory()) {
            entries.push({ name: d.name, path: path.join(resolved, d.name), type: 'dir' });
          } else if (wantFiles && d.isFile() && d.name.toLowerCase().endsWith('.gguf')) {
            entries.push({ name: d.name, path: path.join(resolved, d.name), type: 'file' });
          }
        } catch {
          // A raced deletion or a permission oddity — skip the entry, keep the listing.
        }
      }
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : a.type === 'dir' ? -1 : 1));
      const parent = path.dirname(resolved);
      return { status: 'ok' as const, path: resolved, parent: parent !== resolved ? parent : null, entries };
    };

    if (!raw) {
      if (process.platform === 'win32') {
        const drives: Array<{ name: string; path: string; type: 'dir' }> = [];
        for (let code = 65; code <= 90; code++) {
          const drive = `${String.fromCharCode(code)}:\\`;
          try {
            if (fs.existsSync(drive)) drives.push({ name: drive, path: drive, type: 'dir' });
          } catch {
            // Unreadable drive letter — skip it.
          }
        }
        return { status: 'ok' as const, path: '', parent: null, entries: drives };
      }
      return listDir(os.homedir());
    }
    const result = listDir(raw);
    if (result.status === 'ok') return result;
    // The requested dir may not exist yet (a fresh models dir before the first
    // download, a renamed path) — climb to the nearest existing ancestor so
    // the picker still opens somewhere sensible instead of dead-ending.
    let cur = path.resolve(raw);
    for (;;) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
      const attempt = listDir(cur);
      if (attempt.status === 'ok') return attempt;
    }
    return reply.status(400).send(result);
  });

  // ---- Runs (launch / stop / logs) ---------------------------------------

  // Adopt survivors of a previous gateway lifetime (fire-and-forget at route
  // registration = server boot).
  void restoreLocalRuns();

  // The placement plan needs the machine reading; the probe shells out to
  // vendor CLIs (seconds), so it is cached briefly — the plan is advisory,
  // and the console re-probes explicitly when it wants fresh numbers.
  let detectCache: { at: number; report: DetectReport } | null = null;
  const cachedDetect = async (): Promise<DetectReport> => {
    if (detectCache && Date.now() - detectCache.at < 60_000) return detectCache.report;
    const report = await detectDependencies();
    detectCache = { at: Date.now(), report };
    return report;
  };

  // The placement-plan panel (`localModels.runPlanTitle`): what a launch of this
  // model on this engine target would place where (and the ctx/ngl the runner
  // would resolve).
  app.get('/api/admin/local-models/plan', async (req, reply) => {
    const q = req.query as { modelId?: unknown; engine?: unknown; target?: unknown; ctx?: unknown; kvq8?: unknown; ngl?: unknown; headroom?: unknown };
    const modelId = String(q.modelId ?? '');
    const model = readInstalledModels()[modelId];
    if (!model) return reply.status(404).send({ status: 'error', message: 'unknown model' });
    // No engine named: the first launchable one that can serve this model,
    // else the registry's first launch target. Never a hardcoded engine id —
    // that would silently break the day llama.cpp is not installed.
    const engineId =
      String(q.engine ?? '') ||
      launchableEngines().find((candidate) => model.meta?.engines?.[candidate.id]?.serves)?.id ||
      launchableEngines()[0]?.id ||
      '';
    const engine = engineById(engineId);
    if (!engine) return reply.status(404).send({ status: 'error', message: 'unknown engine' });
    const installs = installedEnginesFor(engineId);
    const target = String(q.target ?? '') || installs.find((i) => i.target !== 'cpu')?.target || installs[0]?.target || '';
    const targetDef = engine.targets(process.platform, process.arch).find((t) => t.id === target);
    const kvq8 = String(q.kvq8 ?? '1') !== '0';
    // The resource switch ("leave room" vs "full performance"): one budget
    // input shared by the preview and the launch (preview ≠ launch is the bug
    // ADR-0037 names), inert for an engine-owned placement.
    const headroom = String(q.headroom ?? '1') !== '0';
    const meta = model.meta ?? null;
    const report = await cachedDetect();
    // The machine card's facts ride every plan response — the same cached
    // probe the planner's totals come from. Free memory is display-only.
    const machine = {
      gpus: report.gpus,
      vramMb: report.vramMb ?? null,
      vramFreeMb: report.vramFreeMb ?? null,
      ramBytes: os.totalmem(),
      ramFreeBytes: os.freemem(),
    };
    const input = {
      sizeBytes: model.size,
      meta: meta
        ? {
            ok: true as const,
            ...(meta.arch ? { arch: meta.arch } : {}),
            ...(meta.layers != null ? { layers: meta.layers } : {}),
            ...(meta.maxCtx != null ? { maxCtx: meta.maxCtx } : {}),
            ...(meta.experts != null ? { experts: meta.experts } : {}),
            ...(meta.expertsUsed != null ? { expertsUsed: meta.expertsUsed } : {}),
            ...(meta.heads != null ? { heads: meta.heads } : {}),
            ...(meta.kvHeads != null ? { kvHeads: meta.kvHeads } : {}),
            ...(meta.headDim != null ? { headDim: meta.headDim } : {}),
            ...(meta.embedding != null ? { embedding: meta.embedding } : {}),
          }
        : null,
      ...(report.vramMb != null ? { vramMb: report.vramMb } : {}),
      ramBytes: os.totalmem(),
      backend: targetDef?.backend ?? 'cpu',
      kvElemBytes: kvq8 ? KV_ELEM_Q8_0 : 2,
      headroom,
    };
    const requestedCtx = Number(q.ctx ?? 0);
    // ADR-0038 §5 / ADR-0039: an engine that owns its own placement (Strata's
    // `--expert-cache`) has no `-ngl` to preview. Answering with layer bars
    // would be a preview of a decision the engine makes internally — the exact
    // "preview ≠ launch" bug ADR-0037 forbids. Such a plan is DECLARED.
    if (engine.runtime?.placement === 'engine') {
      const spec = engine.runtime.profile;
      const profile = spec ? profileFor(model, engine.id) : undefined;
      // No profile is the NORMAL case (ADR-0039 §8): an engine that derives its
      // own launch inputs gates on `serves()`, not on a stored record. A model
      // the engine cannot serve says so — in the engine's words, naming the
      // missing artefact instead of demanding a directory.
      const verdict = engine.runtime.serves({ modelPath: model.filePath, meta: input.meta, profile });
      if (!verdict.serves) {
        return reply.status(400).send({
          status: 'error',
          code: 'engine-cannot-serve',
          message: verdict.reason ?? `${engine.name} cannot serve this model`,
        });
      }
      const ctx = engine.runtime.resolveCtx
        ? engine.runtime.resolveCtx({ requested: requestedCtx, profile, meta: input.meta })
        : (Number.isFinite(requestedCtx) && requestedCtx >= 256 ? Math.floor(requestedCtx) : (meta?.maxCtx ?? 32768));
      return {
        status: 'ok' as const,
        mode: 'declared' as const,
        plan: null,
        ngl: -1,
        ctx,
        autoCtx: null,
        target,
        backend: targetDef?.backend ?? 'cpu',
        ...machine,
        // The context ladder the console renders (backend-owned — the page
        // mirrors nothing). The engine's own ceiling still applies.
        ctxLadder: [...CTX_LADDER],
        // The engine's own summary of what the launch will pass — the console
        // renders argv + feature rows generically (ADR-0039).
        declaration: spec ? spec.describe(profile, ctx, kvq8, { modelPath: model.filePath, meta: input.meta, sizeBytes: model.size }) : { argv: [], features: [] },
      };
    }
    const ctx = Number.isFinite(requestedCtx) && requestedCtx >= 256 ? Math.floor(requestedCtx) : autoCtx(input);
    // ngl >= 0 pins the GPU layer count the operator typed on the console;
    // absent, the planner derives the split from the VRAM budget.
    const requestedNgl = Number(q.ngl ?? -1);
    const gpuLayersOverride = Number.isFinite(requestedNgl) && requestedNgl >= 0 ? Math.floor(requestedNgl) : undefined;
    const plan = planPlacement({ ...input, ctx, ...(gpuLayersOverride != null ? { gpuLayersOverride } : {}) });
    return {
      status: 'ok' as const,
      plan,
      ngl: nglForPlan(plan),
      autoCtx: autoCtx(input),
      target,
      backend: targetDef?.backend ?? 'cpu',
      ...machine,
      ctxLadder: [...CTX_LADDER],
    };
  });

  // Every run the gateway knows, live health applied. The console polls this.
  app.get('/api/admin/local-models/runs', async () => {
    return { status: 'ok' as const, runs: await listLocalRuns() };
  });

  // The monitor board (ADR-0040): every known run with its gateway-side counters
  // merged in, plus a machine summary. One request serves the page — the launcher's
  // `/runs` poll stays launch-shaped and is not widened into a board payload.
  //
  // Counters are PROCESS-LOCAL (ADR-0040 §4): a gateway restart zeroes them while an
  // adopted run keeps serving, so the payload carries each row's `since` and the page
  // states the window instead of presenting a short window as a lifetime total.
  app.get('/api/admin/local-models/monitor', async () => {
    const runs = await listLocalRuns();
    const stats = allStats();
    const rows = runs.map((run) => ({ run, stats: statsFor(run.id) }));
    // `live` counts what can actually answer right now; `inFlight` is the gauge
    // sum across every run, the number the whole board exists to show.
    const liveRows = runs.filter((run) => run.status === 'ready');
    const inFlight = rows.reduce((sum, row) => sum + row.stats.inFlight, 0);
    // `stats` keys for runs the registry already pruned are dropped here — a
    // stopped-and-pruned run's counters must not linger as phantom traffic.
    const known = new Set(runs.map((run) => run.id));
    for (const [id] of stats) if (!known.has(id)) stats.delete(id);
    return {
      status: 'ok' as const,
      runs: rows,
      summary: {
        totalRuns: runs.length,
        liveRuns: liveRows.length,
        inFlight,
        // The gateway's own port, so the board can say where clients point
        // (the same fact the ready-state snippet on /local-run renders).
        gatewayPort: loadConfig().port,
        now: Date.now(),
      },
    };
  });

  // Launch a model on an installed engine target. The body carries the run
  // options; ctx 0 / ngl -1 mean the planner resolves them (the same numbers
  // the /plan preview showed).
  app.post('/api/admin/local-models/runs', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const modelId = typeof body.modelId === 'string' ? body.modelId : '';
    const engine = typeof body.engine === 'string' && body.engine.trim() ? body.engine.trim() : (launchableEngines()[0]?.id ?? '');
    const target = typeof body.target === 'string' && body.target.trim() ? body.target.trim() : undefined;
    if (!modelId) return reply.status(400).send({ status: 'error', message: 'modelId is required' });
    const num = (key: string, fallback: number, min: number, max: number): number => {
      const v = Number(body[key]);
      return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback;
    };
    const bool = (key: string, fallback: boolean): boolean =>
      typeof body[key] === 'boolean' ? (body[key] as boolean) : fallback;
    const extraArgs = Array.isArray(body.extraArgs)
      ? (body.extraArgs as unknown[]).filter((a): a is string => typeof a === 'string' && a.trim().length > 0).slice(0, 32)
      : [];
    const options: Partial<LocalRunOptions> = {
      ctx: num('ctx', DEFAULT_RUN_OPTIONS.ctx, 0, 2_000_000),
      ngl: num('ngl', DEFAULT_RUN_OPTIONS.ngl, -1, 10_000),
      flashAttn: bool('flashAttn', DEFAULT_RUN_OPTIONS.flashAttn),
      kvCacheQ8: bool('kvCacheQ8', DEFAULT_RUN_OPTIONS.kvCacheQ8),
      reasoning: bool('reasoning', DEFAULT_RUN_OPTIONS.reasoning),
      autoRestart: bool('autoRestart', DEFAULT_RUN_OPTIONS.autoRestart),
      headroom: bool('headroom', DEFAULT_RUN_OPTIONS.headroom),
      threads: num('threads', DEFAULT_RUN_OPTIONS.threads, 0, 512),
      extraArgs,
    };
    const result = await startLocalRun({ modelId, engine, ...(target ? { target } : {}), options });
    if (!result.ok) {
      return reply.status(400).send({ status: 'error', code: result.code, message: result.error });
    }
    return { status: 'ok' as const, run: result.run };
  });

  app.post('/api/admin/local-models/runs/:id/stop', async (req, reply) => {
    const id = String((req.params as { id?: string }).id ?? '');
    const result = stopLocalRun(id);
    if (!result.ok) return reply.status(400).send({ status: 'error', message: result.error ?? 'stop failed' });
    return { status: 'ok' };
  });

  app.get('/api/admin/local-models/runs/:id', async (req, reply) => {
    const id = String((req.params as { id?: string }).id ?? '');
    const run = await getLocalRun(id);
    if (!run) return reply.status(404).send({ status: 'error', message: 'unknown run' });
    return { status: 'ok' as const, run };
  });

  // The run-log drawer (`localModels.runLogs`): the newest N lines of the run's
  // in-memory ring (engine stdout/stderr plus the gateway's own lifecycle
  // markers).
  app.get('/api/admin/local-models/runs/:id/logs', async (req) => {
    const id = String((req.params as { id?: string }).id ?? '');
    const limit = Number((req.query as { limit?: unknown }).limit ?? 300);
    return { status: 'ok' as const, lines: runLogs(id, Number.isFinite(limit) ? Math.min(Math.max(1, limit), 1000) : 300) };
  });

  // Engine build jobs (ADR-0039 §9): the engine builds the launch input it
  // derives — Strata's pack, by the workspace's own tooling — so the operator
  // never runs the packer by hand. A build is not a run: no port, no health
  // probe; the console polls the job list and the per-job log ring.
  app.post('/api/admin/local-models/builds', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const modelId = typeof body.modelId === 'string' ? body.modelId : '';
    const engine = typeof body.engine === 'string' ? body.engine.trim() : '';
    if (!modelId || !engine) {
      return reply.status(400).send({ status: 'error', message: 'modelId and engine are required' });
    }
    const result = await startBuildJob({ modelId, engine });
    if (!result.ok) {
      return reply.status(400).send({ status: 'error', code: result.code, message: result.error });
    }
    return { status: 'ok' as const, job: result.job };
  });

  app.get('/api/admin/local-models/builds', async () => {
    return { status: 'ok' as const, jobs: listBuildJobs() };
  });

  // The build-log drawer: the newest N lines of the job's in-memory ring.
  app.get('/api/admin/local-models/builds/:id/logs', async (req) => {
    const id = String((req.params as { id?: unknown }).id ?? '');
    const limit = Number((req.query as { limit?: unknown }).limit ?? 300);
    return { status: 'ok' as const, lines: buildLogs(id, Number.isFinite(limit) ? Math.min(Math.max(1, limit), 1000) : 300) };
  });

  // Drop ended run records from the registry (history hygiene; never touches
  // a live run). Counters are dropped with their record — a pruned run's
  // traffic must not linger on the monitor board (ADR-0040 §4).
  app.delete('/api/admin/local-models/runs', async () => {
    const pruned = pruneLocalRuns();
    if (pruned > 0) {
      const known = new Set((await listLocalRuns()).map((run) => run.id));
      for (const id of statsRunIds()) if (!known.has(id)) dropStats(id);
    }
    return { status: 'ok' as const, pruned };
  });

  // Drop ONE ended run record. A live run is refused by `deleteLocalRun`, and
  // its counters go with the record — a deleted run's traffic must not linger
  // as phantom history (same rule as the bulk prune above, ADR-0040 §4).
  app.delete('/api/admin/local-models/runs/:id', async (req, reply) => {
    const id = String((req.params as { id?: unknown }).id ?? '');
    const result = deleteLocalRun(id);
    if (!result.ok) {
      const code = result.code === 'not-found' ? 404 : result.code === 'run-live' ? 409 : 500;
      return reply.code(code).send({ status: 'error' as const, code: result.code, error: result.error });
    }
    dropStats(id);
    return { status: 'ok' as const };
  });
}

import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import {
  DEFAULT_ENV_NAME,
  clearPointer,
  createEnv,
  envExists,
  getEnvMeta,
  getEnvPaths,
  listEnvs,
  peekEnvName,
  readPointer,
  recreateEnv,
  renameEnv,
  resetSandboxEnv,
  resolveEnvName,
  setEnvDescription,
  trashEnv,
  writePointer,
} from '../config/env.js';
import {
  ARCHIVE_SUFFIX,
  EnvArchiveError,
  IMPORT_BODY_LIMIT_BYTES,
  buildEncryptedZipArchive,
  buildZipArchive,
  parseZipArchiveAsync,
  safeResolveWithin,
} from '../config/env-archive.js';
import { loadConfig } from '../config/index.js';
import type { EnvType } from '../config/env.js';

/**
 * Environment administration API (Phase 2 of the book-sets design,
 * environments decision record). All routes live under /api/admin/environments* so the
 * console webAuth gate in server.ts covers them with zero extra wiring.
 *
 * The switch route is the only one with process-restart side effects; its
 * spawn/exit are injectable (`EnvironmentRouteDeps`) so tests can exercise
 * the pointer-write → spawn → rollback contract without restarting the
 * test runner itself. Defaults mirror the existing UI-restart machinery
 * (console.ts handleRestart / daemon.ts) byte-for-byte in behavior.
 */

export interface EnvironmentRouteDeps {
  /** Spawn the replacement gateway bound to the new env. True = spawned. */
  spawnChild?: (opts: { envName: string }) => boolean | Promise<boolean>;
  /** Self-exit scheduler after a successful spawn (handover to the child). */
  scheduleExit?: () => void;
}

/**
 * Map a thrown [OCR env] Error to {httpCode, message}.
 * (err is `unknown` at the boundary: env.ts throws plain Errors,
 * EnvArchiveError carries its own HTTP-ish code.)
 */
function mapEnvError(err: unknown): { code: number; error: string } {
  const msg = String((err as Error)?.message ?? err).replace(/^\[OCR env\]\s*/, '');
  let code = 400;
  if (err instanceof EnvArchiveError) code = err.code;
  else if (/already exists/i.test(msg)) code = 409;
  else if (/does not exist/i.test(msg)) code = 404;
  return { code, error: msg };
}

// `reply: any` — keeps the helper generic over FastifyReply's per-route
// RequestGeneric typing; the repo uses the same escape in console.ts.
const fail = (reply: any, code: number, error: string, extra: Record<string, unknown> = {}) =>
  reply.status(code).send({ status: 'error', error, ...extra });

/** Recursive dir size, best-effort: missing/unreadable entries count 0. */
function dirSizeBestEffort(dir: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) total += dirSizeBestEffort(p);
        else if (e.isFile()) total += fs.statSync(p).size;
      } catch {
        // permission/race — tolerate, count as 0
      }
    }
  } catch {
    // missing dir = 0 (fresh env without state yet)
  }
  return total;
}

/** Env footprint: config + secret file + all state dirs. Per request, never cached across. */
function envSizeBytes(name: string): number {
  const p = getEnvPaths(name);
  let total = 0;
  for (const f of [p.configPath, p.webauthSecretPath]) {
    try {
      total += fs.statSync(f).size;
    } catch {
      // absent = contributes nothing
    }
  }
  for (const d of [p.dataDir, p.modelsDir, p.catalogDir, p.tracesDir, p.captureDir]) {
    total += dirSizeBestEffort(d);
  }
  return total;
}

function readConfigPort(configPath: string): number | undefined {
  try {
    if (!fs.existsSync(configPath)) return undefined;
    const parsed = parse(fs.readFileSync(configPath, 'utf8')) as { port?: unknown };
    const n = Number(parsed?.port);
    // Clamp to the valid TCP range: a hand-typed 99999 must not be reported
    // as the frontend's redirect target (L3 P3-1).
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
  } catch {
    return undefined;
  }
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

export function registerEnvironmentRoutes(app: FastifyInstance, deps: EnvironmentRouteDeps = {}): void {
  const runningName = () => resolveEnvName();

  // Zip archive upload (import). Registered before any route: a bodyLimit
  // matching IMPORT_BODY_LIMIT_BYTES keeps the compressed-body cap identical
  // to the JSON path; the parser just hands the raw buffer to the handler.
  app.addContentTypeParser(
    ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: IMPORT_BODY_LIMIT_BYTES },
    (_req, body, done) => {
      done(null, body);
    }
  );

  // L3 P2-2: one switch in flight per gateway process. Two parallel POSTs
  // would each spawn a replacement child and race the pointer. Held on the
  // success path (this process is scheduled to exit anyway), released on
  // every failure path so a retried switch works. Scoped to the plugin
  // registration: production has exactly one per process, and a fresh
  // registration in tests naturally gets a fresh guard.
  let switchInFlight = false;

  // ─── Listing & current env ──────────────────────────────────────────────

  app.get('/api/admin/environments', async () => {
    const running = runningName();
    const current = peekEnvName();
    return {
      status: 'ok',
      // Both views are meaningful: `current` = what the NEXT boot resolves
      // (OCR_ENV/pointer, lenient), `running` = what THIS process booted
      // with. They diverge only transiently (CLI pointer edit against a
      // live gateway, or a rolled-back failed switch).
      current,
      running,
      environments: listEnvs().map((e) => ({
        ...e,
        current: e.name === current,
        running: e.name === running,
        sizeBytes: envSizeBytes(e.name),
      })),
    };
  });

  app.get('/api/admin/environments/current', async () => {
    const name = runningName();
    const paths = getEnvPaths();
    return {
      status: 'ok',
      name,
      configPath: paths.configPath,
      root: path.dirname(paths.dataDir),
      pointer: readPointer(),
      // env.json metadata, or a synthetic marker for a not-yet-booted env.
      meta: getEnvMeta(name) ?? { name, type: 'regular', synthetic: true },
    };
  });

  // ─── Create ─────────────────────────────────────────────────────────────

  app.post('/api/admin/environments', async (req, reply) => {
    const body = req.body as {
      name?: string;
      type?: EnvType;
      template?: 'blank' | 'copy-current' | 'copy-default';
      description?: string;
    };
    if (!body || typeof body.name !== 'string') {
      return fail(reply, 400, 'Body must include { name }');
    }
    const template = body.template ?? 'blank';
    if (!['blank', 'copy-current', 'copy-default'].includes(template)) {
      return fail(reply, 400, `Unknown template "${template}" (blank | copy-current | copy-default)`);
    }
    if (body.type !== undefined && body.type !== 'regular' && body.type !== 'sandbox') {
      return fail(reply, 400, `Unknown type "${body.type}"`);
    }

    let info;
    try {
      info = await createEnv({ name: body.name, type: body.type, description: body.description });
    } catch (err) {
      const m = mapEnvError(err);
      return fail(reply, m.code, m.error);
    }

    // Copy templates seed ONLY config.yaml — data always starts empty (book-set
    // intuition: a new copy of the book starts un-annotated).
    if (template !== 'blank') {
      const sourcePath =
        template === 'copy-default' ? getEnvPaths(DEFAULT_ENV_NAME).configPath : getEnvPaths().configPath;
      try {
        if (fs.existsSync(sourcePath)) {
          fs.writeFileSync(info.configPath, fs.readFileSync(sourcePath, 'utf8'), 'utf8');
        }
      } catch (err: any) {
        return fail(reply, 500, `Env created but config copy failed: ${err?.message}`);
      }
    }
    return reply.status(201).send({ status: 'ok', env: info });
  });

  // ─── Import (before the :name routes — static segment wins anyway) ─────

  app.post<{ Querystring: { name?: string; mode?: string } }>(
    '/api/admin/environments/import',
    { bodyLimit: IMPORT_BODY_LIMIT_BYTES },
    async (req, reply) => {
      // Archive-only: the JSON envelope never shipped. The body
      // is a standard zip — plain or AES-encrypted (AE-2); whether a password
      // is needed is decided HERE (server-driven prompt), not sniffed by the
      // client. Content-Type is never trusted.
      const body = req.body as unknown;
      if (!Buffer.isBuffer(body)) {
        return fail(reply, 400, 'Import body must be a zip environment archive (.orc_env.zip)');
      }
      // ?mode=create (default) | replace. Replace is the recoverable
      // overwrite: the OLD book-set moves to envs/.trash FIRST (the same
      // mechanism as delete), then the archive writes fresh content. The
      // bootstrap `default` IS replaceable — its end state keeps the env in
      // existence (trash → scaffold → archive), which is what the
      // new-machine restore flow needs; only a RUNNING env stays refused
      // (Windows file locks — trash of a directory with open handles fails).
      const mode = req.query.mode === 'replace' ? 'replace' : 'create';
      const pw = req.headers['x-ocr-archive-password'];
      const v = await parseZipArchiveAsync(
        new Uint8Array(body),
        req.query.name,
        typeof pw === 'string' && pw.length > 0 ? pw : undefined,
        // Reserved names are import targets only in replace mode (restore
        // over the bootstrap `default`); create-mode must pick a fresh name.
        { allowReservedName: mode === 'replace' }
      );
      if (!v.ok) return fail(reply, v.code, v.error);

      if (mode === 'replace') {
        if (!envExists(v.name)) {
          return fail(reply, 404, `Environment "${v.name}" does not exist — replace imports INTO an existing environment`);
        }
        if (v.name === runningName()) {
          return fail(
            reply,
            409,
            `The currently RUNNING environment "${v.name}" cannot be replaced — switch to another environment first (create a temporary one if none exists), then switch back`
          );
        }
        try {
          trashEnv(v.name, { allowBootstrap: true });
        } catch (err) {
          const m = mapEnvError(err);
          return fail(reply, m.code, m.error);
        }
      } else if (envExists(v.name)) {
        // Import ALWAYS creates a NEW env — never overwrites an existing one.
        return fail(reply, 409, `Environment "${v.name}" already exists — import creates a new environment, it never overwrites`, {
          suggestion: `${v.name}-imported`,
        });
      }

      // Re-verify every payload key resolves INSIDE the (not-yet-created)
      // env root BEFORE any mutation; the write loop re-checks anyway
      // (defense in depth, mirror of the static-asset guard).
      const root = path.dirname(getEnvPaths(v.name).dataDir);
      const writes: Array<{ target: string; text: string }> = [];
      for (const [key, text] of Object.entries(v.payload)) {
        const target = safeResolveWithin(root, key);
        if (!target) {
          return fail(reply, 400, `Payload key "${key}" is not a safe environment-relative path`);
        }
        writes.push({ target, text });
      }

      let info;
      try {
        // Provenance is structured data, not generated prose: the console
        // renders it localized from the viewer's locale (a baked-in English
        // sentence would freeze wrong for non-English users).
        const importedFrom = { name: v.source?.name ?? v.name, appVersion: v.source?.appVersion ?? 'unknown' };
        if (mode === 'replace') {
          // createEnv refuses reserved names — the restore path scaffolds
          // instead (bootstrap `default` included), writing NO blank config:
          // the archive's own config.yaml lands right below.
          info = await recreateEnv({
            name: v.name,
            type: v.type,
            importedFrom,
          });
        } else {
          info = await createEnv({
            name: v.name,
            type: v.type,
            importedFrom,
          });
        }
      } catch (err) {
        // Case-insensitive collision surfacing only at create time.
        const m = mapEnvError(err);
        return fail(reply, m.code, m.error, { suggestion: `${v.name}-imported` });
      }

      try {
        // Archive text replaces the blank template createEnv wrote.
        fs.writeFileSync(info.configPath, v.config, 'utf8');
        for (const w of writes) {
          const check = safeResolveWithin(root, path.relative(root, w.target));
          if (!check) return fail(reply, 400, `Payload key escaped the environment directory`);
          fs.mkdirSync(path.dirname(w.target), { recursive: true });
          fs.writeFileSync(w.target, w.text, 'utf8');
        }
      } catch (err: any) {
        // Partial write: best-effort trash the half-written env so a broken
        // book-set never lingers in the picker (L3 P3-3). Move-to-.trash —
        // still recoverable, never a physical delete.
        let cleaned = false;
        try {
          trashEnv(v.name);
          cleaned = true;
        } catch (trashErr: any) {
          console.error(`[OCR env] Import cleanup failed for "${v.name}": ${trashErr?.message}`);
        }
        return fail(
          reply,
          500,
          `Environment created but archive write failed: ${err?.message}${cleaned ? ` — half-written env "${v.name}" was moved to trash` : ` — MANUAL CLEANUP of "${v.name}" required`}`
        );
      }
      return reply.status(201).send({ status: 'ok', env: info });
  });

  // ─── Rename / description ───────────────────────────────────────────────

  app.patch<{ Params: { name: string } }>('/api/admin/environments/:name', async (req, reply) => {
    const name = req.params.name;
    const body = req.body as { name?: string; description?: string | null };
    if (name.toLowerCase() === DEFAULT_ENV_NAME) {
      return fail(reply, 400, 'The bootstrap "default" environment cannot be renamed or described');
    }
    if (!envExists(name)) return fail(reply, 404, `Environment "${name}" does not exist`);
    if (name === runningName()) {
      return fail(reply, 409, 'Renaming/editing the currently RUNNING environment is not allowed (open file locks on Windows) — switch to another env first');
    }

    let current = name;
    if (typeof body?.name === 'string' && body.name !== name) {
      try {
        renameEnv(name, body.name);
      } catch (err) {
        const m = mapEnvError(err);
        return fail(reply, m.code, m.error);
      }
      current = body.name;
    }
    if (body && 'description' in body) {
      try {
        setEnvDescription(current, typeof body.description === 'string' && body.description ? body.description : undefined);
      } catch (err) {
        const m = mapEnvError(err);
        return fail(reply, m.code, m.error);
      }
    }
    return { status: 'ok', env: { name: current, meta: getEnvMeta(current), configPath: getEnvPaths(current).configPath } };
  });

  // ─── Delete (trash, never delete) ───────────────────────────────────────

  app.delete<{ Params: { name: string } }>('/api/admin/environments/:name', async (req, reply) => {
    const name = req.params.name;
    const body = req.body as { confirm?: unknown } | undefined;
    if (body?.confirm !== true) {
      return fail(reply, 400, 'Deleting an environment requires { "confirm": true } (it is MOVED to envs/.trash, never physically deleted)');
    }
    if (name.toLowerCase() === DEFAULT_ENV_NAME) {
      return fail(reply, 400, 'The bootstrap "default" environment cannot be trashed');
    }
    if (!envExists(name)) return fail(reply, 404, `Environment "${name}" does not exist`);
    if (name === runningName()) {
      return fail(reply, 409, 'The currently RUNNING environment cannot be trashed — switch to another env first');
    }
    try {
      const trashPath = trashEnv(name);
      return { status: 'trashed', name, trashPath };
    } catch (err) {
      const m = mapEnvError(err);
      return fail(reply, m.code, m.error);
    }
  });

  // ─── Sandbox reset ──────────────────────────────────────────────────────

  app.post<{ Params: { name: string } }>('/api/admin/environments/:name/reset', async (req, reply) => {
    const name = req.params.name;
    if (name.toLowerCase() === DEFAULT_ENV_NAME) {
      return fail(reply, 400, 'The bootstrap "default" environment cannot be reset');
    }
    if (!envExists(name)) return fail(reply, 404, `Environment "${name}" does not exist`);
    if (name === runningName()) {
      return fail(reply, 409, 'The currently RUNNING environment cannot be reset — switch to another env first');
    }
    try {
      resetSandboxEnv(name);
      return { status: 'reset', name };
    } catch (err) {
      const m = mapEnvError(err);
      return fail(reply, m.code, m.error);
    }
  });

  // ─── Export (read-only envelope download) ───────────────────────────────

  app.get<{ Params: { name: string }; Querystring: { secrets?: string; include?: string; encrypt?: string } }>(
    '/api/admin/environments/:name/export',
    async (req, reply) => {
      const name = req.params.name;
      // `default` resolves even before its first boot (bootstrap tier), so only
      // a NAMED env can 404 here.
      if (name !== DEFAULT_ENV_NAME && !envExists(name)) {
        return fail(reply, 404, `Environment "${name}" does not exist`);
      }
      const query = req.query;
      // ?encrypt=1 — password-encrypted full backup: secrets are ALWAYS
      // plaintext inside the encrypted layer (that is the point), so it
      // implies secrets=include. The password travels ONLY in the
      // x-ocr-archive-password header, never the query (access logs).
      const encrypt = query.encrypt === '1';
      const includeSecrets = encrypt || query.secrets === 'include';
      // ?include= — comma-separated payload-key subset (unknown keys ignored,
      // the set is closed); absent = every payload file that exists.
      const includePayload =
        typeof query.include === 'string' && query.include.trim().length > 0
          ? query.include
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : undefined;
      const password = req.headers['x-ocr-archive-password'];
      if (encrypt && (typeof password !== 'string' || password.length === 0)) {
        return fail(reply, 400, 'Encrypted export requires the x-ocr-archive-password header');
      }
      try {
        if (encrypt) {
          // A STANDARD zip with AE-2 AES-256-encrypted entries — 360 Zip /
          // 7-Zip / WinRAR open it with the password alone. Same .orc_env.zip
          // name as the plaintext archive; secrets=include is implied.
          const encrypted = await buildEncryptedZipArchive(name, {
            includeSecrets,
            includePayload,
            password: password as string,
          });
          const filename = `${name}-${todayStamp()}${ARCHIVE_SUFFIX}`;
          return reply
            .header('Content-Disposition', `attachment; filename="${filename}"`)
            .type('application/zip')
            .send(Buffer.from(encrypted));
        }
        const archive = buildZipArchive(name, { includeSecrets, includePayload });
        const filename = `${name}-${todayStamp()}${ARCHIVE_SUFFIX}`;
        return reply
          .header('Content-Disposition', `attachment; filename="${filename}"`)
          .type('application/zip')
          .send(Buffer.from(archive));
      } catch (err) {
        const m = mapEnvError(err);
        return fail(reply, m.code, m.error);
      }
    }
  );

  // ─── Switch (pointer write + controlled restart handover) ───────────────

  app.post<{ Params: { name: string } }>('/api/admin/environments/:name/switch', async (req, reply) => {
    const target = req.params.name;

    // Guard the 404 BEFORE touching the pointer (spec): unknown name = typo,
    // nothing has been changed and the gateway keeps running on its env.
    if (target !== DEFAULT_ENV_NAME && !envExists(target)) {
      return fail(reply, 404, `Environment "${target}" does not exist`);
    }

    // Switching to an already-running env: no restart, no pointer churn.
    // (The pointer may lag while the CLI edited it against a live gateway,
    // so still pin it — a no-op write keeps next-boot == now-running.)
    if (target === runningName()) {
      try {
        writePointer(target);
      } catch (err: any) {
        return fail(reply, 500, `Already running "${target}" but the pointer write failed: ${err?.message}`);
      }
      return { status: 'ok', env: target, message: `Gateway is already running environment "${target}" — pointer pinned, no restart` };
    }

    // P2-2: one switch in flight — a second concurrent POST would spawn a
    // second replacement child and race the pointer. Acquired here (after
    // the cheap 404/running guards) and released on every failure path; the
    // success path intentionally holds it (this process is scheduled to die).
    if (switchInFlight) {
      return fail(reply, 409, 'switch already in progress — one restart handover at a time');
    }
    switchInFlight = true;

    // Chosen semantics for "switch to default": an EXPLICIT pointer write of
    // "default" (not removal). peek/resolve treat pointer "default" and an
    // absent pointer identically, and an explicit pin keeps the audit trail
    // of what the operator last selected.
    const previous = readPointer();
    try {
      writePointer(target);
    } catch (err: any) {
      switchInFlight = false;
      return fail(reply, 500, `Pointer write failed: ${err?.message}`);
    }

    const spawnChild =
      deps.spawnChild ??
      (async ({ envName }: { envName: string }) => {
        const { spawnDetachedEnvSwitchChild } = await import('../cli/daemon.js');
        return spawnDetachedEnvSwitchChild({ envName });
      });
    const scheduleExit =
      deps.scheduleExit ??
      (() => {
        setTimeout(() => process.exit(0), 500);
      });

    let spawned = false;
    try {
      spawned = await Promise.resolve(spawnChild({ envName: target }));
    } catch (err: any) {
      spawned = false;
      console.error(`[OCR env] Switch spawn threw: ${err?.message}`);
    }

    if (!spawned) {
      // Failure path: keep serving, roll the pointer back so a crash of THIS
      // process later cannot boot the wrong book-set. previous===target is a
      // legal no-op re-pin (pointer already selected the switch target).
      try {
        if (previous !== null) writePointer(previous);
        else clearPointer();
      } catch (err: any) {
        console.error(`[OCR env] POINTER ROLLBACK FAILED after ${target} spawn failure: ${err?.message} — manual fix required`);
      }
      // Release the guard so the operator can immediately retry the switch.
      switchInFlight = false;
      return {
        status: 'failed',
        env: target,
        error: `Could not spawn the replacement gateway — pointer restored to ${previous ? `"${previous}"` : 'no pointer'}, this gateway keeps running.`,
      };
    }

    scheduleExit();

    // PORT/HOST are deliberately neither pinned NOR inherited for the switch
    // child (spawnDetachedEnvSwitchChild omits them — the target env's own
    // config.yaml decides where it listens; an inherited HOST=0.0.0.0 would
    // crash the child's validateWebAuthStartup after our exit). When that
    // port differs from ours, tell the caller — the frontend follows the new
    // origin (Phase 3).
    const targetPort = readConfigPort(getEnvPaths(target).configPath);
    const addr = app.server.address();
    const currentPort = typeof addr === 'object' && addr ? addr.port : loadConfig().port;
    return {
      status: 'restarting',
      env: target,
      ...(targetPort && targetPort !== currentPort ? { newPort: targetPort } : {}),
      message: `Switching to environment "${target}" — replacement process is booting with OCR_ENV pinned`,
    };
  });
}

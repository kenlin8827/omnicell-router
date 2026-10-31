import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * Kimi Code's local web API install (ADR-0015 §D9 amendment, 2026-11-01 — verified against the
 * vendor source, MoonshotAI/kimi-code @ main, and the shipped v2.4.1 binary).
 *
 * `kimi web` runs the vendor's kap-server on loopback with bearer auth (`~/.kimi-code/server.token`,
 * rotated by `kimi web rotate-token`). Its REST surface is the SAME PluginManager the TUI
 * `/plugins install` drives:
 *
 *     GET  /api/v1/healthz            unauthenticated readiness (the only bypassed path)
 *     POST /api/v1/plugins            {source} → vendor download/manifest/managed-copy/install
 *     POST /api/v1/shutdown           graceful stop
 *
 * So a headless install never writes vendor state itself: it boots a TRANSIENT server, posts the
 * source, and tears the server down. The `/plugins` slash command stays session-only — this API
 * is the vendor-published non-interactive form of it (the web UI calls these same routes).
 */

export interface KimiWebPluginSummary {
  id: string;
  displayName?: string;
  version?: string;
}

export type KimiWebInstallOutcome =
  | { ok: true; plugin: KimiWebPluginSummary }
  | { ok: false; message: string };

/** The process handle the flow needs — a real ChildProcess or the test fake. */
export interface KimiWebChild {
  kill(): void;
  /** The direct child's pid — Windows tree-kill needs it (the shell wrapper spawns a grandchild). */
  pid?: number;
  /** Resolves with the exit code once the child exits; never resolves while it runs. */
  exited: Promise<number | null>;
}

export interface KimiWebDeps {
  /** Test seam: returns a handle for the spawned `kimi web` child. */
  spawnImpl?: (argv: string[], env: NodeJS.ProcessEnv) => KimiWebChild;
  /** Test seam: scripted HTTP. */
  fetchImpl?: typeof fetch;
  /** Kimi home (the vendor's KIMI_CODE_HOME). Default: env KIMI_CODE_HOME ?? ~/.kimi-code. */
  homeDir?: string;
  /** Budget for the server to answer healthz. */
  bootTimeoutMs?: number;
  /** Budget for the install POST — a git download can be slow. */
  installTimeoutMs?: number;
  /** Grace window waiting for the spawned server to exit after shutdown (tests shrink it). */
  teardownGraceMs?: number;
  /** Test seam: the staging clone. Default spawns `git clone --depth 1`. */
  gitImpl?: (repo: string, root: string) => Promise<{ code: number; stderr: string }>;
  /** Budget for the staging clone. */
  cloneTimeoutMs?: number;
}

/** `owner/repo` — the only repository shape a marketplace install may carry. */
export const MARKET_REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** The staging clone the marketplace flow hands to the vendor as a local absolute path. */
function defaultGitClone(repo: string, root: string, timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', ['clone', '--depth', '1', `https://github.com/${repo}.git`, root], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: `${stderr}${error.message}` });
    });
  });
}

/**
 * Marketplace-row install (verified against the shipped v2.4.1 binary). The vendor's GitHub
 * resolver CANNOT install a marketplace-form repository: it rebuilds `<repo>@<plugin>@<market>`
 * as a git ref (`postmanlabs/postman-plugin@@postman` when the source carries no plugin) and
 * 404s. Its LOCAL-PATH branch works — verified `{"source":"<abs clone>"}` installs cleanly —
 * so this flow stages a shallow clone in a temp dir, posts the absolute staging path (the
 * vendor's own PluginManager does manifest/managed-copy/install from it), and removes the
 * staging dir afterwards, success or not.
 */
export async function installMarketplaceRepoViaKimiWeb(repo: string, deps: KimiWebDeps = {}): Promise<KimiWebInstallOutcome> {
  if (!MARKET_REPO_RE.test(repo)) return { ok: false, message: `invalid repository '${repo}'` };
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-kimi-'));
  const root = path.join(staging, 'repo');
  try {
    const clone = await (deps.gitImpl
      ? deps.gitImpl(repo, root)
      : defaultGitClone(repo, root, deps.cloneTimeoutMs ?? 120_000));
    if (clone.code !== 0) {
      const detail = clone.stderr.trim().split('\n').pop() ?? '';
      return { ok: false, message: `staging clone of '${repo}' failed: ${detail.slice(0, 200) || `git exited ${clone.code}`}` };
    }
    return await installViaKimiWeb(root, deps);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const DEFAULT_BOOT_TIMEOUT_MS = 30_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 150_000;
const POLL_MS = 250;

/** An ephemeral loopback port for the transient server (released before the spawn). */
function freePort(): Promise<number> {
  // ES2022 lib (backend tsconfig): Promise.withResolvers is unavailable — executor form.
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function delay(ms: number): Promise<void> {
  // ES2022 lib: Promise.withResolvers is unavailable — executor form.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawn(argv: string[], env: NodeJS.ProcessEnv): KimiWebChild {
  // Windows: `kimi` is an npm-style .cmd shim libuv cannot exec directly — the same shell rule
  // as the plugin writer's defaultExec. argv carries no metacharacters (a port number), so no
  // pre-quoting is needed.
  const isWin = process.platform === 'win32';
  const child: ChildProcess = spawn(argv[0]!, argv.slice(1), {
    shell: isWin,
    windowsHide: true,
    stdio: 'ignore',
    env,
  });
  // ES2022 lib: Promise.withResolvers is unavailable — executor form.
  const exited = new Promise<number | null>((resolve) => {
    child.once('close', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
  return { kill: () => child.kill(), pid: child.pid ?? undefined, exited };
}

/** Poll `probe` until it returns a truthy value or the budget runs out. */
async function poll<T>(
  probe: () => T | null | undefined | Promise<T | null | undefined>,
  budgetMs: number,
): Promise<T | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() + POLL_MS > deadline) return null;
    await delay(POLL_MS);
  }
}

interface Envelope {
  code?: number;
  msg?: string;
  data?: unknown;
}

export async function installViaKimiWeb(source: string, deps: KimiWebDeps = {}): Promise<KimiWebInstallOutcome> {
  const home = deps.homeDir ?? process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), '.kimi-code');
  const tokenFile = path.join(home, 'server.token');
  const fetchImpl = (deps.fetchImpl ?? fetch) as typeof fetch;
  const bootTimeoutMs = deps.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
  const installTimeoutMs = deps.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;

  let port: number;
  try {
    port = await freePort();
  } catch (error) {
    return { ok: false, message: `no free loopback port for the transient kimi web server: ${(error as Error).message}` };
  }

  const spawnImpl = deps.spawnImpl ?? defaultSpawn;
  const child = spawnImpl(['kimi', 'web', '--no-open', '--port', String(port)], {
    ...process.env,
    KIMI_CODE_HOME: home,
  });
  const base = `http://127.0.0.1:${port}`;

  try {
    const up = await poll(async () => {
      try {
        // Per-attempt timeout: the deadline is only re-checked after a probe resolves, so a
        // fetch that connects but never answers (hung server) must not stall the boot timeout.
        const res = await fetchImpl(`${base}/api/v1/healthz`, { signal: AbortSignal.timeout(POLL_MS * 2) });
        return res.ok;
      } catch {
        return null;
      }
    }, bootTimeoutMs);
    if (!up) return { ok: false, message: `kimi web did not answer ${base}/api/v1/healthz within ${bootTimeoutMs}ms` };

    const token = await poll(() => {
      try {
        const text = fs.readFileSync(tokenFile, 'utf8').trim();
        return text.length > 0 ? text : null;
      } catch {
        return null;
      }
    }, 10_000);
    if (!token) return { ok: false, message: `${tokenFile} never appeared after kimi web started` };

    let envelope: Envelope;
    try {
      const res = await fetchImpl(`${base}/api/v1/plugins`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ source }),
        signal: AbortSignal.timeout(installTimeoutMs),
      });
      const text = await res.text();
      try {
        envelope = JSON.parse(text) as Envelope;
      } catch {
        return { ok: false, message: `kimi web answered HTTP ${res.status} with a non-JSON body: ${text.slice(0, 200)}` };
      }
    } catch (error) {
      return { ok: false, message: `kimi web install request failed: ${(error as Error).message}` };
    }
    if (envelope.code !== 0) {
      return { ok: false, message: `kimi web refused the install (${envelope.code}): ${envelope.msg ?? 'no detail'}` };
    }
    const data = envelope.data as Partial<KimiWebPluginSummary> | null | undefined;
    if (!data || typeof data.id !== 'string' || data.id.length === 0) {
      return { ok: false, message: 'kimi web reported success but returned no plugin id' };
    }
    return {
      ok: true,
      plugin: {
        id: data.id,
        ...(typeof data.displayName === 'string' ? { displayName: data.displayName } : {}),
        ...(typeof data.version === 'string' ? { version: data.version } : {}),
      },
    };
  } finally {
    // Polite stop first (the vendor exits cleanly on SIGTERM too), then the hard fallback. The
    // install is already persisted by the vendor at this point — teardown is best-effort.
    try {
      let token = '';
      try {
        token = fs.readFileSync(tokenFile, 'utf8').trim();
      } catch {
        // no token file — shutdown would be 401; the kill below is the guarantee.
      }
      if (token) {
        await fetchImpl(`${base}/api/v1/shutdown`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(2_000),
        }).catch(() => undefined);
      }
    } catch {
      // shutdown is a courtesy; the kill below is the guarantee.
    }
    const graceful = await Promise.race([
      child.exited,
      delay(deps.teardownGraceMs ?? 5_000).then(() => null),
    ]);
    if (graceful === null) {
      child.kill();
      // Windows: with the shell wrapper, kill() only reaps cmd.exe — the node grandchild (the
      // actual server) survives. taskkill /T takes the whole tree.
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref();
      }
    }
  }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runCommand } from '../../utils/run-command.js';
import { getOcrHomeDir } from '../paths.js';

/**
 * Everything a JetBrains IDE install needs BESIDES the proxy hook, so that one
 * `setup` click on a fresh machine ends with a working Agent-mode chat.
 *
 * The proxy hook (`jetbrains-proxy.ts`) only makes the IDE's own HTTPS traffic
 * reach the gateway; it says nothing about Junie — the ACP agent the IDE spawns
 * for Agent mode. On a new machine three things are still missing after the hook:
 *
 *   1. **Junie itself.** IDEA downloads it from GitHub release assets, and on a
 *      fresh install that download is the single most common failure: 215 MB
 *      over a slow link, no resume, retried in a loop. We fetch it once, verify
 *      it, extract it into the exact layout the ACP runtime expects, AND drop
 *      the archive where `AcpBinaryManager` looks for it — the manager treats a
 *      binary it did not promote itself as "install never completed" and
 *      re-downloads, so seeding the archive is what turns our extraction into an
 *      install it accepts.
 *
 *   2. **Junie's model list.** Junie ships a fixed cloud catalog routed through
 *      JetBrains (blocked in some regions, and not the operator's gateway). Its
 *      custom-model mechanism appends our tiers to the picker from
 *      `~/.junie/models/*.json`; `~/.junie/config.json` makes one the default.
 *
 *   3. **A CA the IDE's JBR actually trusts.** Stock JBR has no
 *      `trustStoreType=Windows-ROOT`, so the MITM root must be in ITS cacerts.
 *      On a system-wide install that file is under `C:\Program Files` and not
 *      writable by the user running the setup — the fallback is a copy plus two
 *      `-Djavax.net.ssl.trustStore*` lines in the IDE's user vmoptions.
 *
 * Nothing here touches inference: these are all handshake/plumbing writes, and
 * every file is either marker-owned or created from scratch (never a vendor file
 * rewritten in place), so `teardown` can revoke exactly what it added.
 */

/* ------------------------------------------------------------------ *
 * ACP agent registry + platform keys
 * ------------------------------------------------------------------ */

/** Asset key the ACP registry uses for each OS/arch pair. */
export function platformAssetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const arm = arch === 'arm64' || arch === 'aarch64';
  if (platform === 'win32') return arm ? 'windows-aarch64' : 'windows-x86_64';
  if (platform === 'darwin') return arm ? 'darwin-aarch64' : 'darwin-x86_64';
  if (platform === 'linux') return arm ? 'linux-aarch64' : 'linux-x86_64';
  return null;
}

/** One resolvable binary distribution from the registry. */
export interface AcpBinaryAsset {
  id: string;
  version: string;
  /** Absolute download URL (GitHub release asset). */
  url: string;
  /** Repo-relative command to run, verbatim from the registry (`./junie/junie.exe`). */
  cmd: string;
  args: string[];
  /** File name of the archive, derived from the URL. */
  archiveName: string;
  /** Present for most registry entries; Junie currently publishes none. */
  sha256?: string;
}

interface RegistryAgentLike {
  id?: string;
  version?: string;
  distribution?: {
    binary?: Record<string, { archive?: string; cmd?: string; args?: string[]; sha256?: string }>;
  };
}

/**
 * Resolve `junie`'s binary asset for this platform out of the IDE's own ACP
 * registry — the same file the IDE reads, so the version we install can never
 * drift from the version it expects.
 *
 * Returns null (never throws) for a missing/invalid registry, an absent agent,
 * or a platform the agent does not publish — the callers turn that into an
 * advisory, because the proxy hook is still worth having on its own.
 */
export function pickAcpBinaryAsset(
  registry: unknown,
  agentId: string,
  assetKey: string | null = platformAssetKey(),
): AcpBinaryAsset | null {
  if (!assetKey) return null;
  const agents = (registry as { agents?: unknown })?.agents;
  if (!Array.isArray(agents)) return null;
  const agent = agents.find(
    (candidate): candidate is RegistryAgentLike =>
      !!candidate && typeof candidate === 'object' && (candidate as RegistryAgentLike).id === agentId,
  );
  if (!agent?.version) return null;
  const bin = agent.distribution?.binary?.[assetKey];
  if (!bin?.archive) return null;
  let archiveName: string;
  try {
    archiveName = path.posix.basename(new URL(bin.archive).pathname);
  } catch {
    return null;
  }
  if (!archiveName) return null;
  return {
    id: agentId,
    version: agent.version,
    url: bin.archive,
    cmd: bin.cmd ?? '',
    args: Array.isArray(bin.args) ? bin.args : [],
    archiveName,
    ...(bin.sha256 ? { sha256: bin.sha256 } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Install layout (mirrors AcpPaths / AcpBinaryManager)
 * ------------------------------------------------------------------ */

/**
 * `%LOCALAPPDATA%\JetBrains\<config name>\acp-agents` on Windows.
 *
 * Note this is NOT the roaming config root: IDEA keeps ACP payloads under a
 * per-config-name LOCAL directory, and the older flat `JetBrains\acp-agents`
 * belongs to a different IDE generation. Writing to the wrong one produces an
 * install the IDE never sees.
 */
export function acpAgentsDir(configDir: string): string {
  const name = path.basename(configDir);
  const local =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(local, 'JetBrains', name, 'acp-agents');
}

/** Where the registry snapshot lives (the IDE writes it on first agent lookup). */
export function acpRegistryPath(agentsDir: string): string {
  return path.join(agentsDir, 'registry.json');
}

/** `<agents>/<agent>/<version>` — the directory whose CONTENTS are the archive. */
export function acpInstallRoot(agentsDir: string, agentId: string, version: string): string {
  return path.join(agentsDir, agentId, version);
}

/** Repo-relative `cmd` resolved against the install root (`./junie/junie.exe`). */
export function acpBinaryPath(installRoot: string, cmd: string): string {
  return path.join(installRoot, cmd.replace(/^\.\//, '').replace(/\//g, path.sep));
}

/**
 * The staging path `AcpBinaryManager` downloads into and promotes from.
 *
 * Seeding this is deliberate, not a hack around it: the manager's install
 * verdict is its own promotion bookkeeping, so an extracted-without-promotion
 * binary reads as "install never completed" and is re-downloaded. An archive
 * already sitting at this path is promoted in milliseconds instead.
 */
export function acpDownloadPath(agentsDir: string, agentId: string, version: string, archiveName: string): string {
  return path.join(agentsDir, '.downloads', agentId, version, archiveName);
}

/** Installed Junie version(s) on disk, newest first. */
export function detectAcpInstalls(agentsDir: string, agentId: string): { version: string; binary: string | null }[] {
  const root = path.join(agentsDir, agentId);
  if (!fs.existsSync(root)) return [];
  const out: { version: string; binary: string | null }[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    out.push({ version: entry.name, binary: findExecutable(dir) });
  }
  return out.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

/**
 * First executable-looking file in an extracted agent directory (bounded walk).
 *
 * The registry's `cmd` is the authority and is used when known; this is the
 * fallback that keeps the status line honest when only the layout is available
 * (e.g. an install promoted before the registry was read).
 */
function findExecutable(dir: string, depth = 3): string | null {
  if (depth < 0) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const exeNames = process.platform === 'win32' ? /\.(exe|bat|cmd)$/i : /(^|[^.]\w)$/;
  for (const entry of entries) {
    if (!entry.isDirectory() && exeNames.test(entry.name)) return path.join(dir, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'runtime') continue;
    const found = findExecutable(path.join(dir, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Download + extract
 * ------------------------------------------------------------------ */

/** True when the file ends with a zip End-Of-Central-Directory record. */
export function looksLikeZip(file: string): boolean {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    if (size < 22) return false;
    fd = fs.openSync(file, 'r');
    const tail = Buffer.alloc(22);
    fs.readSync(fd, tail, 0, 22, size - 22);
    // PK\x05\x06 — EOCD signature. A truncated download has no such tail, which
    // is exactly the "215 MB forever" case this guards against.
    return tail[0] === 0x50 && tail[1] === 0x4b && tail[2] === 0x05 && tail[3] === 0x06;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export interface DownloadResult {
  ok: boolean;
  path: string;
  bytes: number;
  detail?: string;
  /** True when an existing file was reused (hash/size already good). */
  cached?: boolean;
}

/**
 * Stream a URL to disk and validate it before anyone extracts it.
 *
 * A partial archive is worse than no archive here: extraction produces a
 * corrupted agent tree that the IDE then reports as an install failure, and the
 * operator has no signal about WHICH step failed. So the download is validated
 * (declared size, then zip structure, then the registry hash when one exists)
 * and removed when it does not check out.
 */
export async function downloadFile(
  url: string,
  dest: string,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    sha256?: string;
    /** Reuse an existing file when it validates (default true). */
    reuseExisting?: boolean;
  } = {},
): Promise<DownloadResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (options.reuseExisting !== false && fs.existsSync(dest) && looksLikeZip(dest)) {
    if (!options.sha256 || (await sha256Of(dest)) === options.sha256) {
      return { ok: true, path: dest, bytes: fs.statSync(dest).size, cached: true };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const partial = `${dest}.part`;
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      // GitHub release assets 404 without a UA on some edges; harmless elsewhere.
      headers: { 'user-agent': 'omnicell-router' },
    });
    if (!res.ok || !res.body) {
      return { ok: false, path: dest, bytes: 0, detail: `HTTP ${res.status} from ${url}` };
    }
    const declared = Number(res.headers.get('content-length') ?? '');
    const expected = Number.isFinite(declared) && declared > 0 ? declared : undefined;

    const out = fs.createWriteStream(partial);
    let bytes = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (!out.write(chunk)) {
        await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));

    if (expected !== undefined && bytes !== expected) {
      fs.rmSync(partial, { force: true });
      return { ok: false, path: dest, bytes, detail: `truncated: ${bytes}/${expected} bytes` };
    }
    if (!looksLikeZip(partial)) {
      fs.rmSync(partial, { force: true });
      return { ok: false, path: dest, bytes, detail: 'downloaded file is not a zip archive' };
    }
    if (options.sha256) {
      const actual = await sha256Of(partial);
      if (actual !== options.sha256) {
        fs.rmSync(partial, { force: true });
        return { ok: false, path: dest, bytes, detail: `sha256 mismatch (${actual})` };
      }
    }
    fs.rmSync(dest, { force: true });
    fs.renameSync(partial, dest);
    return { ok: true, path: dest, bytes };
  } catch (err) {
    fs.rmSync(partial, { force: true });
    return { ok: false, path: dest, bytes: 0, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract a zip without adding a dependency: the platform's own archiver first
 * (`tar` reads zip on Windows 10+/macOS/Linux), then PowerShell's Expand-Archive
 * as the Windows fallback, then `unzip`.
 *
 * Each step is a separate command because a single "try everything" wrapper
 * cannot report WHICH archiver failed, and the operator ends up hunting the
 * cause in the IDE log instead of in the setup message.
 */
export async function extractZip(archive: string, destDir: string): Promise<{ ok: boolean; tool?: string; detail?: string }> {
  fs.mkdirSync(destDir, { recursive: true });
  const attempts: { tool: string; run: () => Promise<{ ok: boolean; stderr: string }> }[] = [
    { tool: 'tar', run: () => runCommand('tar', ['-xf', archive, '-C', destDir], 600000) },
  ];
  if (process.platform === 'win32') {
    attempts.push({
      tool: 'Expand-Archive',
      run: () =>
        runCommand(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
          ],
          600000,
        ),
    });
  }
  attempts.push({ tool: 'unzip', run: () => runCommand('unzip', ['-oq', archive, '-d', destDir], 600000) });

  let last: string | undefined;
  for (const attempt of attempts) {
    const res = await attempt.run();
    if (res.ok && fs.readdirSync(destDir).length > 0) return { ok: true, tool: attempt.tool };
    last = `${attempt.tool}: ${res.stderr.trim().split('\n').slice(-1)[0] ?? 'failed'}`;
  }
  return { ok: false, detail: last };
}

/* ------------------------------------------------------------------ *
 * Junie provisioning
 * ------------------------------------------------------------------ */

export interface JunieInstallResult {
  ok: boolean;
  /** Version now present on disk. */
  version?: string;
  /** Absolute path of the agent executable. */
  binary?: string;
  /** True when this run installed it (vs. it was already there). */
  installed: boolean;
  detail?: string;
}

/**
 * Ensure the Junie agent binary exists, without relying on the IDE's downloader.
 *
 * Order matters and is the whole point: extract first (so the agent works even
 * if the IDE never promotes), then seed `.downloads` (so the IDE DOES promote
 * and stops re-downloading). A pre-existing matching install short-circuits
 * everything — re-running setup must not re-download 215 MB.
 */
export async function ensureAcpAgent(
  options: {
    configDir: string;
    agentId?: string;
    agentsDir?: string;
    /** Where the archive is cached between runs (defaults under OCR_HOME). */
    cacheDir?: string;
    fetchImpl?: typeof fetch;
    /** Present when the caller wants a specific version even if another is installed. */
    asset?: AcpBinaryAsset | null;
    log?: (line: string) => void;
  },
): Promise<JunieInstallResult> {
  const agentId = options.agentId ?? 'junie';
  const agentsDir = options.agentsDir ?? acpAgentsDir(options.configDir);
  const log = options.log ?? (() => {});
  const registryPath = acpRegistryPath(agentsDir);

  let asset = options.asset ?? null;
  if (!asset) {
    if (!fs.existsSync(registryPath)) {
      return {
        ok: false,
        installed: false,
        detail: `ACP registry not found at ${registryPath} — start the IDE once so it downloads the agent registry, then re-run setup.`,
      };
    }
    let registry: unknown;
    try {
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch (err) {
      return { ok: false, installed: false, detail: `ACP registry is unreadable: ${err instanceof Error ? err.message : String(err)}` };
    }
    asset = pickAcpBinaryAsset(registry, agentId);
    if (!asset) {
      return { ok: false, installed: false, detail: `No ${agentId} binary is published for this platform in the ACP registry.` };
    }
  }

  const installRoot = acpInstallRoot(agentsDir, agentId, asset.version);
  const expectedBinary = asset.cmd ? acpBinaryPath(installRoot, asset.cmd) : null;

  if (expectedBinary && fs.existsSync(expectedBinary)) {
    log(`[junie] ${agentId} ${asset.version} already installed at ${expectedBinary}`);
    return { ok: true, installed: false, version: asset.version, binary: expectedBinary };
  }
  const existing = detectAcpInstalls(agentsDir, agentId);
  if (existing.length && existing[0].binary && existing[0].version === asset.version) {
    log(`[junie] ${agentId} ${asset.version} already present at ${existing[0].binary}`);
    return { ok: true, installed: false, version: asset.version, binary: existing[0].binary };
  }

  const cacheDir = options.cacheDir ?? path.join(getOcrHomeDir(), 'downloads');
  const archive = path.join(cacheDir, agentId, asset.version, asset.archiveName);
  log(`[junie] downloading ${asset.url} -> ${archive}`);
  const download = await downloadFile(asset.url, archive, {
    fetchImpl: options.fetchImpl,
    ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
  });
  if (!download.ok) {
    return { ok: false, installed: false, detail: `Download failed: ${download.detail ?? 'unknown error'} (${asset.url})` };
  }
  log(`[junie] downloaded ${download.bytes} bytes${download.cached ? ' (cached)' : ''}`);

  const staged = `${installRoot}.staging`;
  fs.rmSync(staged, { recursive: true, force: true });
  const extracted = await extractZip(archive, staged);
  if (!extracted.ok) {
    fs.rmSync(staged, { recursive: true, force: true });
    return { ok: false, installed: false, detail: `Archive extraction failed: ${extracted.detail ?? 'no archiver available'}` };
  }
  // Promote: the install directory must be the archive ROOT (the registry's
  // `cmd` is resolved against it), so the staging dir is renamed into place
  // rather than copied — an interrupted previous attempt leaves only `.staging`.
  fs.rmSync(installRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(installRoot), { recursive: true });
  fs.renameSync(staged, installRoot);

  const binary = asset.cmd ? acpBinaryPath(installRoot, asset.cmd) : findExecutable(installRoot);
  if (!binary || !fs.existsSync(binary)) {
    return {
      ok: false,
      installed: false,
      version: asset.version,
      detail: `Extracted archive does not contain the expected command (${asset.cmd || 'unknown'}).`,
    };
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(binary, 0o755);
    } catch {
      /* best effort: the archive usually carries the mode already */
    }
  }

  // Seed the manager's staging path so the IDE promotes instead of re-downloading.
  let seeded = false;
  try {
    const seedPath = acpDownloadPath(agentsDir, agentId, asset.version, asset.archiveName);
    fs.mkdirSync(path.dirname(seedPath), { recursive: true });
    fs.copyFileSync(archive, seedPath);
    seeded = true;
  } catch (err) {
    log(`[junie] could not seed ${asset.archiveName}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    ok: true,
    installed: true,
    version: asset.version,
    binary,
    detail: `extracted with ${extracted.tool}${seeded ? ', archive seeded for IDE promotion' : ''}`,
  };
}

/* ------------------------------------------------------------------ *
 * Junie custom model profiles
 * ------------------------------------------------------------------ */

/** Junie's per-user state root (`~/.junie`). */
export function junieHome(): string {
  const override = process.env.JUNIE_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.junie');
}

export const JUNIE_PROFILE_PREFIX = 'ocr-';

/**
 * The public OCR tiers exposed in Junie's picker.
 *
 * Labels are `Tier (OCR)`: the picker already groups these under "Custom", so
 * the model name leads and the parenthetical only says who serves it — and the
 * tiers stay in their natural order instead of collapsing into one "OCR …" block.
 */
export const JUNIE_TIERS: readonly { tier: string; label: string }[] = [
  { tier: 'auto', label: 'Auto (OCR)' },
  { tier: 'lite', label: 'Lite (OCR)' },
  { tier: 'plus', label: 'Plus (OCR)' },
  { tier: 'pro', label: 'Pro (OCR)' },
  { tier: 'ultra', label: 'Ultra (OCR)' },
];

/** One custom-model profile file as Junie parses it. */
export interface JunieModelProfile {
  file: string;
  body: {
    id: string;
    baseUrl: string;
    displayName: string;
    providerName: string;
    apiKey: string;
    apiType: 'OpenAICompletion';
    primaryModel: { id: string };
    fasterModel: { id: string };
    maxContextLength: number;
  };
}

/**
 * Build the model profiles for the local gateway.
 *
 * Two shape details are load-bearing and were established by probing Junie's own
 * serializer, not by guessing:
 *
 *   - `baseUrl` is used VERBATIM as the completions URL; Junie appends nothing.
 *     `.../v1` therefore posts to `/v1` and the gateway answers
 *     `OpenAI: Route POST:/v1 not found`. The full `.../v1/chat/completions`
 *     path is required.
 *   - `apiKey` is a plain string. `{ "value": "..." }` fails to parse with
 *     `Expected beginning of the string, but got { at path: $.apiKey`.
 */
export function buildJunieProfiles(gatewayUrl: string, apiKey: string): JunieModelProfile[] {
  const base = gatewayUrl.replace(/\/+$/, '');
  const completions = /\/chat\/completions$/.test(base) ? base : `${base}${/\/v1$/.test(base) ? '' : '/v1'}/chat/completions`;
  return JUNIE_TIERS.map(({ tier, label }) => ({
    file: `${JUNIE_PROFILE_PREFIX}${tier}.json`,
    body: {
      id: `${JUNIE_PROFILE_PREFIX}${tier}`,
      baseUrl: completions,
      displayName: label,
      providerName: 'OCR Gateway',
      apiKey,
      apiType: 'OpenAICompletion' as const,
      primaryModel: { id: tier },
      fasterModel: { id: 'lite' },
      maxContextLength: 128000,
    },
  }));
}

/**
 * Junie's `config.json` with OUR default selected, preserving every other key.
 *
 * `model` is only the initial selection — once the operator picks a model in the
 * IDE, Junie persists it in `settings.json` (`acpLastSelectedModel`) and that
 * wins. Writing this is still what stops a fresh machine from defaulting to the
 * JetBrains cloud model.
 */
export function mergeJunieConfig(raw: string | null, model: string): string {
  let parsed: Record<string, unknown> = {};
  if (raw && raw.trim()) {
    try {
      const candidate = JSON.parse(raw);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) parsed = candidate as Record<string, unknown>;
    } catch {
      // A corrupt config must not block provisioning: replace it with ours. The
      // file only holds an initial selection, nothing irreproducible.
      parsed = {};
    }
  }
  parsed.model = model;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export interface JunieModelsResult {
  ok: boolean;
  files: string[];
  configPath: string;
  model: string;
  detail?: string;
}

/** Write the profiles + default model. Idempotent; only `ocr-*.json` files are ours. */
export function writeJunieModels(
  gatewayUrl: string,
  apiKey: string,
  options: { home?: string; defaultTier?: string } = {},
): JunieModelsResult {
  const home = options.home ?? junieHome();
  const modelsDir = path.join(home, 'models');
  const configPath = path.join(home, 'config.json');
  const tier = options.defaultTier ?? 'auto';
  const profiles = buildJunieProfiles(gatewayUrl, apiKey);
  const written: string[] = [];
  try {
    fs.mkdirSync(modelsDir, { recursive: true });
    for (const profile of profiles) {
      const file = path.join(modelsDir, profile.file);
      fs.writeFileSync(file, `${JSON.stringify(profile.body, null, 2)}\n`, 'utf8');
      written.push(file);
    }
    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
    const model = `custom:${JUNIE_PROFILE_PREFIX}${tier}`;
    fs.writeFileSync(configPath, mergeJunieConfig(existing, model), 'utf8');
    return { ok: true, files: written, configPath, model };
  } catch (err) {
    return {
      ok: false,
      files: written,
      configPath,
      model: `custom:${JUNIE_PROFILE_PREFIX}${tier}`,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Remove our profiles and the `custom:ocr-*` default, leaving operator edits alone.
 *
 * The `model` key is only cleared when it still points at one of OUR profiles: an
 * operator who re-pointed Junie at something else keeps that selection.
 */
export function removeJunieModels(options: { home?: string } = {}): { removed: string[]; configPath: string } {
  const home = options.home ?? junieHome();
  const modelsDir = path.join(home, 'models');
  const configPath = path.join(home, 'config.json');
  const removed: string[] = [];
  if (fs.existsSync(modelsDir)) {
    for (const entry of fs.readdirSync(modelsDir)) {
      if (!entry.startsWith(JUNIE_PROFILE_PREFIX) || !entry.endsWith('.json')) continue;
      const file = path.join(modelsDir, entry);
      fs.rmSync(file, { force: true });
      removed.push(file);
    }
    try {
      if (fs.readdirSync(modelsDir).length === 0) fs.rmdirSync(modelsDir);
    } catch {
      /* non-empty (operator profiles remain) or already gone — neither is an error */
    }
  }
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && typeof parsed.model === 'string' && parsed.model.startsWith(`custom:${JUNIE_PROFILE_PREFIX}`)) {
        delete parsed.model;
        fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
      }
    } catch {
      /* unreadable config is not ours to rewrite on teardown */
    }
  }
  return { removed, configPath };
}

/** True when our profiles are on disk (status line, not a gate). */
export function junieModelsPresent(options: { home?: string } = {}): boolean {
  const modelsDir = path.join(options.home ?? junieHome(), 'models');
  return fs.existsSync(modelsDir) && fs.readdirSync(modelsDir).some((f) => f.startsWith(JUNIE_PROFILE_PREFIX) && f.endsWith('.json'));
}

/* ------------------------------------------------------------------ *
 * IDE trust of the MITM root (writable cacerts, else vmoptions fallback)
 * ------------------------------------------------------------------ */

/**
 * The IDE's user-level vmoptions file (the one an operator may already have).
 *
 * Named after the launcher (`idea64.exe.vmoptions`, `goland64.exe.vmoptions`):
 * the IDEs do not share a user vmoptions file, so a product-agnostic name would
 * write one IDE's truststore override where the other never reads it.
 */
export function vmOptionsPath(configDir: string, stem: string): string {
  return path.join(configDir, process.platform === 'darwin' ? `${stem}.vmoptions` : `${stem}64.exe.vmoptions`);
}

/** Marker line that scopes our vmoptions block for removal. */
const VMOPTIONS_MARKER = `# omnicell-router-managed: JBR truststore override`;
/** Prefix for a pre-existing trustStore line we had to disable (restored on teardown). */
const VMOPTIONS_DISABLED = `# omnicell-router-managed (disabled): `;

/** A line that sets the JVM truststore — two of these leave the winner to argument order. */
const TRUST_LINE_RE = /^\s*-Djavax\.net\.ssl\.trustStore(?:Password)?=/;

/** Two `-D` lines that make JBR read OUR truststore copy. */
export function vmOptionsTrustLines(truststore: string): string[] {
  return [`-Djavax.net.ssl.trustStore=${truststore}`, `-Djavax.net.ssl.trustStorePassword=changeit`];
}

/**
 * Append (or replace) our truststore block in an IDEA vmoptions file.
 *
 * Replacement rather than append-only, and every pre-existing trustStore line is
 * DISABLED (commented, not deleted) for two reasons:
 *
 *   - the truststore path changes whenever OCR_HOME does, and two
 *     `-Djavax.net.ssl.trustStore` lines leave the winner to JVM argument order —
 *     a silent, version-dependent bug (it already happened on a real machine: a
 *     hand-added block plus this one);
 *   - an operator's own line must come back on teardown, so it is parked inside
 *     our block as a comment and restored by `stripVmOptions`.
 */
export function patchVmOptions(text: string, truststore: string): string {
  const cleaned = stripVmOptions(text);
  const parked: string[] = [];
  const kept: string[] = [];
  for (const line of cleaned.split(/\r?\n/)) {
    if (TRUST_LINE_RE.test(line)) parked.push(`${VMOPTIONS_DISABLED}${line.trim()}`);
    else kept.push(line);
  }
  const block = [VMOPTIONS_MARKER, ...parked, ...vmOptionsTrustLines(truststore)];
  const trimmed = kept.join(`
`).replace(/\s+$/, '');
  return `${trimmed ? `${trimmed}
` : ''}${block.join(`
`)}
`;
}

/**
 * Remove exactly our block, restoring any trustStore line it had parked.
 *
 * Lines are matched by our marker/prefix and nothing else: a file we never wrote
 * is returned unchanged, and an operator's unrelated JVM flags are never touched.
 */
export function stripVmOptions(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === VMOPTIONS_MARKER) {
      // Consume the managed tail: parked lines plus the two trustStore lines.
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const candidate = lines[j];
        if (candidate.startsWith(VMOPTIONS_DISABLED)) {
          out.push(candidate.slice(VMOPTIONS_DISABLED.length));
          continue;
        }
        if (TRUST_LINE_RE.test(candidate)) continue;
        break;
      }
      i = j - 1;
      continue;
    }
    out.push(line);
  }
  const joined = out.join(`
`).replace(/\s+$/, '');
  return joined ? `${joined}
` : '';
}

/**
 * True when we can ACTUALLY write the file — proven by opening it, not by asking.
 *
 * `fs.accessSync(W_OK)` is a trap on Windows: it maps to `_waccess`, which does
 * not evaluate NTFS ACLs, so `C:\Program Files\...\cacerts` reports writable and
 * the keytool import then dies with `java.io.FileNotFoundException: ... (Access
 * is denied)`. Opening for `r+` goes through the real permission check, costs
 * nothing, and is the only verdict a setup message can stand behind.
 */
export function isWritable(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r+');
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

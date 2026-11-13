import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ClientAdapter,
  ClientActionResult,
  collectHookWarnings,
  resolveForwardProxyEndpoint,
  resolveGatewayBaseUrl,
} from './base.js';
import { getOcrHomeDir } from '../paths.js';
import { getForwardProxyStatus } from '../../forward-proxy/status.js';
import { CA_CN } from '../../forward-proxy/ca.js';
import { ClientArtifact, ClientHookStatus, ClientProductStatus } from '../types.js';
import { runCommand } from '../../utils/run-command.js';
import { createApiKey, isApiKeyUsable, listApiKeys } from '../../auth/api-keys.js';
import {
  acpAgentsDir,
  detectAcpInstalls,
  type JunieInstallResult,
  ensureAcpAgent,
  vmOptionsPath,
  isWritable,
  junieModelsPresent,
  patchVmOptions,
  removeJunieModels,
  stripVmOptions,
  writeJunieModels,
} from './jetbrains-junie.js';
import type { ApiKeyConfig } from '../../config/types.js';

/**
 * JetBrains IDE proxy client adapter — forward-proxy hook (no vendor config rewrite).
 *
 * IntelliJ IDEA and GoLand today. Every IntelliJ-platform IDE shares the
 * contract below — the same `proxy.settings.xml` shape, the same JBR truststore
 * layout, the same per-config-name ACP directory, the same user vmoptions file
 * — so a product is ONE row in `JETBRAINS_PRODUCTS` and detection, setup and
 * teardown loop the table. Nothing product-specific may live outside it.
 *
 * An IDE cannot be pointed at a custom LLM endpoint for its own AI surface, and
 * its AI traffic is hardcoded to JetBrains hosts. The `jetbrains-gateway` plugin
 * MITMs those hosts through OCR's inbound forward proxy. This adapter makes the
 * IDE start through that proxy, and — because it must — takes the ONE
 * reversible route the platform actually honors:
 *
 *   1. `<config>/options/proxy.settings.xml` — the IDE's own `HttpConfigurable`.
 *      This is authoritative: `IdeProxySelector` returns NO_PROXY whenever the
 *      UI selection is "No proxy", so `-Dhttp(s).proxyHost` in vmoptions is
 *      silently ignored. Manual proxy + `PROXY_EXCEPTIONS` is the only shape
 *      that routes the JVM AND JCEF legs through the proxy while keeping
 *      loopback (the OCR gateway itself) out of the hop.
 *   2. The MITM root imported into the IDE's OWN truststore
 *      (`<install>/jbr/lib/security/cacerts`, alias-addressed), because JBR ships
 *      without `trustStoreType=Windows-ROOT`. Alias-scoped add/remove keeps the
 *      operation reversible even after the operator's own CA edits.
 *
 * That is the WHOLE hook: a config-file takeover, not a launcher. The IDE reads
 * proxy.settings.xml at startup, so pointing it at the forward proxy is a
 * persistent, reversible rewrite of the client's own config — the same contract
 * `opencode-proxy` has (`hookKind: 'proxy-config'`), and the reason this adapter
 * publishes no launch script: any Start-menu/desktop shortcut works unchanged.
 *
 * Everything this adapter writes is backed up first (`*.ocr-backup`) and restored
 * on teardown. Nothing vendor-owned is rewritten: the proxy component keeps every
 * option the operator set, only the proxy keys are overridden — and the original
 * file goes back byte-for-byte on teardown.
 *
 * Setup also provisions what a FRESH machine still lacks once the hook lands —
 * the Junie ACP agent, its model list, and a CA the JBR actually trusts — because
 * "one click then debug the agent" is the contract (see `jetbrains-junie.ts`). Each of
 * those steps is best-effort and reports through warnings: a failed 215 MB
 * download must not revoke a proxy hook that already works.
 */

/** Loopback never enters the proxy hop: the OCR gateway and its own admin API live there. */
/**
 * Hosts the IDE must reach *directly* — never through the forward proxy.
 *
 * Two different reasons land here, and both end in the same place:
 *
 *   - **The ACP agent binaries** (Junie, any other `binary` agent) come from
 *     GitHub release assets. Through the gateway they answer 502, and the IDE
 *     retries the download in a forever loop while the chat sits there.
 *   - **Everything JetBrains that we do NOT mock.** The proxy intercepts by
 *     default, so any other JetBrains host (`analytics.services.jetbrains.com.cn`,
 *     the plugin marketplace, the account portal, the docs/JCEF fetches) is
 *     answered with OUR forged certificate. The IDE's own TLS stack keeps its
 *     acceptances in `<config>/ssl/cacerts` — host by host — and knows nothing
 *     about JBR's keystore, so the operator gets a scary "untrusted server
 *     certificate" dialog naming `OmniCellRouter Forward Proxy CA` (observed on a
 *     real machine for the analytics endpoint). Bypassing those hosts means the
 *     real JetBrains roots are used and no dialog ever appears.
 *
 * The mocked hosts (`api.ai.jetbrains.com.cn`, `api.jetbrains.cloud`,
 * `api.jetbrains.ai`, `grazie.jetbrains.com`, `ai-api.jetbrains.com`) must NEVER
 * be listed here — they are the whole point of the hook. Do not "simplify" this
 * into `*.jetbrains.com`: that wildcard also matches `api.ai.jetbrains.com.cn`
 * and silently turns every mock off.
 */
export const JETBRAINS_PROXY_EXCEPTIONS: readonly string[] = [
  // Loopback: the OCR gateway, its console and any local model server.
  'localhost',
  '127.0.0.1',
  '::1',
  // Agent binaries + anything a client fetches from source control.
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'gitee.com',
  '*.gitee.com',
  // ACP registry/marketplace assets the IDE downloads agents and plugins from.
  'cdn.agentclientprotocol.com',
  'plugins.jetbrains.com',
  'downloads.marketplace.jetbrains.com',
  'download.jetbrains.com',
  'download-cdn.jetbrains.com',
  // Telemetry / account / marketing: browsers and analytics SDKs that ship their
  // own trust path (that is what produced the certificate dialog).
  'analytics.services.jetbrains.com.cn',
  'account.jetbrains.com.cn',
  'oauth.account.jetbrains.com.cn',
  'resources.jetbrains.com.cn',
  'resources.jetbrains.com',
  'www.jetbrains.com.cn',
  'www.jetbrains.com',
  'frameworks.jetbrains.com',
  // Embedded-browser fetches (documentation links, in-IDE browser panes).
  '*.google.com',
  '*.googleapis.com',
  '*.gstatic.com',
  '*.youtube.com',
  // npm registry: MCP servers and agent packages installed by the IDE.
  'registry.npmjs.org',
  '*.npmjs.org',
];

/** Comma-joined form the IDE writes into `PROXY_EXCEPTIONS` (family-wide: every product bypasses the same hosts). */
export const JETBRAINS_NO_PROXY = JETBRAINS_PROXY_EXCEPTIONS.join(',');

/**
 * The operator's own exceptions FIRST, then ours, deduped case-insensitively.
 *
 * The takeover patches one flat option, so writing our list verbatim would drop
 * whatever the operator had (a corporate mirror, an internal host). Their order
 * is kept so a first-match-wins reader sees what they wrote.
 */
export function mergeProxyExceptions(existing?: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of `${existing ?? ''},${JETBRAINS_NO_PROXY}`.split(',')) {
    const host = raw.trim();
    if (!host || seen.has(host.toLowerCase())) continue;
    seen.add(host.toLowerCase());
    out.push(host);
  }
  return out.join(',');
}

/** Alias that scopes the CA import in each IDE truststore (teardown deletes exactly this). */
export const JETBRAINS_CA_ALIAS = 'ocr-forward-proxy';

/** JBR's stock truststore password. Only used for the local IDE truststore. */
const JBR_STOREPASS = 'changeit';

/** Marker written into every owned file. */
const MARKER = 'omnicell-router-managed';

/* ------------------------------------------------------------------ *
 * Product table — one row per JetBrains IDE this adapter can hook
 * ------------------------------------------------------------------ */

/**
 * One hookable JetBrains IDE.
 *
 * Every IntelliJ-platform product shares the contract this adapter relies on —
 * its own `proxy.settings.xml`, its own JBR `cacerts`, its own user vmoptions,
 * its own per-config-name ACP directory — so support for another product is ONE
 * row here. Detection, setup and teardown loop the table; a product-shaped
 * branch anywhere else is a bug.
 */
export interface JetBrainsProduct {
  /** Stable id: console product key and the `--product` / `product` action target. */
  id: string;
  displayName: string;
  /** Config roots under `%APPDATA%\JetBrains` this product owns. */
  configDirRe: RegExp;
  /** Build version inside a config-root name (group 1). */
  configVersionRe: RegExp;
  /** Build version inside an install-folder name (group 1) — `product-info.json` wins when present. */
  installVersionRe: RegExp;
  /** Install-folder prefix under the Windows install roots. */
  installDirRe: RegExp;
  /** macOS app bundles. */
  macBundles: string[];
  /** Linux install roots to walk. */
  linuxRoots: string[];
  /** Binary stem: `bin/<stem>64.exe`, `Contents/MacOS/<stem>`, `bin/<stem>.sh`,
   *  and `<stem>64.exe.vmoptions` in the user config root. */
  stem: string;
  /** Glob the console shows in place of a config path before the IDE has run once. */
  configGlob: string;
  /** Env override pointing at an install root. */
  envHome: string;
  /** Env override pointing at the launcher binary itself. */
  envBin: string;
}

/** JetBrains' per-user Toolbox root on Linux (shared by every product). */
const LINUX_TOOLBOX = path.join(os.homedir(), '.local/share/JetBrains/Toolbox/apps');

/**
 * Supported products, in console and CLI order.
 *
 * Adding a row IS the implementation of "support product X" — the hook is file
 * surgery on a layout the whole IntelliJ platform shares, so a second adapter
 * (or a second console card) per product would only duplicate the same steps.
 */
export const JETBRAINS_PRODUCTS: readonly JetBrainsProduct[] = [
  {
    id: 'intellij-idea',
    displayName: 'IntelliJ IDEA',
    // Ultimate writes `IntelliJIdea<build>`; Community `IdeaIC<build>`.
    configDirRe: /^(?:IntelliJIdea|IdeaIC)/i,
    configVersionRe: /(?:IntelliJIdea|IdeaIC)(\d+(?:\.\d+)*)/i,
    installVersionRe: /IntelliJ IDEA(?: CE)? (\d+(?:\.\d+)*)/i,
    installDirRe: /^IntelliJ IDEA/i,
    macBundles: ['/Applications/IntelliJ IDEA.app', '/Applications/IntelliJ IDEA CE.app'],
    linuxRoots: ['/opt/intellij-idea', LINUX_TOOLBOX],
    stem: 'idea',
    configGlob: 'IntelliJIdea*',
    envHome: 'IDEA_HOME',
    envBin: 'IDEA_BIN',
  },
  {
    id: 'goland',
    displayName: 'GoLand',
    configDirRe: /^GoLand/i,
    configVersionRe: /GoLand(\d+(?:\.\d+)*)/i,
    installVersionRe: /GoLand (\d+(?:\.\d+)*)/i,
    installDirRe: /^GoLand/i,
    macBundles: ['/Applications/GoLand.app'],
    linuxRoots: ['/opt/goland', LINUX_TOOLBOX],
    stem: 'goland',
    configGlob: 'GoLand*',
    envHome: 'GOLAND_HOME',
    envBin: 'GOLAND_BIN',
  },
];

/** Look a product up by its stable id; null when the id is not one we hook. */
export function jetbrainsProduct(id: string): JetBrainsProduct | null {
  const wanted = id.trim().toLowerCase();
  return JETBRAINS_PRODUCTS.find((product) => product.id === wanted) ?? null;
}
/** Install root that holds `bin/` (`Contents/` inside a macOS app bundle). */
function installBase(home: string): string {
  return process.platform === 'darwin' ? path.join(home, 'Contents') : home;
}

function localAppData(): string {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function roamingAppData(): string {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

/** Launcher binary inside an install root, per platform. */
function binaryIn(home: string, product: JetBrainsProduct): string {
  return process.platform === 'darwin'
    ? path.join(home, 'Contents', 'MacOS', product.stem)
    : process.platform === 'win32'
      ? path.join(home, 'bin', `${product.stem}64.exe`)
      : path.join(home, 'bin', `${product.stem}.sh`);
}

/**
 * Every directory under `root` (bounded depth) that passes `test`.
 *
 * All matches, not the first: Toolbox keeps one directory per CHANNEL
 * (`apps/<product>/<channel>/<build>`), and "first one found" hooks whichever
 * channel happens to sort first instead of the build the operator launches.
 */
function findAllUnder(root: string, depth: number, test: (dir: string) => boolean): string[] {
  if (depth < 0 || !fs.existsSync(root)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (test(dir)) {
      hits.push(dir);
      continue;
    }
    hits.push(...findAllUnder(dir, depth - 1, test));
  }
  return hits;
}

/** Newest config root `product` owns, or null when the IDE never ran here. */
export function productConfigDir(product: JetBrainsProduct): string | null {
  const root = path.join(roamingAppData(), 'JetBrains');
  if (!fs.existsSync(root)) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { dir: string; at: number } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || !product.configDirRe.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    let at = 0;
    try {
      at = fs.statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    if (!best || at > best.at) best = { dir, at };
  }
  return best?.dir ?? null;
}
/** The parts of `product-info.json` this adapter trusts. */
export interface ProductInfo {
  /** Build the install actually contains. */
  version: string | null;
  /** The `%APPDATA%\JetBrains` (and `%LOCALAPPDATA%\JetBrains`) directory name the install writes. */
  dataDirectoryName: string | null;
}

/** Read `product-info.json` (inside `Contents/` on macOS); all-null when absent/unreadable. */
export function readProductInfo(home: string): ProductInfo {
  const info = path.join(installBase(home), 'product-info.json');
  if (!fs.existsSync(info)) return { version: null, dataDirectoryName: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(info, 'utf8')) as { version?: unknown; dataDirectoryName?: unknown };
    return {
      version: typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null,
      dataDirectoryName: typeof parsed.dataDirectoryName === 'string' && parsed.dataDirectoryName.trim() ? parsed.dataDirectoryName.trim() : null,
    };
  } catch {
    return { version: null, dataDirectoryName: null };
  }
}

/** The config root an INSTALL writes (`product-info.json` `dataDirectoryName`), when it exists. */
function configDirOfInstall(home: string): string | null {
  const name = readProductInfo(home).dataDirectoryName;
  if (!name) return null;
  const dir = path.join(roamingAppData(), 'JetBrains', name);
  return fs.existsSync(dir) ? dir : null;
}

/** One install root found on disk, with the build it actually contains. */
export interface JetBrainsInstall {
  /** Install root (the directory that holds `bin/`; the .app bundle on macOS). */
  home: string;
  binary: string;
  /** Config root this install's IDE writes, when it already exists. */
  configDir: string | null;
  /** Build from `product-info.json`, folder name only as a fallback. */
  version: string | null;
  /** Newest mtime in the install root — the tie-break when two copies share a build. */
  installedAt?: number;
}

/**
 * The build an install root actually contains.
 *
 * `product-info.json` FIRST, folder name only as a fallback: an IDE updates in
 * place, so `Programs\IntelliJ IDEA 2026.1` can contain a 2026.3 build (observed
 * on a real machine). Trusting the folder name there would make setup pick the
 * wrong install, import the CA where nothing reads it, and still report success.
 */
export function readProductVersion(home: string, product: JetBrainsProduct = JETBRAINS_PRODUCTS[0]): string | null {
  const fromInfo = readProductInfo(home).version;
  if (fromInfo) return fromInfo;
  return product.installVersionRe.exec(path.basename(home))?.[1] ?? null;
}

/** `2026.3` out of `.../JetBrains/IntelliJIdea2026.3` — the product's own config-root name. */
export function configVersionOf(
  configDir: string | null,
  product: JetBrainsProduct = JETBRAINS_PRODUCTS[0],
): string | null {
  return configDir ? product.configVersionRe.exec(path.basename(configDir))?.[1] ?? null : null;
}

/** Numeric version compare (`2026.3` > `2026.1`). */
function compareProductVersion(a: string | null, b: string | null): number {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The install to treat as THE install: the build the config root belongs to,
 * then the newest build on disk.
 *
 * Both halves matter. A machine can hold a stale install (in-place upgrades leave
 * the old folder behind — often with the SAME build inside) while the config root
 * names the version the operator actually runs; picking by directory order alone
 * hooks the wrong copy.
 */
export function pickInstall(candidates: JetBrainsInstall[], configVersion: string | null): JetBrainsInstall | null {
  if (!candidates.length) return null;
  const matching = configVersion
    ? candidates.filter((candidate) => candidate.version && compareProductVersion(candidate.version, configVersion) === 0)
    : [];
  const pool = matching.length ? matching : candidates;
  return [...pool].sort(
    (a, b) => compareProductVersion(b.version, a.version) || (b.installedAt ?? 0) - (a.installedAt ?? 0),
  )[0] ?? null;
}

/** Every install root of `product` this machine has (empty when none is found). */
export function productInstallCandidates(product: JetBrainsProduct): JetBrainsInstall[] {
  const homes: string[] = [];
  const push = (home: string) => {
    if (homes.some((existing) => path.resolve(existing) === path.resolve(home))) return;
    if (fs.existsSync(binaryIn(home, product))) homes.push(home);
  };

  if (process.platform === 'win32') {
    const roots = [path.join(localAppData(), 'Programs'), path.join(programFiles(), 'JetBrains'), path.join(programFiles(true), 'JetBrains')];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      try {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
          if (entry.isDirectory() && product.installDirRe.test(entry.name)) push(path.join(root, entry.name));
        }
      } catch {
        /* unreadable install root: the next one may still answer */
      }
    }
    // Toolbox nests installs several levels deep (`apps/<product>/<channel>/<build>`).
    for (const home of findAllUnder(path.join(localAppData(), 'JetBrains', 'Toolbox', 'apps'), 4, (dir) =>
      fs.existsSync(binaryIn(dir, product)),
    )) {
      push(home);
    }
  } else if (process.platform === 'darwin') {
    for (const bundle of product.macBundles) push(bundle);
  } else {
    for (const dir of product.linuxRoots) {
      for (const home of findAllUnder(dir, 3, (candidate) => fs.existsSync(binaryIn(candidate, product)))) push(home);
    }
  }

  return homes.map((home) => ({
    home,
    binary: binaryIn(home, product),
    configDir: configDirOfInstall(home),
    version: readProductVersion(home, product),
    installedAt: installMtime(home),
  }));
}

/**
 * When this copy was last written — the stand-in for "which one is in use".
 *
 * Two install roots can hold the SAME build (in-place upgrade plus a fresh
 * install), and the folder name then says nothing. The most recently touched
 * copy is the one the last update or installer wrote, which is the one the
 * operator launches. Best-effort: 0 when nothing is readable.
 */
function installMtime(home: string): number {
  const base = installBase(home);
  for (const rel of ['product-info.json', 'build.txt', 'bin']) {
    try {
      return fs.statSync(path.join(base, rel)).mtimeMs;
    } catch {
      /* try the next marker */
    }
  }
  return 0;
}

/** `%ProgramFiles%` / `%ProgramFiles(x86)%` with a sane fallback when unset. */
function programFiles(x86 = false): string {
  const env = x86 ? process.env['ProgramFiles(x86)'] : process.env.ProgramFiles;
  if (env?.trim()) return env;
  return x86 ? 'C:\\Program Files (x86)' : 'C:\\Program Files';
}

/** The detected install of `product` (env override wins), or null. */
export function detectProduct(product: JetBrainsProduct): JetBrainsInstall | null {
  const homeEnv = process.env[product.envHome]?.trim();
  const binEnv = process.env[product.envBin]?.trim();
  const explicit = homeEnv || binEnv;
  if (explicit) {
    // `binEnv` points at the launcher itself: `<home>/bin/<stem>[64.exe]` on
    // Windows/Linux, `<bundle>.app/Contents/MacOS/<stem>` on macOS. Home is the
    // directory that holds `bin/` (the bundle on macOS), so the macOS path
    // needs one more level than the others.
    const home = binEnv
      ? path.dirname(
          path.dirname(process.platform === 'darwin' ? path.dirname(binEnv) : binEnv),
        )
      : (explicit as string);
    const binary = binEnv ?? binaryIn(home, product);
    if (fs.existsSync(binary)) {
      return {
        home,
        binary,
        configDir: configDirOfInstall(home) ?? productConfigDir(product),
        version: readProductVersion(home, product),
      };
    }
  }
  const configDir = productConfigDir(product);
  const picked = pickInstall(productInstallCandidates(product), configVersionOf(configDir, product));
  return picked ? { ...picked, configDir: picked.configDir ?? configDir } : null;
}

/**
 * Every install the hook must cover for `product`: the same build as its config
 * root (or every install when no config root exists yet).
 *
 * Fanning out is not paranoia — two install roots of the SAME build is a normal
 * state (a Program Files install next to an in-place-upgraded `Programs` copy),
 * and an operator only discovers a CA imported into the other one when TLS fails
 * in the IDE they actually launch.
 */
export function detectProductInstallsForHook(product: JetBrainsProduct): JetBrainsInstall[] {
  const candidates = productInstallCandidates(product);
  const configVersion = configVersionOf(productConfigDir(product), product);
  const matching = configVersion
    ? candidates.filter((candidate) => candidate.version && compareProductVersion(candidate.version, configVersion) === 0)
    : [];
  return matching.length ? matching : candidates;
}

/** One product's on-disk takeover state — the unit the console lists and acts on. */
export interface JetBrainsProductState {
  product: JetBrainsProduct;
  install: JetBrainsInstall | null;
  configDir: string | null;
  /** `proxy.settings.xml` of that config root (null when the IDE never ran). */
  settingsFile: string | null;
  version: string | null;
  exists: boolean;
  /** Proven ours: our marker survived, or a backup of the operator's file does. */
  hooked: boolean;
  backupExists: boolean;
}

/**
 * Every supported product present on this machine — an install OR a config root.
 *
 * A product with neither is absent (no phantom console rows): the card's details
 * line names the supported products instead.
 */
export function detectJetBrainsProducts(): JetBrainsProductState[] {
  const out: JetBrainsProductState[] = [];
  for (const product of JETBRAINS_PRODUCTS) {
    const install = detectProduct(product);
    const configDir = install?.configDir ?? productConfigDir(product);
    if (!install && !configDir) continue;
    const settingsFile = configDir ? proxySettingsPath(configDir) : null;
    const exists = !!settingsFile && fs.existsSync(settingsFile);
    const text = exists && settingsFile ? fs.readFileSync(settingsFile, 'utf8') : '';
    const backup = configDir ? ideaBackupPath(configDir) : null;
    const backupExists = !!backup && fs.existsSync(backup);
    out.push({
      product,
      install,
      configDir,
      settingsFile,
      version: install?.version ?? configVersionOf(configDir, product),
      exists,
      // Ownership, not coincidence: an operator who manually set the very same
      // host/port is NOT hooked by us (there would be nothing to restore), so
      // only our marker or a surviving backup makes the product "taken over".
      hooked: !!configDir && (text.includes(MARKER) || backupExists),
      backupExists,
    });
  }
  return out;
}

/** The IDE's own proxy settings file inside a config root. */
export function proxySettingsPath(configDir: string): string {
  return path.join(configDir, 'options', 'proxy.settings.xml');
}

/**
 * The path the console shows for a product with no config root yet — the global
 * glob, so the row still says where the hook will land once the IDE has run.
 */
export function productConfigPlaceholder(product: JetBrainsProduct): string {
  return path.join(roamingAppData(), 'JetBrains', product.configGlob, 'options', 'proxy.settings.xml');
}

/**
 * Leftover launcher from the earlier `hookKind: 'launcher'` shape of this
 * adapter. Not created any more — setup/teardown delete it so an upgraded
 * install cannot keep a stale script that implies the takeover happens at
 * launch time.
 */
export function staleLauncherPath(): string {
  const name =
    process.platform === 'win32' ? 'idea-launcher.cmd' : process.platform === 'darwin' ? 'idea-launcher.command' : 'idea-launcher.sh';
  return path.join(getOcrHomeDir(), 'clients', name);
}

export function ideaBackupPath(configDir: string): string {
  return `${proxySettingsPath(configDir)}.ocr-backup`;
}

interface HttpConfigurableState {
  httpProxy: boolean;
  pac: boolean;
  host?: string;
  port?: number;
  exceptions?: string;
}

/** Read the proxy keys this adapter cares about (unknown keys are preserved by `patchProxySettingsXml`). */
export function readProxySettings(xml: string): HttpConfigurableState {
  const block = xml.match(/<component name="HttpConfigurable">([\s\S]*?)<\/component>/)?.[1] ?? '';
  const values = new Map<string, string>();
  for (const match of block.matchAll(/<option name="([^"]+)" value="([^"]*)"\s*\/>/g)) {
    values.set(match[1], match[2]);
  }
  const bool = (key: string): boolean => values.get(key) === 'true';
  const port = Number(values.get('PROXY_PORT'));
  return {
    httpProxy: bool('USE_HTTP_PROXY'),
    // Any of the three means the IDE will try the PAC file: `IdeProxySelector`
    // reports `failed to configure proxy by pacUrl=...` on a config that only
    // carries PAC_URL with the flags cleared/unset.
    pac: bool('USE_PROXY_PAC') || bool('USE_PAC_URL') || !!values.get('PAC_URL'),
    host: values.get('PROXY_HOST') || undefined,
    port: Number.isFinite(port) && port > 0 ? port : undefined,
    exceptions: values.get('PROXY_EXCEPTIONS') || undefined,
  };
}

/**
 * The operator's `proxy.settings.xml` with ONLY the manual-proxy keys overridden.
 *
 * The IDE rewrites this file on exit, so a patch issued while it runs can be
 * undone by that exit — which is why setup warns the operator instead of
 * refusing (setup is idempotent). Every option the operator had set is carried
 * over untouched (proxy auth, scheme flags, …) — this is the difference between
 * "point the IDE at the proxy" and "flat-file takeover".
 */
const MANAGED_PROXY_KEYS = [
  'USE_PROXY_PAC',
  'USE_PAC_URL',
  'PAC_URL',
  'USE_HTTP_PROXY',
  'PROXY_HOST',
  'PROXY_PORT',
  'PROXY_EXCEPTIONS',
] as const;

const COMPONENT_RE = /<component name="HttpConfigurable">([\s\S]*?)<\/component>/;
const OPTION_RE = /<option name="([^"]+)" value="([^"]*)"\s*\/>/g;

export function patchProxySettingsXml(xml: string, patch: { host: string; port: number; exceptions?: string }): string {
  const managed: Array<[string, string]> = [
    ['USE_PROXY_PAC', 'false'],
    ['USE_PAC_URL', 'false'],
    ['PAC_URL', ''],
    ['USE_HTTP_PROXY', 'true'],
    ['PROXY_HOST', patch.host],
    ['PROXY_PORT', String(patch.port)],
    ['PROXY_EXCEPTIONS', patch.exceptions ?? JETBRAINS_NO_PROXY],
  ];
  const managedKeys = new Set<string>(MANAGED_PROXY_KEYS);
  const component = xml.match(/<component name="HttpConfigurable">([\s\S]*?)<\/component>/);

  if (!component) {
    const block = [
      '  <component name="HttpConfigurable">',
      `    <!-- ${MARKER}: manual proxy to the OCR forward proxy. Removed by \`ocr teardown jetbrains-proxy\`. -->`,
      ...managed.map(([key, value]) => `    <option name="${key}" value="${value}" />`),
      '  </component>',
      '',
    ].join('\n');
    if (xml.includes('</application>')) return xml.replace('</application>', `${block}</application>`);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<application>\n${block}</application>\n`;
  }

  const kept = [...component[1].matchAll(/<option name="([^"]+)" value="([^"]*)"\s*\/>/g)]
    .filter((match) => !managedKeys.has(match[1]))
    .map((match) => `  <option name="${match[1]}" value="${match[2]}" />`);
  // No leading indent on the opening tag: the match starts AT `<component`, so
  // the file's own indentation stays in front of it — which is what makes a
  // second setup produce byte-identical output instead of drifting.
  const rebuilt = [
    '<component name="HttpConfigurable">',
    `  <!-- ${MARKER}: manual proxy to the OCR forward proxy. Removed by \`ocr teardown jetbrains-proxy\`. -->`,
    ...managed.map(([key, value]) => `  <option name="${key}" value="${value}" />`),
    ...kept,
    '</component>',
  ].join('\n');
  return xml.replace(component[0], rebuilt);
}

/**
 * Undo the takeover WITHOUT a backup — only possible while our marker is still
 * in the file. The IDE rewrites proxy.settings.xml from memory on exit, which both
 * destroys the marker and can drop the backup's value, so teardown falls back
 * to this: remove the keys we own, and the whole component when nothing of the
 * operator's is left in it.
 *
 * Returns null when the component is not ours — a file we never wrote must
 * never be "unpatched", or teardown would quietly disable someone's own proxy.
 */
export function stripManagedProxyBlock(xml: string): string | null {
  const component = xml.match(COMPONENT_RE);
  if (!component || !component[1].includes(MARKER)) return null;
  const kept = [...component[1].matchAll(OPTION_RE)]
    .filter((match) => !(MANAGED_PROXY_KEYS as readonly string[]).includes(match[1]))
    .map((match) => `  <option name="${match[1]}" value="${match[2]}" />`);
  if (!kept.length) {
    // Nothing but our keys was in there: drop the component, leaving the rest
    // of the application file exactly as the IDE wrote it.
    return xml.replace(component[0], '').replace(/\n{3,}/g, '\n\n');
  }
  const rebuilt = [
    '<component name="HttpConfigurable">',
    ...kept,
    '</component>',
  ].join('\n');
  return xml.replace(component[0], rebuilt);
}

/** Absolute path of the truststore the IDE's JBR actually reads. */
export function ideaTruststorePath(home: string): string {
  return path.join(installBase(home), 'jbr', 'lib', 'security', 'cacerts');
}

function ideaKeytoolPath(home: string): string {
  return path.join(installBase(home), 'jbr', 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
}

/** Is the OCR root already in the truststore the JBR will actually read (alias-scoped)? */
async function caAliasPresent(home: string): Promise<boolean | 'unknown'> {
  const store = ideaTruststorePath(home);
  const keytool = ideaKeytoolPath(home);
  if (!fs.existsSync(keytool)) return 'unknown';
  // A read-only install is trusted through the copy, so that is the store to ask.
  const effective = fs.existsSync(store) && isWritable(store) ? store : ideaTruststoreCopyPath();
  if (!fs.existsSync(effective)) return 'unknown';
  const { ok } = await runCommand(
    exeForShell(keytool),
    ['-list', '-alias', JETBRAINS_CA_ALIAS, '-keystore', effective, '-storepass', JBR_STOREPASS],
    15000,
  );
  return ok;
}

/**
 * Is the MITM root trusted where THIS product actually reads trust from?
 *
 * Two placements are legitimate: the install's own JBR store (writable install)
 * or the OCR_HOME copy the product's user vmoptions point at (read-only install,
 * e.g. under `C:\Program Files`). Asking only the install store reports "absent"
 * on a machine whose TLS already works, and the operator is sent to re-run setup
 * forever — the observed state on a real GoLand/IDEA pair.
 */
async function caTrustedForProduct(
  install: JetBrainsInstall,
  product: JetBrainsProduct,
  configDir: string | null,
): Promise<boolean | 'unknown'> {
  const verdict = await caAliasPresent(install.home);
  if (verdict === true || !configDir) return verdict;
  const vmOptions = vmOptionsPath(configDir, product.stem);
  if (!fs.existsSync(vmOptions)) return verdict;
  // Only ACTIVE lines count: a parked `# omnicell-router-managed (disabled): -D…`
  // line names a store the JVM no longer reads.
  const store = fs
    .readFileSync(vmOptions, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .map((line) => /^-Djavax\.net\.ssl\.trustStore=(.+)$/.exec(line.trim())?.[1]?.trim())
    .find(Boolean);
  if (!store || !fs.existsSync(store)) return verdict;
  const keytool = ideaKeytoolPath(install.home);
  if (!fs.existsSync(keytool)) return verdict;
  const { ok } = await runCommand(
    exeForShell(keytool),
    ['-list', '-alias', JETBRAINS_CA_ALIAS, '-keystore', store, '-storepass', JBR_STOREPASS],
    15000,
  );
  return ok ? true : verdict;
}

/**
 * Import into an EXPLICIT store — used for both the IDE's own cacerts and the
 * read-only-install copy, so the two paths cannot drift in their keytool flags.
 *
 * A pre-existing alias is deleted first: re-importing a CHANGED root (OCR_HOME
 * moved, CA regenerated) would otherwise fail with "Certificate already exists"
 * and leave the IDE trusting the old root while every setup reports success.
 */
async function importCaIntoStore(store: string, keytool: string, caPath: string): Promise<{ ok: boolean; detail?: string }> {
  if (!fs.existsSync(store)) return { ok: false, detail: `IDE truststore not found at ${store}` };
  if (!fs.existsSync(keytool)) return { ok: false, detail: `keytool not found at ${keytool}` };
  await runCommand(exeForShell(keytool), ['-delete', '-alias', JETBRAINS_CA_ALIAS, '-keystore', store, '-storepass', JBR_STOREPASS], 15000);
  const { ok, stderr } = await runCommand(
    exeForShell(keytool),
    [
      '-importcert',
      '-noprompt',
      '-alias',
      JETBRAINS_CA_ALIAS,
      '-file',
      caPath,
      '-keystore',
      store,
      '-storepass',
      JBR_STOREPASS,
    ],
    20000,
  );
  return ok ? { ok } : { ok, detail: stderr.trim().split('\n').slice(-2).join(' ') };
}

/**
 * The IDE's OWN per-host acceptance store.
 *
 * The "untrusted server certificate" dialog's *"accept as trusted certificate"*
 * button does not touch JBR's keystore — it pins the leaf it was shown into
 * `<config>/ssl/cacerts` under the HOST NAME as the alias. So a machine that ever
 * clicked it while the proxy intercepted that host keeps trusting OUR forged leaf
 * for that host forever, even after the proxy stops touching it.
 */
export function ideSslTrustPath(configDir: string): string {
  return path.join(configDir, 'ssl', 'cacerts');
}

/**
 * Delete the host-scoped pins that hold OUR forged leaf.
 *
 * Only an alias whose certificate actually names our CA is removed, and only for
 * the hosts this adapter now bypasses: an operator-accepted corporate root under
 * the same alias is left alone (we check the issuer, not just the name). Best
 * effort by design — a missing store, a missing keytool or a locked file simply
 * leaves the pin in place; none of that can fail the takeover.
 *
 * `keytool` is a parameter (not looked up here) so a test can drive the whole
 * decision with a fake tool that records argv.
 */
export async function purgePinnedMitmCerts(
  store: string,
  keytool: string,
  hosts: readonly string[] = JETBRAINS_PROXY_EXCEPTIONS,
  caCommonName: string = CA_CN,
): Promise<string[]> {
  if (!fs.existsSync(store) || !fs.existsSync(keytool)) return [];
  const purged: string[] = [];
  for (const host of hosts) {
    const alias = host.trim();
    // Wildcards cannot be aliases; loopback pins are the operator's own.
    if (!alias || alias.includes('*') || /^(localhost|127\.|::1$)/.test(alias)) continue;
    const base = ['-keystore', store, '-storepass', JBR_STOREPASS, '-alias', alias];
    const listed = await runCommand(exeForShell(keytool), ['-list', '-v', ...base], 15000);
    // Both `-list -v` and the subsequent delete need the alias to exist; a
    // non-zero exit for a missing alias is the common case, not an error.
    if (!listed.ok) continue;
    const detail = `${listed.stdout}
${listed.stderr}`;
    if (!detail.includes(caCommonName)) continue;
    const deleted = await runCommand(exeForShell(keytool), ['-delete', ...base], 15000);
    if (deleted.ok) purged.push(alias);
  }
  return purged;
}

/** Remove exactly the alias this adapter added. */
async function removeCa(home: string): Promise<boolean> {
  const store = ideaTruststorePath(home);
  const keytool = ideaKeytoolPath(home);
  if (!fs.existsSync(store) || !fs.existsSync(keytool)) return false;
  const { ok } = await runCommand(
    exeForShell(keytool),
    ['-delete', '-alias', JETBRAINS_CA_ALIAS, '-keystore', store, '-storepass', JBR_STOREPASS],
    15000,
  );
  return ok;
}

/** Where our read-only-install truststore copy lives (stable across IDE updates). */
export function ideaTruststoreCopyPath(): string {
  return path.join(getOcrHomeDir(), 'jbr', 'cacerts');
}

/** How the IDE ends up trusting the MITM root. */
export interface IdeaTrustOutcome {
  ok: boolean;
  /** `store` = imported into the IDE's own cacerts; `vmoptions` = copy + JVM `-D` override. */
  mode: 'store' | 'vmoptions' | 'none';
  truststore?: string;
  detail?: string;
}

/**
 * Make the IDE's JBR trust the MITM root, editing the vendor keystore only when
 * it is actually writable.
 *
 * A Toolbox install lives under `%LOCALAPPDATA%\Programs` and its cacerts IS
 * writable; a system-wide install under `C:\Program Files` is not, and writing
 * there would need an elevation prompt the setup click cannot satisfy. The
 * fallback is the standard JBR escape hatch: copy the stock store once, keep the
 * copy current with the MITM root, and point the IDE's user vmoptions at it.
 */
async function ensureTrust(
  install: JetBrainsInstall,
  product: JetBrainsProduct,
  configDir: string,
  caPath: string,
): Promise<IdeaTrustOutcome> {
  const store = ideaTruststorePath(install.home);
  const keytool = ideaKeytoolPath(install.home);
  if (!fs.existsSync(store)) return { ok: false, mode: 'none', detail: `IDE truststore not found at ${store}` };
  if (!fs.existsSync(keytool)) return { ok: false, mode: 'none', detail: `keytool not found at ${keytool}` };

  if (isWritable(store)) {
    const imported = await importCaIntoStore(store, keytool, caPath);
    return imported.ok
      ? { ok: true, mode: 'store', truststore: store }
      : { ok: false, mode: 'none', detail: imported.detail };
  }

  const copy = ideaTruststoreCopyPath();
  try {
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    // Refresh from the stock store when the IDE was updated: the copy must keep
    // every vendor root, and a stale copy silently breaks unrelated TLS.
    const stockNewer = !fs.existsSync(copy) || fs.statSync(store).mtimeMs > fs.statSync(copy).mtimeMs;
    if (stockNewer) fs.copyFileSync(store, copy);
  } catch (err) {
    return { ok: false, mode: 'none', detail: `Could not copy the IDE truststore: ${err instanceof Error ? err.message : String(err)}` };
  }

  const imported = await importCaIntoStore(copy, keytool, caPath);
  if (!imported.ok) return { ok: false, mode: 'vmoptions', truststore: copy, detail: imported.detail };

  try {
    const vmOptions = vmOptionsPath(configDir, product.stem);
    const existing = fs.existsSync(vmOptions) ? fs.readFileSync(vmOptions, 'utf8') : '';
    fs.mkdirSync(path.dirname(vmOptions), { recursive: true });
    fs.writeFileSync(vmOptions, patchVmOptions(existing, copy), 'utf8');
  } catch (err) {
    return {
      ok: false,
      mode: 'vmoptions',
      truststore: copy,
      detail: `Could not write ${vmOptionsPath(configDir, product.stem)}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, mode: 'vmoptions', truststore: copy };
}

/**
 * Revoke BOTH trust paths: the user vmoptions block and the alias in our copy.
 *
 * The copy itself is kept — it is a stock-store snapshot other IDEs on this
 * machine may already be pointed at; deleting it would break them on restart.
 */
async function removeTrust(
  install: JetBrainsInstall | null,
  product: JetBrainsProduct,
  configDir: string | null,
): Promise<{ vmOptions: boolean; store: boolean; copy: boolean }> {
  const out = { vmOptions: false, store: false, copy: false };
  if (configDir) {
    const vmOptions = vmOptionsPath(configDir, product.stem);
    if (fs.existsSync(vmOptions)) {
      const text = fs.readFileSync(vmOptions, 'utf8');
      const stripped = stripVmOptions(text);
      if (stripped !== text) {
        try {
          if (stripped.trim()) fs.writeFileSync(vmOptions, stripped, 'utf8');
          else fs.rmSync(vmOptions, { force: true });
          out.vmOptions = true;
        } catch {
          /* locked file: the warning path reports it */
        }
      }
    }
  }
  if (install) out.store = await removeCa(install.home);
  const copy = ideaTruststoreCopyPath();
  const keytool = install ? ideaKeytoolPath(install.home) : null;
  if (keytool && fs.existsSync(copy) && fs.existsSync(keytool)) {
    const { ok } = await runCommand(
      exeForShell(keytool),
      ['-delete', '-alias', JETBRAINS_CA_ALIAS, '-keystore', copy, '-storepass', JBR_STOREPASS],
      15000,
    );
    out.copy = ok;
  }
  return out;
}

/**
 * The gateway key Junie's model profiles authenticate with.
 *
 * Resolution order is deliberate: the console picker wins (the operator may have
 * bound a metered key on purpose), then a key this hook created earlier, then any
 * usable key — and only when nothing is usable do we mint a dedicated `JetBrains`
 * key, because a fresh machine has none and a setup click that ends with a
 * 401-on-every-turn "installed" agent is worse than creating one credential.
 *
 * `IntelliJ IDEA` is the name older setups minted (this hook was IDEA-only):
 * existing installs must keep using that credential, so it is still preferred
 * over an arbitrary usable key.
 */
const JUNIE_KEY_NAMES = ['JetBrains', 'IntelliJ IDEA'];

function resolveJunieKey(explicit?: string, existing?: ApiKeyConfig[]): { key: string; created: boolean } | null {
  const trimmed = explicit?.trim();
  if (trimmed) return { key: trimmed, created: false };
  const keys = existing ?? listApiKeys();
  const dedicated = keys.find((k) => JUNIE_KEY_NAMES.includes(k.name) && isApiKeyUsable(k));
  if (dedicated?.key) return { key: dedicated.key, created: false };
  const usable = keys.find((k) => isApiKeyUsable(k));
  if (usable?.key) return { key: usable.key, created: false };
  const created = createApiKey({ name: 'JetBrains', description: 'Created by `ocr setup jetbrains-proxy` for the Junie agent model list.' });
  return created.success && created.data?.key ? { key: created.data.key, created: true } : null;
}

/**
 * Is this IDE running? It rewrites proxy.settings.xml from memory on exit, which
 * is why setup/teardown say "re-run after quitting" instead of refusing.
 *
 * Windows asks tasklist for the exact image name (CSV + /NH: no localized table
 * header, one quoted row per match, so the test cannot depend on console
 * encoding); elsewhere pgrep matches the launcher path of the app bundle.
 */
async function isProductRunning(product: JetBrainsProduct): Promise<boolean> {
  if (process.platform !== 'win32') {
    const { ok, stdout } = await runCommand('pgrep', ['-f', product.stem], 5000);
    return ok && stdout.trim().length > 0;
  }
  const image = `${product.stem}64.exe`;
  const { ok, stdout } = await runCommand('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], 8000);
  return ok && stdout.toLowerCase().includes(`"${image.toLowerCase()}"`);
}


/**
 * `runCommand` spawns through cmd.exe on Windows WITHOUT quoting the command
 * itself (only the args are quoted), so an executable under a path with a space
 * — every JetBrains install is `...\IntelliJ IDEA 2026.1\` — must be pre-quoted
 * or cmd splits it at the space and reports "not recognized as a command".
 */
function exeForShell(exe: string): string {
  return process.platform === 'win32' && exe.includes(' ') ? `"${exe}"` : exe;
}

/** True when something is accepting connections on the forward-proxy port. */
async function probePort(port: number, host = '127.0.0.1'): Promise<boolean> {
  const net = await import('node:net');
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export class JetBrainsProxyClientAdapter implements ClientAdapter {
  name = 'jetbrains-proxy' as const;
  hookKind = 'proxy-config' as const;
  /** Family title: the console card lists the products inside, and every action
   *  can be narrowed to one of them with `product`. */
  displayName = 'JetBrains IDEs';

  getConfigPath(): string {
    // The takeover IS this file: the IDE's own HttpConfigurable, restored from
    // `*.ocr-backup` on teardown. With several products the primary one is the
    // first that already has a config root.
    for (const state of detectJetBrainsProducts()) {
      if (state.settingsFile) return state.settingsFile;
      if (state.configDir) return proxySettingsPath(state.configDir);
    }
    return productConfigPlaceholder(JETBRAINS_PRODUCTS[0]);
  }

  async getStatus(): Promise<Omit<ClientHookStatus, 'hookKind'>> {
    const fp = resolveForwardProxyEndpoint();
    const live = getForwardProxyStatus();
    const detected = detectJetBrainsProducts();
    // The singleton only knows about an IN-PROCESS proxy; a status poll from a
    // standalone `ocr` CLI would otherwise report "not running" against a live
    // listener. Trust the socket when the singleton has nothing to say.
    const proxyLive = live.running || (fp ? await probePort(fp.port) : false);
    const proxyNote = `forward proxy ${proxyLive ? `running on port ${live.port ?? fp?.port ?? '?'}` : 'NOT running (start the gateway)'}`;

    // Per-product facts, computed ONCE: the console's nested panels show each
    // IDE's own state, and the family line aggregates the same numbers.
    const facts = [] as Array<{
      state: JetBrainsProductState;
      caTrusted: boolean | 'unknown';
      junie: { version: string } | null;
      artifacts: ClientArtifact[];
    }>;
    for (const state of detected) {
      // CA trust is per install (every IDE ships its own JBR, and a read-only
      // install trusts through the vmoptions copy), so every product is asked.
      const caTrusted = state.install ? await caTrustedForProduct(state.install, state.product, state.configDir) : 'unknown';
      // Agent-mode provisioning is part of "hooked", so the card can tell an
      // operator mid-way through "proxy done, agent missing" from "all set".
      const junie = state.configDir ? detectAcpInstalls(acpAgentsDir(state.configDir), 'junie')[0] ?? null : null;
      const artifacts: ClientArtifact[] = [];
      if (state.settingsFile) artifacts.push({ path: state.settingsFile, exists: state.exists });
      if (state.configDir) {
        artifacts.push({ path: ideaBackupPath(state.configDir), exists: state.backupExists });
        artifacts.push({ path: path.join(acpAgentsDir(state.configDir), 'junie'), exists: !!junie });
      }
      facts.push({ state, caTrusted, junie: junie ? { version: junie.version } : null, artifacts });
    }

    // The family verdict covers the HOOKED products — an unhooked sibling has no
    // reason to trust the root, and reporting its "absent" would make a working
    // takeover look broken.
    const anyHooked = facts.some((fact) => fact.state.hooked);
    const scoped = anyHooked ? facts.filter((fact) => fact.state.hooked) : facts;
    const caVerdicts = scoped.map((fact) => fact.caTrusted);
    const caTrusted = caVerdicts.includes(false) ? false : caVerdicts.includes(true) ? true : 'unknown';
    const caNote = `CA in IDE truststore: ${caTrusted === true ? 'imported' : caTrusted === false ? 'absent' : 'unknown'}`;
    const agentNote = facts.some((fact) => fact.junie)
      ? `Junie ${facts.filter((fact) => fact.junie).map((fact) => `${fact.junie!.version} in ${fact.state.product.displayName}`).join(', ')}`
      : 'Junie not installed (setup downloads it)';
    const modelNote = junieModelsPresent() ? 'OCR model list present' : 'OCR model list missing (setup writes it)';

    const products: ClientProductStatus[] = facts.map((fact) => ({
      id: fact.state.product.id,
      displayName: fact.state.product.displayName,
      version: fact.state.version,
      configPath: fact.state.settingsFile ?? productConfigPlaceholder(fact.state.product),
      exists: fact.state.exists,
      hooked: fact.state.hooked,
      backupExists: fact.state.backupExists,
      caTrusted: fact.caTrusted,
      junieVersion: fact.junie?.version ?? null,
      artifacts: fact.artifacts,
    }));

    const artifacts = facts.flatMap((fact) => fact.artifacts);

    let details: string;
    if (!detected.length) {
      details =
        `No supported JetBrains IDE detected (${JETBRAINS_PRODUCTS.map((p) => p.displayName).join(', ')}) — install one under %LOCALAPPDATA%\\Programs or JetBrains Toolbox, or point ${JETBRAINS_PRODUCTS.map((p) => p.envHome).join(' / ')} at its install root`;
    } else if (!fp) {
      details = 'forwardProxy disabled in config.yaml — enable it before hooking the IDE';
    } else {
      const perProduct = detected.map((state) => {
        const label = `${state.product.displayName} ${state.version ?? ''}`.trim();
        if (!state.configDir || !state.settingsFile) return `${label} — no config root yet (start it once, then retry)`;
        const own = state.exists ? readProxySettings(fs.readFileSync(state.settingsFile, 'utf8')) : null;
        if (!state.hooked) {
          // What the file should look like after a takeover — used for the
          // details line only, never for the hooked verdict (ownership, not
          // coincidence: an identical manual proxy of the operator's is not ours).
          const pointsAtProxy = !!own && own.httpProxy && !own.pac && own.host === '127.0.0.1' && own.port === fp.port;
          return `${label} at ${state.install?.home ?? '?'} — proxy not hooked (run setup)${pointsAtProxy ? '; its own settings already point at this host/port, setup will adopt them and back them up' : ''}`;
        }
        const bypassCount = (own?.exceptions ?? JETBRAINS_NO_PROXY).split(',').filter((h) => h.trim()).length;
        return `${label} starts through ${fp.url} (manual proxy, ${bypassCount} direct-bypass hosts)`;
      });
      const restartNote = detected.some((state) => state.hooked)
        ? '; restart the IDE to apply — quit it before re-running setup, it rewrites proxy.settings.xml on exit'
        : '';
      details = `${perProduct.join('; ')}; ${proxyNote}; ${caNote}; ${agentNote}; ${modelNote}${restartNote}`;
    }

    return {
      name: this.name,
      displayName: this.displayName,
      configPath: this.getConfigPath(),
      exists: detected.some((state) => state.exists),
      hooked: detected.some((state) => state.hooked),
      backupExists: detected.some((state) => state.backupExists),
      details: details.trim(),
      products,
      ...(artifacts.length ? { artifacts } : {}),
      // The gateway plugin owns model selection; IDE AI models are not ours to pick.
      modelSlots: [],
    };
  }

  /** `product` = hook ONLY that product; absent = every detected product. */
  async setup(options?: { port?: number; apiKey?: string; product?: string }): Promise<ClientActionResult> {
    const fp = resolveForwardProxyEndpoint();
    if (!fp) {
      return {
        success: false,
        reasonCode: 'forward_proxy_disabled',
        message:
          'forwardProxy is not enabled in config.yaml — set `forwardProxy.enabled: true` (and keep the gateway running) before hooking the IDE.',
      };
    }
    if (!fs.existsSync(fp.caPath)) {
      return {
        success: false,
        reasonCode: 'forward_proxy_ca_missing',
        params: { path: fp.caPath },
        message: `Forward-proxy MITM CA not found at ${fp.caPath} — it is generated when the gateway boots with forwardProxy enabled. Start the gateway and retry.`,
      };
    }
    // The console/CLI names a product; the adapter never invents one.
    const requested = options?.product ? jetbrainsProduct(options.product) : null;
    if (options?.product && !requested) {
      return {
        success: false,
        reasonCode: 'client_not_found',
        message: `Unknown JetBrains product '${options.product}'. Supported: ${JETBRAINS_PRODUCTS.map((p) => `${p.id} (${p.displayName})`).join(', ')}`,
      };
    }

    const detected = detectJetBrainsProducts();
    const targets = requested ? detected.filter((state) => state.product.id === requested.id) : detected;
    if (!targets.length) {
      return {
        success: false,
        reasonCode: 'client_not_found',
        message: requested
          ? `${requested.displayName} not detected. Install it under %LOCALAPPDATA%\\Programs or JetBrains Toolbox, or set ${requested.envHome} to the install root.`
          : `No supported JetBrains IDE detected (${JETBRAINS_PRODUCTS.map((p) => p.displayName).join(', ')}). Install one under %LOCALAPPDATA%\\Programs or JetBrains Toolbox, or point ${JETBRAINS_PRODUCTS.map((p) => p.envHome).join(' / ')} at its install root.`,
      };
    }

    // A running IDE is NOT a hard stop: the patch is what a restart picks up,
    // and the operator is usually mid-session when they ask for it. What we
    // cannot promise is durability — the IDE rewrites proxy.settings.xml from
    // its in-memory state on exit, so the write can be undone. Say that as an
    // advisory instead of refusing the whole setup (setup is idempotent).
    const running = (
      await Promise.all(
        targets.filter((state) => state.install && state.configDir).map((state) => isProductRunning(state.product)),
      )
    ).some(Boolean);

    // Migration: this adapter used to publish a launcher. The hook no longer
    // needs one (the IDE reads the file at startup), so drop the orphan — a
    // stale script would wrongly imply the takeover only happens when it is used.
    const stale = staleLauncherPath();
    if (fs.existsSync(stale)) fs.rmSync(stale, { force: true });

    const hooked: Array<{
      state: JetBrainsProductState;
      settings: string;
      backup: string | null;
      trusts: IdeaTrustOutcome[];
    }> = [];
    const refused: string[] = [];
    for (const state of targets) {
      if (!state.install || !state.configDir || !state.settingsFile) {
        refused.push(`${state.product.displayName} (${!state.install ? 'not installed' : 'no config root yet — start it once'})`);
        continue;
      }
      const settingsFile = state.settingsFile;
      const backup = ideaBackupPath(state.configDir);
      if (fs.existsSync(settingsFile) && !fs.existsSync(backup)) {
        fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
        fs.copyFileSync(settingsFile, backup);
      }
      const original = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '';
      // Keep whatever the operator had listed as exceptions and append ours —
      // the patch is a flat-file takeover of ONE option, and silently dropping a
      // corporate exception would send that host through the proxy from now on.
      const patched = patchProxySettingsXml(original, {
        host: '127.0.0.1',
        port: fp.port,
        exceptions: mergeProxyExceptions(readProxySettings(original).exceptions),
      });
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, patched, 'utf8');

      // EVERY install of the same build for THIS product, not just the detected
      // one: a stale in-place-upgraded copy plus a fresh Program Files copy is a
      // normal state, and a CA imported into the other one only shows up as a
      // TLS failure in the IDE the operator actually launches.
      const installs = detectProductInstallsForHook(state.product);
      const pool = installs.length ? installs : [state.install];
      const trusts: IdeaTrustOutcome[] = [];
      for (const install of pool) trusts.push(await ensureTrust(install, state.product, state.configDir, fp.caPath));
      // Clean up what the previous posture left behind: while everything was
      // intercepted, clicking "accept as trusted" in the dialog pinned our forged
      // leaf per host in the IDE's own store. Those hosts are bypassed now, so the
      // pins are dead weight — and a forged anchor nobody revalidates.
      if (pool[0]) await purgePinnedMitmCerts(ideSslTrustPath(state.configDir), ideaKeytoolPath(pool[0].home));
      hooked.push({ state, settings: settingsFile, backup: fs.existsSync(backup) ? backup : null, trusts });
    }

    if (!hooked.length) {
      const noConfig = targets.filter((state) => state.install && !state.configDir);
      return noConfig.length
        ? {
            success: false,
            reasonCode: 'client_config_missing',
            message: `No ${noConfig.map((state) => state.product.displayName).join(', ')} config directory under ${path.join(roamingAppData(), 'JetBrains')} — start the IDE once so it creates one, then retry.`,
          }
        : { success: false, reasonCode: 'client_not_found', message: `No hookable JetBrains IDE: ${refused.join(', ')}.` };
    }

    // ---- Fresh-machine provisioning (best-effort; the hooks above already landed) ----
    //
    // Agent: the IDE's own downloader is the least reliable part of a first run
    // (215 MB from GitHub, no resume, retried forever). Installing it here also
    // seeds the manager's staging path so the IDE promotes instead of
    // re-fetching. The archive is cached under OCR_HOME, so the second IDE
    // extracts the same download instead of fetching it again.
    const agents: Array<{ product: JetBrainsProduct; result: JunieInstallResult }> = [];
    for (const target of hooked) {
      agents.push({
        product: target.state.product,
        result: await ensureAcpAgent({ configDir: target.state.configDir as string }),
      });
    }
    // Model list: without this, Agent mode uses Junie's cloud default, which is
    // not the operator's gateway — and in some regions is not reachable at all.
    // It is GLOBAL (~/.junie), so it is written once for the family.
    const junieKey = resolveJunieKey(options?.apiKey);
    // VERIFIED URL: the config's port is not necessarily the one serving right now
    // (dev boots with PORT=4700, an installed sidecar may hold 4000 with a different
    // key set) — see `resolveGatewayBaseUrl`.
    const gateway = junieKey ? await resolveGatewayBaseUrl(junieKey.key) : null;
    const models = junieKey && gateway ? writeJunieModels(gateway.url, junieKey.key) : null;

    // The IDEs resolve the MITM root from their OWN truststore (JBR cacerts) or
    // the copy their vmoptions point at — the OS-store verdict the shared
    // collector probes is not the gate here, so its CA codes are dropped and
    // replaced by the outcome of the trust step itself.
    const warnings = (await collectHookWarnings(fp, fp.port)).filter(
      (w) => w.code !== 'ca_not_trusted' && w.code !== 'ca_trust_unknown',
    );
    for (const target of hooked) {
      const copyTrust = target.trusts.find((outcome) => outcome.ok && outcome.mode === 'vmoptions');
      if (copyTrust) {
        // Worth SAYING, not worth failing: the IDE only reads the copy on its next start.
        warnings.push({ code: 'ide_truststore_readonly', params: { path: copyTrust.truststore ?? ideaTruststoreCopyPath() } });
      } else if (!target.trusts.some((outcome) => outcome.ok)) {
        warnings.push({ code: 'ca_trust_unknown', params: { path: fp.caPath, detail: target.trusts[0]?.detail ?? '' } });
      }
    }
    for (const agent of agents) {
      if (!agent.result.ok) {
        warnings.push({
          code: 'junie_install_failed',
          params: { detail: `${agent.product.displayName}: ${agent.result.detail ?? 'unknown error'}` },
        });
      }
    }
    if (!models || !models.ok) {
      warnings.push({
        code: 'junie_models_failed',
        params: { detail: models?.detail ?? 'no usable API key — create one on the API Keys page and re-run setup' },
      });
    } else if (gateway && !gateway.reachable) {
      // The list is written against the best candidate, but nothing answered for
      // this key: say so instead of shipping a URL that will 401 later.
      warnings.push({
        code: 'junie_models_failed',
        params: {
          detail: `the gateway did not answer an authenticated /v1/models on ${gateway.url} — start it, then re-run setup so the Junie profiles point at the live port`,
        },
      });
    }
    if (warnings.some((w) => w.code === 'proxy_not_running') && (await probePort(fp.port))) {
      // A standalone `ocr setup` has no in-process proxy status (the singleton
      // is only set by a gateway boot), so the shared collector reports
      // "not running" against a perfectly live listener. Trust the socket.
      const idx = warnings.findIndex((w) => w.code === 'proxy_not_running');
      if (idx >= 0) warnings.splice(idx, 1);
    }
    if (running) warnings.push({ code: 'ide_running' });

    // Both outcomes can be true at once (one writable install, one under Program
    // Files), so the note reports each instead of the first success.
    const trustOutcomes = hooked.flatMap((target) => target.trusts);
    const storeCount = trustOutcomes.filter((outcome) => outcome.ok && outcome.mode === 'store').length;
    const copyOutcome = trustOutcomes.find((outcome) => outcome.ok && outcome.mode === 'vmoptions');
    const trustNote = [
      storeCount ? `CA imported as ${JETBRAINS_CA_ALIAS} into ${storeCount} IDE truststore${storeCount === 1 ? '' : 's'}` : '',
      copyOutcome
        ? `CA imported into ${copyOutcome.truststore ?? ideaTruststoreCopyPath()} (that install's truststore is read-only, its vmoptions point at the copy)`
        : '',
      !storeCount && !copyOutcome ? `CA NOT imported — ${trustOutcomes[0]?.detail ?? 'manual import required'}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    const agentNote = agents
      .map((agent) => {
        const label = agent.product.displayName;
        if (!agent.result.ok) return `${label}: Junie NOT installed`;
        return `${label}: Junie ${agent.result.version ?? ''} ${agent.result.installed ? 'installed' : 'already present'}`.replace(/\s+/g, ' ').trim();
      })
      .join('; ');
    const modelNote = models?.ok
      ? `OCR model list written against ${gateway?.url ?? '?'} (${models.files.length} profiles, default ${models.model}${junieKey?.created ? ', key created' : ''}${gateway && !gateway.reachable ? ', NOT reachable yet' : ''})`
      : 'OCR model list NOT written';
    const hookNote = hooked
      .map((target) => `${`${target.state.product.displayName} ${target.state.version ?? ''}`.trim()} → ${target.settings}`)
      .join('; ');

    return {
      success: true,
      params: { settings: hooked[0].settings, proxy: fp.url, backup: hooked[0].backup ?? '' },
      message:
        `Hooked ${hookNote}` +
        (refused.length ? `; skipped ${refused.join(', ')}` : '') +
        `; ${trustNote}; ${agentNote}; ${modelNote}` +
        '. Restart the IDE to apply; if it was running during this setup, run setup once more after quitting it (the IDE rewrites proxy.settings.xml from memory on exit).',
      warnings: warnings.length ? warnings : undefined,
    };
  }

  /** Re-apply the proxy block to a config changed after setup (port moves, IDE update). */
  async refreshProfileBindings(): Promise<ClientActionResult> {
    return this.setup();
  }

  /** `product` = unhook ONLY that product; absent = all of them. */
  async teardown(options?: { product?: string }): Promise<ClientActionResult> {
    const requested = options?.product ? jetbrainsProduct(options.product) : null;
    if (options?.product && !requested) {
      return {
        success: false,
        reasonCode: 'client_not_found',
        message: `Unknown JetBrains product '${options.product}'. Supported: ${JETBRAINS_PRODUCTS.map((p) => p.id).join(', ')}`,
      };
    }
    const detected = detectJetBrainsProducts();
    const targets = requested ? detected.filter((state) => state.product.id === requested.id) : detected;
    const removed: string[] = [];
    // Same reasoning as setup: restore the bytes, then tell the operator the IDE
    // can put its in-memory state back on exit. Blocking here would leave an
    // unhookable client whenever the IDE happens to be open.
    const running = (await Promise.all(targets.filter((state) => state.install).map((state) => isProductRunning(state.product)))).some(Boolean);

    const stale = staleLauncherPath();
    if (fs.existsSync(stale)) {
      fs.rmSync(stale, { force: true });
      removed.push(stale);
    }

    let restored = false;
    let caRemoved = false;
    let copyRemoved = false;
    for (const state of targets) {
      if (state.configDir && state.settingsFile) {
        const backup = ideaBackupPath(state.configDir);
        if (fs.existsSync(backup)) {
          // The plain case: put the operator's own bytes back, then forget them.
          fs.copyFileSync(backup, state.settingsFile);
          fs.rmSync(backup, { force: true });
          removed.push(`${state.settingsFile} (restored)`);
          restored = true;
        } else if (fs.existsSync(state.settingsFile)) {
          // The backup is gone (an IDE restart can eat it together with the
          // patch). Still undo what is PROVABLY ours: the marker survives only in
          // a file we wrote, so a foreign config is never touched.
          const stripped = stripManagedProxyBlock(fs.readFileSync(state.settingsFile, 'utf8'));
          if (stripped !== null) {
            fs.writeFileSync(state.settingsFile, stripped, 'utf8');
            removed.push(`${state.settingsFile} (managed block removed — original backup was lost)`);
            restored = true;
          }
        }
      }
      // Fan out for the same reason setup does: more than one install may carry
      // our alias.
      const others = detectProductInstallsForHook(state.product).filter((candidate) => candidate.home !== state.install?.home);
      const installs = state.install ? [state.install, ...others] : others;
      let vmOptions = false;
      for (const install of installs) {
        const outcome = await removeTrust(install, state.product, state.configDir);
        vmOptions ||= outcome.vmOptions;
        caRemoved ||= outcome.store;
        copyRemoved ||= outcome.copy;
      }
      if (vmOptions && state.configDir) {
        removed.push(`${vmOptionsPath(state.configDir, state.product.stem)} (managed block removed)`);
      }
    }
    // Agent-mode provisioning is ours too, but the Junie model list is GLOBAL
    // (~/.junie): removing it while another IDE is still hooked would break that
    // one, so it only goes when no product remains taken over.
    const stillHooked = detectJetBrainsProducts().some((state) => state.hooked);
    const models = stillHooked ? { removed: [] as string[], configPath: '' } : removeJunieModels();
    removed.push(...models.removed);

    if (!restored && !caRemoved && !removed.length) {
      return {
        success: false,
        reasonCode: 'takeover_lost',
        params: { path: targets[0]?.settingsFile ?? 'proxy.settings.xml' },
        message:
          'No takeover to undo: the config backup is gone and the IDE truststore has no CA alias. The IDE most likely overwrote proxy.settings.xml from memory when it exited — quit it, run setup again, and the hook becomes removable again.',
      };
    }
    return {
      success: true,
      params: { removed: removed.join(', ') },
      message:
        `JetBrains unhooked: ${removed.length ? removed.join(', ') : 'no files'}` +
        `${caRemoved ? '; CA alias removed from the IDE truststore' : ''}` +
        `${copyRemoved ? '; CA alias removed from the truststore copy' : ''}` +
        `${models.removed.length ? `; ${models.removed.length} OCR model profiles removed from Junie` : stillHooked ? '; Junie model list kept — another hooked IDE still uses it' : ''}` +
        '. The Junie agent itself is kept — it is a normal agent install and can be used with your own account.',
      warnings: running ? [{ code: 'ide_running' }] : undefined,
    };
  }
}

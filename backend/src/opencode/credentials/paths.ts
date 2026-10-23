import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Path registry for the credential adapter layer.
 *
 * This module is the ONLY place under credentials/ that reads process env or
 * the OS home directory (via resolveDefaultPaths' default parameters).
 * Everything else takes an injected CredentialPaths so that tests run fully
 * sandboxed.
 *
 * Path precedents:
 *  - configDir / dataDir / auth.json  -> user-config.ts:30-33, 48-50 (XDG-aware)
 *  - ocrHome                          -> cli/paths.ts:5-16 (without its mkdir side effect)
 *  - opencode.db / installed.version  -> new here (opencode v2 storage)
 */

export interface CredentialPaths {
  /** XDG_CONFIG_HOME || ~/.config, plus '/opencode'. */
  configDir: string;
  /** XDG_DATA_HOME || ~/.local/share, plus '/opencode'. */
  dataDir: string;
  /** opencode v1 credentials file — <dataDir>/auth.json. */
  authJsonPath: string;
  /** opencode v2 credentials database — <dataDir>/opencode.db. */
  opencodeDbPath: string;
  /** opencode v2 lagging version marker — <configDir>/installed.version. */
  installedVersionPath: string;
  /** OCR state root — OCR_HOME || ~/.onecast-router. */
  ocrHome: string;
  /**
   * User home — ONLY used for the legacy `~/.opencode/<file>` config fallback
   * (opencodeConfigCandidates). Injected/test path sets leave it unset and are
   * therefore hermetic: no candidate outside their own configDir is ever probed.
   */
  home?: string;
  /**
   * Service.json locations for opencode v2 -path Basic auth. Ordered: XDG-aware
   * configDir first, then the legacy home fallback — superset of
   * connector.ts:27-28 (which ignores XDG_CONFIG_HOME; touchpoint gap #5).
   */
  serviceJsonCandidates?: string[];
}

/** Reproduce the existing env-based resolution. The single env/homedir reader. */
export function resolveDefaultPaths(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homedir: string = os.homedir()
): CredentialPaths {
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(homedir, '.config');
  const configDir = path.join(xdgConfig, 'opencode');
  const xdgData = env.XDG_DATA_HOME || path.join(homedir, '.local', 'share');
  const dataDir = path.join(xdgData, 'opencode');
  // OCR_HOME empty/whitespace = unset (cli/paths.ts semantics, no mkdir here —
  // OcrStore creates the directory on first write).
  const ocrOverride = env.OCR_HOME?.trim();
  const ocrHome = ocrOverride ? path.resolve(ocrOverride) : path.join(homedir, '.onecast-router');
  return {
    configDir,
    dataDir,
    authJsonPath: path.join(dataDir, 'auth.json'),
    opencodeDbPath: path.join(dataDir, 'opencode.db'),
    installedVersionPath: path.join(configDir, 'installed.version'),
    ocrHome,
    home: homedir,
    serviceJsonCandidates: [
      path.join(configDir, 'service.json'),
      path.join(homedir, '.opencode', 'service.json'),
    ],
  };
}

/**
 * Where an opencode client keeps its config, in READ priority order: the XDG
 * configDir spellings first, then the legacy `~/.opencode/opencode.json`. The
 * FIRST entry (the jsonc) is also the default write target when nothing exists
 * yet — resolution and default must agree or a first push lands in a file the
 * next read would not prefer.
 *
 * This is the ONE place that knows the candidate list — the defs materializer
 * (write) and the one-shot def port (read) both resolve through it, so a push
 * can never land in a file the client does not read (the historical defect: the
 * port read `<configDir>/opencode.json` while the materializer wrote a fresh
 * `<configDir>/opencode.jsonc` next to it).
 */
export function opencodeConfigCandidates(paths: CredentialPaths): string[] {
  return [
    path.join(paths.configDir, 'opencode.jsonc'),
    path.join(paths.configDir, 'opencode.json'),
    ...(paths.home ? [path.join(paths.home, '.opencode', 'opencode.json')] : []),
  ];
}

/** First existing candidate (same order as opencodeConfigCandidates), else the jsonc default. */
export function resolveOpencodeConfigPath(paths: CredentialPaths = resolveDefaultPaths()): string {
  const candidates = opencodeConfigCandidates(paths);
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0]!;
}

/** Centralized env access for consumers that need raw process.env. */
export function defaultEnv(): Readonly<Record<string, string | undefined>> {
  return process.env;
}

/** OcrStore file — GLOBAL (mirrors opencode's own global credential scope), not per-env. */
export function ocrCredentialsFile(paths: CredentialPaths = resolveDefaultPaths()): string {
  return path.join(paths.ocrHome, 'credentials.json');
}

/** Factory's binding record: the (single) landing plus the one-shot import markers. */
export function credentialStoreStateFile(paths: CredentialPaths = resolveDefaultPaths()): string {
  return path.join(paths.ocrHome, 'credential-store.json');
}

/**
 * Credential-sync state — per-client auto-sync toggles, last read/write
 * outcomes and the one-shot v2 migration marker. Same GLOBAL root as the
 * OCR credentials file. Display-safe metadata only (toggles, timestamps,
 * per-entry provider/action records — never key material).
 */
export function credentialSyncFile(paths: CredentialPaths = resolveDefaultPaths()): string {
  return path.join(paths.ocrHome, 'credential-sync.json');
}

/**
 * SUSPECT credential flags (Decision 6). Same GLOBAL root as the
 * OCR credentials file: an credential is suspect wherever it is used, not per
 * environment. Display-safe metadata only (keyHash prefixes, no key material).
 */
export function suspectCredentialsFile(paths: CredentialPaths = resolveDefaultPaths()): string {
  return path.join(paths.ocrHome, 'suspect-credentials.json');
}

/**
 * Breaker memory: the full state machine of
 * every model and pair breaker, so cooldowns and manual trips survive a
 * gateway restart. Display-safe metadata only (model ids, provider, keyHash
 * prefixes, classifier reasons — never key material). PER-ENV by filename:
 * records are pruned against the ACTIVE env's model set, so one shared file
 * would let an env switch destroy the other env's memory (the first save
 * after restore rewrites the whole file). Unlike the suspect flags — which
 * stay GLOBAL because an credential is suspect wherever it is used — breaker
 * memory is about model rotation, and that is per book-set.
 * `envName` is injected by the caller (BreakerStateStore resolves it from
 * peekEnvName) so this registry keeps reading no process env itself.
 */
export function breakerStateFile(
  paths: CredentialPaths = resolveDefaultPaths(),
  envName = 'default',
): string {
  return path.join(paths.ocrHome, `breaker-state.${envName}.json`);
}

export function serviceJsonCandidates(paths: CredentialPaths = resolveDefaultPaths()): string[] {
  // An injected CredentialPaths without candidates still resolves inside the
  // injected configDir only — never operator home.
  return paths.serviceJsonCandidates ?? [path.join(paths.configDir, 'service.json')];
}

/**
 * Quota snapshots: attached to (provider × keyHashPrefix) — the
 * credential-anchored identity — so they follow the suspect/disabled flags'
 * GLOBAL lifecycle ("an credential is an credential wherever it is used"), not the
 * per-env book-set. Display-safe metadata only (window numbers, prefixes,
 * plan labels — never key material).
 */
export function quotaSnapshotsFile(paths: CredentialPaths = resolveDefaultPaths()): string {
  return path.join(paths.ocrHome, 'quota-snapshots.json');
}

import os from 'node:os';
import path from 'node:path';

/**
 * ADR-0019 path registry for the credential adapter layer.
 *
 * This module is the ONLY place under credentials/ that reads process env or
 * the OS home directory (via resolveDefaultPaths' default parameters).
 * Everything else takes an injected CredentialPaths so that tests run fully
 * sandboxed (ADR-0018 spirit; ADR-0019 Decision 1/2 depend on it).
 *
 * Path precedents:
 *  - configDir / dataDir / auth.json  -> user-config.ts:30-33, 48-50 (XDG-aware)
 *  - ocrHome                          -> cli/paths.ts:5-16 (without its mkdir side effect)
 *  - opencode.db / installed.version  -> new here (ADR-0019 Context: opencode v2 storage)
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
  /** OCR state root — OCR_HOME || ~/.opencode-router. */
  ocrHome: string;
  /**
   * service.json locations for opencode v2 -path Basic auth. Ordered: XDG-aware
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
  const ocrHome = ocrOverride ? path.resolve(ocrOverride) : path.join(homedir, '.opencode-router');
  return {
    configDir,
    dataDir,
    authJsonPath: path.join(dataDir, 'auth.json'),
    opencodeDbPath: path.join(dataDir, 'opencode.db'),
    installedVersionPath: path.join(configDir, 'installed.version'),
    ocrHome,
    serviceJsonCandidates: [
      path.join(configDir, 'service.json'),
      path.join(homedir, '.opencode', 'service.json'),
    ],
  };
}

/** Centralized env access for consumers that need raw process.env. */
export function defaultEnv(): Readonly<Record<string, string | undefined>> {
  return process.env;
}

/** OcrStore file — GLOBAL (mirrors opencode's own global credential scope), not per-env. */
export function ocrCredentialsFile(paths: CredentialPaths = resolveDefaultPaths()): string {
  return path.join(paths.ocrHome, 'credentials.json');
}

/** Factory's last-known-good binding record (Decision 2 hysteresis). */
export function credentialStoreStateFile(paths: CredentialPaths = resolveDefaultPaths()): string {
  return path.join(paths.ocrHome, 'credential-store.json');
}

/**
 * ADR-0019 P3 — SUSPECT account flags (Decision 6). Same GLOBAL root as the
 * OCR credentials file: an account is suspect wherever it is used, not per
 * environment. Display-safe metadata only (keyHash prefixes, no key material).
 */
export function suspectAccountsFile(paths: CredentialPaths = resolveDefaultPaths()): string {
  return path.join(paths.ocrHome, 'suspect-accounts.json');
}

export function serviceJsonCandidates(paths: CredentialPaths = resolveDefaultPaths()): string[] {
  // An injected CredentialPaths without candidates still resolves inside the
  // injected configDir only — never operator home.
  return paths.serviceJsonCandidates ?? [path.join(paths.configDir, 'service.json')];
}

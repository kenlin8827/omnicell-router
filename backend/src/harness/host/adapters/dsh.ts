import fs from 'node:fs';
import path from 'node:path';
import { dshCliPath, dshDesktopCliPath, dshDesktopRunning, dshHome, dshProfilesDir } from '../../../cli/paths.js';
import { DSH_TIMEOUT_MS } from '../timeouts.js';
import { BaseHostAdapter } from './base.js';
import type { AdapterContext } from './types.js';
import type {
  ExtSource,
  PluginMarketplaceInstall,
  PluginSpec,
  PluginWriteTarget,
  SkillsSpec,
} from './types.js';
import type { HarnessScope } from '../../types.js';

/**
 * DSH (DeepSeek Harness) — a PROFILE-based runtime. A profile is a directory under
 * `$DSH_HOME/profiles/<name>` whose `package.json` carries `dsh.profile.bundles` (the active Cordis
 * layer stack) and `dependencies` (the pnpm-managed out-of-tree packages). There is no global
 * plugin list and no project landing: a plugin is installed INTO one profile.
 *
 * Verified against the vendor's own docs and CLI (2026-11-10):
 *   · install  `dsh plugin --profile <name> add <npm|github:owner/repo|path|tarball>`
 *   · remove   `dsh plugin --profile <name> remove <package>`
 *   · record   `dependencies` (package → spec) and `dsh.profile.bundles` (active bundles; in-box
 *              `@deepseek-ai/dsh-*` names appear here without being dependencies)
 * `dsh` forwards the arguments to pnpm inside the profile, so the runtime owns both the resolution
 * and the store; this gateway only composes the vendor's argv (gate 3) and reads its records.
 *
 * The console offers every initialized profile: `web` is the default when present, otherwise the
 * only non-desktop profile, otherwise a fresh `web`. `desktop` is selectable only through the
 * desktop-bundled launcher (the npm/global CLI refuses reserved-profile management) and only while
 * the Electron app is fully quit.
 *
 * Skills are OUTSIDE the profile tree and shared by every profile: the vendor's filesystem provider
 * (`@deepseek-ai/dsh-skill-filesystem`, read from the shipped base bundle's README, 2026-11-10)
 * scans `<DSH_HOME>/skills` (user), `<project>/.dsh/skills` (project) and the cross-agent
 * `~/.agents/skills` / `<project>/.agents/skills` trees (`readsUniversal`). No verified MCP surface:
 * identity, presence, the plugin landing and skills only.
 */

const DSH_BUNDLES_KEY = 'dsh.profile.bundles';
const DSH_DEPENDENCIES_KEY = 'dependencies';
const DSH_MANIFEST = 'package.json';
const DSH_CONSOLE_PROFILE = 'web';
/** Electron's own profile: selectable, but only the desktop-bundled launcher may write it. */
const DSH_DESKTOP_PROFILE = 'desktop';

interface DshProfile {
  name: string;
  dir: string;
  manifest: string;
}

/**
 * Every initialized profile on this machine, stable name order. `desktop` is listed: the operator
 * may target it through the bundled launcher, but it is never auto-selected as the console default
 * and its install requires the desktop app to be fully quit.
 */
export function dshProfiles(): DshProfile[] {
  const root = dshProfilesDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DshProfile[] = [];
  for (const entry of entries) {
    // Profiles may be symlinked/junctioned (dotfile repos, relocated stores); `Dirent` does not
    // follow links, so stat the resolved path before deciding.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const name = entry.name;
    if (name.startsWith('.')) continue;
    const dir = path.join(root, name);
    let isDir = false;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const manifest = path.join(dir, DSH_MANIFEST);
    if (!fs.existsSync(manifest)) continue;
    out.push({ name, dir, manifest });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The profile the console's installs land in: the vendor's active `DSH_PROFILE` when this gateway
 * itself runs inside a writable profile, else `web` when initialized, else the only initialized
 * custom profile, else `web` (initialized on first use). Read on every call, never cached.
 */
export function dshConsoleProfile(): string {
  const names = dshProfiles()
    .map((profile) => profile.name)
    .filter((name) => name !== DSH_DESKTOP_PROFILE);
  const active = process.env.DSH_PROFILE?.trim();
  if (active && !dshProfileError(active) && names.includes(active)) return active;
  if (names.includes(DSH_CONSOLE_PROFILE)) return DSH_CONSOLE_PROFILE;
  // Adopt a lone custom profile; never pick arbitrarily among several.
  return names.length === 1 ? names[0]! : DSH_CONSOLE_PROFILE;
}

const DSH_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The vendor CLI's own profile-name rule. `desktop` is valid; its launcher is chosen separately. */
export function dshProfileError(profile: string): string | undefined {
  const name = profile.trim();
  if (!DSH_PROFILE_NAME.test(name)) {
    return `invalid DSH profile '${profile}' — use letters, digits, dot, dash or underscore (max 64)`;
  }
  return undefined;
}

/**
 * Selectable install targets. `desktop` is hidden when the desktop-bundled launcher is absent —
 * an orphan profile with no way to write it is not an applicable choice. Other profiles are
 * always applicable; surface compatibility is not declared by DSH bundles.
 */
export function dshInstallProfiles(): { name: string; exists: boolean }[] {
  const names = dshProfiles().map((profile) => profile.name);
  const hasDesktopCli = !!dshDesktopCliPath();
  const rows = names
    .filter((name) => name !== DSH_DESKTOP_PROFILE || hasDesktopCli)
    .map((name) => ({ name, exists: true }));
  if (!names.includes(DSH_CONSOLE_PROFILE)) rows.push({ name: DSH_CONSOLE_PROFILE, exists: false });
  const target = dshConsoleProfile();
  return rows.sort((a, b) => {
    if (a.name === target) return -1;
    if (b.name === target) return 1;
    return a.name.localeCompare(b.name);
  });
}

export class DshAdapter extends BaseHostAdapter {
  readonly id = 'dsh' as const;
  readonly configRootEnv = 'DSH_HOME';
  readonly presence = { command: dshCliPath(), dir: dshHome() };

  /** Vendor-verified skill roots (shipped `@deepseek-ai/dsh-skill-filesystem` ranks 400/100):
   *  user `<DSH_HOME>/skills`, project `.dsh/skills`, plus the shared `.agents/skills` trees. */
  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(dshHome(), 'skills'),
    project: path.join('.dsh', 'skills'),
    readsUniversal: true,
  };

  protected readonly extSpec: PluginSpec = {
    subprocess: 'dsh',
    subprocessArgs: (spec: string, _scope: HarnessScope, profile?: string) => [
      'plugin',
      '--profile',
      profile && !dshProfileError(profile) ? profile : dshConsoleProfile(),
      'add',
      spec,
    ],
    scopes: ['global'],
  };

  supportedPluginSources(): ('github' | 'npm')[] {
    return ['npm', 'github'];
  }

  /** Resolve the launcher at PLAN time, by target: only the desktop-bundled command may manage
   *  `desktop`; every other profile uses the normal PATH/known-root resolution. */
  writeTarget(ctx: AdapterContext, scope: HarnessScope, profile?: string): PluginWriteTarget {
    const targetProfile = profile && !dshProfileError(profile) ? profile : dshConsoleProfile();
    const command = targetProfile === DSH_DESKTOP_PROFILE ? dshDesktopCliPath() : dshCliPath();
    if (!command) {
      return {
        ok: false,
        reason: `profile '${targetProfile}' requires the DeepSeek Harness desktop app (its bundled dsh was not found)`,
      };
    }
    const target = super.writeTarget(ctx, scope);
    return target.ok && target.op === 'subprocess' ? { ...target, command } : target;
  }

  marketplaceSpec(profile?: string): PluginMarketplaceInstall | null {
    const target = profile && !dshProfileError(profile) ? profile : dshConsoleProfile();
    const command = target === DSH_DESKTOP_PROFILE ? dshDesktopCliPath() : dshCliPath();
    if (!command) return null;
    return {
      commands: [[command, 'plugin', '--profile', target, 'add', 'github:{repo}']],
      interactive: false,
    };
  }

  installProfiles(): { name: string; exists: boolean }[] {
    return dshInstallProfiles();
  }

  pluginProfileError(profile: string): string | undefined {
    const error = dshProfileError(profile);
    if (error) return error;
    if (profile === DSH_DESKTOP_PROFILE && dshDesktopRunning()) {
      return `quit DeepSeek Harness before installing into the '${profile}' profile`;
    }
    return undefined;
  }

  /** The inverse of `subprocessArgs`: the vendor forwarder rewrites the profile's `dependencies`
   *  and `dsh.profile.bundles` together (the app's `removeBundle` path). */
  pluginRemoveArgs(name: string, _scope: HarnessScope, profile?: string) {
    const target = profile && !dshProfileError(profile) ? profile : dshConsoleProfile();
    // The same gate as `pluginProfileError`: `remove` rewrites the reserved desktop profile's
    // manifest and runs pnpm in it, so a live Electron app would race the write exactly as an
    // install would — the ADR's "fully quit first" rule binds both directions.
    if (target === DSH_DESKTOP_PROFILE && dshDesktopRunning()) {
      return {
        ok: false as const,
        reason: `quit DeepSeek Harness before removing from the '${target}' profile`,
      };
    }
    const command = target === DSH_DESKTOP_PROFILE ? dshDesktopCliPath() : dshCliPath();
    if (!command) {
      return {
        ok: false as const,
        reason: `profile '${target}' requires the DeepSeek Harness desktop app (its bundled dsh was not found)`,
      };
    }
    return {
      ok: true as const,
      command,
      args: ['plugin', '--profile', target, 'remove', name],
      timeoutMs: DSH_TIMEOUT_MS,
    };
  }
  declarations(_ctx: AdapterContext, scope: HarnessScope): { file: string; key: string }[] {
    if (scope !== 'global') return [];
    return orderedProfiles().map((profile) => ({ file: profile.manifest, key: DSH_BUNDLES_KEY }));
  }

  readSources(_ctx: AdapterContext, scope: HarnessScope): ExtSource[] {
    if (scope !== 'global') return [];
    return orderedProfiles().map((profile) => ({
      host: 'dsh' as const,
      scope: 'global' as const,
      origin: 'runtime-store' as const,
      kind: 'declared' as const,
      path: profile.manifest,
      profile: profile.name,
      key: DSH_BUNDLES_KEY,
      // In-box bundles (`@deepseek-ai/dsh-base`, `-web-app`, …) sit in the stack without being
      // dependencies; only an installed package is a plugin row.
      filterBy: DSH_DEPENDENCIES_KEY,
      // A disabled bundle keeps its dependency but leaves `dsh.profile.bundles`; its installed
      // manifest still declares `dsh.bundle`, which is what makes it a plugin row.
      unselectedBundles: 'dsh.bundle',
      // pnpm may hoist the store to `profiles/node_modules` (the shipped install does); a
      // profile-local store wins when it exists.
      nodeModules: [path.join(profile.dir, 'node_modules'), path.join(dshProfilesDir(), 'node_modules')],
    }));
  }
}

/** Profiles with the console target first, so a tracked copy resolves to the profile we wrote. */
function orderedProfiles(): DshProfile[] {
  const profiles = dshProfiles();
  const target = dshConsoleProfile();
  return [...profiles].sort((a, b) => {
    if (a.name === target) return -1;
    if (b.name === target) return 1;
    return a.name.localeCompare(b.name);
  });
}

export const dshAdapter = new DshAdapter();

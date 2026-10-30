import fs from 'node:fs';
import path from 'node:path';
import { UNIVERSAL_SKILLS } from './skills-paths.js';
import type {
  AdapterContext,
  ExtSource,
  HostAdapter,
  HostPresence,
  McpHost,
  PluginHost,
  PluginMarketplaceInstall,
  PluginSpec,
  PluginWriteTarget,
  SkillsHost,
  SkillsSpec,
} from './types.js';
import type { HarnessHostId, HarnessScope, ResolvedRoot } from '../../types.js';
import { installArtifact, type InstallResult } from '../install.js';
import type { HarnessHostAdapter, HostInstallRequest } from '../request.js';
import { defaultExec } from '../writers/plugin.js';

/** Normalize a `string | string[]` landing declaration; absent → empty. */
export function extPaths(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/**
 * The file a config landing WRITES.
 * Plain JSON candidates win over JSONC candidates to preserve comments.
 */
export function writeLanding(candidates: string[]): string {
  const plain = candidates.filter((p) => path.extname(p).toLowerCase() !== '.jsonc');
  return (
    plain.find((p) => fs.existsSync(p)) ??
    candidates.find((p) => fs.existsSync(p)) ??
    plain[0] ??
    candidates[0]!
  );
}

/** Skill names are directory names: lowercase, dash-separated, no path segments. */
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface HostMcpSpec {
  configGlobal: string | string[];
  configProject: string | string[];
  container: string;
}

export type PluginInstallSource = 'github' | 'npm' | 'local';

export interface HostPluginInstallOptions extends Partial<HostInstallRequest> {
  source?: PluginInstallSource;
  spec?: string;
  repo?: string;
  plugin?: string;
}

export interface HostSkillInstallOptions extends Partial<HostInstallRequest> {
  source?: 'github' | 'npm' | 'registry';
}

export interface HostMcpInstallOptions extends Partial<HostInstallRequest> {
  source?: 'github' | 'npm' | 'local';
}

export interface NativeMarketplaceInfo {
  name: string;
  repo: string;
  type?: 'github' | 'npm';
  sourceUrl?: string;
  description?: string;
  origin?: 'native-config' | 'native-cli';
}

export interface MarketplaceSyncResult {
  host: HarnessHostId;
  action: 'add' | 'remove' | 'discovered' | 'skipped';
  repo: string;
  ok: boolean;
  command?: string[];
  error?: string;
}

/**
 * BaseHostAdapter — the unified object-oriented foundation for all host adapters.
 * All concrete adapters extend this class, providing clarity, native install workflows,
 * and standard capabilities.
 */
export abstract class BaseHostAdapter implements HostAdapter, SkillsHost, McpHost, PluginHost, HarnessHostAdapter {
  abstract readonly id: HarnessHostId;
  readonly configRootEnv?: string;
  readonly extensionDir?: string;
  readonly presence?: HostPresence;

  protected readonly skillsSpec?: SkillsSpec;
  protected readonly mcpSpec?: HostMcpSpec;
  protected readonly extSpec?: PluginSpec;

  get harness(): HarnessHostId {
    return this.id;
  }

  get readsUniversalSkills(): boolean {
    return this.skillsSpec?.readsUniversal === true;
  }

  get container(): string {
    return this.mcpSpec?.container ?? '';
  }

  /**
   * Return plugin install sources natively supported by this host.
   * Typical returns: `['github']`, `['npm']`, or `['github', 'npm']`.
   * Hosts without plugin landing return `[]`.
   */
  supportedPluginSources(): ('github' | 'npm')[] {
    return [];
  }

  isSkillsSupported(): boolean {
    return !!this.skillsSpec;
  }

  isMcpSupported(): boolean {
    return !!this.mcpSpec;
  }

  isPluginSupported(): boolean {
    return !!this.extSpec || this.supportedPluginSources().length > 0;
  }

  hasLocalPluginLanding(): boolean {
    return Boolean(
      this.extSpec?.container ||
      this.extSpec?.declared ||
      this.extSpec?.looseDir
    );
  }

  // ---------------------------------------------------------------------------
  // Skills capabilities
  // ---------------------------------------------------------------------------

  skillRoots(ctx: AdapterContext, scope: HarnessScope): ResolvedRoot[] {
    if (!this.skillsSpec) return [];
    const spec = this.skillsSpec;
    if (scope === 'project') {
      const out: ResolvedRoot[] = [
        { root: path.resolve(ctx.projectRoot, spec.project), origin: 'default', precedence: 0 },
      ];
      if (spec.readsUniversal && spec.project !== UNIVERSAL_SKILLS.project) {
        out.push({
          root: path.resolve(ctx.projectRoot, UNIVERSAL_SKILLS.project),
          origin: 'default',
          precedence: 1,
        });
      }
      return out;
    }

    const out: ResolvedRoot[] = [];
    const override = this.configRootEnv ? process.env[this.configRootEnv]?.trim() : undefined;
    if (override) {
      out.push({ root: path.join(path.resolve(override), 'skills'), origin: 'env-override', precedence: 0 });
    }
    out.push({ root: spec.global, origin: 'default', precedence: out.length });
    if (spec.readsUniversal && !out.some((r) => r.root === UNIVERSAL_SKILLS.global)) {
      out.push({ root: UNIVERSAL_SKILLS.global, origin: 'default', precedence: out.length });
    }
    return out;
  }

  skillTarget(
    ctx: AdapterContext,
    scope: HarnessScope,
    name: string
  ): { ok: true; root: ResolvedRoot; path: string } | { ok: false; reason: string } {
    const candidates = this.skillRoots(ctx, scope);
    if (candidates.length === 0) return { ok: false, reason: `host '${this.id}' has no skills location` };
    if (!SKILL_NAME.test(name)) return { ok: false, reason: `invalid skill name '${name}'` };
    const root = candidates[0]!;
    const target = path.resolve(root.root, name);
    const rel = path.relative(root.root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, reason: 'target escapes its root' };
    }
    return { ok: true, root, path: target };
  }

  // ---------------------------------------------------------------------------
  // MCP capabilities
  // ---------------------------------------------------------------------------

  configPath(ctx: AdapterContext, scope: HarnessScope): { ok: true; path: string } | { ok: false; reason: string } {
    if (!this.mcpSpec) {
      return { ok: false, reason: `host '${this.id}' declares no MCP landing` };
    }
    const spec = this.mcpSpec;
    const declared =
      scope === 'project'
        ? extPaths(spec.configProject).map((p) => path.resolve(ctx.projectRoot, p))
        : extPaths(spec.configGlobal);
    if (declared.length === 0) {
      return { ok: false, reason: `host '${this.id}' declares no MCP landing for ${scope} scope` };
    }
    return { ok: true, path: declared.find((p) => fs.existsSync(p)) ?? declared[0]! };
  }

  // ---------------------------------------------------------------------------
  // Plugin capabilities
  // ---------------------------------------------------------------------------

  containers(): string[] {
    if (!this.extSpec?.container) return [];
    return [this.extSpec.container, ...(this.extSpec.containerAliases ?? [])];
  }

  declarations(): { file: string; key: string }[] {
    if (!this.extSpec?.declared) return [];
    return extPaths(this.extSpec.declared.global).map((file) => ({ file, key: this.extSpec!.declared!.key }));
  }

  lock(): string | undefined {
    return this.extSpec?.lock;
  }

  looseDirs(ctx: AdapterContext, scope: HarnessScope): string[] {
    if (!this.extSpec) return [];
    const declared = extPaths(scope === 'project' ? this.extSpec.looseDir?.project : this.extSpec.looseDir?.global);
    return declared.map((p) => (path.isAbsolute(p) ? p : path.resolve(ctx.projectRoot, p)));
  }

  writeTarget(ctx: AdapterContext, scope: HarnessScope): PluginWriteTarget {
    if (!this.extSpec) {
      return { ok: false, reason: `host '${this.id}' declares no plugin landing` };
    }
    if (this.extSpec.subprocess) {
      return {
        ok: true,
        op: 'subprocess',
        command: this.extSpec.subprocess,
        ...(this.extSpec.subprocessArgs ? { args: this.extSpec.subprocessArgs } : {}),
      };
    }
    const candidates = this.configCandidates(ctx, scope);
    if (candidates.length === 0) {
      return { ok: false, reason: `host '${this.id}' declares no plugin config landing` };
    }
    return { ok: true, op: 'config', path: writeLanding(candidates), container: this.containers()[0]! };
  }

  marketplaceSpec(): PluginMarketplaceInstall | null {
    if (!this.extSpec?.marketplace) return null;
    return {
      commands: this.extSpec.marketplace.commands,
      interactive: this.extSpec.marketplace.interactive === true,
    };
  }

  readSources(ctx: AdapterContext, scope: HarnessScope): ExtSource[] {
    const out: ExtSource[] = [];
    if (!this.extSpec) return out;

    if (this.extSpec.subprocess) {
      for (const declaration of this.declarations()) {
        out.push({
          host: this.id,
          scope: 'global',
          origin: 'runtime-store',
          kind: 'declared',
          path: declaration.file,
          key: declaration.key,
          ...(this.extSpec.lock ? { lockPath: this.extSpec.lock } : {}),
          ...(this.extSpec.storeShape ? { containerShape: this.extSpec.storeShape } : {}),
          ...(this.extSpec.specPrefix ? { specPrefix: this.extSpec.specPrefix } : {}),
        });
      }
    } else if (this.containers().length > 0) {
      const candidates = this.configCandidates(ctx, scope);
      if (candidates.length > 0) {
        const write = writeLanding(candidates);
        const ordered = [write, ...candidates.filter((p) => p !== write)];
        for (const file of ordered) {
          out.push({
            host: this.id,
            scope,
            origin: 'config-array',
            kind: 'config-array',
            path: file,
            key: this.containers(),
          });
        }
      }
    }

    for (const dir of this.looseDirs(ctx, scope)) {
      out.push({ host: this.id, scope, origin: 'local-file', kind: 'loose-dir', path: dir });
    }
    return out;
  }

  private configCandidates(ctx: AdapterContext, scope: HarnessScope): string[] {
    if (!this.extSpec?.container) return [];
    const declared = scope === 'project' ? extPaths(this.extSpec.configProject) : extPaths(this.extSpec.configGlobal);
    return scope === 'global' ? declared : declared.map((p) => path.resolve(ctx.projectRoot, p));
  }

  // ---------------------------------------------------------------------------
  // 3 Unified Installation Methods
  // ---------------------------------------------------------------------------

  /**
   * Install a plugin using the native CLI or configuration method declared for this host.
   * Validates whether this host natively supports the requested source ('github' | 'npm').
   */
  async installPlugin(req: HostPluginInstallOptions): Promise<InstallResult> {
    const supported = this.supportedPluginSources();
    if (supported.length === 0) {
      return {
        ok: false,
        code: 'bad_request',
        message: `Host '${this.id}' does not support plugin installation`,
      };
    }

    const channel = req.channel ?? (req.source as 'github' | 'npm' | 'local') ?? 'github';
    if (channel === 'github' && !supported.includes('github')) {
      return {
        ok: false,
        code: 'bad_request',
        message: `Host '${this.id}' natively only supports npm plugin installs, but received github source`,
      };
    }
    if (channel === 'npm' && !supported.includes('npm')) {
      return {
        ok: false,
        code: 'bad_request',
        message: `Host '${this.id}' natively only supports github plugin installs, but received npm source`,
      };
    }

    let marketplace = req.marketplace;
    if (!marketplace && channel === 'github' && this.marketplaceSpec()) {
      const raw = (req.spec ?? req.key ?? '').replace(/^github:/, '');
      const slash = raw.indexOf('/');
      // A pinned key (`owner/repo#dir`, `owner/repo@v1`) still names the repository, not a path:
      // the marketplace chain takes `owner/repo` and would refuse the suffix as an invalid repo.
      const owner = slash > 0 ? raw.slice(0, slash) : '';
      const repoPart = slash > 0 ? raw.slice(slash + 1).replace(/[#@].*$/, '') : '';
      if (repoPart) {
        marketplace = {
          repo: `${owner}/${repoPart}`,
          plugin: repoPart.replace(/-plugin$/, '').replace(/^plugin-/, ''),
          name: repoPart.replace(/-plugin$/, '').replace(/^plugin-/, ''),
        };
      }
    }

    const key = req.key ?? (req.spec ? (channel === 'npm' ? `npm:${req.spec}` : (req.spec.startsWith('github:') ? req.spec : `github:${req.spec}`)) : undefined);
    return this.dispatchInstall({
      ...req,
      kind: 'plugin',
      channel,
      key,
      ...(marketplace ? { marketplace } : {}),
    });
  }

  /**
   * Install an agent skill into this host's designated skills root directory.
   */
  async installSkill(req: HostSkillInstallOptions): Promise<InstallResult> {
    if (!this.isSkillsSupported()) {
      return {
        ok: false,
        code: 'bad_request',
        message: `Host '${this.id}' does not have a skills location`,
      };
    }
    const channel = req.channel ?? (req.source as 'github' | 'npm' | 'registry') ?? 'github';
    return this.dispatchInstall({
      ...req,
      kind: 'skill',
      channel,
    });
  }

  /**
   * Install an MCP server into this host's configuration file.
   */
  async installMcp(req: HostMcpInstallOptions): Promise<InstallResult> {
    if (!this.isMcpSupported()) {
      return {
        ok: false,
        code: 'bad_request',
        message: `Host '${this.id}' does not support MCP configuration`,
      };
    }
    const channel = req.channel ?? (req.source as 'github' | 'npm' | 'local') ?? 'github';
    return this.dispatchInstall({
      ...req,
      kind: 'mcp',
      channel,
    });
  }

  /**
   * Unified dispatcher matching the HarnessHostAdapter interface.
   */
  install(req: HostInstallRequest): Promise<InstallResult> {
    if (req.kind === 'plugin') return this.installPlugin(req);
    if (req.kind === 'mcp') return this.installMcp(req);
    return this.installSkill(req);
  }

  private dispatchInstall(req: HostInstallRequest): Promise<InstallResult> {
    const base = {
      kind: req.kind,
      hosts: [this.id] as HarnessHostId[],
      scope: req.scope ?? ('global' as const),
      ...(req.projectRoot ? { projectRoot: req.projectRoot } : {}),
      ...(req.confirm ? { confirm: true } : {}),
      ...(req.fetchImpl ? { fetchImpl: req.fetchImpl } : {}),
      ...(req.execImpl ? { execImpl: req.execImpl } : {}),
      // Discovery-surface provenance (§D9): the adapter's caller knows which listings a row came
      // from; dropping it here would record every routed install with only its writer source.
      ...(req.listedOn ? { listedOn: req.listedOn } : {}),
      ...(req.marketplace ? { marketplace: req.marketplace } : {}),
    };

    if (req.channel === 'local') {
      if (req.kind === 'plugin') {
        if (!req.localSpec) {
          return Promise.resolve({ ok: false, code: 'bad_request', message: 'local plugin install requires localSpec' });
        }
        return installArtifact({ ...base, manualSpec: req.localSpec });
      }
      if (req.kind === 'mcp') {
        if (!req.localName || !req.localLaunch) {
          return Promise.resolve({ ok: false, code: 'bad_request', message: 'local MCP install requires localName and localLaunch' });
        }
        return installArtifact({ ...base, manualPayload: { name: req.localName, launch: req.localLaunch } });
      }
      return Promise.resolve({ ok: false, code: 'bad_request', message: 'skill installs have no local channel' });
    }

    if (!req.key) {
      return Promise.resolve({ ok: false, code: 'bad_request', message: `${req.channel} install requires key` });
    }

    const key = req.channel === 'npm' && !req.key.includes(':') ? `npm:${req.key}` : req.key;
    return installArtifact({ ...base, key });
  }

  // ---------------------------------------------------------------------------
  // Native Marketplace Synchronization
  // ---------------------------------------------------------------------------

  /**
   * Discover marketplaces natively configured in this host's local agent environment.
   * Concrete adapters that support native marketplace configuration (e.g. Claude, Codex, Copilot)
   * override this method to scan their local config files.
   */
  async listNativeMarketplaces(): Promise<NativeMarketplaceInfo[]> {
    return [];
  }

  /**
   * Sync a marketplace from OCR down to this native host agent using native commands or config writes.
   * Concrete adapters implement this to run e.g. `claude plugin marketplace add <repo>`.
   */
  async syncMarketplaceToHost(
    entry: { repo: string; slug: string; type?: 'github' | 'npm' },
    _execImpl?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>,
  ): Promise<MarketplaceSyncResult> {
    return { host: this.id, action: 'skipped', repo: entry.repo, ok: true };
  }

  /**
   * Remove a marketplace from this native host agent using native commands or config writes.
   * Concrete adapters implement this to run e.g. `claude plugin marketplace remove <repo>`.
   */
  async removeMarketplaceFromHost(
    entry: { repo: string; slug: string; type?: 'github' | 'npm' },
    _execImpl?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>,
  ): Promise<MarketplaceSyncResult> {
    return { host: this.id, action: 'skipped', repo: entry.repo, ok: true };
  }
}

/**
 * Execute a native marketplace CLI command for an adapter.
 */
export async function runNativeMarketplaceCmd(
  host: HarnessHostId,
  action: 'add' | 'remove',
  repo: string,
  command: string[],
  execImpl?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>,
  timeoutMs = 30_000,
): Promise<MarketplaceSyncResult> {
  const runner = execImpl ?? defaultExec;
  const [cmd, ...args] = command;
  if (!cmd) return { host, action, repo, ok: false, error: 'empty command' };
  try {
    const res = await runner(cmd, args, timeoutMs);
    const output = `${res.stdout} ${res.stderr}`.toLowerCase();
    const alreadyExists = action === 'add' && (output.includes('already') || output.includes('exists'));
    const notFound = action === 'remove' && (output.includes('not found') || output.includes('no such') || output.includes('does not exist'));
    const ok = res.code === 0 || alreadyExists || notFound;
    return {
      host,
      action,
      repo,
      ok,
      command,
      ...(ok ? {} : { error: res.stderr || res.stdout || `exit code ${res.code}` }),
    };
  } catch (e) {
    return {
      host,
      action,
      repo,
      ok: false,
      command,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}



import fs from 'node:fs';
import path from 'node:path';
import { UNIVERSAL_SKILLS } from './skills-paths.js';
import type {
  AdapterContext,
  PluginHost,
  PluginSpec,
  PluginWriteTarget,
  ExtSource,
  HostAdapter,
  HostPresence,
  McpHost,
  SkillsHost,
  SkillsSpec,
} from './types.js';
import type { HarnessHostId, HarnessScope, ResolvedRoot } from '../../types.js';

/**
 * The generic host implementations — every behaviour a host can have WITHOUT host-specific code
 * (ADR-0015 §D3 R3, §D2, §D8.8).
 *
 * One `defineHost(id, spec)` per host file declares WHAT the runtime reads (skills dirs, an MCP
 * config landing, an plugin landing); the rules live here. That split keeps the two failure modes
 * apart: a wrong PATH is a per-host data bug in one small file, a wrong RULE is a single
 * implementation bug — they can never silently disagree with each other.
 *
 * Capabilities are separate interfaces (`SkillsHost` / `McpHost` / `PluginHost`), and `defineHost`
 * only attaches the ones the spec asks for. Absence is therefore a TYPE fact: `cursor` cannot be
 * handed to an MCP writer, and no host carries nine `unsupported` stubs.
 */

/** Normalize a `string | string[]` landing declaration; absent → empty. */
export function extPaths(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/**
 * The file a config landing WRITES.
 *
 * Reading may spread over the whole version ladder (v1 + v2 spellings), writing may not: the merge
 * writer refuses a JSONC round-trip because it would drop the file's comments (§D8.2), so an existing
 * plain-JSON candidate wins, then any existing candidate, then the first plain-JSON one, then the
 * declared head. Resolution and default agree by construction — the historical defect this prevents
 * is a writer landing in a file the next read would not prefer.
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

function buildSkills(id: HarnessHostId, spec: SkillsSpec, configRootEnv?: string): SkillsHost {
  const roots = (ctx: AdapterContext, scope: HarnessScope): ResolvedRoot[] => {
    if (scope === 'project') {
      const out: ResolvedRoot[] = [
        { root: path.resolve(ctx.projectRoot, spec.project), origin: 'default', precedence: 0 },
      ];
      // A readsUniversal host with a PRIVATE project root (omp: `.omp/skills`) ALSO loads the
      // cross-agent project tree — referenced from skills-paths, never re-spelled. Hosts whose
      // project root IS the shared tree (cursor, pi, …) already resolve it as their only root.
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
    const override = configRootEnv ? process.env[configRootEnv]?.trim() : undefined;
    if (override) {
      out.push({ root: path.join(path.resolve(override), 'skills'), origin: 'env-override', precedence: 0 });
    }
    out.push({ root: spec.global, origin: 'default', precedence: out.length });
    // A runtime that reads `.agents` also sees a copy materialized there — the cross-agent directory
    // is REFERENCED from its single declaration (skills-paths), never re-spelled per host.
    if (spec.readsUniversal && !out.some((r) => r.root === UNIVERSAL_SKILLS.global)) {
      out.push({ root: UNIVERSAL_SKILLS.global, origin: 'default', precedence: out.length });
    }
    return out;
  };

  return {
    id,
    ...(configRootEnv ? { configRootEnv } : {}),
    readsUniversalSkills: spec.readsUniversal === true,
    skillRoots: roots,
    skillTarget(ctx, scope, name) {
      const candidates = roots(ctx, scope);
      if (candidates.length === 0) return { ok: false, reason: `host '${id}' has no skills location` };
      if (!SKILL_NAME.test(name)) return { ok: false, reason: `invalid skill name '${name}'` };
      const root = candidates[0]!;
      const target = path.resolve(root.root, name);
      const rel = path.relative(root.root, target);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        return { ok: false, reason: 'target escapes its root' };
      }
      return { ok: true, root, path: target };
    },
  };
}

function buildMcp(
  id: HarnessHostId,
  spec: { configGlobal: string | string[]; configProject: string | string[]; container: string },
  configRootEnv?: string
): McpHost {
  return {
    id,
    ...(configRootEnv ? { configRootEnv } : {}),
    container: spec.container,
    configPath(ctx, scope) {
      const declared =
        scope === 'project'
          ? extPaths(spec.configProject).map((p) => path.resolve(ctx.projectRoot, p))
          : extPaths(spec.configGlobal);
      if (declared.length === 0) {
        return { ok: false, reason: `host '${id}' declares no MCP landing for ${scope} scope` };
      }
      // A ladder exists for the same reason plugins have one: a runtime may have moved its file.
      return { ok: true, path: declared.find((p) => fs.existsSync(p)) ?? declared[0]! };
    },
  };
}

function buildPlugin(id: HarnessHostId, spec: PluginSpec, configRootEnv?: string): PluginHost {
  const configCandidates = (ctx: AdapterContext, scope: HarnessScope): string[] => {
    if (!spec.container) return [];
    const declared = scope === 'project' ? extPaths(spec.configProject) : extPaths(spec.configGlobal);
    // A global landing is already absolute; a project landing is declared relative to the project.
    return scope === 'global' ? declared : declared.map((p) => path.resolve(ctx.projectRoot, p));
  };

  const looseDirs = (ctx: AdapterContext, scope: HarnessScope): string[] => {
    const declared = extPaths(scope === 'project' ? spec.looseDir?.project : spec.looseDir?.global);
    return declared.map((p) => (path.isAbsolute(p) ? p : path.resolve(ctx.projectRoot, p)));
  };

  const declarations = (): { file: string; key: string }[] => {
    if (!spec.declared) return [];
    return extPaths(spec.declared.global).map((file) => ({ file, key: spec.declared!.key }));
  };

  const containers = (): string[] =>
    spec.container ? [spec.container, ...(spec.containerAliases ?? [])] : [];

  return {
    id,
    ...(configRootEnv ? { configRootEnv } : {}),
    containers,
    declarations,
    lock: () => spec.lock,
    looseDirs,

    readSources(ctx, scope): ExtSource[] {
      const out: ExtSource[] = [];

      if (spec.subprocess) {
        // A package-manager landing is a GLOBAL record (the runtime's own store has no project
        // scope): the declaration file lists the specs, the lock file answers their versions.
        for (const declaration of declarations()) {
          out.push({
            host: id,
            scope: 'global',
            origin: 'runtime-store',
            kind: 'declared',
            path: declaration.file,
            key: declaration.key,
            ...(spec.lock ? { lockPath: spec.lock } : {}),
            ...(spec.storeShape ? { containerShape: spec.storeShape } : {}),
            ...(spec.specPrefix ? { specPrefix: spec.specPrefix } : {}),
          });
        }
      } else if (containers().length > 0) {
        // A config landing is discoverable by construction: the array the writer merges into IS the
        // record. Every spelling in the version ladder is read, write landing first so the writer's
        // preference wins the dedupe while the fallbacks still surface rows it would not have written.
        const candidates = configCandidates(ctx, scope);
        if (candidates.length > 0) {
          const write = writeLanding(candidates);
          const ordered = [write, ...candidates.filter((p) => p !== write)];
          for (const file of ordered) {
            out.push({
              host: id,
              scope,
              origin: 'config-array',
              kind: 'config-array',
              path: file,
              key: containers(),
            });
          }
        }
      }

      // Loose files are loaded from disk with no package at all — declared for every scope the host
      // loads them from, config-array hosts included (`opencode` reads `plugins/*.ts` directly).
      for (const dir of looseDirs(ctx, scope)) {
        out.push({ host: id, scope, origin: 'local-file', kind: 'loose-dir', path: dir });
      }
      return out;
    },

    writeTarget(ctx, scope): PluginWriteTarget {
      if (spec.subprocess) {
        return {
          ok: true,
          op: 'subprocess',
          command: spec.subprocess,
          ...(spec.subprocessArgs ? { args: spec.subprocessArgs } : {}),
        };
      }
      const candidates = configCandidates(ctx, scope);
      if (candidates.length === 0) {
        return { ok: false, reason: `host '${id}' declares no plugin config landing` };
      }
      return { ok: true, op: 'config', path: writeLanding(candidates), container: containers()[0]! };
    },
  };
}

/** What one host declares: the env root plus whichever capabilities it actually has. */
export interface HostSpec {
  configRootEnv?: string;
  presence?: HostPresence;
  skills?: SkillsSpec;
  mcp?: { configGlobal: string | string[]; configProject: string | string[]; container: string };
  ext?: PluginSpec;
}

/**
 * The composed host. `Partial<>` because a host genuinely lacks most capabilities: `dsh` has none of
 * the three beyond identity, `cursor` has skills only. Callers narrow with the `is*Host` guards, so
 * a capability can never be invoked without having been proved present.
 */
export type DefinedHost = HostAdapter & Partial<SkillsHost & McpHost & PluginHost>;

/**
 * Build one host from its declarative spec. A spec naming a capability gets exactly those methods;
 * naming none yields identity only (a measured "no landing", not a missing table row).
 */
export function defineHost(id: HarnessHostId, spec: HostSpec = {}): DefinedHost {
  const parts: DefinedHost[] = [];
  if (spec.skills) parts.push(buildSkills(id, spec.skills, spec.configRootEnv));
  if (spec.mcp) parts.push(buildMcp(id, spec.mcp, spec.configRootEnv));
  if (spec.ext) parts.push(buildPlugin(id, spec.ext, spec.configRootEnv));
  const base: HostAdapter = {
    id,
    ...(spec.configRootEnv ? { configRootEnv: spec.configRootEnv } : {}),
    ...(spec.presence ? { presence: spec.presence } : {}),
  };
  return Object.assign(base, ...parts);
}

/**
 * A host with ALL three capabilities (`opencode` today).
 *
 * The parameter type REQUIRES all three specs, so the widening cast below cannot claim a method the
 * spec did not ask `defineHost` to build — the requirement is the proof, the cast only teaches the
 * compiler what `Object.assign` already assembled at runtime.
 */
export function defineFullHost(
  id: HarnessHostId,
  spec: {
    skills: SkillsSpec;
    mcp: NonNullable<HostSpec['mcp']>;
    ext: PluginSpec;
    configRootEnv?: string;
    presence?: HostPresence;
  }
): SkillsHost & McpHost & PluginHost {
  return defineHost(id, spec) as SkillsHost & McpHost & PluginHost;
}

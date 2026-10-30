import fs from 'node:fs';
import path from 'node:path';
import type { HarnessHostId, HarnessScope } from '../../types.js';
import type { AdapterContext, HostAdapter } from './types.js';
import { ampAdapter } from './amp.js';
import { antigravityAdapter } from './antigravity.js';
import { claudeAdapter } from './claude.js';
import { clineAdapter } from './cline.js';
import { codexAdapter } from './codex.js';
import { cursorAdapter } from './cursor.js';
import { dshAdapter } from './dsh.js';
import { factoryAdapter } from './factory.js';
import { geminiCliAdapter } from './gemini-cli.js';
import { githubCopilotAdapter } from './github-copilot.js';
import { grokAdapter } from './grok.js';
import { kimiAdapter } from './kimi.js';
import { ompAdapter } from './omp.js';
import { opencodeAdapter } from './opencode.js';
import { piAdapter } from './pi.js';
import { universalAdapter } from './universal.js';
import { windsurfAdapter } from './windsurf.js';
import { zedAdapter } from './zed.js';
import { isSkillsHost } from './types.js';

export { BaseHostAdapter } from './base.js';
export { isPluginHost, isMcpHost, isSkillsHost } from './types.js';
export type {
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

/**
 * The adapter registry — one entry per host in `HOSTS`, SAME ORDER (a test asserts the parity, so a
 * new host cannot be added to the catalog without an adapter, nor removed unnoticed).
 *
 * Order is semantic: it decides (a) which host OWNS a shared skills directory (`skillOwner`) and
 * (b) which adapter answers first for a discovered `(host, canonicalKey)` pair.
 */
export const HOST_ADAPTERS: readonly HostAdapter[] = [
  universalAdapter,
  opencodeAdapter,
  claudeAdapter,
  codexAdapter,
  piAdapter,
  dshAdapter,
  ompAdapter,
  cursorAdapter,
  githubCopilotAdapter,
  geminiCliAdapter,
  antigravityAdapter,
  factoryAdapter,
  kimiAdapter,
  clineAdapter,
  ampAdapter,
  windsurfAdapter,
  zedAdapter,
  grokAdapter,
];

const BY_ID = new Map<HarnessHostId, HostAdapter>(HOST_ADAPTERS.map((adapter) => [adapter.id, adapter]));

/** The adapter for one host, or `undefined` for an id the catalog does not know. */
export function adapterFor(id: HarnessHostId | string): HostAdapter | undefined {
  return BY_ID.get(id as HarnessHostId);
}

/**
 * Every physical skills directory the adapters resolve, deduplicated.
 *
 * One directory is ONE copy: ten hosts share `.agents/skills`, so the FIRST adapter in registry
 * order is the owner and every other host is an alias — installation, the inventory scan and the
 * console all use this rule, otherwise the same directory gets labeled two different ways.
 */
export function skillLocationRoots(
  projectRoot: string = process.cwd()
): { host: HarnessHostId; scope: HarnessScope; root: string }[] {
  const ctx: AdapterContext = { projectRoot };
  const seen = new Set<string>();
  const out: { host: HarnessHostId; scope: HarnessScope; root: string }[] = [];
  for (const adapter of HOST_ADAPTERS) {
    if (!isSkillsHost(adapter)) continue;
    for (const scope of ['global', 'project'] as HarnessScope[]) {
      for (const resolved of adapter.skillRoots(ctx, scope)) {
        if (seen.has(resolved.root)) continue;
        seen.add(resolved.root);
        out.push({ host: adapter.id, scope, root: resolved.root });
      }
    }
  }
  return out;
}

/** The skills roots one host resolves for a scope; empty for a host with no skills capability. */
export function skillRootsFor(
  host: HarnessHostId,
  scope: HarnessScope,
  projectRoot: string = process.cwd()
): { root: string; origin: string; precedence: number }[] {
  const adapter = adapterFor(host);
  return isSkillsHost(adapter) ? adapter.skillRoots({ projectRoot }, scope) : [];
}

/** The host that OWNS a physical skills directory (first adapter in registry order). */
export function skillOwner(
  root: string,
  scope: HarnessScope,
  projectRoot: string = process.cwd()
): HarnessHostId | null {
  return skillReaders(root, scope, projectRoot)[0] ?? null;
}

/**
 * Every host that READS a physical skills directory — the inverse of `skillOwner`.
 *
 * One directory can be read by several runtimes without being written twice: the cross-agent
 * `.agents/skills` root is materialized once and every `readsUniversal` host sees it. Ownership
 * answers "who owns this copy" (install, claims, removal); reading answers "who can USE it" (the
 * console's harness rail on the skills page). Collapsing the two is what makes a shared directory
 * look empty for the eight runtimes that read it.
 */
export function skillReaders(
  root: string,
  scope: HarnessScope,
  projectRoot: string = process.cwd()
): HarnessHostId[] {
  const abs = path.resolve(root);
  const ctx: AdapterContext = { projectRoot };
  const out: HarnessHostId[] = [];
  for (const adapter of HOST_ADAPTERS) {
    if (!isSkillsHost(adapter)) continue;
    if (adapter.skillRoots(ctx, scope).some((resolved) => path.resolve(resolved.root) === abs)) {
      out.push(adapter.id);
    }
  }
  return out;
}

/**
 * Is this runtime present on THIS machine? Measured, never configured: the adapter's `presence`
 * markers (executable on PATH, config directory on disk), plus — for a skills host — the existence
 * of any of its global skills roots, so a runtime that left its skills tree behind stays visible
 * and its rows stay manageable. `universal` is always present: it is the bootstrap entry, the
 * place a first install lands when no runtime is installed yet.
 */
export function hostDetected(adapter: HostAdapter, ctx: AdapterContext = { projectRoot: process.cwd() }): boolean {
  if (adapter.id === 'universal') return true;
  const command = adapter.presence?.command;
  if (command && executableOnPath(command)) return true;
  const dir = adapter.presence?.dir;
  if (dir && fs.existsSync(dir)) return true;
  if (isSkillsHost(adapter)) {
    return adapter.skillRoots(ctx, 'global').some((resolved) => fs.existsSync(resolved.root));
  }
  return false;
}

/** PATH probe for an extensionless executable name; Windows suffixes are tried when the name has none. */
function executableOnPath(command: string): boolean {
  const exts = process.platform === 'win32' && !path.extname(command) ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, command + ext);
      try {
        // X_OK degrades to mere existence on Windows, and on POSIX a
        // directory with the execute bit also passes; require a real file.
        if (!fs.statSync(full).isFile()) continue;
        fs.accessSync(full, fs.constants.X_OK);
        return true;
      } catch {
        // not this candidate — keep probing
      }
    }
  }
  return false;
}

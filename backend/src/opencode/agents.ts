import fs from 'node:fs';
import path from 'node:path';
import {
  ROUTER_PROVIDER_ID,
  getOpenCodeConfigDir,
  getOpenCodeConfigPath,
  readJsonc,
} from './user-config.js';
import { OpenCodeConnector } from './connector.js';

/**
 * OpenCode agent inventory — the model-profile feature needs EVERY agent a hooked
 * OpenCode instance can spawn (primaries AND subagents). TWO sources, in order:
 *  1. LIVE (preferred): the running opencode v2 service `GET /api/agent` — the
 *     runtime source of truth. Config nodes, `agent(s)/*.md` files, built-ins
 *     AND plugin-registered agents arrive already merged by opencode itself, so
 *     spelling drift between v1 `agent` / v2 `agents` can never mislead us.
 *  2. FILE SCAN (fallback, e.g. service not running while the gateway is up):
 *     built-in roster + `agent(s)/*.md` + config nodes (v2 `agents` > v1 `agent`).
 * `model` strips the `omnicell-router/` prefix (undefined = inherit default);
 * a non-router id is reported verbatim (what the agent currently points at).
 */

export type OpenCodeAgentMode = 'primary' | 'subagent' | 'all';

export interface OpenCodeAgentView {
  name: string;
  mode: OpenCodeAgentMode;
  source: 'builtin' | 'file' | 'config' | 'service';
  /** Bound model (router-prefixed values stripped); undefined = inherit default model. */
  model?: string;
  /** The agent's own description (file frontmatter / config node / live
   *  roster). Feeds the console's smart-assign role context — absent means
   *  unknown, never invented here. */
  description?: string;
}

/** opencode's built-in roster. Names are stable across v2; a wrong default only
 *  affects the badge label — the model override always writes by name. */
const BUILTIN_AGENTS: { name: string; mode: OpenCodeAgentMode }[] = [
  { name: 'build', mode: 'primary' },
  { name: 'plan', mode: 'primary' },
  { name: 'general', mode: 'subagent' },
  { name: 'explore', mode: 'subagent' },
];

const VALID_MODES = new Set<OpenCodeAgentMode>(['primary', 'subagent', 'all']);

/** Strip the router namespace; anything non-router (or missing) reads as unbound. */
function stripRouterPrefix(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.startsWith(`${ROUTER_PROVIDER_ID}/`)
    ? value.slice(ROUTER_PROVIDER_ID.length + 1)
    : undefined;
}

/** Minimal YAML-frontmatter reader for agent/*.md: `key: value` lines between
 *  the leading `---` fences. Only the keys we consume are looked at. */
function readFrontmatter(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return out;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export interface ListAgentsOverrides {
  /** opencode.json(c) path under test (default: resolved user config). */
  configPath?: string;
  /** agent-files dir under test (default: `<config dir>/agent`, `<config dir>/agents`). */
  agentDir?: string;
}

/** Both file-dir spellings opencode has used; `agents` (v2) wins on same-name. */
const AGENT_DIR_NAMES = ['agents', 'agent'] as const;

/** Merge one config agent node into the inventory (later calls win). */
function mergeConfigNode(byName: Map<string, OpenCodeAgentView>, node: unknown): void {
  if (!node || typeof node !== 'object') return;
  for (const [name, def] of Object.entries(node as Record<string, unknown>)) {
    const d = (def && typeof def === 'object' ? def : {}) as Record<string, unknown>;
    const prev = byName.get(name);
    const mode = VALID_MODES.has(d.mode as OpenCodeAgentMode) ? (d.mode as OpenCodeAgentMode) : prev?.mode ?? 'all';
    const configModel = typeof d.model === 'string' && d.model ? d.model : undefined;
    const configDescription = typeof d.description === 'string' && d.description.trim() ? d.description.trim() : undefined;
    byName.set(name, {
      name,
      mode,
      source: 'config',
      model: configModel !== undefined ? stripRouterPrefix(configModel) ?? configModel : prev?.model,
      description: configDescription ?? prev?.description,
    });
  }
}

export function listOpenCodeAgents(overrides: ListAgentsOverrides = {}): OpenCodeAgentView[] {
  const byName = new Map<string, OpenCodeAgentView>();
  for (const b of BUILTIN_AGENTS) {
    byName.set(b.name, { name: b.name, mode: b.mode, source: 'builtin' });
  }

  // 1. `agent(s)/*.md` files (global dirs only in v1 — project agents need a cwd
  //    the gateway does not have). `agent` scanned first, `agents` (v2) wins.
  const baseDir = overrides.agentDir;
  const dirs = baseDir
    ? [baseDir]
    : AGENT_DIR_NAMES.map(n => path.join(getOpenCodeConfigDir(), n));
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.md') && !entry.endsWith('.markdown')) continue;
        const name = entry.replace(/\.(md|markdown)$/, '');
        let fm: Record<string, string> = {};
        try {
          fm = readFrontmatter(fs.readFileSync(path.join(dir, entry), 'utf8'));
        } catch {
          // unreadable file — still list the agent, defaults apply
        }
        const mode = VALID_MODES.has(fm.mode as OpenCodeAgentMode) ? (fm.mode as OpenCodeAgentMode) : 'all';
        const prev = byName.get(name);
        const fileModel = typeof fm.model === 'string' && fm.model ? fm.model : undefined;
        byName.set(name, {
          name,
          mode,
          source: 'file',
          model: fileModel !== undefined ? stripRouterPrefix(fileModel) ?? fileModel : prev?.model,
          description: typeof fm.description === 'string' && fm.description.trim() ? fm.description.trim() : prev?.description,
        });
      }
    } catch {
      // dir unreadable — config-node and builtin entries still stand
    }
  }

  // 2. Config nodes win over files/built-ins: legacy `agent` first, v2 `agents`
  //    second (so a same-name entry defined in both reads as opencode sees it).
  const configPath = overrides.configPath ?? getOpenCodeConfigPath();
  const parsed = readJsonc(configPath);
  mergeConfigNode(byName, parsed?.agent);
  mergeConfigNode(byName, parsed?.agents);

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One raw service agent record (`GET /api/agent` item). */
interface RawServiceAgent {
  id?: string;
  name?: string;
  mode?: string;
  hidden?: boolean;
  description?: string;
  model?: { providerID?: string; id?: string } | string | null;
}

/** Map the live service roster to the console view. Hidden internal agents
 *  (compaction / title / summary …) are bindable in principle but noise for the
 *  profile UI — filtered here, never in the caller. `name` carries the agent ID
 *  (the config-node key the binding write uses), NOT the service's display name
 *  — writing by display name would create a new agent instead of overriding. */
export function mapServiceAgents(raw: RawServiceAgent[]): OpenCodeAgentView[] {
  const out: OpenCodeAgentView[] = [];
  for (const a of raw) {
    if (!a || typeof a.id !== 'string' || !a.id) continue;
    if (a.hidden) continue;
    const mode = VALID_MODES.has(a.mode as OpenCodeAgentMode) ? (a.mode as OpenCodeAgentMode) : 'all';
    let model: string | undefined;
    if (typeof a.model === 'string' && a.model) model = a.model;
    else if (a.model && typeof a.model === 'object' && a.model.providerID && a.model.id) {
      model = `${a.model.providerID}/${a.model.id}`;
    }
    if (model) model = stripRouterPrefix(model) ?? model;
    out.push({
      name: a.id,
      mode,
      source: 'service',
      model,
      description: typeof a.description === 'string' && a.description.trim() ? a.description.trim() : undefined,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface LiveAgentsOverrides extends ListAgentsOverrides {
  /** Inject the service connector (tests); default: auto-discover. */
  connector?: Pick<OpenCodeConnector, 'isAvailable' | 'getAgents'>;
}

/**
 * Inventory with the live service preferred: the running opencode v2 service's
 * effective agent list (plugins included, node-spelling irrelevant) when it is
 * reachable; otherwise the file scan. The write path (profile apply/teardown
 * JSONC edits) is unaffected — the service hot-reloads the config it watches.
 */
export async function listOpenCodeAgentsLive(overrides: LiveAgentsOverrides = {}): Promise<OpenCodeAgentView[]> {
  try {
    const conn = overrides.connector ?? new OpenCodeConnector();
    if (conn.isAvailable()) {
      const raw = await conn.getAgents();
      if (raw.length > 0) return mapServiceAgents(raw);
    }
  } catch {
    // service down / auth rotated / old build without /api/agent — file fallback
  }
  return listOpenCodeAgents(overrides);
}

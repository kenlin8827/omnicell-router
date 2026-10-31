import type { HarnessSourceView } from '../types.js';
import { CLAWHUB_VIEW } from '../skill/clawhub.js';
import { PI_DEV_VIEW } from '../plugin/adapters/pi-dev.js';

/**
 * Default built-in market source views — one registry per axis, never a shared pool.
 *
 * The scope split follows the axis split:
 * - SKILL_VIEWS is GLOBAL. ClawHub is the skill axis' one curated directory (ADR-0015 §D6, owner
 *   decision) and declares no `hosts`: the same skill market serves every harness, so a skill
 *   registry is never a harness's private default.
 * - MCP_DEFAULT_VIEWS and PLUGIN_DEFAULT_VIEWS are the PER-HARNESS tier: an MCP server or plugin
 *   lands in a specific runtime, so a view belongs to the harnesses whose landing can take it
 *   (`hosts`, resolved by `plugin/builtin.ts` for the console and the federated market). MCP has no
 *   browsable directory wired today (npm is an INSTALL RESOLVER only, owner decision 2026-10-31);
 *   the registry stays separate so a future MCP directory is never declared in the plugin table.
 * Operator-configured `mp-<slug>` sources join each axis' listings by what their snapshot carries;
 * they are synced bidirectionally with local agent environments.
 */
export const SKILL_VIEWS: HarnessSourceView[] = [CLAWHUB_VIEW];
export const MCP_DEFAULT_VIEWS: HarnessSourceView[] = [];
export const PLUGIN_DEFAULT_VIEWS: HarnessSourceView[] = [PI_DEV_VIEW];

/** Every built-in view, in console chip order: the global skill directory, then the per-harness tier. */
export const SOURCES: HarnessSourceView[] = [...SKILL_VIEWS, ...MCP_DEFAULT_VIEWS, ...PLUGIN_DEFAULT_VIEWS];

/** Id-indexed lookup over the default views. */
export const SOURCES_VIEW_LOOKUP: Record<string, HarnessSourceView> = Object.fromEntries(
  SOURCES.map((s) => [s.id, s]),
);

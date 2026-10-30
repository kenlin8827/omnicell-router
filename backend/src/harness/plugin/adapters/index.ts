import { BasePluginMarketAdapter } from './base.js';
import { adapterFor } from '../../host/adapters/index.js';
import { PiDevPluginMarketAdapter } from './pi-dev.js';
import { PiGithubPluginMarketAdapter, PI_PROBE_OPTIONS } from './pi-github.js';
import { ClaudePluginMarketAdapter, CLAUDE_PROBE_OPTIONS, CLAUDE_CATALOG } from './claude.js';
import { CopilotPluginMarketAdapter, COPILOT_PROBE_OPTIONS } from './copilot.js';
import { UniversalPluginMarketAdapter, UNIVERSAL_PROBE_OPTIONS } from './universal.js';
import { CodexPluginMarketAdapter, CODEX_PROBE_OPTIONS } from './codex.js';
import { GeminiPluginMarketAdapter, GEMINI_PROBE_OPTIONS } from './gemini.js';
import { CursorPluginMarketAdapter, CURSOR_PROBE_OPTIONS } from './cursor.js';
import { AntigravityPluginMarketAdapter, ANTIGRAVITY_PROBE_OPTIONS } from './antigravity.js';
import { FactoryPluginMarketAdapter, FACTORY_PROBE_OPTIONS } from './factory.js';
import { GrokPluginMarketAdapter, GROK_PROBE_OPTIONS } from './grok.js';
import { KimiPluginMarketAdapter, KIMI_PROBE_OPTIONS } from './kimi.js';
import type { PluginAdapter } from '../types.js';
import { HOSTS } from '../../host/hosts.js';
import type { HarnessHostId } from '../../types.js';
import type { HostProbe, ProbeOptions } from '../../common/market.js';

export {
  BasePluginMarketAdapter,
  clampPage,
  channelOf,
  sourceIdOf,
  tempEntry,
} from './base.js';

export {
  PiDevPluginMarketAdapter,
  PiPluginMarketAdapter,
  PI_DEV_VIEW,
  browsePiDev,
} from './pi-dev.js';

export { PiGithubPluginMarketAdapter, PI_PROBE_OPTIONS } from './pi-github.js';
export { ClaudePluginMarketAdapter, CLAUDE_PROBE_OPTIONS, CLAUDE_CATALOG, CLAUDE_MANIFEST_PATHS, parseClaudeMarketplace } from './claude.js';
export { GrokPluginMarketAdapter, GROK_PROBE_OPTIONS } from './grok.js';
export { CopilotPluginMarketAdapter, COPILOT_PROBE_OPTIONS } from './copilot.js';
export { CodexPluginMarketAdapter, CODEX_PROBE_OPTIONS } from './codex.js';
export { GeminiPluginMarketAdapter, GEMINI_PROBE_OPTIONS } from './gemini.js';
export { UniversalPluginMarketAdapter, UNIVERSAL_PROBE_OPTIONS } from './universal.js';
export { CursorPluginMarketAdapter, CURSOR_PROBE_OPTIONS } from './cursor.js';
export { AntigravityPluginMarketAdapter, ANTIGRAVITY_PROBE_OPTIONS } from './antigravity.js';
export { FactoryPluginMarketAdapter, FACTORY_PROBE_OPTIONS } from './factory.js';
export { KimiPluginMarketAdapter, KIMI_PROBE_OPTIONS } from './kimi.js';

/** Every served harness's published form. ONE probe consumes the whole list, so support is
 *  DETECTED from the repository's own directories instead of inferred from the acting tab. */
export function allHostProbes(): HostProbe[] {
  return HOSTS.map((host) => {
    const dir = adapterFor(host.id)?.extensionDir ?? null;
    return { harness: host.id, dir, options: probeOptionsFor(host.id) };
  });
}

/** Create the per-harness adapter. `fetchImpl` is injectable for tests; production uses global
 *  fetch. pi.dev IS pi's official plugin directory, so pi defaults to the read-only official
 *  surface; `opts.custom` opts into the operator-source variant (git marketplaces + pi.dev). */
export function createPluginAdapter(
  harness: HarnessHostId,
  fetchImpl?: typeof fetch,
  opts?: { custom?: boolean },
): PluginAdapter {
  const probes = () => allHostProbes();
  if (harness === 'pi' && opts?.custom) return new PiGithubPluginMarketAdapter('pi', fetchImpl, probes);
  if (harness === 'pi') return new PiDevPluginMarketAdapter(fetchImpl, probes);
  if (harness === 'claude') return new ClaudePluginMarketAdapter('claude', fetchImpl, probes);
  if (harness === 'github-copilot') return new CopilotPluginMarketAdapter('github-copilot', fetchImpl, probes);
  if (harness === 'codex') return new CodexPluginMarketAdapter('codex', fetchImpl, probes);
  if (harness === 'gemini-cli') return new GeminiPluginMarketAdapter('gemini-cli', fetchImpl, probes);
  if (harness === 'universal') return new UniversalPluginMarketAdapter('universal', fetchImpl, probes);
  if (harness === 'cursor') return new CursorPluginMarketAdapter('cursor', fetchImpl, probes);
  if (harness === 'antigravity') return new AntigravityPluginMarketAdapter('antigravity', fetchImpl, probes);
  if (harness === 'factory') return new FactoryPluginMarketAdapter('factory', fetchImpl, probes);
  if (harness === 'kimi') return new KimiPluginMarketAdapter('kimi', fetchImpl, probes);
  if (harness === 'grok') return new GrokPluginMarketAdapter('grok', fetchImpl, probes);
  return new BasePluginMarketAdapter(harness, fetchImpl, probes);
}

/**
 * Probe hooks for one harness's form. The marketplace READER lives in `claude.ts` (the format
 * owner); each clone directory is claimed by its own adapter: claude → `.claude-plugin`,
 * grok → `.grok-plugin`, github-copilot → `.github/plugin`, universal → `.agents/plugins`.
 * Non-catalog forms are read by their own manifest readers: pi → layer `package.json`,
 * gemini-cli → root `gemini-extension.json`; codex/cursor/kimi/antigravity/factory are
 * directory-keyed. Every probe also carries the name reader, because a directory-keyed harness
 * still needs the marketplace/plugin NAMES its install command spells.
 */
export function probeOptionsFor(harness: HarnessHostId | null | undefined): ProbeOptions {
  const hooks = probeHooks(harness);
  const defaultExtensionDir = harness ? adapterFor(harness)?.extensionDir : undefined;
  return {
    ...hooks,
    ...(defaultExtensionDir ? { defaultExtensionDir } : {}),
    nameReader: CLAUDE_CATALOG,
  };
}

function probeHooks(harness: HarnessHostId | null | undefined): ProbeOptions {
  if (harness === 'pi') return PI_PROBE_OPTIONS;
  if (harness === 'codex') return CODEX_PROBE_OPTIONS;
  if (harness === 'gemini-cli') return GEMINI_PROBE_OPTIONS;
  if (harness === 'github-copilot') return COPILOT_PROBE_OPTIONS;
  if (harness === 'universal') return UNIVERSAL_PROBE_OPTIONS;
  if (harness === 'cursor') return CURSOR_PROBE_OPTIONS;
  if (harness === 'antigravity') return ANTIGRAVITY_PROBE_OPTIONS;
  if (harness === 'factory') return FACTORY_PROBE_OPTIONS;
  if (harness === 'kimi') return KIMI_PROBE_OPTIONS;
  if (harness === 'grok') return GROK_PROBE_OPTIONS;
  if (harness === 'claude' || harness == null) return CLAUDE_PROBE_OPTIONS;
  return {};
}

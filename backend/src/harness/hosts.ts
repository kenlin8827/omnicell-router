import type { HarnessHostId } from './types.js';

/**
 * Harness host identity table — the catalog ORDER plus the console label for each runtime.
 *
 * Paths are NOT here any more: every landing a host owns (skills dirs, MCP config, extension
 * `plugin[]` / package store) is declared in that host's adapter under `harness/adapters/` — one file
 * per host, each path spelled exactly once (ADR-0015 §D3 R3). The split is deliberate:
 *
 *   · this file answers "which hosts exist, in which order, called what";
 *   · `adapters/<host>.ts` answers "what does this runtime read, and how is it written".
 *
 * A host absent from `HOSTS` has no adapter, and vice versa — a test asserts the parity.
 */

export interface HostDef {
  id: HarnessHostId;
  label: string;
}

export const HOSTS: HostDef[] = [
  { id: 'universal', label: 'Universal' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'pi', label: 'Pi' },
  { id: 'dsh', label: 'DSH' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'github-copilot', label: 'GitHub Copilot / VS Code' },
  { id: 'gemini-cli', label: 'Gemini CLI' },
  { id: 'cline', label: 'Cline' },
  { id: 'amp', label: 'Amp' },
  { id: 'windsurf', label: 'Windsurf' },
  { id: 'zed', label: 'Zed' },
];

import path from 'node:path';
import { defineHost } from './declarative.js';
import { home } from './skills-paths.js';

/**
 * Claude Code (ADR-0015 §D8.11) — its own skills directory PLUS the plugin CLI landing: installs go
 * through `claude plugin install <id> --scope user` and are recorded in
 * `~/.claude/plugins/installed_plugins.json` as an object MAP keyed `<name>@<marketplace>`. The MAP
 * shape is read with the `claude:` spec prefix (a bare id would parse as a versioned npm spec); the
 * store has no project scope (the pi rule) — a project ask still answers the same global record.
 */
export const claudeAdapter = defineHost('claude', {
  presence: { command: 'claude', dir: path.join(home(), '.claude') },
  skills: { global: path.join(home(), '.claude', 'skills'), project: path.join('.claude', 'skills') },
  ext: {
    subprocess: 'claude',
    // The runtime's own argument grammar, echoed verbatim — the writer never invents one.
    subprocessArgs: (spec, scope) => ['plugin', 'install', spec, '--scope', scope === 'project' ? 'project' : 'user'],
    declared: { global: path.join(home(), '.claude', 'plugins', 'installed_plugins.json'), key: 'plugins' },
    storeShape: 'map',
    specPrefix: 'claude:',
  },
});

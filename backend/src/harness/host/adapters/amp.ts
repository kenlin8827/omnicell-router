import path from 'node:path';
import { BaseHostAdapter } from './base.js';
import { UNIVERSAL_SKILLS, xdgConfig } from './skills-paths.js';
import type { SkillsSpec } from './types.js';

/**
 * Amp — own XDG skills directory plus the shared cross-agent tree. Measured 2026-12 against
 * ampcode.com/docs/customize/skills: user precedence includes `~/.config/agents/skills` (the
 * `--global` install target) AND `~/.agents/skills`; project skills live in `.agents/skills`
 * (searched up to 5 parent levels). The docs only verify the literal `~/.config` path — an
 * `XDG_CONFIG_HOME` override is standard resolution here, not a vendor-documented one.
 * No MCP or plugin landing.
 */
export class AmpAdapter extends BaseHostAdapter {
  readonly id = 'amp' as const;
  readonly presence = { command: 'amp', dir: path.join(xdgConfig(), 'agents') };

  protected readonly skillsSpec: SkillsSpec = {
    global: path.join(xdgConfig(), 'agents', 'skills'),
    project: UNIVERSAL_SKILLS.project,
    readsUniversal: true,
  };
}

export const ampAdapter = new AmpAdapter();

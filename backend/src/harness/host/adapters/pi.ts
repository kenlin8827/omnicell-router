import os from 'node:os';
import path from 'node:path';
import { defineHost } from './declarative.js';
import { UNIVERSAL_SKILLS, home } from './skills-paths.js';

/**
 * Pi — shared skills directory + package-manager plugin landing (ADR-0015 §D8.9).
 *
 * `pi install npm:<spec>` writes `settings.json` `packages[]` (the declaration the runtime itself
 * reads), resolves the package under `<dir>/npm` (whose lock file answers the exact version), and
 * loads loose `plugins/*.ts` files from disk with no package at all. All three surfaces are
 * declared here, because all three are things the runtime loads and the console must be able to show.
 */

const AGENT_DIR = path.join(os.homedir(), '.pi', 'agent');

export const piAdapter = defineHost('pi', {
  presence: { command: 'pi', dir: path.join(home(), '.pi') },
  skills: { global: UNIVERSAL_SKILLS.global, project: UNIVERSAL_SKILLS.project, readsUniversal: true },
  ext: {
    subprocess: 'pi',
    declared: { global: path.join(AGENT_DIR, 'settings.json'), key: 'packages' },
    looseDir: { global: path.join(AGENT_DIR, 'extensions') },
    lock: path.join(AGENT_DIR, 'npm', 'package-lock.json'),
  },
});

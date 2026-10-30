import { defineHost } from './declarative.js';

/**
 * DSH — relocated by `DSH_HOME`; NO skills location (`skills: null` in the old catalog) and no
 * verified MCP or plugin landing. Identity + env root only, which is the honest surface.
 */
export const dshAdapter = defineHost('dsh', { configRootEnv: 'DSH_HOME', presence: { command: 'dsh' } });

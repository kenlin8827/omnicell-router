import { BaseHostAdapter } from './base.js';

/**
 * DSH — relocated by `DSH_HOME`; no skills location and no verified MCP or plugin landing.
 * Identity and presence probe only.
 */
export class DshAdapter extends BaseHostAdapter {
  readonly id = 'dsh' as const;
  readonly configRootEnv = 'DSH_HOME';
  readonly presence = { command: 'dsh' };
}

export const dshAdapter = new DshAdapter();

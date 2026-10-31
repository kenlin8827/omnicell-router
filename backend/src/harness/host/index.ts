import { adapterFor, BaseHostAdapter } from './adapters/index.js';
import type { HarnessHostId } from '../types.js';
import type { HarnessHostAdapter } from './request.js';

export { BaseHostAdapter };

/**
 * Return the host adapter instance for the specified harness.
 * Every supported host is represented by its dedicated adapter extending BaseHostAdapter.
 */
export function getHostAdapter(harness: HarnessHostId): HarnessHostAdapter {
  const adapter = adapterFor(harness);
  if (!adapter) throw new Error(`Unknown harness: ${harness}`);
  return adapter as unknown as HarnessHostAdapter;
}

export type { HarnessHostAdapter, HostInstallRequest, InstallChannel } from './request.js';

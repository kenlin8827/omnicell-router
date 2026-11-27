import { getModelServicePlugin, pluginDeclinesCredentials } from '../plugins/host.js';
import { wireFor } from '../providers/wire.js';
import { primaryProtocol, normalizeProtocols } from '../providers/protocols-field.js';
import { getProviderNodeById } from '../opencode/user-config.js';

/**
 * One quota pair for a provider whose plugin owns login (`authTypes: ['none']`).
 * There is no OCR key to hash. The prefix is the pair identity the console
 * translates as the machine CLI login.
 */
export const CLI_LOGIN_QUOTA_PREFIX = 'cli-login';

/** True when the provider's model-service plugin refuses an OCR credential. */
export function providerUsesCliLogin(providerId: string): boolean {
  const def = getProviderNodeById(providerId);
  const protocols = normalizeProtocols(def?.protocols ?? def?.package ?? def?.npm);
  const npm = protocols.length > 0 ? primaryProtocol(protocols) : undefined;
  const options = def?.options as { baseURL?: unknown } | undefined;
  const settings = def?.settings as { baseURL?: unknown } | undefined;
  const base = typeof options?.baseURL === 'string' ? options.baseURL : typeof settings?.baseURL === 'string' ? settings.baseURL : undefined;
  return pluginDeclinesCredentials(getModelServicePlugin(wireFor(npm, base)));
}

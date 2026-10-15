import crypto from 'node:crypto';
import { ApiKeyConfig, ModelAccessConfig, RateLimitRule, RouterConfig } from '../config/types.js';
import { loadConfig, saveConfig } from '../config/index.js';
import { ENTRY_PATTERN } from './model-access.js';

export interface AuthValidationResult {
  valid: boolean;
  keyConfig?: ApiKeyConfig;
  error?: string;
}

/**
 * Validates a Bearer token or API key against adminApiKey or configured client API keys
 */
export function validateApiKey(token: string, config: RouterConfig): AuthValidationResult {
  if (!token) {
    return { valid: false, error: 'Missing API key' };
  }

  // 1. Check Master / Admin API Key
  if (config.adminApiKey && token === config.adminApiKey) {
    return { valid: true };
  }

  // 2. Check Client API Keys
  const keys = config.apiKeys || [];
  const found = keys.find((k) => k.key === token);

  if (!found) {
    return { valid: false, error: 'Invalid API key' };
  }

  if (found.enabled === false) {
    return { valid: false, error: 'API key is disabled' };
  }

  if (found.expiresAt) {
    const expiryTime = new Date(found.expiresAt).getTime();
    if (!Number.isNaN(expiryTime) && expiryTime <= Date.now()) {
      return { valid: false, error: 'API key has expired' };
    }
  }

  return {
    valid: true,
    keyConfig: found,
  };
}

/**
 * Generate a cryptographically secure random API Key
 * Format: sk-ocr-<32 hex chars>
 */
export function generateApiKey(prefix = 'sk-ocr'): string {
  const randomHex = crypto.randomBytes(16).toString('hex');
  return `${prefix}-${randomHex}`;
}

/**
 * Mask an API key for safe display (e.g. sk-ocr-••••••••abcd)
 */
export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 12) return '••••••••';
  const prefix = key.slice(0, 7);
  const suffix = key.slice(-4);
  return `${prefix}••••••••${suffix}`;
}

/**
 * List all configured API keys (with keys optionally masked)
 */
export function listApiKeys(mask = false): ApiKeyConfig[] {
  const config = loadConfig();
  const keys = config.apiKeys || [];
  if (!mask) return keys;
  return keys.map((k) => ({
    ...k,
    key: maskApiKey(k.key),
  }));
}

/**
 * Validate an optional client-supplied modelAccess payload. Returns undefined
 * (unset) for absent/empty input, or an error string for malformed shapes —
 * an empty allow-list would lock the key out of EVERY model, so it is rejected.
 */
export function validateModelAccess(
  input: unknown
): { value?: ModelAccessConfig; error?: string } {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'modelAccess must be an object { mode, models }' };
  }
  const { mode, models } = input as { mode?: unknown; models?: unknown };
  if (mode !== 'allow' && mode !== 'deny') {
    return { error: 'modelAccess.mode must be "allow" or "deny"' };
  }
  if (!Array.isArray(models) || models.some((m) => typeof m !== 'string' || !m.trim())) {
    return { error: 'modelAccess.models must be a non-empty array of model id strings' };
  }
  const unique = Array.from(new Set((models as string[]).map((m) => m.trim())));
  const badEntry = unique.find((m) => !ENTRY_PATTERN.test(m));
  if (badEntry) {
    return {
      error: `Invalid model entry '${badEntry}': allowed chars are letters, digits, - _ . / : and * (wildcard)`,
    };
  }
  if (mode === 'allow' && unique.length === 0) {
    return { error: 'modelAccess.models must not be empty in "allow" mode (the key would be locked out of every model)' };
  }
  return { value: { mode, models: unique } };
}

/**
 * Create and persist a new API Key
 */
export function createApiKey(payload: {
  name: string;
  key?: string;
  expiresAt?: string;
  description?: string;
  modelAccess?: ModelAccessConfig;
  limits?: RateLimitRule[];
}): { success: boolean; data?: ApiKeyConfig; error?: string } {
  const config = loadConfig();
  const keys = [...(config.apiKeys || [])];

  const trimmedName = payload.name?.trim();
  if (!trimmedName) {
    return { success: false, error: 'API Key name is required' };
  }

  const generatedKey = payload.key?.trim() || generateApiKey();

  // Ensure key uniqueness
  if (keys.some((k) => k.key === generatedKey)) {
    return { success: false, error: 'API Key string already exists' };
  }

  const newKey: ApiKeyConfig = {
    id: `key-${crypto.randomBytes(4).toString('hex')}`,
    name: trimmedName,
    key: generatedKey,
    enabled: true,
    createdAt: new Date().toISOString(),
    expiresAt: payload.expiresAt || undefined,
    description: payload.description?.trim() || undefined,
    modelAccess: payload.modelAccess,
    limits: payload.limits,
  };

  keys.unshift(newKey);
  const saveResult = saveConfig({ apiKeys: keys });
  if (!saveResult.success) {
    return { success: false, error: saveResult.error || 'Failed to persist API Key configuration' };
  }

  return { success: true, data: newKey };
}

/**
 * Update an existing API Key (e.g. toggle enabled, update name/description).
 * `modelAccess` and `limits` follow PUT semantics: undefined = leave
 * unchanged, null = clear the policy (back to unrestricted / no caps),
 * value = replace.
 */
export function updateApiKey(
  id: string,
  updates: Partial<Pick<ApiKeyConfig, 'name' | 'enabled' | 'expiresAt' | 'description'>> & {
    modelAccess?: ModelAccessConfig | null;
    limits?: RateLimitRule[] | null;
  }
): { success: boolean; data?: ApiKeyConfig; error?: string } {
  const config = loadConfig();
  const keys = [...(config.apiKeys || [])];
  const idx = keys.findIndex((k) => k.id === id);

  if (idx === -1) {
    return { success: false, error: `API Key '${id}' not found` };
  }

  const current = keys[idx];
  const updated: ApiKeyConfig = {
    ...current,
    ...(updates.name !== undefined && { name: updates.name.trim() }),
    ...(updates.enabled !== undefined && { enabled: Boolean(updates.enabled) }),
    ...(updates.expiresAt !== undefined && { expiresAt: updates.expiresAt }),
    ...(updates.description !== undefined && { description: updates.description.trim() }),
    ...(updates.modelAccess !== undefined && { modelAccess: updates.modelAccess ?? undefined }),
    ...(updates.limits !== undefined && { limits: updates.limits ?? undefined }),
  };

  keys[idx] = updated;
  const saveResult = saveConfig({ apiKeys: keys });
  if (!saveResult.success) {
    return { success: false, error: saveResult.error || 'Failed to persist API Key changes' };
  }

  return { success: true, data: updated };
}

/**
 * Delete an API Key by ID
 */
export function deleteApiKey(id: string): { success: boolean; error?: string } {
  const config = loadConfig();
  const keys = config.apiKeys || [];
  const filtered = keys.filter((k) => k.id !== id);

  if (filtered.length === keys.length) {
    return { success: false, error: `API Key '${id}' not found` };
  }

  const saveResult = saveConfig({ apiKeys: filtered });
  if (!saveResult.success) {
    return { success: false, error: saveResult.error || 'Failed to remove API Key from config' };
  }

  return { success: true };
}

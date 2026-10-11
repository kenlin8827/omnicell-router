import { ApiKeyConfig, ModelAccessConfig } from '../config/types.js';

export type { ModelAccessConfig };

/** Chars permitted in a model-access entry: model ids plus the `*` wildcard.
 *  NOTE: a bare `*` does NOT pass this pattern (cannot be saved via the
 *  API/UI); the matcher below still tolerates one defensively. */
export const ENTRY_PATTERN = /^[A-Za-z0-9._:/\-]+(\*[A-Za-z0-9._:/\-]*)*$/;

/**
 * Virtual force-tier id → tier name. Policy lists accept these entries as
 * tier-wide rules: `deny auto-plus` blocks EVERY plus-tier model (not just a
 * literal id that happens to be named auto-plus, which matches nothing).
 * Bare `auto` and physical ids return '' (no tier meaning).
 */
export function tierFromVirtualEntry(entry: string): string {
  switch (entry) {
    case 'auto-lite':
      return 'lite';
    case 'auto-plus':
      return 'plus';
    case 'auto-pro':
      return 'pro';
    case 'auto-ultra':
      return 'ultra';
    default:
      return '';
  }
}

/** Compiled-entry cache — access lists are tiny but re-checked per candidate
 *  per request; compiling once per distinct entry is a free win. */
const ENTRY_MATCHER_CACHE = new Map<string, (modelId: string) => boolean>();

/**
 * Compile one model-access entry into a matcher. Entries containing `*` are
 * fnmatch-style wildcards (each `*` = any run of characters, including `/`,
 * so `zhipu/*` covers every zhipu model); plain entries match exactly.
 * Entries are validated against ENTRY_PATTERN at write time
 * (validateModelAccess), so the regex build here cannot throw on user input.
 */
function compileEntryMatcher(entry: string): (modelId: string) => boolean {
  let cached = ENTRY_MATCHER_CACHE.get(entry);
  if (cached) return cached;
  if (!entry.includes('*')) {
    cached = (modelId) => modelId === entry;
  } else {
    const re = new RegExp(
      '^' + entry.split('*').map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
    );
    cached = (modelId) => re.test(modelId);
  }
  ENTRY_MATCHER_CACHE.set(entry, cached);
  return cached;
}

/**
 * Extract the effective model-access policy for a validated key.
 * Returns undefined when the key is unrestricted (no policy configured —
 * unrestricted is the default; restrictions only apply when a key has an
 * explicit modelAccess policy).
 */
export function getModelAccessPolicy(keyConfig?: ApiKeyConfig): ModelAccessConfig | undefined {
  if (!keyConfig) return undefined;
  const access = keyConfig.modelAccess;
  if (!access || (access.mode !== 'allow' && access.mode !== 'deny')) return undefined;
  if (!Array.isArray(access.models)) return undefined;
  return { mode: access.mode, models: access.models.filter((m) => typeof m === 'string' && m.length > 0) };
}

/**
 * Does `policy` admit the model? List entries are exact ids, `*` wildcards,
 * OR virtual tier ids (`auto-lite`/`auto-plus`/`auto-pro`/`auto-ultra`) which
 * match EVERY model of that tier — pass the candidate's `tier` to enable that
 * expansion (undefined tier = entries match by id/wildcard only).
 * Undefined policy (or empty list in deny mode) admits everything.
 */
export function isModelAllowed(modelId: string, policy?: ModelAccessConfig, tier?: string): boolean {
  if (!policy) return true;
  const hit = (entry: string) =>
    compileEntryMatcher(entry)(modelId) ||
    (tier !== undefined && tier !== '' && tierFromVirtualEntry(entry) === tier);
  if (policy.mode === 'deny') return !policy.models.some(hit);
  return policy.models.some(hit);
}

/**
 * Entry-point check for a client-requested model name. Reduces the gateway's
 * accepted indirection layers to physical model ids, then applies `policy`:
 * - variant ids (`base-variant`, `base#variant`) → resolved via `variantBase`
 *   to the base model id that will actually serve
 * - combo ids → allowed only when EVERY member passes (no silent composition
 *   change: a combo with a denied member is rejected outright)
 * - virtual `auto*` entries: deny mode blocks explicitly listed tiers; ALLOW
 *   mode requires the virtual id to be named by the whitelist (exact or
 *   wildcard) — an unnamed entry is not part of the whitelist
 * - `default` behaves like `auto`
 *
 * Returns { ok: true } or { ok: false, denied } with the denied ids
 * for the 403 error message.
 */
export function checkRequestedModel(
  requestedModel: string,
  policy: ModelAccessConfig | undefined,
  comboMembers: (comboId: string) => { id: string; tier?: string }[],
  variantBase?: (id: string) => { id: string; tier?: string } | undefined,
  modelTier?: (id: string) => string | undefined
): { ok: true } | { ok: false; denied: string[] } {
  if (!policy) return { ok: true };
  const requested = requestedModel === 'default' ? 'auto' : requestedModel;
  if (!requested) return { ok: true };

  if (requested === 'auto' || requested.startsWith('auto-')) {
    if (policy.mode === 'deny') {
      const reqTier = tierFromVirtualEntry(requested);
      if (reqTier && policy.models.some((e) => tierFromVirtualEntry(e) === reqTier)) {
        return { ok: false, denied: [requested] };
      }
      return { ok: true };
    }
    // Allow mode: virtual entries must be named by the whitelist.
    return isModelAllowed(requested, policy) ? { ok: true } : { ok: false, denied: [requested] };
  }

  // Variant syntax first — the base id is the physical model that serves.
  const resolved = variantBase?.(requestedModel);
  const candidate = resolved ?? { id: requestedModel, tier: modelTier?.(requestedModel) };

  const members = comboMembers(requestedModel);
  if (members.length > 0) {
    // Tier-aware: combo members are judged with their tier so that virtual
    // tier entries in the policy apply to them identically to the pool.
    const denied = members.filter((m) => !isModelAllowed(m.id, policy, m.tier));
    return denied.length === 0 ? { ok: true } : { ok: false, denied: denied.map((m) => m.id) };
  }

  return isModelAllowed(candidate.id, policy, candidate.tier)
    ? { ok: true }
    : { ok: false, denied: [candidate.id] };
}

/**
 * Should the virtual auto* entry `id` surface as usable for `policy`?
 * `tierAllowed(tier)` reports whether at least one REGISTERED model of that
 * tier passes the (tier-expanded) policy.
 * - deny mode: usable unless its tier is explicitly denied, while anything
 *   is routable at all.
 * - allow mode: the whitelist must NAME the entry (exact or wildcard), AND
 *   it must be runtime-viable — bare `auto` needs at least one allowed model
 *   in ANY tier, `auto-X` needs one in tier X — otherwise the preview would
 *   promise a 200 that the execution pool turns into a 403.
 */
export function isAutoEntryUsable(
  id: string,
  policy: ModelAccessConfig | undefined,
  tierAllowed: (tier: string) => boolean
): boolean {
  if (!policy) return true;
  const ALL_TIERS = ['lite', 'plus', 'pro', 'ultra'];
  const vt = tierFromVirtualEntry(id);
  if (policy.mode === 'deny') {
    if (vt && policy.models.some((e) => tierFromVirtualEntry(e) === vt)) return false;
    return ALL_TIERS.some(tierAllowed);
  }
  if (!isModelAllowed(id, policy)) return false;
  if (!vt) return ALL_TIERS.some(tierAllowed);
  return tierAllowed(vt);
}

/**
 * Fastify guard factory shared by all three inference surfaces
 * (/v1/chat/completions, /v1/messages, /v1/responses). Reads the `authInfo`
 * the auth preHandler attached (absent when auth is disabled — unrestricted),
 * resolves variants/combos to physical member ids and 403s with an
 * OpenAI-style error when the key's policy denies the requested model.
 */
export function makeModelAccessGuard(registry: {
  getModel: (id: string) => { tier?: string } | undefined;
  resolveCombo: (comboId: string) => { id: string; tier?: string }[];
  resolveVariantRef: (modelId: string) => { base: { id: string; tier?: string } } | null;
}) {
  return (req: any, reply: any, requestedModel: string): boolean => {
    const authInfo = req.authInfo;
    const policy = getModelAccessPolicy(authInfo?.keyConfig);
    const verdict = checkRequestedModel(
      requestedModel,
      policy,
      (comboId) => registry.resolveCombo(comboId),
      (id) => {
        const ref = registry.resolveVariantRef(id);
        return ref ? { id: ref.base.id, tier: ref.base.tier } : undefined;
      },
      (id) => registry.getModel(id)?.tier
    );
    if (!verdict.ok) {
      reply.status(403).send({
        error: {
          message: `API key '${authInfo?.keyConfig?.name || ''}' is not allowed to use model '${requestedModel}' (model policy: ${policy!.mode} [${policy!.models.join(', ')}])`,
          type: 'invalid_request_error',
          code: 'model_not_allowed',
        },
      });
      return false;
    }
    return true;
  };
}

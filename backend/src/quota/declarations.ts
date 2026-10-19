import type { QuotaCodeAdapter, QuotaProbeEntry } from './types.js';

/**
 * Built-in declaration table (L-b) — ships with the release, keyed by the OCR
 * CATALOG provider id (never another project's id namespace). Coverage here is
 * independent of the live credential pool: a covered provider's credential
 * appearing anywhere in the store arms its probes automatically.
 *
 * Per-entry discipline:
 *  - every host was cross-checked against the catalog inference baseURL so
 *    probe origin == provider's own domain;
 *  - every `auth` choice is disclosed here and in the decision record
 *    (bearer = the inference
 *    header reused; x-api-key = the endpoint's documented key header);
 *  - facts (endpoints + response shapes) were verified against the providers'
 *    public API documentation, cross-checked against a public MIT reference
 *    implementation — borrowed as FACTS only, this table and the
 *    engine are original OCR code.
 */

export const BUILTIN_QUOTA_DECLARATIONS: QuotaProbeEntry[] = [
  {
    id: 'deepseek',
    providerId: 'deepseek',
    // GET /user/balance — same origin as the inference baseURL
    // (https://api.deepseek.com), same Bearer auth.
    url: 'https://api.deepseek.com/user/balance',
    auth: 'bearer',
    windows: {
      form: 'each',
      path: 'balance_infos',
      window: {
        nameSpec: { template: 'Balance ({currency})', code: 'balance', argPath: 'currency' },
        // Credit-pool flattening (v1-lossy: currency +
        // granted/topped-up split are not modeled): the balance reads as a
        // pool that drains from its current total — used 0 at fetch time,
        // total = the live balance. A funded credential is 100% left, an empty
        // one 0%.
        used: { literal: 0 },
        total: { firstOf: [{ path: 'total_balance' }, { path: 'totalBalance' }] },
      },
    },
    builtin: true,
  },
  {
    id: 'openrouter',
    providerId: 'openrouter',
    // GET /api/v1/key — same origin as https://openrouter.ai/api/v1 inference,
    // same Bearer auth. `limit: null` means no per-key cap.
    url: 'https://openrouter.ai/api/v1/key',
    auth: 'bearer',
    windows: {
      form: 'static',
      windows: [
        {
          name: 'Credits',
          nameCode: 'credits',
          used: { path: 'usage' },
          total: { path: 'limit' },
          remaining: { path: 'limit_remaining' },
        },
      ],
    },
    cacheTtlMs: 15 * 60_000,
    builtin: true,
  },
  {
    id: 'vercel',
    providerId: 'vercel',
    // GET https://ai-gateway.vercel.sh/v1/credits — the gateway's own origin
    // (catalog `vercel` = Vercel AI Gateway, @ai-sdk/gateway default base
    // https://ai-gateway.vercel.sh), Bearer AI_GATEWAY_API_KEY (inference
    // auth). USD decimal strings; flattened to numbers (currency is v1-lossy).
    url: 'https://ai-gateway.vercel.sh/v1/credits',
    auth: 'bearer',
    windows: {
      form: 'static',
      windows: [
        {
          name: 'Credits',
          nameCode: 'credits',
          used: { path: 'total_used' },
          remaining: { path: 'balance' },
        },
      ],
    },
    cacheTtlMs: 15 * 60_000,
    builtin: true,
  },
  {
    id: 'zhipuai',
    providerId: 'zhipuai',
    // GET https://open.bigmodel.cn/api/monitor/usage/quota/limit — catalog
    // `zhipuai` inference base is https://open.bigmodel.cn/api/paas/v4 (same
    // origin), Bearer (inference auth).
    url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    auth: 'bearer',
    windows: {
      form: 'each',
      path: 'data.limits',
      window: {
        where: { path: 'type', in: ['TOKENS_LIMIT', 'CREDIT_LIMIT'] },
        nameSpec: {
          from: 'unit',
          // GLM window unit codes: 3 = rolling session (number = hours),
          // 6 = weekly. Other units fall through with the raw number.
          enumMap: { '3': 'Session ({number}h)', '6': 'Weekly (7d)' },
          enumCode: { '3': 'sessionHours', '6': 'weekly7d' },
          fallback: 'Limit ({number})',
          code: 'limit',
          argPath: 'number',
        },
        used: { path: 'percentage' },
        total: { literal: 100 },
        resetAt: { path: 'nextResetTime', time: true },
      },
      plan: { template: 'GLM {data.level}' },
    },
    builtin: true,
  },
  {
    id: 'zhipuai-coding-plan',
    providerId: 'zhipuai-coding-plan',
    // Catalog `zhipuai-coding-plan` inference base is
    // https://open.bigmodel.cn/api/coding/paas/v4 — same origin as the
    // monitor endpoint above.
    url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    auth: 'bearer',
    windows: {
      form: 'each',
      path: 'data.limits',
      window: {
        where: { path: 'type', in: ['TOKENS_LIMIT', 'CREDIT_LIMIT'] },
        nameSpec: {
          from: 'unit',
          enumMap: { '3': 'Session ({number}h)', '6': 'Weekly (7d)' },
          enumCode: { '3': 'sessionHours', '6': 'weekly7d' },
          fallback: 'Limit ({number})',
          code: 'limit',
          argPath: 'number',
        },
        used: { path: 'percentage' },
        total: { literal: 100 },
        resetAt: { path: 'nextResetTime', time: true },
      },
      plan: { template: 'GLM {data.level}' },
    },
    builtin: true,
  },
  {
    id: 'kimi-code-plan-cn',
    providerId: 'kimi-code-plan-cn',
    // GET https://api.kimi.com/coding/v1/usages — same origin as the catalog
    // inference base https://api.kimi.com/coding/v1. The usage endpoint takes
    // the key in `x-api-key` (disclosed above; the chat leg sends the
    // combined form).
    url: 'https://api.kimi.com/coding/v1/usages',
    auth: 'x-api-key',
    windows: {
      form: 'static',
      windows: [
        {
          name: 'Weekly',
          nameCode: 'weekly',
          // usage is an OBJECT on the response (limits is the sibling array);
          // the DSL path walks it directly. `where` gates on a real cap so a
          // limit-less free credential does not read as an unlimited 100% window.
          where: { path: 'usage.limit', exists: true },
          used: { path: 'usage.used' },
          total: { path: 'usage.limit' },
          remaining: { path: 'usage.remaining' },
          resetAt: { path: 'usage.resetTime', time: true },
        },
      ],
      plan: {
        from: 'user.membership.level',
        enumMap: {
          LEVEL_BASIC: 'Moderato',
          LEVEL_INTERMEDIATE: 'Allegretto',
          LEVEL_ADVANCED: 'Allegro',
          LEVEL_STANDARD: 'Vivace',
        },
      },
    },
    builtin: true,
  },
  {
    id: 'opencode',
    providerId: 'opencode',
    // Zen surface: GET https://opencode.ai/zen/v1/usage — same origin as the
    // catalog inference base https://opencode.ai/inference/v1, same Bearer.
    // Windows are percent-of-cap per rolling period.
    url: 'https://opencode.ai/zen/v1/usage',
    auth: 'bearer',
    windows: {
      form: 'eachObject',
      path: 'usage',
      window: {
        nameSpec: {
          from: '@key',
          enumMap: { rolling: 'Rolling', weekly: 'Weekly', monthly: 'Monthly' },
          enumCode: { rolling: 'rolling', weekly: 'weekly', monthly: 'monthly' },
        },
        used: { path: 'percent' },
        total: { literal: 100 },
        resetAt: { path: 'resetsAt', time: true },
      },
    },
    builtin: true,
  },
  {
    id: 'opencode-go',
    providerId: 'opencode-go',
    // GET https://opencode.ai/zen/go/v1/usage — same origin as the catalog
    // inference base https://opencode.ai/inference/go/v1, same Bearer.
    url: 'https://opencode.ai/zen/go/v1/usage',
    auth: 'bearer',
    windows: {
      form: 'eachObject',
      path: 'usage',
      window: {
        nameSpec: {
          from: '@key',
          enumMap: { rolling: 'Rolling', weekly: 'Weekly', monthly: 'Monthly' },
          enumCode: { rolling: 'rolling', weekly: 'weekly', monthly: 'monthly' },
        },
        used: { path: 'percent' },
        total: { literal: 100 },
        resetAt: { path: 'resetsAt', time: true },
      },
    },
    builtin: true,
  },
  {
    id: 'moonshotai',
    providerId: 'moonshotai',
    // GET /v1/users/me/balance — same origin as the catalog `moonshotai`
    // inference base https://api.moonshot.ai/v1, same Bearer. Documented
    // surface: `data.available_balance` (USD decimal string, vouchers
    // included). Credit-pool flattening (v1-lossy: the cash/voucher split is
    // not modeled): the balance reads as a pool draining from its live total
    // — used 0 at fetch time, total = the live available amount.
    url: 'https://api.moonshot.ai/v1/users/me/balance',
    auth: 'bearer',
    windows: {
      form: 'static',
      windows: [
        {
          // Raw name, no nameCode: the static form carries no nameArg, and
          // the coded `balance` template would render an unbound "{n}".
          name: 'Balance (USD)',
          used: { literal: 0 },
          total: { firstOf: [{ path: 'data.availableBalance' }, { path: 'data.available_balance' }] },
        },
      ],
    },
    cacheTtlMs: 15 * 60_000,
    builtin: true,
  },
  {
    id: 'moonshotai-cn',
    providerId: 'moonshotai-cn',
    // The .cn twin of `moonshotai` — identical shape, CNY unit, host
    // api.moonshot.cn (the two consoles' keys never interoperate; a wrong-host
    // key honestly 401s and the probe fails without a snapshot).
    url: 'https://api.moonshot.cn/v1/users/me/balance',
    auth: 'bearer',
    windows: {
      form: 'static',
      windows: [
        {
          name: 'Balance (CNY)',
          used: { literal: 0 },
          total: { firstOf: [{ path: 'data.availableBalance' }, { path: 'data.available_balance' }] },
        },
      ],
    },
    cacheTtlMs: 15 * 60_000,
    builtin: true,
  },
];

/** Provider ids covered by the DSL table (L-c adapters cover others). */
export function builtinDslProviderIds(): string[] {
  return BUILTIN_QUOTA_DECLARATIONS.map((e) => e.providerId);
}

/**
 * Providers whose quota needs CODE (built-in adapters, L-c — one file per
 * provider under quota/adapters/): MiniMax is the only v1 entry (multi-URL
 * fallback + per-URL inverted count semantics — both banned DSL classes).
 * The scheduler consults this registry BEFORE the DSL table (L-c wins).
 */
import { MINIMAX_ADAPTER } from './adapters/minimax.js';

export function builtinAdapters(): QuotaCodeAdapter[] {
  return [MINIMAX_ADAPTER];
}

/** All provider ids the release covers (DSL + adapters), for coverage views. */
export function allBuiltinCoveredProviderIds(): string[] {
  return [...builtinDslProviderIds(), ...builtinAdapters().flatMap((a) => a.providerIds)];
}

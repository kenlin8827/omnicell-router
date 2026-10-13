import fs from 'node:fs';
import path from 'node:path';
import { isMap, parse, parseDocument, stringify } from 'yaml';
import { Layer2JudgeConfig, RequestCaptureConfig, RouterConfig, WebAuthConfig } from './types.js';
import { DEFAULT_RETRIABLE_CAUSES } from '../resilience/types.js';
import { ensureEnvScaffold, getEnvPaths, resolveEnvName } from './env.js';

// Bootstrap levers (OCR_ENV / OCR_HOME) come from the REAL process environment
// only — there is no .env loader. A file-based override would be a second,
// cwd-dependent source of truth next to the envs/current pointer (ADR-0018).

const DEFAULT_CONFIG: RouterConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '127.0.0.1',
  adminApiKey: process.env.ROUTER_API_KEY || undefined,
  // First-boot tier members live HERE, not in runtime seeding: defaultConfigYaml()
  // bakes them into every brand-new config.yaml and the loadConfig() fallback
  // below re-applies them when a file has no `tiers:` section at all. One glob
  // per tier over the full `provider/model` id (case-insensitive), mapping the
  // four Claude model families lite→ultra: haiku / sonnet / opus / fable.
  tiers: {
    lite: { members: [{ pattern: '*haiku*' }] },
    plus: { members: [{ pattern: '*sonnet*' }] },
    pro: { members: [{ pattern: '*opus*' }] },
    ultra: { members: [{ pattern: '*fable*' }] },
  },
  routing: { mode: 'smart' },
  fallback: {
    enabled: true,
    maxRetries: 1,
    escalateTier: 'plus',
    injectErrorContext: true,
  },
  classifier: {
    localModel: {
      enabled: false,
      confidenceThreshold: 0.85,
    },
    layer2: {
      enabled: false,
      // No model pinned by default — the judge then follows
      // `systemone.defaultModel`.
      timeoutMs: 1500,
      collectEnabled: false, // dataset sampling: judged decisions → data/layer2-decisions.jsonl (single-key gate, opt-in)
    },
  },
  flywheel: {
    // Opt-in: writing user prompts to disk is not a sensible default, and with
    // it on, every `bun test` run appends its fixtures to the production
    // dataset. Existing deployments that set `flywheel.enabled: true` in
    // config.yaml keep collecting — only the implicit default changes.
    enabled: false,
    datasetPath: './data/flywheel.jsonl',
    maxSamples: 100000,
    logUserPrompt: true,
    // Retention knobs default OFF (0 = disabled): a boot + hourly sweep that
    // silently deletes training history with no backup must be an explicit
    // operator decision (docs/design/flywheel-deletion.md D4). Backward
    // compat: deployments without these keys keep never auto-deleting.
    retentionDays: 0,
    maxFileSizeMB: 0,
  },
  proxy: {
    enabled: false, // opt-in: proxying only when explicitly enabled
    url: 'http://127.0.0.1:7890',
  },
  forwardProxy: {
    enabled: false, // opt-in: full-capture MITM proxy must be enabled consciously
    port: 4555,
    host: '127.0.0.1',
    bypassHosts: [],
    viaOutboundProxy: false, // opt-in: transit egress via the outbound proxy policy
  },
  compression: {
    rtk: { enabled: false },
    headroom: { enabled: false, url: 'http://127.0.0.1:8787', timeoutMs: 3000 },
    caveman: { enabled: false, level: 'full' },
  },
  requestCapture: {
    enabled: false, // opt-in: full bodies may contain sensitive data
    retentionDays: 7,
    maxTotalMB: 512,
    maxBodyBytes: 65536,
    // System One group: surface master + judge-leg sub-switch, both default
    // ON — they only matter under the capture master, and a user who turns
    // the master on asked for capture; silence BOTH legs by flipping the
    // group master off, or exempt just the judge leg via the sub-switch.
    systemone: { enabled: true, l2DecisionEnabled: true },
  },
  tracePersist: {
    enabled: true, // default on: console history survives restarts (pure observability data)
    retentionDays: 7,
    maxTotalMB: 100,
  },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 3,
    slidingWindowSize: 20,
    failureRateThreshold: 0.5,
    initialCooldownMs: 30000,
    maxCooldownMs: 5 * 3600 * 1000, // 5 hours max cooldown
    cooldownMultiplier: 2.0,
    quotaCooldownMs: 12 * 3600 * 1000, // 12 hours for quota/balance exhaustion
    halfOpenMaxProbes: 1,
    activeProbing: {
      enabled: false,
      intervalMs: 60000,
    },
    accountAffinity: {
      // ADR-0019 Decision 7 — a session keeps its account while its pair breaker is up;
      // idle past this window it re-spreads like a new session (the upstream
      // prompt cache is gone by then anyway). 300000 = Anthropic cache TTL.
      cacheTtlMs: 300000,
    },
  },
  retry: {
    enabled: true,
    inplace: {
      enabled: true,
      maxAttempts: 1,
      backoffMs: 200,
      jitterMs: 100,
      retryOnCauses: [...DEFAULT_RETRIABLE_CAUSES],
      maxRateLimitWaitMs: 2000,
    },
    failover: {
      enabled: true,
      maxAttempts: 2,
      tierCrossPolicy: 'allow_escalate',
    },
  },
  apiKeys: [],
  providers: [],
  models: [],
};

export function getConfigPath(customPath?: string): string {
  // Top priority: an explicit path from the caller (CLI --config, tests).
  if (customPath) return path.resolve(customPath);
  // Otherwise the active environment's own config.yaml. resolveEnvName()
  // fails fast on an unknown env — loud startup error.
  return getEnvPaths().configPath;
}

/**
 * webAuth sanitizer: shallow-copies and strips anything that must never
 * persist — a hand-written plaintext `password` key (hashes only), so a
 * round-tripped config can't leak or overwrite the stored hash format.
 * (Exported for the environment-archive import path — config/env-archive.ts.)
 */
export function sanitizeWebAuthInput(input: unknown): WebAuthConfig | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const wa = { ...(input as WebAuthConfig) };
  delete (wa as { password?: unknown }).password;
  return wa;
}

/**
 * Layer 2 sanitizer: drops the retired vendor-connection keys (`provider`,
 * `baseUrl`, `apiKey`) left over from the pre-System-One judge, which talked
 * to a hand-configured vendor endpoint. The judge now addresses a REGISTERED
 * model through the gateway's own System One protocol, so those
 * keys are meaningless — and keeping them would re-persist dead settings on
 * every console save. `decisionCapture` joins the drop list after the
 * dataset-sampling move to classifier.layer2.collectEnabled (old key ignored).
 */
function sanitizeLayer2Input(input: unknown): Layer2JudgeConfig {
  const merged = { ...DEFAULT_CONFIG.classifier?.layer2, ...(input as Layer2JudgeConfig) } as Layer2JudgeConfig & {
    provider?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
    decisionCapture?: unknown;
  };
  delete merged.provider;
  delete merged.baseUrl;
  delete merged.apiKey;
  delete merged.decisionCapture;
  return merged;
}

/**
 * Resolve the `requestCapture:` tree from a raw parsed config. Only known
 * fields are picked, so retired/junk keys never round-trip into a saved
 * config.yaml. Raw YAML values pass through unchecked (type enforcement is
 * the consumers' nullish-merge).
 */
function resolveRequestCapture(parsed: any): RequestCaptureConfig {
  const base = DEFAULT_CONFIG.requestCapture as RequestCaptureConfig;
  const raw = (parsed?.requestCapture ?? {}) as Record<string, unknown>;
  // `as` cast: raw YAML is untyped at this boundary; the old spread was too.
  const pick = <K extends 'enabled' | 'retentionDays' | 'maxTotalMB' | 'maxBodyBytes' | 'dir'>(key: K) =>
    (raw[key] ?? base[key]) as RequestCaptureConfig[K];
  const sysRaw = raw.systemone as Record<string, unknown> | undefined;
  return {
    enabled: pick('enabled'),
    retentionDays: pick('retentionDays'),
    maxTotalMB: pick('maxTotalMB'),
    maxBodyBytes: pick('maxBodyBytes'),
    dir: pick('dir'),
    systemone: {
      enabled: (sysRaw?.enabled ?? base.systemone?.enabled) as boolean,
      l2DecisionEnabled: (sysRaw?.l2DecisionEnabled ?? base.systemone?.l2DecisionEnabled) as boolean,
    },
  };
}

export function loadConfig(configPath?: string): RouterConfig {
  const resolvedPath = getConfigPath(configPath);
  if (fs.existsSync(resolvedPath)) {
    try {
      const raw = fs.readFileSync(resolvedPath, 'utf8');
      const parsed = parse(raw);
      // Removed keys (retired systems: `rules:`, `classifier.layer2.decisionCapture`,
      // the renamed `capture:` section, key-level `role`) are STRIPPED here so
      // stale keys never re-persist on the next config save. No dual-read, no
      // migration — the config tree is the only source of truth.
      const {
        rules: _removedRules,
        capture: _removedCapture,
        ...parsedRest
      } = parsed || {};
      return applyTestEnvOverrides({
        ...DEFAULT_CONFIG,
        ...parsedRest,
        // `role` (removed key-level RBAC — unrestricted is expressed by
        // simply not configuring modelAccess) is stripped so stale keys
        // don't get re-persisted on the next config save.
        apiKeys: (parsed?.apiKeys || DEFAULT_CONFIG.apiKeys).map(({ role: _role, ...k }: { role?: unknown; [k: string]: unknown }) => k),
        webAuth: sanitizeWebAuthInput(parsed?.webAuth),
        // Absent `tiers:` section → ship the DEFAULT_CONFIG template members
        // (the 4 glob rules); an explicit `tiers: {}` stays `{}` (truthy) —
        // empty pools + the boot-direct warning, the operator's own choice.
        // Cloned so a future in-place edit cannot poison the module template.
        tiers: parsed?.tiers || structuredClone(DEFAULT_CONFIG.tiers),
        routing: { ...DEFAULT_CONFIG.routing, ...parsed?.routing },
        fallback: { ...DEFAULT_CONFIG.fallback, ...parsed?.fallback },
        classifier: {
          localModel: { ...DEFAULT_CONFIG.classifier?.localModel, ...parsed?.classifier?.localModel },
          // Retired Layer 2 vendor keys (`provider` / `baseUrl` / `apiKey` — the
          // judge now calls a registered model over the System One protocol)
          // are stripped so stale values don't get re-persisted on
          // the next console save.
          layer2: sanitizeLayer2Input(parsed?.classifier?.layer2),
        },
        flywheel: { ...DEFAULT_CONFIG.flywheel, ...parsed?.flywheel },
        proxy: { ...DEFAULT_CONFIG.proxy, ...parsed?.proxy },
        forwardProxy: { ...DEFAULT_CONFIG.forwardProxy, ...parsed?.forwardProxy },
        compression: {
          rtk: { ...DEFAULT_CONFIG.compression?.rtk, ...parsed?.compression?.rtk },
          headroom: { ...DEFAULT_CONFIG.compression?.headroom, ...parsed?.compression?.headroom },
          caveman: { ...DEFAULT_CONFIG.compression?.caveman, ...parsed?.compression?.caveman },
        },
        requestCapture: resolveRequestCapture(parsed),
        tracePersist: { ...DEFAULT_CONFIG.tracePersist, ...parsed?.tracePersist },
        circuitBreaker: { ...DEFAULT_CONFIG.circuitBreaker, ...parsed?.circuitBreaker },
        retry: {
          enabled: parsed?.retry?.enabled ?? DEFAULT_CONFIG.retry?.enabled,
          inplace: { ...DEFAULT_CONFIG.retry?.inplace, ...parsed?.retry?.inplace },
          failover: { ...DEFAULT_CONFIG.retry?.failover, ...parsed?.retry?.failover },
        },
        providers: parsed?.providers || DEFAULT_CONFIG.providers,
        models: parsed?.models || DEFAULT_CONFIG.models,
        combos: parsed?.combos || [],
        catalog: parsed?.catalog,
      });
    } catch (err) {
      console.warn(`[Config] Failed to parse ${resolvedPath}, falling back to defaults:`, err);
    }
  }
  return applyTestEnvOverrides(DEFAULT_CONFIG);
}

/**
 * Test-run guard for the flywheel collector.
 *
 * `bun test` sets NODE_ENV=test, and the test process loads the REAL config.yaml
 * — where operators reasonably keep `flywheel.enabled: true` for live traffic.
 * Without this override, every test run appends its fixtures to the production
 * dataset (observed: 6,600+ synthetic rows accumulated alongside 8 real ones).
 * Only the flywheel switch is forced off; every other config value is passed
 * through untouched, and tests that exercise the collector directly construct
 * FlywheelCollector with an explicit config + temp path, bypassing loadConfig.
 */
function applyTestEnvOverrides(cfg: RouterConfig): RouterConfig {
  if (process.env.NODE_ENV !== 'test') return cfg;
  return { ...cfg, flywheel: { ...cfg.flywheel, enabled: false } };
}

/**
 * Annotated default-config template: DEFAULT_CONFIG serialized through the
 * same self-documenting comment pipeline as saveConfig(). Single source of
 * truth for what a fresh config.yaml looks like — never a static example
 * file that would drift from DEFAULT_CONFIG / YAML_FIELD_COMMENTS.
 */
export function defaultConfigYaml(): string {
  return annotateYamlComments(stringify(DEFAULT_CONFIG));
}

/**
 * First-boot template initialization: when the active environment has no
 * config.yaml yet, write the annotated default template to disk so a fresh
 * install starts with a self-documenting file instead of silent in-memory
 * defaults plus an empty raw-YAML editor. Idempotent — an existing file is
 * never touched; write failures only warn (the gateway can run purely on
 * in-memory defaults). Called once at gateway boot, deliberately NOT inside
 * loadConfig (which runs on auth hot paths and in tests: no write side
 * effects on a read function).
 */
export function ensureDefaultConfigFile(): { created: boolean; path: string } {
  const configPath = getConfigPath();
  // Every env needs its tree (state dirs + env.json) before the first write
  // lands in it — the bootstrap `default` included. Idempotent.
  try {
    ensureEnvScaffold(resolveEnvName());
  } catch (err: any) {
    console.warn(`[Config] Could not scaffold the environment tree for ${configPath}: ${err.message}`);
  }
  if (fs.existsSync(configPath)) return { created: false, path: configPath };
  try {
    fs.writeFileSync(configPath, defaultConfigYaml(), 'utf8');
    return { created: true, path: configPath };
  } catch (err: any) {
    console.warn(`[Config] Could not write default config template to ${configPath}: ${err.message}`);
    return { created: false, path: configPath };
  }
}

export function getRawConfig(): string {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    return fs.readFileSync(configPath, 'utf8');
  }
  // No file yet — return the annotated default template so the raw-YAML
  // editor starts from a self-documenting draft; saving it creates the file.
  return defaultConfigYaml();
}

export function saveRawConfig(yamlContent: string): { success: boolean; error?: string } {
  const configPath = getConfigPath();
  try {
    const parsed = parse(yamlContent);
    if (!parsed || typeof parsed !== 'object') {
      return { success: false, error: 'YAML must define an object configuration' };
    }
    fs.writeFileSync(configPath, yamlContent, 'utf8');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Live reference to the RUNNING server's config object (registered by
 * createServer). The auth preHandler prefers `config.apiKeys` over a fresh
 * disk read (boot snapshot) — without syncing, a key edited via the UI or the
 * YAML editor would persist to config.yaml yet keep failing on the wire until
 * the next restart. Every config save refreshes the snapshot's keys in-place.
 */
let runtimeConfigRef: RouterConfig | undefined;

/** Called once by createServer so config saves can refresh the boot snapshot. */
export function registerRuntimeConfigRef(cfg: RouterConfig): void {
  runtimeConfigRef = cfg;
}

/**
 * Live config snapshot (createServer's object, hot-synced by saveConfig for
 * the fields the running gateway reads per request: apiKeys, webAuth).
 * Console-auth endpoints prefer it over a disk re-read so the gate and the
 * credential checks can never disagree.
 */
export function getRuntimeConfigRef(): RouterConfig | undefined {
  return runtimeConfigRef;
}

export function saveConfig(newConfig: Partial<RouterConfig>): { success: boolean; error?: string } {
  const configPath = getConfigPath();
  try {
    const current = loadConfig();
    const merged = { ...current, ...newConfig };
    // webAuth passwordHash preservation: GET /api/admin/config strips the
    // hash, so UI round-trips (SettingsPage saveConfig(config)) would erase
    // it — re-attach the stored hash whenever the incoming payload lacks one.
    if (merged.webAuth && current.webAuth?.passwordHash && !merged.webAuth.passwordHash) {
      merged.webAuth = { ...merged.webAuth, passwordHash: current.webAuth.passwordHash };
    }
    merged.webAuth = sanitizeWebAuthInput(merged.webAuth);
    const yamlContent = annotateYamlComments(stringify(merged));
    fs.writeFileSync(configPath, yamlContent, 'utf8');
    // Single sync point: whichever path saved the config (key CRUD, visual
    // editor, ...), the running gateway's key snapshot follows immediately.
    if (runtimeConfigRef) runtimeConfigRef.apiKeys = merged.apiKeys;
    // Same for webAuth — the console-auth gate reads it per request and the
    // runtime ref IS the createServer snapshot object, so this is hot.
    if (runtimeConfigRef) runtimeConfigRef.webAuth = merged.webAuth;
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── YAML comment annotation ────────────────────────────────────────────────
// loadConfig() parses config.yaml into a plain object, so hand-written comments
// are lost on every visual-config save. saveConfig() therefore re-attaches
// per-field comments from the map below before writing, keeping the on-disk
// file self-documenting. saveRawConfig() writes user YAML verbatim and keeps
// whatever comments the user typed.

const YAML_FILE_HEADER = [
  'OpenCode Router 网关配置（config.yaml）',
  '可视化编辑：控制台「可视化配置」页；手写编辑：「配置文件」页（原文保存，注释保留）',
  '注意：配置无热加载，保存/修改后需重启网关才生效；价格单位均为 美元/百万 tokens',
].join('\n');

/** yaml pkg renders commentBefore verbatim after '#', so pad one space per line ourselves. */
const padComment = (text: string) => ' ' + text.replace(/\n/g, '\n ');

/** Field path (dotted, relative to root) → zh-CN comment. `tiers.*` covers any tier name. */
const YAML_FIELD_COMMENTS: Record<string, string> = {
  port: '网关监听端口',
  host: '监听地址（默认 127.0.0.1 仅本机；0.0.0.0 = 监听所有网卡，非回环绑定强制启用 webAuth 登录）',
  adminApiKey: '推理面主密钥（/v1/* 全模型访问），亦可作为控制台 /api/admin/* 的程序化访问凭据（Authorization: Bearer）',
  webAuth: '控制台登录鉴权（/admin 管理面的账号密码；绑定非回环地址时强制启用）',
  'webAuth.enabled': '控制台登录开关：true 需账号密码登录；绑定 0.0.0.0 / 局域网 IP 时必须为 true（否则网关拒绝启动），仅 127.0.0.1 绑定可关闭',
  'webAuth.username': '控制台登录用户名',
  'webAuth.passwordHash': '登录密码的 scrypt 哈希（格式 scrypt$<saltHex>$<hashHex>，绝不存明文；在控制台「系统设置」页修改，勿手写）',
  tiers: '梯队成员策略：候选池唯一依据 = 各梯队显式 members 成员列表 + 全局排除名单；默认模板为每个梯队内置 1 条 glob 成员（haiku→lite / sonnet→plus / opus→pro / fable→ultra，运行时不再自动生成种子，删除整个 tiers 段会在下次加载时恢复这套模板默认）；无任何规则命中的模型=未分类，不进任何池；主选策略只影响池内用法（控制台 /tiers 页可视化编辑，保存即时生效）',
  'tiers.*.members': '成员列表（顺序=优先级/failover 链）：每项 { pattern, weight?, effortMap? } —— pattern 匹配完整模型 id（provider/model），glob 通配（* 任意 / ? 单字符，不区分大小写），不带通配符=子串匹配、写完整 id=单项；effortMap=思考级别翻译（如 { none: high, low: high }，未配置的级别原样透传）；同一模型只归属一个梯队（跨档重叠按 lite→plus→pro→ultra 先得，保存时提示）',
  'tiers.exclude': '全局排除名单（在原始 YAML 页编辑；/tiers 页保存时原样回传）：命中的模型不进入任何梯队候选池（无条件；仅可按 id 直连或经组合调用）',
  'tiers.*.selection': '主选策略：priority 优先级 / weighted 加权随机 / round_robin 轮询',
  'tiers.*.match': '【仅匹配建议引擎】不参与路由、不再生成成员列表：用于模型目录页推荐、/tiers 页预览与保存时检查；候选池唯一依据是上方 members，默认模板已内置四档 glob（haiku→lite / sonnet→plus / opus→pro / fable→ultra），请在控制台 /tiers 页增删成员（保存即时生效）',
  'tiers.*.match.patterns': '【仅匹配建议引擎】名称通配符（glob）',
  'tiers.*.match.minInputPerM': '【仅匹配建议引擎】输入价下限 $/M',
  'tiers.*.match.maxInputPerM': '【仅匹配建议引擎】输入价上限 $/M',
  'tiers.*.match.exclude': '【仅匹配建议引擎】名称/价格否决（不给出该梯队建议）',
  'tiers.*.match.excludeTiers': '【仅匹配建议引擎】锚定排除（被引梯队的条件命中即否决）',
  routing: '路由模式：smart=分类级联（默认）/ cost=始终 lite / quality=始终 pro',
  fallback: '失败兜底：重试耗尽后按梯队升级重试',
  'fallback.maxRetries': '兜底重试次数',
  'fallback.escalateTier': '兜底升级目标梯队',
  'fallback.injectErrorContext': '兜底请求是否注入上游错误上下文',
  classifier: '意图分类器（smart 模式的 lite/pro/ultra 判定）',
  'classifier.localModel.enabled': '本地分类模型开关',
  'classifier.localModel.confidenceThreshold': '置信度阈值（低于则交给 layer2 判定）',
  'classifier.layer2.enabled': 'Layer2 判定开关（经本机 System One 协议调用已注册模型）',
  'classifier.layer2.model': '判定模型 id（已注册的模型；留空则用 systemone.defaultModel）',
  'classifier.layer2.timeoutMs': '判定超时（毫秒，超时放行 Layer1 结果）',
  'classifier.layer2.decisionCache': '判定决策缓存（相同上下文复用判定结果）',
  'classifier.layer2.collectEnabled': 'L2 裁判决策样本采集开关（默认 false 关闭）：单键门控，落盘 data/layer2-decisions.jsonl（不进捕捉页），64MB 封顶后停写并告警一次；热生效',
  flywheel: '学习飞轮（路由决策样本沉淀，用于训练分类器；默认关闭）',
  'flywheel.datasetPath': '样本数据集路径（JSONL）',
  'flywheel.maxSamples': '样本条数上限',
  'flywheel.logUserPrompt': '是否记录用户提示词原文（隐私敏感）',
  'flywheel.retentionDays': '样本保留天数（0 或不填=不自动清理；启用后启动时+每小时自动删除超龄样本；自动清理不生成备份、删除不可恢复，请谨慎设置）',
  'flywheel.maxFileSizeMB': '数据集文件大小上限 MB（0 或不填=不限制；超出后从最旧样本开始裁剪；在保留天数清理之后执行；自动清理不生成备份）',
  circuitBreaker: '熔断器（按模型统计失败并自动摘除，见 /guardrails 页）',
  'circuitBreaker.failureThreshold': '窗口内失败次数阈值（达到即熔断）',
  'circuitBreaker.slidingWindowSize': '滑动窗口样本数',
  'circuitBreaker.failureRateThreshold': '失败率阈值（0-1）',
  'circuitBreaker.initialCooldownMs': '首次熔断冷却时长（毫秒）',
  'circuitBreaker.maxCooldownMs': '冷却时长上限（毫秒）',
  'circuitBreaker.cooldownMultiplier': '连续熔断的冷却指数退避倍数',
  'circuitBreaker.quotaCooldownMs': '配额/余额耗尽专用冷却时长（毫秒）',
  'circuitBreaker.halfOpenMaxProbes': '半开状态最大并发探测数',
  'circuitBreaker.activeProbing': '主动探测（冷却期内定时试探是否恢复）',
  'circuitBreaker.activeProbing.intervalMs': '探测间隔（毫秒）',
  'circuitBreaker.accountAffinity': '会话账号亲和（多账号供应商：会话绑定一个账号，仅故障转移时切换，绝不负载均衡）',
  'circuitBreaker.accountAffinity.cacheTtlMs': '亲和窗口（毫秒，默认 300000 = Anthropic 提示缓存 5 分钟）；空闲超过此窗口的会话按新会话重新分散选号',
  retry: '重试策略',
  'retry.inplace': '原地重试（同一模型）',
  'retry.inplace.maxAttempts': '额外重试次数',
  'retry.inplace.backoffMs': '重试基础退避（毫秒）',
  'retry.inplace.jitterMs': '退避随机抖动（毫秒）',
  'retry.inplace.retryOnCauses': '触发重试的错误类型',
  'retry.inplace.maxRateLimitWaitMs': '429 Retry-After 最大等待（毫秒）',
  'retry.failover': '故障转移（切换候选模型重试）',
  'retry.failover.maxAttempts': '故障转移尝试次数',
  'retry.failover.tierCrossPolicy': '跨梯队策略：allow_escalate 允许向上升级',
  apiKeys: '客户端接入密钥（sk-ocr-*，见 /keys 页）',
  opencode: 'OpenCode 本地服务连接',
  proxy: '出站代理策略（保存后即时生效，无需重启；作用于上游模型调用 / Layer2 判定 / 目录与 logo 同步；localhost/127.0.0.1 永不走代理）',
  'proxy.enabled': '出站代理总开关（默认 false 不启用；true 时按 url 与包含/排除规则出站）',
  'proxy.url': '全局代理 URL，http(s)://[user:pass@]host:port —— 需要鉴权时把用户名:密码嵌在 @ 前（自动转为 Proxy-Authorization，含 HTTPS CONNECT 隧道；特殊字符需 URL 编码）；留空 = 直连',
  'proxy.includes': '包含规则（glob）：非空时仅命中者走代理；pattern 匹配 provider/model 组合与模型 id —— anthropic/* 为 provider 级，*/claude-* 或 claude-* 为模型级',
  'proxy.excludes': '排除规则（glob）：命中者强制直连；与 includes 同设时先执行（excludes 命中 = 直连，其余再按 includes 过滤）',
  forwardProxy: '入站前向代理（HTTP_PROXY/HTTPS_PROXY 服务端）：默认全量接管——解密后的 LLM 协议流量（chat/messages/responses）走路由管线，其余透明转发；loopback 与 bypassHosts 命中者纯隧道透传；需在被代理客户端信任导出的 CA（重启网关生效）',
  'forwardProxy.enabled': '入站代理总开关（默认 false）',
  'forwardProxy.port': '代理监听端口（默认 4555；客户端 HTTP_PROXY/HTTPS_PROXY 指向 http://127.0.0.1:4555）',
  'forwardProxy.host': '代理监听地址（默认 127.0.0.1，仅本机）',
  'forwardProxy.bypassHosts': '例外主机（glob）：纯字符串 = 直连隧道；{ host, viaProxy: true } = 经出站代理隧道（逐主机勾选）；loopback 永远绕过',
  'forwardProxy.caDir': 'MITM CA 存放目录（默认 ~/.opencode-router/forward-proxy）',
  'forwardProxy.viaOutboundProxy': '非例外主机的转发请求（未被拦截接管的 GET 等）是否经出站代理；例外主机的出站方式在 bypassHosts 逐行勾选',
  compression: 'Token 压缩（rtk 工具输出压缩 + headroom 上下文压缩 + caveman 输出风格注入；全部失败时放行原文，重启网关生效）',
  'compression.rtk.enabled': 'rtk 工具输出压缩：git/grep/ls/tree/日志/构建输出等工具结果文本压缩 60-90%（本地确定性压缩器，不破坏上游前缀缓存）',
  'compression.headroom.enabled': 'headroom 上下文压缩：转发前调用 headroom sidecar 的 /v1/compress（失败/超时自动放行原文；会话模式保上游前缀缓存）',
  'compression.headroom.url': 'headroom sidecar 地址（需自行运行 headroom proxy，默认 127.0.0.1:8787，仅本机回环）',
  'compression.headroom.timeoutMs': 'headroom 调用超时（毫秒，超时放行原文）',
  'compression.headroom.compressUserMessages': '同时压缩 user 角色文本（会话模式下自动忽略）',
  'compression.caveman.enabled': 'caveman 输出压缩：向 system 幂等注入简洁风格提示词，显著压缩输出 token（代码/路径/命令逐字保留）',
  'compression.caveman.level': 'caveman 强度：lite / full / ultra / wenyan-lite / wenyan / wenyan-ultra（文言）',
  requestCapture: '请求全量捕获（HTTP 交换审计日志；默认关闭）：请求/响应原文落盘 JSONL，捕获体可能含敏感数据且占用磁盘，按日期目录保留、到期或超容量自动清理',
  'requestCapture.systemone.enabled': 'System One 决策面总闸（默认 true；仅当 requestCapture.enabled 为 true 时生效）：关闭时两腿同哑——/v1/systemone 全链路捕捉（客户端请求/响应 + 网关对上游的调用腿；路由指标仍不捕获）连同下方 L2 裁判 HTTP 腿捕捉一并静默；开启时该面全链路捕捉照常（决策体是客户端状态快照，注意隐私与磁盘占用）',
  'requestCapture.systemone.l2DecisionEnabled': 'L2 裁判 HTTP 腿捕捉子开关（默认 true；仅当 requestCapture.enabled 与 requestCapture.systemone.enabled 均为 true 时生效）：L2 裁判内部发起的决策模型调用记为上游捕捉事件（挂外层会话/追踪），与客户端请求捕捉主语正交——只增记裁判自己的线路调用，不筛选客户端流量；注意与 classifier.layer2.collectEnabled（数据集采样落盘）是两个不同开关',
  catalog: '目录数据源：远程 catalog 源定义与本地锚定（控制台 /catalog 页可视化编辑，改后即时生效）',
  'catalog.syncIntervalMs': '目录自动同步周期（毫秒，默认 86400000 = 24h）',
  'catalog.lockedModels': '本地锚定的模型 id 列表：这些模型的本地定义值（含 0 价）不被任何远程源覆盖',
  'catalog.autoPullModels': '自动拉取模型：每个同步周期为自定义服务商拉取模型清单（live /v1/models 优先，只新增不覆盖；默认 true）',
  combos: '自定义模型组合（combo）：把若干已注册模型组成一个虚拟模型名，客户端直接以 combo id 作为 model 调用（控制台 /combos 页可视化编辑，保存后即时生效，无需重启）',
  'combos.*.selection': '主选策略：priority 配置顺序（默认）/ weighted 加权随机 / round_robin 轮询',
  'combos.*.models': '成员列表（顺序即故障转移链序）：成员可写 \'model-id\' 或 { id, weight }（weight 用于 weighted/round_robin，默认 1）',
  'combos.*.note': '备注：仅控制台展示的自由文本，不参与路由',
  session: '会话粘性（棘轮：会话内模型不漂移）',
  'session.strategy': '会话策略：monotonic 单调棘轮 / sticky 粘性 / stateless 无状态',
  'session.ttlSeconds': '会话保持时长（秒）',
  'session.maxSessions': '会话表容量上限',
};

function lookupYamlComment(path: string): string | undefined {
  const direct = YAML_FIELD_COMMENTS[path];
  if (direct !== undefined) return direct;
  const segs = path.split('.');
  // Dynamic map level: tiers.<name>[.field…] → tiers.*[…]
  if (segs[0] === 'tiers' && segs.length >= 2) {
    segs[1] = '*';
    return YAML_FIELD_COMMENTS[segs.join('.')];
  }
  // Dynamic map level: combos.<comboId>.<field…> → combos.*.<field…>
  if (segs[0] === 'combos' && segs.length >= 3) {
    return YAML_FIELD_COMMENTS[`combos.*.${segs.slice(2).join('.')}`];
  }
  return undefined;
}

function applyYamlComments(node: any, prefix: string): void {
  if (!node || typeof node !== 'object' || !Array.isArray(node.items)) return;
  for (const pair of node.items) {
    const keyNode = pair?.key;
    const keyName = keyNode?.value != null ? String(keyNode.value) : null;
    if (!keyName) continue;
    const fieldPath = prefix ? `${prefix}.${keyName}` : keyName;
    const comment = lookupYamlComment(fieldPath);
    if (comment) keyNode.commentBefore = padComment(comment);
    // Recurse into plain mappings only; sequences (models/apiKeys/weights…) are
    // documented at their key — per-item comments would drown the file.
    if (isMap(pair.value)) applyYamlComments(pair.value, fieldPath);
  }
}

/** Attach file header + per-field comments; returns input untouched if it can't be parsed as a mapping. */
export function annotateYamlComments(yamlText: string): string {
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return yamlText;
  if (!doc.commentBefore) doc.commentBefore = padComment(YAML_FILE_HEADER);
  applyYamlComments(doc.contents, '');
  return doc.toString();
}

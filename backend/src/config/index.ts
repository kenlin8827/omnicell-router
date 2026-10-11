import fs from 'node:fs';
import path from 'node:path';
import { isMap, parse, parseDocument, stringify } from 'yaml';
import dotenv from 'dotenv';
import { RouterConfig, WebAuthConfig } from './types.js';
import { DEFAULT_RETRIABLE_CAUSES } from '../resilience/types.js';

dotenv.config();

const DEFAULT_CONFIG: RouterConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '127.0.0.1',
  adminApiKey: process.env.ROUTER_API_KEY || undefined,
  baselineModel: 'auto',
  tiers: {},
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
      provider: 'typesafe',
      model: 'typesafe/jev',
      timeoutMs: 1500,
    },
  },
  flywheel: {
    enabled: true,
    datasetPath: './data/flywheel.jsonl',
    maxSamples: 100000,
    logUserPrompt: true,
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
  capture: {
    enabled: false, // opt-in: full bodies may contain sensitive data
    retentionDays: 7,
    maxTotalMB: 512,
    maxBodyBytes: 65536,
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
  if (customPath) return path.resolve(customPath);

  const cwdPath = path.resolve(process.cwd(), 'config.yaml');
  if (fs.existsSync(cwdPath)) return cwdPath;

  // Fallback: search upward to repository root
  try {
    const currentDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const repoRootPath = path.resolve(currentDir, '..', '..', 'config.yaml'); // backend/src/config -> backend/src -> backend -> root
    const altRootPath = path.resolve(currentDir, '..', '..', '..', 'config.yaml');
    if (fs.existsSync(repoRootPath)) return repoRootPath;
    if (fs.existsSync(altRootPath)) return altRootPath;
  } catch {}

  return cwdPath;
}

/**
 * webAuth sanitizer: shallow-copies and strips anything that must never
 * persist — a hand-written plaintext `password` key (hashes only), so a
 * round-tripped config can't leak or overwrite the stored hash format.
 */
function sanitizeWebAuthInput(input: unknown): WebAuthConfig | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const wa = { ...(input as WebAuthConfig) };
  delete (wa as { password?: unknown }).password;
  return wa;
}

export function loadConfig(configPath?: string): RouterConfig {
  const resolvedPath = getConfigPath(configPath);
  if (fs.existsSync(resolvedPath)) {
    try {
      const raw = fs.readFileSync(resolvedPath, 'utf8');
      const parsed = parse(raw);
      // Legacy `rules:` (removed prompt-override system) is stripped so stale
      // keys don't get re-persisted on the next config save.
      const { rules: _legacyRules, ...parsedRest } = parsed || {};
      return {
        ...DEFAULT_CONFIG,
        ...parsedRest,
        // Legacy `role` (removed key-level RBAC — unrestricted is expressed by
        // simply not configuring modelAccess) is stripped so stale keys don't
        // get re-persisted on the next config save.
        apiKeys: (parsed?.apiKeys || DEFAULT_CONFIG.apiKeys).map(({ role: _role, ...k }: { role?: unknown; [k: string]: unknown }) => k),
        webAuth: sanitizeWebAuthInput(parsed?.webAuth),
        tiers: parsed?.tiers || {},
        routing: { ...DEFAULT_CONFIG.routing, ...parsed?.routing },
        fallback: { ...DEFAULT_CONFIG.fallback, ...parsed?.fallback },
        classifier: {
          localModel: { ...DEFAULT_CONFIG.classifier?.localModel, ...parsed?.classifier?.localModel },
          layer2: { ...DEFAULT_CONFIG.classifier?.layer2, ...parsed?.classifier?.layer2 },
        },
        flywheel: { ...DEFAULT_CONFIG.flywheel, ...parsed?.flywheel },
        proxy: { ...DEFAULT_CONFIG.proxy, ...parsed?.proxy },
        forwardProxy: { ...DEFAULT_CONFIG.forwardProxy, ...parsed?.forwardProxy },
        compression: {
          rtk: { ...DEFAULT_CONFIG.compression?.rtk, ...parsed?.compression?.rtk },
          headroom: { ...DEFAULT_CONFIG.compression?.headroom, ...parsed?.compression?.headroom },
          caveman: { ...DEFAULT_CONFIG.compression?.caveman, ...parsed?.compression?.caveman },
        },
        capture: { ...DEFAULT_CONFIG.capture, ...parsed?.capture },
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
      };
    } catch (err) {
      console.warn(`[Config] Failed to parse ${resolvedPath}, falling back to defaults:`, err);
    }
  }
  return DEFAULT_CONFIG;
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
 * First-boot template initialization: when no config.yaml resolves at the
 * default path, write the annotated default template to disk so a fresh
 * install starts with a self-documenting file instead of silent in-memory
 * defaults plus an empty raw-YAML editor. Idempotent — an existing file is
 * never touched; write failures only warn (the gateway can run purely on
 * in-memory defaults). Called once at gateway boot, deliberately NOT inside
 * loadConfig (which runs on auth hot paths and in tests: no write side
 * effects on a read function).
 */
export function ensureDefaultConfigFile(): { created: boolean; path: string } {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) return { created: false, path: configPath };
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
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
  baselineModel: '基线模型 id（FinOps 成本节省的对照基准）',
  tiers: '梯队成员策略：候选池唯一依据 = 各梯队显式 members 成员列表 + 全局排除名单；无任何规则命中的模型=未分类，不进任何池；主选策略只影响池内用法（控制台 /tiers 页可视化编辑，保存即时生效）',
  'tiers.*.members': '成员列表（顺序=优先级/failover 链）：每项 { pattern, weight?, effortMap? } —— pattern 匹配完整模型 id（provider/model），glob 通配（* 任意 / ? 单字符，不区分大小写），不带通配符=子串匹配、写完整 id=单项；effortMap=思考级别翻译（如 { none: high, low: high }，未配置的级别原样透传）；同一模型只归属一个梯队（跨档重叠按 lite→plus→pro→ultra 先得，保存时提示）',
  'tiers.exclude': '全局排除名单（在原始 YAML 页编辑；/tiers 页保存时原样回传）：命中的模型不进入任何梯队候选池（无条件；仅可按 id 直连或经组合调用）',
  'tiers.*.selection': '主选策略：priority 优先级 / weighted 加权随机 / round_robin 轮询',
  'tiers.*.match': '【仅建议引擎】不参与路由：目录页推荐 / 一键导入 / 首启种子仍沿用此匹配规则',
  'tiers.*.match.patterns': '【仅建议引擎】名称通配符（glob）',
  'tiers.*.match.minInputPerM': '【仅建议引擎】输入价下限 $/M',
  'tiers.*.match.maxInputPerM': '【仅建议引擎】输入价上限 $/M',
  'tiers.*.match.exclude': '【已弃用】不参与路由',
  'tiers.*.match.excludeTiers': '【已弃用】不参与路由',
  routing: '路由模式：smart=分类级联（默认）/ cost=始终 lite / quality=始终 pro',
  fallback: '失败兜底：重试耗尽后按梯队升级重试',
  'fallback.maxRetries': '兜底重试次数',
  'fallback.escalateTier': '兜底升级目标梯队',
  'fallback.injectErrorContext': '兜底请求是否注入上游错误上下文',
  classifier: '意图分类器（smart 模式的 lite/pro/ultra 判定）',
  'classifier.localModel.enabled': '本地分类模型开关',
  'classifier.localModel.confidenceThreshold': '置信度阈值（低于则交给 layer2 判定）',
  'classifier.layer2.enabled': 'Layer2 LLM 二次判定开关',
  'classifier.layer2.provider': '判定服务提供方：typesafe/opencode/openrouter/custom',
  'classifier.layer2.model': '判定模型 id',
  'classifier.layer2.timeoutMs': '判定超时（毫秒，超时放行 Layer1 结果）',
  'classifier.layer2.decisionCache': '判定决策缓存（相同上下文复用判定结果）',
  flywheel: '数据飞轮（会话样本沉淀，用于微调数据集）',
  'flywheel.datasetPath': '样本数据集路径（JSONL）',
  'flywheel.maxSamples': '样本条数上限',
  'flywheel.logUserPrompt': '是否记录用户提示词原文（隐私敏感）',
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

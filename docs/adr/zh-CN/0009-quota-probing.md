# ADR-0009：额度跟踪——分层知识、声明式探测与结构禁例、凭据锚定激活

## 状态

已实现 —— 2026-10-15。范围：网关如何获知并展示每个 (providerId × keyHashPrefix) 对的剩余额度、一次探测允许长什么样、探测知识放在哪、探测失败能做什么不能做什么、哪些消费面使用它。凭证身份 / 密钥出口纪律 = ADR-0006；熔断词汇 = ADR-0004；环境布局 = ADR-0007；trace 归因 = ADR-0005/0008。

## 决策

### 1. 总原则：覆盖随 release，激活随凭据

额度状态按 **(providerId, keyHashPrefix)** 对跟踪——与配对熔断、凭证行政标记同一套展示安全的凭据身份（ADR-0006 §6）。两条轴刻意解耦：

- **覆盖**（哪些 provider *可以*被探测）随 release 出货：内置声明表（§3）+ 内置代码 adapter（§4），或随用户配置（§5）。它绝不按当前凭证池快照圈范围：凭证天天增减，而某服务商额度端点的知识不随之变动。
- **激活**（是否真的调度一次探测）随凭据：被覆盖的 provider 只要凭据出现在绑定存储的任意位置（或 config 烘焙的推理 key——无链退化形态），下一轮调度自动armed。凭证池枚举从不参与覆盖判定。

额度面**只展示**：声明的或探测出的上限永远不门控路由。配置过期不得逐出健康配对；下架决定权仍在熔断面（下文），后者依据的是*推理侧*证据，而非探测侧聚合值。

### 2. 数据模型

```
QuotaSnapshot { providerId, keyHashPrefix, windows[], plan?, source, verifiedAt, entryId, lastFailureAt? }
QuotaWindow   { name, used, total, remainingPct, resetAt, unlimited }
source ∈ probed | measured | declared | forked
badge  ∈ probed | declared | unverified | stale        （控制台可见四态）
```

v1 明知有损而有意不建模（在此备案而非塞进模型）：每窗口的 `currency` / `isCreditBalance`（多币种预付费余额拍平为信贷池窗口：`used 0 / total = 实时余额`），以及周期窗口元数据。`measured` 是二期头收割层（L-a）预留的血统值；`declared` 为静态套餐上限声明保留。徽章映射：无快照 → `unverified`；`declared` 血统 → `declared`；最近一次尝试失败或超出条目 cacheTtl → `stale`；其余 `probed`。

存储纪律：快照是凭据锚定的展示安全聚合值，因此住在**全局**状态根（`<OCR_HOME>/quota-snapshots.json`，原子 temp+rename 0600、load-once、防抖写盘——SUSPECT/DISABLED 标记文件先例，ADR-0006 §7），**不是**按环境账本目录：凭证的额度属于凭证本身，在任何环境同样成立。密钥材料永不进文件（只有前缀与数字）。**最后一次探测的原始交换**（url/status/解析后的 body——绝不存响应头，超大或非 JSON 的 body 截断为文本）是同一存储上的**仅内存**侧表，永不序列化：供控制台逐配对的"查看最后一次探测"弹窗使用，重启后即为空。

### 3. L-b：内置声明表（DSL 驱动，随 release）

各家额度端点至少存在六维差异（认证头形态、错误语义、值类型、币种来源、窗口粒度、命名），不存在标准。逐 provider 的 if 链必然腐烂；此表**声明式**，由单一引擎解释（`quota/dsl.ts`）。每条目：一个 provider（以 **OCR catalog** 的 provider id 为键——已逐家对照 `catalog/ocr.json` 核实；外来 id 命名空间不采用）、一个 URL、GET-only、静态 headers、一张窗口抽取表。

host + auth 披露（此表是可信 release 代码；内置条目允许绝对 URL 与非推理认证头——每项选择在此列明）：

| 条目（providerId） | 探测 URL | 认证头 | 推理 origin（catalog） |
| :--- | :--- | :--- | :--- |
| deepseek | `https://api.deepseek.com/user/balance` | `Bearer`（推理同款） | api.deepseek.com ✓ |
| openrouter | `https://openrouter.ai/api/v1/key` | `Bearer`（推理同款） | openrouter.ai/api/v1 ✓ |
| vercel | `https://ai-gateway.vercel.sh/v1/credits` | `Bearer`（推理同款） | gateway vercel.sh origin（catalog `vercel` 无 api 字段；端点以官方 REST 文档为准） |
| zhipuai | `https://open.bigmodel.cn/api/monitor/usage/quota/limit` | `Bearer`（推理同款） | open.bigmodel.cn ✓（双域服务商；国际镜像 api.z.ai 有意不用——catalog 钉在 open.bigmodel.cn） |
| zhipuai-coding-plan | 同一 monitor 端点 | `Bearer`（推理同款） | open.bigmodel.cn ✓ |
| kimi-code-plan-cn | `https://api.kimi.com/coding/v1/usages` | **`x-api-key`**——该端点文档化的 key 头，与推理 `Bearer` 形态不同，按规在此披露 | api.kimi.com ✓ |
| opencode | `https://opencode.ai/zen/v1/usage`（Zen 面） | `Bearer`（推理同款） | opencode.ai ✓（推理基座 `/inference/v1`；usage 面在同 host 的 `/zen/v1` 下） |
| opencode-go | `https://opencode.ai/zen/go/v1/usage` | `Bearer`（推理同款） | opencode.ai ✓ |
| moonshotai | `https://api.moonshot.ai/v1/users/me/balance` | `Bearer`（推理同款） | api.moonshot.ai ✓（积分池余额按 §2 摊平：`used 0 / total = 实时余额`；现金/代金券拆分 v1 不建模；用原始窗口名、无 nameCode——静态形态没有 nameArg 可绑定） |
| moonshotai-cn | `https://api.moonshot.cn/v1/users/me/balance` | `Bearer`（推理同款） | api.moonshot.cn ✓（摊平与命名说明同 `moonshotai`） |

入表前核对规则（每条内置条目出货前执行）：在 `catalog/ocr.json` 找到该 provider → 核对额度端点 origin 同属该服务商自家域 → 才进表。核对不过关者（例如 `qoder`——根本不在 OCR catalog）剔除。

### 4. L-c：内置代码 adapter（一家一文件）

语义无法声明式表达的 provider 落为代码 adapter（`quota/adapters/`，仿 `providers/` 目录）。v1 只有一个：**MiniMax**（`minimax`、`minimax-cn`、`minimax-coding-plan`、`minimax-cn-coding-plan`）。原因：两级 URL 回退链且成员语义**互为反义**（`/coding_plan/` 端点的计数读作 REMAINING，`/token_plan/` 读作 USED），外加相对/绝对两种重置字段与纯百分比共享桶——“per-URL 反义映射”是禁列的表类（§6），且条目单 URL 是铁律。adapter 事实（各地区 URL 序、信封 `base_resp.status_code`、snake/camel 字段对、回退触发码 404/405/5xx、密钥无效判定 401/403/1004）**先自录进文件头部事实清单再动笔**；代码照清单，不照参考项目。待办（列名，暂缓）：Copilot / Zed / Kimi-OAuth 通道——其认证需要铸造/设备流程（非推理形态头），因此永远不能进配置表；只能走 adapter，按需实现。

### 5. L-a 与 L-d：预留的收割层与用户表

- **L-a（二期，仅预留数据面）：** 从推理响应 `x-ratelimit-*` 头收割（捕获面对响应头保留 NAMES、仅脱敏凭据形态的 VALUE，故 `x-ratelimit-*` 三件套在捕获中存活——ADR-0008 §5），挂靠在已落地的 `ExecutionTrace.execution.credentialKeyHashPrefix` 逐轮归因上（第 1 步地基：orchestrator 为实际 SERVED 凭据打戳——与限流凭证 subject 同款链头退化；SQLite 无需 DDL，因为 trace 行是 JSON blob，旧行 replay 该字段为 `undefined`，即 `clientHeaders` 前向兼容先例）。目前没有任何写入方产出 `source: measured`。
- **L-d（config.yaml `quotaProbes:` 节）：** 长尾与自建网关（以及对内置条目的显式 fork）。用户条目受下述铁律约束——它们是铁律**唯一**约束的层（内置代码与 release 表可信，改以 §3/§4 披露代替约束）。

### 6. DSL：十二构件、五类禁例

构件（每个都无需计算即可解析）：窗口三形态（静态具名 / 数组 `each` / 键对象 `eachObject`）；`firstOf` 候选路径；**二推三**（used/total/remaining 任二者推出第三者）；对常量 `invert`；`scale`（比率→百分比）；`where` 门（**仅存在性 / 相等 / ∈**）；名称解析 = 纯 `{field}` 插值 + 字面量 `enumMap`（+ fallback），并携带可选的**不透明 i18n 身份**（`enumCode`/`code`/`argPath` 与窗口级 `nameCode` → 快照 `nameCode`/`nameArg`——供控制台翻译表映射为本地化标签的代码，绝非计算）；静态 headers 块；`successIf`（对 body 字段单等值）；`unlimited`（字面量或布尔路径）；`source: headers`；时间解析（秒/毫秒按量级判别、ISO、纯日期串）。缺 total 的退化（“无上限声明”）是**存在性**规则，不是值谓词。

**禁列五类**（拒绝是结构性的——schema 根本拼不出它们——且加载器额外拒绝未知键防夹带；违规条目**整条**丢弃、大声报出）：

1. 算术表达式（无 `+ - * /`、无计算字段——只有字面量与路径）；
2. 跨调用数据注入（逐响应无状态解析；不接受前次调用或其他配对的数据）；
3. 值比较 / 正则 / 时间差谓词（`where` 只认 `exists` / `eq` / `in`——别无其他；“存在性选择可以，值条件不行”是控制线）；
4. per-URL 反义映射（一条目一 URL；反义族系走代码 adapter）；
5. header 值插值（headers 全是静态串；header 值里的 `{...}` 加载即拒）。

**铁律（仅约束 L-d）：** a) 相对路径消毒——拒 `..`、`//`、`@`、协议头，且解析后必须落在该 provider 推理 baseURL 的 origin 内；b) 认证固定复用推理 `Bearer`——额度调用需要拼装/换 scheme/派生头的 provider 对配置表失格（只能内置 adapter）；c) GET-only、每条目 1 URL、cacheTtl 钳 [60 秒, 24 小时]（429 退避是引擎级全局逻辑，§7）；d) 配置**永不**得静默遮蔽内置——替换必须 `override: <内置条目 id>`，且 fork 条目带血统戳（`forkedFrom`、`verifiedAt`）；e) 禁类校验在加载时执行；失败面报控制台（`/api/admin/quota.rejected`），绝不吞。proto 形态的 provider id 与 `__proto__/constructor/prototype` 路径跳见之即拒（ADR-0006 污染纪律）。

### 7. 调度

due-based，形照主动健康 prober（借思路不借代码）：固定 tick（默认 60 秒，`quota.intervalMs` 钳 [10 秒, 1 小时]）先**零副作用**地规划本周期探测（纯 plan 可断言），再顺序执行；每对下次到期 = verifiedAt + 条目 cacheTtl，±15% 抖动；每 tick 至多 6 次探测。被覆盖凭据的首见即排（这就是激活随凭据）。**任何探测吃到 429 即 arm 引擎级全局退避**（指数，5 分钟基、3 小时顶），暂停整个调度器——额度端点是共享基础设施，一次封顶响应意味着全体放慢。总开关 `quota.enabled: false` 停止一切出网探测；盘上快照照常展示（过期逻辑不变）。

### 8. 失败语义与路由面防火墙

**探测失败 ≠ 额度失败。** 失败尝试不进熔断器、不标 SUSPECT、不禁用、不进 trace 表：旧快照保留，`lastFailureAt` 把徽章翻成 `stale`。反向额度面消费推理侧证据只有一个方向：在熔断 manager 唯一失败汇聚点（`recordFailureScoped`）记录的每个 `QUOTA_EXHAUSTED` 诊断，在规则门控**之前**落 **`quota_events`** 账本一行（观测不是政策——关掉额度*跳闸*不得蒙住账本）。账本照限流账本纪律：环 500、`traces.db` 镜像（`quota_events` 表、独立 WAL 句柄、fail-open、启动 replay）。分类器新增中文撞顶 marker（额度措辞 + 会话频控措辞进入匹配字面量），使中文服务商的额度烧穿折入 QUOTA_EXHAUSTED（credential 作用域、12 小时下限、不打 SUSPECT——ADR-0004 语义不变）。词汇防火墙成立：`CLOSED/HALF_OPEN/OPEN` 仍是 CircuitBreaker 专属词；额度徽章态（`probed/declared/unverified/stale`）另立一轴，永不复用为健康词汇。撞顶下架继续走既有配对熔断 trip 语义；`resetAt` 对齐冷却整形为二期。

### 9. 消费面

控制台：`CredentialHealth` 叠加层（每个返回凭证的响应都带，ADR-0006 §9 契约）新增附加键 `quota?: CredentialQuotaView`——四态徽章、逐窗口条 + 重置倒计时、血统（`entryId`、`source`、`plan`、过期态）在 tooltip。该键缺席 = *未覆盖*，与 `unverified` 徽章（已覆盖尚无结果）刻意不同。独立**额度页**（`/admin/quota`）渲染跨服务商目录：服务商被覆盖的每个已连接配对（配对枚举同 status 的 credentialHashes——链上凭据 + config 烘焙 key，仅展示安全前缀；未覆盖服务商不出行），携徽章、窗口条、套餐、血统与其归属用量联查（trace 环上的 `getCredentialPairUsageStats`）。版本覆盖面清单（覆盖/激活二分保持可检视）、被拒的 `quotaProbes:` 条目（校验失败上报，绝不吞）与近期烧穿事件账由 `GET /api/admin/quota` 按诊断契约供给（`coverage / rejected / pairs / events`）——页面本体保持单一目录面，不内嵌这三张清单。`POST /api/admin/quota/refresh` 重排一对或整个调度（只做失效标记——探测留在调度器，绝不在请求路径同步跑）。`frontend/src/lib/api.ts` 按后端契约名 1:1 镜像（`CredentialQuotaView`、`QuotaPairRow`、`QuotaWindow`、`QuotaBadgeState`、`QuotaSource`）。原始密钥在任何界面上都不出现（只有展示安全前缀）；UI 文案全走 `t()`。

## IP 纪律（备案约束）

所有表条目/adapter 条目的端点事实、响应形状与窗口语义以各家公开 API 文档核实，并对照一个公开 MIT 许可的参考实现（仓库可见文本中刻意不具名）交叉验证。从中只取*事实*（URL、认证头形态、字段结构、单位码如 GLM 的 session/weekly 码）与*架构思路*（声明表 + adapter 注册、多窗口模型、due-based 调度）——API 契约事实不受版权保护，思路亦非代码。OCR 全部实现、fixture（全合成、自著）、注释与文档均为原创英文文本；无逐字拷贝或逐行转写（红线：功能 diff 中与其源码连续 ≥6 词相同）。借的是事实，不是代码。

## 后果

- 新增一个覆盖 provider：语义可声明则一表行（执行 §3 catalog 核对 + auth 披露），不可声明则一家一文件 adapter，长尾则一条用户 `quotaProbes:` 条目——release 在长大，运行时无需知道凭证池。
- 禁例列表在加载时可强制，因为它是结构性的：拼不出的东西就跑不起来；坏的用户条目大声落到 `/api/admin/quota.rejected`，不会半工作。
- 额度可见性永远不会搁浅流量：探测结果只是展示证据；推理侧额度烧穿维持既有熔断语义，另得一本持久事件账本。
- 测试：`quota-dsl`（构件、禁类、逐条目 fixture）、`quota-engine`（铁律、计划合并、探测执行、MiniMax 语义、调度器、事件联动、trace 配对）。

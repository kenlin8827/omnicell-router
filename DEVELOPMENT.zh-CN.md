# OneCastRouter (OCR) 开发者与架构指南

<div align="center">

[![Runtime](https://img.shields.io/badge/Runtime-Bun%20%7C%20Node.js-blue.svg)](https://bun.sh)
[![Architecture](https://img.shields.io/badge/Architecture-Cascaded%20Model--Driven-purple.svg)]()
[![Tests](https://img.shields.io/badge/Backend%20Suites-121%20Suites%20Pass-brightgreen.svg)]()
[![ADR](https://img.shields.io/badge/ADR-0001%20through%200014-blue.svg)](docs/adr/zh-CN/README.md)

[English Version](DEVELOPMENT.md) | [Chinese Version](DEVELOPMENT.zh-CN.md) | [User README](README.zh-CN.md) | [版本发布指南](RELEASING.zh-CN.md)

</div>

> 本指南系统阐述 **OneCastRouter (OCR)** 的核心架构、内部子系统、级联分发管道、测试套件与代码规范。内容严格契合当前 `main` 分支代码事实及架构决策记录（ADR-0001 至 ADR-0014）。

---

## 目录
1. [代码工程结构与核心子系统](#1-代码工程结构与核心子系统)
2. [全局请求执行生命周期](#2-全局请求执行生命周期)
3. [级联仲裁分发引擎](#3-级联仲裁分发引擎)
4. [会话状态机与接入模式自治](#4-会话状态机与接入模式自治)
5. [韧性体系与作用域隔离熔断](#5-韧性体系与作用域隔离熔断)
6. [调用故障账本与可观测性](#6-调用故障账本与可观测性)
7. [Token Saver 压缩套件](#7-token-saver-压缩套件)
8. [凭证中心与服务商定义单一事实源](#8-凭证中心与服务商定义单一事实源)
9. [声明式 Quota 额度探测引擎](#9-声明式-quota-额度探测引擎)
10. [架构决策记录目录 (ADR-0001 至 ADR-0014)](#10-架构决策记录目录-adr-0001-至-adr-0014)
11. [测试矩阵与验证套件](#11-测试矩阵与验证套件)
12. [代码规范与清理契约](#12-代码规范与清理契约)

---

## 1. 代码工程结构与核心子系统

OneCastRouter 采用 Bun Workspaces Monorepo 单体仓库架构，包含 Fastify 后端与 Vite+React 前端：

```
onecast-router/
├── backend/                             # 核心网关守护进程 (Fastify + Pino)
│   ├── src/
│   │   ├── auth/                        # 管理 API Key、Web 会话、模型访问策略
│   │   ├── capture/                     # HTTP 交换报文抓包与 System One 决策数据集捕获
│   │   ├── cli/                         # CLI 命令入口、客户端同步子系统
│   │   ├── compression/                 # Token Saver（rtk 截断、headroom 压缩、caveman 提示）
│   │   ├── config/                      # YAML 配置解析、环境隔离加载、运行时热重载
│   │   ├── forward-proxy/               # 正向 MITM 拦截代理与动态根证书生成
│   │   ├── metrics/                     # FinOps 成本测算与 Token 消耗统计
│   │   ├── observability/               # 上游调用故障事件环形缓冲与 SQLite 账本 (ADR-0013)
│   │   ├── opencode/                    # 服务商定义、在线模型目录同步、凭据适配器
│   │   ├── pipeline/                    # 核心调度编排器、提示词规范化、KV 缓存防线
│   │   ├── protocols/                   # Anthropic、OpenAI、Responses 协议转换器
│   │   ├── providers/                   # 纯直接执行引擎、候选池构建、模型成员匹配
│   │   ├── quota/                       # 声明式 DSL 探测器、SQLite quota_events 账本
│   │   ├── ratelimit/                   # 滑动窗口速率限制器与客户端限流事件日志
│   │   ├── resilience/                  # 熔断器状态机、作用域熔断状态、健康视图
│   │   ├── router/                      # RouteEntry 经验表 (ADR-0011)、决策层、路由审计账本
│   │   ├── routes/                      # Fastify HTTP 路由注册 (控制台、环境管理、协议面)
│   │   ├── session/                     # 单调会话棘轮状态机、零 Header 哈希
│   │   ├── surfaces/                    # 统一协议面映射表与分发层 (ADR-0008)
│   │   ├── trace/                       # SQLite 调用追踪库 (traces.db) 与内存轨迹环
│   │   ├── validator/                   # 本地 AST 与 JSON Schema 语法断言校验
│   │   ├── index.ts                     # 网关服务引导与全局生命周期管理
│   │   └── server.ts                    # Fastify HTTP 服务初始化与 Admin 接口暴露
│   └── tests/                           # 121 个完全沙箱隔离的后端单元测试套件
├── frontend/                            # Web 运维控制台 (Vite + React + Vanilla CSS)
│   └── src/
│       ├── components/                  # UI 组件（主题 Combobox 下拉框、数据表格、弹窗）
│       ├── pages/                       # 运维页面（模型组合、调用失败账本、经验表等）
│       ├── lib/                         # 1:1 镜像后端响应契约的 API 客户端
│       └── i18n/                        # 国际化语言包（英文与中文翻译表）
├── docs/                                # 项目架构设计文档
│   └── adr/                             # 规范化架构决策记录 (ADR-0001 至 ADR-0014)
│       └── zh-CN/                       # 双语中文 ADR 镜像树
└── scripts/                             # 自动化构建与测试运行脚本
    ├── test-isolated.ts                 # 多进程沙箱环境后端测试运行器
    ├── check-guardrails-matrix.ts       # CI 架构护栏完整性验证脚本
    └── full-system-test.ts              # 10 点端到端集成测试脚本
```

---

## 2. 全局请求执行生命周期

所有客户端请求均经由 Fastify 服务器截获，转换为规范化协议对象，经级联仲裁后由直接候选池负责执行：

```
                           客户端请求到达
   (POST /v1/chat/completions | POST /v1/messages | POST /v1/responses)
                                      │
                                      ▼
               [Step 1: 协议面检测与分发 (ADR-0008)]
                - Protocol Surface 注册表匹配请求路径后缀
                - 分发到具体的流式/非流式协议处理管道
                                      │
                                      ▼
               [Step 2: 规范化处理与会话指纹计算 (ADR-0002)]
                - 对历史消息计算 SHA-256 前缀链式哈希 (Prefix-Chain Hash)
                - 严格保全规范化字节序，保护上游 Provider KV Prompt Cache
                                      │
                                      ▼
               [Step 3: 级联梯队与思考强度决策 (ADR-0001, ADR-0011, ADR-0012)]
                - Layer 0: 显式规则直通 (force_tier, combos, auto-tier 别名)
                - RouteEntry 经验表: SHA-256 提示词哈希命中直接短路判决
                - Layer 2 决策层: System One 远程单次调用联合决策 {tier, effort} (可选)
                - 默认保底: 硬编码 plus 质量基准线防御
                                      │
                                      ▼
               [Step 4: 单调会话棘轮与接入模式自治 (ADR-0002, ADR-0014)]
                - 执行“只升不降”策略，严禁多轮会话中途向廉价层级降级
                - 强制模式边界：仅 auto 系列允许网关决策调级
                - 校验绑定实例健康度；必要时执行安全防跌落的 Pin Eviction
                                      │
                                      ▼
               [Step 5: 直接池化执行与两阶段重试 (ADR-0004, ADR-0005)]
                - 基于注册表构建目标层级的活跃候选池
                - Stage 1: 原物理实例上就地抖动重试（吸收 5xx/超时短时波动）
                - Stage 2: 同梯队备选故障转移与受控向上升级
                - 更新作用域熔断状态并写入 failure-events 账本 (ADR-0013)
                                      │
                                      ▼
               [Step 6: 链路诊断标头注入与客户端流式交付]
                - 注入 X-OCR-Trace-ID, X-OCR-Tier, X-OCR-Thinking-Source 等标头
                - 执行 SSE 重新分块切片并推向客户端
```

---

## 3. 级联仲裁分发引擎

网关彻底废弃传统的“字符长度规则”，采用分层确定的仲裁逻辑：

### 3.1 Layer 0: 显式规则与快速直通
1. **组合直通 (Combos)**：若请求的 `model` 为已配置的自定义组合（ADR-0003），直接绕过梯队仲裁。组合池根据其自身配置的分配策略（`priority`, `weighted`, `round_robin`）选出领头模型，故障转移严格局限于组合内。
2. **强制梯队列名**：如 `auto-lite`, `auto-plus`, `auto-pro`, `auto-ultra`，直接选定目标梯队，会话进入 `'explicit'` 模式合约。
3. **客户端选项**：请求体中携带的 `router_options.force_tier` 具有最高控制优先级。
4. **全局模式杠杆**：配置 `routing.mode: cost` 强制默认导向 `lite`，配置 `routing.mode: quality` 导向 `pro`。

### 3.2 RouteEntry 持久化经验表 (ADR-0011)
在调用任何远程决策调用前，网关计算提示词的 16 进制 SHA-256 哈希：
$$\mathcal{H}_{\text{prompt}} = \text{SHA256}(\text{normalize}(\text{prompt}))[0 \dots 15]$$
- 若在 `<envRoot>/data/route-entries.json` 中存在该记录，直接以 `layerUsed: 'entry'` 和 `reasonCode: 'entry.hit'` 短路返回对应层级与思考预算。
- **写入白名单权威阶梯**：`human`（控制台人工编辑） > `l2_confident`（System One 决策层置信度 $\ge 0.85$）。`@ocr-*` 指令永不写回——手动覆盖是决策，不是统计经验。
- 人工编辑的经验条目具备不可覆盖性。

### 3.3 Layer 2: System One 语义决策层 (ADR-0012)
- 由配置项 `classifier.layer2.enabled: true` 主动开启（默认关闭）。
- 通过 `runSystemoneDecision` 异步调用轻量级决策层模型（`classifier.layer2.model`）。
- 开启时，决策层在单次调用中联合返回 `{tier, effort}`，彻底省去两次往返延迟。
- 决策缓存在进程内的 LRU+TTL 缓存（`decisionCache`）中。

### 3.4 质量优先保底基准线
当决策层未启用、超时或因上游故障未命中时，系统强制回退至硬编码的 **`plus`** 梯队（`layerUsed: 'layer0'`, `reasonCode: 'default'`）。零配置网关绝不会暗中向廉价微模型降级。

### 3.5 显式升档指令 (ADR-0011)
升档由用户书写，而非推断。**最后一条** user 消息里的任意 `@ocr-*` token 让当轮移动一步：

| Token | 效果（仅当轮） |
| :--- | :--- |
| `@ocr-tier-up` / `@ocr-tier-down` | 梯队 $\pm 1$（`lite` $\leftrightarrow$ `plus` $\leftrightarrow$ `pro` $\leftrightarrow$ `ultra`） |
| `@ocr-effort-up` / `@ocr-effort-down` | 思考级别 $\pm 1$（`none` $\to$ `low` $\to$ `medium` $\to$ `high` $\to$ `xhigh` $\to$ `max`） |

- **全链抹除**：每次请求都会把所有 `@ocr-…` token 从全部消息与角色中剥离，上行 payload 与「从未写过指令」逐字节等价（前缀缓存稳定、任何厂商都看不到保留字）。未知 token 同样抹除并记 `directive_unknown`。
- **仅末条 user 生效**：只有最后一条客户端 user 消息可以生效，且只作用于当轮——客户端每轮都会重发历史，按位置生效正是重发幂等的来源。tool 结果 / assistant 文本 / system 提示中的指令会被抹除但永不生效（注入防御）。
- **当轮作用域**：tier 覆盖在单调棘轮**之后**应用，因此永不抬升 `session.maxTier`、永不重钉会话。它也是唯一合法的降档来源——自动机制（L0、经验表、L2）只升不退。
- **优先级**：客户端显式 model / `force_tier` / combo > `@ocr-*` 指令 > L2 动态 > 经验表 > L0 规则 > `plus` 基线。
- 生效 / 被忽略（`explicit_choice`）/ 未知的指令都会追加到 `<envRoot>/data/routing-ledger.jsonl`；控制台渲染 `directive.*` reason 码。语法参考：`docs/design/directives.md`。

---

## 4. 会话状态机与接入模式自治

### 4.1 零 Header 前缀链式指纹识别
标准客户端调用不包含任何专属会话标头。OCR 通过历史对话前缀哈希确定会话归属：
$$\mathcal{H}_{\text{session}} = \text{SHA256}(\text{CanonicalJSON}(\text{messages}[0 \dots n-2]))$$
由于前缀 $messages[0 \dots n-2]$ 包含了上一轮 Assistant 实际输出 $A_{n-1}$，由于大模型自回归采样的巨大随机熵，哈希碰撞概率在数学上趋于零。

### 4.2 单调会话棘轮 (Monotonic Session Ratchet)
一旦某多轮对话因任务复杂升级至更高层级（`plus`/`pro`/`ultra`），后续该会话的一切简短追问（如“修复第 5 行”、“谢谢”）严禁向廉价 `lite` 模型降级，强制锁定在既有层级及物理模型实例上，彻底阻断降智与上下文理解断裂。

### 4.3 接入模式自治矩阵 (ADR-0014)
根据会话首轮的寻址方式，网关划定严格的操作边界：

| 接入模式 | 触发标识 | 允许网关决策调级 | `@ocr-*` 指令 | 会话棘轮锁定 |
| :--- | :--- | :--- | :--- | :--- |
| **`auto`** | 纯 `auto`, `default`, 决策层模型标识 | 允许（走完整级联） | 双轴生效 (effort + tier) | 是 |
| **`explicit`** | 注册的具体物理模型、强制 `auto-*` 别名 | 严禁（合约忠实执行） | 忽略（台账记 `explicit_choice`） | 否 (固定执行目标) |
| **`combo`** | 配置的虚拟组合模型 ID | 严禁（内部自主轮转） | 忽略 | 否 |

### 4.4 实例受控驱逐 (Pin Eviction, ADR-0002)
会话与具体物理模型实例绑定以发挥上游 KV Cache 效益。当且仅当发生下列情况时，绑定实例才会被安全驱逐并重新选定：
1. 模型从配置中被删除，或被动态黑名单排除。
2. 模型整体读取为不可用（`unavailable`，即模型级熔断器断开，或其所有凭证对全部挂掉）。
3. 防跌落落脚点保障：新目标必须同属当前会话层级；仅在该层级全灭时方允许跨梯队迁移。

---

## 5. 韧性体系与作用域隔离熔断

### 5.1 7 类上游故障分类标准 (ADR-0004)
1. `quota` (HTTP 402)：服务商余额透支/超额。对该目标强制断开 12 小时。
2. `auth` (HTTP 401/403)：密钥失效。将该凭据标记为持久化 `SUSPECT`（可疑）状态。
3. `rate_limit` (HTTP 429)：并发或速率超限，基于上游 `Retry-After` 指数退避。
4. `server_error` (HTTP 5xx)：上游服务故障，由连续失败阈值与滑动窗口失败率联合触发熔断。
5. `timeout`：网关或网络传输超时。
6. `network`：连接拒绝、DNS 解析失败或 TCP 中途重置。
7. `bad_request` (HTTP 400)：客户端载荷或参数不合法，不触发熔断计数。

### 5.2 熔断作用域与健康状态词汇
熔断器在三个独立维度进行故障隔离：
- **`model` 作用域**：影响该模型在所有凭据下的全局调用。
- **`credential` 作用域**：以密钥指纹 `keyHashPrefix = sha256(key)[0..7]` 为锚点，隔离特定失效密钥。
- **`pair` 作用域**：仅熔断特定的 `(model, credential)` 组合对。

在健康汇总视图中，严格采用能力状态词汇：
- **`available`**：实例健康，可供路由分发。
- **`recovering`**：处于 `HALF_OPEN` 半开试探状态。
- **`unavailable`**：不可用（模型级断开或全部候选密钥对挂起）。

### 5.3 两阶段执行与 KV Cache 保护屏障 (ADR-0005)
`executeCandidatePool` 是全局调用的唯一直通漏斗：
- **阶段 1（就地抖动重试）**：遇到偶发 5xx 或超时，网关优先在**原物理实例**上添加微小随机抖动延迟（$200\text{ms} + 0..100\text{ms}$）重试 1 次。可直接吸收约 70% 的云端瞬态抖动，同时保全 100% 已预热的上游 KV Prompt Cache。
- **阶段 2（同梯队故障转移与受控升级）**：若就地重试依然失败，候选池在同梯队健康备选模型中毫秒级轮询。同梯队全部耗尽后，允许受控向上升级至更高梯队，严禁向下降级。

---

## 6. 调用故障账本与可观测性

依照 **ADR-0013** 构建，专注于物理模型级调用故障的全局审计：
- **双重发射源**：统一捕获 `serving` 业务候选调用与 `l2-decision` 决策层模型调用中的物理故障。
- **10 秒风暴聚合**：10 秒窗口内发生的相同故障（`model × provider × errorClass × role`）自动合并为一条记录，递增计数器 $N$。
- **存储介质**：内存环形缓冲（500 条）+ SQLite 数据库同步镜像（`traces.db` 的 `failure_events` 表）。
- **管理路由**：
  - `GET /api/admin/failure-events`: 多维度过滤故障账本。
  - `POST /api/admin/failure-events/clear`: 一键清空内存环与持久化数据库。
  - `DELETE /api/admin/failure-events/:id`: 删除单条故障条目。

---

## 7. Token Saver 压缩套件

在请求发往上游前执行确定性预处理：
1. **`rtk` (确定性工具输出压缩)**：基于结构化语法对高频大型工具输出（git status、diff、文件树、构建日志）执行无损语义裁剪。
2. **`headroom` (神经语义压缩 Sidecar)**：可选的后台伴随进程，在超长历史轮次中执行多轮上下文神经语义提炼。
3. **`caveman` (极简系统提示注入)**：向系统提示词中追加紧凑指令，要求上游模型给出极度精炼、零客套的技术实现。

---

## 8. 凭证中心与服务商定义单一事实源

### 8.1 服务商定义的单一事实源 (ADR-0010)
上游连接定义（BaseURL、支持模型、协议转换）的唯一事实源为 `<ocrHome>/providers.json`。外部下游配置（如 OpenCode v2 的 `opencode.jsonc`）仅作为只写同步物化目标。

### 8.2 凭据中心架构 (ADR-0006)
- 凭证真实存储于 `<ocrHome>/credentials.json`。
- 以密钥哈希为唯一锚点：
  $$\text{keyHash} = \text{SHA256}(\text{key})$$
  任何界面与日志中仅展示安全的前 8 位字符 `keyHashPrefix`。
- 双向同步适配器：支持 OpenCode v2、Claude Code、Codex 与 Pi。

---

## 9. 声明式 Quota 额度探测引擎

依照 **ADR-0009** 规范实施，在非推理阻塞前提下自动监控余额：
- **四层知识体系**：内置厂商声明表 $\to$ 代码适配器 $\to$ 运维人员 `quotaProbes:` 声明配置。
- **12 项安全 DSL 语法**：支持 `get`, `post`, `header`, `body`, `extract_json`, `math`, `assert`, `date_format` 等。
- **5 类结构性封禁语法**：严禁执行 Shell 命令、严禁裸 Socket 访问、严禁凭证回写、严禁明文传输、严禁将探测结果设为同步推理前置阻塞闸门。
- **数据落地**：探测快照与推理端真实消耗记录汇入 SQLite 的 `quota_events` 账本中。

---

## 10. 架构决策记录目录 (ADR-0001 至 ADR-0014)

所有技术演进均以 ADR 为准绳，详见 `docs/adr/`：

| ADR 编号 | 决策标题 | 核心摘要 |
| :--- | :--- | :--- |
| **[ADR-0001](docs/adr/0001-routing-pipeline.md)** | 路由管道决策 | 级联层级仲裁、决策模型决策缓存、硬编码 plus 保底基线。 |
| **[ADR-0002](docs/adr/0002-sessions.md)** | 会话与棘轮机制 | 7 层零 Header 会话指纹、单调会话棘轮、受控 Pin 驱逐与落脚点防御。 |
| **[ADR-0003](docs/adr/0003-model-addressing-and-tier-membership.md)** | 模型寻址与层级归属 | 单一寻址决议阶梯、组合模型自治池、按密钥维度的访问控制策略。 |
| **[ADR-0004](docs/adr/0004-resilience-and-health.md)** | 韧性与健康状态治理 | 7 类故障分类标准、多作用域隔离熔断、能力状态汇总词汇体系。 |
| **[ADR-0005](docs/adr/0005-execution-topology.md)** | 执行拓扑结构 | 纯直接上游调用、`executeCandidatePool` 全局唯一漏斗、两阶段重试机制。 |
| **[ADR-0006](docs/adr/0006-credential-store.md)** | 凭据存储中心 | 基于能力的存储适配器、密钥哈希唯一标识、客户端双向同步物化。 |
| **[ADR-0007](docs/adr/0007-environments-and-bootstrap.md)** | 环境隔离与引导机制 | 独立账本目录、受控热重启环境切换、导出/导入安全信封格式。 |
| **[ADR-0008](docs/adr/0008-protocol-surfaces-and-capture.md)** | 协议接入面与报文捕获 | Chat/Anthropic/Responses 统一映射表、全捕获正向代理、安全脱敏。 |
| **[ADR-0009](docs/adr/0009-quota-probing.md)** | 声明式额度探测 | 12 项 DSL 语法、5 类封禁行为、只读展示与 quota_events 账本。 |
| **[ADR-0010](docs/adr/0010-provider-def-ownership.md)** | 服务商定义所有权 | `<ocrHome>/providers.json` 为单一源，`opencode.jsonc` 降为物化目标。 |
| **[ADR-0011](docs/adr/0011-route-entries-and-escalation-directives.md)** | 经验表与显式升档指令 | 提示词经验表 (`route-entries.json`)、`@ocr-*` 显式升档指令、路由审计账本。 |
| **[ADR-0012](docs/adr/0012-l2-decision-emitted-thinking-effort.md)** | 决策层联合思考级别决策 | System One 决策层单次联合决策 `{tier, effort}`、思考预算决策溯源标头。 |
| **[ADR-0013](docs/adr/0013-failure-events-ledger.md)** | 调用故障事件账本 | 上游物理调用故障记录、10 秒风暴聚合、SQLite 持久化镜像、管理端点。 |
| **[ADR-0014](docs/adr/0014-entry-mode-autonomy.md)** | 接入模式自治矩阵 | 模式权限矩阵：仅 auto 家族允许网关调级；强制梯队与物理模型忠实直通。 |

---

## 11. 测试矩阵与验证套件

### 11.1 常用测试执行命令
- **全项目类型检查**（验证后端与前端 TypeScript 静态类型）：
  ```bash
  bun run typecheck
  ```
- **后端沙箱隔离测试套件**（运行 121 个独立进程测试）：
  ```bash
  bun run test
  ```
  *重要注意*：切勿直接运行 `bun test backend/tests`。共享内存会导致静态单例配置相互污染产生假失败。必须通过隔离运行器（`scripts/test-isolated.ts`）在独立沙箱中执行。
- **前端生产构建验证**：
  ```bash
  bun run build:frontend
  ```
- **完整系统端到端集成测试**：
  ```bash
  bun run test:system
  ```

---

## 12. 代码规范与清理契约

1. **英文核心代码与严格国际化**：
   - 源代码文件中的所有代码注释（`//`, `/* */`）、变量标识符、日志输出以及英文主文档（`README.md`, `DEVELOPMENT.md`）必须为 **100% 纯英文**。
   - 中文内容严格限制于国际化语言表（`frontend/src/i18n/locales/zh-CN.ts`）、中文镜像文档（`*.zh-CN.md`）以及配置文件内置说明模板（`YAML_FIELD_COMMENTS`）。
2. **前端组件规范**：
   - 所有下拉选择控件必须统一使用 `frontend/src/components/Combobox.tsx`，严禁使用原生 `<select>` 标签以避免暗色主题失真。
   - `frontend/src/lib/api.ts` 中的响应类型必须与后端返回契约同名 1:1 镜像对齐。
3. **彻底清理契约**：
   - 删除或重命名符号时，必须同步清理所有引用、注释说明、测试用例标题以及 ADR 说明。
   - 提交代码前，使用下列命令审计无用变量：
     ```bash
     npx tsc -p backend --noEmit --noUnusedLocals --noUnusedParameters
     npx tsc -p frontend --noEmit --noUnusedLocals
     ```

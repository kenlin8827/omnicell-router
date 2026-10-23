# ADR-0001：路由管线——级联梯队决策、带决策缓存的决策层

## 状态

已实现 —— 2026-10-21（移除第 1 层微分类器与学习飞轮；事实侧语料重写）。范围：auto 请求如何选择梯队、昂贵一腿如何变便宜、决策层决策如何采样。请求 `model` 名称解析见 ADR-0003；会话策略见 ADR-0002；决策层协议面见 ADR-0008。

## 背景

自动路由必须逐轮在 `lite|plus|pro|ultra` 中选择——廉价、兜底确定、且绝不让会话抖动（会话棘轮建立在此决策之上，ADR-0002）。本仓库的创始边界：**禁止任何形式的响应缓存**——语义/响应缓存既污染路由（系统提示词权重主导）又污染答案（跨会话串扰），还破坏了本网关存在意义所系的上游 KV 缓存。决策路径可以缓存*决策*，绝不缓存*内容*（`decision-cache.ts:4-12` 申明了这条边界）。

已退役的第 1 层（由学习飞轮训练的本地微张量分类器）从未兑现收益：出厂 base scaffold 的置信度在所有请求上都低于阈值，每个决策本就级联而下——这一层白带着训练器、数据集管线和一个控制台页面，对路由结果的贡献为零。它是删除而非弃用：级联现在是 L0 规则 → L2 决策层 → 硬编码 plus 基线。

## 决策

### 1. 层词汇与级联

`layerUsed: 'layer0' | 'entry' | 'layer2'`（`types/router.ts`），reasonCode 集合随之一同锁定（`forced`、`default`、`combo`、`entry.hit`、`l2.*`、`session.*`、`directive.*`；`directive` 归因走 reasonParams——见 ADR-0011）。

- **第 0 层 = 绝不咨询模型。** 显式选择即决策：`router_options.force_tier`、auto 梯队别名（`lite/plus/pro/ultra` 在路由前改写 `force_tier`）、组合（reasonCode `combo`）、以及全局模式杆 `routing.mode`：`cost`→lite、`quality`→pro、`smart`→级联；客户端点名模型或强制梯队永远压过模式（`routingModeForceTier`，`router/index.ts`）。
- **经验查询 = 持久化的既有判定。** 咨询决策层之前，auto 请求先查 RouteEntry 表（ADR-0011）：命中即以 `layerUsed: 'entry'` 短路 L2。
- **第 2 层 = 远程决策层。** 任何判定失手（未启用、模型不可解析、超时、上游失败）都返回 null → 优雅兜底（`layer2-decision.ts`）。路由绝不因决策层失败而硬失败。
- **默认 = plus 基线。** 无判定结果时级联落在硬编码 `plus`，reasonCode `default`、`layerUsed: 'layer0'`（`router/index.ts`）——绝不瞎猜到 lite。

### 2. 结构化输出门（第 1 层的存活遗产）

`needsSchemaValidation = hasToolsOrSchema(request)`——对请求载荷的直接读取（tools 列表 / `json_schema` / `json_object` response_format），在 `router/request-traits.ts` 计算并随每个 `RoutingDecision` 携带。无论判定到哪个梯队，它都为 orchestrator 的 lite 先行 Schema 断言级联（5A）上膛。路由路径中不再存在任何习得特征。

### 3. 出厂默认质量优先

开箱 `layer2.enabled: false` ⇒ auto 请求落在文档化的 plus 基线。零配置绝不会静默走便宜路线；启用决策层是有意识的自选动作。

### 4. Layer 2 决策层——共享执行器、诚实契约、决策缓存

- 决策层经网关自身的 System One 协议调用一个已注册模型（`runSystemoneDecision`；与 `/v1/systemone` 面共享执行器，ADR-0008）。模型取 `classifier.layer2.model`，缺省回落 `systemone.defaultModel`；超时 `timeoutMs` 默认 5000。
- 校准诚实：原生决策上游 → `l2.system_one`；聊天模型转换 → `l2.system_one_uncalibrated`，reason 中含「（未校准）」标注。
- 显式模型诚实：显式命名注册模型（完整 id / 变体 / 裸名）不渲染为梯队判定——解析器注入的 force_tier 改写为 `explicit.model`（「路由到所指定模型，无梯队判定」），控制台不会给注册表推导出的梯队加徽章。
- 决策层是请求之下的内部腿：绝不经过候选池、熔断或限流拒绝——它自己的 HTTP 腿可并入外层 trace（`purpose:'l2-decision'`，ADR-0008）。
- 决策缓存（缓存决策，绝不缓存响应）：键 `systemone::<modelId>::sha256(state)`，state = 最近 4 轮 `role: content` 拼接、截至 4000 字符；内存 LRU+TTL，默认 500 条 / 1800 秒 / 开启（`decision-cache.ts`，配置 `classifier.layer2.decisionCache.*`）。只存成功决策；竞态胜者写入。命中标记：reason 前缀 `"[Decision Cache] "` + `reasonParams.cached=true`——不设独立 reasonCode，不加响应头。

### 5. 决策层数据集采样器（存活的采集腿）

- （`classifier.layer2.collectEnabled`，单键，默认 OFF——state 含用户对话内容）：(state, tier, confidence, latency, model, native/converted) → 固定路径 `data/layer2-decisions.jsonl`（相对**活动环境**根），64 MB 封顶后停写 + 每进程恰好一条告警，删除/轮转即恢复，热应用（`capture/decision-capture.ts`）。
- 护栏：`collectEnabled`（数据集采样）≠ requestCapture HTTP 交换审计日志（ADR-0008）——一个命名空间给日志，一个给训练数据；退役键（`capture:`、`decisionCapture`、`flywheel:`、`classifier.localModel`、`requestCapture.systemone` 双闸子树、决策层厂商键 `provider/baseUrl/apiKey`）在加载时剥离，保存时绝不重写。

## 后果

- 零配置质量可预期；智能路由是自选动作，每次失手都有确定性降级。
- 判定成本由缓存复用封顶；内容纯净受保护（除决策外无任何缓存）。
- 已退役飞轮的磁盘遗留（`data/flywheel.jsonl`、`models/layer1-classifier.json`）为惰性文件——没有任何代码读取，可随时删除。
- 测试：`router*`、`decision-cache`、`layer2-systemone`、`decision-capture`。

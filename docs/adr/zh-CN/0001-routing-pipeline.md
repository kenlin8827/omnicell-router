# ADR-0001: 路由流水线——级联定档、裁决者决策缓存、双飞轮

## 状态

已实现 — 2026-10-15（事实面语料重写）。范围：auto/default 请求如何选定梯队、昂贵一环如何变便宜、学习数据如何采样。请求 `model` 名称解析 = ADR-0003；会话策略 = ADR-0002；裁决者的协议接入面 = ADR-0008。

## 背景

Auto 路由必须按轮从结构信号中选择 `lite|plus|pro|ultra`——语言中立、廉价、降级路径确定，且绝不来回抖动会话（会话棘轮骑在这个决策上，ADR-0002）。本仓库的立身边界：**任何形式的响应缓存都被禁止**——语义/响应缓存同时污染路由（System Prompt 权重主导）与回答（跨会话串味），还摧毁网关存在的意义——上游 Provider 的 KV 缓存最大化。决策路径可以缓存*决策*，永不缓存*内容*（`decision-cache.ts:4-12` 以"早前被禁的响应缓存"为对照声明此边界）。

## 决策

### 1. 层级词汇与级联

`layerUsed: 'layer0' | 'layer1' | 'layer2'`（`types/router.ts:162`），reasonCode 集合锁定在其旁边（`:147-153`）。

- **Layer 0 = 永不问模型。** 显式选择即决策：`router_options.force_tier`、auto 梯队别名（`auto-lite/plus/pro/ultra` 在路由前改写为 `force_tier`，`orchestrator.ts:356-363`）、combo（reasonCode `combo`）、全局模式闸 `routing.mode`：`cost`→lite、`quality`→pro、`smart`→级联；客户端点名模型或强制梯队永远压过模式（`routingModeForceTier`，`router/index.ts:14-23`，应用于 `orchestrator.ts:469-477`）。
- **Layer 1 = 本地 CPU 分类器。** 仅当 `localModel.enabled` 且置信度 ≥ `classifier.localModel.confidenceThreshold`（默认 0.85）才短路（`router/index.ts:116`，`layer1-classifier.ts:289,371`）。
- **Layer 2 = 远端裁决者**，仅低置信 L1 时出场。裁决任何失手（禁用、模型解析不出、超时、上游失败）返回 null → 优雅回落到 L1 标注层（`layer2-judge.ts:106-128`；`router/index.ts:137-183`）。路由绝不因裁决失败而硬错。

### 2. Layer 1——语言中立特征、保证级联的空底座

仅八个结构特征（`layer1-classifier.ts:66-75,192-278`）：token 数、轮次、有无 system prompt、代码块占比、语法符号密度、工具/结构输出、字符熵、标点密度。**任何自然语言词表都不存在**——语言中立是立身决策。派生标志：`hasCode`（代码块占比 > 0.05 或含 ```）、`hasToolsOrSchema`（tools / json_schema / json_object response_format）；`hasMathOrProof` = 符号熵 > 0.7（`router/index.ts:53`）。

- 结构协议短路（先于一切模型）：tools/json_schema → `lite` @0.92（`l1.schema_protocol`）——结构化输出请求在协议形态上就是廉价能力可胜任的。
- 模型形态：`linear_softmax_classifier`（微张量）或 `onnx`（仅当 `modelPath` 以 `.onnx` 结尾**且** `onnxruntime-node` 加载成功；预测分支目前是返回 plus @0.90 的桩——`:117-133,310-326`）。
- 自动初始化：缺失 `models/layer1-classifier.json` 时落盘零权重底座；均匀概率保证低于阈值 ⇒ 新装必然级联到 Layer 2（`:53-57,95-96,110-146`）。
- 进程内训练器：多分类逻辑回归（softmax + L2），由执行飞轮供数据（`:451-560`）。

### 3. 出厂默认是质量优先

`localModel.enabled: false` + `layer2.enabled: false`（`config/index.ts:46-58`）⇒ auto 请求落在有文档的"Default Quality-First"回退，定在 `plus`（`router/index.ts:166-183`，`layer1-classifier.ts:351-368`）。零配置绝不静默走廉价路由；启用级联是每一环的自觉 opt-in。

### 4. Layer 2 裁决者——共享执行器、诚实契约、决策缓存

- 裁决者经网关自家 System One 协议调用一个**已注册**模型（`runSystemoneDecision`；执行器与 `/v1/systemone` 面共享，ADR-0008）。模型：`classifier.layer2.model`，否则 `systemone.defaultModel`；超时 `timeoutMs` 默认 1500（`layer2-judge.ts:130-134,197`）。
- 校准诚实：原生决策上游 → `l2.system_one`；chat 模型转换 → `l2.system_one_uncalibrated`，理由文本自带"(self-reported, not yet calibrated)"（`:247-252`）。
- 裁决者是请求之下的内部一环：永不走候选池/熔断/限流拒绝（`decision-pipeline.ts:222-234`）——其自身 HTTP 腿可并入外层请求 trace（`purpose:'l2-judge'`，ADR-0008）。
- 决策缓存（缓存决策，永不缓存响应）：键 `systemone::<modelId>::sha256(state)`，state = 最近 4 轮 `role: content` 拼接、切至 4000 字符；内存 LRU+TTL，默认 500 条 / 1800 s / 开启（`decision-cache.ts:30-58`，配置 `classifier.layer2.decisionCache.*`）。只存成功决策；竞态胜者写入（`layer2-judge.ts:283-291`）。命中标记：理由前缀 `"[Decision Cache] "` + `reasonParams.cached=true`——无独立 reasonCode、无响应头。

### 5. 双飞轮——严格两个命名空间

- **执行飞轮**（`flywheel.enabled` opt-in，`flywheel.datasetPath` 默认 `data/flywheel.jsonl`）：记录 featureVector + decision + execution + 派生 label——"实际服务的，而非路由所请求的"（`flywheel/collector.ts:144-236`）。供 L1 训练器与目录校验。`enabled` 闸门保存后热应用（控制台采集开关 / 配置编辑器 / raw YAML 共用 `saveConfig`；collector 从活动 section 对象上读取闸门，并在首条记录时惰性建目录与武装保留清理）——`datasetPath` 与保留参数仍为重启生效。
- **裁决数据集采样器**（`classifier.layer2.collectEnabled`，单键，默认 OFF——state 含用户对话内容）：(state, tier, confidence, latency, model, native/converted) → 固定路径 `data/layer2-decisions.jsonl`（相对**活动环境**根），64 MB 封顶后停写 + 每进程恰好一条告警，删除/轮转即恢复，热应用（`flywheel/decision-capture.ts:39-132`）。
- 防歧义护栏：`collectEnabled`（数据集采样）≠ `requestCapture.systemone.l2DecisionEnabled`（HTTP 交换捕获，ADR-0008）——日志一个命名空间，训练数据另一个；退役键（顶层 `capture:`、`decisionCapture`、裁决者 vendor `provider/baseUrl/apiKey`）加载即剥离、保存永不写回。

## 后果

- 零配置质量可预期；智能路由逐环 opt-in，每个失手都有确定降级。
- 裁决成本被缓存复用封顶；内容纯度受保（除决策外什么都不缓存）。
- 学习信号诚实（served-not-asked）且内容设闸（含对话的数据集默认关）。
- 测试：`router*`、`decision-cache`、`layer1/layer2`、`flywheel*`。

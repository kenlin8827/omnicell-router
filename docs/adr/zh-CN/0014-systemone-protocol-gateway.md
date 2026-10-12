# ADR-0014：System One 协议网关与上游翻译

## 状态

Implemented — 2026-10-11。当日修订：本接入面上的 `auto-*` 梯队别名解析（§1）。

## 背景

**System One** 是 TypeSafe AI 于 2026 年 9 月引入（首个模型 Jev）、并被阿里云百炼决策模型 API（`decision-model-preview`）与 LiteLLM Auto Router（自托管分类器 Laya / Bespoke Nimble；托管 Jev）独立采纳的决策模型协议。一次 System One 请求将单个 `state` 对照一张带类型的 `questions` 映射（`choice` / `noul` / `score`）进行求值，返回带概率与置信度的带类型 `answers`——绝不返回生成文本。调用方是直接消费这些值的路由器、护栏（guardrails）与分诊流水线。

网关此前携带一个休眠的 TypeSafe 触点：Layer 2 judge 旧的 `provider: 'typesafe'` 分支向 `POST {base}/decision/choice` 发请求——该形态不存在于 TypeSafe 当前公开 API（唯一有文档的端点是 `POST /v1/systemone`）。此分支已删除（见 §5）——示例配置与线上配置中 `classifier.layer2` 均以禁用状态出厂（`classifier.layer2.enabled: false`）。

运营者希望网关对外提供 `POST /v1/systemone`——既可以由原生 System One 上游（Jev / 百炼决策模型）支撑，也可以由任意已注册的 chat 模型支撑，且无论哪种情况协议契约都必须保持成立。

## 决策

### 1. 入站接入面：`POST /v1/systemone`

- 新路由（`backend/src/routes/systemone.ts`），注册在其他协议兼容层旁边（`server.ts`）。鉴权与逐 key 模型访问策略与 `/v1/chat/completions` 完全一致。
- 只做结构性校验（`protocols/systemone/convert.ts#validateSystemoneRequest`）：`state` 必填；`questions` 非空；逐类型形态（`choice` 选项映射非空；`score` 为 ≥2 档的数组；`noul` 可选 `{true,false}` 提示）。上游特有上限（如 TypeSafe score ≤10 档 vs 百炼 ≤255 档）不在此强制——上游才是权威。非法请求体 → 400 `invalid_request_error`（网关信封；上游自身用 422）。
- `model` 解析：已注册的物理模型 id；缺省 / `'auto'` / `'default'` 回落到配置 `systemone.defaultModel`；两者皆无 → 400。虚拟梯队别名 `auto-lite` / `auto-plus` / `auto-pro` / `auto-ultra` 解析为目标梯队链首的健康成员——候选在选定之前先按 key 做访问过滤（allow 模式的 key 必须点名别名；deny 模式的 key 不得把该梯队整个禁用），且该接入面在梯队无候选池（404）、准入为零（403）或无健康成员（503）时显式失败——绝不静默回退到其他梯队。选定的是链首（权重/优先级序），不是 chat 池的 weighted/round_robin 策略，并且完全绕开分类器（无 Layer 1 调用、无请求合成——纯 registry 池投影）。`X-OCR-Model` 仍如实披露实际服务者。仍然没有梯队级联、会话棘轮或 combo 解析——System One 是无状态决策接入面：别名只约束一个梯队；解析到的模型就是被服务的模型。

### 2. 两条上游路径，按 provider 类型选择

| Provider 类型 | 路径 | 线型 |
| --- | --- | --- |
| `systemone`（原生） | 直通（passthrough） | `POST {baseUrl}/systemone`，请求体 `{...body, model: upstreamModel}` |
| 所有 chat 类型 | 转换 | 合成 chat completion + 响应合成 |

- 原生 provider 在 `config.providers` 中以 `type: 'systemone'` 声明（TypeSafe baseUrl `https://api.typesafe.ai/v1`；百炼 `https://{WorkspaceId}.<region>.maas.aliyuncs.com/compatible-mode/v1`）。registry 保存其配置（`getProviderConfig`）但不构建 chat 执行器——它们永远不可经 chat 线路由。
- 原生响应经一个最简 `answers` 存在性检查后原样透传（`answers` / `usage` / 厂商附加字段如 `request_id`、`latency_ms`）（原生端点返回非 System-One 形态的响应体 → 502 `upstream_error`）。

### 3. 转换契约（chat 模型）

- 请求侧：一次 chat completion 承载全部问题（`state` + `questions` JSON 置于 user message；固定的 system prompt 锚定 JSON 契约）。`temperature: 0`、`response_format: json_object`、`max_tokens: 4096`。批量携带所有问题，镜像 System One 的并行求值语义（TypeSafe 官方指引：一次批量调用比逐题串行便宜且快约 12 倍）。
- 决策调用的 reasoning effort 被钉死（convert.ts 中的 `decisionReasoningEffort`），只有一条规则——取我们可信任的最低档，绝不硬编码 `'none'`：运营者 `effortMap` 翻译优先；显式 `supportedReasoningEfforts` 列表取其最低档（`'none'` 只在此处被信任）；粗粒度的旧版/目录布尔标记取 `'low'`（它证明"具备思考能力"，并不证明厂商枚举接受 `'none'`）；完全没有 effort 声明 → 该字段整个省略（什么都不发）。System One 是快速决策协议——转换调用默认不得烧思考 token。
- 厂商枚举可能与目录的粗粒度能力标记冲突（阿里只接受 `low|high|max`，而模型仍被目录布尔标记声明为具备思考能力），因此路由在运行时校准：被上游拒绝的 `reasoning_effort` 从厂商自己的错误枚举清单重新定档（取其中最低允许档，如 `must be one of: 'low', 'high', 'max'` → `low`）；错误消息不含清单时回落到保守的 `none` → `low` → 省略链——硬性封顶 3 次尝试并按模型记忆化至进程结束——客户端永远看不到厂商的 effort 400。
- 响应侧：宽容 JSON 提取（代码围栏 / 首个 `{` 兜底）→ 逐题合成并归一化：
  - `choice`：声明的选项对 criteria 键做大小写不敏感匹配；概率过滤进 criteria 空间并重新归一化；空分布 → 在全部选项集上退化为 `{winner: 1}`；winner = 有声明取声明，否则取 argmax；`confidence` = 有提供取提供，否则取分布峰值。
  - `noul`：数字 / 布尔 / 是非字符串 → 钳位到 `[0,1]`。
  - `score`：档位索引钳位到 `[0, n-1]`；无声明索引时取概率加权期望；`legend` 由 criteria 数组重建。
  - `usage`：`prompt_tokens` / `completion_tokens` → `input_tokens` / `output_tokens`。
- 失败处理：一次修复重试（把模型上一轮输出连同失败原因追加进上下文）；仍非法 → 502 `conversion_failed` 并点名出问题的 question ids。刻意不编造答案——降级的答案绝不静默合成。
- **保真声明**：经转换的 chat 模型给出的概率/置信度是自报估计值，未经校准（Jev 的校准来自 RLCD 训练）。以 confidence 做门禁的消费方应优先选择原生上游。此为 ADR 成文承诺（且必须出现在面向用户的文档中）。

### 4. 执行语义（v1）

- 转换调用经 `registry.execute` 执行——严格是点名的那个模型，provider 级代理策略、超时与 `UpstreamError` 分类照常生效。orchestrator 的会话 / 分类器 / schema-断言机制刻意不启用。
- 明确不在 v1 范围：熔断器触发与结果记录（别名解析会读取熔断器可用性来为梯队选定把关，但本接入面永不触发或记录）、FinOps 计费、trace/flywheel/capture 记录与决策缓存；原生上游的 4xx/5xx 状态原样镜像给调用方。

### 5. Layer 2 judge 迁移路径

**已实现**——Layer 2 judge 不再直接说任何厂商线。它把四档词汇表（`lite` / `plus` / `pro` / `ultra`，criteria 携带各档完整评分细则与"绝不按字符长度判档"规则）合成为一道 System One `choice` 问题，走与本路由相同的执行器（`protocols/systemone/decide.ts` → `runSystemoneDecision`），读取 `answers.tier.choice` + `confidence`。因此 `type: 'systemone'` 的原生模型直接服务 judge；任何其他已注册 chat 模型则以转换方式服务 judge。

- 配置收敛为 `classifier.layer2.{enabled, model, timeoutMs, decisionCache}`——`provider` / `baseUrl` / `apiKey` 删除。`model` 是已注册 id；`'auto'`（或未设）经 `systemone.defaultModel` 解析。
- judge 自身的 `timeoutMs` 是高于上游超时的硬截止：到期时 judge 返回 null，级联回落到 Layer 1（转换路径无法中途取消——provider 各自持有 AbortController——落败者只是不再被等待）。
- 可选的决策捕获（`classifier.layer2.decisionCapture`，默认关闭）：被判定的 (state, answer, tier) 三元组落盘 `data/layer2-decisions.jsonl`——蒸馏原生决策模型、校准转换置信度的原始材料。只在竞速获胜路径上记录；目前尚无消费方。
- 转换答案的保真警示对路由与对客户端接入面完全同样成立：由转换 chat 模型选出的梯队建立在未经校准的自报值之上，judge 会把这一点写进它的 `reason` 字符串，保证 trace 诚实。

## 后果

- `/v1/systemone` 成为一等网关接入面：任何已注册模型都能为其服务；原生 System One 上游获得精确直通。
- `auto-*` 梯队别名在本接入面上的解析完全不涉及分类器（仅 registry 池投影），因此不增加决策延迟、也没有 Layer 2 递归；逐 key 访问过滤发生在选定之前，被禁成员永远无法挡住一个被允许的兄弟。
- 运营者可以在网关上提供 LiteLLM 风格的分类器端点而无需专用决策模型——代价是未校准的概率（如上成文）。
- 转换调用的韧性仅有 provider 级（超时 / 代理 / 错误分类）。本接入面的熔断触发与记录 + 重试 + FinOps 集成是明示的后续工作。
- 控制台尚无 System One provider 编辑器——原生上游经 `config.yaml` 配置（`type: 'systemone'`；见 `config.example.yaml`）。

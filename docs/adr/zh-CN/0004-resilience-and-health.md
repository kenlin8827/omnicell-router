# ADR-0004: 容错——错误分类、规则树下的断路器状态机、作用域跳闸、能力健康视图、整形与熔断之别

## 状态

已实现 — 2026-10-15（事实面语料重写）。范围：什么算失败、断路器如何跳闸与恢复、什么能熬过重启、健康向上如何用**词**、限流与熔断的分野。执行时序 = ADR-0005；健康视图的驱逐消费 = ADR-0002。

## 决策

### 1. 七类错误分类；分类器只诊断，管理器才裁定

`QUOTA_EXHAUSTED | AUTHENTICATION_ERROR | RATE_LIMITED | SERVICE_UNAVAILABLE | CLIENT_ERROR | MANUAL | UNKNOWN`（`resilience/types.ts:7-15`；5xx 与网络因——reset/超时/DNS——统统折入 SERVICE_UNAVAILABLE，附 `networkCause` 子词汇）。状态码提取容忍数字、消息文本（`status: 429`）与 provider 码字符串诸形态；`Retry-After` 仅支持整数秒（不支持 HTTP-date）。

默认处置（每一环都可被规则树覆写；共同偏向是"欠冷，勿过冷"）：

| 类别 | 触发码/措辞 | 默认作用域 | 冷却 | 副作用 |
| :--- | :--- | :--- | :--- | :--- |
| QUOTA | 402/`insufficient_quota`/余额措辞 | account | `trip.quota.cooldownMs`（12h 档） | 从不 SUSPECT |
| AUTH | 401/`invalid_api_key`… | account | `trip.auth.cooldownMs` | `markSuspect:true` |
| RATE_LIMIT | 429/503+限流措辞；遵从 `Retry-After` | 命中账号级措辞表→account，否则 pair | `clamp(RA·1000,[1s,maxCooldown])`；无 RA → `min(60s,initial)` | 短突发（RA ≤ `maxRateLimitWaitMs`）原地可重试；**长 RA 硬熔且以该时长为冷却——信任上游自报的等待** |
| SERVICE_UNAVAILABLE | 5xx/网络 | model | 阶梯（30s→×2→5h 顶） | — |
| CLIENT_ERROR | 400/422 + 措辞 | 永不跳闸 | — | 仅 `counting.clientErrors` ON 时计数（唯一的反转项） |
| UNKNOWN | 其余一切 | pair | 统计计数 | — |

作用域规则：仅当错误携带凭证归属（由 `registry.execute` 统一盖戳）才允许 scoped 跳闸；无归属错误永不带 `tripScope`（缺省 = model）。规则 per-class `scope` 覆写诊断——在归属**之后**生效，从不之前。

### 2. 三态机；消耗门 vs 非消耗 peek

`CLOSED | HALF_OPEN | OPEN`（`CircuitBreakerState`）——这套词汇属于断路器组件，**永不**用于模型级聚合（见 §4）。探测：per-class 连续失败阶梯 + 滑动失败率窗（默认阈值 3/窗 20/50%；`initialCooldownMs` 30s、×2 递增、`maxCooldownMs` 5h 顶；quota 固定 12h）。恢复试飞：`recovery.halfOpen.{maxProbes,successThreshold,maxWaitMs}` + `onCanaryFailure: backoff|initial|close`（MANUAL 强制 backoff；默认阈值 1 = 金丝雀一击即闭；卡住的单金丝雀受 `maxWaitMs` 限界，0 = 永等）。

- **消耗门** `canExecute` 只在紧贴上游调用前被调。**Peek** `peekExecute`（选择、池过滤、leader 挑选、控制台）永不占探针槽——查找会把恢复中的模型饿死在永久 HALF_OPEN。
- pair/account 裁定刻意不触模型断路器（单个 pair 吃 429 不应株连整个模型）；模型级跳闸经**聚合**读成"全部前缀 out"，不改写 pair 状态。
- 非惩罚结局（规则 drop、`shouldTripBreaker:false`）释放已消耗的探针槽；客户端侧 413/499 根本到不了断路器（无上游调用即无记录）。

### 3. 热规则树，OFF 语义即契约

`circuitBreaker.rules`（全局 ⊕ per-provider 覆写）：按类 counting/trip/recovery 旋钮——UNSET 回落全局档（legacy 行为即默认值）。**每次控制台保存都热应用**（`manager.applyConfig`——换规则集，不换活状态机；唯一对账：因已被禁规则而 OPEN 的断路器当场释放）（`routes/console.ts:1082,1106`）。OFF 语义是契约不是实现细节：counting-off = 不记录不跳闸（并释放已占探针槽）；trip-off（quota/auth）= 完全忽略（不跳、不计、**不标 SUSPECT**——被忽略的 401 不得行政弹射账号）；trip.rateLimit-off = 长 RA 429 降级为计数的统计失败，RA 推导地板仍然流入 `max(min, computed)`。全树不变量：**开关既不设置也不清除既有标记**（`markSuspect:false` 只停**新**标记；已存的 SUSPECT 持续拦选择直至人工 clear）。SUSPECT 仅随跳闸设置；仅 reconnect/Push/管理员清除。操作员 DISABLED 对分类器不可见却在一切选择退化中优先（绝不被强试）。Shadow 模式：自动跳闸不否决（账照记）；MANUAL 永远生效。`circuitBreaker.enabled:false` = 门永放行 + 记录 no-op；选择层标记、限流、手动跳闸照常工作。

### 4. 两种健康读数，一个刻意分歧

- `modelAvailability`（**peek** 式聚合布尔）：模型断路器不允许 ⇒ 全前缀 out；否则某前缀 out 当且仅当 `isPairOut`（DISABLED 最先，次 SUSPECT，再 pair 断路器 peek）。服务池构建、账号选择、驱逐**着陆守卫**。
- `modelHealthView` ∈ `available | recovering | unavailable`（**状态**式聚合，非消耗 `getState()`，并按 `verdict()` 契约同款折叠 shadow：被 shadow 的自动跳闸仍在服务，故永不读作下架；MANUAL 保持原样）：`available` = 模型非 OPEN ∧ 存在 CLOSED pair；`recovering` = 试飞在途（槽位空闲或被占皆可）而无 CLOSED pair；`unavailable` = 模型 OPEN 且无 CLOSED pair，或全部 pair 硬 OPEN/DISABLED/SUSPECT。下架优先于试飞中；无凭证链退化只看模型态；模型试飞中但所有 pair 仍硬 OPEN 读 `unavailable`（探针根本到不了上游）。服务会话钉扎**驱逐**（ADR-0002 只在 `unavailable` 触发）——操作员绝不会把"试飞刚开始"和"没了"混为一谈。

分歧是要点：忙碌金丝雀在 peek 上读作不可用——本轮池会绕开它、peek 式着陆守卫会拒绝它，但状态视图保护活绑定不被搬离距一次探针之遥的模型。

### 5. 断路器记忆——状态分环境，标记属全局

断路器状态机持久化到 `<home>/breaker-state.<env>.json`（按**环境账本**）：完整状态机 + 滑窗结果熬过重启；HALF_OPEN 恢复时探针计数清零、`enteredAt` 重锚 now（快照期在飞的 canary 不得被饿死）；`cooldownUntil` 带时钟回拨护栏；写入去抖（`persistence.debounceMs`，不参与热应用）、原子 temp+rename 0600、损坏文件旁存 `.corrupt.<ts>`；SIGINT/SIGTERM/SIGBREAK/exit 钩子刷盘。行政标记持久化**全局**（`suspect-accounts.json`——SUSPECT 与 DISABLED 两类）：它们附着在凭证上，不属于账本。加载跳过永久禁规则的记录。

### 6. 主动健康探测（opt-in）

`circuitBreaker.activeProbing.enabled:false` 默认；节奏 `activeProbing.intervalMs`。每 tick 扫描到期的 pair（HALF_OPEN，或 OPEN 且冷却尽），用 `max_tokens:1` 的 `health_check_ping` 走**真实执行路径**（凭证重盖 → 诊断带作用域）。探针永不占流量金丝雀槽：自带模型槽预算（= `halfOpen.maxProbes`），每 pair 取第一个 not-out 的"代表凭证"；SUSPECT 从不自愈；全 out 的链本周期跳过。探测把被动等冷却变成有验证的恢复，代价约等于零 token。

### 7. 限流——另一根轴：配额整形，不是健康

独立引擎（`ratelimit/`）：对 `requests | tokens | costUsd` 的滑动窗日志（任一满即裁定）；被拒的请求**不计数**。两个方向：**入站强制**（按 apiKey：429 + `Retry-After`，OpenAI 错误形 + `param=limitedBy`；有界宽限 ≤ 2s 先复查一次再拒；MITM 腿不入站计量）与**出站整形**（按账号 `account:<provider>:<keyHashPrefix>` 叠层上限：选择时**跳过**到顶账号——仅作用于新落位；keep-bound 铁律：本地封顶永不动已绑定会话，只有 provider 自己的 429/pair-open/下架动它；末位候选强试照旧，记为 `forced`）。每个候选的次序被固定：selectAccount（健康+亲和+余量）→ 限流 PEEK（非消耗；到顶不烧金丝雀）→ 消耗门 `canExecuteScoped` → `dispatch` 扣槽 → 执行 → scoped 记录。事件账本种类 `denied/grace-admitted/skipped/forced/shaped`（上游 429 归断路器，不入此账）；环 500 + 合并 UPSERT 镜像进 `traces.db`（独立句柄、故障隔离、处处 fail-open）。管理 API：`GET /api/admin/ratelimit[/events]`、`POST /api/admin/ratelimit/events/clear`。

### 8. 操作员表面

`X-OCR-*` 头单点归属 `surfaces/ocr-headers.ts`（默认值是冻结契约；传输层决定**送达方式**而非内容）：chat 腿 13 基头（`Tier`、`Tier-Escalated`、`Layer`、`Model`、`Failover`、`Failover-Attempts`、`Failover-Path`、`InPlace-Retries`、`Breaker-State`、`Session-ID`、`Session-Ratchet`、`Session-Lookup`、`Trace-ID`、`Latency-MS`）+ 条件 `Thinking-Requested/Actual/Degraded` 与 `Variant`；决策面恰 3 头（ADR-0008）。断路器管理 API：`GET /api/admin/health/circuit-breakers`（模型+pair 快照 + 规则横幅）、`POST .../reset?scope=model|account|pair&account=<keyHashPrefix>`（清冷却/失败计数/滑窗/阶梯位——**从不**清 SUSPECT）、`POST .../trip`（手动，默认 1h，钳 [1s, 7d]）、`POST /api/admin/health/suspect-accounts/clear`。重复的配置告警一律过 `WarnThrottle`（每进程去重一次 + 60s ≤ 50 条折叠）。

## 后果

- 硬/软响应由类别决定、规则树可覆写、热应用——每族 OFF 语义被成文而非默认猜想。
- §4 的能力/状态分层给操作员每个词一份无歧义的对应："宕了"、"在恢复"、"下架了"；peek 与状态视图的分歧由测试钉死（`pin-eviction.test.ts`、`resilience*`）。
- 恢复要么被验证（探针），要么被诚实绕开（peek），绝不出自偶然。

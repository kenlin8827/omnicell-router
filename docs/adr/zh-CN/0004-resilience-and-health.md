# ADR-0004: 容错——错误分类、规则树下的断路器状态机、作用域跳闸、能力健康视图、整形与熔断之别

## 状态

已实现 — 2026-10-15（事实面语料重写）。范围：什么算失败、断路器如何跳闸与恢复、什么能熬过重启、健康向上如何用**词**、限流与熔断的分野。执行时序 = ADR-0005；健康视图的驱逐消费 = ADR-0002。

## 决策

### 1. 七类错误分类；分类器只诊断，管理器才裁定

`QUOTA_EXHAUSTED | AUTHENTICATION_ERROR | RATE_LIMITED | SERVICE_UNAVAILABLE | CLIENT_ERROR | MANUAL | UNKNOWN`（`resilience/types.ts:7-15`；5xx 与网络因——reset/超时/DNS——统统折入 SERVICE_UNAVAILABLE，附 `networkCause` 子词汇）。状态码提取容忍数字、消息文本（`status: 429`）与 provider 码字符串诸形态；`Retry-After` 仅支持整数秒（不支持 HTTP-date）。

默认处置（每一环都可被规则树覆写；共同偏向是"欠冷，勿过冷"）：

| 类别 | 触发码/措辞 | 默认作用域 | 冷却 | 副作用 |
| :--- | :--- | :--- | :--- | :--- |
| QUOTA | 402/`insufficient_quota`/余额措辞 | credential | `trip.quota.cooldownMs`（12h 档） | 从不 SUSPECT |
| AUTH | 401/`invalid_api_key`… | credential | `trip.auth.cooldownMs` | `markSuspect:true` |
| RATE_LIMIT | 429/503+限流措辞；遵从 `Retry-After` | 命中凭证级措辞表→credential，否则 pair | `clamp(RA·1000,[1s,maxCooldown])`；无 RA → `min(60s,initial)` | 短突发（RA ≤ `maxRateLimitWaitMs`）原地可重试；**长 RA 硬熔且以该时长为冷却——信任上游自报的等待** |
| SERVICE_UNAVAILABLE | 5xx/408/425/网络 | 端点证据（5xx/超时/reset）→model；**主机级连接失败（DNS `ENOTFOUND`/`EAI_AGAIN`、TCP `ECONNREFUSED`、TLS/证书）→provider** | 阶梯（30s→×2→5h 顶） | 主机级证据只喂**统计**阶梯——从不硬熔（一次 DNS 抖动不得放倒整个 provider，阶梯阈值自会吸收） |
| CLIENT_ERROR | 请求 fault 类 4xx **按状态码**：400–499 中除 403/404/408/410/425 外的一切（401/402/429 已在前面归入各自类别）——无措辞白名单 | 永不跳闸 | — | 仅 `counting.clientErrors` ON 时计数（唯一的反转项） |
| UNKNOWN | 其余一切，含 403（权限）与 404/410（死模型地址），各带明确 reason | pair | 统计计数 | 绝不放宽：同一把 key 在别的模型上可能服务正常 |

作用域规则：仅当错误携带凭证归属（由 `registry.execute` 统一盖戳）才允许 scoped 跳闸；无归属错误永不带 `tripScope`（缺省 = model）。**唯一例外是主机级连接失败**：其半径是 PROVIDER——与凭证、模型无关——故 `tripScope:'provider'` 有无归属都随行（provider 由模型注册可知，扇出覆盖每一把凭证、含哨兵元组）。盖戳同时落在诊断自身（`ErrorDiagnosis.usedKeyHashPrefix`），调用方选择前缀缺席时管理器从它归因——退化选择（全不健康/全禁用/无会话）仍在默认凭证上执行，该次尝试的凭证级错误必须冷却真正服务它的那把凭证，而不是模型断路器。规则 per-class `scope` 覆写诊断——在归属**之后**生效，从不之前。

**控制台参考（只读）。** 上面这套分类器固定映射会在 `/admin/breaker-rules` 以只读参考弹窗呈现，由区块头部按钮唤起——不做内联块，因为页面的纵向流属于可配置规则树。它只回答一个问题：每条规则的 `auto` 作用域解析到什么、以及为什么请求类 415 永不跳闸而 403 会计数，因此只打印影响面：硬跳/计数/忽略这类处置是分类器在**任何覆写之前**给出的判定，真正生效的处置归 A 区所有，再只读地复述一遍会让页面出现两个真相。行为事实（默认作用域、硬跳/计数/忽略处置、是否有计数开关，以及主机级/凭证额度/长 Retry-After/SUSPECT 等变体）单点来源于 `CLASSIFIER_TAXONOMY`（`resilience/error-classifier.ts`，与 `classify()` 同文件），经状态载荷的 `circuitBreakers.classifier` 暴露，并由 `classifier-taxonomy.test.ts` 钉死到真实 `classify()` 输出——描述符是行为的**摘要**，绝非第二份实现，该测试即防漂移守卫。触发条件文案是按稳定 category 键控的特许 i18n 拷贝；弹窗是参考而非配置（规则树**覆写**这些默认值，从不重定义映射）。旧网关省略该字段时头部按钮不渲染，参考也就无处可达。

### 2. (模型 × 凭证) 元组上的三态机；作用域即扇出写入

`CLOSED | HALF_OPEN | OPEN`（`CircuitBreakerState`）——这套词汇属于断路器组件，**永不**用于模型级聚合（见 §4）。唯一存在的状态机是键为 `modelId::keyHashPrefix` 的 (模型 × 凭证)**元组**断路器；`keyHashPrefix === ''` 是链外凭证（provider 配置内置 key）的**哨兵**元组，故一切 legacy 模型级路径恰好退化为一个元组。没有模型级断路器状态机：所谓"模型级"是这些元组的派生折叠（`getAllSnapshots`/`getSnapshot`）——最坏态胜出，仅为摘要/UI 兼容而留。

跳闸作用域是对元组的**扇出写入**，每个目标记录管理器盖的作用域标签（`tuple.lastScope`，在 pair 快照视图中以 `scope` 呈现）——**四级**粒度，由窄到宽：

- `pair` → 单个元组（provider + modelId + 凭证）；
- `credential` → (provider, 凭证) 在其可达的全部模型上的每一个元组；
- `model` → 该 modelId 的**每一个**元组（等量扇出记账：每个元组的阶梯都吃到模型级失败，故一把 key 服务着垂死上游仍在阈值处拄倒整个模型）；编排层传入完整凭证链，故未服务过失败尝试的 key 也被覆盖——MANUAL 模型级跳闸同样贯通整条链（REST 入口经注册表解析 provider 链），操作员下架不会在无失败史的模型上退化成哨兵元组。
- `provider` → 该 provider 服务的**每个模型的每个元组**（已注册模型 ∪ 已携带其元组的模型——与 credential 作用域同款幽灵覆盖契约）。自动入口**保留给**主机级连接失败（§1）：证据只喂统计阶梯、从不硬熔，且不带凭证归属。手动 provider 下架（控制台/REST）是普通手动跳闸，同款冷却钳位。provider 跳闸从不标 SUSPECT，也从不触其他 provider 的元组。

手动下架（model/provider 级）比失败扇出多一条保证：**未知凭证链**时哨兵元组必被纳入——它是 `modelAvailability(model, [])` 读取的链外执行路径，故游离 pair 元组（如此前一次 credential 跳闸留下的）不能吸走整个扇出、让模型在未触动的哨兵上继续服务。已知非空链则恰好覆盖链上元组；那时运行时从不查哨兵，故不多造一行。

探测：per-class 连续失败阶梯 + 滑动失败率窗（默认阈值 3/窗 20/50%；`initialCooldownMs` 30s、×2 递增、`maxCooldownMs` 5h 顶；quota 固定 12h）。恢复试飞：`recovery.halfOpen.{maxProbes,successThreshold,maxWaitMs}` + `onCanaryFailure: backoff|initial|close`（MANUAL 强制 backoff；默认阈值 1 = 金丝雀一击即闭）。试飞是**按元组**的：模型级扇出跳闸后每个元组各自需要 `successThreshold` 次成功，故整模型恢复时延随凭证数增长（有意为之——元组只在其**自己的** key 再次服务成功时关闭）。每模型探针预算（每探测周期 `halfOpen.maxProbes`）在同一模型的诸元组间共享，扇出无法放大后台负载。

- **OPEN 吸收证据**：元组已 OPEN 期间观察到的失败会被分类并写入事件账，但**不**喂断路器的任何计数——阶梯、失败率窗、总量皆然（`recordFailure`/`recordHardTrip` 提前返回）：跳闸已为该次中断定价，冷却期内持续的流量不得把恢复后的阶梯顶高（否则一场 5h 中断会在恢复后第一次抖动就以阈值 3 重新武装）。
- **消耗门** `canExecuteScoped` 只在紧贴上游调用前被调——它是**那一个**元组的门（+SUSPECT）；`canExecute(modelId)` 是哨兵元组的门（链外路径）。**Peek** `peekExecute`（选择、池过滤、leader 挑选、控制台）永不占探针槽——查找会把恢复中的元组饿死在永久 HALF_OPEN。
- 凭证级裁定不触其他凭证的元组；元组状态才是控制台卡片的自身真相，派生的模型折叠只是展示背景，永不刷到健康的兄弟卡片上。
- 非惩罚结局（规则 drop、`shouldTripBreaker:false`）释放已消耗的探针槽；客户端侧 413/499 根本到不了断路器（无上游调用即无记录）。
- **记账单位是逻辑请求，不是尝试。** 一个候选位若原地重试，只在**最后一次**尝试上记一次失败（编排器在 `isInPlaceRetriable && attempt < maxInPlaceAttempts && !relay.committed` 期间抑制逐次记录；存活下来的诊断带着 `usedCredentialKeyHashPrefix` 盖戳，故阶梯归因到真正出错的那把凭证）。原地重试从来不是新证据——对同一个垂死上游的三次尝试不得记成三级阶梯。429 整形惩罚与失败事件账仍按尝试记（每次尝试都是一次真实的上下游交换）。

### 3. 热规则树，OFF 语义即契约

`circuitBreaker.rules`（全局 ⊕ per-provider 覆写）：按类 counting/trip/recovery 旋钮——UNSET 回落全局档（legacy 行为即默认值）。**每次控制台保存都热应用**（`manager.applyConfig`——换规则集，不换活状态机；唯一对账：因已被禁规则而 OPEN 的断路器当场释放）（`routes/console.ts:1082,1106`）。OFF 语义是契约不是实现细节：counting-off = 不记录不跳闸（并释放已占探针槽）；trip-off（quota/auth）= 完全忽略（不跳、不计、**不标 SUSPECT**——被忽略的 401 不得行政弹射凭证）；trip.rateLimit-off = 长 RA 429 降级为计数的统计失败，RA 推导地板仍然流入 `max(min, computed)`。全树不变量：**开关既不设置也不清除既有标记**（`markSuspect:false` 只停**新**标记；已存的 SUSPECT 持续拦选择直至人工 clear）。SUSPECT 仅随跳闸设置；仅 reconnect/Push/管理员清除。操作员 DISABLED 对分类器不可见却在一切选择退化中优先（绝不被强试）。Shadow 模式：自动跳闸不否决（账照记）；MANUAL 永远生效。`circuitBreaker.enabled:false` = 门永放行 + 记录 no-op；选择层标记、限流、手动跳闸照常工作。

### 4. 两种健康读数，一个刻意分歧

- `modelAvailability`（**peek** 式聚合布尔）：模型断路器不允许 ⇒ 全前缀 out；否则某前缀 out 当且仅当 `isPairOut`（DISABLED 最先，次 SUSPECT，再 pair 断路器 peek）。服务池构建、凭证选择、驱逐**着陆守卫**。
- `modelHealthView` ∈ `available | recovering | unavailable`（**状态**式聚合，非消耗 `getState()`，并按 `verdict()` 契约同款折叠 shadow：被 shadow 的自动跳闸仍在服务，故永不读作下架；MANUAL 保持原样）：`available` = 模型非 OPEN ∧ 存在 CLOSED pair；`recovering` = 试飞在途（槽位空闲或被占皆可）而无 CLOSED pair；`unavailable` = 模型 OPEN 且无 CLOSED pair，或全部 pair 硬 OPEN/DISABLED/SUSPECT。下架优先于试飞中；无凭证链退化只看模型态；模型试飞中但所有 pair 仍硬 OPEN 读 `unavailable`（探针根本到不了上游）。服务会话钉扎**驱逐**（ADR-0002 只在 `unavailable` 触发）——操作员绝不会把"试飞刚开始"和"没了"混为一谈。

分歧是要点：忙碌金丝雀在 peek 上读作不可用——本轮池会绕开它、peek 式着陆守卫会拒绝它，但状态视图保护活绑定不被搬离距一次探针之遥的模型。

### 5. 断路器记忆——状态分环境，标记属全局

断路器状态机持久化到 `<home>/breaker-state.<env>.json`（按**环境账本**）：完整状态机 + 滑窗结果熬过重启；HALF_OPEN 恢复时探针计数清零、`enteredAt` 重锚 now（快照期在飞的 canary 不得被饿死）；`cooldownUntil` 带时钟回拨护栏；写入去抖（`persistence.debounceMs`，不参与热应用）、原子 temp+rename 0600、损坏文件旁存 `.corrupt.<ts>`；SIGINT/SIGTERM/SIGBREAK/exit 钩子刷盘。行政标记持久化**全局**（`suspect-credentials.json`——SUSPECT 与 DISABLED 两类）：它们附着在凭证上，不属于账本。加载跳过永久禁规则的记录。

### 6. 主动健康探测（opt-in）

`circuitBreaker.activeProbing.enabled:false` 默认；节奏 `activeProbing.intervalMs`（由与配额探测共享的 `utils/probe-interval.ts` 钳到 [10 s, 1 h]；缺省/NaN/非正数回落 `DEFAULT_PROBE_INTERVAL_MS`）。启用时随进程启停（boot 时 `orchestrator.startProber()`，关机时停）——恢复探测与配额探测同属进程生命周期机器。每 tick 扫描到期的 pair（HALF_OPEN，或 OPEN 且冷却尽），用 `max_tokens:1` 的 `health_check_ping` 走**真实执行路径**（凭证重盖 → 诊断带作用域），受 30 s 探针超时限界（`DEFAULT_PROBE_TIMEOUT_MS`，`config/defaults.ts`）。该限界刻意远低于服务路径的 `DEFAULT_PROVIDER_TIMEOUT_MS`（300 s）：探针是证据不是服务负载，且一个挂死的上游绝不能占住扫描的 `isProbing` 重入锁。代价写在这里而不是藏着——某 provider 若对 1-token 补全真需要 30 s 以上（长 prefill、冷排队），它会每次探测都失败；而探针超时按 SERVICE_UNAVAILABLE 归入 model 作用域，故这类周期是把该模型**所有已存在元组**重新 OPEN 并各自抬升冷却，而不只是冷却被探的那一个 pair——这正是 `activeProbing` 默认关闭的理由；探针也永不继承服务超时。放弃等待同样不等于取消该请求：`resolver.execute` 没有 AbortSignal 契约，挂死的 provider 每个周期都会留一条孤儿调用直到它自己的 provider 超时（300 s），期间仍占那把凭证的并发与额度。

全部凭证 out 的链在本周期跳过。**消耗式准入**：每轮试飞前先过 `manager.acquireProbeTrial`（取探针槽——驱动 OPEN→HALF_OPEN、占用试飞槽、真实金丝雀已持槽时直接跳过，合成与真实试飞永不竞争）；探针行在失败账上带 `role:'probe'`，控制台据此把合成试飞与服务流量分开。探针**不**自带宽裕槽位、也不吃「自己的一份预算」——它用的就是 `halfOpen.maxProbes` 这份真实试飞预算（按模型计，跨元组共享）；SUSPECT 凭证永不自动回场。

若探针目标自身从未失败过（模型级跳闸的"代表凭证"挑选），试飞归该模型**武装中（到期）**的元组，结果记在**那里**——关闭真正持槽的断路器，否则成功无法释放它已消耗的槽。因此失败的探针会交付**两件**事实（`manager.recordProbeFailure`）：(1) 真正服务那次 ping 的凭证给出的**物理**事实——该凭证的 credential 作用域（它在每个模型上的 pair）、SUSPECT 标记与 `quota_events` 行全部归因于它；若改记在武装前缀上，就会去冷却、甚至标记一把从未失败的健康凭证，而真正出错的凭证保持 CLOSED；(2) 武装元组的裁定，当上述作用域尚未覆盖它时——按 pair 记、绝不扇出，因为试飞槽就在那个元组上，一个没吃到阶梯的 OPEN 元组会把槽永远卡住；死模型也必须像服务流量那样重新冷却。两刀是互补的：(1) 单打在物理答案比 model 更窄时不会冷却武装元组，(2) 单打在代表凭证不是武装凭证时不会冷却真凶。探针**作为探针**永不设置 SUSPECT：该标记只随 credential 作用域诊断的物理记录走（`trip.auth.markSuspect`），即服务流量拿到的同一条行政断言；而探针驱动的元组跳闸已经凭 auth 冷却期把那把凭证从选择中摘除。探测把被动等冷却变成有验证的恢复，代价约等于零 token。

### 7. 限流——另一根轴：配额整形，不是健康

独立引擎（`ratelimit/`）：对 `requests | tokens | costUsd` 的滑动窗日志（任一满即裁定）；被拒的请求**不计数**。两个方向：**入站强制**（按 apiKey：429 + `Retry-After`，OpenAI 错误形 + `param=limitedBy`；有界宽限 ≤ 2s 先复查一次再拒；MITM 腿不入站计量）与**出站整形**（按凭证 `credential:<provider>:<keyHashPrefix>` 叠层上限：选择时**跳过**到顶凭证——仅作用于新落位；keep-bound 铁律：本地封顶永不动已绑定会话，只有 provider 自己的 429/pair-open/下架动它；末位候选强试照旧，记为 `forced`）。每个候选的次序被固定：selectCredential（健康+亲和+余量）→ 限流 PEEK（非消耗；到顶不烧金丝雀）→ 消耗门 `canExecuteScoped` → `dispatch` 扣槽 → 执行 → scoped 记录。事件账本种类 `denied/grace-admitted/skipped/forced/shaped`（上游 429 归断路器，不入此账）；环 500 + 合并 UPSERT 镜像进 `traces.db`（独立句柄、故障隔离、处处 fail-open）。管理 API：`GET /api/admin/ratelimit[/events]`、`POST /api/admin/ratelimit/events/clear`。

### 8. 操作员表面

`X-OCR-*` 头单点归属 `surfaces/ocr-headers.ts`（默认值是冻结契约；传输层决定**送达方式**而非内容）：chat 腿 13 基头（`Tier`、`Tier-Escalated`、`Layer`、`Model`、`Failover`、`Failover-Attempts`、`Failover-Path`、`InPlace-Retries`、`Breaker-State`、`Session-ID`、`Session-Ratchet`、`Session-Lookup`、`Request-ID`、`Latency-MS`）+ 条件 `TTFT-MS`/`Gen-MS`（仅当落定尝试真正流式时——网关实测的首 token 等待与解码窗口，两者相除即控制台的输出速度（output speed，OTel `time_per_output_token` 的倒数）；缓冲轮次两首都缺席）、`Thinking-Requested/Actual/Degraded` 与 `Variant`；决策面恰 3 头（ADR-0008）。断路器管理 API：`GET /api/admin/health/circuit-breakers`（模型+pair 快照 + 规则横幅）、`POST .../reset?scope=model|credential|pair|provider&credential=<keyHashPrefix>&provider=<id>`（清冷却/失败计数/滑窗/阶梯位——**从不**清 SUSPECT）、`POST .../trip`（手动，默认 1h，钳 [1s, 7d]；同款四级作用域——`provider` 必须带 provider id，model/provider 下架经注册表贯通该 provider 的完整凭证链；落在零个元组上的跳闸回 400 且带 `affected:0`，绝不假成功）、`POST /api/admin/health/suspect-credentials/clear`。重复的配置告警一律过 `WarnThrottle`（每进程去重一次 + 60s ≤ 50 条折叠）。`/api/admin/status` 的 `circuitBreakers` 块还额外携带静态 `classifier` 参考映射（§1），供熔断规则只读参考弹窗渲染；它是增量字段，旧网关省略时头部按钮不渲染。

## 后果

- 硬/软响应由类别决定、规则树可覆写、热应用——每族 OFF 语义被成文而非默认猜想。
- §4 的能力/状态分层给操作员每个词一份无歧义的对应："宕了"、"在恢复"、"下架了"；peek 与状态视图的分歧由测试钉死（`pin-eviction.test.ts`、`resilience*`）。
- 恢复要么被验证（探针），要么被诚实绕开（peek），绝不出自偶然。

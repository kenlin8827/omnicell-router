# ADR-0008: 顶级工业级模型熔断、多级容灾与健康管理系统

## 状态
已接受并实现 (Accepted & Implemented) - 2026-09-30
**2026-10-14 修订** — 熔断器状态已落盘持久化（见文末修订小节）。原“纯内存、重启清零”的姿态被取代：冷却时长、退避位置、滑动窗口与手动熔断均跨网关重启存活。

**2026-10-14 修订（规则）** — §1/§2 的每一条自动熔断规则都可在 `circuitBreaker.rules` 下独立开关并配置自身参数；HALF_OPEN 成为可配置的试探批次；`circuitBreaker.shadow` 新增“只验证、不拦流量”模式。默认值没有任何改变：不写 `rules` 时行为与修订前逐字节一致（见文末“修订（2026-10-14，规则）”小节）。

**2026-10-14 修订（热生效）** — 熔断规则在每次配置保存后即时生效；规则修订“重启生效”的姿态被取代（见文末“修订（2026-10-14，热生效）”小节）。

## 上下文 (Context)
在大规模生产级 AI 网关与模型路由网关实践中，上游大语言模型服务具有强异构、跨供应商、高波动等特征，面临诸多不可避免的可用性挑战：
1. **欠费与额度耗尽 (Quota Exhausted)**：账号突然欠费、Token 额度用完（HTTP 402 / `insufficient_quota`），若网关不具备感知能力，会导致后续海量请求持续冲击该模型并全量失败。
2. **多小时级供应商重大故障 (5-Hour Outages)**：上游服务雪崩（500/502/503/504 / 网络超时），缺乏熔断器会导致每次请求等待数十秒超时，耗尽网关连接池，拖垮下游客户端。
3. **频控限流 (Rate Limiting 429)**：TPM / RPM 超限时未作短时退避，无法利用同 Tier 备选模型分担流量。
4. **会话单调棘轮死锁 (Session Ratchet Deadlock)**：先前为了保护 KV Cache 命中率引入了 Session 模型锁定（Pinning），但当被锁定的模型宕机时，整个会话后续轮次全盘瘫痪。
5. **客户端误传不当导致误熔断**：客户端上下文超长（400 context length exceeded）或安全过滤拦截，属于用户输入问题，绝不能被错误计入模型故障并导致模型熔断。

## 决策 (Decision)
全面构建**高精度错误分类学（Error Taxonomy）、多级熔断状态机（Circuit Breaker）、同级优先透明故障转移（Same-Tier Failover）与会话自愈（Session Self-Healing）**的工业级弹性体系：

### 1. 结构化错误分类学 (Error Taxonomy & Diagnosis)
将上游异常严格解构为 6 类，实行差异化治理：
* `QUOTA_EXHAUSTED` (HTTP 402 / `insufficient_quota`)：**立即硬熔断 (Hard Open)**，进入长冷却（默认 12 小时），不发起高频探活，支持管理后台手动复位；
* `AUTHENTICATION_ERROR` (HTTP 401 / `invalid_api_key`)：**立即硬熔断**，锁定直至密钥重载；
* `RATE_LIMITED` (HTTP 429 / TPM/RPM)：**瞬时自适应退避**，优先解析 `Retry-After` Header，短时避让同 Tier 备用节点；
* `SERVICE_UNAVAILABLE` (HTTP 5xx / 网络超时 / ETIMEDOUT)：**滑动窗口 + 连续失败阈值熔断**，进入阶梯指数退避（30s $\to$ 60s $\to$ 120s ... 最大 5 小时封顶）；
* `CLIENT_ERROR` (HTTP 400 / context length exceeded)：**零惩罚穿透**，不计入模型故障，不触发重试与熔断；
* `UNKNOWN`：标准容错重试。

### 2. 标准三态熔断状态机 (Circuit Breaker State Machine)
* `CLOSED`（健康）：正常承载流量；
* `OPEN`（熔断）：阻断对该模型的请求，即刻零耗时转向备选模型；
* `HALF_OPEN`（试探）：冷却期满后，放行微量金丝雀（Canary）请求探活。探活成功则完全恢复 `CLOSED`，探活失败则加倍冷却时长再次 `OPEN`。

### 3. 同 Tier 候选池透明故障转移 (Zero-Downtime Failover)
* 每个 Tier 维护优先级候选列表（`primary`, `backup-1`, `backup-2`）；
* 请求优先派发给主模型；主模型抛出可恢复故障（402/503/429）时，熔断器记录故障并在单次 HTTP 会话内**毫秒级透明转移**至同 Tier 备选模型；
* 用户无感知拿到 200 成功响应，响应头附带治理追踪元数据：
  * `X-OCR-Failover: true`
  * `X-OCR-Failover-Attempts: 2`
  * `X-OCR-Failover-Path: primary-model -> backup-model`
  * `X-OCR-Breaker-State: CLOSED`

### 4. 会话单调棘轮自愈 (Session Self-Healing)
* 当检测到会话绑定的 `pinnedModel` 进入 `OPEN` 熔断态时，网关自动解绑并将 Session 平滑迁移重绑定（Repin）至健康的同 Tier 备选模型，彻底消除死锁。

### 5. 全维可观测性与管理接口 (Observability & REST APIs)
* `GET /health`：智能汇总网关全局健康度（`ok` / `degraded` / `outage`）与熔断器健康数；
* `GET /v1/health/circuit-breakers`：暴露所有模型的实时状态、剩余冷却时长、故障类别、总请求/失败数；
* `POST /v1/health/circuit-breakers/reset`：提供管理员在人工充值或供应商排障完毕后的一键复位接口。

## 后果与影响 (Consequences)
- **正面影响**：
  - 彻底终结了“模型欠费或宕机 5 小时导致服务全崩”的脆弱性，实现真正意义上的 99.99% 企业级高可用保障；
  - 零配置透明容灾：客户端像调用标准 OpenAI 接口一样使用，底层自动完成多供应商无感切换；
  - 精确保护上游账单与连接池资源，杜绝持续向失效上游发送雪崩流量。

## 修订 (2026-10-14) — 熔断记忆跨重启存活

**问题。** 状态机此前只存在于进程内存，每次重启都会清空全部冷却：402 额度硬熔断（12 小时）与运维手动熔断（最长 7 天）被静默解除，刚启动的网关会立刻重新冲击仍在冷却窗口内的账号。注册表自身的注释甚至把“持久排除”转嫁给 `config.tiers`——那是针对缺口设计的绕行，不是本意。

**决策。**

- `<OCR_HOME>/breaker-state.<env>.json`（version 1，**按环境分文件**——与 suspect 标记不同：账号可疑与否跨环境成立，故 suspect 保持 GLOBAL；而熔断记忆以模型 id 为键，模型属于当前环境的配置，切到 B 环境恢复时会剪掉 A 的记录、首次保存即整文件重写，共用一个文件等于让环境切换摧毁另一套账）。承载每个模型级与 pair 级熔断器的全部可变状态：状态机、连续失败数、累计计数、滑动窗口、`cooldownUntil`、退避位置（`currentCooldownMs`）、探测配额与熔断原因三元组。文件惯例与 `suspect-accounts.json` 一致（temp+rename 原子写、0600、加载一次、损坏文件按空记忆启动并在首次写入时改名 `.corrupt.<ts>` 保留）。
- **写入时机**：每个公共变更入口挂起约 1 秒的去抖快照；`process.on('exit')` 钩子同步 flush——信号处理器对 `process.exit()` 从不执行（控制台的重启路由正是这样退出），'exit' 同时覆盖 SIGINT/SIGTERM/SIGBREAK 与自然结束。硬杀（`taskkill /F`、断电）没有任何处理器：那一侧的真实损失上界就是去抖窗口（治理叠加层的既有原则：短暂损失是"少整形"，不是"说谎"）。保存失败时快照保留待重试（下一次变更或退出 flush）——一次瞬时写失败（AV 锁住 rename 目标、短暂 ENOSPC）不会静默丢弃 trip。
- **恢复次序**：启动路径在全部配置模型注册完成之后才挂接存储，并丢弃当前配置已不再认识的模型记录（自我净化，不留幽灵熔断器）。身份（provider/tier）永远取自当前配置，文件中的副本仅作展示。恢复时 `cooldownUntil` 被钳制到 `now + currentCooldownMs`：停机期间墙钟**回跳**不能把冷却拉长到超出其退避阶梯位；墙钟**前跳**则提前放行——fail-open，与未持久化的活进程表现相同，属如实标注而非修复。
- **信任边界**：非法状态值、闭集词表之外的 reasonCode/category、`reasonParams` 中的非原始值成员与非数值标量在加载时被清洗；单条畸形记录丢弃而非致命；保存失败降级为告警——网关照常以内存态熔断器运行。**存在但读不了**的文件（EACCES、AV 瞬时读锁）以告警方式按空记忆启动，并在首次写入时改名保留，绝不无声覆盖。
- **不设配置开关，默认开启**——与始终持久化的 `suspect-accounts.json` 一致。落盘内容保持展示安全（模型 id、provider、keyHash 前缀、分类器 reason 文本；绝无密钥材料）——如实附注：分类器 `reason` 字符串内嵌最多约 150 字符的上游响应体切片，与已在控制台快照中暴露的是同一文本；0600 尽力而为（Windows 上是 no-op，真实 ACL 需 icacls）。
- 消耗型闸门（`canExecute` 的探测槽占用）与惰性 OPEN→HALF_OPEN 迁移不单独触发写入：被占用的 canary 槽通常会走到 `recordSuccess`/`recordFailure`，由它们挂起写入。但去抖保存或退出 flush 仍可能落在 canary 请求途中，持久化出探测配额已耗尽的 HALF_OPEN；因此 `applyRecord` 在恢复 HALF_OPEN 记录时会刷新探测配额——重启永远不会把熔断器卡死在 HALF_OPEN（最坏情形：重启后多发一次 canary）。
- canary 成功恢复（HALF_OPEN→CLOSED）时滑动窗口同步清空、从零重新起算：故障期间的旧失败记录不得让恢复后的一次瞬时抖动即刻再熔断（连续失败计数亦照常归零，滑窗速率阈值重新挣回）。

**后果。**

- （+）额度/限流冷却、阶梯退避与手动熔断跨重启存活；恢复试探恰好接续上一段生命周期的位置。
- （+）CLOSED 态的失败累积同样存活：连续计数与滑动窗口不再被重启清零。
- （−）文件位于 GLOBAL 状态根下，共享同一 `OCR_HOME` 的并发网关实例会互相竞写——与 suspect 标记的既有立场一致（单进程即产品形态）。
- （−）手动熔断不再“随重启解除”：被遗忘的手动熔断会冷却到自己的时限为止；需要永久排除时仍应使用 `config.tiers` 排除列表。

## 修订 (2026-10-14, 规则) — 逐条可配熔断规则、HALF_OPEN 试探批次、影子模式

规范见 [docs/design/circuit-breaker-rules-config.md](../../design/circuit-breaker-rules-config.md)（v3.1）。本次修订改变的是**运维者可以关掉哪些边、用什么参数**；§1 的错误分类、§2 的三态状态机、§3 的故障转移契约均未改动——规则开关绝不重写 `category` 与 `isRetriable`，因此故障转移行为与规则无关。

**问题。** §1/§2 把熔断行为写成了常量：402 与 401 永远硬熔断（且 401 永远标记账号），超长的 `Retry-After` 永远按借用自重试配置的分界硬熔断，两条统计检测器永远在跑；唯一的总闸是 `circuitBreaker.enabled`，全开或全关。恢复期是硬编码的单只 canary，首个成功即闭合——对于由多个凭据共同服务的模型，这个粒度太粗。而一套新规则只有让它去拦截真实流量之后才能被判断好坏。

**决策。**

- **一棵规则树、三个族、启动时解析一次。** `circuitBreaker.rules.counting.*` 决定**什么才会被记为失败**（`serverErrors`、`unknownErrors`、`clientErrors` 各带 `enabled` + `minCooldownMs`；429 的计入性**没有开关**——分类器始终计数，`rateLimitErrors` 只拥有“无 `Retry-After` 时”的冷却下限）；`rules.trip.*` 决定**计数到的失败何时打开熔断**（`quota`、`auth`、`rateLimit`、`consecutiveFailures`、`failureRate`，每条自带 `enabled`、自身参数与 `scope` 覆写）；`rules.recovery.*` 是半开/全开恢复策略。`circuitBreaker.shadow` 与 `circuitBreaker.persistence.debounceMs` 并列于该树。任何未设置的参数回落到 §1 的全局旋钮——规则页以只读的**共享默认值**折叠区展示它们（每个 `auto` 字段的实时继承值，悬停显示配置键；旋钮本身仍只能在 YAML 编辑，`activeProbing.intervalMs` 是唯一的例外）；`resolveCircuitBreaker` 对 `rules`、每个族映射、每个规则对象都**逐键合并**——部分书写的规则块不可能在浅层顶层合并中丢掉同级的默认值。跨字段钳制在清洗器与解析器中双向强制：`recovery.halfOpen.maxProbes >= 1`、`successThreshold <= maxProbes`、`trip.failureRate.minCalls <= windowSize`。
- **规则施加在管理器闸门，绝不在分类器内。** `CircuitBreakerManager.applyFailure` 是编排器与 `ActiveHealthProber` 的唯一汇合点（探测路径调用 `classify()` 时不带熔断配置，若把门控写进分类器，恰好会被这条驱动恢复的路径绕过）。一次诊断被解析为一种派发结果——`drop`（丢弃）/ `hard`（带最终时长的硬熔断）/ `count`（带调整副本的计数）/ `as-is`（原样）——再投递到爆炸半径内的每个熔断器；调用方的诊断对象永不被改写。
- **硬熔断时长由闸门解析，不再由分类器“建议”。** `trip.quota.cooldownMs` / `trip.auth.cooldownMs` 决定 402/401 的封锁时长（默认 `quotaCooldownMs`，即 §1 的 12 小时）；硬 429 取 `max(trip.rateLimit.minCooldownMs, min(Retry-After, 全局 maxCooldownMs))`——钳制上限保持全局，因为它封顶的是**任何**推导冷却。`trip.rateLimit.hardTripAboveMs` 分界在闸门处重新推导（默认借用 `retry.inplace.maxRateLimitWaitMs`；覆写它会有意让熔断侧分界与原地重试决策脱钩，而熔断侧从不改写后者）。据此 `ErrorDiagnosis.suggestedCooldownMs` 更名为 **`minCooldownMs`**，且只作为**统计路径**的下限（`max(minCooldownMs, 计算出的阶梯/速率冷却)`），再也无法左右硬熔断时长。
- **各族的 OFF 含义不同，而这正是契约。** 计数族关闭 = 该类根本不被记录（不进窗口、不计连续数）；被丢弃的类仍会释放它已占用的 HALF_OPEN 探测槽，于是一次“非惩罚”结果永远不会把试探卡死。检测器关闭 = 照常计数，只是不再评估该判定（已写入文档并被测试钉住）。`trip.rateLimit` 关闭是把超长 `Retry-After` 的 429 **降级**为计入的统计失败，而非忽略，且其 `Retry-After` 推导下限照常流入 `max(下限, 计算值)`。`counting.clientErrors` 打开是唯一的反向语义：400/422 成为计入的失败（`shouldTripBreaker: true`），使用熔断规则自身的阶梯。
- **“自动熔断为零”是五开关判据。** 当且仅当五个 `trip.*` 开关全部关闭时自动熔断才关闭——计数族关闭并不是通往“零”的路径，因为计入的 429 无开关且仍喂给检测器。`getRulesStatus()` 恰用这五个开关算出 `on | partly_off | all_off`（外加 `shadow`），整套生效规则集随 `/api/admin/status` 载荷下发给控制台，于是界面横幅与规则页不可能与闸门给出不同答案。如实附注：该判据统计的是会**触发**的规则；已经 OPEN 的熔断器仍会沿自身的恢复阶梯前进（`maxWaitMs` 或“批次未达标”引起的重新打开属于状态机自身的边），手动熔断是运维意图，不在判据之内。
- **关闭一条规则会对账存量状态。** `restoreState()` 跳过 `reasonCode` 属于被禁用规则的 OPEN 记录（`breaker.quota`、`breaker.auth`、`breaker.rate_limit`、`breaker.consecutive`、`breaker.rate_window`）——否则重启会复活一个没人要求过的 12 小时额度封锁。热生效修订（见下）在每次保存时对存量熔断器运行同一过滤器。`breaker.canary`（包裹其成因的触发性编码）与 `breaker.manual`（运维意图）有意不参与对账：这类记录要么按自身冷却到期，要么由手动 reset 清除。同理，已存在的 SUSPECT 标记**熬过**一切开关（见下）。
- **HALF_OPEN 成为一个试探批次。** `recovery.halfOpen.maxProbes` 是并发试探预算（默认 `halfOpenMaxProbes`，并且现在也是 `getProbeBudget()` 给出的探测路径每模型每周期预算）；`successThreshold` 是该批次需要多少个成功才允许闭合——闭合时依旧把阶梯与窗口清空重装。未达门槛的成功会释放自己那一个槽，让批次继续派发。存在凭据归属时，一次 pair 成功**计为模型试探的一次成功**，而不是强行关闭模型熔断器。`BreakerRecord` 与快照新增 `halfOpenSuccesses` 与 `halfOpenEnteredAt`（此前根本没有半开进入时刻）；`applyRecord` 对恢复出的 HALF_OPEN 会同时刷新探测数、成功数**与**进入时刻——停机不得消耗等待预算，重启也绝不能把试探卡死。
- **半开的两条出口都可配置。** `recovery.onCanaryFailure` 为三态：`backoff`（现行：阶梯 × `recovery.cooldownMultiplier`，受全局 `maxCooldownMs` 封顶）、`initial`（按阶梯首档重新熔断）、`close`（乐观置为 CLOSED，并**保留** `consecutiveFailures` 与 `currentCooldownMs`，使下一次计入的失败以更高档重熔）。`close` 对 `MANUAL` 熔断器永不生效——category 为 `MANUAL` 时回落到 `backoff`，因为规则不得推翻运维者的下线动作。三种情形共用这一条策略：探测失败、`maxWaitMs` 超时（`recovery.halfOpen.maxWaitMs`，默认 `0` = 永久等待，即现行形态；在下一次闸门检查时判定）、以及**批次未达标**：`maxProbes` 槽位全部占用而 `halfOpenSuccesses < successThreshold`。该判定以 `successThreshold > 1` 为前提，因此默认的 1/1 形态分毫未动——卡住的单只 canary 仍像过去那样滞留，不会在其探测请求仍在途中时被提前重熔。批次未达标**不计入新的失败**（什么都没失败，只是批次无法达到门槛），并以 `breaker.canary` 重新打开。
- **影子模式只翻转裁决。** `circuitBreaker.shadow: true` 之下，状态机仍以完整保真度运行——探测槽照常占用、阶梯照常前进、窗口照常填满、熔断照常记录/快照/发事件——而 `canExecute`/`peekExecute` 返回 `allowed: true`。豁免是结构性的，不是特例：翻转发生在熔断器的裁决处并对 category `MANUAL` 拒绝生效，而 DISABLED 运维下线与 SUSPECT 拒停在任何裁决被查询之前就已由管理器答复。已知并被接受的观测偏差：处于影子模式的模型继续承接全量流量，因此统计历史与真实执法的一次运行会有出入。
- **SUSPECT 随熔断产生，绝不被开关清除。** `markSuspect` 挂在熔断那一刻：auth 规则关闭即“忽略”（不熔断、不计数），因此**不产生新标记**——一个被忽略的 401 不该以行政手段把账号踢出池子；实现中的门控条件是 `accountSuspect && trip.auth.enabled && trip.auth.markSuspect`。`markSuspect: false` 保留熔断，只停止**新**标记；`suspect-accounts.json` 中已存在的条目继续拦截选路，直到运维者手动清除。贯穿整棵规则树的不变式：**开关既不会设置、也不会清除已存在的标记。** 该标记位于账号爆炸半径分支上，因此把 401 改路由到 pair 或模型熔断器的 `scope` 覆写会只熔断、不标记（ADR-0019 决策 6）。
- **生效方式为热生效。** 规则在每次配置保存后即时生效——最初“重启生效”的姿态（v1 的范围裁剪：“本次不加新热应用通道”）在同日被推翻；见文末“修订（2026-10-14，热生效）”小节。规则编辑位于独立的 `/breaker-rules` 页面；`/guardrails` 保留实时观测与手动 trip/reset 卡片，并提供进入规则页的链接。

**后果。**

- （+）§1 的每一类错误都可以按各自口径决定熔断、计入或忽略，并自带冷却与爆炸半径；运维者终于能表达“相信宕机检测、忽略死键检测”，而不再是整套接受或整套关闭。
- （+）规则集可以在拦截任何真实流量之前先用生产流量验证，而其继承值与闸门使用的正是同一份快照。
- （+）恢复能力随凭据矩阵扩展（多探测、N-of-M），而默认配置仍是逐字节不变的旧单 canary 行为。
- （−）一套机器现在有两份词汇：§2 的机器（边）与配置页的规则集（处置）。映射关系是“一条边 ↔ 唯一的规则归属者”，代码把闸门保持为唯一决策点，使两者不可能漂移成不同答案。
- （−）规则变更从下一个判定点起生效（热生效，见文末修订小节）而无需重启——但已在进行中的冷却按原时长走完、不重算，且存量状态对账改为每次保存时运行，而非只在启动时。
- （−）`minCalls`、`successThreshold`、`maxWaitMs` 给了运维者新的方式去拖慢恢复；钳制只能挡住不可能满足的组合，挡不住“合法但缓慢”的组合。

## 修订 (2026-10-14, 热生效) — 熔断规则即时生效

规则修订的同日跟进：其“重启生效”的姿态是 v1 的范围裁剪（“本次不加新热应用通道”），并非终局立场，现于此推翻。基准对照：Envoy 的**全部**熔断设置皆可运行时配置，xDS 视重启为例外；本控制台中其余所有可编辑段（proxy/capture/layer2/combos/tiers）早已保存即生效，熔断页是唯一的“保存后须重启”离群点。而调规则最急迫的时机恰是故障进行中——也正是重启破坏力最大的时刻：在途 LLM 流式请求被掐断，内存中的窗口与冷却计时被重置回持久化快照。

**决策。**

- `CircuitBreakerManager.applyConfig(config, retry)` 重跑 `resolveBreakerRules`，换掉闸门的规则集，并经 `CircuitBreaker.applyConfig` 把配置与新规则推给每个存量熔断器（model 与 pair 皆含）。两条保存路径（`/api/admin/config` 与原文 YAML 端点）都在写入成功后立即调用。`retry` 仅用于 `hardTripAboveMs` 的默认值，与启动时一致。
- **下一判定点语义，不做回溯重评。** 这次替换不触碰任何状态机字段：已 OPEN 的冷却计时按原时长继续走，阶梯位置、连续计数、HALF_OPEN 试探与滑动窗口全部保留。运行中的 `windowSize` 变更只随新结果推入时收敛（恢复路径对持久化切片重拟合；活体窗口自然排空）。调低阈值不会回溯触发任何人——下一次失败按新规则评估。
- **不变量 2 的对账前移到保存时。** 本次保存中被禁用的规则，其名下 OPEN 的熔断器（按 `reasonCode` 归属；`breaker.canary`/`breaker.manual` 永不参与）被立即 reset——`restoreState()` 启动过滤器的活体孪生。对账读取 `toRecord()` 而非 `getSnapshot()`：读取不得迁移状态机，已到期的 OPEN 与其“被恢复的孪生”一样被对账，而不是先滑入 HALF_OPEN 逃过一劫。
- **范围之外：** `persistence.debounceMs` 仍需重启生效（`BreakerStateStore` 在构造时绑定去抖值）；SUSPECT 标记照旧熬过一切开关（规则修订的不变量）。

**后果。**

- （+）影子模式的调参闭环不再需要重启；故障进行中的规则修改不再掐断流量流、不再重置观测。
- （+）控制台 UX 归于一致：所有可编辑段保存即生效。
- （−）规则集不再是“仅启动时确定”的常量：假定“构造时快照”的注释与测试已按清理契约清扫；对账边界（同一进程生命周期内规则 关→开→关 的切换）在每次保存时对账——这是有意为之。

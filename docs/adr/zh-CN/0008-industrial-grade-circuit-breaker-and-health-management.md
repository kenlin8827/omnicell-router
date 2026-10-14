# ADR-0008: 顶级工业级模型熔断、多级容灾与健康管理系统

## 状态
已接受并实现 (Accepted & Implemented) - 2026-09-30
**2026-10-14 修订** — 熔断器状态已落盘持久化（见文末修订小节）。原“纯内存、重启清零”的姿态被取代：冷却时长、退避位置、滑动窗口与手动熔断均跨网关重启存活。

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

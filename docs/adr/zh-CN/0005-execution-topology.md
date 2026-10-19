# ADR-0005: 执行拓扑——纯直连执行、唯一候选咽喉、两级重试、缓存经济性

## 状态

已实现 — 2026-10-15（事实面语料重写）。范围：决策如何变成上游调用；启动池由什么构成；重试/failover 语义；流式；token-saver 压缩；成本真相。健康语义 = ADR-0004；寻址/成员制 = ADR-0003；凭证选择/亲和 = ADR-0002。

## 决策

### 1. 纯直连执行——守护进程彻底退出推理路径

网关自己直发 provider HTTP 端点；请求路径上不存在任何对后台辅助进程的依赖（历史"daemon"被完整移出推理路径；`bootDirect` 之名是留存的证据）。`buildDirectPool` **仅在启动时**运行（`index.ts:124`；不存在池重建 HTTP 端点——provider 定义与凭证是启动作用域，梯队成员是活的，见 ADR-0003）。Mock 模式只在池为空时注入 `mock-lite/plus/pro/ultra`（`registry.ts:115-152`）。

### 2. 启动池的三个真源

`providers/boot-direct.ts`：(a) `opencode.jsonc` 的 provider 节点——**只认现行形状**（唯一 `providers` slot；节点级 `npm/options` 旧形状丢弃并上报；`env:[VAR]` 名单物化为 `{env:X}` 模板）；(b) 启动绑定的 CredentialStore 凭证链（ADR-0006）——`resolveKey/resolveKeyChain`，链头不变量 `chain[0].key === config.apiKey`，内联 key 前插于 store key 之前，裸 key 只驻**进程内**、永不序列化；(c) 目录（wire + 定价）。

失败教义：不可路由的 provider 被**排除并上报**（`db_unreadable | no_credential | no_baseURL | 全模型不可路由`），永不炸启动；OAuth 行列示挂牌、永不进链、永不被路由（`:163-209,323-326`）。线型派发**数据驱动**：npm 包优先级 `model > catalog entry > provider def > recommendation`——协议真身在目录数据里，不在代码表里（`wire.ts:1-11`）；每 provider 基座：openai-compatible / anthropic / responses / google；System One 不建 chat 执行器（决策协议直调，ADR-0008）。

### 3. 唯一的候选咽喉

`executeCandidatePool` 是所有入口模式（auto/显式/combo/升档）的**唯一**执行漏斗——所以在此施加的按 key 模型访问过滤覆盖一切，包括升档尾巴踏入被禁模型（`orchestrator.ts:1316-1331`；`policyDenied` → 诚实 403，`:939-946`）。逐候选次序被固定：selectCredential（健康+亲和+余量，ADR-0002/0004）→ 限流 PEEK → 消耗门 `canExecuteScoped`（请求路径上唯一的探针消耗点）→ 出站扣槽 → `registry.execute` 携所选凭证（未知选择器的抛掷不可达——陈旧绑定在**选择边界**恢复，绝不成 500）→ scoped 熔断记录。末位候选在闸门全禁时被无条件强试（all-unhealthy 保留 legacy 无前缀强试）；全 DISABLED **永不**强试（下架优先于可用性猜测，ADR-0004）。

### 4. 两级重试经济性

- **原地微退避**（同候选再来一次：默认 1 次，200ms + 100ms 抖动）：瞬时网络/5xx 抖动原地重试保住 prompt-cache 位置（10 倍代价的重试好过一次全量重 prefill 的 failover）；按因白名单放行（`retryOnCauses`——`server_internal_error` 刻意默认除外：含糊的 500 可能已执行）；短 RA 429 突发合格；401/402 **永不**原地（无法归属/配额——绕行）。
- **Failover 链走**：auto 用 `retry.failover.maxAttempts` 预算；显式/combo 上限 = 链长（其组合即契约）；`tierCrossPolicy: same_tier_only | allow_escalate`——升档模式**只**给 lite 链附健康 plus 尾巴；严格防降级：高梯队链永不附低梯队尾巴（`:1227-1229,1311-1315`）。
- 结构断言级联（仅 auto + 结构化输出）：lite 冲锋 → **本地静态断言**（零额外 LLM；JSON 语法/required/type/enum）→ 失败则携失败输出 + `[System Assertion Error]` 纠正消息升 `fallback.escalateTier`（plus|pro|ultra）、temperature 压 0.1——显式模型、combo、`router_options.disable_fallback` 全部跳过。降级是诚实的（因果入 `reasonParams`），不是静默兜底。

### 5. 流式 = 只朝下游的重分块

网关对上游**非**流式，向客户端重分块为 SSE（`chat-sse.ts:3-6`）：role → content 4 字/块 → tool_calls 32 字/块 → 终块带真实 `finish_reason` + usage。终块载荷**先编码后 beginSse**（绝不双重终止）。两种传输都实现 `beginSse/writeSseChunk/endSse`；`X-OCR-*` 头在 SSE 腿同型携带。客户端离场逐腿检测、合成 499（nginx 惯例）记录、永不上游发送。MITM 中不匹配 surface 表的流量走裸双向 splice（跳逐头双向剥离；ADR-0008）。

### 6. Token-saver 压缩族——三段，全部 fail-open

路由前 `applyCompression`（`compression/index.ts:36-75`）：① **rtk** 工具输出压缩（git/grep/ls/logs/build 形态；确定性 ⇒ 同内容同字节同缓存键）；② **headroom** sidecar（`POST /v1/compress`，按网关**自家** sessionId 会话粘连 ⇒ 重放前缀字节稳定；fail-open）；③ **caveman** 输出风格注入（幂等 system-message 追加；`lite|full|ultra|wenyan-*` 档；约束：代码/路径/命令/URL/报错逐字保留、安全告警临时恢复全句、保持用户主导语言）。**压缩前指纹原则**闭环：客户端永远重发**未压缩**字节，故会话锚索引压缩前快照（`orchestrator.ts:491-505`；身份见 ADR-0002），而上游压缩前缀靠压缩器确定性 + 会话模式保持字节稳定。

**Sidecar 生命周期——关联而非拥有**（`compression.headroom.autoStart`，默认关闭）：网关启动时探测 `<url>/health` 并**收编**任何已在运行的实例；仅当无人应答时才以**分离进程**启动 `headroom proxy --host 127.0.0.1 --port <从url推导> --mode cache`（仅限 loopback 地址）并轮询就绪（≤20s），全程不阻塞请求面——期间照常 fail-open，仍在启动中的 sidecar 由下一次探测自然收编。被拉起的 pid 记录在 `<home>/headroom.pid`（进程级文件，ADR-0007 约定），网关退出**永不**杀 sidecar：headroom 的会话重放状态正是跨网关受控重启（ADR-0007）保上游前缀字节稳定的那一环，故 sidecar 天然比网关活得久。控制台面：`GET /api/admin/headroom/sidecar` + `/start` + `/stop`。停止不区分启动者：网关记录的 pid 直接终止；手动启动的**本机**实例按端口识别监听 pid（`Get-NetTCPConnection` / `lsof`；仅限 loopback——/health 探测刚刚确认该端口就是 headroom）后同样终止；拒绝保持诚实——远程实例（`not-loopback`）与无法识别的监听者（`pid-unknown`）以机器码如实上报、由控制台本地化，绝不瞎猜。

### 7. 成本真相，拒绝省钱表演

单请求成本 = 未命中×input + 命中×`cache_read` + output（仅当模型有 `pricing.reasoning` 才对 reasoning_tokens 加价）（`request-cost.ts:13-39`）。`cache_read` 是**目录价**（兜底 `input×0.25`）——无硬编码折扣常数。基线/节省额**刻意不计算**（legacy `savedCostUsd` 在重放时被剥除）：反事实基线不是度量。FinOps 梯队/token/延迟聚合是**进程内**的；只有 `totalRequests`+`fallbackCount` 持久（共享 `traces.db` 里的 `finops_totals` 表，WAL、独立句柄、故障隔离先例）。出口 = trace 的 finops 块 + `GET /api/admin/metrics`(+reset)。不存在任何 `X-OCR-FinOps-*` 头。

### 8. 执行路径的观测平面

TraceTracker：环 5000 + 按环境 `traces.db`（WAL）持久化，保留 7 天 / 100 MB，逐小时清扫；记录 = 请求摘要（安全 `clientHeaders` 子集）+ routing（reason/reasonCode/reasonParams 含驱逐归因，ADR-0002）+ execution + finops。管理面：traces（环→库，冷会话可从持久化 trace 重建）、sessions（活行 join）、logs（环尾 ≤ 5000）。Fastify 逐请求访问日志**刻意关闭**（UI 轮询噪音；onError 保 5xx 底）——请求观测是 trace/capture 平面的职责，不是 stdout 的。捕获接缝实名 `observability/http-exchange`（客户腿）+ `observability/upstream-events`（`UpstreamEventContext` 贯穿 `process()`，provider 侧 emit 契约）——不存在其他事件汇抽象。

## 后果

- 单一执行漏斗 ⇒ 安全过滤、熔断记账、限流扣槽各只有一个是非之地；入口模式差异是同一机制上的策略字段。
- 缓存经济性逐层显名：原地重试、确定性压缩、会话粘连 sidecar、字节稳定指纹——成本数字保持为度量，不做营销。
- 降级全程响亮：排除上报、降级带因、空池告警。

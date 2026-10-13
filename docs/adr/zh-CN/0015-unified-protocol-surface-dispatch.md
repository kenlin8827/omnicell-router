# ADR-0015：统一协议接入面派发——双推理传输共用同一层接缝

## Status

Proposed — 2026-10-12。Layer: system。Scope: global。Domain: routing。
本记录修订 ADR-0014 的接入面位置与 MITM 腿范围；其 §4 的 capture 豁免继续有效（见 Decision Outcome）。
**2026-10-13 修订**——为共享 RespStore 增加可选磁盘恢复日志（见文末修订小节）。默认关闭：step 3b 的纯内存姿态仍是出厂默认，本次修订只新增一个配置开关门控的持久化选项。

## Context and Problem Statement

每个推理请求都从两条传输腿之一进入网关：

- 原生 Fastify `/v1/*` 路由（携带 API key 的客户端），以及
- MITM 正向代理（客户端直接拨号上游域名的隧道）。

重构前，每条传输腿各自持有一份完整的逐请求编排：校验、响应头发出、capture 接线、错误信封、模型访问策略。真正共享的只有 orchestrator 核心与纯协议转换器。这份重复已被证实发生漂移：

- X-OCR 头集合三处漂移：chat 路由 15 个、responses 6 个、MITM 腿仅 5 个。
- MITM 腿的 capture 落盘请求行与请求头为空。
- MITM 腿的 capture 完全缺失 response 与 499 事件。
- chat 腿的 `auto-*` 把 `force_tier` 双写（server.ts + orchestrator）。
- 错误信封、SSE 头集合与中断语义逐 handler 各异。

新增一条协议线要审四个手写 handler；每个修复都必须改两遍。

## Decision Drivers

- 逐请求编排必须只有一份实现，所有传输腿共享。
- 漂移必须在类型与结构层面不可能发生，而不是依赖评审纪律。
- 行为保持必须可门禁化：
  - 字节恒等 harness + capture 红/绿测试，
  - 逐 runtime（Bun + Node）钉住事实，不假设行为统一。
- 鉴权姿态的变化必须在类型层显式，绝不静默发生。

## Considered Options

### A. 纯函数 surface + 两条共享 pipeline + 两个传输适配器

**Pros**

- 编排单点归属；两条传输腿调用同一条 pipeline。
- 逐面策略（capture、gate）以字面类型编码。
- 新协议线 = 表里加一行；两条腿自动继承。

**Cons**

- capture finalize 纪律落在两个适配器文件里。
- 接缝设计前置成本高；迁移需要逐步门禁。

### B. 逐 surface 单体 handler 闭包，两腿共用

**Pros**

- 各路由可独立迁移；diff 小且局部。

**Cons**

- 编排逻辑按 surface 重写一遍（x4）。
- 漂移必然卷土重来——这正是本决策要治的病。

### C. MITM 内部回环 fetch Fastify 本机端点

**Pros**

- 只剩一套 HTTP 栈；编排物理上无法重复。

**Cons**

- 网关内部多一次网络跳转，延迟上升。
- 丢失客户端原始拨号的 `Host`——裸名 host-pinning 失效。
- 客户端中断 / 499 语义被内部跳转扭曲。

### D. 传输 profile 参数冻结 MITM 旧的 5 头集合

**Pros**

- 线路零变化；迁移量最小。

**Cons**

- 把漂移制度化进共享代码。否决。

## Decision Outcome

选定方案："A. 纯函数 surface + 两条共享 pipeline + 两个传输适配器"——它是唯一能让已观测漂移在结构上不可能发生、同时让行为保持可被测试门禁的选项。

落地于 `backend/src/surfaces/`：

- `table.ts`——`SURFACES` 注册表（chat / anthropic / responses / systemone）。
  - `server.ts` 循环该表注册全部协议路由。
- `detectSurface()`——MITM 路径识别与路由身份共用同一张后缀表。
  - 两者不可能再对"存在哪些线"各说各话。
- `types.ts`——`TransportContext` 终止发送纪律：每请求恰好一次发送。
  - 一次 `sendJson`，或一次 `beginSse` → `writeSseChunk`* → `endSse`。
- capture finalize 折叠进终止发送本身。
  - 有响应即已 capture——没有可被遗忘的独立步骤。
- `ModelAccessGate`——联合类型：`'key'`（Fastify 逐 key 守卫）| `'exempt'`（MITM）。
  - 策略豁免（POLICY EXEMPTION）由类型强制：既不会被静默丢弃，也不会被误加。
- `chat-pipeline.ts`——所有 chat 形态协议线的冻结顺序：
  - parse → 400 → gate → process → builder 头 → afterResult → encode/send。
- `decision-pipeline.ts`——systemone 走同一传输抽象，
  - 但直连 registry 执行器（`protocols/systemone/decide.ts`）；
  - 结构上无 capture 通路。
- `transport-fastify.ts` / `transport-node-http.ts`——两个适配器。
  - 独占响应写出、X-OCR 头暂存、capture finalize 与中断探测。
- Fastify capture 钩子（`onRequest`/`onResponse`/`onSend`）已从 `server.ts` 删除。
  - 终结处理归适配器所有。

### 对 ADR-0014 的修订（0014 原文不动）

- `POST /v1/systemone` 现同时由 MITM 腿服务。
  - `detectSuffix: '/systemone'` 有意宽于 `routePath`。
  - 与 ADR-0014 §2 的原生上游 URL 形态一致。
- ADR-0014 §4 的 capture 豁免继续有效——且升级为结构强制：
  - `DecisionSurface` 类型上的字面量 `capture: false`；
  - decision pipeline 零 `captureProcessContext()` 调用；
  - 线路级不变量测试：`backend/tests/forward-proxy-systemone.test.ts`
    （"systemone capture exemption"）——capture 开启、两腿各打一遍 → 零条 client 事件。
  - ADR-0016 随后取代了该豁免支，并于同日重写为最终树：`capture:` 更名为
    `requestCapture:`——本面 capture 现由
    `requestCapture.enabled && requestCapture.systemone.enabled` 解析
    （面总闸；中间命名 `clientEnabled` 从未发布），
    上述旧键名（含 capture.systemoneEnabled，默认值亦已改为 true）已退役（见 ADR-0016）。
- 路由已迁移：`backend/src/routes/systemone.ts` 不复存在。
  - surface 落位于 `backend/src/surfaces/systemone.ts`。

### Consequences

**Positive**

- 漂移在结构上不可能：逐面只有一份编排、一个头 builder、一条 capture 通路。
- 新协议线 = `SURFACES` 加一行；两条传输腿零成本继承。
- MITM 腿获得完整 X-OCR 诊断头，并与原生腿 capture 对等。
- 已批准的头增量，如实披露为 Δ-1/2/3（响应侧 append-only）：
  - chat SSE 响应新增三个条件性 Thinking 头。
  - responses 路由两种发送形态由 6 头 → 15 头。
  - MITM 腿由 5 头 → 完整 builder 集合。
- 已批准的行为收敛 C-1..C-6：
  - MITM 执行错误按面映射（非法 `#variant` 现在回 404 而非 500）。
  - MITM `/v1/responses` 经共享 RespStore 获得 `previous_response_id`。
  - `stream === true` 全局严格；非布尔 truthy 走 JSON 路径。
  - capture 请求体不再在 chat Fastify 腿预注入 `force_tier`。
  - MITM SSE 逐事件写出；全流总字节恒等。
- 折叠进接缝的安全与可观测副作用：
  - host-pinning 仅读取 MITM 腿的 `clientRequest` 头。
  - 原生腿上伪造 `Host` 不再能左右 provider 选择。
  - `traceparent` 两腿同样生效（传输头喂给 orchestrator）。

**Negative / Risks**

- capture finalize 语义现分布于两个适配器文件。
  - 冻结契约文档记录其纪律；不变量测试看守。
- 共享 RespStore 跨腿可见（一腿创建的会话可在另一腿续用）。
  - 缓解：有界 FIFO（2 万节点 + 老化清扫）；96 位不可猜测响应 id。
  - 跨腿触达是能力（capability），不是暴露。
  - 两腿共用同一单例，因此可选恢复日志（文末修订）同样会把 MITM 腿的
    会话链落盘——这正是它默认关闭、开启即须是自觉的磁盘隐私决策的又一理由，
    内容类别与 `requestCapture` 相同。
- 宽后缀 `/systemone` 会拦截任何以 `/systemone` 结尾的本地 POST。
  - 在代理代码已文档化的 loopback 信任模型下接受。
  - 失败一律返回响亮的网关信封，绝不静默。
- Bun 在读完请求体后无法观测客户端中断。
  - 499 合成依赖 Node 下的 req `'aborted'` 事件与 socket-destroyed 探测。
  - `backend/tests/capture-abort.test.ts` 逐 runtime 钉住真实行为。
- capture 翻转（step 3c）把风险集中到一次变更。
  - 缓解：红/绿 capture 与中断测试先对【旧代码】写好，再翻转适配器。

---

## 修订（2026-10-13）：可选的 RespStore 恢复日志

**本修订回答的问题。** 纯内存存储让每次网关重启都失去全部记忆：进行中的
`previous_response_id` 续接会撞上 fail-visible 400，不会全量重发的客户端就此
丢会话。对跨越配置修改与升级重启的长 agent 会话而言，这条降级路径不够好。

**决策。** 存储可选地把节点树镜像为仅追加 JSONL 恢复日志
（`responses.persist`，**默认 false**）。语义：

- L1（内存 Map）仍是唯一权威；日志只是重启存续优化。追加在 `afterResult`
  排队尽力而为地执行；磁盘失败最多警告一次，绝不失败或拖慢请求路径。
- 启动时在第一个 id 被解析之前同步重放：TTL 过滤（同一 24 小时），坏行/撕裂
  行跳过并警告，按 `createdAt` 升序插入（FIFO 驱逐以插入序为准——乱序重放会
  错杀活跃会话），批量装载后只做【一次】清扫（2 万上限下逐条清扫是 O(n²)）。
- 压实（compaction）是从 L1 活状态出发的原子重写（temp + rename）：TTL 清理、
  单节点上限（默认 256 KiB，超限轮次只留内存）、总字节预算（默认 64 MiB，
  从最旧裁剪）。节奏：启动时 + 每 1000 次追加。`clear()` 会清空日志，
  已删会话绝不复活。
- 文件位于本环境自己的数据目录（ADR-0017 书套隔离——跨环境日志会把错书套的
  会话链重放进存储），权限 0600。

**默认关闭的姿态。** 日志携带对话原文——与 `requestCapture`（ADR-0016）同一
内容类别，故仓库的磁盘隐私 opt-in 姿态逐字适用。关闭时 step 3b 的内存行为
逐字节不变。开关会自我提示：persist=off 下第一个携带 `previous_response_id`
的请求触发每进程一次的警告，点名 `responses.persist`；persist=on 下启动日志
报告重放计数。

**天花板（有意为之，非疏漏）。**

- SessionManager（棘轮 tier、钉住模型、账号亲和）仍是纯内存。重启后续接
  功能完好但路由冷启动。按 ADR-0019 D7，有状态线程换账号是硬性功能断裂——
  恢复日志并不能在重启时阻止这一点，它只消除消息链丢失。持久化整个会话层
  经考虑后缓做：冷路由重计费的代价，尚无实测证据能压过其一致性成本。
  若证据出现，升级路径是每会话 `{account, tier, model}` 三元组 sidecar，
  而非全量会话持久化。
- 崩溃发生在响应与落盘之间时，最后一轮仍未刷盘，照旧落入 400 路径。
  fail-visible 契约及其冻结文案不变。

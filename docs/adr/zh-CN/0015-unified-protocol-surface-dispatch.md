# ADR-0015：统一协议接入面派发——双推理传输共用同一层接缝

## Status

Proposed — 2026-10-12。Layer: system。Scope: global。Domain: routing。
本记录修订 ADR-0014 的接入面位置与 MITM 腿范围；其 §4 的 capture 豁免继续有效（见 Decision Outcome）。

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
- 宽后缀 `/systemone` 会拦截任何以 `/systemone` 结尾的本地 POST。
  - 在代理代码已文档化的 loopback 信任模型下接受。
  - 失败一律返回响亮的网关信封，绝不静默。
- Bun 在读完请求体后无法观测客户端中断。
  - 499 合成依赖 Node 下的 req `'aborted'` 事件与 socket-destroyed 探测。
  - `backend/tests/capture-abort.test.ts` 逐 runtime 钉住真实行为。
- capture 翻转（step 3c）把风险集中到一次变更。
  - 缓解：红/绿 capture 与中断测试先对【旧代码】写好，再翻转适配器。

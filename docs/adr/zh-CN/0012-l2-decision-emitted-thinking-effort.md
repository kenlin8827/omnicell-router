# ADR-0012：决策层产出的思考级别（决策完整性）

## 状态

已实现 —— 2026-10-21。范围：L2 决策层的决策输出从 `{tier}` 扩展为 `{tier, effort}`，trace/结果契约新增级别来源（`effortSource`）。路由级联 = ADR-0001；级别词汇与诚实规则 = ADR-0003；经验表 = ADR-0011；会话棘轮 = ADR-0002。

## 背景

auto 路由决策层此前只决定提示词「去哪」（tier），从不决定所供模型「想多深」（effort）——决策只做了一半：一个被判为足以进入 pro 梯队的难题，仍可能以厂商默认（常常完全不思考）运行，路由决策的价值被悄悄浪费。与此同时，级别词汇（ADR-0003）恰好有四个获取途径，而这四个——客户端字段、经验表命中、重试升档、模型 `defaultEffort`——都是在编排器读取**之前**通过改写 `request.reasoning_effort` 注入的。trace 的 `requestedEffort` 因此无法区分「客户端所求」与「网关决定」：一个诚实性缺口（网关的决定伪装成了客户端的要求）。

评审中浮现的设计约束：

1. **成本**——决策层决定的级别会花掉客户端从未要求花费的思考 token；该功能必须可选开启（opt-in）。
2. **缓存卫生**——决策缓存键（`provider::model::state`）绝不能在运营者关闭功能后复活旧的决策层级别。
3. **反馈回路**——决策层级别经现有 `l2_confident` 写回流入经验表；修订必须双向，否则经验表退化为单向成本棘轮。
4. **降档语义**——`reasoningDegraded` 比较的是实供秩与**有效所求**秩；当所求由网关作出时，trace 也必须如实说明。

## 决策

### 1. 决策层在一次调用中回答两个问题

System One 的 `questions` 是 map（`protocols/systemone/types.ts`）：决策层现在于同一次决策调用中询问 `tier`（现有）与 `effort`（覆盖完整 6 级 `EFFORT_LADDER` 的 `choice`，含 `none`——「不思考」是合法判断）——零额外上游延迟，原生与转换两条路径本就会遍历整个 map。effort 问题**仅在客户端省略 `reasoning_effort` 时**提出：客户端显式值永不被复核，省略问题也保持了答案空间最小。effort 解析失败绝不拖垮一个好的 tier 答案（部分成功：保留 tier，丢弃 effort）。

### 2. `effortSource`——所求的来源是一等事实

`EffortSource = 'client' | 'l2-decision' | 'entry' | 'escalation' | 'default'`。编排器在任何注入发生前快照客户端的线上值，并把此后的每次改写归因到其发生点。该值随 `ExecutionResult.effortSource`（呈现为 `X-OCR-Thinking-Source` 头）、`ExecutionTrace.execution.effortSource` 与路由 `reasonParams` 传播。`requestedEffort` 保持其既定语义——级别机制实际对照服务的**有效所求**——而 `effortSource` 说明这是**谁的**所求。`reasoningDegraded` = 实供秩 < 有效所求秩，与来源无关：决策层决定的级别被能力钳制时与客户端所求同样记为降档（ADR-0003 诚实规则同样约束网关自己的决定）。

### 3. 配置开关——`classifier.layer2.effortDecision`（默认 FALSE）

决策层决定的级别会花掉无人显式订购的思考 token，因此该功能默认关闭、显式开启。决策缓存命名空间随开关分裂（`systemone` 与 `systemone+effort`）：切换开关绝不可能从另一模式下记录的缓存条目里复活陈旧的 effort 答案。

### 4. effort 逐轮浮动——永不进棘轮

会话棘轮钉住的是 tier（模型身份一致性，ADR-0002）；effort 保持逐轮判断，无单调下限。一个被钉在 pro 的会话收到琐碎追问时，由被钉住的 pro 模型以低级别服务——**谁回答**保持一致，**想多深**逐轮自由。决策层 effort 的置信度仅作 trace 元数据；它永不喂给棘轮、重试阶梯或任何阈值。

### 5. 经验表双向学习 effort

现有 `l2_confident` 写回本就会记录实际服务的 `actualEffort`（ADR-0011 §2）——决策层级别接入后，条目经由**同一条**路径获得 effort；白名单不新增写入者。同源覆盖使条目向下修订与向上同样容易（新的高置信判断替换陈旧判断），因此经验表不会因决策层误判而退化为单向成本棘轮。`correction` 行保持 ADR-0011 冻结的粘性（已被接受的失败证据优先于预测；人工编辑是逃生舱），重试升档语义不变——它仍是会话内的失败阶梯，其 effort 步进复用同一套钳制机制。

## 后果

- `auto` + `effortDecision: true` = 网关对每个提示词决定「去哪、想多深」；控制台「思考」列与 `X-OCR-Thinking-Source` 头会把每个实供级别归因到其作者。
- 默认关闭 = 运营者不动作则行为与成本零变化；客户端显式请求在任何模式下逐字节一致。
- 优雅降级：决策层省略或答错 effort 时得到 `effort: undefined`——本轮行为与本 ADR 之前完全一致。
- 测试：`layer2-systemone`（双问题契约、解析容错、缓存命名空间分裂）、`reasoning-effort-e2e`（决策层注入、客户端优先、trace 来源归因）、`trace-persistence`（来源字段磁盘往返存活）、`ocr-headers`（新响应头）。

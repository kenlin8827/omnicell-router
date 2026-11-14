# ADR-0024：观测作用域词汇——五层、不许有孪生词

日期：2026-11-14
状态：**已实现**——下文的层级、写时 turn 身份、`exchanges[]` 读平面与数据切换
全部已在代码中落地，并由测试钉住。本篇是**单一目标态契约**：不含过渡条款、
不含保留的历史拼写、不含派生回退。
约束范围：`docs/design/glossary.md`、`backend/src/observability/request-identity.ts`、
`backend/src/observability/http-exchange.ts`、`backend/src/capture/recorder.ts`、
`backend/src/capture/turn-boundary.ts`、`backend/src/session/session-row.ts`、
`backend/src/session/session-manager.ts`、`backend/src/trace/tracker.ts`、
`frontend/src/i18n/locales/*.ts`、`frontend/src/pages/SessionsPage.tsx`、
`frontend/src/pages/CapturesPage.tsx`。

> **改动纪律。** 每一次改名都与它自己的代码改动在**同一个 commit** 落地，
> 注释、测试标题、ADR 散文与中英两份语言树一起扫净（cleanup contract）。
> 在上述任何表面留下陈旧用词的改名是未完成的改名。

## 背景

同一批词曾指向不同平面的不同范围，歧义已经产生了防御性注释与互相矛盾的计数：

- `turn` 曾有三种读法：捕获平面的 *inference turn*（按一个 `requestId` 拼起的
  2–4 个事件）、控制台 *Turns* 列（用户提示数）、会话实体的 `turnCount`（每个
  request +1）。ADR-0023（同日）又把 `turn` 用作**准入单位**。
- `exchange` 曾有三种粒度：一对请求/响应、单条事件、整个捕获特性。
- turn 边界本身是读平面启发式（`userPromptSummary` 是否为空 + 消息数）：
  它随读取窗口变化、无法 join、无法审计。没人能拿来作键的层不是层。
- ADR-0021 原阶梯把调用方 trace 值画在网关请求之上，把关联读成了包含。

本篇把这一切收口：层级固定、turn 边界物化为写时属性、读平面只读取而不再推导、
所有孪生名在同一次改动中改名完毕。

## 决策

### 1. 层级

| 层 | 定义 | 身份 | 写入时机 | 业界对应物 |
| :--- | :--- | :--- | :--- | :--- |
| `session` | 最大写时容器：网关自持的会话实体 | `sessionId` | 写时 | `gen_ai.conversation.id`、`anthropic.session.id` |
| `turn` | **一次用户提示**及它驱动的全部 request；工具循环续接**不**新开 turn | 每个 `sessionId` 内的 `turnIndex`——是**属性**，不是 id | 写时（准入闸口） | conversational turn（「one turn, many requests」那一支） |
| `request` | **一次入站客户端请求**及它引发的全部 HTTP 腿 | `requestId` | 写时 | server span + 其下的 client span |
| `exchange` | **一条腿上的一次 HTTP 请求及其响应** | `exchangeId` + `attempt` | 写时 | 一次 HTTP message exchange（RFC 9110） |
| `event` | 一次 exchange 的**单个阶段记录**（`request` 或 `response`） | `id`（`evt_…`）、`phase` | 写时 | 阶段 / span 事件 |

简写：`session ⊃ turn ⊃ request ⊃ exchange ⊃ event`。

层级附带两条诚实规则。第一，`session`、`request`、`exchange`、`event` 是各自带 id 的
**独立写时实体**；`turn` 是写时**属性**（`turnIndex`），绝不是实体——不存在 `turnId`、
没有 turn 表、没有 turn 归档记录。第二，`exchange` 是一对，绝不是容器：
`client ↔ gateway` 与 `gateway ↔ upstream` 是两个不同的 HTTP 请求，因此是两个不同的
exchange。一个 request 拥有 2–N 个 exchange：客户端一对、上游 failover 的每一跳、
以及 Layer-2 决策对（`purpose: 'l2-decision'`，按上游腿路由）。

### 2. id 列即权威

`exchangeId` 把一条腿上的请求事件与它的响应事件精确配对。`requestId` 连接一次入站
调用的**全部**腿：客户端对、上游对、每个 failover 尝试与 Layer-2 决策对。这与
OpenTelemetry HTTP 重试约定同形：一个入站 SERVER span 拥有每次发送尝试的 CLIENT
span。`requestId` 不是 trace：调用方的 `traceparent` 可能覆盖整段对话，因此 trace 是
由多个请求组成的 DAG，绝不是一个请求（ADR-0021）。

### 3. 写入什么——turn 身份

每个可服务的入站请求在既有 id 之外记录三个字段，并盖章在该请求的**每条**捕获事件与
每条 trace 记录上：

| 字段 | 含义 |
| :--- | :--- |
| `turnIndex` | 1 起、在单个 `sessionId` 内单调递增、不可变。键是 `(sessionId, turnIndex)`；不存在 `turnId` |
| `isPromptStart` | 该请求是否开启了 turn |
| `turnDecision` | `new_prompt` \| `continuation` \| `ambiguous_compaction` \| `no_prompt`——边界判定的溯源，供审计 |

无用户提示的请求（独立决策面、健康探针、重放）记录 `turnIndex: null`；null 是一等值，
不是缺失字段。

### 4. 边界规则（结构化，`capture/turn-boundary.ts`）

一个请求当且仅当其消息列表携带一条**新的**用户消息、且该消息**不是**工具结果续接时，
才开启新 turn：

- Anthropic：内容只有 `tool_result` 块的 `user` 消息是续接。
- OpenAI：末尾 `role: "tool"` 消息、或只携带工具结果的 user 消息是续接。

判定是**结构化**的。文本是否存在仅用于显示，绝不定边界：只有图片或附件的用户提示
**就是**新 turn。

- 历史变短（客户端压缩/截断）时下标比较失效：照样分配并记录
  `ambiguous_compaction`。存疑时仍分配保证键唯一；标签让存疑可见。
- 超时后重发同一提示的客户端请求是**新** turn。网关不猜意图；幂等是客户端的选项，
  不是启发式。
- 完全没有用户消息：`no_prompt`、`turnIndex: null`。
- failover 各跳、内部重试、重入与 Layer-2 决策腿是**同一个** request，永不分配。

### 5. 唯一写入者，仅观测

- 分配只发生在一个点：入站准入闸口，在最终会话绑定**之后**、首条事件发射**之前**
  （`orchestrator.ts` → `SessionManager.allocateTurnIndex()`）。执行路径、failover
  循环与捕获写入方都不得递增它。
- 计数器存储沿用 `bypassTurns` 先例：环境级会话快照（快照 `v: 3`）内的
  `turnCounters: sessionId → 高水位` Map，FIFO 封顶、fail-open。trace 是审计线索而非
  计数器：它可能被修剪，所以对留存 trace 取 `max+1` 只是快照缺失/损坏时的**种子**，
  绝不是运行时来源。
- `turnIndex` 仅用于**观测**。不得作为限流预算、计费、配额或任何不可逆决策的键。
  ADR-0023 的预算按 `request` 计；一个判错的边界最多错一个控制台计数——绝不错预算、
  绝不错账。

分配对每个请求上下文幂等。重入、failover 跳或重试派发带着同一份请求状态到达同一
闸口，绝不分配两次。残余风险：快照刷盘有去抖，硬崩溃可能丢最后几次分配；只要快照或
trace 二者存其一，`max+1` 种子就能恢复高水位；要发生键碰撞需要同一个会话的**两者**
同时丢失。

### 6. 读平面

- 永不重编号：turn 绝不在读取时重算。每条事件已携带
  `turnIndex` / `isPromptStart` / `turnDecision`，读取方只是复制。读路径中没有任何
  `derived` 回退，也没有任何提示词文本启发式。
- 六个固定摘要槽位被 `CaptureRequestSummary` 上的 `exchanges[]` 取代，按
  `(leg, attempt)` 分桶。failover 的每一跳与决策对都保持可见；控制台抽屉按
  `<exchangeId>:<phase>` 为每个 exchange 阶段渲染一个标签页，`attempt > 1` 带标号。
- `attempt` 在 `(requestId, leg)` 内 1 起编号；客户端 exchange 恒为 1，上游 failover
  每跳/原地重试各 +1。写时盖章，绝不在读取时推断。
- 时序契约：一条事件的 `ts` 是该阶段发生的时刻；流式响应事件另带 `firstByteTs`
  （首个 body 分片）。于是 `latencyMs = response.ts - request.ts`、
  `ttftMs = firstByteTs - request.ts`、`genMs = response.ts - firstByteTs`——每个量
  只有一个含义，无需猜测。捕获平面与 trace 平面使用同一套 TTFT / 解码 TPS 词汇
  （ADR-0005 §8）。
- `promptSummary` **仅用于显示**。它在写时盖章于开启 turn 的 client-request 事件
  （发射方自带的文本优先，否则 recorder 摊平最后一个 user 槽），让 `bodies=none`
  的读取也能渲染提示；它绝不定边界，续接请求永远没有。
- 控制台 wire 上的 `turnCount` 数 `isPromptStart` 请求（`promptTurnsOf()`）；会话
  实体把每个 request 计为 `requestCount`。捕获读取中的 `totalTurns` 是
  `count(distinct turnIndex)`，既不是序号也不是请求数。
- 归档索引（`/summary`）直接扫描写时 `turnIndex` 元数据；轮次选择器列出按
  `turnIndex` 作键的 `CaptureTurnIndexEntry`。`requestNumber` 是读取窗口内 1 起的
  **请求**序号——分页器的单位；turn 归属绝不折叠进它。

### 7. 已知例外——是范围，不是严格包含

- `conversationKey`（内容哈希，ADR-0002 §1 及其后果节）可以把一段对话跨易变
  `sessionId` 重组；归档读平面存在比 session **更宽**的容器。`session` 是最大的
  **写时**实体，不是最大的可能分组。它是索引键，不是第六层。
- 独立决策面自铸 `requestId` 且无用户提示，因此不属于任何 turn
  （`turnIndex: null`）。
- 网关**没有**第三条腿。`direction` 恰为 `client | upstream`，且命名的是**腿**而非
  向量：响应事件与其请求事件携带相同的 `direction`。客户端收到的响应是
  `clientResponse`——按腿命名，与 `clientRequest` 同一坐标系；旧的
  `gatewayResponse` 拼写按发送者命名，已退役。`normalizedRequest` 是无 socket、
  无状态码、无时延的**内存报文形状**；`clientRequest → normalizedRequest →
  upstreamRequest` 是报文形状链，不是一组事件。

### 8. 数据切换（单向，无运行时兼容）

- 捕获归档：写入仍走 `capture/` 根，`CAPTURE_SCHEMA = 2`（每行都带
  `schema: 2` 与 turn 身份）——版本挂在数据上，不挂在根名上。schema 1 是
  **无标记基线**，由 `V1ToV2Migrate`（`migrate/steps/v1-to-v2.ts`）**原地**
  向前带，覆盖**两种历史形态**：已带网关 id 的行原样采用；没有网关 id 的旧行
  （只有 `traceId` + `spanId`）的请求边界从事件序列**读出来**——`traceId` 是
  连接级关联，`spanId` 才是 exchange 身份，一个 client request 开启请求、它引发的
  upstream span 归属该请求、配对的 client response 收口，requestId 由
  `(sessionId, spanId, ts)` 确定性铸造（重跑铸出同一 id）。两种形态的 turn 身份
  都来自准入闸口所用的同一套结构化规则（`classifyTurnBoundary`），对归档已记录的
  原 body 按文件顺序重放、按会话串接上一请求的消息数；`attempt` 为同一
  `(requestId, leg)` 内每个不同 exchange 的序号；退役词汇被丢弃。引擎对每条重写行
  盖 `migratedFrom: 1`，因此迁移期重建的 turn 绝不会被误认为准入闸口印章；而始终
  没到达目标 schema 的行仍被归档行校验器**拒绝**，绝不静默归一化。无法干净收口的
  旧 span 序列由该 step 自己**修进**目标 schema（落在任何 client 请求之外的 upstream
  交换成为无提示的孤儿请求、取 `NO_TURN`；前一个未收口又开来 client 请求就直接算
  下一个请求；无主的响应挂到其 span 更早开启的请求上或自成一条；文件在请求中途结束
  则保留该请求）——所以没有东西需要搁置，也没有东西会被搁置：没有封存、没有
  `capture-archive/`、没有暂存地。升级必须让它已经握有的历史保持**可读**，而活根是
  唯一副本。不可解析 JSON 的行原字节保留、在趟汇总里计为 `unreadable`，绝不因为一行
  腐烂而丢掉同文件的千行好数据。此后每次 schema 升级（3 及以后）只是
  同一链条里多一个 `V{N}ToV{N+1}` 类（`capture/migrate/`，每类一文件于
  `migrate/steps/`，按 `(from, to)` 解析、每文件现建实例、`begin()` 每跳按该跳将重写的形状规划，boot 趟处理每个文件、
  每小时 sweep 只碰静置的文件，全文件原子重写且在换上前再校验原文件）
  ——不再新开根，也没有读取侧分支。
- `traces.db`：`DB_VERSION = 3` 执行**一次性**迁移——存储 blob 中的 `turnNumber`
  改名为 `requestNumber`，并按旧 `request.userPromptSummary` 置空约定回放一次，
  给每行盖上结构化 turn 身份。运行时读取方严格单形状：热路径上没有双字段回退。
- 会话快照：增量 `v: 3`（`turnCounters`）；`v: 1` / `v: 2` 载荷照常加载、不带计数器，
  并从留存 trace 重新播种。

### 9. 禁用拼写

| 禁用 | 原因 |
| :--- | :--- |
| `tun`、`tune` 作作用域单位 | `tun` 是笔误；`tune/tuning/tunable` 已表示配置调整，`tunnel` 归 ADR-0018/0020 所有 |
| 裸 `turn` 指 HTTP 交互或一次入站请求 | 用 `request`；一个 `requestId` = 一个请求 |
| `turn` 指准入/预算单位 | ADR-0023 的 `admitRequest()`、预算与重入计数按 REQUEST |
| `exchange` 指整个推理调用或配对容器 | exchange 是一条腿上的一次请求及其响应 |
| `request` 指出站 HTTP 报文 | 出站报文是 exchange；`request` 是入站客户端请求及它引发的一切 |
| `gatewayRequest` | 网关不会给自己发请求；`plugins/gateways.ts` 的 `GatewayRequestInfo` 是插件匹配参数，不是请求对象 |
| `gatewayResponse` | 已退役，改用 `clientResponse`：响应按腿命名，与 `clientRequest` 一致 |
| 领域模型中的 `traceId` / `spanId` | ADR-0021 禁用；`clientRequestId` 仅作关联 |
| `direction: 'gateway'` | 会捏造没有网络腿的 HTTP 事件 |
| 捕获平面之外的裸 `event` | 三本观测账本（失败/限流/配额）存 `ledger events`；无限定词的 `event` 只指捕获阶段记录 |
| 新增 `round*` 读平面符号 | `roundNumber` / `totalRounds` / `CaptureRoundIndexEntry` 已**删除**；turn 由写时 `turnIndex` 作键。不得重新引入窗口内重编号 |

## 后果

- 新代码、注释、测试标题、ADR 散文与控制台文案遵循层级。
  `docs/design/glossary.md` 是查表入口；本 ADR 是决策。
- 随本契约同批落地的改名（全部同 commit 扫净）：`HttpExchangeEvent →
  CaptureEvent`；`gatewayResponse → clientResponse`（发射器、传输层、wire 字段、
  八语言 `tabGatewayResponse → tabClientResponse`）；`CaptureTurnSummary →
  CaptureRequestSummary`；`groupEventsIntoTurns → groupEventsIntoRequests`；
  `numberTurns → numberRequests`；`/turn?id= → /request?id=`；实体
  `turnCount → requestCount`（控制台 wire 的 `turnCount` 保留 = 用户提示数）；
  `ExecutionTrace.turnNumber → requestNumber`（wire，前后端同 commit）；
  `admitTurn → admitRequest`（ADR-0023）。
- 八语言 `thTurns` / `thTurnsTip` 键与 `promptTurnsOf()` 在本契约下是**正确的**——
  控制台 *Turns* 列按写时 `isPromptStart` 标志数用户提示。
- 契约前的 `per-turn` 散文已逐点审计——绝不批量替换。规则看**句子**的单位而非单词：
  单位是一次入站请求的地方改为 `per-request`（ADR-0005 每次调用的 TTFT、ADR-0009
  每次调用的归因、ADR-0012 每次调用的 effort 判定、ADR-0002 路由）；只有单位确实是
  用户提示的地方保留 `per-turn`（ADR-0011 的指令覆盖层按请求**应用**、但按提示
  **定域**）。

## 参考

- ADR-0008 §5（捕获模型、schema-2 归档）
- ADR-0021（网关自持 id、无 `traceId` / `spanId`、同请求各腿共享 `requestId`）
- ADR-0023（`admitRequest()` 与预算按请求而非按提示）
- ADR-0002 §1 / 后果节（`conversationKey`）；ADR-0018 / ADR-0020（`tunnel`）
- `docs/design/glossary.md`（查表；中文镜像在 `docs/design/zh-CN/`）
- RFC 9110 §3.4/§3.9（message exchange）；OpenTelemetry HTTP 语义约定
  （每次尝试一个 span）；OpenTelemetry GenAI 约定（`gen_ai.conversation.id`）

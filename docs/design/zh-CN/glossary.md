# 观测作用域术语表

状态：生效中。决策记录：[ADR-0024](../../adr/zh-CN/0024-observation-scope-vocabulary.md)。
英文正本：[../glossary.md](../glossary.md)（结构权威）。

本文件是会话、trace、捕获与控制台所用词汇的查表入口。ADR-0024 承载决策，本文件
承载答案。新符号、注释、测试标题或控制台标签需要表示作用域时，取下表第一行匹配的词，
不要自造同义词。

## 1. 层级速查

| 层 | 含义 | 身份 | 写入时机 | 业界对应物 |
| :--- | :--- | :--- | :--- | :--- |
| `session` | 最大的写时容器，网关会话实体 | `sessionId` | 写时 | `gen_ai.conversation.id` |
| `turn` | 一次用户提示及它驱动的全部 request | 每 session 一个 `turnIndex`（写时**属性**，无 id） | 写时（准入闸口） | conversational turn |
| `request` | 一次入站客户端请求及它引发的全部 HTTP 腿 | `requestId` | 写时 | server span + 其下的 client span |
| `exchange` | 一条腿上的一次 HTTP 请求及其响应 | `exchangeId` + `attempt` | 写时 | HTTP message exchange（RFC 9110 §3.4） |
| `event` | 一次 exchange 的单个阶段记录 | `id`（`evt_…`）+ `phase` | 写时 | 阶段 / span 事件 |

`session ⊃ turn ⊃ request ⊃ exchange ⊃ event`。

两条规则优先于对词义的任何直觉：

- `session`、`request`、`exchange`、`event` 是各自带 id 的写时**实体**。
  `turn` 是写时**属性**（每 session 的 `turnIndex`，盖章在该请求的每条捕获事件与
  每条 trace 记录上），绝不是实体：**不存在 `turnId`。** 边界在准入闸口以结构化
  方式判定（`capture/turn-boundary.ts`），读取方只复制、绝不重推导。
- `exchange` 是**一对**。`client ↔ gateway` 与 `gateway ↔ upstream` 是两个不同的
  HTTP 请求，因此是两个 exchange。一个 request 拥有 2–N 个。

## 2. 分层条目

### session

- 定义：网关自持的会话实体（棘轮、置顶、trace 索引）。`sessionId` 由网关铸造。
- 父级：写时实体中没有。`conversationKey` 可在归档读平面上跨易变 sessionId 重组
  （见第 6 节）。
- 子级：turn（写时 `turnIndex` 属性）、request（写时记录）。
- 代码：`session/session-manager.ts`（快照 `v: 3` 携带 `turnCounters` 高水位）、
  `session/session-row.ts`、`X-OCR-Session-ID`。
- 不得称为：trace、调用方借来的 conversation id。

### turn

- 定义：**一次用户提示**及它驱动的全部 request。工具结果续接重发历史，但**不**新开
  turn。
- 身份：`turnIndex`，1 起、单个 `sessionId` 内单调递增、不可变，在准入闸口于最终
  会话绑定后一次性分配；键是 `(sessionId, turnIndex)`，没有 turn id。
  `turnIndex: null` 是一等值（无用户提示）。
- 溯源：`isPromptStart`（开启者标志）与 `turnDecision`（`new_prompt` /
  `continuation` / `ambiguous_compaction` / `no_prompt`）。
- 子级：request。
- 代码：`capture/turn-boundary.ts`（结构化边界）、`session-manager.ts
  allocateTurnIndex()`（唯一写入者）、八语言 `thTurns` / `thTurnsTip`、
  `session-row.ts promptTurnsOf()`（数 `isPromptStart` 的 trace）、
  `CaptureTurnIndexEntry` / `totalTurns`（全归档索引，按 `turnIndex` 作键）。
- 不得称为：一次 HTTP 往返、一次入站请求、一个 exchange。
- 注意：LLM 世界另有「agent 循环一趟」的 turn 读法。本项目**不**采用。新代码里的
  裸 `turn` 必须指本层。

### request

- 定义：**一次入站客户端请求**及它引发的全部 HTTP 腿（客户端对、上游对、failover
  各跳、Layer-2 决策对）。
- 身份：`requestId`——网关铸造、唯一、不可变，是 trace 记录主键、控制台行身份、
  捕获 join 键、`X-OCR-Request-ID`。
- 子级：exchange。
- 代码：`observability/request-identity.ts mintRequestId()`、
  `recorder.ts groupEventsIntoRequests()`（按 `requestId` 分组）、
  `CaptureRequestSummary`（读平面投影，带 `exchanges[]`）、
  `trace/tracker.ts`（`requestNumber`、`turnIndex`、`isPromptStart`、
  `turnDecision`）。
- 不得称为：turn、exchange、trace、出站 HTTP 报文（出站报文是 `exchange`）。

### exchange

- 定义：**一条腿上的一次 HTTP 请求及其响应**。RFC 9110 允许信息性响应加一个最终
  响应，但永远围绕**一次**请求。
- 身份：`exchangeId`——配对请求事件与响应事件；`attempt` 是 `(requestId, leg)` 内
  1 起的序号（客户端恒为 1，上游 failover 每跳 +1）。时序：`latencyMs` 是两条事件
  的 `ts` 差；流式响应另带 `firstByteTs`，让 `ttftMs` 与 `genMs` 各只有一个含义。
- 子级：两条事件（`phase: 'request'` 与 `phase: 'response'`）。
- 代码：`observability/http-exchange.ts emitClientRequest` / `emitClientResponse`
  （客户端腿）、`emitUpstreamRequest` / `emitUpstreamResponse`（上游腿）、
  `mintExchangeId()`。
- 基数：每 request 2–N 个——客户端、上游、failover 每跳、Layer-2 决策调用。
  每一跳都保持可见：读平面按 `(leg, attempt)` 分桶 `exchanges[]`，绝无
  last-write-wins。
- 不得称为：整个推理调用、配对容器、单条事件。

### event

- 定义：一行 JSONL；`eventType: 'http-exchange'`、`schema: 2`、一个 `direction`、
  一个 `phase`、一个 `exchangeId`、一个 `requestId`，外加写时 turn 身份与
  `attempt`。
- 代码：`recorder.ts recordEvent()`（盖章 `schema`、`attempt`、`NO_TURN` 默认）/
  `readEvents()`、`parseArchivedEvent()`（严格 schema-2 校验——缺 turn 身份的行被
  拒绝，而非归一化）。
- 不得称为：exchange。两条事件才构成一个 exchange。裸 `event` 只指**捕获**阶段
  记录；失败 / 限流 / 配额三本账本存 `ledger events`，不是 `events`。

## 3. id 词汇（ADR-0021 为权威）

| id | 归属 | 范围 | 可否重复 |
| :--- | :--- | :--- | :--- |
| `sessionId` | 网关 | 会话实体 | 否 |
| `requestId` | 网关 | 一个 request 及其全部腿 | 否 |
| `exchangeId` | 网关 | 一对请求/响应 | 否 |
| `turnIndex` | 网关 | 一个 session 内的一个 turn | session 内不可 |
| `clientRequestId` | 调用方 | 仅关联，**绝不作键** | 可，跨行跨 turn |
| `upstreamRequestId` | provider | provider 自己的调用 id | 可 |
| `conversationKey` | 派生 | 内容哈希，归档读平面 | 可 |

领域模型中不存在 `traceId` 与 `spanId`。调用方 `traceparent` 被解析为
`clientRequestId`，绝不回显为键。

## 4. 事件轴

| 轴 | 取值 | 含义 |
| :--- | :--- | :--- |
| `direction` | `client` / `upstream` | 从网关视角看是哪条**腿**；命名腿而非向量——响应与其请求取值相同 |
| `phase` | `request` / `response` | exchange 的哪一侧 |
| `purpose` | `l2-decision`（唯一值，`ExchangePurpose`） | 网关发起的决策调用，挂上游方向 |
| `attempt` | `(requestId, leg)` 内 1..N | failover / 重试序号；客户端腿恒为 1 |

`direction: 'gateway'` 被禁。网关没有第三条腿：`normalizedRequest` 是无 socket、
无状态码、无时延的**内存报文形状**；`clientRequest → normalizedRequest →
upstreamRequest` 是报文形状链（字段/调试视图），不是一组事件。客户端收到的响应是
`clientResponse`——按**腿**命名，与 `clientRequest` 同一坐标系；已退役的
`gatewayResponse` 拼写按发送者命名。

## 5. 禁用拼写

| 禁用 | 改用 | 原因 |
| :--- | :--- | :--- |
| `tun`、`tune` 作作用域 | `turn` | 笔误 / 调节旋钮；`tunnel` 归 ADR-0018、ADR-0020 |
| `turn` 指一次 HTTP 交互 | `request` | turn 是用户提示 |
| `turn` 指准入/预算单位 | `request` | ADR-0023 的 `admitRequest()`、预算与重入计数按请求 |
| `exchange` 指容器 | `request` | exchange 是一对 |
| `request` 指出站 HTTP 报文 | `exchange` | `request` 是入站客户端请求及它引发的一切 |
| 新增 `round*` 符号 | `turnIndex` | `roundNumber`、`totalRounds`、`CaptureRoundIndexEntry` 已**删除**；turn 由写时 `turnIndex` 作键，绝不做窗口内重编号 |
| `gatewayResponse` | `clientResponse` | 已退役：响应按腿命名，与 `clientRequest` 一致 |
| `gatewayRequest` | `request` | 网关不会给自己发请求 |
| `traceId`、`spanId` | `requestId`、`clientRequestId` | ADR-0021 |
| `direction: 'gateway'` | `purpose: 'l2-decision'` | 不存在该网络腿 |
| 捕获平面之外的裸 `event` | `ledger event` | 三本观测账本存 ledger events |

## 6. 已知例外

- `conversationKey` 可跨易变 `sessionId` 重组，因此归档读平面存在比 session **更宽**
  的容器。
- 独立决策面自铸 `requestId` 且无用户提示，不属于任何 turn（`turnIndex: null`）。
- 上游 failover 每跳写一个 exchange；`exchanges[]` 让每跳保持可见，抽屉为每个
  `attempt` 各开一个标签页。
- 切换前的数据只有到达活形状后才进入运行时读平面：schema-1 捕获归档由
  `V1ToV2Migrate` 原地迁移（重建出来的身份以 `migratedFrom: 1` 标记）——
  包括「请求层之前」写下的文件，它们的请求边界从记录下的 span 序列读出、
  而非猜测——`traces.db` 已完成一次性 `DB_VERSION = 3` 归一化。无法收口的序列
  原地修好（取 `NO_TURN` 的孤儿请求），绝不封存搬走：任何东西都不离开活根，
  因为升级不该让运营者失去自己已有的历史。任何热路径上都没有遗留回退分支。

## 7. 去哪里查

| 问题 | 文件 |
| :--- | :--- |
| 为什么是这套层级 | `docs/adr/0024-observation-scope-vocabulary.md` |
| id 归属与基数 | `docs/adr/0021-request-identity.md` |
| `request` 定义与捕获事件模型（schema-2 归档） | `docs/adr/0008-protocol-surfaces-and-capture.md` §5 |
| 对话重组 | `docs/adr/0002-sessions.md` §1（及后果节） |
| id 铸造 | `backend/src/observability/request-identity.ts` |
| 事件发射 | `backend/src/observability/http-exchange.ts` |
| 写时 turn 边界 | `backend/src/capture/turn-boundary.ts` |
| 读平面请求组装与全归档 turn 索引 | `backend/src/capture/recorder.ts` |
| 准入预算与重入（按 `request`，绝不按提示） | `docs/adr/0023-rate-limit-waiting-and-reentrant-admission.md` |
| 控制台计数 | `backend/src/session/session-row.ts`、`frontend/src/pages/SessionsPage.tsx` |

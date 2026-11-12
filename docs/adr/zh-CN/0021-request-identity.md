# ADR-0021：请求身份——网关自有键，调用方值仅作关联

## 状态

已实现——2026-11-12。

## 背景

调用方可以在同一条分布式 trace 里合法地放置多个请求：重试、工具循环、子代理，或者——实测中——客户端把同一个 W3C `traceparent` 用于整段对话。因此 trace id 命名的是一个由多个 span 组成的 DAG，绝不是某一次请求。网关过去把每次请求的观测记录存在**调用方**的 trace id 之下（`traces.db` 主键 `trace_id`），于是共享同一 `traceparent` 的 8 次请求塌缩成 1 行，而另一个会话的行又被前者的后续轮次覆盖。控制台因此显示出一个幽灵会话，并把 token 总量放大了 7 倍（`7 × 67 217`）。

同一种歧义也渗透到了 capture 平面和响应头：`sessionId` 有时就是客户端自己的值，`X-OCR-Trace-ID` 回显了调用方本来就知道的值，而没有任何接口能命名网关自己的那一行。

## 决策

### 1. 一套词表；无前缀即网关层

本服务是默认命名空间，因此只有外部命名空间才加前缀。

| 名字 | 归属 | 基数 | 职责 |
| :--- | :--- | :--- | :--- |
| `requestId` | 网关 | 每请求唯一、不可变 | trace 记录主键、控制台行身份、capture 关联键、`X-OCR-Request-ID` |
| `sessionId` | 网关 | 每会话唯一 | 会话实体（ratchet / pins）、`X-OCR-Session-ID` |
| `clientRequestId` | 调用方 | 可重复、可缺 | 仅作关联——永不作键 |
| `clientSessionId` | 调用方 | 可重复、可缺 | 客户端会话别名，以 `request.clientRef`（含来源信息，ADR-0002）承载，不设第二个字段 |
| `upstreamRequestId` | 上游 provider | 可缺 | 上游自己的调用 id（`x-request-id`），记录在 capture 归档的上游响应事件上——绝不铸造，上游不提供即缺失 |
| `exchangeId` | 网关 | 每次 HTTP 交换唯一 | 配对一次请求事件与其响应事件（每个 request 2+ 个交换） |

领域模型、存储、admin API、控制台与响应头中不存在 `traceId`，也不存在 `spanId`。只有 `observability/request-identity.ts` 这一处理解线上词表：它把 W3C `traceparent`（其次 `x-request-id`、`x-trace-id`、`x-correlation-id`、`request-id`）解析为 `clientRequestId`，并铸造 `requestId` / `exchangeId`。

### 2. 作用域阶梯

```
trace（调用方）  ⊃  requests（网关）  ⊃  exchanges（网关）
session（网关）  ⊃  requests
```

调用方的值可以跨行重复；网关的键不可以。网关**从不**自己编造 `clientRequestId`：编造出来的关联值只是伪装的网关 id。

### 3. 存储规则

- `TraceTracker` 的 Map 与会话索引都以 `requestId` 为键；会话索引每条**记录**一个条目。
- `record()` 永不覆盖：缺失 id（历史行 / 植入行）或键冲突都会重新铸造一个 `requestId`。
- `traces.db` 模式 v2（`PRAGMA user_version`）为 `(request_id PRIMARY KEY, session_id, ts, data)`——没有 trace-id 列。闸门同时看**版本与形状**：文件可能带着 v2 版本号却是外来形状（某个中间构建留下过 `request_id` 作主键、外加 NOT NULL `trace_id` 的表，导致每次写入都违反约束——写入又是 fail-open 的，于是持久化被静默停掉）。因此只要 `PRAGMA table_info` 显示的不是恰好 `(request_id PK, session_id, ts, data)` 也同样重建；行内已有网关 `request_id` 的保留该键。v1→v2 迁移在**一个事务内**重建表（SQLite 不能删主键列），并把历史行按旧主键（主键保证唯一）重键；那些 v1 行里已经塌缩的部分无从恢复。回放归一化用该键填充 `requestId`，并丢弃两个 id 都没有的行。该文件与 FinOps / failure-event / quota-event / ratelimit 账本共用——各家独立句柄、只执行 `CREATE TABLE IF NOT EXISTS`；`user_version` 是**文件级**的，故由本 store 独占，版本高于当前二进制时按原样读取（绝不下迁）。
- `sessionId` 是网关的会话实体 id，只有一个被认可的命名例外（ADR-0002 的会话解析）：`header_fallback` 之下网关会**以 vendor header 的值命名**新解析出的会话，因此 `sessionId` 可能恰好等于某个客户端字符串。它仍然是网关实体（由网关解析得出，任何其他 store 都不把它当原始键），该值不跨会话被信任。
- 同一轮次内部的推理腿共享该轮次的 `requestId`：路由一次 chat 请求时发出的 layer-2 决策调用就是这样的腿，靠 `purpose: l2-decision` 区分，而不是第二个 id。独立的决策 **surface** 本身是一次客户端请求，因此和其它请求一样铸造自己的 `requestId`。
- capture 事件携带 `requestId`、`exchangeId`、`clientRequestId?`、`sessionId`、`upstreamRequestId?`；轮次分组与请求/响应配对只使用 `requestId` / `exchangeId`。
- 本决策之前写下的归档文件在**归档读取器**里一次性映射（`normalizeArchivedEvent`）：`spanId → exchangeId`、`traceId → clientRequestId`，并以调用方值充当关联键（那些文件里没有网关 id）。这是摄入边界的数据迁移——下游代码不持有两种拼写，且该函数在保留窗口越过切换点后即可删除。

### 4. 线上

- `X-OCR-Request-ID`（新增）命名确切的控制台行。
- `X-OCR-Session-ID` 继续命名网关会话。
- capture 管理端点以轮次 id 取值：`GET /api/admin/capture/:date/:file/turn?id=<requestId>` 即可解析该轮次（`evt_…` 事件 id 亦可，两者都能唯一命名它）。
- `X-OCR-Trace-ID` 移除。回显调用方自己的 trace id 不携带任何信息——调用方本就持有它，而网关也不在声明一条它并未传播的 span 关系。

## 结果

- 客户端在整段对话里复用同一个 `traceparent` 不再有副作用：每个请求是自己的行、自己的 capture 轮次、自己的用量记录。
- token / 成本聚合不会再因重复的调用方 id 而倍增；`total` 与每行数值描述的是不同请求。
- 控制台深链与复制目标都是网关的 `requestId`；调用方值永不在服务端被解析（它可能覆盖多行，解析就是猜测）。
- capture 归档仍是唯一保留调用方关联值的地方——这正是线上日志应有的职责。
- 架构切换是**单向**的。旧二进制打开 v2 文件仍能**读**（回放就是 `SELECT data`），但写入指向已删除的 `trace_id` 列并 fail-open，持久化会静默退化为仅内存。若需要保留回滚可能，在本构建首次启动前先留一份副本（`VACUUM INTO traces.db.pre-v2`）。
- 重命名对任何读取 `X-OCR-Trace-ID` 的调用方是破坏性变更；该头在 `README.md` 与控制台的 fact chip 中已改写为 `X-OCR-Request-ID`。
- `TraceTracker` / `ExecutionTrace` / `/api/admin/traces` 保留原名：“traces” 是**观测平面**（记录面板）的名字，`requestId` 是平面内部的**身份**。重命名平面会牵动公开路由、深链、导航与全部语言包，对正确性零收益；真正需要严格的只有上面的 id 词表。
- `upstreamRequestId` **只取上游响应头**（`x-request-id` / `request-id`）。刻意不解析响应体：流式响应是 SSE，逐块解析是热路径成本，而不发该头的上游本就不在线上暴露真正的请求 id。缺失即表示上游不命名调用——绝不铸造。

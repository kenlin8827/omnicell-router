# ADR-0013：失败事件账本——模型调用失败观测

## 状态

已实现 —— 2026-10-21。范围：新的观测平面（`failure_events` 账本 + 控制台失败观测页），外加裁判错误路径上的一处 fail-fast 修复。账本先例 = ADR-0009 的 `quota_events`；trace 平面「只记已执行轮次」的规则 = ADR-0005；熔断状态词仍 confined 于 CircuitBreaker 层（ADR-0004）。

## 背景

运营者的问题「**哪些**模型调用失败了、什么原因」此前没有任何平面能回答：

- trace 表只记已执行的轮次——失败的一轮没有 turn，失败调用无处落盘。
- 熔断器只保留跳闸**状态**（`available/recovering/unavailable`），没有逐次失败的原因与时间线；它的兄弟账本（rate-limit event log）明确把上游 429 划入熔断器领域，而那里没有原因。
- 日志尾部是原始未聚合文本；LogsPage 答不了「哪些模型」。
- 路由裁判的线上失败被一个完全静默的 catch 吞掉——配额耗尽的裁判模型唯一产出就是「缺失的 tier 决策」（触发本 ADR的生产事故：裁判模型烧光月配额，每个 `/auto` 请求都在无声降级）。

评审中否决的备选：

- **扩 trace 表**——语义错位：失败调用没有 turn、没有会话轮次形态，还会污染所有 trace 消费者的不变量。
- **汇入 LogsPage**——原始尾巴无法按模型聚合，问题依旧无人回答。

## 决策

### 1. 一本账，每次失败的上游模型调用一条事件

新增 `backend/src/observability/failure-events.ts`。记录形状：`{ id, ts, lastTs, count, model, provider, errorClass, status?, message, role, sessionId? }`。`errorClass` = 错误分类器的 `ErrorCategory` 词汇（与熔断规则、网关错误面同一种语言），外延 `TIMEOUT`——被放弃的裁判调用没有可分类的 HTTP 状态。`role` 区分发射者：今天是 `serving`（候选池尝试）与 `judge`（路由裁判线上调用）；`probe` 预留在词汇里，未来健康探测若加发射点无需改 schema。

### 2. 两个发射点，构造上即 fail-open

- **业务（serving）**——编排器候选池的逐候选 catch，恰在分类器判定已在手的点位：每个被诊断的失败都随类别、状态、消息与所属会话入账，**无论**后续候选是否救回本轮（failover 结果是路由的事；调用失败是事实）。原地重试的失败与任何重复一样走合并。
- **裁判（judge）**——裁判线上调用的 catch（与任何上游错误同样分类）与截止时间分支（`errorClass: 'TIMEOUT'`）。截止时间已赢下竞速后迟到的 rejection 绝不重复入账——超时分支独占那次观测。两类裁判行都携带触发轮次的会话 id（`routeAsync` → `evaluate` 穿透传入），死掉的裁判可归因到受害会话——与裁判的捕获身份不同，这条归因不依赖 capture 总开关。

不入账——账本观测的是**调用**，不是拒绝：策略拒绝、被熔断跳过的候选、被禁用的凭据、空池（都没出网）；内容级失败同样不入（200 但答案不可解析——那是 /auto last-outcome 面的辖域）。

### 3. 风暴合并——限流账本的同一规则

同 model+provider+errorClass+role 的连续重复在 10 秒窗口内折叠为一行：`count` 递增、`lastTs` 前移、按稳定 `id` UPSERT。一场 429 风暴是一个不断增长观测，而不是几百行。错误 `message` 为日志级英文、截断到 400 字符——一行是一个观测，不是 wire body 的档案。

### 4. 存储与 quota_events 完全同构

进程内 ring（500 行）+ 共享 `traces.db` 中自有 `failure_events` 表的持久镜像，独立 `bun:sqlite` 句柄（WAL、分句柄故障隔离）。启动时先把最近 500 条重放进 ring 再接流量；非 bun 运行时退化为纯内存；所有方法 fail-open——失败观测绝不能破坏它所观测的请求路径。无配置开关：像 `quota_events` 一样常开。

### 5. 裁判静默修复——节流告警

裁判的失败路径（线上错误、超时、不可解析答案）现在会在竞速失败分支按失败模型发一条节流告警（去重 + 窗口限幅，共享 warn-throttle），而 /auto 的 last-outcome 记录继续承担「永远最新的一次判定」。catch 不再是黑洞：日志、/auto 卡片与账本各自承载与自身粒度相称的信号。

### 6. 控制台面

`GET /api/admin/failure-events`（等值过滤 `model`/`provider`/`errorClass`/`role`，可选 `limit`，最新在前）+ `POST /api/admin/failure-events/clear`（ring + 镜像；熔断/限流状态不受影响）+ `DELETE /api/admin/failure-events/:id`（单删一条——ring 行与镜像行同生共死；合并 ×N 的观测是一行、整体消亡；与 route-entries 删除同一 `{ removed }` 契约）。失败观测页在**同一份过滤视图**上渲染两段：上方按模型聚合卡带（失败总数、原因构成、最近一次），下方合并后的事件列表——卡带与表格永远回答同一个问题。

## 后果

- 「哪些模型失败、为何、多频繁」从考古挖掘变成一眼可读的页面；配额耗尽、死 key、5xx 连击与裁判超时共享同一条带角色归因的时间线。
- 每次上游失败都跨重启持久（有界于 ring 预算）——账本是观测，不是档案。
- 路由零影响：没有任何消费者拿账本做门控；写入 fail-open；平面只展示。
- QPS 下死掉的裁判产出：每模型一条节流告警、/auto 卡片最新判定、合并后的账本行——三个诚实信号取代沉默。
- 测试：`failure-events`（record/合并/列表过滤/清空，持久化往返含启动重放，经真实候选池的 serving 发射，裁判线上错误与超时的 judge 发射）。

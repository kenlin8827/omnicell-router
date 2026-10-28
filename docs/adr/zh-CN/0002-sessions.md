# ADR-0002: 会话——身份解析、单调棘轮、钉扎驱逐、凭证亲和

## 状态

已实现 — 2026-10-15。由代码事实推导（`backend/src/session/session-manager.ts`、`backend/src/pipeline/orchestrator.ts` 4B 接缝、`backend/src/pipeline/credential-selection.ts`）。语料重置中按现行代码重新推导（历史编号已退役；现行图谱：0001 路由、0003 寻址/成员制、0004 容错、0005 执行、0006 凭证、0007 环境、0008 接入面）。层级：跨切面（请求侧会话状态）。本篇一引用的健康词汇定义于 ADR-0004；亲和身份锚定定义于 ADR-0006。

## 背景

每个被路由的轮次都要在无客户端配合的前提下回答两个问题：*这是哪段对话*，以及*该由谁服务*。无约束的逐轮换模导致智力退化（追问落到弱模型）并摧毁上游 KV prompt 缓存（缓存未命中要重付 80–95% 的输入成本）。会话子系统是这两个问题的唯一所有者；流水线其余部分只读它的裁定。

## 决策

### 1. 身份——分层零 Header 解析

优先级序（先中先得），`resolveSessionId`：

1. 显式 Header `x-session-id` / `x-conversation-id` / `session-id` / `conversation-id`，或 `router_options.session_id`。
2. 客户端内嵌会话 UUID——Claude Code `metadata.user_id` 的两种形态：旧版字符串 `user_{hex}_account_{uuid}_session_{uuid}` 与 2.x JSON 载荷 `{"device_id":...,"account_uuid":...,"session_id":"<uuid>"}`；两者的内层 id 同属一个对话 uuid 命名空间，统一映射到共享的 `cc_` 前缀。仅全形匹配：宽松的 `_session_` 后缀会把普通用户 id 提升为会话级；JSON 探测要求 JSON 对象且 `session_id` 为非空字符串（与控制台的 `formatSessionId` 同一语义）。
3. 裸 `request.user`（用户粒度；为兼容保留）。
4. 链锚——历史头部截至每个 assistant 轮的前缀哈希（探针有界；命中分叉/重生成后仍共头的历史）。按**规范形**序列化（见下）：登记的 assistant 回音保留其 `tool_calls`，故 agent 工具循环能扛住客户端回传时的字节漂移重新锚定。
5. 尾锚——长度 ≥ 3、终于 assistant 边界的尾部窗口（截旧轮保上下文的客户端靠它回家）。
6. 会话键——`sha256(apiKey 身份 + 完整首条用户消息)`。仅在字节精确锚点落空后才走到（第 2 轮起，如重生成的 assistant 改写），且仅当该键**只有唯一候选**（无歧义）时才归队；有歧义的键（两个活会话共享首条消息）冷启动——假性拆分可自愈，假性合并永不可逆。传输 IP 被刻意排除在输入之外：本地网关对所有人都是 `127.0.0.1`/`::1`（无区分度），且地址在两个环回族之间抖动（正是它破坏了再锚定）。这取代了原先的首条消息根映射：它把 turn-1 形态的重发直接短路到 mint（根本不查键），又把有歧义的根**墓碑化**——同题重问毒化键，再叠加下述 tool-call 漂移，之后每一轮都落到被毒化的键上重新 mint，把一条会话级联成几十个 session id。
7. 冷启动——全新随机 id（`sess_` + 12 随机字节）。turn-1 形态的重发**总是** mint 一个不同 id（守住"绝不假性合并"）；待各分叉从第 2 轮起有了自己的锚点后自愈。确定性出生 id 被否决：本地网关上共享模板开场白的会话会与它相撞。

tool-call 锚按**规范形**序列化——易变包装字段（`"type":"function"` 标记、arguments JSON 的美化 vs 重压缩、信封键序）被归一化抹平；对回传时重新序列化的客户端，整对象哈希会在每个 tool-call 边界落空。该保留的区分度照旧保留：纯 tool-call 轮仍按 id + name + arguments 区分，不同的调用绝不互撞（不可逆的假性合并方向）。锚映射与会话键持久化到按环境的 JSON 快照（`<env>/data/sessions.json`——只存内容哈希与会话 id，无明文），2 秒防抖 + 原子写、关停时刷盘；重启不再撕碎非配合型客户端的分组（仅内存态的 tier/钉选/亲和绑定会重建）。完整摘要式重写匹配不到任何锚，刻意开新会话。出生元数据（`origin`、`firstUserMessage`）先写先得、此后不可变。

### 2. 梯队策略——三种可配置策略

- `monotonic`（默认）：会话记住峰值梯队。升档放行（reasonCode `session.escalated`）；降档请求被拦截、会话保持峰值（`session.ratchet` / `session.preserved`）。理由：短追问（"谢谢""改这一行"）不得换掉大脑、不得作废缓存。
- `sticky`：每轮锁在会话天花板（`session.sticky`）。
- `stateless` / `enabled: false`：逐轮独立路由，零会话写入。

会话生命周期：闲置 TTL（`ttlSeconds`，默认 3600）与容量（`maxSessions`，默认 10000）在清理时按 LRU 驱逐；无定时器。

### 3. 模型钉扎及其驱逐——对话换模型仅有的两条路

会话钉扎一个模型（`pinnedModel`，棘轮在出生/升档时写入）。钉扎读取用活注册表；ratchet 模式下钉扎坐候选链链首。被钉扎模型发生**硬切换**（`repinModel`，先于执行在本接缝持久化）当且仅当：

```
evict(pin) = configForce ∨ healthForce
switch     = evict ∧ 健康着陆点存在 ∧ landing.id ≠ pin
```

- **configForce**——`pin ∉ getCandidateModelsForTier(pin.tier, healthyOnly=false)`：id 已离开注册表（僵尸钉扎——同接缝顺带修复）、`unclassified`（从所有梯队成员表移除 / glob 不再认领），或被全局 `tiers.exclude` denylist 否决。**非**触发项：模型移入其他梯队（`reclassifyTiers` 原地改写 `m.tier`——钉扎仍命中"自己梯队"的池）；对非捕获模型（无 `tierMatch`，其梯队是持久的，见 ADR-0003）的成员表编辑。
- **healthForce**——`modelHealthView(pin) === 'unavailable'`（ADR-0004）：模型断路器 OPEN，或全部凭证 pair 硬 OPEN / SUSPECT / 操作员 DISABLED。`recovering`（试飞在途——金丝雀槽位空闲**或被占**）永不驱逐：peek 视图会把忙碌的试飞读成宕机，而在距恢复只差一次探针的模型上移走钉扎，烧毁的 KV 缓存永久不回（没有任何回切逻辑）。Shadow 模式下自动跳闸永不驱逐：被 shadow 的断路器照常服务（`verdict()` 契约），视图同样按在服务折叠；MANUAL 与行政下架逐字生效。
- **着陆点**——`getModelForTier(actualTier, true)` ∧ peek 可用；请求梯队全空时跨层着陆合法且有日志（`reason=empty-pool`）；repin 永不触碰 `maxTier`。**无健康着陆点 → 被驱逐的钉扎继续服务**（安全失败：被清空的梯队不得搁浅绑定会话；每轮懒惰重判，有处可去即自动完成迟到的切换）。
- **范围**——仅 ratchet 模式。显式点名请求永不改道，仅为对齐回写钉扎（点名模型在天花板梯队实际服务；会话出生/升档时棘轮 resolver 收到的是**被点名模型本身**，绝非池代表——pool-less 部署下点名流量必须保持可调用；裸 `auto` 仍走池解析代表）。Combo 完全绕开钉扎（`sessionMode='bypass'`）：成员表逐调用现场重解析，combo 编辑下一个请求即触达所有对话——没有"绑定"需要撤离。
- **控制台面**——钉扎是路由内部状态，绝不出现在控制台会话行中：`GET /api/admin/sessions` 只报 `currentModel`（实际服务过该会话最后一轮的模型 id，照注册原样——由图录/梯队成员匹配而来的模型带 `provider/model` 前缀，手写注册的模型是裸 id）与服务商 `currentProvider`——活跃行与轨迹重建行共用同一套推导，`GET /api/admin/sessions/:id` 走同一份投影。故障转移的落点因此绝不会冒充会话锚点；重启后的重建行按设计不携带路由状态，渲染同样的执行视图而非编造一个钉扎值；且行是封闭白名单（`SessionRow`，`backend/src/session/session-row.ts`），未来新增的会话内部字段默认不外泄，不会顺着一处展开（spread）漏出来。
- **归因**——绝不新增 `reasonCode`（本轮代码属于 §2 的 `session.*` 词汇）；迁移走 `reasonParams`：`{ repin: 'config'|'health', repinFrom, repinTo }`，随 trace 持久化，在会话切换时间线渲染为显式尾部。
被否决：peek 式驱逐（把钉扎从恢复中的模型上搬走）；在 `executeCandidatePool` 过滤链首（该池被显式/combo 共用——打破显式优先契约）；干等 TTL（最长一小时静默否决已提交的操作员编辑）。

### 4. 凭证亲和——切换是强制故障转移，绝非负载均衡

每个会话可绑定一个凭证（`boundKeyHashPrefix` = 显示安全的 `sha256(keyHash)` 前缀，身份定义见 ADR-0006）。契约（选择点的纯函数 `selectCredential`；持久化归编排器，且仅在成功服务之后）：

- 绑定的凭证健康且在该候选链中 → **永不**因再平衡而移动（本地速率封顶不得移动绑定——只有 provider 自己的 429 / pair 跳闸 / 下架才动它）；
- 绑定 pair OPEN / SUSPECT / DISABLED → 按链序取下一个健康凭证，**FORCED rebind** 在其成功服务后持久化；
- 绑定陈旧/过期/不在该链 → 视为未绑定 → 确定性新会话散布 `sha256(sessionId) % healthyPool`（被封顶凭证优先避开——整形只作用于**新落位**）；自 ADR-0006 权重修订起该散布为**加权**散布：同一哈希在 `[0, Σweights)` 里抽槽，再按权重前缀和走——权重 w 占 w 个连续槽（全部权重为 1 时与原落位逐一相等；权重绝不移动已保留绑定、绝不改变强制故障转移的落点——那里仍按链序——也不触碰棘轮）；
- 全部前缀不可用 → 不带前缀（legacy 强试）；全部 DISABLED → 移到下一候选（下架是决定，不是猜测）；
- 窗口懒惰过期（`credentialAffinity.cacheTtlMs`，对照 `lastActiveAt` 读取）独立于会话 TTL；恢复后不回切，模型凭证皆然。

模型 repin 从不重写绑定：连续性骑在选择边界（绑定前缀存在于新模型 provider 链则 keep，否则算 stale → 重散布 + 成功后 FORCED rebind）。模型维度与凭证维度严格分层：部分凭证禁用 rebind 的是凭证，永远不是模型。

## 后果

- 零 Header 客户端获得完整对话连续性；有了锚点/键快照，重启连分组也不再撕碎（只有内存态的 ratchet/钉选/亲和绑定会重建）。
- 身份锚定在 API-key 应用上（绝不用传输 IP），且 tool-call 锚能扛住客户端回传的字节漂移——正是这两处失败把一条 agent 循环级联成几十个 session id。每个捕捉事件都带 `conversationKey`（ADR-0008），档案可凭内容哈希按会话重组，与易变的 sessionId 无关。
- 客户端 User-Agent 头随轨迹记录（`request.clientHeaders.userAgent`），并在控制台会话表上只读展示为客户端指纹；因其可被客户端伪造，绝不作为身份或路由输入——与上文排除传输 IP 的理由相同。
- 旁路（combo）回合从不创建会话实体，因此按会话的回合编号使用独立的持久化计数器（`SessionManager.recordBypassTurn`，快照字段 `bypassTurns`）——纯展示用途的记账，绝不参与路由；缺少它时每个 combo 请求都会读到 `undefined + 1`，控制台请求明细表的每一行都被标成 #1。
- 操作员编辑（梯队成员表、denylist）下一轮即触达活会话；每个被驱逐会话恰好支付一次缓存重建——强制、可归因、只在有处可去时重试。
- 测试：`pin-eviction.test.ts`（两力、非触发、试飞豁免含双视图分歧、着陆守卫、范围回归）、`credential-affinity-orchestrator.test.ts`、`credential-selection.test.ts`、`session.test.ts`、`resilience*.test.ts`。

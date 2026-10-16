# ADR-0002: 会话——身份解析、单调棘轮、钉扎驱逐、账号亲和

## 状态

已实现 — 2026-10-15。由代码事实推导（`backend/src/session/session-manager.ts`、`backend/src/pipeline/orchestrator.ts` 4B 接缝、`backend/src/pipeline/account-selection.ts`）。语料重置中按现行代码重新推导（历史编号已退役；现行图谱：0001 路由、0003 寻址/成员制、0004 容错、0005 执行、0006 凭证、0007 环境、0008 接入面）。层级：跨切面（请求侧会话状态）。本篇一引用的健康词汇定义于 ADR-0004；亲和身份锚定定义于 ADR-0006。

## 背景

每个被路由的轮次都要在无客户端配合的前提下回答两个问题：*这是哪段对话*，以及*该由谁服务*。无约束的逐轮换模导致智力退化（追问落到弱模型）并摧毁上游 KV prompt 缓存（缓存未命中要重付 80–95% 的输入成本）。会话子系统是这两个问题的唯一所有者；流水线其余部分只读它的裁定。

## 决策

### 1. 身份——分层零 Header 解析

优先级序（先中先得），`resolveSessionId`：

1. 显式 Header `x-session-id` / `x-conversation-id` / `session-id` / `conversation-id`，或 `router_options.session_id`。
2. 客户端内嵌会话 UUID——Claude Code 全形约定 `user_{hex}_account_{uuid}_session_{uuid}`（仅全形匹配；宽松的 `_session_` 后缀会把同一用户的不相关对话假性合并）。
3. 裸 `request.user`（用户粒度；为兼容保留）。
4. 链锚——历史头部截至每个 assistant 轮的前缀哈希（探针有界；命中分叉/重生成后仍共头的历史）。
5. 尾锚——长度 ≥ 3、终于 assistant 边界的尾部窗口（截旧轮保上下文的客户端靠它回家）。
6. 根锚——`sha256(clientIp + 完整首条用户消息)`；有歧义的根被**墓碑化**（两个活会话共享首条消息 ⇒ 谁都不许经根再锚；假性拆分可自愈，假性合并永不可逆）。
7. 冷启动——全新随机 id（`sess_` + 12 随机字节）。确定性出生 id 被否决：本地网关对所有人都是 `127.0.0.1`。

序列化刻意全保真（tool_calls、tool_call_id、非文本 part 都进哈希）——有损哈希会让两个不同的纯工具调用轮字节相同（假性合并，不可逆方向）。锚映射全部内存态：重启后配合型客户端（1–3 层）无损接续，非配合型拿到新会话（状态反正已丢；仅追踪分组断裂）。完整摘要式重写匹配不到任何锚，刻意开新会话。出生元数据（`origin`、`firstUserMessage`）先写先得、此后不可变。

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
- **归因**——绝不新增 `reasonCode`（本轮代码属于 §2 的 `session.*` 词汇）；迁移走 `reasonParams`：`{ repin: 'config'|'health', repinFrom, repinTo }`，随 trace 持久化，在会话切换时间线渲染为显式尾部。

被否决：peek 式驱逐（把钉扎从恢复中的模型上搬走）；在 `executeCandidatePool` 过滤链首（该池被显式/combo 共用——打破显式优先契约）；干等 TTL（最长一小时静默否决已提交的操作员编辑）。

### 4. 账号亲和——切换是强制故障转移，绝非负载均衡

每个会话可绑定一个凭证（`boundKeyHashPrefix` = 显示安全的 `sha256(keyHash)` 前缀，身份定义见 ADR-0006）。契约（选择点的纯函数 `selectAccount`；持久化归编排器，且仅在成功服务之后）：

- 绑定的账号健康且在该候选链中 → **永不**因再平衡而移动（本地速率封顶不得移动绑定——只有 provider 自己的 429 / pair 跳闸 / 下架才动它）；
- 绑定 pair OPEN / SUSPECT / DISABLED → 按链序取下一个健康账号，**FORCED rebind** 在其成功服务后持久化；
- 绑定陈旧/过期/不在该链 → 视为未绑定 → 确定性新会话散布 `sha256(sessionId) % healthyPool`（被封顶账号优先避开——整形只作用于**新落位**）；
- 全部前缀不可用 → 不带前缀（legacy 强试）；全部 DISABLED → 移到下一候选（下架是决定，不是猜测）；
- 窗口懒惰过期（`accountAffinity.cacheTtlMs`，对照 `lastActiveAt` 读取）独立于会话 TTL；恢复后不回切，模型账号皆然。

模型 repin 从不重写绑定：连续性骑在选择边界（绑定前缀存在于新模型 provider 链则 keep，否则算 stale → 重散布 + 成功后 FORCED rebind）。模型维度与账号维度严格分层：部分账号禁用 rebind 的是账号，永远不是模型。

## 后果

- 零 Header 客户端获得完整对话连续性；重启只伤非配合型的分组轨迹。
- 操作员编辑（梯队成员表、denylist）下一轮即触达活会话；每个被驱逐会话恰好支付一次缓存重建——强制、可归因、只在有处可去时重试。
- 测试：`pin-eviction.test.ts`（两力、非触发、试飞豁免含双视图分歧、着陆守卫、范围回归）、`account-affinity-orchestrator.test.ts`、`account-selection.test.ts`、`session.test.ts`、`resilience*.test.ts`。

# ADR-0011：路由经验表与重试升档

## 状态

已实现 —— 2026-10-21。范围：替代已删除学习飞轮（见 ADR-0001 重写）的持久化路由记忆，以及重复提问升档阶梯。路由级联见 ADR-0001；会话策略见 ADR-0002。

## 背景

Layer 1 与飞轮删除后，网关在对话之间没有任何记忆：每个 auto 请求都从头推导档位（判定器或 plus 基线），用户对答案不满意也没有任何自动补救。两个廉价且诚实的信号一直被丢弃：

1. **跨会话**：「这条 prompt 之前在 X 档服务过」——持久化、可人工编辑的经验表胜过对相同字节反复判定。
2. **会话内**：「用户把同一条 prompt 原样重发了」——这是网关侧唯一可靠的不满意信号（点赞/点踩按钮属于客户端）。重发一次 = 「想得更深」；再重发 = 「换更强的模型」。

## 决策

### 1. RouteEntry——每条归一化 prompt 一行

`{ promptHash, tier, effort?, source, confidence, sessions[≤20 LRU], hitCount, createdAt, updatedAt, snippet? }`，整体 JSON 持久化在 `<envRoot>/data/route-entries.json`（2 秒防抖落盘；崩溃最多丢防抖窗口内的计数）。`promptHash` = 空白折叠后 prompt 的 sha256 前缀（16 hex）——同一归一化同时喂给重试检测器。`snippet` = prompt 前 200 字符，仅作展示/编辑辅助，由 `routeEntries.snippetEnabled` 门控（默认开——与会话 `attachOrigin`、已退役飞轮 `logUserPrompt` 相同的「默认可见 + 显式脱敏开关」隐私口径；开关只影响新写入，绝不删除已存片段）。容量上限：`maxEntries`（默认 5000），按 `updatedAt` LRU 淘汰。

### 2. 写入白名单——三个生产者，别无分号

- `l2_confident`：置信度 ≥ 0.85 的 Layer 2 判定，在**成功执行后**落盘，记录实际服务的档位（failover/级联的真实高于意图）。Schema 级联轮次跳过——那类轮次的档位由 lite 先发拥有。
- `correction`：被用户**接受**的升档重试。「接受」只有一种可观测形态：之后的请求换了不同的 prompt hash（「换了个话题」）。满意即走永不写回——已接受的有界损耗。置信度 1.0（实际执行证据）。
- `human`：控制台编辑。置信度 1.0 且**对自动写入免疫**——操作者意图高于观测证据；想改就删行重录。

优先级：`human > correction > l2_confident`——条目绝不丢失确定性（`route-entries.ts` 的 SOURCE_RANK）。

### 3. 级联位置——判定器之前查询

`L0 规则 → 经验查询 → L2 判定器 → plus 基线`。经验命中直接短路 L2（经验表本身就是一次既有判定；`layerUsed: 'entry'`，reasonCode `entry.hit`），并应用条目的 `effort`（客户端显式 effort 永远优先）。显式选择（`force_tier`——含模式强制档、点名模型、组合）完全跳过经验表。

### 4. 重试阶梯——三条件，单调步进

检测（三条件缺一不可，`retry-escalation.ts`）：上一条**已完成**轮次成功 + prompt ≥ 20 归一化字符 + 哈希相同。失败轮次不留重试状态痕迹，技术性重发永不计数。范围边界：检测是**会话域**的——裸 turn-1 形状重发（仅 `[A]`、无历史）按会话管理器的反误合并规则刻意铸造新会话，因此无状态单发客户端在阶梯之外；累积历史的客户端（聊天界面、Agent、携带 `metadata.user_id` 的客户端）正是它服务的对象。

阶梯（从上一轮**实际服务**的档位/思考档起算）：

| 次数 | 动作 |
| --- | --- |
| 1 | 同档，思考档 +1（写进 `reasoning_effort`；由既有 effort 机制翻译并钳制）|
| 2+ | 梯队 +1，思考档回落默认 |
| 封顶 | ultra，之后不再提议 |

能力上限（冻结决策 A3）：钉扎模型无法服务下一档思考档时，+1 会钳制成空操作——计划器**直接跳到梯队 +1**（`cause: effort_ceiling`）。钉扎本身绝不因思考档步骤被打破。梯队步骤走常规单调棘轮（升级 = 合法的换钉，ADR-0002）；sticky 策略会话按设计压平梯队提议（操作者选择了稳定）。归因经 `reasonParams.retry` + `attempt` 携带（棘轮的 session.* reasonCode 重写会保留合并参数）。

### 5. 影子模式与台账

`routeEntries.escalateOnRetry: false` = 影子模式：检测与记录照跑，任何动作不发生。`routing-ledger`（`<envRoot>/data/routing-ledger.jsonl`，纯追加，仅含 prompt **哈希**，64 MB 封顶 + 单次告警）记录每个生命周期事件：`retry_detected`、`entry_hit`、`entry_write`、`escalation`、`correction`。它是飞轮之后的新审计旁路——纯观测，绝不回读参与路由。

### 6. 配置

`routeEntries: { enabled（默认 true）, snippetEnabled（默认 true）, escalateOnRetry（默认 true）, maxEntries（默认 5000） }`——每次控制台保存即热应用（decision-capture 模式）。`enabled: false` 冻结整个子系统：不查询、不写入、无台账。

## 后果

- 会话内的重复不满意一轮自愈；修复跨会话持久（JSON 文件跨重启存活）。
- 控制台 `/route-entries` 页让每条经验可浏览、可人工编辑——「记忆可观测、人工可编辑」需求的逐字落地。
- 诚实边界：满意即走的用户什么都不写（表里保留升档前档位，直到纠偏落地）；换措辞而非原样重发的用户同样计为「接受」。
- 测试：`route-entries`（存储语义）、`retry-escalation`（检测 + 阶梯），既有棘轮/orchestrator 套件覆盖集成缝。

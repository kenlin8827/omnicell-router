# ADR-0014: 入口模式自治权——梯队与思考级别切换矩阵

- **状态**：已实现
- **日期**：2026-10-21
- **关联**：ADR-0001（路由管线）、ADR-0002（会话/棘轮）、ADR-0003（模型寻址）、ADR-0011（重试升档）、ADR-0012（决策层思考级别）

## 背景

网关在同一条线路上服务多种入口模式：`auto` 级联、强制梯队别名（`lite/plus/pro/ultra`）、
全局路由模式杠杆（`routing.mode: cost|quality`）、客户端 `router_options.force_tier`、显式命名
模型（完整 id / `#变体` / 裸上游名）以及配置的组合（combo）。每种模式携带不同的客户端意图——但
网关能执行的每一次梯队/思考级别变更（会话棘轮、重试阶梯、schema 断言级联、跨级池尾）都必须知道
**哪些意图授权它**。2026-10-21 的审计发现三处强制梯队被静默跨越的路径（详见 §历史）；本 ADR 将
修正后的矩阵固化为契约。

## 决策——自治权矩阵

| 入口模式 | 梯队可被网关判定移动？ | 思考级别可被推断？ | 会话交互 |
| :--- | :--- | :--- | :--- |
| `auto` / 梯队别名 / 未注册名（分类器） | **可以**——完全自治 | 可以（决策层、经验表、重试阶梯） | `'ratchet'`——升级、降级拦截、pin 读写 |
| 强制梯队：梯队别名（`lite/plus/pro/ultra`）、`routing.mode` 杠杆、`router_options.force_tier` | **不可以**——强制梯队即契约 | 不推断（仅客户端值 / 变体钉扎 / 模型规格） | `'explicit'`——记录轮次、提案**绝不向下改写**；强制梯队**高于**峰值时是合法的天花板上调（与其他升级一样重钉会话）；不高于峰值时，其他梯队的 pin 既不跟随也不改写（留给后续 auto 轮次）；僵尸 id 修复为强制梯队的健康头；空梯队降级落点仍然跟随 |
| 显式模型（完整 id / `#变体` / 裸名） | **不可以**——所命名模型执行；仅在自身梯队内故障转移 | 不推断（同强制梯队） | `'explicit'`——所命名模型执行成功时回写 pin |
| 组合（combo） | **不可以**——组合即权威 | 不可以 | `'bypass'`——无会话实体、无 pin、无天花板 |

### 什么算梯队移动（全部门禁在 auto 家族内）

- **会话单调棘轮拦截**——`session.sticky` / `session.ratchet` / `session.preserved` 改写
  （session-manager `applyRatchet`，`allowIntercept`）。
- **重试升档阶梯**——`retry.effort` / `retry.tier`（ADR-0011）；`retryEligible` =
  检测命中 ∧ `!comboId` ∧ `!explicitModel` ∧ `!force_tier`。
- **schema 断言 lite 抢跑级联**——5A/5B：lite 先行、断言、失败升入 `fallback.escalateTier`。
  仅 auto 家族武装；**两个方向都是梯队移动**（lite 抢跑会服务到强制 plus 之下；升级腿会服务到
  强制 lite 之上）。
- **跨级池升级尾**——`executeCandidatePool({ allowEscalate })` 在 lite 链耗尽后追加 plus 候选。
  仅 auto 家族武装（`!explicitModel ∧ !force_tier ∧ tierCrossPolicy='allow_escalate' ∧ tier='lite'`）。

### 什么不算自治（所有模式一致适用）

- **能力钳制**——effort 映射与 `resolveServedEffort` 把请求翻译成服务模型实际支持的级别
  （`reasoningDegraded` 诚实降级，ADR-0012）。是翻译，不是判定。
- **模型 `defaultEffort`**——按模型自身声明的默认级别服务（ADR-0012 `effortSource: 'default'`）
  是模型规格，不是对请求的推断。
- **梯队内故障转移**——熔断驱动的候选遍历永不离开梯队池；尝试上限按模式（auto：配置预算；
  explicit/combo：链长）。

## 理由

1. **强制选择是客户端已经做出的路由决策。** 静默跨越它与 combo 快速失败契约所禁止的「不可见
   计费/模型漂移」是同一件事（ADR-0003）——且**双向成立**：强制 plus 不得被 lite 抢跑降级，
   强制 lite 不得在断供或 schema 失败时逃逸进 plus。应当响亮失败。
2. **棘轮保护的是 auto 会话，不是客户端 authored 的选择。** 会话中途的强制别名是一次单轮覆盖：
   不高于会话峰值时绝不降级、绝不改写任何状态（随后的裸 `auto` 轮仍 ride 峰值）；强制梯队**高于**
   峰值时是合法的天花板上调（与其他升级一样重钉）。
3. **观测保持诚实。** 强制轮次携带 `explicit.model` / `forced` reason 词汇——绝不出现带徽章的
   梯队判定码（ADR-0001 §4 显式模型诚实）。

## 实现锚点

- `orchestrator.ts` §3B `retryEligible`；`routeAutoDecision` 经验表门禁（`!force_tier`）；
  `RouterEngine.routeAsync` forced 早退（强制梯队到不了决策层）。
- `orchestrator.ts` §4 `sessionMode` 决议——`explicitModel || force_tier → 'explicit'`。
- `orchestrator.ts` §5 级联门禁（`!explicitModel ∧ !comboId ∧ !force_tier`）；直连路径
  `allowEscalate` 尾门禁；combo `needsSchemaValidation: false`。
- `session-manager.ts` `applyRatchet({ allowIntercept })`——explicit 模式记录不改写；bypass
  根本不调用。

## 历史

- 2026-10-21：审计发现强制梯队被 schema 级联（双向）、plus 池尾、棘轮拦截三条路径跨越；
  三处门禁全部关闭，`retry.test.ts` 改写为契约测试（auto 经验命中 lite 保留升级尾；强制
  lite 响亮失败）。
- 2026-10-21：pin 跟随细化——强制轮次仅在强制梯队内跟随会话 pin（KV 亲和），僵尸 id 修复为
  强制梯队的健康头，空梯队降级落点保留；其他梯队的 pin 既不跟随也不改写
  （`pin-eviction.test.ts` 的跨梯队移动断言已同步更新）。

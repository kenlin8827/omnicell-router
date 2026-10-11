# ADR-0013：梯队成员列表路由 + 内联思考级别映射

## 状态

Implemented — 2026-10-10。取代 ADR-0012 的**路由半边**（自动 match 不再决定候选池成员）。ADR-0012 的分类器不删除——保留为**建议引擎**（目录页推荐、首启种子、/tiers 保存检查全部基于它）。

## 背景

ADR-0012 定稿了四梯队完全同构的自动匹配：pattern 认领 → 价格区间约束 → exclude / excludeTiers 否决 → 未分类第四态。实测使用后运营者（本项目作者）得出结论：

1. **确定性优先于零维护**。模型池是精选集合；隐式启发式不断产生意外（free 模型因"最便宜"霸占 lite 首选、$3/$8 边界归属模糊、缺价模型落未分类、目录改名静默改变归属）。业界主流网关（LiteLLM / Portkey 风格）本来就是显式白名单 model list——这恰是运营者真正想要的。新模型**不**自动进池是特性，不是缺陷。
2. **"按模型组翻译思考级别"是真实需求**，match 系统无法表达：同一个请求级别在不同模型上必须变成不同的值——加档（medium→high）、保持（medium）、减档（medium→low）、映射到 none。全局规则（单一默认值 / +N 提升）被明确否决；按模型 pattern 寻址的翻译表是接受的形态。
3. 控制面分散（梯队钉选在目录弹窗、`reasoningEfforts` 只能手改 JSON、weights 在另一个编辑器里）。带行内配置的成员列表视图是接受的 UX。

## 决策

### 1. 梯队成员 = 显式 `members` 列表（唯一真源）

```ts
interface TierMemberRule {
  pattern: string;              // glob 匹配【完整模型 id】（`provider/model`）；无通配符=子串；写全 id=单项
  weight?: number;              // >= 1，默认 1（预留；v1 UI 不暴露）
  effortMap?: Partial<Record<ReasoningEffort, ReasoningEffort>>; // 思考级别翻译，内联
}

interface TierPolicy {
  members?: TierMemberRule[];   // 列表顺序 = 优先级 / failover 链顺序
  selection?: 'priority' | 'weighted' | 'round_robin';
  match?: ...                   // @deprecated——仅供建议引擎，不再参与路由
  weights?: ...                 // @deprecated——权重移入成员规则项
}
```

单个已注册模型的认领链（以 `model.id` × members 配置为输入的纯函数）：

```
for tier in [lite, plus, pro, ultra]:          // 跨档顺序：轻档先认领
  for rule in members[tier]（列表序）:           // 档内列表序 = 优先级
    globMatch(rule.pattern, 完整模型id) 命中 → claim { tier, rule, index }
全不命中 → 'unclassified'                       // 第四态保留（ADR-0012）；不进任何池
```

- **认领序号 = 链优先级**（`priority = index + 1`）；列表第一条是梯队主选。boot/sync 里"最便宜 lite 代表"等 `isDefaultInTier` 自动赋值**全部移除**——列表顺序即顺序。
- 手配模型（无 `tierMatch` 捕获）保持其显式 tier，不受成员列表管辖（沿用旧语义）。
- 全局 `tiers.exclude` 保留（池层过滤）。档级 `match.exclude` / `excludeTiers` / 价格区间随 match 一起从路由退役。

### 2. `effortMap`——逐模型思考级别翻译

生效链路（auto / 显式模型 / combo 成员统一——这是**模型属性**）：

```
effectiveTarget = effortMap[requested] ?? requested        // 不配 = 原样透传
actual          = downgradeReasoning(effectiveTarget, supported(model))   // 能力收窄
若 effectiveTarget !== 'none' 且 actual === 'none' → 跳过该候选            // 诚实契约
degraded        = rank(actual) < rank(requested)           // 对照【客户端请求】而非映射目标
```

- **映射参与候选选择**（`bestEffortMatch`）：逐候选 gap = `rank(requested) − rank(actual)`；gap 最小者优先，并列按池序。配了 `none→high` 的候选会赢下"未传 effort"的请求（gap −3）；配了 `medium→low` 的候选会输给原生 medium 的模型（gap 1 vs 0）。
- `requested === 'none'` 的请求**仅当**存在把 none 映射到非 none 的候选时才进入 effort 选择；否则走旧直通（任意模型、不思考）。none **不跨档搜索**。
- 逐候选应用发生在 `executeCandidatePool`（唯一执行咽喉点）：链上每个成员按**自己的**请求副本计算 `downgradeReasoning(map(candidate, requested), supported(candidate))`。没有映射 = 请求与现状逐字节一致。
- 词汇表为完整 **6 级** `EFFORT_LADDER`（none / low / medium / high / xhigh / max）。非法键/值在清洗阶段丢弃。
- 响应头契约不变：`X-OCR-Thinking-Actual` = 实际发出值（映射+收窄后）；`Degraded` = actual < requested。

### 3. 退役清单

| 从路由退役 | 保留为 |
| :--- | :--- |
| `tiers[t].match`（patterns / 价格区间 / exclude / excludeTiers） | 建议引擎输入（目录建议、首启种子） |
| 目录钉选 `overrides.json.tier` | seed 一次性采纳；路由不再读取；弹窗编辑移除 |
| `tiers[t].weights` | 权重进成员规则项 |
| `isDefaultInTier` 自动赋值（最便宜 lite 等） | 移除——列表顺序即顺序 |

### 4. 迁移（不做双轨——路由一步切换）

- **首启自动种子**：若四档**均无** `members` 键，用旧管道（match + 钉选，即切换前路由的真实行为）对全部已注册模型分类，按旧链顺序归组（价格金字塔领头模型落在 index 0）为 `[{ pattern: id }]` 显式列表写入 `config.yaml`，并醒目打日志；随后按 members 路由。（显式写了 `members: []` 的档被尊重，永不重播种子。）种子只在真实启动路径（`boot-direct`）执行——这也是**唯一**写 `config.yaml` 的路径。
- **不提供手动重新导入**：首启自动种子是唯一的迁移路径。如需从头重建，删除四档 `members` 键并重启（boot 会再次种子）；此后 /tiers 编辑器完全手动。
- **保存检查**：重叠（同一模型可被 2+ 档认领——运行时按档序先得，但保存时警告）与失联（规则未命中任何已注册模型）→ 非阻塞警告（保存响应 + 干跑检查端点）。

### 5. "未分类"仍是第四态

无任何成员规则命中的已注册模型不进任何池、永不担任梯队代表（ADR-0012 §1 语义不变），仍可按 id 直连 / 经 combo 调用。目录页新增"未入池"视图（可见性 + 一键加入 = 把 id 追加进某档 members）。

## 行为差异（相对 ADR-0012 路由）

1. 新模型**不自动进池**——在 /tiers 或目录"未入池"视图手动加入。
2. 目录改名/下架会让规则失联——UI 标记"不在目录"的成员（孤儿）。
3. 一个模型归属唯一梯隊（档序先得）；重叠规则保存时警告。
4. 路由完全不再看价格；lite 主选是列表写谁就是谁（不再"最便宜优先"）。
5. 四档全无 members 配置时，首启自动种子——路由宁可醒目迁移，绝不静默破坏。

## 风险与边界

- ADR-0012 分类器（`providers/tier-match.ts`）为建议而存活；其测试继续有效。建议与路由的漂移风险固有且可接受（建议永不参与路由）。
- 手写 YAML 的畸形规则会被清洗（非法规则丢弃、非法 effort 键过滤）——永不崩溃路由。
- 遗留 daemon sync 路径在本次变更中**已删除**（`opencode/sync.ts` 移除；`opencode/connector.ts` 仅保留 daemon 目录读取）。成员/种子路径只剩一条：`boot-direct`。

## 改动面

- **后端**：`providers/member-match.ts`（新增：解析/认领/effortMap 助手 + 种子生成器）、`types/router.ts`（`EffortMap`）、`config/types.ts`（TierMemberRule + 弃用注释）、`providers/registry.ts`（认领制重分类/池/选择 + effort 感知选模型）、`providers/boot-direct.ts`（认领 + 首启种子；遗留 daemon 同步路径已删除，连接器保留为 `opencode/connector.ts`）、`pipeline/orchestrator.ts`（选模/写回/重算处的映射 + executeCandidatePool 逐候选）、`routes/console.ts`（池投影、保存检查端点、告警文案）、`config/index.ts`（YAML 注释）、`config.example.yaml`。
- **前端**：`pages/RulesPage.tsx`（成员列表编辑器 + effortMap 弹层 + 保存检查）、`lib/api.ts` 类型、`pages/CatalogSourcesPage.tsx`（未入池视图、加入操作）、`i18n` ×3。
- **测试**：新增 `member-match.test.ts`（认领顺序、子串、重叠、effortMap 选模）；`tier-membership.test.ts` 按 members 重写；`tier-match.test.ts` 不动（建议引擎）；reasoning-effort 套件补充映射用例。

## 后果

- 成员、顺序、思考翻译 100% 显式且集中于一处可审计；任何隐藏启发式都无法移动模型或思考级别。
- 控制的代价：新模型需显式加入；目录变动依赖孤儿/未入池视图兜底；首启迁移一次。
- lite→plus→pro→ultra 仍是请求侧词汇；梯队语义（升级、棘轮、failover）完全不变。
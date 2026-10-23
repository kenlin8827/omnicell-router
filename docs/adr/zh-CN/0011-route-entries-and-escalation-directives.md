# ADR-0011：路由经验表与显式升档指令

## 状态

已实现 —— 2026-10-21。**2026-12 修订**：自动的「重复提问升档」阶梯（`retry-escalation.ts`、
`SessionRetryState`、`correction` 写回、`routeEntries.escalateOnRetry` 开关）已整体删除，
由 §4–§6 的显式 `@ocr-*` 指令面取代。经验表（§1–§3）不变。路由级联 = ADR-0001；会话/棘轮 =
ADR-0002；决策层级别 = ADR-0012；入口模式自治 = ADR-0014。

## 背景

Layer 1 与学习飞轮已删除（ADR-0001），网关的记忆只剩一个位置：按 prompt 的经验表。这部分是
成立的——高频出现的开发者提示词直接按历史服务档位执行，不必为一次决策层调用付费。

上一版修订还加了自动升档阶梯：原样重发同一 prompt 被解读为「这个答案不够好」，于是 effort → tier
逐级抬升。生产环境下这套启发式有四个缺陷，且都不是靠调参能修掉的，因为它们属于语义层：

1. **重复 ≠ 不满。**「换一版」（regenerate）、误触双击、客户端自带的 retry 按钮都会产生逐字节
   相同的重发，其中没有一种必然想要更贵的模型，而网关要为这个猜测付真金白银。
2. **信号作用域与效果作用域不匹配。** 用户只对**一条**答案表达意见，tier 步进却走棘轮，变成整个
   会话的天花板——之后每一条无关问题都按抬升后的档位计费。
3. **长度门槛与语言无关。** `≥20 字符` 对英文约 3 个单词，对中文是一整句，于是「还是不对，再来」
   这类产品主语言下最典型的纠偏短语被静默当成噪音滤掉。
4. **`correction` 写回用最弱的证据写了最强的行。**「下一条消息换了 prompt」无法区分接受、放弃与
   普通对话推进，却写入了 `confidence: 1.0` 并压过 `l2_confident` 的行。

显式控制把这四点从构造上消掉：用户自己声明意图，效果限定在当轮，不推断任何东西。

## 决策

### 1. RouteEntry——每个归一化 prompt 一行

`{ promptHash, tier, effort?, source, confidence, sessions[≤20 LRU], hitCount, createdAt,
updatedAt, snippet? }`，整文件持久化于 `<envRoot>/data/route-entries.json`（2s 去抖保存；崩溃最多
丢掉去抖窗口）。`promptHash` = 空白折叠后 prompt 的 sha256 前缀（16 hex）。指令在哈希**之前**已从
消息链抹除（§4），因此带指令的轮次与不带指令的同一条 prompt 哈希一致。`snippet` = 前 200 字符，
仅作展示/编辑辅助，受 `routeEntries.snippetEnabled` 门控（默认开——与会话 `attachOrigin` 同一套
「默认可见 + 显式关闭」隐私立场；该开关只影响新写入，不删除已存片段）。容量上限 `maxEntries`
（默认 5000），按 `updatedAt` LRU 淘汰——**人工行豁免**（算子意图优先于容量压力）。

### 2. 写入白名单——两个生产者，别无其他

- `l2_confident`：置信度 ≥ 0.85 的 L2 判定，在**成功后**以实际服务的档位落库（故障转移/级联的
  事实优先于意图）。schema 级联轮次跳过——那类档位结果归 lite 主控。决策层同时决定级别时
  （ADR-0012），实际服务的 `actualEffort` 随同一次写入落库。
- `human`：控制台人工编辑。置信度 1.0，且对自动写入**免疫**——算子意图优先于观测证据；要改就删行
  重建。

优先级：`human > l2_confident`（`route-entries.ts` SOURCE_RANK）。历史遗留在磁盘上的 `correction`
行在加载时折叠为 `l2_confident`（它们现在就是普通的习得行，不留死掉的来源标签）。

**指令永不写回。** 手动覆盖是决策，不是统计经验——把它固化进表里，等于把一个用户一次性的成本
决定变成所有人的路由。

### 3. 级联位置——决策层之前查表

`L0 规则 → 经验表查询 → L2 决策层 → plus 基线`。命中即短路 L2（表本身就是一个既有判断；
`layerUsed: 'entry'`，reasonCode `entry.hit`），并在客户端未显式指定时套用条目的 `effort`。
显式选择（`force_tier`——含模式强制、命名模型、combo）完全跳过经验表。

### 4. 升档指令——词表与抹除契约

两种形式，命名空间可配置（`<prefix><suffix>`）：

| token（默认前缀） | 效果 |
| --- | --- |
| `@ocr-tier-up` | 当轮 tier + 1 |
| `@ocr-tier-down` | 当轮 tier − 1 |
| `@ocr-effort-up` | 当轮 effort + 1 |
| `@ocr-effort-down` | 当轮 effort − 1 |
| `@ocr-tier-lite` / `plus` / `pro` / `ultra` | 当轮 tier **钉到**该档 |
| `@ocr-effort-none` … `@ocr-effort-max`（6 档） | 当轮思考档**钉到**该档 |
| `@ocr-continue` | 不作用任何轴——续写上一条回复 |

步进形式是相对「当轮本来会服务什么」；钉住形式直接命名目的地——而这正是会话天花板所必需的：
棘轮按会话限制**自动**升档（ADR-0002/ADR-0014），所以「我现在就要 ultra」必须能用一次表达，
而不是数 `-up` 的次数（后者仍然可用，净和叠加：两次 `-up` 等价于 `tier-ultra`，除非被钳制）。
两种形式共享同一条性质：只作用于当轮，不作用于会话。

钉住是手动覆盖，因此可以低于自动判定——这是显式降档，只允许用户指令触发（第 6 节），台账记
`direction: 'down'`，控制台据此显示到底是谁的判断落地。同轴上钉住与步进并存时，**最后一个钉住
胜出**，被压过的步进记为 `ignoredSteps` / `ignoredCause: 'pin_wins'`，绝不静默丢弃。被钉住的
effort 与客户端显式 `reasoning_effort` 一样受能力钳制（degraded-or-equal，记 `clamped`），
因为钉住是绝对请求，不是方向。

`@ocr-continue` 在两个轴之外：内容级 token，不产生任何 tier/effort 效果——它的全部语义就是
抹除加纯指令丢弃（见下）。单独出现在最后一条 user 消息时，当轮按不变的档位续写上一条回复；
台账以 `axis: 'continue'` 标记，保证无提示词轮次可审计。

**命名空间可配置**（`directives.prefix`，默认 `@ocr-`）。`ocr` 是行业通用缩写：光学字符识别领域的
提示词里出现 `@ocr-pipeline`、`@ocr-v2` 完全正常，而与客户自身领域词汇冲突的保留命名空间无法靠措辞
规避——它必须能在不改代码的前提下搬迁。校验是封闭形状：`@` + 小写短标识 + 结尾分隔符（`-`、`_`、
`.`、`:`），3–32 字符，于是 `<prefix><suffix>` 不会歧义；其余一律在加载时回落默认值（非法值绝不能
悄悄扩大或缩小网关改写用户文本的范围）。匹配带「前一字符非字母数字」的左边界，因此正文里仅仅包含该
子串的内容（`alice@ocr-corp.com`）不在命名空间内。搬迁前缀会让此前写下的 token 变回普通文本（不再
被抹除），代价是恰好一次前缀缓存失效。`directives.enabled: false` 是总开关：既不抹除也不生效，token
作为普通文本上行。两个键都在控制台保存后即时生效（`pipeline/directive-gate.ts`）。

两条契约都是无条件、无状态的（`pipeline/directives.ts`）：

**抹除——每次请求、每条消息。** 所有 `<prefix>…` token 都从全部角色（system / developer / user /
assistant / tool）与全部文本片段中移除；只因移除而变空的行整行丢弃；内容彻底清空的 user 消息整条丢弃（system / assistant / tool 消息即使被清空也保留）。
上行 payload 必须与「从未写过指令」逐字节等价，于是厂商永远看不到保留字，跨轮的前缀缓存也保持
稳定。未知的 `<prefix>*` token 同样抹除（笔误不能泄漏），并记入台账。哈希、片段、trace、抓包读到的
都是抹除后的链条。

只剩指令的消息（「继续」）整条丢弃，链条于是停在上一轮的 assistant 消息上——这就是「继续」的语义。
这类轮次没有自己的 prompt 身份，因此既不会命中、也不会改写任何经验行。

**生效——按位置。** 只有**最后一条**客户端 user 消息可以生效，且只作用于当轮。这正是重发幂等的
来源：客户端每轮都会重发完整历史，若从更早的消息读取效果，就会在每次请求上重复升档。tool 结果、
assistant 文本、system 提示同样被抹除但**永不生效**——否则一个抓取到的网页就能强制抬档（成本
放大）。同一轴上的多个 token 按出现顺序净额抵消（`up` 后 `down` = 0）。

面向算子/用户的语法参考：`docs/design/directives.md`。

### 5. 指令的作用域、钳制与优先级

- **tier** 在会话棘轮**之后**应用：指令是逐轮覆盖，因此永不抬升 `session.maxTier`，也永不重钉
  会话（当轮即信号作用域）。带 tier 指令的轮次刻意不跟随会话 pin，否则对任何已建立的会话，指令
  都会退化为空操作。
- **effort** 基线 = 该时点实际在用的有效所求——客户端自己的值，否则经验表命中 / L2 判定注入，
  否则所服务模型的 `defaultEffort`。因此步进是相对于「这一轮本来会服务什么」（与 tier 轴从棘轮后
  的决策出发同构）；结果按能力「降级或相等」钳制，与其余 effort 机制同一套规则。写入时机在模型
  匹配之前，以便按 effort 选模型时能感知；来源记为 `effortSource: 'directive'`。
- 钳制范围：tier ∈ [lite, ultra]，effort ∈ [none, max]。被截断的步进在台账中标记 `clamped: true`。
  钉住不会越界（词表本身就是边界），但 effort 轴上仍可能被模型能力钳制。
- 同轴「钉住 vs 步进」：钉住胜出，被压过的步进计数（`ignoredSteps`），两种形式可共存于一条消息。
- 优先级（高 → 低）：客户端显式 `model` / `force_tier` / combo → `@ocr-*` 指令 → L2 动态（tier，
  以及高于下界的 effort）→ 经验表 → L0 规则 → plus 基线。显式客户端选择优先于指令
  （`directive_ignored {cause: 'explicit_choice'}`）。
- 若一条纯指令 prompt 会令消息链中不再有任何 user 消息，则直接 400。

### 6. 自动机制永不降档

tier：L0 规则、经验表、L2 决策层只能在基线之上**抬升**（既有的单调棘轮，ADR-0002/ADR-0014）。
降档只保留给显式的 `@ocr-tier-down` / `@ocr-effort-down`。理由是代价不对称：过度配置花的是钱
（可见、有界、可回滚），配置不足花的是**静默的**质量。分类器要判断「这题不值这么多钱」需要预算
与重要性上下文，而它结构上拿不到——那是政策判断，政策属于算子与用户。

effort 保留一个有界的例外：`classifier.layer2.effortDecision` 可以把级别定在模型 `defaultEffort`
之下，但不得低于 `classifier.layer2.effortFloor`（默认 `low`）。effort 问题只在客户端省略该字段时
才会提出，因此客户端显式值根本不会被覆盖；被下界抬回的钳制记为 `effort_change`。effort 没有会话
状态、也永不使 prompt 前缀缓存失效——这正是它可以这样绑定、而 tier 降档不可以的原因。

### 7. 配置与台账

`routeEntries: { enabled（默认 true）, snippetEnabled（默认 true）, maxEntries（默认 5000） }`——
每次控制台保存即时热应用。已退役的 `escalateOnRetry` 在加载时剥离，不会回写进 config.yaml。
`directives: { enabled（默认 true）, prefix（默认 `@ocr-`） }`——加载时由 `resolveDirectivePrefix`
校验，并经 `pipeline/directive-gate.ts` 热应用：命名空间是「每次请求的抹除契约」，读一份过期副本会
让运营者刚换过的命名空间悄悄停止抹除。
`classifier.layer2: { …, effortDecision, effortFloor }`。

`routing-ledger`（`<envRoot>/data/routing-ledger.jsonl`，仅追加、只存 prompt 哈希、64 MB 封顶并
告警一次）记录：`entry_hit`、`entry_write`、`directive_applied`（轴、from/to、delta、clamped）、
`directive_ignored`（原因）、`directive_unknown`（token）、`effort_change`（L2 下界钳制）。纯观测
——永不被路由读取。

## 后果

- 升档现在是确定的、幂等的、可审计的：一个 token 进，一步出，只作用于一轮。同一段历史连发五次，
  得到五个完全相同的轮次。
- 随启发式一并删除：三条件检测器、A3 能力跳步、`correction` 写回（及其粘性优先级）、影子模式开关、
  两条基于长度的跳过路径。`SessionRetryState` / `recordTurnOutcome` 不复存在，会话不再携带重试
  记账。
- 成本控制保持显式：唯一自动的向上压力是棘轮与 L2，唯一向下的手段是 `@ocr-tier-down` /
  `@ocr-effort-down`（逐轮）与会话 TTL。
- 已知边界：若客户端自身协议会吞掉 `@ocr-*`（例如对外发文本做了标记清理），指令就不会触发——它
  退化为普通路由，而不会退化成错误路由。
- 测试：`directives`（抹除/生效纯函数）、`route-entries`（存储语义）、`route-escalation-e2e`
  （编排器集成：逐轮作用域、幂等、注入防御、显式选择优先级、台账）。

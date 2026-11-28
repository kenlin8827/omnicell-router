# ADR-0003: 模型寻址与梯队成员制——一条解析阶梯、一个成员权威

## 状态

已实现 — 2026-10-15（事实面语料重写）。范围：请求 `model:` 字段允许点名的种类及其解析方式；谁决定池成员资格；combo；变体；按 key 的模型策略；思考级别词汇。成员编辑对会话的后果 = ADR-0002；池执行语义 = ADR-0004/0005。

## 决策

### 1. 寻址阶梯（一个名字，一个胜者）

解析顺序，精确（chat 路径 `orchestrator.ts:739-1085`；决策面镜像同一顺序 `surfaces/decision-pipeline.ts:54-137`）：

1. trim 一次；`request.model` 原文上 wire（surface 契约——转发请求的 **model 字符串**永不改写；已文档化的唯一字节改写是工具关联 id，有字段预算的载体做确定性投影，见 ADR-0033）。
2. 裸梯队别名 `lite|plus|pro|ultra` → `force_tier`（Layer 0，ADR-0001）。这些 id 是 RESERVED——模型与 combo 都不得注册（`RESERVED_IDS`，`member-match.ts`）。历史备注：这些别名最初带前缀（`auto-lite`…`auto-ultra`）；同一次清理中去掉了前缀，并退役了裸 `default` 别名（它是 `auto` 的同义词）——不存在遗留兼容层：旧 id 直接解析失败。
3. 精确已注册 id → 透明直通：钉扎该模型并强制其梯队（`:364-373`）。
4. 变体兄弟 `base-variant` / `base#variant` → 路由到 BASE，钉扎变体的 `reasoningEffort`、压过客户端所发思考级别（`ModelVariant = {id, reasoningEffort}`；`:375-387`）。真实注册 id 永远赢过兄弟名；combo 赢过变体引用；`#` 无匹配变体 → **响亮 404，绝不静默转 auto**（`:388-398`）。
5. 裸上游名（无 provider 前缀——客户端按其自家目录点名模型的方式）：全部命中返回，按输入价、id 定序（`getModelsByUpstreamName`）；MITM 腿额外按被拦截 host 收窄（`upstreamHost` 取自客户端请求 host——原生腿刻意不信 Host，防伪冒；`:106-124,415-418`）。裸命中**绝不**抢占某个仍是活跃 combo id 的名字（`:425`）——该名字的网关自释义是它公布的 combo；同名物理模型仍可用带 provider 前缀的完整 id 直达。
6. combo id（在精确 id 与变体兄弟分支之后、`auto` 之前检查——且优先于裸名命中）：成员表**就是**候选池，梯队池/会话棘轮/结构断言升档全部旁路；成员全未注册的 combo **快速报错**——绝不静默降级成 `auto`（不可见的计费/模型漂移）（`:439-467`）。管线执行前的占位模型解析（思考档位机制）对 combo 与点名显式模型**不得**咨询梯队池——"无任何梯队规则认领模型"的 pool-less 部署下两条路径必须保持可调用（`:584-591, 705-722`——会话 resolver 与占位模型两处）。
7. 其余未注册名 → `auto`，由梯队池裁定。这就是智能路由本身（例如 Claude Code 内切模型后送来的原生 `claude-opus-*` 名落到 `auto` 池链）。

词汇事实：已解析的物理记录是 `ModelRegistration`（id + provider + wire + 派生归属梯队 + pricing…，`config/types.ts:56-190`）；`ComboModelRef {id, weight?}` 是未解析的配置句柄（`:192`）；`modelRef` **措辞**命名网关可见 id 命名空间 = auto 别名 ∪ combo id ∪ 注册 id ∪ 变体兄弟 id（`:131-148`）——即控制台目录为每行打的五种标签（`kind: 'auto'|'tier'|'combo'|'model'|'variant'`，`/api/admin/gateway-models`——同一词汇也驱动按 key 的有效模型视图 `/api/admin/api-keys/:id/models`，后者每行额外携带 `allowed` 策略判定与 `virtual` 标记；每行还携带 `tiers`——该模型的**完整**成员集合，不上报任何单一固定梯队）。历史语料的 `ModelRef`/`ModelIdentity` **类型名从未落地代码**——不得复活；`AGENTS.md` 已改指本篇。

### 2. 梯队成员制——已提交的成员列表是唯一来源，按梯队投影

`tiers.<tier>.members` 决定候选池（`config/types.ts:261-265`）。确定性胜过零维护：策展池、无隐藏启发式；新模型**不**自动入池是特性不是缺陷。已经不存在任何分类器：曾用于预标注模型的价格档/名称通配/能力标志分类器已删除（它早已不再参与路由，其 `tierMatch` 输出也没有任何读者——见下方 home tier 条目）。

- `TierMemberRule = {pattern, weight?≥1, effortMap?}`；pattern 语义：`*`/`?` 大小写不敏感 glob，**无通配符 = 子串匹配**，全量 id = 精确钉。这个钉由**投影**施加（`markExactFullIds`，`providers/member-match.ts`）：pattern 命中**已注册**模型 id 的规则在每个提交/预览/boot 读取点都被标记 `exact: true`，因此 `deepseek/v4-flash` 绝不会以子串方式认领更长的兄弟 `deepseek/v4-flash-vision-exp`。部分 pattern（`deepseek/v4`、`flash`）与未注册 id 保持子串语义——未注册且无通配符的 pattern 若是一个已注册 id 的子串，仍会认领它；只有什么都匹配不到时才作为孤立项上报。磁盘配置本身从不被重写。
- **成员资格是按梯队的投影**（`claimInTier`，`member-match.ts`）：梯队 T 列表里的每条规则各自独立认领它匹配到的东西，因此一个模型——或 combo 展开后的成员——**可以**同时加入多个梯队（规则重叠按契约合法，保存时**不**告警）。每个梯队的链序（权重降序、再该梯队的规则序号）、权重与内联 `effortMap` 都来自**该梯队自己**的认领规则，所以同一个模型在不同池里可以有不同的排名——以及不同的 effort 翻译。`matchingTiers` 返回完整成员集合（目录的 `tiers` 数组、按梯队展开的 model-access 检查）。
- 注册表只保留**一份**已提交成员视图（`committedMembers`，由 `reclassifyTiers` 设置——唯一的提交点；从 boot 配置初始化）：每次运行时池读取（`getCandidateModelsForTier`、权重、`effortMapFor`、`tiersOf`、无覆盖的实时预览）都把**那份**快照投影到模型宇宙上（`buildTierPoolEntries`）。带草稿覆盖的预览则改从草稿重新推导。
- **归属梯队（派生视图）**：`m.tier` = 按梯队序 lite→plus→pro→ultra 的首次认领（`claimModel`），并把该认领的 priority/列表代表标志与 effortMap 存到注册对象上。它**只**为需要单一梯队值的消费方存在——钉扎模型的 force_tier、按梯队的上报（`tierUsed` 回落到它，否则上报实际服务池的梯队）、model-access 的梯队展开，以及裸 auto 拓宽池的邻近排序。**池成员资格绝不读它**。
- `tier` 是**可选的**：`undefined` 是**第四态**，不是错误——没有任何梯队的成员表认领该模型，所以它不进任何候选池。它是一个普通的可选值，而不是被加宽的 `TierLevel` 联合，好让 `TIER_RANK` / failover 链 / 会话棘轮继续在严格四值词汇上运作；每个读取方自行声明「无归属梯队」对它意味着什么。
- 链序 = 权重降序、再认领序号（`buildTierPoolEntries`）——权重排序对**每一种**策略的链都生效，权重相同才按该梯队的规则序号。`priority` 取该链首（failover 沿用同一顺序），永不读取轮转游标。`weighted_round_robin` 是链上的平滑加权轮询（权重 w 的成员每轮被服务 w 次且均匀交错）；`round_robin` 走同一轮转内核但所有成员权重按 1 计——等权轮转、权重被忽略。任何其他值（含已退役的 `weighted` 加权随机抽取旧拼写）在读写两侧都归一化为 `priority`：只有三种拼写会被持久化，已有 `weighted` 与 `round_robin`（两者都是旧加权机制：加权随机抽取 / 连续加权槽位）由 v6→v7 迁移在升级时统一改写为 `weighted_round_robin`；新的等权 `round_robin` 是升级后的显式选择。代表（`tierDefaults`、空池回退链）就是各梯队的池首，每次提交都重算。
- **选主发生在哪里由会话模式决定，不由策略决定。** 有持久 pin 时（`session.enabled` + `monotonic`/`sticky`，默认值），策略选主只在 pin 诞生与重钉时发生一次；该会话后续每一轮都服务这个 pin（prompt-cache 亲和，ADR-0002），游标不再前进。强制梯队的轮次（ADR-0014）对同梯队的 pin 出于同一亲和理由照常跟随；pin 在强制梯队之外时既不跟随也不改写，该轮就在强制池里抽一次。`stateless` 或 `session.enabled: false` 下不存 pin，所以选主每请求发生一次，落在实际服务链的链首（auto 直连、lite 级联与升档腿都一样）。Combo 绕过会话、按请求轮转（见下 `ComboConfig`）。
- **可级联轮次只抽将要服务的腿，不抽被丢弃的预选。** 当 lite 抢跑级联将决定路由时，orchestrator
  **跳过**执行前的 auto 抽取（否则会为一个请求根本不服务的模型推进游标，占位也终被丢弃）；用于
  effort 预览的占位取池首，永不抽取。级联随后按实际服务的每条腿各抽一次（lite 冲锋、再升档梯队）。
  已持久化的会话 pin 本就提供执行前模型，且不会压制级联。
- **轮转游标以成员 id 与其声明权重为键。** 组成变化**或**权重变化（同 id、新份额）都会开启新的
  信用向量，池缩到单成员时同样重置，恢复后的池不会沿用变化前累积的信用。权重在每个边界都归一化到
  有限上限（`MAX_MEMBER_WEIGHT`）——YAML `.inf` / `1e309` 的 `Infinity` 被钳制而非毒化累加器。
- **运行时无自动种子、出厂无内置成员**（历史种子路径已删除）：`DEFAULT_CONFIG.tiers` 为四个空梯队壳——全新 config.yaml 出厂即无池，`auto` 在操作者于 /tiers 页添加成员前无法路由；显式 `tiers: {}` 被尊重为"无池"；任何梯队都无 `members` 键的配置保持空池 + 启动告警（`member-match.ts:36-45`；YAML 字段注释的中文原文"运行时不再自动生成种子"只存在于 `config/index.ts`）。
- `unclassified` 是第四态**标记位**，不是梯队加宽（`types/router.ts:26`）：不被任何梯队认领、不进任何池、不得成为梯队代表，控制台以"未入池"视图呈现并可一键加入。它作为 `PoolMembership` 取值存在——即一个**认领结果**（`claimModel` / `resolveTierPool` 的返回值），而绝不是存在注册对象上的字段：没有归属梯队的注册对象就是 `tier: undefined`。
- 双轴活性：BOOT 快照拥有模型宇宙（provider/凭证/wire）；成员资格+链优先序+effortMap 是**文件派生的活投影**——控制台两条保存路径即时提交 `applyTierConfigNow`（+ `applyCombos`），另有 2 秒懒惰重放兜手改 YAML（`registry.ts` `maybeRefreshMembers`，`routes/console.ts` `handleSaveConfig`/`handleSaveRawYaml`）。懒惰重放同样重放 **combos**——绕过控制台保存路径的组合写入（手改 YAML、api-keys 路由等直调 `saveConfig` 的调用方）此前要等到下一次保存事件或重启才对路由可见。重放带指纹守卫：内容未变即空操作（不重建表、不清轮询游标、不重复告警）。
- 手工配置的模型（无 `autoTier` 戳记）永不重分类——其显式梯队是永久的，也正是它入池的依据（成员规则不动它；该梯队里一条匹配的规则仍可提供权重）。`tiersOf` 暴露的恰是它的显式梯队。戳记 `autoTier?: true` 只是来源凭证，**不携带任何载荷**：成员资格在每次提交时从成员表重新推导，价格、名称通配与能力标志都不再参与。
- 全局 denylist `tiers.exclude` 是唯一剩下的池否决——无条件，"连显式钉扎都压过"（`registry.ts:467-472`）。
- Combo 间接引用：成员规则 `pattern: 'combo:<id>'` 是**声明的引用**，不是 glob——每个提交/读取点（boot 认领、`applyTierConfigNow`、2 秒懒惰重放、`resolveTierPool` 预览、保存检查）都经 `expandComboRefs` **原位展开**为 combo 的已注册成员：配置序保留（引用所处的列表位置决定链序）、逐成员 weight 携带、引用级 `effortMap` 整块作用于全部展开成员、重复与未注册 id 丢弃、与先前规则的精确 id 认领去重，且每个展开成员都是**精确钉**（`exact: true`——成员全 id 绝不子串认领更长的兄弟 id，如 `p/v4-pro`）。池永远是物理模型列表——请求路径**绝不**解析引用。一个 combo 可被**任意多个**梯队引用——每个梯队的池各自独立展开。这是唯一获准的自动跟随通道：此后 combo 的编辑在下一次提交时流入每个引用它的梯队，因为操作者已按引用逐个选择加入；死引用（未知 / 保留字 / 已停用 / 被遮蔽 / 零已注册成员）展开为空，以 `deadCombo` 保存检查警告呈现（boot 同样告警）。引用自身的 `weight` 字段无效——权重住在 combo 的成员条目上。

### 3. Combo

`ComboConfig = {id, disabled?, selection?, models:(string|ComboModelRef)[], note?}`——`selection` 只决定 **leader**；failover 永远按配置序走；无跨梯升档（组合本身即契约）；尝试上限 = 链长（ADR-0005）。`priority` 取配置序链首；`weighted_round_robin` 与 `round_robin` 共用梯队池同一套 `WeightedRoundRobin` 内核（按 combo 作用域独立游标）：`weighted_round_robin` 把成员声明的权重当作轮转份额，`round_robin` 一律按 1——等权轮转、权重被忽略。任何其他值（含旧拼写 `weighted`）在读写两侧都归一化为 `priority`；已有 `weighted` 与 `round_robin`（旧加权随机 / 连续加权槽位）由 v6→v7 迁移在升级时统一改写为 `weighted_round_robin`，因此只有三种拼写会被持久化，新的等权 `round_robin` 是升级后的显式选择。梯队成员表可经 `combo:<id>` 规则引用 combo（§2）——组合保持自持，引用只在提交点镜像成员资格。`disabled: true` 是运维下线开关：combo 仍保持注册，好让请求路径区分「已禁用」与「未知名字」，但它从所有目录隐藏（`/v1/models` 列表与详情 404、控制台模型选择器），请求显式点名它则快速失败返回 404——与空成员场景同一条「绝不静默降级」契约，绝不回落池路由（`orchestrator.ts:866-896`）。`resolveCombo` 逐调用现场解析：配置序保留、未注册 id 丢弃、重复折叠到首次出现——迟到注册的模型自然加入（`registry.ts:1005-1020`）。id 命名空间冲突单向且响亮：combo 撞已存在模型 id → combo 被忽略 + 告警；模型后注册盖住 combo → 遮蔽（告警 + 从 `/v1/models` 隐藏）（`:961-972`、`:279-281`）。`combos` 列表顺序即控制台展示顺序——可在 UI 中重排，按原顺序写回配置。

#### 3a. 目录面形状（`/v1/models`）

`GET /v1/models` 是 OpenAI 兼容的（{object:'list', data:[{id, object, created, owned_by, metadata}]}），让通用 SDK 与聊天客户端能列举模型；行 id 是网关可见的 modelRef 词汇（注册 id / 变体兄弟 id / auto* 别名 / combo id）。能力目录——一个 models.dev 形状的 provider map（对齐 https://models.opencode.ai/api.json ——仅 schema 形状对齐，不复用数据），按 provider id 键控，每个 provider 携带 `models` 为按模型 id 键控的 models.dev 能力块 map（snake_case：`reasoning`/`tool_call`/`modalities`/`limit`/`cost`/`reasoning_options`）——住在 `GET /v1/catalog.json`，由**同一份**过滤数据构建（一个 builder，两种投影；OpenAI 列表的每一行都在 `metadata` 下携带其能力块）。每种 modelRef kind 的能力来源（`providers/virtual-meta.ts`）：具体模型原样透传其 catalog 记录；虚拟引用（auto*/combo）携带成员**包络**——成员间 `limit.context`/`limit.output` 取 MIN（任何成员溢出都会毁掉请求）、image input 仅当**每个**成员都声明才成立（`tool_call`/`temperature`/`structured_output` 同为交集标志）、`cost` 取链序 leader（`auto` 取梯级序首层，combo 取配置序首成员）——且 `reasoning: true` 带**完整**努力阶梯，因为梯队成员制是规则驱动的、随每次配置保存而漂移：包络只声明**限制**，绝不声明思考档位真相（网关按请求钳制，`X-OCR-Thinking-*` 如实上报）。变体兄弟以 `<upstream>-<variant>` 键挂在 base provider 下，`reasoning: false` 且只带钉扎的那个档位。两处防覆盖回退保证投影绝不抹掉可寻址条目：具体模型的 `upstreamModel` 键在其 provider 的模型 map 中已被占用时（联邦 `omnicell-router` 定义指向**另一个**实例，可能注册出 `upstreamModel` = `auto`/`lite`/…），改用其全局唯一的注册 id 作键——两条目从此共存、各以 `ocr.model` 寻址；变体兄弟的自然 `<upstream>-<variant>` 键被占用时同理回退到其注册兄弟 id（`<baseId>-<variantId>`）。OCR 路由扩展（kind/tier/selection/members/parent/variant/memberCount）住在每个模型的命名空间化 `ocr` 键下。按 key 策略过滤（§4）会剪除模型条目并丢弃模型 map 清空的 provider（两个面都如此）。同一套包络数学也喂客户端钩子写入（pi `models.json`——`cli/clients/model-meta.ts`）。

### 4. 按 key 的模型策略

`apiKeys[].modelAccess = {mode: 'allow'|'deny', models: string[]}`——条目 = 精确 id、`*` 通配、或**梯队虚拟条目** `lite|plus|pro|ultra`（整层规则）；缺省 = 不受限（`auth/model-access.ts`）。四层强制，无路可漏：接入面入口闸（进流水线前折叠所有间接：变体→base、combo→**每个**成员、梯队别名→梯队，`checkRequestedModel` :103-141）、编排器对显式模型的纵深防御（:452-467，403）、执行咽喉对所有候选过滤（`executeCandidatePool`，ADR-0005）含升档尾巴、以及 `/v1/models` + 详情列表（变体按 base 判；combo 仅当所有成员放行才展示）。裸 `auto` 在有策略时**跨层拓宽**到允许池（选层优先、梯队邻近次之）而非 403——"auto"承诺的是**某个**允许的模型，不是某个梯队。

### 5. 思考级别词汇

`EFFORT_LADDER = none|minimal|low|medium|high|xhigh|max`——`indexOf` **就是**秩（`types/router.ts:56-58`）。`'none'` 是客户端可显式发送的**真实档位**，与字段省略不同；"6 档 + none 开关"的说法已过时（唯一例外：System One vendor 枚举无 `none`——legacy `true` 在其上映射到六个非 none 档）。诚实规则（`pickModelForEffort`，`registry.ts:743-786`）：永不升过所求（翻译→能力钳制→降档或无果）；超配池（支持集全部高于所求）不算匹配——宁可换路也不静默掉到 none；跨梯回落允许、降序、如实上报实际模型；`degraded` = 实供秩 < 所求秩（经 `X-OCR-Thinking-*` 呈现，ADR-0004；三个值——`requestedEffort` / `actualEffort` / `reasoningDegraded`——同时作为可选增量字段逐轮记入 `ExecutionTrace.execution`：控制台会话明细由此读取，字段引入之前的旧行反序列化为缺失）。所求的**作者**是一等事实：`effortSource`（`'client' | 'l2-decision' | 'entry' | 'directive' | 'default'`，ADR-0012）把网关注入的级别与客户端自己的字段区分开——网关的决定同样受这些诚实规则约束（决策层决定的级别被能力钳制时与客户端所求同样记为 `degraded`）。成员规则内联 `effortMap`（`map?.[ask] ?? ask`）在**能力钳制之前**作用于全部四站（选择、钉扎模型路径、逐候选拷贝、failover 后重算）；`none→实档` 映射连省略思考请求也生效。`defaultEffort` 仅在客户端省略字段时钉入——显式值含 `none` 永远优先。

## 后果

- 成员资格、顺序、思考翻译 100% 显式、单处可审；目录动荡经由未入池/孤儿视图与保存期的孤儿 + `deadCombo` 告警变得可见，不再被静默吸收。**跨梯队重叠按设计合法且静默**——/tiers 上每个梯队的卡片展示它自己的规则产生的投影。Combo 引用可两级审阅——config.yaml 里的引用本身、每个池预览 / 保存检查里的展开结果；请求路径内不做任何展开。
- 命名诚实：没有任何类型顶着代码从未落地的 `Identity`/`Ref` 契约；本篇的阶梯就是解析契约。
- 客户端挂接遵守同一套判定：控制台 clients 页的跟随模式按 key 作用域有效视图原样快照——具体行进 extras 列表，虚拟行经适配器的 `virtualModels` 载荷注入（`allowed` 判定决定 `auto`/档位别名注入哪些）。custom 模式经显式表单草稿范围化同一载荷（未改动的草稿 = 载荷缺省 = 适配器默认档位块：opencode/dsh/pi/omp 全量，grok 无），并存入控制台表单记忆。客户端切换器因此绝不宣传会被 key 策略 403 的条目，虚拟档位块也绝不同一词条出现第二个来源。
- 测试：`tier-membership`、`tier-combo-members`、`tier-pools*`、`combos`、`variants`、`model-access`、`boot-direct-autotier`，以及 `cli.test.ts` 中的 `virtualModels` 范围化测试（opencode/dsh/pi/grok）。

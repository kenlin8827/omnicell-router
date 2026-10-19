# ADR-0003: 模型寻址与梯队成员制——一条解析阶梯、一个成员权威

## 状态

已实现 — 2026-10-15（事实面语料重写）。范围：请求 `model:` 字段允许点名的种类及其解析方式；谁决定池成员资格；combo；变体；按 key 的模型策略；思考级别词汇。成员编辑对会话的后果 = ADR-0002；池执行语义 = ADR-0004/0005。

## 决策

### 1. 寻址阶梯（一个名字，一个胜者）

解析顺序，精确（chat 路径 `orchestrator.ts:348-467`；决策面镜像同一顺序 `surfaces/decision-pipeline.ts:54-137`）：

1. trim 一次；`request.model` 原文上 wire（surface 契约——转发字节永不改写）。
2. `auto-lite|plus|pro|ultra` 虚拟 id → `force_tier`（Layer 0，ADR-0001）。这些 id 是 RESERVED——模型与 combo 都不得注册（`RESERVED_COMBO_IDS`，`registry.ts:695`）。
3. 精确已注册 id → 透明直通：钉扎该模型并强制其梯队（`:364-373`）。
4. 变体兄弟 `base-variant` / `base#variant` → 路由到 BASE，钉扎变体的 `reasoningEffort`、压过客户端所发思考级别（`ModelVariant = {id, reasoningEffort}`；`:375-387`）。真实注册 id 永远赢过兄弟名；combo 赢过变体引用；`#` 无匹配变体 → **响亮 404，绝不静默转 auto**（`:388-398`）。
5. 裸上游名（无 provider 前缀——客户端按其自家目录点名模型的方式）：全部命中返回，按输入价、id 定序（`getModelsByUpstreamName`）；MITM 腿额外按被拦截 host 收窄（`upstreamHost` 取自客户端请求 host——原生腿刻意不信 Host，防伪冒；`:106-124,415-418`）。裸命中**绝不**抢占某个仍是活跃 combo id 的名字（`:425`）——该名字的网关自释义是它公布的 combo；同名物理模型仍可用带 provider 前缀的完整 id 直达。
6. combo id（在精确 id 与变体兄弟分支之后、分类器之前检查——且优先于裸名命中）：成员表**就是**候选池，分类器/会话棘轮/结构断言升档全部旁路；成员全未注册的 combo **快速报错**——绝不静默降级成 `auto`（不可见的计费/模型漂移）（`:439-467`）。管线执行前的占位模型解析（思考档位机制）对 combo 与点名显式模型**不得**咨询梯队池——"无任何梯队规则认领模型"的 pool-less 部署下两条路径必须保持可调用（`:584-591, 705-722`——会话 resolver 与占位模型两处）。
7. 其余未注册名 → 分类器裁定。这就是智能路由本身（例如 Claude Code 内切模型后送来的原生 `claude-opus-*` 名）。

词汇事实：已解析的物理记录是 `ModelRegistration`（id + provider + wire + tier + pricing…，`config/types.ts:15-80`）；`ComboModelRef {id, weight?}` 是未解析的配置句柄（`:99`）；`modelRef` **措辞**命名网关可见 id 命名空间 = auto 别名 ∪ combo id ∪ 注册 id ∪ 变体兄弟 id（`:120-137`）——即控制台目录为每行打的四种标签（`kind: 'auto'|'combo'|'model'|'variant'`，`/api/admin/gateway-models`，排列顺序与此处命名空间的读法一致）。历史语料的 `ModelRef`/`ModelIdentity` **类型名从未落地代码**——不得复活；`AGENTS.md` 已改指本篇。

### 2. 梯队成员制——已提交的成员列表是唯一来源

`tiers.<tier>.members` 决定候选池（`config/types.ts:149-153`）。确定性胜过零维护：策展池、无隐藏启发式；新模型**不**自动入池是特性不是缺陷。分类器降级为**建议引擎**（boot 预标注、控制台 preview/check；`match:` 配置 @deprecated-suggestion-only，`:183-198`）。

- `TierMemberRule = {pattern, weight?≥1, effortMap?}`；pattern 语义：`*`/`?` 大小写不敏感 glob，**无通配符 = 子串匹配**，全量 id = 精确钉（`utils/glob.ts:7-16`）。
- 首次认领即得：梯队序 lite→plus→pro→ultra，再列表序（`claimModel`，`member-match.ts:87-98`）；一个模型恰属一个梯队；规则重叠在**保存时**告警（`matchingTiers` 经 `POST /api/admin/tiers/check`）。
- 链序 = 列表序：priority = 序号+1，表首即梯队代表（`reclassifyTiers`，`registry.ts:431-456`）；按梯队 `selection: priority|weighted|round_robin` 选 leader（权重抽签 / 连续槽位 RR + 梯队级游标）——`pickPrimary` `:291-343`。
- **运行时无自动种子、出厂无内置成员**（历史种子路径已删除）：`DEFAULT_CONFIG.tiers` 为四个空梯队壳——全新 config.yaml 出厂即无池，`auto` 在操作者于 /tiers 页添加成员前无法路由；显式 `tiers: {}` 被尊重为"无池"；任何梯队都无 `members` 键的配置保持空池 + 启动告警（`member-match.ts:28-35`；YAML 字段注释的中文原文"运行时不再自动生成种子"只存在于 `config/index.ts`）。
- `unclassified` 是第四态**标记位**，不是梯队加宽（`types/router.ts:9-21`）：不进任何池、不得成为梯队代表，控制台以"未入池"视图呈现并可一键加入。
- 双轴活性：BOOT 快照拥有模型宇宙（provider/凭证/wire）；成员资格+链优先序+effortMap 是**文件派生的活投影**——控制台两条保存路径即时提交 `applyTierConfigNow`（+ `applyCombos`），另有 2 秒懒惰重放兜手改 YAML（`registry.ts:375-425`，`routes/console.ts:1076-1077,1100-1101`）。
- 非捕获模型（无 `tierMatch`）永不重分类——其显式梯队是永久的，成员表编辑动不了它们（`projectedClaim` 返回 undefined → 跳过，`registry.ts:405-411`）。
- 全局 denylist `tiers.exclude` 是唯一剩下的池否决——无条件，"连显式钉扎都压过"（`registry.ts:271-281`）；梯队侧 `match.exclude/excludeTiers` 只是分类闸口的否决（仅建议路径）。
- Combo 间接引用：成员规则 `pattern: 'combo:<id>'` 是**声明的引用**，不是 glob——每个提交/读取点（boot 认领、`applyTierConfigNow`、2 秒懒惰重放、`resolveTierPool` 预览、保存检查）都经 `expandComboRefs` **原位展开**为 combo 的已注册成员：配置序保留（引用所处的列表位置决定链序）、逐成员 weight 携带、引用级 `effortMap` 整块作用于全部展开成员、重复与未注册 id 丢弃、与先前规则的精确 id 认领去重，且每个展开成员都是**精确钉**（`exact: true`——成员全 id 绝不子串认领更长的兄弟 id，如 `p/v4-pro`）。池永远是物理模型列表——请求路径**绝不**解析引用。这是唯一获准的自动跟随通道：此后 combo 的编辑在下一次提交时流入梯队，因为操作者已按引用逐个选择加入；死引用（未知 / 保留字 / 已停用 / 被遮蔽 / 零已注册成员）展开为空，以 `deadCombo` 保存检查警告呈现（boot 同样告警）。引用自身的 `weight` 字段无效——权重住在 combo 的成员条目上。

### 3. Combo

`ComboConfig = {id, disabled?, selection?, models:(string|ComboModelRef)[], note?}`——`selection` 只决定 **leader**；failover 永远按配置序走；无跨梯升档（组合本身即契约）；尝试上限 = 链长（ADR-0005）。梯队成员表可经 `combo:<id>` 规则引用 combo（§2）——组合保持自持，引用只在提交点镜像成员资格。`disabled: true` 是运维下线开关：combo 仍保持注册，好让请求路径区分「已禁用」与「未知名字」，但它从所有目录隐藏（`/v1/models` 列表与详情 404、控制台模型选择器），请求显式点名它则快速失败返回 404——与空成员场景同一条「绝不静默降级」契约，绝不回落分类器路由（`orchestrator.ts:442-453`）。`resolveCombo` 逐调用现场解析：配置序保留、未注册 id 丢弃、重复折叠到首次出现——迟到注册的模型自然加入（`registry.ts:737-752`）。id 命名空间冲突单向且响亮：combo 撞已存在模型 id → combo 被忽略 + 告警；模型后注册盖住 combo → 遮蔽（告警 + 从 `/v1/models` 隐藏）（`:698-724`、`:161-163`）。`combos` 列表顺序即控制台展示顺序——可在 UI 中重排，按原顺序写回配置。

### 4. 按 key 的模型策略

`apiKeys[].modelAccess = {mode: 'allow'|'deny', models: string[]}`——条目 = 精确 id、`*` 通配、或**梯队虚拟条目** `auto-*`（整层规则）；缺省 = 不受限（`auth/model-access.ts`）。四层强制，无路可漏：接入面入口闸（进流水线前折叠所有间接：变体→base、combo→**每个**成员、auto*→梯队，`checkRequestedModel` :103-141）、编排器对显式模型的纵深防御（:452-467，403）、执行咽喉对所有候选过滤（`executeCandidatePool`，ADR-0005）含升档尾巴、以及 `/v1/models` + 详情列表（变体按 base 判；combo 仅当所有成员放行才展示）。裸 `auto` 在有策略时**跨层拓宽**到允许池（选层优先、梯队邻近次之）而非 403——"auto"承诺的是**某个**允许的模型，不是某个梯队。

### 5. 思考级别词汇

`EFFORT_LADDER = none|low|medium|high|xhigh|max`——`indexOf` **就是**秩（`types/router.ts:31-52`）。`'none'` 是客户端可显式发送的**真实档位**，与字段省略不同；"5 档 + none 开关"的说法已过时（唯一例外：System One vendor 枚举无 `none`——legacy `true` 在其上映射到五个非 none 档）。诚实规则（`pickModelForEffort`，`registry.ts:484-544`）：永不升过所求（翻译→能力钳制→降档或无果）；超配池（支持集全部高于所求）不算匹配——宁可换路也不静默掉到 none；跨梯回落允许、降序、如实上报实际模型；`degraded` = 实供秩 < 所求秩（经 `X-OCR-Thinking-*` 呈现，ADR-0004）。成员规则内联 `effortMap`（`map?.[ask] ?? ask`）在**能力钳制之前**作用于全部四站（选择、钉扎模型路径、逐候选拷贝、failover 后重算）；`none→实档` 映射连省略思考请求也生效。`defaultEffort` 仅在客户端省略字段时钉入——显式值含 `none` 永远优先。

## 后果

- 成员资格、顺序、思考翻译 100% 显式、单处可审；目录动荡经由未入池/孤儿视图与保存期重叠告警变得可见，不再被静默吸收。Combo 引用可两级审阅——config.yaml 里的引用本身、每个池预览 / 保存检查里的展开结果（`deadCombo` 警告）；请求路径内不做任何展开。
- 命名诚实：没有任何类型顶着代码从未落地的 `Identity`/`Ref` 契约；本篇的阶梯就是解析契约。
- 测试：`tier-membership`、`tier-combo-members`、`tier-pools*`、`combos`、`variants`、`model-access`、`tier-match`（建议路径）。

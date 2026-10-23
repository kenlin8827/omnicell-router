# ADR-0010：Provider 定义归属——OCR 定义文件，opencode.jsonc 降级为物化目标

## Status

Implemented — 2026-10-20（阶段：定义库 + 一次性 jsonc 移植；CRUD/boot/视图漏斗换源；先物化后推 key 的同步 REPLACE 语义；CLI 钩子改道）。修订 ADR-0005 §2(a) 的 boot 数据源。2026-10-21 修订：手写 `config.yaml` `providers[]` 配置面退役——定义文件是连接定义的唯一事实源（见 §1）。

## Decision

### 1. 每类工件一个真相——连接定义加入凭证的行列

Provider 的**连接定义**——id、name、npm wire 包、baseURL、headers、env 槽位、canonical/body、节点内静态模型——由 OCR 持有于 `<ocrHome>/providers.json`，GLOBAL（不按环境分账；与 `credentials.json` 同册，ADR-0007 文件约定）。这是**唯一**的用户侧连接定义配置面：早先的手写 `config.yaml` `providers[]` 一节已**退役**（注册表不再读取；config 解析器直接丢弃，原生 System One 直通支路整体退役（ADR-0008 修订；未来 Jev/Bailian 集成以普通定义文件 provider 形式接入），手写 `models[]` 配置面随之一同退役（模型在 boot 时从定义 + 目录物化；`RouterConfig.models` 仅作为运行时载体存在，由 `boot.models` 覆盖））。`opencode.jsonc` **整体退出真相链**：任何 console 路由、boot 路径、视图都不得再把它当真相读写。它是**物化目标**——opencode 同步适配器从定义文件再生的客户端工件，与密钥世界的 `opencode.db`/`auth.json` 完全同构（ADR-0006）。手改的 jsonc 定义不是任何东西的数据源；§4 的一次性导入是唯一存在的 client→OCR 定义流动，永远如此。

### 2. 文件——jsonc providers 节点的保形移植

`providers.json`：`version: 1`，原子 temp+rename，形状 = 现行 jsonc `providers` 节点逐字保形（id → `{ name?, npm?, options: { baseURL?, headers? }, models?, env?, canonical?, body? }`）。Provider id 为小写 slug（首字符 `[a-z0-9]`，其后 `[a-z0-9._-]`）：id 在定义文件、凭证库、配额（provider × keyHashPrefix）对、熔断状态与 modelRef `provider/model` 串中都是逐字键，且目录/词汇表里每个 id 都是小写——因此 `upsertProviderDef` 在每次定义写入时拒绝其他形态，console 创建路由以 400 复述规则，表单 id 字段是实时输入掩码（转小写、剔除非法字符），用户所见即所存。`user-config.ts` 的节点解析器（仅 CURRENT shape；`env:[VAR]` 名物化为 `{env:X}` 模板——boot-direct.ts:13,22 正是经这一个漏斗取节点）**不改**：boot-direct 与 console 路由换的是 loader 的**源**，不是语法。与目录层的边界：provider 的**全部**模型——节点内静态模型与拉取而来的一律——都留在该节点内（书册统一修订案；`catalog/custom.json` overlay 已退役，因此不存在第二个落点，也不再有任何优先级问题需要陈述）。

### 3. Boot pool——三源不变，(a) 换人

ADR-0005 §2 改述为：(a) `providers.json` provider 节点，(b) boot 绑定的凭证链（ADR-0006），(c) catalog。失败教义不变：不可路由的 provider 被**排除并上报**，绝不 boot 中止；定义文件不可读 = 响亮的降级徽章（凭证库教义镜像）。池子保持 boot 作用域（ADR-0005 §1——不出现 pool-rebuild 端点）。

### 4. 一次性迁移

boot 时，marker 不存在且 jsonc `providers` 非空 ⇒ 逐字导入定义文件（幂等：按 id 整节点 upsert），完成 marker 记入 `credential-store.json` 账本（standalone-import 模式，factory.ts）。jsonc 在磁盘上**逐字节原样保留**（绝不删除上游工件——cp-dataloss 教义），因此 v2 CLI 在同步物化出更新之前一直保持迁移前的视图。导入失败 = 响亮降级态、扣住 marker、下次 boot 重试。

### 5. 同步契约——key 与定义都推，只写不读

opencode v2 客户端的写方向物化**两类工件**：key（现有 `pushOcrIntoV2`）与定义——用保注释的 jsonc 写器把定义文件渲染进 jsonc 的 `providers` 节点，随后 `POST /api/location/reload` 让运行中的服务注册这些 id（`resolveIntegrationId` 的 reload 自愈路径原样存活）。v2 可写闸门（`declaredProviderIds`）改查**定义文件**，不再查 jsonc。读方向保持仅凭证——定义**绝不** client→OCR 流动。v1 客户端：只推 key，不推定义（legacy 降级面；无定义重写表面）。

### 6. Console 与 UI 去 opencode 化

Provider CRUD 重写到定义库（`upsertProviderDef`/`getProviderNodeById` 变为定义文件操作）。connected 视图 = 定义文件 ∪ 绑定 store 凭证；网格顺序读定义文件序列（jsonc 顺序随耦合一同消亡）。页面更名为"Provider 管理"；`opencode.jsonc` 字样只允许出现在同步客户端面板内。catalog 无需去耦——models.dev 本就是直连抓取（sources/models-dev.ts），与 opencode 无涉。同一条 connected 并集也治理 catalog 聚合（模型列表）：每个聚合 provider 的 `connected` 并入绑定 store 的凭证存在性（且凭证文件 mtime 参与聚合签名，增删密钥无需重启即触发重建）。聚合只读定义文件——冻结的 auth.json 快照不喂养任何视图；其仅存的读者是凭证层的一次性导入与 v1 同步客户端。

### 7. 自动拉取按服务商 opt-in（`catalog.autoPullPatterns`）

2026-12 修订：周期性模型 sweep（`autoPullProviderModels`，由 catalog 仓库的同步定时器驱动）与创建后的机会性拉取，只作用于在 `config.yaml` 的 `catalog.autoPullPatterns` 中声明过的服务商（providerId → 模型 id 的 glob，逗号分隔多模式——与手动拉取路由同一套 DSL）。未出现在映射中的服务商（或映射为空白串）永不被自动拉取；已声明的服务商，其拉取范围受自身 pattern 约束——未声明的聚合网关不再会在每个同步周期被灌入全量上游清单。白名单存放在路由器 config，绝不进定义文件——opencode v2 节点必须保持解码器可读，且拉取行为是路由器行为而非连接定义。`catalog.autoPullModels` 仍是总开关。两道门都是热读取（控制台改后即时生效）。控制台手动拉取不受影响——那里的 pattern 是逐请求参数。sweep 保持 ADD-ONLY：本地维护的定义永不被覆盖。

## Consequences

- 从不同步的客户端**设计上**就看不到新东西：旧的"经 jsonc 即时共享"耦合正是被移除的对象。迁移后 v2 CLI 保有导入的（逐字节相同的）定义，直到写同步物化出更新。
- 自动拉取 opt-in（§7）对既有安装是一次破坏性行为翻转：过去被默默 sweep 的服务商，现在在操作者声明 pattern 前保持不动。这就是预期默认——全量物化本就是 bug；重新武装只需每个服务商一条 `catalog.autoPullPatterns` 条目。
- 每类一个真相自此齐整：`credentials.json`（密钥）· `providers.json`（连接定义）· `catalog/*`（模型+定价）· `opencode.jsonc`（客户端副本）。控制台上每一条"存于 X"的陈述都恰好映射到一个归属文件。
- 清理契约：`rg "upsertProviderDef|getProviderNodeById|opencode\.jsonc" backend/src frontend/src` 必须收敛到同步适配器的物化路径、迁移的一次读取路径与同步面板 i18n 文案。provider-def-opencode-v2-write-routes.test.ts 一族改写到定义库上；boot-direct 测试改为播种定义文件而非 jsonc。
- `onecast-router` 定义节点（客户端钩子写入它，好让客户端解析 `onecast-router/...` 引用）是**普通** catalog 公民：聚合像列举任何定义文件服务商一样列举它。任何地方都**不存在**基于 id 的特例——行为只取决于定义**是什么**，而非它**叫什么**。唯一存在的守卫是自引用检测（`utils/self-url.ts`）：环回主机上网关自身端口上的 baseURL 绝不是合法上游。`buildDirectPool` 在**解析后**的 baseURL 上响亮排除它——在 `{env:...}` 展开之后，正是原始记录检查会漏掉的逃逸路径（`self_loop`——入池会让每条被路由请求递归进网关，ADR-0005 §2 排除并报告教义）；`pullLiveModels` 与 `autoPullProviderModels` sweep 拒绝自拉取（那会把每个可路由模型物化成该服务商的定义）；console 的 provider-create 与 provider-update 都在门口拒绝（409，update 的 baseURL 回退与 upsert 一样落到 `body.baseURL ?? existing.options?.baseURL`）。指向**另一**实例（另一端口/主机）的定义处处放行——合法的联邦上游。catalog 存储（`ocr.json`）版本现为 4（见下方修订案；1–3 已被前史烧毁），版本只单调前进，绝不复用或回退；它存在的意义是当聚合语义在代码层变化时作废全部磁盘快照，因为签名只覆盖 defs/config mtime + 来源定义 + 锁定 id。`/v1/catalog.json` 与 `/v1/models` 照旧呈现注册表构建的 VIRTUAL 服务商——那个平面不受影响。

## 修订案 —— provider 书册统一（providers.json，连接时准入教义）

后续修订彻底消灭了 provider 类别体系。以下逐条列明对前文的覆盖；未被覆盖处前文继续有效。

- **一本书，无类别**。`<ocrHome>/providers.json`（由 `custom-providers.json` 改名而来）是每一个 provider 的唯一 def 真源——内置（从目录连接）与自建中继一律如此。历史遗留的 `catalog/custom.json` 自定义商店退役：它的"纯凭证 provider 落点"存在的前提是内置 provider 没有 defs 节点，这个不对称已消除。**硬切换**——旧书不做迁移，代码直接不再读取（磁盘文件原地保留不动）。操作员升级方式：重启（绑定清扫为每个有凭据的 provider 补节点）后重新拉取/重连：空节点就是**空宇宙**（无目录回落），节点未填充前没有模型会被路由。这个状态是**可见的**、不只留在日志里：节点里没有任何模型的 provider 卡片带一个 `未维护任何模型` 徽章，点开就是模型对话框（拉取/新增）；而 `/models` 是只列已维护模型的面板，其空状态直接给出前往 Provider 页的入口，而不是一条死路。凭据仍在也不会自动恢复路由——只能由操作员显式补模型。
- **defs 节点就是路由宇宙**。`buildDirectPool` 只取 `Object.keys(defs)`——目录列表只是节点的**来源**，绝不是回落池。空节点被排除并上报（`未维护任何模型`），而不是被静默展开回目录。正因如此，`/models`（已维护的物理模型）与 `/v1/models`（同一集合、经按 key 策略过滤）才一致。
- **模型隐藏是 CLIENT 可见性旗标，不是第二套宇宙**。`disabled`（overrides.json，或聚合携带的 def 级旗标——override 优先）把**已维护**模型挡在 boot 池外：重启后 `/v1/models` 不列出它，直接调用也无法命中。控制台各面仍读聚合，因此 `/models` 与聚合目录页照常列出该行并有开关/徽章（可恢复）。池子是 boot 作用域的，该旗标没有热生效。UI 只写 override 这一面——模型表单里的 def 级开关已退役（它读写第二面且无法关回去）。
- **连接时准入教义**。凭据落地（控制台 connect、provider 创建、启动绑定清扫）即确保该 provider 拥有 defs 节点，并从显式覆盖或聚合目录记录播种 effective baseURL——这正是 live `/v1/models` 拉取全 provider 可用的前提（旧 credential-only 类永远没有节点可携带 baseURL）。`ensureConnectedProviderBook`（catalog/auto-pull.ts）随后对空节点一次性自动填充模型：live 优先、静态目录回落、`enrichFromCatalog` 补定价/上下文。播种同样适用于**已存在**的节点：绑定清扫按设计只建裸节点，因此没有 `options.baseURL` 的节点会在下一次 connect/绑定清扫时被补上——否则文档承诺的硬切换恢复动作（重连时不重打 baseURL）会让每个自建中继永久无法 live 拉取。已有模型的节点属操作员所有，绝不重填。填充失败作为响应数据（`modelsFilled`/`fillError`），绝不使 connect 失败。§7 周期清扫的 auto-pull OPT-IN 不变——自建中继仍仅在显式 `autoPullPatterns` 条目或手动 pull 时物化。
- **custom 徽章纯动态、不落盘**。provider 是 custom 当且仅当其 id 未被内置 provider 目录覆盖（聚合第 5 步按 `sources` 是否含 `opencode` | `models-dev` 推导）。旧的 `custom: true` 静态簿记（defs 视图、第 1 步记录）全部移除。
- **模型写入只有一个落点**（provider 自己的节点）：modelsGet/modelAdd/modelUpdate/modelRemove/modelsClear 删除 credential-only 回退分支；pullCatalogModels 无条件写节点；周期清扫对无节点 provider 直接跳过（未连接 → 无处可写，绝不伪造连接）。`modelsManageable` 能力字段随它曾经把守的门一并**从线上移除**：落点唯一之后，可编辑性**就是**存在性（行存在即拥有节点），一个恒为 true 的字段是死接口。
- **绑定清扫检查原始 defs 文件而非归一化视图**。归一化视图会丢弃 retired-shape 节点（Decision 9），只有原始检查能避免把此类节点"复活"为全新可路由节点。retired 节点保持启动时的响亮排除，直到操作员显式迁移（重连即有意重建——密钥刚入 store，无损失）。
- **`ocr.json` 版本 4**：3 被本修订案烧毁（聚合失去了 `custom` 源）；单调递增、永不复用。`custom` CatalogSourceId 随之消失：source 标签永远是配置中该 source 自己的 `src.def.id`，从不硬编码类别，因此退役成员已无生产者。（`catalog.sources[].type: 'custom'` 是另一个概念——用户可配置的模型清单 SOURCE 类型——继续存在。）
- 环境书集（ADR-0007）：`catalog/custom.json` 移出导出集；信封白名单继续**接受**该键（其 checksum 仍校验，被篡改的书集照样拒绝）随后**丢弃**——修订前的书集可导入而不被拒，退役文件绝不写回新环境。
- **控制台按平面分离**。`/models` = 仅已维护的物理模型（defs 支撑的行，可编辑/测试/锁定）；聚合目录移到模型来源页的只读 tab（发现/参考，无维护动作）。虚拟引用（auto/梯队别名、combo、变体）绝不出现在 `/models`——它们有自己的页面，这让"已维护"没有歧义。

## 修订案 —— defs 写入路径加固（2026-12）

在书册统一修订案之后复审，修掉同步契约的四处缺陷。§5 继续有效——本修订案补齐它缺失的不变量。

- **缺失 ≠ 空（物化守卫）**。物化器读**原始** defs 书：文件缺失 / 不可解析 / 版本不符**不等于** `providers: {}`。当客户端槽位非空时**响亮拒绝**（`ok:false`、一条 `failed` 条目、客户端文件逐字节不变）；当客户端槽位为空时是空操作。合法但为空的 defs 书仍然 REPLACE 客户端槽位——那是 def 删除传播，绝不能与"不可读"混为一谈。每次变更都会把同步前的客户端配置复制为 `<config>.bak.ocr-defs`（刷新式，而非仅首次抓取），操作员需要撤销的那次清空永远是紧邻的上一个状态。
- **渲染变了才 reload**。写入路径本身在物化槽位**确实变化**时发起 `POST /api/location/reload`（`materializeDefs` 返回 `changed`；未变化的渲染绝不 reload，因此周期自动写零成本）。未匹配 resolve 的自愈保留，但只作为 reload 失败的回退：仅靠它会让**纯 def** 变更（新增模型、改价/上下文、删除 provider）对运行中的客户端不可见——这些变更之后没有 key 推送，也就永远不会产生未匹配 resolve。CLI 的 setup / teardown / profile 刷新路径走同一个助手函数 reload。结果里携带 `defsMaterialized` / `defsChanged` / `defsReloaded`（控制台 wire 类型同步镜像），"defs 没到客户端"从此可见，而不是静默成功。
- **唯一的配置路径解析器**。候选清单归 `credentials/paths.ts` 所有（`opencodeConfigCandidates` / `resolveOpencodeConfigPath`：`<configDir>/opencode.jsonc` → `<configDir>/opencode.json` → `~/.opencode/opencode.json`，取第一个存在的，jsonc 作为默认写入目标）。一次性端口（读）与物化器（写）都经它解析；此前的实现里，端口读"哪个文件存在就读哪个"，物化器却固定写 `<configDir>/opencode.jsonc`，于是在以 `opencode.json`（或历史 home 路径）为准的机器上，推送落进客户端从不读取的文件却报告成功。候选解析绝不越出注入的路径集（`CredentialPaths.home` 可选），沙箱路径集因此保持封闭。
- **v1 存在性 = v1 证据，而非仅 auth.json**。`v1FlavorActive` = "无 v2 证据（无 db、无 v2 pin）且 有 v1 证据"，v1 证据为已存在的 `auth.json` **或** v1 版本 pin。pin 之所以算数，是因为写入方向在全新 v1 安装上**创建** `auth.json`——要求文件存在会使这条（已有文档描述的）创建分支不可达，干净 v1 机器永远无法播种。
- **retired-shape 判据已更正（实测，2026-12）**。opencode v2.0.0 **不会**丢弃带节点级 `npm`/`options` 的节点：在真实安装上实测，一个 `npm`+`options` 探针节点的模型正常被枚举出来。排除策略保留，但理由换成诚实的那个——retired 的**线上拼写**未被证明被采纳，现实失败模式是"provider 看似注册成功、baseURL/headers 却被忽略"，即静默指错端点，比"没有 provider"更糟。此前"解码器会整节点丢弃（`kind=invalid`）"的说法从未被验证，予以撤回（代码注释与 boot-direct 的排除注释已同步）。
- **漂移可见，绝不靠"同步成功"推断**。状态视图新增 `defsDrift`（opencode-v2）：用**与物化器相同**的比较，把客户端已物化的 `providers` 槽位与定义文件对比，因此徽章永不与一次推送的实际行为相左；同步表渲染"定义未推送"徽章。自动写入默认关闭且两个方向彼此独立，在此之前客户端副本落后与"推送成功"在界面上无法区分。
- **单 provider 运行覆盖两个方向**。同步运行的 `provider` 收窄现在同时作用于拉取与推送（`credential-sync/run` 路由接受可选 `provider`），provider 级手势不会再扫全量书册。
- **产物类别的不对称（记录在案，而非偶然）**。写入方向以 REPLACE 覆盖的类别，绝不允许客户端→OCR 回流：defs 以身份渲染整体替换 `providers` 槽位，唯一的客户端→OCR 定义流动就是一次性 port。写入方向只是**追加**的类别则允许回流：key 是只增/轮换推送，所以只在 OCR 文件里删除的 key 会被下一次拉取重新导入（ADR-0006 修订案）。未来任何推送侧删除都必须与拉取侧 tombstone 同批交付，否则两个方向永久对冲。
- **自动同步与手动同步共用一个内核、两层外壳（记录在案）**。两者都调用同一对 `pullIntoOcr`/`pushFromOcr`，写同一份 `credential-sync.json`；差异是有意的：SUSPECT 只由手动动作抬升（该标志是操作员确认，绝不自动清除），引擎持有在途闸门与 1.5s debounce + 60s 兜底，只有手动运行支持 `provider` 收窄。其中一处后果在此修复：当 `defsChanged === true && defsReloaded === false` 时兜底**也会重试**——此时 key 全部 dedupe（`ok` 读作 true）而客户端还在用旧的服务商列表，除此之外没有任何机制会重试它。

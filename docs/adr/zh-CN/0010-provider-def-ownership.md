# ADR-0010：Provider 定义归属——OCR 定义文件，opencode.jsonc 降级为物化目标

## Status

Implemented — 2026-10-20（阶段：定义库 + 一次性 jsonc 移植；CRUD/boot/视图漏斗换源；先物化后推 key 的同步 REPLACE 语义；CLI 钩子改道）。修订 ADR-0005 §2(a) 的 boot 数据源。2026-10-21 修订：手写 `config.yaml` `providers[]` 配置面退役——定义文件是连接定义的唯一事实源（见 §1）。

## Decision

### 1. 每类工件一个真相——连接定义加入凭证的行列

Provider 的**连接定义**——id、name、npm wire 包、baseURL、headers、env 槽位、canonical/body、节点内静态模型——由 OCR 持有于 `<ocrHome>/custom-providers.json`，GLOBAL（不按环境分账；与 `credentials.json` 同册，ADR-0007 文件约定）。这是**唯一**的用户侧连接定义配置面：早先的手写 `config.yaml` `providers[]` 一节已**退役**（注册表不再读取；config 解析器直接丢弃，原生 System One 直通支路整体退役（ADR-0008 修订；未来 Jev/Bailian 集成以普通定义文件 provider 形式接入），手写 `models[]` 配置面随之一同退役（模型在 boot 时从定义 + 目录物化；`RouterConfig.models` 仅作为运行时载体存在，由 `boot.models` 覆盖））。`opencode.jsonc` **整体退出真相链**：任何 console 路由、boot 路径、视图都不得再把它当真相读写。它是**物化目标**——opencode 同步适配器从定义文件再生的客户端工件，与密钥世界的 `opencode.db`/`auth.json` 完全同构（ADR-0006）。手改的 jsonc 定义不是任何东西的数据源；§4 的一次性导入是唯一存在的 client→OCR 定义流动，永远如此。

### 2. 文件——jsonc providers 节点的保形移植

`custom-providers.json`：`version: 1`，原子 temp+rename，形状 = 现行 jsonc `providers` 节点逐字保形（id → `{ name?, npm?, options: { baseURL?, headers? }, models?, env?, canonical?, body? }`）。`user-config.ts` 的节点解析器（仅 CURRENT shape；`env:[VAR]` 名物化为 `{env:X}` 模板——boot-direct.ts:13,22 正是经这一个漏斗取节点）**不改**：boot-direct 与 console 路由换的是 loader 的**源**，不是语法。与目录层的边界：节点内静态模型跟定义走（同今天 jsonc 节点）；拉取/覆盖模型留在 `catalog/custom.json`（add-only overlay，不动——custom-store.ts:12-14 的优先级原样存活）。

### 3. Boot pool——三源不变，(a) 换人

ADR-0005 §2 改述为：(a) `custom-providers.json` provider 节点，(b) boot 绑定的凭证链（ADR-0006），(c) catalog。失败教义不变：不可路由的 provider 被**排除并上报**，绝不 boot 中止；定义文件不可读 = 响亮的降级徽章（凭证库教义镜像）。池子保持 boot 作用域（ADR-0005 §1——不出现 pool-rebuild 端点）。

### 4. 一次性迁移

boot 时，marker 不存在且 jsonc `providers` 非空 ⇒ 逐字导入定义文件（幂等：按 id 整节点 upsert），完成 marker 记入 `credential-store.json` 账本（standalone-import 模式，factory.ts）。jsonc 在磁盘上**逐字节原样保留**（绝不删除上游工件——cp-dataloss 教义），因此 v2 CLI 在同步物化出更新之前一直保持迁移前的视图。导入失败 = 响亮降级态、扣住 marker、下次 boot 重试。

### 5. 同步契约——key 与定义都推，只写不读

opencode v2 客户端的写方向物化**两类工件**：key（现有 `pushOcrIntoV2`）与定义——用保注释的 jsonc 写器把定义文件渲染进 jsonc 的 `providers` 节点，随后 `POST /api/location/reload` 让运行中的服务注册这些 id（`resolveIntegrationId` 的 reload 自愈路径原样存活）。v2 可写闸门（`declaredProviderIds`）改查**定义文件**，不再查 jsonc。读方向保持仅凭证——定义**绝不** client→OCR 流动。v1 客户端：只推 key，不推定义（legacy 降级面；无定义重写表面）。

### 6. Console 与 UI 去 opencode 化

Provider CRUD 重写到定义库（`upsertCustomProvider`/`getProviderNodeById` 变为定义文件操作）。connected 视图 = 定义文件 ∪ 绑定 store 凭证；网格顺序读定义文件序列（jsonc 顺序随耦合一同消亡）。页面更名为"Provider 管理"；`opencode.jsonc` 字样只允许出现在同步客户端面板内。catalog 无需去耦——models.dev 本就是直连抓取（sources/models-dev.ts），与 opencode 无涉。同一条 connected 并集也治理 catalog 聚合（模型列表）：每个聚合 provider 的 `connected` 并入绑定 store 的凭证存在性（且凭证文件 mtime 参与聚合签名，增删密钥无需重启即触发重建）。聚合只读定义文件——冻结的 auth.json 快照不喂养任何视图；其仅存的读者是凭证层的一次性导入与 v1 同步客户端。

### 7. 自动拉取按服务商 opt-in（`catalog.autoPullPatterns`）

2026-12 修订：周期性模型 sweep（`autoPullProviderModels`，由 catalog 仓库的同步定时器驱动）与创建后的机会性拉取，只作用于在 `config.yaml` 的 `catalog.autoPullPatterns` 中声明过的服务商（providerId → 模型 id 的 glob，逗号分隔多模式——与手动拉取路由同一套 DSL）。未出现在映射中的服务商（或映射为空白串）永不被自动拉取；已声明的服务商，其拉取范围受自身 pattern 约束——未声明的聚合网关不再会在每个同步周期被灌入全量上游清单。白名单存放在路由器 config，绝不进定义文件——opencode v2 节点必须保持解码器可读，且拉取行为是路由器行为而非连接定义。`catalog.autoPullModels` 仍是总开关。两道门都是热读取（控制台改后即时生效）。控制台手动拉取不受影响——那里的 pattern 是逐请求参数。sweep 保持 ADD-ONLY：本地维护的定义永不被覆盖。

## Consequences

- 从不同步的客户端**设计上**就看不到新东西：旧的"经 jsonc 即时共享"耦合正是被移除的对象。迁移后 v2 CLI 保有导入的（逐字节相同的）定义，直到写同步物化出更新。
- 自动拉取 opt-in（§7）对既有安装是一次破坏性行为翻转：过去被默默 sweep 的服务商，现在在操作者声明 pattern 前保持不动。这就是预期默认——全量物化本就是 bug；重新武装只需每个服务商一条 `catalog.autoPullPatterns` 条目。
- 每类一个真相自此齐整：`credentials.json`（密钥）· `custom-providers.json`（连接定义）· `catalog/*`（模型+定价）· `opencode.jsonc`（客户端副本）。控制台上每一条"存于 X"的陈述都恰好映射到一个归属文件。
- 清理契约：`rg "upsertCustomProvider|getProviderNodeById|opencode\.jsonc" backend/src frontend/src` 必须收敛到同步适配器的物化路径、迁移的一次读取路径与同步面板 i18n 文案。provider-def-opencode-v2-write-routes.test.ts 一族改写到定义库上；boot-direct 测试改为播种定义文件而非 jsonc。
- `onecast-router` 定义节点（客户端钩子写入它，好让客户端解析 `onecast-router/...` 引用）是**普通** catalog 公民：聚合像列举任何定义文件服务商一样列举它。任何地方都**不存在**基于 id 的特例——行为只取决于定义**是什么**，而非它**叫什么**。唯一存在的守卫是自引用检测（`utils/self-url.ts`）：环回主机上网关自身端口上的 baseURL 绝不是合法上游。`buildDirectPool` 在**解析后**的 baseURL 上响亮排除它——在 `{env:...}` 展开之后，正是原始记录检查会漏掉的逃逸路径（`self_loop`——入池会让每条被路由请求递归进网关，ADR-0005 §2 排除并报告教义）；`pullLiveModels` 与 `autoPullProviderModels` sweep 拒绝自拉取（那会把每个可路由模型物化成该服务商的定义）；console 的 provider-create 与 provider-update 都在门口拒绝（409，update 的 baseURL 回退与 upsert 一样落到 `body.baseURL ?? existing.options?.baseURL`）。指向**另一**实例（另一端口/主机）的定义处处放行——合法的联邦上游。catalog 存储（`ocr.json`）版本从 3 起步——1 与 2 已被前史烧毁（2 是改名前带 `builtin` 来源 id 的快照），版本只单调前进，绝不复用或回退；它存在的意义是当聚合语义在代码层变化时作废全部磁盘快照，因为签名只覆盖 defs/config mtime + 来源定义 + 锁定 id。`/v1/catalog.json` 与 `/v1/models` 照旧呈现注册表构建的 VIRTUAL 服务商——那个平面不受影响。

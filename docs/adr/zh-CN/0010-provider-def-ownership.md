# ADR-0010：Provider 定义归属——OCR 定义文件，opencode.jsonc 降级为物化目标

## Status

Implemented — 2026-10-20（阶段：定义库 + 一次性 jsonc 移植；CRUD/boot/视图漏斗换源；先物化后推 key 的同步 REPLACE 语义；CLI 钩子改道）。修订 ADR-0005 §2(a) 的 boot 数据源。

## Decision

### 1. 每类工件一个真相——连接定义加入凭证的行列

Provider 的**连接定义**——id、name、npm wire 包、baseURL、headers、env 槽位、canonical/body、节点内静态模型——由 OCR 持有于 `<ocrHome>/custom-providers.json`，GLOBAL（不按环境分账；与 `credentials.json` 同册，ADR-0007 文件约定）。`opencode.jsonc` **整体退出真相链**：任何 console 路由、boot 路径、视图都不得再把它当真相读写。它是**物化目标**——opencode 同步适配器从定义文件再生的客户端工件，与密钥世界的 `opencode.db`/`auth.json` 完全同构（ADR-0006）。手改的 jsonc 定义不是任何东西的数据源；§4 的一次性导入是唯一存在的 client→OCR 定义流动，永远如此。

### 2. 文件——jsonc providers 节点的保形移植

`custom-providers.json`：`version: 1`，原子 temp+rename，形状 = 现行 jsonc `providers` 节点逐字保形（id → `{ name?, npm?, options: { baseURL?, headers? }, models?, env?, canonical?, body? }`）。`user-config.ts` 的节点解析器（仅 CURRENT shape；`env:[VAR]` 名物化为 `{env:X}` 模板——boot-direct.ts:13,22 正是经这一个漏斗取节点）**不改**：boot-direct 与 console 路由换的是 loader 的**源**，不是语法。与目录层的边界：节点内静态模型跟定义走（同今天 jsonc 节点）；拉取/覆盖模型留在 `catalog/custom.json`（add-only overlay，不动——custom-store.ts:12-14 的优先级原样存活）。

### 3. Boot pool——三源不变，(a) 换人

ADR-0005 §2 改述为：(a) `custom-providers.json` provider 节点，(b) boot 绑定的凭证链（ADR-0006），(c) catalog。失败教义不变：不可路由的 provider 被**排除并上报**，绝不 boot 中止；定义文件不可读 = 响亮的降级徽章（凭证库教义镜像）。池子保持 boot 作用域（ADR-0005 §1——不出现 pool-rebuild 端点）。

### 4. 一次性迁移

boot 时，marker 不存在且 jsonc `providers` 非空 ⇒ 逐字导入定义文件（幂等：按 id 整节点 upsert），完成 marker 记入 `credential-store.json` 账本（standalone-import 模式，factory.ts）。jsonc 在磁盘上**逐字节原样保留**（绝不删除上游工件——cp-dataloss 教义），因此 v2 CLI 在同步物化出更新之前一直保持迁移前的视图。导入失败 = 响亮降级态、扣住 marker、下次 boot 重试。

### 5. 同步契约——key 与定义都推，只写不读

opencode v2 客户端的写方向物化**两类工件**：key（现有 `pushOcrIntoV2`）与定义——用保注释的 jsonc 写器把定义文件渲染进 jsonc 的 `providers` 节点，随后 `POST /api/location/reload` 让运行中的服务注册这些 id（`resolveIntegrationId` 的 reload 自愈路径原样存活）。v2 可写闸门（`declaredProviderIds`）改查**定义文件**，不再查 jsonc。读方向保持仅凭证——定义**绝不** client→OCR 流动。v1 客户端：只推 key，不推定义（legacy 降级面；无定义重写表面）。

### 6. Console 与 UI 去 opencode 化

Provider CRUD 重写到定义库（`upsertCustomProvider`/`getProviderNodeById` 变为定义文件操作）。connected 视图 = 定义文件 ∪ 绑定 store 凭证；网格顺序读定义文件序列（jsonc 顺序随耦合一同消亡）。页面更名为"Provider 管理"；`opencode.jsonc` 字样只允许出现在同步客户端面板内。catalog 无需去耦——models.dev 本就是直连抓取（sources/models-dev.ts），与 opencode 无涉。

## Consequences

- 从不同步的客户端**设计上**就看不到新东西：旧的"经 jsonc 即时共享"耦合正是被移除的对象。迁移后 v2 CLI 保有导入的（逐字节相同的）定义，直到写同步物化出更新。
- 每类一个真相自此齐整：`credentials.json`（密钥）· `custom-providers.json`（连接定义）· `catalog/*`（模型+定价）· `opencode.jsonc`（客户端副本）。控制台上每一条"存于 X"的陈述都恰好映射到一个归属文件。
- 清理契约：`rg "upsertCustomProvider|getProviderNodeById|opencode\.jsonc" backend/src frontend/src` 必须收敛到同步适配器的物化路径、迁移的一次读取路径与同步面板 i18n 文案。provider-def-opencode-v2-write-routes.test.ts 一族改写到定义库上；boot-direct 测试改为播种定义文件而非 jsonc。

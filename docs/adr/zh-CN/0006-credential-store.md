# ADR-0006: 凭证存储——OCR 文件是唯一真相；opencode v2 是同步客户端

## 状态

已实现 — 2026-10-19（凭证同步重写）。取代 2026-10-15 的「能力旗标后的两个适配器 + 仅推式收敛」绑定模型：启动不再**选择** store，opencode v2 不再是另一份凭证真相，旧 reconcile/push 的单一真相语义退役。范围：凭证住在哪儿、网关如何读写、什么状态挂在密钥上、凭证如何向各客户端传播。消费方：启动链 = ADR-0005；熔断/亲和锚定 = ADR-0004/0002；额度探测 = ADR-0009。

## 决策

### 1. 唯一被绑定的 store——永远是 OcrStore

`<ocrHome>/credentials.json` 是唯一凭证真相。`bindCredentialStore` 不做任何选择：没有 CLI 探测、没有版本证据阶梯、没有 last-known-good 滞回、没有惰性升级。工厂是全函数，落到 OcrStore 且 `degradedCode: null`；唯一带徽标的落点是 `bind_failed`（意外崩溃）。`VersionEvidence` 只记录 `installed.version` 内容作诊断（`cli` 恒为 null，不选择任何东西）。`StoreKind` 保留 `'opencode-v2' | 'opencode-v2-readonly' | 'ocr'`——这些标签现在描述的是**同步客户端**的适配器，永远不是被绑定的 store。能力旗标规则不变：调用方按 `capabilities` 分支、永不按 `kind`；裸密钥依旧只从 `resolveKey/resolveKeyChain`（启动/池/同步消费者）、`revealKey`（密码门控路线）与同步引擎自己的 HTTP 写三处离开。

### 2. auth.json——v1 的凭证文件：导入源、可选的同步目标、永不是管理写入的汇

独立一次性导入（marker 记于 `<ocrHome>/credential-store.json` 的 `standaloneImport`，keyHash 去重，oauth/wellknown 仅列出并打徽标，导入本身不动 auth.json）如今在**所有**落点上运行——包括 v2 机器。auth.json 时代的遗留密钥并入 OCR 文件：这正是已退役 reconcile 做过的数据迁移，改指向新的真相。

auth.json 依旧永不是管理写入的汇（控制台凭证写永不触碰它）。唯一的写入者是 opencode-v1 同步客户端——且仅在操作者开启开关或显式手动运行时（§4），并且只在 v1 味道的机器上。

### 3. 一次性 v2 迁移——翻转时的路由连续性

密钥只存在于 opencode v2 db 的机器，在池改为只读 OCR 文件时不能丢路由。`maybeRunV2Migration`（启动时、`buildDirectPool` 之前）把 v2 db 中所有可路由 api 密钥拉进 OCR 文件一次；marker（`credential-sync.json` 的 `migration`）记录 `doneAt/pulled/deduped`。任何失败条目或 db 不可读都扣留 marker → 下次启动重试（去重保证幂等）。db 不存在的机器零成本跳过、不写 marker（之后装了 opencode 也会在后续启动被迁移）。v1 方向不需要一次性迁移：独立导入覆盖首启，持续拉取覆盖其余。

### 4. 凭证同步——按客户端传播（`credentials/sync.ts`）

表格默认就有两个客户端，开关全部默认关闭（启用前仅手动）：

- **opencode-v2**：
  - **读（拉取）**：v2 db（只读 sqlite）→ OCR 文件。只取可路由 api 行；oauth/wellknown 永不出客户端。keyHash 去重使重跑为零操作。
  - **写（推送）**：OCR 文件 → v2 托管服务 HTTP API（`connectKey`；服务发现与目标策略 `loopback | remote_tls | insecure_remote` 拒绝不变）。去重键为（provider 大小写不敏感 × keyHash 前缀）对活 db。
- **opencode-v1**（legacy auth.json 味道）：
  - **读（拉取）**：auth.json 的 api 条目 → OCR 文件；oauth/wellknown 永不过界；畸形条目响亮失败。该客户端只存在于 **v1 味道**的机器——auth.json 存在且**没有** v2 证据（无 `opencode.db`、无 v2 版本钉）：在 v2 机器上 auth.json 按定义是一份过期的一次性迁移快照，永不被拉取或写入。
  - **写（推送）**：把每个本地 provider 的链首 api 密钥合并进 auth.json——每 provider 一把密钥（v1 文件形状；活跃链首优先）、仅 api 形状条目（已有的 oauth/wellknown 条目原样保留并记为 `skipped`）、无删除传播、无法解析的 auth.json 拒绝合并而非覆写。客户端不存在的机器上绝不凭空捏造该文件。

两个客户端共用的写方向不变式：**本地 OCR 条目永远保留**——推送让客户端向 OCR 文件收敛，绝不反向；与单一真相模型配套的「验证收敛后删除本地副本」行为一并退役。

### 5. 自动同步——开关、实时推送、轮询拉取、自愈

状态在 `<ocrHome>/credential-sync.json`（`{version:1, clients:{<id>:{autoRead,autoWrite,lastReadAt,lastWriteAt,lastRead,lastWrite}}, migration}`）。仅展示安全内容——时间戳、开关、脱敏的逐条记录；绝无密钥材料。

- `autoWrite` 开：每次成功的 OCR 变更（connect/activate/rename/disconnect，经 `OcrStore` 变更钩子）为**每一个**开启开关的客户端排定一次防抖推送（约 1.5s）。60s 轮询 tick 是兜底：失败或从未执行的写（变更时服务不可用）会重试，直到记录到 ok 结果。
- `autoRead` 开：60s 轮询把客户端新密钥拉进 OCR 文件。
- 开关按客户端独立、在**触发时**检查（防抖期间关掉即跳过）；全关 = 仅手动。手动运行（`run` 路由）对单个客户端执行任一或两个方向，结果与自动路径一样入档。

### 6. 凭证身份（不变）

sha256(rawKey) 是持久身份；界面只见 12 字符前缀。熔断对、SUSPECT/DISABLED 标记、会话亲和与额度快照都锚定 `(provider × keyHashPrefix)`。每个写同步收敛对（推送或已有）都是一次重连手势，解除该凭证 SUSPECT；DISABLED 刻意存续。

### 7. OAuth 边界（不变）

没有任何 store 声明 OAuth。oauth/wellknown 行只列出并打徽标：不路由、不导入、不推送、不拉取；reveal 拒绝无裸 api 密钥材料的行。

### 8. 启动与控制台表面

启动顺序：绑定 store（OcrStore）→ `initCredentialSync`（迁移一次性 + 自动定时器 + 变更钩子）→ `buildDirectPool`。控制台：`GET /credential-store`（状态；`kind` 恒为 `'ocr'`；`integrations` 字段移除——被绑定 store 不按 integration 定址）；密钥作为**一整册**处理，因此没有按 provider 的独立推送端点：唯一的写入口是 `POST /credential-sync/run` 且 `direction: write`（可选 `provider` 收窄；本地保留，结果入档）；另有 `GET /credential-sync`（表格数据）、`POST /credential-sync/toggle`。reveal 的四道硬闸不变。

### 9. 退役

reconcile 闸（auth.json→v2 推送 + `authWriteDisabled` marker——被 §2 导入 + §4 写同步取代）、CLI 版本探测 + 滞回 + 惰性升级循环、`not_ocr_bound` 前置拒绝、只读变体的路由表面（被绑定 store 发出的 409 `store_readonly` 不可达；适配器内部只读变体仍服务同步侧读取）、以及启动时的 CLI 子进程（启动对 opencode 零耦合）。旧 `credential-store.json` 的 reconcile 块仍可读（加法式容忍），但不再写入。

## 后果

- 管理面写入永不依赖 opencode：opencode 缺席、停止或损坏时控制台照常工作。
- 控制台新增的密钥只有经过一次写同步才会到达 opencode——开启自动则自动发生，否则需要显式操作。凭证同步表格让这种传播可见，而非隐式。
- `OpencodeV2Store` 作为同步引擎的工具被完整测试（拉取用读、推送用带验证的 HTTP 写、二级服务发现不变）；它的路由级 v2 行为（integration 不匹配 409、只读拒绝、视图失效）不再从控制台可达，相应路由测试随行为一并退役。
- 测试：`credentials-sync`（引擎 + 推送保留本地契约）、`credentials-factory`（唯一落点 + 全函数）、`credentials-console-routes`（路由 × OCR 文件）、`boot-direct-credential-store`（OCR 文件启动），以及契约不变的 `credentials-leak-surfaces` / `credentials-reveal-route` / `credentials-standalone-import` / `credentials-opencode-v2-*` 适配器套件。

## 修订案 —— key 删除永不传播（因此拉取会重新导入）

两个客户端的写入方向都是**只增/轮换**：v2 逐个 `connectKey`，从不调用删除路由；v1 按 provider 合并链头 api key，从不移除 provider 节点。后果直说：**只在 OCR 文件里删除的凭证，会在下一次读同步（手动或自动读轮询）时被重新导入**，只要客户端仍持有它。这是读方向的契约——pull 导入客户端持有的东西，而 store 不保留"这是操作员有意删除"的记忆，所以"客户端有一把 OCR 没有的 key"与"操作员刚删掉那把 key"在观测上是同一件事。操作规则：**要让删除生效，必须在客户端侧一并删除**（控制台的拉取按钮提示已写明这一点）。

**控制台的 DELETE 是吊销（revocation），不是本地清理**，因此复用上面已有的机制，而不是再造一本账：

- 删除 OCR 行（store 的 `disconnect`）；
- 把该 key **材料**以 DISABLED 锚定进现有的 keyHash 锚定 takedown 账本（`reason: 'deleted'`），于是拉取再次导入时该行是**停用回归**——绝不直接可路由，有徽章、一键恢复。已经被停用的 key 材料保留它自己的备注：该标记的另一半（`disabledAt`）按设计保留，删除不得把操作员的审计文字洗成 `'deleted'`；这就是拉取侧 tombstone；另立一个 `(provider × keyHashPrefix)` 文件只会重复一本生命周期已经吻合的账（"在操作员抬升之前，跨过每一次重连都保持"）；
- 同时删除客户端副本（v2 的 `DELETE /api/credential/:id`，按 `keyHashPrefix` 精确匹配一行，绝不做集合 diff），因为 opencode 用它自己的 db 路由，只删 OCR 拦不住它。v1 没有按 id 的删除（纯文件里一个 provider 一把 key），返回 `unsupported`；响应逐目标报告客户端那一半，控制台如实展示，而不是假装"干净吊销"。`?clientRevoke=0` 可关闭客户端那一半（只退役 OCR 行）。

对未来工作的约束：**仍然禁止**做"把删除镜像进客户端"的全量对账——OCR 书不可读或降级时那会读成"把客户端删空"。删除永远由操作员发起、且一次只针对一把 key 材料。

### v1 客户端 —— 已验证范围

v1 适配器是**fixture 级验证，不是二进制级验证**：参考机上只装了 v2，没有 opencode v1。测试套件确定性地钉住的是：

- 写出的文件保持 v1 形状（每 provider 一条 `api` 条目，`<dataDir>/auth.json`，0600 best-effort），并且**逐字保留不属于我们的一切**——其他 provider 的条目、被重写条目上的未知字段（`account_id` 以及将来新增字段）、`oauth`/`wellknown` 条目原样不动并报告为 `skipped`；
- 每次真正写入前把原文件保留为 `auth.json.bak.ocr`（不写入则不备份），rename 走 `atomicWriteWithRetry`（Windows 上被占用进程挡住时的 EPERM/EBUSY 会重试，而不是判推送失败）；
- 存在性：v1 证据 = 已存在的 `auth.json` **或** v1 `installed.version` pin，且在带 v2 证据的机器上一律不生效。

**没有 v1 二进制就无法验证、因此不得声称已证**的部分：真实 v1 运行时会接受合并后的文件；Windows 上 0600 的意图是否被遵守/忽略；v1 是否真的从 `auth.json` 路由（两个方向的前提）；纯 v1 机器上是否存在 `installed.version`（既无 pin 又无 `auth.json` 时读作 absent —— 适配器保持惰性，而不是猜）。字段词汇已与安装在机上的 v2 二进制里内嵌的 v1 导入器字符串交叉核对（`account_id`、`methodID`、`wellknown`、`integration_id`）——这是证据，不是证明。

## 修订案 —— 凭证同步中的链头权威

写方向本来就是按 provider 推送**整条链**（v1 因文件形状只推链头）。之前未处理的是客户端**用哪把 key 路由**：opencode v2 会把新连入的凭证置为 ACTIVE（2.0.15 实测——加第二把 key 会把正在工作的行降级），而凭证层面除了 `active` 没有任何顺序字段。现在这条边界由三条规则约束：

- **推送恢复 OCR 链头。** 一个 provider 的 key 落齐之后，只要客户端的 active 行与 OCR 链头（按 `keyHashPrefix` 匹配）不一致，写路径就把它重新激活。每次推送都执行（全 dedup 的推送也算），所以客户端 active 漂移会被自愈；本来就正确时只多一次视图读取、不发 HTTP 请求。这是控制台 connect 路由 `headPreserved` 防护在同步路径上的镜像——没有它，推送一把新加的**备选** key 会在 OCR 仍路由链头的情况下悄悄把 opencode 指向那把 key。
- **拉取永不覆盖 OCR 链头。** OCR 文件是唯一真相，拉取是只增的，所以客户端侧的一次激活不能把链头降级；否则在 auto-write 关闭时，一次拉取就会把操作员"设为链头"的操作抹掉（本 ADR 在别处明确拒绝的双向互斗）。客户端链头只填**空缺**：某 provider 的 OCR 行全部失去 active 标记（链头行被断开）时，采纳客户端链头，而不是让路由退化成按最近更新时间挑。
- **非 active 备选之间的相对顺序**不同步，这是刻意的。v2 不暴露顺序字段（行按 `active DESC, time_updated DESC` 读取），拉取又用拉取时刻给导入行打时间戳，所以客户端的备选先后不会在 OCR 文件里复现，反向亦然。跨边界的权威只有 ACTIVE 链头；备选之间的顺序是客户端本地的读取顺序，不是路由契约。要改这一点需要在 OCR 侧引入真正的顺序表示（schema 版本升级），而不是继续玩时间戳。

测试：`credentials-sync` 两个方向都钉住了——推备选不会抢链头、全 dedup 的推送会治愈漂移的链头、拉取保留已有 OCR 链头、只有当 OCR 链没有 active 行时才采纳客户端链头。

## 修订——凭证链热刷新（2026-10-28）

路由链（`registry.credentialChains`）过去是**仅启动时**的快照：`buildDirectPool` → `registerProvider` 是唯一写入点，因此通过控制台加入的凭证（connect / activate / disconnect）或由凭证同步落地的 key，在下一次网关重启前对 `pipeline/credential-selection.ts` 不可见。多凭证 provider 的新会话散布会一直塌缩到启动时的链上——运营表现就是「所有请求永远用第一把凭证」——因为选择器看到 `chain.length === 1` 而退化为链头。

链现在是**热的**：`registry.refreshCredentialChain(name, chain)` 整体换入条目（Bun 单线程下 Map 写入原子；在途请求继续用旧数组引用服务），并在每个 store 变更缝隙被调用：

- 控制台 **connect**（`connectKeyIdempotent`——覆盖 create / setKey / connect 路由），
- 控制台 **activate**（链会**重排**——链头 = active 行），
- 控制台 **disconnect**（被移除的 key 立即离开运行时链），
- **凭证同步运行**（一次拉取可能在多个 provider 上落 key；刷新所有已连接 provider 的链）。

操作员 disable/enable 刻意**不是**重建触发器：被禁用的行保留在链里，由选择期的 `isPairOut` 过滤（下架优先于一切运行时信号；链成员资格与此正交）。空链会删除条目——provider 退化到链头烘焙路径（`config.apiKey`），保持链头 === 烘焙 key 的不变式。

RAW key 仍然只在注册表内存中（永不序列化）。重建时的 store 读取失败被吞掉——旧链继续服务（fail-open）。`console.ts` 里「重复 connect 会增长链」的陈旧描述对应一个已不存在的机制；那里的 dedup 保护的是 store 的 keyHash 身份，不是链长。

测试：`credentials-console-routes` 钉住热路径——connect 让运行时链增长、activate 重排链头、disconnect 移除该行，全程无需重启。

## 修订——单凭证散布权重（2026-10-29）

确定性新会话散布（ADR-0002 §4）过去给每条健康行相等的哈希槽。额度不对等的操作员（一把 key 的日额度是另一把的 5 倍）没有任何杠杆：分摊永远是 1/N。凭证现可携带可选整数 `weight`（>= 1，缺省 = 1，上限 `CREDENTIAL_WEIGHT_MAX` = 100——单源在 `backend/src/config/defaults.ts`，镜像于 `frontend/src/lib/defaults.ts`）。

- **归属**：权重只存在 OCR 文件里（`OcrCredential.weight`，随 schema version 2 保存）。opencode v2 服务除 `active` 外没有权重/顺序字段，v2 绑定的行恒为权重 1：`capabilities.weight` 在 OCR store 为 `true`、在 `OpencodeV2Store` 为 `false`，绑定 store 无该能力时控制台路由以 400 `capability_unsupported` 拒绝（与 reorder 门同款）。权重两个方向都不过同步边界——push/pull 的头权威规则不变。
- **操作面**：`POST …/providers/:id/credentials/:credentialId/weight`，body `{ weight }`；路由校验 `[1, CREDENTIAL_WEIGHT_MAX]` 整数（否则 400 `invalid_weight`），store 写时再次收敛，读路径对手改文件消毒（0/负数/非数值退化为缺省，分数取整——坏值永远进不了散布）。控制台 Keys 页在单 provider 凭证放大弹框里编辑权重；卡片行只读显示 `×N` 徽标。
- **落位语义**：`weightedSpreadIndex` 用同一个 sha256(sessionId) 抽槽，落在 `[0, Σweights)`，按权重前缀和走——权重 w 占 w 个连续槽。全 1 权重与原落位逐一相等（total === count），存量会话落点不变。权重只塑形**新会话散布**：强制故障转移落点仍按链序，keep/亲和规则不读它，棘轮不碰（ADR-0011 覆盖纪律）。
- **热链**：权重走 `CallCredential.weight` 全链路（`resolveKeyChain` → 启动/`refreshProviderCredentialChain`），设权重后下一次落位即生效，无需重启。

测试：`credential-selection.test.ts` 钉住加权散布（全 1 向后兼容、槽位映射、比例冒烟、故障转移链序优先）；`credentials-ocr-store.test.ts` 钉住 set/clamp/消毒与链/meta 透传；`credentials-console-routes.test.ts` 钉住路由（200 形态、非法 body 400、未知 id 404、仅掩码线上契约）。

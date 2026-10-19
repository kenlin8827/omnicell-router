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

### 6. 账号身份（不变）

sha256(rawKey) 是持久身份；界面只见 12 字符前缀。熔断对、SUSPECT/DISABLED 标记、会话亲和与额度快照都锚定 `(provider × keyHashPrefix)`。每个写同步收敛对（推送或已有）都是一次重连手势，解除该账号 SUSPECT；DISABLED 刻意存续。

### 7. OAuth 边界（不变）

没有任何 store 声明 OAuth。oauth/wellknown 行只列出并打徽标：不路由、不导入、不推送、不拉取；reveal 拒绝无裸 api 密钥材料的行。

### 8. 启动与控制台表面

启动顺序：绑定 store（OcrStore）→ `initCredentialSync`（迁移一次性 + 自动定时器 + 变更钩子）→ `buildDirectPool`。控制台：`GET /credential-store`（状态；`kind` 恒为 `'ocr'`；`integrations` 字段移除——被绑定 store 不按 integration 定址）；`POST /credential-store/push` 即按 provider 的写同步（本地保留，结果入档）；新增 `GET /credential-sync`（表格数据）、`POST /credential-sync/toggle`、`POST /credential-sync/run`。reveal 的四道硬闸不变。

### 9. 退役

reconcile 闸（auth.json→v2 推送 + `authWriteDisabled` marker——被 §2 导入 + §4 写同步取代）、CLI 版本探测 + 滞回 + 惰性升级循环、`not_ocr_bound` 前置拒绝、只读变体的路由表面（被绑定 store 发出的 409 `store_readonly` 不可达；适配器内部只读变体仍服务同步侧读取）、以及启动时的 CLI 子进程（启动对 opencode 零耦合）。旧 `credential-store.json` 的 reconcile 块仍可读（加法式容忍），但不再写入。

## 后果

- 管理面写入永不依赖 opencode：opencode 缺席、停止或损坏时控制台照常工作。
- 控制台新增的密钥只有经过一次写同步才会到达 opencode——开启自动则自动发生，否则需要显式操作。凭证同步表格让这种传播可见，而非隐式。
- `OpencodeV2Store` 作为同步引擎的工具被完整测试（拉取用读、推送用带验证的 HTTP 写、二级服务发现不变）；它的路由级 v2 行为（integration 不匹配 409、只读拒绝、视图失效）不再从控制台可达，相应路由测试随行为一并退役。
- 测试：`credentials-sync`（引擎）、`credentials-factory`（唯一落点 + 全函数）、`credentials-console-routes`（路由 × OCR 文件）、`credentials-push-endpoint`（保留本地）、`boot-direct-credential-store`（OCR 文件启动），以及契约不变的 `credentials-leak-surfaces` / `credentials-reveal-route` / `credentials-standalone-import` / `credentials-opencode-v2-*` 适配器套件。

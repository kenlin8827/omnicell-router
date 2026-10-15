# ADR-0006: 凭证存储——能力旗标后的两个适配器、以密钥哈希锚定的身份、仅推式收敛

## 状态

已实现 — 2026-10-15（事实面语料重写）。范围：凭证住在哪儿、网关如何读写、什么状态挂在密钥上、哪些写路径被说不。消费方：启动链 = ADR-0005；熔断/亲和锚定 = ADR-0004/0002。

开篇事实勘误：历史语料描述过三个 store（含 "OpencodeV1Store"）。该形状已不存在：`StoreKind = 'opencode-v2' | 'opencode-v2-readonly' | 'ocr'`（`credentials/types.ts:23`）——**两个适配器加一个只读变体**；`auth.json` 是只读的一次性迁移/导入源，从来不是活 store。

## 决策

### 1. 一个带能力旗标的接口；按能力分支，永不按 kind 分支

`CredentialStore`：`probe / listAccounts / resolveKey / resolveKeyChain / revealKey / connectKey / activate / rename / disconnect / beginOAuth / completeOAuth / listIntegrationIds? / invalidate? / accountsOverview?`（`types.ts:164-219`），门面 `StoreCapabilities = {multiAccount, activate, rename, oauth, envVisible, integrationScoped}`（`:30-55`）。硬规则：调用方按 `capabilities` 分支，**永不**按 `kind`（`:10-11,22-23`）。类型化失败词汇（`StoreUnreadable / EmptyCredentialTable / CapabilityUnsupported / WriteFailed / IntegrationUnmatched / AccountNotFound`）；原型污染型 provider id 被拒（`RESERVED_PROVIDER_IDS`）。裸密钥离开 store 只有四道门：`resolveKey/resolveKeyChain`（仅启动/池消费者）、`revealKey`（密码门控的控制台路线）、store 自己的 HTTP 写，以及——没有别的。

### 2. OpencodeV2Store——SQLite 只读、HTTP 独写、目标策略收紧

- 读：`bun:sqlite` **readonly** 打开 `<dataDir>/opencode.db`（表 `credential`，必需列校验，缺列 = 响亮 `schema_mismatch`）；**永不**写库——"不得改库管理凭证"是上游的明文规矩，从违（`opencode-v2-store.ts:30-31,49-73`）。视图缓存 60s + `invalidate()`；空表 = 类型化 `EmptyCredentialTableError`。
- 写：纯托管服务 HTTP——`POST /api/integration/{id}/connect/key`、`POST /api/credential/{id}/activate`、`PATCH /api/credential/{id}`、`DELETE /api/credential/{id}`、`GET /api/integration`，外加 `POST /api/location/reload` 作未知 integration id 的**自愈**。集合式 `GET/POST /api/credential` 刻意不用（实测构建上 404——经验之谈，注在 API 表 `:82-84`）。`connectKey` **验证落库**（轮询 sqlite 找新行、重试一次；绝不伪造 synthetic-id 成功）。
- 服务发现：`OPENCODE_SERVER_URL`/`OPENCODE_SERVER_PASSWORD` 或 `service.json`；Basic auth；**目标策略 `loopback | remote_tls | insecure_remote`**——非回环明文 HTTP 在 fetch 之前拒绝，无 opt-in 旋钮（`:169-177,827-831`）。
- 只读变体（`db-present` 证据但无 CLI 可写）：读全同、含本地 `revealKey`；一切写抛 `CapabilityUnsupportedError('…','cli-absent-db-present')` → 控制台映射 409 `store_readonly`。

### 3. OcrStore——独立/降级两用的本地 store

`<ocrHome>/credentials.json`——刻意**全局**（熬得过环境更迭；对照断路器记忆的按环境制，ADR-0004 §5）。`{version:1, providers:{id:[...]}}`，原子 temp+rename 0600，首 key 默认 active，空 provider 整键剪除。在没有 opencode 的机器上是**常态主 store（无任何降级挂牌）**——factory 在此不打折；此外才是响亮 fallback store（`degradedCode: db_unreadable | unsupported_version`）。它没有 auth.json 写路径，永远没有。

### 4. auth.json——导入源，永不是汇

`AuthSnapshot.read()` 而已（`auth-snapshot.ts`）：opencode v2 在自身 db 迁移时一次性导入该文件且永不写回 ⇒ 在 v2 机器上 auth.json **定义上**就是陈旧快照。后果链：v2 store 不可读 ⇒ 降级 OcrStore + 挂牌 + 逐 provider 排除报告——回落 auth.json 会静默路由陈旧凭证（被禁）；OCR 永不写 auth.json；独立导入（见下）保持源文件字节不变。

### 5. Factory——证据阶梯、每启动粘滞绑定、永不炸启动

`bindCredentialStoreOnce` 证据优先级（`factory.ts:500-541`）：① CLI `opencode --version` ② `installed.version` **内容**解析（文件存在本身绝不选 store）③ `last-known-good` 迟滞（PATH 抖动不得在生命周期内来回换 store）④ `db-present`（CLI 缺席但 db 存在——这本身就是 opencode 证据）⑤ none。`isV2 = db-present ∨ major ≥ 2`；`writable = 有 CLI 证据`（db-present ⇒ 只读变体）。检出 v1 ⇒ 不支持 ⇒ OcrStore + 挂牌 + 一次性**独立 auth.json 导入**（仅 type:api，oauth/wellknown 列而不导、源不动、失败条目留手待下次启动重试）。完全没有 opencode ⇒ OcrStore 静默常态。绑定崩溃 ⇒ OcrStore + `bind_failed` 挂牌——`bindCredentialStore` 全函数永不 reject。绑定每启动一次、进程内粘滞（重启再探）。持久态：`<ocrHome>/credential-store.json`（`{bound, version, evidence, degradedCode, reconcile?, standaloneImport?}`，原子写、Windows-EPERM 退避重试）。

### 6. 仅推式收敛——"单真源"的操作化

- **Reconcile**（store-backed 读翻转**之前**）：可写 v2 首次绑定且无完成标记 ⇒ 把 auth.json-only 的 `type:api` 密钥经 `connectKey` 推入 v2 db——大小写不敏感的 provider × keyHash 去重、**哈希为主 label 为辅**、oauth 形永不推；门查能力（`envVisible ∧ activate` 即可写 v2 的签名——readonly 推不动，门会**等**可写绑定）；auth.json 永不修改/删除（`reconcile.ts`）。完成即写标记并置 `authWriteDisabled:true`——**部分推送失败也照置**（反回归："此机器不再有 auth.json 写入"；标记写失败有进程内 override 兜底）。
- **Push**（恢复收敛，`push.ts`，路线 `POST /api/admin/credential-store/push`）：OcrStore 绑定机恢复 opencode ⇒ 本条目单向复制进 v2；本地行仅在**验证收敛**后删除（失败保本地）；收敛的 `(provider, keyHashPrefix)` 账号清 SUSPECT（DISABLED 刻意保留）。
- **写纪律**："读侧降级许以挂牌；写侧增殖一概拒绝"——任何地方没有 fallback 分支：`WriteFailedError`→502 `write_failed`、`CapabilityUnsupportedError`→409 `store_readonly`（`console.ts:408-434`）。控制台加 key 幂等（同 keyHash ⇒ `deduped:true`，旧 head 除非 suspect/disabled 保持原位）。

### 7. 账号身份 = sha256(rawKey)，显示安全前缀

`sha256KeyHash` + `keyHashPrefix(rawKey, 12)`（`types.ts:287-295`）：**密钥哈希即持久身份**——熬过 label 编辑、凭证行 id 更迭、provider 改名；UI 只见 12 字符安全前缀，密钥材料永不出面。以此锚定的状态：pair 断路器 `(model × prefix)`、SUSPECT/DISABLED 旗标 `(provider × prefix)`（生命周期相反，ADR-0004 §3/§5）、会话亲和绑定（ADR-0002）、按账号健康/限流主体。`disconnect` 尊重显式 DELETE（不可逆的双重确认在**控制台 UI**，不在后端）；删除前捕获的锚用于清该账号 SUSPECT，其 DISABLED 旗标刻意存续——同一把 key 回来时，下架仍然作数。

### 8. OAuth 边界

没有任何 store 声称 OAuth（`oauth:false`，`begin/completeOAuth` 抛错）；oauth/wellknown 行列示挂牌、永不路由、永不 reconcile/import/push；reveal 对无裸 api-key 材料的行说不。OAuth 凭证生命周期归上游服务——网关绕开它，绝不穿过它。

### 9. 启动与控制台表面

启动序：绑 store → 状态 → `ensureReconciled` → `buildDirectPool`（链以进程内裸 key 注册，ADR-0005）。控制台：掩码 `AccountMeta` + `AccountHealth` 叠层（suspect / openPairs / cooldown / disabled+reason / limits）附着在**每一个**返回账号的写响应上；store 状态路线给出能力、降级码、reconcile 审计、integrations（scoped 时）。Reveal 路线四道硬闸：webAuth 激活、共享爆破桶、密码先验后触 store、仅 api-key 行。前端 `api.ts` 与这些 wire 名 1:1 镜像（仓库约定）。

## 后果

- 凭证状态机可读而无可写歧路；每个收敛方向都是单向经验证的，密钥不可能跨 store 静默增殖。
- 身份锚在密钥材料（而非 id/label）上，使熔断/嫌疑/亲和历史熬得过上游更迭。
- 测试：`credentials*`、`user-config*`、factory/reconcile/push 各套件、`guardrails*`。

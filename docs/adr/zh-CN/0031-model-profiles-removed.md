# ADR-0031 — 移除模型方案机制：直接行 + 智能分配即全部

- **状态:** 已实施
- **日期:** 2026-11-15
- **取代:** 模型方案的全部表面（config `routing.modelProfiles`、控制台 `/model-profiles` 页、客户端方案挂接及其回写）
- **关联:** [ADR-0003](../0003-model-addressing-and-tier-membership.md)（模型编址——方案从不参与路由）、[ADR-0016](../0016-config-schema-evolution.md)（v1→v2 迁移）、[ADR-0026](../0026-mitm-canonical-seam.md)（先例：删除而非废弃）

## 背景

模型方案是一张 config 里的「槽位 → modelRef」命名表。客户端挂接一个方案后，把各 agent/subagent 绑定到槽位键，一次应用即把解析出的 modelRef 写入客户端自身配置；之后保存方案会重新解析并回写所有已关联槽位的行（write-through），手动 pin 的行不受影响。方案从不参与路由——网关在请求时从不解析方案 id。

线上数据一锤定音：所有观察到的部署里 `modelProfiles` 都是 `[]`，没有任何客户端挂接过方案（`profileMemory` 全是 `profile: ""`、`bindings: {}`）。与此同时，真正承载工作流的两条路持续在用：

- **tier 别名**（`auto/lite/plus/pro/ultra`）已经表达"这个角色用智能路由"，零配置；
- **客户端页行编辑**（直接的每 agent 模型引用，含原生 pin）加**智能分配**（一次 decider 调用给每个角色挑模型）完整覆盖显式指派。

方案唯一不可替代的是跨客户端批量换绑——改一处表、所有挂接客户端的关联行跟着变。这个价值在单运营者本地网关上从未兑现，而概念成本是实打实的：槽位、绑定、`slot:` 链接标签、回写/手动 pin/继承三种行状态、一个专属控制台页，以及每个客户端适配器和 setup 载荷校验路径里多出的一条方案分支。

## 决策

### 1. 删除，而非废弃

沿 ADR-0026 先例，整体移除。以下内容**不再存在**：

- config：`ModelProfileConfig`、`RouterConfig.modelProfiles`、`modelProfiles` 注释条目、`routing.modelProfiles` 布局行；
- console 路由：setup 载荷的 `profile` 字段及其槽位解析/校验分支、`refreshClientProfileBindings` 与两处 config 保存回写调用点；
- 客户端适配器：`ModelProfileBinding`、`ClientHookStatus.profile`、`ClientAdapter.refreshProfileBindings`、opencode/pi/omp 的 sidecar 方案 echo、方案解除挂接的清扫；
- sidecar：pi 的 `models.json.ocr-meta.json` 与 omp 的 `models.yml.ocr-meta.json` 只承载该 echo，因此仅作为遗留物存在——teardown 时删除，不再读不再写。opencode 的 `opencode.jsonc.ocr-meta.json` 保留其既有职责（记忆原默认模型）；已废弃的 `profile` 键在每次写入时剥除，旧 sidecar 随之收敛干净；
- 前端：`ModelProfilesPage`、`/model-profiles` 路由与导航项、agent 行表 / `ClientsPage` / `SmartAssignDialog` 里的方案选择器与 `slot:` 链接标签词汇（方案模式候选路径——decider 现在始终直接指派网关模型引用）、`getModelProfiles` / `saveModelProfiles`、八个语言包命名空间。

链接表本身**保留**：客户端页的每 agent/每角色模型指派是幸存功能，行状态只剩两种——网关模型引用，或留空（继承默认）。`linksOn` 与表单记忆（`clientProfileMemory`）职责不变，仅摘除已废弃的 `profile`/`bindings` 字段。

### 2. Schema v2：链只追加，键直接消失

`SCHEMA_VERSION` 从 1 升到 2，新增冻结的 `migrations/v1-to-v2.ts`：

- 丢弃 `routing.modelProfiles`，并从 `SECTION_MOVES_V2` 中删除该布局行（由 `SECTION_MOVES_V1` 过滤派生——冻结的 v1 表仍是唯一事实源），废弃键永远不会再持久化；
- 从每条 `routing.profileMemory` 条目中剥离方案簿记（`profile`/`bindings`）；仍然有效的表单记忆字段原样保留；
- 该步骤只在 `routing` 组已存在时才触碰它——junk 输入仍迁移到同样的最小骨架。

冻结的 `v0-to-v1.ts` 继续描述 v1 格式（历史上确实有该 section），通过本地 `LegacyModelProfileConfig` 声明实现——不为它复活已删除的 config 类型。

### 3. 什么没有被移除

- `clientProfileMemory` 保留其 config 键名：改活键名要付一次迁移的代价，却买不到任何东西——条目文档现在写清它是什么（每客户端控制台表单记忆），而不是它曾经装过什么。
- `harness/` 侧的 `profile` 词汇（DSH 插件档案）是无关机制，原样不动。
- 智能分配保留 `{ id, note }` 候选形状；`note` 现在就是普通调用方上下文。

## 后果

- setup 载荷收敛到唯一的 agent 绑定来源（`agentModels`），控制台行表丢掉三态语义——routing 组的认知面积减少一个概念（方案）、一个页面、一个链接标签命名空间。
- 跨客户端模型变更现在需要 N 次显式 setup（或逐客户端重跑智能分配）。如果多客户端批量换绑将来成为真实工作流，它应该以"从客户端页草稿派生的预设"形态回归，而不是平行的槽位表机制。
- 活配置的升级在启动时发生（ADR-0016 链）；旧构建加载 v1 文件会得到一次性版本警告，符合严格读取契约。

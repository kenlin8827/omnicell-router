# ADR-0016：Config Schema 演进 —— 版本化分组磁盘格式

日期：2026-10-28
状态：已接受
治理对象：`backend/src/config/schema.ts`、`backend/src/config/migrations/*`、
`backend/src/config/index.ts` 的 config 读写路径、`backend/src/index.ts` 的启动升级。

## 背景

config.yaml 顶层膨胀到约 33 个扁平段且无语义分组：`fallback` 与 `retry.failover` 同属执行层恢复机制却处在不同深度；`proxy` 与 `forwardProxy` 不说明各自朝向；磁盘格式演进只能靠加载时的键名嗅探，每个未来 schema 变更都要重新回答"怎么识别旧文件"。

## 决策

### 1. 磁盘格式版本化 + 分组；运行时保持扁平

config.yaml 以 `schemaVersion` 为首键，所有段归入且只归入六个语义组——每段唯一归属、无杂物抽屉：

| 组 | 含义 | 段 |
|---|---|---|
| `client` | 客户端接入面——请求怎么进来 | `port`、`host`、`webAuth`、`apiKeys`、`rateLimit`、`forwardProxy` |
| `protocol` | 协议面——网关对外说哪种协议 | `systemone`、`responses` |
| `routing` | 流量编排面——请求路由到哪个模型 | `strategy`、`tiers`、`classifier`、`session`、`directives`、`routeEntries`、`combos`、`modelProfiles`、`profileMemory` |
| `upstream` | 上游连接面——怎么打到上游 | `proxy`、`credentials`、`streaming`、`compression` |
| `resilience` | 韧性恢复面——失败怎么救 | `circuitBreaker`、`retry`（`inplace` / `failover` / `escalation`） |
| `ops` | 运维观测面——观测、数据源、内部设施 | `requestCapture`、`tracePersist`、`logging`、`catalog`、`quota`、`quotaProbes`、`opencode`、`defaultModels` |

运行时 `RouterConfig` 对象**不变、保持扁平**：消费方继续读 `config.tiers`、`config.retry`、`config.fallback`。分组只存在于磁盘 ↔ 运行时之间，由唯一一张声明式映射表（`schema.ts` 的 `SECTION_MOVES`）双向使用。

### 2. 运行时零兼容，迁移只发生在启动与保存点

- **`loadConfig` 绝不迁移**：只断言 `schemaVersion === 当前版本`；不符即走与语法损坏文件相同的宽容层（内置默认 + 一条 warn）。运行时无任何 legacy 容忍。
- **`upgradeConfigFile()` 在网关启动时运行一次**（首次 `loadConfig` 之前）：版本落后的文件被迁移并**原位重写**（先 `.bak` 快照，变更清单 warn 一次）。启动完成后磁盘文件即当前 schema。文件版本**超前**于本构建 → 启动报错（"upgrade OCR"）——fail-fast，绝不静默回退（与 ADR-0007 的 env 解析同哲学）。
- **所有写路径只发当前版本**——`saveConfig`、`defaultConfigYaml()`、原始 YAML 编辑器保存（旧格式草稿迁移后落盘；超前草稿拒绝）。保存即升级；没有降级路径。

### 3. 每个版本一步、一份脚本文件，严格按链推进

`backend/src/config/migrations/v0-to-v1.ts`、`v1-to-v2.ts`……每份导出冻结的 `{ from, to, warn, migrate }` 步骤；`schema.ts` 的 `MIGRATIONS` 按序组装。`migrateConfig` 逐版本推进（`while cur < SCHEMA_VERSION: find(from === cur)`），**绝不跳版本**——最终骨架 = 全部步骤的叠加。

铁律：
- 已发布的迁移文件**永久冻结**；演进只追加新文件，绝不改旧文件。`backend/tests/fixtures/` 的冻结 fixture + `backend/tests/config-migration.test.ts` 锚定每步的变换。
- 迁移步骤是**纯形状变换**。业务钳制（垃圾 → 默认、毫秒下限）留在 `loadConfig` 的 value cleaners——信任边界校验绝不混入迁移。
- 未映射/退役键在迁移时消失（不在映射表内），绝不复活；migrateConfig 对迁移前 v0 解析中发现的退役手写面（ADR-0010）warn 一次，由启动升级显式提示而不是静默丢弃。

### 4. v0 → v1 步骤（本 ADR 的落地）

v0 = 所有 ADR-0016 之前的文件（扁平、无 `schemaVersion`）。该步骤：
1. 全部扁平段归入六组；
2. 改名 `routing.mode` → `routing.strategy`（与新组键撞名）、`clientProfileMemory` → `routing.profileMemory`（组内 `client.` 前缀冗余）、`fallback` → `resilience.retry.escalation`（重试流水线的第三级终于与兄弟同级）；
3. **整体移除 `adminApiKey`**（主密钥 + `ROUTER_API_KEY` env）：推理面只认 `client.apiKeys` 条目；程序化 admin Bearer 通道移除——webAuth 激活时 `/api/admin/*` 只接受登录会话 cookie。

`env-archive` 的脱敏名单继续守卫原始（可能为 v0 的）config 字节中的 `adminApiKey`：配置键退役了，秘密形态没有。

## 后果

- 未来 schema 变更都是增量动作：写下一份迁移文件、`SCHEMA_VERSION` +1、补冻结 fixture。加载时启发式永不回归。
- YAML 注释标注器已移除——由下方"零注释磁盘格式"修订取代：词典改由控制台动态渲染，仍按运行时路径键控，注释表与映射表不会漂移。

## 同日修订：零注释磁盘格式

原计划写入 config.yaml 的逐字段 YAML 注释**作废**。写盘注释被证明脆弱（重复标注会累积重复的头部注释），且把磁盘格式与操作者语言耦合。

新契约：**config.yaml 只承载值**——首键 `schemaVersion`，其后六组，全文零注释。zh-CN 与 en 注释词典位于 `backend/src/config/comments-zh.ts` / `comments-en.ts`（按运行时路径键控），由控制台「配置文件」页动态渲染（GET /api/admin/config/comments）：侧栏按当前界面语言显示光标所在键的文档，跟随语言切换即时生效。编辑器内还会把已收录键的注释渲染为键所在行尾的**只读幽灵文本**（CodeMirror widget decoration——绝不写进文档、绝不参与保存），超过 120 字符截断、全文见侧栏。磁盘格式永不随语言变化；保存永不重写注释；不存在重新标注端点。
- 控制台可视化页不受影响：`saveConfig` 仍收扁平运行时形状，分组是 config 模块内部的事。

# ADR-0015：Harness 制品——技能、MCP 服务、扩展

- **状态**：已实现（按现行代码记录，2026-10-24）
- **日期**：2026-10-24
- **修订**：2026-10-25 —— 已安装行的来源单元格显示浏览面（安装源，如 `pi.dev`），仅在记录无其它来源面时回退写入方（§D8.6）。
- **关联**：ADR-0010（定义归属 + 物化目标）、ADR-0006（凭证库——本域从不读取）、ADR-0013（观测账本先例）、ADR-0007（环境布局、废纸篓删除）

## 背景

网关与六个运行时（`SupportedClient`：`opencode`、`opencode-proxy`、`claude`、`codex`、`pi`、`dsh`）之间已经存在一层 **client** 关系。那层关系只管 **流量**：适配器把运行时的模型/鉴权配置写好，让请求流经网关，到此为止。

运行时还能获得的东西——**技能**（指令目录）、**MCP 服务**（工具后端）、**扩展**（运行时插件/包）——过去只能由各家 CLI 装进各自目录，网关里没有任何记录。三个后果：

1. 操作者看不到什么装在哪里；同一个技能常被复制到四个目录，然后静默漂移。
2. 三类制品的写入语义完全不同——文件树投放、配置合并、包安装。把它们合成一个"安装"按钮就是一个数据丢失类别。
3. 来源目录的可访问性不一致：有的是匿名 JSON，有的需要 OIDC 或密钥。

本记录冻结已落地的模型：宿主目录表、归属分层、写入闸门、卸载操作、发现通道。此处描述的一切都存在于 `backend/src/harness/` 与 `backend/src/routes/harness.ts`；**未实现清单**一节明确列出刻意不存在的东西。

## 决策

### D1 — 词汇：`client` 是流量，`harness` 是能力

| 术语 | 含义 | 落点 |
| :--- | :--- | :--- |
| client | 接入网关的运行时（模型 + 鉴权配置） | `<运行时配置>`，如 `opencode.json` |
| harness | 该运行时作为**制品宿主**看的那一面（技能 / MCP / 扩展） | `<ocrHome>/harness/` |
| artifact | 某一类的一个可安装单元 | manifest 记录 + 物化副本 |

`opencode-proxy` 是同一运行时的**挂载模式**，不是第二个宿主：harness 域只有一个 `opencode` 目标。harness 状态永不进入路由真相链、永不触碰凭证（ADR-0006）、永不读取 provider 定义（ADR-0010）。

### D2 — 宿主落点写在每宿主一个的适配器里

两个文件分担这张表，边界是硬性的：

- `hosts.ts` 回答**有哪些宿主、顺序、叫什么**（`HOSTS`：只有 id + label）。
- `adapters/<host>.ts` 回答**该运行时读什么、怎么写**——每宿主一个文件，每个落点路径只声明一次。共享规则（`defineHost` 与 `SkillsHost` / `McpHost` / `ExtensionHost` 构建器）在 `adapters/declarative.ts` 里，所以错路径是一个小文件的数据错误，错规则是一处实现错误。

能力是**彼此独立的接口**，不是每宿主九个方法：十二个宿主有技能落点，一个（opencode）有经核实的 MCP 落点，两个（opencode、pi）有经核实的扩展落点。不会 MCP 的宿主根本不实现 `McpHost`——"没有这个能力"是类型事实，而不是运行时抛 `unsupported`。

版本差异是**同一适配器内的阶梯**，绝不拆成第二个适配器：`opencode` v1/v2 只差落点拼写，而扩展 identity 是 `extension:<harness>:<canonicalKey>`（§D7）——拆两个适配器 id 会在迁移期（一台机器同时有两种拼写）把同一个已装插件劈成两个制品。

全局根由 `os.homedir()` 与 `XDG_CONFIG_HOME`（缺省 `~/.config`）推导；项目根是仓库相对路径，按网关进程 cwd 解析——**已声明但在 `ENABLED_SCOPES` 为 `['global']` 期间不可达**（见下文**范围**）。只有下表这些格子有落地；空白的（kind × host）在解析阶段就被拒绝，不靠猜。

| 宿主 | 技能：全局 / 项目 | MCP 落地 | 扩展落地 |
| :--- | :--- | :--- | :--- |
| universal | `~/.agents/skills` / `.agents/skills` | — | — |
| opencode | `$XDG/opencode/skills` / `.agents/skills` | `opencode.json` · `mcp` | v1 `opencode.json` · `plugin[]` · `plugin/`；v2 `opencode.jsonc` · `plugins[]` · `plugins/` |
| claude | `~/.claude/skills` / `.claude/skills` | — | — |
| codex | `~/.agents/skills` / `.agents/skills` | — | — |
| pi | `~/.agents/skills` / `.agents/skills` | — | `pi install npm:<spec>`（子进程） |
| dsh | 无 | — | — |
| cursor | `~/.cursor/skills` / `.agents/skills` | — | — |
| github-copilot | `~/.copilot/skills` / `.agents/skills` | — | — |
| gemini-cli | `~/.gemini/skills` / `.agents/skills` | — | — |
| cline | `~/.agents/skills` / `.agents/skills` | — | — |
| amp | `$XDG/agents/skills` / `.agents/skills` | — | — |
| windsurf | `~/.codeium/windsurf/skills` / `.windsurf/skills` | — | — |
| zed | `~/.agents/skills` / `.agents/skills` | — | — |

- **多数宿主只是读者，少数才是归属者。** 九个宿主都读项目 `.agents/skills`；一个目录就是一个副本，所以由 `skillOwner()`（适配器注册表中第一个解析到该路径的条目）决定记录里的 host，其余宿主只是别名。安装、盘点、控制台共用这条规则。
- **归属与可读是两个答案，控制台两个都要问。** `skillOwner()` 回答"这个副本归谁"（安装目标、claim、卸载）；`skillReaders()` 回答"谁能**加载**它"（`CopyView.readers`，归属者在最前）。技能页的 harness 轨道按**可读性**筛选——装在 `.agents/skills` 里的一份技能对九个运行时都可用，用归属去建轨道只会在一个条目下显示它、把另外八个藏起来。写入仍然只认归属者（`KIND_META.skill.installAxis = 'skills-owner'`）：轨道是镜头，绝不是扇出的许可。
- **根是通过本进程量出来的。** `adapter.skillRoots(ctx, scope)` 给出候选根，带 `origin: 'default' | 'env-override'` 与优先级序号；`OPENCODE_CONFIG_DIR` 会改变 opencode 的根（DSH 声明 `DSH_HOME` 但没有技能落点）。从别的 shell 用不同覆盖启动的运行时在这里是不可见的，因此低优先级根上的副本**绝不**被报告成"没读到"。
- **`host ≠ SupportedClient`。** Cursor / VS Code / Zed / Windsurf 永远不是流量客户端，但它们是制品宿主；不会为了它们扩大流量枚举。
- **范围——只装全局；项目级是延后，不是删除。** 可接受范围由唯一常量 `ENABLED_SCOPES`（`harness/scopes.ts`）给出，当前是 `['global']`。所有面向产品的路径都读它：安装路由对其它值回答 `unsupported_scope`，`scanInventory` 不读也不扫项目级技能根 / 扩展来源 / MCP 落地，控制台不提供范围选择（一律发 `global`）。**预留的接口**就是适配器早已声明的东西——`SkillsSpec.project`、`configProject`、`looseDir.project` 每个宿主仍只拼写一次——加上写入器的 `scope` 参数，因此将来开放项目级支持只需改这张表加控制台选择器。卸载守卫仍然保留**两个**范围：范围闸门出现之前就落在仓库里的副本依旧可以卸载。技能名会规整为 `^[a-z0-9]+(-[a-z0-9]+)*$`，且解析出的目标必须留在根内（`adapter.skillTarget` 拒绝任何越界）。
- **`readsUniversal`** 记录该运行时是否原生读取跨代理的 `.agents` 目录；它决定别名/归属关系，也决定哪些宿主不需要厂商专属写入就能接受技能副本。
- **共享集只有一个排除项，且默认勾选。** 钉住某个运行时的技能页会列出该运行时能**加载**的每一行，因此归 `universal`（共享 `.agents` 目录，九个运行时都读）的行会在每个轨道条目下重复出现，把真正属于该运行时的行挤下去。`hideShared` 开关按副本归属（`row.hosts` 含共享宿主）把它们筛掉。它是一个 facet 而不是模式——筛选的是来源 chip 计数所用的同一张表，所以每个 chip 的数字仍然诚实——并且在无意义的地方不出现：MCP/扩展页（那里没有共享落点）、共享条目本身（那会把要收窄的列表清空），以及筛掉共享后不剩任何私有行的页面。最后这道闸门同时守着**默认值**：开关出厂即勾选，所以技能全在共享树里的运行时仍然打开完整列表。开关上带着它当前隐藏的条数，被隐藏的集合永远有账可查。

### D3 — 技能路径规则

- **R1——不双写。** OpenCode 原生读 `~/.agents/skills`；同时写它与厂商目录会造出两个真相源。规划器从不自行扇出：由操作者点名宿主。
- **R2——路径表只有一张。** 宿主路径只出现在 `HOSTS` 里。第二张表就是漂移双胞胎，见到即删。
- **R3——XDG 只在声明处生效。** `$XDG/*` 那几行的全局根使用 `XDG_CONFIG_HOME`；其余是按厂商文档的主目录字面路径。harness 域不借别的模块的解析器重新推导路径。

### D4 — 归属:manifest 是真相,目录是物化产物

| 层 | 路径 | 内容 | 共享性 |
| :--- | :--- | :--- | :--- |
| 意图 | `<envRoot>/harness/manifest.json` | 本环境按副本记录的已装内容 | 每环境 |
| 认领 | `<ocrHome>/harness/claims.json` | `path → {env, artifactId}`，一路径一属主 | 全机 |
| 内容库 | `<ocrHome>/harness/store/<storeKey>/` | 按内容键的技能载荷 | 全机 |
| 回收站 | `<ocrHome>/harness/trash/<ts>-<planId>/` | 卸载快照 | 全机 |
| 翻译缓存 | `<envRoot>/harness/i18n/{descriptions,readme}/<sha256>.<lang>.json` | 派生译文存储——**一条一文件**；拆分前的 `i18n/descriptions.json` 大文件只读一次并就地提升 | 每环境 |

- manifest **按环境**，绝不是一个文件被多个环境与桌面 + CLI 共享。写入是原子的（临时文件 + 改名）。
- **读不出真实记录时，绝不回"空"。** 每个写入方都会整文件重写，所以把一份读不了的文件当成空 manifest 返回，等于把"空"持久化成新的真相。读取失败（Windows 上的瞬时占用）让操作失败；不是合法 JSON、或版本形状无法识别的文件，改名为 `<file>.corrupt-<ts>` 后再以新文件继续——字节留下来了，绝不被静默吞掉。
- **一个物化路径只属于一个环境。** `claimPath` 拒绝被别的环境认领的路径；同一环境可重复认领。路径已被他环境认领的副本报 `foreign`，只能走转移流程——绝不允许第二次认领，也绝不静默删除。
- **内容库只由技能写入器使用**：载荷先进 `<storeKey>.tmp-*`，改名提升后再逐目标复制。MCP 与扩展没有内容库 blob——它们要么改配置文件，要么跑包管理器。
- **manifest v2** 为扩展带上制品级 `harness`。v1 记录在读取时于内存迁移：旧的 `extension:<canonicalKey>` 按宿主拆成多条记录，`external` 标记按 token 精确匹配回填；没有副本的旧记录（没有任何宿主能命名它）退休到 `manifest.orphans.json`——删掉"它曾经存在"的唯一记录，比留一条孤儿更糟。
- **记录会带上来源声明的一行 `description`**（可选；来源没有声明时字段缺席）。控制台优先显示已安装内容里的文本——技能的 `SKILL.md` 在查看时读取——只有副本里没有我们可读的文件时才回落到这个字段：运行时自己 store 里的 npm 包、宿主配置里的一个 MCP 条目。发现行（运行时自己装的）直接读运行时 store 里该包自己的 `package.json` `description`：这是本地文件读取，绝不是 registry 往返，因此一台装满扩展的机器不再渲染成一墙空白卡片，而重扫也不会变成 N 次网络请求。
- **本地扩展行用自己的材料描述自己**，免得手动放进去的插件也成一墙空白卡片。路径指向目录时，读该目录 `package.json` 的 `description`；路径指向文件时，读文件首个块注释的第一段（上限 300 字符，折成一行）。既无头注释又无清单时为 `null`——这是读取作者写下的话，绝不是猜测、不是由文件名拼出来的短语、也不是 registry 查询。
- **没有 GC。** 内容库与回收站只增不减；删除"无引用"blob 会删掉别人的回滚。手动 prune 是唯一出口。

```jsonc
{
  "version": 2,
  "artifacts": [{
    "id": "extension:opencode:npm:@acme/plugin",   // <kind>:<canonicalKey>，扩展带宿主
    "canonicalKey": "npm:@acme/plugin",
    "kind": "extension",
    "harness": "opencode",
    "name": "@acme/plugin",
    "description": "来源声明的一行描述",   // 可选，无声明时缺席
    "sourceId": "npm",
    "pin": { "npm": { "integrity": "sha512-…" } },
    "contentHash": "sha256:…",
    "listedOn": ["npm"],
    "trust": "community",
    "copies": [{
      "scope": "global",
      "host": "opencode",
      "rootId": "default",
      "path": "~/.config/opencode/opencode.json",   // external 时是身份 token
      "contentHash": "sha256:…",
      "placement": "verified",
      "installedAt": "2026-10-24T00:00:00.000Z"
    }]
  }]
}
```

- **pin 是联合类型,不是 ref。** 仓库来源技能用 `{git:{commitSha}}`，包用 `{npm:{integrity}}`，ClawHub 技能用 `{clawhub:{slug, version}}`（该注册表托管自己的版本化档案，确定性下载的版本就是 pin），没有可验证上游声明时用 `{adopted:true}`。单独的 `ref` 永远不是 pin。
- **`placement` 与 `state` 是两根轴**，只有探针能提升 `placement`（D8.7）。

### D5 — 三种写入模式、三道闸门

| 种类 | 写入方式 | 闸门 |
| :--- | :--- | :--- |
| skill | 文件树投放（`<name>/`，N 个文件） | 解析目标，拒绝 `exists` / `foreign`，先暂存再复制 |
| mcp | **配置合并**进 `opencode.json` 的 `mcp` | 展示新增/变更键，必须 `confirm: true`，`.bak.ocr` + 原子写 |
| extension | `plugin[]` 数组编辑**或** `pi install npm:<spec>`——恰好一个宿主 | 逐字回显命令，必须 `confirm: true`，绝不加 `-y`，120 秒超时 |

- **扩展只针对一个宿主，绝不多个。** 装进两个运行时就是两次安装、也就是两个制品：`kind: extension` 且 `hosts.length !== 1` 会被后端拒绝。
- **合并不重写无法往返的文件。** 带注释的配置（JSONC）被拒绝，而不是被 stringify 掉注释；`createBackup` 在原子改名之前写 `.bak.ocr`。
- **子进程安装会执行第三方代码。** 计划逐字回显命令，运行器绝不追加 `-y`/`--yes`，捕获输出，记录退出码。
- **写入顺序。** 技能：认领 → 内容库暂存 → 逐副本 `cpSync`（失败副本删除并释放）→ 最后写 manifest。MCP：认领 → 合并 → 备份/写盘 → 最后写 manifest。扩展：执行/合并 → 最后写 manifest。因此 manifest 条目只可能出现在已经落地的副本上。
- **卸载操作跟着落地形状走,不跟来源走:**

  | 落地形状 | 操作 | 被销毁的东西 |
  | :--- | :--- | :--- |
  | 文件树、松散扩展文件 | `move-to-trash` | 该树，进 `trash/<ts>-<planId>/` |
  | JSON 数组里的一个字符串（`plugin[]`、pi `packages[]`） | `drop-entry` | 该字符串；先写 `.bak.ocr` |
  | JSON 对象里的一个成员（`mcp` 里的服务） | `drop-server` | 该成员；先写 `.bak.ocr` |
  | 没有声明文件的包副本 | `prune-record` | 仅记录 |

  `path` 是**配置文件**的副本永不进回收站：`opencode.json` 里装着其它所有服务与插件，移动它等于删掉不属于我们的配置。来自发现行的 `trash-path` 描述符还要过包含校验（必须直接位于已知技能根或宿主声明的松散扩展目录之下）——这是路径安全规则，不是归属仪式。

- **卸载是 plan → confirm → apply**，计划 TTL 10 分钟。apply 会重检每个非 `drop` 目标仍存在，`dirty` 副本无 `discardLocalEdits` 则拒绝，且只有全部文件系统操作成功后才写 manifest。每个被执行的制品都留一条 `applies` 账本行（`remove`），包括磁盘上没留痕迹的 `prune-record`。
- **认领只在路径被销毁时释放**（`move-to-trash`）。配置成员编辑不会消灭文件，而该文件通常还装着别的制品。

### D6 — 来源是适配器,每个都要说清自己能做什么

`registry.ts` 是能产出载荷的适配器；路由文件里的 `SOURCES` 是控制台渲染的视图。视图里有、注册表里没有的来源，回答 `unsupported_source`，而不是假装能用。

| 来源 | 种类 | 可访问性（实测） | 角色 |
| :--- | :--- | :--- | :--- |
| GitHub `owner/repo` | skill | 匿名；搜索 10 次/分，`GITHUB_TOKEN` 可选 | 内容来源：每次安装一个 tarball，上限 200 文件 / 8 MiB |
| npm registry | skill, extension, mcp | 匿名搜索 200；`keywords:` 是精确标签过滤 | 扩展包来源，兼 MCP 启动来源：mcp 行解析为钉住 spec 的启动命令（`npx -y <pkg@version>`，记录版本 + `dist.integrity`——registry 之外没有作者运行时参数，因此一个也不编造）；npm 作技能解析为 `unsupported_kind`。空查询落在**钉住的运行时自己的**标签上（`browse.ts` 里的按宿主映射），MCP 轴落在作者自标的 `mcp-server` 标签上（实测 2026-10-25 为 10 501 个包；更宽的 `model-context-protocol` 标签 41 344 行里多为 SDK/客户端）；没有标签约定的运行时退回相关度短语并明说，绝不借用别的运行时的标签 |
| pi.dev 包目录 | extension | 匿名 200，服务端渲染 HTML——没有 JSON API；每页 50 张卡片，用目录自己的 `&page` 寻址 | Pi 官方目录，绑定 `pi`；只读浏览：每行自带 `pi install npm:<pkg>` 命令，因此 key 是 `npm:<pkg>`，安装经 npm 源执行 |
| MCP 官方注册表 | mcp | 匿名 `/v0/servers`——列表可浏览（`limit` ≤ 100、不透明游标、`version=latest`）；单体读取走 `/v0/servers/<name>/versions/latest`（裸路径回答 404） | 权威服务身份 + 启动参数；浏览行的句柄是 `mcp-official:<name>`，安装把服务合并进宿主的 `mcp` 容器。注册表不提供星标数、也不提供排序参数，因此该来源不声明 `sorts`，市场既不发明计数也不发明排序 |
| skills.sh | skill | API 无 Vercel 工作负载令牌时 **401**；榜单**页面**匿名 **200**（`/`、`/trending`、`/hot`，各在 RSC flight 载荷里带 600 行榜单）；`GET /api/search?q=&limit=` 匿名 **200**——上限 **200** 行、忽略 `offset`/`page`/`cursor`、少于 2 个字符直接拒绝 | **在线**，但绝不走那个封闭 API：空查询（或 1 个字符）读取所选榜单，2 个字符以上则通过站点自己的搜索接口检索**整个目录**——因此 `total` 是该应答的上限计数，而不是榜单那 150 万的总数。行以 `github:<owner/repo>#<技能目录>` 安装（站点自己的 `npx skills add` 身份），故与 pi.dev 一样只读浏览。401 要求的 `VERCEL_OIDC_TOKEN` 由 Vercel 部署内部签发、寿命约一小时，不是运维可持有的密钥 |
| ClawHub | skill | `GET /api/v1/skills?limit=&cursor=&sort=`（游标分页，自带 `sort` 枚举）、`GET /api/v1/search?q=` ——**没有分页参数**，一次应答就是一个窗口；`GET /api/v1/skills/<slug>?ownerHandle=` → 单条技能的自身记录（`skill.description` 就是发布的 `SKILL.md`，另带 `latestVersion`、`stats`、`owner`）；`GET /api/v1/download?slug=&ownerHandle=&version=` → 确定性 ZIP 字节；匿名读 3000 次/分/IP，429 带 `Retry-After`（实测 2026-10-25） | **在线**，且是唯一从**自己托管库**安装的技能注册表：行不带 GitHub 仓库，因此 pin 是注册表版本（`{clawhub:{slug, version}}`），`stars` 保持 `null`——注册表自己的星标/下载/安装计数走 `registryStats`（它自己的单位，标注为 ClawHub 的），绝不被当作 GitHub 星标重贴标签。`ownerHandle` 是注册表自己的 409 报错指明的消歧参数——端点上未文档化，但实测有效（owner 不对时回 404）。应答 200 却带 JSON 的是注册表给 GitHub-backed 技能的 `public-github` 移交描述符；其形状未文档化，适配器按名拒绝而不猜测 |
| Smithery | mcp | 匿名 `GET /servers` + `GET /servers/<name>` 皆 **200**；列表无论怎么切片都只服务 500 行，却声称约 20 765 | **已上线**：唯一**托管**自己记录（`<slug>.run.tools`，实测 MCP `initialize` 无 `Authorization` 头时回 401）的聚合商，因此它对自己那些部署拥有启动权威。仲裁：官方注册表也收录同一服务时，官方记录优先。连接声明了必需配置（`configSchema.required`）的条目按名拒绝——写入器只能引用环境变量**键名**，无法承载逐连接的配置对象 |
| OpenCode 生态 | extension | 精选文档表（mdx），以快照形式随包发布 | 只读浏览，绑定 `opencode`；有已核实包名的行经 npm 源安装 |
| awesome-opencode | extension | `dist/registry.json`——带声明式 schema 的扁平数组，经 GitHub contents API 读取 | 社区目录，绑定 `opencode`；安装时按需解析包名（条目自述名 → 经 repository 核实的候选），并回答 npm 身份 |
| opencode.cafe | extension | Convex `extensions:listAllApproved`——匿名可读，直接 POST（未文档化契约） | 社区目录，绑定 `opencode`；只有 `type: 'plugin'` 是扩展；安装同样按需解析包名；该查询会带出作者邮箱，读取器会将其收窄掉 |
| manual | mcp, extension | 操作者输入 | 逃生口：`manualPayload`（MCP）/ `manualSpec`（扩展） |

- **一份归一化载荷。** 写入器看不到来源：技能 → `{files}`；MCP → `{launch}`；扩展 → `{spec}`。产不出载荷的来源就是只读浏览，并明说这一点。
- **上限约束的是解压后的字节，且在任何解压之前。** 声明的压缩长度不构成内存边界（deflate 可达约 1000:1）：文件数从归档自己的目录记录读取，每次解压都被限制在剩余预算内，因此超限载荷以 `too_large` 被拒，而不是在网关进程里展开。
- **来源可以绑定宿主。** `hosts?: HarnessHostId[]` 把适配器收窄到其载荷真正能喂的运行时；控制台只在那些页面渲染它的入口，安装会拒绝其它宿主。
- **视图顺序就是噪音顺序。** `SOURCES` 数组既是控制台的 chip 行，也是落地优先级：每个轴上，市场打开的是**第一个** enabled+browsable 的来源。顺序跟随一行声明的边界有多宽：行**就是**制品本身的目录——官方目录（`mcp-official`、`pi-dev`）、精选快照（OpenCode 生态）、skills.sh 榜单——排在"承载制品的容器"的搜索之前（GitHub 的主题过滤仓库搜索：主题由仓库作者自行声明，星标奖励的是仓库而不是技能），后者又排在 npm 之前——最宽也最吵的一张网，对整个 registry 的相关度搜索、排序权重实测无效，**刻意声明在最后**：宽网是操作者主动选入的面，绝不是默认落地面。因此 opencode 页面打开的是精选目录，技能页面打开的是 skills.sh 榜单；只有没有更窄来源的运行时（claude、codex 等）才落在 npm 上。ClawHub——技能专用注册表，行**就是**技能但不带 GitHub 仓库、星标信号走自己的 `registryStats`——在技能轴上位于 skills.sh 与 GitHub 之间。
- **来源是代码配置,不是用户配置**（见"未实现"）。
- **托管型聚合商对自己托管的部署拥有权威。** 只做索引的来源可以排序与描述，但不得凭空发明启动规格。Smithery 是例外，因为它**运行**它列出的东西（`<slug>.run.tools`，实测对 MCP `initialize` 回 401 并要求 `Authorization`），所以它对自己托管的记录是首要记录——但官方注册表收录同一服务时仍然优先。这类来源绝不能携带密钥：启动规格只把 `Authorization` 写成环境变量**键名**，值由操作者提供（闸 4）。
- **目录型来源可以回答另一个来源的身份，而且必须"挣得"这个身份。** 三个 OpenCode 目录都不在自己的行里给包名，因此行不能自己发明安装句柄：

  - 精选 OpenCode 清单（`opencode-ecosystem.ts`）是随包快照。31 行中 29 行已对照 registry 与包自身的 `repository` 字段核实，这些行的 key 就是 `npm:<pkg>`，直接经 npm 源安装；另 2 行没有已发布包，保留没有任何适配器服务的 `static-opencode:<name>` 键，控制台因此给出"在 npm 中搜索"，而不是一个只会回答 `unsupported_source` 的安装按钮。
  - awesome-opencode（`sources/awesome-opencode.ts`）在安装时解析包名：先看条目自己声明的名字，否则探测候选并要求包自身的 `repository` 同时匹配 owner 与 repo——绝不接受"存在一个同名包"。136 个条目中 89 个能解析；其余返回 `no_artifact` 并给出 repo 地址，而不是去装一个被抢注的名字。
  - opencode.cafe（`sources/opencode-cafe.ts`）读 Convex 查询（`extensions:listAllApproved`，匿名可读、直接 POST——这是未文档化的契约，因此重新配置过的部署只会回答 `upstream`，绝不会回答"空目录"）。只有 `type: 'plugin'` 是扩展。读取器把每一行收窄到一个**没有 `author` 字段**的形状：该公开查询会返回作者邮箱，这些地址不得进入市场、manifest 或日志。

  "挣得包名"的规则只有一处，在 `catalog-npm.ts`。解析出的载荷由 npm 适配器产出，因此制品的 `canonicalKey` 是 `npm:<pkg>`——同一个包无论由哪个目录发现，都只有**一个身份**。`sourceId` 记录的是**在哪发现的**，那是来源出处而不是身份；正因如此，扩展写入器的 `ref` 从 key 自身推导，而不是按请求来源的名字长度去切。行上带着**另一个来源** key 的目录（Pi 目录与精选清单都按 `npm:<pkg>` 安装）会因此丢掉这条出处，所以安装请求同时携带 `listedOn`，记录两者都保留（D8.6）。
- **目录只发布 HTML 时，就从 HTML 读。** `pi.dev/packages`（Pi 官方目录）是服务端渲染、不提供 API，因此 `harness/pi-dev.ts` 依据目录自己的筛选/排序脚本已在消费的机器可读属性（`data-package-card`、`data-package-name`、`data-package-types`、`data-package-date`、`data-package-path`），再加上页面印出的 `pi install npm:<pkg>` 命令——那是目录自己对"这一行装什么"的声明。这份契约没有版本也没有文档，所以读取器**宁可大声失败**：页面既无包卡片也无结果计数标记，或卡片里取不出包名时，回答 `upstream`，绝不回答空市场。类型为 `extension` 的行、无类型行、以及 `skill`/`theme`/`prompt` 行**全部列出**：每一行都用同一条印出的命令（`pi install npm:<pkg>`）写进同一个运行时包存储，所以这层不做剔除，目录自己的计数因此就是精确的 `total`。行上的类型徽章是目录的词汇，不是本市场的种类。卡片上的 `data-package-downloads` 只用来让上游按它排序，**不会**被塞进市场的 `stars` 字段。**翻页也交给目录自己**：每页 50 张卡片、用它的 `&page` 参数寻址，而网格上方的计数标记（`1-50 / 286 (of 5338)`）同时回答总数与"有没有下一页"——解析出来，绝不靠多打一次请求去探测。因为本市场不剔除任何行，目录第 `i` 行就是市场第 `i` 行，所以控制台的一页可以按算术映射到它跨界的那一到两个目录页（24 行 < 50 卡片）：任意深度最多两次抓取，既不用从第 1 页开始走，也不需要上限，更不会出现重复或缺行；每个目录页在共享的 60 秒窗口内只抓一次。适配器报告来源自己的 `total` 与 `hasMore`，因此控制台用**共用分页条**渲染这个市场（摘要 `1–24 of 5338` + 页码条），而不是给单个来源做特例。
- **"来源没有热度信号"就是 `null`，绝不是 `0`。** 只有 GitHub 源发布星数；npm、Pi 目录、精选清单以及两个社区目录都不发布，因此这些行带 `stars: null`，控制台渲染成破折号。印 `0` 等于断言"没人星标过它"，而这些来源从未这样说过。行上如果**指名了仓库**，仍可取得真实星数，但只能**按需**（`harness/stars.ts`、`POST /api/admin/harness/market/stars`）：浏览本身绝不代操作者花掉星标配额。解析器做批量：GitHub 的搜索端点接受一条查询里的多个 `repo:` 限定符，因此 24 行的一页约花 3 次请求而不是 24 次；分组按查询的字符预算切，而不是固定条数；每个答案缓存数分钟，翻回去不重复花费；GitHub 没有收录的仓库进 `missing`，不会被折成 0。匿名搜索为 10 次/分钟，`GITHUB_TOKEN` 可提高上限，且与浏览读取器共用同一份请求头。
- **市场行与已装行的"详情"都由服务端读取，绝不放进 iframe。** `GET /api/admin/harness/detail` 回答一行的长文部分——README、许可证、最新版本、发布日期——先读 npm registry 文档；当它没有正文（或该行根本没有 npm 包）时，再读仓库（`api.github.com/repos/<repo>` 与 `/readme`）。`clawhub:<owner>/<slug>` 行两条路都不走：该注册表自己托管技能、不提供仓库，所以它的长文部分取自注册表的**单条记录**（`GET /api/v1/skills/<slug>?ownerHandle=`）——其 `skill.description` 就是发布的 `SKILL.md`（渲染前先剥掉 frontmatter），`latestVersion`/`stats` 提供版本、许可、日期与计数。这些计数（ClawHub 自己的星标、下载、安装）走 `registryStats`，**绝不进** `stars`：星标列的含义是 GitHub 星数，其 tooltip 会说明这个数字属于谁。控制台用**原生弹框**呈现，因为实测无法嵌入来源页面（2026-10-25：`github.com` 返回 `X-Frame-Options: deny`，`www.npmjs.com` 在 Cloudflare 挑战后返回 `SAMEORIGIN`，`pi.dev` 返回 `SAMEORIGIN`；少数可嵌的社区站点，其行内 URL 又都指回 GitHub）。**已装行打开的是同一个弹框**：它的身份从 `canonicalKey` 推出来（`npm:<pkg>` → registry 文档，`github:<owner>/<repo>#<dir>` → 仓库，`clawhub:<owner>/<slug>` → 注册表记录），所以"我装了什么、它自己怎么写的"在两个页签上都只需一次点击；没有公开身份的行（`manual:<name>`）也能打开，只显示本机元数据、没有正文——弹框陈述它知道的事，而不是拒绝。该端点只用这一行**声明的身份**构造上游——`npm:<name>` 里的包名、校验过的 `owner/repo`，以及 `clawhub:<owner>/<slug>` 这一对——绝不用行上的 `url`：一个会跟随调用方 URL 的 admin GET 就是一个 SSRF 代理。每一半都在边界处校验（`safePackageName` 拒绝路径穿越、多余分段与裸 `@scope`；`safeRepoSlug` 与 ClawHub 这一对拒绝 URL 与 `.`/`..`）。什么都读不到的行仍然给出答案（`readFrom: 'none'`、README 为 `null`），因为弹框是以浏览结果已经带回的行内容为骨架的；被拒绝或被限流时给出可翻译的 `reason`（GitHub 匿名额度用尽为 `rateLimited`，其余为带状态码的 `http`），英文 `message` 仅作兜底。README 上限 120 000 字符、缓存 10 分钟——比浏览缓存长，因为正文不会随键击变化，而匿名 GitHub 额度是 60 次/小时；失败的结果绝不缓存，所以下一次点击是**新一轮尝试预算**，而不是十分钟的死路。弹框默认是 900px 卡片，全屏由操作者自己切换、绝不是默认。它还能**翻译正文**：翻译路由的 `format: 'markdown'` 会切到**长文契约**——独立的系统提示（描述提示会把 3 000 字文档答成两句话）、散文按 4 500 字符分块、围栏代码**原样复制**而交给模型重打、以及 20 000 字符的预算：超出部分以源语言返回并置 `truncated: true`。任何一段都**绝不半译**——替换半译的段落会把它的尾部从文档里丢掉——结果写进**自己的一条文件**（`i18n/readme/<sha256>.<lang>.json`）、按完整源文建键，因此重新打开弹框不花钱，删掉某一页的译文也绝不影响别人。花在哪一个模型上是运营者的配置决策：`defaultModels.translation`（任何网关可见的 modelRef）指定首选，`lite` 别名殿后；`auto` 绝不自行出现——内部非关键调用不允许无上限花费，链条失败就如实报错而不是升档（运营者显式写 `auto` 视为自担成本，照常生效）。控制台默认模型选择器旁有链路探针（`POST /api/admin/harness/translations/probe`）：以一行短文走真实链路——测的是选择器里的未保存值（先测后存，清空则按纯 lite 测）——并报告实际服务的模型，绝不写缓存；显式点击即显式承担这一次调用的花费。这个存储会被**清扫**：条目 90 天过期，随后从最旧的开始裁剪，直到整个存储落进 32 MiB 预算——写入后每小时最多一次，也可用 `POST /api/admin/harness/translations/prune` 立即执行；崩溃写入留下的临时文件一小时后清除。拆分前的旧大文件一旦**自身**超过同一时限也会被删除（它的 mtime 就是旧构建最后一次写入的时间；留着它会让它比自己产出的每一条都活得更久）。重新打开一个翻译过的页面时，控制台用只读批量接口（`format: 'markdown'`）读回该条目，所以弹框**打开即译文**、既不用点也不调用模型；标题栏的徽章随时切回原发布文本。正文走**自己的**渲染管线（`frontend/src/lib/readme-markdown.tsx`）：原始 HTML 先被解析（`rehype-raw`）再立刻**净化**（`rehype-sanitize`）——依据库自带的 GitHub 派生白名单，外加 README 真的会用的表现型标签（`details`/`summary`/`kbd`/`picture`、`align`），`href` 只允许 http/https/mailto、`src` 只允许 http/https。这与模型输出是**不同的信任模型**（后者根本拒绝原始 HTML）：README 是操作者主动打开的仓库正文，其中一半是用 `<div align="center">` 写的。远程图片**只在**这个界面加载（`referrerPolicy="no-referrer"`、`loading="lazy"`）；其他界面不会因此获得 HTML 能力，`script`/`style`/`iframe`/事件处理器/`javascript:` URL 永远过不了净化器。
- **排序是「源」的，不是控制台的。** 每个源在 `GET /sources` 里声明它真正能提供的顺序（`sorts`），控制台只渲染这张清单；选中的键作为 `sort` 送到 `/browse`，先按声明校验再交给适配器，因此源喂不动的顺序会被丢弃而不是照发。凡是有公开契约的源，控制台都给出**完整的官方集合**、绝不做"精选子集"：GitHub 给全部四个文档值（`stars`/`forks`/`updated`/`help-wanted-issues`，加上**省略参数**即 best match）；pi.dev 目录给它自己排序控件里的三种（`downloads`/`recent`/`name`，即实测会改变页序的 `?sort=` 值）。**后端整表读取**的目录（精选快照、awesome-opencode、opencode.cafe）在切片前对全部匹配行排序，因此那里的 `name` 是真全局序。npm 既没有 `sort`、也没有可用的等价物——文档里的 `quality`/`popularity`/`maintenance` 权重实测无效（五个查询、各 50 行，在三组极端权重下结果顺序完全一致）——所以 npm 的 `name`/`updated` 由**后端**在 registry 自身排序的一个最大窗口（`size=250`）上排序，并在答案里带 `window-sorted` 提示说明该窗口：页面照抄服务端给的顺序，`total` 也报窗口大小，因为翻出窗口之外答不出来。控制台永不重排任何列表；只有一种顺序（或没有）的源显示成一行静态文字，绝不是点不动的下拉——重排当前页等于宣称一个人人都没算过的全局顺序。
- **浏览缓存 60 秒**，因为匿名 GitHub 搜索只允许 10 次/分，否则每次键击都会花掉一次。缓存按**精确查询串**建键，因此不同前缀就是不同的上游调用——控制台因此只在**提交**查询（回车、切来源、清空）时发请求，输入框里的文字永不上网。控制台也可以强行重读：刷新按钮发出 `refresh=1`，`browseSource` 在分发前先逐出**该来源**的缓存族（`evictBrowseCache`），因此一个仍然温热的窗口不可能回答一个本就意味着"要新数据"的请求——而且刷新一个目录绝不会丢掉另一个目录刚预热的窗口。**榜单类来源的榜单页改用十分钟窗口**（`BOARD_TTL_MS`）：排名是按天变化的，而 skills.sh 约 30 次请求后就用 `429 Retry-After: 60` 限流，其 all-time 榜约 50 页——否则一次深度滚动要花掉两个限流窗口才能到底，下次访问又要再花一遍。刷新按钮照旧绕过该窗口（逐出逻辑不变），搜索应答仍用共享的 60 秒。单个来源挂掉只回答自己的原因，绝不清空整页。读取失败同时给出 `reason`（`network`、`timeout`、`http`、`rateLimited`、`unavailable`、`markupChanged`、`badPayload`、`unsupportedSource`），由控制台经 `harness.browseError.*` 翻译；英文 `message` 只作为控制台不认识的 reason 的兜底——与市场提示同一条规则：**后端陈述事实，控制台拥有措辞**。运行时自己的文字永远到不了操作者眼前（它既没有主语，又让人去传一个控制台无法设置的 fetch 选项），粗粒度的失败类别留在 `code` 里，调用方按它分支。

- **市场读取对每一个失败应答都重试，不再只挑"看起来瞬时"的失败。** 每一次市场抓取都走**同一个** helper（`harness/net.ts` → `fetchWithRetry`）：同一套策略若在每个读取器里各写一遍，等其中一个学会了新状态码那天就会漂移。策略（`MARKET_RETRY`）是 5 次尝试、间隔 400 毫秒起逐次翻倍（±20% 抖动）、单次 6 秒、**总计 30 秒预算**——操作者确认的忍耐上限（2026-10-25；旧策略为 10 秒内 3 次尝试）。预算是契约、`attempts` 只是上限：每次尝试的截止时间是预算的剩余量，所以快速失败的端点约 7 秒内用完全部 5 次询问，而硬挂起的端点大约得到 4 次完整尝试，操作者在 30 秒耗尽时看到 `timeout`——不会更晚，因为预算连睡眠也一起封顶。重试：抛出的网络错误与**所有**状态码（含 `4xx`）——npm CDN 在发布传播期间的瞬时 `404`、比退避还短的突发 `403`/`429` 窗口都真实存在，而 10 秒预算框死了死胡同重试的代价（2026-10-25 修订：旧策略绝不重试 `403`/`429` 及其余 `4xx`）。唯一的提前返回是剩余预算放不下的 `Retry-After`——服务器点名了一个策略兑现不了的等待，再问一次必然徒劳；放得下的 `Retry-After` 则垫高下一次睡眠的下限。仍然绝不重试：解码不出的负载（`badPayload` / `markupChanged` 是**答案**，不是抖动）。helper 把**最后一个响应**原样交回而不是吞掉，因此每个读取器仍按自己的 `reason` 映射状态码；若每次尝试都抛错，则重抛最后一个错误，原有措辞不变。**只用于读**——安装仍然只尝试一次：写路径绝不能在操作者背后被重放。

### D7 — 身份:一个制品一个键

| 种类 | `canonicalKey` | `artifactId` |
| :--- | :--- | :--- |
| skill | `<sourceId>:<ref>[#detail]`，如 `github:owner/repo#dir` | `skill:<canonicalKey>` |
| mcp | `<sourceId>:<ref>`，如 `manual:brave` | `mcp:<canonicalKey>` |
| extension | `npm:<name>` / `manual:<spec>` | `extension:<harness>:<canonicalKey>` |

- **扩展把宿主放进 `artifactId`,不放进 `canonicalKey`。** 同一个包装进两个运行时是两次安装、两套回滚；合并会让"卸载"含义模糊。`canonicalKey` 保持与运行时无关，将来若出现跨运行时 ABI 仍可按 npm 身份归组。
- `name` 是磁盘目录名（技能）或逐字写入的 spec（扩展）。两个制品抢同一个目录是**拒绝**（`exists`），不是一个以后才发明的后缀策略。
- **来源是存下来的,不是合并出来的。** `pin`、`sourceId`、`listedOn`、`trust` 随记录走；本版本没有信任梯级的字段仲裁（见"未实现"）。`listedOn` 会累积来源面（D8.6），而 `sourceId`、`pin`、`trust` 始终是**那一个写入方**的说法。
- **来源面与写入方是两件事。** `sourceId` 点名产出载荷的写入方；`listedOn`（写入方在前、去重、上限 8、在路由处对照来源注册表校验）记录这一行是**在哪被浏览到**的，因为目录行可能带着写入方的 key——Pi 目录里的包安装时就是 `npm:<pkg>`。本地页的来源 chip 按两者的并集收窄与计数，并且**只在该来源本页至少装了一条时出现**（判据不分面：被搜索收窄成 0 的 chip 仍然保留）。行内的来源单元格回答"我是从哪里装的"——显示**浏览面**（Pi 目录装的包显示 `pi.dev`，那正是操作者点下的目录），仅在记录没有其它来源面时回退写入方；写入方没有丢：它在 `sourceId`、`canonicalKey`（`npm:<pkg>`，单元格 tooltip）和 chip 并集里。制品永不被改名，只是这一列的问题得到字面回答。计数仍是发现面，绝不是对制品身份的声明。

### D8 — 铁律（每一条都在代码里生效）

1. **不自动安装、不自动更新。** 每次写入都走 plan → confirm → apply；控制台里的补救动作也从不自行执行。
2. **不静默合并。** MCP 计划报告确切的增/改键；JSONC 文件直接拒绝。
3. **网关装的是指令和可执行文件,并且明说。** `SKILL.md` 装完就是代理的指令；`pi install` 会跑 npm lifecycle scripts，执行第三方代码。确认文案逐字说明这一点，并记录确切命令。
4. **MCP 密钥只留名字,不留值。** 启动记录只携带 env/header 的**键名**；值由操作者提供。harness 从不读取、存储或记录凭证值（ADR-0006 不受影响）。
5. **不可信输入纪律。** 注册表载荷先被归一到窄形状再进控制台；校验在任何写入器之前完成（名称文法、spec 文法、`..` 段、launch 形状）。
6. **安装状态按副本,绝不按布尔。** `state` 是唯一逐副本词汇（`clean | dirty | missing | foreign | untracked`）；`partial` 是派生汇总，永不落盘。`untracked` 只回答"没有 manifest 条目"，从不等于"不可卸载"（D5）。
7. **落盘 ≠ 加载。** 默认声明是 `materialized`。安装后探针只在有证据时把它升级为 `verified`——技能：`SKILL.md` 在；MCP：服务键在解析后的配置里；扩展配置副本：spec 在宿主声明的容器里；`external` 副本：apply 时的退出码。探针失败记 `unverified`；无法判定则保持原值。控制台没有探针结果时绝不写"已加载"。
8. **发现是观测,观测不是卸载禁令。** 运行时自己装的东西，从它自己的记录里读出来——写入器合并的 `plugin[]` 数组（向宿主适配器询问：`readSources`）、MCP 写入器合并的**对象**（`configPath` 解析出的文件内的 `mcp` 容器，因此操作者手工加的服务同样是观测对象），或 pi 的声明文件 + lock 文件 + 松散 `extensions/` 目录——合并进唯一的 `discovered[]` 通道，按 `kind`、`harness` 打标。四条规则：行是 `untracked`，永不被提升为 manifest 制品；不被当作我们的副本去 stat/哈希；它携带 **`removal` 描述符**（松散文件是 `trash-path`，`plugin[]`/`packages[]` 里的一个字符串是 `drop-entry`，`mcp` 对象里的一个成员是 `drop-server`），因此与受管副本用同一批按形状的操作卸载——描述符是计划参数，`trash-path` 仍要过包含校验；manifest 已记录同一 `(harness, canonicalKey)` 时排除——MCP 服务按同一 `(host, serverKey)` 排除——一次安装永不被报告两次。解析是容错的：运行时在我们读的同时重写自己的配置，只会回答"没有行"，绝不抛错。**跨版本读取阶梯**：运行时在大版本之间搬过落点时，每种可能的拼写都读（`opencode`：v2 `opencode.jsonc` + `plugins[]` + `plugins/`，v1 `opencode.json` + `plugin[]` + `plugin/`），且每行的 `removal` 描述符点名该条目**实际**所在的容器——卸载编辑的是运行时读取的数组，不是我们会写入的那个。JSONC 配置按 JSONC 解析（注释不是损坏）；写入落点仍拒绝 JSONC 重写，优先已存在的纯 JSON 候选（§D8.2）。
9. **`external` 是归属标记,不是状态。** 包管理器托管的副本没有我们的路径：`path` 是身份 token `<canonicalKey>#<harness>`，永不被 stat 或哈希，状态报 `clean`、`placement` 报 `verified`，因为子进程退出码就是证据。它的卸载编辑运行时自己读取的声明（`pi` 的 `settings.json` `packages[]`）；宿主没有声明文件时退回 `prune-record`，并明说包体仍在。绝不发明未经验证的反向命令。

## 未实现清单（勿假设存在）

| 领域 | 现状 |
| :--- | :--- |
| 项目级发现与安装（技能、MCP、扩展） | 在产品边界处关闭：`ENABLED_SCOPES` 为 `['global']`，因此安装路由回答 `unsupported_scope`、盘点不扫任何项目根、控制台不提供范围选择器。适配器里的项目落点声明与写入器的 `scope` 参数**保留**作为接口——将来开放只需改这张表加选择器，不必重拼十三个适配器 |
| opencode 之外的 MCP 落地 | 不在 `HOSTS` 中；目标被带原因拒绝，绝不猜 |
| opencode（`config`）与 pi（`subprocess`）之外的扩展落地 | 不存在；其它宿主拒绝 |
| npm 作为**技能**来源 | 视图已声明，解析返回 `unsupported_kind` |
| PulseMCP / mcp.so | 无可用适配器、视图里也没有行（实测 410 已退役 / 404）。skills.sh 已移出本行：它的**页面**可读，见 §D6 |
| OpenCode 精选清单 | 只读快照：无安装适配器，也不做运行时抓取——本环境下 `raw.githubusercontent.com` 与 `cdn.jsdelivr.net` 都会重置连接，故表格随包发布、两次刷新之间会腐化。31 行中 29 行有已核实的 npm 包名，经 npm 源安装；2 行没有发布包，无法从控制台安装 |
| awesome-opencode | 有安装适配器，但包名必须"挣得"：136 个插件条目中 89 个能解析出包（条目自述名，或候选包自身的 `repository` 字段同时匹配 owner 与 repo）。其余 47 个返回 `no_artifact` 并附带 repo 地址——按"看起来像"的名字安装等于把供应链押上去 |
| opencode.cafe | 在线且可读（54 条已批准，其中 40 条 `type: 'plugin'`），但建立在**未文档化契约**上：Convex 部署地址与查询名来自站点自己的客户端 bundle。读取器丢弃其 `author.email` 字段。安装说明未给出包名的条目（本地路径、`…other plugins`）会退到 repository 探测，可能返回 `no_artifact` |
| 在 `config.yaml` 里声明来源 | 来源 = `SOURCES` 表 + `registry.ts`；没有 `harness.sources` 配置段 |
| 预写意图文件、跨副本安装回滚、manifest 咨询锁 | 未实现；保证是"最后写 manifest" + 逐副本回滚 |
| `shadowed` 汇总、`profile` 根来源 | 类型联合里有名字，没有产出者 |
| 内容库/回收站 GC、adopt 未跟踪目录、harness 导出/导入、`canonicalKey` 别名覆盖、目录重名后缀策略 | 未实现（重名 = 拒绝） |
| `dsh` 的 MCP/扩展面、`codex` 的 MCP（本仓无 TOML 写入器） | 不支持 |
| 已验证的反向包管理器命令（`pi uninstall`） | 未实现；声明编辑就是已交付的撤销方式 |

## 后果

- 正面：三类制品一份盘点，漂移是被检出而不是被偶然发现；来源层是同一载荷形状后面的适配器，接入一个市场只需一个文件加一行视图，而不是重写页面；身份、信任与卸载操作只说一次、处处复用。
- 正面：按落地形状决定卸载操作，正是"卸一个插件"不再等于"删掉客户端整份配置"的原因——那是按来源判定时真实的失败模式。
- 负面：能力在 (kind × host) 上非常不均匀——MCP 只有 opencode，扩展只有 opencode 与 pi。这是诚实的，但意味着多数宿主行对其中两类是只读的。
- 负面：从控制台卸掉运行时自己装的包，只是让它不再加载，字节仍留在运行时库里；这是编辑声明的真相，控制台必须一直这么讲。
- 负面：没有 GC 意味着内容库与回收站会长大；没有导出/导入意味着 harness 意图不随环境迁移（ADR-0007 迁移的是环境状态，不是这个）。
- 负面：manifest 原子写但不加锁。桌面 + CLI 被假定为同一环境的串行写入者；并发的第二个写入者可能丢掉一条副本记录。

## 实施锚点

- `backend/src/harness/hosts.ts`——宿主身份表（`HOSTS`：id + label，目录顺序）。
- `backend/src/harness/adapters/`——每宿主一个文件（各自的落点路径，只声明一次）、共享的 `defineHost` 规则、能力接口、注册表（`adapterFor`、`skillLocationRoots`、`skillOwner`、`skillRootsFor`）。
- `backend/src/harness/{manifest,types}.ts`——manifest v2 + 迁移 + 孤儿、认领、词汇。
- `backend/src/harness/writers/{skill,mcp,extension}.ts`——三种写入模式及其闸门。
- `backend/src/harness/{inventory,discover}.ts`——对账、发现通道、卸载描述符。
- `backend/src/harness/{maintenance,config-file}.ts`——卸载操作、回收站快照、共享的配置读写纪律。
- `backend/src/harness/{install,registry,spi,browse,sources/*}.ts`——编排、来源适配器、归一化载荷、浏览缓存。
- `backend/src/harness/opencode-ecosystem.ts`——随包发布的 OpenCode 精选清单（数据模块，不是适配器：它不产出载荷），含已核实的 `名称 → npm 包名` 映射。
- `backend/src/harness/browse.ts`——全部浏览适配器共用一个 `MarketItem` 形状，其中包括 awesome-opencode 的 registry 读取器（contents API，60 秒缓存）、纯磁盘的精选读取器，以及 Smithery 的列表/详情读取路径。
- `backend/src/harness/smithery.ts`——Smithery 列表与单体读取器：把行收窄（不带 owner id、不带任何令牌），并把可达的 500 行窗口与它声称的总数分开陈述。
- `backend/src/harness/detail.ts`——一行市场记录的长文部分（npm 文档、仓库事实、README、ClawHub 的自身记录），并在此校验身份，使读取不会跟随调用方给出的 URL。
- `backend/src/harness/catalog-npm.ts`——唯一决定"什么才算挣得的包名"的地方（`declaredPackageName`、`sanitizePackageName`、`npmCandidates`、`verifyNpmIdentity`），被每个目录适配器共用。
- `backend/src/harness/awesome-opencode.ts`——社区 registry 读取器（GitHub contents API）。
- `backend/src/harness/opencode-cafe.ts`——opencode.cafe 的 Convex 读取器；把行收窄到没有 `author` 字段的形状。
- `backend/src/harness/pi-dev.ts`——pi.dev 官方目录读取器：服务端渲染 HTML，依据目录自己的卡片属性与页面印出的 `pi install npm:<pkg>` 命令。
- `backend/src/harness/sources/awesome-opencode.ts` / `sources/opencode-cafe.ts`——把一条目录条目变成包 spec 的安装适配器，载荷与 pin 委托给 npm 适配器。
- `backend/src/harness/net.ts`——抓取失败**唯一**的措辞（哪个上游、怎么办），每个读取器共用，运行时错误文本因此到不了操作者眼前；同时也是**唯一**的重试点（`fetchWithRetry` / `MARKET_RETRY`），读取器不再各自携带尝试次数、退避或预算。
- `backend/src/harness/{probe,ledger,translation}.ts`——安装后的 placement 证据、事件环骨架上的 `applies` 账本、派生描述缓存。
- `backend/src/routes/harness.ts`——管理面（`sources`、`hosts`、`applies`、`inventory`、`plan`、`apply`、`browse`、`install`、`translate*`），全部位于既有 `/api/admin/*` 鉴权闸门之下。
- `frontend/src/pages/HarnessPage.tsx`——每类一页、有落地时的宿主侧栏、已装/市场两个页签、逐目标安装门禁、卸载选择器。页签是地址的一部分（`?tab=market`，`local` 保持隐式），因此刷新后仍停在操作者正在读的那一页；而**宿主变化**会丢弃它——侧栏徽章数的是**已装**副本，所以点侧栏永远回本地页签。

## 待决问题

- 下一个值得验证的 MCP 落地是哪个（Claude 与 Cursor 有公开配置文件；每个都要先对厂商文档核实，才能进入 `HOSTS`）。
- 是否要在声明编辑之上再加一个已验证的 `pi uninstall` 操作，还是就此把声明编辑定为契约（它是唯一不会删掉不属于我们的字节的方式）。
- 内容库何时需要 GC，以及在导入与回滚存在之后，"安全引用集"到底是什么。
- `trust` 这类"演示级"信任字段是保持单来源，还是长出本记录刻意省略的跨源聚合。`listedOn` 已经不需要这个问题：它记录一行被浏览到的每个来源面（D8.6），只剩写入方的那份 `trust` 声明仍是单值。

# ADR-0015：Harness 制品——技能、MCP 服务、插件

- **状态**：已实现（按现行代码记录，2026-10-24）
- **日期**：2026-10-24
- **修订**：2026-10-25 —— 已安装行的来源单元格显示浏览面（安装源，如 `pi.dev`），仅在记录无其它来源面时回退写入方（§D8.6）。
- **修订**：2026-11-01 —— MCP 轴新增操作者包源（`npm` / `pypi`），落在 `harness/mcp-market.json`；该轴**共享**：只有一个 `shared` 桶，包源不钉 harness（解析出的启动命令与宿主无关），旧 harness 桶按共享读取并在下次写入时拍平。
- **修订**：2026-11-02 —— MCP 添加/编辑表单的远程（URL）半区把请求头改为「名 + 值」行：registry 的 `remotes[].transport.headers` 预填名称，`setKeys` 标记已存值，值留空时保留它（或写入宿主的环境变量引用），填写则按字面写入且永不回显。传输分段标为「远程 URL」而不是「SSE」：已核实的宿主都不声明 transport 字段（§D8）。
- **修订**：2026-11-03 —— `openclaw` 以三类能力加入宿主目录：技能（`~/.openclaw/skills` 全局、裸工作区 `skills/` 项目，二者另读共享树，`readsUniversal`）、CLI 物化 MCP 落点（§D8.13 的 JSON5 变体：中央 `~/.openclaw/openclaw.json` 把服务嵌在 `mcp.servers`——带注释、可裸键的 JSON5，经 `json5` 读取，只由 `openclaw mcp add` / `mcp unset` 写入，仅全局）、插件子进程落点（`openclaw plugins install <spec> --force`；git 行走 `--marketplace` 命令链）。MCP 落点格式联合新增 `json5`，容器键变为点路径感知（`mcpContainerAt` / `ensureMcpContainer`）。MCP 语法经出厂 2026.10.10 二进制实测（真实 add/unset 往返确认了嵌套容器、`${KEY}` 引用与 `--no-probe`；CLI 的 `--header` 取 `KEY=value`，而非其行文示例的 `KEY: value`）。
- **关联**：ADR-0010（定义归属 + 物化目标）、ADR-0006（凭证库——本域从不读取）、ADR-0013（观测账本先例）、ADR-0007（环境布局、废纸篓删除）

## 背景

网关与十二个运行时（`SupportedClient`：`opencode`、`opencode-proxy`、`claude`、`codex`、`pi`、`dsh`、`omp`、`grok`、`kimi`、`openclaw`、`cursor-proxy`、`qoder-proxy`）之间已经存在一层 **client** 关系。那层关系只管 **流量**：适配器让运行时的请求流经网关（改写配置、设置服务环境，或生成代理启动器），到此为止。

运行时还能获得的东西——**技能**（指令目录）、**MCP 服务**（工具后端）、**插件**（运行时插件/包）——过去只能由各家 CLI 装进各自目录，网关里没有任何记录。三个后果：

1. 操作者看不到什么装在哪里；同一个技能常被复制到四个目录，然后静默漂移。
2. 三类制品的写入语义完全不同——文件树投放、配置合并、包安装。把它们合成一个"安装"按钮就是一个数据丢失类别。
3. 来源目录的可访问性不一致：有的是匿名 JSON，有的需要 OIDC 或密钥。

本记录冻结已落地的模型：宿主目录表、归属分层、写入闸门、卸载操作、发现通道。此处描述的一切都存在于 `backend/src/harness/` 与 `backend/src/routes/harness.ts`；**未实现清单**一节明确列出刻意不存在的东西。

## 决策

### D1 — 词汇：`client` 是流量，`harness` 是能力

| 术语 | 含义 | 落点 |
| :--- | :--- | :--- |
| client | 接入网关的运行时（模型 + 鉴权配置） | `<运行时配置>`，如 `opencode.json` |
| harness | 该运行时作为**制品宿主**看的那一面（技能 / MCP / 插件） | `<ocrHome>/harness/` |
| artifact | 某一类的一个可安装单元 | manifest 记录 + 物化副本 |

`opencode-proxy` 是同一运行时的**挂载模式**，不是第二个宿主：harness 域只有一个 `opencode` 目标。`cursor-proxy`（宿主 `cursor`）与 `qoder-proxy`（尚无宿主）同理。harness 状态永不进入路由真相链、永不触碰凭证（ADR-0006）、永不读取 provider 定义（ADR-0010）。

### D2 — 宿主落点写在每宿主一个的适配器里

两个文件分担这张表，边界是硬性的：

- `hosts.ts` 回答**有哪些宿主、顺序、叫什么**（`HOSTS`：只有 id + label）。
- `adapters/<host>.ts` 回答**该运行时读什么、怎么写**——每宿主一个文件，每个落点路径只声明一次。共享规则（`defineHost` 与 `SkillsHost` / `McpHost` / `PluginHost` 构建器）在 `adapters/declarative.ts` 里，所以错路径是一个小文件的数据错误，错规则是一处实现错误。

能力是**彼此独立的接口**，不是每宿主九个方法：十五个宿主有技能落点，八个有经核实的 MCP 落点（四个文件合并、四个 CLI 物化），十一个有经核实的插件落点（任何已声明写入路径——本地 config、子进程或 marketplace 命令链；见宿主目录表）。不会 MCP 的宿主根本不实现 `McpHost`——"没有这个能力"是类型事实，而不是运行时抛 `unsupported`。

版本差异是**同一适配器内的阶梯**，绝不拆成第二个适配器：`opencode` v1/v2 只差落点拼写，而插件 identity 是 `plugin:<harness>:<canonicalKey>`（§D7；manifest v1/v2 拼作 `extension:`）——拆两个适配器 id 会在迁移期（一台机器同时有两种拼写）把同一个已装插件劈成两个制品。

全局根由 `os.homedir()` 与 `XDG_CONFIG_HOME`（缺省 `~/.config`）推导；项目根是仓库相对路径，按控制台所选项目的根解析（控制台传入；缺省回退到网关进程 cwd——见下文**范围**）。只有下表这些格子有落地；空白的（kind × host）在解析阶段就被拒绝，不靠猜。

| 宿主 | 技能：全局 / 项目 | MCP 落地 | 插件落地 |
| :--- | :--- | :--- | :--- |
| universal | `~/.agents/skills` / `.agents/skills` | — | — |
| opencode | `$XDG/opencode/skills` / `.agents/skills` | `opencode.json` · `mcp` | v1 `opencode.json` · `plugin[]` · `plugin/`；v2 `opencode.jsonc` · `plugins[]` · `plugins/` |
| claude | `~/.claude/skills` / `.claude/skills` | CLI（§D8.13）：`claude mcp add-json <name> '<entry>' --scope user` → `~/.claude.json` · `mcpServers`；项目 `.mcp.json`（只读观察） | `claude plugin install <id> --scope user\|project`（子进程）；记录在 `~/.claude/plugins/installed_plugins.json` · `plugins` 映射（§D8.11） |
| codex | `~/.agents/skills` / `.codex/skills`——另读共享项目树，`readsUniversal` | CLI（§D8.13）：`codex mcp add <name> [--env K=V] -- <cmd>` / `--url` → `~/.codex/config.toml` · `mcp_servers`（TOML，只读；仅全局——该动词没有项目语法） | `codex plugin marketplace add {repo} --ref main` → `plugin marketplace upgrade` → `plugin add {plugin}@{marketplace}`（§D9） |
| pi | `~/.pi/agent/skills` / `.pi/skills`（仍读共享树，`readsUniversal`） | `~/.pi/agent/mcp.json` · `mcpServers` | `pi install npm:<spec>`（子进程） |
| dsh | — | — | — |
| omp | `~/.omp/skills`（由 `PI_CONFIG_DIR` 迁移）/ `.omp/skills` | `~/.omp/agent/mcp.json` · `mcpServers`；项目 `.omp/mcp.json` | marketplace 命令链 + 散装 `.omp/extensions` 根（两个范围） |
| cursor | `~/.cursor/skills` / `.agents/skills` | — | `/add-plugin {plugin}`——交互式（§D9） |
| gemini-cli | `~/.gemini/skills` / `.gemini/skills`——另读共享树，`readsUniversal` | — | — |
| cline | `~/.cline/skills` / `.cline/skills`——另读共享树，`readsUniversal` | — | — |
| amp | `$XDG/agents/skills` / `.agents/skills` | — | — |
| windsurf | `~/.codeium/windsurf/skills` / `.windsurf/skills` | — | — |
| zed | `~/.agents/skills` / `.agents/skills` | — | — |
| grok | `~/.grok/skills` / `.grok/skills` | CLI（§D8.13）：`grok mcp add <name> [-e K=V] [-s user\|project] -- <cmd>` / `--transport http <url> [--header "K: V"] [-s …]` → `~/.grok/config.toml` / 项目 `.grok/config.toml` · `mcp_servers`（TOML，只读） | `grok plugin install {url} --trust`（子进程；`--trust` 是厂商要求的非交互语法，不是跳过确认——闸 3 先行确认）；记录 `~/.grok/plugins/`（§D9）；来源持久化在 `~/.grok/settings.json` 的 `extraKnownMarketplaces`（`config.toml` 的 TOML 形态不读取——本仓无 TOML 读取器） |
| antigravity | — | — | `.antigravity-plugin/plugin.json`（`agy plugin install <url>`） |
| factory | — | — | `.factory-plugin/`（`marketplace.json` + `plugin.json`；`droid plugin marketplace add <url>`） |
| kimi | `~/.kimi-code/skills`（由 `KIMI_CODE_HOME` 迁移）/ `.kimi-code/skills` | 文件合并：`~/.kimi-code/mcp.json` · 项目 `.kimi-code/mcp.json` · `mcpServers`（§D8.13，literalEnv） | 根 `kimi.plugin.json`（规范形态；`.kimi-plugin/` 目录为回退）；安装经本地 web API（`kimi web`，§D9 2026-11-01 修订） |
| openclaw | `~/.openclaw/skills`（状态目录，由 `OPENCLAW_STATE_DIR` 迁移）/ 裸 `skills/`（工作区）——另读共享树，`readsUniversal` | CLI（§D8.13，JSON5 变体）：`openclaw mcp add <name> --command C --arg A… --env K=V… [--cwd D]` / `--url U --transport streamable-http --header K=V`（恒带 `--no-probe`）→ `~/.openclaw/openclaw.json`（由 `OPENCLAW_CONFIG_PATH` 迁移）· `mcp.servers`（JSON5，只读，仅全局——无项目落点） | `openclaw plugins install <spec> --force`（子进程；npm spec 钉 `npm:` 前缀，因为裸名会走 ClawHub 解析；`--force` 是厂商对非 ClawHub 源要求的非交互确认——闸 3 先行确认）；git 行走 `openclaw plugins install {plugin} --marketplace {repo} --force`；散装 `.openclaw/extensions` 根（状态目录 + 工作区）是读取面 |

- **经验证的插件落地 = 任何已声明的写入路径。** 本地 config/声明存储/散目录（opencode）、包管理器子进程（pi、claude）、运行时自己的 marketplace 命令链（§D9：claude、codex、factory、antigravity、opencode、cursor、grok；kimi 改经其本地 web API 应答）都算——交互式链条在闸 3 只展示、绝不执行，但仍是可作答的写入路径。控制台的 `hasExt` 闸读适配器的 `hasPluginLanding()`（base.ts）：未声明任何写入路径的宿主被隐藏，绝不以"只会拒绝"的复选框形式出现。
- **多数宿主只是读者，少数才是归属者。** 十四个宿主都读项目 `.agents/skills`；一个目录就是一个副本，所以由 `skillOwner()`（适配器注册表中第一个解析到该路径的条目）决定记录里的 host，其余宿主只是别名。安装、盘点、控制台共用这条规则。
- **归属与可读是两个答案，控制台两个都要问。** `skillOwner()` 回答"这个副本归谁"（安装目标、claim、卸载）；`skillReaders()` 回答"谁能**加载**它"（`CopyView.readers`，归属者在最前）。技能页的 harness 轨道按**可读性**筛选——装在 `.agents/skills` 里的一份技能对十四个运行时都可用，用归属去建轨道只会在一个条目下显示它、把另外十三个藏起来。写入仍然只认归属者（`KIND_META.skill.installAxis = 'skills-owner'`）：轨道是镜头，绝不是扇出的许可。
- **存在性是实测的，未探测到的宿主不进轨道。** 每个适配器声明 `presence` 标记——PATH 上可探测的可执行名和/或其配置目录——`hostDetected()` 依据这些标记加上该宿主任一全局技能根是否存在来作答（运行时删了但技能树还在，就仍然可见，否则它的副本将无处可管）。控制台轨道只显示已探测到的宿主，外加行已落地的宿主；`universal` 恒为已探测，于是一台还没装任何运行时的机器仍有落点。目录表本身保持静态——存在性是每个机器上 hosts 端点的实测，绝不改动 `HOSTS` 的成员。
- **根是通过本进程量出来的。** `adapter.skillRoots(ctx, scope)` 给出候选根，带 `origin: 'default' | 'env-override'` 与优先级序号；`OPENCODE_CONFIG_DIR` 会改变 opencode 的根，`PI_CONFIG_DIR` 会改变 omp 的根（DSH 声明 `DSH_HOME` 但没有技能落点）。从别的 shell 用不同覆盖启动的运行时在这里是不可见的，因此低优先级根上的副本**绝不**被报告成"没读到"。
- **`host ≠ SupportedClient`。** Cursor 既是制品宿主，也是代理接入的流量客户端（`cursor-proxy`）；宿主 id 仍是 `cursor`，因为 harness 域读的是制品、不是流量。VS Code / Zed / Windsurf 只是制品宿主，不为它们扩大流量枚举。
- **范围——全局与项目。** 可接受范围由唯一常量 `ENABLED_SCOPES`（`harness/scopes.ts`）给出，为 `['global', 'project']`。所有面向产品的路径都读它：安装/编辑路由对其它值回答 `unsupported_scope`，`scanInventory` 在控制台所选项目根下读取项目级技能根 / 插件来源 / MCP 落地，控制台把每个品类的已装视图拆成全局/项目两个页签。项目落点就是适配器声明的东西——`SkillsSpec.project`、`configProject`、`looseDir.project` 每个宿主只拼写一次——加上写入器的 `scope` 参数。两个与范围相关的细节：CLI 落地的项目级 MCP（§D8.13）以**项目根作为子进程 cwd** 运行运行时自己的命令，因为 claude `--scope project` / grok `-s project` 按 cwd 定位落地——而 codex 的 `mcp add`/`mcp remove` 根本没有范围语法，适配器直接**拒绝**项目范围而不是静默写全局配置；`external` 副本的 `path` 是身份令牌而非路径，因此 manifest 为每个项目级副本记录 `projectRoot` 作为唯一的项目归属。卸载守卫保留**两个**范围：任一范围下登记的副本都可卸载。范围能力是按宿主×品类给出的，而不是构建级统一：`HostAdapter.supportedScopes(kind)` 是所有消费者读取的答案，在 `BaseHostAdapter` 中从该品类自己的声明派生一次——项目级插件落地仅当 spec 声明了它才存在（`configProject`+`container`、`declared.project`、`looseDir.project`、带 `{scope}` 令牌的 marketplace 命令，或随范围变化的 `subprocessArgs`）；`PluginSpec`/`HostMcpSpec` 上的显式 `scopes?` 覆盖用于声明无法承载的情况（codex MCP：项目文件可读观察，但 `codex mcp add` 没有项目范围语法，因此 spec 回答 `['global']`；openclaw MCP 同为仅全局——定义按厂商设计集中在 `~/.openclaw/openclaw.json`，不存在项目落点）。`planPlugin`/`planMcp` 拒绝列表中不存在的范围——落全局却让 manifest 记 `project` 会让 manifest、清单盘点与卸载各持一份真相——`/hosts` 以 `kindScopes` 提供该矩阵，控制台从而绝不提供写入器会拒绝的范围（隐藏 Project 芯片，提交路径把过期的选择纠正为 `global`）。技能名会规整为 `^[a-z0-9]+(-[a-z0-9]+)*$`，且解析出的目标必须留在根内（`adapter.skillTarget` 拒绝任何越界）。
- **`readsUniversal`** 记录该运行时是否原生读取跨代理的 `.agents` 目录；它决定别名/归属关系，也决定哪些宿主不需要厂商专属写入就能接受技能副本。
- **共享集只有一个排除项，且默认勾选。** 钉住某个运行时的技能页会列出该运行时能**加载**的每一行，因此归 `universal`（共享 `.agents` 目录，十个运行时都读）的行会在每个轨道条目下重复出现，把真正属于该运行时的行挤下去。`hideShared` 开关按副本归属（`row.hosts` 含共享宿主）把它们筛掉。它是一个 facet 而不是模式——筛选的是来源 chip 计数所用的同一张表，所以每个 chip 的数字仍然诚实——并且在无意义的地方不出现：MCP/插件页（那里没有共享落点）、共享条目本身（那会把要收窄的列表清空），以及筛掉共享后不剩任何私有行的页面。最后这道闸门同时守着**默认值**：开关出厂即勾选，所以技能全在共享树里的运行时仍然打开完整列表。开关上带着它当前隐藏的条数，被隐藏的集合永远有账可查。

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
- **内容库只由技能写入器使用**：载荷先进 `<storeKey>.tmp-*`，改名提升后再逐目标复制。MCP 与插件没有内容库 blob——它们要么改配置文件，要么跑包管理器。
- **manifest v3** 为插件带上制品级 `harness`，并把 kind 改拼为 `plugin`（原 `extension`，§D2）。**刻意不做旧版迁移**：pre-v3 文件按无法解析的字节处置（set aside），manifest 从空开始——已装制品从源重新安装即可。（v1/v2 的 `extension:` 拼写与迁移机器——按宿主拆分、`manifest.orphans.json`——随改名一并退役，2026-10-30。）
- **记录会带上来源声明的一行 `description`**（可选；来源没有声明时字段缺席）。控制台优先显示已安装内容里的文本——技能的 `SKILL.md` 在查看时读取——只有副本里没有我们可读的文件时才回落到这个字段：运行时自己 store 里的 npm 包、宿主配置里的一个 MCP 条目。发现行（运行时自己装的）直接读运行时 store 里该包自己的 `package.json` `description`：这是本地文件读取，绝不是 registry 往返，因此一台装满插件的机器不再渲染成一墙空白卡片，而重扫也不会变成 N 次网络请求。
- **本地插件行用自己的材料描述自己**，免得手动放进去的插件也成一墙空白卡片。路径指向目录时，读该目录 `package.json` 的 `description`；路径指向文件时，读文件首个块注释的第一段（上限 300 字符，折成一行）。既无头注释又无清单时为 `null`——这是读取作者写下的话，绝不是猜测、不是由文件名拼出来的短语、也不是 registry 查询。
- **没有 GC。** 内容库与回收站只增不减；删除"无引用"blob 会删掉别人的回滚。手动 prune 是唯一出口。

```jsonc
{
  "version": 2,
  "artifacts": [{
    "id": "plugin:opencode:npm:@acme/plugin",   // <kind>:<canonicalKey>，插件带宿主
    "canonicalKey": "npm:@acme/plugin",
    "kind": "plugin",
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
| plugin | `plugin[]` 数组编辑**或** `pi install npm:<spec>`——恰好一个宿主 | 逐字回显命令，必须 `confirm: true`，绝不加 `-y`，120 秒超时 |

- **插件只针对一个宿主，绝不多个。** 装进两个运行时就是两次安装、也就是两个制品：`kind: plugin` 且 `hosts.length !== 1` 会被后端拒绝。
- **合并不重写无法往返的文件。** 带注释的配置（JSONC）被拒绝，而不是被 stringify 掉注释；`createBackup` 在原子改名之前写 `.bak.ocr`。
- **子进程安装会执行第三方代码。** 计划逐字回显命令，运行器绝不追加 `-y`/`--yes`，捕获输出，记录退出码。
- **写入顺序。** 技能：认领 → 内容库暂存 → 逐副本 `cpSync`（失败副本删除并释放）→ 最后写 manifest。MCP：认领 → 合并 → 备份/写盘 → 最后写 manifest。插件：执行/合并 → 最后写 manifest。因此 manifest 条目只可能出现在已经落地的副本上。
- **卸载操作跟着落地形状走,不跟来源走:**

  | 落地形状 | 操作 | 被销毁的东西 |
  | :--- | :--- | :--- |
  | 文件树、松散插件文件 | `move-to-trash` | 该树，进 `trash/<ts>-<planId>/` |
  | JSON 数组里的一个字符串（`plugin[]`、pi `packages[]`） | `drop-entry` | 该字符串；先写 `.bak.ocr` |
  | JSON 对象里的一个成员（`mcp` 里的服务） | `drop-server` | 该成员；先写 `.bak.ocr` |
  | 没有声明文件的包副本 | `prune-record` | 仅记录 |

  `path` 是**配置文件**的副本永不进回收站：`opencode.json` 里装着其它所有服务与插件，移动它等于删掉不属于我们的配置。来自发现行的 `trash-path` 描述符还要过包含校验（必须直接位于已知技能根或宿主声明的松散插件目录之下）——这是路径安全规则，不是归属仪式。

- **卸载是 plan → confirm → apply**，计划 TTL 10 分钟。apply 会重检每个非 `drop` 目标仍存在，`dirty` 副本无 `discardLocalEdits` 则拒绝，且只有全部文件系统操作成功后才写 manifest。每个被执行的制品都留一条 `applies` 账本行（`remove`），包括磁盘上没留痕迹的 `prune-record`。
- **认领只在路径被销毁时释放**（`move-to-trash`）。配置成员编辑不会消灭文件，而该文件通常还装着别的制品。

### D6 — 来源是适配器,每个都要说清自己能做什么

`registry.ts` 是能产出载荷的适配器；`common/source-views.ts` 里的 `SOURCES` 是控制台渲染的视图（由各内建目录自己的声明组合而成）。视图里有、注册表里没有的来源，回答 `unsupported_source`，而不是假装能用。

| 来源 | 种类 | 可访问性（实测） | 角色 |
| :--- | :--- | :--- | :--- |
| GitHub `owner/repo` | skill | 匿名；搜索 10 次/分，`GITHUB_TOKEN` 可选 | 内容来源：每次安装一个 tarball，上限 200 文件 / 8 MiB |
| npm registry | plugin, mcp | 匿名 200 | 仅作**安装解析器**（浏览目录已按所有者决定于 2026-10-31 移除）：`npm:<pkg>` 句柄解析为钉住 spec 的启动命令（`npx -y <pkg@version>`，记录版本 + `dist.integrity`——registry 之外没有作者运行时参数，因此一个也不编造）；pi.dev 行经它安装。npm 作技能解析为 `unsupported_kind` |
| pi.dev 包目录 | plugin | 匿名 200，服务端渲染 HTML——没有 JSON API；每页 50 张卡片，用目录自己的 `&page` 寻址 | Pi 官方目录，绑定 `pi`；只读浏览：每行自带 `pi install npm:<pkg>` 命令，因此 key 是 `npm:<pkg>`，安装经 npm 源执行 |
| ClawHub | skill | `GET /api/v1/skills?limit=&cursor=&sort=`（游标分页，自带 `sort` 枚举）、`GET /api/v1/search?q=` ——**没有分页参数**，一次应答就是一个窗口；`GET /api/v1/skills/<slug>?ownerHandle=` → 单条技能的自身记录（`skill.description` 就是发布的 `SKILL.md`，另带 `latestVersion`、`stats`、`owner`）；`GET /api/v1/download?slug=&ownerHandle=&version=` → 确定性 ZIP 字节；匿名读 3000 次/分/IP，429 带 `Retry-After`（实测 2026-10-25） | **在线**，且是唯一从**自己托管库**安装的技能注册表：行不带 GitHub 仓库，因此 pin 是注册表版本（`{clawhub:{slug, version}}`），`stars` 保持 `null`——注册表自己的星标/下载/安装计数走 `registryStats`（它自己的单位，标注为 ClawHub 的），绝不被当作 GitHub 星标重贴标签。`ownerHandle` 是注册表自己的 409 报错指明的消歧参数——端点上未文档化，但实测有效（owner 不对时回 404）。应答 200 却带 JSON 的是注册表给 GitHub-backed 技能的 `public-github` 移交描述符；其形状未文档化，适配器按名拒绝而不猜测 |
| manual | mcp, plugin | 操作者输入 | 逃生口：`manualPayload`（MCP）/ `manualSpec`（插件） |

今天**没有可浏览的 MCP 目录**（`MCP_DEFAULT_VIEWS` 为空）：早期版本列出的官方注册表、Smithery 以及 OpenCode 目录适配器都随独立浏览目录一并移除。MCP 行仍可通过宿主自己的视图或操作者来源出现；该轴保留自己（空）的注册表，未来的 MCP 目录因此永远不会被声明进插件表。

- **一份归一化载荷。** 写入器看不到来源：技能 → `{files}`；MCP → `{launch}`；插件 → `{spec}`。产不出载荷的来源就是只读浏览，并明说这一点。
- **上限约束的是解压后的字节，且在任何解压之前。** 声明的压缩长度不构成内存边界（deflate 可达约 1000:1）：文件数从归档自己的目录记录读取，每次解压都被限制在剩余预算内，因此超限载荷以 `too_large` 被拒，而不是在网关进程里展开。
- **来源可以绑定宿主。** `hosts?: HarnessHostId[]` 把适配器收窄到其载荷真正能喂的运行时；控制台只在那些页面渲染它的入口，安装会拒绝其它宿主。
- **视图顺序就是噪音顺序。** `SOURCES` 数组既是控制台的 chip 行，也是落地优先级：每个轴上，市场打开的是**第一个** enabled+browsable 的来源。顺序跟随一行声明的边界有多宽：行**就是**制品本身的目录——官方目录（`pi-dev`）、精选注册表（ClawHub）——排在"承载制品的容器"的搜索之前，后者又排在 npm 之前——最宽也最吵的一张网，**刻意声明在最后**：宽网是操作者主动选入的面，绝不是默认落地面。**技能轴只留一个 chip（所有者决定，2026-12）：** 技能市场只浏览 ClawHub——skills.sh、GitHub 与 npm 全部移出技能轴。技能市场是一个行**就是**技能的精选注册表，不是相关度搜索；skills.sh 的封闭 API 与 GitHub 的主题搜索连同各自适配器在同一 commit 移除（npm 与 github 仍保留为 host 轴的**安装解析器**——`github:<owner/repo>#<dir>` 或 `npm:<pkg>` 句柄总得有地方解析——只是不再作为发现芯片）。
- **来源是代码配置,不是用户配置**（见"未实现"）。
- **目录型来源可以回答另一个来源的身份，而且必须"挣得"这个身份。** 行不能自己发明安装句柄："挣得包名"的规则只有一处，在 `common/npm-catalog.ts`（条目声明的包名 → 规范化候选 → 对照 registry 与包自身 `repository` 字段核实，绝不接受"存在一个同名包"）。解析出的载荷由 npm 适配器产出，因此制品的 `canonicalKey` 是 `npm:<pkg>`——同一个包无论由哪个目录发现，都只有**一个身份**。`sourceId` 记录的是**在哪发现的**，那是来源出处而不是身份；正因如此，插件写入器的 `ref` 从 key 自身推导，而不是按请求来源的名字长度去切。行上带着**另一个来源** key 的目录（Pi 目录按 `npm:<pkg>` 安装）会因此丢掉这条出处，所以安装请求同时携带 `listedOn`，记录两者都保留（D8.6）。
- **目录只发布 HTML 时，就从 HTML 读。** `pi.dev/packages`（Pi 官方目录）是服务端渲染、不提供 API，因此 `plugin/adapters/pi-dev.ts` 依据目录自己的筛选/排序脚本已在消费的机器可读属性（`data-package-card`、`data-package-name`、`data-package-types`、`data-package-date`、`data-package-path`），再加上页面印出的 `pi install npm:<pkg>` 命令——那是目录自己对"这一行装什么"的声明。这份契约没有版本也没有文档，所以读取器**宁可大声失败**：页面既无包卡片也无结果计数标记，或卡片里取不出包名时，回答 `upstream`，绝不回答空市场。类型为 `plugin` 的行、无类型行、以及 `skill`/`theme`/`prompt` 行**全部列出**：每一行都用同一条印出的命令（`pi install npm:<pkg>`）写进同一个运行时包存储，所以这层不做剔除，目录自己的计数因此就是精确的 `total`。行上的类型徽章是目录的词汇，不是本市场的种类。卡片上的 `data-package-downloads` 只用来让上游按它排序，**不会**被塞进市场的 `stars` 字段。**翻页也交给目录自己**：每页 50 张卡片、用它的 `&page` 参数寻址，而网格上方的计数标记（`1-50 / 286 (of 5338)`）同时回答总数与"有没有下一页"——解析出来，绝不靠多打一次请求去探测。因为本市场不剔除任何行，目录第 `i` 行就是市场第 `i` 行，所以控制台的一页可以按算术映射到它跨界的那一到两个目录页（24 行 < 50 卡片）：任意深度最多两次抓取，既不用从第 1 页开始走，也不需要上限，更不会出现重复或缺行；每个目录页在共享的 60 秒窗口内只抓一次。适配器报告来源自己的 `total` 与 `hasMore`，因此控制台用**共用分页条**渲染这个市场（摘要 `1–24 of 5338` + 页码条），而不是给单个来源做特例。
- **"来源没有热度信号"就是 `null`，绝不是 `0`。** 没有任何已上线的浏览来源发布 GitHub 星数：ClawHub 用自己的单位在 `registryStats` 里给出下载/星标计数，pi.dev 的下载量又是另一种度量，因此这些行带 `stars: null`，控制台渲染成破折号。印 `0` 等于断言"没人星标过它"，而这些来源从未这样说过。行上如果**指名了仓库**，仍可取得真实星数，但只能**按需**（`harness/common/stars.ts`、`POST /api/admin/harness/market/stars`）：浏览本身绝不代操作者花掉星标配额。解析器做批量：GitHub 的搜索端点接受一条查询里的多个 `repo:` 限定符，因此 24 行的一页约花 3 次请求而不是 24 次；分组按查询的字符预算切，而不是固定条数；每个答案缓存数分钟，翻回去不重复花费；GitHub 没有收录的仓库进 `missing`，不会被折成 0。匿名搜索为 10 次/分钟，`GITHUB_TOKEN` 可提高上限，且与浏览读取器共用同一份请求头。
- **市场行与已装行的"详情"都由服务端读取，绝不放进 iframe。** `GET /api/admin/harness/detail` 回答一行的长文部分——README、许可证、最新版本、发布日期——先读 npm registry 文档；当它没有正文（或该行根本没有 npm 包）时，再读仓库（`api.github.com/repos/<repo>` 与 `/readme`）。`clawhub:<owner>/<slug>` 行两条路都不走：该注册表自己托管技能、不提供仓库，所以它的长文部分取自注册表的**单条记录**（`GET /api/v1/skills/<slug>?ownerHandle=`）——其 `skill.description` 就是发布的 `SKILL.md`（渲染前先剥掉 frontmatter），`latestVersion`/`stats` 提供版本、许可、日期与计数。这些计数（ClawHub 自己的星标、下载、安装）走 `registryStats`，**绝不进** `stars`：星标列的含义是 GitHub 星数，其 tooltip 会说明这个数字属于谁。控制台用**原生弹框**呈现，因为实测无法嵌入来源页面（2026-10-25：`github.com` 返回 `X-Frame-Options: deny`，`www.npmjs.com` 在 Cloudflare 挑战后返回 `SAMEORIGIN`，`pi.dev` 返回 `SAMEORIGIN`；少数可嵌的社区站点，其行内 URL 又都指回 GitHub）。**已装行打开的是同一个弹框**：它的身份从 `canonicalKey` 推出来（`npm:<pkg>` → registry 文档，`github:<owner>/<repo>#<dir>`、运行时存自己写的 `git:github.com/<owner>/<repo>`、运营者 git 市场的 `mp-<slug>:<owner>/<repo>#` → 仓库，`clawhub:<owner>/<slug>` → 注册表记录），所以"我装了什么、它自己怎么写的"在两个页签上都只需一次点击；没有公开身份的行（`manual:<name>`）也能打开，只显示本地记录的元数据、没有正文——弹框陈述它知道的事，而不是拒绝。该端点只用这一行**声明的身份**构造上游——`npm:<name>` 里的包名、校验过的 `owner/repo`，以及 `clawhub:<owner>/<slug>` 这一对——绝不用行上的 `url`：一个会跟随调用方 URL 的 admin GET 就是一个 SSRF 代理。每一半都在边界处校验（`safePackageName` 拒绝路径穿越、多余分段与裸 `@scope`；`safeRepoSlug` 与 ClawHub 这一对拒绝 URL 与 `.`/`..`）。什么都读不到的行仍然给出答案（`readFrom: 'none'`、README 为 `null`），因为弹框是以浏览结果已经带回的行内容为骨架的；被拒绝或被限流时给出可翻译的 `reason`（GitHub 匿名额度用尽为 `rateLimited`，其余为带状态码的 `http`），英文 `message` 仅作兜底。README 上限 120 000 字符、缓存 10 分钟——比浏览缓存长，因为正文不会随键击变化，而匿名 GitHub 额度是 60 次/小时；失败的结果绝不缓存，所以下一次点击是**新一轮尝试预算**，而不是十分钟的死路。弹框默认是 900px 卡片，全屏由操作者自己切换、绝不是默认。它还能**翻译正文**：翻译路由的 `format: 'markdown'` 会切到**长文契约**——独立的系统提示（描述提示会把 3 000 字文档答成两句话）、散文按 4 500 字符分块、围栏代码**原样复制**而交给模型重打、以及 20 000 字符的预算：超出部分以源语言返回并置 `truncated: true`。任何一段都**绝不半译**——替换半译的段落会把它的尾部从文档里丢掉——结果写进**自己的一条文件**（`i18n/readme/<sha256>.<lang>.json`）、按完整源文建键，因此重新打开弹框不花钱，删掉某一页的译文也绝不影响别人。花在哪一个模型上是运营者的配置决策：`defaultModels.translation`（任何网关可见的 modelRef）指定首选，`lite` 别名殿后；`auto` 绝不自行出现——内部非关键调用不允许无上限花费，链条失败就如实报错而不是升档（运营者显式写 `auto` 视为自担成本，照常生效）。控制台默认模型选择器旁有链路探针（`POST /api/admin/harness/translations/probe`）：以一行短文走真实链路——测的是选择器里的未保存值（先测后存，清空则按纯 lite 测）——并报告实际服务的模型，绝不写缓存；显式点击即显式承担这一次调用的花费。这个存储会被**清扫**：条目 90 天过期，随后从最旧的开始裁剪，直到整个存储落进 32 MiB 预算——写入后每小时最多一次，也可用 `POST /api/admin/harness/translations/prune` 立即执行；崩溃写入留下的临时文件一小时后清除。拆分前的旧大文件一旦**自身**超过同一时限也会被删除（它的 mtime 就是旧构建最后一次写入的时间；留着它会让它比自己产出的每一条都活得更久）。重新打开一个翻译过的页面时，控制台用只读批量接口（`format: 'markdown'`）读回该条目，所以弹框**打开即译文**、既不用点也不调用模型；标题栏的徽章随时切回原发布文本。正文走**自己的**渲染管线（`frontend/src/lib/readme-markdown.tsx`）：原始 HTML 先被解析（`rehype-raw`）再立刻**净化**（`rehype-sanitize`）——依据库自带的 GitHub 派生白名单，外加 README 真的会用的表现型标签（`details`/`summary`/`kbd`/`picture`、`align`），`href` 只允许 http/https/mailto、`src` 只允许 http/https。这与模型输出是**不同的信任模型**（后者根本拒绝原始 HTML）：README 是操作者主动打开的仓库正文，其中一半是用 `<div align="center">` 写的。远程图片**只在**这个界面加载（`referrerPolicy="no-referrer"`、`loading="lazy"`）；其他界面不会因此获得 HTML 能力，`script`/`style`/`iframe`/事件处理器/`javascript:` URL 永远过不了净化器。
- **排序是「源」的，不是控制台的。** 每个源在 `GET /sources` 里声明它真正能提供的顺序（`sorts`），控制台只渲染这张清单；选中的键作为 `sort` 送到 `/browse`，先按声明校验再交给适配器，因此源喂不动的顺序会被丢弃而不是照发。凡是有公开契约的源，控制台都给出**完整的官方集合**、绝不做"精选子集"：ClawHub 用它自己的 `sort` 枚举；pi.dev 目录给它自己排序控件里的三种（`downloads`/`recent`/`name`，即实测会改变页序的 `?sort=` 值）。没有任何已上线来源由后端整表读取，因此没有在本地计算出的全局序。控制台永不重排任何列表；只有一种顺序（或没有）的源显示成一行静态文字，绝不是点不动的下拉——重排当前页等于宣称一个人人都没算过的全局顺序。
- **浏览缓存 60 秒**，因为匿名 GitHub 读取受 10 次/分 的配额约束，否则每次键击都会花掉一次。缓存按**精确查询串**建键，因此不同前缀就是不同的上游调用——控制台因此只在**提交**查询（回车、切来源、清空）时发请求，输入框里的文字永不上网。控制台也可以强行重读：刷新按钮发出 `refresh=1`，`browseSource` 在分发前先逐出**该来源**的缓存族（`evictBrowseCache`），因此一个仍然温热的窗口不可能回答一个本就意味着"要新数据"的请求——而且刷新一个目录绝不会丢掉另一个目录刚预热的窗口。刷新按钮照旧绕过该窗口（逐出逻辑不变），搜索应答仍用共享的 60 秒。单个来源挂掉只回答自己的原因，绝不清空整页。读取失败同时给出 `reason`（`network`、`timeout`、`http`、`rateLimited`、`unavailable`、`markupChanged`、`badPayload`、`unsupportedSource`），由控制台经 `harness.browseError.*` 翻译；英文 `message` 只作为控制台不认识的 reason 的兜底——与市场提示同一条规则：**后端陈述事实，控制台拥有措辞**。运行时自己的文字永远到不了操作者眼前（它既没有主语，又让人去传一个控制台无法设置的 fetch 选项），粗粒度的失败类别留在 `code` 里，调用方按它分支。

- **市场读取对每一个失败应答都重试，不再只挑"看起来瞬时"的失败。** 每一次市场抓取都走**同一个** helper（`harness/net.ts` → `fetchWithRetry`）：同一套策略若在每个读取器里各写一遍，等其中一个学会了新状态码那天就会漂移。策略（`MARKET_RETRY`）是 5 次尝试、间隔 400 毫秒起逐次翻倍（±20% 抖动）、单次 6 秒、**总计 30 秒预算**——操作者确认的忍耐上限（2026-10-25；旧策略为 10 秒内 3 次尝试）。预算是契约、`attempts` 只是上限：每次尝试的截止时间是预算的剩余量，所以快速失败的端点约 7 秒内用完全部 5 次询问，而硬挂起的端点大约得到 4 次完整尝试，操作者在 30 秒耗尽时看到 `timeout`——不会更晚，因为预算连睡眠也一起封顶。重试：抛出的网络错误与**所有**状态码（含 `4xx`）——npm CDN 在发布传播期间的瞬时 `404`、比退避还短的突发 `403`/`429` 窗口都真实存在，而 10 秒预算框死了死胡同重试的代价（2026-10-25 修订：旧策略绝不重试 `403`/`429` 及其余 `4xx`）。唯一的提前返回是剩余预算放不下的 `Retry-After`——服务器点名了一个策略兑现不了的等待，再问一次必然徒劳；放得下的 `Retry-After` 则垫高下一次睡眠的下限。仍然绝不重试：解码不出的负载（`badPayload` / `markupChanged` 是**答案**，不是抖动）。helper 把**最后一个响应**原样交回而不是吞掉，因此每个读取器仍按自己的 `reason` 映射状态码；若每次尝试都抛错，则重抛最后一个错误，原有措辞不变。**只用于读**——安装仍然只尝试一次：写路径绝不能在操作者背后被重放。

### D6b — 内部回环调用钉住保留会话 ID

翻译与探测调用经网关自己的回环 `/v1` 面进来，不带标记时**每次调用**都会铸造一个新 `cold_start` 会话，控制台会话列表被单轮内部行淹没。因此内部调用方经 `router_options.session_id` 钉住**按用途固定**的会话 ID：`ocr-internal:translation`（描述 + README 分块）与 `ocr-internal:translation-probe`（链路探测）。`ocr-internal:` 前缀是**保留命名空间**——它声明"该行是网关内部噪音"，不是强制约束；外部客户端发送同前缀同样会被隐藏，这一点被接受（管理面信任其调用方）。标记**就是 ID 本身**：持久化轨迹以 `sessionId` 为键，因此网关重启后分类在活跃行与轨迹重建行上都天然存活，无需存储任何标志——`GET /api/admin/sessions` 由前缀推导 `internal: true` 并默认隐藏这些行（`hideInternal=0` 可显示）。控制台把该开关放在会话说明行右侧（`隐藏内部会话` 勾选框），并给显示出来的内部行打 `内部` 徽章——默认生效后该分类在界面上仍然可见。翻译链是显式的（configured → lite），共享会话永远不可能棘轮升档。

### D7 — 身份:一个制品一个键

| 种类 | `canonicalKey` | `artifactId` |
| :--- | :--- | :--- |
| skill | `<sourceId>:<ref>[#detail]`，如 `github:owner/repo#dir` | `skill:<canonicalKey>` |
| mcp | `<sourceId>:<ref>`，如 `manual:brave` | `mcp:<canonicalKey>` |
| plugin | `npm:<name>` / `manual:<spec>` | `plugin:<harness>:<canonicalKey>` |

- **插件把宿主放进 `artifactId`,不放进 `canonicalKey`。** 同一个包装进两个运行时是两次安装、两套回滚；合并会让"卸载"含义模糊。`canonicalKey` 保持与运行时无关，将来若出现跨运行时 ABI 仍可按 npm 身份归组。
- `name` 是磁盘目录名（技能）或逐字写入的 spec（插件）。两个制品抢同一个目录是**拒绝**（`exists`），不是一个以后才发明的后缀策略。
- **来源是存下来的,不是合并出来的。** `pin`、`sourceId`、`listedOn`、`trust` 随记录走；本版本没有信任梯级的字段仲裁（见"未实现"）。`listedOn` 会累积来源面（D8.6），而 `sourceId`、`pin`、`trust` 始终是**那一个写入方**的说法。
- **来源面与写入方是两件事。** `sourceId` 点名产出载荷的写入方；`listedOn`（写入方在前、去重、上限 8、在路由处对照来源注册表校验）记录这一行是**在哪被浏览到**的，因为目录行可能带着写入方的 key——Pi 目录里的包安装时就是 `npm:<pkg>`。本地页的来源 chip 按两者的并集收窄与计数，并且**只在该来源本页至少装了一条时出现**（判据不分面：被搜索收窄成 0 的 chip 仍然保留）。行内的来源单元格回答"我是从哪里装的"——显示**浏览面**（Pi 目录装的包显示 `pi.dev`，那正是操作者点下的目录），仅在记录没有其它来源面时回退写入方；写入方没有丢：它在 `sourceId`、`canonicalKey`（`npm:<pkg>`，单元格 tooltip）和 chip 并集里。制品永不被改名，只是这一列的问题得到字面回答。计数仍是发现面，绝不是对制品身份的声明。

### D8 — 铁律（每一条都在代码里生效）

1. **不自动安装、不自动更新。** 每次写入都走 plan → confirm → apply；控制台里的补救动作也从不自行执行。
2. **不静默合并。** MCP 计划报告确切的增/改键；JSONC 文件直接拒绝。
3. **网关装的是指令和可执行文件,并且明说。** `SKILL.md` 装完就是代理的指令；`pi install` 会跑 npm lifecycle scripts，执行第三方代码。确认文案逐字说明这一点，并记录确切命令。
4. **MCP 密钥默认只留名字，值永不回读。** 启动记录只携带 env/header 的**键名**；只有操作者在控制台的
   registry 驱动表单里亲手填了值，这个值才会原样写入运行时自己的配置文件——绝不进入 manifest、ledger、
   日志或任何读接口的回答。harness 从不回读已存的值：只报告「已设置」，不回显内容。ADR-0006 的
   provider 凭证库不受影响。
5. **不可信输入纪律。** 注册表载荷先被归一到窄形状再进控制台；校验在任何写入器之前完成（名称文法、spec 文法、`..` 段、launch 形状）。
6. **安装状态按副本,绝不按布尔。** `state` 是唯一逐副本词汇（`clean | dirty | missing | foreign | untracked`）；`partial` 是派生汇总，永不落盘。`untracked` 只回答"没有 manifest 条目"，从不等于"不可卸载"（D5）。
7. **落盘 ≠ 加载。** 默认声明是 `materialized`。安装后探针只在有证据时把它升级为 `verified`——技能：`SKILL.md` 在；MCP：服务键在解析后的配置里；插件配置副本：spec 在宿主声明的容器里；`external` 副本：apply 时的退出码。探针失败记 `unverified`；无法判定则保持原值。控制台没有探针结果时绝不写"已加载"。
8. **发现是观测,观测不是卸载禁令。** 运行时自己装的东西，从它自己的记录里读出来——写入器合并的 `plugin[]` 数组（向宿主适配器询问：`readSources`）、MCP 写入器合并的**对象**（`configPath` 解析出的文件内的 `mcp` 容器，因此操作者手工加的服务同样是观测对象），或 pi 的声明文件 + lock 文件 + 松散 `extensions/` 目录——合并进唯一的 `discovered[]` 通道，按 `kind`、`harness` 打标。四条规则：行是 `untracked`，永不被提升为 manifest 制品；不被当作我们的副本去 stat/哈希；它携带 **`removal` 描述符**（松散文件是 `trash-path`，`plugin[]`/`packages[]` 里的一个字符串是 `drop-entry`，`mcp` 对象里的一个成员是 `drop-server`），因此与受管副本用同一批按形状的操作卸载——描述符是计划参数，`trash-path` 仍要过包含校验；manifest 已记录同一 `(harness, canonicalKey)` 时排除——MCP 服务按同一 `(host, serverKey)` 排除——一次安装永不被报告两次。解析是容错的：运行时在我们读的同时重写自己的配置，只会回答"没有行"，绝不抛错。**跨版本读取阶梯**：运行时在大版本之间搬过落点时，每种可能的拼写都读（`opencode`：v2 `opencode.jsonc` + `plugins[]` + `plugins/`，v1 `opencode.json` + `plugin[]` + `plugin/`），且每行的 `removal` 描述符点名该条目**实际**所在的容器——卸载编辑的是运行时读取的数组，不是我们会写入的那个。JSONC 配置按 JSONC 解析（注释不是损坏）；写入落点仍拒绝 JSONC 重写，优先已存在的纯 JSON 候选（§D8.2）。
9. **`external` 是归属标记,不是状态。** 包管理器托管的副本没有我们的路径：`path` 是身份 token `<canonicalKey>#<harness>`，永不被 stat 或哈希，状态报 `clean`、`placement` 报 `verified`，因为子进程退出码就是证据。它的卸载编辑运行时自己读取的声明（`pi` 的 `settings.json` `packages[]`，claude 的 `installed_plugins.json` `plugins`）；宿主没有声明文件时退回 `prune-record`，并明说包体仍在。绝不发明未经验证的反向命令。
10. **claude 的插件落点是运行时自己的 CLI 和映射记录。** 插件经 `claude plugin install <id> --scope user|project` 安装（铁律 3：逐字回显确切命令、确认后执行、硬超时——绝不手改 claude 自己的状态）。记录在 `~/.claude/plugins/installed_plugins.json`：一个以插件 id（`"<名称>@<市场>"`）为键的**对象映射**，每个值携带 `installPath` / `version` / `installedAt`；启用状态在各 settings.json 的 `enabledPlugins` 里，由运行时自己从这个记录同步。两条在代码里生效的推论：插件 id 与带版本的 npm spec 形状冲突，所以每条记录都以 **`claude:` spec 前缀**读取（canonicalKey 为 `claude:<名称>@<市场>`，绝不按 npm 解析）；记录是映射，所以发现层按形状读（来源上的 `containerShape: 'map'`），卸载反向操作是对运行时自身键的 `drop-server` 成员删除（`~/.claude/plugins/marketplaces/` 下的市场/物料缓存保留——与 pi 一样，明说包体仍在）。行的版本与描述取自条目值和已装插件自己的 `.claude-plugin/plugin.json`。这个记录是**全局的**（同 pi）；`--scope` 旗标携带安装范围，记录本身不分叉。

    **原生市场安装携带两个身份。** `canonicalKey` 仍是市场行的键（`mp-…`，控制台用它把该行标为已装）；记录同时保存 `nativeKey`——运行时自己的 `<插件>@<市场>` 存储键——发现层两种拼写都排除。否则一次 `claude plugin install` 会出现两次：一次是受跟踪的制品，一次是从 `installed_plugins.json` 读回的映射成员。该字段出现之前写入的记录，对 git 市场安装按 `(harness, 插件名)` 去重，因此无需重写 manifest 也能保证不重复。

11. **MCP 的健康状态由运行时回答，不从磁盘推断。** 落盘探针（D8.7）只证明配置成员存在，证明不了服务已连接。凡暴露实时接口的 MCP 宿主（opencode v2：`GET /api/mcp`），控制台读取运行时自己的 `connected | pending | disabled | needs_auth | failed` 并按服务展示——配置副本完好时，`needs_auth` / `failed` 仍会让该行异常；健康的实时回答也会显示，而不是留空。该读取与盘点扫描分离（`GET /mcp/runtime`）、有界且只读：没有服务、守护进程不可达或接口不支持都只回答"没有实时结论"，绝不当作失败判定，磁盘状态独立成立。

12. **MCP 落点是一份按宿主的契约，不是一种条目拼写（修订，2026-12）。** 三个宿主落 MCP 服务，它们的配置除"有名字的服务"之外毫无共同点：opencode 把对象合入它本来就拥有的配置文件，pi 与 omp 各有一份专用 `mcp.json`。因此落点由每个宿主回答四件事——路径/容器（§D8.2）加上 `shape`、`secretRef`、`namePattern`——而每一项都是从运行时自己那里**读**来的（它发布的文档、它的配置 schema、或它自己的 `add` 命令写出的文件），绝不从邻居运行时推测：

    | 宿主 | 全局 · 项目文件 | 容器 | 条目 | 密钥引用 | 名称语法 |
    | :--- | :--- | :--- | :--- | :--- | :--- |
    | opencode | `opencode.json` · `opencode.json` | `mcp` | `{type, command[], environment, enabled}` | `{env:KEY}` | `^[\w.-]+$` |
    | pi | `~/.pi/agent/mcp.json` · `.pi/mcp.json` | `mcpServers` | `{command, args, env}` | `${KEY}` | `^[A-Za-z0-9_-]+$`（点号由 pi 自己拒绝） |
    | omp | `~/.omp/agent/mcp.json` · `.omp/mcp.json` | `mcpServers` | `{command, args, env}` | `${KEY}` | `^[A-Za-z0-9_.-]{1,100}$` |

    每个格子的证据都是运行时自己的产物，这也是它可信的原因：pi 把 `mcp.json` 发布在 agent 目录，其 `mcp add` 写入器存 `{command, args, env}` 并把 `${VAR}` 留给加载时展开（`pi mcp add foo.bar` 直接回答 `invalid server name`）；omp 的 schema（`mcp-schema.json`）点名 `<agentDir>/mcp.json` 与 `.omp/mcp.json`，它的发现读取器就打开这些路径，它的 helper 展开 `${VAR}` / `${VAR:-default}`，而它根本没有 `mcp` CLI 动词——所以对 omp 来说**文件**就是写入面，不是退路。

    四条推论由代码而不是约定来保证：
    - 条目按宿主**合成**（`mcpEntryForLaunch(existing, launch, spec)`），因此 opencode 专有词汇（`type`、`enabled`、`environment`）绝不会被嫁接到没有这些词汇的运行时上，操作者自己写的、不属于我们的字段也能在一次编辑后存活；
    - 密钥引用按宿主拼写（`secretReference`），而**两种**拼写读回时都算"引用，不是值"——`${KEY}` 绝不能被当作已存密钥报给控制台；
    - 被运行时自身语法拒绝的名字是**逐目标**拒绝，而不是整请求失败：`tools.brave` 会落进 omp、对 pi 被拒，apply 结果带着被跳过的宿主与原因（铁律 2 仍然要求先展示计划再落盘）；
    - 两种命令拼写都**读**（`command[]`，以及 `command` + `args`），所以发现行无论由哪个运行时写出，都能同样地描述自己。

    这里**没有**覆盖、也不得被误认为已覆盖的：配置文件是**运行时自有状态**、而不是我们可以合入的 config 的宿主（claude 的 `~/.claude.json` 同时承载会话/用户状态且由运行时自己反复重写；codex 的配置是带注释的 TOML）。它们需要"由 CLI 落地的 MCP 落点"（铁律 3 命令链、以运行时 store 为真相而不是对文件哈希、由运行时自己的动词做反向删除）；见未实现清单。

## 未实现清单（勿假设存在）

| 领域 | 现状 |
| :--- | :--- |
| opencode 之外的 claude / codex / grok / openclaw MCP 落地 | 已作为 CLI 物化落点交付（§D8.13 修订，2026-11-02；openclaw 2026-11-03，JSON5 变体）：运行时自己的 `mcp add` / `mcp remove`（openclaw 为 `mcp unset`）动词负责写，运行时自有的配置文件只读观察，副本记为 `external`。kimi 以文件合并落点交付（专用 `mcp.json` 为纯 JSON，`literalEnv`）。`cursor` 与 `dsh` 仍无经核实的 MCP 面 |
| 由 CLI 落地的 MCP 落点（铁律 3 命令链、以运行时 store 为真相、用运行时自己的动词做反向删除） | 已交付（§D8.13 修订，2026-11-02）：plan 在闸 2 组合运行时自己的 argv，apply 有界地 spawn，副本记 `external`，反向删除是运行时自己的动词（`cli-remove`） |
| 已声明写入路径（opencode `config`；pi、claude、grok、openclaw `subprocess`；claude 映射记录 §D8.11；antigravity / factory / kimi 各自清单；§D9 marketplace 命令链：claude、codex、factory、antigravity、opencode、cursor、grok、openclaw；kimi 的 web API §D9 修订）之外的插件落地 | 不存在；其它宿主拒绝 |
| npm 作为**技能**来源 | 不再是任何轴上的视图来源；`npm:<pkg>` 只作安装解析器，技能轴解析返回 `unsupported_kind` |
| PulseMCP / mcp.so | 无可用适配器、视图里也没有行（实测 410 已退役 / 404） |
| 在 `config.yaml` 里声明来源 | 来源 = `common/source-views.ts` 的 `SOURCES` + `registry.ts`；没有 `harness.sources` 配置段 |
| 预写意图文件、跨副本安装回滚、manifest 咨询锁 | 未实现；保证是"最后写 manifest" + 逐副本回滚 |
| `shadowed` 汇总、`profile` 根来源 | 类型联合里有名字，没有产出者 |
| 内容库/回收站 GC、adopt 未跟踪目录、harness 导出/导入、`canonicalKey` 别名覆盖、目录重名后缀策略 | 未实现（重名 = 拒绝） |
| `dsh` 的 MCP/插件面 | 不支持：没有经核实的 MCP 面；CLI 物化落点模式（§D8.13）就是未来某个经核实面接入的缝 |
| 已验证的反向包管理器命令（`pi uninstall`） | 未实现；声明编辑就是已交付的撤销方式 |

## 后果

- 正面：三类制品一份盘点，漂移是被检出而不是被偶然发现；来源层是同一载荷形状后面的适配器，接入一个市场只需一个文件加一行视图，而不是重写页面；身份、信任与卸载操作只说一次、处处复用。
- 正面：按落地形状决定卸载操作，正是"卸一个插件"不再等于"删掉客户端整份配置"的原因——那是按来源判定时真实的失败模式。
- 负面：能力在 (kind × host) 上非常不均匀——MCP 落在 opencode、pi、omp、kimi（文件合并）与 claude、codex、grok、openclaw（CLI 物化），扩展则凡声明了写入路径的宿主皆可
  （opencode/pi/claude/codex/cursor/omp/antigravity/factory/kimi/grok/openclaw）。这是诚实的，但意味着多数宿主行对其中两类是只读的。
- 负面：从控制台卸掉运行时自己装的包，只是让它不再加载，字节仍留在运行时库里；这是编辑声明的真相，控制台必须一直这么讲。
- 负面：没有 GC 意味着内容库与回收站会长大；没有导出/导入意味着 harness 意图不随环境迁移（ADR-0007 迁移的是环境状态，不是这个）。
- 负面：manifest 原子写但不加锁。桌面 + CLI 被假定为同一环境的串行写入者；并发的第二个写入者可能丢掉一条副本记录。

## 实施锚点

- `backend/src/harness/host/hosts.ts`——宿主身份表（`HOSTS`：id + label，目录顺序）。
- `backend/src/harness/host/adapters/`——每宿主一个文件（各自的落点路径、技能根与 `extensionDir`，只声明一次）、共享的 `defineHost` 规则、能力接口、注册表（`adapterFor`、`skillLocationRoots`、`skillOwner`、`skillRootsFor`）。
- `backend/src/harness/host/{manifest,types}.ts` / `backend/src/harness/{types,config-file}.ts`——manifest（无遗留迁移）、认领、词汇，以及共享的配置读写纪律。
- `backend/src/harness/host/writers/{skill,mcp,plugin}.ts`——三种写入模式及其闸门。
- `backend/src/harness/host/{install,registry,inventory,discover,drift,maintenance,ledger,probe,request,scopes}.ts`——编排、对账、发现通道、卸载描述符、回收站快照、共享事件环骨架上的 `applies` 账本，以及安装后的落点证据。
- `backend/src/harness/host/resolvers/{github,npm,clawhub,git-marketplace}.ts`——安装解析器；git-marketplace 解析器服务所有操作者 `mp-<slug>` 源。
- `backend/src/harness/host/{mcp-entry,mcp-registry,mcp-edit,mcp-cli}.ts` +
  `common/pypi-source.ts`——MCP 轴：条目校验与 launch 语法、官方注册表读取器、带闸门的编辑路径、纯内存
  tar 包探测（提取注册表形态的 launch），以及喂给 `pypi` 解析器（`host/resolvers/pypi.ts`）与
  `kimi-web` writer（`host/writers/kimi-web.ts`）的 PyPI 源语法/探测。
- `backend/src/harness/common/market.ts`——操作者 git 市场存储 + probe：快照历史、格式中立的 probe（`ProbeOptions`）、浏览行、联邦分区合并与 `toCatalogRow`。
- `backend/src/harness/{tcp-reach,db-probe}.ts`——DSN 构建器的连接测试：对任意协议做不带凭据的 TCP 拨测，对两个主流引擎用 `pg` / `mysql2` 真实登录，判定码区分认证、数据库与 TLS。
- `backend/src/harness/common/{github,stars,npm-catalog,source-views,marketplace-rescan-scheduler}.ts`——仓库/树/tarball 读取（pin 与上限）、按需星数查询、npm 身份判定、来源视图注册顺序，以及 opt-in 重扫定时器。
- `backend/src/harness/plugin/`——每 harness 一个文件：`adapters/base.ts`（共享市场引擎：源 CRUD、索引/联邦合并、`install(row)`）、`adapters/index.ts`（适配器工厂 + `probeOptionsFor`）、`adapters/pi-dev.ts` / `pi-github.ts` / `claude.ts` / `codex.ts` / `cursor.ts` / `gemini.ts` / `grok.ts` / `antigravity.ts` / `factory.ts` / `kimi.ts` / `universal.ts`（各自的形态；pi 的官方面与操作者 git 面分居两文件），以及 `catalog.ts`（收割后的 JSONL 索引）与 `builtin.ts`（按 harness 的内建视图查找）。
- `backend/src/harness/net.ts`——抓取失败**唯一**的措辞（哪个上游、怎么办），每个读取器共用，运行时错误文本因此到不了操作者眼前；同时也是**唯一**的重试点（`fetchWithRetry` / `MARKET_RETRY`），读取器不再各自携带尝试次数、退避或预算。
- `backend/src/harness/{detail,tree,translation,spi,hash}.ts`——一行市场记录的长文部分、git 树过滤、派生描述缓存、来源适配器契约与哈希。
- `backend/src/routes/harness.ts`——管理面（`sources`、`hosts`、`applies`、`inventory`、`plan`、`apply`、`browse`、`install`、`translate*`），全部位于既有 `/api/admin/*` 鉴权闸门之下。
- `frontend/src/pages/HarnessPage.tsx`——每类一页、有落地时的宿主侧栏、已装/市场两个页签、逐目标安装门禁、卸载选择器。页签是地址的一部分（`?tab=market`，`local` 保持隐式），因此刷新后仍停在操作者正在读的那一页；侧栏选择只替换 `:harness` 段并把查询串原样带走——切换宿主只改变作用域，不改变页签。

## 待决问题

- 下一个值得验证的 MCP 落地是哪个：Claude（`mcpServers` 块本身已核实，但写入不能重新序列化运行时自有状态文件——见未实现清单）、Codex（TOML）、Cursor（厂商文档）。每个都要先对厂商文档核实，才能进入 `HOSTS`。
- 是否要在声明编辑之上再加一个已验证的 `pi uninstall` 操作，还是就此把声明编辑定为契约（它是唯一不会删掉不属于我们的字节的方式）。
- 内容库何时需要 GC，以及在导入与回滚存在之后，"安全引用集"到底是什么。
- `trust` 这类"演示级"信任字段是保持单来源，还是长出本记录刻意省略的跨源聚合。`listedOn` 已经不需要这个问题：它记录一行被浏览到的每个来源面（D8.6），只剩写入方的那份 `trust` 声明仍是单值。

## D9 —— 操作者 git 市场源（修订，2026-10-30）

操作者指定的任意 GitHub 仓库无需改代码即可成为浏览/安装源：`<ocrHome>/harness/plugin-market.json` 是插件轴配置——每个条目对应一个 `mp-<slug>` 适配器实例（`host/resolvers/git-marketplace.ts`），注册表动态解析 `mp-*` id。文件按 harness 分桶（`{ "shared": [...], "<harness>": [...] }`，2026-11-01 修订）：桶**就是**作用域，条目本身不再带 `harness` 字段；同目录的 `skill-market.json` 与 `mcp-market.json` 各自只有一个 `shared` 桶——技能本就是全局的，MCP 源则是一个启动命令与宿主无关的包（只有落点文件不同），写 harness 键都是假话。`slug` 在**三份**文件中仍是同一个身份。设立这一类型的背景：Claude 式 `marketplace.json` 目录格式已成为行业收敛中的分发形态（grok、Goose、omp 均直接读取或克隆它），而其下的内容早已收敛到一个原语：`SKILL.md`。

**识别（probe）。** 添加时与每次重扫各探测一次：仓库元数据 + HEAD 提交 + git 树。识别出的清单（`.claude-plugin/marketplace.json` 及其 grok / Goose 克隆）把扫描范围收窄到作者声明的仓库内相对路径目录；清单里的外部源（`git-subdir`、`url`、`npm` 等）只报告、不解析——一期不追随。没有清单（或清单不可解析——坏文件不是清单）则回退为全树 `SKILL.md` 扫描。行数封顶（30），按目录名去重、短路径优先：生成型镜像（如 `skills/` 的 `.openclaw/skills/` 副本）不会重复成行。

**格式归属（修订，2026-10-31）。** 市场格式不是基类引擎的事。只有 Claude 有**标准** catalog：收敛后的 `marketplace.json`（`plugins[].source` 为仓库相对路径）只在 `plugin/adapters/claude.ts` 解析一次（`parseClaudeMarketplace` / `CLAUDE_CATALOG`）。另外只解析两种**安装命令强制要求**的厂商文件：Gemini CLI 的根 `gemini-extension.json` 与 Pi 的层内 `package.json`（`PluginManifestReader`——`file`、可选 `atRoot`、`base: 'layer' | 'repo'`）。Kimi Code 增补了第四个读取器（2026-11-01 修订，经厂商文档核实）：其**规范**清单是根 `kimi.plugin.json`——厂商文档自带示例插件正是此布局（完全没有 `.kimi-plugin/` 目录）。`kimi.ts` 按厂商专属方式读取它（name/description；id 按厂商文档化的语法校验，永远装不上的清单不算清单），且按厂商文档化的优先级，根清单在两者并存时胜过 `.kimi-plugin/` 目录。其余 harness 一律**按目录**识别：`.codex-plugin/`、`.cursor-plugin/`、`.antigravity-plugin/` 里的厂商清单并不统一，probe 绝不用共享 schema 解析它们。该 harness 的形态目录（由 host 适配器声明）存在**即支持**：产出一行以仓库命名的插件，source 指向仓库根。基类 `BasePluginMarketAdapter` 不提供任何格式钩子，只走裸 `SKILL.md` 扫描；`marketplace.json` 不是 pi 的格式，因此也不存在需要同步的抽象「shape」注册表。

**克隆目录归各自的 harness。** 同一格式会出现在各运行时的目录下，每个目录由自己的适配器认领并复用 Claude 的解析器：`claude.ts` → `.claude-plugin/marketplace.json`、`grok.ts` → `.grok-plugin/marketplace.json`、`factory.ts` → `.factory-plugin/marketplace.json`、`universal.ts`（AGENTS/Goose 约定）→ `.agents/plugins/marketplace.json`。没有 catalog 文件的 harness 改为**按目录**识别（codex、cursor、antigravity，以及 factory/grok 的无 catalog 回退；kimi 仅在根清单之下作回退加入这组）：目录存在即支持，厂商 JSON 绝不按共享 schema 解析。Claude 源绝不读 grok 自己的目录，反之亦然；解析器共享，**目录不共享**。唯一例外、经厂商证实：Grok 接受 `.claude-plugin/` 等价形态（用户指南 "Skills, Plugins & Marketplaces"），因此 `allHostProbes()` 为 grok 额外发出一条钉在 claude 目录上的探针——claude 形态的仓库对 grok 同样**被探测到**，grok 原生仓库仍优先认领 `.grok-plugin/`。

**扩展层（修订，2026-10-31）。** 同时服务多个运行时的仓库按运行时各出一个形态（`pi-extension/`、`.claude-plugin/`、`.codex-plugin/` 等）。源可钉扎 `extensionDir`——仓库内相对目录，按窄语法校验（禁止绝对路径、盘符、反斜杠与 `..`）。钉扎后 probe 绝不越界：目录缺失答 `missing_dir`，绝不静默退回全树扫描；对 Claude 格式的源，清单只在 `<layer>/marketplace.json` 里找。层内没有 catalog 时，该 harness **自己的**钩子仍可描述该源：层内清单（pi 的 `package.json`）使层本身成为一个插件行；按目录识别的 harness（codex、cursor、antigravity）以目录存在为插件、以仓库为名产出一行；根清单（gemini-cli 的 `gemini-extension.json`、kimi 的 `kimi.plugin.json`）根本不需要层。每个 host 适配器声明本生态的默认层（`harness/host/adapters/<host>.ts` 的 `extensionDir`），probe 在源未钉扎时**套用**它：扫描的是该 harness 自己的形态目录（`.claude-plugin/`、`.codex-plugin/`、`.cursor-plugin/`、`.factory-plugin/`、`.kimi-plugin/`、`.antigravity-plugin/`、`pi-extension/` 等），而不是整个仓库。显式 `extensionDir` 仍然优先；默认目录在仓库中不存在时降级为裸 `SKILL.md` 扫描而不是报错，实际生效的层记入快照。控制台也经 `GET .../sources` 广告并预填该默认值，操作者可见并可覆盖。

**围栏与溯源。** `mp-<slug>` 适配器只解析其配置的仓库、且只接受 `#<skill-dir>` 钉扎引用——市场行自带钉扎，裸引用即猜测。解析委托给 github 适配器（tarball、上限、提交 pin），并**覆写** canonicalKey 为 `mp-<slug>:<repo>#<dir>`，使 manifest 记录永远记载操作者实际浏览的来源面，而不是把所有市场焊死在内建 `github:` 源上。

**刻意不安装的内容。** 各家 harness 的适配形态——hooks（可执行 JS）、OpenCode 运行时插件、slash 命令、规则文件、git 直载的私有插件——在快照中计数（`authorAdapters`、`unsupported`），绝不进入 payload。本域安装的 kind 是技能与 MCP；rules 与命令形态需要单独决策才能成为行。git 直载插件（pi 的 `git:` 安装未发布仓库 JS）是记录在案的非目标：npm 发布的插件已由 npm 源覆盖，而从操作者自加的清单执行仓库内代码是信任边界的变更，值得单独一篇 ADR。

**重扫（opt-in）。** 每源独立：`rescan.enabled`（默认关）+ `intervalMs`（钳制 1 分钟–30 天；默认 1 天）。进程级单定时器扫描到期源，追加有界快照历史（20 份，按 sha+行去重），并与上一份快照对比行/pin。重扫只**报告**新增与移除——绝不改写已安装副本；升级仍走安装路由及其门。快照同时携带仓库级 stars 与 `pushedAt`（同一次 API 响应白送）：这是源级元数据，绝不盖到行上——行不得宣称其来源未声明的人气信号（§D6）。

**浏览。** 自定义源走标准 `/sources` + `/browse` 契约：行以 `mp-<slug>:<repo>#<dir>` 为键渲染为 MarketItem，唯一声明的排序是 `name`（对快照做本地过滤+分页——旧快照也作答，新鲜度归重扫循环），安装走普通安装路由，写入方来源优先，`listedOn` 不变。

**维护动词归入按 harness 的面（修订，2026-12）。** 全局 CRUD 路由
（`POST/PATCH/DELETE /api/admin/harness/marketplaces*`、`rescan`、`snapshots`）已**移除**——独立的
全局管理页面在教一种存储并不具备的所有权。注册与移除移入按 harness 的插件市场面（§D10/§D11）：
`POST /api/admin/harness/plugins/:harness/sources {url, extensionDir?}`（先探测，slug 由仓库**推导**——
`mp-<repo>`；同一仓库的第二个层以目录 token 作后缀 `mp-<repo>-<layer>`，重复注册同一 (repo, layer) 对答 409）、
`POST .../sources/check {url, extensionDir?}`（操作者添加前的干跑；报告 skill/MCP/plugin 计数，不落任何状态）、
`DELETE .../sources/:slug`（未知 harness 或 slug 均 404）。`GET /api/admin/harness/sources`
保留为只读视图（内建源 + `mp-` chips），无任何变更动词。未知或非 github 目标答 400；未知 harness 答 404。

**MCP 轴上的包源（修订，2026-11-01）。** 控制台的 MCP 市场现在有自己的 Sources 抽屉，其"源类型"是
**包生态**而非启动形态：`npm` 与 `pypi`。`stdio` 只是包启动后的传输方式，绝不是源类型——源回答的是
"读哪个注册表"，启动器由生态决定（npm 用 `npx -y <pkg@ver>` / `bunx`，PyPI 用 `uvx <pkg>==<ver>`）。
MCP 轴有独立文件 `<ocrHome>/harness/mcp-market.json`，但只有**一个 `shared` 桶**：包源是一次注册表读取，
解析出的启动命令在每个运行时里都相同——不同的只是落点配置。把源钉在创建它的抽屉所属 harness 下，会让它从
兄弟 MCP 页签里消失，并让第二次添加答出假的重复（`already_configured`），因此该轴**从不写 `harness`**。
`slug` 在全存储中仍是一个 `mp-` 身份；旧 per-harness 桶按共享读取，并在下次变更时拍平。

- **共享的是目录，不是安装。** 共享源不会把一次安装扇出到多个宿主：市场行仍只装进页面钉住的那个宿主
  （§D11，2026-12）；只有具备已验证 MCP 落点的宿主（`opencode`、`pi`、`omp`）才列出该源。因此源视图的
  `hosts` 声明取**落点表**，绝不取快照——包探测不检测任何形态，记录的是 `hosts: []`。

- **一个源 = 一个包。** 不收 npm `@scope/*`，也没有 PyPI 命名空间：包注册表不是精选服务列表，列出一个
  命名空间只会把非服务当成服务展示。输入 scope 在 check 与 add 阶段都答 `invalid_source`。
- **版本在安装时解析，绝不冻结进源。** 条目只存裸包名（`repo`），快照把探测时的版本仅作为信息记录，安装句柄
  （`npm:<pkg>` / `pypi:<pkg>`）每次安装都经注册表适配器解析。`pypi` 解析为固定到具体版本的 `uvx` 启动，
  并写 `pin: {pypi:{version}}`（`host/resolvers/pypi.ts`），与 npm 的 `npx -y <spec>` + integrity 对称。
  带版本或 extra 的引用（`name==1.0`、`name[cli]`）不是源。
- **写进配置的条目键由包身份派生，绝不复用包名本身。** 宿主配置的条目是对象键，而已验证的三种宿主语法都拒绝
  scope 形式的 npm 名（`@bytebase/dbhub` 含 `@` 与 `/`；pi 连点号也拒绝），直接拿注册表名当键会让一次本可解析
  的安装在每个落点上答 `invalid server name`。`mcpServerNameFromPackage`（`host/mcp-entry.ts`）用**交集语法**
  （`[A-Za-z0-9_-]`，100 字符——omp schema 的上界）派生，并保留 scope（`@scope/name` → `scope-name`，两个 scope
  的同名包因此绝不会撞进同一个成员）。注册表身份保留在 `canonicalKey` 与市场行的 `name` 里；行上另带派生的
  `serverName`，控制台只读的名称框显示的就是它——表单绝不展示一个落点会拒绝的键。
- **轴隔离由代码保证，不靠约定。** 插件收割跳过 `axis: 'mcp'` 条目（`plugin/catalog.ts`），市场同步/移除
  也拒绝对其执行原生 `marketplace add|remove`（`host/marketplace-sync.ts`）：MCP 源写的是服务配置，把它的包
  注册成插件市场会是一句运行时真的会照做的假话。`dueMarketplaceEntries` 同样把包源排除在 git 重扫调度之外
  ——它们的新鲜度由该源自己的重扫路由经注册表读取。

## D10 —— 插件市场：按 harness 的适配器 + 两层目录（修订，2026-10-30）

**一个 harness 一个文件，一个 harness 一条适配器链。** 每个 harness 的市场住在 `harness/plugin/adapters/` 下**自己的文件**里
（`pi-dev.ts`、`pi-github.ts`、`claude.ts`、`codex.ts`、`cursor.ts`、`gemini.ts`、`grok.ts`、`antigravity.ts`、`factory.ts`、`kimi.ts`、`universal.ts`）：pi 的两个面分开——`pi-dev.ts` 持有实时官方目录与 `PiDevPluginMarketAdapter`，`pi-github.ts` 持有 `PiGithubPluginMarketAdapter` 与 git probe。Claude 的 catalog 解析器在 `claude.ts`；Pi 的 package、Gemini 与 Kimi 的根清单读取器在各自文件里；其余 harness 一律按**目录**识别，绝不解析厂商 JSON。各 harness 文件只声明自己的身份与目录（由 host 适配器声明）。
共享引擎为 `PiPluginMarketAdapter extends BasePluginMarketAdapter`；harness 专属行为不出其文件。
`probeOptions()`（claude → `CLAUDE_PROBE_OPTIONS`；codex → `CODEX_PROBE_OPTIONS`；gemini-cli → `GEMINI_PROBE_OPTIONS`；
pi 的 git 变体 → 自己的 `package.json` 清单读取器）。
`PluginMarketAdapter` 拥有 `sources()` + `search()` + `checkSource()` + `registerSource()`/`unregisterSource()` + `install(row)`。
刻意**不设** `supported()`：适配器的存在即支持声明——只为被服务的 harness 创建实例，落点验证发生在
安装时，行级兼容性由 `CatalogRow.hosts[]` 携带。

**两层：有界 vs 无界。**

- **索引层**——有界源（操作者 git 市场经其快照、精选静态目录）收割进
  `<ocrHome>/harness/catalog/<harness>/index.jsonl`（JSONL，每次收割整体替换，每 harness 封顶 2000 行，
  超限按最新源整体裁剪）。检索/排序/分页全部本地：零上游请求、可离线、快照背书。收割是对快照的**读**——
  注册源时 probe 一次（唯一的硬网络依赖），此后 GitHub 故障不会白屏；rescan 失败继续以旧快照服务并在
  标签上注明快照年龄。
- **联邦层**——无界活目录（pi.dev、精选 OpenCode 插件列表）。行**绝不落盘**；每次应答自带
  `total`/`totalExact`。

**适配器定序；门面同键归并。** 门面**绝不重排**联邦页——对各自独立分页的源做页内重排得不出全局序，
其暗含的分页是假的。由于今天没有任何联邦插件源能按 `name`/`stars`/`updated` 出页（它们原生按下载量 /
目录位置排序），目录页里**排序后的 `rows` 只来自索引层**；每个联邦源的应答以自带标签的
`CatalogSection`、按该源自己的原生序、带自己的 total 呈现。控制台不交叉排列它无法共序的行。`stars`
排序只收 star 数是真实 GitHub 数字的源；没有的源不参与该排序，且排除本身要被说明。

**诚实计数。** 没有独立的 `count()` 方法——每次 `search` 应答携带 `total?` + `totalExact`，只取上游
自己声明的内容。不能计数的源给下界（`5000+`）；门面绝不合成跨源总数字。

**行。** 只卖 plugin kind——skill 和 MCP 走自己的轴（三样都带的源在 probe 里照报三样；目录各卖各的，
并给出到其他市场的链接）。去重键：npm 行用 `npm:<pkg>`，git 行用 `mp-<slug>:<repo>#<source>`。
`surfaces[]` 记录行被见过的每个源；`hosts[]` 是源声明的兼容面，控制台对未声明适配当前 harness 的行
**置灰而不隐藏**。

**五道边界。**（1）注册只收 github.com URL；（2）mp 解析器的围栏（`#dir` 钉扎、不收裸引用）——绝不猜；
（3）体量上限（每源 30 行、tarball 8 MiB / 200 文件、索引每 harness 2000 行）；（4）收割：只有索引层
源落盘，联邦应答即逝；（5）查询：单源 8s 超时，页面按 section 降级而非整体失败——超时源显示为注记。

**安装。** `install(row)` 委派给普通安装编排器（resolve → payload → writer → manifest），以适配器自己的
harness 作为唯一宿主——插件恰好装进**一个** host，其身份包含它（§D5）；`surfaces` 减去写入源后作为
`listedOn` 传递（§D9）。这里没有任何绕过闸门的东西。

**双轴适配器（修订，2026-12）。** 市场沿领域其余部分相同的轴一分为二：HOST 轴（`harness/host/`）拥有全部
安装；MARKET 轴（`harness/plugin/`）只管发现——`install(row)` 是一步翻译，把行转投 host 路由，闸门纪律
（gate-3）原封不动。`plugin/adapters/index.ts` 是唯一构造点；`claude` 得到声明式落点
（container 形态、`specPrefix`、子进程参数），`pi` 得到 sibling-id 目录，其余走通用适配器。

**sources 视图对贡献者诚实。** `GET .../sources` 应答本 harness 目录的索引层源——而索引收割只列出对该
harness **贡献了行**的源。只有技能的 git 仓库出现在技能轴的视图上，而不会出现在一无所获的插件轴上：
一个零行的源 chip 等于宣称收割从未写过的层。

**变更后全量重收割——但按层钉扎的源例外。** 源存储是全局的（`plugin-market.json` 与 `skill-market.json`
共享一个身份命名空间），因此
`registerSource`/`unregisterSource`——以及重扫调度器在 probe 之后——会重收割**每一个**被服务的 harness
的索引。收割本身保持作用域诚实：一个源的 catalog 只为快照探测到的 harness 携带行（§D9 修订），因此
`pi-extension` 源绝不会教 claude tab 去安装它，按 harness 钉扎的条目也绝不会进入兄弟页签的索引。过期的兄弟
tab 会教出一种存储并不具备的按 harness 模型；收割是对快照的本地读——天然廉价。

**接线。** `backend/src/harness/plugin/adapters/`（按 harness 的适配器文件架在共享引擎上），共享市场内核在
`backend/src/harness/common/market.ts`（行契约、浏览缓存/分发、操作者源存储 + probe、stars、npm 身份），
host 轴在 `backend/src/harness/host/`；路由
`/api/admin/harness/plugins/:harness/{catalog,sources,sources/check,sources/:slug,install}`（§D11）；
控制台页面是 `HarnessPage` 的 `plugin` tab（`/harness/plugins` 路由回该页）。每个内建目录在自己的适配器里声明源视图与浏览函数
（`skill/clawhub.ts`、`plugin/adapters/pi-dev.ts`）；`harness/common/source-views.ts` 只声明它们的顺序。

## D11 —— 控制台市场面：按 harness 的 tab、一个来源弹框、一份共享存储（修订，2026-12）

**没有独立的市场页。** 独立的 Marketplaces 页面及其导航入口已**移除**。来源维护就在消费这些来源的地方：
harness 页面的市场 tab。`/harness/plugins` 与 `/harness/plugins/:harness` 路由回指
`HarnessPage kind="plugin"`——插件市场是 harness 页面的一个 **tab**，不是独立目的地。导航名为
「插件管理 / Plugin Management」。

**一个弹框，一次只服务一个轴——按 kind、按作用域、也按路由隔离。** 来源弹框（`HarnessSourcesDrawer`）从
harness 页面的市场 tab 打开——技能、插件，以及具备已验证落点的 MCP tab。每个轴同时拥有自己的注册表**与**
维护路由：插件与 MCP 源都走 `/plugins/:harness/sources*`（路径只记录打开抽屉的 tab）；技能轴有**全局**面，
路径不带 `:harness`——`GET/POST/PATCH/DELETE /api/admin/harness/skills/sources*`。内容同样按轴拆分：
每条路由只列出本轴注册表的内建源（`SKILL_VIEWS`、`MCP_DEFAULT_VIEWS`、`PLUGIN_DEFAULT_VIEWS`），
以及快照实际携带该 kind 的操作者条目。**技能是全局的**：ClawHub 对所有 harness 一视同仁，技能来源注册时
**不带 harness 作用域**，因此每个 harness 页面看到同一份列表，快照落在全局快照路径。**MCP 包源同样是全局的**：
一个 `shared` 桶、每个 MCP 能力页看到同一份列表、一份全局快照——落点集（`opencode`、`pi`、`omp`）是该源唯一的
宿主声明。**插件按 harness 划分**：插件装进特定运行时，其内建源（各自的 `hosts` 声明）与条目都收窄到当前
harness。新注册的插件条目默认钉扎到添加它的页签（§D10，2026-11-01）；弹框仅在探测到多个支持 harness 时
提供共享选项，遗留的共享插件条目只在快照记录了该 harness 形态的页签上列出。

**支持是探测出来的，不是声明的。** 弹框只有三个字段：源类型（GitHub | npm）、仓库（或包/作用域），
以及条目的支持 Harness——由探测**报告**，绝不要求操作者选择。旧的「扩展目录」输入框已从 UI 移除：
`extensionDir` 仍是后端探测参数（显式钉扎保留按 harness 的历史语义与严格 `missing_dir`），但弹框始终用
**每个**被服务 harness 的形态对同一仓库探测一次，并把检测结果记入快照（`hosts`）。同一仓库以另一层再注册
仍会派生第二个 slug（`mp-<repo>-<layer>`）。MCP 轴没有这个字段：包源按定义共享，落点表（`opencode`、
`pi`、`omp`）就是它的宿主声明。

**操作者输入宽容，存储的身份不宽容。** 仓库输入框接受完整 URL、`github.com/owner/repo` 引用、
`git@github.com:owner/repo.git` 克隆行、npm 的 `github:owner/repo`，以及裸 `owner/repo`——
由**同一个**解析器（`harness/common/market.ts` 的 `githubRepoFromInput`）归一化，技能轴与插件适配器
共用它，两个轴因此不会各自漂移。仓库**之下**的路径仍然拒绝：那正是 `extensionDir` 命名的东西，
静默丢弃它等于注册了与粘贴内容不同的层。

**弹框声明作用域。** 弹框背后的存储是**全局**的——一个身份命名空间，`mp-` id 被每个被服务的 harness
共享。`plugin-market.json` 按 harness 分桶（`shared` 桶作为操作者选择共享与修订前条目的存储），
`skill-market.json` 与 `mcp-market.json` 各自只有一个 `shared` 桶。弹框副标题写明这一点；每次变更都会
重收割所有被服务 harness 的索引（§D10），列出的插件源要么是本 harness 自己的条目，要么是快照探测到本
harness 形态的共享条目；MCP 源则在每个具备落点的页签列出——宿主声明取落点表，而不是快照。

**解析器 vs 芯片。** npm 与 github 在 host 轴上仍是**安装解析器**（`npm:` 行总得有地方解析），但 npm 的
**浏览芯片**不在插件轴上——插件轴浏览 pi-dev（联邦）加操作者 git 源；技能轴保留自己的芯片。一个源的
`kinds` 声明（各自适配器里的视图，最终由 `harness/common/source-views.ts` 组装）是浏览芯片出现在哪个轴上的唯一裁决。

**接线。** `frontend/src/components/HarnessSourcesDrawer.tsx`；从 `HarnessPage` 的市场 tab 携带 tab 的 kind 打开；API client
与按 harness 路由形状 1:1 镜像。废弃的全局 client 函数与 `MarketplacesPage` 连同其 i18n 键在同一 commit 删除。

**手动添加 MCP 是 harness 页面上的能力（修订，2026-11-01）。** 适配器实现了 MCP landing（`hasMcp`）的 harness
在其「已安装」tab 提供 **添加 MCP**：stdio 启动（command、args、环境变量**名**）或远程 URL 启动（url、请求头**名**加可选的字面值）。
它走与市场行**同一条** `manualPayload` 分支和 gate 2——第一次请求不写入任何东西，返回合并计划（文件、容器，
以及精确的新增/覆盖键），第二次带 `confirm` 重发；环境变量/请求头默认只记**名**，只有操作者在 registry
驱动表单里填了值才会写入（gate 4，2026-11-01 修订）。两种远程传输（`http`、`sse`）都通过宿主适配器的
remote 形状落地；opencode 写
`{type: 'remote', url, headers}`，不区分二者。这把 manual 逃生口暴露到控制台，但**不**打开浏览目录
（在 npm MCP 源落地之前，`MCP_DEFAULT_VIEWS` 仍为空）。

**编辑已有 MCP 服务器（修订，2026-11-01）。** 同一个 harness 页面可以编辑「已安装」tab 列出的任何服务——
OCR 安装的 `tracked` 副本，或扫描从 runtime 自己配置里读到的行。`GET /api/admin/harness/mcp/entry`
把条目读回成 launch（`command`/`args` 加环境变量**名**，或 `url` 加请求头**名**；值从不返回），
并给出 `setKeys`——存的值不是裸 `{env:KEY}` 引用的那些键（字面值或 `{file:...}` 引用）——表单据此显示
「已设置」，本身拿不到值。`POST /api/admin/harness/mcp/edit` 以当前条目为基底合成下一条，保留未知字段
（`timeout`、`enabled` 等）以及所有键仍存在的环境变量/请求头**值**，stdio ⇄ remote 互转时清掉另一形状的
字段。gate 2 不变：没有 `confirm` 时路由返回 `confirm_required` 与精确的文件、容器和被覆盖的键，什么都不
写；条目完全相同时返回 `changed: false`，既不给计划也不写入。名称是**已存在**的键，因此只读——改名等于
删除 + 新增。tracked 副本的 manifest 哈希随文件同步更新，编辑不会被报成本地改脏；discovered 条目只写
runtime 自己的配置，绝不创建 manifest 记录。被其他环境认领的配置拒绝（`foreign`），与卸载一致；未认领的
runtime 配置可编辑——观测不是所有权。

**MCP 参数是从 registry 与包本身发现的启动参数（修订，2026-11-01）。** 添加/编辑 MCP 弹框不再从一条要
誊写的命令行开始，且只保留**一张**表：启动参数。`GET /api/admin/harness/mcp/registry?q=…` 向官方 MCP
Registry 索取服务器自己的 `server.json`（registry 的 `Input` 与 `Argument` 声明：名称、描述、`format`、
`isRequired`、`isSecret`、`default`、`choices`），控制台按声明逐项渲染对应的控件——值是明文输入框
（敏感项**不做**密码遮罩：同样的文本本来就出现在启动参数行里）、数字项是数字键盘、registry 发布
`choices` 时用可输入的建议下拉 `SuggestInput`（建议只是提示而非封闭枚举，扫描没见到的值同样可以输入）、`dsn` 格式用结构化 DSN 构建器——而不是一个自由文本的 args 文本域。回答在到达
界面前先归一化并限幅（`searchMcpRegistry`：`version=latest`、只取 npm 包形状、≤20 候选、≤64 输入、
≤32 参数、≤2 MB 响应体、15 s 超时）；畸形条目直接丢弃，绝不修补（gate 5）。这次查询不写任何东西。

只有 registry 声明时往往不足以拼出启动命令。官方 DBHub 记录在**任何**版本都没有 `runtimeArguments`——只有
环境变量——因此给不出 `--transport` / `--port` / `--dsn`。`GET /api/admin/harness/mcp/cli?pkg=…&registry=…`
补上这一环：解析已发布的包，把归档下载到内存，扫描随包发布的源码中包**自己的**解析器所读的 flag。
`registry=npm`（默认，`npx` / `bunx` 使用）读 tarball 并扫描 JavaScript（`args.<name>`、`args["<name>"]`、
字面量 `'--name'`、`requireFlagValue("<name>"…`）；`registry=pypi`（`uvx` 使用）读 PyPI 源码归档——优先
sdist，其次 wheel——并扫描 Python（`add_argument("--name"`、`click.option("--name"`、`Option("--name"`）。
每个 flag 都带回示例值、枚举 `choices`、数字/敏感/必填提示、连接串名（`dsn`、`connection-string`、`database-url` 等）的 `dsn` 格式，以及包在缺省时回退的环境变量名（`process.env`
或 `os.environ`）。包**从不执行**、也不写任何文件，所以探测不需要确认门；下载有限幅（20 s、≤2 MB 元数据、
≤25 MB 归档、≤64 个选项、≤8 MB 源码），把 flag 藏在解释器后面的包只会少返回几项，不会失败。

检测是显式的——操作者点 **检测**；只有一个匹配时立即套用，多个匹配等待选择，切换选择器会重新探测所选包。
查询本身是包规格时，即使 registry 没有记录也会探测；尚未选择运行器时，npm 查不到会自动改试 PyPI，因此裸的
uvx 包名同样能解析。只要启动命令已经点明包名，「参数来源」就是**只读**的——探测读的就是那个包，换来源要改启动
命令，而不是在这里再写一份真值；只有点不出包名的启动才退回到可输入的查询框。套用一个候选会填好草稿：`npx -y <package>@<version>`（取 registry
的 `version`，没有则 `@latest`）、按 registry 顺序排列的所有固定 `runtimeArguments` / `packageArguments` 值，
以及声明的输入项；只有远程条目的 registry 项（`server.remotes`）改为填 URL 与请求头输入。registry 把取值留给
操作者的参数（只有 `valueHint` 没有 `value`）单独成行，勾选后回写到 argv。获取参数是**合并**进已打开的表——
同名保留已填的值，新行追加（必填声明在前），手动添加的行保持不动。每行最左侧都有一个**使用**勾选框，决定它是否
写入启动命令行：探测到的 flag 只是建议，默认不勾选；而从现有命令行解析、带声明默认值、必填声明或手动添加的行
默认勾选。勾选后即使还没有值也会写入（作为单独的开关）；取消勾选后该行连同其值一起收进「备选参数」，
「清除备选」只删除未勾选且非必填的行。描述旁的**必填**标签只是声明元数据——registry 声明与 Python 的
`required=True` 会预置它，npm 包通常没有——不再决定分组。探测仍然会带回 `secret` 作为知识，但值列**永不**遮罩。

**`dsn` 格式的 flag 用结构化 DSN 构建器渲染（修订，2026-12）。** CLI 探测按名字识别连接串 flag（`--dsn`、`--connection-string`、`--database-url` 等）并标为 `format: 'dsn'`——registry 自己的 `Input`/`Argument` `format` 仍是四个官方值（`string`/`number`/`boolean`/`filepath`），因此 `dsn` 只会经探测产生。控制台渲染一个构建器而非明文输入框：操作者编辑驱动 / 主机 / 端口 / 数据库 / 用户名 / 密码 / 一组 key=value 参数，控制台把它序列化成一条 URL 形式的 `scheme://[user[:pass]@]host[:port][/db]?k=v` 连接串回写到 argv（值仍作为 `mcp-args` 里一个带引号的 token 往返）。紧凑单元格显示遮罩后的摘要，凭据不会一眼可读；构建器里密码以明文编辑（敏感项**不在打开时**遮罩）。构建器无法解析的值——ODBC 式 `DSN=;UID=;PWD=`、没有 `//` 的 `file:` 路径——会改为打开原始文本域回退，操作者可在两者间切换；探测的 `secret` 知识不受影响（`dsn` 名字本就属于敏感，但 `connection-string` / `database-url` 不另行打标）。

**构建器可以测试连接；对两个主流引擎，测试就是真实登录（修订，2026-11）。** 字符串无法告诉操作者端点是否应答，而 TCP 应答也分不清「密码错」和「库不存在」。因此对话框的 **测试连接** 分两层，两层都只读取目标，既不写配置，也不运行 MCP 包：

- **PostgreSQL（`postgres` / `postgresql`）与 MySQL/MariaDB（`mysql` / `mariadb`）** 用操作者自己的参数通过 `pg` / `mysql2` 真实登录并执行 `select 1` / `ping`。返回值是判定码——`ok`、`auth_failed`、`database_missing`、`tls_failed`、`unsupported_auth`、`refused`、`timeout`、`unreachable`、`error`——外加驱动自己的失败文本，密码错误绝不会被报成端口错误。`sslmode`（MySQL 也写作 `ssl-mode`）映射到引擎策略：`disable` / `allow` / `prefer` / `require` / `verify-ca` / `verify-full`；缺省等于 `prefer`，并且只有「服务端完全不提供 TLS」时才回退明文——证书错误绝不降级。
- **其他所有协议** 仍然只对推导出的 `host:port` 做 TCP 拨测（`tcp-reach.ts`），只证明可达、不涉及凭据，并如实说明这一限制。控制台不会为自己不会说的引擎发明协议知识。

`POST /api/admin/harness/mcp/dsn-probe` 这次请求只携带结构化字段（驱动 / 主机 / 端口 / 用户名 / 密码 / 数据库 / 参数），不携带原始字符串。因此凭据会进入网关：路由位于 admin 鉴权 + CSRF 闸门之内，值只用于握手，不写日志、不回显在响应里，返回的只有驱动自己的失败文本（其中不含密码）。端口留空时按驱动默认端口表补全，仅用于测试；保存的值仍保持无端口。即使测试通过，MCP 服务器的最终裁决仍是安装后运行期自己的状态（§D8.12）：它回答服务器是否用这条 DSN 连上了。

**stdio 表单有两种编辑方式，默认是自定义编辑。** 自定义编辑直接填写可执行文件与参数——这也是运行时真正存储的
形状；高级编辑只是同一张表上的辅助：按「运行器 + 包名」拼出命令行（`npx` 总会带上 `-y`）。这两个分段标为
**编辑方式**而不是「模式」，因为传输协议已经占用了这个词。套用候选**不会**切换已选的编辑方式：自定义草稿收到
的是拼好的整条命令行，而不是运行器/包名这一对。

**环境变量不属于这张表单。** registry 的 `environmentVariables` 刻意不合并：表单没有环境变量编辑器，编辑读取
仍只返回环境变量**名**与 `setKeys`，`POST /api/admin/harness/mcp/edit` 保留所有键仍存在的 `environment`
值。因此写穿的 `envValues` 路径只是 API 能力，控制台这张表单不驱动它。未套用 schema 时，自由文本域仍然是
高级视图，所以 Registry 没有收录的服务器照样能装。

**远程请求头则是「名 + 值」行（修订，2026-11-02）。** 远程条目整条启动面就是 URL 加它的 `headers`，所以表单把
请求头按行编辑，而不是一串名称。registry 的 `remotes[].transport.headers` 预填名称（连同 `required` /
`secret` / 描述，以及钉死或默认的值），编辑读取返回的 `setKeys` 把已存值（字面值或 `{file:...}`）的键标为
「已设置」。行的值走与 stdio 表单 `envValues` 相同的 `headerValues` 写穿：填了值就按字面写入；留空且键仍在时
保留已存值；新命名的键由 `referenceMap` 物化宿主自己的引用（opencode 是 `{env:KEY}`，pi/omp 是 `${KEY}`）。
读回仍只回答键**名**，字面值永不进入控制台（gate 4）。传输分段标为 **远程 URL** 而不是「SSE」：三个已核实的
落点都不声明 transport 字段，`streamable-http` 服务器也写进同一个 `{url, headers}` 形状，因此控制台不能声称一种
配置根本没存的线上传输。

**市场 MCP 行通过共享的添加/编辑表单安装（修订，2026-12）。** 安装按钮不再弹出独立的“选目标 host”对话框加
最小化的 command/args/env 覆盖；它弹出与“手动添加”和“编辑”同用的那张表单，用 resolver 钉死的启动命令
预填（`npx -y <pkg>` / `uvx <pkg>`），服务器名为只读。安装只写入页面 pin 的当前 landing——多客户端 fan-out 与
host 选择 chips 被移除（后端仍接受 `hosts[]` 以备将来的界面，但控制台一次只写一个客户端配置）。gate 2 不变：
第一次调用什么都不写并返回合并计划，第二次带 `confirm` 重发。**未改动**的表单不送 `launch` 覆盖，因此安装的是
resolver 自己的钉死命令（§D9）；改动过的表单发送改后的 launch，并因安装仍走 resolver 的 KEY 路径（而非
`manualPayload`）而保留该行的 `sourceId` / `listedOn` / `trust` / `canonicalKey` 归因。

## D12 —— 市场 = 一个内置市场 + 代码实现的扩展市场；添加的条目是**插件**（修订，2026-10-31）

**市场面两层，都由代码实现。** 每个 harness 一个**内置**市场（pi 的 pi.dev、Claude 的官方目录等），
外加任意多个**扩展**市场（ClawHub、pi.dev、收敛格式的 `marketplace.json` 仓库）。扩展市场在
`harness/common/source-views.ts` 声明、适配器在 `harness/plugin/adapters/`——操作者不能在运行时凭空造一个。
每个轴维护弹框添加的东西跟随该轴：**插件**弹框添加插件（一个仓库或 npm 包，装进发布了该形态的 harness）；
**技能**弹框添加一个发布 `SKILL.md` 的 GitHub 仓库，注册时**不带 harness 作用域**，对所有 harness 可见；
**MCP** 弹框添加一个 npm/PyPI 包，同样**不带 harness 作用域**——每个具备已验证落点的 harness 读同一份源，
只有安装目标不同。存储的 `mp-` 条目是该制品的身份与溯源，不是新的可浏览「源」命名空间。
按 harness 划分的是**插件**层：插件绑定到加载它的运行时。技能轴的内置目录（ClawHub）与共享的 MCP 包目录
是**全局**视图，声明在按 harness 划分的表**旁边**，绝不混进那张表。
目录身份是注册的一部分，不是事后补的标签：内建技能目录注册为**自己的**目录（`ClawHub`），插件默认目录注册为
`pi.dev`；`default` 是操作者来源未指定目录时落入的**系统**桶。市场目录选择器始终显示这个系统桶；命名内建目录
保持注册顺序并**排在前面**，系统桶永远不压过该轴的官方目录。

**git 来源的安装走运行时自己的命令链。** `PluginMarketplaceSpec`（`host/adapters/types.ts`）是每 host 的
argv 模板列表；writer 展开后**按序**执行，遇到第一个非零退出即停止。不抓 tarball、不写 `plugin[]` 数组、
不解析 payload。门 3 逐条原样回显命令（计划目标上的 `runs[]`）；`req.marketplace` 让 `installArtifact`
绕过解析分支。本次落地的命令链：

| Harness | 命令链 |
| --- | --- |
| claude | `plugin marketplace add {repo}` → `plugin install {plugin}@{marketplace} --scope {scope}` |
| codex | `plugin marketplace add {repo} --ref main` → `plugin marketplace upgrade {marketplace}` → `plugin add {plugin}@{marketplace}` |
| factory | `plugin marketplace add {urlGit}` → `plugin install {plugin}@{marketplace} --scope {scope}` |
| antigravity | `plugin install {url}` |
| opencode | `plugin add github:{repo}` |
| cursor | `/add-plugin {plugin}`——交互式 |
| grok | `plugin install {url} --trust`——直接从仓库安装（厂商的 `--trust` 是必需的非交互语法；闸 3 先行确认） |
| pi | 仅 npm（`install npm:{spec}`），无市场命令链 |

**交互式**命令链只在门 3 展示、绝不 spawn：厂商只允许在会话内安装，所以 apply 会带着原因拒绝，而不是
假装写入成功。npm 行仍走解析器路径，但必须显式声明 `subprocessArgs` 语法——没声明的 host 直接拒绝，

不会继承 pi 的语法。

**本地 REST 安装 API 同样是写入路径（2026-11-01 修订）。** Kimi Code 没有任何非交互的 CLI 插
件动词——`/plugins install` 只是 TUI 斜杠命令，`kimi -p` 会把斜杠命令当 prompt 文本（均已对厂
商源码与发行的 v2.4.1 二进制核实）。但 `kimi web` 在 loopback 上运行厂商的 kap-server，以
bearer 鉴权（`~/.kimi-code/server.token`），其 `POST /api/v1/plugins {source}` 驱动的正是 TUI
命令背后的同一个 PluginManager。writer（`host/writers/kimi-web.ts`）在临时 loopback 端口上启
动一次**瞬态** `kimi web --no-open`，轮询免鉴权的 `/api/v1/healthz`，用 home token 提交 source，
然后关闭服务器——下载/manifest/托管副本/`installed.json` 写入全部由厂商代码完成，本仓**绝不**
写厂商状态。计划目标是新的 `webapi` op，`echo` 逐字给出这次 POST；闸 3 的文案说明会启动并停
止一台瞬态 loopback 服务器。原交互式 `/plugins install {url}` 链条由此退役——cursor 现在是唯一
仅会话内安装的插件运行时。

**git 型 marketplace 行同样落到 webapi 落地（2026-11-01 修订）。** git 型行携带
`{repo, plugin, name}` marketplace 身份，编排器的闸过去为此要求一条 CLI marketplace
命令链——即使 kimi 的已验证落地是 loopback web API，也以「declares no native marketplace
install form」拒绝。该闸现在接受**任一**落地：有 `marketplaceSpec()` 命令链的宿主计划
该链；只有 `webApiSpec()` 的宿主（kimi）计划 `webapi` op；两者皆无的宿主仍然拒绝。

**marketplace 行经厂商的 LOCAL-PATH 分支安装（2026-11-01 修订，已对发行的 v2.4.1 二进制
实测）。** 厂商的 GitHub 解析器装不了 marketplace 形态的仓库：它把源重拼成
`<repo>@<plugin>@<marketplace>` 并把整个串当 git ref 解析（源不带 plugin 时即
`postmanlabs/postman-plugin@@postman`）——必然 HTTP 404。其**本地路径**分支可用。因此
webapi 宿主上的 marketplace 行由 writer 在自有临时目录浅克隆（`installMarketplaceRepoViaKimiWeb`）、
提交暂存目录的绝对路径、apply 后删除暂存目录；manifest/托管副本/安装仍全部由厂商自己的
PluginManager 基于该克隆完成。计划的 echo 逐字给出克隆与 POST（闸 3）。裸 `github:` 键保持
直连 URL POST。快照支持度闸仍在最前：探针未检测到目标宿主形态时先拒绝。

**源类型。** `github`（默认）照常探测仓库；`npm` 注册一个包（`@scope/pkg`）或整个作用域
（`@scope/*`，注册表搜索第一页，25 个包）为插件条目，行键为 `npm:<pkg>`。npm 条目只服务插件轴。
包页面 URL（`https://www.npmjs.com/package/<name>`，含 scope / `%2F` 形式及其 `/v/<version>` 页签）
会被归一成同一个包名——身份不变；tarball 或版本文档 URL 不是包页面，仍然无效：它命名的是源无法记录的钉扎。

**安装命令需要的名字来自源自己的清单。** probe 记录 `snapshot.marketplace`（收敛 catalog 的顶层
`name`，用 claude 解析器读取）与插件行的 `name`；按目录识别的 harness 只读这些**名字**，绝不读行。
行携带 `marketplace`，使 `marketplaceSpec` 的 `{plugin}@{marketplace}` 是厂商身份，而不是从仓库 slug 猜出来的。

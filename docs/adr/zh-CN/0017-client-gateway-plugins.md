# ADR-0017：client-gateway 插件 — MITM 腿之后的入站原生协议接管

## 状态

已实现 — 2026-11-05。

## 背景

两条扩展轴中此前只有一条落地：

- 插件清单的 `type` 字段是声明好的扩展轴（`plugins/types.ts`），但只有一种类型 `'model-service'` —— 承载出站方向的厂商协议知识（原生传输、凭证链、vendored 厂商二进制）。
- ADR-0008 的入站 surface 表是封闭的：四个 wire 别名，其余一律 404。协议既非 OpenAI 亦非 Anthropic 形态的厂商客户端（Cursor：ConnectRPC + protobuf over HTTP/2 打到 `api2.cursor.sh`，且端点不可配置）没有任何合法的入站路径。

Cursor 无法通过配置指向自定义端点 —— 它的 AI 流量硬编码到自己的 API 域名。唯一可行的集成拓扑是 TLS 拦截：让客户端指向入站 forward proxy（ADR-0008 §3），然后应答/中继解密后的流量。这正是 `plugins/types.ts` 早已为插件保留的那类厂商协议知识：后续阶段才会用到的 vendored .proto 集（阶段 2 才锁定到已验证的 Cursor 版本，见 §4）、帧编解码器、版本漂移提取工具。它们不应进入 core。

## 决策

### 1. 第二种插件类型：`'client-gateway'`

client-gateway 插件声明接管入站 forward proxy 上的整台 SNI 主机，并拥有这些主机解密流量的处置权。模块导出 `createPlugin(host: ClientGatewayHost): ClientGatewayPlugin`：

- `hosts: readonly string[]` —— 接管的主机（如 `api2.cursor.sh`）。
- `match(info)` / `handle(req, res)` —— 每请求准入与完整生命周期。网关在 h1 腿看到 node-http req/res，在 h2 腿看到 http2 兼容层（同形 API）。
- `ClientGatewayHost` SDK（自包含，与 model-service host SDK 同规则 —— 打包插件永不按路径 import backend 模块）：`chat(body, sink, signal)` 让一次规范 OpenAI 形态的补全走与 `/v1/chat/completions` 完全相同的 `dispatchSurface` 管线（模型解析、tier、熔断、捕获全部生效）；`catalog()` 暴露路由面供 AvailableModels 类应答构造；`ocrHome()` 供工件状态使用。

插件注册表（`plugins/gateways.ts`）为模块级，随插件宿主每个加载周期原子重建（stage → commit，镜像 model-service 注册表的交换模式），禁用/卸载立即热拔除。**host 作用域由注册表裁定，绝不信任插件**：`findGateway` 先按 `:authority`（h2 兼容层）/ `host`（h1）匹配、去端口、忽略大小写，然后才轮询插件的 `match()`。

### 2. 网关路由永不进入 ADR-0008 的 surface 表

SURFACES 表对直连 `/v1` 面保持封闭。网关路由是主机作用域的，只存在于 MITM 腿之后 —— 主机接管以插件安装为选择加入（安装即授权，信任模型不变）；被接管主机上的未知路径要么由网关自行中继，要么回落到透明转发。这就是第四条 Cursor wire 的合法归宿：不是表里的第五行。

### 3. forward-proxy 的 h2 腿 —— 传输层完备，不由插件门控

Cursor 的流式端点强制 HTTP/2（h1 客户端吃 464）；forward proxy 的按主机 TLS terminator 此前只有 h1（Bun 无服务端 SNICallback，故沿用现有按主机 terminator 模式）。h2 同时是 gRPC/Connect 流量的通用底层传输，因此这条腿不是 vendor 特性：它属于代理本身，插件只拥有它接管主机上的 vendor **语义**。

- 每台主机都同时通告两种协议，差别在**顺序**。Bun 尊重**服务端**偏好（已验证：服务端 `['http/1.1','h2']` + 客户端 `['h2','http/1.1']` 协商出 `http/1.1`），所以未接管主机通告 `['http/1.1','h2']` —— 双栈客户端（curl、浏览器、多数 SDK）继续走 surfaces 管线熟悉的 h1 路径，**零回归**；而只给 h2 的客户端拿到 h2，不再被降级弄坏。被接管主机通告 `['h2','http/1.1']`，因为插件连双栈客户端也要走 vendor 的 h2 线。terminator 缓存按 主机+模式 键控，运行时安装插件后下一个 CONNECT 即翻转通告。
- 到内环的路由在第一个解密块上判定：协商出的 ALPN 只是提示（Bun 在回调时刻不能可靠暴露服务端 `alpnProtocol`）；h2 连接 preface（`PRI * HTTP/2.0`）才是权威。h2 字节接先验 h2c 内环（`http2.createServer`，compat `request` API），h1 字节走既有内环。两个内环跑同一条 intercept 链，且 h2 回落同时接受 `:authority`（h1 用 `host`）。
- 透明转发会**重新发起它刚接受的协议**：h2 腿向上游也用 h2 中继（`forward-proxy/h2-forward.ts` —— 会话池、`:authority` 按拨号目标重建、剥离逐跳头但**保留 `te: trailers`**（gRPC 要求端到端）、响应 trailer 经 `addTrailers` 转发、双向 body 带背压、客户端断开即取消）。上游若不会说 h2，则在任何字节到达客户端**之前**把这次交换交回 h1 转发器 —— 包括已经捕获的 body 字节，由 h1 腿先写出（Bun 的 h2 兼容 IncomingMessage 会丢弃无人监听时发出的块，所以 body 头部必须同步捕获）。
- 后果：**不装任何插件**时，gRPC/Connect 客户端被完整透明代理 —— 完整 HTTP/2 语义、完整 access-log 捕获 —— 而不是被降级成 464。vendor 语义（Cursor 的 Connect 路由、模型目录）仍然需要插件；属于核心的只是传输。
- 网关中继走同一条腿：client gateway 通过 host SDK 的 `relayUpstream` 中继其认领主机，该调用跑的正是这些转发器，带 ADR-0018 **准入**门（`reject` → 任何拨号之前先 403，返回 `{ rejected: true }`）、**实时**规则表 egress、ADR-0019 上游信任与 h2/h1 回落。上游 scheme 由调用方声明 —— `opts.secure`（缺省 `true` = TLS；`false` = 明文源站）—— 声明明文源站**不**绕过其他任何东西：准入门与实时规则表 egress 与 TLS 腿完全一致（明文腿本来就没有证书可信任），且 h2 腿仅支持 TLS，所以明文源站由 h1 腿服务。插件永不自己拨号上游 —— 裸 `http2.connect`/`https.request` 会静默绕过全部。

### 4. 参考实现：`cursor-gateway`

仓库 dev 插件树携带分阶段参考实现（`plugins/cursor-gateway/`，独立仓库；此处不跟踪）：

- **阶段 1（已发布，0.1.0）** —— OBSERVE。认领四个 Cursor 主机，把每个解密交换经核心 host SDK（`relayUpstream`）逐字节中继上游；两个方向都抓取进按天 JSONL feed，Connect 帧由解码器在**读取时**解析。Cursor 继续打真实后端；抓取永不改写流量。
- **阶段 2+（dev 插件已发布）** —— OWN。解码并回答三条推理线（`agent.v1.AgentService/Run`、`aiserver.v1.InferenceService/RunInference`、旧版 `ChatService/StreamUnifiedChat…`），合并或替换模型目录，并路由被请求的 id：OCR 命名空间的 id 走 `host.chat`，其余 id 逐字节中继给 Cursor。客户端的 MCP 工具定义随 agent 线作为额外 function spec 传递。插件面向 operator 的 `mockGetMe` 开关（`mockEmail` 覆盖地址）由插件本地用合成身份回答 `aiserver.v1.DashboardService/GetMe`（Cursor 的登录校验），没有可用 Cursor 会话也能演练接管链路；其他账户/仪表盘 RPC 仍按原样转发。另一个仅用于测试的 `mockPlan` 开关会在回程改写 `/auth/full_stripe_profile` 的会员字段，让客户端选择器在免费账户上渲染注入的条目——上游资料不动，Cursor 服务端鉴权照常生效。
- 线格式：Connect 帧 `[1B flags][4B BE length][payload]`，0x01 gzip，EndStream JSON 位于 `0x02`（Connect 标准）或 `0x80`（Cursor 旧标记）—— 阶段 1 是无 schema 预览；阶段 2 vendor 锁定到已验证 Cursor 版本的 proto，客户端升级后重跑提取器。

### 5. 流量观测 —— 抓取全保真，展示开窗口

想让自己的流量可见的网关注册的是**解析器**（dissector），而不是一个视图。Wireshark 模型，按阶段拆开：

- **抓取（插件，写路径）** —— 插件把每个解密块直接流式写入旁挂文件 `<ocrHome>/plugins/traffic/<id>/bodies/<YYYYMMDD>/<exchangeId>-<side>.bin`，并往当天的 JSONL 追加**一行**元数据（头、字节数、状态、腿、文件引用）。内存里不缓冲任何东西：一次长 `StreamChat` 的代价是 O(chunk)，不是 O(body)。body **绝不为存储而截断** —— 唯一的天花板是失控保护（每侧 64 MiB），它停下写入并打上诚实的 `truncated` 标记。超过 7 个按天目录的 body 由插件自己的写路径清理。
- **解码（插件，读路径）** —— 后端在**读取时**用抓到的字节调用插件的 `dissect(exchange)`，返回具名的协议层。协议知识因此留在拥有那条线的插件里；控制台渲染它从未听说过的层。
- **展示（核心路由，读路径）** —— 路由每侧只读一个固定**窗口**（解析器 32 KiB，内联 hex 预览 1 KiB），只下发字节数与文件引用，永不下发 payload。`/api/admin/traffic-body/:token` 流式返回完整抓取以供下载 —— 与 proxy 日志用的是**同一个**中立端点，所以控制台永不知道是哪个子系统存的字节；全保真一键可得，而浏览器的 DOM 永不会收到几兆的 body。
- **一条时间线，一套筛选** —— 被解析的行并入既有的 proxy access-log 表（不新开 tab，不新开视图）。各列分类的是传输，不是厂商：type（`http` / `connect`）、protocol（`h1` / `h2` / `ws` / connect-rpc）、host、method、path、status、duration、↑/↓ body 字节数。
- **一个抽屉，一个解码器注册表** —— 每一行（proxy 或 gateway）都由**同一个**详情组件按归一化的单侧模型（头、字节、层、下载引用）渲染；行的种类只负责构建这个模型。一个 body 就是字节加上一串声称能解它的解码器：`hex` 是**兜底**解码器（Wireshark 的 `data` —— 永远适用，即回退项），内置 `text` / `json` / `image` / `pdf`，而每个插件解析层都排在它们之上。默认视图是排名最高且适用的解码器，于是协议知识无需 UI 里的排序逻辑就压过 hex，新增一种格式只是注册表里多一项 —— 永不新增一个分支。层输出由解析器打上**单侧标记**（`req` / `res`）：空响应 body 绝不能以已解码的样子出现。

后果：控制台永不学习厂商协议，未声明解析器的插件干脆不出现。保留期、feed 布局与尾部上限属于核心路由；字节归属属于插件。

### 6. 控制台归属

`/admin/clients` 新增 `cursor` 作为代理接入客户端（`SupportedClient`、`CursorClientAdapter`）。setup 无法写厂商配置文件 —— 它 (a) 要求 `forwardProxy.enabled`，(b) 写 `cursor-launcher.cmd|.sh|.command`（CLI 存在时再写 `cursor-agent-launcher.*`），启动器对 Chromium 腿设 `--proxy-server`，对 Electron 的 Node/gRPC 腿设小写 `http(s)_proxy` + `NODE_EXTRA_CA_CERTS` + `NO_PROXY`。阶段 1 不发布模型广告：插件的 `AvailableModels` 在阶段 2 才到来。按应用启动器是刻意的：不接管系统代理（那会和 Clash/v2ray 抢同一组注册表键），也不上内核重定向器。CA 信任保持 forward-proxy CA 原样（不新增信任材料）；安装仍是 operator 显式动作。状态探测按平台取证 —— Windows 查 Root 存储（`certutil`）、macOS 用 `security verify-cert` 走 SSL 信任策略、Linux 查锚点目录 + 合并 bundle + Chromium/Electron 实际读取的 NSS 数据库 —— 探测无法执行时返回 `unknown`，绝不猜。代理注入只在进程启动时生效：Dock / 开始菜单 / `.desktop` 启动会绕过启动器，已运行的单实例会吞掉后来的启动器调用。macOS 的 `.command` 以脱离方式启动 Cursor（`nohup … &`），所以关掉双击它的那个终端窗口不会带走 Cursor；Linux 的 `.sh` 保留 `exec`，因为它本身就是那个终端会话。teardown 删除启动器、≤0.1.x 遗留的 `models.json`，永不触碰 CA，永不触碰 Cursor 自身文件；CLI 已不在时 setup 会清掉过期的 CLI 启动器。状态回显同时发布**两条**启动器路径（`configPath` 加 `artifacts` 里的 CLI 启动器 —— 仅当 `cursor-agent` 已安装或此前 setup 留下的启动器文件仍在时才发布，否则 `artifacts` 缺省不存在），控制台卡片据此列出 setup 拥有的每一个启动器，而不是只显示 IDE 那一个。`ocr cursor` / `ocr cursor-agent` 是直通动词：直接执行托管启动器（转发 stdio 与**启动器**的退出码，被信号终止时为 `128+signum`），不再另行推导 env —— 命令行与双击共用同一份契约。Windows/macOS 的 IDE 启动器是刻意脱离的（`start`/`nohup`），因此那里的退出码属于启动器，`--help`/`--version` 的输出属于它启动的应用而非 `ocr cursor` —— CLI 会明说这一点，而不是静默退出 0；Linux 的 `.sh` 与两个 agent 启动器保持挂接，转发真实退出码。

同一页还能导出插件：`GET /api/admin/plugins/:id/package` 对已打包插件原样返回其安装 zip，对 dev 树插件则先将其入口 **bundle**（第三方依赖内联）再用与 `plugins:build` **同一个确定性打包器**压包——下回来的包可直接再 Install，且与构建产物逐字节相同。

插件包始终**自包含**：发行版宿主是 `bun build --compile` 单文件，编译态只从内嵌 snapshot 解析裸包名，**不**查磁盘 `node_modules`。因此纯源码包会在加载时被拒绝并给出重新打包提示；依赖解析属于打包期（作者/CI），绝不放在插件安装期。`plugin.json` **不**携带依赖清单：仓内插件把 npm 包声明在宿主仓库的 workspace `package.json`（打包器从仓库 `node_modules` 解析），仓外作者直接交付已 bundle 的 `index.js` —— 安装期唯一的契约是入口在零外部包的情况下可解析。bundle 按 **Node** 目标构建而不是 Bun，因为**两个**宿主运行时必须跑同一份产物：编译后的 sidecar 与 `node backend/dist/index.js`（README：Bun 或 Node >= 18）。`bun` 目标会为内联依赖里的 CJS 互操作发射 `import.meta.require` —— 这是纯 Bun API，曾导致包在 sidecar 里能加载、在 Node 入口直接抛 `__require is not a function` —— 所以 CJS 互操作改为发射 `createRequire`，而 bundle 里仍残留 `import.meta.require` 的包会在打包期被拒绝。每个包还带一个内容为 `{"type":"module"}` 的 `package.json`（仓库源码里的 `package.json` 会被替换、绝不随包发出）：入口是 ESM，而裸 `.js` 从 Node 20.19 / 22.7 起才因语法探测默认按 ESM 处理 —— README 仍支持的 Node 18 在没有这个标记时会把 `export` 当 CommonJS 解析并报错。

官方包与三方包共用**一个**加载器和**一种**包格式。优先级是确定性的：源码树（**仅当** `OCR_PLUGIN_SRC_DIR` 指定时才读——`bun run dev` 会为它自己的后端子进程指定 `plugins`，因为那正是编辑插件的命令；除它之外没有任何入口读检出目录，所以已安装或独立运行的网关列出的就是**已安装**的东西，装卸流程可测，而不是被幽灵行挡住；连 dev 默认也不要，就用空的 `OCR_PLUGIN_SRC_DIR=` 退出）> `<pluginsRoot>/bundled/*.zip`（随应用分发）> `<pluginsRoot>/*.zip`（operator 安装），同一根内按文件名排序；一个 id 归**优先级最高**的那一份所有——重复会告警并忽略低优先级副本，而**加载失败**的副本同样占住该 id（控制台一个 id 只一行，disable/uninstall 只有一个目标），因此永不依赖 `readdir` 顺序。任何根内的包**文件名都是自由格式**：每个归属问题——应用是否已经分发这个 id、这次 install 是否算覆盖、这次 uninstall 是否写墓碑——都按 **manifest id** 判定，绝不靠猜 `<id>.zip`。`bundled/` 是应用自有层：想遮蔽它的 install 会被拒绝，`ocr-*` 前缀为它们保留且在 **install 期**即被拒绝（不只是加载期），卸载它们只在 `disabled.json` 写墓碑、不删除应用自有文件。卸载会删掉包、解包副本、账本条目、插件**注册**的 preset provider（仅当 defs 文件里的节点仍与插件写入时完全一致才删——operator 改过就归 operator，保留）以及 disabled 账本行；它连 `<pluginsRoot>/config/<id>.json`（operator 的插件配置）也一并删除 —— 所以卸载是**彻底清空**：包、解包副本、账本行、已注册的 preset provider、配置产物，以及删完最后一个后空掉的 `plugins/config/` 目录。配置不需要存活，因为**升级不是**「卸载 → 安装」：升级是**直接覆盖安装同一个 id**，它会重新解包（mtime 是新的，模块缓存失效，无需重启），不动配置产物和 operator 改过的 provider 定义，并对它声明的 preset 做一次对账——**新版本删掉的** preset 会从 `providers.json` 退役（除非那条定义被 operator 改过，那就归 operator），因此升级不会留下任何属于旧版本、已不存在能力的 provider——并把 disabled 插件变回 enabled（安装本身就表达了“我要用”）。解包目录是**重建**而非合并：新版本删掉的资源文件随旧树一起消失。唯一把卸载做成可逆墓碑的是**随应用分发的包**：文件属于应用，重新 enable 时不该连带把配置丢掉。**当前构建流水线不填充这一层**——「插件是否随应用分发」还是一个未定的产品问题——所以它由决定随包发插件的发行放进去，或由 operator 自己有意放一份；守卫只对实际存在的东西生效，而 `bun run plugins:build` 只把可安装产物写进仓库内的 `<repo>/.plugin-dist/`——它是仓库构建输出，既不写应用自有层、也不写运行时根：包是通过控制台上传完成安装的，构建步骤不去写 `OCR_HOME`。重载是分层的，边界就是模块缓存：`POST <prefix>/plugins/reload` 在进程内重新从磁盘导入，足以覆盖 `plugin.json`（schema、preset、展示）与插件**入口文件**的改动——每次导入都用入口 mtime 做 cache-bust，且 specifier 用**路径**而非 `file://` URL，因为 Bun 对 file-URL 模块只按 URL 记缓存、忽略 query，在 Windows 上会一直返回旧模块直到重启；但**被入口 import 的子模块**改动无法从外部 bust——它的解析 URL 不带 query，缓存会继续命中。那是 watcher 的职责：`bun run dev` 已经用 `bun --watch` 跑后端，加载图里任何文件变化都会重启进程并重建模块。**加载失败的包会被**丢弃**，绝不每次启动重复失败——而当它是作为**升级**上传时，先恢复此前在跑的那一版，所以一次坏的上传是幂等的（422 + 旧包回来、配置完好），而不是丢掉插件。被拒绝的 install 不写任何东西**——判定发生在触碰任何产物或账本之前。`plugin.json.apiVersion` 声明插件契约版本，必须**等于** `SUPPORTED_PLUGIN_API`：v1 是第一个插件机制，不承诺向后或向前兼容，因此任何其它值——以及缺失该字段——都是非法包，在 install 落盘前拒绝，加载期再拒绝一次；给 host SDK **增加**能力（如 `pluginDir()`）属于增量、**不**提升 `apiVersion`，只有删除或变更契约才会。`plugin.json.id` 必须是小写 slug（`a-z`、`0-9`、`-`，首字符为字母或数字），因为它**就是**目录名——`<pluginsRoot>/unpacked/<id>/` 与规范安装目标 `<pluginsRoot>/<id>.zip`（手工放进任一根的包保留它自己的文件名）——所以 manifest 校验器会在任何包能操纵这些路径之前拒绝一切路径形状的 id，大小写也无法在大小写不敏感的文件系统上绕过 `ocr-` 保留字。还有：manifest 不可读的包，只有**文件名本身**是 slug 时才会以一行形式浮出——id 是路径组件，所以名字任意、身份不明的文件只会被告警并忽略，绝不交给解包器。由于插件包是单个扁平化入口，随包分发的数据文件一律从 `host.pluginDir()`（插件的加载根）解析，**绝不**用内层源码模块的 `import.meta.url`——源码被打包后它的父目录已经不在包内，轻则提示词静默降级，重则 proto 语料直接加载失败。

### 7. 插件级配置

插件可声明面向 operator 的参数，控制台按声明通用渲染设置表单。三个来源严格分离：

- **声明** —— `plugin.json` `configSchema`：扁平数组，元素 `{key, type, default?, min?, max?, values?, enumLabels?, control?, section?, visibleWhen?, title?, desc?}`，其中 `type ∈ string|number|boolean|string[]|enum`，另外可选 `configSections` 分组。`title`/`desc`/`enumLabels` 沿用清单的 locale-map 约定（纯字符串或 BCP-47 键的字符串映射）；`enumLabels` 把一个已声明的 `values` 项映射到操作者看到的文案——机器值（`follow`）本身不是标签。`visibleWhen` 是**仅影响显示**的谓词——`{key, equals?|in?}`，且只能指向一个兄弟 enum/boolean 字段。`control` 从**封闭**的控制台控件词表（`text` | `textarea` | `model` | `models` | `segmented` | `apiKey`）里选一个控件，且必须能驱动该字段的类型（`model` 对 `string`、`models` 对 `string[]`、`segmented` 对 `enum`、`apiKey` 对 `string`——即控制台自己模式开关用的连体按钮形态，这样「不设置 / 自定义 / 跟随 Key」这类三选一不必硬塞进下拉框）；控件只改变取值的**编辑方式**，存储、校验、合并仍按类型驱动，所以 `model` 的值在产物里依然是一个纯字符串。新增控件属于控制台能力（注册表 + 渲染器 + 本 ADR），插件既不能自创也不能组合。`configSections: [{id, title?, advanced?}]` 用来把字段分组，**只声明一次**、由 `field.section` 引用（每个字段自带标题就是 drift twin）；声明了却无人引用的 section、字段指向未声明的 id，安装期即失败；一个 section 里的字段若全被 `visibleWhen` 隐藏，则不渲染该标题。`advanced` 让整组默认折叠——组内取值同样保留，与隐藏字段一致。这就是它的全部表面积：没有表达式、没有布局、没有顺序、没有分页、也没有插件自带的 UI 代码（那会以管理员凭证在控制台里运行）。**分组就是终点**：超出 sections 的表单应该是控制台的第一方页面，而不是更厚的协议。排列顺序为：已声明 section 顺序 → 组内 schema 顺序，无分组字段排在最前。排布权留在控制台；插件只声明条件，以及在默认控件不适配数据时从词表里点一个控件。被 `visibleWhen` 隐藏的字段**不清空也不跳过**——它保留取值，仍参与校验与合并，操作者切回某个模式不会丢掉已填内容。仅原始类型；刻意不引 JSON-Schema 引擎或布局 DSL —— 那会把任意 UI 复杂度邀请进插件协议。畸形 schema 在安装/装载时响亮失败（作者侧 API 不得静默降级）：未知或与类型不兼容的 `control`、无人引用的 section、字段指向未声明的 section、`visibleWhen` 指向未知字段、指向没有离散取值的字段、指向目标永远不会取的值、以及可见性成环，都是安装期错误。
- **存储** —— `<pluginsRoot()>/config/<id>.json` 只存 operator 的**生效值**（非默认值）。插件参数**永不**进入 `config.yaml`（ADR-0016：schema 冻结；插件生命周期状态随插件工件存放，disabled.json / registrations.json 先例）。
- **合并** —— host 逐字段校验存储值（未知键丢弃；类型/范围不符回落默认值并告警；坏工件永不导致装载崩溃），把合并结果通过 host SDK `config()` 交给插件。`''` 是合法的 `string` 值：声明为空的默认值可原样往返。调用时查询：控制台保存后永远是最新。合并结果按插件 id 缓存；每次插件重载使缓存失效，手改工件可被拾取。

控制台：`GET /api/admin/plugins/:id/config` 返回 `{schema, values}`，`PUT` 校验 + 持久化 + 触发插件可选的 `onConfigChange(config)`（钩子失败绝不回滚已持久化的保存；合并值无论如何都会通过 `config()` 到达插件）。无 schema 的插件不暴露任何字段并拒绝写入 —— 不存在自由参数袋。

`cursor-gateway` 使用该机制承载它的整个 operator 面：抓包（`logFrames`、`previewBytes`）、模型目录（`model` 写入 Cursor 的默认模型 RPC，`forceModel`，`modelListMode` 及其 `models`/`followKeyId`，`catalogReplace`）、Agent 循环（`maxTurns`、`toolTimeoutMs`、`heartbeatMs`、`maxResultChars`、`contextMaxChars`、`systemPrompt`）、接管范围（`interceptAgent` / `interceptDesktop` / `interceptLegacy`，以及后者的旧版开关）与合成 `GetMe` 应答（`mockGetMe` / `mockEmail` / `mockPlan`）。Client Hub 卡片只编辑该 schema 的模型目录子集；Plugins 页抽屉渲染其余字段。

## 后果

- 厂商入站协议可插拔，core 不再增长；proto 语料与其漂移工具在阶段 2 vendored 之后随需要它们的插件走（§4，安装即授权）。**传输**是另一半，而且它不动：h2 重发属于核心（§3），并通过 `relayUpstream`（ADR-0018 准入门 + 实时规则表 egress + ADR-0019 上游信任 + h2/h1 回落）暴露给网关，所以插件作者只需要写语义或观测——什么都不装的运维方同样得到可用且完整落日志的 h2/gRPC 透传。
- 网关中继永不静默绕过 forward-proxy 策略：`relayUpstream` 是唯一拨号路径，应用 ADR-0018 准入门、实时规则表 egress 与 ADR-0019 信任。插件自己拨号上游是缺陷，不是优化。
- TransportContext 多了第三个实现（回调 sink 的网关 seam）—— 终端发送纪律由三个实现共同背书，插件补全对路由/熔断/捕获而言与原生腿补全无法区分。
- Bun http2 服务端的怪癖（terminator 回调时刻 `alpnProtocol` 不可靠）已固化为 preface 嗅探规则 —— 不要"简化"回纯 ALPN 路由。同一族的怪癖、同一条规矩：ALPN **顺序**是服务端偏好决策（实测，不靠假定），且 h2 兼容 IncomingMessage 会丢弃无人监听时发出的块 —— 所以 h2 请求体头部必须在第一个 await 之前同步捕获。
- 边界：Tab 补全、代码库索引与登录流量不被拦截（未接管主机/中继路径 —— Cursor 对这些继续打真实后端）；网关不承担 `x-cursor-checksum` 义务（它是服务端不是客户端）；个人使用，自己的机器，自己的账号。
- 不新增 config.yaml 节：网关生命周期状态随插件工件存放（disabled.json / registrations.json 先例，ADR-0016 姿态不动）；operator 设置的插件值存在 `<pluginsRoot()>/config/<id>.json`，永不进入 schema。

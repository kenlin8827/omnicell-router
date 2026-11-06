# ADR-0017：client-gateway 插件 — MITM 腿之后的入站原生协议接管

## 状态

已实现 — 2026-11-05。

## 背景

两条扩展轴中此前只有一条落地：

- 插件清单的 `type` 字段是声明好的扩展轴（`plugins/types.ts`），但只有一种类型 `'model-service'` —— 承载出站方向的厂商协议知识（原生传输、凭证链、vendored 厂商二进制）。
- ADR-0008 的入站 surface 表是封闭的：四个 wire 别名，其余一律 404。协议既非 OpenAI 亦非 Anthropic 形态的厂商客户端（Cursor：ConnectRPC + protobuf over HTTP/2 打到 `api2.cursor.sh`，且端点不可配置）没有任何合法的入站路径。

Cursor 无法通过配置指向自定义端点 —— 它的 AI 流量硬编码到自己的 API 域名。唯一可行的集成拓扑是 TLS 拦截：让客户端指向入站 forward proxy（ADR-0008 §3），然后应答/中继解密后的流量。这正是 `plugins/types.ts` 早已为插件保留的那类厂商协议知识：数 MB 的 vendored .proto 集（7 个文件，约 7 万行，锁定 Cursor 3.28.7）、帧编解码器、版本漂移提取工具。它们不应进入 core。

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

### 4. 参考实现：`cursor-gateway`

仓库 dev 插件树携带参考实现（`plugins/cursor-gateway/`，vendored protos + `protobufjs`，keepCase 加载 —— 提取的 proto 是蛇形命名）：

- `AvailableModels`（一元）按广告工件 `<ocrHome>/gateways/cursor/models.json`（`{models: string[]}`，由控制台 Cursor 客户端适配器写入）应答，缺省回落到实时 `catalog()` —— Cursor 的模型选择器逐字显示 OCR 的 tier/模型。
- `StreamUnifiedChatWithTools`（双向）实现 AGENT LOOP：对话历史 → 规范消息；OpenAI `tool_calls` → `ClientSideToolV2Call` 帧（枚举 `ClientSideToolV2`、`tool_call_id`、`name`、`raw_args` JSON）；客户端后续的 `ClientSideToolV2Result` 帧（同一请求信封的字段 2）→ `role:'tool'` 消息并进入下一轮；无工具调用的轮次关闭流（Connect 0x80 end-stream JSON trailer）。
- `StreamUnifiedChat`（服务端流，顶层裸文本）与 SSE/Poll 变体的诚实 `unimplemented` Connect trailer；被接管主机上的未知路径经真实 TLS 用 h2 客户端中继上游（`agent.api5.cursor.sh` 仅 h2）。
- 线格式编解码：Connect 帧 `[1B flags][4B BE length][payload]`，0x01 gzip，0x80 end-stream-JSON —— 自集成验证所用的协议实验台移植（Cursor 3.28.7）。proto 锁定；客户端升级后重跑提取器并重新 vendor。

### 5. 控制台归属

`/admin/clients` 新增 `cursor` 作为代理接入客户端（`SupportedClient`、`CursorClientAdapter`）。setup 无法写厂商配置文件 —— 它 (a) 要求 `forwardProxy.enabled`，(b) 写启动器（`cursor-launcher.cmd|.sh|.command`）以 `--proxy-server=http://127.0.0.1:<livePort>` 启动探测到的 Cursor 二进制，(c) 写模型广告文件。CA 信任保持 forward-proxy CA 原样（不新增信任材料）；安装仍是 operator 显式动作（certutil/security/update-ca-certificates 探测尽力而为，探测不出即诚实 `unknown`）。teardown 只删启动器 + 广告文件 —— 永不触碰 CA，永不触碰 Cursor 自身文件。

### 6. 插件级配置

插件可声明面向 operator 的参数，控制台按声明通用渲染设置表单。三个来源严格分离 —— 与 §4 的广告文件同一三元组的一般化：

- **声明** —— `plugin.json` `configSchema`：扁平数组，元素 `{key, type, default?, min?, max?, values?, title?, desc?}`，其中 `type ∈ string|number|boolean|string[]|enum`，`title`/`desc` 沿用清单的 locale-map 约定。仅原始类型；刻意不引 JSON-Schema 引擎 —— 那会把任意 UI 复杂度邀请进插件协议。畸形 schema 在安装/装载时响亮失败（作者侧 API 不得静默降级）。
- **存储** —— `<pluginsRoot()>/config/<id>.json` 只存 operator 的**生效值**（非默认值）。插件参数**永不**进入 `config.yaml`（ADR-0016：schema 冻结；插件生命周期状态随插件工件存放，disabled.json / registrations.json 先例）。
- **合并** —— host 逐字段校验存储值（未知键丢弃；类型/范围不符回落默认值并告警；坏工件永不导致装载崩溃），把合并结果通过 host SDK `config()` 交给插件。调用时查询：控制台保存后永远是最新。合并结果按插件 id 缓存；每次插件重载使缓存失效，手改工件可被拾取。

控制台：`GET /api/admin/plugins/:id/config` 返回 `{schema, values}`，`PUT` 校验 + 持久化 + 触发插件可选的 `onConfigChange(config)`（钩子失败绝不回滚已持久化的保存；合并值无论如何都会通过 `config()` 到达插件）。无 schema 的插件不暴露任何字段并拒绝写入 —— 不存在自由参数袋。

`cursor-gateway` 使用该机制承载 `toolTimeoutMs`（0 = 工具调用帧省略 `timeout_ms`）、`relayUnknownPaths`（false = 未知路径回 unimplemented Connect trailer 而不是中继）、`debugFrames`（帧级日志）。模型广告仍是独立工件 —— 由客户端适配器从 Cursor 卡片的模型槽位写入，不是 operator 自由文本。

## 后果

- 厂商入站协议可插拔，core 不再增长；2 MB 的 proto 语料与其漂移工具随需要它们的插件走（安装即授权）。**传输**是另一半，而且它不动：h2 重发属于核心（§3），所以插件作者只需要写语义——什么都不装的运维方同样得到可用且完整落日志的 h2/gRPC 透传。
- TransportContext 多了第三个实现（回调 sink 的网关 seam）—— 终端发送纪律由三个实现共同背书，插件补全对路由/熔断/捕获而言与原生腿补全无法区分。
- Bun http2 服务端的怪癖（terminator 回调时刻 `alpnProtocol` 不可靠）已固化为 preface 嗅探规则 —— 不要"简化"回纯 ALPN 路由。同一族的怪癖、同一条规矩：ALPN **顺序**是服务端偏好决策（实测，不靠假定），且 h2 兼容 IncomingMessage 会丢弃无人监听时发出的块 —— 所以 h2 请求体头部必须在第一个 await 之前同步捕获。
- 边界：Tab 补全、代码库索引与登录流量不被拦截（未接管主机/中继路径 —— Cursor 对这些继续打真实后端）；网关不承担 `x-cursor-checksum` 义务（它是服务端不是客户端）；个人使用，自己的机器，自己的账号。
- 不新增 config.yaml 节：网关生命周期状态随插件工件存放（disabled.json / registrations.json 先例，ADR-0016 姿态不动）；广告文件是插件工件状态，不是 schema。

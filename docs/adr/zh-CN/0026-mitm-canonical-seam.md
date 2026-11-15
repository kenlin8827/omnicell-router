# ADR-0026 — MITM 标准接缝：模型流量归插件所有，未知名机制整体删除

- **状态：** 已实现
- **日期：** 2026-11-15
- **取代：** [ADR-0003](./0003-model-addressing-and-tier-membership.md) §7a（整节废止）
- **关联：** [ADR-0017](./0017-client-gateway-plugins.md)（客户端网关插件）、[ADR-0018](./0018-forward-proxy-rule-table.md)（规则表与准入）、[ADR-0008](./0008-protocol-surfaces-and-capture.md)（协议面表）

## 背景

当时有两个同时悬空的问题，而它们其实是同一个问题：

1. `forwardProxy.unresolvedModel`（ADR-0003 §7a）是**一套活在传输配置里的第二套模型寻址政策**。它的三个动词各自复制了一个已有归属的机制——`fail` 复刻了 `#variant` 的 404 契约，`direct` 复刻了代理自己就有的逐字节透传，modelRef 复刻了组合与档位别名。它唯一没有孪生兄弟的部分是逐主机覆写表，而它唯一的真实场景（“这个 host 的目录我不镜像”）是关于**厂商**的事实，不是全局政策。
2. MITM 腿**自己懂模型流量**：拦截器自己识别标准协议面并派发进管线。于是“这条请求归谁”有两个答案——插件注册表（host 认领）和拦截器（路径表）。

(1) 的实际代价：一个专属控制台页、一个导航项、八个语言命名空间、一个带三条 YAML 注释的配置键、一个测试文件、一个 `DirectForwardPlan` 结果形状、一个只服务 `direct` 的传输执行器，以及一段必须自问“我是不是在 MITM 腿上”的 orchestrator 分支。(2) 的实际代价：网关插件可以认领 host，却永远无法**拥有标准协议面**，因为拦截器已经先把它们拿走了。

## 决策

### 1. 未知名机制是删除，不是废弃

`forwardProxy.unresolvedModel`、`pipeline/unresolved-model.ts`、`UnresolvedModelConfig` 类型、`DirectForwardPlan` 结果、`surfaces/direct-forward.ts`、`directMiss` 路径、控制台页面、它的路由、导航项与语言命名空间**都不存在**。不接受、不翻译、不警告。

走完全部解析阶段仍未命中的模型名，交由分类器决定——**每一条腿都一样**，MITM 也不例外。这就是全部行为。管线里不再有任何“MITM 特殊”的姿态，orchestrator 也不再打听自己在哪条腿上。

之所以是删除而非缩小键：每个动词都是既有决策点的副本，而一个会给出不同答案的副本，比缺一个功能更糟。网关没有镜像其模型名的厂商，正确做法是**不认领那个厂商的 host**（请求随后逐字节透明转发，这正是 `direct` 在模仿的事），或由一个网关插件显式映射名字（这是 modelRef 在模仿的事，但映射归真正了解厂商的那一方所有）。

### 2. 两种认领形状，一个 accept 钩子

`ClientGatewayPlugin.hosts` 只接受两类条目：

- **精确 SNI 主机**（`api2.cursor.sh`）—— 厂商所有者；
- **通配** `'*'` —— 通用网关，愿意为任何没有被精确认领的主机作答。

排序归注册表，不归插件：**所有精确认领先被询问，通配认领最后。** 所以通配永远不会因清单顺序盖住厂商插件。

`match(info)` 是 **accept** 步骤且不可省略，这正是通配得以安全的原因：`hosts: ['*']` 表示*“我愿意在这里作答”*，`match()` 表示*“而我真正认识的是这些流量”*（标准路径、方法）。通配的拒绝不是吞下一切——请求会落到下一个网关，最终落到透明转发。

这就是全部扩展点。通用网关就是一个 `hosts: ['*']`、`match()` 接受标准协议面的插件；不需要新插件类型、不需要新清单字段、不需要改核心。

### 3. 模型服务是一行**网关**，内置那一行也不例外

修订 2（2026-11-15）：拦截器不再派发任何协议面。它只有两个结果，不是三个：

1. 某个网关接受请求——精确认领、已安装的通配认领、最后是**内置**通配行——由它拥有；
2. 无人接受 → 不是模型流量 → 逐字节透明转发。

标准协议面归 `plugins/builtin/model-gateway.ts` 所有：`hosts: ['*']`，`match()` = `POST` + 命中 `surfaces/table.ts` 的路径，`handle()` = 读 body → `createNodeHttpTransport` → `dispatchSurface`。在编排关心的每个意义上它都是一个网关；唯一让它“内置”的原因是它随进程绑定、不从包加载——因为它只需要活的 orchestrator。

它**排在最后**，在所有已安装通配之后。这个顺序就是整套替换故事：装一个通配包即抢在内置行之前、无需改核心，禁用即交还，而任何插件都无法靠清单顺序盖过厂商的精确认领。

内置行刻意**不进** `gateways` 映射：拦截器持有它，并把它作为**调用方的兜底行**传给 `findGateway()`，因此它不是注册表状态。`listGatewayHosts()` 供给 CONNECT 准入、h2 优先中继选择和控制台的认领预览——那个集合里出现字面 `'*'` 会把每个主机的判定翻转。这一行对上述消费者不可见是**结构性的**，不是靠过滤；而把它做成参数而不是模块状态，意味着同一进程里的两个拦截器无法互相改写对方的模型流量。

### 4. 为什么这个位置的默认占用者是内置行，而不是一个包

诱人的替代方案——把同样的东西发成 `plugins/model-gateway/`——今天做不到等价。服务一条解密后的标准请求不只是“跑管线”：请求以 node-http 的 `req`/`res` 抵达，而把它变成 `TransportContext` 的适配器里有四项策略：

- **带 32 MB 上限的 body 读取**及其 413 封装（`surfaces/transport-node-http.ts`）。
- **客户端交换捕获**（`observability/http-exchange.ts`）：控制台逐轮的客户端请求/响应记录，由传输层在终态发送里发出。插件 SDK 够不到它——`GatewayRelayTap` 是**另一个**feed（插件自己的流量日志，Cursor 网关写的就是这个），所以包要么复制记录器，要么在被安装的那一刻静默丢掉被捕获的轮次。一个会改变控制台能看见什么的网关不叫即插即用。
- **免密钥 POLICY EXEMPTION**（见 `surfaces/transport-node-http.ts`：那条线上的 `Authorization` 属于真正的上游）。网关插件的补全则是**密钥绑定**的（ADR-0017 §48），所以包要么要求运维绑定密钥——改变“把工具指向代理”的成本——要么 SDK 必须授予插件同等豁免。
- **协议形状。** `host.chat()` 接收 OpenAI 形状的 body；内置行服务四种协议，它们的 body 由 `surfaces/` 先解析。

把这四项全部开放给插件，产出的不是一个插件，而是那个适配器换了个插件名字。所以接缝画在策略真正居住的地方：**适配器留在核心，可被包替换的是那一行**。如果未来某个 ADR 把捕获记录器与豁免开放给 SDK，包形态就成立了，而内置行原样继续工作——顺序已经允许。

今天运维不用等这些也能做：装一个只接受自己想拥有的协议面的通配包（比如只吃 `/v1/messages` 的 Anthropic 工作流），其余一概拒绝。拒绝会落回内置行，所以**部分替换**现在已经成立。

## 后果

- **删除项。** 一个控制台页面 + 路由 + 导航项、八条语言文案、一个配置键（en/zh 各三条 YAML 注释）、一个 223 行测试文件、`forward-proxy.test.ts` 中的一个测试块、`config-migration.test.ts` 中的一条断言、`pipeline/unresolved-model.ts`、`surfaces/direct-forward.ts`、`DirectForwardPlan`、`directForward`、`directMiss`、`ProcessContext.unresolvedModel`、`TransportContext.relayUpstream` 的唯一调用方。
- **`forwardProxy` 段回归纯传输。** 规则、准入、TLS 信任、访问日志、端口/地址/CA 目录。其中不再有任何东西决定一个模型名意味着什么。
- **拦截器没有派发分支。** `forward-proxy/interceptor.ts` 就是 `findGateway` → `handle` → 否则 `return false`。它答不了“这条请求是什么”，只能答“谁拥有它”——所以未来任何协议面要进 MITM 腿，都必须过一行网关。
- **被代理客户端的未知名，不再是 404，也不再是直通。** 它像任何未注册名字一样走路由：分类器决定。想要硬失败的运维去注册那个名字，或用会映射它的插件。
- **`listGatewayHosts()` 原样返回通配。** 它是认领词汇，不是解析后的主机清单；需要具体主机的消费方自行过滤 `'*'`。规则表的 `claimed` 原因仍是精确匹配，所以通配网关不会悄悄把每个 host 翻成 `intercept`——MITM 决策仍然归规则表。
- **`dist/` 构建产物在下一次构建前仍带废弃字符串**；它们是生成物、运行时不会被读取，也不构成任何兼容承诺。


## 第一个按精确 host 认领的包：`opencode-gateway`

代理模式是两个半边，互不替代：**入口**让客户端的流量进入 forwardProxy（把 `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` 写进 OpenCode 的托管服务），**归属**决定这些流量是什么意思。本节讲后者。自 ADR-0028 起两个半边同属一个包 `plugins/opencode-gateway/`——入口是它的 `client-adapter` part，下面这些认领是它的 `client-gateway` part。

`plugins/opencode-gateway/` 是第一个按**精确 host**（而非通配）认领的包，它钉住了三条该保留的边界：

- **不用通配。** OpenCode 没有独占 host，`'*'` 认领会把机器上其他客户端的流量一起抢走。认领是一份可配置的 host 列表，`match()` 再把它收窄到模型路径上的 `POST`——遥测、鉴权、上传、模型目录保持透明。
- **只接管一条 wire，不是四条。** `host.chat()` 输出的是 canonical OpenAI 帧，所以 OpenAI chat 线可以端到端应答、零转换。Anthropic 与 Responses 请求**主动拒绝**，落回内置行——它们的转换器已经在核心里；在包里再写一份，就是上文那四条策略的第二个实现，而且没有主人保证两者不漂移。
- **`intercept: false` 依然认领。** "装了但透明"没法用"拒绝"表达：内置行照旧会派发。所以它先认领，再经 `host.relayUpstream` 逐字节转发，走的是与透明转发完全相同的传输策略。

它的模型策略就是代理模式的契约本身：OCR 目录里有的引用原样保留；目录里没有的 OpenCode 原生引用（`claude-sonnet-4-5`）落到配置的目标模型（默认 `auto`），而不是 404；`forceModel` 则无视客户端选了什么，一律改写。

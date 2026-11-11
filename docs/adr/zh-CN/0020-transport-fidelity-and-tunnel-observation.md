# ADR-0020：传输保真与隧道观测

日期：2026-12
状态：已接受
治理对象：`backend/src/forward-proxy/server.ts`（MITM 各腿、隧道、`Upgrade:`
中继）、`backend/src/forward-proxy/relay.ts`（`splice` 及其 tap）、
`backend/src/forward-proxy/ws-frames.ts`（帧观测器）、
`backend/src/forward-proxy/access-log.ts`（`recordProxyTunnel`）、
`backend/src/forward-proxy/sni.ts`（`peekClientHello`）。

## 背景

代理终结 TLS 之后，必须把「它接受了什么」重新发起出去。三个问题反复出现，
而每个问题的答案此前都只隐含在代码里：

1. **重新发起要多保真？** h2 客户端不能被降级到 h1 应答（gRPC/Connect 的帧、
   trailer、双向流），这正是 `h2-forward.ts` 存在的原因。同一个问题同样适用于
   WebSocket、一般的 `Upgrade:`，以及盲隧道里承载的任何东西。
2. **对网关而言「盲隧道」意味着什么？** 通用 TCP 拦截（mitmproxy 的 `tcp`
   模式）是调试能力，不是网关能力：没有 HTTP 语义的字节根本无法进入路由流水线。
3. **运行时能做到什么？** 若干 Bun 缺口决定了答案，而未记录的缺口和 bug
   无法区分。

## 决策

### 1. 保真：客户端说的协议，就在上游重新发起

客户端说什么协议，源站腿就说同一协议。做不到时给明确错误——绝不静默降级。

| 客户端腿 | 源站腿 | 说明 |
|---|---|---|
| h1 请求 | h1（`forwardDirect` / `forwardSecureViaProxy`） | — |
| h2 请求 | h2（`forwardH2`），h1 回退 | 回退只发生在任何字节到达客户端之前，并重放已捕获的 body 头部 |
| `Upgrade:`（h1） | 字节级原样中继 | 握手只有一跳；重新序列化会破坏子协议/扩展 |
| h2 `CONNECT :protocol=websocket` | **不提供** | 见 §3 |
| 盲隧道 | 原始 splice | 见 §2 |

### 2. TCP 只透传——但必须可观测

盲隧道不解密、不解析、不修改。它**必须**可观测，因为「开了一条隧道」什么
也回答不了：

- **不解密也能看到身份。** 每条隧道的首包都会做 ClientHello 探测
  （`peekClientHello`）：记录 SNI 与 ALPN 列表。探测搭在中继自己的 tap 上，
  因此不可能从 splice 里偷走字节，也不拖延中继——服务器先说话型协议
  （SMTP、IMAPS）不会被「等一个正在等问候语的客户端」卡住。
- **字节总量与存活时间。** 隧道结束时落一行带 `reqBytes` / `respBytes` /
  `durationMs` 的记录。没有这些，「开了六小时什么都没传」和「开了并搬了
  2 GB」在控制台上完全一样。
- **非 TLS 的 CONNECT 立刻中继。** ClientHello 分类器区分「根本不是 TLS」与
  「TLS 但还没收全」，因此 SSH/IMAPS 隧道不再被缓冲到 32 KiB 才动。
- **不做应用层空闲超时，改用内核探针。** 隧道可能承载合法保持安静的协议
  （IMAP IDLE 会安静约 29 分钟），因此任何「空闲 N 分钟就关」的默认值都是
  一颗等着第一个 IMAP 客户端引爆的回归。真正需要回收的是**没有 FIN/RST 就
  消失**的对端——那条永远占着两个描述符的半死 SSE。因此 `splice` 在两侧
  socket 上都开 TCP keepalive（`FORWARD_PROXY_KEEPALIVE_MS`，60 秒），h1/h2
  源站腿同理；操作系统默认空闲是两小时，比这个泄漏活得还久。活着但安静的
  连接永远不会被碰：只有探针得不到应答时 keepalive 才会失败它。

### 3. WebSocket：字节级原样中继，帧级观测

升级中继把客户端握手与帧原样转发——被声明主机上的厂商**语义**属于客户端网关
插件（ADR-0017），不属于核心代理。核心仍然观测：`ws-frames.ts` 是一个流式帧
计数器（消息数、文本/二进制、ping/pong、close code、负载字节），不缓冲消息、
不改写字节，遇到声明了荒谬长度的流会停止而不是分配内存。计数写进升级记录的
note 里。

**两个 WebSocket 面被运行时堵死，均在 Bun 1.3.14 上实测：**

- **明文代理端口上的 `ws://`。** `'upgrade'` 事件拿到的是一个写入被吞掉的
  socket（`write()` 返回 true、`bytesWritten` 始终为 0、客户端什么都收不到），
  而把已接受的 socket 通过 `emit('connection')` 交给 `http.Server` 同样不被支持，
  因此也没有「前置门」的绕法。经 CONNECT 的 `wss://`——也是终结 TLS 的代理唯一
  能拦截的形式——完整支持。
- **h2 腿上的 RFC 8441（`CONNECT :protocol=websocket`）。** `'stream'` 监听器
  返回时若尚未应答，Bun 会立刻回 405，而正确答案无法同步产生（必须中继源站的
  `sec-websocket-accept`）。合规客户端根本不会尝试：Bun 的 h2 服务端不会通告
  `SETTINGS_ENABLE_CONNECT_PROTOCOL`，而这正是 Chrome（以及所有合规客户端）使用
  该扩展前检查的门。这些客户端会回落到 h1 WebSocket，而那条路完整支持。

### 4. `Upgrade:` 继承 CONNECT 的端口

升级请求头里带的也是不带端口的 `Host`，因此遵循与 ADR-0018 §3a 相同的优先级：
`Host` 显式端口 > CONNECT 端口 > 443。默认 443 会把非 443 源站的升级请求发到
错误端口——和请求腿早已修掉的是同一类静默错误目标。

## 后果

- h1/h2/upgrade 三条腿在保真上不会再各说各话：要么重新发起客户端协议，要么
  给出有名有姓的错误。
- 隧道变成可回答的问题（哪个主机、什么协议、传了多少、开了多久），且一个字节
  都不用解密——这是 mitmproxy 没有的能力，因为它要么拦截要么什么都看不到。
- WebSocket 流量获得帧级可见性，而代理从不编辑任何一帧。
- 两个运行时缺口连同验证方式一起记录在案，下一位读者不必重新论证。

## 非目标

- **通用 TCP 拦截**（mitmproxy 的 `tcp` 模式）：协议识别加帧编辑器，且没有
  任何 HTTP 语义可路由、可计量、可计费。产品是网关，不是字节级调试器。
- **HTTP/3 / QUIC MITM。** 走显式 HTTP 代理的客户端根本不使用 h3，而
  CONNECT-UDP/MASQUE 是另一套传输面。
- **明文代理端口上的 h2c** 与 **PUSH_PROMISE 转发**。本产品的流量里都没有真实
  客户端，而两者都会引入一条带自己故障模式的第二传输路径。
- **WebSocket 帧编辑**（改写负载、注入帧）。那是插件能力（ADR-0017）；核心只观测。
- **h1 响应 trailer。** Bun 的 `res.addTrailers` 在线上是空操作（实测：chunked
  终止段不含 trailer 部分），因此 h1 客户端收不到上游 trailer。h2 腿——gRPC
  真正所在的地方——是携带的。
- **应用层空闲超时**（「安静 N 分钟后关闭连接」）。不做逐面默认值就无法正确：
  30 秒对 HTTP 腿合适、对 WebSocket 不合适、对 IMAP IDLE 是致命的，而逐面默认
  值本身就是一层策略面。描述符上限由 `maxConnections` 承担；半死对端由
  keepalive 回收（§2）。

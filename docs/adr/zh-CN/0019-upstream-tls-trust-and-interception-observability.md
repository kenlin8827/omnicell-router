# ADR-0019：上游 TLS 信任与拦截可观测性

日期：2026-12
状态：已接受
治理对象：`backend/src/forward-proxy/upstream-tls.ts`（解析器）、
`backend/src/forward-proxy/egress.ts`（`describeUpstreamFailure`）、
`backend/src/forward-proxy/server.ts`（源站各腿与 terminator 生命周期）、
`backend/src/forward-proxy/h2-forward.ts`（h2 腿 + 会话池）、
`backend/src/config/index.ts`（`normalizeUpstreamTlsConfig`）、
`backend/src/config/types.ts`（`ForwardProxyConfig.upstreamTls`）。

## 背景

前向代理是 MITM：它终结客户端的 TLS，再自己向源站发起 TLS。由此产生两个此前
未处理的问题。

1. **源站腿是代理自己的信任决策。** MITM 必须校验源站真实证书（否则它干脆
   关掉校验即可）。但此前只能用系统信任库，于是私有 CA 签发的源站——企业
   TLS 检查链、内部服务、测试机——经由代理完全不可达，既不能指定 CA，也没有
   「我知道，接受它」的开关。
2. **所有失败长得一模一样。** TLS 信任失败、DNS 失败、端口拒绝统统输出
   `502 Forward proxy: upstream connection failed`。唯一能定位原因的字段
   （`err.code`）在消息和台账里都被丢掉了。而客户端拒绝**我们**签发的证书
   （证书固定/pinning）根本不会进台账——它在握手内就中止了，请求从未发生。

## 决策

### 1. `forwardProxy.upstreamTls` 是信任面

```yaml
forwardProxy:
  upstreamTls:
    caFile: /etc/corp/root-ca.pem   # 追加到系统信任库
    insecure: false                 # 应急开关，默认 false
```

- `caFile` 是**追加**到系统信任库，绝不替换：运维声明缺什么，而不是接管信任。
- `insecure` 完全关闭校验，默认关闭。开启期间启动日志告警 + 控制台横幅——
  持续性风险不能只活在 YAML 注释里。
- `caFile` 缺失或不可读只按路径告警一次并回退到系统信任库，**绝不**静默关闭
  校验：失败即失败，且要吵。
- 热生效。每次源站腿都从实时配置解析，证书包按短 TTL 重新 stat，因此轮换文件
  会被发现。h2 会话池的 key 含信任签名，旧策略下的会话不会被复用。

### 2. 失败要分类，不要合并

`describeUpstreamFailure(err, { proxied, timedOut })` 是每条源站腿（h1 直连、
h1 经上游代理、h2 中继、Upgrade 中继）唯一的分类器，返回
`{ status, message, note }`：

- TLS 信任类错误码（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`、`CERT_HAS_EXPIRED`、
  `ERR_TLS_CERT_ALTNAME_INVALID` 等）→ 502，明确说是信任失败并指向
  `forwardProxy.upstreamTls.caFile`；
- DNS 类错误码 → 502，说明主机无法解析；
- 其余 → 502 并带上错误码；
- 代理自己的挂起保护 → 504。

同一句话写进台账 note（`upstream tls: <code>` / `upstream dns: <code>` /
`upstream connect: <code>` / `upstream timeout`），于是「这台主机为什么不通」
在控制台上就能回答，不必抓包。

### 3. 被拒绝的证书也是一条观测

客户端拒绝被拦截的证书（pinning，或信任库没有我们的 CA）是 MITM 代理的头号
支持问题。现在它会落一行 `connect` 台账。

这个信号需要自己造，因为 Bun 不提供现成的：客户端拒绝证书时
`tlsClientError` **不会**触发（Bun 1.3.14 实测——服务端只看到
`secureConnection` 之后一个裸的 socket 关闭）。可靠信号是「TLS 会话关闭时
一个解密字节都没收到」，在解密流上捕获。两条路径共享同一个 terminator 级
去重窗口：被 pin 的客户端会疯狂重连，否则会把真实记录全部挤出环形缓冲。

### 4. 驱逐要排空，不要直接杀

Terminator 有 LRU 上限（全量抓包会见到客户端访问的每个主机）。旧实现驱逐时
立刻关闭监听，于是已经解析到该 terminator 端口、但还没完成 dial 的 CONNECT
会撞上 `ECONNREFUSED`，静默降级为盲隧道——这次交换就此失去拦截，只留一行日志。

被驱逐的 terminator 现在进入 DRAINING 集合（有上限，30 秒）：仍然接受已经
在途的那条连接，但不会被**新的** CONNECT 复用，也不会超出宽限窗口。
`close()` 会连同排空集合一起清理。

### 5. 错误信封对连接是终态

在 Bun 上单靠 `Connection: close` 关不掉 MITM 内层连接（实测：完整 502 之后
客户端的 TLS 会话仍然开着，所有非流式客户端因此挂死），而内层服务器的
`res.socket.end()` 对这条 loopback 对是惰性的。因此 terminator 携带一个
`abort()` 钩子，错误应答在信封真正交出去之后再关闭客户端传输（内层服务器发出
的下一个 chunk 就是那个信封，所以时机是精确的——立刻 `end()` 会把响应截断）。

## 后果

- 私有 CA 的源站通过指定 CA 变得可达，`insecure` 成为有文档、且高调告警的
  应急开关，而不是一个说不出口的愿望。
- 每条源站失败在客户端应答和台账里都能自我解释。
- 被 pin 的客户端从「玄学」变成可见记录。
- terminator 驱逐不再会静默降低拦截能力。
- `ForwardProxyDeps.upstreamTls`（测试注入点）现在按字段**合并**到实时选项之上，
  于是测试可以注入 `lookup`，同时仍然走真实的 `caFile` / `insecure` 解析。

## 非目标

- **替换系统信任库。** `caFile` 是追加；想要封闭信任集的运维可以指向自己的
  证书包，但要接受系统根证书仍然有效（按安装覆盖信任是另一个特性）。
- **按主机或按规则的 TLS 策略。** 信任是进程级的单一决策，和上游代理 URL 一样。
  按主机的 `insecure` 是一份清单而不是一条策略，而规则表已经承载两个维度
  （ADR-0018）。
- **向源站出示客户端证书（mTLS）。** 作为独立能力跟踪：它需要一个凭据面
  （证书放哪、谁轮换），而不是一个布尔开关。
- **把 `tlsClientError` 当作 pinning 信号。** 它在 Bun 上不是；解密流信号才是
  权威。

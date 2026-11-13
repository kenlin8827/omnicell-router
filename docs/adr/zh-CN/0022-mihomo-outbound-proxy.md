# ADR-0022: 出站代理——手动 URL 或托管的 Mihomo 核心

日期: 2026-11-13
状态: 已接受
约束: `backend/src/config/types.ts`（`ProxyConfig`）、`backend/src/utils/proxy.ts`、
`backend/src/utils/proxy-node.ts`、`backend/src/proxy/mihomo-*.ts`、
`backend/src/routes/mihomo.ts`、`frontend/src/pages/ProxyPage.tsx`。

## 背景

出站代理原来只有一个 URL（`proxy.url`）加上按 provider/model 的包含与排除列表。已经在用订阅客户端（Clash Meta / mihomo）的操作者只能手工把 `proxy.url` 指过去，控制台也不能切换节点。另外，`proxiedFetch` 把 `{ proxy }` 传给 `fetch`。这个选项在 Bun 上生效，在 Node 的 fetch 上被忽略，所以用 `node` 启动的网关会静默直连。

ADR-0018 的前向代理出口仍然只回答「走不走出站代理」，也仍然不看 `proxy.includes` / `proxy.excludes`。本记录只改变「出站代理」指的是哪个端点。

## 决策

### 1. `proxy.mode` 选择端点；默认是 `manual`

- `manual`（默认；`mode` 缺失或无法识别时也是它）——端点是 `proxy.url`，与从前完全一致。
- `mihomo`——端点是 `http://127.0.0.1:<proxy.mihomo.mixedPort>`（混合端口默认 7890）。此时忽略 `proxy.url`。

两种模式都按原来的顺序应用 `includes`、`excludes` 和 loopback 绕过。loopback 包含 External Controller，所以控制器调用不会再被送回混合端口。`outboundProxyUrl()`（前向代理出口，ADR-0018）使用同一个端点，仍然不看包含/排除列表。

`proxy.enabled` 仍是总开关。sidecar 只在 `enabled` 为真且 `mode` 为 `mihomo` 时运行。

### 2. Sidecar 是生成的配置加一个本机控制器

网关把 mihomo 配置写到 `<env>/mihomo/`（`mixed-port`、`external-controller: 127.0.0.1:<controllerPort>`、`secret`、每个启用订阅一个 `proxy-provider`、一个 `select` 组、`MATCH` 到该组）。控制器已经健康就接管，否则执行 `mihomo -d <dir> -f <config>`。pid 文件和 `owner` 标记（`spawned` / `adopted`）记录是谁启动的。显式停止会结束本机监听。离开 mihomo 模式时，只停止本网关自己拉起的进程。

二进制查找顺序是 `proxy.mihomo.binaryPath`，然后 `<ocrHome>/bin/mihomo`，然后 `PATH`。从 MetaCubeX/mihomo 的 GitHub release 下载是显式的管理操作，绝不是启动副作用。`selectedNodes` 在启动后通过控制器恢复。

### 3. 密钥不进日志，归档默认脱敏

控制器密钥在为空时于首次启动生成，并经 `saveConfig` 写回。订阅 URL 可能内嵌令牌。两者都不写入日志。环境归档脱敏 `proxy.mihomo.controllerSecret` 和每条订阅的 `url`（扁平形状与 `upstream.proxy.mihomo.*` 都覆盖）。已登录的控制台仍然拿到 URL，因为操作者要在那里编辑。状态接口只报告 `secretConfigured`，不返回密钥本身。

### 4. Node 的 fetch 自己打开代理

在 Bun 上，`proxiedFetch` 继续使用 `fetch(url, { proxy })`。在 Node 上，HTTP 用绝对形式请求，HTTPS 用 `openViaProxy`（CONNECT）再在隧道上的 TLS 套接字上发送 HTTP/1.1。响应体是 web stream。重定向继续走代理，除非下一跳是 loopback。

### 5. 不提升 schemaVersion

新字段位于既有的 `upstream.proxy` 段内。缺失字段由 `loadConfig` 填默认值。这是值清洗，不是磁盘形状迁移（ADR-0016）。`schemaVersion` 保持 1。没有 `mode` 的文件维持 `manual`。

## 后果

- 既有配置的代理行为不变。
- `egress: proxy` 的前向代理行使用同一个端点，因此 mihomo 模式也覆盖中转流量，不需要第二条 URL。
- 管理面是 `/api/admin/proxy/mihomo/*`，以及代理页的三个标签（基本设置、订阅、节点）。

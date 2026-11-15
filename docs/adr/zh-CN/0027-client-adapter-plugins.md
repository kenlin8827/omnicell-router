# ADR-0027 — 客户端适配器即插件：为客户端 hook 开第三种插件类型

- **状态：** 已实现
- **日期：** 2026-11-15
- **关联：** [ADR-0017](./0017-client-gateway-plugins.md)（插件契约）、[ADR-0026](./0026-mitm-canonical-seam.md)（模型流量归网关）、[ADR-0015](./0015-harness-artifacts.md)（roster 排序）

## 背景

Client Hub 的 hook（OpenCode provider 注入、Claude 配置改写、Cursor/Qoder/JetBrains 启动器、OpenCode 代理模式）曾是一张编译期封闭的表：

```ts
const adapters: Record<SupportedClient, ClientAdapter> = { opencode: …, claude: …, … };
```

这带来三个后果，只有第一个是刻意的：

1. **穷尽性。** `Record<SupportedClient, …>` 把“每个客户端 id 恰好一个 hook”变成了类型检查能保证的事实——对本 build 自带的 hook 来说，这确实有用。
2. **加一个客户端要发一次核心版本。** 第三方能不动核心就加出站 provider（model-service）或入站主机（client-gateway），但 Client Hub 这一层——恰恰是厂商差异最重的一层——完全没有扩展点。
3. **自带的 hook 全部强制存在。** 尤其 `opencode-proxy`：它是一个有棱角的细分模式（要求 `forwardProxy` 已启用、要把 MITM CA 写进 opencode 信任库、而 `service set env` 触不到 `--standalone` / `serve` / shell 启动的 CLI）。不用它的人同样背着它的代码、它的控制台行和它的失败模式。

## 决定

### 1. 第三种插件类型：`client-adapter`

一个 `client-adapter` 包提供**一个** Client Hub hook。它的清单里没有 `hosts`、没有 `wires`——那是另外两条轴的词汇：

| 类型 | 拥有什么 | 认领 |
|---|---|---|
| `model-service` | 出站 provider 执行器 | `wires` |
| `client-gateway` | 转发代理上的一个入站厂商主机 | `hosts` |
| `client-adapter` | 一个客户端的 hook 状态 | —（适配器自己的 `name`） |

`createPlugin(host)` 直接返回适配器对象：`{ name, displayName, hookKind, getConfigPath(), getStatus(), setup(), teardown(), …可选 }`。宿主只校验这几样；其余归核心注册表管。

### 2. 宿主 SDK 给事实，不给策略

```ts
interface ClientAdapterHost {
  log(...args: unknown[]): void;
  ocrHome(): string;        // sidecar / 备份文件落在这里
  pluginDir(): string;      // 包唯一的资源根
  config(): Record<string, unknown>;   // 已合并、已校验的运维配置
  forwardProxy(): { url; port; caPath; requireCredential } | null;  // 实时快照
  caCertPath(): string;     // 即使代理关闭也解析得出
}
```

刻意不给：配置写入、密钥查询、`ClientHookStatus` / `ClientActionResult` 词表。插件返回普通对象，核心注册表在边界处赋予类型——包无法通过漂移扩宽契约，这与另外两种类型遵循同一条规则。

`forwardProxy()` 读的是**运行时**快照（只有在服务端快照尚未绑定时才回落到一次配置读取，例如独立 CLI），但服务器运行后绝不读过期配置：热重载会挪端口，而一个宣称了“运行中的代理并不监听”的端口，会让客户端每一轮都 401。

### 3. 核心优先、插件其次、冲突直接拒

两张表，一个查找顺序：

- `cli/clients/core-adapters.ts` —— 本 build 自带的 hook，导出 `CORE_ADAPTERS`，类型为 `Record<CoreClientId, …>`，使映射表与保留 id 清单无法漂移。id 清单本身（`CORE_ADAPTER_IDS`、`CoreClientId`、`RETIRED_CLIENT_IDS`）放在 `cli/clients/reserved.ts` —— 一个**叶子**模块：插件注册表由此能在不 import 适配器类的情况下读到保留 id；那些类会带上配置加载器、user-config 与凭据存储，这条模块依赖边否则会延伸到每一个调用插件宿主的调用方。
- `cli/clients/plugin-adapters.ts` —— 插件贡献的 hook，与插件宿主在**同一个事务**里重建：注册先写入 staging 映射，集合在提交点整体交换，因此中途失败的重建会保留上一套 hook，而不是让 Client Hub 变空。

`getClientAdapter(name)` 先问核心。注册时遇到核心 id（`a plugin cannot replace a built-in hook`）或第二个包抢已占用的 id（`already provided by plugin 'X'`）会**抛错**——两者都以该包自己的加载错误出现在控制台，绝不会变成“行为取决于安装顺序”的行。

`getAllClientAdapters()` 把插件行排在自带行**之后**，安装一个包不会打乱 roster 顺序。

### 4. `opencode-proxy` 离开核心

> **已被 [ADR-0028](./0028-multi-part-plugins.md) 取代：** 包现在是 `plugins/opencode-gateway/`，客户端 id 也随之迁移（`opencode-gateway`，同一 `service-env` 类型，sidecar 为 `opencode-gateway.env-meta.json`）——因为这一半与它的网关半边同属一个多 part 包。

OpenCode 代理模式 hook 离开核心时是 `plugins/opencode-proxy/`（366 行核心代码 → 一个只依赖 SDK 的包）。它是这条接缝的第一个真实用户，也是这个类型存在的理由：不是给所有人用的 hook，应该可安装，而不是强制存在。

那一步没有变的：`service-env` hook 类型，以及 CLI 动词、控制台标签与 i18n 键继续工作。随后 `opencode-proxy` 成为**退役** id：该半与它的网关半边合并为 `plugins/opencode-gateway/`（ADR-0028）时，客户端 id 与 sidecar 随之迁移（`opencode-gateway`、`<ocrHome>/opencode-gateway.env-meta.json`），注册现在**拒绝**旧 id（ADR-0029 §3），而不是为同一个客户端开出第二行。

## 后果

- **`ClientAdapter` 的 id 不再是编译期穷尽的。** 自带表类型为 `Record<CoreClientId, …>`，键来自 `cli/clients/reserved.ts` 的保留 id 清单；`SupportedClient` 则为控制台与 CLI 能**寻址**的 id（自带 hook 加上文档化的包 hook）提供类型。不在联合里的插件 id 在边界处仍按 `SupportedClient` 处理（适配器对象结构化转换）——所以那个联合是**标签/CLI** 词表，不是运行时白名单。把它做成运行时白名单等于重新关掉扩展点。
- **控制台 roster 变成安装相关的。** `client-adapter` 行只在其包被加载且启用时出现。插件页用独立标签渲染第三种类型（`pluginPage.typeClientAdapter`，八种语言齐备）。
- **这一步时包还没有随桌面端分发。**（已被 ADR-0029 §1 取代：应用现在每次宿主重建时从 `.plugin-dist` 播种 `<ocrHome>/plugins/bundled`。）`tauri.conf.json` 的 resources 只有 `frontend/dist` + 后端二进制，没有任何步骤往应用自有层播种。因此把一个 hook 移出核心，意味着运维必须自己装包（或用 dev 树）。对 `opencode-proxy` 这种需要主动选择的细分模式可以接受，这也是**没有任何默认 hook 被移走**的原因。把插件包纳入随包分发是移走默认 hook 的前提，那是打包任务，不是插件契约变更。
- **CLI 懒加载插件。** `setupClient` / `teardownClient` / `getAllClientStatuses` 会 await `ensurePluginClientAdapters()`——在本进程还没跑过插件宿主时（`isPluginHostInitialized()`）跑一次，所以从不启动服务端的独立 CLI 里 `ocr setup opencode-gateway` 依然可用。**核心命令**绝不预加载宿主：只有非 OCR 命令（启动动词候选）或 `help` 会加载，因此 `ocr shims-status` 这类纯 JSON 命令不会被插件启动输出污染。
- **坏包拖不垮 Client Hub。** 懒加载吞掉失败，自带表不受影响；在 `createPlugin` 阶段抛错的包只会变成插件页上的一行失败记录，什么都不贡献。

## 此处未决定

**`opencode-gateway`**——一个 Cursor 风格的、认领 opencode 厂商主机的 client-gateway 插件——最初被当作这个 hook 的**替代品**考虑，并按那个理解被否决。Cursor 需要网关，是因为它说私有 Connect/protobuf 协议、有自己的目录 RPC；opencode 说的是标准协议，模型选择器来自 `models.dev` 加它自己的 `providers` 节点，而不是厂商的 `/v1/models`。所以"在 opencode 里看到预设模型"是**出站**问题，由 provider 注入解决（`clients/opencode.ts`），认领 `api.anthropic.com` 对此毫无增益。

那个否决对"替代"是对的，对"范围"是错的：**配置接入与代理模式是两个不同的产品。** 配置接入注入一个 OCR provider，完全不碰代理；代理模式不碰客户端的 provider、模型和 key，转而接管经 forwardProxy 出去的流量——这件事标准行做的是通用处理，而这个包做的是 OpenCode 自己的策略（目录里没有的引用落到目标模型、强制模型、绑定计量 key）。所以网关存在（`plugins/opencode-gateway/`），这个 hook 也留下：它是代理模式的入口，见下文 §5。


### 5. 代理模式是一个包、两个 part

OpenCode 代理模式两个半边都要：`client-adapter`（入口：让客户端的流量进入 forwardProxy，写服务环境变量 + MITM CA）与 `client-gateway`（认领模型 host，接管这些 host 上的模型请求）。本 ADR 的早期修订把它们拆成两个包——`opencode-proxy` 与 `opencode-gateway`——理由是两条轴互相独立。轴确实独立，但这两个半边不独立：没有入口，网关看不到任何流量；没有网关，入口只换来内置行的通用处理。拆成两个包的实际后果是：操作者要先装一个本身不干活的半边，另一个半边才成立。

现在它们是一个包 `plugins/opencode-gateway/`，声明 `parts: [client-adapter, client-gateway]`（ADR-0028）。轴的定义一点没变：`client-adapter` 仍然没有认领能力，`client-gateway` 仍然没有 setup/teardown 生命周期。变的是**打包单位**——一个 manifest 可以占多条轴，宿主只调一次 `createPlugin`，两个半边共享同一个闭包和同一份配置 artifact。

一个包还让安装/卸载保持原子：Client Hub 的行与认领同时出现、同时消失。对于一个"半边单独存在就没有意义"的产品，这是唯一诚实的状态。

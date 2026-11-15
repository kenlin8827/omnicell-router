# ADR-0030 —— 客户端钩子随其网关一起发布

- **状态：** 已实现
- **日期：** 2026-11-15
- **关联：** [ADR-0017](./0017-client-gateway-plugins.md)（网关插件）、[ADR-0027](./0027-client-adapter-plugins.md)（client-adapter 包）、[ADR-0028](./0028-multi-part-plugins.md)（多 part 包）、[ADR-0029](./0029-package-lifecycle.md)（包生命周期）

## 背景

Client Hub 里四行代理接入 —— Cursor、Qoder、JetBrains IDEs、OpenCode（代理模式）—— 来自两个不同的地方：

- `opencode-gateway` 是**一个**多 part 包：入口钩子与网关同装同卸。
- Cursor、Qoder、JetBrains 是**核心适配器**（`cursor-proxy.ts`、`qoder-proxy.ts`、`jetbrains-proxy.ts` + `jetbrains-junie.ts`，约 3.4k 行），而它们的网关是包（`cursor-gateway`、`qoder-gateway`、`jetbrains-gateway`）。

这不是设计决策，是迁移做了一半。它制造了一整类只因「拆分」而存在的缺陷与硬编码：

1. **一行点了也没用的卡片。** `cursor-proxy` 的钩子写启动器把 Cursor 指向 forward proxy，但没有 `cursor-gateway` 就没人应答那些 host。操作者可以钩上一个最终只是透明转发的客户端 —— 于是控制台出现了 `GATEWAY_PLUGIN_BY_CLIENT` 表来禁用 setup 按钮，又出现 `LAUNCH_COMMANDS` 表来知道 `ocr cursor` 这个动词。
2. **核心里的客户端知识，核心自己用不上。** `ocr cursor` / `ocr cursor-agent` / `ocr qoder` / `ocr qoder-cli` 是写死的 `CliAction` 成员，直接 import 客户端模块分发；帮助文本逐行手写。
3. **包无法拥有的生命周期。** 卸载 `cursor-gateway` 后 `cursor-proxy` 那行仍在、仍是已接管、仍然无用；两半各有各的升级路径。
4. **`SupportedClient` 两头都不实在。** 它自称「本构建随包发布的钩子 id」，却列出了网关在包里的 id。

机制（一个包多条轴）ADR-0028 已经给了。缺的全在**宿主**侧：启动器钩子需要的那些事实，适配器 SDK 没有暴露。

## 决策

### 1. 代理接入家族按产品各一个包

`cursor-gateway`、`qoder-gateway`、`jetbrains-gateway` 现在是多 part 包：`parts: [client-adapter, client-gateway]`，一次 `createPlugin(host)` 返回 `{ gateway, clientAdapter }`（ADR-0028）。适配器离开核心（`cursor-proxy.ts`、`qoder-proxy.ts`、`jetbrains-proxy.ts`、`jetbrains-junie.ts` 删除）；`CORE_ADAPTERS` 里不再有任何代理接入钩子。

**客户端 id 不变**（`cursor-proxy`、`qoder-proxy`、`jetbrains-proxy`）：它们是操作者手输的公开钩子 id（`ocr setup cursor-proxy`）、sidecar 文件名，以及已接管机器上的启动器文件名。包 id 与钩子 id 刻意不同 —— 包是「Cursor 支持」，钩子是「Cursor 启动器」—— 而控制台已不再需要它们相等（见 §3）。

### 2. 宿主 SDK 补齐了启动器/代理钩子真正需要的事实

`ClientAdapterHost` 新增五个接缝，每一个都是「只有宿主知道的事实」，每一个都替换掉一个适配器原先 import 的核心模块：

| 接缝 | 替换 | 包为何无法自行推导 |
| --- | --- | --- |
| `forwardProxyStatus()` | `forward-proxy/status.ts` | 监听中的代理是运行态，不是配置（`forwardProxy()` 报告的端点在没有进程监听时依然可读） |
| `caTrust(caPath?, {force})` | `forward-proxy/ca-trust.ts` | 探测要调用系统信任工具，且全进程 TTL 缓存；`force` 正是 setup 后提示所需要的 |
| `caCommonName()` | `forward-proxy/ca.ts` 的 `CA_CN` | 信任库别名校验必须匹配本安装签发的 CA；包里写常量必然漂移 |
| `probeVersion(cmd)` | `base.ts` 的 `probeClientVersion` | 10 分钟进程级缓存：每次状态轮询都起一个 CLI 子进程正是它要防的 |
| `gatewayBaseUrl(apiKey?)` | `base.ts` 的 `resolveGatewayBaseUrl` | 候选端口要用**带鉴权**的 `GET /v1/models` 探测；写进客户端一个过期端口 = 每轮 401 |

JetBrains 还要把一个 key 写进 Junie 的模型列表，所以宿主暴露的是 key **存储**（`apiKeys()`、`createApiKey()`），而不是让包自己实现 key 存在哪。**选择策略**留在钩子里（「优先名为 `JetBrains` 的、否则任一可用、否则新建」）—— 宿主只拥有存储。

这条守住了稳态规则：**钩子自身的知识（安装位置、脚本文本、IDE 手术、sidecar 策略）在包里；任何描述「这个安装运行成什么样」的事实来自宿主。** 包不 import 后端运行时模块。（`plugins/jetbrains-gateway/exec.ts` 是本地 `runCommand` 孪生，正是为此 —— ADR-0017 §6：打包插件是单个 bundle，旁边没有 `src/`。）

### 3. 钩子**声明**命令面，核心只负责渲染

`ClientAdapter` 增加若干可选声明成员，注册表把派生字段盖进 `ClientHookStatus`：

```ts
interface ClientAdapter {
  /** 直通动词（`ocr cursor`、`ocr cursor-agent`）。 */
  launchVerbs?(): ClientLaunchVerb[];   // { verb, script, detached, summary?, missingHint? }
  /** 拥有该客户端**模型面**的包 id（网关目录）。 */
  catalogPlugin?: string;
  /** 品牌资源键（`assets/brands/<icon>.svg`）；缺省＝客户端 id。 */
  icon?: string;
  /** 上下文已隐含变体时的裸产品名。 */
  shortName?: string;
}

interface ClientHookStatus {
  pluginId?: string;        // 哪一行由哪个包提供（缺省＝内置）
  catalogPlugin?: string;   // 哪个包拥有其模型面
  launch?: string[];        // 动词，按声明顺序
  icon?: string;
  shortName?: string;
}
```

`ClientProductStatus` 同样增加 `icon?: string`：JetBrains 产品的 id（`intellij-idea`）与它的标记文件名（`idea`）不同，而这个事实属于**定义该产品的包**，不属于控制台的三元表达式。

由此产生的全是删除：

- `CliAction` 去掉四个启动动词；`main()` 在 OCR 自己的参数解析之前用 `findLaunchVerb()`（注册表：核心 + 所有已加载包）解析第一个 token。新包新增 `ocr <动词>`，核心零改动。
- `printHelp()` 的客户端段落改为**生成**（每个适配器一行 `ocr setup <id>` / `ocr teardown <id>` / `ocr <动词>`）。手写块删除。
- `ClientsPage` 去掉 `GATEWAY_PLUGIN_BY_CLIENT`、`CLIENT_BY_GATEWAY_PLUGIN`、`LAUNCH_COMMANDS`。目录编辑器读 `c.catalogPlugin`，插件门控读 `c.catalogPlugin`，可复制的启动命令读 `c.launch`。
- 控制台最后一张「客户端→logo」表也没了：`BrandIcon` 读 `c.icon ?? c.name`（产品行读 `p.icon ?? p.id`），`c.shortName ?? c.displayName` 取代了按 id 判断的两个三元表达式；`clients.nameOpencode` / `clients.nameOpencodeProxy` 两个 i18n 键随之删除（八种语言）。
- `jetbrains-gateway` 不再需要「没有目录」的特例：它只是不声明 `catalogPlugin`。

### 4. 注册顺序继续保证「失败的包不能拦截流量」

ADR-0029 的规则不变，且对每个代理接入包都成为关键路径：适配器那一半**先**注册（它是会抛错的那半），网关先 stage、只对已装载 id 提交（`retainStagedGateways`）。适配器失败的包是一行红色控制台记录 —— 绝不会是一个背后没有网关的钩子。

## 影响

- **卸载就是卸载。** 移除 `cursor-gateway` 会连启动器那一行一起消失；不再有孤儿钩子，也不再需要控制台表来维持配对。
- **`ocr setup cursor-proxy` 照旧可用**，而且帮助文本现在这么说是因为包这么说。
- **构建要求：** 必须重新生成 `.plugin-dist`（`bun run plugins:build`）—— 旧 zip 播种出的包只声明 `client-gateway`，对打包安装而言 Client Hub 那一行就直接不存在（dev 树通过 `OCR_PLUGIN_SRC_DIR` 直接读 `plugins/`）。
- **写配置型钩子仍留在核心。** `opencode`、`claude`、`codex`、`pi`、`dsh`、`omp`、`grok`、`kimi`、`openclaw`、`workbuddy` 改写客户端自身配置（模型槽、key 策略、profile 链接）。抽走它们需要 ADR-0027 刻意没有暴露的配置改写接缝（`catalogPlugin`/`launchVerbs` 覆盖不到）；那是下一个家族，不是本次的遗留。
- **i18n 仍按客户端 id 取几个字符串**（`clients.cursorHint`、`clients.*SetupOk`）。那些是本地化**文案**，不是客户端名册：没有译文的包回落到共享的代理文案。把它们搬进 manifest 等于把 UI 文案写进协议 —— 那是另一个决策。

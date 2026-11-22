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
4. **`SupportedClient` 两头都不实在。** 它自称「本构建内存在的钩子 id」，却列出了网关在包里的 id。

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

### 5. Agent 安装也是钩子的职责，连传输层一起

一个代理钩子如果最终指向机器装不上的 agent，那就是「一行钩不平」的记录（ADR-0027 §1 的精神）。所以 `jetbrains-gateway` 自己安装 Junie：从 IDE 自己的 ACP registry 取版本，下载、校验、解压到 `acp-agents/<agent>/<version>/`，再把归档 seed 进 `.downloads`，让 `AcpBinaryManager` 直接 promote 而不是重新下。

传输层属于这个决策的一部分，不是它下面的实现细节。那个产物是 GitHub release 重定向后的 215 MB，而促成这一节的事故是**实测**而非假设：单流在受限链路上跑 24 KB/s 且无续传（2.5 小时，旧的 30 分钟上限让首次安装根本不可能完成），而六分片跨镜像可达 ~860 KB/s —— 4 分钟，且与 release API 的 `sha256` 摘要逐字节一致。所以 `downloadFile` 先用带 Range 的请求探测，把归档切成 4 MiB 片，按 `<dest>.part` 的偏移续传、并把来源写进 `<dest>.part.json`（URL / 模式 / sha256，于是**另一个**资产的残片会被丢弃而不是拼接），每次尝试轮换镜像，并上报进度。

三条规则保证它不会变成宿主的策略：

| 规则 | 理由 |
| --- | --- |
| 镜像与本地包属于**运营者**配置（`downloadMirrors`、`junieArchivePath`、`downloadConcurrency`），绝不是包内常量 | 镜像是区域网络的变通；写死一个等于把第三方主机发给所有运营者 |
| 下载留在 `setup()` 内部 —— 不新增控制台动词 | 线上词汇只有 `setup`/`teardown`（钩子的两个状态转换），而 `ClientHookStatus` 已经通过通用的 `agent` 字段（名称 + 版本，由 hook 提供）表达中间态（「代理好了、agent 缺」）。第三个按钮会造出第三种生命周期状态，而它的 teardown 语义没人定义过 |
| 校验尽力而为，但永不缺席 | ACP registry 不为 Junie 发布 hash，所以能连上时取 GitHub release API 的摘要，否则用声明大小 + zip 结构。不匹配就删；只是截断就留（那**就是**续传状态） |

对控制台的后果：坏链路上 setup 仍可能要几分钟，所以适配器每 32 MB 经宿主 logger 打一行进度（`N/M MB (K KB/s via <端点>)`）—— 运营者不必靠新按钮就能区分「在下」与「卡死」。

### 6. 接管同时拥有 Air agent 目录；IDE 区域是可选项

Air in IDEs 的 Manage Agents 目录来自一个 JetBrains 签名的 registry 包，URL 跟着 IDE 的
**区域**走，而两边的包内容并不一致：中国区包 8 个 agent，国际包 45 个。只留下按区域选出的包，
等于钩子发了代理却悄悄藏起大多数 agent —— 所以 `setup` 会把 Air 插件自己声明的 Registry 键
（`air.acp.registry.url`，指向 `resources.jetbrains.com/agentclientprotocol/registry.zip`）
写进每个已接管 IDE 的 `<config>/options/ide.general.xml`：备份一次、拆卸还原、运营者自己设的
值绝不覆盖。

IDE 的**区域**本身（`Settings → Language and Region`）是另一回事：它是机器全局的（整台机器上
所有 JetBrains IDE 共享一个 JDK Preferences 值），且决定账号、市场与 AI 端点 ——
「JetBrains AI is not available in your region」的判定读的就是 `Region.CHINA`，别无其它。
所以翻动它是**可选**的（`airRegionUnrestrict`，默认关；目标 `airRegionTarget`），首次使用前
备份，并且只在**没有任何**产品处于接管状态时才还原 —— 与全局 Junie 模型列表同一条门槛规则。
与 §5 相同的生命周期规则：两者都落在 `setup()`/`teardown()` 内，不新增控制台动词。

### 7. 探测到客户端正在运行是「征求同意」的停顿，不是静默写入

IDE 把设置留在内存里，退出时会重写自己的配置文件：所以「它开着的时候接管」可能被它自己还原，
「它开着的时候拆除」也可能被写回来 —— 控制台显示「未接管」，客户端却仍在走代理。这两种都不是
操作者看得见的报错，因此**确定**探测到运行时就直接停下：`setup`/`teardown` 返回
`success: false`，`reasonCode: 'ide_running'`，把探测到的客户端名字放进 `params.products`；
只有调用方带上 `acknowledgeRunning: true` 重发（控制台：一个解释「退出时会重写」的确认框；
CLI：`--force`）才继续。探针是**失败即放行**的 —— `tasklist`/`pgrep` 可能卡死（某台机器上的
`tasklist` 根本不返回，这也是 `runCommand` 现在自己持有硬超时的原因），而不可靠的探针绝不能把
操作者锁在一个本来能用的钩子外面。所以这道门槛要的是同意，不是能力判定。

## 影响

- **卸载就是卸载。** 移除 `cursor-gateway` 会连启动器那一行一起消失；不再有孤儿钩子，也不再需要控制台表来维持配对。
- **`ocr setup cursor-proxy` 照旧可用**，而且帮助文本现在这么说是因为包这么说。
- **构建/安装要求：** 包仍由 `bun run plugins:build` 生成到 `<repo>/.plugin-dist/`，但任何发行物都不分发它们（ADR-0032）—— 运营者从控制台上传该目录里的 zip。手工装上的旧 zip 只声明 `client-gateway`，Client Hub 那一行就直接不存在（dev 树通过 `OCR_PLUGIN_SRC_DIR` 直接读 `plugins/`）。
- **写配置型钩子仍留在核心。** `opencode`、`claude`、`codex`、`pi`、`dsh`、`omp`、`grok`、`kimi`、`openclaw`、`workbuddy` 改写客户端自身配置（模型槽、key 策略、profile 链接）。抽走它们需要 ADR-0027 刻意没有暴露的配置改写接缝（`catalogPlugin`/`launchVerbs` 覆盖不到）；那是下一个家族，不是本次的遗留。
- **i18n 仍按客户端 id 取几个字符串**（`clients.cursorHint`、`clients.*SetupOk`）。那些是本地化**文案**，不是客户端名册：没有译文的包回落到共享的代理文案。把它们搬进 manifest 等于把 UI 文案写进协议 —— 那是另一个决策。
  **修订 2026-11-22：** 上条说的「另一个决策」后来按相反方向做了：各客户端文案不再住核心 i18n。包在自己的 manifest 里声明 `clientText`（setupOk / teardownOk / hint / errors / family，多语言映射）与 `clientRank`（名册排序）——机制与 `warningLabels` 相同（manifest 校验、宿主渲染流程、locale 解析、`{param}` 插值）。核心 i18n 只保留共享回退（`clients.caHint`、告警码）；`clients.cursorHint` / `clients.*SetupOk` / `clients.proxy*` 键随 `SupportedClient` 一起删除。`cursor-gateway`、`opencode-gateway`、`qoder-gateway`、`jetbrains-gateway`、`antigravity-gateway` 现在各自携带文案（见 ADR-0027 修订）。

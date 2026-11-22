# ADR-0028 —— 多 part 包：一个 manifest，多条扩展轴

- **状态：** 已实现
- **日期：** 2026-11-15
- **关联：** [ADR-0017](./0017-client-gateway-plugins.md)（插件契约）、[ADR-0026](./0026-mitm-canonical-seam.md)（网关接管模型流量）、[ADR-0027](./0027-client-adapter-plugins.md)（client-adapter 包）

## 背景

插件的 manifest 只能声明一条扩展轴：

```ts
interface PluginManifest {
  type: 'model-service' | 'client-gateway' | 'client-adapter';
  wires?: string[];
  hosts?: string[];
}
```

宿主读 `manifest.type`，导入一次入口，按该类型校验唯一一种形状。在每个产品恰好只占一条轴的时候，这是对的。

OpenCode 代理模式打破了这个前提。它是一个产品，两个半边，而且分属**不同**两条轴：

- `client-adapter`——入口：把 `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` 写进 OpenCode 的托管服务。没有它，流量根本到不了 forwardProxy（OpenCode 跑在 Bun 上，不读操作系统代理设置）。
- `client-gateway`——认领它要打到的模型 host，并接管这些 host 上的请求。

两个半边单独都没有意义。在"一条轴"的规则下只有三种做法：

1. **拆成两个包。** ADR-0027 §5 最初就是这么做的。它能跑，但操作者必须先装 `opencode-proxy`（没有网关时它什么都不做），再装 `opencode-gateway`（没有入口时它一条请求也看不到）；而且前者的 Client Hub 行指向的是后者拥有的产品。
2. **一个包、假借一种 type。** 做不到：两个半边需要不同的宿主能力面（`forwardProxy`/`caCertPath` 对 `chat`/`relayUpstream`），生命周期调用也不同（注册适配器 vs 暂存网关）。
3. **把一条轴折进另一条。** ADR-0027 §5 已否决，理由现在仍然成立：`client-adapter` 没有认领能力，`client-gateway` 没有 setup/teardown，往任一方向折都会让某个 part 拥有其契约明确说它没有的能力。

轴的清单从来不是**包的种类**分类法，而是独立能力的清单；"一条轴一种能力"并不要求"一个包一条轴"。

## 决定

### 1. `parts` —— 一个包声明它占的每一条轴

```jsonc
{
  "id": "opencode-gateway",
  "apiVersion": 1,
  "parts": [
    { "type": "client-adapter" },
    { "type": "client-gateway", "hosts": ["api.openai.com", "api.anthropic.com"] }
  ]
}
```

`type` / `wires` / `hosts` 作为**单 part** 写法继续有效。两种写法互斥：同时写 `type` 与 `parts` 等于把轴声明了两遍，而第二份正是"单一真相的 manifest"要防的漂移。声明了 `parts` 之后，顶层 `wires`/`hosts` 同样被拒——认领列表属于认领它的那个 part。

每个 part：

| part | 必须有 | 禁止 |
|---|---|---|
| `model-service` | 非空 `wires` | — |
| `client-gateway` | 非空 `hosts` | — |
| `client-adapter` | 无 | `wires`、`hosts`（它贡献的是 hook，不是 wire 或认领） |

每条轴最多一个 part：宿主按包 id 各注册一个网关、一个适配器，第二个只会静默失败。

`normalizePluginParts()` 是两种写法的**唯一**读取者。装载器、控制台行、打包器、类型检查都调它，没有一处再自行判断"type 还是 parts"。

### 2. 一次 `createPlugin` 调用，一个结果对象

多 part 包的入口返回它声明的每一个半边：

```ts
export function createPlugin(host: ClientAdapterHost & ClientGatewayHost): PluginEntryResult {
  return { clientAdapter: createIngressAdapter(host), gateway: createGatewayPlugin(host) };
}
```

宿主只调**一次** `createPlugin`，传入的宿主对象携带各 part 能力面的并集。否决"每个 part 调一次"的理由是：两个半边会变成同一份配置 artifact 上的两个闭包，设置保存之后，入口读到的值和网关读到的值可能不一致。

单 part 包继续直接返回自己的对象（适配器 / 网关 / provider），宿主按形状识别——与改动前完全一致。包也可以显式返回 `PluginEntryResult`。

**声明的每一个 part 都必须存在。** 缺一个就整体装载失败，错误里点名是哪个 part。只注册已经加载的那个半边，会留下一个"看起来装好了"的控制台行，而它被装进来的理由（另半边）在静默地什么都不应答。

### 3. 注册与注销保持原子

装载路径从同一个结果出发：暂存网关、注册适配器、填入 model-service 注册表，并由 `PluginView.types` 报告每一条轴，控制台可以按 part 逐个渲染标签。禁用/卸载本来就走同一次重建（或同一组热拔除调用），所以多 part 包不可能只留下半个自己。

### 4. 这次改动**不**改变什么

- **轴的契约。** `client-adapter` 仍然只拿到事实，`client-gateway` 仍然拥有它的 host，谁也没有获得对方的能力。一个 part 无法从自己的能力面上看出兄弟 part 是否存在。
- **part 间通信。** 没有，也不需要：两个半边共享闭包，是因为它们由同一个函数构造，而不是因为宿主在中间转发消息。需要跨轴协议的包，描述的是新的一条轴，应当另写 ADR。
- **认领顺序。** 多 part 包的网关在 `findGateway` 里的位置与单 part 网关完全相同（精确优先、通配其次、内置行最后）。

## 后果

- **装一个，两个半边都在。** `plugins/opencode-gateway/` 取代 `plugins/opencode-proxy` 与旧的网关包：Client Hub 的行与 host 认领同时出现、同时消失。ADR-0027 §5 已同步改写。
- **新增的是打包能力，不是能力模型。** 单轴包完全不受影响——现有 manifest 全部照旧校验、装载、行为不变（`importPlugin` 里单 part 那条路径就是原来的代码）。
- **控制台多标签列。** `PluginView.types` 是纯增量；`type` 仍是 `types[0]`，所有既有消费者不受影响。
- **打包不变。** 入口仍被 bundle 成一个 `index.js`；包的各个 part 是被内联的源模块。`collectPluginAssets` 本来就排除任意深度的源码。
- **一个值得点明的钝角：** 多 part 包无法在安装时拆分（"只装网关不装入口"）。这是故意的——整件事的前提就是这两个半边不能分开用。将来若出现各 part 确实可独立使用的产品，应当拆成两个包，而不是发明一个部分安装开关。

## 考虑过的替代方案

- **`types: ['client-adapter', 'client-gateway']`**（用数组替代 `type`）。否决：`wires`/`hosts` 在扁平数组里无处安放，只能退回顶层（一份列表、两个可能的属主）或引入平行数组。`parts` 让每条轴的词汇跟着那条轴走。
- **每个 part 各调一次 `createPlugin`。** 同上否决：同一份配置 artifact 上的两个闭包。
- **允许 `client-adapter` 也声明 `hosts`。** 否决：等于让适配器的生命周期拥有一份它回答不了的认领，并复制网关注册表里的通配/排序逻辑。
- **保留两个包，让一个自动安装另一个。** 否决：静默安装第二个包意味着插件宿主需要一张依赖图，卸载还要引用计数。

# ADR-0035 — 所有模型服务插件共用一份 catalog-def 契约

- 状态：已接受（已实现）
- 日期：2026-11-21

## 背景

模型服务插件（`-models` 半边，见 ADR-0017）替网关回答一个问题：*这个厂商模型是什么？* 答案是一份 models.dev 形状的模型 def，写进 `<ocrHome>/providers.json`，网关再拿它做路由、能力徽章、effort 档位和console 目录。过去每个插件各自手写这份 def，各自一个 `xxxCatalogToDef`。

两个插件，两份答案，其中一份是错的：

- `workbuddy-models` 把厂商自己的 effort 表如实映射成 `reasoningOptions`，并且**写下了文档解释为什么无档位的 `toggle` 不安全**。
- `qoder-models` 却给**每一个**思考模型都写 `reasoningOptions: [{type:'toggle'}]`，注释里的理由是「目录不发布档位表，网关绝不能声称一个没有证据的档位梯度」。

那条注释是错的。qoder 的目录行一直带着这张表：

```json
"thinking_config": {
  "disabled": {},
  "enabled": { "efforts": { "high": {"is_default": true}, "low": {}, "max": {} },
               "is_default": true }
}
```

插件把这个字段丢掉了，改写成 toggle，而 toggle **比什么都不写更糟**。`effortLadderFor`（`backend/src/providers/boot-direct.ts`）把无档位的 toggle 解析成 `[]`，`downgradeReasoning`（`backend/src/types/router.ts`）返回 `candidates[0] ?? 'none'` —— 于是**每一个**请求档位都被压成 `none`。客户端向 GLM-5.4 要 `high`，静默拿到的是最浅的那一档。

而在厂商禁止关闭思考的模型上（`thinking_config` 有 `enabled` 块、没有 `disabled` 块），`none` 不只是「最便宜」，而是**被拒绝**：HTTP 400，上游错误码 `1210`（`该模型始终思考，不支持关闭思考；请使用 low、high 或 max`）。

这个故障在设计上就是静默的：容忍 `none` 的模型不报任何错，只是深度错了、账单错了；只有拒绝 `none` 的模型才吐 400。网关自身无法察觉，因为它是被告知「这个模型没有显式档位控制」的，而它针对这个说法的一切行为都是正确的。

还有一个次要缺陷同源：控制台的「测试」按钮曾硬编码 `isReasoning: false` 构造请求体，完全无视模型定义 —— 所以探测路径与推理路径发送了不同的请求，探测报 400 而上游推理其实是通的。

## 决定

**1. 只有一个映射器，任何插件都不得手写 def。** `backend/src/plugins/catalog-def.ts` 的 `toOcrDef` 把规范化的 `VendorCapabilities` 转成拉取引擎写入的 def。插件只负责把厂商词汇翻译成 `VendorCapabilities`，仅此而已。某个插件想另搞一套，就必须改这份契约 —— 而所有其他插件和共享测试套件都在那里看着。

**2. 只有档位表才算「声明了档位」。** `{type:'effort',values}` 只能来自厂商声明的表（或单个钉死的档位，写成单值表）。裸 `{type:'toggle'}` **只**在厂商明确声明「只有开/关、没有档位」时才发出 —— 那是它唯一为真的场景。厂商禁止关闭思考的模型标记为 `disableable: false`，映射器会从它的档位表中剔除 `none`，路由器因此永远不可能请求它。这个剔除是绝对的：即使厂商给出自相矛盾的表（唯一档位就是 `none`），也只写布尔值（不写档位表），绝不回退到把被剔除的 `none` 重新发布出去 —— 那样的回退会重新打开本规则要防的那个拒答。这个事实还会以 `reasoningDisableable: false` 随 def 传递：启动梯度（`effortLadderFor`）与每一处路由解析（`modelSupportsEfforts`、编排器钳制、System One 决策钉档）都会从解析出的档位集中剔除 `none` —— 裸 reasoning 布尔值会展开成包含 `none` 的完整梯度，若不携带该事实，无表的始终思考模型仍会被提供「关闭思考」并重演拒答。当这类模型必须服务一个已钉死的选定、而请求档位低于其声明下限时，服务档位落在它声明的最低档（`downgradeReasoning` 第三个参数），绝不是厂商拒收的 `none` —— 只有这个事实才允许向下应答。路由除外：在路由里够不到的请求是跳过该候选，因为选模型不等于承诺服务某个模型。厂商说「它会思考」但没发布表时，只写布尔值：不编造梯度，也不写一个会抹掉客户端档位的 toggle。

**3. 绝不发明。** `tool_call`、`temperature`、`structured_output`、`limit.input`、`cost` 除非厂商声明过，否则一律省略。写错的 `true` 会让网关发送上游拒收的参数；写错的 `false` 会隐藏模型真实拥有的能力。`undefined` 表示「未声明」，那就保持未声明。

**4. `attachment` 与 `modalities.input` 是同一事实，模态词汇表就是 models.dev 的全集。** 输入为 `text | image | audio | video | pdf`，输出为 `text | image | audio`。`attachment` 专门是**视觉**布尔值，所以一个只支持 pdf 的行会声明 `modalities` 但不带 `attachment`。纯文本行两个块都不声明 —— 复述「文本可用」不是能力声明。

**5. OCR 尚无法表达的厂商词汇，原样保留在 `vendor` 下。** 路由永不读取它；它的存在是为了将来提升某个字段时不必重新拉取全部模型。

**6. 声明的表由网关自己的梯度重新排序，绝不沿用厂商的键顺序。** 厂商把 `efforts` 发布成**无序对象**（`{"high":…,"low":…,"max":…}`），键顺序没有含义。映射器在发出前按 `EFFORT_LADDER` 排序，因为控制台会逐字渲染这个列表，而从一个任意顺序的列表里读出的 `defaultEffort` 会显得坐在梯度的错误一端。`normalizeEfforts` 同时会丢掉网关梯度叫不出名字的档位，而不是把无法路由的字符串漏进 `supportedReasoningEfforts`。

## 谁在读这份 def

契约只有让字段真正到达消费方才算数。映射器发出的字段，目前的消费方：

| Def 字段 | 消费方 |
| --- | --- |
| `reasoningOptions` | `effortLadderFor`（`providers/boot-direct.ts`）→ `downgradeReasoning`（`types/router.ts`）→ 线上 effort 参数 |
| `defaultEffort` | 分层/入口的 effort 默认值、控制台预选档位 |
| `attachment` | 控制台能力徽章（`routes/console.ts`）、`providers/virtual-meta.ts` |
| `modalities.input` | 客户端 agent 分配（`cli/clients/model-meta.ts`） |
| `limit` / `cost` | 上下文余量与控制台能力视图（`providers/virtual-meta.ts`）；`cost` 还派生 `pricing` 与缓存支持提示（`providers/boot-direct.ts`）。价格绝不决定梯队归属 |
| `disabled` | 路由池剔除 |

模态词汇表**刻意宽于它现有的消费方**：`audio`、`video`、`pdf` **目前没有消费方**（`model-meta.ts` 只检查 `image`）。契约允许承载它们，是为了将来某个插件声明时这个事实能被记录下来而不是丢掉；但声明它们**并不**换来准入控制。不要把词汇表的存在读成「该能力已被处理」的承诺。

## 后果

- 规则钉在 `backend/tests/plugins/catalog-def-contract.test.ts`，每条规则一个 `describe`，针对共享映射器跑一次，而不是每个插件各实现一遍。
- `qoder-models` 不再向拒绝 `none` 的模型发送 `reasoning_effort: 'none'`，400/1210 从源头消失。它的 `1210` 回放（`provider.ts` 里的 `effortClampTarget` / `clampThinkingOn`）降级为安全网：用于未映射的模型，或上游开始拒绝我们以为它接受的档位；它不再是主防线。两个调用方共用同一份实现：流式循环与控制台探测。探测从模型的**真实** def 构造请求体（由 provider def 推导 `capabilities.reasoning`，而非硬编码 `isReasoning: false`），所以「测试」跑的就是路由器跑的那条线 —— 探测绿说明推理路径是绿的，探测红是真实拒绝而不是探测专属的假象。
- 请求的档位重新真正到达线上：客户端要 `high` 就得到 `high`，控制台显示厂商的真实表。
- 将来的插件无法再悄悄重新引入这个缺陷：它没有 def 可写。
- `qoder-models` 的 `auto` / `fast` 行发布 `is_reasoning: true` 但 `thinking_config: null` —— 它们是不声明任何档位的路由别名。它们携带布尔值、不写 `reasoningOptions`，这是诚实的答案，也是文档化的布尔展开，而不是 toggle。

## 被否决的方案

- **各插件各写映射器，配一份共享文档。** 那正是此前的状况；文档没能阻止漂移，因为这种漂移在账单或某个 400 暴露之前是不可见的。
- **让插件在运行时从 backend 导入映射器，只导入类型。** 插件是自包含打包的（`pack.ts` 会内联相对导入），所以相对路径的运行时导入是可行的 —— 但插件不能随便伸手进 backend 的任意模块。`catalog-def.ts` 刻意做到除了它必须与之保持一致的 `EFFORT_LADDER` 常量之外，没有任何依赖。
- **靠探测厂商来推断档位梯度。** 现网实测否决了它：`reasoning_content` 的长度**不是**档位信号 —— GLM-5.4 在 low/high/max 三个档位下给出的推理内容长度完全相同（1147 字符）。厂商声明的表才是真相，猜测不是。
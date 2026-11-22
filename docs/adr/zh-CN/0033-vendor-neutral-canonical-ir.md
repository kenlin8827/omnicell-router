# ADR-0033 — 协议面与 wire 之间的厂商中立规范 IR

- 状态：已接受（已实现）
- 日期：2026-11-18；完成于 2026-11-19
- 取代：ADR-0008 §9 中“规范 chat 链”的表述

## 背景

ADR-0008 曾把所有转换统一到 `ChatCompletionRequest`。那是务实的桥，不是中立模型：chat 没有 typed items、item 生命周期、签名推理、多段工具结果和中立的缓存控制对象。旧链因此会丢弃 Anthropic document、签名／隐去思考与多模态工具结果，压平 Responses typed items，并不得不在 Chat 中间形态上叠加厂商补丁。

以转换为产品的网关，不能拿某个厂商的 API 形状当语义模型。模型必须在它们之上。

## 决定

1. **Canonical IR 是唯一语义模型**，位于 `backend/src/ir/`，采用 item 语义而非 Chat message 语义：
   - `instructions` 是一等字段，与对话 `input[]` 分离；
   - typed `input[]` / `output[]`（`message`、`tool_call`、`tool_result`、`reasoning`、`item_reference`、`extension`）保留 item id、状态与顺序；
   - typed content parts（`text`、`image`、`file`、`audio`、`refusal`、`extension`）保留媒体来源、引用、签名与缓存断点；
   - 工具是 typed union：`function`、`custom`、`builtin`、`extension`；`tool_choice` 包含 Responses `allowed_tools`；
   - tool call 同时保留 item `id` 与关联 `callId`；目标要求对象时，非法参数 JSON 显式失败，不改写成别的含义；
   - 推理正文、摘要 part、签名与加密内容是不同字段——正文绝不改标为摘要；
   - generation、结构化输出、推理、缓存、有状态请求与归因控制都有显式规范字段；
   - usage 保留缓存输入、缓存写入、推理、音频与预测 token 明细；
   - 流式使用厂商中立的 item 生命周期（`StreamEvent`），包含 text／refusal／reasoning／summary 完成事件与终态事件。

2. **每个北向协议面直接解析为 IR**。Chat Completions、Responses 与 Anthropic Messages 保持各自外部线协议。Gemini 仅是**出站** provider 协议，不宣称存在 Gemini 北向面。System One 仍是独立决策协议，不是 chat item 模型。

3. **每个南向 provider 都消费并返回 IR**。OpenAI Chat、OpenAI Responses、Anthropic Messages 与 Gemini `generateContent` 各有独立适配器。编排器、路由、会话历史、RespStore、usage 计费与协议面编码器都不需要 Chat 中间形态。

   Chat 只留在明确边界：Chat 协议面／provider 适配器、有版本的插件 Chat 契约、外部 Headroom API、旧磁盘数据迁移，以及显式测试这些边界的测试。

   物理布局与此一致：中立流工具在 `ir/stream.ts`（`createEventAccumulator`、`canonicalResponseToEvents`）；Chat SSE 编解码在 `ir/adapters/openai-chat-stream.ts`，与 `adapters/openai-chat.ts` 同级；端点作用域的 tool-markup 恢复（ADR-0034）在 `providers/`，不进 IR 核心。

4. **厂商知识命名空间化，丢失必须可见**。载体自有数据放在 `VendorBag` 或 `extension` item／part。同载体转换可原样回放；异载体 opaque item、不支持的媒体来源、工具种类、引用、签名或缓存控制抛 `IrUnsupportedError`，映射为 `400 unsupported_parameter`，绝不置空或 JSON 字符串化成另一种含义。Gemini grounding／logprob 响应元数据在存在忠实目标映射前，保留为 opaque extension 输出。

5. **渲染 payload 前经过同一能力闸门**。每个南向适配器调用 `assertCanonicalRequestSupported`，依据 `ir/capabilities.ts` 的可执行矩阵检查。矩阵覆盖 content／source 种类、工具、结构化输出、推理、状态、generation、归因与缓存断点。客户端专用的 `stream_options` 由北向 Chat 编码器消费，不误报为上游能力缺失。

6. **payload 使用显式白名单**。provider 不把客户端请求对象 spread 进上游正文。通用 OpenAI-compatible Chat 仍按缓存完整性闸门要求，在自身边界剥离载体专属缓存标记；这是刻意的适配器策略，不是第二套规范模型或跨协议转换链。

7. **流式能力如实声明**。四个内置 provider——OpenAI Chat、Responses、Anthropic 与 Gemini——都把原生上游 SSE 解码为 IR 事件。上游返回 JSON 仍是受支持的 fallback，通过同一套规范事件与终态语义展开。客户端与上游的流式轴相互独立：JSON 客户端可以把原生上游 SSE 聚合成单个响应，SSE 客户端也可以接收由缓冲上游结果合成的事件。Responses 流式期间分配的 item id，在 item 完成事件与终态响应中原样复用。

8. **转换工作与缓冲均有界**。每个边界只解析或渲染一次；流式逐事件中继。单个未终止 SSE 帧与累积语义文本各有 32 MiB 上限；上游流式原始抓包独立限制为 256 KiB，不截断语义 delta；客户端写入等待 drain，不为慢客户端建立无界队列。迭代器提前退出会取消上游 body；正常客户端断连的计费路径仍会排空终态 usage。核心路径不再有全对全转换器矩阵或重复 Chat 往返。一致性与资源套件覆盖长上下文、高频 delta、超大帧、取消、超时和背压；`bun run bench:ir` 记录机器相关的延迟与堆测量，不设置脆弱的通用时间阈值。

## 命名

- **协议 id = wire id**（落盘、控制台、插件 manifest 的 `protocol`、内部执行器键——只有一套词汇，2026-11-19 / 2026-11-20 修订）：`openai-chat`、`openai-responses`、`anthropic-messages`、`google-gemini`、`systemone`，以及任何 model-service 插件声明的协议 id（裸协议名，绝不是 SDK npm 包）。一个 `WireKind` 值就是它的协议 id——没有第二套“短 wire”拼写。插件侧的清单由已加载的插件 manifest 推导得出，不在这里穷举——见下。
- **旧输入别名**（只读，永不写出）：退休的 `openai-compatible` / `openai` / `responses` / `anthropic` / `google`，以及入站面 `chat` / `responses`，在每个读取边界（`wireFor`、`protocolForWire`、probe、dispatch trace、`trace/persist.ts` 回放）由 `providers/protocol.ts` 归一化，因此改名前的归档与 def 保持同样的路由与展示。不重写任何落盘数据。
- **无歧义展示**（2026-11-20 修订）：控制台各处（徽标、tooltip、编辑表单）统一展示完整规范 id（`openai-chat`、`openai-responses`、`anthropic-messages`、`google-gemini`、`systemone`），消除短别名（`chat`/`responses`/`messages`）可能带来的归属歧义。
- **IR 类型**：`CanonicalRequest`、`CanonicalResponse`、`InputItem`、`OutputItem`、`StreamEvent`。

> 修订（2026-11-20）：将 `openai-compatible` 更名为 `openai-chat`，使所有内置协议统一遵循 `<vendor>-<api>` 命名范式（`openai-chat`、`openai-responses`、`anthropic-messages`、`google-gemini`），并移除短徽标别名表以消除歧义；`openai-compatible` 保留为只读历史输入别名。

## 修订（2026-12）——wire 词汇由注册表驱动

插件宿主是“存在哪些 wire”的唯一权威：model-service manifest 声明 `wires: []`，`getModelServicePlugin(wire)` 匹配已加载插件的 `PluginView.wires`。此前所有靠“点名厂商”来回答“这是不是插件协议”的地方都犯了同一个错——一个没人点名的插件协议会掉进 OpenAI 兼容 chat wire，随之而来的 `400` 被归咎于上游。

- `backend/src/providers/plugin-wires.ts` 是唯一的桥：宿主在每次注册表重建的尾部 PUSH 当前认领的 wire 集合（`claimPluginWires`），每个决策点 ASK（`isPluginWire`）。核心文件不再列举任何插件协议，新插件协议无需改核心。
- 消费者及其推导来源：`wireFor`（`providers/wire.ts`）在核心形态之后把插件 wire 解析为自身（插件不得吞并核心 wire）；`DispatchingProvider`（`providers/executors/dispatch.ts`）与 `ProviderRegistry`（`providers/registry.ts`）通过注册表构建插件执行器，插件缺席时该 wire 保持 UNSET，于是 dispatch 以 wire id 报错而不是转到 chat 执行器；控制台词表（`providers/vocabulary.ts`）仅在已安装插件认领时追加插件 wire；`CLIENT_PACKAGE_FALLBACK`（`opencode/credentials/def-materialize.ts`）对每个插件 wire 都替换为 `openai-chat`（自带传输的插件按定义没有客户端 SDK 段），而不是逐个列举厂商。
- 因此 `WireKind` / `ProbeKind` / `ProviderConfig.type` / `ModelRegistration.wire` 都是开放的：核心字面量供读者阅读，插件 id 为 `string & {}`。此处写成封闭枚举就是插件注册表的漂移双胞胎。
- 引导下限：`plugin-wires.ts` 的 `NATIVE_WIRES`（`qoder`、`workbuddy`）是身份表而非分发表——OCR 原生协议 id 的 wire 就是它自身，携带它的 def 必须在插件缺席时也能解析到该 wire（def 可能早于安装存在，而 wire 在启动时就已决定，远早于缺失的执行器有机会报错）。

## 实现状态

- 核心执行与观测链只使用 IR；旧 route 级 Chat 转换库与 Chat chunk 累积器已删除。
- Responses 续接节点保存规范 input／output items（`v: 2`）；只有回放旧恢复记录时才进行 Chat 转换。
- `backend/tests/ir/ir-conformance.test.ts` 钉住跨协议顺序、工具与媒体保真、推理、缓存控制、usage、显式失败、流式生命周期／id 稳定性与有界转换工作。
- `backend/tests/ir/ir-matrix.test.ts` 执行 12 项请求、12 项缓冲响应、48 项流式与 9 项 posture 组合。脱敏 golden 流 fixture、压缩／缓存完整性与资源边界套件列于 `docs/design/protocol-matrix.zh-CN.md`。
- `bun run test:live` 是显式 opt-in 的真实账号契约入口，不进入隔离测试；跳过配置绝不是 provider 兼容性证据。`bun run bench:ir` 提供本地性能基线。
- ADR-0008 §9 现在陈述 IR 不变量，不再描述规范 Chat 链。

## 后果

- 用更多显式类型与适配器替换隐式丢失和两两补丁。
- 每个新载体必须声明能力并通过一致性语料。
- “缓冲上游 + 合成客户端 SSE”不得描述为原生 provider 流式。
- 不支持的厂商方言不得静默接受：要么实现忠实映射，要么显式失败。

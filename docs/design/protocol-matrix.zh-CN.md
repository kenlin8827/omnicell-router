# Canonical IR 协议与执行矩阵

状态：本文列出的内置协议已实现。可执行测试与 `ir/capabilities.ts` 是事实源；本文解释矩阵维度，不另维护一份容易漂移的逐 case 手工清单。

## 1. 转换覆盖

北向：OpenAI Chat Completions（`openai-chat`）、OpenAI Responses（`openai-responses`）、Anthropic Messages（`anthropic-messages`）。南向：上述三种加 Google Gemini `generateContent`（`google-gemini`）。每一跳都是“客户端协议 → Canonical IR → provider 协议”；响应与流沿反向路径经过同一 IR。

| 维度 | 完整组合 | 数量 | 可执行证明 |
| --- | --- | ---: | --- |
| 请求转换 | 3 北向 × 4 南向 | 12 | `backend/tests/ir/ir-matrix.test.ts` |
| 缓冲响应转换 | 4 南向 × 3 北向 | 12 | `backend/tests/ir/ir-matrix.test.ts` |
| 流式转换 | 3 客户端协议 × 4 上游协议 × 2 客户端形态（JSON／SSE）× 2 上游形态（缓冲／原生） | 48 | `backend/tests/ir/ir-matrix.test.ts` |
| 流式 posture | 客户端 `allow/deny/always` × 上游 `follow/stream/buffered` | 9 | `backend/tests/ir/ir-matrix.test.ts` |
| 原生 transport 与 JSON fallback | 四个 provider 实现 | 全部 | `backend/tests/providers/provider-native-streams.test.ts` |
| 脱敏持久化流语料 | Chat／Responses／Anthropic／Gemini golden JSON | 4 | `backend/tests/ir/ir-golden-fixtures.test.ts` 与 `backend/tests/fixtures/ir/` |

公共 fixture 只包含所有目标均可表达的语义：instructions、有序对话输入、函数定义与调用、工具结果、助手正文、终态与缓存 usage。它不意味着所有厂商特性都能移植。特性专项负例证明：不支持的映射必须显式失败，不得静默消失。

## 2. 能力与保真维度

`backend/src/ir/capabilities.ts` 是可执行特性矩阵。`ir-gates.test.ts`、`ir-conformance.test.ts`、`cache-integrity.test.ts` 与各协议面套件同时覆盖正向映射和拒绝路径。

| 维度 | Chat | Responses | Anthropic | Gemini |
| --- | --- | --- | --- | --- |
| 原生上游 SSE | 支持 | 支持 | 支持 | 支持 |
| 缓冲 JSON／流请求 JSON fallback | 支持 | 支持 | 支持 | 支持 |
| content parts | text、image、refusal | text、image、file、refusal | text、image、file | text、image、file、audio |
| 工具定义 | 仅 function（可移植） | function、custom、builtin | function | function |
| 结构化输出 | JSON object／schema | JSON object／schema | JSON schema 映射 | JSON object／schema |
| 推理控制 | effort 映射 | effort、budget、summary、签名 | budget、签名 | budget、thought 签名 |
| 多候选 | 支持 | 不支持 | 不支持 | 支持 |
| 响应 annotations | 不支持 | 支持 | 支持 | 仅 opaque 载体扩展 |
| 请求缓存控制 | key 与载体自有断点；通用上游剥离异载体标记 | key、retention、options、part 断点 | part／tool／item `cache_control` | 未声明支持 |
| item reference／有状态上游 | 不支持 | 支持 | 不支持 | 不支持 |

其他门禁覆盖媒体 source 类型、strict 工具 schema、allowed tool choice、并行工具调用、generation 字段、verbosity、logprobs、service tier、归因、metadata、item reference 与 stream options。同载体 opaque 扩展可以往返；异载体 opaque item／part 或无法忠实表达的关键特性抛 `unsupported_parameter`。客户端可见的 `error.message` 会点名特性、拨号出站协议、经 registry 拨号时的模型及其声明的 `protocols[]`，以及简短修复提示——不再是一句光秃秃的 “Protocol cannot…”。适配器不会把未知内容字符串化进 prompt，也不会静默丢弃签名推理、引用、工具定义或 usage 明细。

**Chat 工具种类。** `openai-chat` 只宣称 **function** 工具。该 id 是 OCR 的可移植 OpenAI 兼容 Chat Completions 契约（小米／DeepSeek／Kimi 一类端点）。OpenAI 平台 Chat Completions 在 2025-08 增加了 `type:"custom"`（自由文本／Lark 或正则 grammar）；该方言**不属于**通用 `openai-chat` 线——若在全局矩阵打开，会把仅 OpenAI 支持的载荷转发给会拒绝或过滤它的兼容上游。Responses 继续承载 `custom` 与 `builtin`。Codex 这类客户端若带着 Responses custom／builtin 打到 chat 兼容或仅 Anthropic 的模型，会得到显式的 `unsupported_parameter`，并点名以 `openai-responses`／`protocols[]` 为修复路径——绝不静默改写成 function calling。

**工具关联标识。** 没有任何载体拥有工具关联 id 的**形状**：chat 客户端控制 `tool_calls[].id`，而 cursor-gateway 插件的 agent 循环（插件树不受 git 跟踪，在源码之外）会把**上一个上游**铸造的 id 重新注入历史——于是从冗长提供方起、落进 Responses 提供方的级联，会把一个新上游从未发过的字符串递回给它。严格的 Responses 上游会字段校验该串并返回 400。因此**出站请求侧**通过一个确定性映射渲染 `call_id`（`responsesCallId`，预算 `RESPONSES_CALL_ID_MAX_LEN`）：已在字符集与长度预算内的 id **逐字节原样**离开——按 `call_` / `toolu_` 形状取键的载体仍看到原值——其余变成 `call_` 加上按预算截短的 SHA-256 摘要（59 位十六进制 = 236 bit），形状也因此保住。该映射是幂等投影（`f(f(x)) === f(x)`），客户端重放网关已改写过的 id 会拿回同一个名字，调用与结果不会跨轮错位；确定性同样是重放前缀能被缓存的原因。**截断原文不是退路**——共享前缀的 id 会把两次调用悄悄合并成同一个关联 id，任何一侧都不报错；空白字符同理是哈希而不是剥离。工具**结果**的空关联 id 抛 `unsupported_parameter`，机器码为 `tool_call_id`，绝不铸造所有无标签调用共用的占位串；而 tool **call** 的空 `call_id` 不会被拒——它有 item id 可退；两者都没有时，`mintToolCallId`（`call_` 加 24 位十六进制，沿用 `syntheticId` 的命名空间）在读侧把它补上，而不是留一个空标签。映射**只存在于预算被强制执行的那一侧，且只作用于 `call_id` 字段**：canonical 状态、`store: true` 链路重放所用的会话存档、以及记录下的 canonical 响应都保留原 id，出站**响应侧不对 `call_id` 做投影**——把摘要交回客户端，它会与下一轮历史里的原值互不相认而成为 orphan，进而让配对修复用合成的“cancelled”占位结果覆盖客户端真正的工具结果。命名只发生在**响应**平面上。请求平面照抄客户端写下的名字，空也照抄：harness 每轮都会重发整段历史，若在读客户端请求体时造名，每次重发都会得到不同名字，出站前缀每轮都在变字节——这是客户端看不见也修不掉的冷缓存。所以把无名配对拒掉才是对无法往返数据的诚实结论，这也是有意不再把 `""` 转发给上游（它会在更晚、更不清楚的地方拒绝）。归档里**上游请求**的正文则是**渲染后**的形态，因为那才是真正发出去的字节。item `id` 是**另一张映射**（`responsesToolItemId`），预算更窄：`RESPONSES_TOOL_ITEM_ID_MAX_LEN` 约束的是 id **正文**，`fc_` / `ctc_` 的 item 类型前缀再加在前面（因此摘要型 item id 为 48 位十六进制 + 3 = 51 字符）。 上游没给 tool call 任何 id 时，锚点在**读到上游响应的那一刻**铸进 canonical 状态（`mintToolCallId`），于是 canonical 状态、`store: true` 重放的会话存档、归档与每个出站载体都只认**同一个名字**；wire 侧只为该规则之前存档的节点补槽位——若在渲染时才铸造，客户端会拿到一个存档里从未有过的锚点，`store: true` 的下一轮就会被本网关自己的 `tool_call_id` 门拒绝，而客户端什么都没做错。这个锚点同时填 `id` 与 `call_id`——空串的摘要是个常量，会把所有无 id 调用并成同一个名字——且流式编码器缓存该锚点，`output_item.added`、`output_item.done` 与终态响应绝不会给同一条目两个称呼。入站流式解码器遵守同一条规则：一个没带 id 的 Responses `function_call` 每帧都会被**独立读一次**，所以 `OpenAIResponsesStreamDecoder` 会记住它为该 output index 造过的名字，`output_item.done` 不会把客户端在流中拿到的锚点换成第二个；Anthropic 与 Gemini 的流式腿也按其缓冲腿的同一命名空间给无名调用命名。`extension` 条目的名字在**自己的 payload 里**，故编码器先读 payload id 再铸造（按类型取 `msg_` / `rs_` / `item_`，tool call 取 `fc_` / `ctc_`），且透传是**复制**——铸造出的名字不会就被写进记录下来的上游 payload。

## 3. 流式、背压与终态

| 关注点 | 契约 |
| --- | --- |
| 客户端 JSON + 原生上游 SSE | 排空上游事件并聚合为一个 IR 响应，再发送单个 JSON。客户端没有字节提交，重试／failover 仍合法。 |
| 客户端 SSE + 缓冲上游 | 把最终 IR 响应展开为规范事件，再编码成客户端原生 SSE 生命周期。 |
| 客户端 SSE + 原生上游 SSE | 上游只解码一次，逐 IR 事件中继，再为客户端编码一次。注册表累积同一批事件对象完成 usage／记账。 |
| 慢客户端 | 两种 node transport 都等待 `drain`，生产路径不建立无界帧历史队列。 |
| 取消 | 迭代器提前退出取消上游 body；正常断连处理按中继契约继续排空终态 usage。 |
| 提交点 | 响应头／首个 SSE 字节提交后，不重试，也不追加 JSON 错误终态；关闭流且不产生第二个终态响应。 |
| 总超时／idle 超时 | 默认：缓冲 30 分钟；流式总时长 60 分钟；流式 idle 5 分钟。provider 配置可覆盖。 |
| 语义累积 | 正文／工具／推理等累积文本合计 32 MiB 字符上限。 |
| SSE 解析器 | 单个未终止帧／data 载荷限制 32 MiB；包含大量完整小帧的大网络 chunk 合法。 |
| 原始流抓包 | 独立 256 KiB 上限，不影响语义事件投递。 |

## 4. 缓存计费与请求控制

| 载体 | 缓存输入 usage 来源 | 其他保留的 usage |
| --- | --- | --- |
| Chat | `usage.prompt_tokens_details.cached_tokens` | reasoning、audio、prediction token 明细 |
| Responses | `usage.input_tokens_details.cached_tokens` | reasoning、audio、prediction token 明细 |
| Anthropic | `cache_read_input_tokens` | cache creation 总量与 5m／1h 分桶 |
| Gemini | `usageMetadata.cachedContentTokenCount` | reasoning／thought token 数 |

缓冲与原生流式两条腿都映射为 `CanonicalResponse.usage.cachedInputTokens`；北向 JSON 与 SSE 编码器输出对应载体的等效字段。Prompt cache key、retention／options 与客户端缓存断点保留在规范请求类型中，仅由声明支持的载体消费。通用 OpenAI-compatible 上游渲染前剥离异载体扩展。

## 5. 压缩管线

压缩在路由与上游渲染前执行，不会变成第二套执行 IR。

| 阶段 | 修改边界 | 完整性契约 |
| --- | --- | --- |
| RTK | 仅 `tool_result` item 的 text part | 不重写 assistant tool-call arguments、工具定义、缓存标记、签名或 extension part。确定性转换保持前缀稳定；有损压缩器必须带自己的标记。 |
| Headroom | 可选外部 Chat `/v1/compress` 投影 | 投影／转换失败、非 200、messages 数量不匹配与 `compression_skipped` 全部 fail-open 到原 IR；投影失败暴露 `headroomSkippedReason`。 |
| Caveman | 仅追加 system instructions | 原前缀顺序与内容不变；重复注入确定且幂等。 |

`backend/tests/ir/compression-integrity.test.ts` 同时钉住上述规则和抓包顺序：客户端腿记录压缩前的客户端协议 body，上游腿记录实际压缩后的 provider payload。

## 6. 抓包保真

抓包留在两条物理 HTTP 腿上，不落在 IR：客户端事件保留客户端协议 envelope，上游事件保留实际 provider wire body。因此经过 IR 转换不会把任何一侧替换成规范调试载荷。

“原始 wire”是运维表述，不承诺逐字节归档：JSON 可能重序列化，执行路径移除指令时抓包也同步清理，凭证默认脱敏，并存在体积上限／截断。上游流式响应原始抓包明确限制为 256 KiB，但不截断语义 delta。

## 7. 验证入口

- `bun run test`——隔离、无外网供应商调用的完整测试。
- `bun run test -- ir-matrix ir-golden-fixtures provider-native-streams compression-integrity stream-resource-boundaries`——聚焦转换／资源套件。
- `bun run bench:ir`——本地确定性基线：四种请求渲染、四种原生解码、长上下文、10k delta、48 种流式组合、慢客户端背压与并发堆使用。结果是机器测量，不是可移植的 CI 时间阈值。
- `bun run test:live`——只有显式设置 `OCR_LIVE_TEST=1` 和 `OCR_LIVE_PROVIDERS` 才执行。每个选中 provider 需要独立的 `OCR_LIVE_<PROTOCOL>_API_KEY` 与 `_MODEL`；可选 `_BASE_URL`、`_TIMEOUT_MS` 和 Chat `_ORGANIZATION`。运行缓冲／原生流的文本与工具调用契约，返回缓存 usage 时如实报告，不打印凭证，缺配置标记 `skipped`，绝不计作 `pass`。

实网检查没有真正对相应账号与模型运行前，不能算入普通 CI 的兼容性证据。

## 8. 明确边界与后续工作

- 没有 Gemini 北向协议面。
- Responses 北向 Conversations、background 执行／轮询与自动 truncation 均显式拒绝，不是已实现的网关功能。
- 插件 model-service API v1 仍是有版本的 Chat 执行器边界；未宣称也未实现插件原生 IR v2。
- System One 是决策协议，不是另一种 chat item 协议面。
- 同载体 opaque 扩展可往返，不等于具备跨厂商可移植语义。新方言需要忠实适配器映射和一致性 fixture，否则必须可见地拒绝。
- Golden fixture 与本地模拟证明网关行为，不能替代每个 provider／model 组合的实网账号互操作测试。
- OpenAI 平台 Chat `custom` 工具暂缓：该方言的编解码应挂在**默认关闭的 provider 级能力**之后，而不是全局 `OPENAI_CHAT` 矩阵。在相应 ADR 落地前，把 custom／builtin 的 agent 流量路由到具备 Responses 能力的上游。

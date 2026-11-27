# ADR-0034 — 严格作用域的工具调用标记恢复与残留观测

- 状态：已接受（已实现）
- 日期：2026-11-19
- 取代：同编号先前的“只观测”版本和“不限作用域修复”版本

## 背景

有些模型把工具调用写成助手正文里的标记，依赖前面的 API 将其转换为结构化 `tool_calls`。DeepSeek V4 已观测到这种行为，既有带 DSML 哨兵的拼写，也有完全不含 DSML 哨兵的形式：

```
<｜tool_calls｜>
<｜invoke name="ls">
<｜parameter name="path">src</｜parameter>
</｜invoke>
</｜tool_calls｜>
```

权威转换器属于拥有 chat template 的那一层：模型服务端（`vLLM --tool-call-parser deepseek_v3`、SGLang 的等价物）或应答前完成解析的 provider API。OCR 无法替上游修好这个组件。但当 opencode zen 中继把标记原样透出时，OCR 客户端会把标签当正文，工具不会执行，模型还会从历史中读回这些标记并在后续轮次重复。

早先不限作用域的网关修复并不安全：它依赖真实流量里并不存在的字面量 `DSML` 哨兵，可能改写代码示例，把截断调用当成完整调用，重复原生调用，复用合成 ID，还把流式 provider 变成“先组装再回放”。随后的只观测版本虽然暴露了泄露，却让这条已知受影响路径仍然不可用。因此，本决策比两个前身都更严格。

## 决策

**1. 权威修复仍归端点；OCR 只做一个防御性、严格限定作用域的恢复。** `backend/src/providers/compat/tool-markup-recovery.ts` 的 `toolMarkupRecoveryFor` 仅在以下条件同时成立时启用 `dsml` 恢复：

- 解析后模型的 `upstreamModel` 把 `deepseek-v4` 当作独立的 id 片段（不区分大小写；`deepseek-v4-flash` 命中，`deepseek-v40` 不命中）；
- provider `baseUrl` 的主机名为 `opencode.ai`，路径为 `/zen/v1`（末尾斜杠等价）；
- 请求声明了至少一个符合其 `toolChoice` 的可调用 function 工具（`none` 和不兼容的 `custom` 会禁用恢复）。

provider ID 刻意不参与判断，重命名 provider 不改变行为。DeepSeek 官方端点、其他 opencode 路径、其他模型族以及没有可调用工具的请求都保持原样。这不是通用 DSML 兼容模式，也不能扩张成未声明的方言嗅探器。

**2. 每个调用要么完整恢复，要么完全不猜。** 解析器接受已观测的全角／ASCII 拼写、可选 DSML 哨兵、包装块或裸 `invoke`、并行调用和零参数调用。只有完整闭合、名称已由请求声明、参数通过结构性 schema 检查的调用才会转换；检查包括声明类型、必填属性、枚举、数组和 `additionalProperties: false`，但这不是完整 JSON Schema 校验器。真实的无类型字符串参数，只有声明 schema 明确它是字符串时才可接受；绝不会把任意非 JSON 值强制转型来凑成成功调用。

未知工具、畸形参数、schema 不匹配和截断标记都保留为普通正文。畸形包装块不可分割：OCR 不会恢复一个并行子调用却把另一个留在正文里。 fenced code 和行内 backtick 代码都视为正文，即使内容恰好是语法有效的调用也不例外。与某条 user / tool_result 文本完全相同的 assistant 正文一律不恢复——模型原样回显攻击者植入的 DSML 时，不得把它升级成可执行的 `tool_call`。

**3. 缓冲腿和流式腿共用同一套 IR 语义。** 缓冲路径使用 `recoverToolMarkupInResponse`，原生 SSE 路径使用 `createToolMarkupStreamRecovery`。普通正文 delta 继续增量下发；只有仍可能形成工具标签、代码围栏或行内代码跨度的正文才会暂留，暂留上限为 1 MiB，超限后回退为透传而不是无限缓冲。工具事件等到流末统一协调，避免上游原生空占位调用和恢复调用都被执行。没有整响应伪流式，也不切换传输方式。

恢复出的合成 ID 包含响应 ID、candidate 序号和调用序号：拼出 `call_` + 响应 ID + `_dsml_<candidate>_<sequence>` 后，**只有整个串已落在 `call_id` 字符集与 `RESPONSES_CALL_ID_MAX_LEN` 内才原样保留**，否则把**整串**摘要压缩到留给 marker 的空间再把 marker 接回。所以触发线是减去前缀与 marker 后的余额（普通响应 ID 大约 48），不是裸的 64；既不清洗也不截尾，因此本网关铸造的 ID 不会被自家的出站 Responses 门再改写，共享同一串 64 字符尾部的两个响应绝不会并成同一个关联 ID，只有字符集外字符不同的两个响应 ID（`resp.a` 与 `resp_a`）也不会。响应 ID 为空就当作没给，改用 uuid 播种（与流式腿一致），否则每一轮都会铸出同一个 `call__dsml_0_1`。同名且参数为空或 `{}` 的原生占位调用接收恢复参数并保留原生 ID，不再生成重复调用。凡是 output 就是主输出的 candidate，不论序号都只转换一次（此前还要求 index 0，于是同一次恢复调用会被铸出两个 ID，chat 腿与存档／会话腿就分家了）。非长度限制的终态原因（包括 `content_filter`）原样保留。

失败的缓冲响应绝不修复。流式失败时，排队中的恢复调用被丢弃，已抑制的源标记会在失败终态前重新作为正文发出；已经下发的 delta 无法撤回。任何终态路径都不会把不完整调用静默变成可执行调用。

**4. 恢复和残留泄露是两个独立观测信号。** 成功转换会写入 `CanonicalResponse.toolTextRecovery`，并在缓冲响应上输出 `X-OCR-Recovered-Tool-Calls: <n>`；这不会伪装成上游解析器健康。

`backend/src/providers/compat/tool-markup-leak.ts` 仍是只读检测器，在作用域恢复之后统计仍留在正文中的标记；对不在恢复作用域内的响应，它观测原始泄露。残留标记在可写响应头的缓冲腿上输出 `X-OCR-Tool-Markup-Leak: <n>`，并在两条腿上都写一条 serving 失败台账（`errorClass: 'UNKNOWN'`，消息包含 provider 和数量）。流式腿使用增量扫描器或恢复后的响应，绝不补写迟到的响应头。不会为单项诊断新增熔断／错误分类。

**5. 客户端不增加第二份解析器。** `frontend/src/pages/PlaygroundPage.tsx` 不恢复工具标记。各北向协议面接收相同的标准工具项；唯一的防御性解析器位于南向 provider 执行边界，因为只有这里同时知道端点和模型作用域。

## 后果

- 受影响的 opencode zen + DeepSeek V4 路径，在缓冲和原生流式请求上都能执行完整且已声明的工具调用，普通正文仍持续流式下发。
- 代码示例、未知工具、畸形或截断调用、失败响应、无关端点和无工具请求都不会获得合成工具执行；失败流仍保留被抑制过的源标记正文。
- 运维可以区分“网关做了防御性恢复”（`X-OCR-Recovered-Tool-Calls`）和“仍有标记泄露”（`X-OCR-Tool-Markup-Leak` 加 serving 台账）。恢复成功不代表端点已修好；provider／模型服务端的解析器仍是权威修复点。
- 扩展到其他端点或方言，必须有真实观测证据、显式修改作用域、对抗性测试，并同步修订本 ADR。仅重命名 provider 不会启用或禁用现有作用域。

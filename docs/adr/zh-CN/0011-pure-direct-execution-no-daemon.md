# ADR-0011: 纯直连执行——OpenCode daemon 完全退出推理链路

## 状态

Accepted（分阶段实施）— 2026-10-08
关联：[ADR-0002](./0002-dynamic-model-discovery-via-opencode.md)（其第 4 条"Keyless Proxy Delegation"由本 ADR **废止**；第 1–3 条动态发现与价格金字塔分层理念**保留**，仅更换数据源）。

## 背景

2026-10-08 的 gpt-6-luna 故障排查暴露了执行委托给 opencode daemon 的四个结构性缺陷（均有实测证据）：

1. **执行端点有损**：`OpenCodeProxyProvider` 所依赖的 `/api/experimental/generate` 将 messages 拍平为纯文本 prompt——system/角色结构、`tools` 定义、多模态 content blocks 全部丢弃，且无原生流式（网关事后切假 SSE）。编码类客户端（Claude Code / codex / opencode 子代理）以 tool calling 为生，此路径事实上不可用。
2. **daemon 不是透明管道**：它是 opencode 应用的推理组件，会加料——`instructions[]` 文件与 agent system prompt 被拼进每次请求；插件注册了 `chat.message` / `chat.params` / `experimental.chat.system.transform` 等改写钩子（本机实测存在）；上游准入按"是否来自 OpenCode 客户端"判定（"free tier can only be used from within OpenCode" 即其产物）。网关对最终发给模型的内容失去控制权。
3. **出网策略倒挂**：网关 `/proxy` 接出能力只能管网关自己的出网；真实外网流量发生在 daemon 进程，区域封锁时网关无法施救。
4. **依赖与一致性地耗**：daemon 单点（同日多次新旧进程混跑产生半新半旧症状）；"手动测试 ≠ 正式调用"的双路径漂移直接制造了 `ModelProtocolUnsupported` 假警报。

关键反证：委托 daemon 的理由是"协议真值难复刻"。实测证明协议真值的**数据源是 models.dev 的 `provider.npm`（含模型级覆盖）**，本仓库 catalog 已持有；真值不在 daemon 的执行栈（行为）里，在数据里。**有数据即可直连，无需行为代持。**

## 决策

1. **推理唯一执行路径 = 网关直连 provider**。`OpenCodeProxyProvider` 移出执行链路；daemon（`/api/provider`、`/api/model`）降级为可选的目录辅助源（catalog `'service'` source），永不进入请求路径。
2. **凭证直读**：`~/.config/opencode/opencode.jsonc` provider 节点 + `~/.local/share/opencode/auth.json`——与 daemon 同源同文件，不落第二份拷贝，保持 ADR-0002"凭证不扩散"的优势（该读取能力 `user-config.ts` 已具备，现仅用于控制台）。
3. **线型派发数据驱动**：`模型级 provider.npm > config 节点 npm > catalog builtin npm` 解析出 wire ∈ { openai, anthropic, responses, google }，与 `probeKindFor` **共用同一判定函数**——测试与执行从代码结构上不可能再漂移。附带规则 `baseForWire()`：models.dev 每 provider 只发布一个 `api`（通常 OpenAI 兼容挂载），Anthropic 线常见于兄弟挂载（实测 Zen：`/zen/v1/messages` 404 而 `/inference/anthropic/v1/messages` 200），boot 与 probe 同步换算；`anthropicMessagesUrl()` 消除 `/v1/v1` 双后缀（claude-sonnet-5-5 事故，2026-10-08）。控制台测试路由的模型选择：provider 级探测（未显式传 `modelId`）按序构建至多 3 个文本候选（启用 config 定义 → catalog 顺序），且仅在**模型级拒绝**时轮换——上游以结构化 404（方舟 `ModelNotOpen`/`UnsupportedModel`）或 400 协议/url 不匹配应答——因此即使 catalog 首位模型未在账号开通，一次通过即可证明 provider 存活；连接级失败（鉴权、网络、网关 404）绝不轮换，显式 `modelId` 绝不被替换。
4. **新增 `ResponsesProvider`**（OpenAI Responses API 线：`POST {base}/responses`）。
5. **裸 fetch 无法覆盖的 wire**（`@ai-sdk/google-vertex/*` rawPredict、bedrock SigV4 等）：模型在注册表**显式标记不可路由**，控制台可见、返回明确错误。禁止再用猜错的协议线打上线然后甩锅上游 400。
6. **OAuth provider（github-copilot 等）**：P2 在网关实现 token 刷新生命周期；完成前从路由池显式排除并可见，不得隐性依赖 daemon 代持。

## 实施阶段

| 阶段 | 内容 | 完成判据 |
| :--- | :--- | :--- |
| P1 | 直连派发：boot 时模型池改由 `catalogRepository`（models.dev + config 定义，均已存在）构建，替代 daemon `syncToTierModels`；registry 按模型级 npm 选 executor；新增 ResponsesProvider；probe 与 executor 共用 npm→wire 判定 | 无 daemon 进程时，全部纯 API-key provider 推理正常；Test 与推理报错逐字节一致 |
| P2 | OAuth 刷新（github-copilot 优先，本机主力供给） | copilot 模型直连可路由 |
| P3 | `/v1/messages` ⇄ OpenAI 桥补全 tools / tool_result / 图像 / 原生流式透传 | Claude Code 挂网关可完成一轮真实工具调用 |
| 各阶段 | 集成测试在无 config.yaml 的干净 worktree 跑（本机 apiKeys 会致 401 假失败） | typecheck + 测试全绿 |

## 风险与边界

- 凭证由"daemon 代持"变为"网关进程内存持有"：本机单用户工具，auth.json 同一份文件，泄露面不扩大；网关仍不将密钥写入自身配置或响应。
- 模型池鲜活度取决于 models.dev 24h 缓存 + opencode.jsonc 手动定义（无 daemon 实时同步）——与 ADR-0002 相比动态性略降，用控制台"同步"按钮补偿。
- P1–P2 期间带 OAuth/特殊 wire 的供给不可用，属**显式排除**（可观测），而非静默降级——宁可少路由，不可假路由。
- ADR-0010 决策缓存、ADR-0008/0009 熔断重试等上层机制不受影响（位于 registry 之后）。

## 后果

- 网关行为完全由本仓库代码 + models.dev 数据决定：opencode 升级插件/instructions 不再改变经网关的模型输出（"纯"的定义）。
- `/proxy` 首次对全链路出网有效。
- "手动测试 vs 正式调用"一类 bug 结构性根除（单判定函数、单执行栈）。
- 控制台未来可增加"直连/不可路由"池状态列，兑现决策第 5、6 条的可见性承诺。

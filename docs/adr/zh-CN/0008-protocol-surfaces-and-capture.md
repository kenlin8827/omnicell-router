# ADR-0008: 协议接入面与捕获——双传输一张派发表、交换事件而非轮快照、两腿全链 opt-in

## 状态

已实现 — 2026-10-15（事实面语料重写）。范围：入站协议面（原生路由 + MITM 代理）、共享派发接缝、System One 决策网关、请求捕获平面。trace/捕获持久化分界 = ADR-0005；数据集采样（**不是**捕获）= ADR-0001；决策面的寻址 = ADR-0003。

## 决策

### 1. 一张表、两种传输、一个接缝

`SURFACES`（`surfaces/table.ts:8-23`）是唯一注册表：每个入站面一行——`routePath / detectSuffix / exec / capture / encodeStream`。同一张表同时驱动 Fastify 路由注册（`server.ts:1044-1056`）与 MITM 路径探测（`detectSurface` 后缀匹配）——限流路由表也由它派生（`INFERENCE_ROUTE_PATHS = SURFACES.map`）。`dispatchSurface` 只按 `exec` 分叉：`chat-pipeline` | `decision-pipeline`。两种传输各自构造 `TransportContext`（`surfaces/types.ts:58-79`）：`method/url/headers/clientIp` + 访问闸（判别联合：Fastify 侧 `kind:'key'`——已验 bearer/x-api-key + 按 key 模型访问，拒绝已由 guard 写成 403；MITM 侧 `kind:'exempt'`——客户端是**穿过**我们连出去的，信任在 CONNECT/TLS 层 + bypass 名单；无网关 key，故捕获事件不带 apiKey 归属，上游调用一律用注册 provider 自己的凭证）+ `captureProcessContext()`（捕获关时答 `{}`）+ 终发（`sendJson` / `beginSse`+`writeSseChunk`+`endSse`）+ `isClientGone()` + `logError`。终发纪律：每请求恰一次终发；parse/gate 失败**零捕获事件**（两腿都在 dispatch 之前）。

### 2. 入站线型别名——恰四个；Gemini 是上游 wire

`/v1/chat/completions`（OpenAI-compatible）、`/v1/messages`（Anthropic-compatible）、`/v1/responses`（OpenAI Responses）、`/v1/systemone`（决策网关）。别名表封闭——其余一律 404。Gemini `:generateContent` 是**出站** provider wire（出站集 `openai|anthropic|google|responses|opencode-proxy`），不是入站别名。systemone 的 `detectSuffix '/systemone'` 刻意**宽于**其 routePath——让 MITM 腿认领途经的 typesafe.ai / bailian 原生决策流量。

### 3. MITM 转发代理——全捕获就是要点

默认姿态：每个 HTTPS CONNECT 都 MITM，除 loopback 与 `bypassHosts`（`forward-proxy/server.ts:15-22`）：SNI peek → `startMitm` → 解密流 splice 进内层 `http.Server`；命中 surface 表且 POST ⇒ dispatch；否则裸字节中继（`relay.ts` splice 带背压；跳逐头集合——connection/keep-alive/TE/trailer/transfer-encoding/upgrade/proxy-*——双向剥离）。请求体 32 MB 上限（413）与非法 JSON（400）都发生在捕获/dispatch **之前**——零事件。裸名消歧走 `upstreamHost` = 被拦截请求的 host（`orchestrator.ts:106-124`；原生腿刻意不信 Host——防伪冒，ADR-0003 §1.5）。

### 4. trace 身份——两腿严格同型

共享入站提取器（`observability/trace-id.ts`）：优先级 `traceparent` > `x-request-id` > `x-trace-id`/`x-correlation-id`/`request-id` > 铸 32-hex（W3C 验而后可用，畸形必重铸、绝不回显）；MITM 读**原始** clientRequest 头。出站注入 traceparent **未实现**（builder 仅测试用）。捕获的 `clientHeaders` 是安全子集 `{userAgent, acceptLanguage, requestId}`；authorization/api-key/cookies 在结构上就进不了 trace 记录。

### 5. requestCapture——HTTP 交换事件，不是轮快照

命名空间：`requestCapture:`——退役的顶层 `capture:`（更名残留）、`classifier.layer2.decisionCapture`、键级 `role` 加载即剥离、保存永不写回；两条控制台保存路径热应用（`routes/console.ts:1074,1098`）。一个命名空间一个含义：**请求/HTTP 交换日志**（训练数据采样是另一个 concern，ADR-0001 §5）。

模型：`HttpExchangeEvent`——每方向每腿一条；一次推理轮产生 2–4 条共享同一 `traceId`：client-request / gateway-response / upstream-request / upstream-response（旧的轮形 `CaptureRecord` @deprecated）。每条事件另带 `conversationKey`（ADR-0002 §1：sha256(apiKey 身份 + 首条用户消息)，内容寻址，无法解析时省略），档案可凭它跨易变 sessionId 重组会话。头部现行制度：**名保留**，凭证形**值** `[REDACTED]`（子串拒单：authorization/api-key/cookie/token/secret/bearer/…-key/key/auth；query 里的 auth 参同遮）。主闸 `enabled:false` 默认——OFF 是**字节同一的零事件姿态**（测试钉死），开是自觉 opt-in（`/api/admin/*` 免鉴权提醒适用）。落盘：`<capture>/<YYYY-MM-DD>/<sanitized-sessionId>.jsonl`，保留 7 天 / 512 MB / 体 64 KB，boot + 逐小时清扫，I/O 全 fail-open。网关响应体 stash 上限 1 MB；客户端断连经传输适配器终结（合成 499）——hang/cancel 也留痕。`/v1/systemone` 面本身永不捕获 FinOps 或 trace 行——捕获只有交换事件。

### 6. System One 面——两腿 opt-in 闸树

`requestCapture.enabled`（总闸，默认 OFF）× `requestCapture.systemone.enabled`（面闸，默认 ON；关掉则**两腿同哑**——客户端一对与 surface 自己的上游一对（原生直通/合成转换皆然），无 purpose 标签）。发射严格晚于全部 400/403/404/503 闸。Layer-2 裁决者的内部调用构成第三闸：`isSystemoneJudgeCaptureEnabled = 总闸 × 面闸 × systemone.l2DecisionEnabled`（默认 ON）——子闸只能**增记**事件（裁决者自己的 HTTP 腿，挂外层被路由请求，upstream 方向，`purpose:'l2-judge'`，唯一的 ExchangePurpose 值），永不越过面闸。OFF 的隐私姿态：`captureProcessContext()` 答 `{}`，该面路径与无捕获构建字节同一（专测钉住）。

### 7. 决策网关（/v1/systemone）——两种上游形态，诚实写进措辞

原生（`provider type:'systemone'`——TypeSafe Jev / decision-model-preview）：直通，零损耗。其余一切：协议**转换**——一条 JSON 受限的 chat completion 携全部问题；由此产生的概率是"自报估计、未经校准"（措辞长在协议类型与 reasonCode 分叉里，ADR-0001 §4）。该面的模型语义：点名模型 = 所点即所得；auto 梯队别名按**纯池投影**解析到访问过滤后池的链头——404 未知/无池、403 被禁、503 解析不出，**绝不**静默回退；裸 `auto`/`default`/省略 → `systemone.defaultModel`；原生上游用注册链头凭证；决策线限流计数但永不本地拒绝（裁决者是请求下腿）。响应头恰三个（冻结契约）：`X-OCR-Model / X-OCR-Systemone-Upstream / X-OCR-Latency-MS`。**同一执行器**同时服务 HTTP 面与 Layer-2 路由裁决——一个实现，两个调用方。

### 8. Responses 续接状态（`responses.persist`）

`/v1/responses` 链存储以内存 L1 Map 为权威；`responses.persist: false` 默认 = 逐字节的纯内存姿态；ON 时向 append-only JSONL 镜像（`<env dataDir>/responses-chain.jsonl`，0600），启动重放（TTL 24h 过滤 → createdAt 序 → 封顶清扫 → 原子压实；边界 20k 节点 / 256KB 单节点 / 64MB 文件 / 每 1000 append 压实一次）。persist 把**重启失忆**缩到"最后一条未刷盘的轮"——链用型客户端若存储滚了，得到的是有文档的显式失败 400（全量重发降级，提示词保住）；磁盘故障只告警、永不拖垮请求；persist-OFF 的链用客户端每进程恰一条告警讲清这层暴露。

## 后果

- 新增一个入站面 = 表里加一行；两种传输自动继承派发、头、捕获、限流行为——逐腿漂移结构性不可能（头模块的注释把旧漂移立为它存在的理由）。
- 捕获答"什么经过了线路"，trace 答"什么被决定并执行"，数据集答"模型该学什么"——三个平面、三个命名空间、任何一把键都不蕴含另一个。
- 隐私姿态默认关/字节同一且有测试钉；opt-in 是两级闸且对暴露范围诚实。

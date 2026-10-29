# ADR-0008: 协议接入面与捕获——双传输一张派发表、交换事件而非轮快照、两腿全链 opt-in

## 状态

已实现 — 2026-10-15（事实面语料重写）。2026-10-21 修订：原生 System One 上游支路（`systemoneUpstreams[]`、厂商直通）**退役**——该面仅经 chat 模型协议转换服务；未来 Jev/Bailian 集成以普通 provider 形式经定义文件接入（ADR-0010）。2026-10-24 修订：写侧 `@ai-sdk/typesafe-ai` → package 映射保留原生 `typesafe` 段，该别名继续留在 npm 词表中——2026-10-23 的降级（改用兼容运行时 + 从下拉框隐藏别名）是回归，现予撤回。客户端可加载性仍是独立一层：客户端没有该段时，写给客户端的那一份由 `CLIENT_PACKAGE_FALLBACK` 替换（ADR-0010 修订案）。2026-10-22 修订：原生 decision 支路**以 wire 驱动方式复职**——解析出的 npm 为 `@ai-sdk/typesafe-ai`（或 opencode v2 segment `typesafe`）的 provider 定义解析到 wire `systemone`，在决策面上以**原生直通调用**服务（§7）；所有 chat wire 模型仍走转换。范围：入站协议面（原生路由 + MITM 代理）、共享派发接缝、System One 决策网关、请求捕获平面。trace/捕获持久化分界 = ADR-0005；数据集采样（**不是**捕获）= ADR-0001；决策面的寻址 = ADR-0003。

## 决策

### 1. 一张表、两种传输、一个接缝

`SURFACES`（`surfaces/table.ts:8-23`）是唯一注册表：每个入站面一行——`routePath / detectSuffix / exec / capture / encodeStream`。同一张表同时驱动 Fastify 路由注册（`server.ts:1044-1056`）与 MITM 路径探测（`detectSurface` 后缀匹配）——限流路由表也由它派生（`INFERENCE_ROUTE_PATHS = SURFACES.map`）。`dispatchSurface` 只按 `exec` 分叉：`chat-pipeline` | `decision-pipeline`。两种传输各自构造 `TransportContext`（`surfaces/types.ts:58-79`）：`method/url/headers/clientIp` + 访问闸（判别联合：Fastify 侧 `kind:'key'`——已验 bearer/x-api-key + 按 key 模型访问，拒绝已由 guard 写成 403；MITM 侧 `kind:'exempt'`——客户端是**穿过**我们连出去的，信任在 CONNECT/TLS 层 + bypass 名单；无网关 key，故捕获事件不带 apiKey 归属，上游调用一律用注册 provider 自己的凭证）+ `captureProcessContext()`（捕获关时答 `{}`）+ 终发（`sendJson` / `beginSse`+`writeSseChunk`+`endSse`）+ `isClientGone()` + `logError`。终发纪律：每请求恰一次终发；parse/gate 失败**零捕获事件**（两腿都在 dispatch 之前）。

### 2. 入站线型别名——恰四个；Gemini 是上游 wire

`/v1/chat/completions`（OpenAI-compatible）、`/v1/messages`（Anthropic-compatible）、`/v1/responses`（OpenAI Responses）、`/v1/systemone`（决策网关）。别名表封闭——其余一律 404。Gemini `:generateContent` 是**出站** provider wire（出站集 `openai|anthropic|google|responses|opencode-proxy`），不是入站别名。systemone 的 `detectSuffix '/systemone'` 刻意**宽于**其 routePath——让 MITM 腿认领途经的 typesafe.ai / bailian 同形决策流量。

### 3. MITM 转发代理——全捕获就是要点

默认姿态：每个 HTTPS CONNECT 都 MITM，除 loopback 与 `bypassHosts`（`forward-proxy/server.ts:15-22`）：SNI peek → `startMitm` → 解密流 splice 进内层 `http.Server`；命中 surface 表且 POST ⇒ dispatch；否则裸字节中继（`relay.ts` splice 带背压；跳逐头集合——connection/keep-alive/TE/trailer/transfer-encoding/upgrade/proxy-*——双向剥离）。请求体 32 MB 上限（413）与非法 JSON（400）都发生在捕获/dispatch **之前**——零事件。裸名消歧走 `upstreamHost` = 被拦截请求的 host（`orchestrator.ts:106-124`；原生腿刻意不信 Host——防伪冒，ADR-0003 §1.5）。

### 4. trace 身份——两腿严格同型

共享入站提取器（`observability/trace-id.ts`）：优先级 `traceparent` > `x-request-id` > `x-trace-id`/`x-correlation-id`/`request-id` > 铸 32-hex（W3C 验而后可用，畸形必重铸、绝不回显）；MITM 读**原始** clientRequest 头。出站注入 traceparent **未实现**（builder 仅测试用）。捕获的 `clientHeaders` 是安全子集 `{userAgent, acceptLanguage, requestId}`；authorization/api-key/cookies 在结构上就进不了 trace 记录。

### 5. requestCapture——HTTP 交换事件，不是轮快照

命名空间：`requestCapture:`——退役的顶层 `capture:`（更名残留）、`classifier.layer2.decisionCapture`、键级 `role`、以及退役的 `requestCapture.systemone` 双闸子树加载即剥离、保存永不写回；两条控制台保存路径热应用（`routes/console.ts:1074,1098`）。一个命名空间一个含义：**请求/HTTP 交换日志**（训练数据采样是另一个 concern，ADR-0001 §5）。

模型：`HttpExchangeEvent`——每方向每腿一条；一次推理轮产生 2–4 条共享同一 `traceId`：client-request / gateway-response / upstream-request / upstream-response（旧的轮形 `CaptureRecord` @deprecated）。每条事件另带 `conversationKey`（ADR-0002 §1：sha256(apiKey 身份 + 首条用户消息)，内容寻址，无法解析时省略），档案可凭它跨易变 sessionId 重组会话。头部现行制度：**名保留**，凭证形**值** `[REDACTED]`（子串拒单：authorization/api-key/cookie/token/secret/bearer/…-key/key/auth；query 里的 auth 参同遮）；`requestCapture.redactSecrets`（默认 true）是运营者**退出脱敏**的开关——置 false 后命中拒单的头与 query 值原样落盘（含上游 provider 真实密钥），由 `CaptureRecorder` 统一下发，构造与热应用一致。主闸 `enabled:false` 默认——OFF 是**字节同一的零事件姿态**（测试钉死），开是自觉 opt-in（`/api/admin/*` 免鉴权提醒适用）。落盘：`<capture>/<YYYY-MM-DD>/<sanitized-sessionId>.jsonl`，保留 7 天 / 池 2048 MB / 单体上限 16 MB（按“一份满载的 2M-token 上下文能完整落盘”定标） / 单会话封顶 512 MB——触及封顶的会话档案停止追加，并落一条终态 `archive-overflow` 行；该行是元数据，读取侧不得将其计作一轮。封顶的因由：agent 循环每轮重发全量历史，呈 O(turns²) 增长，一个失控会话不得吃掉共享配额；预算为软上限（并发追加最多多出一行）。控制台尾读窗口随单体上限缩放（8 MB 下限 / 48 MB 封顶），完整历史恒可经导出取得（导出不封顶）。读取面（控制台）：`readEvents` 改为**异步**——fs.promises 窗口读 + 按 128 行一批让出事件循环的解析——档案读取不再阻塞网关事件循环；`bodies=none`（控制台元数据优先默认）剥离解析后事件的 wire body，并在读取时给每条响应事件盖上派生的 `completionTokens`（响应体内最后一次 usage 计数），tok/s 速率章在无 body 时照常渲染；完整 body 经 `GET /api/admin/capture/:date/:file/turn?id=<client-request 事件 id>` 按轮取回，或以 `bodies=full` 重读。跨零点会话由读取侧拼接：事件窗口与按轮端点均支持 `stitched=1`，把同一会话跨日期的分片合并（`readEventsStitched`/`readTurnStitched`；分片发现经 `listSessionsWithSpans`，限定为缓存的 ≤64 KB 头部读取，会话行带 `spanDates`）；前端把跨日跨度渲染为徽章加逐日分隔线。会话行另带 `protocol`——由首条 client-request 事件的请求行派生的入站面（`/v1/chat/completions` → chat、`/v1/messages` → anthropic、`/v1/responses` → responses、`/v1/systemone` → systemone；无请求行的旧档案保持 undefined = 无徽标）——且预览/轮提示提取器把 System One 请求体的 `state`（字符串或结构化 JSON，封顶）视为用户文本，决策面会话由此获得内容标题而非裸 sessionId。boot + 逐小时清扫，I/O 全 fail-open。网关响应体 stash 上限 1 MB；客户端断连经传输适配器终结（合成 499）——hang/cancel 也留痕。`/v1/systemone` 面本身永不捕获 FinOps 或 trace 行——捕获只有交换事件。

### 6. System One 面——单总闸捕获

退役的双闸树（`requestCapture.systemone.{enabled, l2DecisionEnabled}`——面闸默认 ON，外加决策调用子闸默认 ON）加载即剥离、保存永不写回：两闸默认值都是 TRUE，只会收窄一个本已显式的隐私 opt-in，代价是让捕捉卡片读起来像 System One 面配置（面向操作者的混淆，2026-12 退役）。单一 `requestCapture.enabled` 总闸（默认 OFF）现在门控每条腿——`/v1/systemone` 客户端一对、该面自己的上游一对（按解析 wire 的原生直通或合成转换调用，无 purpose 标签）、以及 Layer-2 决策层的内部调用腿（挂外层被路由请求，upstream 方向，`purpose:'l2-decision'`，唯一的 ExchangePurpose 值；总闸不开时编排器根本不向决策层传捕获 ctx）。发射严格晚于全部 400/403/404/503 闸。OFF 的隐私姿态：`captureProcessContext()` 答 `{}`，该面路径与无捕获构建字节同一（专测钉住）。

### 7. 决策网关（/v1/systemone）——wire 驱动，诚实写进措辞

该面的模型语义：点名模型 = 所点即所得；auto 梯队别名按**纯池投影**解析到访问过滤后池的链头——404 未知/无池、403 被禁、503 解析不出，**绝不**静默回退；裸 `auto`/省略 → `systemone.defaultModel`；决策线限流计数但永不本地拒绝（决策层是请求下腿）。响应头恰三个（冻结契约）：`X-OCR-Model / X-OCR-Systemone-Upstream / X-OCR-Latency-MS`。**同一执行器**同时服务 HTTP 面与 Layer-2 路由决策层——一个实现，两个调用方。控制台的智能分配决策模型（`POST /api/admin/client/:client/smart-assign`，以及只读的 `GET /api/admin/decider/resolve` 探针——它回答一次选择实际落在哪个物理模型上）是**第三个调用方**，复用**同一条**别名级联：物理 id、combo 主成员、档位别名→决策面池链头、裸 `auto` → `systemone.defaultModel`——同一个名字在控制台里只有一个含义；控制台调用不带 API key，访问过滤在此为空操作；解析不出的选择直接 400 拒绝，绝不静默替换。

两条执行支路，由解析出的模型 wire 选择（永不由配置表选择）：

- **原生直通（wire `systemone`）**——2026-10-22 修订。解析 npm 为 `@ai-sdk/typesafe-ai`（opencode v1 字符串，或直接写进 defs 文件的 opencode v2 segment `typesafe`）的 provider 定义经共享 `wireFor()` 解析到 wire `systemone`；模型以 `wire: 'systemone'` 进入启动池，决策执行器**直接调用**厂商决策端点：`POST {baseUrl}/systemone`，Bearer 鉴权取自 provider 凭证链，请求体 = 客户端 `{model, state, questions, …}` 形状、model id 改写为 `upstreamModel`，响应 answers **原样透传**（未知 answer 类型如 `box` 不做二次猜测）。chat 池**永不见**这些模型（`getCandidateModelsForTier` 默认排除 `wire === 'systemone'`，仅决策面显式传入时包含）——decision 协议无法应答 chat，把 chat 路由到其上只会把网关自身的错配归咎于上游。厂商 npm 契约由 `@ai-sdk/typesafe-ai` SDK 本体钉死（v3）：`languageModel` 直接 throw `NoSuchModelError`；只有 decision 模型存在，端点 `POST {baseURL}/systemone`，`{model, state, questions}` + Bearer `TYPESAFE_AI_API_KEY`。
- **协议转换（其余所有 chat wire）**——一条 JSON 受限的 chat completion 携全部问题；由此产生的概率是"自报估计、未经校准"（措辞长在协议类型与 reasonCode 分叉里，ADR-0001 §4）。

`X-OCR-Systemone-Upstream` 携带实际采取的支路（`native` / `converted`）——让两条路径在线上可分辨的诚实标记。2026-10-21 退役的 `systemoneUpstreams[]` 配置支路保持退役：原生支路以**数据**（defs 文件的 npm，ADR-0010）回归，而非配置节。

### 8. Responses 续接状态（`responses.persist`）

`/v1/responses` 链存储以内存 L1 Map 为权威；`responses.persist: false` 默认 = 逐字节的纯内存姿态；ON 时向 append-only JSONL 镜像（`<env dataDir>/responses-chain.jsonl`，0600），启动重放（TTL 24h 过滤 → createdAt 序 → 封顶清扫 → 原子压实；边界 20k 节点 / 256KB 单节点 / 64MB 文件 / 每 1000 append 压实一次）。persist 把**重启失忆**缩到"最后一条未刷盘的轮"——链用型客户端若存储滚了，得到的是有文档的显式失败 400（全量重发降级，提示词保住）；磁盘故障只告警、永不拖垮请求；persist-OFF 的链用客户端每进程恰一条告警讲清这层暴露。

## 后果

- 新增一个入站面 = 表里加一行；两种传输自动继承派发、头、捕获、限流行为——逐腿漂移结构性不可能（头模块的注释把旧漂移立为它存在的理由）。
- 捕获答"什么经过了线路"，trace 答"什么被决定并执行"，数据集答"模型该学什么"——三个平面、三个命名空间、任何一把键都不蕴含另一个。
- 隐私姿态默认关/字节同一且有测试钉；opt-in 是两级闸且对暴露范围诚实。

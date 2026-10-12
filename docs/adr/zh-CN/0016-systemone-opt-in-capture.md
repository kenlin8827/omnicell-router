# ADR-0016：requestCapture——System One 两腿 Capture 与 capture/数据集分家

## Status

提议 (Proposed) — 2026-10-12。Layer: surface。Scope: capture。Domain:
observability。
本记录同日重写为最终批准树（见 Decision Outcome）。本记录更早的几轮
——经 `capture.systemoneEnabled` 的选择性开启客户端腿 capture、
`capture.l2DecisionEnabled` 命名空间迁移，以及从未发布的中间命名
`requestCapture.systemone.clientEnabled`——均被本次重写取代，其历史
保留在 Key-lineage & ambiguity guard 一节。
本记录取代 ADR-0014 §4 的 capture-records 一支（客户端腿为"取代"且当日
补全为全链路，judge 腿为"扩展"），并取代 §5 数据集一支的成文形态（键名、
封顶；默认维持 OFF）。ADR-0014 已实现且不可变更；取代关系由本记录承载，ADR-0015
的 "Amendment to ADR-0014" 一节已加指向本最终树一行的注。

## Context and Problem Statement

运维者只有一套 capture/可观测性控制台，覆盖整个网关。其余所有 HTTP
接入面都会向它投递交换事件——chat、anthropic、responses，两条传输腿
都算上（原生 `/v1` 与 MITM 腿，ADR-0015）。唯独 `POST /v1/systemone`
是例外：按 ADR-0014 §4 保持沉默（§4 原句已在 Key-lineage & ambiguity
guard 逐字钉住）。在一套别处全可见的控制台里，一个一等接入面在
capture 页面上完全隐形，这让运维者困惑——决策流量只能去别处审计，
或者根本无从审计。放回语境里读，§4 的沉默是 v1 交付的范围纪律，不是
反可观测性立场。默认姿态应当是"运维者什么都不改时看到的行为"；但
选择权本身，归运维者。

这一天内的演进史，如实压缩如下：

1. 第一轮：在 `capture.systemoneEnabled`（默认 OFF）之后选择性开启客户端
   腿 capture——解决了控制台盲区，但 `capture:` 伞盖依旧只有一个。
2. 第二轮（即"B 案"命名空间迁移）：ADR-0014 §5 的决策采样开关从
   `classifier` 树迁出，进入 `capture.l2DecisionEnabled`，被三道
   `capture.*` 开关串联把关。
3. 这次迁移暴露了更深的歧义：`capture.*` 同时容纳了两种不同的持久化
   语义。HTTP 交换 capture 是一份归档（目录、保留期、总量封顶、请求头
   脱敏、capture 页面）；而数据飞轮的训练数据集是一个封顶的 jsonl
   文件，存 (state, answer, tier) 样本——蒸馏原料，永不出现在 capture
   页面。一个命名空间从此有了两个主语；数据集开关住在 capture 伞盖
   之下，暗示了一个假的等式：样本是 capture 记录。
4. 最终重构：按主语（SUBJECT）分离。`requestCapture:` = 请求/HTTP 交换
   日志，仅此而已。`classifier.layer2.collectEnabled` = 数据集采样，仅此
   而已。同时交换 capture 新增一条 §4 从未涉及过的腿：Layer 2 judge 的
   内部上游调用。

问题：按主语拆开两种持久化语义，把 systemone 交换 capture 的逐腿控制权
交给运维者，同时让零配置部署见到的一仍分毫不差是 ADR-0014 §4 的姿态。

## Decision Drivers

- 控制权归运维者；默认值守住隐私总闸。
- 一个命名空间一个含义：键住在哪里，就说明什么东西在落盘。
- 默认安全：零配置变更 = 零条交换事件。
- 结构性保证优于约定——类型、加载时的响亮告警、不变量测试（即
  ADR-0015 之道）。
- 控制台一致性：一等接入面不得隐形；每条被记录的腿都以具名标记
  （`purpose`）如实披露。
- 迁移诚实：每个退役键发出一次响亮告警，且只点名一个继任者。

## Considered Options

### A. 两种语义继续同住一个 `capture:` 伞盖（当日第二轮）

**Pros**

- 单一隐私链：总闸 → 面 → 细节，全在一个命名空间。
- 数据集开关不必第三次改名。

**Cons**

- 一个命名空间两个持久化主语——治盲区的药反而把迁移刚暴露的歧义制度化。
- `capture.l2DecisionEnabled`（数据集）将与 judge 腿 capture 开关永远撞名：
  同样的词，不同的主语。
否决（本次重写正是为了解开这个状态）。

### B. 按主语分家：`requestCapture:` + `classifier.layer2.collectEnabled`（选定）

**Pros**

- 每个命名空间恰好说清一件事：交换日志 vs 数据集采样。
- 开关住在各自主语旁边；门禁收缩为真实的门链。
- 逐腿子节点把控制权交给运维者，且总闸一开即全量披露。

**Cons**

- 数据集开关两天内第三次改名（谱系表 + 加载告警承载；键龄仅一天）。
- 两个名字相似的最终开关（`collectEnabled` 与 `systemone.l2DecisionEnabled`）
  需要明示的防歧义护栏。

### C. 数据集开关退回原名 `classifier.layer2.decisionCapture`

**Pros**

- 与 ADR-0014 §5 成文零差异。

**Cons**

- 把 "capture" 一词放回一个非 capture 的主语上——正是要治的那个歧义。否决。

## Decision Outcome

选定方案："B. 按主语分家"——因为一个命名空间只能有一个含义。以下每一个
键、每一个默认值都服从同一条原则：控制权归运维者，默认值守住隐私总闸
（CONTROL BELONGS TO THE OPERATOR, DEFAULTS PRESERVE THE PRIVACY MASTER）。

最终批准树（冻结契约，2026-10-12）：

```yaml
requestCapture:                     # 由 `capture:` 更名而来——只放请求
  enabled: false                    # capture（一个命名空间一个含义）。
                                    # 隐私总闸：选择性开启，默认值不变。
  retentionDays: 7                  # 归档成员：名称、默认值、语义全部
  maxTotalMB: 512                   # 不变——只有节的标题搬了家。
  maxBodyBytes: 65536
  dir: ~/.opencode-router/capture
  systemone:                        # 面总闸 + judge 腿子开关
    enabled: true                   # System One SURFACE MASTER（面总闸）——
                                    # 关闭时两腿同哑：客户端直连 /v1/systemone
                                    # 与 MITM 腿的 HTTP 交换事件
                                    # （旧名 capture.systemoneEnabled；中间
                                    # 命名 clientEnabled 从未发布）连同
                                    # 下方 judge 腿。
    l2DecisionEnabled: true         # 子开关（仅当 systemone.enabled 为 true
                                    # 时生效）：新增：Layer 2 路由 judge 的
                                    # 内部 systemone 决策调用，作为上游腿
                                    # http-exchange 事件记录，挂在【外层
                                    # 被路由请求】的 trace/session 上，
                                    # purpose='l2-judge'。只增记裁判自己的
                                    # 线路调用，与客户端腿主语正交。
                                    # 不是客户端请求；关闭 = 今日静默行为。
classifier.layer2:
  enabled: true                     # judge 到底跑不跑——正交的特性开关，
                                    # 本记录不动它。
  collectEnabled: false             # 训练数据集开关（旧名
                                    # classifier.layer2.decisionCapture，
                                    # 一度叫 capture.l2DecisionEnabled）：
                                    # (state, answer, tier) →
                                    # data/layer2-decisions.jsonl。
                                    # 单键门禁，热应用，64MB 硬封顶后
                                    # 停写 + 恰好一条告警。
                                    # 不是 capture；不上 capture 页面。
```

### 决策 1 — `capture:` 更名为 `requestCapture:`（加载时节迁移）

- 本节只放请求/HTTP 交换日志；名字说明落盘的是什么：请求的交换记录。
- 成员身份不变：`enabled`、`retentionDays`、`maxTotalMB`、
  `maxBodyBytes`、`dir`——默认值与语义原样。
- 加载时节迁移：旧 `capture:` 节在加载时映射进 `requestCapture:`，并发出
  一次响亮告警：
  - 普通成员按名映射（`capture.enabled` → `requestCapture.enabled`，其余
    归档成员同理）；
  - `capture.systemoneEnabled` → `requestCapture.systemone.enabled`（面
    总闸；从未发布的中间命名 `requestCapture.systemone.clientEnabled` 若
    出现在解析结果中，同样防御性地并入 `enabled`），告警中点名；
  - `capture.l2DecisionEnabled` → `classifier.layer2.collectEnabled`，
    并带上 Key-lineage & ambiguity guard 一节的防歧义措辞。
- 控制台保存即剥离旧键：经控制台保存的配置只写回最终树——一次告警、
  一次迁移，没有永久兼容层。
- `requestCapture.enabled` 仍是隐私总闸：默认 `false`；翻开它才是那个
  "选择性开启"动作。

### 决策 2 — `requestCapture.systemone` 节点（面总闸 + judge 子开关）

- `systemone.enabled`（默认 `true`）：System One 面总闸（SURFACE
  MASTER）——关闭时两腿同哑。开启时，本开关的腿为全链路（FULL-CHAIN）
  HTTP 交换事件：客户端直连
  `POST /v1/systemone`
  与认领 `/systemone` 的 MITM 腿——客户端请求、本面自己的上游调用
  （原生直通/合成转换）、网关响应，两条传输腿皆然（ADR-0015 接缝）。
  旧名 `capture.systemoneEnabled`；
  中间命名 `clientEnabled` 从未进入任何线上配置。
- 生效门禁（客户端腿）：
  `requestCapture.enabled && requestCapture.systemone.enabled`。
- 本组开关默认 `true`，因为总闸才是选择性开启动作：翻开
  `requestCapture.enabled` 就应换来本面的完整披露，而不是第二轮找开关。
  默认部分开启的腿会在明确的"capture 已开"决定之下重新制造隐形流量。
- 类型接缝（ADR-0015 的 surface 表）：`DecisionSurface.capture` 由字面量
  `false` 拓宽为字面量 `'configurable'`——本面的 capture 在运行时按配置
  解析，绝不因意外而开启。`ChatSurface.capture` 保持 `true`。

### 决策 3 — judge 腿 capture（新能力）

- 记录什么：Layer 2 路由 judge 的内部 systemone 决策调用
  （`runSystemoneDecision`），作为上游腿 http-exchange 事件记录。
- 挂在哪里：外层被路由请求的 trace/session——即触发该次裁决的客户端
  请求。这不是客户端请求：judge 不是一个接入面，不立独立记录。
- 每条这样的事件都带 `purpose='l2-judge'`。
- 生效门禁：`requestCapture.enabled &&`
  `requestCapture.systemone.enabled`（面总闸）&&
  `requestCapture.systemone.l2DecisionEnabled`（子开关，仅在面总闸开启时
  生效）。关闭 = 今日静默行为：
  judge 腿零条交换事件。
- 这是对 §4 记录类的扩展（EXTEND），不是对客户端一支的简单恢复：§4
  排除的是 HTTP 接入面的 capture；judge 的内部线路流量此前根本没有
  capture 叙事。
- 竞速落败者的诚实披露：judge 的 `timeoutMs` 可能在 Layer 1 / Layer 2
  竞速中落败，而线路调用仍在继续——provider 各自持有 AbortController，
  转换路径无法中途取消（ADR-0014 §5）。capture 记录的是线路事实，不是
  竞速结果：两次真实调用都可能被记录——胜者的与落败者的。数据集通路
  维持"仅竞速获胜路径"的既有规则；两个落盘处各自的语义不同，这是
  有意为之。

### 存续 limb（自第一轮承接，键名已更新）

- 门禁次序（客户端腿）：parse-400 与访问门禁 403/404 不产生任何事件——
  capture 在门禁之后发出，与 chat 面镜像一致。
- 脱敏：共享 capture 记录器的请求头脱敏对两条腿同样生效——凭证形态的
  值（`authorization` 等）落盘即 `[REDACTED]`；正文受
  `requestCapture.maxBodyBytes` 截断。
- 存储：交换事件只落 `requestCapture` 归档（dir / retentionDays /
  maxTotalMB）；决策 3 的任何内容都不写入 `data/layer2-decisions.jsonl`，
  任何数据集样本也不出现在 capture 页面。
- 强制层：配置默认（总闸 OFF）、`'configurable'` 类型字面量、不变量
  测试——既有零事件守卫（`backend/tests/forward-proxy-systemone.test.ts`，
  "systemone capture exemption"）转为 DEFAULT-OFF 守卫继续绿；on-path
  测试钉住脱敏请求头（`authorization: [REDACTED]`，端到端）与 judge 腿的
  `purpose='l2-judge'` 事件。

## Key-lineage & ambiguity guard

本决策动过的每一个键，按新旧排列的完整链——拒绝静默改名：

| 主语 | 键链（最早 → 最终） | 语义 |
| --- | --- | --- |
| 数据集采样 | `classifier.layer2.decisionCapture` → `capture.l2DecisionEnabled` → `classifier.layer2.collectEnabled` | (state, answer, tier) → 封顶 jsonl；训练原料 |
| 客户端腿交换 | `capture.systemoneEnabled` →（`requestCapture.systemone.clientEnabled`——从未发布）→ `requestCapture.systemone.enabled` | HTTP 交换事件，两条传输腿；面总闸关闭时两腿同哑 |
| judge 腿交换 | （无——新增）→ `requestCapture.systemone.l2DecisionEnabled` | 上游腿 http-exchange 事件，`purpose='l2-judge'`；子开关仅在面总闸之下生效 |

### 防歧义护栏——两个名字相似的最终开关

`classifier.layer2.collectEnabled` 与
`requestCapture.systemone.l2DecisionEnabled` 是两个不同的开关，本记录把
区别钉死，防止任何读者把它们合并：

- `collectEnabled` = 数据集采样 → `data/layer2-decisions.jsonl`；训练
  飞轮；不上 capture 页面。
- `systemone.l2DecisionEnabled` = 交换 capture → capture 归档与页面；
  judge 线路调用的 HTTP 事件。
- 退役键告警只把数据集旧键（`classifier.layer2.decisionCapture`、
  `capture.l2DecisionEnabled`）指向 `collectEnabled`，且告警文本明示：
  `requestCapture.systemone.l2DecisionEnabled` 是另一个开关——绝不会被
  当作它们的继任者提供。

### Supersession of ADR-0014 §4 and §5 (ADR-0014 itself untouched)

§4——capture-records 一支。钉住的原句
（`docs/adr/0014-systemone-protocol-gateway.md`，§4）：

> Deliberately out of v1 scope: circuit-breaker tripping and outcome recording (alias resolution READS breaker availability to gate the tier pick, but never trips or records on this surface), FinOps accounting, trace/flywheel/capture records and decision caching; native upstream 4xx/5xx statuses are mirrored to the caller.

状态：`trace/flywheel/capture records` 中的 `capture records`，就面向客户
端的 HTTP 接入面而言已被取代且当日补全为全链路（决策 2）；就 judge 腿而言是扩展（EXTEND）
而非恢复——其上游线路流量本就不在 §4 的叙述之内（决策 3）。§4 其余排除
继续有效，在此逐条重申以防漂移：

- 熔断器触发与结果记录——仍排除；
- FinOps 计费——仍排除；
- trace/flywheel/session 记录——仍排除；
- 本面的决策缓存——仍排除；
- 客户端请求的上游腿交换事件（合成的转换调用与原生直通）——不再排除：
  被捕捉的面请求为全链路（当日补全），上游腿以本面自身身份记录、无
  purpose 标记（本腿在自己的 turn 内不歧义）。决策 3 只管 judge 自己的
  内部调用。

§5——数据集一支。钉住的原句（§5）：

> Opt-in decision capture (`classifier.layer2.decisionCapture`, default OFF): judged (state, answer, tier) pairs land in `data/layer2-decisions.jsonl` — the raw material for distilling a native decision model and for calibrating converted confidence. Recorded only on the race-winner path; nothing consumes the file yet.

状态：该支按其成文形态已被取代——键退役（见上方谱系链）、新增 64MB 硬封顶
（停写 + 恰好一条告警）；默认值维持 OFF（样本含会话内容，保持手动开启）。
特性本身完整存续：同样的三元组、同样的落盘文件、同样只在竞速获胜路径
上记录的规则。0014 §5 原文一字不动地作为历史保留；ADR-0014 本身
Accepted/Implemented 且不可变更——不做任何编辑。

取代关系全图：

- 0014 §4——capture-records 一支：客户端腿"取代"、judge 腿"扩展"；
  §4 其余排除继续有效。
- 0014 §5——数据集一支：成文形态被取代（键 + 默认值 + 封顶）；特性
  在 `classifier.layer2.collectEnabled` 存续。
- ADR-0016 自己的更早两轮——`capture.systemoneEnabled` 选择性开启与
  `capture.l2DecisionEnabled` 迁移：被本次重写取代；键链见上。
- ADR-0015 "Amendment to ADR-0014" 一节曾声明该支 "REMAINS binding"；
  此论断已被超越——该节现已加一行指向本最终树。

## Defaults disclosure

| 键 | 默认值 | 效果 |
| --- | --- | --- |
| `requestCapture.enabled` | `false` | 隐私总闸，选择性开启，默认值不变——零配置部署发出零条交换事件（0014 §4 姿态分毫不差存续） |
| `requestCapture.systemone.enabled` | `true` | System One 面总闸——关闭时两腿同哑；开启时被捕捉的面请求为全链路（客户交换一对 + 本面上游调用一对） |
| `requestCapture.systemone.l2DecisionEnabled` | `true` | capture 总闸与面总闸同时 ON 时，judge 腿交换事件（`purpose='l2-judge'`）随开 |
| `classifier.layer2.collectEnabled` | `false` | 数据集采样手动开启（样本含会话状态）；开启后 judge 决策即写入（单键门禁——不受 capture 总闸管辖） |

- 数据集封顶：`data/layer2-decisions.jsonl` 在 64MB 硬封顶，随后停写 +
  恰好一条告警。它是一个有界的飞轮文件，不是归档；保留期设置对其
  不适用。
- 所有开关均热应用——capture 总闸、`systemone` 面总闸及其 judge 子开关、
  `collectEnabled`。
  本树中不存在任何重启快照。
- 披露诚实：翻开 capture 总闸即默认启用 systemone 的两条腿（面总闸与子
  开关均默认 `true`）。只要面自身双腿、不要裁判腿的运维者需设 `l2DecisionEnabled: false`；
  想让整个决策面静默的运维者设 `systemone.enabled: false`。
- 迁移成本：在途的每个键都出生于 2026-10-11/12（ADR-0014 §5 与本记录
  各轮）；对线上配置的影响可忽略，加载时的响亮告警覆盖一切漂移。

## Consequences

**Positive**

- systemone 进入 capture 控制台，与其他 HTTP 面一视同仁。
- 一个命名空间一个含义：`requestCapture` 是交换日志；数据集开关住在
  它所服务的 classifier 旁边。
- 逐腿控制权交给运维者；总闸一开即完整披露。
- judge 腿可见性纯属新增：路由决策自此端到端可审计，且对竞速落败者
  诚实披露。
- 强制层层叠：配置默认 + 类型字面量 + 加载迁移告警 + 不变量测试。

**Negative / Risks**

- 两个名字相似的 l2 开关并存；防歧义护栏是文档、告警与评审的常驻税负。
- 本组开关默认 `true`：capture 总闸一翻两腿同开。停留在第一轮心智（面开关默认
  OFF）会低估披露范围。已在 Defaults disclosure 明示。
- 开启后客户端状态快照与 judge 线路流量都会落盘（请求头脱敏；正文受
  `requestCapture.maxBodyBytes` 截断）——与 chat capture 同一风险等级，
  覆盖面更大。
- `collectEnabled` 默认维持 OFF（保留 0014 §5 姿态——样本含会话内容）：
  单键手动开启；开启后 64MB 封顶、停写 + 一次告警、热生效。
- 面请求为全链路捕捉（客户一对 + 上游一对）：该面每请求事件量翻倍——
  受 maxTotalMB/保留天数约束。
- 须常绿的测试 limb：默认-关与显式-关零事件守卫；on-path 全链路 + 脱敏请求头
  钉查；`purpose='l2-judge'` 事件钉查；竞速落败记录的诚实性钉查。

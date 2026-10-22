# 架构决策记录 (Architecture Decision Records - 中文版)

> English version is available at [../README.md](../README.md).

本项目采用架构决策记录（Architecture Decision Record, ADR）来沉淀核心设计决策、背景动因及其权衡（Trade-offs），确保项目演进过程中的架构一致性与可追溯性。

> **语料重置 2026-10-15：** 历史编号（0001–0021）已被有意清除（commit 285e913 及后续）。本树按**现行代码事实**重新推导——每篇记录的是已落地的行为，而非抵达它的演进过程。跨切面词汇契约：断路器状态 `CLOSED/HALF_OPEN/OPEN` 只属于 `CircuitBreaker` 层；模型级聚合读能力词 `available/recovering/unavailable`（ADR-0004）；历史 `ModelRef/ModelIdentity` 类型名从未落地代码，不得复活（ADR-0003）。

## ADR 索引清单

| 编号 | 标题 | 状态 | 日期 | 核心摘要 |
| :--- | :--- | :--- | :--- | :--- |
| [ADR-0001](./0001-routing-pipeline.md) | 路由流水线——级联定档、裁决缓存 | **已实现** | 2026-10-21 | layer0 显式选择 / layer2 裁决级联 / 硬编码 plus 基线；响应缓存被禁、决策可缓存；出厂质量优先默认 |
| [ADR-0002](./0002-sessions.md) | 会话——身份、棘轮、钉扎驱逐、凭证亲和 | **已实现** | 2026-10-15 | 七层零 Header 身份；单调棘轮；钉扎按 config∨health 驱逐 + 着陆守卫 + 回写；亲和 = 仅强制故障转移、永不回切 |
| [ADR-0003](./0003-model-addressing-and-tier-membership.md) | 模型寻址与梯队成员制 | **已实现** | 2026-10-15 | 一条解析阶梯（别名→精确 id→变体→裸上游名→combo→分类器）；members 列表 = 唯一成员权威；combo 池自持；按 key 策略四层强制；思考级别诚实规则 |
| [ADR-0004](./0004-resilience-and-health.md) | 容错——分类、断路器、健康视图、整形 | **已实现** | 2026-10-15 | 七类错误 scoped 跳闸；消耗门 vs 非消耗 peek；热规则树且 OFF 语义成文；`ModelHealthView` 能力词汇；断路器记忆分环境、行政标记属全局；限流另立一轴 |
| [ADR-0005](./0005-execution-topology.md) | 执行拓扑——纯直连、单一咽喉 | **已实现** | 2026-10-15 | 纯直连执行；启动池 = 定义文件+store+目录（不可路由 → 上报排除，不炸启动）；`executeCandidatePool` 唯一漏斗；两级重试经济性；SSE 重分块；压缩族 + 压缩前指纹；实测成本不做省钱表演 |
| [ADR-0006](./0006-credential-store.md) | 凭证存储——能力旗标、密钥哈希身份 | **已实现** | 2026-10-15 | 两适配器 + 只读变体；按能力分支永不按 kind；SQLite 只读 / HTTP 独写；证据梯 factory、每启动粘滞；仅推式收敛 + authWriteDisabled；sha256(key) 身份锚熔断/嫌疑/亲和；OAuth 各门皆外 |
| [ADR-0007](./0007-environments-and-bootstrap.md) | 环境——账本目录、重启切换、导出/导入 | **已实现** | 2026-10-15 | 单一目录布局无 legacy 分支；OCR_ENV>指针>default（customPath ≠ 杠杆）；切换 = 受控重启（两类子进程 PORT/HOST 纪律不同）；'ocr-env' 信封默认脱敏、封闭白名单、导入守卫成栈；废纸篓删除 |
| [ADR-0008](./0008-protocol-surfaces-and-capture.md) | 接入面与捕获 | **已实现** | 2026-10-15 | 一张派发表双传输；入站别名恰四个；MITM 全捕获姿态；requestCapture = HTTP 交换事件（每轮 2–4 条）、凭证值掩码、默认关字节同一；systemone 两腿闸树 + 概率诚实措辞；responses.persist 失忆边界 |
| [ADR-0009](./0009-quota-probing.md) | 额度跟踪——分层知识、声明式探测 | **已实现** | 2026-10-15 | 覆盖随 release、激活随凭据；四层（头收割预留 / 声明表 / 代码 adapter / 用户表）；12 构件 DSL、五类禁例结构上写不出；铁律只约束用户配置；探测失败≠额度失败；只展示不门控路由；熔断汇聚点写 quota_events 账本 |
| [ADR-0010](./0010-provider-def-ownership.md) | Provider 定义归属——OCR 定义文件，opencode.jsonc 物化目标 | **已实现** | 2026-10-19 | 连接定义真相落于 `<ocrHome>/custom-providers.json`（jsonc 保形移植、解析器不动）；opencode.jsonc 退出真相链——同步客户端物化目标（推定义只写不读，reload 自愈存活）；boot pool 换源；一次性 jsonc 导入带 marker；v1 只推 key；页面去 opencode 化 |
| [ADR-0011](./0011-route-entries-and-retry-escalation.md) | 路由经验表与重试升档 | **已实现** | 2026-10-21 | 持久化按 prompt 记忆（可人工编辑、片段可关）；写入白名单 human > correction > l2_confident；经验命中短路判定器；重复提问阶梯思考档+1 → 梯队+1（A3 能力上限跳步）；routing-ledger 仅哈希审计；escalateOnRetry=false 即影子模式 |
| [ADR-0012](./0012-judge-emitted-thinking-effort.md) | 裁判产出的思考级别——决策完整性 | **已实现** | 2026-10-21 | 裁判在一次 System One 调用中同答 {tier, effort}（仅客户端省略时提问）；`effortSource` 来源归因（client/judge/entry/escalation/default）落到 trace 与 X-OCR-Thinking-Source 头；逐轮浮动不进棘轮；经验表双向学习级别；缓存命名空间随开关分裂；`classifier.layer2.effortDecision` 默认关 |
| [ADR-0013](./0013-failure-events-ledger.md) | 失败事件账本——模型调用失败观测 | **已实现** | 2026-10-21 | 每次失败的上游模型调用一条事件（业务池 + 裁判两发射点，fail-open，「算调用不算拒绝」边界）；`errorClass` = 分类器类别 ∪ TIMEOUT；10s 风暴合并 ×N；ring + traces.db 镜像（quota_events 先例，无配置开关）；裁判静默 catch 接节流告警；`GET /api/admin/failure-events` + 失败观测页（按模型聚合卡带 + 同一过滤视图的事件列表，支持单事件 DELETE） |
| [ADR-0014](./0014-entry-mode-autonomy.md) | 入口模式自治权——梯队与思考级别切换矩阵 | **已实现** | 2026-10-21 | 仅 auto 家族（`auto`/分类器名）可凭判定移动梯队——棘轮拦截、重试阶梯、schema 级联、plus 池尾全部收门禁于它；强制梯队（梯队别名/模式杠杆/`force_tier`）即契约逐字服务（'explicit' 会话模式，无级联、无池尾）；显式模型仅梯队内故障转移 + pin 回写；combo 完全旁路；思考级别推断同样仅限 auto（能力钳制 + 模型 defaultEffort 全模式适用但不属判定） |

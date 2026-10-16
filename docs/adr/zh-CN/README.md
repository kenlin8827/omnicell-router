# 架构决策记录 (Architecture Decision Records - 中文版)

> English version is available at [../README.md](../README.md).

本项目采用架构决策记录（Architecture Decision Record, ADR）来沉淀核心设计决策、背景动因及其权衡（Trade-offs），确保项目演进过程中的架构一致性与可追溯性。

> **语料重置 2026-10-15：** 历史编号（0001–0021）已被有意清除（commit 285e913 及后续）。本树按**现行代码事实**重新推导——每篇记录的是已落地的行为，而非抵达它的演进过程。跨切面词汇契约：断路器状态 `CLOSED/HALF_OPEN/OPEN` 只属于 `CircuitBreaker` 层；模型级聚合读能力词 `available/recovering/unavailable`（ADR-0004）；历史 `ModelRef/ModelIdentity` 类型名从未落地代码，不得复活（ADR-0003）。

## ADR 索引清单

| 编号 | 标题 | 状态 | 日期 | 核心摘要 |
| :--- | :--- | :--- | :--- | :--- |
| [ADR-0001](./0001-routing-pipeline.md) | 路由流水线——级联定档、裁决缓存、双飞轮 | **已实现** | 2026-10-15 | layer0 显式选择 / layer1 CPU 特征 / layer2 裁决级联；响应缓存被禁、决策可缓存；出厂质量优先默认；数据集与执行飞轮两命名空间分家 |
| [ADR-0002](./0002-sessions.md) | 会话——身份、棘轮、钉扎驱逐、账号亲和 | **已实现** | 2026-10-15 | 七层零 Header 身份；单调棘轮；钉扎按 config∨health 驱逐 + 着陆守卫 + 回写；亲和 = 仅强制故障转移、永不回切 |
| [ADR-0003](./0003-model-addressing-and-tier-membership.md) | 模型寻址与梯队成员制 | **已实现** | 2026-10-15 | 一条解析阶梯（别名→精确 id→变体→裸上游名→combo→分类器）；members 列表 = 唯一成员权威；combo 池自持；按 key 策略四层强制；思考级别诚实规则 |
| [ADR-0004](./0004-resilience-and-health.md) | 容错——分类、断路器、健康视图、整形 | **已实现** | 2026-10-15 | 七类错误 scoped 跳闸；消耗门 vs 非消耗 peek；热规则树且 OFF 语义成文；`ModelHealthView` 能力词汇；断路器记忆分环境、行政标记属全局；限流另立一轴 |
| [ADR-0005](./0005-execution-topology.md) | 执行拓扑——纯直连、单一咽喉 | **已实现** | 2026-10-15 | 纯直连执行；启动池 = jsonc+store+目录（不可路由 → 上报排除，不炸启动）；`executeCandidatePool` 唯一漏斗；两级重试经济性；SSE 重分块；压缩族 + 压缩前指纹；实测成本不做省钱表演 |
| [ADR-0006](./0006-credential-store.md) | 凭证存储——能力旗标、密钥哈希身份 | **已实现** | 2026-10-15 | 两适配器 + 只读变体；按能力分支永不按 kind；SQLite 只读 / HTTP 独写；证据梯 factory、每启动粘滞；仅推式收敛 + authWriteDisabled；sha256(key) 身份锚熔断/嫌疑/亲和；OAuth 各门皆外 |
| [ADR-0007](./0007-environments-and-bootstrap.md) | 环境——账本目录、重启切换、导出/导入 | **已实现** | 2026-10-15 | 单一目录布局无 legacy 分支；OCR_ENV>指针>default（customPath ≠ 杠杆）；切换 = 受控重启（两类子进程 PORT/HOST 纪律不同）；'ocr-env' 信封默认脱敏、封闭白名单、导入守卫成栈；废纸篓删除 |
| [ADR-0008](./0008-protocol-surfaces-and-capture.md) | 接入面与捕获 | **已实现** | 2026-10-15 | 一张派发表双传输；入站别名恰四个；MITM 全捕获姿态；requestCapture = HTTP 交换事件（每轮 2–4 条）、凭证值掩码、默认关字节同一；systemone 两腿闸树 + 概率诚实措辞；responses.persist 失忆边界 |
| [ADR-0009](./0009-quota-probing.md) | 额度跟踪——分层知识、声明式探测 | **已实现** | 2026-10-15 | 覆盖随 release、激活随凭据；四层（头收割预留 / 声明表 / 代码 adapter / 用户表）；12 构件 DSL、五类禁例结构上写不出；铁律只约束用户配置；探测失败≠额度失败；只展示不门控路由；熔断汇聚点写 quota_events 账本 |

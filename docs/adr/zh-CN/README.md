# 架构决策记录 (Architecture Decision Records - 中文版)

> English version is available at [../README.md](../README.md).

本项目采用架构决策记录（Architecture Decision Record, ADR）来沉淀核心设计决策、背景动因及其权衡（Trade-offs），确保项目演进过程中的架构一致性与可追溯性。

## ADR 索引清单

| 编号 | 标题 | 状态 | 日期 | 核心摘要 |
| :--- | :--- | :--- | :--- | :--- |
| [ADR-0001](./0001-purge-fuzzy-semantic-cache.md) | 彻底物理移除本地模糊语义缓存 | **已接受 (Accepted)** | 2026-09-29 | 根除 System Prompt 主导导致的余弦相似度虚高与回答串味问题，确保穿透透明与零残留 |
| [ADR-0002](./0002-dynamic-model-discovery-via-opencode.md) | 基于 OpenCode 的 100% 动态模型发现与自适应分层 | **部分废止 (Superseded in part by [ADR-0011](./0011-pure-direct-execution-no-daemon.md))** | 2026-09-29 | 彻底废除静态 providers/models 硬编码，完全由本地 OpenCode 运行时接管模型发现、分层与鉴权代理（执行委托部分已被 ADR-0011 废止，动态发现理念保留） |
| [ADR-0003](./0003-language-neutral-routing-engine.md) | 语言中立的多维复杂度与结构化路由引擎 | **已接受 (Accepted)** | 2026-09-29 | 摒弃中英文自然语言词表硬编码，改用语法标点密度、LaTeX 形式数学、跨语言技术缩写与动态规则 |
| [ADR-0004](./0004-hierarchical-classification-and-data-flywheel.md) | 多层分类架构与数据飞轮演进体系 | **已实现 (Accepted)** | 2026-09-29 | 落地 Layer 0 结构规则 -> Layer 1 本地 CPU 经验小模型 -> Layer 2 专职裁决模型 (System One 协议) -> 级联降级真值闭环 |
| [ADR-0005](./0005-auto-initializing-base-model-scaffold.md) | 本地空白底座模型自动初始化与确定性穿透 | **已实现 (Accepted)** | 2026-09-29 | 自动落盘未训练微张量底座 (W=0, b=0)，数学严格保证置信度 0.33 < 0.85，100% 确定性穿透至 Layer 2 并支持飞轮原地自演进 |
| [ADR-0006](./0006-monotonic-session-ratchet-and-prefix-fingerprinting.md) | 多轮会话单调递增升档与前缀指纹追踪 | **已实现 (Accepted)** | 2026-09-29 | 解决中途乱切导致的智力倒退与 KV Cache 归零问题，无粘性头下利用前缀链哈希 100% 精准定位并执行只升不降 |
| [ADR-0007](./0007-symmetrical-pipeline-naming-classifier-and-judge.md) | 层级对称性流水线命名演进：Layer 1 分类器冲锋与 Layer 2 裁决者断后 | **已实现 (Accepted)** | 2026-09-29 | 消除突兀空间命名，确立 layer1-classifier（极速冲锋）与 layer2-judge（专职语义裁决）对称体系并彻底清理旧存根 |
| [ADR-0008](./0008-industrial-grade-circuit-breaker-and-health-management.md) | 顶级工业级模型熔断、多级容灾与健康管理系统 | **已实现 (Accepted)** | 2026-09-30 | 故障精准解构（402额度硬熔断/5xx阶梯退避5h/429瞬时退避）、同Tier毫秒级透明故障转移、会话单调棘轮自愈与全维可观测接口 |
| [ADR-0009](./0009-cost-aware-resilience-and-hierarchical-retry.md) | 经济性感知的高弹性两层重试与跨层级故障转移架构 | **已实现 (Accepted)** | 2026-09-30 | 两层重试拓扑（瞬时5xx原地重试挽救10x KV Cache成本、402立即穿透Failover）、同级优先遍历、向上升档保活与严格反向防降级（Anti-Downgrade） |
| [ADR-0010](./0010-routing-decision-cache.md) | 路由决策缓存（Layer 2 Judge 结果复用） | **已接受 (Accepted)** | 2026-10-07 | LRU+TTL 缓存 Layer 2 语义裁决结果（非响应缓存），跨会话复用零网络零 token，命中带 [Decision Cache] 标记可观测 |
| [ADR-0011](./0011-pure-direct-execution-no-daemon.md) | 纯直连执行——OpenCode daemon 完全退出推理链路 | **已接受 (Accepted)** | 2026-10-08 | 废止执行委托：网关直连 provider（npm 数据驱动线型派发 + Responses 线 + /proxy 全链出网），daemon 降级为目录辅助源；不可路由供给显式排除而非静默降级；P1 直连派发 / P2 OAuth 生命周期 / P3 tools·流式透传 |
| [ADR-0012](./0012-symmetric-tier-matching-and-unclassified-pool.md) | 梯队匹配去残差化——四梯队完全同构 + 锚定排除 excludeTiers + 未分类第四态 | **已实现 (Implemented)** | 2026-10-09（2026-10-10 升级为 4 档） | 取消 Plus 残差兜底：四梯队统一 patterns/价格区间/exclude/excludeTiers 五项配置（Plus 死配置项转为真实生效的闭区间基线 [0.8,3]，新增 Pro [3,8] 与 Ultra [8,+∞] 两档）；excludeTiers 为梯队侧锚定排除（运行时取被引梯队条件作过滤）；什么都不命中=未分类，不进任何池；空池静默跨梯队降级改为带日志显式降级 |
| [ADR-0013](./0013-member-list-routing-and-effort-map.md) | 梯队成员列表路由 + 内联思考级别映射 | **已实现 (Implemented)** | 2026-10-10 | 候选池成员唯一来源=已提交的 tiers.<tier>.members 列表（列表顺序即链优先序，首位为梯队代表）；自动 match 不再决定成员，分类器降级为建议引擎（目录页推荐/首启种子/保存检查）；member 规则内联 effortMap 翻译思考级别 |
| [ADR-0014](./0014-systemone-protocol-gateway.md) | System One 协议网关与上游翻译 | **已实现 (Implemented)** | 2026-10-11 | POST /v1/systemone 由原生直通（Jev/百炼决策模型）或经任意已注册 chat 模型转换供能（自报概率、未经校准，ADR 成文声明）；Layer 2 judge 迁移至同一执行器；auto-* 梯队别名按纯 registry 池投影解析，绝不静默回退 |
| [ADR-0015](./0015-unified-protocol-surface-dispatch.md) | 统一协议接入面派发——双推理传输共用同一层接缝 | **提议 (Proposed)** | 2026-10-12 | 两条推理传输腿（原生 /v1 与 MITM 代理）经同一张表驱动的 ProtocolSurface + TransportContext 接缝派发；capture/头/鉴权编排单点归属；修订 ADR-0014 的面位置与 MITM 腿范围；其 §4 capture 豁免后经 ADR-0016 取代（改为 opt-in） |
| [ADR-0016](./0016-systemone-opt-in-capture.md) | requestCapture——System One 两腿 Capture 与 capture/数据集分家 | **提议 (Proposed)** | 2026-10-12 | 最终树（同日重写）：`capture:` 更名为 `requestCapture:`——只放请求/HTTP 交换日志，一个命名空间一个含义（加载时节迁移：旧节映射 + 一次性响亮告警，控制台保存即剥离旧键）；新增 `systemone` 节点（面总闸+子开关）——`enabled`（System One 面总闸——关闭时两腿同哑；客户端直连 /v1/systemone 与 MITM 腿的全链路交换事件（客户一对＋本面上游一对，原生直通/合成转换）；旧名 capture.systemoneEnabled；中间命名 clientEnabled 从未发布）与 `l2DecisionEnabled`（子开关，仅当 `systemone.enabled` 为 true 时生效；新增：Layer 2 judge 的内部 systemone 调用作为上游腿 http-exchange 事件，挂在外层被路由请求的 trace/session 上，purpose='l2-judge'）；隐私总闸 `enabled: false` 不变（零配置 = ADR-0014 §4 姿态分毫不差存续），本组开关默认 `true`，capture 总闸一开即全量披露；训练数据集开关落定于 `classifier.layer2.collectEnabled`——数据集采样而非 capture：(state,answer,tier) → data/layer2-decisions.jsonl，单键门禁、热应用、64MB 封顶后停写 + 恰好一条告警、永不上 capture 页面；取代 0014 §4 capture-records 一支（客户端腿，当日补全为全链路）并扩展之（judge 腿，非简单恢复），取代 §5 数据集一支的成文形态（键退役更名 + 64MB 封顶；默认维持 OFF——含会话内容需手动开启）；防歧义护栏：collectEnabled ≠ systemone.l2DecisionEnabled |



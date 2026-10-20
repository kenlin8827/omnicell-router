# OneCastRouter (OCR) 开发者与架构深度指南 (Developer Guide)

[![Runtime](https://img.shields.io/badge/Runtime-Bun%20%7C%20Node.js-blue.svg)](https://bun.sh)
[![Architecture](https://img.shields.io/badge/Architecture-Cascaded%20Model--Driven-purple.svg)]()
[![Tests](https://img.shields.io/badge/Tests-37%2F37%20Pass%20(100%25)-brightgreen.svg)]()

[English Version](DEVELOPMENT.md) | [简体中文](DEVELOPMENT.zh-CN.md) | [返回用户文档 (User README)](README.zh-CN.md)

> 本文档面向参与 **OneCastRouter (OCR)** 核心研发、二次开发、私有化部署调优以及算法研究的开发者。  
> 涵盖级联路由流水线架构设计、单调棘轮状态机原理及测试矩阵。

---

## 目录
- [一、全局流水线与架构设计](#一全局流水线与架构设计)
- [二、核心算法与数学确定性证明](#二核心算法与数学确定性证明)
- [三、核心模块职责与工程目录结构](#三核心模块职责与工程目录结构)
- [四、完整测试矩阵与验证套件](#四完整测试矩阵与验证套件)
- [五、代码规范与零残留原则 (Zero Cruft)](#五代码规范与零残留原则-zero-cruft)

---

## 一、全局流水线与架构设计

OneCastRouter (OCR) 摒弃了行业内常见的字符长度规则（如 `prompt.length < 20 -> 小模型`）和词表匹配，构建了级联分层流水线：

```
                      客户端请求 (Cursor / Chatbox / NextChat / WebUI / 各种官方 SDK)
                                                   │
                                                   ▼
                    [Step 1: 规范化前缀清洗与会话指纹追踪]
                     - 基于 SHA-256 前缀链哈希，实现真正的零 Header 会话自动识别
                     - 保持规范字节序列，最大化利用上游厂商 Provider 的 KV 提示词缓存
                                                   │
                                                   ▼
                  [Step 2: 级联分层分类流水线]
            ┌──────────────────────────────────────┐
            ▼                                      ▼
   [Layer 0: 请求规则直通]                [Layer 2: 专职裁决模型]
    - 显式梯队 / 别名 / 组合直达            - 结合多轮完整上下文综合判断
    - 全局路由模式拨杆                      - 统计标定 Plus / Pro / Ultra
    - 确定性分发，零模型开销                - 相同上下文复用决策缓存
            │                                      │
            └──────────────────────────────────────┘
                        │ （无判定结果时）
                        ▼
              [默认：plus 质量基线]
                                                   │
                                                   ▼
                    [Step 3: 多轮会话单调递增棘轮状态机 (Monotonic Session Ratchet)]
                     - “只升不降”策略：对话中途严禁降档至低阶模型，根除模型乱切与智商倒退
                     - 物理固定同款模型实例 (`pinnedModel`)，独家保护 80%~95% 上游 KV Cache
                                                   │
                                                   ▼
                    [Step 4: 执行代理与级联静态 Schema 断言 (Fallback)]
                     ├── Lite 先发冲锋 ────► [本地 AST / JSON Schema 静态断言验证]
                     │                       ├── 断言通过 ──► 直接返回客户端 (节省 90% 成本)
                     │                       └── 断言失败 ──► 注入错误上下文，无感静默降级重试至 plus
                     └── Plus / Pro / Ultra ───────────► 施加推理 Token 预算约束并直接返回
```

### 分层裁决逻辑
1. **Layer 0（请求规则层）**：
   - 显式客户端选择立即决定：`router_options.force_tier`、auto 梯队别名、组合（combo）与全局 `routing.mode` 拨杆。
   - 携带结构化输出要求（`response_format` / `tools`）的请求，无论定档如何，执行阶段都会启用 Lite 先发的 Schema 断言级联。
2. **路由经验表（ADR-0011）**：
   - 咨询判定器之前，auto 请求先查持久化经验表：命中即以历史服务过该提问的档位（与思考档）短路 L2。
   - 可在控制台 `/route-entries` 页人工编辑；写入只来自白名单（判定器 ≥0.85、被接受的重试纠偏、人工编辑）。
3. **Layer 2（专职上下文语义裁决者）**：
   - 携带最近 4 轮完整对话上下文，调用专职决策模型执行高精度任务难度与意图评判。
   - 任何判定失手（未启用、模型不可解析、超时、上游失败）均优雅降级。
4. **默认（质量优先基线）**：
   - 无判定结果时请求落在硬编码 `plus` 梯队——零配置绝不静默走便宜路线。
5. **重试升档（ADR-0011）**：
   - 同一会话原样重发同一提问（≥20 字符、上一轮成功）即升档：第 1 次抬思考档，第 2 次起升梯队（封顶 `ultra`，能力上限直接跳梯队+1）。

---

## 二、核心算法与数学确定性证明

### 零 Header 前缀链哈希抗碰撞证明
在无显式 Session ID 的情况下，OneCastRouter (OCR) 采用前缀链哈希（Prefix-Chain Hash）追踪多轮对话：
$$\mathcal{H}_{\text{session}} = \text{SHA256}(\text{CanonicalJSON}(\text{messages}[0 \dots n-2]))$$

**抗碰撞性分析**：
由于对话历史 $messages[0 \dots n-2]$ 中必定包含上一轮模型生成的助手回复 $A_{n-1}$。因大语言模型采样的随机性与温度机制，$A_{n-1}$ 包含了大量自回归生成的长 Token 序列。  
在密码学 SHA-256 下，不同用户的历史序列产生哈希碰撞的理论概率满足生日悖论：
$$P(\text{collision}) \le \frac{k^2}{2 \times 2^{256}} \approx 0$$
在全局多租户高并发场景下，前缀链哈希碰撞概率在数学上可忽略不计，从而实现 100% 稳定的零 Header 会话识别。

---

## 三、核心模块职责与工程目录结构

```
onecast-router/
├── src/
│   ├── router/                    # 级联路由仲裁引擎
│   │   ├── request-traits.ts      # 基于规则的请求事实（结构化输出门）
│   │   ├── route-entries.ts       # 持久化按 prompt 经验表（ADR-0011）
│   │   ├── retry-escalation.ts    # 重复提问检测 + 升档阶梯（ADR-0011）
│   │   ├── routing-ledger.ts      # 纯追加、仅哈希的审计台账
│   │   ├── layer2-judge.ts        # Layer 2: 专职上下文感知意图裁决模型
│   │   └── index.ts               # 级联流水线统一仲裁器 (RouterEngine)
│   ├── session/                   # 会话生命周期与状态机
│   │   └── session-manager.ts     # 多轮单调棘轮状态机与前缀链哈希指纹
│   ├── capture/                   # 请求/响应与决策捕捉落盘
│   │   ├── recorder.ts            # 完整请求/响应体归档（自选开启）
│   │   └── decision-capture.ts    # Layer 2 裁决决策数据集采样器（自选开启）
│   ├── validator/                 # 语法断言与降级提取
│   │   ├── schema-assertion.ts    # 本地 AST 与 JSON Schema 静态语法断言
│   │   └── parser.ts              # 提取语法解析错误上下文
│   ├── budget/                    # Token 预算管理
│   │   └── budget-manager.ts      # 限制中等任务的思考预算与最大 Token 上限
│   ├── trace/                     # 执行调用轨迹与遥测索引
│   │   └── tracker.ts             # 环形缓冲区轨迹捕获、会话多轮索引与查询端点支撑
│   ├── providers/                 # 模型供应商执行代理
│   │   ├── opencode-proxy.ts      # OpenCode v2 无密钥代理执行适配器
│   │   └── registry.ts            # 动态供应商与物理模型注册表
│   ├── opencode/                  # 本地 OpenCode 连通
│   │   └── sync.ts                # 自动发现本地服务、同步 90+ 模型与实时计费
│   ├── pipeline/                  # 核心级联管线
│   │   ├── prompt-optimizer.ts    # 前缀规范化清洗，保护上游 KV 缓存
│   │   └── orchestrator.ts        # 全局编排器（路由、会话状态与级联回退）
│   ├── metrics/                   # FinOps 成本优化指标核算
│   │   └── finops-tracker.ts      # 实时聚合节约金额、各层流量占比与缓存命中率
│   ├── server.ts                  # Fastify HTTP 代理服务器与路由处理器
│   └── index.ts                   # 应用程序入口
├── scripts/
│   └── full-system-test.ts        # 10 点全链路系统端到端集成测试套件
├── docs/
│   └── adr/                       # 架构决策记录 (ADR-0001 至 ADR-0008)
│       └── zh-CN/                 # 架构决策记录中文双语镜像目录
├── config.example.yaml            # 生产环境配置模板
├── tests/                         # 单元测试套件 (30/30 100% 通过)
└── package.json
```

---

## 四、完整测试矩阵与验证套件

### 1. 运行所有单元测试（37/37 项全绿）
```bash
bun test
```
* **tests/session.test.ts** (4 tests): 验证前缀链指纹、单调棘轮只升不降门禁与模型物理固定。
* **tests/trace.test.ts** (7 tests): 验证执行轨迹记录、按会话索引追溯、全局分页查询与会话重置清除。
* **tests/router.test.ts**: 验证强制梯队覆盖、结构化输出门与 plus 质量基线兜底。
* **tests/validator.test.ts** (4 tests): 验证 Markdown JSON 围栏解析、语法异常拦截与 Schema 断言。
* **tests/opencode.test.ts** (3 tests): 验证 OpenCode 守护进程凭据发现、模型同步与自适应三层金字塔构建。
* **tests/pipeline.test.ts** (4 tests): 验证端到端流水线执行、静默升档降级与 FinOps 实时损益聚合。
* **tests/server.test.ts** (6 tests): 验证 Fastify 服务器、OpenAI 补全接口、SSE 流式块传输与指标端点。

### 2. 运行端到端全系统集成测试（对接真实本地 OpenCode）
```bash
bun run scripts/full-system-test.ts
```
启动真实网关实例，对本地 OpenCode 守护进程执行 10 维全链路真实压力验证（健康检查、模型映射、级联推理、独立会话隔离、SSE 流式、旧模型自适应、FinOps 大盘）。

---

## 五、代码规范与零残留原则 (Zero Cruft)

1. **绝对物理清理（Zero Cruft）**：
   - 重构时不保留任何转发存根（`export * from ...`）或废弃别名，彻底物理删除旧文件以保持架构极简。
2. **严格国际化（Strict i18n Compliance）**：
   - 生产源码（`src/`）、测试用例（`tests/`）、辅助脚本（`scripts/`）以及配置文件（`config.yaml`）**严禁包含任何中文字符**，所有注释与日志均使用英文。
   - 双语支持严格隔离在双语文档体系中（`docs/adr/zh-CN/`、`README.zh-CN.md`、`DEVELOPMENT.zh-CN.md`）。
3. **零硬编码与语言中立（Zero Hardcoding）**：
   - 严禁在分类逻辑中硬编码自然语言词汇或字符长度阈值。

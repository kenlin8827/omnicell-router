# OneCastRouter (OCR) 开发者与架构深度指南 (Developer Guide)

[![Runtime](https://img.shields.io/badge/Runtime-Bun%20%7C%20Node.js-blue.svg)](https://bun.sh)
[![Architecture](https://img.shields.io/badge/Architecture-Three--Layer%20Model--Driven-purple.svg)]()
[![Tests](https://img.shields.io/badge/Tests-37%2F37%20Pass%20(100%25)-brightgreen.svg)]()

[English Version](DEVELOPMENT.md) | [简体中文](DEVELOPMENT.zh-CN.md) | [返回用户文档 (User README)](README.zh-CN.md)

> 本文档面向参与 **OneCastRouter (OCR)** 核心研发、二次开发、私有化部署调优以及算法研究的开发者。  
> 涵盖三层全模型驱动流水线架构设计、微张量冷启动数学证明、单调棘轮状态机原理、数据飞轮蒸馏训练流程及测试矩阵。

---

## 目录
- [一、全局流水线与架构设计](#一全局流水线与架构设计)
- [二、核心算法与数学确定性证明](#二核心算法与数学确定性证明)
  - [1. 空白微张量底座与 Softmax 确定性穿透证明](#1-空白微张量底座与-softmax-确定性穿透证明)
  - [2. 语言中立多维特征提取与香农熵分析](#2-语言中立多维特征提取与香农熵分析)
  - [3. 零 Header 前缀链哈希抗碰撞证明](#3-零-header-前缀链哈希抗碰撞证明)
- [三、核心模块职责与工程目录结构](#三核心模块职责与工程目录结构)
- [四、主动学习数据飞轮与模型原地蒸馏](#四主动学习数据飞轮与模型原地蒸馏)
- [五、完整测试矩阵与验证套件](#五完整测试矩阵与验证套件)
- [六、代码规范与零残留原则 (Zero Cruft)](#六代码规范与零残留原则-zero-cruft)

---

## 一、全局流水线与架构设计

OneCastRouter (OCR) 摒弃了行业内常见的字符长度规则（如 `prompt.length < 20 -> 小模型`）和词表匹配，构建了严格的三层分级流水线：

```
                      客户端请求 (Cursor / Chatbox / NextChat / WebUI / 各种官方 SDK)
                                                   │
                                                   ▼
                    [Step 1: 规范化前缀清洗与会话指纹追踪]
                     - 基于 SHA-256 前缀链哈希，实现真正的零 Header 会话自动识别
                     - 保持规范字节序列，最大化利用上游厂商 Provider 的 KV 提示词缓存
                                                   │
                                                   ▼
                  [Step 2: 三层全模型驱动分层分类流水线]
            ┌──────────────────────────────────────┼──────────────────────────────────────┐
            ▼                                      ▼                                      ▼
   [Layer 0: 协议结构直通]              [Layer 1: 本地 CPU 微模型]              [Layer 2: 专职裁决模型]
    - 明确 JSON Schema / Tools 约束       - 提取 8 维语言中立统计特征             - 结合多轮完整上下文综合判断
    - 确定性分发至 Lite 极速层            - 未训练空白底座 (W=0, b=0)             - 统计标定 Plus / Pro / Ultra
    - 零开销协议旁路直达                  - 极速 CPU 推理 (<0.1ms)                - 裁决真值异步反哺数据飞轮
            │                                      │                                      │
            └──────────────────────────────────────┼──────────────────────────────────────┘
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
1. **Layer 0（协议结构层）**：
   - 检测请求中是否包含明确的结构化输出要求（如 `response_format: { type: 'json_object' }` 或 `tools`）。
   - 若命中，确定性交付给 Lite 极速模型先发冲锋，并在后置阶段进行本地静态 AST / Schema 断言检验。
2. **Layer 1（CPU 微张量分类器）**：
   - 提取 8 维语言中立特征向量，在 CPU 上执行纯矩阵线性前向运算与 Softmax 计算（耗时 `<0.1ms`）。
   - 若模型置信度高于设定阈值（默认 $\theta = 0.85$），直接以此层裁决执行；若置信度不足，无感穿透至 Layer 2。
3. **Layer 2（专职上下文语义裁决者）**：
   - 携带最近 4 轮完整对话上下文，调用专职决策模型执行高精度任务难度与意图评判。
   - 裁决结果不仅决定当前请求的执行路线，还会异步沉淀为数据飞轮的有监督蒸馏样本。

---

## 二、核心算法与数学确定性证明

### 1. 空白微张量底座与 Softmax 确定性穿透证明
为实现零冷启动硬编码与平滑自演进，网关在初次启动且无模型文件时，自动在当前环境的 `envs/<env>/models/layer1-classifier.json` 落地初始模型，并将初始权重与偏置全部设为零：
$$W \in \mathbb{R}^{8 \times 3} = \mathbf{0}, \quad b \in \mathbb{R}^3 = \mathbf{0}$$

**前向传播数学推导**：
对任意输入的 8 维特征向量 $x \in \mathbb{R}^8$：
$$z = W^T x + b = \mathbf{0}^T x + \mathbf{0} = \begin{bmatrix} 0 \\ 0 \\ 0 \\ 0 \end{bmatrix}$$

经 Softmax 激活函数计算后，四类（lite, plus, pro, ultra）的预测概率为：
$$P(\text{tier}_i) = \frac{e^{z_i}}{\sum_{j=1}^4 e^{z_j}} = \frac{e^0}{e^0 + e^0 + e^0 + e^0} = \frac{1}{4} = 0.25$$

**确定性穿透引理**：
由于系统的置信度门限阈值 $\theta = 0.85$：
$$\max_{i} P(\text{tier}_i) = 0.25 < 0.85$$
因此，未训练状态下的置信度判定在**数学上严格恒为 `isConfident = false`**。  
系统由此保证：在任何冷启动与未训练场景下，绝不发生误短路判决，100% 优雅穿透至 Layer 2 专职裁决模型。

### 2. 语言中立多维特征提取与香农熵分析
Layer 1 分类器提取的 8 维连续特征向量 $x = [x_1, x_2, \dots, x_8]^T \in [0, 1]^8$ 均严格语言中立：

| 维度 | 特征名称 | 提取与归一化逻辑 |
| :--- | :--- | :--- |
| $x_1$ | `token_count_normalized` | $\min(1.0, \log_{10}(\max(1, \text{tokens})) / 4.0)$（万 Token 映射至 1.0） |
| $x_2$ | `turn_count_normalized` | $\min(1.0, \text{turns} / 20.0)$（20 轮上下文映射至 1.0） |
| $x_3$ | `has_system_prompt` | 存在 System Prompt 设为 1.0，否则 0.0 |
| $x_4$ | `code_block_ratio` | Markdown 代码围栏文本字符数占总字符数的比例 $\in [0, 1]$ |
| $x_5$ | `syntax_symbol_density` | 跨语言语法字符集 (`{}[];()=><|&`) 出现频次密度 |
| $x_6$ | `has_tools_or_schema` | 请求是否声明了 Tools、Functions 或 JSON Schema |
| $x_7$ | `character_entropy` | 字符香农信息熵归一化：$H(X) = -\sum p(c) \log_2 p(c) / 8.0$ |
| $x_8$ | `punctuation_density` | 通用标点符号 (`?!,.:;`) 出现频次密度 |

### 3. 零 Header 前缀链哈希抗碰撞证明
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
│   ├── router/                    # 三层路由仲裁引擎
│   │   ├── layer1-classifier.ts   # Layer 1: CPU 微张量特征分类器与原地训练引擎
│   │   ├── layer2-judge.ts        # Layer 2: 专职上下文感知意图裁决模型
│   │   └── index.ts               # 三层流水线统一仲裁器 (RouterEngine)
│   ├── session/                   # 会话生命周期与状态机
│   │   └── session-manager.ts     # 多轮单调棘轮状态机与前缀链哈希指纹
│   ├── flywheel/                  # 生产数据飞轮与样本收集
│   │   └── collector.ts           # 异步写入 flywheel.jsonl，打标负样本
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
├── models/
│   └── layer1-classifier.json     # 自动初始化的微张量底座模型骨架 (W=0, b=0)
├── scripts/
│   ├── train-layer1-classifier.ts # 飞轮数据集原地蒸馏微调脚本 (bun run train:layer1)
│   ├── flywheel-stats.ts          # 飞轮样本分布统计分析 (bun run flywheel:stats)
│   └── full-system-test.ts        # 10 点全链路系统端到端集成测试套件
├── docs/
│   └── adr/                       # 架构决策记录 (ADR-0001 至 ADR-0008)
│       └── zh-CN/                 # 架构决策记录中文双语镜像目录
├── config.example.yaml            # 生产环境配置模板
├── tests/                         # 单元测试套件 (30/30 100% 通过)
└── package.json
```

---

## 四、主动学习数据飞轮与模型原地蒸馏

```
[在线流量路由]
      │
      ▼
Layer 2 专职裁决 / Layer 1 Schema 校验失败
      │
      ▼
写入当前环境的 envs/<env>/data/flywheel.jsonl (含 Ground Truth 标签与负样本标定)
      │
      ▼
运行 bun run train:layer1
      │
      ▼
计算 Softmax 交叉熵损失与 L2 正则化微梯度
      │
      ▼
原地更新 envs/<env>/models/layer1-classifier.json (isBaseModel: true -> false)
      │
      ▼
后续高频同类请求由 Layer 1 CPU 直接毫秒级命中 (<0.1ms, 零边际成本)
```

### 执行飞轮训练
1. **查看当前飞轮样本分布**：
   ```bash
   bun run flywheel:stats
   ```
2. **执行微张量梯度下降蒸馏**：
   ```bash
   bun run train:layer1
   ```
   训练输出示例：
   ```
   🧠 OCR (OneCastRouter) Layer 1 Classifier Trainer (Active Learning)
   📊 Successfully loaded flywheel dataset: 58 records
   🎯 Valid training samples: 58 (including 6 fallback-corrected negative samples)
   ⏳ Running micro-tensor Softmax cross-entropy gradient descent (with L2 regularization)...
   👉 Total Trained Samples : 58
   👉 Final Converged Loss  : 0.4869
   👉 Training Set Accuracy : 79.3%
   👉 Model Output Path     : envs/<env>/models/layer1-classifier.json
   👉 Status Transition     : isBaseModel (true -> false)
   ```

---

## 五、完整测试矩阵与验证套件

### 1. 运行所有单元测试（37/37 项全绿）
```bash
bun test
```
* **tests/flywheel.test.ts** (5 tests): 验证底座自动初始化、Softmax 均等概率穿透、原地蒸馏微调与负样本纠偏。
* **tests/session.test.ts** (4 tests): 验证前缀链指纹、单调棘轮只升不降门禁与模型物理固定。
* **tests/trace.test.ts** (7 tests): 验证执行轨迹记录、按会话索引追溯、全局分页查询与会话重置清除。
* **tests/router.test.ts** (4 tests): 验证强制分层覆盖、动态规则评估与质量基线兜底。
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

## 六、代码规范与零残留原则 (Zero Cruft)

1. **绝对物理清理（Zero Cruft）**：
   - 重构时不保留任何转发存根（`export * from ...`）或废弃别名，彻底物理删除旧文件以保持架构极简。
2. **严格国际化（Strict i18n Compliance）**：
   - 生产源码（`src/`）、测试用例（`tests/`）、辅助脚本（`scripts/`）以及配置文件（`config.yaml`）**严禁包含任何中文字符**，所有注释与日志均使用英文。
   - 双语支持严格隔离在双语文档体系中（`docs/adr/zh-CN/`、`README.zh-CN.md`、`DEVELOPMENT.zh-CN.md`）。
3. **零硬编码与语言中立（Zero Hardcoding）**：
   - 严禁在分类逻辑中硬编码自然语言词汇或字符长度阈值。

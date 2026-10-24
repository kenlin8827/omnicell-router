# OmniCellRouter (OCR)

<div align="center">

**面向 [OpenCode](https://opencode.ai) 与通用大模型客户端的生产级智能级联路由器与 FinOps 网关。**

[![npm](https://img.shields.io/npm/v/onecast-router.svg?color=blue)](https://www.npmjs.com/package/onecast-router)
[![Desktop Release](https://img.shields.io/github/v/release/kenlin8827/onecast-router?color=purple)](https://github.com/kenlin8827/onecast-router/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Runtime](https://img.shields.io/badge/Runtime-Bun%20%7C%20Node.js-blue.svg)](https://bun.sh)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-green.svg)](https://platform.openai.com/docs/api-reference)
[![FinOps](https://img.shields.io/badge/Cost%20Optimization-70%25%20~%2090%25-orange.svg)]()

**[快速开始](#快速开始)** · **[命令行 CLI](#命令行-cli-使用指南)** · **[客户端接入](#客户端接入)** · **[架构与核心特性](#核心特性)** · **[开发者指南](DEVELOPMENT.zh-CN.md)** · **[版本发布指南](RELEASING.zh-CN.md)** · **[English Version](README.md)**

</div>

---

## 什么是 OmniCellRouter (OCR)？

**OmniCellRouter (OCR)** 是一个高性能、本地优先的 LLM API 级联路由、韧性编排与 FinOps 治理网关。它将不同上游服务商（OpenAI、Anthropic、DeepSeek、Moonshot/Kimi、阿里云百炼 DashScope、Ollama 及兼容 OpenAI 协议的私有服务）统一整合为多梯队智能级联资源池。

通过编排**规则直通快道**、**RouteEntry 持久化经验表**、可选的 **System One 语义决策层**、**单调会话棘轮**、**两阶段抖动就地重试与上游 KV Cache 保护**以及 **Token Saver 压缩套件**，OmniCellRouter 在保障多轮复杂开发长对话逻辑质量零劣化的前提下，降低 **70% 至 90%** 的 API 费用支出。

---

## 核心特性

- **💸 降低 70% ~ 90% API 支出**：琐碎、简短、结构化提取类请求毫秒级直通轻量 micro 级模型；复杂工程架构与算法逻辑自动升阶至 plus/pro/ultra 主力模型。
- **⚡ 原生 OpenCode v2 集成与免密透传**：无缝连接本地 OpenCode 守护进程或 OCR 凭证中心，自动同步 90+ 模型目录与凭证，客户端零手动配置。
- **🧠 经验驱动智能分发 (ADR-0011)**：持久化提示词级经验表（`data/route-entries.json`），高频复现提示词直接命中经验短路判决，节省决策层模型开销。
- **🎯 System One 决策与推理强度联合决策 (ADR-0012)**：上下文感知语义决策层单次调用同时决策目标层级与思考预算（`{tier, effort}`），并提供完整的决策溯源标头。
- **🔒 单调会话棘轮与接入模式自治 (ADR-0002, ADR-0014)**：多轮对话“只升不降”，防止上下文被轻量模型污染导致逻辑降智。仅 `auto` 系列支持网关智能调级，强制层级与具体模型指令严格忠实执行。
- **📈 显式升档指令 (ADR-0011)**：在最后一条 user 消息里写 `@ocr-tier-up` / `@ocr-tier-down` / `@ocr-effort-up` / `@ocr-effort-down`，即为当轮升/降一个梯队或一档思考级别。指令每次请求都会从上行消息链中抹除，只作用于当轮（不改变会话梯队上限），也不会被当作经验学习——不再猜测「重发一条 prompt 到底意味着什么」。
- **🛡️ 两阶段就地重试与 KV 缓存屏障 (ADR-0005)**：面对上游 5xx 与超时偶发波动，优先在原模型实例就地抖动重试，保护 100% 预热 KV 缓存，避免上下文重建引发 10 倍费用骤增。
- **🩺 分层韧性熔断治理体系 (ADR-0004)**：精准分类 7 大上游故障（`quota`, `auth`, `rate_limit`, `server_error`, `timeout`, `network`, `bad_request`），在 `model`、`credential` 与 `(model, credential)` 对维度实现隔离熔断。
- **📊 实时调用故障事件账本 (ADR-0013)**：环形缓冲区与 SQLite 持久化镜像记录所有上游调用失败，具备 10 秒风暴聚合能力，并在 Web 控制台提供可视化治理。
- **🗜️ Token Saver 压缩管道**：内置工具输出确定性截断压缩（`rtk`）、神经语义上下文压缩 Sidecar（`headroom`）以及精简系统提示注入（`caveman`）。
- **🔍 声明式 Quota 额度探测 (ADR-0009)**：内置包含 12 项语法的 DSL 引擎，非阻塞异步探测上游服务商余额与额度窗口。
- **🔌 多协议全面兼容 (ADR-0008)**：即插即用兼容 OpenAI Chat Completions、Anthropic Messages 以及 OpenAI Responses API 规范。

---

## 快速开始

### 1. npm 安装（推荐）

```bash
# 全局安装
npm install -g onecast-router

# 启动后台网关并在默认浏览器打开管理控制台
ocr web

# 或者无需全局安装直接运行
npx onecast-router web
```

### 2. Windows / macOS / Linux 一键安装脚本

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/kenlin8827/onecast-router/main/install.ps1 | iex
```

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/kenlin8827/onecast-router/main/install.sh | bash
```

### 3. 原生独立桌面应用 (GUI)

直接从 [GitHub Releases](https://github.com/kenlin8827/onecast-router/releases/latest) 下载开箱即用的安装包：
* **Windows**: `OneCastRouter_0.0.1_x64-setup.exe` (NSIS 安装包)
* **macOS (Apple Silicon)**: `OneCastRouter_0.0.1_aarch64.dmg`
* **macOS (Intel)**: `OneCastRouter_0.0.1_x64.dmg`

---

## 命令行 CLI 使用指南

安装完成后，可以在任意终端直接管理后台守护进程与客户端接入：

```bash
# 网关生命周期管理
ocr start               # 启动 OCR 后台守护进程（默认端口 4000）
ocr web                 # 在默认浏览器中启动并打开 Web 管理控制台
ocr status              # 查看运行状态、PID、内存、FinOps 节省指标与客户端挂载
ocr stop                # 停止后台网关守护进程
ocr restart             # 重启后台网关

# 一键挂载各大客户端代理
ocr setup opencode      # 将 OpenCode 路由无缝接入 OCR
ocr setup claude        # 将 Claude Code / Claude Desktop 接入 OCR
ocr setup codex         # 将 Codex / OpenAI CLI 接入 OCR
ocr setup pi            # 将 Pi 接入 OCR

# 卸载客户端代理挂载
ocr teardown opencode   # 恢复 OpenCode 直连
ocr teardown claude     # 恢复 Claude 直连
```

---

## 从源码手动编译

### 1. 环境依赖
* **Bun**（推荐）：`>= 1.0`，或 **Node.js**：`>= 18`。
* **OpenCode v2**（可选但推荐）：自动同步本地上游服务商配置、密钥及计费目录。

### 2. 源码下载与编译
```bash
git clone https://github.com/kenlin8827/onecast-router.git
cd onecast-router
bun install && bun run build
```

### 3. 环境配置与启动
每个环境管理独立的配置账本（配置、凭据、会话与日志）。默认环境目录位于 `~/.onecast-router/envs/default/config.yaml`。初次启动网关将自动根据自解释模板创建该文件。

```bash
# 启动后台守护进程
bun run ocr start

# 或前台启动（便于查看日志）
bun run start:bun
```
网关默认监听于 `http://127.0.0.1:4000`。浏览器访问 `http://127.0.0.1:4000/admin` 打开管理控制台。

---

## 客户端接入

OmniCellRouter 提供标准的 OpenAI 与 Anthropic 兼容端点，配置极为简单：

### 1. Cursor IDE
1. 打开设置：`Settings` -> `Models`。
2. 开启 `OpenAI API Key`，输入任意占位符字符串（如 `sk-ocr`）。
3. 展开 `Override OpenAI Base URL`，填入：
   ```
   http://127.0.0.1:3000/v1
   ```
4. 在模型选择列表中，添加并选中虚拟模型：`auto`。

### 2. Claude Code / OpenCode CLI / Chatbox
1. **API Base URL**: `http://127.0.0.1:3000/v1`
2. **API Key**: 任意占位符字符串（或已配置的 `adminApiKey`）。
3. **Model**: 输入 `auto`（或显式层级别名如 `auto-plus`）。

### 3. Python SDK
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3000/v1",
    api_key="sk-ocr"
)

response = client.chat.completions.create(
    model="auto",
    messages=[
        {"role": "user", "content": "请用 TypeScript 实现一个支持防抖与取消的通用泛型函数，并附带单元测试。"}
    ]
)

print(response.choices[0].message.content)
```

### 4. Node.js / TypeScript SDK
```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://127.0.0.1:3000/v1',
  apiKey: 'sk-ocr',
});

async function main() {
  const stream = await openai.chat.completions.create({
    model: 'auto',
    messages: [{ role: 'user', content: '详细解释分布式系统中的 Paxos 与 Raft 协议差异。' }],
    stream: true,
  });

  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
}

main();
```

---

## 模型寻址与虚拟梯队

网关支持四类寻址模态（ADR-0003, ADR-0014）：

| 模型标识 (ModelRef) | 类别 | 路由行为与 FinOps 特征 |
| :--- | :--- | :--- |
| **`auto`** / **`default`** | 智能级联模型 | **完整级联管线**：分析输入特征、检索 RouteEntry 经验表、可选调用决策层模型，并受单调会话棘轮保护，节约 70%~90% 成本。 |
| **`auto-lite`** | 强制轻量梯队 | 强制路由至 `lite` 微模型池（~$0.10 ~ $0.50 / M tokens），适合简单翻译、代码补全、格式化提取。 |
| **`auto-plus`** | 强制主力梯队 | 强制路由至 `plus` 标准主力池（~$2.00 ~ $3.00 / M tokens），默认通用工程代码主力基准线。 |
| **`auto-pro`** | 强制专家梯队 | 强制路由至 `pro` 深度推理专家池（~$3.00 ~ $8.00 / M tokens），解决数学推演、长上下文架构重构。 |
| **`auto-ultra`** | 强制前沿梯队 | 强制路由至 `ultra` 前沿顶尖池（≥ $8.00 / M tokens），支撑多文件全自主智能体长循环。 |
| *Custom Combos* | 自定义组合池 | 依照设定策略（`priority`, `weighted`, `round_robin`）在组合成员内分发，成员故障严格在池内故障转移。 |
| *物理模型* | 直连穿透调用 | 任意已注册物理模型名（如 `deepseek-chat`, `kimi-k2.7-code`），绕过梯队仲裁直接透传上游。 |

---

## 级联仲裁管道架构

请求调度分四个严密步骤执行：

```
                      客户端请求 (Chat Completions / Anthropic Messages / Responses)
                                                    │
                                                    ▼
                     [Step 1: 特征解析与会话前缀指纹识别]
                      - 基于 SHA-256 前缀链式哈希的零 Header 会话识别
                      - 保证规范字节序，最大化上游服务商 KV Prompt Cache
                                                    │
                                                    ▼
                     [Step 2: 级联梯队与思考强度决策管道]
             ┌───────────────────────────────────────────────────────────────┐
             │ Layer 0: 明确规则与请求级直通                                 │
             │  - 客户端 force_tier / combo / auto-* 强制层级 / 模式杠杆    │
             └───────────────────────────────┬───────────────────────────────┘
                                             │ (无显式规则直通)
                                             ▼
             ┌───────────────────────────────────────────────────────────────┐
             │ RouteEntry 持久化经验表检索 (ADR-0011)                        │
             │  - SHA-256 提示词哈希命中直接短路判决                         │
             │  - 写入权重：人工编辑 > 重试纠偏 > 高置信度决策层               │
             └───────────────────────────────┬───────────────────────────────┘
                                             │ (未命中经验表)
                                             ▼
             ┌───────────────────────────────────────────────────────────────┐
             │ Layer 2: System One 语义决策层 (ADR-0012, 默认关闭需开启)   │
             │  - 上下文感知意图难度评估                                     │
             │  - 单次调用联合判决 {tier, effort}                            │
             └───────────────────────────────┬───────────────────────────────┘
                                             │ (决策层未启用 / 未命中 / 超时故障)
                                             ▼
             ┌───────────────────────────────────────────────────────────────┐
             │ 兜底基准线：硬编码 'plus' 梯队（防降智质量防线）               │
             └───────────────────────────────────────────────────────────────┘
                                                    │
                                                    ▼
                     [Step 3: 多轮对话单调会话棘轮 (ADR-0002)]
                      - 只升不降策略：会话严禁中途向廉价层级降级
                      - 锁定物理模型实例，确保高命中率 KV 缓存
                                                    │
                                                    ▼
                     [Step 4: 直接池化执行与故障转移 (ADR-0005)]
                      - 遭遇 5xx/超时优先原实例就地抖动重试
                      - 同层级候选故障转移，受控向上升级
                      - 失败事件记录至环形缓冲与 SQLite 持久化账本
```

---

## 可观测性与 FinOps 诊断

### 1. HTTP 响应诊断标头
每次网关调用均返回完整的调用链路诊断标头：
* `X-OCR-Trace-ID`: 本轮请求的全局唯一跟踪 ID。
* `X-OCR-Tier`: 实际调用的目标梯队（`lite`, `plus`, `pro`, `ultra`）。
* `X-OCR-Model`: 最终调用的物理模型标识。
* `X-OCR-Thinking-Effort`: 生效的思考预算（`low`, `medium`, `high`, `max`）。
* `X-OCR-Thinking-Source`: 思考预算决策来源（`client`, `l2-decision`, `entry`, `escalation`, `default`）。
* `X-OCR-Failover`: 是否触发了故障转移（`true` / `false`）。
* `X-OCR-Failover-Attempts`: 取得成功前尝试的模型次数。
* `X-OCR-Breaker-State`: 执行实例的熔断器状态（`CLOSED`, `HALF_OPEN`）。
* `X-OCR-Session-ID`: 计算出的零标头会话 ID。
* `X-OCR-Session-Ratchet`: 本轮是否被单调棘轮锁定（`true` / `false`）。
* `X-OCR-Cost-USD`: 本次请求实际花费金额（美元）。
* `X-OCR-Saved-USD`: 相较于 plus 基准模型所节约的金额。
* `X-OCR-Latency-MS`: 网关端到端处理耗时（毫秒）。

### 2. 核心管理接口一览

| 接口端点 | 方法 | 作用说明 |
| :--- | :--- | :--- |
| `/api/admin/status` | `GET` | 网关综合状态：熔断器、已注册模型、实时统计、环境账本。 |
| `/api/admin/usage` | `GET` | 聚合 Token 使用量与分 API 密钥消耗详情。 |
| `/api/admin/quota` | `GET` | 实时额度探测计划、各服务商凭据额度快照及额度事件账本。 |
| `/api/admin/quota/refresh` | `POST` | 使凭据额度缓存失效并立刻触发重新探测。 |
| `/api/admin/route-entries` | `GET` | 分页浏览持久化 RouteEntry 经验表。 |
| `/api/admin/route-entries/:hash` | `PATCH` | 人工手动覆盖指定提示词哈希的目标层级与思考预算。 |
| `/api/admin/route-entries/:hash` | `DELETE` | 删除经验表中的指定条目。 |
| `/api/admin/failure-events` | `GET` | 查询上游物理模型调用失败事件账本（支持过滤）。 |
| `/api/admin/failure-events/clear` | `POST` | 清空内存环与 SQLite 持久化故障事件记录。 |
| `/api/admin/health/circuit-breakers/reset` | `POST` | 手动重置处于熔断状态的模型、凭据或对熔断器。 |
| `/v1/sessions` | `GET` | 查看活跃多轮会话状态、锁定梯队与绑定模型。 |
| `/v1/traces` | `GET` | 分页查询请求执行轨迹。 |
| `/v1/metrics` | `GET` | 查看实时 FinOps 统计、梯队流量占比与累计成本节约。 |

---

## 常见问题

### Q1: OmniCellRouter 需要在配置文件中重复填写各大厂商 API Key 吗？
**不需要**。OmniCellRouter 以 `<ocrHome>/providers.json` 和 `credentials.json` 为统一真实源，并与本地 OpenCode v2 双向自动同步。下游客户端调用时仅需使用任意占位 Key 或管理控制台配置的密钥即可。

### Q2: 为什么对话在长轮次中绝不会“降智”？
市面上的朴素无状态路由器常将简短回复（如“好”、“修复第 5 行”）误判为简单任务而分发至微模型，导致数十万字长代码上下文被轻量模型破坏。OmniCellRouter 执行**单调会话棘轮（Monotonic Session Ratchet）**：一旦会话由于复杂任务进入较高梯队（`plus`/`pro`/`ultra`），后续轮次绝不允许反向降级，严格锁定原模型实例。

### Q3: 频繁切换模型会导致 KV Cache 失效引起费用暴涨吗？
**绝不会**。OmniCellRouter 会话严格绑定物理模型实例，并内置**两阶段就地抖动重试机制**：遇到上游 5xx 临时抖动或超时，网关优先在原物理模型就地重试，最大化保全 80%~95% 的已预热上游 Prompt Cache，避免重新上传百万 Token 导致账单翻倍。

### Q4: 上游服务商宕机或余额欠费如何处置？
OmniCellRouter 提供工业级 7 类故障响应：
- **HTTP 402（余额欠费/超额）**：立即对该凭据或对熔断 12 小时，后续请求直接跳过，零延迟损耗。
- **HTTP 5xx / 超时**：触发指数退避，并在毫秒级内自动无缝重定向到同层级备选候选模型，保障客户端 200 成功率。
- **HTTP 429（速率限制）**：依据上游 `Retry-After` 进行自适应退避。
- **全面可观测性**：每次失败即刻被收录至 failure-events 账本，管理员可在 Web 端直观查看。

---

## 开源协议

基于 [MIT License](LICENSE) 开源发布。

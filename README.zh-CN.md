# OneCastRouter (OCR)

<div align="center">

**面向 [OpenCode](https://opencode.ai) 的生产级智能级联路由与 FinOps 成本优化网关。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Runtime](https://img.shields.io/badge/Runtime-Bun%20%7C%20Node.js-blue.svg)](https://bun.sh)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-green.svg)](https://platform.openai.com/docs/api-reference)
[![FinOps](https://img.shields.io/badge/成本优化-70%25%20~%2090%25-orange.svg)]()

**[快速上手](#快速上手)** · **[客户端配置接入](#客户端配置接入)** · **[核心特性](#特性)** · **[开发者深度指南](DEVELOPMENT.zh-CN.md)** · **[English](README.md)**

</div>

---

## 什么是 OneCastRouter (OCR)？

**OneCastRouter (OCR)** 是一个高性能、本地优先的智能 LLM API 级联路由网关。它与本地运行的 **OpenCode v2** 原生联动，让您无需在任何客户端中硬编码或暴露上游供应商的 API Key，同时通过**智能模型分层、多轮会话单调递增锁、上游 KV 缓存保护以及本地语法断言**，在不牺牲回答质量的前提下，将大模型 API 开销降低 **70% 至 90%**。

---

## 特性

- **💸 70% ~ 90% 成本削减**：简单指令与模式抽取毫秒级由轻量模型承接；复杂编程与高难度逻辑自动、无感升档至顶配旗舰模型。
- **⚡ 免密钥上游代理**：秒级直连本地 OpenCode v2 守护进程，自动拉取已配置的 90+ 活跃模型、凭据与 Token 计费阶梯，客户端完全免配 API Key。
- **🔒 多轮对话单调递增锁（只升不降）**：会话一旦升级至旗舰模型，后续轮次绝不降级至低阶小模型，根除模型乱切带来的“智力骤降”与幻觉。
- **🛡️ 工业级模型熔断与透明容灾 (Circuit Breaker & Failover)**：精准错误解构（402 余额不足硬熔断 12 小时、5xx 连续宕机阶梯退避最高 5 小时、429 频控自适应退避），同 Tier 备选模型毫秒级透明自动故障转移，会话钉扎按配置/健康双力驱逐迁移（Session-Pin Eviction），保障 99.99% 企业级高可用。
- **🚀 经济感知型两层重试与 KV Cache 极致保护 (In-Place Retry & Failover - ADR-0005)**：针对瞬时 5xx 网关毛刺执行原地抖动重试，100% 挽救上游 KV 缓存状态并避免 10x 账单暴涨；同级优先遍历、向上升档保活与严格反向防降级（Anti-Downgrade），兼顾系统高可用与产研代码智力底线。
- **💾 上游 KV Cache 极致保护**：多轮会话物理锁定在完全相同的模型实例上，大幅提高 OpenAI、Anthropic、DeepSeek 等上游厂商的 Prefill 缓存命中率（80%~95%），极速响应并节省缓存开销。
- **🎯 零 Header 前缀链指纹识别**：无需客户端传递任何自定义 Header，基于历史对话前缀链哈希，自动精准追踪多轮会话生命周期。
- **🛡️ 本地静态 Schema 断言与静默重试**：结构化 JSON 输出任务由轻量模型先发执行，若本地 AST / Schema 校验不通过，自动携带报错上下文静默升档至旗舰模型修复重试。
- **🔌 100% 兼容 OpenAI 协议**：无缝作为 Cursor、VS Code、Chatbox、NextChat、LobeChat、LangChain 及各种官方 SDK 的代理中转。

---

## 快速上手

### 1. 环境依赖
* **OpenCode v2**：必需。OCR 面向 opencode v2（provider 配置写在 `providers` 节点，凭证存放在 `opencode.db` 及其 HTTP 服务）。**不支持 opencode v1**：在 v1 机器上 OCR 仍可运行，但会降级——provider 与密钥由 OCR 自有凭证库（`~/.onecast-router/credentials.json`）管理，而 opencode v1 读不到它，因此这些配置只服务于 OCR 网关。控制台会显示明确的告警徽章。升级到 opencode v2 即可共享同一份凭证真相。
* **Bun**（推荐，极致速度）：`>= 1.0`，或 **Node.js**：`>= 18`。

### 2. 安装
```bash
# 克隆仓库
git clone https://github.com/kenlin8827/onecast-router.git
cd onecast-router

# 使用 Bun 安装依赖 (推荐)
bun install

# 或使用 npm 安装
npm install
```

### 3. 配置
每个环境拥有自己的配置文件——默认环境位于 `~/.onecast-router/envs/default/config.yaml`。首次启动会自动写入一份带注释的模板；如果想用完整示例配置起步，复制到该位置即可：
```bash
mkdir -p ~/.onecast-router/envs/default
cp config.example.yaml ~/.onecast-router/envs/default/config.yaml
```
> 💡 **提示**：上游模型和密钥完全由本地 OpenCode 自动托管，`config.yaml` 默认开箱即用，无需填入任何模型密钥！

> 📦 **多环境**：`~/.onecast-router/envs/<name>/` 下每套环境都是完全独立的一整套（配置、密钥、会话、抓包、飞轮数据互不共享）。用 `ocr env create <name>` / `ocr env use <name>`，或控制台 `/environments` 页面管理；切换环境会重启网关。

> ⚙️ **引导开关**：`OCR_ENV`（启动哪套环境）与 `OCR_HOME`（状态根目录，默认 `~/.onecast-router`）**只从进程环境变量读取**——OCR 没有 `.env` 文件加载机制。需要临时隔离实例时：`OCR_HOME=/tmp/ocr-scratch bun run ocr start`。日常切换环境请用 `ocr env use <name>`（或控制台页面），它写入 `~/.onecast-router/envs/current` 指针。

### 4. 启动网关
```bash
# 使用 Bun 运行 (开发/生产均可，带热重载)
bun run dev:bun

# 或使用 Node.js 运行
npm run dev
```
网关默认监听在 `http://127.0.0.1:3000`。

### 5. 探活验证
打开终端执行以下命令，验证服务状态与 OpenCode 模型同步情况：
```bash
curl http://127.0.0.1:3000/health
```
返回示例：
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "modelsCount": 94,
  "timestamp": 1727622400000
}
```

---

## 客户端配置接入

OneCastRouter (OCR) 完全兼容 OpenAI 协议标准，只需将客户端的 **API Base URL** 指向本网关即可。

### 1. Cursor IDE
在 Cursor 中接入无需任何额外插件：
1. 打开 Cursor 设置：`Settings` -> `Models`。
2. 开启 `OpenAI API Key` 选项，密钥填入任意字符串（如 `sk-ocr`）。
3. 展开 `Override OpenAI Base URL`，填入：
   ```
   http://127.0.0.1:3000/v1
   ```
4. 在模型列表输入并勾选推荐虚拟模型：`auto`。

### 2. Chatbox / NextChat / LobeChat
以 NextChat (ChatGPT-Next-Web) 或 Chatbox 为例：
1. **接口地址 (API URL)**：`http://127.0.0.1:3000`（或 `http://127.0.0.1:3000/v1`）。
2. **API Key**：填入任意内容（若在 `config.yaml` 中配置了 `adminApiKey`，则填入该密钥）。
3. **模型 (Model)**：选择或自定义输入 `auto`。

### 3. Python 官方 SDK
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3000/v1",
    api_key="sk-ocr"  # 任意占位符
)

response = client.chat.completions.create(
    model="auto",  # 智能四步级联自动路由
    messages=[
        {"role": "user", "content": "请写一个通用的 TypeScript 防抖函数并附带单元测试。"}
    ]
)

print(response.choices[0].message.content)
```

### 4. Node.js / TypeScript 官方 SDK
```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://127.0.0.1:3000/v1',
  apiKey: 'sk-ocr',
});

async function main() {
  const completion = await openai.chat.completions.create({
    model: 'auto',
    messages: [{ role: 'user', content: '解释量子计算的基本原理。' }],
    stream: true,
  });

  for await (const chunk of completion) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
}

main();
```

### 5. cURL 命令行直接调用
```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [
      {"role": "user", "content": "9.11 和 9.8 哪个数字更大？简要解释理由。"}
    ]
  }'
```

---

## 虚拟模型列表

OneCastRouter (OCR) 在暴露上游全部原生模型的同时，提供了开箱即用的**虚拟级联模型**：

| 模型名称 | 定位与适用场景 | 计费成本区间 |
| :--- | :--- | :--- |
| **`auto`** <br>*(强烈推荐默认)* | **全自动智能级联路由**：自动识别任务复杂度、语法规范及多轮对话历史，动态分派最合适且最具性价比的模型。 | 节省 70% ~ 90% |
| **`auto-lite`** | **强制指定极速低成本层**：针对大批量浅层信息抽取、日常问候、简单翻译。 | 约 $0.10 ~ $0.50 / M Tokens |
| **`auto-plus`** | **强制指定中坚全能主力层**：针对常规系统架构设计、长代码生成与严谨业务分析。 | 约 $2.00 ~ $3.00 / M Tokens |
| **`auto-pro`** | **强制指定高阶推理专家层**：针对高难度形式化逻辑证明、深思考难题与长时程 agent 任务。 | 约 $3.00 ~ $8.00 / M Tokens |
| **`auto-ultra`** | **强制指定旗舰之上顶级档**：小时级自治 agent 任务、旗舰推理极限挑战。 | ≥ $8.00 / M Tokens |
| *上游物理模型名* | 直接透传调用上游的具体物理模型（如 `kimi-k2.7-code`, `deepseek-chat`）。 | 按上游标准定价实报实销 |
| *自定义模型组合* | **用户自由编排的虚拟模型**（`config.combos`）：直接以 combo id 作为 model 调用，网关按主选策略（priority / weighted / round_robin）选首选，故障转移严格限制在配置成员内。每个成员独立享有熔断/重试语义；不参与会话棘轮，绝不跨组合扩员。 | 成员定价加总 |

组合在 `config.yaml` 中定义（也可在控制台 `/combos` 页可视化编辑，保存后即时生效）：

```yaml
combos:
  - id: my-combo            # 客户端可见的虚拟模型名
    selection: weighted     # priority 配置顺序 | weighted 加权随机 | round_robin 轮询
    models:
      - kimi-k2.7-code      # 简写字符串 = weight 1
      - id: deepseek-chat
        weight: 3           # weighted/round_robin 份额
```

---

## 运维观测与 FinOps 大盘

### 1. 响应诊断头（Response Headers）
每次 API 调用均会在 HTTP 响应头中注入详细的 FinOps 性能与成本诊断信息：
* `X-OCR-Tier`：本次实际承接调用的模型层级（`lite`, `plus`, `pro`, `ultra`）。
* `X-OCR-Model`：实际承接推理的上游模型 ID（例如 `volcengine/kimi-k2.7-code`）。
* `X-OCR-Failover`：是否触发了同 Tier 上游故障自动转移（`true` / `false`）。
* `X-OCR-Failover-Attempts`：本次请求尝试调用的模型候选数量（如 `1` 为首次直接成功，`2` 为主模型故障后备用模型成功接管）。
* `X-OCR-Failover-Path`：故障转移的完整模型调用链路（例如 `primary-plus -> secondary-plus`）。
* `X-OCR-Breaker-State`：承接模型当前的熔断器健康状态（`CLOSED`, `HALF_OPEN`）。
* `X-OCR-Session-ID`：自动计算出的会话唯一哈希指纹。
* `X-OCR-Session-Ratchet`：是否触发了多轮只升不降棘轮锁死（`true` / `false`）。
* `X-OCR-Trace-ID`：本次请求在网关中记录的唯一轨迹 ID（例如 `trace_8df3e29a...`）。
* `X-OCR-Cost-USD`：本次调用实际产生的费用。
* `X-OCR-Saved-USD`：相比全程使用旗舰基准模型所**节约的金额**。
* `X-OCR-Latency-MS`：端到端整体网关路由与执行耗时。

### 2. 会话状态与轨迹观测端点

#### 🔍 查看所有活跃会话 `GET /v1/sessions`
```bash
curl http://127.0.0.1:3000/v1/sessions
```

#### 📌 查看单个会话详情 `GET /v1/sessions/:id`
查询指定会话当前的最高锁定层级、物理固定模型、交互轮数与最近 5 轮轨迹摘要：
```bash
curl http://127.0.0.1:3000/v1/sessions/sess_8df3e29a...
```

#### 📜 按会话查询完整调用轨迹 `GET /v1/sessions/:id/traces`
获取该会话自开始以来**每一轮的完整调用轨迹**（含每轮意图、路由判定层级、实际承接模型、耗时及 FinOps 损益）：
```bash
curl http://127.0.0.1:3000/v1/sessions/sess_8df3e29a.../traces
```

#### 🌐 全局请求轨迹查询 `GET /v1/traces`
支持通过 `?session_id=...` 过滤特定会话，或通过 `?limit=50&offset=0` 分页查询全网关最近的路由决策日志：
```bash
curl "http://127.0.0.1:3000/v1/traces?limit=20"
```

#### 🔬 单次请求轨迹透视 `GET /v1/traces/:id`
根据响应头中的 `X-OCR-Trace-ID` 查询单次请求的深度调用轨迹：
```bash
curl http://127.0.0.1:3000/v1/traces/trace_8df3e29a...
```

#### 🗑️ 重置/清除特定会话 `DELETE /v1/sessions/:id`
清除指定会话状态及其轨迹记录，方便客户端从头开启全新上下文：
```bash
curl -X DELETE http://127.0.0.1:3000/v1/sessions/sess_8df3e29a...
```

### 3. 实时经济学大盘 `GET /v1/metrics`
实时查看整个网关当前的累计调用量、节约成本百分比、各层级流量分布及缓存命中率：
```bash
curl http://127.0.0.1:3000/v1/metrics
```
```json
{
  "totalRequests": 1280,
  "cacheHits": 420,
  "cacheHitRatePct": 32.8,
  "fallbackCount": 18,
  "tierDistribution": {
    "lite": { "count": 960, "pct": 75.0 },
    "plus": { "count": 270, "pct": 21.09 },
    "pro": { "count": 50, "pct": 3.91 }
  },
  "economics": {
    "actualCostUsd": 0.512,
    "baselineCostUsd": 4.620,
    "totalSavingsUsd": 4.108,
    "savingsPct": 88.92
  }
}
```

### 4. 熔断器状态大盘与管理
#### 🩺 查询所有模型熔断状态 `GET /v1/health/circuit-breakers`
实时查看所有已注册模型的健康态、熔断原因、剩余冷却时长与调用计数：
```bash
curl http://127.0.0.1:3000/v1/health/circuit-breakers
```
```json
{
  "object": "circuit_breaker_summary",
  "total": 3,
  "healthy": 2,
  "tripped": 1,
  "breakers": [
    {
      "modelId": "claude-3-5-sonnet",
      "state": "OPEN",
      "reason": "Quota or balance exhausted for model 'claude-3-5-sonnet'",
      "category": "QUOTA_EXHAUSTED",
      "remainingCooldownMs": 43190000
    }
  ]
}
```

#### 🔄 管理员手动复位熔断器 `POST /v1/health/circuit-breakers/reset`
在上游账户完成充值或厂商故障排除后，立即复位熔断器重回 CLOSED 健康状态（支持通过 `?model=...` 复位特定模型）：
```bash
curl -X POST http://127.0.0.1:3000/v1/health/circuit-breakers/reset
```

---

## 常见问题 (FAQ)

### Q1: 我需要自己注册模型供应商并充值 API Key 吗？
**不需要**。OneCastRouter (OCR) 原生直连您本地已经配置并运行良好的 OpenCode v2 实例。OpenCode 中已配置好的所有可用模型和配额，OneCastRouter 会自动同步并直接代理。

### Q2: 为什么多轮对话中途不会变笨？
传统基于单条请求的无状态路由器，在面对超长上下文中的简短追问（如“好的谢谢”、“改下第3行”）时，常因字数极短而错误分发给 Lite 轻量小模型，导致小模型面对超万 Token 严重幻觉。OneCastRouter (OCR) 采用**单调递增棘轮状态机（Monotonic Session Ratchet）**，一旦会话进入深度旗舰状态，后续轮次被单向锁死、只升不降，且物理固定同一模型实例，保障智力持续高水平并锁定上游 KV Cache。

### Q3: 本地分类小模型冷启动时会误判吗？
**绝不会**。系统默认附带的未训练微张量底座经过严密数学设计（$W=\mathbf{0}, b=\mathbf{0}$），Softmax 理论概率均匀分布为 $\approx 0.334$，必然小于 $0.85$ 门控阈值。在积累足够生产飞轮数据并执行蒸馏微调前，100% 确定性优雅穿透至 Layer 2 专职裁决模型。

### Q4: 上游某个模型突然欠费或宕机 5 小时怎么办？
**OneCastRouter (OCR) 拥有顶级工业级弹性熔断与故障转移能力 (ADR-0004)**：
- **欠费 / 额度耗尽 (HTTP 402)**：系统即刻将其硬熔断（默认避让 12 小时），后续请求零耗时绕开，绝不会反复冲击上游导致超时；
- **服务雪崩 / 宕机**：连续失败或滑动窗口超限后触发熔断并以指数退避（最高 5 小时封顶）；冷却结束后以微量 Canary 试探探活；
- **同 Tier 透明故障转移 (Failover)**：若 Primary 模型挂了，系统在同一次请求内毫秒级自动切换至同 Tier 的 Backup 备用模型，客户端无感获得 200 响应；
- **会话钉扎驱逐 (Session-Pin Eviction)**：钉扎模型被移出模型池（配置编辑/黑名单/删除）或彻底不可用（模型断路器硬开、或全部凭证下架）时，系统将会话硬切至健康着陆模型并回写绑定（同级已空允许跨级着陆）；若无健康着陆点则保留原钉扎继续服务（安全兜底，下轮重试），根除死锁。

### Q5: 遇到云厂商网关偶发 503 报错，随便切模型会导致 KV 缓存失效和成本暴增吗？
**绝不会**。OneCastRouter (OCR) 采用**经济感知型两层重试架构 (ADR-0005)**：
- **第一层：原地微退避重试 (In-Place Retry)**：针对瞬时 5xx/超时网关毛刺，执行 200ms (+100ms 随机抖动) 的极速原地重试，1 次重试即可化解 ~70% 边缘偶发抖动，**100% 挽救上游已预热的 KV Cache**，彻底避免跨模型切换导致的 10 倍冷启动账单惩罚；
- **第二层：同级优先故障转移与防降级 (Failover & Anti-Downgrade)**：若原地重试耗尽，系统同级优先切换；若 Fast 模型全量故障，允许受控向上升档至 Flagship 兜底保活；**严禁任何将 Flagship 降级至 Fast 的危险操作**，宁可返回 503 绝不以残缺智力生成代码污染生产。

---

## 开发者与架构进阶

如果您对底层的微张量前向计算数学证明、香农熵特征提取、主动学习数据飞轮原地微调训练、架构决策记录等内容感兴趣，请阅读：

* 📘 **[开发者深度指南 (DEVELOPMENT.zh-CN.md)](DEVELOPMENT.zh-CN.md)**：包含完整数学推导、数据飞轮训练指令、单元测试套件解析与代码规范。
* 🏛️ **[架构决策记录 (ADR)](docs/adr/zh-CN/README.md)**：记录 ADR-0001 至 ADR-0008 全部架构选型的事实面定稿（中英双语镜像）。


---

## 开源协议

本项目基于 [MIT 许可证](LICENSE) 开源。

# 限流等待——完整控制流图

[ADR-0023](../../adr/zh-CN/0023-rate-limit-waiting-and-reentrant-admission.md)
的配套流程图（第 1 节可重入准入、第 2 节等待预算、第 2.1 节超时出口、
第 3 节 429 阶梯、第 4 节硬约束）。ADR 的 §1.1 只保留一张收敛总览；
**本文件是完整流程图的留档位置**。英文正本：
[`rate-limit-waiting-flow.md`](../rate-limit-waiting-flow.md)。

> 状态：**拟议中**，与 ADR-0023 同步。**流程图描述目标状态**；引用
> `parseInt` / `evaluate()` / `penalize()` 的说明段落描述的是今天的基线，
> 与 ADR-0023「背景」一节一致。本文件是英文正本的中文镜像：
> **节点 ID 与边拓扑逐字一致，只翻译标签与说明
> 文字**；结构以英文正本为权威。图表与 ADR 表格冲突时，**以 ADR 表格为准**。

## 1. 全链路

一个 request 从准入到唯一终态。四个 subgraph 是控制流的四个归属方；每条跨越
subgraph 边界的箭头，要么是重入 `admitRequest()`，要么是向客户端交接。

```mermaid
flowchart TD
  subgraph A["admitRequest()：每 request 累计预算"]
    A0["request 进入：requestId + 准入状态"]
    A1["peek() 非消耗探测"]
    A2{"命中本地 cap？"}
    A3["apiKeys limits：2s 预算"]
    A4["credentials overlay：30s 预算"]
    A5{"窗口已开？"}
    A6{"预算或重入次数尚余？"}
    A7{"客户端仍存活？"}
    A8["SSE 注释心跳帧"]
    A9["锁定 model x credential，不 rebind"]
  end
  subgraph P["executeCandidatePool：唯一咽喉"]
    P1["tryDispatch()：恰好占 1 个槽"]
    P2{"凭证 cap peek？"}
    P3["跳过该候选"]
    P4["上游调用"]
    P5{"上游结果"}
    P6["成功终态"]
  end
  subgraph R["上游 429 阶梯：按 cache 成本排序"]
    R0{"声明了 Retry-After？"}
    R1{"RA 不超过 30s？"}
    R2["锁定配对原地等待"]
    R3{"RA 小于 2min？"}
    R4["429 + 上游 Retry-After"]
    R5{"可换路：断路器放行且有候选？"}
    R6["换路，rebind"]
    R7["429 + 池内最小 Retry-After"]
    R8["抑制整形冷却"]
  end
  subgraph E["超时出口：§2.1"]
    E0["超时时刻重取 verdict"]
    E1{"绑定来源？"}
    E2["精确值：满约束上 msUntilBelow 的 max"]
    E3["下界：纯 reservation 或池内"]
    E4["Retry-After = max(1, ceil(剩余 ms / 1000))"]
    E5{"200 SSE 头已写出？"}
    E6["429 + Retry-After + 各响应头"]
    E7["SSE error event 携带 retry_after_ms"]
    E8["客户端退避；turn 继续"]
  end
  C0{"relay.committed？"}
  C1["断流，禁止重入"]

  A0 --> A1
  A1 --> A2
  A2 -->|"apiKeys 规则"| A3
  A3 --> A9
  A2 -->|"credentials 覆盖层"| A4
  A4 --> A9
  A2 -->|"无"| P1
  A9 --> A5
  A5 -->|"是"| P1
  A5 -->|"否"| A6
  A6 -->|"是"| A7
  A7 -->|"是"| A8
  A8 --> A1
  A7 -->|"否"| C1
  A6 -->|"否"| E0
  P1 --> P2
  P2 -->|"满额，仍有其他候选"| P3
  P3 --> P2
  P2 -->|"满额，keep-bound 或最后候选"| A4
  P2 -->|"未满"| P4
  P4 --> P5
  P5 -->|"2xx"| P6
  P5 -->|"429"| R0
  P5 -->|"其他失败"| C0
  R0 -->|"是"| R1
  R1 -->|"是"| R2
  R2 --> P4
  R1 -->|"否"| R3
  R3 -->|"是"| R4
  R4 --> E8
  R3 -->|"否"| R5
  R5 -->|"是"| R6
  R6 --> P1
  R5 -->|"否"| R7
  R7 --> E8
  R0 -->|"否"| R8
  R8 --> C0
  C0 -->|"否"| A1
  C0 -->|"是"| C1
  E0 --> E1
  E1 -->|"时间窗口或冷却"| E2
  E2 --> E4
  E1 -->|"纯 reservation 或池内"| E3
  E3 --> E4
  E4 --> E5
  E5 -->|"否"| E6
  E6 --> E8
  E5 -->|"是"| E7
  E7 --> E8
```

两条箭头承载了整个决策：`P2 --> A4` 用来取代今天的 `forced` 立即派发
（满额的 keep-bound 配对**改为等待**，而不是硬打一个满窗口），
`C0 --> A1` 则是调用失败后唯一合法的重入。两者都以 `!relay.committed` 为前提；
`C0 --> C1` 是那个禁止向客户端输出第二份半截流的终态。

## 2. 上游 429 阶梯（放大）

```mermaid
flowchart TD
  S0["上游 429"] --> S1{"Retry-After 解析：Number + isFinite"}
  S1 -->|"HTTP-date 或 NaN：视为无 RA"| S9["无 Retry-After 分支"]
  S1 -->|"毫秒值"| S2{"不超过 maxRateLimitWaitMs（30s）？"}
  S2 -->|"是"| S3["RATE_LIMIT_BURST：锁定配对原地 sleep"]
  S3 --> S4["就地重新派发同一配对"]
  S2 -->|"否"| S5{"小于 failoverThresholdMs（2min）？"}
  S5 -->|"是"| S6["429 + Retry-After = 上游 RA"]
  S5 -->|"否"| S7{"canExecuteScoped 且池内有候选？"}
  S7 -->|"是"| S8["换路，rebind，重新 dispatch"]
  S7 -->|"否"| S10["429 + Retry-After = 池内最小 peek.retryAfterMs"]
  S9 --> S11["抑制 penalize()；断路器仍独立记录"]
  S11 --> S12{"relay.committed？"}
  S12 -->|"否"| S13["返回 admitRequest()，由探测决定等待"]
  S12 -->|"是"| S14["断流，禁止重入"]
  S6 --> S15["客户端退避"]
  S10 --> S15
```

四个 provider 调用点**以及分类器自己的解析**（`error-classifier.ts`，还额外
要求 `parsed > 0`）上的 `parseInt` 会把 `Retry-After: 0.5` 变成 `0`、把
HTTP-date 变成 `NaN`；两者今天都被丢弃，误送进「无声明」分支。只修 provider
四处，`S1` 仍然不诚实。此处 `RATE_LIMIT_BURST` 是 `networkCause` / 可重试原因，
不是分类器的 `ErrorCategory`（后者仍是 `RATE_LIMITED`）。无 RA 的 429 必须
不写整形冷却：`evaluate()` 在窗口数学**之前**查 `cooldowns`，因此一次 60s
的 `penalize()` 会让 30s 预算内每次探测都读到约 60s 的可用时间，重入在
数学上必然超时。

## 3. 超时出口与退避交接（放大）

```mermaid
flowchart TD
  T0["预算耗尽或重入次数为 0"] --> T1["超时时刻用 peek() 重取 verdict"]
  T1 --> T2{"绑定来源？"}
  T2 -->|"滑动窗口"| T3["msUntilBelow()，取满约束的 max"]
  T2 -->|"冷却"| T4["until - now"]
  T2 -->|"纯 reservation"| T5["max(probeIntervalMs, 1s)，标 estimate"]
  T2 -->|"全池"| T6["min(peek.retryAfterMs)，下界"]
  T3 --> T7["剩余 ms，不是首次探测值"]
  T4 --> T7
  T5 --> T7
  T6 --> T7
  T7 --> T8["Retry-After = max(1, ceil(ms / 1000))"]
  T8 --> T9{"200 SSE 头已写出？"}
  T9 -->|"否"| T10["429 + Retry-After + RateLimit-Reset"]
  T9 -->|"是"| T11["event: error 携带 error.retry_after_ms；关闭流"]
  T10 --> T12["code: rate_limit_exceeded；可选 waited_ms"]
  T11 --> T12
  T12 --> T13["客户端退避并重试"]
```

`RateLimit-Limit` / `-Remaining` **只在入站路径**越过边界，那里描述的是
客户端自己的密钥契约；出站路径描述的是调用方并不拥有的凭证，留在事件账本里。
`costUsd` 窗口按时间重开，所以回答 `429 + Retry-After`，**绝不回 `402`**——
SDK 会把 402 读成「不要重试」。仅由 token reservation 撑满的窗口不会随时间
老化，1s 的 `RESERVATION_RETRY_FLOOR_MS` 是拍出来的 floor：原样返回会造成
「1s 后回来、仍然满、再等 1s」的重试风暴。

## 4. 图与 ADR 章节对照

节点标签里的配置键省略了模块前缀；全限定名与目标默认值见 ADR-0023 第 5 节。

| 节点 | ADR-0023 章节 | 管辖表述 |
| :--- | :--- | :--- |
| `A0`–`A9` | 第 1、2 节 | 唯一 `admitRequest()`；累计预算；等待期间锁定配对 |
| `P1`–`P6` | 第 1 节、后果 | `executeCandidatePool` 仍是唯一咽喉；拒绝不计数 |
| `R0`–`R8` | 第 3 节 | 按 cache 成本排序的阶梯；本地 cap 永不单独授权换路 |
| `E0`–`E8` | 第 2.1 节 | 预算耗尽仍要交出可用的退避时刻 |
| `C0`、`C1` | 第 4 节 | `committed` 即终态 |
| `S1`、`S9`、`S11` | 第 4 节 | 共享无损解析器；无 RA 的 429 不写整形冷却 |
| `T2`–`T8` | 第 2.1 节 | 精确值 vs 下界；剩余值而非原始值 |

## 5. 维护约定

- Fig. 1 是唯一一张端到端图。Fig. 2、Fig. 3 分别放大其中的 `R`、`E`
  subgraph；改动任一分支必须两处同步。
- ADR-0023 §1.1 是 Fig. 1 的收敛视图。Fig. 1 的拓扑一旦变动，要检查 §1.1
  是否还在讲同一个故事——这是**第一组**刻意的同源对（Fig. 1 ↔ §1.1），
  不是两份独立副本。
- **双语镜像是第二组同源对**（英文正本 ↔ 本文件）：本文件是
  `../rate-limit-waiting-flow.md` 的中文镜像，节点 ID 与边拓扑逐字一致，只
  本地化标签与说明文字；英文正本为结构权威。任何拓扑改动必须在同一个
  commit 里同步两份，并做一次结构比对。
- 中文镜像放在 `zh-CN/` 子目录，因此不会落入 `AGENTS.md` 的英文文档树
  CJK 检查（`docs/design/*.md` 只匹配一层）。
- 代码落地时由**同一个 commit** 统一推进：ADR-0023 中英双份的状态行 →
  `已接受`，两份索引的状态列 → `已实现`，两份流程图配套文档 → `已实现`。

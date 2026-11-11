# ADR-0018：前向代理规则表

日期：2026-12
状态：已接受（两次修订——见下方两节「修订」）
治理对象：`backend/src/forward-proxy/rules.ts`（解析器）、
`backend/src/forward-proxy/egress.ts`（`ruleDecision` / `isRuleRejected` /
`ruleTunnels` / `transitEgressFor` / `transitProxyFor`）、
`backend/src/forward-proxy/server.ts` 与 `h2-forward.ts`（每条转发腿）、
`backend/src/surfaces/direct-forward.ts`、
`backend/src/config/index.ts`（`resolveForwardProxyConfig`）、
`backend/src/routes/console.ts`（lint + 试算端点）、
`frontend/src/pages/ProxyAccessPage.tsx`（规则卡）。

## 背景

前向代理的策略曾分裂成四套部分机制，用互相重叠的词表描述两个问题。

**问题 A——这个主机的字节往哪走？**
1. `forwardProxy.viaOutboundProxy`——一个全局布尔，管所有非例外主机。
2. `forwardProxy.bypassHosts[].viaProxy`——逐条目的旗标，但只对「同时被排除接管」的主机可达。被接管（MITM）的主机根本没法单独指定出口：`transitProxyFor(host, port, force)` 在所有 MITM 腿上拿到的都是 `force === undefined`，只能跟随全局开关。
3. `proxy.includes` / `proxy.excludes`——provider/model 级列表，前向代理却用 `{ model: host }` 伸手进去，等于把主机名塞进 provider-model 匹配器。于是 `includes` 一旦非空，转发流量会被静默改成直连。

**问题 B——这条连接到底要不要被接管？**
4. `bypassHosts`（拒绝）与 `mitmHosts`（允许）——**同一个轴**上的两条列表，带一个空列表哨兵（「留空 = 除例外外全接管」）和固定的 `拒绝 > 允许 > 默认` 优先级。

没有办法拒绝一个主机。也没有办法说「除了这些，全部走代理」而不去动一个同时管隧道和转发的开关。而「`*.internal.com` 直连」和「`*.internal.com` 不接管」写在两个毫不相干的地方，没人能只看一处就知道一个主机的完整结果。

中间修订曾把它拆成两张有序表（`egressRules` + `decryptRules`）。那消掉了冗余，但没消掉操作者真正的抱怨：一个主机的结果分居两处，而「解密」成了配置里的一等概念。接管是这个产品的默认姿态，不是一种模式——所以它应该是一个**默认值**，而不是一张表。

## 修订 2——两字段 `{ ingress, egress }` 行

上面的单词枚举只是中间形态：它把两个轴又压回了同一个词里，在控制台和配置文件之间切换的操作者得记一张心理映射表（「接管 + 代理 ✓」↔ `proxy-passthrough`）。行形状现在是两个**单轴**字段——控制台每行的控件与 YAML 行逐字同一套词表：

```yaml
forwardProxy:
  rules:
    - { match: "ads.example.com",  ingress: reject,      egress: direct }
    - { match: "*.pinned.example", ingress: passthrough, egress: proxy }
    - { match: "*.internal.com",   ingress: passthrough, egress: direct }
    - { match: "*",                ingress: intercept,   egress: proxy }
```

- `ingress: intercept | passthrough | reject`——进站怎么处理：接管并解密（默认姿态）、纯隧道透传、或准入即 403；
- `egress: direct | proxy`——被放行的字节从哪出：直接本机出网，或走「代理」页配置的上游代理。

`reject` 行必须带 `egress: direct`；`reject` + `egress: proxy` 是**唯一**的非法组合，lint 报出（`invalid-rule`，保持行位），不做静默重映射。`ForwardProxyRule` 携带两个字段；运行时 `RuleDecision` **不变**（由 `ingress`/`egress` 派生出 `{ action: 'direct'|'proxy'|'reject', tunnel, … }`），每条转发腿零改动。这一版当初随附了两种旧拼法的翻译——**修订 3 已把它们彻底删除**（见下）。下文凡出现 `-passthrough` 词形，一律读作 `ingress: passthrough` + 对应的 `egress`。

## 修订 3——只有一种拼法，不做翻译

修订 1 的 `{ action }` 矩阵、初版的 `{ action, tunnel }` 组合，以及 ADR-0018 之前那些 section 键（`viaOutboundProxy` / `bypassHosts` / `mitmHosts`）的折叠，**全部删除**。留着第二个读者是最糟的组合：它保有一套控制台渲染不出来的词表，让今后每次行形状变更都变成三方合并，还掩盖了「这个文件本来就需要重写」这件事。

取而代之的规则各自只有一处：

- 缺少 `ingress` + `egress` 的行就是**无效行**——保持行位，由 `lintRules` 报出（`invalid-rule`），绝不做重新解释；
- schema 未声明的 section 键在 `resolveForwardProxyConfig` 里**直接丢弃**（不折叠、不在下次控制台保存时重新落盘）。因此升级上来的安装从出厂的默认表开始，按唯一存在的那种拼法写出自己要的行。

`normalizeRuleTable` 就是全部契约：显式 `rules` 数组（哪怕是空表）优先，否则用出厂默认表。

## 修订 1——单词 action 枚举

最初版本把一行写成 `{ action, tunnel? }`——两个字段，而 `tunnel` 命名的是**机制**（盲隧道）而不是**效果**（不接管），且与三个 `action` 值不在同一个轴上。五种可能的结局本就是一个封闭集合，所以词表干脆就是那张矩阵：

```yaml
forwardProxy:
  rules:
    - { match: "ads.example.com", action: reject }
    - { match: "*.pinned.example", action: proxy-passthrough }
    - { match: "*.internal.com",  action: direct-passthrough }
    - { match: "*",               action: proxy }
```

| action | 出口 | 是否接管 |
|---|---|---|
| `direct` | 直连 | 接管（默认姿态） |
| `direct-passthrough` | 直连 | 不接管——纯隧道 |
| `proxy` | 出站代理 | 接管（默认姿态） |
| `proxy-passthrough` | 出站代理 | 不接管——纯隧道 |
| `reject` | 无——准入即 403 | — |

基础词是**出口**，`-passthrough` 后缀是「不接管」的显式选择，不带后缀的普通形式仍是默认姿态——所以那一版里不带后缀的行含义不变。`ForwardProxyRule` 删掉 `tunnel` 字段；运行时 `RuleDecision` 保留派生出的 `{ action: 'direct'|'proxy'|'reject', tunnel: boolean }`（出口 + 是否接管），每条转发腿零改动。（这一版随附的 `{ action, tunnel }` 翻译已被修订 3 删除——那种写法的行现在就是无效行，报出、绝不重新解释。）下文凡写 `tunnel: true` 之处，一律按 `-passthrough` 拼法读。

## 决策

### 1. 一张有序表，一行就是一个主机的结果

```yaml
forwardProxy:
  rules:
    - { match: "ads.example.com", action: reject }
    - { match: "*.pinned.example", action: proxy-passthrough }
    - { match: "*.internal.com",  action: direct-passthrough }
    - { match: "*",               action: proxy }
```

`match` 是**裸主机名**的 glob（`*` 跨点，所以 `*.internal.com` **不**覆盖 `internal.com` 本身——两个都要写）。不匹配端口：CONNECT 目标在解析前已剥掉端口。`action` 五选一——五种可能的结局就是词表本身：

| action | 出口 | 是否接管 |
|---|---|---|
| `direct` | 直连本机出网 | 接管（默认姿态） |
| `direct-passthrough` | 直连本机出网 | 不接管——纯隧道 |
| `proxy` | 走出站代理策略——`proxy.enabled` + `proxy.url` | 接管（默认姿态） |
| `proxy-passthrough` | 走出站代理策略——`proxy.enabled` + `proxy.url` | 不接管——纯隧道 |
| `reject` | 无——准入阶段直接回 403 | — |

基础词是出口，`-passthrough` 后缀显式放弃接管：字节照样发往那个出口，但什么都不解密。（历史注：本 ADR 最初把这个 opt-out 写成可选的 `tunnel: true` 旗标；后折入单词本身——见上方「修订」。）

**顺序就是语义。** 没有「最具体胜出」（`*.foo.com` 与 `foo.*` 谁更具体无法定义），也没有类别优先级（`direct` 高于 `proxy` 只是没人能从表里读出来的任意约定）。先命中的规则生效，控制台会报告**命中的是哪一条**。

**为什么是一张表而不是两张。** 两个问题确实独立（「接管但直连」「纯隧道但走上游代理」都真实存在），但其中只有一个有真正的默认值：接管。所以出口必填（每个主机都要有出口，或者被拒绝），「不接管」是可选的例外，绝大多数行根本不写（旧版把这个例外拼成可选的 `tunnel` 旗标，现折入 `-passthrough` 后缀）。拆成 `egressRules` + `decryptRules` 会让操作者为「一个主机的一个问题」去读两张有序表，还把机制词（「解密」）搬上了配置面。因此本 ADR 同时退役了中间那版两张表的拼法：`egressRules` / `decryptRules` 在加载时被剥离。

### 2. 规则表覆盖不了的两条不变量

- **loopback 永远 `egress: direct` + 透传。** `isLoopbackHost` 在查表之前判定：代理或接管 loopback 目标会招致环路（前向代理 → 上游代理 → 前向代理）并破坏本地开发。因此「拒绝 loopback」在语法上写不出来——这是刻意的。
- **未命中 = `direct` + 接管。** 兜底成 `reject` 会让漏写一条规则变成整机流量总闸断掉；兜底成「不接管」会让只想加一条例外的配置静默关掉全量抓包。两个兜底都与 ADR-0018 之前的默认一致，所以**空表不改变任何行为**。

### 3. `reject` 是准入闸，先于接管判定

被拒绝的主机在任何隧道打开之前、任何证书签发之前回 403，三条腿都如此：CONNECT（裸 socket 403，不发 `200 Connection Established`）、明文 absolute-URI、MITM 内层服务（内层 `Host` 可能与 CONNECT 目标不同）。决策写进访问日志账本（`connect (rejected by rule)` / `rejected by rule`），所以「拒绝」是可观测的，不是莫名卡死。

### 4. `action: proxy` 是主机级、终局的

`action` 通过 `outboundProxyUrl()` 解析代理 URL——只看 `proxy.enabled` + `proxy.url`。它刻意**不看** `proxy.includes` / `proxy.excludes`：那两张表回答的是「哪个 provider/model」，让 provider 级列表把主机级决策降级成直连，正是这张表要消除的静默谎言。

`proxy.enabled !== true` 时 `proxy` 解析为直连（`resolveProxyUrl` 在没有启用代理时就是这个行为）。因为规则表否则会显示一个谎言，这个组合被双重暴露：启动告警 + 控制台横幅。

### 5. 作用域：网关替客户端处理的流量

每条转发腿都查表：`forwardTo`（明文代理 + 接管后的 h1）、`tunnel`（盲隧道）、`Upgrade:` 中继、`forwardH2`（接管后的 h2 上游）、管线的 `direct-forward` 中继，以及 client-gateway 中继（`relayUpstream`，ADR-0017 §3 —— 同一道准入门与同一套 egress：插件自己拨号上游就会静默绕过两者）。网关自身的上游调用保留 provider/model 级的 `proxy:` 策略（`providers/*`、`systemone/native`、catalog 同步走 `proxiedFetch`）——`reject` 规则永远不可能把推理打断，两套词表也不会相撞。

放置位置带来的后果：规则表挂在 `forwardProxy.` 下，因此治理前向代理/中继流量。网关自身基础设施调用的主机级出站明确不在范围内；要覆盖它们，需要把规则表提升到顶层 `egress:` 并同步退役 `proxy.includes/excludes`。

### 6. 没有迁移面——退役键直接丢弃，不折叠

已被修订 3 取代。ADR-0018 之前的那些键（`viaOutboundProxy`、`bypassHosts`、`mitmHosts`，以及中间形态的 `egressRules` / `decryptRules`）不属于 schema，由 `resolveForwardProxyConfig` 直接丢弃；既不折叠，也不逐键告警——一个仍在读取死掉的表面的墓碑不是迁移，而是第二份实现。

仍带着它们的安装因此落到出厂默认表（`* → intercept + proxy`），并把行重写成：

| 旧表面 | 等价的一行 |
|---|---|
| `bypassHosts: [<host>]` | `{ match: <host>, ingress: passthrough, egress: direct }` |
| `bypassHosts: [{ host: <host>, viaProxy: true }]` | `{ match: <host>, ingress: passthrough, egress: proxy }` |
| `viaOutboundProxy: true` | 兜底行的 `egress: proxy` |

不升 schema：v1 磁盘 schema 本来就没声明过这些键，丢弃它们是收缩而不是版本变更。新装模板种子为 `enabled: false` + `rules: [{ match: '*', ingress: intercept, egress: proxy }]`——一条兜底：全量接管，出口走上游代理。监听器是总闸，所以这条种子在操作者打开代理之前不路由任何流量；而一旦打开，「全部经上游代理」正是被封锁网络需要的姿态。`reject` 永不出厂。

### 7. 控制台是契约的一部分

有序表只有在能被提问时才可读，所以 `POST /api/admin/forward-proxy/rules/resolve` 针对**未保存**的表返回：

- `warnings`——lint 码（`invalid-rule`、`unreachable-rule`、`no-catch-all`、`proxy-rule-without-proxy`），带操作者所写那一行的下标；措辞由控制台通过 i18n 渲染，规则归后端所有；
- `decision`——探针主机的 `{ action, tunnel, reason, ruleIndex, match }`，由代理腿调用的**同一个** `resolveHost` 产出，所以预览不可能与真实决策不一致。

控制台只说这一行**自己的两个字段**：一个下拉是 `ingress`（接管 / 透传 / 拒绝），一个开关是 `egress`（直连 / 代理），探针的回答也用同样的两个词——所以「UI 词表」不是另一套词表，它就是 schema 本身。这份镜像由 `forward-proxy-console-vocabulary-parity.test.ts` 对着后端运行时的取值表（`RULE_INGRESSES`、`RULE_EGRESSES`、`RULE_WARNING_CODES`）做一致性校验；控制台没有对应句子可渲染的 lint 码会导致类型检查失败，而不是悄悄落到一句错的话上。

新增行插入在兜底规则**之前**并继承其 `egress`——追加在兜底之后将永不命中，那读起来是「功能坏了」而不是「你放错位置了」。重排用 ↑↓ 按钮而非拖拽：列表在滚动容器里，且必须保持键盘可达。

操作系统的代理集成（`system-proxy.ts`）现在从规则表推导绕过列表：字面（非 glob）的 `egress: direct` 行恰好就是「根本不该发给代理」的主机。`proxy` 行必须到达代理，`reject` 行必须到达代理才能被拒——所以 `reject` 即使 `egress` 是 `direct` 也被排除在绕过列表之外。这也修掉一个旧的不一致——`bypassHosts` 曾被写进 OS 绕过列表，哪怕它的出口是「经代理」。

## 后果

- 两个概念取代四套机制：逐主机「字节往哪走」与「这条连接要不要被接管」，由一张有序表的一行回答。
- MITM 腿的出站漏洞被补上：被接管的主机可以独立于其他主机选择直连、经代理或拒绝。
- 「拒绝」变得可表达，并且在账本里可观测。
- `h2-forward` 与 h1 转发器不可能再对出站有分歧（两者都调 `transitEgressFor`）。
- 页面上三段式的出站 UI（全局开关 + 逐行勾选 + 一个经主机名伸手进去的 provider 级列表）与单独的 MITM 白名单，收敛成一张规则卡。
- 用 `mitmHosts` 的安装失去 opt-in 白名单模式；等价写法是一条带 `passthrough` 进站的兜底行（`ingress: passthrough, egress: proxy`）。
- 设置了 `proxy.includes` 并指望它门控转发流量的配置，现在会看到规则表胜出。这是有意的纠正，也是 `proxy` 经 `outboundProxyUrl()` 解析的原因。

## 非目标

- **给接管轴再开一张表。** §1 已否决——一个主机读两遍，还把默认值升格成机制。
- **把 `proxy.includes` / `proxy.excludes` 也改成第三张表。** 那两张表匹配的是 `provider/modelId`（一个字符串三种解释：裸 provider、裸 model id、子串），不是主机；共用 `match` 字段名只会制造混淆。它们也没有「第三套表征互相打架」的问题，而那正是本 ADR 的动因。若那个表面将来需要同样处理，它该有独立 ADR——包括「`includes` 非空时未列出的调用方（catalog 同步、logo 拉取、探活）静默走直连」这个已知 wart。
- **CIDR / IP 段匹配。** `globMatch` 是字符串 glob，`10.0.0.0/8` 没有意义。IPv4/IPv6 字面量按普通字符串匹配。
- **端口级规则。** 规则只匹配裸主机名。
- **覆盖 loopback。** 任何规则都不能代理、拒绝或接管 loopback 目标。
- **逐规则元数据**（标签、备注、命中计数）。这是路由表，不是清单。

# ADR-0039 — 引擎注册运行时，网关不再提名字

- 状态：已接受（已实现）
- 日期：2026-11-26
- 修订：ADR-0038 §4（Strata profile 只是一类通用 profile 的实例）、ADR-0037 §6（运行目标集合是开放的）

## 背景

ADR-0038 把 Strata 变成了第二个运行目标。它用的是"加第二个 case"最常见的方式：把引擎名字写进了每一层需要区别对待的地方。

| 层 | 它长出的 Strata 分支 |
| --- | --- |
| `gguf.ts` | `engineSupportFor` 对任何 GGUF 硬编码 `['llamacpp']`，当私有架构集合命中**且** `opts.strataProfile` 为真时再追加 `'strata'` |
| `runner.ts` | `const isStrata = engine.id === 'strata'`、profile 预检、分层绕过、`launchLegs` 返回 Strata argv、预留 `visionPort`、`servedNameFor` 读 `model.strata.modelName` |
| `routes/local-models.ts` | `/plan` 有 `if (engineId === 'strata')` 分支，`strata:` 载荷按该引擎的旗标塑形 |
| `model-store.ts` | `InstalledModel.strata`、`setStrataProfile` |
| 控制台 | 15 个硬编码输入框的 `StrataLaunchFields`、五处 `choice.engine === 'strata'`、一个按 `strataFamily` 判定的徽标 |

这些对两个引擎都是对的，对三个就都是错的。下一个引擎——vLLM、SGLang、MLX、或另一个 llama.cpp 衍生品——得被穿过全部五层，而每个分支只能靠 grep 名字找到。`strataFamily` 徽标其实已经在漂移：它把一个架构清单塞进了 GGUF **解析器**，而那个模块唯一职责是读头部。

还有一个更安静的问题：`InstalledModel` 只能容纳一个引擎的启动 profile。一个模型若能被两个引擎服务，就需要两份；而"每个引擎一个字段"和"每个引擎一个分支"是同一个错误。

## 决定

### 1. 引擎自带一个 `EngineRuntime`

`backend/src/local/engine-runtime.ts` 就是契约。它只问四个问题：

```ts
interface EngineRuntime {
  placement: 'gateway' | 'engine';       // ctx / 分层归谁
  accepts: { ngl; threads; flashAttn; kv; reasoning };  // 哪些共享控件适用
  serves(input): EngineServeVerdict;     // 能否加载这个文件，不能则说明原因
  resolveCtx?(input): number;            // 仅引擎自持分层时使用
  legs(facts, services): Promise<EngineLeg[] | { error }>;  // 到底起什么进程
  profile?: EngineProfileSpec;           // 运维必须提供什么
}
```

`EngineLeg` 形如 `{ key, cmd, args, cwd, aux, name?, port? }`。引擎腿是 `aux: false`；旁路进程是 `aux: true`，通过 `services.allocatePort()` 拿到自己的端口，其退出只被记录、不致命。这套机制是通用的，但它不是"随手发明一条旁路"的许可：图像走 stdin 工作进程的引擎根本没有端口可分配（§7）。运行记录因此保存 `aux: Array<{ name, pid, port? }>`，不再是 `visionPid`/`visionPort`。

`EngineProfileSpec` 承载：控制台渲染用的 schema（`groups` → `fields`，含 i18n key、类型、上下界、`required`）、路由调用的校验器、runner 预检的路径表、计划面板打印的 `describe()` 摘要，以及可选的 `servedName()`。

这个模块不导入 runner、路由或模型库。运行时是纯数据进出，可单独单测。

### 2. 网关只发问，不点名字

- `engineSupportFor(file, meta, profiles)` 把 `runtime.serves()` 折过整个注册表，自身不含任何引擎名。返回值携带逐引擎裁决（`serves`、`family`、`needsSetup`、`reason`），于是控制台用引擎自己的话解释被阻挡的原因，而不是靠翻译猜。
- `startLocalRun` 按裁决放行，预检 `profile.paths()`，经 `placement` 解析 ctx/ngl（gateway → `plan.ts`；engine → `resolveCtx`），再拉起 `legs()`。`launchLegs` 是异步的，因为运行时可能要分配端口。
- `/plan` 对引擎自持分层返回 `mode: 'declared'` 与通用的 `declaration: { argv, features }`——引擎自己的摘要，于是没有路由需要知道 `--pack` 是什么。声明还可以携带引擎自己的估算（`estTokPerSec`、`firstLoadBytes`——Strata 的加载模型：dense 半驻留显存按 VRAM 带宽，每 token 流过 `expertsUsed / experts` 的专家质量）：控制台把它们显示在和规划器相同的估算卡片上，且 `firstLoadBytes` 是事实（急切加载的字节数）而不是显示数字——首载时间的换算率由控制台自己掌握。
- `/engines` 每行返回 `runtime: { placement, accepts, profile }`。运行页从这一块渲染控件与整张 profile 表单：`accepts.ngl: false` 隐藏层数选择，`profile: null` 隐藏抽屉里的 profile 段。
- 目标推荐搬到 `EngineDef.recommendTarget(detectSummary)`，`detect.ts` 只报告机器事实，推荐表按实际存在的引擎生成。

### 3. profile 按引擎为键，并向前迁移

`InstalledModel.profiles: Record<engineId, unknown>`。读取一律经 `profilesOf()`/`profileFor()`，它们会把遗留的 `strata` 字段折进来；首次写入即把值移入 `profiles` 并删除遗留键。一个模型可以按引擎携带多份 profile，这才是"被两个引擎服务"的真实含义。`setEngineProfile(id, engine, raw)` 的校验器取自 `engine.runtime.profile.normalize`——模型库永远不需要认识某个字段名。

### 4. 注册就是扩展点

`registerEngine(def)` / `unregisterEngine(id)` 修改活注册表，所有消费者读同一份。因此第三个引擎 = 一个导出 `EngineRuntime` 的模块 + 一条目录记录，别无他物。`engine-registry.test.ts` 在运行时注册一个 `.stub` 引擎，并断言文件门控、目录暴露与经 `startLocalRun` 的真实启动——本 ADR 的回归护栏。

### 5. 适配器覆盖整个产品接触面，不只是 runner

引擎是通过六道接缝到达运维的，每一道都由引擎自己声明；任何一道里残留名字判断都是 bug，因为「理论上灵活、实际上写死」就藏在那里：

| 接缝 | 谁回答 | 网关代码 |
|---|---|---|
| 目录（名字、仓库、`descriptionKey`、二进制名、构建目标） | `EngineDef` | `/engines` 原样映射 |
| 版本标签 | `resolveRelease`（单通道）或 `listTags`（标签流） | 一个路由，无 id 判断 |
| 下载与解包 | `matchAssets` + `binaryNames` | `install.ts` 走定义 |
| 启动门控 | `runtime.serves()` | `engineSupportFor` 折注册表 |
| argv 与旁路进程 | `runtime.legs()` | `startLocalRun` 拿到什么起什么 |
| 运维表单 | `runtime.profile`（`groups`/`fields`/`normalize`/`paths`/`describe`） | 控制台渲染它 |

控制台是同一类适配器：它也不点引擎名。运行表单遍历 `runtime.accepts` 渲染共享控件、遍历 `runtime.profile.groups` 渲染引擎自有输入；卡片文案来自 `descriptionKey`，被阻挡原因来自 verdict。`EngineFieldSpec.kind` 因此覆盖 profile 可能的线上形状——`text`、`number`、`select`（选项值为字面量）、`boolean`、`list`（`string[]`）——需要枚举、开关或 argv 列表的引擎，把表单当数据发出来即可。

向后兼容被限制在两处，且都是读路径：`InstalledModel.profiles` 读取时折入本 ADR 之前的 `strata` 字段（首次写入即迁移），旧的 `/models/:id/strata` 路由保留为别名。任何地方都没有「如果这个引擎是 X」的分支。

### 6. 家族清单是**提示**，profile 才是**断言**

逼出这条规则的现场案例：`Swift-Qwen3.8-Flash-Next-…-00001-of-00002.gguf` 的 GGUF 头里 `general.architecture = qwen4exp`、512 个路由专家。Strata 能跑它——运维手动启动它已经好几周——但精选架构清单里没有 `qwen4exp`，于是判定是「不属于本家族」，控制台干脆把 Strata 从选择器里去掉，一个受支持的模型看起来像不受支持。

架构白名单永远落后于厂商。所以它只能决定**文案**，不能决定「这个选项是否存在」：

| 文件 | 判定 |
|---|---|
| 非 GGUF | 拒绝（该引擎加载的是 GGUF 分片） |
| 稠密模型（无路由专家） | 拒绝，并**明说**它是稠密模型——Strata 是 MoE 引擎 |
| MoE，磁盘上找不到工作区 | `family: true`（架构已记录）——仍然可被选择，原因里点名缺了哪个产物 |
| MoE，未记录架构，工作区可解析 | `serves: true`——布局就是断言，架构清单只决定徽标 |

最后一行是关键，而 §8 把断言从「profile」搬到了「磁盘」。完整的运行配置不可能靠猜得到：它指向一个**为某一个模型**构建出来的 pack，它存在，就说明有人已经在这台引擎上跑过这个模型。所以判定问的是「这些产物在不在」，不是「有没有人填过路径」——为了一条架构字符串去否决它，等于网关用一个信息更少的猜测压过运维。

因为判定现在不只取决于文件、还取决于代码，`InstalledModelMeta.scanVersion`（`META_SCAN_VERSION`）记录缓存 verdict 的计算代次；代次一变，缓存行重算一次，升级后控制台绝不会继续显示这个版本已经不会给出的结论。

### 7. HTTP 面不一定是引擎本身（现场修正）

第一版 Strata profile 把引擎命令行拆成了网关字段，拉起 `strata.exe … --port N` 再去轮询 `N`。这两半都是错的，启动根本不可能成功：

- `strata.exe` 自己解析 argv，且把**任何**未知参数当作致命错误（`unknown argument: --port` → `usage()`，退出码 2）。它是一个常驻的 **stdin** 工作进程：`--serve` 让它读 `GEN <max_new> <ids>` / `GENI …` 行、流式写回 `T <id>`。它里面没有 socket。
- OpenAI/HTTP 面是 `serve/server.py`：`--port`/`--host` 归它，`strata … --serve` 由它拉起，配置里有 `vision` 段时 `strata-vision` 编码器也由它拉起。`strata-vision.exe` 同样不是服务：它从 stdin 读 `ENC <image> <out>` 行。

由此得到通用规则：**`legs()` 拉起的是"暴露网关要访问的那个端点"的进程，而它可能是一个启动器，不是模型进程。** 对 Strata 来说就是厂商前端，而它的 `strata-*.json` 运行配置（pack、native 分片、PLE 表、专家二进制、MTP 头、ctx、kv、pool workers、CUDA DLL 目录）就是引擎命令行。把这些重新打成网关字段，等于复制厂商的文件，还把 `--port` 与 `--prefill` 弄错了；所以 profile 只承载配置里没有的东西——而 §8 连这一点也去掉了：配置由网关生成。

控制台上看得见的后果，都是"不留无效控件"：

| 控件 | 为什么对 Strata 隐藏 |
|---|---|
| `-ngl` / 分层条 | 分层由引擎的 `--expert-cache` 自己决定；`ngl` 恒为 `-1` |
| Flash Attention / KV Q8 | 两者都在配置的 `args` 里；前端不接受这两个参数 |
| ctx 阶梯 | **保留**：选中的 ctx 就是生成配置里的 `--max-context`，因为配置是每次启动生成的（§8） |
| 层数/线程预览 | `/plan` 返回 `mode: 'declared'` 与前端 argv |

声明不是把 profile 复述一遍：`describe()` 与 `servedName()` 回答的是启动真正会用的那份布局，所以 MTP / PLE / Vision 三行和对外服务的 `model_name` 都是引擎真正会用的值。

### 8. 不该有人来填目录：配置由网关生成（现场修正）

§7 的 profile 还在向运维要 `root` 与 `config`。这个问法是错的，运维一句话就说清了：**引擎是我们自己的，我们知道 Strata，配置是我们自动构建的。** 这两半都成立，而它们都不需要一张表单。

- **布局是可发现的。** 一个 Strata 工作区是 `<ws>/Strata-main/serve/server.py` 配 `<ws>/Strata-data/{packs,models,mtp}`，而注册表里的模型路径本来就落在里面（`…/Strata-data/models/<模型>/shard-00001-of-00002.gguf`）。所以模型文件就是锚点：向上找 `serve/server.py`，按 `packs/` 与 `models/` 的存在找同级数据根，再按模型自己的文件夹名匹 pack。每一步都是一次必须成功的 stat。
- **配置是网关写的。** `strataEngineArgs` 用解析出的布局加本次启动的 ctx 组装引擎命令行，`writeStrataConfig` 把它落到 `<家目录>/strata/configs/<pack>-ctx<N>.json`。其中 `exe` 来自引擎安装记录——**我们安装的那个引擎，才是要跑的那个**。

布局拒绝猜的情况：

| 情形 | 行为 |
|---|---|
| 两个 pack 同等匹配 | 拒绝，并列出两者——跑错 pack 等于跑错权重 |
| 没有 `serve/server.py` | 拒绝，说明找了哪棵树、在哪找 |
| 没有 `.venv` 解释器 | 拒绝，点名解释器 |
| 稠密模型 | 拒绝（不变，源于引擎本身的性质） |

profile 仍然存在，但只是**可选覆盖**：布局推不出来的产物（`mtp`、`mmproj`——安装事实已在 §10 移到引擎设置，pack 覆盖在 §11 移除），加上两个真正属于单次启动的旋钮（`kv`、`maxContext`）。空记录是常态，这个引擎不会再设 `needsSetup`，`serves()` 也不再以「运维必须提供什么」为前提。

另外两处随之改变：

- `EngineProfileSpec.describe()` / `servedName()` 现在接收模型路径（`EngineProfileWhere`）：空 profile 是合法答案，而布局需要锚点。只给 profile 的签名只能靠编一个路径。
- `META_SCAN_VERSION` 升到 3：第 2 代的缓存行是在「没有 profile 就不能启动」这个前提下算的，而这个问题这个版本已经不问了。

### 9. Pack 也由我们来构建（2026-11-26）

§8 拿掉了配置表单，但还剩一个拒绝理由——「这个模型没有构建好的 pack」。这个问法错得和 §8 一样：打包器是工作区自带的工具（`tools/iq_pack.py`），工作区本来就是网关解析出来的，pack 的输出名也是厂商自己的约定（模型文件夹名小写——正是 `matchPack` 第一个尝试的精确匹配）。运维永远不该手跑打包器。

- **`EngineRuntime.build?` 就是这个能力**，和这里的一切一样是注册制的：它和 `legs()` 一样返回腿，只是没有端口——构建不提供服务。Strata 的构建是**一条腿**：`python tools/iq_pack.py --gguf <分片 1> --out packs/<模型文件夹小写>`。
- **构建不是 run**（`local/build-jobs.ts`）：没有端口、没有健康探测、没有收养、没有重启预算。腿按顺序 spawn，输出流进每个任务自己的日志环，任务以 `done` / `failed` 收场。同一（模型，引擎）只允许一个进行中的构建——两个打包器写同一个 pack 目录会把两批写交错进同一份权重。构建日志与运行日志共用 runner 的行清洗和管道排空，两个抽屉读起来一致。
- **中断安全用的是打包器自己的契约，由我们这边强制执行。** `iq_pack.py` 最后才发布 `native_experts.txt`（「没有它的 pack 不算完成」），而 `looksLikePack` 现在**要求**它在场：一个只构建了一半的 pack——被中断构建的残骸——永远匹配不上，也就永远不可能被拿去服务。
- **判定本身携带这个提议。** 当唯一缺失的产物就是 pack（工作区、解释器、打包器都解析成功）时，`EngineServeVerdict.buildable` 置位。pack 平局仍是运维的决定，绝不触发构建：构建会发布在精确匹配的名字下，等于悄悄选了胜者。控制台凭这个标志渲染构建动作——模型行的「构建 Pack」按钮（导入 → 构建 → 运行）、运行页的「构建并运行」——不点名任何引擎。
- **完成即翻闸门。** 构建完成会重扫模型的 meta（`rescanModelMeta`）——判定是磁盘的函数，而 pack 是新的磁盘状态——于是控制台下一次轮询就把这个引擎变成可启动，不需要重启、不需要 profile。

### 10. 安装事实属于引擎设置，不属于每模型运行时（2026-11-26）

§8 在每模型 profile 里留了三个从来不是模型事实的覆盖项：`workspace`、`dataRoot`、`python` 描述的是**安装**——一台机器一份，所有模型共享。放在每模型层，发现失败就得每个模型重填一遍，这是错误的层。

- **`EngineRuntime.setup?` 是契约**（`EngineSetupSpec`：intro + `EngineFieldSpec[]` + `normalize`），像 profile spec 一样序列化到 `/engines` 行上，由引擎页通用渲染，存进 `local-settings.json` 的 `engineSetup[engineId]`。设置路由经由持有引擎的 `normalize` 校验，自己不认识任何字段名。
- **解析链：setup → 环境变量（`STRATA_HOME`/`STRATA_DATA`）→ 从模型路径发现 → binary 锚点。** 显式的安装路径是运维意图，所以排在发现之前；没有 setup 时，位于另一棵树里的模型仍然按自己的树解析。
- **表单预填发现结果（2026-11-26 修订）。** setup 字段可以声明 `picker: 'directory' | 'file'`（用服务端 `FilePickerModal` 渲染），spec 可以提供 `resolve(ctx): Record<string, string>`——同一条发现链，但去掉模型路径、去掉已存覆盖（过期的 pin 不能被当成"发现答案"回显）。设置路由把结果暴露为 `engineSetupResolved`；控制台显示 stored ?? resolved，保存时把**显示出来**的值固化为 pin——运维看到的路径就是运行的路径。清空字段即交还给自动发现。解析值**跟随**另一个设置的字段（Strata 的 `python` ← 工作区的 `.venv`）声明 `derived: true`：解析值只以占位符幽灵显示，未被亲手编辑就永不固化——固化派生值只会在它跟随的字段变动后变成过期路径。
- **每模型 profile 删掉这三个键。** `normalize` 本来就丢未知键，所以旧版本写入的 `workspace`/`root` 会被忽略而不是报错。留在每模型层的是真正每模型的东西：`mtp`、`mmproj` 逃生舱，以及启动调优（`kv`、`maxContext`）。pack 目录本身保持**不可配置**（§9，§11 进一步强化）：它从数据根下的模型文件夹名推导，构建也发布到那里。

### 11. Pack 覆盖也拿掉了（2026-11-26）

§8 把 `pack` 留在 profile 里，作为两个 pack 同等匹配时的裁决手段。但它一旦被渲染成表单字段，对每个一辈子也遇不到打平的运维来说，读起来都是「请配置你的 pack」——它服务的唯一场景是千年一遇的撞名，而为了一个撞名存在的字段会让常态看起来像是没配完。`StrataProfile.pack` 就此删除：

- **匹配归匹配器，构建归构建器，仅此而已。** `resolveStrataLayout` 无条件走 `matchPack`；旧版本存下的 `pack` 键和其他退役键一样被 `normalize` 忽略。
- **打平在磁盘上解决，不在表单里。** 拒绝理由仍然列出两个候选，现在还给出解法——重命名或删掉多余的，只保留由这个模型构建出来的那个。靠表单里手填一个 pack 路径来裁决来源，本来就不安全：这个决定属于证据所在的地方——packs 目录本身。

### 12. 对着 server.py 源码核实的集成契约（2026-11-26）

对厂商前端（`serve/server.py`，约 5000 行）的一次通读确定了集成可以深入到什么程度。每条结论及其后果：

- **server.py 是监管器，不是薄壳。** 它持有 tokenizer、chat 模板、请求准入（FIFO + batch 槽位）、vision 编码器、引擎重启预算（3 次）和引擎静默看门狗（300 秒）。直接拉起 `strata.exe` 等于把这些全部重写——exe 是没有 tokenizer 的 stdin 工作进程，参数解析零容忍（任何未知 flag 退出码 2）。网关自己的 `autoRestart` 叠在它上面：server.py 重启的是**引擎**，runner 重启的是 server.py。
- **就绪契约天然成立。** `StrataEngine.__init__` 会阻塞到引擎打印 `READY`，server.py 在此之后才绑定端口。因此 runner 基于连接的探测把数分钟的冷加载读作「连接拒绝 = starting」，恰在服务器能应答时翻成 `ready`；`LOCAL_RUN_READY_TIMEOUT_MS`（10 分钟）守在这个窗口上。**`--lazy` / `lazy_load` / `idle_unload_s` 永远不得写进生成的配置**：它们把契约颠倒过来（端口先于权重——`loaded:false` 的 200 `/health` 会把 run 标成 ready，而第一个请求要堵上几分钟）。生成器一个都不写。
- **`parallel` 是唯一的并发旋钮，而且它是配置键，不是引擎参数。** `"parallel": N`（2-8）由 server.py 内部翻译成引擎的 `--batch N`（`parallel_args()`）；把 `--batch` 直接写进 `args` 会绕过服务器自己的簿记。它作为每模型 profile 的可选字段暴露。网关**刻意不算推荐值**：厂商的推荐规则（专家缓存在槽位之外还须装得下一半专家；槽位占缓存不超过五分之一；最多 4 槽——32K 下每槽约 0.56 GiB 显存，专家主要走内存时单请求慢 10-25%）属于厂商的 setup 并随之演化；引擎会把任何请求值裁剪到放得下的程度，所以这个字段取任何值都安全，而留空（一个接一个）对单卡机器仍是正确默认。
- **启动抽屉的 `extraArgs` 落在引擎上**（配置的 `args`）：是给引擎参数用的（`--pool-workers`、`--adapt-async`……）。服务级 flag 填进去（`--gpu`、`--lazy`）会到达一个对未知参数直接退出 2 的 exe——这与每个引擎的裸 argv 字段是同一类踩坑点，写进文档而不是掩盖。
- **`--gpu` / 多卡层切分刻意不接。** server.py 接受 `gpu`（单卡或切分列表）并会计算 `layer_split`，但这台网关面对的机器，正确默认是单卡启动；多卡选择器需要先有多卡探测管线，而一个喂了一半的 `gpu` 值比没有更糟。

### 13. 布局属于网关，不是模型旁边的一份检出（2026-11-27）

§8 从模型文件向上找一棵厂商目录树（`Strata-main/serve/server.py` 配 `Strata-data`）。那是开发者的检出。只装了引擎的机器，`<ocrHome>/engines/strata/<版本>-<目标>` 里只有 `strata.exe` 和 `strata-vision.exe`。这个 exe 仍然不是 HTTP 服务（§7），所以安装还会带上发行包里的 control bundle。

- **两个目录，都在网关主目录下。** `<ocrHome>/strata/runtime` 是 control bundle（`serve/server.py` 和它自带的 Python）。`<ocrHome>/strata/data` 放 `packs/`、`models/`、`mtp/`，启动需要时创建。生成的配置仍在 `<ocrHome>/strata/configs`。模型文件留在注册表原来的位置。pack 按模型文件夹名，在我们自己的数据目录下匹配。
- **跑的 exe 是网关装的那一份。** runtime 树里碰巧有的二进制不是第二台引擎，也不会被优先选用。
- **缓存的判定会重算。** `META_SCAN_VERSION` 是 5。第 4 代缓存可能因为模型文件躺在一份检出里就写成 `serves: true`，也不会给「只缺 pack」带上 `buildable`。已装模型页用 `family` 表示兼容，用 `buildable` 放出「构建 Pack」，用 `reason` 说明为什么还不能启动。
- **引擎页显示这些路径。** `setup.resolve` 返回 `runtime`、`data` 和解释器（`runtime/python/python.exe`，否则该目录的 `.venv`），文件还没落地也照样返回。一个写着「自动发现」的空框会把安装真正用的目录藏起来。手填的 pin 仍然覆盖；一个看起来不像它所命名之物的 pin 会被忽略。清空字段就回到这几个目录。
- **control bundle 是伴随资源**，不在引擎压缩包里：`strata-control-<引擎版本>-<系统>-<架构>.zip`（Windows）或 `.tar.gz`，解压到 `strata/runtime`。引擎包仍可单独安装；发行里没有这份 bundle 时，启动会点名缺的前端。

## 后果

- 新增引擎会触及：它自己的运行时模块、目录记录、i18n 文案、profile 字段描述。**不会**触及 runner、路由、模型库、`gguf.ts` 或控制台。
- 运行表单已是数据驱动。不在描述里的字段无法被输入；运维手写、控制台不渲染的字段在保存后原样保留（表单克隆已存对象，只覆盖自己的键）。
- 被阻挡的引擎自己说话。拒绝文案是运行时给出的英文原文，不是本地化字符串——这是有意的取舍：准确的原因胜过错误的翻译，同一句话也会落在运行日志里。
- 共享形状不再点任何引擎的名字。`strataFamily` 是最后一个：它已从 `EngineSupport` 与新写入的 meta 中移除（字段仅作为可选、已弃用的读取保留，供本 ADR 之前缓存的记录使用）。家族判断全部落在逐引擎 verdict 的 `engines[id].family` 上，控制台读的就是它。
- 分层规划器未被改动，仍是唯一的放置估算者；声明 `placement: 'engine'` 的引擎永远不会拿到分层条。
- 运行时可以拉起一个启动器，而不是模型二进制（§7）。它唯一不能做的事，是假设这两者是同一个进程，或假设引擎接受网关的 `--port`。

## 修订 — 2026-11-26：能力开关与下拉式参数字段

- `EngineRunControls` 新增 `spec` 与 `vision`。它们命名的是能力（预测草稿头、
  视觉腿），不是机制：运行页为每个能力渲染「自动/关闭」开关，"off" 如何表达由
  引擎自己的 profile 决定。Strata 的表达是 `mtp` / `mmproj` 键上的 `'off'`
  哨兵——跳过自动发现，本次启动不跑草稿或只跑文本，声明 chips 随之变化。控制台
  写入哨兵时仍然不点名任何引擎：它只写字段描述符声明的键。
- 参数字段一律渲染为下拉，禁用原生 `<select>`：`select` 字段的选项可在字面
  label 之外携带 `labelKey`（i18n），`customizable: true` 会追加「自定义…」
  选项，把下拉切换为手填路径输入——常见情况是点选，稀有的路径覆盖依然可行。
  Strata 的 `maxContext` 是 `CTX_LADDER` 上的下拉（与运行页 ctx 阶梯同一来源）。

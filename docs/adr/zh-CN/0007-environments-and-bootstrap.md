# ADR-0007: 环境——账本目录、受控重启切换、脱敏导出 / 设防导入

## 状态

已实现 — 2026-10-15（事实面语料重写）。范围："环境"在磁盘上是什么、如何被选中/切换/导出/导入/删除。凭证存储刻意偏全局（对照 ADR-0006 §3/§7）；断路器记忆按环境（ADR-0004 §5）——两个刻意划开的分界都在彼篇成文。

## 决策

### 1. 单一布局，无模式分支

每个环境一个目录：`<home>/envs/<name>/`，内含 `config.yaml · data/ · models/ · catalog/ · traces/ · capture/ · webauth-secret · env.json`（`config/env.ts:241-255`）。`<home>` = `~/.opencode-router`，被 `OCR_HOME` 整体覆写——唯一的沙箱杠杆（隔离测试器给每个测试文件自己的 `OCR_HOME` + `OCR_ENV=default`）。进程级文件（`ocr.pid`、`ocr.log`、`ocr.info.json`）驻 `<home>` 根、不属于任何环境；`info.json` 记录活动环境名。`default` 是引导层：永远可解析、首启由脚手架创建、不可手工创建/改名/入废纸篓。`env.json` = schema-v1 元数据 `{name, type, createdAt, schemaVersion, description?, importedFrom?}`；名称语法 `^[a-z0-9][a-z0-9_-]{0,31}$` + 大小写不敏感去重。

legacy 布局支持是被**移除**而非兼容分叉：无 `legacyConfigPath()`、无模式分支——前环境位置（repo-root `config.yaml`/`data`/`models`、`<home>/{catalog,traces,capture,webauth-secret}`）没有任何代码路径读取；升级的机器从脚手架默认起步，旧文件要就手抄。不发布迁移工具。`ensureEnvScaffold` 只建目录——带注释的 `config.yaml` 模板归配置层；`createEnv` 模板 = `blank | copy-current | copy-default`（只复制配置；数据永不复制）。

### 2. 解析：OCR_ENV > 指针 > default——customPath 不是环境杠杆

选择优先级：`OCR_ENV`（fail-fast：点名不存在的环境 = 启动错误，绝不静默回退）→ `envs/current` 指针文件（原子 temp+rename；**损坏指针是唯一宽容环节**：回落 default + 每进程一次告警）→ `default`。`customPath` 只是显式的配置文件参数（`getConfigPath(customPath?)`，CLI `--config`、测试）——覆盖所选环境的 `config.yaml` 路径，**永不**选择环境。解析结果进程级缓存（`resolveEnvName` 严格 / `peekEnvName` 宽容供徽标）——import-time 单例的现实迫使切换以重启为界（ADR-0005 的启动作用域池同根同源）。

### 3. 切换 = 受控重启交接；热换被拒

进程内热切环境被以明文理由拒绝：WAL 化的 SQLite 句柄（traces.db 共享 + finops + ratelimit 各自按环境于启动打开）、模块级路径单例、Windows 对运行中目录的文件锁。控制台 `POST /api/admin/environments/:name/switch` 是唯一带重启副作用的路线（CLI `ocr env use` 只写指针，下次启动生效）。切换序列：404 守卫 → 目标已在跑？只钉指针不重启 → 单飞行守卫 → 写指针（"切回 default"写**字面值** `"default"`，不删指针）→ spawn 携带 `OCR_RESTART_OF=<父 pid>` 的脱离子进程 → 父进程 500ms 后退出；子进程等父死（15s 强杀）、300ms 放端口、消费自身重启标记（不收养递归）。PORT/HOST 纪律区分两种子进程：普通重启**钉住**当前 PORT/HOST；环境切换子进程**既不钉也不继承**——由目标环境自己的 `config.yaml` 决定（继承来的 `HOST=0.0.0.0` 会强制 webAuth 到一个父已退出的子进程上 = 全网关中断）。spawn 失败指针回滚、父继续服务。目标配置端口不同则响应携带 `newPort`（钳 1-65535），前端跟随重定向。运行中环境的改名/替换/删除/reset 一律拒绝（Windows 文件锁，理由诚实）。

### 4. 每环境 web-auth secret

会话 cookie = HMAC-SHA256 签名的 `ocr_session`（HttpOnly、SameSite=Lax）；签名 secret 驻**活动环境**的 `webauth-secret` 文件——首用即 `randomBytes(32)` hex 0600 创建、熬过重启（Restart 按钮不得把操作员踢下线）、且按环境隔离意味着一个环境的 cookie 不能在另一个环境重放有效。secret 不可读 → 进程内临时兜底（绝不炸启动）。非回环绑定仍在启动硬闸 webAuth（`validateWebAuthStartup`）。

### 5. 导出——显式 'ocr-env' 信封、默认脱敏

容器：格式 id `'ocr-env'` version 1，传输名 `.orc_env.zip`（`<name>-YYYYMMDD.orc_env.zip`）——**自有**信封（manifest + config.yaml + payload 条目），不是 opencode 兼容文件，也明确不是被弃用的自定义 `OCRENC1` 容器。Payload 白名单是**封闭**的五个键：`data/flywheel.jsonl`、`data/layer2-decisions.jsonl`、`models/layer1-classifier.json`、`catalog/custom.json`、`catalog/overrides.json`——`catalog/ocr.json` 刻意排除（签名键控缓存，重建可得）。秘密策略：`webAuth.passwordHash` **永远**删除；会话 secret / CA 材料 / traces / capture / 日志**永不**入档；配置内的凭证值默认脱敏（`__REDACTED__` 哨兵 + `redactedPaths` 列表；类型无关——`adminApiKey`、`providers[*].apiKey`、`apiKeys[*].key`、带 userinfo 的 `proxy.url`、`opencode.password` 处非空标量即遮）；明文密钥仅显式 `?secrets=include`。`?include=` 选 payload 子集（未知键忽略——封闭集合即契约）。`?encrypt=1` ⇒ 标准 zip + WinZip AE-2 AES-256 条目（zip.js，PBKDF2-HMAC-SHA1 钉死 WinZip 的 1000 轮，CRC-32 存 0，manifest sha256 仍是完整性层；密码经 `x-ocr-archive-password` 头——**永不**走 query；`encrypt=1` 蕴含 `secrets=include`——加密层即保护所在；第三方解压软件凭密码可开；离线解密脚本随仓）。

### 6. 导入——默认新建、替换经废纸篓、守卫成栈

`POST /api/admin/environments/import`——只收 zip 字节（Content-Type 不被信任），body ≤ 64 MB。守卫栈全部生效：条目白名单（`../escape.txt` 之类恶意名可**列**不可**取**）；zip-bomb 在解压前查中央目录（单条目 32 MB / 总量 128 MB）；路径遍历双重检查（验证期 + 写点再 `safeResolveWithin`）；payload 白名单**强于**遍历安全（payload 里的 `config.yaml/env.json/webauth-secret` 键被拒——它们会把未受控内容偷运过脱敏线）；信封版本门（比本构建新 = "升级 OCR 再导入"）；校验和必需且逐字节（净化发生在校验**之后**）；`__REDACTED__` 哨兵递归剥离、`__proto__/constructor/prototype` 键在配置还原时丢弃；**错误密码与损坏字节不可区分**（同一个 400——不做解密神谕）；`?name=` 重定目标仍过同一语法/保留名校验。语义：`mode=create`（默认）永不覆盖（409 + `suggestion: <name>-imported`）；`mode=replace` 把旧账本**先**移入 `envs/.trash`（可恢复，与删除同机制）再写新——RUNNING 目标拒绝；`default` 恰可经此废纸篓→脚手架→归档之路被替换（刻意的恢复路径）。写失败半成品入废纸篓。

### 7. 删除与沙箱

删除 = 确认闸的**移动**而非 rm：`envs/.trash/<name>-<timestamp>`（指向被删环境的指针一并原子清除）；`default` 受护；RUNNING 拒绝。`EnvType = regular | sandbox`；`POST /:name/reset` **仅**沙箱环境——清 `data/ traces/ capture/`、留 `config.yaml + env.json`；regular 环境永不被静默清空（CLI `ocr env create --sandbox`、`ocr env reset` 经 daemon info 拒清运行中环境）。`/api/admin/environments` 下九条路线（list 带 current+running+sizeBytes、current、create、import、PATCH 改名/描述、delete、reset、export、switch）；`switch` 是唯一有重启副作用的路线（spawn/exit 可注入供测试）。

## 后果

- "一个环境"就是一个可折叠的目录：拷贝目录，或走脱敏信封——状态边界从布局本身可见。
- 切换语义匹配运行时的真实约束（启动作用域单例），失败模式（指针回滚、不继承端口的子进程、newPort 重定向）皆有成文而非临场发挥。
- 测试：`env-resolution`、`env-archive`（含加密/导入守卫）、`environments-api`、`env-file-immunity`。

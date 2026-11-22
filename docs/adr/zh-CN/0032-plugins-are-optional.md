# ADR-0032 — 插件一律可选：任何发行物都不携带插件包

- **状态:** 已实施
- **日期:** 2026-11-17
- **取代:** [ADR-0029](../0029-package-lifecycle.md) §1（应用用发行构建产物填充自有层）及其「全新安装首启即带随包插件」的结论
- **关联:** [ADR-0017](../0017-client-gateway-plugins.md)（插件契约、应用自有层）、[ADR-0027](../0027-client-adapter-plugins.md)（client-adapter 包）、[ADR-0028](../0028-multi-part-plugins.md)（多 part 包）、[ADR-0030](../0030-client-hooks-ship-with-their-gateway.md)（钩子随其网关）

## 背景

ADR-0029 §1 把 `.plugin-dist/*.zip` 变成了发行物，好让插件包成为产品功能的交付方式：桌面包把 `.plugin-dist/` 作为 `plugins/` 资源带上，npm 包的 `files` 列出 `.plugin-dist`，桌面壳把 `OCR_BUNDLED_PLUGIN_SRC` 指向自己的资源目录，每次启动都把这些 zip 复制进 `<ocrHome>/plugins/bundled/`，成为**应用自有**插件包。

结果是：每个插件都成了每个渠道、每个运营者发行物的强制组成部分。

- 安装包与 npm 包都带着某个运营者可能永远不会用到的集成代码——以及其中的厂商 wire 决策。
- 这些包按定义属于应用自有，因此上传路由**拒绝**覆盖或升级它们（ADR-0017 §6）。修一个插件需要发一次应用版本，而想要另一个版本的运营者没有任何受支持的路径。
- 「我不要这个集成」不是一个可选项：卸载只写墓碑、字节留在盘上，下一个版本又把同样的文件塞回来。

运营者的要求正好相反：**插件一律可选，且完全不得发行。** 网关才是产品；插件是运营者自己加的。

## 决策

### 1. 任何渠道都不携带插件包

- `desktop/src-tauri/tauri.conf.json` 只打包 `frontend/dist/`。不存在 `plugins/` 资源，因此安装包、MSI 与免安装 exe 里只有外壳、控制台静态资源与网关 sidecar。
- 根 `package.json` 的 `files` 不再包含 `.plugin-dist`：npm 包只发 `bin/`、`backend/dist/`、`frontend/dist/` 与文档。装 CLI 永远不会顺带装上插件。
- 桌面壳不再设置 `OCR_BUNDLED_PLUGIN_SRC`，打包安装没有任何插件来源可指。

`.plugin-dist/` 仍是一个**构建产物**（`bun run plugins:build`）：它是运营者安装时使用的产物集，不是发行物的组成部分。

### 2. 应用自有层只允许显式投放，绝不自动

`bundledPluginSourceDir()` 仅当 `OCR_BUNDLED_PLUGIN_SRC` 指明目录时才返回来源。仓库内的默认回退（`<root>/.plugin-dist`，按模块自身位置解析）被**移除**：源码运行不得把工作区的构建产物悄悄提升为应用自有状态——应用自有包是无法通过上传覆盖的。

因此正常启动什么都不投放，`bundled/` 为空。`OCR_PLUGIN_SRC_DIR` 依旧直接关闭投放（开发树优先于任何打包副本）。

### 3. 应用自有层的语义保留，只去掉「随包发行」的叙事

`<ocrHome>/plugins/bundled/` 仍然存在（ADR-0017 §6）：放在这里的包属于应用自有，在发现顺序上优先于运营者安装，上传无法覆盖，卸载写墓碑而不删文件。它只由显式指明的投放来源、或运营者刻意放置的文件填充。ADR-0029 的投放机制全部保留——字节比较以免改写 mtime（从而避免 `ensureUnpacked` 失效）、每个 id 只留一份、清单不合法的包不投放、墓碑不动。

### 4. 生命周期与措辞跟上新事实

安装/升级/拒绝/墓碑行为不变（ADR-0029 §2–4）。所有权拒绝的文案改为陈述事实——`'<id>' is an app-owned package (plugins/bundled) — disable it from the plugins page instead of installing an override`、`plugin id 'ocr-*' is reserved for app-owned packages`——不再声称某包「随网关发行」。

### 5. 安装入口只有控制台

Plugins 页仍是添加插件的唯一入口（`POST /plugins/install`，上传 `.plugin-dist/` 里的 zip 或插件自身发布物）。没有自动下载、没有更新通道、没有首启拉取：想要网关、模型服务或客户端钩子的运营者自己装，不想要的得到的是一台没有插件行的网关。

## 结论

- 全新安装的桌面版**没有任何插件**。过去首启即到的集成——`opencode-gateway`（代理模式）、`cursor-gateway`、`qoder-gateway`、`jetbrains-gateway`（前向代理客户端钩子）与 `qoder-models` / `workbuddy-models`（模型服务）——在安装之前一律不存在，相关的 Client Hub 行与 provider 类型也就不会被提供。
- 版本发布不再修插件，插件也不再迫使发版。包版本由运营者选择，升级插件永远不需要升级应用。
- 没有任何包会「意外」变成应用自有：正常安装 `bundled/` 为空，上传路由不会被没人要的包挡住。
- `ocr-*` 保留命名空间现在只是命名空间守卫（核心词汇 vs 运营者包），不再意味着这类包存在。
- 启动只在指明投放来源时才写入 `<ocrHome>/plugins/bundled/`，只读的 home 不受影响。
- 若 `tauri.conf.json` 重新引入 `plugins/` 资源，或 `files` 重新引入 `.plugin-dist`，插件会被悄悄重新发行。两者必须保持缺席，桌面壳也不得设置 `OCR_BUNDLED_PLUGIN_SRC`。

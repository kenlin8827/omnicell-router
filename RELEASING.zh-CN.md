# OmniCellRouter (OCR) 发行与打包发布指南

<div align="center">

[![npm](https://img.shields.io/npm/v/omnicell-router.svg?color=blue)](https://www.npmjs.com/package/omnicell-router)
[![Desktop Release](https://img.shields.io/github/v/release/kenlin8827/omnicell-router?color=purple)](https://github.com/kenlin8827/omnicell-router/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[英文版 (English)](RELEASING.md) | [中文版 (Chinese)](RELEASING.zh-CN.md) | [用户使用手册 (README)](README.zh-CN.md)

</div>

本文档详细介绍了 **OmniCellRouter (OCR)** 的两大发布渠道与发行流程：

1. **npm Registry 官方源 (`omnicell-router`)**：Web 控制台与 CLI 完整网关包。用户通过 `npm install -g omnicell-router` 全局安装或通过 `npx omnicell-router` 免安装直接启动。
2. **GitHub Releases 多平台桌面版**：独立的原生桌面安装包（Tauri v2 + 嵌入式 Bun 编译网关 Sidecar），覆盖 Windows (`.exe` NSIS)、macOS (`.dmg` 包含 Apple Silicon 与 Intel) 以及 Linux (`.AppImage`, `.deb`)。

---

## 1. 发行架构总览

```
                      ┌──────────────────────────────────────────────┐
                      │              OmniCellRouter 源码库             │
                      └───────┬──────────────────────────────┬───────┘
                              │                              │
                     npm 发布 (Web/CLI 网关)         GitHub Actions Tag 推送 (桌面版)
                              │                              │
                              ▼                              ▼
                 ┌─────────────────────────┐   ┌───────────────────────────┐
                 │       npm 官方源         │   │      GitHub Releases      │
                 │   (omnicell-router)      │   │     (多平台桌面安装包)     │
                 └────────────┬────────────┘   └─────────────┬─────────────┘
                              │                              │
                     `npm i -g ...`                 桌面客户端安装包:
                     `npx ...`                      - Windows NSIS (.exe)
                              │                     - macOS 苹果芯片 M 系列 (.dmg)
                              ▼                     - macOS Intel 芯片 (.dmg)
                     CLI 命令行 & Web 控制台        - Linux AppImage 与 Deb
                     (`ocr start / web`)            - 原生桌面托盘与客户端窗口
```

---

## 2. 发布到 npm 官方源 (`omnicell-router`)

### 2.1 npm 安装包运行机制

- **全局可执行命令**：用户安装后，npm 会自动在系统 `PATH` 中注册 `ocr` 与 `omnicell-router` 命令，指向跨平台脚本 [bin/ocr.js](file:///d:/OpenHub/omnicell-router/bin/ocr.js)。
- **原生 Node.js 兼容**：运行时支持 Node.js (>= 18.0.0)，终端用户无需预先安装 Bun 或 TypeScript。
- **内嵌完整 Web 控制台**：发布包内仅包含编译后的生产文件（前端 [frontend/dist](file:///d:/OpenHub/omnicell-router/frontend/dist) 与后端 [backend/dist](file:///d:/OpenHub/omnicell-router/backend/dist)），包解压体积仅约 28 MB（内嵌了完整的离线字体与静态资产）。
- **完整生命周期管理**：支持所有 CLI 指令，如 `ocr start`（后台启动）、`ocr web`（启动并打开浏览器）、`ocr status`（查看监控）和 `ocr stop`（停止服务）。

### 2.2 发布前准备

1. 拥有 [npmjs.com](https://www.npmjs.com/) 注册账号。
2. 本地已安装 Node.js (>= 18) 或 Bun。
3. 终端已配置并登录 npm 账号（支持双重身份验证 2FA）。

### 2.3 npm 发布步骤全流程

#### 步骤 1：切换至官方源
确保当前终端使用的是 npm 官方源，而非淘宝等第三方镜像源：

```bash
npm config set registry https://registry.npmjs.org/
```

#### 步骤 2：登录 npm 账号
在终端运行登录命令：

```bash
npm login
```
终端会弹出浏览器授权或提示输入用户名、密码及一次性动态验证码 (OTP)。登录后验证身份：

```bash
npm whoami
```

#### 步骤 3：更新版本号
根据本次更新性质，递增 `package.json` 中的版本号：

```bash
# Bug 修复 / 小改动（如 0.0.1 -> 0.0.2）
npm version patch

# 新增向下兼容功能（如 0.0.1 -> 0.1.0）
npm version minor

# 重大架构更新 / 不兼容改动
npm version major
```

#### 步骤 4：本地打包预检（Dry-run）
在发布前执行模拟打包，确保上传文件精简纯净：

```bash
npm pack --dry-run
# 或者使用 Bun：
bun pm pack --dry-run
```

确认清单仅包含：
- `bin/ocr.js` 与 `bin/` 脚本；
- `backend/dist/`（编译后网关后端）；
- `frontend/dist/`（编译后 Web 控制台前端静态资源）；
- `README.md`、`README.zh-CN.md`、`LICENSE`。
- 测试用例、源代码（`*.ts`, `*.tsx`）、`.git` 和 `desktop/` 源码均被自动排除。

#### 步骤 5：执行正式发布
运行发布命令：

```bash
npm publish --access public
```

> [!NOTE]
> 根目录 `package.json` 中配置了 `"prepublishOnly": "bun run build"` 钩子，npm 会在打包前自动执行全量构建（`tsc -p backend && vite build frontend`），确保发布代码为最新编译产物。

#### 步骤 6：验证用户安装
发布成功后，可另开一个终端窗口或在测试机上验证：

```bash
# 全局安装
npm install -g omnicell-router

# 查看版本
ocr --version

# 启动 Web 控制台（自动拉起后台服务并打开浏览器）
ocr web
```

---

## 3. 多平台桌面版安装包发布 (GitHub Releases)

OCR 桌面端基于 Tauri v2 框架开发，网关后端通过 Bun 单文件交叉编译（`bun build --compile`）直接注入为原生 Sidecar 二进制。

### 3.1 目标平台与安装包格式

| 目标系统与架构 | 平台编译目标 (Target) | 打包格式 | 安装包文件名格式 |
| :--- | :--- | :--- | :--- |
| **Windows x64** | `x86_64-pc-windows-msvc` | NSIS | `OmniCellRouter_<版本>_x64-setup.exe` |
| **macOS (Apple Silicon)** | `aarch64-apple-darwin` | DMG | `OmniCellRouter_<版本>_aarch64.dmg` |
| **macOS (Intel)** | `x86_64-apple-darwin` | DMG | `OmniCellRouter_<版本>_x64.dmg` |
| **Linux x64** | `x86_64-unknown-linux-gnu` | AppImage & DEB | `OmniCellRouter_<版本>_amd64.AppImage`<br>`OmniCellRouter_<版本>_amd64.deb` |

### 3.2 自动化 GitHub Actions 发布流水线

工程已在 [.github/workflows/desktop-build.yml](file:///d:/OpenHub/omnicell-router/.github/workflows/desktop-build.yml) 中配置全自动发布流水线，任何以 `v*`（如 `v0.1.0`）格式的 Git Tag 推送都会自动触发：

1. **多平台矩阵并行编译**：
   - `windows-latest`：编译 Windows NSIS 极速安装包；
   - `macos-latest`：交叉编译 Apple Silicon (`aarch64`) 与 Intel (`x86_64`) 的 DMG 镜像；
   - `ubuntu-22.04`：在 Linux 容器中链接 webkit2gtk-4.1 并打包 AppImage 与 deb 安装包。
2. **网关 Sidecar 版本注入**：
   - 自动运行 `desktop/scripts/build-sidecar.ts`，将当前 Tag 版本号注入到编译二进制中。
3. **自动创建 Release 并上传安装包**：
   - `release` 任务会自动汇总上述所有操作系统的安装包产物；
   - 自动创建 GitHub Release，生成 Release Notes，并将全部平台的 `.exe`、`.dmg`、`.AppImage`、`.deb` 文件挂载至资产列表。

### 3.3 桌面版发布操作步骤

#### 步骤 1：确认并同步版本号
版本号以根 [package.json](file:///d:/OpenHub/omnicell-router/package.json) 为唯一事实源，人工只改它；其余副本（子包 package.json、`desktop/src-tauri/tauri.conf.json`、`Cargo.toml`、`Cargo.lock`）由 `npm version` 生命周期钩子经 [scripts/version-sync.ts](file:///d:/OpenHub/omnicell-router/scripts/version-sync.ts) 自动同步：

```bash
npm version minor        # 0.1.0 -> 0.2.0，钩子自动同步全部版本副本
```

漂移由 CI 守门（`desktop-build.yml` 的 `bun scripts/version-sync.ts --check`），也可本地自查：

```bash
bun scripts/version-sync.ts --check
```

#### 步骤 2：提交代码并打 Tag
```bash
git add .
git commit -m "chore: release v0.1.0"
git tag v0.1.0
```

#### 步骤 3：推送 Tag 到 GitHub
```bash
git push origin v0.1.0
```

#### 步骤 4：查看 GitHub Actions 构建进度
1. 访问 GitHub 仓库的 **Actions** 页面，可观察 `desktop-build` 流水线各系统并发构建状态；
2. 构建完成后（约 15-20 分钟），进入 GitHub 仓库的 **Releases** 页面；
3. 确认新版本已成功发布，且 Assets 附件中已包含了全部操作系统的桌面安装包。

---

### 3.4 本地编译桌面版（可选 / 开发调试）

如需在本地开发机调试或直接编译当前平台的安装包：

```bash
# 1. 构建全量后端与前端代码
bun run build

# 2. 编译本地平台对应的网关 Sidecar 二进制
cd desktop
bun run sidecar

# 3. 运行本地打包
bun run build
```

打包生成的安装包文件保存在：
`desktop/src-tauri/target/release/bundle/`

---

## 4. 完整发行 CheckList 检查清单

在对外进行新版本发布时，建议按照如下步骤逐一确认：

- [ ] 本地测试套件全绿：`bun run test`（121 个测试套件，1600+ 用例通过）。
- [ ] TypeScript 类型检查无误：`bun run typecheck`。
- [ ] 版本号只改根 `package.json` 并运行 `npm version <patch|minor|major>`（钩子自动同步其余副本；`bun scripts/version-sync.ts --check` 应全绿）。
- [ ] 提交代码变更：`git commit -m "chore: release vX.Y.Z"`。
- [ ] 推送 Git Tag 触发桌面版发布：`git tag vX.Y.Z && git push origin vX.Y.Z`。
- [ ] 检查 GitHub Actions 流水线是否成功发布 Release 并挂载了所有平台安装包。
- [ ] 执行 npm 发布：`npm publish --access public`。
- [ ] 验证用户安装：运行 `npm install -g omnicell-router`，测试 `ocr --version` 与 `ocr web`。

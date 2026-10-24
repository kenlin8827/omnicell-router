# OmniCellRouter (OCR) Release & Packaging Guide

<div align="center">

[![npm](https://img.shields.io/npm/v/onecast-router.svg?color=blue)](https://www.npmjs.com/package/onecast-router)
[![Desktop Release](https://img.shields.io/github/v/release/kenlin8827/onecast-router?color=purple)](https://github.com/kenlin8827/onecast-router/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English Version](RELEASING.md) | [Chinese Version](RELEASING.zh-CN.md) | [User README](README.md)

</div>

This document describes how to package and publish **OmniCellRouter (OCR)** across its two distribution channels:

1. **npm Registry (`onecast-router`)**: The CLI & Web Gateway package, installable globally via `npm install -g onecast-router` or executable via `npx onecast-router`.
2. **GitHub Releases (Desktop Applications)**: Multi-platform standalone desktop packages (Tauri v2 + embedded Bun gateway sidecar) for Windows (`.exe`), macOS (`.dmg`), and Linux (`.AppImage`, `.deb`).

---

## 1. Distribution Architecture Overview

```
                      ┌──────────────────────────────────────────────┐
                      │              OmniCellRouter Repo              │
                      └───────┬──────────────────────────────┬───────┘
                              │                              │
                    npm Publish (Web/CLI)           GitHub Actions Tag Push (Desktop)
                              │                              │
                              ▼                              ▼
                 ┌─────────────────────────┐   ┌───────────────────────────┐
                 │     npm registry        │   │      GitHub Releases      │
                 │   (onecast-router)      │   │  (Multi-Platform Assets)  │
                 └────────────┬────────────┘   └─────────────┬─────────────┘
                              │                              │
                     `npm i -g ...`                 Desktop Installers:
                     `npx ...`                      - Windows NSIS (.exe)
                              │                     - macOS Apple Silicon (.dmg)
                              ▼                     - macOS Intel (.dmg)
                     CLI & Web Gateway              - Linux AppImage & Deb
                     (`ocr start / web`)            - Native Desktop Shell
```

---

## 2. Publishing to npm Registry (`onecast-router`)

### 2.1 How the npm Package Works

When installed via npm:
- **Global Executables**: Installs `ocr` and `onecast-router` commands on the system `PATH` via [bin/ocr.js](file:///d:/OpenHub/opencode-router/bin/ocr.js).
- **Runtime Portability**: Runs natively on Node.js (>= 18.0.0) without requiring Bun or TypeScript compiler installed on the user's host.
- **Embedded Web Console**: Ships pre-compiled static assets ([frontend/dist](file:///d:/OpenHub/opencode-router/frontend/dist)) and server dist ([backend/dist](file:///d:/OpenHub/opencode-router/backend/dist)), keeping the unpacked download size around 28 MB.
- **Lifecycle Commands**: Users can run `ocr start`, `ocr web` (or `ocr ui`), `ocr status`, and `ocr stop`.

### 2.2 Prerequisites

1. An account on [npmjs.com](https://www.npmjs.com/).
2. npm CLI logged in to your account with 2FA configured.
3. Node.js (>= 18) or Bun installed locally.

### 2.3 Step-by-Step npm Publishing Procedure

#### Step 1: Ensure Official Registry
Ensure your npm client is pointed to the official registry rather than a private or third-party mirror:

```bash
npm config set registry https://registry.npmjs.org/
```

#### Step 2: Authenticate with npm
Log in to your npm account from the terminal:

```bash
npm login
```
Follow the interactive prompt in your browser or enter your credentials and OTP (One-Time Password). Verify authentication status:

```bash
npm whoami
```

#### Step 3: Bump the Package Version
Update the version in `package.json`:

```bash
# For a bug fix or patch:
npm version patch

# For new features (backward-compatible):
npm version minor

# For major breaking changes:
npm version major
```

#### Step 4: Pre-Publish Verification
Before publishing, run a dry-run pack to ensure the bundle contains only the required distributions:

```bash
npm pack --dry-run
# Or with Bun:
bun pm pack --dry-run
```

Verify that:
- `bin/ocr.js` is included.
- `backend/dist/` and `frontend/dist/` are included.
- `README.md`, `README.zh-CN.md`, and `LICENSE` are included.
- Source files (`*.ts`, `*.tsx`), tests, `.git`, and `desktop/` source are excluded.

#### Step 5: Publish the Package
Run the publish command:

```bash
npm publish --access public
```

> [!NOTE]
> `package.json` contains `"prepublishOnly": "bun run build"`, which automatically compiles both backend TypeScript and frontend Vite production bundles before the files are uploaded to npm.

#### Step 6: Verify User Installation
Test the published package on a clean machine or terminal:

```bash
# Global install test
npm install -g onecast-router

# Verify version
ocr --version

# Verify help manual
ocr --help

# Start web console
ocr web
```

---

## 3. Publishing Multi-Platform Desktop Releases (GitHub Releases)

OCR provides native desktop shells for Windows, macOS, and Linux built using Tauri v2 and an embedded Bun sidecar binary.

### 3.1 Target Matrix & Artifacts

| Platform / Architecture | Target Triple | Bundle Type | Output Artifact Name Pattern |
| :--- | :--- | :--- | :--- |
| **Windows x64** | `x86_64-pc-windows-msvc` | NSIS | `OneCastRouter_<ver>_x64-setup.exe` |
| **macOS Apple Silicon** | `aarch64-apple-darwin` | DMG | `OneCastRouter_<ver>_aarch64.dmg` |
| **macOS Intel** | `x86_64-apple-darwin` | DMG | `OneCastRouter_<ver>_x64.dmg` |
| **Linux x64** | `x86_64-unknown-linux-gnu` | AppImage & DEB | `OneCastRouter_<ver>_amd64.AppImage`<br>`OneCastRouter_<ver>_amd64.deb` |

### 3.2 Automated GitHub Actions Pipeline

The workflow defined in [.github/workflows/desktop-build.yml](file:///d:/OpenHub/opencode-router/.github/workflows/desktop-build.yml) automatically triggers upon pushing any tag matching `v*` (e.g., `v0.1.0`):

1. **Parallel Cross-Compilation**:
   - `windows-latest`: Builds Windows NSIS installer.
   - `macos-latest`: Cross-compiles both ARM64 and x64 DMG images.
   - `ubuntu-22.04`: Builds AppImage and Debian packages with webkit2gtk-4.1 dependencies.
2. **Sidecar Injection**:
   - Compiles `backend/src/index.ts` using Bun's standalone executable compiler with compile-time version injection (`--define __OCR_VERSION__`).
3. **Automated Release Creation**:
   - The `release` job collects artifacts from all four runners.
   - Creates a GitHub Release tagged with your version.
   - Generates release notes and attaches all desktop installers as release assets.

### 3.3 Desktop Release Steps

#### Step 1: Synchronize Versions
Ensure both root `package.json` and `desktop/src-tauri/tauri.conf.json` have matching version strings:

- `package.json`: `"version": "0.1.0"`
- `desktop/src-tauri/tauri.conf.json`: `"version": "0.1.0"`

#### Step 2: Commit and Create Tag
Commit any pending changes and tag the release:

```bash
git add .
git commit -m "chore: release v0.1.0"
git tag v0.1.0
```

#### Step 3: Push Tag to GitHub
Push the tag to your remote repository:

```bash
git push origin v0.1.0
```

#### Step 4: Monitor and Confirm Release
1. Open the GitHub repository **Actions** tab and watch the `desktop-build` workflow.
2. Once complete (~15-20 minutes for all runners), navigate to the **Releases** page.
3. Confirm that the new release is published with all `.exe`, `.dmg`, `.AppImage`, and `.deb` files attached.

---

### 3.4 Local Desktop Build (Optional / Development)

To test the desktop installer locally before tagging:

```bash
# 1. Build backend and frontend dist
bun run build

# 2. Build local platform sidecar binary
cd desktop
bun run sidecar

# 3. Build native desktop bundle
bun run build
```

Generated bundles are located under:
`desktop/src-tauri/target/release/bundle/`

---

## 4. Full Release Checklist

Follow this checklist for a unified public release:

- [ ] All test suites pass: `bun run test` (121 suites, 1600+ test cases).
- [ ] TypeScript type checks pass: `bun run typecheck`.
- [ ] Update version in `package.json` and `desktop/src-tauri/tauri.conf.json`.
- [ ] Commit changes: `git commit -m "chore: release vX.Y.Z"`.
- [ ] Push git tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
- [ ] Verify GitHub Actions release workflow finishes and desktop assets are attached.
- [ ] Publish npm package: `npm publish --access public`.
- [ ] Test fresh installation via `npm install -g onecast-router` and `ocr web`.

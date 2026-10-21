#!/usr/bin/env bash
# Remote one-line installer for OneCastRouter (OCR)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/kenlin8827/onecast-router/main/install.sh | bash
#
set -e

REPO="kenlin8827/onecast-router"
INSTALL_DIR="$HOME/.local/share/onecast-router"
BIN_DIR="$HOME/.local/bin"

if [ -t 1 ]; then
  CYAN='\033[0;36m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  RED='\033[0;31m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  CYAN=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; NC=''
fi

echo -e "${CYAN}${BOLD}"
echo "  ⚡ OneCastRouter (OCR) - One-Click Installer"
echo "  High-Performance FinOps & Cascading Gateway for AI Coding Agents"
echo -e "${NC}"

# 1. Local checkout detection
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"
IS_PREBUILT=false

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ] && grep -q "onecast-router" "$SCRIPT_DIR/package.json" 2>/dev/null; then
  echo -e "${GREEN}✔ Detected local repository checkout at: ${SCRIPT_DIR}${NC}"
  TARGET_REPO="$SCRIPT_DIR"
else
  echo -e "📦 Installing OneCastRouter into ${INSTALL_DIR}..."
  mkdir -p "$INSTALL_DIR"
  DOWNLOADED=false

  echo -e "${CYAN}Checking GitHub for latest prebuilt release...${NC}"
  LATEST_RELEASE=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null || echo "")
  ASSET_URL=$(echo "$LATEST_RELEASE" | grep -o 'https://[^"]*onecast-router-dist.tar.gz' | head -n 1 || echo "")
  TAG_NAME=$(echo "$LATEST_RELEASE" | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4 || echo "")

  if [ -n "$ASSET_URL" ]; then
    echo -e "${CYAN}Downloading prebuilt release ${TAG_NAME}...${NC}"
    TMP_TAR="/tmp/onecast-router-dist.tar.gz"
    if curl -fsSL "$ASSET_URL" -o "$TMP_TAR" 2>/dev/null; then
      echo -e "${CYAN}Extracting prebuilt archive into ${INSTALL_DIR}...${NC}"
      tar -xzf "$TMP_TAR" -C "$INSTALL_DIR"
      rm -f "$TMP_TAR"
      DOWNLOADED=true
      IS_PREBUILT=true
      echo -e "${GREEN}✔ Successfully installed prebuilt release ${TAG_NAME}!${NC}"
    fi
  fi

  if [ "$DOWNLOADED" != "true" ]; then
    if [ -d "$INSTALL_DIR/.git" ]; then
      echo "Updating existing installation via git..."
      git -C "$INSTALL_DIR" pull --ff-only || true
    else
      git clone --depth 1 "https://github.com/${REPO}.git" "$INSTALL_DIR"
    fi
  fi
  TARGET_REPO="$INSTALL_DIR"
fi

# 2. Check runtime (Bun or Node)
cd "$TARGET_REPO"
if command -v bun >/dev/null 2>&1; then
  echo -e "${GREEN}✔ Found Bun runtime ($(bun --version))${NC}"
  bun install
  if [ "$IS_PREBUILT" != "true" ] && [ ! -f "$TARGET_REPO/frontend/dist/index.html" ]; then
    echo -e "${CYAN}Building Web Console...${NC}"
    bun run build:frontend
  fi
elif command -v npm >/dev/null 2>&1; then
  echo -e "${GREEN}✔ Found Node.js runtime ($(node --version))${NC}"
  npm install
  if [ "$IS_PREBUILT" != "true" ] && [ ! -f "$TARGET_REPO/frontend/dist/index.html" ]; then
    echo -e "${CYAN}Building Web Console...${NC}"
    npm run build:frontend
  fi
else
  echo -e "${YELLOW}⚠ Neither Bun nor Node was found on PATH. Attempting automatic install or fallback...${NC}"
fi

# 3. Register global shims
mkdir -p "$BIN_DIR"
if [ "$TARGET_REPO/bin" != "$BIN_DIR" ]; then
  cp -f "$TARGET_REPO/bin/ocr" "$BIN_DIR/ocr"
  cp -f "$TARGET_REPO/bin/onecast-router" "$BIN_DIR/onecast-router"
fi
chmod +x "$BIN_DIR/ocr" "$BIN_DIR/onecast-router"

# 4. PATH detection & export
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo -e "${YELLOW}Adding $BIN_DIR to your shell PATH...${NC}"
    for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
      if [ -f "$rc" ]; then
        if ! grep -q "$BIN_DIR" "$rc"; then
          echo -e "\nexport PATH=\"$BIN_DIR:\$PATH\"" >> "$rc"
        fi
      fi
    done
    export PATH="$BIN_DIR:$PATH"
    ;;
esac

echo -e "\n${GREEN}${BOLD}🎉 OneCastRouter (OCR) installed successfully!${NC}\n"
echo -e "You can now run:"
echo -e "  ${CYAN}ocr start${NC}             # Start the gateway daemon"
echo -e "  ${CYAN}ocr web${NC}               # Open the Web Console Dashboard"
echo -e "  ${CYAN}ocr setup opencode${NC}    # Hook OpenCode to route via OCR"
echo -e "  ${CYAN}ocr setup claude${NC}      # Hook Claude Code to route via OCR"
echo -e "  ${CYAN}ocr setup codex${NC}       # Hook Codex to route via OCR"
echo -e "  ${CYAN}ocr status${NC}            # Check gateway health and metrics\n"

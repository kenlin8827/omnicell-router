#requires -Version 5.1
<#
.SYNOPSIS
    Remote one-line installer for OneCastRouter (OCR).
.EXAMPLE
    irm https://raw.githubusercontent.com/kenlin8827/onecast-router/main/install.ps1 | iex
#>
$ErrorActionPreference = 'Stop'

$Repo = "kenlin8827/onecast-router"
$InstallDir = Join-Path $env:LOCALAPPDATA "onecast-router"
$BinDir = Join-Path $InstallDir "bin"

Write-Host ""
Write-Host "  ⚡ OneCastRouter (OCR) - Windows One-Click Installer" -ForegroundColor Cyan
Write-Host "  High-Performance FinOps & Cascading Gateway for AI Coding Agents" -ForegroundColor DarkGray
Write-Host ""

# 1. Local checkout detection
$LocalRepo = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "package.json"))) {
  $pkg = Get-Content (Join-Path $PSScriptRoot "package.json") -Raw
  if ($pkg -match "onecast-router") {
    $LocalRepo = $PSScriptRoot
    Write-Host "[OCR] Detected local repository checkout at: $LocalRepo" -ForegroundColor Green
  }
}

$TargetRepo = if ($LocalRepo) { $LocalRepo } else { $InstallDir }

if (-not $LocalRepo) {
  Write-Host "[OCR] Installing OneCastRouter into $InstallDir..." -ForegroundColor Cyan
  if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  }
  
  if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host "[OCR] Updating existing installation..." -ForegroundColor Cyan
    git -C $InstallDir pull --ff-only
  } else {
    git clone --depth 1 "https://github.com/$Repo.git" $InstallDir
  }
}

# 2. Check runtime (Bun or Node)
Push-Location $TargetRepo
try {
  $bun = Get-Command bun -ErrorAction SilentlyContinue
  if ($bun) {
    Write-Host "[OCR] Found Bun runtime ($(& bun --version))" -ForegroundColor Green
    & bun install
    Write-Host "[OCR] Building Web Console..." -ForegroundColor Cyan
    & bun run build:frontend
  } elseif (Test-Path "D:\dev\bun\bin\bun.exe") {
    Write-Host "[OCR] Found Bun runtime at D:\dev\bun\bin\bun.exe" -ForegroundColor Green
    & "D:\dev\bun\bin\bun.exe" install
    Write-Host "[OCR] Building Web Console..." -ForegroundColor Cyan
    & "D:\dev\bun\bin\bun.exe" run build:frontend
  } else {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
      Write-Host "[OCR] Found Node runtime ($(& node --version))" -ForegroundColor Green
      & npm install
      Write-Host "[OCR] Building Web Console..." -ForegroundColor Cyan
      & npm run build:frontend
    } else {
      Write-Host "[OCR] ⚠ Neither Bun nor Node found in PATH." -ForegroundColor Yellow
    }
  }
} finally {
  Pop-Location
}

# 3. Create Shims in BinDir
if (-not (Test-Path $BinDir)) {
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
}

$SourceBinDir = Join-Path $TargetRepo "bin"
Copy-Item (Join-Path $SourceBinDir "ocr.cmd") (Join-Path $BinDir "ocr.cmd") -Force
Copy-Item (Join-Path $SourceBinDir "ocr.ps1") (Join-Path $BinDir "ocr.ps1") -Force
Copy-Item (Join-Path $SourceBinDir "onecast-router.cmd") (Join-Path $BinDir "onecast-router.cmd") -Force
Copy-Item (Join-Path $SourceBinDir "onecast-router.ps1") (Join-Path $BinDir "onecast-router.ps1") -Force

# 4. Check and Append to User PATH
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($UserPath -like "*$BinDir*")) {
  Write-Host "[OCR] Adding $BinDir to User PATH..." -ForegroundColor Yellow
  [Environment]::SetEnvironmentVariable('Path', "$UserPath;$BinDir", 'User')
  $env:PATH = "$env:PATH;$BinDir"
}

Write-Host ""
Write-Host "🎉 OneCastRouter (OCR) installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "You can now run:" -ForegroundColor White
Write-Host "  ocr start             " -NoNewline -ForegroundColor Cyan; Write-Host "# Start the gateway daemon" -ForegroundColor DarkGray
Write-Host "  ocr web               " -NoNewline -ForegroundColor Cyan; Write-Host "# Open Web Console" -ForegroundColor DarkGray
Write-Host "  ocr setup opencode    " -NoNewline -ForegroundColor Cyan; Write-Host "# Hook OpenCode to route via OCR" -ForegroundColor DarkGray
Write-Host "  ocr setup claude      " -NoNewline -ForegroundColor Cyan; Write-Host "# Hook Claude Code to route via OCR" -ForegroundColor DarkGray
Write-Host "  ocr setup codex       " -NoNewline -ForegroundColor Cyan; Write-Host "# Hook Codex to route via OCR" -ForegroundColor DarkGray
Write-Host "  ocr status            " -NoNewline -ForegroundColor Cyan; Write-Host "# Check gateway health and metrics" -ForegroundColor DarkGray
Write-Host ""

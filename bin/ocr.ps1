#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CliTs = Join-Path $ScriptDir "..\backend\src\cli\index.ts"
$DistJs = Join-Path $ScriptDir "..\backend\dist\cli\index.js"
if (-not (Test-Path $DistJs)) {
  $DistJs = Join-Path $ScriptDir "..\dist\cli\index.js"
}

if (-not (Test-Path $CliTs)) {
  $FallbackCliTs = Join-Path $env:LOCALAPPDATA "omnicell-router\backend\src\cli\index.ts"
  if (Test-Path $FallbackCliTs) {
    $CliTs = $FallbackCliTs
    $DistJs = Join-Path $env:LOCALAPPDATA "omnicell-router\backend\dist\cli\index.js"
    if (-not (Test-Path $DistJs)) {
      $DistJs = Join-Path $env:LOCALAPPDATA "omnicell-router\dist\cli\index.js"
    }
  }
}

$bun = Get-Command bun -ErrorAction SilentlyContinue
if ($bun) {
  & bun run $CliTs @args
  exit $LASTEXITCODE
}

$bunDefault = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
if (Test-Path $bunDefault) {
  & $bunDefault run $CliTs @args
  exit $LASTEXITCODE
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  if (Test-Path $DistJs) {
    & node $DistJs @args
  } else {
    & npx tsx $CliTs @args
  }
  exit $LASTEXITCODE
}

Write-Error "[OCR ERROR] Neither bun nor node found in PATH."
exit 1

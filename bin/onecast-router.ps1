#requires -Version 5.1
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $ScriptDir "ocr.ps1") @args
exit $LASTEXITCODE

@echo off
setlocal
set "CLI_TS=%~dp0..\backend\src\cli\index.ts"
set "DIST_JS=%~dp0..\backend\dist\cli\index.js"
if not exist "%DIST_JS%" (
  set "DIST_JS=%~dp0..\dist\cli\index.js"
)

if not exist "%CLI_TS%" (
  if exist "%LOCALAPPDATA%\omnicell-router\backend\src\cli\index.ts" (
    set "CLI_TS=%LOCALAPPDATA%\omnicell-router\backend\src\cli\index.ts"
    set "DIST_JS=%LOCALAPPDATA%\omnicell-router\backend\dist\cli\index.js"
    if not exist "!DIST_JS!" (
      set "DIST_JS=%LOCALAPPDATA%\omnicell-router\dist\cli\index.js"
    )
  )
)

where bun >nul 2>nul
if %ERRORLEVEL% equ 0 (
  bun run "%CLI_TS%" %*
  exit /b %ERRORLEVEL%
)

if exist "%USERPROFILE%\.bun\bin\bun.exe" (
  "%USERPROFILE%\.bun\bin\bun.exe" run "%CLI_TS%" %*
  exit /b %ERRORLEVEL%
)

where node >nul 2>nul
if %ERRORLEVEL% equ 0 (
  if exist "%DIST_JS%" (
    node "%DIST_JS%" %*
    exit /b %ERRORLEVEL%
  )
  npx tsx "%CLI_TS%" %*
  exit /b %ERRORLEVEL%
)

echo [OCR ERROR] Neither bun nor node found on PATH.
exit /b 1

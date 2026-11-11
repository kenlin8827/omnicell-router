; Custom NSIS hooks (tauri.conf.json bundle.windows.nsis.installerHooks).
;
; The installer script these macros are inserted into is the VENDORED template
; `nsis/installer.nsi` (tauri.conf.json bundle.windows.nsis.template), a copy of
; the stock tauri v2 template plus one added wizard page. Everything said below
; about "the STOCK template" still holds: that code is stock and untouched.
; Upgrades must replace a RUNNING app: kill both binaries before file copy
; (otherwise the old images keep serving stale code) and auto-start the
; fresh build afterwards.

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /T /IM "OmniCellRouter.exe"'
  nsExec::Exec 'taskkill /F /T /IM ocr-backend.exe'
  Sleep 1500
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Exec '"$INSTDIR\OmniCellRouter.exe"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM ocr-backend.exe'
  ; The tray's "Start with system" autostart value is removed by the STOCK
  ; template (`DeleteRegValue HKCU …\Run "${PRODUCTNAME}"` under
  ; `${If} $UpdateMode <> 1`, generated installer.nsi), so this hook must not
  ; delete it a second time with a different guard — two guards drift apart.
  ${If} $UpdateMode <> 1
    ; Remove the `ocr`/`omnicell-router` shims this install registered. Marker-
    ; scanned in PowerShell (not via the gateway's `uninstall-shims`) because an
    ; older binary predating `--cli` would boot the server here and hang the
    ; uninstaller. Only packaged self shims match; repo trampolines survive.
    ; Decoded script:
    ;   $d = Join-Path $env:LOCALAPPDATA 'omnicell-router\bin'
    ;   Get-ChildItem -LiteralPath $d -File -ErrorAction SilentlyContinue |
    ;     Where-Object { (Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue) -match 'omnicell-router-self-shim' } |
    ;     Remove-Item -Force -ErrorAction SilentlyContinue
    nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand JABkACAAPQAgAEoAbwBpAG4ALQBQAGEAdABoACAAJABlAG4AdgA6AEwATwBDAEEATABBAFAAUABEAEEAVABBACAAJwBvAG0AbgBpAGMAZQBsAGwALQByAG8AdQB0AGUAcgBcAGIAaQBuACcACgBHAGUAdAAtAEMAaABpAGwAZABJAHQAZQBtACAALQBMAGkAdABlAHIAYQBsAFAAYQB0AGgAIAAkAGQAIAAtAEYAaQBsAGUAIAAtAEUAcgByAG8AcgBBAGMAdABpAG8AbgAgAFMAaQBsAGUAbgB0AGwAeQBDAG8AbgB0AGkAbgB1AGUAIAB8ACAAVwBoAGUAcgBlAC0ATwBiAGoAZQBjAHQAIAB7ACAAKABHAGUAdAAtAEMAbwBuAHQAZQBuAHQAIAAtAEwAaQB0AGUAcgBhAGwAUABhAHQAaAAgACQAXwAuAEYAdQBsAGwATgBhAG0AZQAgAC0AUgBhAHcAIAAtAEUAcgByAG8AcgBBAGMAdABpAG8AbgAgAFMAaQBsAGUAbgB0AGwAeQBDAG8AbgB0AGkAbgB1AGUAKQAgAC0AbQBhAHQAYwBoACAAJwBvAG0AbgBpAGMAZQBsAGwALQByAG8AdQB0AGUAcgAtAHMAZQBsAGYALQBzAGgAaQBtACcAIAB9ACAAfAAgAFIAZQBtAG8AdgBlAC0ASQB0AGUAbQAgAC0ARgBvAHIAYwBlACAALQBFAHIAcgBvAHIAQQBjAHQAaQBvAG4AIABTAGkAbABlAG4AdABsAHkAQwBvAG4AdABpAG4AdQBlAA=='
  ${EndIf}
  Sleep 500
!macroend

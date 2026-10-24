; Custom NSIS hooks (tauri.conf.json bundle.windows.nsis.installerHooks).
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
  Sleep 500
!macroend

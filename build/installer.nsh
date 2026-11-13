; Chromium's renderer sandbox cannot start in every Windows session, and the
; failure happens before the app's own JavaScript runs — so the launch path has
; to pass --no-sandbox. Shortcuts are created best-effort; a .cmd launcher is
; always written next to the executable because it needs no shell COM.
;
; The shortcut is named "DeepSeek Harness Desktop" on purpose: a plain
; "DeepSeek Harness.lnk" already exists on many machines (it launches `dsh web`
; in a browser), and we must not overwrite or delete it.
!macro customInstall
  CreateShortCut "$DESKTOP\DeepSeek Harness Desktop.lnk" "$INSTDIR\DeepSeek Harness.exe" "--no-sandbox" "$INSTDIR\DeepSeek Harness.exe" 0
  CreateDirectory "$SMPROGRAMS\DeepSeek Harness Desktop"
  CreateShortCut "$SMPROGRAMS\DeepSeek Harness Desktop\DeepSeek Harness Desktop.lnk" "$INSTDIR\DeepSeek Harness.exe" "--no-sandbox" "$INSTDIR\DeepSeek Harness.exe" 0

  FileOpen $0 "$INSTDIR\Launch DeepSeek Harness.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 "start $\"$\" $\"%~dp0DeepSeek Harness.exe$\" --no-sandbox$\r$\n"
  FileClose $0
!macroend

!macro customUnInstall
  Delete "$DESKTOP\DeepSeek Harness Desktop.lnk"
  Delete "$SMPROGRAMS\DeepSeek Harness Desktop\DeepSeek Harness Desktop.lnk"
  RMDir "$SMPROGRAMS\DeepSeek Harness Desktop"
  Delete "$INSTDIR\Launch DeepSeek Harness.cmd"
!macroend

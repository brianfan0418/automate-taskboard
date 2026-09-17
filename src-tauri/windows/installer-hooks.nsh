; Amendment 12 (W12-A): desktop shortcut, offered once per user.
;
; Fresh interactive install: the finish page's "create desktop shortcut" checkbox (default on) decides.
; Fresh /P or /S install: the Tauri template creates it (unless /NS).
; Update (/UPDATE, e.g. the shared-folder auto-update): the template never creates it, so the first
; update that finds no marker creates it here once. After the marker exists, a shortcut the user
; deleted is not recreated. A real uninstall (not /UPDATE) removes the shortcut (template) and the
; marker, so a later reinstall offers it again.

!define AUTOMATE_SHORTCUT_MARKER_KEY "Software\AutoMate Taskboard\Installer"
!define AUTOMATE_SHORTCUT_MARKER_VALUE "DesktopShortcutOffered"

; Amendment 14 (2.0.2): installing 2.0.1 over 2.0.0 failed with "cannot open node.exe for writing"
; because the launcher had exited while its board service (node.exe) and codex-runtime\codex.exe kept
; running. Before any file is copied or deleted (install and uninstall):
; 1. a running launcher is closed the same way the template does it (question unless /P or /S), so an
;    older launcher cannot restart its service after step 2;
; 2. stop-app-processes.ps1 (hidden PowerShell through nsExec, 60 s timeout, no WMI) stops only our own
;    executables: the launcher exe, node.exe and ConPtyAttachSend.exe under $INSTDIR — and only when
;    $INSTDIR really holds our launcher exe — plus codex.exe / codex-*.exe / rg.exe under
;    %APPDATA%\AutoMate Taskboard\codex-runtime. Its exit code and output go to the install details;
; 3. the files this installer replaces are opened for writing to prove nothing still holds them. If one
;    is still in use: interactive → a Traditional Chinese message, then abort; /P or /S (including the
;    shared-folder update /P /R /UPDATE) → abort with exit code 5, no dialog and no Abort/Retry/Ignore.
; This file is UTF-8 with BOM (makensis reads a BOM-less include in the ANSI code page).

!define AUTOMATE_HOOK_DIRECTORY "${__FILEDIR__}"
!ifndef AUTOMATE_STOP_POWERSHELL_NAME
  !define AUTOMATE_STOP_POWERSHELL_NAME "powershell.exe"
!endif
!define AUTOMATE_STILL_RUNNING_MESSAGE "AutoMate Taskboard 的背景程式仍在執行，無法更新檔案：$R3$\r$\n$\r$\n請在系統匣的 AutoMate Taskboard 圖示按右鍵選「結束」，或重新開機後，再執行一次安裝程式。"
!define AUTOMATE_STOP_EXIT_CODE 5

!macro AUTOMATE_CHECK_FILE_UNLOCKED FILE
  ${If} ${FileExists} "$R7\${FILE}"
    ClearErrors
    FileOpen $R2 "$R7\${FILE}" a
    ${If} ${Errors}
      StrCpy $R3 "$R3 ${FILE}"
    ${Else}
      FileClose $R2
    ${EndIf}
  ${EndIf}
!macroend

!macro AUTOMATE_STOP_APP_PROCESSES
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
  !else
    nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"
  !endif
  Pop $R0
  ${If} $R0 = 0
    IfSilent automate_kill_launcher 0
    ${If} $PassiveMode != 1
      nsis_tauri_utils::StrReplace "$(appRunningOkKill)" "{{product_name}}" "${PRODUCTNAME}"
      Pop $R2
      MessageBox MB_OKCANCEL "$R2" IDOK automate_kill_launcher
      nsis_tauri_utils::StrReplace "$(appRunning)" "{{product_name}}" "${PRODUCTNAME}"
      Pop $R1
      Abort $R1
    ${EndIf}
    automate_kill_launcher:
    !if "${INSTALLMODE}" == "currentUser"
      nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
    !else
      nsis_tauri_utils::KillProcess "${MAINBINARYNAME}.exe"
    !endif
    Pop $R0
    Sleep 500
  ${EndIf}

  ; $R7 = our install directory, or "" when $INSTDIR does not hold our launcher (nothing under it is touched).
  StrCpy $R7 ""
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R7 "$INSTDIR"
  ${EndIf}
  ReadEnvStr $R8 APPDATA
  System::Call 'Kernel32::SetEnvironmentVariable(t "AUTOMATE_STOP_INSTDIR", t "$R7")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "AUTOMATE_STOP_RUNTIME", t "$R8\${PRODUCTNAME}\codex-runtime")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "AUTOMATE_STOP_SELF", t "$EXEPATH")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "AUTOMATE_STOP_LAUNCHER", t "${MAINBINARYNAME}.exe")i'
  InitPluginsDir
  File "/oname=$PLUGINSDIR\automate-stop-app-processes.ps1" "${AUTOMATE_HOOK_DIRECTORY}\stop-app-processes.ps1"
  ; The installer is 32-bit: System32 would give a 32-bit PowerShell that cannot read 64-bit process paths.
  StrCpy $R6 "$SYSDIR\WindowsPowerShell\v1.0\${AUTOMATE_STOP_POWERSHELL_NAME}"
  ${If} ${RunningX64}
  ${AndIf} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\${AUTOMATE_STOP_POWERSHELL_NAME}"
    StrCpy $R6 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\${AUTOMATE_STOP_POWERSHELL_NAME}"
  ${EndIf}
  nsExec::ExecToStack /TIMEOUT=60000 `"$R6" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\automate-stop-app-processes.ps1"`
  Pop $R5
  Pop $R4
  DetailPrint "AutoMate Taskboard: stop leftover processes, result $R5"
  ${If} $R4 != ""
    DetailPrint "$R4"
  ${EndIf}

  ; Whatever the script reported (timeout, blocked PowerShell, access denied), check the files themselves.
  StrCpy $R3 ""
  ${If} $R7 != ""
    !insertmacro AUTOMATE_CHECK_FILE_UNLOCKED "${MAINBINARYNAME}.exe"
    !insertmacro AUTOMATE_CHECK_FILE_UNLOCKED "node.exe"
    !insertmacro AUTOMATE_CHECK_FILE_UNLOCKED "bin\ConPtyAttachSend.exe"
  ${EndIf}
  ${If} $R3 != ""
    DetailPrint "AutoMate Taskboard: files still in use:$R3"
    SetErrorLevel ${AUTOMATE_STOP_EXIT_CODE}
    IfSilent automate_stop_failed 0
    ${If} $PassiveMode != 1
      MessageBox MB_ICONSTOP|MB_OK "${AUTOMATE_STILL_RUNNING_MESSAGE}"
    ${EndIf}
    automate_stop_failed:
    Abort "AutoMate Taskboard files are still in use:$R3"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro AUTOMATE_STOP_APP_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro AUTOMATE_STOP_APP_PROCESSES
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R9 HKCU "${AUTOMATE_SHORTCUT_MARKER_KEY}" "${AUTOMATE_SHORTCUT_MARKER_VALUE}"
  ${If} $R9 != "1"
    ${If} $UpdateMode = 1
    ${AndIf} $NoShortcutMode <> 1
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
    WriteRegStr HKCU "${AUTOMATE_SHORTCUT_MARKER_KEY}" "${AUTOMATE_SHORTCUT_MARKER_VALUE}" "1"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    ; The template already deletes $DESKTOP\${PRODUCTNAME}.lnk when it points at this install.
    DeleteRegValue HKCU "${AUTOMATE_SHORTCUT_MARKER_KEY}" "${AUTOMATE_SHORTCUT_MARKER_VALUE}"
    DeleteRegKey /ifempty HKCU "${AUTOMATE_SHORTCUT_MARKER_KEY}"
    DeleteRegKey /ifempty HKCU "Software\AutoMate Taskboard"
  ${EndIf}
!macroend

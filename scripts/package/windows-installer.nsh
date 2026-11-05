; Shared by Electron and Tauri. Keep electron-builder's registry identity,
; multi-user directory discovery, old-uninstaller handoff and shortcut handling.
!define NEDIA_INSTALLER_SCRIPT "${__FILEDIR__}\windows-installer.ps1"

!macro customInit
  ; electron-builder skips CHECK_APP_RUNNING in the elevated inner installer.
  ; Run our preflight there as well, after its inherited install mode is known.
  ${If} ${UAC_IsInnerInstance}
    !insertmacro customCheckAppRunning
  ${EndIf}
!macroend

!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\nedia-installer.ps1 "${NEDIA_INSTALLER_SCRIPT}"
  System::Call 'kernel32::GetCurrentProcessId() i.r0'
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\nedia-installer.ps1" -Mode CheckRunning -InstallDirectory "$INSTDIR" -InstallerProcessId $0'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Please exit NediaMatrix and its background runtime, then retry. / 请退出应用并等待后台运行时结束后重试。$\r$\n$1" /SD IDOK
    SetErrorLevel 10
    Quit
  ${EndIf}
  ; Check dependencies before removing the installed application. A failed
  ; bootstrap leaves the old application and all business data in place.
  !ifndef BUILD_UNINSTALLER
    !ifdef NEDIA_WEBVIEW2_BOOTSTRAPPER
      File /oname=$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe "${NEDIA_WEBVIEW2_BOOTSTRAPPER}"
      nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\nedia-installer.ps1" -Mode EnsureWebView2 -Bootstrapper "$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe"'
      Pop $0
      Pop $1
      ${If} $0 != 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "WebView2 installation failed. / WebView2 安装失败，请检查网络后重试。$\r$\n$1" /SD IDOK
        SetErrorLevel 20
        Quit
      ${EndIf}
    !endif
  !endif
!macroend

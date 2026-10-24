; HyperPlayer for Windows (packaging/windows/build.sh): the player, the server, or both.
; The server runs as the "HyperPlayer" Windows service (hyperplayer-service.exe), with
; settings in %ProgramData%\HyperPlayer\server.env and its data next to them.
;
; makensis -DVERSION=x.y.z[-beta.n] -DFILEVERSION=x.y.z.0 -DSTAGE=dir -DOUTFILE=setup.exe
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "Sections.nsh"

!ifndef VERSION | FILEVERSION | STAGE | OUTFILE
  !error "Pass VERSION, FILEVERSION, STAGE and OUTFILE (see build.sh)"
!endif
!define APP "HyperPlayer"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"
!define FIREWALL_RULE "HyperPlayer server"
!define SERVICE_EXE "$INSTDIR\server\hyperplayer-service.exe"

Name "${APP} ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\${APP}"
InstallDirRegKey HKLM "Software\${APP}" "InstallDir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
VIProductVersion "${FILEVERSION}"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "FileDescription" "${APP} installer"
VIAddVersionKey "FileVersion" "${FILEVERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Enrico Ansaloni"

; Server settings (asked on the server pages).
Var ServerHome
Var KeepSettings
Var AskedKeep
Var Library
Var SmbUser
Var SmbPassword
Var Port
Var Tls
Var TlsNames
Var TlsCert
Var TlsKey
Var LastfmKey
Var LastfmSecret
Var FinishText
; Controls of the page being shown.
Var hLibrary
Var hSmbUser
Var hSmbPassword
Var hPort
Var hTlsSelf
Var hTlsFiles
Var hTlsOff
Var hNames
Var hCert
Var hKey
Var hLastfmKey
Var hLastfmSecret

!define MUI_ICON "../../apps/client/icons/hyperplayer.ico"
!define MUI_UNICON "../../apps/client/icons/hyperplayer.ico"
!define MUI_ABORTWARNING
!define MUI_COMPONENTSPAGE_SMALLDESC

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
Page custom MusicPage MusicPageLeave
Page custom ServerPage ServerPageLeave
Page custom LastfmPage LastfmPageLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "${APP} is installed"
!define MUI_FINISHPAGE_TEXT "$FinishText"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Start the ${APP} player"
!define MUI_FINISHPAGE_RUN_FUNCTION StartPlayer
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishShow
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; ------------------------------------------------------------------- sections

Section "Player" SecPlayer
  SetShellVarContext all
  ; A running player keeps its executable locked.
  nsExec::Exec 'taskkill /IM hyperplayer.exe /F'
  SetOutPath "$INSTDIR"
  File "${STAGE}/hyperplayer.exe"
  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\hyperplayer.exe"
SectionEnd

Section "Desktop shortcut" SecDesktop
  SetShellVarContext all
  ${If} ${SectionIsSelected} ${SecPlayer}
    CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\hyperplayer.exe"
  ${EndIf}
SectionEnd

Section /o "Server" SecServer
  SetShellVarContext all
  DetailPrint "Stopping the server (if it's running)..."
  ${If} ${FileExists} "${SERVICE_EXE}"
    nsExec::ExecToLog '"${SERVICE_EXE}" stop'
  ${EndIf}

  SetOutPath "$INSTDIR\server"
  ; The bundle's chunk names change between versions: start from a clean folder.
  RMDir /r "$INSTDIR\server\dist"
  File /r "${STAGE}/server/*"

  CreateDirectory "$ServerHome\data"
  CreateDirectory "$ServerHome\logs"
  ; Administrators and the service's account only: the settings hold passwords.
  ; (S-1-5-18 SYSTEM, S-1-5-32-544 Administrators, S-1-5-19 LocalService.)
  nsExec::ExecToLog 'icacls "$ServerHome" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-19:(OI)(CI)M /T /Q'
  ${If} $KeepSettings != 1
    Call WriteSettings
  ${EndIf}

  DetailPrint "Registering the HyperPlayer service..."
  nsExec::ExecToLog '"${SERVICE_EXE}" install'
  ; Players on the network reach node.exe, whatever the port.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${FIREWALL_RULE}"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${FIREWALL_RULE}" dir=in action=allow program="$INSTDIR\server\node.exe" enable=yes profile=private,domain'
  nsExec::ExecToLog '"${SERVICE_EXE}" start'

  DetailPrint "Waiting for the server to answer..."
  nsExec::ExecToStack '"$INSTDIR\server\node.exe" "$INSTDIR\server\server-status.mjs"'
  Pop $0
  Pop $1
  ${If} $0 == 0
    StrCpy $FinishText "The server is running. Connect players to:$\r$\n$\r$\n$1$\r$\n(With a self-signed certificate, players show the second line, its fingerprint, and ask to trust it once.)$\r$\n$\r$\nFirst sign-in: username admin, password hyperplayer; you choose your own right away.$\r$\n$\r$\nOther computers reach it when this PC's network is set to Private in Windows."
  ${Else}
    StrCpy $FinishText "The server was installed but didn't answer yet. Its log is in $ServerHome\logs."
  ${EndIf}
SectionEnd

; Always: what uninstalling needs.
Section "-Uninstaller"
  SetShellVarContext all
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "Software\${APP}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "Enrico Ansaloni"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1
  ${IfNot} ${SectionIsSelected} ${SecServer}
    StrCpy $FinishText "The ${APP} player is in the Start menu."
  ${EndIf}
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecPlayer} "The player, to listen to the music on a HyperPlayer server."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "A shortcut to the player on the desktop."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecServer} "The server: keeps your music library and streams it to players on this PC, your network or (behind a reverse proxy) anywhere. Runs as a Windows service."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ------------------------------------------------------------------ functions

Function .onInit
  SetShellVarContext all
  StrCpy $ServerHome "$APPDATA\${APP}"
  StrCpy $Port "4533"
  StrCpy $Tls "self"
  ReadEnvStr $TlsNames COMPUTERNAME
  ; The first Windows beta installed the player for one user: replace it.
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "UninstallString"
  ${If} $0 != ""
    ExecWait '$0 /S'
  ${EndIf}
FunctionEnd

Function AskKeepSettings
  ${If} $AskedKeep != 1
    StrCpy $AskedKeep 1
    ${If} ${FileExists} "$ServerHome\server.env"
      MessageBox MB_YESNO|MB_ICONQUESTION "A HyperPlayer server is already set up on this PC. Keep its settings?" IDNO +2
      StrCpy $KeepSettings 1
    ${EndIf}
  ${EndIf}
FunctionEnd

; Skips the server pages when the server isn't being installed or keeps its settings.
!macro ServerPageOnly
  ${IfNot} ${SectionIsSelected} ${SecServer}
    Abort
  ${EndIf}
  Call AskKeepSettings
  ${If} $KeepSettings == 1
    Abort
  ${EndIf}
!macroend

Function MusicPage
  !insertmacro ServerPageOnly
  !insertmacro MUI_HEADER_TEXT "Music" "Where the server finds your music."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 20u "Music folders, separated by ; (for example D:\Music;\\nas\Music). The server only reads them, and notices new music by itself."
  Pop $0
  ${NSD_CreateText} 0 22u 78% 12u $Library
  Pop $hLibrary
  ${NSD_CreateButton} 80% 21u 20% 14u "Add folder..."
  Pop $0
  ${NSD_OnClick} $0 AddFolder
  ${NSD_CreateLabel} 0 46u 100% 20u "Folders on a network share (\\server\share\...) are reached with this account. Leave it empty if the shares need none."
  Pop $0
  ${NSD_CreateLabel} 0 70u 22% 12u "Username"
  Pop $0
  ${NSD_CreateText} 24% 68u 54% 12u $SmbUser
  Pop $hSmbUser
  ${NSD_CreateLabel} 0 86u 22% 12u "Password"
  Pop $0
  ${NSD_CreatePassword} 24% 84u 54% 12u $SmbPassword
  Pop $hSmbPassword
  nsDialogs::Show
FunctionEnd

Function AddFolder
  ${NSD_GetText} $hLibrary $1
  nsDialogs::SelectFolderDialog "Choose a music folder" ""
  Pop $0
  ${If} $0 != "error"
  ${AndIf} $0 != ""
    ${If} $1 == ""
      StrCpy $1 $0
    ${Else}
      StrCpy $1 "$1;$0"
    ${EndIf}
    ${NSD_SetText} $hLibrary $1
  ${EndIf}
FunctionEnd

Function MusicPageLeave
  ${NSD_GetText} $hLibrary $Library
  ${NSD_GetText} $hSmbUser $SmbUser
  ${NSD_GetText} $hSmbPassword $SmbPassword
  ${If} $Library == ""
    MessageBox MB_ICONEXCLAMATION "Add at least one music folder."
    Abort
  ${EndIf}
FunctionEnd

Function ServerPage
  !insertmacro ServerPageOnly
  !insertmacro MUI_HEADER_TEXT "Server" "How players reach the server."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 2u 22% 12u "Port"
  Pop $0
  ${NSD_CreateNumber} 24% 0 20% 12u $Port
  Pop $hPort
  ${NSD_CreateLabel} 0 20u 100% 10u "HTTPS:"
  Pop $0
  ${NSD_CreateRadioButton} 0 32u 100% 10u "Self-signed certificate (made by the server; players ask to trust it once)"
  Pop $hTlsSelf
  ${NSD_AddStyle} $hTlsSelf ${WS_GROUP}
  ${NSD_CreateLabel} 12u 46u 34% 12u "Names players use:"
  Pop $0
  ${NSD_CreateText} 46% 44u 54% 12u $TlsNames
  Pop $hNames
  ${NSD_CreateRadioButton} 0 62u 100% 10u "My own certificate files (PEM, e.g. from Let's Encrypt)"
  Pop $hTlsFiles
  ${NSD_CreateLabel} 12u 76u 34% 12u "Certificate (fullchain.pem):"
  Pop $0
  ${NSD_CreateText} 46% 74u 54% 12u $TlsCert
  Pop $hCert
  ${NSD_CreateLabel} 12u 92u 34% 12u "Private key (privkey.pem):"
  Pop $0
  ${NSD_CreateText} 46% 90u 54% 12u $TlsKey
  Pop $hKey
  ${NSD_CreateRadioButton} 0 110u 100% 10u "Off: a reverse proxy in front does HTTPS"
  Pop $hTlsOff
  ${If} $Tls == "files"
    ${NSD_Check} $hTlsFiles
  ${ElseIf} $Tls == "off"
    ${NSD_Check} $hTlsOff
  ${Else}
    ${NSD_Check} $hTlsSelf
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function ServerPageLeave
  ${NSD_GetText} $hPort $Port
  ${NSD_GetText} $hNames $TlsNames
  ${NSD_GetText} $hCert $TlsCert
  ${NSD_GetText} $hKey $TlsKey
  ${NSD_GetState} $hTlsFiles $0
  ${NSD_GetState} $hTlsOff $1
  ${If} $0 == ${BST_CHECKED}
    StrCpy $Tls "files"
  ${ElseIf} $1 == ${BST_CHECKED}
    StrCpy $Tls "off"
  ${Else}
    StrCpy $Tls "self"
  ${EndIf}
  ${If} $Port < 1
  ${OrIf} $Port > 65535
    MessageBox MB_ICONEXCLAMATION "The port is a number from 1 to 65535."
    Abort
  ${EndIf}
  ${If} $Tls == "files"
    ${IfNot} ${FileExists} $TlsCert
    ${OrIfNot} ${FileExists} $TlsKey
      MessageBox MB_ICONEXCLAMATION "Choose the certificate and key files."
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Function LastfmPage
  !insertmacro ServerPageOnly
  !insertmacro MUI_HEADER_TEXT "Last.fm" "Optional: lets users scrobble to Last.fm."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 30u "Scrobbling to Last.fm needs an API account for this server (https://www.last.fm/api/account/create). Leave these empty to skip it; ListenBrainz works without."
  Pop $0
  ${NSD_CreateLabel} 0 36u 22% 12u "API key"
  Pop $0
  ${NSD_CreateText} 24% 34u 76% 12u $LastfmKey
  Pop $hLastfmKey
  ${NSD_CreateLabel} 0 52u 22% 12u "Shared secret"
  Pop $0
  ${NSD_CreatePassword} 24% 50u 76% 12u $LastfmSecret
  Pop $hLastfmSecret
  nsDialogs::Show
FunctionEnd

Function LastfmPageLeave
  ${NSD_GetText} $hLastfmKey $LastfmKey
  ${NSD_GetText} $hLastfmSecret $LastfmSecret
  ${If} $LastfmKey != ""
  ${AndIf} $LastfmSecret == ""
    MessageBox MB_ICONEXCLAMATION "Enter the shared secret too (or leave both empty)."
    Abort
  ${EndIf}
FunctionEnd

!macro Setting KEY VALUE
  FileWriteUTF16LE $9 "${KEY}='${VALUE}'$\r$\n"
!macroend

; server.env, as the service reads it (UTF-16 keeps any folder name intact).
Function WriteSettings
  FileOpen $9 "$ServerHome\server.env" w
  FileWriteUTF16LE /BOM $9 "# HyperPlayer server settings, written by the installer. After editing, restart the HyperPlayer service.$\r$\n"
  !insertmacro Setting HP_LIBRARY $Library
  !insertmacro Setting HP_PORT $Port
  !insertmacro Setting HP_HOST "0.0.0.0"
  ${If} $Tls == "off"
    !insertmacro Setting HP_TLS "off"
    ; Behind a proxy: client addresses (for sign-in limits) come from X-Forwarded-For.
    !insertmacro Setting HP_TRUST_PROXY "true"
  ${Else}
    !insertmacro Setting HP_TLS "on"
  ${EndIf}
  ${If} $Tls == "self"
  ${AndIf} $TlsNames != ""
    !insertmacro Setting HP_TLS_NAMES $TlsNames
  ${EndIf}
  ${If} $Tls == "files"
    !insertmacro Setting HP_TLS_CERT $TlsCert
    !insertmacro Setting HP_TLS_KEY $TlsKey
  ${EndIf}
  ${If} $SmbUser != ""
    !insertmacro Setting HP_SMB_USER $SmbUser
    !insertmacro Setting HP_SMB_PASSWORD $SmbPassword
  ${EndIf}
  ${If} $LastfmKey != ""
    !insertmacro Setting HP_LASTFM_API_KEY $LastfmKey
    !insertmacro Setting HP_LASTFM_SECRET $LastfmSecret
  ${EndIf}
  FileClose $9
FunctionEnd

Function FinishShow
  ; Nothing to start without the player.
  ${IfNot} ${SectionIsSelected} ${SecPlayer}
    ShowWindow $mui.FinishPage.Run ${SW_HIDE}
  ${EndIf}
FunctionEnd

Function StartPlayer
  ; Through Explorer, so the player runs as the user rather than as administrator.
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\hyperplayer.exe"'
FunctionEnd

; ------------------------------------------------------------------ uninstall

Section "Uninstall"
  SetShellVarContext all
  nsExec::Exec 'taskkill /IM hyperplayer.exe /F'
  ${If} ${FileExists} "${SERVICE_EXE}"
    nsExec::ExecToLog '"${SERVICE_EXE}" uninstall'
  ${EndIf}
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${FIREWALL_RULE}"'
  RMDir /r "$INSTDIR\server"
  Delete "$INSTDIR\hyperplayer.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  DeleteRegKey HKLM "Software\${APP}"
  ${If} ${FileExists} "$APPDATA\${APP}\server.env"
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete the server's data (library database, accounts, certificate) and settings in $APPDATA\${APP}? Keep them to install again later." IDNO +2
    RMDir /r "$APPDATA\${APP}"
  ${EndIf}
  ; Each user's player settings stay in their own %APPDATA%\HyperPlayer.
SectionEnd

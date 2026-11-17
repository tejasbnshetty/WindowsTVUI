; Extra steps for the Couch UI installer (included by electron-builder's NSIS template).
;
; The installer is per-machine, so Windows asks for administrator rights ONCE, at install time.
; That elevation is what allows the firewall rule below; the app itself always runs as a normal user.
;
; One program-based rule covers everything the launcher needs: the remote page / WebSocket (TCP 8787)
; and the couchui.local mDNS announcements (UDP 5353). It is limited to PRIVATE networks only, so the
; remote is never reachable from "Public" networks such as cafe Wi-Fi.

!macro customInstall
  DetailPrint "Adding Windows Firewall rule for Couch UI (Private networks only)"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Couch UI"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Couch UI" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=private'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Firewall rule was not added (exit code $0). Windows will ask the first time Couch UI runs; choose Private networks."
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing Windows Firewall rule for Couch UI"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Couch UI"'
  Pop $0
!macroend

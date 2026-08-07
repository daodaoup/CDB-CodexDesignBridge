Option Explicit

Dim shell, fileSystem, packageRoot, installerPath, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

packageRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
installerPath = fileSystem.BuildPath(packageRoot, "scripts\install-codex-design-bridge.ps1")

If Not fileSystem.FileExists(installerPath) Then
  MsgBox "The CDB installer package is incomplete.", vbCritical, "Codex Design Bridge"
  WScript.Quit 2
End If

MsgBox "CDB 0.7 will install automatically after Codex is fully closed. Save your work, click OK, then exit Codex. The installer will not force-close the app.", vbInformation, "Install Codex Design Bridge"

command = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File """ & installerPath & """ -WaitForExit"
exitCode = shell.Run(command, 0, True)

If exitCode = 0 Then
  MsgBox "Codex Design Bridge was installed successfully. Reopen Codex and start a new task.", vbInformation, "Codex Design Bridge"
Else
  MsgBox "Installation did not complete. The previous CDB version was kept. Use the diagnostic .cmd installer to view details.", vbCritical, "Codex Design Bridge"
End If

WScript.Quit exitCode

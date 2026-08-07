Option Explicit

Dim fileSystem, shell, scriptDirectory, rootDirectory, command
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
rootDirectory = fileSystem.GetAbsolutePathName(fileSystem.BuildPath(scriptDirectory, ".."))
shell.CurrentDirectory = rootDirectory
command = "cmd.exe /d /c node """ & rootDirectory & _
  "\bin\figma-sync.js"" start 1>""" & rootDirectory & _
  "\.figma-sync\bridge.log"" 2>&1"

shell.Run command, 0, False

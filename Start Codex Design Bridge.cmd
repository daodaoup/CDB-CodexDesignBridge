@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Codex Design Bridge is not installed correctly.
  echo Please run npm install once, then double-click this file again.
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

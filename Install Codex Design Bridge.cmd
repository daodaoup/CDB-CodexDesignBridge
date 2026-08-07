@echo off
setlocal
set "INSTALLER_DIR=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%INSTALLER_DIR%scripts\install-codex-design-bridge.ps1"
set "INSTALL_EXIT=%ERRORLEVEL%"
echo.
if not "%INSTALL_EXIT%"=="0" (
  echo Installation failed. Review the message above, then try again.
) else (
  echo Installation succeeded.
)
pause
exit /b %INSTALL_EXIT%

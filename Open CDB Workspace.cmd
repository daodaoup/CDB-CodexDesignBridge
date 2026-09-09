@echo off
setlocal

set "CDB_PACKAGE_ROOT=%~dp0"
set "CDB_NODE_PATH="
set "CDB_NODE_CANDIDATE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node.exe"
if exist "%CDB_NODE_CANDIDATE%" (
  set "CDB_NODE_PATH=%CDB_NODE_CANDIDATE%"
  goto run
)

set "CDB_NODE_CANDIDATE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%CDB_NODE_CANDIDATE%" (
  set "CDB_NODE_PATH=%CDB_NODE_CANDIDATE%"
  goto run
)

set "CDB_NODE_CANDIDATE=%LOCALAPPDATA%\Programs\ChatGPT\resources\cua_node\node.exe"
if exist "%CDB_NODE_CANDIDATE%" (
  set "CDB_NODE_PATH=%CDB_NODE_CANDIDATE%"
  goto run
)

set "CDB_NODE_CANDIDATE=%LOCALAPPDATA%\Programs\Codex\resources\cua_node\node.exe"
if exist "%CDB_NODE_CANDIDATE%" (
  set "CDB_NODE_PATH=%CDB_NODE_CANDIDATE%"
  goto run
)

for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined CDB_NODE_PATH set "CDB_NODE_PATH=%%N"
if defined CDB_NODE_PATH goto run

echo CDB could not find a Node.js runtime. Install or update Codex, then try again.
pause
exit /b 1

:run
"%CDB_NODE_PATH%" "%CDB_PACKAGE_ROOT%scripts\open-local-workspace.mjs"
set "CDB_EXIT_CODE=%ERRORLEVEL%"
if not "%CDB_EXIT_CODE%"=="0" pause
exit /b %CDB_EXIT_CODE%

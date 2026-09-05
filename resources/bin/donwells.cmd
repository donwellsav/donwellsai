@echo off
setlocal
set "RESOURCES_DIR=%~dp0.."
set "ELECTRON_RUN_AS_NODE=1"
if not exist "%RESOURCES_DIR%\..\donwells.exe" (
  echo donwells: packaged Electron executable not found 1>&2
  exit /b 127
)
if not exist "%RESOURCES_DIR%\cli\donwells.mjs" (
  echo donwells: packaged CLI loader not found 1>&2
  exit /b 127
)
"%RESOURCES_DIR%\..\donwells.exe" "%RESOURCES_DIR%\cli\donwells.mjs" %*
exit /b %ERRORLEVEL%

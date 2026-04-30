@echo off
setlocal

set "CODEMIE_INSTALL_URL=%CODEMIE_INSTALL_URL%"
if "%CODEMIE_INSTALL_URL%"=="" (
  set "CODEMIE_INSTALL_URL=https://raw.githubusercontent.com/codemie-ai/codemie-code/main/install/windows"
)

set "INSTALL_PS1=%TEMP%\codemie-install.ps1"

curl -fsSL "%CODEMIE_INSTALL_URL%/install.ps1" -o "%INSTALL_PS1%"
if errorlevel 1 (
  echo Failed to download CodeMie PowerShell installer from %CODEMIE_INSTALL_URL%/install.ps1
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_PS1%" %*
set "INSTALL_EXIT=%ERRORLEVEL%"

del "%INSTALL_PS1%" >nul 2>nul
exit /b %INSTALL_EXIT%

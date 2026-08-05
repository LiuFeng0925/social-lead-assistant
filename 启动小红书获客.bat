@echo off
setlocal

set "ROOT=%~dp0"
set "CLIENT=%ROOT%client"
set "ELECTRON=%CLIENT%\node_modules\electron\dist\electron.exe"

if not exist "%CLIENT%\node_modules" (
  echo First run: installing desktop dependencies...
  call npm --prefix "%CLIENT%" ci
  if errorlevel 1 goto :failed
)

if not exist "%ELECTRON%" (
  echo First run: downloading the Electron desktop runtime...
  call "%CLIENT%\node_modules\.bin\electron.cmd" --version
  if errorlevel 1 goto :failed
)

if not exist "%ELECTRON%" goto :failed

start "" "%ELECTRON%" "%CLIENT%\electron\main.js"
exit /b 0

:failed
echo.
echo Desktop app startup failed. Please keep this window open and send the error to the developer.
pause
exit /b 1

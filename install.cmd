@echo off
rem ------------------------------------------------------------------------------------------
rem  TSUN Micro-inverters - installs the app on your Homey Pro from a Windows PC.
rem
rem  Double-click this file (or run "install.cmd" from a command prompt), either at the root
rem  of the repository or inside the com.pepane13.tsun app folder. It runs in cmd, not
rem  PowerShell, so the PowerShell script execution policy ("running scripts is disabled on
rem  this system") cannot block the Homey CLI.
rem
rem  Steps: Node.js check (24+), Homey CLI install or update, git pull (if this is a git clone),
rem  then "homey app install" (with sign-in and Homey selection if needed).
rem ------------------------------------------------------------------------------------------
setlocal EnableExtensions
cd /d "%~dp0"
title TSUN Micro-inverters - install
rem install.cmd can sit at the root of the repository or inside the app folder itself
set "APPDIR=%~dp0com.pepane13.tsun"
if exist "%~dp0app.json" set "APPDIR=%~dp0."
if not exist "%APPDIR%\app.json" (
  echo [ERROR] App not found: put install.cmd at the root of the repository
  echo         or in the com.pepane13.tsun folder ^(next to app.json^).
  goto :fail
)

rem ---------- 1. Node.js ----------
echo.
echo [1/4] Node.js
where node >nul 2>&1
if errorlevel 1 goto :nonode
set "NODEMAJ=0"
for /f "tokens=1 delims=v." %%m in ('node --version') do set "NODEMAJ=%%m"
for /f "delims=" %%v in ('node --version') do echo       Node.js %%v found
rem The current Homey CLI needs Node.js 24 or later
if %NODEMAJ% GEQ 24 goto :nodeok
echo       Node.js %NODEMAJ% is too old for the current Homey CLI ^(Node.js 24 or later needed^).
where winget >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Install the current Node.js LTS from https://nodejs.org then run install.cmd again.
  goto :fail
)
echo       Updating Node.js LTS with winget ...
winget upgrade --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
if errorlevel 1 winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
echo.
echo       Node.js updated: close this window and run install.cmd again.
goto :fail
:nodeok

rem ---------- 2. Homey CLI (installed or updated to the latest version) ----------
echo.
echo [2/4] Homey CLI
set "NPMG="
for /f "delims=" %%p in ('npm prefix -g 2^>nul') do set "NPMG=%%p"
if not defined NPMG set "NPMG=%APPDATA%\npm"
set "HOMEY=%NPMG%\homey.cmd"
echo       npm install -g homey@latest ...
call npm install -g homey@latest
if errorlevel 1 (
  if exist "%HOMEY%" (
    echo [WARNING] Update failed: the installed Homey CLI is used.
  ) else (
    echo [ERROR] npm could not install the Homey CLI.
    goto :fail
  )
)
if not exist "%HOMEY%" (
  echo [ERROR] Homey CLI installed but not found at "%HOMEY%".
  goto :fail
)
for /f "delims=" %%v in ('call "%HOMEY%" --version 2^>nul') do echo       Homey CLI %%v

rem ---------- 3. Latest version of the source ----------
echo.
echo [3/4] Source code
where git >nul 2>&1
if errorlevel 1 (
  echo       git not installed: skipped, the local files are installed as they are.
  goto :install
)
git -C "%APPDIR%" rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo       Not a git clone: skipped, the local files are installed as they are.
  goto :install
)
git -C "%APPDIR%" pull --ff-only
if errorlevel 1 echo [WARNING] git pull failed ^(local changes?^): the local files are installed as they are.

rem ---------- 4. Install on the Homey ----------
:install
for /f "tokens=2 delims=:, " %%v in ('findstr /c:"\"version\"" "%APPDIR%\app.json"') do (
  set "APPVER=%%~v"
  goto :gotver
)
:gotver
echo.
echo [4/4] Installing TSUN Micro-inverters %APPVER% on the Homey
pushd "%APPDIR%"
call "%HOMEY%" app install
if not errorlevel 1 goto :done

echo.
echo       Install failed: signing in to your Athom account and choosing the Homey, then retrying.
call "%HOMEY%" login
if errorlevel 1 goto :failpop
call "%HOMEY%" select
if errorlevel 1 goto :failpop
call "%HOMEY%" app install
if errorlevel 1 goto :failpop

:done
popd
echo.
echo ==========================================================================================
echo  Installed. In the Homey app: device TSUN MX3000D, Settings, "Production forecast" to
echo  enable the forecast and set the panel tilt and orientation.
echo ==========================================================================================
echo.
pause
exit /b 0

:nonode
echo       Node.js is not installed.
where winget >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Install Node.js LTS from https://nodejs.org then run install.cmd again.
  goto :fail
)
echo       Installing Node.js LTS with winget ...
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
echo.
echo       Node.js installed: close this window and run install.cmd again
echo       ^(a new window is needed for Windows to find node and npm^).
goto :fail

:failpop
popd
:fail
echo.
echo Installation not completed.
pause
exit /b 1

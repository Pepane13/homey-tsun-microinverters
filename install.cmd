@echo off
rem ------------------------------------------------------------------------------------------
rem  TSUN Micro-inverters - installs the app on your Homey Pro from a Windows PC.
rem
rem  Double-click this file (or run "install.cmd" from a command prompt) at the root of the
rem  repository. It runs in cmd, not PowerShell, so the PowerShell script execution policy
rem  ("running scripts is disabled on this system") cannot block the Homey CLI.
rem
rem  Steps: Node.js check, Homey CLI install if missing, git pull (if this is a git clone),
rem  then "homey app install" (with sign-in and Homey selection if needed).
rem ------------------------------------------------------------------------------------------
setlocal EnableExtensions
cd /d "%~dp0"
title TSUN Micro-inverters - install
set "APPDIR=%~dp0com.pepane13.tsun"

if not exist "%APPDIR%\app.json" (
  echo [ERROR] Folder com.pepane13.tsun not found next to this script.
  echo         Keep install.cmd at the root of the repository.
  goto :fail
)

rem ---------- 1. Node.js ----------
echo.
echo [1/4] Node.js
where node >nul 2>&1
if errorlevel 1 goto :nonode
for /f "delims=" %%v in ('node --version') do echo       Node.js %%v found

rem ---------- 2. Homey CLI ----------
echo.
echo [2/4] Homey CLI
set "NPMG="
for /f "delims=" %%p in ('npm prefix -g 2^>nul') do set "NPMG=%%p"
if not defined NPMG set "NPMG=%APPDATA%\npm"
set "HOMEY=%NPMG%\homey.cmd"
if exist "%HOMEY%" goto :cliok
echo       Homey CLI not found: installing it with npm install -g homey ...
call npm install -g homey
if errorlevel 1 (
  echo [ERROR] npm could not install the Homey CLI.
  goto :fail
)
if not exist "%HOMEY%" (
  echo [ERROR] Homey CLI installed but not found at "%HOMEY%".
  goto :fail
)
:cliok
echo       Homey CLI found: "%HOMEY%"

rem ---------- 3. Latest version of the source ----------
echo.
echo [3/4] Source code
if not exist "%~dp0.git" (
  echo       Not a git clone ^(zip download^): skipped.
  goto :install
)
where git >nul 2>&1
if errorlevel 1 (
  echo       git not installed: skipped, the local files are installed as they are.
  goto :install
)
git pull --ff-only
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

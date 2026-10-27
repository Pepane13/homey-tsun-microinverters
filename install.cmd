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
rem  "homey app install" (with sign-in and Homey selection if needed), then optionally
rem  "homey app publish" to upload the version to the Homey App Store.
rem
rem  Options:  install.cmd            install, then ask whether to publish (no answer = no)
rem            install.cmd publish    install and publish without asking
rem            install.cmd nopublish  install only
rem ------------------------------------------------------------------------------------------
setlocal EnableExtensions
cd /d "%~dp0"
set "MODE=%~1"
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
echo [1/5] Node.js
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
echo [2/5] Homey CLI
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
echo [3/5] Source code
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
echo [4/5] Installing TSUN Micro-inverters %APPVER% on the Homey
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
echo.
echo       Installed. In the Homey app: device TSUN MX3000D, Settings, "Production forecast"
echo       to enable the forecast and set the panel tilt and orientation.

rem ---------- 5. Publish to the Homey App Store (optional) ----------
echo.
echo [5/5] Homey App Store
if /i "%MODE%"=="nopublish" (
  echo       Skipped ^(nopublish^).
  goto :end
)
if /i "%MODE%"=="publish" goto :publish
echo       Publish version %APPVER% to the Homey App Store? It is uploaded as a new build that
echo       you then release from the Homey Developer Tools ^(test or certification^).
echo       Guidelines: https://apps.developer.homey.app/app-store/guidelines
choice /C YN /N /T 60 /D N /M "      Publish now? [Y/N] (no answer within 60 s = N) "
if errorlevel 2 (
  echo       Not published.
  goto :end
)

:publish
echo       Publishing TSUN Micro-inverters %APPVER% ...
rem Headless mode: the CLI does not bump the version (it comes from the repository), takes the
rem changelog from .homeychangelog.json and makes no git commit of its own.
set "HOMEY_HEADLESS=1"
call "%HOMEY%" app publish
set "PUBERR=%errorlevel%"
set "HOMEY_HEADLESS="
if not "%PUBERR%"=="0" (
  echo [ERROR] Publication failed ^(version %APPVER% already published, or Athom sign-in needed:
  echo         run "homey login" and try again^).
  goto :failpop
)

rem Git clone: tag the published version (v%APPVER%) and push the tag
where git >nul 2>&1 || goto :published
git -C "%APPDIR%" rev-parse --is-inside-work-tree >nul 2>&1 || goto :published
git -C "%APPDIR%" rev-parse -q --verify "refs/tags/v%APPVER%" >nul 2>&1 && goto :published
git -C "%APPDIR%" tag -a "v%APPVER%" -m "TSUN Micro-inverters %APPVER% (Homey App Store)"
if errorlevel 1 goto :published
git -C "%APPDIR%" push origin "v%APPVER%"
if errorlevel 1 echo [WARNING] Tag v%APPVER% created locally but not pushed to GitHub.

:published
echo.
echo       Published. Release build %APPVER% at https://tools.developer.homey.app/apps
echo       ^(Test release, or Submit for certification for the public App Store^).

:end
popd
echo.
echo ==========================================================================================
echo  Done.
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
echo Not completed.
pause
exit /b 1

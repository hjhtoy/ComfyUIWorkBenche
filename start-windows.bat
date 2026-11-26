@echo off
rem Frameform workspace one-click launcher for Windows.
rem Double-click this file. All messages are ASCII to avoid console encoding issues.
setlocal
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8787
if "%FRAMEFORM_DATA%"=="" set "FRAMEFORM_DATA=%USERPROFILE%\FrameformData"

echo ==^> Checking Node.js and Python
where node >nul 2>nul
if errorlevel 1 goto nonode
where npm >nul 2>nul
if errorlevel 1 goto nonode
set "PYTHON="
py -3 -V >nul 2>nul && set "PYTHON=py -3"
if not defined PYTHON (
  python -V >nul 2>nul && set "PYTHON=python"
)
if not defined PYTHON goto nopython

if not exist node_modules (
  echo ==^> First run: installing npm dependencies
  call npm ci
  if errorlevel 1 goto error
)

if not exist .venv\Scripts\python.exe (
  echo ==^> First run: creating Python virtual environment
  %PYTHON% -m venv .venv
  if errorlevel 1 goto error
)
echo ==^> Checking workspace service dependencies
.venv\Scripts\python.exe -m pip install -q -r workspace\requirements.txt
if errorlevel 1 goto error

if not exist dist\Frameform.html (
  echo ==^> First run: building the workbench page
  call npm run build
  if errorlevel 1 goto error
)

echo.
echo Workbench URL: http://127.0.0.1:%PORT%
echo Data folder:   %FRAMEFORM_DATA%
echo Press Ctrl+C to stop. Run npm run build after changing sources.
start "" /min powershell -noprofile -command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%'"
.venv\Scripts\python.exe -m workspace --data "%FRAMEFORM_DATA%" serve --port %PORT%
goto end

:nonode
echo Node.js not found. Install Node.js 20+ from https://nodejs.org/
goto error
:nopython
echo Python not found. Install Python 3.10+ from https://www.python.org/downloads/
echo During setup, enable "Add python.exe to PATH".
goto error
:error
echo.
echo Startup failed. See the messages above.
:end
pause

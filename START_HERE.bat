@echo off
cd /d "%~dp0"
where npm >nul 2>&1
if errorlevel 1 (
  echo Node.js and npm are required. Install Node.js and try again.
  pause
  exit /b 1
)
if not exist node_modules\ (
  call npm ci
  if errorlevel 1 goto failed
)
call npm run build
if errorlevel 1 goto failed
python -m func.app
if errorlevel 1 (
  echo.
  echo Python did not start. Install Python 3.10 or newer and try again.
  pause
)
exit /b %errorlevel%
:failed
echo.
echo React setup or build failed. Check the error above.
pause
exit /b 1

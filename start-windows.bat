@echo off
title Dispatch Copilot
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed.
  echo  Install the LTS version from https://nodejs.org, then double-click this file again.
  echo.
  pause
  exit /b 1
)
echo.
echo  Starting Dispatch Copilot...
echo  Your browser will open at http://localhost:8080
echo  Keep this window open while you use the app. Close it to stop the app.
echo.
start "" /b cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:8080"
node server.js
pause

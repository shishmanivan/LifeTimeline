@echo off
setlocal

cd /d "%~dp0"

echo Starting PastPresentYou local server mode...
echo Project root: %CD%
echo.

REM Start backend in a separate window
start "PastPresentYou Backend" cmd /k "cd /d ""%~dp0"" && npm run personal:server"

REM Small delay so backend has a moment to start
timeout /t 2 /nobreak >nul

REM Start frontend in server mode in a separate window
start "PastPresentYou Frontend (server mode)" cmd /k "cd /d ""%~dp0"" && set VITE_PERSONAL_PHOTO_STORAGE=server && set VITE_PERSONAL_PHOTO_API_BASE_URL=http://127.0.0.1:8787 && npm run dev"

echo.
echo Two windows were launched:
echo 1) Backend: npm run personal:server
echo 2) Frontend in server mode: npm run dev
echo.
echo If something closes immediately, read the error in that window.
echo This BAT should be placed in the project root folder.
echo.
pause

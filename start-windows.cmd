@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo   J.A.R.V.I.S. - запуск интерфейса в браузере
echo   ------------------------------------------------
echo   Для отдельного окна с автозапуском сервера используйте
echo   desktop\dist\Jarvis.exe
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -OpenBrowser

echo.
pause

@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_c2ai_gold_lmstudio_vscode_autostart.ps1" %*
exit /b %ERRORLEVEL%

@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass ^
  -File "%~dp0scripts\p2ai_stack\run_c2ai_gold_lmstudio_vscode_autostart.ps1" ^
  -C2AiGoldRoot "%~dp0" %*

exit /b %ERRORLEVEL%

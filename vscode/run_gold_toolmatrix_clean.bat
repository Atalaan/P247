@echo off
setlocal

call "%~dp0scripts\p2ai_stack\start_lmstudio_gui_via_explorer.bat"
if errorlevel 1 exit /b %ERRORLEVEL%

powershell -NoProfile -ExecutionPolicy Bypass ^
  -File "%~dp0scripts\p2ai_stack\run_c2ai_gemma4_toolmatrix.ps1" ^
  -ClineRoot "%~dp0" %*

exit /b %ERRORLEVEL%

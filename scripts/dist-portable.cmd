@echo off
setlocal
call npm run pack:portable
if errorlevel 1 exit /b %errorlevel%
node scripts\zip-portable.mjs

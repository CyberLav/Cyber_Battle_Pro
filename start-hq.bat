@echo off
title Cyber Battle Pro Field HQ
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 18 or newer is required, or use CBP-HQ.exe instead. & pause & exit /b 1)
if not exist node_modules (echo Installing dependencies... & call npm ci || (pause & exit /b 1))
node server.js %*
pause

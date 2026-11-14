@echo off
chcp 65001 > nul
title Video and Audio Downloader

echo.
echo =======================================================
echo          Starting Smart Video Downloader...
echo =======================================================
echo.

if not exist "node_modules" (
    echo [Info] Installing dependencies for the first time...
    call npm install --silent
)

echo Starting local server and opening browser automatically...
echo.
echo (Keep this window open while using the downloader)
echo =======================================================
echo.

node server.js
pause

@echo off
title Battleship Server
echo ========================================
echo   BATTLESHIP ONLINE - Starting Server
echo ========================================
echo.

cd /d "%~dp0"

echo Checking Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Node not in PATH. Trying Program Files...
    set NODE_EXE="C:\Program Files\nodejs\node.exe"
) else (
    set NODE_EXE=node
)

echo Installing dependencies if needed...
if not exist node_modules\express (
    echo Running npm install...
    %NODE_EXE% "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" install
)

echo.
echo Starting server...
echo Open browser at: http://localhost:5050
echo.
%NODE_EXE% backend\server.js

pause

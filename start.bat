@echo off
title TxtLlmHub

echo =============================================
echo   TxtLlmHub - Local LLM Translation Tool
echo =============================================
echo.

cd /d "%~dp0"

echo [Check] Looking for Python...
where python >nul 2>&1
if %errorlevel% neq 0 (
    where python3 >nul 2>&1
    if %errorlevel% neq 0 (
        echo [ERROR] Python not found. Install Python 3.9+ and add to PATH.
        pause
        exit /b 1
    )
    set PYTHON=python3
) else (
    set PYTHON=python
)

echo         Found:
%PYTHON% --version

echo.
echo [1/3] Checking dependencies...
%PYTHON% -c "import flask, requests" >nul 2>&1
if %errorlevel% neq 0 (
    echo         Installing...
    %PYTHON% -m pip install -r requirements.txt -q
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b 1
    )
    echo         Done
) else (
    echo         Dependencies OK
)

echo.
echo [2/3] Make sure LLM server is running at 127.0.0.1:8080
echo.
echo [3/3] Starting TxtLlmHub...
echo.
echo =============================================
echo   Server: http://127.0.0.1:5000
echo   Check "LLM Status" in the web toolbar.
echo   Press Ctrl+C to stop.
echo =============================================

start "" http://127.0.0.1:5000

%PYTHON% app.py

pause

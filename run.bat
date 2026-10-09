@echo off
chcp 65001 >nul
echo ========================================
echo Activating TileServer-GL (via npx) and Local Web Server...
echo ========================================

:: 1. Activating TileServer-GL using npx in the background
echo Activating TileServer-GL...
start cmd /k "npx tileserver-gl --config config.json"

:: Small 3-second delay to let the npx TileServer initialize
timeout /t 3 /nobreak >nul

:: 2. Activating the local Python web server for the site on port 8000 (remains active in this window)
echo Activating local web server (Python)...
python -m http.server 8000
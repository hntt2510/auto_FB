@echo off
setlocal
title Facebook Account Manager
cd /d "%~dp0"

echo ===================================================
echo        Facebook Account Manager v0.8.0
echo ===================================================
echo.

rem Kiem tra node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [LOI] Khong tim thay Node.js tren he thong!
    echo Vui long cai dat Node.js tai https://nodejs.org/ truoc khi tiep tuc.
    echo.
    pause
    exit /b 1
)

rem Kiem tra va cai dat dependencies neu can
if not exist "node_modules\" (
    echo [THONG BAO] Thu muc node_modules chua ton tai.
    echo Dang chay npm install de cai dat dependencies...
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo [LOI] Cai dat dependencies that bai.
        pause
        exit /b 1
    )
    echo Cai dat dependencies hoan tat!
    echo.
)

rem Kiem tra tham so dong lenh
if /i "%~1"=="dev" goto run_dev
if /i "%~1"=="pack" goto run_packaged
if /i "%~1"=="build" goto run_build

rem Don dep cac tien trinh cu dang bi treo chay ngam (tranh xung dot SingleInstanceLock)
taskkill /F /IM "Facebook Account Manager.exe" >nul 2>nul

echo Chon che do khoi dong:
echo.
echo   [1] Bat ung dung che do Development (npm run dev) - Mac dinh sau 3s
if exist "release\win-unpacked\Facebook Account Manager.exe" (
    echo   [2] Bat ban dong goi san (release\win-unpacked)
    echo   [3] Build va dong goi lai ung dung (npm run build)
)
echo.

choice /C 123 /D 1 /T 3 /M "Nhap lua chon [1, 2, 3]: "
if errorlevel 3 goto run_build
if errorlevel 2 goto run_packaged
if errorlevel 1 goto run_dev

:run_dev
echo.
echo [INFO] Dang khoi dong che do phat trien (npm run dev)...
echo Cua so nay se giu lai de theo doi log. Nhan Ctrl+C de thoat.
echo.
call npm run dev
goto finished

:run_packaged
echo.
echo [INFO] Dang khoi dong Facebook Account Manager...
start "" "release\win-unpacked\Facebook Account Manager.exe"
echo.
echo Ung dung da duoc khoi dong! Cua so nay se dong sau 3 giay.
timeout /t 3 >nul
exit /b 0

:run_build
echo.
echo [INFO] Dang build va dong goi ung dung (npm run build)...
call npm run build
if %errorlevel% equ 0 (
    echo.
    echo [THANH CONG] Dong goi hoan tat!
    echo Dang khoi dong ung dung da dong goi...
    start "" "release\win-unpacked\Facebook Account Manager.exe"
    timeout /t 3 >nul
    exit /b 0
) else (
    echo.
    echo [LOI] Qua trinh build that bai.
    pause
)
goto finished

:finished
echo.
echo Ung dung da dong.
pause

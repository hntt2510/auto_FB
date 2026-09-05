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

rem Kiem tra node_modules
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

rem Neu chua co ban dong goi thi chay dev luon
if not exist "release\win-unpacked\Facebook Account Manager.exe" goto run_dev

echo Da tim thay ban dong goi (Packaged App).
echo.
echo   [1] Bat ung dung da dong goi (Mac dinh sau 3s)
echo   [2] Bat che do phat trien (npm run dev)
echo   [3] Dong goi lai ung dung (npm run build)
echo.
choice /C 123 /D 1 /T 3 /M "Nhap lua chon [1, 2, 3]: "
if errorlevel 3 goto run_build
if errorlevel 2 goto run_dev
if errorlevel 1 goto run_packaged

:run_dev
echo.
echo [INFO] Dang khoi dong che do phat trien (npm run dev)...
echo Nhan Ctrl+C de dung ung dung.
echo.
call npm run dev
goto end

:run_packaged
echo.
echo [INFO] Dang khoi dong Facebook Account Manager...
start "" "release\win-unpacked\Facebook Account Manager.exe"
goto end

:run_build
echo.
echo [INFO] Dang build va dong goi ung dung (npm run build)...
call npm run build
if %errorlevel% equ 0 (
    echo.
    echo [THANH CONG] Dong goi hoan tat!
    echo Dang khoi dong ung dung da dong goi...
    start "" "release\win-unpacked\Facebook Account Manager.exe"
) else (
    echo.
    echo [LOI] Qua trinh build that bai.
    pause
)
goto end

:end

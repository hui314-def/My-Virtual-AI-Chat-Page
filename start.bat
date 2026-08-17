@echo off
chcp 65001 >nul
title AI Chat - 启动器

REM ============================================================
REM  一键启动脚本
REM  1) 列出已安装依赖的后端服务，供用户按需选择启动
REM  2) 启动前端网页服务，并打印访问地址
REM
REM  端口默认 8000，两种修改方式：
REM    - 直接修改下方 set "PORT=8000"
REM    - 运行时传入：start.bat 9000
REM ============================================================

cd /d "%~dp0"

REM ---------- 端口配置 ----------
set "PORT=8000"
if not "%~1"=="" set "PORT=%~1"

REM ---------- 虚拟环境路径 ----------
set "VPY=%~dp0.venv\Scripts\python.exe"

echo.
echo  ============================================================
echo     虚拟AI · 灵境投影 —— 一键启动
echo  ============================================================
echo.

REM ---------- 检测各后端依赖是否安装 ----------
if not exist "%VPY%" (
    echo  [提示] 未检测到虚拟环境 .venv，跳过后端服务。
    echo         如需语音 / 图片 / 知识库功能，请先运行 install_dependencies.bat。
    echo.
    goto start_frontend
)
echo  [提示] 检测到虚拟环境 .venv，开始检查后端依赖 ...
"%VPY%" -c "import fastapi" >nul 2>&1
if not errorlevel 1 set "OK2=1"
"%VPY%" -c "import chromadb" >nul 2>&1
if not errorlevel 1 set "OK3=1"
"%VPY%" -c "import torch" >nul 2>&1
if not errorlevel 1 set "OK4=1"
"%VPY%" -c "import requests" >nul 2>&1
if not errorlevel 1 set "OK5=1"
"%VPY%" -c "import pymysql, jwt, bcrypt" >nul 2>&1
if not errorlevel 1 set "OK6=1"

REM 若没有任何后端依赖，直接启动前端
if not defined OK2 if not defined OK3 if not defined OK4 if not defined OK5 if not defined OK6 (
    echo  [提示] 未检测到任何后端服务依赖，仅启动前端。
    echo         如需后端功能，请先运行 install_dependencies.bat。
    echo.
    goto start_frontend
)

REM ---------- 生成状态显示 ----------
set "S2=未安装"
set "S3=未安装"
set "S4=未安装"
set "S5=未安装"
set "S6=未安装"
if defined OK2 set "S2=已安装"
if defined OK3 set "S3=已安装"
if defined OK4 set "S4=已安装"
if defined OK5 set "S5=已安装"
if defined OK6 set "S6=已安装"

REM ---------- 后端选择菜单 ----------
:menu
echo  ------------------------------------------------------------
echo   请选择要启动的后端服务（可多选，例如 23、234、2345、23456）：
echo.
echo    [1] 全部已安装的后端
echo    [2] 图片生成服务  （端口 5050）   %S2%
echo    [3] 知识库服务    （端口 5051）   %S3%
echo    [4] 千问语音合成服务  （端口 5000）   %S4%
echo    [5] moss语音合成服务  （端口 5000）   %S5%
echo    [6] 聊天存储服务  （端口 8001）   %S6%
echo    [0] 不启动后端，仅启动前端
echo  ------------------------------------------------------------
set "choice="
set /p "choice=  请输入选择（如 23、234、1，直接回车=仅前端）: "

set "choice=%choice: =%"
if "%choice%"=="0" goto start_frontend
if "%choice%"=="" goto start_frontend

REM 「1 = 全部」归一化为 23456
echo %choice% | findstr "1" >nul
if not errorlevel 1 set "choice=23456"

REM ---------- 启动所选后端 ----------
echo %choice% | findstr "2" >nul
if not errorlevel 1 (
    if defined OK2 (
        call :launch "图片生成服务" "5050" "backend_code\image_gen\image_gen_api.py" "%~dp0"
    ) else (
        echo  [提示] 图片生成服务依赖未安装，已跳过。
    )
)

echo %choice% | findstr "3" >nul
if not errorlevel 1 (
    if defined OK3 (
        call :launch "知识库服务" "5051" "knowledge_api.py" "%~dp0backend_code\knowledge_base"
    ) else (
        echo  [提示] 知识库服务依赖未安装，已跳过。
    )
)

echo %choice% | findstr "4" >nul
if not errorlevel 1 (
    if defined OK4 (
        call :launch "千问语音合成服务" "5000" "backend_code\tts\tts_api.py" "%~dp0"
    ) else (
        echo  [提示] 千问语音合成服务依赖未安装，已跳过。
    )
)

echo %choice% | findstr "5" >nul
if not errorlevel 1 (
    if defined OK5 (
        call :launch "moss语音合成服务" "5000" "moss_tts_server.py" "%~dp0backend_code\tts"
    ) else (
        echo  [提示] moss语音合成服务依赖未安装，已跳过。
    )
)

echo %choice% | findstr "6" >nul
if not errorlevel 1 (
    if defined OK6 (
        call :launch "聊天存储服务" "8001" "chat_store_api.py" "%~dp0backend_code\chat_store"
    ) else (
        echo  [提示] 聊天存储服务依赖未安装，已跳过。
    )
)

REM ---------- 启动前端 ----------
:start_frontend
set "FRONT_PY=python"
if exist "%VPY%" set "FRONT_PY=%VPY%"

echo.
echo  ============================================================
echo   前端网页服务启动中 ...
echo.
echo   访问地址：http://localhost:%PORT%/
echo  ============================================================
echo.
echo   按 Ctrl+C 可停止前端服务。
echo.

"%FRONT_PY%" -m http.server %PORT%
if errorlevel 1 (
    echo.
    echo  [错误] 前端启动失败。可能原因：
    echo         (1) 端口 %PORT% 已被占用，可换端口：start.bat 9000
    echo         (2) 未安装 Python，请先安装 Python 3.12 并加入 PATH
    echo.
)
pause
exit /b 0

REM ---------- 子程序：启动单个后端 ----------
:launch
REM %~1 = 标题  %~2 = 端口  %~3 = 入口文件  %~4 = 工作目录
echo  [启动] %~1（端口 %~2）...
start "%~1" /D "%~4" "%VPY%" "%~3"
goto :eof

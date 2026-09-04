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

REM ---------- 定义 ANSI 颜色（让终端变得炫酷） ----------
for /F "delims=#" %%E in ('"prompt #$E# & for %%F in (1) do rem"') do set "ESC=%%E"
set "Cyan=%ESC%[36;1m"
set "Yellow=%ESC%[33;1m"
set "Green=%ESC%[32;1m"
set "Reset=%ESC%[0m"
set "Red=%ESC%[31;1m"

echo.
echo %Yellow%╔════════════════════════════════════════════════════════════════╗%Reset%
echo %Yellow%║  %Cyan%✦ 虚拟AI · 灵境投影  ✦%Yellow%
echo %Yellow%║  %Green%一键启动器 (conda 环境)%Yellow%
echo %Yellow%╠════════════════════════════════════════════════════════════════╣%Reset%
echo %Yellow%║  %Reset%▶ 环境: %Green%%CONDA_ENV%%Reset%
echo %Yellow%║  %Reset%▶ 模式: 后台最小化运行 (任务栏可见)%Yellow%
echo %Yellow%║  %Reset%▶ 提示: 菜单选项支持多选 (如 23、234)%Yellow%
echo %Yellow%╚════════════════════════════════════════════════════════════════╝%Reset%
echo.

REM ---------- 检测各后端依赖是否安装 ----------
if not exist "%VPY%" (
    echo  [提示] 未检测到虚拟环境 .venv，跳过后端服务。
    echo         如需语音 / 图片 / 知识库功能，请先运行 install_dependencies.bat。
    echo.
    goto start_frontend
)
echo  [提示] 检测到虚拟环境 .venv，开始检查后端依赖 ...
"%VPY%" -m pip show fastapi >nul 2>&1
if not errorlevel 1 set "OK2=1"
"%VPY%" -m pip show chromadb >nul 2>&1
if not errorlevel 1 set "OK3=1"
"%VPY%" -m pip show torch >nul 2>&1
if not errorlevel 1 set "OK4=1"
"%VPY%" -m pip show requests >nul 2>&1
if not errorlevel 1 set "OK5=1"
"%VPY%" -m pip show pymysql PyJWT bcrypt >nul 2>&1
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
echo %Yellow%╔════════════════════════════════════════════════════════════════════╗%Reset%
echo %Yellow%║  %Cyan%★ 请选择要启动的后端服务（可多选，如 23、234、2345）%Yellow%
echo %Yellow%║
echo %Yellow%║     [1] %Reset%全部已安装的后端%Yellow%
echo %Yellow%║     [2] %Reset%图片生成服务  (端口 5050)  %S2%%Yellow%
echo %Yellow%║     [3] %Reset%知识库服务    (端口 5051)  %S3%%Yellow%
echo %Yellow%║     [4] %Reset%千问语音合成服务 (端口 5000)  %S4%%Yellow%
echo %Yellow%║     [5] %Reset%moss语音合成服务 (端口 5555)  %S5%%Yellow%
echo %Yellow%║     [6] %Reset%聊天存储服务  (端口 8001)  %S6%%Yellow%
echo %Yellow%║     [0] %Reset%不启动后端，仅启动前端%Yellow%
echo %Yellow%║     [K] %Reset%停止所有已启动的服务（杀死后台进程）%Yellow%
echo %Yellow%║                                                               
echo %Yellow%║  %Reset%输入 (23、234，K=停止，直接回车=仅前端) :%Yellow%
echo %Yellow%╚════════════════════════════════════════════════════════════════════╝%Reset%
set "choice="
set /p "choice=  > "

set "choice=%choice: =%"
if /i "%choice%"=="K" goto stop_all
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

goto start_frontend

:stop_all
echo.
echo 正在终止所有 AIChat 相关服务（包括前端）...
taskkill /FI "WINDOWTITLE eq AIChat_*" /T /F >nul 2>&1
if errorlevel 1 (
    echo 没有找到正在运行的 AIChat 服务。
) else (
    echo 所有服务已成功终止。
)
echo.
timeout /t 2 /nobreak >nul
pause
exit /b 0

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

set "FRONT_TITLE=AIChat_Frontend_%PORT%"
start /MIN "%FRONT_TITLE%" "%VPY%" -m http.server %PORT%

timeout /t 1 /nobreak >nul

start http://localhost:%PORT%
if errorlevel 1 (
    echo.
    echo  [错误] 前端启动失败。可能原因：
    echo    1、 端口 %PORT% 已被占用，可换端口：start.bat 9000
    echo    2、 未安装 Python，请先安装 Python 3.12 并加入 PATH
    echo.
)
pause
exit /b 0

REM ---------- 子程序：启动单个后端 ----------
:launch
REM %~1 = 标题  %~2 = 端口  %~3 = 入口文件  %~4 = 工作目录
echo  [启动] %~1（端口 %~2）...
set "WIN_TITLE=AIChat_%~2_%~1"
start /MIN "%WIN_TITLE%" /D "%~4" "%VPY%" "%~3"
goto :eof

@echo off
chcp 65001 >nul
title AI Chat - Install Dependencies

REM ============================================================
REM  项目依赖一键安装脚本
REM  前端无需安装；后端依赖统一安装到虚拟环境 .venv
REM  支持按需多选安装
REM ============================================================

cd /d "%~dp0"

echo.
echo  ============================================================
echo     虚拟AI · 灵境投影 —— 项目依赖一键安装
echo  ============================================================
echo.

REM ---------- 检查 Python ----------
set "PY=python"
%PY% --version >nul 2>&1
if not errorlevel 1 goto py_ready

set "PY=py -3"
%PY% --version >nul 2>&1
if not errorlevel 1 goto py_ready

echo  [错误] 未检测到 Python！
echo         请先安装 Python 3.12（推荐），安装时勾选
echo         "Add python.exe to PATH"，然后重新运行本脚本。
echo         下载地址：https://www.python.org/downloads/
echo.
pause
exit /b 1

:py_ready
for /f "tokens=2" %%v in ('%PY% --version 2^>^&1') do set "PYVER=%%v"
echo  [信息] 检测到 Python 版本：%PYVER%

REM ---------- 创建 / 复用虚拟环境 ----------
set "VENV=.venv"
set "VPY=%VENV%\Scripts\python.exe"

if exist "%VPY%" (
    echo  [信息] 已存在虚拟环境 %VENV%，直接复用。
    echo         （如需重建，请先手动删除 .venv 文件夹后重跑本脚本）
) else (
    echo  [信息] 正在创建虚拟环境 %VENV% ...
    %PY% -m venv "%VENV%"
    if errorlevel 1 (
        echo  [错误] 虚拟环境创建失败，请检查 Python 安装是否完整。
        pause
        exit /b 1
    )
    echo  [完成] 虚拟环境创建成功。
)

echo  [信息] 正在升级虚拟环境内的 pip ...
"%VPY%" -m pip install --upgrade pip
echo.

REM ---------- 安装菜单（支持多选） ----------
:menu
echo  ------------------------------------------------------------
echo   请选择要安装的服务（可多选，例如输入 234 或 2 3 4）：
echo.
echo    [1] 全部安装（图片生成 + 知识库 + 两种语音合成）
echo    [2] 图片生成服务  （image_gen，需配合 ComfyUI）
echo    [3] 知识库服务    （knowledge_base，含向量数据库）
echo    [4] 千问语音合成服务  （qwen_tts，本地模型体积较大，建议 Python 3.12）
echo    [5] moss语音合成服务  （调用云端moss_tts）
echo    [6] 聊天存储服务  （端口 8001）   %S6%
echo    [0] 退出
echo  ------------------------------------------------------------
set "choice="
set /p "choice=  请输入选择（如 23、234、1）: "

REM 去除输入中的空格
set "choice=%choice: =%"
if "%choice%"=="0" goto bye
if "%choice%"=="" goto invalid

REM 是否选择「全部安装」
set "INSTALL_ALL="
echo %choice% | findstr "1" >nul
if not errorlevel 1 set "INSTALL_ALL=1"

set "HAS_ANY="
if defined INSTALL_ALL (
    call :do_install "图片生成" "backend_code\requestments\image_gen_requirements.txt"
    call :do_install "知识库"   "backend_code\requestments\knowledge_base_requirements.txt"
    call :do_install "千问语音合成" "backend_code\requestments\qwen_tts_requirements.txt"
    call :do_install "moss语音合成" "backend_code\requestments\moss_tts_requirements.txt"
    call :do_install "聊天存储服务" "backend_code\requestments\chat_store_requirements.txt"
    goto finish
)

echo %choice% | findstr "2" >nul
if not errorlevel 1 (
    call :do_install "图片生成" "backend_code\requestments\image_gen_requirements.txt"
    set "HAS_ANY=1"
)

echo %choice% | findstr "3" >nul
if not errorlevel 1 (
    call :do_install "知识库" "backend_code\requestments\knowledge_base_requirements.txt"
    set "HAS_ANY=1"
)

echo %choice% | findstr "4" >nul
if not errorlevel 1 (
    call :do_install "千问语音合成" "backend_code\requestments\qwen_tts_requirements.txt"
    set "HAS_ANY=1"
)

echo %choice% | findstr "5" >nul
if not errorlevel 1 (
    call :do_install "moss语音合成" "backend_code\requestments\moss_tts_requirements.txt"
    set "HAS_ANY=1"
)

echo %choice% | findstr "6" >nul
if not errorlevel 1 (
    call :do_install "moss语音合成" "backend_code\requestments\chat_store_requirements.txt"
    set "HAS_ANY=1"
)

if not defined HAS_ANY goto invalid
goto finish

:invalid
    echo.
    echo  [提示] 输入无效，请重新输入 0~6 的组合（如 2、23、234、1）。
    echo.
    goto menu

REM ---------- 安装单个服务 ----------
:do_install
    echo.
    echo  ============================================================
    echo   正在安装【%~1】依赖，请耐心等待 ...
    echo  ============================================================
    "%VPY%" -m pip install -r "%~2"
    if errorlevel 1 (
        echo.
        echo  [失败] 【%~1】依赖安装出错，请查看上方错误信息。
    ) else (
        echo.
        echo  [成功] 【%~1】依赖安装完成。
    )
    echo.
    goto :eof

:finish
    echo  ============================================================
    echo   依赖安装结束。
    echo  ============================================================
    call :create_env
    call :show_usage
    echo.
    echo  按任意键退出 ...
    pause >nul
    exit /b 0

:bye
    echo.
    echo  已取消安装，按任意键退出 ...
    pause >nul
    exit /b 0

REM ---------- 生成 .env 模板 ----------
:create_env
    if exist ".env" (
        echo  [信息] 已存在 .env 文件，跳过创建。
        goto :eof
    )
    echo  [信息] 正在创建 .env 配置模板 ...
    (
        echo # TTS 语音合成服务鉴权（留空则不启用鉴权）
        echo TTS_API_KEY=
        echo # 图片生成服务鉴权（留空则不启用鉴权）
        echo IMG_API_KEY=
        echo # Qwen3-TTS 模型路径（按实际情况填写，即模型权重所在文件夹）
        echo QWEN_TTS_MODEL_PATH=
        echo # MOSI 云端 API 密钥（用于 MossClient 调用）
        echo MOSS_API_KEY=
        echo # ===== 聊天存储服务（MySQL 云同步）=====
        echo DB_HOST=localhost
        echo DB_PORT=3306
        echo DB_USER=root
        echo DB_PASSWORD=
        echo DB_NAME=ai_chat_sync
        echo JWT_SECRET=
        echo CHAT_STORE_PORT=8001
    ) > ".env"
    echo  [完成] 已生成 .env 文件，可按需填写 API Key 与模型路径。
    goto :eof


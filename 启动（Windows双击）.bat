@echo off
title Eating Manager
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误] 没有找到 Node.js。
  echo 请先打开 https://nodejs.org 下载安装 LTS 版本，装好后再双击本文件。
  echo.
  pause
  exit /b
)

if not exist "api.env" (
  echo.
  if exist "api.env.txt" (
    echo [错误] 你的密钥文件名其实是 api.env.txt，多了 .txt 后缀。
    echo 请在文件夹顶部点"查看"，勾选"文件扩展名"，再把它改名为 api.env
  ) else (
    echo [错误] 没有找到 api.env 密钥文件。
    echo 请复制 api.env.example，改名为 api.env，用记事本打开并填入 API 密钥。
  )
  echo.
  pause
  exit /b
)

echo 正在启动，浏览器会自动打开 http://localhost:8787
echo 使用期间请不要关闭这个黑色窗口；关闭窗口即停止。
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8787'"
node --env-file=api.env server.js

echo.
echo 程序已停止。如果上面有红字或"错误"，请截图发给 Claude。
pause

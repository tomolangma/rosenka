@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ================================
echo   土地マップ を起動します
echo ================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [エラー] Node.js が見つかりません。
  echo https://nodejs.org/ からインストールしてください。
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 初回セットアップ中です。依存パッケージをインストールします...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [エラー] npm install に失敗しました。
    pause
    exit /b 1
  )
  echo.
)

echo ブラウザを開きます: http://localhost:5173
echo （終了するには、このウィンドウで Ctrl + C を押してください）
echo.

start "" "http://localhost:5173"

call npm start

endlocal

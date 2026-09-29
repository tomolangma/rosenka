@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

echo ================================
echo   路線価チェッくん を起動します
echo ================================
echo.

call :ensure_node
if errorlevel 1 (
  echo.
  echo [エラー] Node.js の自動インストールに失敗しました。
  echo ・管理者として start.bat を再実行する
  echo ・または https://nodejs.org/ から LTS 版を入れる
  echo.
  pause
  exit /b 1
)

echo サーバーを起動しています...
echo ブラウザで http://localhost:5173 を開きます。
echo （終了するには、このウィンドウで Ctrl + C を押してください）
echo.

set OPEN_BROWSER=1
node server.js
set "EC=%ERRORLEVEL%"
if not "%EC%"=="0" (
  echo.
  echo [エラー] サーバーが終了コード %EC% で止まりました。
  echo Node.js が入っているか、ポート 5173 が空いているか確認してください。
  echo.
  pause
)
endlocal & exit /b %EC%

:: ---------- Node.js LTS が無ければ自動インストール ----------
:ensure_node
where node >nul 2>nul
if not errorlevel 1 (
  for /f "tokens=*" %%V in ('node -v 2^>nul') do echo Node.js %%V を使用します。
  exit /b 0
)

echo Node.js が見つかりません。LTS 版を自動インストールします...
echo （初回のみ。完了まで数分かかることがあります）
echo.

:: 1) winget
where winget >nul 2>nul
if not errorlevel 1 (
  echo [1/2] winget でインストールを試行中...
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --disable-interactivity
  call :refresh_path
  where node >nul 2>nul
  if not errorlevel 1 (
    for /f "tokens=*" %%V in ('node -v 2^>nul') do echo Node.js %%V のインストールが完了しました。
    exit /b 0
  )
)

:: 2) 公式 MSI
echo [2/2] 公式インストーラでインストールを試行中...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-node-lts.ps1"
if errorlevel 1 exit /b 1

call :refresh_path
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
  if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
)
where node >nul 2>nul
if errorlevel 1 exit /b 1
for /f "tokens=*" %%V in ('node -v 2^>nul') do echo Node.js %%V のインストールが完了しました。
exit /b 0

:refresh_path
for /f "usebackq tokens=2*" %%A in (`reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul`) do set "MACHINE_PATH=%%B"
for /f "usebackq tokens=2*" %%A in (`reg query "HKCU\Environment" /v Path 2^>nul`) do set "USER_PATH=%%B"
if defined MACHINE_PATH if defined USER_PATH (
  set "PATH=%MACHINE_PATH%;%USER_PATH%"
) else if defined MACHINE_PATH (
  set "PATH=%MACHINE_PATH%"
) else if defined USER_PATH (
  set "PATH=%USER_PATH%"
)
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
exit /b 0

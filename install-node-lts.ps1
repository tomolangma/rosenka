# Node.js LTS を公式 MSI でサイレントインストールする
$ErrorActionPreference = 'Stop'

$idx = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
$lts = $idx | Where-Object { $_.lts } | Select-Object -First 1
if (-not $lts) { throw 'Node.js LTS の情報を取得できませんでした。' }

$ver = $lts.version
$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
$msi = Join-Path $env:TEMP ("node-{0}-{1}.msi" -f $ver, $arch)
$url = "https://nodejs.org/dist/$ver/node-$ver-$arch.msi"

Write-Host "Download $url"
Invoke-WebRequest -Uri $url -OutFile $msi

Write-Host "Install $msi"
$p = Start-Process -FilePath msiexec.exe -ArgumentList @('/i', $msi, '/qn', '/norestart') -Wait -PassThru
Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue

# 0 = success, 3010 = success reboot required
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
  throw ("msiexec が失敗しました (exit $($p.ExitCode))。管理者として実行してください。")
}

Write-Host "Node.js $ver をインストールしました。"

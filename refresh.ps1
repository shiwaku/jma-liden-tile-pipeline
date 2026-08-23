# 雷雨のときにこれを叩く。最新の落雷を取ってタイルを作り、ビューアを開く。
#
#   .\refresh.ps1              直近3時間を取ってビューアを起動
#   .\refresh.ps1 -Hours 12    直近12時間
#   .\refresh.ps1 -NoViewer    取得とタイル生成だけ（ビューアは起動しない）
#
# 配信は約5日で消えるので、-Hours に指定できるのは実質 120 まで。

param(
  [double]$Hours = 3,
  [switch]$NoViewer
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

python scripts/refresh.py --hours $Hours
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($NoViewer) { exit 0 }

Set-Location (Join-Path $PSScriptRoot 'viewer')
if (-not (Test-Path 'node_modules')) {
  Write-Host '== 依存を入れる (初回のみ)'
  npm install
}
Write-Host ''
Write-Host '== ビューアを起動する。表示された URL をブラウザで開くこと（Ctrl+C で終了）'
npm run dev

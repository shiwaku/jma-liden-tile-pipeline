#!/usr/bin/env bash
# ビューア + PMTiles を gh-pages ブランチへ公開する。
# 履歴は保持しない（PMTiles を積み上げるとリポジトリが膨らむため force push）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -d dist ] || [ -z "$(ls -A dist/*.pmtiles 2>/dev/null)" ]; then
  echo "dist/*.pmtiles が無い。先に make build を実行すること" >&2
  exit 1
fi

echo "== ビューアをビルド"
( cd viewer && npm ci && npm run build )

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -r viewer/dist/. "$STAGE/"
mkdir -p "$STAGE/pmtiles"
cp dist/*.pmtiles dist/index.json "$STAGE/pmtiles/"
# Jekyll に _ 始まりを消されないようにする
touch "$STAGE/.nojekyll"

SIZE=$(du -sk "$STAGE" | cut -f1)
echo "== 公開サイズ: $((SIZE / 1024)) MB"

cd "$STAGE"
git init -q
git checkout -q -b gh-pages
git add -A
git -c user.name="deploy-pages" -c user.email="deploy@local" \
    commit -q -m "deploy $(basename "$ROOT") $(date -u +%Y-%m-%dT%H:%M:%SZ)"
REMOTE="$(cd "$ROOT" && git remote get-url origin)"
git push -q --force "$REMOTE" gh-pages
echo "== gh-pages へ push した: $REMOTE"

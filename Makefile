PYTHON ?= python3

.PHONY: all refresh collect normalize build status prune clean clean-dist manifest deploy-pages

all: build status

# 雷雨のときに叩く: 直近だけ取ってタイルまで作る（HOURS=12 などで変えられる）
HOURS ?= 3
refresh:
	$(PYTHON) scripts/refresh.py --hours $(HOURS)

# 収集窓の中で未取得のスライスを取る（5日窓なので数時間おきで足りる）
collect:
	$(PYTHON) scripts/collect.py

# raw -> archive/（恒久アーカイブ）
normalize:
	$(PYTHON) scripts/normalize.py

# archive/ -> dist/*.pmtiles + dist/index.json
build: normalize
	$(PYTHON) scripts/build.py

# 収集カバレッジの点検（どこが欠落しているか）
status:
	$(PYTHON) scripts/status.py

# アーカイブ済みで配信期限を過ぎた raw キャッシュを消す
prune:
	$(PYTHON) scripts/prune.py

# dist/ の一覧と合計サイズ
manifest:
	@echo "=== dist/ PMTiles ==="
	@ls -l dist/*.pmtiles 2>/dev/null | awk '{printf "%-34s %8.2f MB\n", $$9, $$5/1048576}' || true
	@du -ck dist/*.pmtiles 2>/dev/null | tail -1 | awk '{printf "TOTAL: %.2f MB\n", $$1/1024}' || true

# ビューア + PMTiles を GitHub Pages (gh-pages ブランチ) へデプロイ
deploy-pages:
	bash scripts/deploy-pages.sh

# 生成物とキャッシュを消す（archive/ は消さない）
clean:
	rm -rf data/raw/* data/work/* dist/*

clean-dist:
	rm -rf dist/*

#!/usr/bin/env python3
"""Step 1: 気象庁ナウキャストの落雷位置(liden)を5分スライス単位で data/raw/ に収集する。

配信は**約5日のローリングウィンドウ**で、それより古い basetime は 404 になる
（実測: 5日前=200 / 5日6時間前=404）。したがって

- **過去への遡り取得はできない。** 収集を止めた期間は永久に埋まらない。
- **逆に、5日以内なら後から埋められる。** 5分ごとに起動する必要はなく、
  窓より短い間隔（既定は6時間ごと）で回せば取りこぼさない。

このスクリプトは毎回「窓の中の全 basetime」を列挙し、**未取得のものだけ**取る。
一度保存したスライスは二度と取り直さない（raw は不変のアーカイブ）。

空スライス（雷が無かった5分）も `{"type":"FeatureCollection","features":[]}` として
保存する。**「取得済みで雷なし」と「未取得」を区別できないと、
カバレッジが検証できなくなる**ため。

404（配信終了）は `.miss` マーカーを残し、以後試行しない。
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

from common import (
    JST,
    basetime_dt,
    iter_basetimes,
    load_config,
    miss_path,
    now_utc,
    parse_obstime,
    raw_path,
)

USER_AGENT = "jma-liden-tile-pipeline/0.1 (+https://github.com/shiwaku/jma-liden-tile-pipeline)"


def fetch_slice(url: str, timeout: int, retries: int) -> tuple[int, dict | None]:
    """(status, geojson) を返す。404 は (404, None)。"""
    req = urllib.request.Request(
        url, headers={"Accept-Encoding": "gzip", "User-Agent": USER_AGENT}
    )
    last_exc: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                raw = res.read()
                if res.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return res.status, json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return 404, None
            last_exc = exc
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"取得失敗: {url}: {last_exc!r}")


def validate_slice(basetime: str, geojson: dict) -> list[str]:
    """スライスの前提が崩れていないか検査し、警告文のリストを返す。

    前提（実測で確認済み・README 参照）:
      - geometry は Point のみ
      - properties は id / obstimeJST / type
      - obstimeJST は (basetime-5分, basetime] に入る
    崩れたら黙って通さない。データ側の仕様変更に気づけなくなる。
    """
    warns: list[str] = []
    end_jst = basetime_dt(basetime).astimezone(JST)
    for f in geojson.get("features", []):
        geom = f.get("geometry") or {}
        if geom.get("type") != "Point":
            warns.append(f"想定外の geometry: {geom.get('type')}")
            break
    for f in geojson.get("features", []):
        keys = set((f.get("properties") or {}).keys())
        if keys != {"id", "obstimeJST", "type"}:
            warns.append(f"想定外の properties: {sorted(keys)}")
            break
    for f in geojson.get("features", []):
        try:
            obs = parse_obstime(f["properties"]["obstimeJST"])
        except Exception:  # noqa: BLE001
            warns.append(f"obstimeJST を解釈できない: {f['properties'].get('obstimeJST')!r}")
            break
        delta = (end_jst - obs).total_seconds()
        if not 0 <= delta <= 300:
            warns.append(
                f"obstimeJST がスライス範囲外: {f['properties']['obstimeJST']} "
                f"(basetime={basetime})"
            )
            break
    return warns


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--window-days", type=float, default=None,
                        help="遡る日数（既定は config の collect.window_days）")
    parser.add_argument("--max-slices", type=int, default=None,
                        help="1回で取得する最大スライス数")
    parser.add_argument("--dry-run", action="store_true",
                        help="取得せず、未取得スライス数だけ数える")
    args = parser.parse_args()

    config = load_config()
    src, col = config["source"], config["collect"]
    window = args.window_days if args.window_days is not None else col["window_days"]
    limit = args.max_slices if args.max_slices is not None else col["max_slices_per_run"]

    targets = [
        bt for bt in iter_basetimes(now_utc(), window, src["interval_minutes"])
        if not raw_path(bt).exists() and not miss_path(bt).exists()
    ]
    print(f"窓 {window} 日 / 未取得 {len(targets)} スライス", flush=True)
    if args.dry_run:
        for bt in targets[:20]:
            print(f"  [TODO] {bt}")
        if len(targets) > 20:
            print(f"  ... 他 {len(targets) - 20} 件")
        return 0

    fetched = empty = gone = 0
    features = 0
    warnings: list[str] = []
    for bt in targets[:limit]:
        url = src["url_template"].format(basetime=bt)
        try:
            status, geojson = fetch_slice(url, col["timeout_sec"], col["retries"])
        except Exception as exc:  # noqa: BLE001
            print(f"[FAIL] {bt}: {exc}", file=sys.stderr)
            return 1

        dest = raw_path(bt)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if status == 404:
            miss_path(bt).write_text("", encoding="utf-8")
            gone += 1
            continue

        n = len(geojson.get("features", []))
        for w in validate_slice(bt, geojson):
            warnings.append(f"{bt}: {w}")
        tmp = dest.with_suffix(".part")
        tmp.write_text(json.dumps(geojson, ensure_ascii=False, separators=(",", ":")),
                       encoding="utf-8")
        tmp.replace(dest)
        fetched += 1
        features += n
        if n == 0:
            empty += 1
        time.sleep(col["request_interval_sec"])

    print(f"\ncollect: {fetched} 取得（うち空 {empty}）/ {gone} 配信終了(404) "
          f"/ {features} 件の落雷")
    if warnings:
        print(f"\n⚠ 想定外のデータ {len(warnings)} 件:", file=sys.stderr)
        for w in warnings[:10]:
            print(f"  {w}", file=sys.stderr)
        print("  README の「データの前提」を確認すること", file=sys.stderr)
    remaining = len(targets) - min(len(targets), limit)
    if remaining:
        print(f"残り {remaining} スライス未取得（--max-slices を増やすか再実行）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

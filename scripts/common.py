"""共通ユーティリティ: config 読み込み・パス規約・basetime 列挙。

basetime は気象庁ナウキャストの配信単位で、**UTC の5分境界**を
`YYYYMMDDHHMMSS` で表した文字列。1スライスは
`(basetime - 5分, basetime]` の観測を含む（実測で確認済み・README 参照）。

観測時刻 `obstimeJST` は JST なので、**日別の集計・出力は JST 日付**で切る。
raw の置き場は basetime（UTC）由来、normalized/dist は JST 日付由来で、
意図的に別のキーを使っている。
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Windows の既定コンソールは CP932 で、日本語のログが化ける。
# 出力側だけ UTF-8 に寄せる（ファイル I/O は各所で encoding を明示している）。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure") and (_stream.encoding or "").lower() != "utf-8":
        _stream.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "pipeline.json"

RAW_DIR = ROOT / "data" / "raw"        # 配信のキャッシュ（使い捨て・gitignore）
ARCHIVE_DIR = ROOT / "archive"          # 恒久アーカイブ（コミット対象）
DIST_DIR = ROOT / "dist"                # 生成タイル（gitignore）
MANIFEST_PATH = ARCHIVE_DIR / "manifest.json"

SLICES_PER_DAY = 288                    # 5分 × 288 = 24時間

UTC = timezone.utc
JST = timezone(timedelta(hours=9))

BASETIME_FMT = "%Y%m%d%H%M%S"


def load_config() -> dict:
    with CONFIG_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def now_utc() -> datetime:
    return datetime.now(UTC)


def floor_to_interval(dt: datetime, minutes: int) -> datetime:
    """dt を interval の境界に切り下げる（秒・マイクロ秒は捨てる）。"""
    return dt.replace(
        minute=dt.minute - (dt.minute % minutes), second=0, microsecond=0
    )


def basetime_str(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime(BASETIME_FMT)


def basetime_dt(s: str) -> datetime:
    return datetime.strptime(s, BASETIME_FMT).replace(tzinfo=UTC)


def iter_basetimes(end: datetime, window_days: float, minutes: int):
    """新しい順に basetime 文字列を列挙する。

    end は5分境界に切り下げた時刻。新しい方から返すので、
    途中で打ち切っても「直近が埋まっている」状態を保てる。
    """
    end = floor_to_interval(end, minutes)
    count = int(window_days * 24 * 60 / minutes)
    for i in range(count + 1):
        yield basetime_str(end - timedelta(minutes=minutes * i))


def raw_path(basetime: str) -> Path:
    """data/raw/YYYY/MM/DD/liden_<basetime>.json（basetime = UTC）"""
    return RAW_DIR / basetime[0:4] / basetime[4:6] / basetime[6:8] / f"liden_{basetime}.json"


def miss_path(basetime: str) -> Path:
    """配信終了（404）を記録するマーカー。以後この basetime は取得を試みない。"""
    return raw_path(basetime).with_suffix(".miss")


def archive_path(jst_date: str) -> Path:
    """archive/liden_YYYYMMDD.geojson.gz（YYYYMMDD = JST 日付）

    **これがこのリポジトリの一次資産。** 配信は約5日で消えるので、
    ここに入った時点で初めてデータが恒久化する。
    """
    return ARCHIVE_DIR / f"liden_{jst_date}.geojson.gz"


def slice_day_index(basetime: str) -> tuple[str, int]:
    """スライスを (JST 日付, 0-287 の枠番) に割り当てる。

    スライスは `(basetime-5分, basetime]` なので、**終端時刻で日を決める**と
    日付が1枠ずれる。ここでは「JST 00:05 終端 = その日の枠0」
    「翌 00:00 終端 = その日の枠287」と定義し、日 D の枠 0..287 が
    ちょうど obstime `(D 00:00, D+1 00:00]` を覆うようにしている。

    境界の一瞬（obstime がちょうど 00:00:00.000）だけは、その features は
    前日の日付を持つ枠に入る。features の日付は常に obstime が決めるので、
    枠のカバレッジと1件だけ食い違う余地がある（実害はないが仕様として記す）。
    """
    jst = basetime_dt(basetime).astimezone(JST)
    minutes = jst.hour * 60 + jst.minute
    if minutes == 0:                    # 00:00 終端 = 前日の最終枠
        return (jst - timedelta(days=1)).strftime("%Y%m%d"), SLICES_PER_DAY - 1
    return jst.strftime("%Y%m%d"), minutes // 5 - 1


def load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        with MANIFEST_PATH.open(encoding="utf-8") as f:
            return json.load(f)
    return {"days": {}}


def save_manifest(manifest: dict) -> None:
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    with MANIFEST_PATH.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write(chr(10))


def empty_bitmap() -> str:
    return "." * SLICES_PER_DAY


def bitmap_set(bitmap: str, index: int) -> str:
    """枠 index を取得済み('1')にする。**既に立っているビットは落とさない**
    （raw を掃除した後で再計算してもカバレッジが後退しないため）。"""
    if len(bitmap) != SLICES_PER_DAY:
        bitmap = (bitmap + empty_bitmap())[:SLICES_PER_DAY]
    if bitmap[index] == "1":
        return bitmap
    return bitmap[:index] + "1" + bitmap[index + 1:]


def tile_path(jst_date: str) -> Path:
    return DIST_DIR / f"liden_{jst_date}.pmtiles"


def parse_obstime(s: str) -> datetime:
    """'2026/08/22 16:35:00.010' (JST) -> aware datetime"""
    return datetime.strptime(s, "%Y/%m/%d %H:%M:%S.%f").replace(tzinfo=JST)


def iter_raw_slices():
    """保存済みスライスを (basetime, Path) で古い順に列挙する。"""
    for p in sorted(RAW_DIR.rglob("liden_*.json")):
        yield p.stem.removeprefix("liden_"), p

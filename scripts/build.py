#!/usr/bin/env python3
"""Step 3: 日別 GeoJSON から PMTiles を生成し、ビューア用の索引を書く。

## tippecanoe / pmtiles の実行場所

この環境の tippecanoe・pmtiles は **WSL 側**にしか無い（Windows の PATH には
無く、~/tippecanoe のバイナリは Linux ELF）。そのため

1. Windows の PATH に `tippecanoe` があればそのまま実行（WSL・CI・Linux）
2. 無ければ `wsl.exe` 経由で実行し、パスを WSL 形式に変換して渡す

を自動で切り替える。パス変換はリポジトリ直下を一度だけ `wslpath` で引き、
以降は相対パスを繋ぐ（/mnt/c 固定を前提にしない）。

## .pmtiles を指定しても mbtiles が出る

tippecanoe 2.80 は出力拡張子が `.pmtiles` でも中身は mbtiles(SQLite) を書く。
バージョンで挙動が違うので**マジックバイトを見て判定**し、SQLite なら
`pmtiles convert` を通す。既に PMTiles ならそのまま使う。
"""
from __future__ import annotations

import argparse
import gzip
import json
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path

from common import (
    ARCHIVE_DIR,
    DIST_DIR,
    ROOT,
    archive_path,
    load_config,
    load_manifest,
    tile_path,
)

WORK_DIR = ROOT / "data" / "work"

SQLITE_MAGIC = b"SQLite format 3\x00"
PMTILES_MAGIC = b"PMTiles"

_wsl_root: str | None = None


def _use_wsl() -> bool:
    return shutil.which("tippecanoe") is None


def _wsl_prefix() -> str:
    """リポジトリ直下の WSL パスを一度だけ解決して覚える。"""
    global _wsl_root
    if _wsl_root is None:
        if shutil.which("wsl.exe") is None:
            raise RuntimeError(
                "tippecanoe が PATH に無く、wsl.exe も見つからない。\n"
                "WSL に tippecanoe / pmtiles を入れるか、PATH の通る環境で実行すること。"
            )
        out = subprocess.run(["wsl.exe", "-e", "wslpath", "-a", "-u", str(ROOT)],
                             capture_output=True, text=True, check=True)
        _wsl_root = out.stdout.strip().rstrip("/")
        if not _wsl_root:
            raise RuntimeError("wslpath がリポジトリのパスを解決できなかった")
    return _wsl_root


def _as_arg(p: Path) -> str:
    """コマンドに渡すパス。WSL 経由なら WSL 形式に直す。"""
    if not _use_wsl():
        return str(p)
    rel = p.resolve().relative_to(ROOT).as_posix()
    return f"{_wsl_prefix()}/{rel}"


def run_tool(argv: list[str], timeout: int = 3600) -> None:
    """tippecanoe / pmtiles を実行する（必要なら WSL 経由）。"""
    if _use_wsl():
        # ログインシェル経由。tippecanoe / pmtiles は /usr/local/bin と ~/.local/bin にある
        quoted = " ".join(f"'{a}'" if " " in a else a for a in argv)
        cmd = ["wsl.exe", "-e", "bash", "-lc", quoted]
    else:
        cmd = argv
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(
            f"{argv[0]} 失敗 (exit {proc.returncode}):\n"
            f"{(proc.stderr or proc.stdout)[:800]}"
        )


def head_bytes(p: Path, n: int = 16) -> bytes:
    with p.open("rb") as f:
        return f.read(n)


def unpack(jst_date: str) -> Path:
    """アーカイブ(.gz)を tippecanoe に渡せる素の GeoJSON に展開する。

    tippecanoe に gzip を直接食わせない（バージョンによって扱いが違う）。
    展開先は data/work/ で、生成後に消す。
    """
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    out = WORK_DIR / f"liden_{jst_date}.geojson"
    with gzip.open(archive_path(jst_date), "rb") as src, out.open("wb") as dst:
        shutil.copyfileobj(src, dst)
    return out


def build_one(jst_date: str, cfg: dict, force: bool) -> str:
    archive = archive_path(jst_date)
    dest = tile_path(jst_date)
    if not archive.exists():
        raise FileNotFoundError(f"アーカイブが無い: {archive}")
    if dest.exists() and not force and dest.stat().st_mtime >= archive.stat().st_mtime:
        return "skip"

    src = unpack(jst_date)
    tiles = cfg["tiles"]
    tmp = dest.with_suffix(".tmp.pmtiles")
    tmp.unlink(missing_ok=True)
    run_tool([
        "tippecanoe", "-q", "-f",
        "-o", _as_arg(tmp),
        "-l", tiles["layer"],
        "-n", f"liden_{jst_date}",
        "-A", "気象庁 雷ナウキャスト（落雷の位置）",
        *tiles["tippecanoe"],
        _as_arg(src),
    ])
    if not tmp.exists():
        raise RuntimeError(f"tippecanoe が出力を作らなかった: {tmp}")

    src.unlink(missing_ok=True)

    head = head_bytes(tmp)
    if head.startswith(PMTILES_MAGIC):
        tmp.replace(dest)
        return "ok"
    if not head.startswith(SQLITE_MAGIC):
        raise RuntimeError(f"tippecanoe の出力が mbtiles でも PMTiles でもない: {head!r}")

    # SQLite(mbtiles) だった → pmtiles convert を通す
    mbtiles = dest.with_suffix(".mbtiles")
    tmp.replace(mbtiles)
    dest.unlink(missing_ok=True)
    try:
        run_tool(["pmtiles", "convert", _as_arg(mbtiles), _as_arg(dest)])
    finally:
        mbtiles.unlink(missing_ok=True)
    if not dest.exists() or not head_bytes(dest).startswith(PMTILES_MAGIC):
        raise RuntimeError("pmtiles convert 後も PMTiles になっていない")
    return "ok"


def day_summary(jst_date: str, manifest: dict) -> dict:
    """索引用に日ごとの件数・範囲・type 内訳・カバレッジを出す。"""
    with gzip.open(archive_path(jst_date), "rt", encoding="utf-8") as f:
        data = json.load(f)
    feats = data["features"]
    entry = manifest["days"].get(jst_date, {})
    base = {
        "date": jst_date,
        "count": len(feats),
        "slices": entry.get("slices", 0),
        "complete": entry.get("complete", False),
    }
    if not feats:
        return base
    lons = [f["geometry"]["coordinates"][0] for f in feats]
    lats = [f["geometry"]["coordinates"][1] for f in feats]
    epochs = [f["properties"]["epoch_ms"] for f in feats]
    types = Counter(f["properties"]["type"] for f in feats)
    tile = tile_path(jst_date)
    return {
        **base,
        "bbox": [min(lons), min(lats), max(lons), max(lats)],
        "epoch_ms": [min(epochs), max(epochs)],
        "obstime": [feats[0]["properties"]["obstime"], feats[-1]["properties"]["obstime"]],
        "types": {str(k): v for k, v in sorted(types.items(), key=lambda x: str(x[0]))},
        "pmtiles": tile.name,
        "bytes": tile.stat().st_size if tile.exists() else 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--force", action="store_true", help="既存でも再生成する")
    parser.add_argument("--date", help="JST 日付 YYYYMMDD を1日だけ処理する")
    args = parser.parse_args()

    cfg = load_config()
    DIST_DIR.mkdir(parents=True, exist_ok=True)

    manifest = load_manifest()
    dates = ([args.date] if args.date
             else sorted(p.name[len("liden_"):-len(".geojson.gz")]
                         for p in ARCHIVE_DIR.glob("liden_*.geojson.gz")))
    if not dates:
        print("入力がない（先に normalize.py を実行する）")
        return 0

    if _use_wsl():
        print(f"tippecanoe は WSL 経由で実行する（リポジトリ = {_wsl_prefix()}）")

    built = skipped = 0
    summaries = []
    for jst_date in dates:
        try:
            result = build_one(jst_date, cfg, args.force)
        except Exception as exc:  # noqa: BLE001
            print(f"[FAIL] {jst_date}: {exc}", file=sys.stderr)
            return 1
        summary = day_summary(jst_date, manifest)
        summaries.append(summary)
        built += result == "ok"
        skipped += result == "skip"
        flag = "完全" if summary["complete"] else f"{summary['slices']}/288枠"
        print(f"[{result.upper():4}] liden_{jst_date}.pmtiles  "
              f"{summary['count']:7,} 件  {summary.get('bytes', 0) / 1048576:6.2f} MB  {flag}")

    index = {
        "layer": cfg["tiles"]["layer"],
        "source": "気象庁 高解像度降水ナウキャスト 落雷の位置（liden）",
        "license": "気象庁ホームページ利用規約（出典明示で利用可）",
        "days": summaries,
    }
    index_path = DIST_DIR / "index.json"
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n",
                          encoding="utf-8")
    total = sum(s["count"] for s in summaries)
    print(f"\nbuild: {built} 生成 / {skipped} スキップ / 全 {total:,} 件 -> {DIST_DIR}")
    print(f"索引: {index_path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

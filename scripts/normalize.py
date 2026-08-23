#!/usr/bin/env python3
"""Step 2: raw の5分スライスを **JST 日別の恒久アーカイブ**にまとめる。

`archive/liden_YYYYMMDD.geojson.gz` がこのリポジトリの一次資産。配信は約5日で
消えるので、**ここに入るまでデータは恒久化していない**。`data/raw/` は
いつ消してもよいキャッシュ。

やること:

1. **JST 日付で束ねる。** basetime は UTC だが観測時刻 `obstimeJST` は JST。
   日本の落雷を日単位で見るのは JST が自然なので、出力は JST 日付で切る。
   1つの JST 日は UTC 15:00(前日)〜15:00 の basetime にまたがる。
2. **プロパティを安定キーに置き換える。** 配信元の `id` は
   `nowc_<basetime>_<validtime>_liden_<スライス内連番>` で、スライス内の並び順に
   依存する。時刻・位置・種別を一次情報として持たせ、`src_id` は出所として残す。
3. **`epoch_ms` を持たせる。** MapLibre の filter は数値比較が速く、
   時間アニメーションのスライダーにそのまま使える。
4. **`type` は変換しない。** 0 / 1 / 4 の3値を観測しているが、コードと
   「対地放電 / 雲放電」の対応が一次資料で確認できていない（README 参照）。
   推測した対応を焼き付けると後から直せないので、素の値を通す。
5. **既存アーカイブとマージする。** `src_id` で重複排除するので、
   何度実行しても同じ結果になる（冪等）。後から欠落スライスを埋めた場合も
   その日のアーカイブに足されるだけ。
6. **カバレッジを manifest に記録する。** 288枠のビットマップで
   「どの5分が取得済みか」を残す。raw を掃除しても後退しない。
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime

from common import (
    ARCHIVE_DIR,
    SLICES_PER_DAY,
    UTC,
    archive_path,
    bitmap_set,
    empty_bitmap,
    iter_raw_slices,
    load_manifest,
    parse_obstime,
    save_manifest,
    slice_day_index,
)


def load_archive(jst_date: str) -> dict[str, dict]:
    """既存アーカイブを {src_id: feature} で読む。無ければ空。"""
    path = archive_path(jst_date)
    if not path.exists():
        return {}
    with gzip.open(path, "rt", encoding="utf-8") as f:
        data = json.load(f)
    return {f["properties"]["src_id"]: f for f in data.get("features", [])}


def write_archive(jst_date: str, feats: dict[str, dict]) -> tuple[int, float, bool]:
    """アーカイブを書く。戻り値は (件数, MB, 書き換えたか)。

    **内容が同じなら書かない。** 書き直すとファイルの mtime が動き、
    `build.py` が「入力が新しい」と判断して全日のタイルを作り直す。
    6時間ごとの CI で毎回全再生成になるので、ここで止める。

    gzip は `mtime=0` で書く。内容が同じならバイト列も同じになるので、
    git の diff も出ない（gzip ヘッダの時刻でファイルが変わるのを防ぐ）。
    """
    ordered = sorted(feats.values(), key=lambda f: (f["properties"]["epoch_ms"],
                                                    f["properties"]["src_id"]))
    payload = json.dumps({"type": "FeatureCollection", "features": ordered},
                         ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz:
        gz.write(payload)
    blob = buf.getvalue()

    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    path = archive_path(jst_date)
    if path.exists() and path.read_bytes() == blob:
        return len(ordered), path.stat().st_size / 1048576, False

    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(blob)
    tmp.replace(path)
    return len(ordered), path.stat().st_size / 1048576, True


def normalize_feature(feat: dict, basetime: str) -> tuple[str, str, dict] | None:
    """(jst_date, src_id, 正規化 feature) を返す。壊れていれば None。"""
    props = feat.get("properties") or {}
    try:
        obs = parse_obstime(props["obstimeJST"])
        lon, lat = feat["geometry"]["coordinates"][:2]
    except Exception:  # noqa: BLE001
        return None
    src_id = props.get("id")
    if not isinstance(src_id, str):
        return None
    return obs.strftime("%Y%m%d"), src_id, {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {
            "obstime": obs.isoformat(timespec="milliseconds"),
            "epoch_ms": int(obs.timestamp() * 1000),
            "hhmm": obs.strftime("%H:%M"),
            "type": props.get("type"),
            "slice": basetime,
            "src_id": src_id,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--date", help="JST 日付 YYYYMMDD だけ処理する")
    args = parser.parse_args()

    manifest = load_manifest()
    stats = Counter()
    new_feats: dict[str, dict[str, dict]] = defaultdict(dict)
    touched_days: set[str] = set()

    for basetime, path in iter_raw_slices():
        slice_day, slice_index = slice_day_index(basetime)
        if args.date and slice_day != args.date:
            continue
        try:
            geojson = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            print(f"[SKIP] {path.name}: 読めない ({exc})", file=sys.stderr)
            stats["unreadable"] += 1
            continue
        stats["slices"] += 1

        # 空スライスでもカバレッジは立てる（雷が無かったことも観測結果）
        day_entry = manifest["days"].setdefault(
            slice_day, {"coverage": empty_bitmap(), "features": 0})
        day_entry["coverage"] = bitmap_set(day_entry["coverage"], slice_index)
        touched_days.add(slice_day)

        for feat in geojson.get("features", []):
            norm = normalize_feature(feat, basetime)
            if norm is None:
                stats["broken"] += 1
                continue
            feat_day, src_id, out = norm
            if args.date and feat_day != args.date:
                continue
            new_feats[feat_day][src_id] = out
            touched_days.add(feat_day)
            stats["features"] += 1

    if not touched_days:
        print("正規化対象がない（data/raw/ が空か、--date に該当なし）")
        return 0

    for jst_date in sorted(touched_days):
        existing = load_archive(jst_date)
        before = len(existing)
        existing.update(new_feats.get(jst_date, {}))
        count, mb, changed = write_archive(jst_date, existing)
        added = count - before

        entry = manifest["days"].setdefault(
            jst_date, {"coverage": empty_bitmap(), "features": 0})
        entry["features"] = count
        entry["updated"] = datetime.now(UTC).isoformat(timespec="seconds")
        fetched = entry["coverage"].count("1")
        entry["slices"] = fetched
        entry["complete"] = fetched == SLICES_PER_DAY

        types = Counter(f["properties"]["type"] for f in existing.values())
        breakdown = " ".join(f"type{k}={v:,}" for k, v in
                             sorted(types.items(), key=lambda x: str(x[0])))
        flag = "完全" if entry["complete"] else f"{fetched}/{SLICES_PER_DAY}枠"
        tag = "OK  " if changed else "SAME"
        print(f"[{tag}] liden_{jst_date}.geojson.gz  {count:7,} 件 (+{added:,})  "
              f"{mb:6.2f} MB  {flag}  {breakdown}")

    save_manifest(manifest)
    msg = (f"\nnormalize: {stats['slices']:,} スライス -> {len(touched_days)} 日 / "
           f"{stats['features']:,} 件を投入")
    if stats["broken"]:
        msg += f" / 壊れた feature {stats['broken']}"
    if stats["unreadable"]:
        msg += f" / 読めないスライス {stats['unreadable']}"
    print(msg)
    print(f"アーカイブ: {ARCHIVE_DIR.name}/  索引: {ARCHIVE_DIR.name}/manifest.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

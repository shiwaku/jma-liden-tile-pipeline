#!/usr/bin/env python3
"""アーカイブ済みで、もう取り直す必要のない raw キャッシュを消す。

`data/raw/` は「同じスライスを二度取らない」ためだけの置き場。配信保持期間
（実測 約5日）を過ぎたスライスは取り直すこともできないので、アーカイブに
入っていれば消してよい。

**アーカイブに入っていないスライスは消さない。** 消してしまうと、
まだ窓の中なら取り直せるはずのものを取り直せなくなる。
"""
from __future__ import annotations

import argparse

from common import (
    RAW_DIR,
    basetime_dt,
    floor_to_interval,
    iter_raw_slices,
    load_config,
    load_manifest,
    now_utc,
    slice_day_index,
)

# 実測の配信保持期間。ここより古いスライスは取り直せない
RETENTION_DAYS = 5.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--keep-days", type=float, default=RETENTION_DAYS,
                        help=f"この日数より新しい raw は残す（既定 {RETENTION_DAYS:g}）")
    parser.add_argument("--apply", action="store_true",
                        help="実際に削除する（既定は削除せず一覧だけ出す）")
    args = parser.parse_args()

    cfg = load_config()
    manifest = load_manifest()
    now = floor_to_interval(now_utc(), cfg["source"]["interval_minutes"])

    doomed = []
    kept_recent = kept_unarchived = 0
    for basetime, path in iter_raw_slices():
        age_days = (now - basetime_dt(basetime)).total_seconds() / 86400
        if age_days <= args.keep_days:
            kept_recent += 1
            continue
        slice_day, slice_index = slice_day_index(basetime)
        coverage = (manifest["days"].get(slice_day) or {}).get("coverage", "")
        archived = len(coverage) > slice_index and coverage[slice_index] == "1"
        if not archived:
            # アーカイブに入っていない = normalize が通っていない。消さない
            kept_unarchived += 1
            continue
        doomed.append(path)

    total_mb = sum(p.stat().st_size for p in doomed) / 1048576
    print(f"削除対象 {len(doomed):,} スライス ({total_mb:.1f} MB) / "
          f"新しくて残す {kept_recent:,} / 未アーカイブで残す {kept_unarchived:,}")
    if kept_unarchived:
        print("⚠ 未アーカイブの古いスライスがある。先に normalize.py を実行すること")
    if not doomed:
        return 0
    if not args.apply:
        print("\n（--apply を付けると実際に削除する）")
        for p in doomed[:5]:
            print(f"  {p.relative_to(RAW_DIR)}")
        if len(doomed) > 5:
            print(f"  ... 他 {len(doomed) - 5} 件")
        return 0

    for p in doomed:
        p.unlink(missing_ok=True)
    # 空になったディレクトリを片付ける
    for d in sorted((d for d in RAW_DIR.rglob("*") if d.is_dir()), reverse=True):
        try:
            d.rmdir()
        except OSError:
            pass
    print(f"削除した: {len(doomed):,} スライス ({total_mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

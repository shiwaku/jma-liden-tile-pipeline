#!/usr/bin/env python3
"""収集カバレッジを点検する。

配信が約5日で切れるため、**「今どこが埋まっていないか」を常に見えるように
しておく**のがこのパイプラインの要。区分は次の4つ:

  取得済 : スライスの JSON がある（空スライス = 雷なしも取得済み扱い）
  欠落   : 収集窓の中で未取得 → `collect.py` をそのまま回せば埋まる
  窓外   : 収集窓より古いが配信保持期間の中 → `--window-days` を広げれば **まだ取れる**
  期限切 : 配信保持期間より古く未取得 → **もう取れない**
  配信終 : 404 を確認済み（`.miss` マーカー）
"""
from __future__ import annotations

import argparse
import json
import unicodedata
from collections import defaultdict

from common import (
    basetime_dt,
    floor_to_interval,
    iter_basetimes,
    load_config,
    load_manifest,
    miss_path,
    now_utc,
    raw_path,
    slice_day_index,
)

# 配信保持期間の実測値。5日前=200 / 5日6時間前=404 を確認（README 参照）。
# 境界は日により動くとみて、判定は安全側（短め）に 5.0 日で見る。
RETENTION_DAYS = 5.0

COLUMNS = ["取得済", "欠落", "窓外", "期限切", "配信終", "合計"]


def width(s: str) -> int:
    """全角を2桁として数えた表示幅。"""
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)


def pad(s: str, n: int, right: bool = True) -> str:
    space = " " * max(0, n - width(s))
    return space + s if right else s + space


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--window-days", type=float, default=None,
                        help="収集窓（既定は config の collect.window_days）")
    parser.add_argument("--show-gaps", action="store_true",
                        help="まだ取得できる basetime を列挙する")
    args = parser.parse_args()

    cfg = load_config()
    interval = cfg["source"]["interval_minutes"]
    window = args.window_days if args.window_days is not None else cfg["collect"]["window_days"]
    now = floor_to_interval(now_utc(), interval)

    # 取得済みの判定は **manifest のカバレッジ**を一次情報にする。
    # data/raw/ はいつ掃除してもよいキャッシュなので、raw の有無で判定すると
    # 掃除後に「欠落」が復活してしまう。raw は manifest の補助として見る。
    manifest = load_manifest()
    per_day: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    gaps: list[str] = []
    outside: list[str] = []
    # 保持期間より少し広く見て、期限切れも数える
    for bt in iter_basetimes(now, RETENTION_DAYS + 1, interval):
        slice_day, slice_index = slice_day_index(bt)
        jst_day = f"{slice_day[:4]}-{slice_day[4:6]}-{slice_day[6:]}"
        age_days = (now - basetime_dt(bt)).total_seconds() / 86400
        d = per_day[jst_day]
        d["合計"] += 1
        entry = manifest["days"].get(slice_day) or {}
        coverage = entry.get("coverage", "")
        archived = len(coverage) > slice_index and coverage[slice_index] == "1"
        if archived or raw_path(bt).exists():
            d["取得済"] += 1
        elif miss_path(bt).exists():
            d["配信終"] += 1
        elif age_days <= window:
            d["欠落"] += 1
            gaps.append(bt)
        elif age_days <= RETENTION_DAYS:
            d["窓外"] += 1
            outside.append(bt)
        else:
            d["期限切"] += 1

    for slice_day, entry in manifest["days"].items():
        jst_day = f"{slice_day[:4]}-{slice_day[4:6]}-{slice_day[6:]}"
        if jst_day in per_day:
            per_day[jst_day]["件数"] = entry.get("features", 0)

    print(f"現在 (UTC): {now.strftime('%Y-%m-%d %H:%M')}  / 収集窓 {window:g} 日 "
          f"/ 配信保持 約{RETENTION_DAYS:g} 日（実測）\n")

    head = pad("JST 日付", 12, right=False) + "".join(pad(c, 8) for c in COLUMNS) \
        + pad("落雷件数", 11)
    print(head)
    print("-" * width(head))
    tot: dict[str, int] = defaultdict(int)
    for day in sorted(per_day):
        d = per_day[day]
        row = pad(day, 12, right=False) + "".join(pad(f"{d[c]:,}", 8) for c in COLUMNS) \
            + pad(f"{d['件数']:,}", 11)
        print(row)
        for k, v in d.items():
            tot[k] += v
    print("-" * width(head))
    print(pad("合計", 12, right=False) + "".join(pad(f"{tot[c]:,}", 8) for c in COLUMNS)
          + pad(f"{tot['件数']:,}", 11))

    if tot["欠落"]:
        print(f"\n→ 収集窓内の {tot['欠落']:,} スライスは未取得: python scripts/collect.py")
    if tot["窓外"]:
        oldest = min(outside)
        print(f"→ 窓外の {tot['窓外']:,} スライスもまだ配信中: "
              f"python scripts/collect.py --window-days {RETENTION_DAYS:g}"
              f"（最古 {oldest}）")
    if tot["期限切"]:
        print(f"\n⚠ {tot['期限切']:,} スライスは配信保持期間を過ぎており、"
              f"**永久に取得できない**")
    if args.show_gaps:
        for label, items in (("収集窓内の欠落", gaps), ("窓外（まだ取得可）", outside)):
            if items:
                print(f"\n{label}:")
                for bt in items:
                    print(f"  {bt}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

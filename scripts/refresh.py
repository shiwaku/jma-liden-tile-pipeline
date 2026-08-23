#!/usr/bin/env python3
"""雷雨のときに手動で叩く「最新だけ取る」ワンショット。

collect（直近だけ）→ normalize → build をまとめて実行する。

## なぜ直近だけなのか

配信は約5日で消えるので、本来は継続収集しないとデータは残らない。
このリポジトリは **「普段は溜めない。雷雨のときに最新を見る」** 運用を選んでいる。
その割り切りの結果:

- **走らせなかった期間は永久に欠ける。** それでよい、という判断。
- 逆に、雷雨に気づいてから叩けば **直近5日ぶんまでは遡って取れる。**
  「昨日の夕方すごかったな」も、5日以内なら `--hours 48` などで拾える。

既定の3時間は 36 スライスで、実測 30 秒ほどで終わる。
4日ぶん（1,153スライス）を取ると 13 分ほどかかる。
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from common import DIST_DIR, ROOT, load_manifest

SCRIPTS = Path(__file__).resolve().parent


def run(name: str, *args: str) -> None:
    cmd = [sys.executable, str(SCRIPTS / name), *args]
    print(f"\n$ python scripts/{name} {' '.join(args)}".rstrip(), flush=True)
    proc = subprocess.run(cmd, cwd=ROOT)
    if proc.returncode != 0:
        raise SystemExit(f"scripts/{name} が失敗した (exit {proc.returncode})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--hours", type=float, default=3.0,
                        help="遡る時間。既定 3（配信保持は約5日=120時間まで）")
    parser.add_argument("--skip-build", action="store_true",
                        help="タイル生成をせず、取得とアーカイブだけ行う")
    args = parser.parse_args()

    if args.hours > 120:
        print(f"⚠ --hours {args.hours:g} は配信保持期間（約120時間）を超えている。"
              f"それより古い basetime は 404 になるだけで害はないが、無駄に叩く。",
              file=sys.stderr)

    window_days = args.hours / 24
    run("collect.py", "--window-days", f"{window_days:.6f}")
    run("normalize.py")
    if not args.skip_build:
        run("build.py")

    # 何が最新なのかを最後に一行で出す（これが見たくて叩いているので）
    manifest = load_manifest()
    days = sorted(manifest["days"])
    print("\n" + "=" * 64)
    if days:
        latest = days[-1]
        entry = manifest["days"][latest]
        cov = entry.get("coverage", "")
        last_slot = cov.rfind("1")
        end_min = (last_slot + 1) * 5
        clock = f"{end_min // 60:02d}:{end_min % 60:02d}"
        print(f"最新: {latest[:4]}-{latest[4:6]}-{latest[6:]} JST {clock} まで  "
              f"落雷 {entry.get('features', 0):,} 件  "
              f"({entry.get('slices', 0)}/288 枠)")
    print(f"タイル: {DIST_DIR.relative_to(ROOT)}/  "
          f"ビューア: cd viewer && npm run dev")
    print("=" * 64)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

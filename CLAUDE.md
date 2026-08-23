# CLAUDE.md

## プロジェクト概要

気象庁ナウキャストの「落雷の位置」（liden）を5分スライス単位で継続収集し、
JST 日別アーカイブ → PMTiles → MapLibre タイムラプスビューアまで通すパイプライン。

スクリプト構成・`config/*.json` 方式・`viewer/` の作りは
[`gtfs-gis/railway-frequency-converter`](https://github.com/shiwaku/railway-frequency-converter)
に揃えている（`basemap.ts` / `theme.ts` / `pale-style.json` / `vite.config.ts` は
そこからの流用）。

詳細な使い方・実測値・設計判断は `README.md` を参照。ここには作業するときの
注意だけ書く。

## 取り扱いルール

- **扱うのは気象庁の公開データのみ。** 業務で受領したデータ・顧客提供データ・
  案件固有の受領仕様は、コード・ドキュメント・コミットメッセージ・設定例の
  いずれにも含めない。
- `data/raw/` `data/work/` `dist/` は `.gitignore` 済み。
  **`archive/` はコミット対象**（一次資産なので）。
- 出典表示が必要（気象庁ホームページ利用規約）。ビューアのフッタと
  `dist/index.json` に入れてある。消さないこと。

## 最重要: 配信は約5日で消える

このパイプラインの設計はほぼ全部これが理由。

- **`archive/` に入るまでデータは恒久化していない。** `data/raw/` は
  キャッシュなので消してよいが、**`archive/` を消すと二度と復元できない。**
  `archive/` を触る変更をするときは、消す方向の操作を絶対に自動化しないこと。
- **`git checkout` や `git clean` で `archive/` を巻き戻さない。**
  収集済みのデータが失われる。
- **定期収集はしていない。** 「普段は溜めない。雷雨のときに `refresh.ps1` を叩いて
  最新を見る」運用を意図して選んでいる。`collect.yml` は手動実行専用。
  **これは未実装ではなく決定事項**なので、「cron が無いから足しておこう」と
  勝手に定期実行を追加しないこと。増やすかどうかは利用者が決める。
- その代償として、走らせなかった期間は永久に欠ける。`status.py` の「期限切」が
  常に大きな数になるのは正常な表示であって、直すべき不具合ではない。
- 姉妹リポジトリ `jma-liden-on-kepler`（2024/08/07 の6時間ぶんを kepler.gl で
  1回可視化したもの）の元データは**もう再取得できない**。あれは代替不能な資産なので
  参照するだけにして、変更しない。

## 構成

| パス | 役割 |
|------|------|
| `scripts/common.py` | config 読み込み・パス規約・basetime 列挙・枠番の定義・manifest |
| `refresh.ps1` | **雷雨のとき叩くやつ。** 最新を取ってタイルを作りビューアを開く |
| `scripts/refresh.py` | collect（直近だけ）→ normalize → build のワンショット |
| `scripts/collect.py` | Step 1: 窓の中の未取得スライスを取得。前提の検査つき |
| `scripts/normalize.py` | Step 2: raw → `archive/liden_YYYYMMDD.geojson.gz` とカバレッジ |
| `scripts/build.py` | Step 3: archive → `dist/*.pmtiles` + `dist/index.json` |
| `scripts/status.py` | 収集カバレッジの点検（取得済/欠落/窓外/期限切/配信終） |
| `scripts/prune.py` | 取り直せない古い raw キャッシュの掃除（既定は dry-run） |
| `scripts/deploy-pages.sh` | ビューア + PMTiles を gh-pages へ force push |
| `config/pipeline.json` | 取得元URL・窓・tippecanoe オプション。理由は `comment` に書く |
| `archive/manifest.json` | 日ごとの288枠カバレッジ（`1`/`.` のビットマップ）と件数 |
| `viewer/src/layers.ts` | レイヤー定義・時間フィルタ・経過時間の配色。**ここが本体** |
| `viewer/src/main.ts` | 地図・UI・再生ループ |
| `viewer/src/{basemap,theme}.ts`, `pale-style.json`, `style.css` | 流用（末尾に固有CSSを追記） |

## 開発時の注意

- **`type` に意味を与えない。** 0 / 1 / 4 を観測しているが、対地放電／雲放電との
  対応は一次資料で確認できていない（README に調査経緯あり）。ラベルを付けたく
  なっても、一次資料が出るまでは配信値のまま扱う。**推測をデータに焼き付けると
  後から直せない。**
- **カバレッジの判定に `data/raw/` の有無を使わない。** `archive/manifest.json` の
  ビットマップが一次情報。raw を基準にすると `prune.py` を回した瞬間に
  「欠落」が復活する（実際に一度そう書いて直した）。
- **`bitmap_set()` は立っているビットを落とさない。** raw を掃除した後に
  normalize を回してもカバレッジが後退しないため。
- **空スライスを「データ無し」として捨てない。** 「取得済みで雷なし」と「未取得」を
  区別できなくなる。
- **gzip は `mtime=0` かつ `BytesIO` 経由で書く。** 内容が同じならバイト列も
  同じにしないと、CI が毎回無意味なコミットを積む。`mtime=0` だけでは足りない:
  `GzipFile(fileobj=開いたファイル)` は **fileobj の `.name` を gzip ヘッダの
  FNAME に埋める**ので、同じ内容でもバイト列が変わる。`io.BytesIO` に書けば
  FNAME が付かない。
- **アーカイブは内容が変わらなければ書かない。** 書き直すと mtime が動き、
  `build.py` が全日のタイルを作り直す（6時間ごとの CI で毎回全再生成になる）。
  `write_archive()` がバイト列を比較して `SAME` を返す。
- タイル生成は WSL 経由になる（この環境では tippecanoe が WSL 側にしか無い）。
  `build.py` が自動で切り替えるので、Windows から直接 `python scripts/build.py`
  で通る。
- **tippecanoe の出力は拡張子ではなくマジックバイトで判定する。**
  2.80 は `.pmtiles` を指定しても mbtiles を書く。バージョンで挙動が変わるので
  中身を見る。
- ビューアを変更したら実際に描画を確認すること。式の不正は
  `map.on('error')` にも `console.error` にも出ず、「背景地図が真っ白」のような
  一見無関係な症状で壊れる（README「ビューア実装で踏んだこと」）。
  puppeteer-core + `~/.cache/puppeteer` の Chrome で確認できる。
- スクリプトの日本語ログは Windows の CP932 コンソールで化けるため、
  `common.py` が stdout/stderr を UTF-8 に寄せている。新しいスクリプトでも
  `common` を import しておくこと。

## 調べて確認した事実

再調査の手間を省くためのメモ。すべて実データか一次資料で確認したもの。
**数値は README に表で入れてあるので、そちらを正とする。**

- 配信保持期間は約5日（5日前=200 / 5日6時間前=404）。`targetTimes_N1.json` が
  列挙するのは直近3時間だけで、**列挙範囲＝取得可能範囲ではない**。
- 1スライスは `(basetime-5分, basetime]`。連続24スライス2,466件で違反0件。
- スライス間の重複は0件（`id` も `(obstime,座標,type)` も一意）。
- 座標精度は小数3桁が上限。→ 最大ZL 7 で情報が頭打ち（z7 と z12 で最大ZLの
  一意 `src_id` が完全一致、容量は 59% 減）。
- `type` は 0 / 1 / 4 の3値。気象庁の表示アイコンは `CG.svg`（対地放電）と
  `CC.svg`（雲放電）の2種のみで 1:1 対応しない。配信 JS に `CG`/`CC`/`liden` の
  文字列は無く、`kishou/know/kurashi/thunder.html` と `bosai/nowc/help.html` は 404。

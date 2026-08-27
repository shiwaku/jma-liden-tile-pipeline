import maplibregl, { Map as MLMap } from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'

import { getBasemapStyle } from './basemap'
import { applyThemeAttr, initialTheme, type Theme } from './theme'
import {
  addLidenLayers,
  ageColor,
  ageOpacity,
  COUNT_LAYER_BASE,
  GLOW_LAYERS,
  groupTypes,
  layerId,
  legendHtml,
  PICK_LAYER_BASE,
  removeLidenLayers,
  SLOTS,
  sourceId,
  typeFilter,
  type DayEntry,
  type Index,
  type Slot,
} from './layers'

/**
 * PMTiles の配置先。dev では vite.config.ts のミドルウェアが `/pmtiles` で配る。
 *
 * **既定を絶対パス `/pmtiles` にしてはいけない。** GitHub Pages のプロジェクトサイトは
 * `https://<user>.github.io/<repo>/` に載るので、`/pmtiles` は
 * `https://<user>.github.io/pmtiles` を指してしまい全部 404 になる（実際に踏んだ）。
 * 相対の `./pmtiles` を `document.baseURI` で絶対化して使う。
 *
 * ここで `new URL()` を使うのは安全。テンプレート（`{z}` など）を含まないので、
 * `layers.ts` のタイルURLテンプレートで `new URL()` を避けている理由
 * （`{z}` が %7Bz%7D にエンコードされる）は当てはまらない。
 */
const PMTILES_BASE = (() => {
  const raw = import.meta.env.VITE_PMTILES_BASE ?? './pmtiles'
  const withSlash = raw.endsWith('/') ? raw : raw + '/'
  return new URL(withSlash, document.baseURI).href.replace(/\/$/, '')
})()
/**
 * 時刻カーソルは **分単位**で持つ（配信スライスの5分単位ではない）。
 *
 * `epoch_ms` は1秒未満まで持っているので、カーソルを5分刻みにする理由はない。
 * 5分刻みだったころは「1分/コマ」を選んでも
 * `round(1/5) = 0` → 最低1枠に丸められて「5分/コマ」と同じ動きになっていた。
 *
 * 5分という単位は「配信スライスのカバレッジ（288枠）」の話であって、
 * 表示の時間解像度とは別物。混ぜないこと。
 */
/**
 * 日付タブに出す日数。**配信保持（約5日）に合わせて5日。**
 *
 * これは「取りに行く窓」ではなく「見せる窓」。収集の窓は
 * `.github/workflows/collect.yml` の `hours` と `config/pipeline.json` の
 * `collect.window_days` 側にあり、こことは別物なので混ぜないこと。
 *
 * **絞るのは表示だけで、アーカイブは絞らない。** `archive/` は一次資産で、
 * ここに入った日は配信から消えても復元できる唯一の控えになる。
 * この定数を大きくすれば、過去に集めた日はそのまま出てくる。
 */
const VISIBLE_DAYS = 5

const MINUTES_PER_DAY = 24 * 60

// 背景地図(pmtiles://)と落雷タイル(pmtiles://)の両方で必要
maplibregl.addProtocol('pmtiles', new Protocol().tile)

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error('要素が無い: #' + id)
  return el as T
}

interface State {
  index: Index
  /** カーソルがいま乗っている日。`minute` から導くので直接書き換えない */
  day: DayEntry
  /**
   * **タイムライン先頭からの経過分**（0..表示日数×1440）。
   *
   * 1日ぶんではなく**表示している全日を通した**位置を持つ。日をまたいで
   * 再生するために、カーソルを日に属さない値にしてある。日への対応づけは
   * `dayAt()` / `cursorMs()` が持つ。
   */
  minute: number
  windowMinutes: number
  stepMinutes: number
  activeTypes: Set<number>
  playing: boolean
  theme: Theme
  /** いま表に出しているスロット。もう一方は先読み／前日の残光用 */
  slot: Slot
  /** 各スロットに載っている日（YYYYMMDD）。未ロードは null */
  slotDate: Record<Slot, string | null>
}

let map: MLMap
let state: State
let timer: number | null = null

/** その日の JST 00:00 の epoch(ms)。スライダーの原点。 */
function dayStartMs(date: string): number {
  const y = +date.slice(0, 4)
  const m = +date.slice(4, 6)
  const d = +date.slice(6, 8)
  // JST(+09:00) の 00:00 を UTC に直す
  return Date.UTC(y, m - 1, d, 0, 0, 0) - 9 * 3600 * 1000
}

/**
 * タイムライン全体の長さ（分）。**表示している日数 × 1440。**
 *
 * 実時間の差ではなく**日の枚数**で数える。収集していない日はそもそも
 * index.json に載らないのでアーカイブには穴が空きうる。実時間で測ると
 * 誰もいない何日ぶんもスクラブする羽目になるので、1日を1レーンとして詰める。
 * 日付は時計にも目盛りにも必ず出しているので、詰めても読み違えない。
 */
function timelineMinutes(): number {
  return state.index.days.length * MINUTES_PER_DAY
}

/** その分位置が何日目のレーンか。末尾（＝全長ちょうど）は最終日に寄せる。 */
function dayIndexAt(minute: number): number {
  const i = Math.floor(minute / MINUTES_PER_DAY)
  return Math.min(Math.max(i, 0), state.index.days.length - 1)
}

function dayAt(minute: number): DayEntry {
  return state.index.days[dayIndexAt(minute)]
}

/** その日の中での分（0..1440）。 */
function minuteOfDay(minute: number): number {
  return minute - dayIndexAt(minute) * MINUTES_PER_DAY
}

function cursorMs(): number {
  return dayStartMs(dayAt(state.minute).date) + minuteOfDay(state.minute) * 60 * 1000
}

/** カーソルが乗っている日の JST 00:00〜24:00。「1日ぶんすべて」表示で使う。 */
function dayRange(): [number, number] {
  const start = dayStartMs(dayAt(state.minute).date)
  return [start, start + MINUTES_PER_DAY * 60 * 1000]
}

/**
 * PMTiles の URL。**内容が変わったことが分かる版数を付ける。**
 *
 * ファイル名は `liden_YYYYMMDD.pmtiles` で固定なのに、同じ日を後から
 * 追加収集すると中身だけが差し替わる。GitHub Pages は
 * `Cache-Control: max-age=600` を返すので、版数を付けないと
 * **新旧のアーカイブのバイト範囲が混ざる。** PMTiles はレンジ取得なので、
 * ヘッダ／ディレクトリだけ古いキャッシュから来るとオフセットがずれて
 * 「地図は出るが落雷が出ない・欠ける」形で壊れる。
 *
 * 版数は `slices`-`bytes`（build.py が書く実測値）にする。中身が変わった
 * ときだけ変わるので、変わっていない日のタイルはキャッシュが効いたままになる。
 * デプロイ時刻のような全日共通の値にすると、1日ぶん増えただけで
 * 全日を再ダウンロードさせてしまう。
 *
 * クエリを足しても pmtiles の Protocol は壊れない。タイル URL の解析は
 * `/pmtiles:\/\/(.+)\/(\d+)\/(\d+)\/(\d+)/` の**貪欲**マッチなので、
 * `/` を含まないクエリは末尾の z/x/y と取り違えられない。
 */
function tileUrl(day: DayEntry): string {
  const name = day.pmtiles ?? 'liden_' + day.date + '.pmtiles'
  return PMTILES_BASE + '/' + name + '?v=' + day.slices + '-' + (day.bytes ?? 0)
}

// ---- 描画の更新 ----

/**
 * 時刻カーソルの反映。**paint だけを差し替える。**
 * `setFilter` はタイルの再評価を起こすので再生ループでは触らない
 * （種別の切替だけが filter を触る → `refreshFilter()`）。
 */
/** 表のスロットの層 id。 */
function activeLayer(base: string): string {
  return layerId(base, state.slot)
}

/** 表と裏を入れ替えた側のスロット。 */
function otherSlot(): Slot {
  return state.slot === 'a' ? 'b' : 'a'
}

/** 表示中の時刻窓 [from, cursor]。「1日ぶんすべて」はその日の 00:00 起点。 */
function visibleRange(): [number, number] {
  const cursor = cursorMs()
  const windowMs = state.windowMinutes * 60 * 1000
  return [windowMs <= 0 ? dayRange()[0] : cursor - windowMs, cursor]
}

/** その日のタイルが時刻窓に掛かるか。 */
function dayIntersects(date: string, from: number, to: number): boolean {
  const start = dayStartMs(date)
  return start < to && start + MINUTES_PER_DAY * 60 * 1000 > from
}

/** 塗っているスロットの層 id（存在するものだけ）。クリックも件数もこれで揃える。 */
function paintedLayers(base: string): string[] {
  return paintedSlots()
    .map((slot) => layerId(base, slot))
    .filter((id) => map.getLayer(id))
}

/** いま塗るべきスロット（＝時刻窓に掛かる日を載せているスロット）。 */
function paintedSlots(): Slot[] {
  const [from, to] = visibleRange()
  return SLOTS.filter((slot) => {
    const date = state.slotDate[slot]
    return date !== null && dayIntersects(date, from, to)
  })
}

function refreshLayers(): void {
  if (!map.getLayer(activeLayer(COUNT_LAYER_BASE))) return
  const cursor = cursorMs()
  const windowMs = state.windowMinutes * 60 * 1000
  const color = ageColor(cursor, windowMs)
  // **時刻窓に掛かるスロットは全部塗る。** 真夜中の直後は残光が前日に伸びるので、
  // 表（新しい日）だけ塗ると 00:00 から残光ぶんのあいだ画面が空になる
  // （5分/コマなら 30分ぶん＝6コマ、「一瞬消えた」に見える）。
  const on = new Set(paintedSlots())

  for (const slot of SLOTS) {
    for (const s of GLOW_LAYERS) {
      const id = layerId(s.id, slot)
      if (!map.getLayer(id)) continue
      if (!on.has(slot)) {
        map.setPaintProperty(id, 'circle-opacity', 0)
        continue
      }
      // 芯を白にするのはダークのときだけ。**ライトの淡色地図では白は背景に溶ける**ので、
      // 芯にも経過時間の色を載せて点を見えるようにする。
      const c = s.color === 'white' && state.theme === 'light' ? color : (s.color === 'white' ? '#ffffff' : color)
      map.setPaintProperty(id, 'circle-color', c)
      map.setPaintProperty(id, 'circle-opacity', ageOpacity(cursor, windowMs, s.base))
    }
  }

  updateClock()
  updateVisibleCount()
}

/**
 * ソースが読み終わるまで待つ。**保険のタイムアウト付き。**
 *
 * `sourcedata` が期待どおり飛ばないケース（タイルが1枚も無い日など）で
 * 永久に待たないようにする。待てなかったら諦めて先へ進むだけなので、
 * 最悪でも「元の一瞬消える挙動」に戻るだけで固まりはしない。
 */
function whenSourceLoaded(id: string, timeoutMs = 4000): Promise<void> {
  if (!map.getSource(id)) return Promise.resolve()
  if (map.isSourceLoaded(id)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = (): void => {
      map.off('sourcedata', onData)
      window.clearTimeout(timer)
      resolve()
    }
    const onData = (e: { sourceId?: string }): void => {
      if (e.sourceId === id && map.isSourceLoaded(id)) done()
    }
    const timer = window.setTimeout(done, timeoutMs)
    map.on('sourcedata', onData)
  })
}

/**
 * 何分前から次の日を裏へ積み始めるか（シミュレーション時間）。
 * 5分/コマ・120ms なら 120分 ＝ 24コマ ≒ 2.9 秒ぶんの猶予になる。
 */
const PRELOAD_LEAD_MINUTES = 120

/** 裏のスロットにその日を載せる（すでに載っていれば何もしない）。 */
function loadIntoBack(day: DayEntry): Slot {
  const back = otherSlot()
  if (state.slotDate[back] === day.date) return back
  removeLidenLayers(map, back)
  addLidenLayers(map, back, tileUrl(day), state.index.layer)
  state.slotDate[back] = day.date
  refreshFilter()
  return back
}

/**
 * 真夜中が近づいたら次の日を裏へ積む。**早すぎると前日を追い出してしまう。**
 *
 * 昇格した直後の裏には**前日**が載っていて、それが真夜中をまたぐ残光を
 * 描いている。次の日をすぐ積むとそれを上書きしてしまうので、境界の
 * PRELOAD_LEAD_MINUTES 前になるまで待つ。
 */
function maybePreloadNext(): void {
  const i = dayIndexAt(state.minute)
  const toBoundary = (i + 1) * MINUTES_PER_DAY - state.minute
  if (toBoundary > PRELOAD_LEAD_MINUTES) return
  const next = state.index.days[i + 1]
  if (next) loadIntoBack(next)
}

/**
 * カーソルが別の日のレーンに入ったらタイルを差し替える。
 *
 * タイルは日ごとに分かれているので、通しで再生すると真夜中でソースを
 * 貼り替える必要がある。**毎コマ呼ばれるので、日が変わっていなければ即戻る**こと。
 *
 * **消してから足すと、読み終わるまで落雷が一瞬消える。** 表と裏の2スロットを
 * 持ち、裏で読み終わってから表に昇格させる。次の日は境界に着く前に裏へ
 * 先読みしておくので、真夜中の入れ替えは待ち時間ゼロで済む。
 *
 * ここでは `fitBounds` しない。再生中に真夜中を越えるたび地図が飛ぶのは邪魔なので、
 * 画面を合わせるのは日付タブを押したとき（`jumpToDay`）だけにする。
 *
 * **`activeTypes` にも触らない。** 日によって出る type は違うが、真夜中ごとに
 * 絞り込みが戻ると、消したはずの雲放電が勝手に復活する。
 */
function syncDay(): void {
  const day = dayAt(state.minute)
  if (day.date === state.day.date) {
    maybePreloadNext()
    return
  }

  // 裏に載っていなければ（＝スライダーで遠くへ飛んだ）いま載せる。
  // **表はまだ消さない。** 読み終わるまで前の日を出しておく。
  const back = loadIntoBack(day)
  void whenSourceLoaded(sourceId(back)).then(() => {
    // 待っている間にさらに日が変わっていたら、そのときの sync に任せる
    if (dayAt(state.minute).date !== day.date) return
    state.day = day
    state.slot = back
    // 旧スロットはそのまま残す。**真夜中をまたぐ残光をそれが描く。**
    markSelectedDay()
    updateDayNote()
    refreshLayers()
  })
}

/** カーソルを動かし、スライダー・タイル・描画をまとめて追従させる。 */
function setMinute(minute: number): void {
  state.minute = Math.min(Math.max(minute, 0), timelineMinutes())
  ;($('time-slider') as HTMLInputElement).value = String(state.minute)
  syncDay()
  refreshLayers()
}

/** 種別の絞り込み。トグル操作のときだけ呼ぶ。 */
/**
 * 種別の絞り込み。トグル操作のときだけ呼ぶ。
 * **裏のスロットにも掛ける。** 掛け忘れると、真夜中で表に出た瞬間に
 * 消したはずの種別が復活する。
 */
function refreshFilter(): void {
  const filter = typeFilter(state.activeTypes)
  for (const slot of SLOTS) {
    for (const s of GLOW_LAYERS) {
      const id = layerId(s.id, slot)
      if (map.getLayer(id)) map.setFilter(id, filter)
    }
  }
}

/** 通しのタイムラインなので、時刻だけでは何日目か分からない。**必ず日付も出す。** */
function updateClock(): void {
  const m = minuteOfDay(state.minute)
  const hh = String(Math.floor(m / 60) % 24).padStart(2, '0')
  const mm = String(m % 60).padStart(2, '0')
  const time = m === MINUTES_PER_DAY ? '24:00' : hh + ':' + mm
  $('clock').textContent = mmdd(dayAt(state.minute)) + ' ' + time
}

/** 日付の短い表記（`8/26`）。タブ・目盛り・時計で同じものを使う。 */
function mmdd(day: DayEntry): string {
  return +day.date.slice(4, 6) + '/' + +day.date.slice(6, 8)
}

/**
 * 画面内の可視件数。
 *
 * - `queryRenderedFeatures` はタイル境界で同じ点を二重に返すので `src_id` で数え直す
 * - **不透明度0で消した点も「描画済み」として返ってくる**ので、時刻の窓は
 *   ここで JS 側で絞る（filter に時刻を入れていないため）
 */
function updateVisibleCount(): void {
  if (!map.isStyleLoaded()) return
  // 塗っているスロット全部から数える。真夜中をまたぐ残光は2日ぶんに散るので、
  // 表だけ数えると件数が実際より少なく出る。
  const layers = paintedLayers(COUNT_LAYER_BASE)
  if (layers.length === 0) return
  const [from, cursor] = visibleRange()
  const ids = new Set<string>()
  for (const f of map.queryRenderedFeatures({ layers })) {
    const p = f.properties ?? {}
    const e = p.epoch_ms as number
    if (e > from && e <= cursor) ids.add(p.src_id as string)
  }
  $('visible-count').textContent = ids.size.toLocaleString('ja-JP') + ' 件'
}

/**
 * その位置で拾える落雷のうち、**いま見えているもの**を1件返す。
 *
 * `queryRenderedFeatures` は**不透明度0の点も「描画済み」として返す**ので、
 * そのまま先頭を採ると「光っていない別の時刻の落雷」の内容が出る
 * （実際に踏んだ: 15:00 を見ているのに 17:45 の点が返ってきた）。
 * 時刻窓で絞ってから、**いちばん新しい＝いちばん明るい**ものを選ぶ。
 */
function pickAt(point: maplibregl.Point): maplibregl.MapGeoJSONFeature | null {
  const layers = paintedLayers(PICK_LAYER_BASE)
  if (layers.length === 0) return null
  const [from, cursor] = visibleRange()
  let best: maplibregl.MapGeoJSONFeature | null = null
  let bestMs = -Infinity
  for (const f of map.queryRenderedFeatures(point, { layers })) {
    const e = (f.properties ?? {}).epoch_ms as number
    if (!(e > from && e <= cursor)) continue
    if (e > bestMs) { bestMs = e; best = f }
  }
  return best
}

// ---- 再生 ----

function tick(): void {
  let next = state.minute + state.stepMinutes
  // 末尾まで行ったら先頭の日へ戻る（1日ぶんではなく**全日**を1周する）
  if (next > timelineMinutes()) next = 0
  setMinute(next)
}

function setPlaying(on: boolean): void {
  state.playing = on
  $('play-btn').textContent = on ? '❚❚' : '▶'
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
  if (on) timer = window.setInterval(tick, 120)
}

// ---- パネルの組み立て ----

/**
 * 日付タブ。**タイムラインは通しなので、これは「その日の 00:00 へ飛ぶ」ボタン。**
 * 押してもタイルの読み込み直しはしない（カーソルを動かせば `syncDay` が追う）。
 */
function buildDaySeg(): void {
  const seg = $('day-seg')
  seg.innerHTML = ''
  state.index.days.forEach((day, i) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.role = 'tab'
    btn.dataset.date = day.date
    // 選択状態は既存 CSS の .seg button[aria-selected='true'] に合わせる
    btn.setAttribute('aria-selected', String(day.date === state.day.date))
    btn.textContent = mmdd(day)
    btn.title = day.count.toLocaleString('ja-JP') + ' 件 / ' + day.slices + '/288 枠'
    if (!day.complete) btn.classList.add('is-partial')
    btn.addEventListener('click', () => jumpToDay(i))
    seg.appendChild(btn)
  })
}

/**
 * 選択表示だけを塗り替える。**再生中は真夜中ごとに呼ばれる**ので、
 * タブを作り直す `buildDaySeg` とは分けてある（作り直すとクリックの取りこぼしが出る）。
 */
function markSelectedDay(): void {
  for (const btn of $('day-seg').querySelectorAll<HTMLButtonElement>('button')) {
    btn.setAttribute('aria-selected', String(btn.dataset.date === state.day.date))
  }
}

/**
 * スライダーの目盛り。通しなので「0時/6時/…」では今どのへんか分からない。
 * 日付を**レーンの左端に**並べる。
 */
function buildSliderScale(): void {
  const box = $('slider-scale')
  box.innerHTML = ''
  for (const day of state.index.days) {
    const span = document.createElement('span')
    span.textContent = mmdd(day)
    box.appendChild(span)
  }
}

function buildTypeToggles(): void {
  const box = $('types')
  box.innerHTML = ''
  // **表示している全日の合計**で出す。日ごとの件数にすると、通し再生で真夜中を
  // 越えるたび数字が飛んで、絞り込みを操作したのかデータが変わったのか分からない。
  const totals = totalTypes()
  const present = Object.keys(totals).map(Number).sort((a, b) => a - b)
  for (const g of groupTypes(present)) {
    const n = g.codes.reduce((sum, c) => sum + (totals[String(c)] ?? 0), 0)
    const label = document.createElement('label')
    label.className = 'toggle'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.id = 'group-' + g.key
    input.checked = g.codes.every((c) => state.activeTypes.has(c))
    input.addEventListener('change', () => {
      for (const c of g.codes) {
        if (input.checked) state.activeTypes.add(c)
        else state.activeTypes.delete(c)
      }
      refreshFilter()
      updateVisibleCount()
    })
    // 流用した CSS は input を隠して .switch を見せる構造。
    // .switch を出さないとチェックボックスが一切見えなくなる（実際に踏んだ）。
    const knob = document.createElement('span')
    knob.className = 'switch'
    const span = document.createElement('span')
    span.className = 't-label'
    span.innerHTML = g.label + ' <em>' + n.toLocaleString('ja-JP') + '</em>' +
      '<small>' + g.note + '</small>'
    label.append(input, knob, span)
    box.appendChild(label)
  }
}

function updateDayNote(): void {
  const d = state.day
  const note = d.complete
    ? d.count.toLocaleString('ja-JP') + ' 件・288/288 枠（完全）'
    : d.count.toLocaleString('ja-JP') + ' 件・' + d.slices + '/288 枠 — 未取得の時間帯あり'
  $('day-note').textContent = note
  $('day-note').classList.toggle('is-warn', !d.complete)
}

function updateLegend(): void {
  $('legend').innerHTML = legendHtml(state.windowMinutes)
}

/**
 * その日の 00:00 へ飛ぶ。**再生は止めない**（飛んだ先からそのまま流れる）。
 *
 * 画面を合わせるのはここだけ。`syncDay` 側でも `fitBounds` すると、
 * 通し再生で真夜中を越えるたびに地図が飛んでしまう。
 */
function jumpToDay(i: number): void {
  setMinute(i * MINUTES_PER_DAY)
  const day = state.index.days[i]
  if (day.bbox) {
    map.fitBounds(day.bbox, { padding: 48, duration: 0, maxZoom: 8 })
  }
}

/** 表示している全日を合計した type 別件数。 */
function totalTypes(): Record<string, number> {
  const total: Record<string, number> = {}
  for (const d of state.index.days) {
    for (const [k, v] of Object.entries(d.types ?? {})) total[k] = (total[k] ?? 0) + v
  }
  return total
}

// ---- テーマ ----

function applyTheme(theme: Theme): void {
  state.theme = theme
  applyThemeAttr(theme)
  $('theme-btn').textContent = theme === 'dark' ? '☀' : '☾'
  map.setStyle(getBasemapStyle(theme), { diff: false })
  map.once('styledata', () => {
    // スタイルを差し替えるとソースごと消えるので、**表だけ**載せ直す。
    // 裏は次に日が変わるとき（syncDay / maybePreloadNext）に積み直される。
    addLidenLayers(map, state.slot, tileUrl(state.day), state.index.layer)
    state.slotDate = { a: null, b: null }
    state.slotDate[state.slot] = state.day.date
    refreshFilter()
    refreshLayers()
  })
}

// ---- 起動 ----

async function boot(): Promise<void> {
  // index.json はファイル名が固定なのに毎回中身が変わる。GitHub Pages の
  // `max-age=600` に任せると、Actions を回した直後でも**古い日付一覧が最大10分**
  // 出続ける（実際に踏んだ: 収集もタイル生成もデプロイも成功しているのに
  // ビューアの日付だけ増えない）。索引だけは必ずサーバに取りに行く。
  // 実体の PMTiles 側は `tileUrl()` の版数でキャッシュを切る。
  const res = await fetch(PMTILES_BASE + '/index.json', { cache: 'no-store' })
  if (!res.ok) {
    document.body.innerHTML =
      '<p style="padding:24px;font:14px system-ui">' +
      'dist/index.json が読めない。先に <code>python scripts/build.py</code> を実行すること。</p>'
    return
  }
  const index: Index = await res.json()
  // 日付タブに出すのは**直近 VISIBLE_DAYS 日ぶんだけ**。
  // archive/ は消さないので index.json には集めた日が全部載る。
  // 全部出すとタブが際限なく増えるので、**表示だけ**を末尾から絞る。
  // archive/ も dist/ も完全なままなので、ここを外せばいつでも全日出せる。
  const days = index.days.filter((d) => d.count > 0).slice(-VISIBLE_DAYS)
  if (days.length === 0) {
    document.body.innerHTML = '<p style="padding:24px;font:14px system-ui">落雷データが空。</p>'
    return
  }
  index.days = days
  const latest = days[days.length - 1]
  // 起動位置は**最新日の 00:00**。通しになっても、開いた直後に見えるものは
  // これまでと同じにしておく。過去へはスライダーを左へ引けば繋がっている。
  const startMinute = (days.length - 1) * MINUTES_PER_DAY

  // `hash: true` の Map は初期化直後に自分でハッシュを書くので、
  // **Map を作る前に**「URL で位置指定があったか」を控える。
  // これを見ずに常に fitBounds すると、URL で位置を指定しても無視される。
  const hadHash = window.location.hash.length > 1

  const theme = initialTheme()
  state = {
    index,
    day: latest,
    minute: startMinute,
    windowMinutes: 30,
    stepMinutes: 5,
    // **全日に出てくる type をまとめて有効にする。** 最新日にしか無い type で
    // 初期化すると、過去の日へスクラブしたときに一部が黙って消える。
    activeTypes: new Set(
      days.flatMap((d) => Object.keys(d.types ?? {})).map(Number),
    ),
    playing: false,
    theme,
    slot: 'a',
    slotDate: { a: latest.date, b: null },
  }
  applyThemeAttr(theme)

  map = new maplibregl.Map({
    container: 'map',
    style: getBasemapStyle(theme),
    center: [138.0, 37.0],
    zoom: 4.4,
    maxZoom: 14,
    hash: true,
  })
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120 }), 'bottom-left')

  // スタイル・タイルのエラーは黙って落ちる（「地図は出るがオーバーレイだけ出ない」
  // 形で壊れる）。開発時は必ず表に出す。
  const mapErrors: string[] = []
  map.on('error', (e) => {
    const msg = (e as unknown as { error?: Error }).error?.message ?? String(e)
    mapErrors.push(msg)
    console.error('[map]', msg)
  })
  if (import.meta.env.DEV) {
    Object.assign(window as unknown as Record<string, unknown>, {
      __map: map,
      __mapErrors: mapErrors,
      __state: () => state,
    })
  }

  $('theme-btn').textContent = theme === 'dark' ? '☀' : '☾'
  $('theme-btn').addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark')
  })
  $('collapse-btn').addEventListener('click', () => {
    const body = $('panel-body')
    body.hidden = !body.hidden
    // パネルは全高固定なので、畳むときは .collapsed を付けて高さの固定を解除する。
    // hidden だけだと中身が消えた全高の板が残る。
    $('panel').classList.toggle('collapsed', body.hidden)
    $('collapse-btn').textContent = body.hidden ? '▾' : '▴'
  })
  $('collapse-btn').textContent = '▴'

  $('play-btn').addEventListener('click', () => setPlaying(!state.playing))
  $('time-slider').addEventListener('input', (e) => {
    setPlaying(false)
    // ドラッグで日をまたぐので、タイルの差し替えも要る（setMinute が面倒を見る）
    setMinute(+(e.target as HTMLInputElement).value)
  })
  $('window-select').addEventListener('change', (e) => {
    state.windowMinutes = +(e.target as HTMLSelectElement).value
    updateLegend()
    refreshLayers()
  })
  $('speed-select').addEventListener('change', (e) => {
    state.stepMinutes = +(e.target as HTMLSelectElement).value
    if (state.playing) setPlaying(true)
  })

  // クリックで1件の内容を見る
  const tooltip = $('tooltip')
  // **レイヤー指定でイベントを張らない。** 表のスロットは真夜中で入れ替わるので、
  // id を固定して張ると入れ替わった側で拾えなくなる。地図全体で受けて、
  // そのとき塗っているスロット全部に問い合わせる。
  map.on('click', (e) => {
    const f = pickAt(e.point)
    if (!f) {
      tooltip.hidden = true
      return
    }
    const p = f.properties ?? {}
    tooltip.hidden = false
    tooltip.style.left = (e.point.x + 12) + 'px'
    tooltip.style.top = (e.point.y + 12) + 'px'
    tooltip.innerHTML =
      '<strong>' + String(p.obstime ?? '').replace('T', ' ').slice(0, 23) + '</strong><br />' +
      'type ' + p.type + ' / 配信スライス ' + p.slice
  })
  map.on('mousemove', (e) => {
    const pick = activeLayer(PICK_LAYER_BASE)
    const on = map.getLayer(pick)
      ? map.queryRenderedFeatures(e.point, { layers: [pick] }).length > 0
      : false
    map.getCanvas().style.cursor = on ? 'pointer' : ''
  })
  map.on('moveend', updateVisibleCount)
  // タイルの読み込みが終わるまで queryRenderedFeatures は空を返す。
  // refreshLayers の直後に数えるだけでは 0 のままになるので idle で数え直す。
  map.on('idle', updateVisibleCount)

  // スライダーは**全日通し**。max は日数×1440（HTML の 1440 固定を上書きする）。
  const slider = $('time-slider') as HTMLInputElement
  slider.max = String(timelineMinutes())
  slider.value = String(startMinute)

  await new Promise<void>((resolve) => map.once('load', () => resolve()))
  addLidenLayers(map, 'a', tileUrl(latest), index.layer)
  buildSliderScale()
  buildDaySeg()
  buildTypeToggles()
  updateDayNote()
  updateLegend()
  refreshFilter()
  refreshLayers()
  // URL で位置が指定されていない初回だけデータ範囲に合わせる。
  // fitBounds は duration:0（アニメーション中に hashchange が割り込むと戻される）。
  if (!hadHash && latest.bbox) {
    map.fitBounds(latest.bbox, { padding: 48, duration: 0, maxZoom: 8 })
  }
}

void boot()

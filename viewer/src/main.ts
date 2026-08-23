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
  COUNT_LAYER,
  GLOW_LAYERS,
  groupTypes,
  legendHtml,
  PICK_LAYER,
  removeLidenLayers,
  typeFilter,
  type DayEntry,
  type Index,
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
const SLICE_MINUTES = 5
const SLOTS_PER_DAY = 288

// 背景地図(pmtiles://)と落雷タイル(pmtiles://)の両方で必要
maplibregl.addProtocol('pmtiles', new Protocol().tile)

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error('要素が無い: #' + id)
  return el as T
}

interface State {
  index: Index
  day: DayEntry
  /** 0..287 の枠番。JST 00:00 起点で 5 分刻み */
  slot: number
  windowMinutes: number
  stepMinutes: number
  activeTypes: Set<number>
  playing: boolean
  theme: Theme
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

function cursorMs(): number {
  return dayStartMs(state.day.date) + (state.slot + 1) * SLICE_MINUTES * 60 * 1000
}

function dayRange(): [number, number] {
  const start = dayStartMs(state.day.date)
  return [start, start + SLOTS_PER_DAY * SLICE_MINUTES * 60 * 1000]
}

function tileUrl(day: DayEntry): string {
  return PMTILES_BASE + '/' + (day.pmtiles ?? 'liden_' + day.date + '.pmtiles')
}

// ---- 描画の更新 ----

/**
 * 時刻カーソルの反映。**paint だけを差し替える。**
 * `setFilter` はタイルの再評価を起こすので再生ループでは触らない
 * （種別の切替だけが filter を触る → `refreshFilter()`）。
 */
function refreshLayers(): void {
  if (!map.getLayer(COUNT_LAYER)) return
  const cursor = cursorMs()
  const windowMs = state.windowMinutes * 60 * 1000
  const color = ageColor(cursor, windowMs)

  for (const s of GLOW_LAYERS) {
    // 芯を白にするのはダークのときだけ。**ライトの淡色地図では白は背景に溶ける**ので、
    // 芯にも経過時間の色を載せて点を見えるようにする。
    const c = s.color === 'white' && state.theme === 'light' ? color : (s.color === 'white' ? '#ffffff' : color)
    map.setPaintProperty(s.id, 'circle-color', c)
    map.setPaintProperty(s.id, 'circle-opacity', ageOpacity(cursor, windowMs, s.base))
  }

  updateClock()
  updateVisibleCount()
}

/** 種別の絞り込み。トグル操作のときだけ呼ぶ。 */
function refreshFilter(): void {
  if (!map.getLayer(COUNT_LAYER)) return
  const filter = typeFilter(state.activeTypes)
  for (const s of GLOW_LAYERS) map.setFilter(s.id, filter)
}

function updateClock(): void {
  const end = (state.slot + 1) * SLICE_MINUTES
  const hh = String(Math.floor(end / 60) % 24).padStart(2, '0')
  const mm = String(end % 60).padStart(2, '0')
  $('clock').textContent = end === SLOTS_PER_DAY * SLICE_MINUTES ? '24:00' : hh + ':' + mm
}

/**
 * 画面内の可視件数。
 *
 * - `queryRenderedFeatures` はタイル境界で同じ点を二重に返すので `src_id` で数え直す
 * - **不透明度0で消した点も「描画済み」として返ってくる**ので、時刻の窓は
 *   ここで JS 側で絞る（filter に時刻を入れていないため）
 */
function updateVisibleCount(): void {
  if (!map.getLayer(COUNT_LAYER) || !map.isStyleLoaded()) return
  const cursor = cursorMs()
  const windowMs = state.windowMinutes * 60 * 1000
  const from = windowMs <= 0 ? dayRange()[0] : cursor - windowMs
  const ids = new Set<string>()
  for (const f of map.queryRenderedFeatures({ layers: [COUNT_LAYER] })) {
    const p = f.properties ?? {}
    const e = p.epoch_ms as number
    if (e > from && e <= cursor) ids.add(p.src_id as string)
  }
  $('visible-count').textContent = ids.size.toLocaleString('ja-JP') + ' 件'
}

// ---- 再生 ----

function tick(): void {
  const step = Math.max(1, Math.round(state.stepMinutes / SLICE_MINUTES))
  state.slot += step
  if (state.slot >= SLOTS_PER_DAY) state.slot = 0
  const slider = $('time-slider') as HTMLInputElement
  slider.value = String(state.slot)
  refreshLayers()
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

function buildDaySeg(): void {
  const seg = $('day-seg')
  seg.innerHTML = ''
  for (const day of state.index.days) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.role = 'tab'
    // 選択状態は既存 CSS の .seg button[aria-selected='true'] に合わせる
    btn.setAttribute('aria-selected', String(day.date === state.day.date))
    btn.textContent = +day.date.slice(4, 6) + '/' + +day.date.slice(6, 8)
    btn.title = day.count.toLocaleString('ja-JP') + ' 件 / ' + day.slices + '/288 枠'
    if (!day.complete) btn.classList.add('is-partial')
    btn.addEventListener('click', () => void selectDay(day))
    seg.appendChild(btn)
  }
}

function buildTypeToggles(): void {
  const box = $('types')
  box.innerHTML = ''
  const present = Object.keys(state.day.types ?? {}).map(Number).sort((a, b) => a - b)
  for (const g of groupTypes(present)) {
    const n = g.codes.reduce((sum, c) => sum + (state.day.types?.[String(c)] ?? 0), 0)
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

async function selectDay(day: DayEntry): Promise<void> {
  state.day = day
  state.activeTypes = new Set(Object.keys(day.types ?? {}).map(Number))
  state.slot = 0
  const slider = $('time-slider') as HTMLInputElement
  slider.value = '0'

  removeLidenLayers(map)
  addLidenLayers(map, tileUrl(day), state.index.layer)

  buildDaySeg()
  buildTypeToggles()
  updateDayNote()
  refreshFilter()
  refreshLayers()
  if (day.bbox) {
    map.fitBounds(day.bbox, { padding: 48, duration: 0, maxZoom: 8 })
  }
}

// ---- テーマ ----

function applyTheme(theme: Theme): void {
  state.theme = theme
  applyThemeAttr(theme)
  $('theme-btn').textContent = theme === 'dark' ? '☀' : '☾'
  map.setStyle(getBasemapStyle(theme), { diff: false })
  map.once('styledata', () => {
    addLidenLayers(map, tileUrl(state.day), state.index.layer)
    refreshFilter()
    refreshLayers()
  })
}

// ---- 起動 ----

async function boot(): Promise<void> {
  const res = await fetch(PMTILES_BASE + '/index.json')
  if (!res.ok) {
    document.body.innerHTML =
      '<p style="padding:24px;font:14px system-ui">' +
      'dist/index.json が読めない。先に <code>python scripts/build.py</code> を実行すること。</p>'
    return
  }
  const index: Index = await res.json()
  const days = index.days.filter((d) => d.count > 0)
  if (days.length === 0) {
    document.body.innerHTML = '<p style="padding:24px;font:14px system-ui">落雷データが空。</p>'
    return
  }
  index.days = days
  const latest = days[days.length - 1]

  // `hash: true` の Map は初期化直後に自分でハッシュを書くので、
  // **Map を作る前に**「URL で位置指定があったか」を控える。
  // これを見ずに常に fitBounds すると、URL で位置を指定しても無視される。
  const hadHash = window.location.hash.length > 1

  const theme = initialTheme()
  state = {
    index,
    day: latest,
    slot: 0,
    windowMinutes: 30,
    stepMinutes: 5,
    activeTypes: new Set(Object.keys(latest.types ?? {}).map(Number)),
    playing: false,
    theme,
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
    state.slot = +(e.target as HTMLInputElement).value
    setPlaying(false)
    refreshLayers()
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
  map.on('click', PICK_LAYER, (e) => {
    const f = e.features?.[0]
    if (!f) return
    const p = f.properties ?? {}
    tooltip.hidden = false
    tooltip.style.left = (e.point.x + 12) + 'px'
    tooltip.style.top = (e.point.y + 12) + 'px'
    tooltip.innerHTML =
      '<strong>' + String(p.obstime ?? '').replace('T', ' ').slice(0, 23) + '</strong><br />' +
      'type ' + p.type + ' / 配信スライス ' + p.slice
  })
  map.on('click', (e) => {
    const hits = map.queryRenderedFeatures(e.point, { layers: [PICK_LAYER] })
    if (hits.length === 0) tooltip.hidden = true
  })
  map.on('mouseenter', PICK_LAYER, () => { map.getCanvas().style.cursor = 'pointer' })
  map.on('mouseleave', PICK_LAYER, () => { map.getCanvas().style.cursor = '' })
  map.on('moveend', updateVisibleCount)
  // タイルの読み込みが終わるまで queryRenderedFeatures は空を返す。
  // refreshLayers の直後に数えるだけでは 0 のままになるので idle で数え直す。
  map.on('idle', updateVisibleCount)

  await new Promise<void>((resolve) => map.once('load', () => resolve()))
  addLidenLayers(map, tileUrl(latest), index.layer)
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

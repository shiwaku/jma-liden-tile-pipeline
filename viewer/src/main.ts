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
  buildFilter,
  legendHtml,
  LAYER_DOT,
  LAYER_GLOW,
  SOURCE_ID,
  type DayEntry,
  type Index,
} from './layers'

// PMTiles の配置先。dev では vite.config.ts のミドルウェアが /pmtiles で配る。
const PMTILES_BASE = import.meta.env.VITE_PMTILES_BASE ?? '/pmtiles'
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

function refreshLayers(): void {
  if (!map.getLayer(LAYER_DOT)) return
  const cursor = cursorMs()
  const windowMs = state.windowMinutes * 60 * 1000
  const filter = buildFilter(cursor, windowMs, state.activeTypes, dayRange())

  for (const id of [LAYER_GLOW, LAYER_DOT]) {
    map.setFilter(id, filter)
  }
  map.setPaintProperty(LAYER_DOT, 'circle-color', ageColor(cursor, windowMs))
  map.setPaintProperty(LAYER_DOT, 'circle-opacity', ageOpacity(cursor, windowMs))
  map.setPaintProperty(LAYER_GLOW, 'circle-color', ageColor(cursor, windowMs))

  updateClock()
  updateVisibleCount()
}

function updateClock(): void {
  const end = (state.slot + 1) * SLICE_MINUTES
  const hh = String(Math.floor(end / 60) % 24).padStart(2, '0')
  const mm = String(end % 60).padStart(2, '0')
  $('clock').textContent = end === SLOTS_PER_DAY * SLICE_MINUTES ? '24:00' : hh + ':' + mm
}

/**
 * 画面内の可視件数。`queryRenderedFeatures` はタイル境界で同じ点が
 * 二重に返ることがあるので `src_id` で数え直す。
 */
function updateVisibleCount(): void {
  if (!map.getLayer(LAYER_DOT) || !map.isStyleLoaded()) return
  const feats = map.queryRenderedFeatures({ layers: [LAYER_DOT] })
  const ids = new Set(feats.map((f) => f.properties?.src_id as string))
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
  const types = Object.keys(state.day.types ?? {}).map(Number).sort((a, b) => a - b)
  for (const t of types) {
    const label = document.createElement('label')
    label.className = 'toggle'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.id = 'type-' + t
    input.checked = state.activeTypes.has(t)
    input.addEventListener('change', () => {
      if (input.checked) state.activeTypes.add(t)
      else state.activeTypes.delete(t)
      refreshLayers()
    })
    const span = document.createElement('span')
    const n = state.day.types?.[String(t)] ?? 0
    span.innerHTML = 'type ' + t + ' <em>' + n.toLocaleString('ja-JP') + '</em>'
    label.append(input, span)
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

  if (map.getLayer(LAYER_DOT)) map.removeLayer(LAYER_DOT)
  if (map.getLayer(LAYER_GLOW)) map.removeLayer(LAYER_GLOW)
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)
  addLidenLayers(map, tileUrl(day), state.index.layer)

  buildDaySeg()
  buildTypeToggles()
  updateDayNote()
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
  map.on('click', LAYER_DOT, (e) => {
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
    const hits = map.queryRenderedFeatures(e.point, { layers: [LAYER_DOT] })
    if (hits.length === 0) tooltip.hidden = true
  })
  map.on('mouseenter', LAYER_DOT, () => { map.getCanvas().style.cursor = 'pointer' })
  map.on('mouseleave', LAYER_DOT, () => { map.getCanvas().style.cursor = '' })
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
  refreshLayers()
  if (latest.bbox) map.fitBounds(latest.bbox, { padding: 48, duration: 0, maxZoom: 8 })
}

void boot()

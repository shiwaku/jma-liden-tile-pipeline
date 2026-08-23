import type { ExpressionSpecification, Map as MLMap } from 'maplibre-gl'

/** dist/index.json の1日ぶん。 */
export interface DayEntry {
  date: string
  count: number
  slices: number
  complete: boolean
  bbox?: [number, number, number, number]
  epoch_ms?: [number, number]
  obstime?: [string, string]
  types?: Record<string, number>
  pmtiles?: string
  bytes?: number
}

export interface Index {
  layer: string
  source: string
  license: string
  days: DayEntry[]
}

export const SOURCE_ID = 'liden'
export const LAYER_GLOW = 'liden-glow'
export const LAYER_DOT = 'liden-dot'

/**
 * 残光の配色。新しい落雷ほど明るく、時間が経つほど沈む。
 * 単一色相ではなく「白 → 黄 → 橙 → 赤紫」に流すことで、
 * 同じ場所に重なった古い点と新しい点が区別できる。
 */
const AGE_RAMP: Array<[number, string]> = [
  [0.0, '#ffffff'],
  [0.08, '#fff2a8'],
  [0.25, '#ffc247'],
  [0.5, '#f4783b'],
  [0.75, '#c23b6e'],
  [1.0, '#5b2a80'],
]

/** PMTiles の maxzoom。これを超えるズームはオーバーズームで描く（README 参照）。 */
export const TILE_MAXZOOM = 7

/**
 * 経過時間（0=最新, 1=窓の端）から色を作る式。
 *
 * `cursor` は再生ごとに変わるので、この式もフレームごとに作り直して
 * `setPaintProperty` で差し替える。式の中で参照するのは `epoch_ms` だけ。
 */
export function ageColor(cursor: number, windowMs: number): ExpressionSpecification | string {
  if (windowMs <= 0) {
    // 1日ぶんすべて表示: 経過時間で色を分けない。
    // ここは **式ではなく素の色文字列を返す**。`['literal', '#ffc247']` は
    // literal が配列・オブジェクト専用なので色として不正で、レイヤーの paint が
    // 丸ごと無効になる（実際に踏んだ）。
    return '#ffc247'
  }
  const stops = AGE_RAMP.flatMap(([t, color]) => [t * windowMs, color])
  return [
    'interpolate',
    ['linear'],
    ['max', 0, ['-', cursor, ['get', 'epoch_ms']]],
    ...stops,
  ] as ExpressionSpecification
}

/** 経過時間で不透明度も落とす（古い点を背景に沈める）。 */
export function ageOpacity(cursor: number, windowMs: number): ExpressionSpecification | number {
  if (windowMs <= 0) return 0.55
  return [
    'interpolate',
    ['linear'],
    ['max', 0, ['-', cursor, ['get', 'epoch_ms']]],
    0, 1,
    windowMs * 0.6, 0.55,
    windowMs, 0.12,
  ] as ExpressionSpecification
}

/**
 * 時刻とタイプで絞り込む filter。
 *
 * `epoch_ms` は数値なので比較が軽い。`type` は配信値のまま扱い、
 * 選択されていない値を落とす。
 */
export function buildFilter(
  cursor: number,
  windowMs: number,
  activeTypes: Set<number>,
  dayRange: [number, number],
): ExpressionSpecification {
  const from = windowMs <= 0 ? dayRange[0] - 1 : cursor - windowMs
  const clauses: ExpressionSpecification[] = [
    ['>', ['get', 'epoch_ms'], from] as ExpressionSpecification,
    ['<=', ['get', 'epoch_ms'], cursor] as ExpressionSpecification,
  ]
  if (activeTypes.size > 0) {
    clauses.push([
      'in',
      ['get', 'type'],
      ['literal', [...activeTypes]],
    ] as unknown as ExpressionSpecification)
  } else {
    // 全部オフ = 何も出さない
    clauses.push(['==', ['literal', 1], ['literal', 0]] as unknown as ExpressionSpecification)
  }
  return ['all', ...clauses] as ExpressionSpecification
}

/** 落雷レイヤーを追加する。にじみ用の大きい円と、芯の小さい円の2枚重ね。 */
export function addLidenLayers(map: MLMap, url: string, layerName: string): void {
  map.addSource(SOURCE_ID, {
    type: 'vector',
    url: `pmtiles://${url}`,
  })

  map.addLayer({
    id: LAYER_GLOW,
    type: 'circle',
    source: SOURCE_ID,
    'source-layer': layerName,
    paint: {
      // ズームが上がるほど大きく。落雷は点なので面積で密度を見せる
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        3, 4, 7, 10, 12, 26,
      ],
      'circle-color': '#ffc247',
      'circle-opacity': 0.18,
      'circle-blur': 1,
    },
  })

  map.addLayer({
    id: LAYER_DOT,
    type: 'circle',
    source: SOURCE_ID,
    'source-layer': layerName,
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        3, 1.4, 7, 3, 12, 7,
      ],
      'circle-color': '#ffffff',
      'circle-opacity': 1,
      'circle-stroke-width': 0,
    },
  })
}

export function legendHtml(windowMinutes: number): string {
  if (windowMinutes <= 0) {
    return `<div class="legend-row">
      <span class="legend-swatch" style="background:#ffc247"></span>
      <span>1日ぶんの落雷（時刻で色分けしない）</span>
    </div>`
  }
  const bar = AGE_RAMP.map(([, c]) => c).join(',')
  return `
    <div class="legend-ramp" style="background:linear-gradient(90deg,${bar})"></div>
    <div class="legend-ends"><span>今</span><span>${windowMinutes}分前</span></div>
  `
}

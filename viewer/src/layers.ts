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

/**
 * 発光は **3層の円を重ねて**作る。ぼかした大きい円で光をにじませ、
 * その内側にもう一枚、芯に小さくて硬い白を置く。
 * 構成は姉妹リポジトリ jartic-traffic-signal-cycle-converter の
 * `viewer/src/map/layers/signal.ts` に合わせている。
 *
 * `circle-blur` は 1 を超えてよい（2.5 で外周まで大きくにじむ）。
 * 芯だけ白にして色は外側2層に載せる。落雷は「白く光る中心＋色の暈」に見える。
 */
export const GLOW_LAYERS: Array<{
  id: string
  radius: Array<[number, number]>
  blur: number
  /** 不透明度の基準値。経過時間の減衰にこれを掛ける */
  base: number
  color: 'age' | 'white'
}> = [
  { id: 'liden-glow', radius: [[3, 5], [7, 12], [12, 26]], blur: 2.5, base: 0.5, color: 'age' },
  { id: 'liden-mid', radius: [[3, 2.5], [7, 6], [12, 12]], blur: 1.5, base: 0.8, color: 'age' },
  { id: 'liden-core', radius: [[3, 0.8], [7, 1.6], [12, 3]], blur: 0, base: 1, color: 'white' },
]

/** 当たり判定に使う層。いちばん大きいので拾いやすい。 */
export const PICK_LAYER = 'liden-glow'
/** 件数を数える層。芯なので画面端で余分に拾わない。 */
export const COUNT_LAYER = 'liden-core'

/**
 * 残光の配色。新しい落雷ほど明るく、時間が経つほど沈む。
 *
 * 明度だけで段階を付けない。**ぼかした小さな発光点では明度差はにじんで潰れる**ので、
 * 白→黄→橙→赤紫と色相を回す（この判断も姉妹リポジトリの実測メモに合わせた）。
 */
const AGE_RAMP: Array<[number, string]> = [
  [0.0, '#ffffff'],
  [0.08, '#fff2a8'],
  [0.25, '#ffc247'],
  [0.5, '#f4783b'],
  [0.75, '#c23b6e'],
  [1.0, '#5b2a80'],
]

/** PMTiles の maxzoom。これを超えるズームはオーバーズームで描く。 */
export const TILE_MAXZOOM = 7

/**
 * 放電種別（配信値 `type`）のグループ分け。
 *
 * 出典は気象庁「配信資料に関する仕様 No.13201 雷観測データ」の
 * > 放電種別（TT）：0-1 雲放電、4 対地放電
 * https://www.data.jma.go.jp/suishin/shiyou/pdf/no13201
 *
 * **アーカイブ側は `type` を変換していない。** ラベル付けはここだけでやる。
 * 仕様が改訂されてもアーカイブを作り直さずに済むようにするため。
 */
export const DISCHARGE_GROUPS: Array<{ key: string; label: string; note: string; codes: number[] }> = [
  { key: 'ground', label: '対地放電（落雷）', note: 'type 4', codes: [4] },
  { key: 'cloud', label: '雲放電', note: 'type 0・1', codes: [0, 1] },
]

/**
 * 仕様に無いコードは「その他」に集める。**黙って隠さない**のが要点。
 * 配信側が新しい種別を出し始めたときに気づけなくなる。
 */
export function groupTypes(present: number[]): Array<{ key: string; label: string; note: string; codes: number[] }> {
  const known = new Set(DISCHARGE_GROUPS.flatMap((g) => g.codes))
  const groups = DISCHARGE_GROUPS
    .map((g) => ({ ...g, codes: g.codes.filter((c) => present.includes(c)) }))
    .filter((g) => g.codes.length > 0)
  const unknown = present.filter((c) => !known.has(c)).sort((a, b) => a - b)
  if (unknown.length > 0) {
    groups.push({
      key: 'other',
      label: 'その他（仕様に無いコード）',
      note: unknown.map((c) => `type ${c}`).join('・'),
      codes: unknown,
    })
  }
  return groups
}

/** 経過時間（ミリ秒）を表す式。`cursor` より新しい点は負になる。 */
function ageExpr(cursor: number): ExpressionSpecification {
  return ['-', cursor, ['get', 'epoch_ms']] as ExpressionSpecification
}

/** 経過時間から色を作る式。窓を切らないときは素の色を返す（式にしない）。 */
export function ageColor(cursor: number, windowMs: number): ExpressionSpecification | string {
  if (windowMs <= 0) {
    // `['literal', '#ffc247']` は不正（literal は配列・オブジェクト専用）で、
    // レイヤーの paint が丸ごと無効になる。素の色文字列を返す。
    return '#ffc247'
  }
  const stops = AGE_RAMP.flatMap(([t, color]) => [t * windowMs, color])
  return ['interpolate', ['linear'], ageExpr(cursor), ...stops] as ExpressionSpecification
}

/**
 * 経過時間から不透明度を作る式。**時間の絞り込みもここでやる。**
 *
 * `setFilter` を毎フレーム差し替えるとタイルが再評価されて再生が重くなるので、
 * 窓の外は不透明度0にして消す（filter は種別の切替だけに使う）。
 */
export function ageOpacity(cursor: number, windowMs: number, base: number): ExpressionSpecification | number {
  if (windowMs <= 0) return base * 0.55
  return [
    'interpolate', ['linear'], ageExpr(cursor),
    -1, 0,                      // cursor より未来は消す
    0, base,
    windowMs * 0.6, base * 0.55,
    windowMs, base * 0.12,
    windowMs + 1, 0,            // 窓の外は消す
  ] as ExpressionSpecification
}

/**
 * 種別の絞り込みだけを行う filter。**時刻は含めない**（上記のとおり paint 側でやる）。
 * 種別のトグルは頻度が低いので、ここでタイルが再評価されても問題ない。
 */
export function typeFilter(activeTypes: Set<number>): ExpressionSpecification {
  if (activeTypes.size === 0) {
    // 全部オフ = 何も出さない
    return ['==', ['literal', 1], ['literal', 0]] as unknown as ExpressionSpecification
  }
  return ['in', ['get', 'type'], ['literal', [...activeTypes]]] as unknown as ExpressionSpecification
}

function radiusExpr(stops: Array<[number, number]>): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], ...stops.flat()] as ExpressionSpecification
}

/** 落雷レイヤー（発光3層）を追加する。 */
export function addLidenLayers(map: MLMap, url: string, layerName: string): void {
  map.addSource(SOURCE_ID, { type: 'vector', url: `pmtiles://${url}` })
  for (const s of GLOW_LAYERS) {
    map.addLayer({
      id: s.id,
      type: 'circle',
      source: SOURCE_ID,
      'source-layer': layerName,
      paint: {
        'circle-color': s.color === 'white' ? '#ffffff' : '#ffc247',
        'circle-radius': radiusExpr(s.radius),
        'circle-blur': s.blur,
        'circle-opacity': 0,
        'circle-stroke-width': 0,
      },
    })
  }
}

export function removeLidenLayers(map: MLMap): void {
  for (const s of GLOW_LAYERS) {
    if (map.getLayer(s.id)) map.removeLayer(s.id)
  }
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)
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

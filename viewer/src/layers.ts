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

/**
 * 落雷レイヤーは **2枚組（スロット）** で持つ。
 *
 * タイルは日ごとに分かれているので、通し再生では真夜中でソースを差し替える。
 * 1枚しか無いと「消す→足す→読み終わるまで空」で**一瞬落雷が消える**。
 * 表と裏を用意し、**裏で読み終わってから表を入れ替える**ことで空白を無くす。
 *
 * id は基底名 + スロット（`liden-core-a`）。スロットが違えば別レイヤーなので、
 * 2日ぶんを同時に地図へ載せておける。
 */
export type Slot = 'a' | 'b'

export const SLOTS: Slot[] = ['a', 'b']

export function sourceId(slot: Slot): string {
  return 'liden-' + slot
}

export function layerId(base: string, slot: Slot): string {
  return base + '-' + slot
}

/**
 * 発光は **3層の円を重ねて**作る。ぼかした大きい円で光をにじませ、
 * その内側にもう一枚、芯に小さくて硬い白を置く。
 * 構成は姉妹リポジトリ jartic-traffic-signal-cycle-converter の
 * `viewer/src/map/layers/signal.ts` に合わせている。
 *
 * `circle-blur` は 1 を超えてよい（2.5 で外周まで大きくにじむ）。
 * 芯だけ白にして色は外側2層に載せる。落雷は「白く光る中心＋色の暈」に見える。
 *
 * **半径は低ズーム側を持ち上げた曲線にする。** 全体を一律に何倍しても
 * 全国表示（ZL4〜5）ではほとんど変わらない（実測: 2.4倍にしても画面の
 * 明るさ合計が 2.5% しか増えない）。効くのは ZL3 側の値。
 * ただし上げすぎると暈が融合して密集部が1つの塊になり、個々の落雷が消える
 * （ZL3 で glow=14 まで上げると瀬戸内が塊になった）。
 */
export const GLOW_LAYERS: Array<{
  id: string
  radius: Array<[number, number]>
  blur: number
  /** 不透明度の基準値。経過時間の減衰にこれを掛ける */
  base: number
  color: 'age' | 'white'
}> = [
  { id: 'liden-glow', radius: [[3, 11], [7, 18], [12, 36]], blur: 2.5, base: 0.5, color: 'age' },
  { id: 'liden-mid', radius: [[3, 5.5], [7, 9], [12, 17]], blur: 1.5, base: 0.8, color: 'age' },
  { id: 'liden-core', radius: [[3, 2], [7, 3], [12, 5]], blur: 0, base: 1, color: 'white' },
]

/** 当たり判定に使う層の基底名。いちばん大きいので拾いやすい。 */
export const PICK_LAYER_BASE = 'liden-glow'
/** 件数を数える層の基底名。芯なので画面端で余分に拾わない。 */
export const COUNT_LAYER_BASE = 'liden-core'

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

/**
 * 落雷レイヤー（発光3層）を1スロットぶん追加する。
 *
 * **`circle-opacity` は 0 で入る。** 足した瞬間に見えてしまうと、裏で先読み
 * している日が表に重なる。見せるのは `refreshLayers` が塗ったときだけ。
 */
export function addLidenLayers(map: MLMap, slot: Slot, url: string, layerName: string): void {
  map.addSource(sourceId(slot), { type: 'vector', url: `pmtiles://${url}` })
  for (const s of GLOW_LAYERS) {
    map.addLayer({
      id: layerId(s.id, slot),
      type: 'circle',
      source: sourceId(slot),
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

export function removeLidenLayers(map: MLMap, slot: Slot): void {
  for (const s of GLOW_LAYERS) {
    const id = layerId(s.id, slot)
    if (map.getLayer(id)) map.removeLayer(id)
  }
  if (map.getSource(sourceId(slot))) map.removeSource(sourceId(slot))
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

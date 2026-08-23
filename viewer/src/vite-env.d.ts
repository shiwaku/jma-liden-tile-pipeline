/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** PMTiles 配置先ベース URL。未設定なら dev ミドルウェアの /pmtiles を使う。 */
  readonly VITE_PMTILES_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

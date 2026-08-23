export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'jma-liden-theme'

/**
 * 既定はダーク。**発光が主役の可視化なので OS 設定より優先する。**
 * ライトの淡色地図では白い芯が背景に溶けて、落雷が光って見えない。
 * 一度でも切り替えたら localStorage の選択を尊重する。
 */
export function initialTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY)
  return saved === 'light' || saved === 'dark' ? saved : 'dark'
}

/** <html data-theme="…"> を更新して現在テーマを保存する。 */
export function applyThemeAttr(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  localStorage.setItem(STORAGE_KEY, theme)
}

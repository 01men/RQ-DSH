/** 平台主题（WP-05/B3）：五平台差异化仅 data-platform 一个属性差。零依赖模块（避免 app.js 循环引用）。 */

export const PLATFORM_KEY = 'heng_ops_platform'

/** 启动回放记忆的平台（免闪默认色）。 */
export function replayPlatformTheme() {
  try {
    const remembered = localStorage.getItem(PLATFORM_KEY)
    if (remembered) document.documentElement.dataset.platform = remembered
  } catch { /* 忽略 */ }
}

/** 设置当前平台主题并记忆（卡片包下发 platform 后调用）。 */
export function applyPlatformTheme(platform) {
  if (!platform || typeof platform !== 'string') return
  document.documentElement.dataset.platform = platform
  try { localStorage.setItem(PLATFORM_KEY, platform) } catch { /* 忽略 */ }
}

/** 当前平台（未设置时 undefined → 服务端按 strategy 兜底）。 */
export function currentPlatform() {
  try { return document.documentElement.dataset.platform || undefined } catch { return undefined }
}

/** 资产目录过滤（WP-12 瘦身）：纯函数零依赖——selftest 直测筛选语义与性能。 */

/** 类型徽标元数据（与 assets.js TYPE_META 对齐；独立声明保持本模块零依赖）。 */
export const ASSET_TYPES = ['mcp', 'agent', 'app', 'skill', 'model', 'nas']

/**
 * 资产归属平台：显式 platform 字段优先；缺失归「未标注」（平台维度是推广期逐步补录的元数据）。
 */
export function assetPlatform(item) {
  const platform = String(item?.platform ?? '').trim()
  return platform === '' ? '未标注' : platform
}

/**
 * 目录筛选：类型 / 平台 / 关键词（名称、slug、组织、负责人子串，大小写不敏感）。
 * 约定：空条件=不过滤；返回新数组不改输入。
 */
export function filterAssets(items, { type = '', platform = '', q = '' } = {}) {
  const keyword = String(q ?? '').trim().toLowerCase()
  return (items ?? []).filter((item) => {
    if (type && item.type !== type) return false
    if (platform && assetPlatform(item) !== platform) return false
    if (keyword) {
      const haystack = `${item.name ?? ''} ${item.slug ?? ''} ${item.org ?? ''} ${item.owner ?? ''}`.toLowerCase()
      if (!haystack.includes(keyword)) return false
    }
    return true
  })
}

/** 从资产集合推导可选平台清单（按出现序，含「未标注」仅在存在未标注资产时）。 */
export function platformFacets(items) {
  const seen = []
  for (const item of items ?? []) {
    const platform = assetPlatform(item)
    if (!seen.includes(platform)) seen.push(platform)
  }
  return seen
}

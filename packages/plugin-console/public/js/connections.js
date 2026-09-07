/**
 * 宿主服务连接管理（docs/frontend-host-switching.md）：控制台默认连本机宿主，
 * 可手动配置其他宿主服务地址（如 http://192.168.0.7:7300），配置过即可一键切换，
 * 切换后整页自动刷新生效（BASE 在 api.js 模块加载时定刻，刷新是应用新连接的唯一途径）。
 *
 * 本模块保持纯函数 + 常量：所有读写经注入的 storage（localStorage 形状），
 * Node 可直接导入（selftest 经 connections.test.mjs 直测），不触碰 DOM。
 * DOM 侧（连接页 UI）在 pages/connections.js；BASE 消费方在 api.js。
 */

/** 连接清单存储键：[{ id, name, base, createdAt }]（不含内置本机连接）。 */
export const CONNECTIONS_KEY = 'heng_ops_connections'
/** 活动连接存储键：连接 id；''/缺省 = 内置本机连接。 */
export const ACTIVE_KEY = 'heng_ops_active_connection'
/** 内置本机连接 id：base 取本页部署前缀（同源），不可删除。 */
export const LOCAL_ID = 'local'

/** 地址规范化：http(s) URL、去尾斜杠、拒绝 query/hash。合法返回 { ok, base }，否则 { ok: false, error }。 */
export function normalizeBase(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return { ok: false, error: '请填写宿主服务地址' }
  if (!/^https?:\/\//i.test(value)) return { ok: false, error: '地址需以 http:// 或 https:// 开头' }
  let url
  try { url = new URL(value) } catch { return { ok: false, error: '地址格式不合法' } }
  if (url.search || url.hash) return { ok: false, error: '地址不带查询参数与 # 锚点' }
  const path = url.pathname.replace(/\/+$/, '')
  return { ok: true, base: url.origin + path }
}

/** 读取连接清单（存储损坏/形态不对时回落空清单）。 */
export function loadConnections(storage) {
  try {
    const raw = storage.getItem(CONNECTIONS_KEY)
    const list = raw ? JSON.parse(raw) : []
    if (!Array.isArray(list)) return []
    return list.filter((item) => item && typeof item.id === 'string' && typeof item.base === 'string')
  } catch { return [] }
}

export function saveConnections(storage, list) {
  storage.setItem(CONNECTIONS_KEY, JSON.stringify(list))
}

export function getActiveId(storage) {
  try { return storage.getItem(ACTIVE_KEY) || '' } catch { return '' }
}

/** 切换活动连接（只写偏好不刷新；调用方负责 location.reload() 应用）。 */
export function setActiveId(storage, id) {
  if (id === LOCAL_ID) storage.removeItem(ACTIVE_KEY)
  else storage.setItem(ACTIVE_KEY, id)
}

/**
 * 活动连接决议：本机 = { id: LOCAL_ID, name: '本机宿主服务', base: mountBase }（mountBase 为
 * 本页部署前缀 '' 或 '/rq'）；远程 = 清单内对应项，清单已删则回落本机（防悬空）。
 */
export function activeConnection(storage, mountBase = '') {
  const id = getActiveId(storage)
  if (id && id !== LOCAL_ID) {
    const found = loadConnections(storage).find((item) => item.id === id)
    if (found) return found
  }
  return { id: LOCAL_ID, name: '本机宿主服务', base: mountBase }
}

/** 新增/更新连接：base 规范化失败返回 { ok:false, error }；同名远处自动去重更新。 */
export function upsertConnection(storage, { id, name, base }) {
  const normalized = normalizeBase(base)
  if (!normalized.ok) return normalized
  const list = loadConnections(storage)
  const target = { id: id || `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: String(name ?? '').trim() || new URL(normalized.base).host, base: normalized.base, createdAt: Date.now() }
  const index = list.findIndex((item) => item.id === target.id)
  if (index >= 0) {
    target.createdAt = list[index].createdAt
    list[index] = target
  } else {
    list.push(target)
  }
  saveConnections(storage, list)
  return { ok: true, list, connection: target }
}

/** 删除连接。返回 removedActive 表示删的是活动连接（调用方需回落本机并刷新）。 */
export function removeConnection(storage, id) {
  const list = loadConnections(storage).filter((item) => item.id !== id)
  saveConnections(storage, list)
  const removedActive = id !== LOCAL_ID && getActiveId(storage) === id
  if (removedActive) setActiveId(storage, LOCAL_ID)
  return { list, removedActive }
}

/**
 * 面板 API 客户端：与 console api.js 同一套令牌存储键（同源复用控制台会话），
 * BASE 由 boot.js 传入（/rq/panel/ 挂载形态推导修正）。全部请求收口于此，
 * 页面代码零裸 fetch（RBAC 走查铁律同样适用于面板前端）。
 *
 * M2 远端连接（形态 C）：boot.js 探测到宿主连接为 remote 时调用 setRemoteProxy(true)——
 * 全部 /api/* 请求改经本机插件的远端代理（/rqcard/proxy/*）转发宿主，浏览器零跨域；
 * 令牌按连接隔离（setConnectionScope(hubBase)），本机/远端会话互不串台。
 */

export let BASE = ''

export function setBase(value) {
  BASE = value
}

/** 远端代理开关：true 时 /api/* 重写到 ${BASE}/rqcard/proxy/api/*。 */
let remoteProxy = false

export function setRemoteProxy(enabled) {
  remoteProxy = Boolean(enabled)
}

/** 连接作用域：远端连接时传 hubBase，令牌键按连接命名空间隔离（对齐 console connections.js 语义）。 */
let scope = ''

export function setConnectionScope(value) {
  scope = String(value ?? '')
}

const scopedKey = (baseKey) => (scope ? `${baseKey}@${scope}` : baseKey)

/** 请求路径重写：远端模式把 /api/* 指向本机插件的宿主代理。 */
const mapPath = (path) => (remoteProxy && path.startsWith('/api/')
  ? `${BASE}/rqcard/proxy${path}`
  : `${BASE}${path}`)

const session = {
  get token() { return localStorage.getItem(scopedKey('heng_ops_token')) ?? '' },
  get refreshToken() { return localStorage.getItem(scopedKey('heng_ops_refresh')) ?? '' },
  saveRefresh(token) { localStorage.setItem(scopedKey('heng_ops_refresh'), token) },
  get user() {
    try { return JSON.parse(localStorage.getItem(scopedKey('heng_ops_user')) ?? 'null') } catch { return null }
  },
  save(token, user) {
    localStorage.setItem(scopedKey('heng_ops_token'), token)
    localStorage.setItem(scopedKey('heng_ops_user'), JSON.stringify(user))
  },
  clear() {
    localStorage.removeItem(scopedKey('heng_ops_token'))
    localStorage.removeItem(scopedKey('heng_ops_refresh'))
    localStorage.removeItem(scopedKey('heng_ops_user'))
  },
  get permissions() { return this.user?.permissions ?? [] },
  can(point) { return this.permissions.includes('*') || this.permissions.includes(point) },
}

export { session }

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

let refreshing = null

async function tryRefresh() {
  if (!session.refreshToken) return false
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const response = await fetch(mapPath('/api/auth/refresh'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.ok === false) return false
        localStorage.setItem(scopedKey('heng_ops_token'), payload.data.token)
        localStorage.setItem(scopedKey('heng_ops_refresh'), payload.data.refreshToken)
        return true
      } catch {
        return false
      } finally {
        setTimeout(() => { refreshing = null }, 50)
      }
    })()
  }
  return refreshing
}

async function request(method, path, body, retried = false) {
  const headers = { 'content-type': 'application/json' }
  if (session.token) headers.authorization = `Bearer ${session.token}`
  const response = await fetch(mapPath(path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try { payload = await response.json() } catch { /* non-json */ }
  if (response.status === 401 && !retried && await tryRefresh()) {
    return request(method, path, body, true)
  }
  if (!response.ok || payload?.ok === false) {
    const err = payload?.error ?? {}
    throw new ApiError(err.code ?? `HTTP_${response.status}`, err.message ?? `请求失败（${response.status}）`, response.status)
  }
  return payload?.data
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  put: (path, body = {}) => request('PUT', path, body),
  patch: (path, body = {}) => request('PATCH', path, body),
  delete: (path, body) => request('DELETE', path, body),
}

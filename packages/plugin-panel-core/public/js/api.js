/**
 * 面板 API 客户端：与 console api.js 同一套令牌存储键（同源复用控制台会话），
 * BASE 由 boot.js 传入（/rq/panel/ 挂载形态推导修正）。全部请求收口于此，
 * 页面代码零裸 fetch（RBAC 走查铁律同样适用于面板前端）。
 */
export let BASE = ''

export function setBase(value) {
  BASE = value
}

const TOKEN_KEY = 'heng_ops_token'
const REFRESH_KEY = 'heng_ops_refresh'
const USER_KEY = 'heng_ops_user'

export const session = {
  get token() { return localStorage.getItem(TOKEN_KEY) ?? '' },
  get refreshToken() { return localStorage.getItem(REFRESH_KEY) ?? '' },
  saveRefresh(token) { localStorage.setItem(REFRESH_KEY, token) },
  get user() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) ?? 'null') } catch { return null }
  },
  save(token, user) {
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.setItem(USER_KEY, JSON.stringify(user))
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(REFRESH_KEY)
    localStorage.removeItem(USER_KEY)
  },
  get permissions() { return this.user?.permissions ?? [] },
  can(point) { return this.permissions.includes('*') || this.permissions.includes(point) },
}

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
        const response = await fetch(`${BASE}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.ok === false) return false
        localStorage.setItem(TOKEN_KEY, payload.data.token)
        localStorage.setItem(REFRESH_KEY, payload.data.refreshToken)
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
  const response = await fetch(`${BASE}${path}`, {
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

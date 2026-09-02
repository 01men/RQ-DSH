/** API 客户端：令牌管理 + 统一请求封装。 */

const TOKEN_KEY = 'heng_ops_token'
const REFRESH_KEY = 'heng_ops_refresh'
const USER_KEY = 'heng_ops_user'

/**
 * 部署前缀：独立形态（根路径部署）为 ''；dsh 宿主挂载形态下页面位于 /rq/ 之下，
 * 由文档地址自动推导（SPA 全程 hash 路由，document URL 恒为目录形态）。
 */
export const BASE = new URL('.', document.baseURI).pathname.replace(/\/$/, '')

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
  constructor(code, message, status, extra) {
    super(message)
    this.code = code
    this.status = status
    this.extra = extra
  }
}

let refreshing = null

/** access token 过期时静默续期（refresh 轮转链），失败才回落登录页。 */
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
  if (response.status === 401 && !retried && !PUBLIC_TOKEN_PATHS.has(path) && await tryRefresh()) {
    return request(method, path, body, true)
  }
  if (!response.ok || payload?.ok === false) {
    const err = payload?.error ?? {}
    if (response.status === 401 && !path.startsWith('/api/auth/') && !location.hash.startsWith('#/oauth')) {
      session.clear()
      if (!location.hash.startsWith('#/login')) location.hash = '#/login'
    }
    throw new ApiError(err.code ?? 'HTTP_' + response.status, err.message ?? `请求失败（${response.status}）`, response.status, err)
  }
  return payload?.data
}

const PUBLIC_TOKEN_PATHS = new Set(['/api/auth/login', '/api/auth/refresh', '/api/auth/sso', '/api/auth/sso/authorize', '/api/auth/sso/bind', '/api/auth/sso/register', '/api/auth/client-credentials', '/api/auth/entry-ticket-session'])

/**
 * 票据免登：一次性入场票据 → 控制台会话（门户/钉钉「打开即工作台」）。
 * 票据只进请求体与内存：调用方须先从 URL 取出并立即清除参数，不得常驻地址栏或写入 localStorage。
 */
export async function entryTicketSession(ticket) {
  const response = await fetch(`${BASE}/api/auth/entry-ticket-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket }),
  })
  let payload = null
  try { payload = await response.json() } catch { /* non-json */ }
  if (!response.ok || payload?.ok === false) {
    const err = payload?.error ?? {}
    throw new ApiError(err.code ?? 'HTTP_' + response.status, err.message ?? `票据兑换失败（${response.status}）`, response.status, err)
  }
  const result = payload.data
  session.clear()
  session.save(result.token, result.user)
  if (result.refreshToken) session.saveRefresh(result.refreshToken)
  return result.user
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  put: (path, body = {}) => request('PUT', path, body),
  patch: (path, body = {}) => request('PATCH', path, body),
  delete: (path, body) => request('DELETE', path, body),
  qs(params) {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
    }
    const str = search.toString()
    return str ? `?${str}` : ''
  },
}

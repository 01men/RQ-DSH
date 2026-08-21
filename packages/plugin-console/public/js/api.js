/** API 客户端：令牌管理 + 统一请求封装。 */

const TOKEN_KEY = 'heng_ops_token'
const USER_KEY = 'heng_ops_user'

export const session = {
  get token() { return localStorage.getItem(TOKEN_KEY) ?? '' },
  get user() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) ?? 'null') } catch { return null }
  },
  save(token, user) {
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.setItem(USER_KEY, JSON.stringify(user))
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY)
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

async function request(method, path, body) {
  const headers = { 'content-type': 'application/json' }
  if (session.token) headers.authorization = `Bearer ${session.token}`
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try { payload = await response.json() } catch { /* non-json */ }
  if (!response.ok || payload?.ok === false) {
    const err = payload?.error ?? {}
    if (response.status === 401 && !path.startsWith('/api/auth/login')) {
      session.clear()
      if (!location.hash.startsWith('#/login')) location.hash = '#/login'
    }
    throw new ApiError(err.code ?? 'HTTP_' + response.status, err.message ?? `请求失败（${response.status}）`, response.status, err)
  }
  return payload?.data
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

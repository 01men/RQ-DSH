/**
 * @dsh-ops/plugin-console —— 管理控制台接入插件。
 *
 * 职责：
 *   - REST API 网关：统一 Bearer 鉴权（authn）、权限点校验（RBAC）、审计埋点
 *   - 静态托管管理控制台 SPA（public/，飞书级交互）
 *   - 工具桥：POST /api/tools/execute 让 CLI/外部系统以同一套工具契约调用平台
 *   - 首次启动种子数据（演示环境）
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { HttpExchange } from '../../platform-core/src/index.ts'
import { createPluginContext, platformVersionInfo } from '../../platform-core/src/index.ts'
import { PermissionCatalog } from '../../plugin-iam/src/index.ts'
import { seedAll } from './seed.ts'

export const name = 'console'
export const inject = [
  'httpServer', 'opsStorage', 'platformBus', 'tools',
  'iam', 'authn', 'oidc', 'audit', 'usage', 'billing', 'market', 'modelGateway',
  'mcpRegistry', 'nasRegistry', 'skillHub', 'resourceCore', 'agentRegistry', 'appRegistry', 'update',
]

interface CallerInfo {
  kind: 'human' | 'machine'
  principalId: string
  userId?: string
  name: string
  permissions: string[]
  actChain: Array<{ name: string; type: string }>
}

const PUBLIC_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/sso',
  '/api/auth/sso/authorize',
  '/api/auth/sso/bind',
  '/api/auth/sso/register',
  '/api/auth/refresh',
  '/api/auth/client-credentials',
  '/api/auth/providers',
  '/api/health',
  '/api/market/developers/register',
  '/api/market/developers/login',
  // 接入码本身即凭证（一次性 + TTL + 按 IP 失败锁定），enroll 端点公开
  '/api/connect/enroll',
])

/** 动态路径的公开前缀（OIDC 授权页查询：仅回显客户端名/scope，不泄露 redirect_uri）。 */
const PUBLIC_PATH_PREFIXES = ['/api/authn/oidc/auth-requests/']

/** 从请求头推导对外基址（钉钉等真实 IdP 的 redirect_uri 需绝对 URL；反代场景优先 x-forwarded-*）。 */
function requestOrigin(exchange: HttpExchange): string | undefined {
  const header = (name: string): string | undefined => {
    const value = exchange.headers[name]
    if (value === undefined) return undefined
    return String(Array.isArray(value) ? value[0] : value)
  }
  const host = header('x-forwarded-host') ?? header('host')
  if (!host) return undefined
  const proto = header('x-forwarded-proto') ?? 'http'
  return `${proto}://${host}`
}

/** 服务记录对外回显时脱敏认证类请求头（存储保留原文，仅展示层掩码）。 */
function maskServiceHeaders<T extends { headers?: Record<string, string> }>(service: T): T {
  if (!service.headers) return service
  const masked: Record<string, string> = {}
  for (const [key, value] of Object.entries(service.headers)) {
    masked[key] = /authorization|token|secret|key/i.test(key)
      ? (value.length > 8 ? `${value.slice(0, 6)}…` : '****')
      : value
  }
  return { ...service, headers: masked }
}

/** NAS 资产回显时脱敏网关访问令牌（存储保留原文，仅展示层掩码）。 */
function maskNasEntity<T extends { attrs?: Record<string, unknown> }>(nas: T): T {
  if (!nas.attrs || nas.attrs['accessToken'] === undefined) return nas
  const token = String(nas.attrs['accessToken'])
  return { ...nas, attrs: { ...nas.attrs, accessToken: token.length > 8 ? `${token.slice(0, 6)}…` : '****' } }
}

interface NasImportEntry {
  name: string
  url: string
  token: string
  nasIp: string
  error?: string
}

/**
 * 解析面向 NAS 纳管的 mcpServers JSON（synology-filestation-mcp 形态）：
 * url + headers.Authorization（Bearer 令牌）+ headers["X-NAS-IP"]（设备路由）。
 * 与 plugin-mcp 的通用导入不同，此处要求认证头与设备路由头齐备（NAS 域契约）。
 */
function parseNasMcpServersConfig(raw: string | object): NasImportEntry[] {
  let config: unknown
  if (typeof raw === 'string') {
    try {
      config = JSON.parse(raw)
    } catch {
      throw new Error('配置不是合法 JSON，请粘贴完整的 mcpServers 配置文本')
    }
  } else {
    config = raw
  }
  const obj = config && typeof config === 'object' && !Array.isArray(config) ? config as Record<string, unknown> : null
  if (!obj) throw new Error('配置须为 JSON 对象')
  const map = (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)
    ? obj.mcpServers
    : obj) as Record<string, unknown>
  const entries = Object.entries(map).filter(([, value]) => value && typeof value === 'object')
  if (entries.length === 0) throw new Error('未识别出任何服务条目：需要 {"mcpServers": {"名称": {"url": "…", "headers": {"Authorization": "Bearer …", "X-NAS-IP": "…"}}}}')
  return entries.map(([name, server]) => {
    const record = server as Record<string, unknown>
    const headers = (record.headers && typeof record.headers === 'object' ? record.headers : {}) as Record<string, string>
    const authHeader = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1] ?? ''
    const nasIp = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-nas-ip')?.[1] ?? ''
    const url = typeof record.url === 'string' ? record.url.trim() : ''
    const base = { name, url, token: authHeader.replace(/^Bearer\s+/i, '').trim(), nasIp: String(nasIp).trim() }
    if (!url) return { ...base, error: '缺少 url 字段' }
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ...base, error: `仅支持 http(s) 地址，收到 ${parsed.protocol}` }
    } catch {
      return { ...base, error: `url 不是合法地址：${url}` }
    }
    if (!base.token) return { ...base, error: '缺少 headers.Authorization（Bearer 网关令牌）' }
    if (!base.nasIp) return { ...base, error: '缺少 headers["X-NAS-IP"]（NAS 设备路由）' }
    return base
  })
}

export function apply(ctx: Context) {
  const http = ctx.httpServer

  // -- 鉴权中间件 ---------------------------------------------------------
  http.use((exchange) => {
    if (!exchange.path.startsWith('/api/') || PUBLIC_PATHS.has(exchange.path) || PUBLIC_PATH_PREFIXES.some((prefix) => exchange.path.startsWith(prefix))) return
    const header = String(exchange.headers['authorization'] ?? '')
    if (!header.startsWith('Bearer ')) {
      exchange.fail(401, 'UNAUTHORIZED', '缺少 Bearer 令牌，请先登录')
      return true
    }
    try {
      const verified = ctx.authn.verify(header.slice(7))
      exchange.principal = {
        kind: verified.principal.type,
        principalId: verified.principal.id,
        ...(verified.principal.type === 'human' && verified.principal.refId ? { userId: verified.principal.refId } : {}),
        name: verified.principal.name,
        permissions: verified.scopes,
        actChain: verified.actChain,
      } satisfies CallerInfo
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(401, 'TOKEN_INVALID', message)
      return true
    }
  })

  const caller = (exchange: HttpExchange): CallerInfo => exchange.principal as CallerInfo

  const requirePermission = (exchange: HttpExchange, point: string): boolean => {
    const info = caller(exchange)
    if (info.permissions.includes('*') || info.permissions.includes(point)) return true
    ctx.platformBus.emit('audit.authz.denied', {
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      point,
      path: exchange.path,
    })
    exchange.fail(403, 'FORBIDDEN', `缺少权限点 ${point}，请联系管理员调整角色`, { permission: point })
    return false
  }

  /** 注册一条受权限保护的路由。 */
  const guarded = (method: string, path: string, permission: string, handler: (exchange: HttpExchange) => unknown | Promise<unknown>): void => {
    http.register(method, path, async (exchange) => {
      if (!requirePermission(exchange, permission)) return
      try {
        const result = await handler(exchange)
        if (!exchange.res.writableEnded) exchange.ok(result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        exchange.fail(400, 'BAD_REQUEST', message)
      }
    })
  }

  const body = <T extends Record<string, any>>(exchange: HttpExchange): T => (exchange.body ?? {}) as T
  const changeLog = (exchange: HttpExchange, action: string, resourceType: string, resourceId: string, resourceName: string, detail = ''): void => {
    const info = caller(exchange)
    ctx.audit.record({
      type: 'change',
      actorType: info.kind === 'human' ? 'human' : 'machine',
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      action,
      resourceType,
      resourceId,
      resourceName,
      result: 'ok',
      detail,
      ...(info.actChain.length > 0 ? { actChain: info.actChain } : {}),
    })
  }

  // -- 健康 ---------------------------------------------------------------
  http.register('GET', '/api/health', (exchange) => {
    exchange.ok({ status: 'ok', time: new Date().toISOString() })
  })

  // -- 三方登录可用性（公开：登录页按配置显隐三方登录入口） ----------------------
  http.register('GET', '/api/auth/providers', (exchange) => {
    const providers = ctx.iam.connectorConfigs().all()
      .filter((config) => config.enabled && config.loginEnabled)
      .map((config) => ({ provider: config.provider, corpId: config.corpId }))
    exchange.ok({ providers })
  })

  // -- 认证 ---------------------------------------------------------------
  http.register('POST', '/api/auth/login', async (exchange) => {
    const { username, password } = body<{ username: string; password: string }>(exchange)
    if (!username || !password) {
      exchange.fail(400, 'BAD_REQUEST', '用户名与密码必填')
      return
    }
    try {
      const result = ctx.authn.login(username, password)
      const user = ctx.iam.users().get(result.userId)!
      exchange.ok({
        token: result.token,
        refreshToken: result.refreshToken,
        expiresAt: result.record.expiresAt,
        user: {
          id: user.id, username: user.username, displayName: user.displayName,
          orgId: user.orgId, roleIds: user.roleIds,
          roles: user.roleIds.map((roleId) => ctx.iam.roles().get(roleId)?.name).filter(Boolean),
          permissions: ctx.iam.userPermissions(user.id),
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(401, 'LOGIN_FAILED', message)
    }
  })

  // -- 三方登录（IdentityProviderAdapter 链路） ------------------------------
  http.register('POST', '/api/auth/sso/authorize', async (exchange) => {
    const { provider, scene } = body<{ provider: string; scene?: 'web_qr' | 'h5' | 'in_app' }>(exchange)
    try {
      exchange.ok(await ctx.authn.beginSso(provider ?? 'dingtalk', scene ?? 'web_qr', requestOrigin(exchange)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(400, 'SSO_AUTHORIZE_FAILED', message)
    }
  })

  http.register('POST', '/api/auth/sso', async (exchange) => {
    const { provider, code, state } = body<{ provider: string; code: string; state: string }>(exchange)
    if (!code || !state) {
      exchange.fail(400, 'BAD_REQUEST', 'code 与 state 必填（先调 /api/auth/sso/authorize 获取 state）')
      return
    }
    try {
      const result = await ctx.authn.completeSso(provider ?? 'dingtalk', code, state)
      if (result.kind === 'pending') {
        exchange.ok({ kind: 'pending', pendingTicket: result.pendingTicket, profileName: result.profileName })
        return
      }
      const user = ctx.iam.users().get(result.userId)!
      exchange.ok({
        kind: 'hit',
        token: result.session.token,
        refreshToken: result.session.refreshToken,
        expiresAt: result.session.access.expiresAt,
        user: {
          id: user.id, username: user.username, displayName: user.displayName,
          orgId: user.orgId, roleIds: user.roleIds,
          roles: user.roleIds.map((roleId) => ctx.iam.roles().get(roleId)?.name).filter(Boolean),
          permissions: ctx.iam.userPermissions(user.id),
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(401, 'SSO_FAILED', message)
    }
  })

  http.register('POST', '/api/auth/sso/bind', async (exchange) => {
    const { pendingTicket, username, password } = body<{ pendingTicket: string; username: string; password: string }>(exchange)
    try {
      const result = ctx.authn.ssoBindExisting(pendingTicket, username, password)
      const user = ctx.iam.users().get(result.userId)!
      exchange.ok({
        token: result.session.token,
        refreshToken: result.session.refreshToken,
        expiresAt: result.session.access.expiresAt,
        user: {
          id: user.id, username: user.username, displayName: user.displayName,
          orgId: user.orgId, roleIds: user.roleIds,
          roles: user.roleIds.map((roleId) => ctx.iam.roles().get(roleId)?.name).filter(Boolean),
          permissions: ctx.iam.userPermissions(user.id),
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(401, 'SSO_BIND_FAILED', message)
    }
  })

  http.register('POST', '/api/auth/sso/register', async (exchange) => {
    const { pendingTicket } = body<{ pendingTicket: string }>(exchange)
    try {
      const result = ctx.authn.ssoRegister(pendingTicket)
      const user = ctx.iam.users().get(result.userId)!
      exchange.ok({
        token: result.session.token,
        refreshToken: result.session.refreshToken,
        expiresAt: result.session.access.expiresAt,
        user: {
          id: user.id, username: user.username, displayName: user.displayName,
          orgId: user.orgId, roleIds: user.roleIds,
          roles: user.roleIds.map((roleId) => ctx.iam.roles().get(roleId)?.name).filter(Boolean),
          permissions: ctx.iam.userPermissions(user.id),
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(401, 'SSO_REGISTER_FAILED', message)
    }
  })

  http.register('POST', '/api/auth/refresh', async (exchange) => {
    const { refreshToken } = body<{ refreshToken: string }>(exchange)
    if (!refreshToken) {
      exchange.fail(400, 'BAD_REQUEST', 'refreshToken 必填')
      return
    }
    try {
      const result = ctx.authn.refreshSession(refreshToken)
      exchange.ok({ token: result.token, refreshToken: result.refreshToken })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(401, 'REFRESH_FAILED', message)
    }
  })

  http.register('POST', '/api/auth/client-credentials', async (exchange) => {
    const { clientId, clientSecret } = body<{ clientId: string; clientSecret: string }>(exchange)
    try {
      const result = ctx.authn.clientCredentialsLogin(clientId, clientSecret)
      exchange.ok({ token: result.token, expiresAt: result.record.expiresAt, principal: { id: result.principal.id, name: result.principal.name, scopes: result.principal.scopes } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(401, 'CC_FAILED', message)
    }
  })

  http.register('GET', '/api/auth/me', (exchange) => {
    const info = caller(exchange)
    exchange.ok({
      kind: info.kind,
      principalId: info.principalId,
      ...(info.userId !== undefined ? { userId: info.userId } : {}),
      name: info.name,
      permissions: info.permissions,
      actChain: info.actChain,
    })
  })

  http.register('POST', '/api/auth/logout', async (exchange) => {
    const header = String(exchange.headers['authorization'] ?? '')
    const token = header.slice(7)
    const refreshToken = body<{ refreshToken?: string }>(exchange).refreshToken
    try {
      const verified = ctx.authn.verify(token)
      if (verified.token.sid) {
        ctx.authn.revokeSession(verified.token.sid, '用户主动登出')
      } else {
        ctx.authn.revokeToken(verified.token.jti, '用户主动登出')
      }
    } catch { /* 令牌已失效也允许登出 */ }
    if (refreshToken) {
      try { ctx.authn.refreshSession(refreshToken) } catch { /* 已失效 */ }
    }
    // 吊销强持久化后再响应：返回 200 后进程被杀，吊销状态不丢失（评审崩溃恢复实验）
    await ctx.opsStorage.flushDurable()
    exchange.ok()
  })

  // -- 总览（工作台）-------------------------------------------------------
  guarded('GET', '/api/overview', 'console.login', () => {
    const pendingApprovals = ctx.audit.approvals().find((item) => item.status === 'pending')
    const unreadAlerts = ctx.audit.alerts().find((item) => !item.read)
    const recentEvents = ctx.platformBus.recent(20).map((event) => ({
      name: event.name, at: event.at, payload: summarize(event.payload),
    }))
    const costTrend = ctx.audit.costReport('date').sort((a, b) => a.key.localeCompare(b.key)).slice(-14)
    return {
      iam: { users: ctx.iam.users().count(), orgs: ctx.iam.orgs().count(), pendingUsers: ctx.iam.users().find((user) => user.status === 'pending').length },
      mcp: ctx.mcpRegistry.metricsOverview(),
      agents: ctx.agentRegistry.overview(),
      apps: ctx.appRegistry.overview(),
      skills: {
        total: ctx.skillHub.skills().count(),
        published: ctx.skillHub.skills().find((item) => item.status === 'published').length,
        pendingApproval: ctx.skillHub.skills().find((item) => item.status === 'pending_approval').length,
      },
      approvals: { pending: pendingApprovals.length, items: pendingApprovals.slice(0, 5) },
      alerts: { unread: unreadAlerts.length, critical: unreadAlerts.filter((item) => item.severity === 'critical').length },
      audit: ctx.audit.summary(),
      recentEvents,
      costTrend,
      conflicts: ctx.iam.conflicts().find((item) => item.status === 'pending').length,
    }
  })

  // -- 资产运营：统一台账 / 健康巡检 / 成本报表（企业 AI 资产运营管理） --------
  guarded('GET', '/api/assets/inventory', 'usage.read', (exchange) => {
    const days = Math.min(Math.max(Number(exchange.query.get('days') ?? 30) || 30, 1), 90)
    const fromIso = new Date(Date.now() - days * 86_400_000).toISOString()
    const usageByResource = new Map(ctx.usage.breakdown(fromIso).byResource.map((row) => [row.resource, row]))
    const orgName = (orgId: string) => ctx.iam.orgs().get(orgId)?.name ?? orgId
    const usageOf = (resource: string | undefined) => {
      if (!resource) return { calls: 0, chargeCents: 0 }
      const row = usageByResource.get(resource)
      return { calls: row?.count ?? 0, chargeCents: row?.charge_cents ?? 0 }
    }
    const items = [
      ...ctx.mcpRegistry.services().all().map((service) => ({
        type: 'mcp' as const,
        id: service.id,
        name: service.name,
        slug: service.slug,
        status: service.status,
        health: service.health.status,
        exec: service.exec,
        version: service.currentVersion,
        org: orgName(service.orgId),
        owner: service.owner,
        updatedAt: service.updatedAt,
        ...usageOf(`mcp:${service.slug}`),
      })),
      ...ctx.nasRegistry.list().map((nas) => ({
        type: 'nas' as const,
        id: nas.id,
        name: nas.name,
        slug: nas.slug,
        status: nas.status,
        health: ctx.nasRegistry.healthOf(nas.id).status,
        org: orgName(nas.orgId),
        owner: nas.ownerId,
        updatedAt: nas.updatedAt,
        calls: 0,
        chargeCents: 0,
      })),
      ...ctx.resourceCore.list('agent').map((agent) => ({
        type: 'agent' as const,
        id: agent.id,
        name: agent.name,
        slug: agent.slug,
        status: agent.status,
        health: agent.status === 'online' ? 'healthy' : 'unknown',
        org: orgName(agent.orgId),
        owner: agent.ownerId,
        updatedAt: agent.updatedAt,
        ...usageOf(undefined),
      })),
      ...ctx.resourceCore.list('app').map((app) => ({
        type: 'app' as const,
        id: app.id,
        name: app.name,
        slug: app.slug,
        status: app.status,
        health: app.status === 'online' ? 'healthy' : 'unknown',
        org: orgName(app.orgId),
        owner: app.ownerId,
        updatedAt: app.updatedAt,
        ...usageOf(`app:${app.slug}`),
      })),
      ...ctx.skillHub.skills().all().map((skill) => ({
        type: 'skill' as const,
        id: skill.id,
        name: skill.name,
        slug: skill.slug,
        status: skill.status,
        health: 'unknown',
        org: orgName(skill.orgId),
        owner: skill.authorName,
        updatedAt: skill.updatedAt,
        calls: skill.stats?.installs ?? 0,
        chargeCents: 0,
      })),
      ...ctx.modelGateway.models().all().map((model) => ({
        type: 'model' as const,
        id: model.id,
        name: model.displayName,
        slug: model.slug,
        status: model.status,
        health: model.status === 'online' ? (model.endpoint ? 'healthy' : 'down') : 'unknown',
        org: '平台自营',
        owner: model.provider,
        updatedAt: model.updatedAt,
        ...usageOf(`model:${model.slug}`),
      })),
    ]
    const type = exchange.query.get('type')
    const status = exchange.query.get('status')
    const q = exchange.query.get('q')
    const filtered = items.filter((item) => {
      if (type && item.type !== type) return false
      if (status && item.status !== status) return false
      if (q && !`${item.name}${item.slug}${item.org}${item.owner}`.toLowerCase().includes(q.toLowerCase())) return false
      return true
    }).sort((a, b) => b.chargeCents - a.chargeCents || a.name.localeCompare(b.name))
    const byType: Record<string, { total: number; inService: number }> = {}
    for (const item of items) {
      const bucket = byType[item.type] ?? { total: 0, inService: 0 }
      bucket.total++
      if (['online', 'gray', 'published'].includes(item.status)) bucket.inService++
      byType[item.type] = bucket
    }
    return {
      days,
      total: filtered.length,
      summary: {
        byType,
        unhealthy: items.filter((item) => item.health === 'down' || item.health === 'degraded').length,
        chargeCents30d: items.reduce((sum, item) => sum + item.chargeCents, 0),
      },
      items: filtered,
    }
  })

  guarded('POST', '/api/assets/healthcheck', 'mcp.service.read', async (exchange) => {
    const info = caller(exchange)
    const checked: Array<{ type: string; id: string; name: string; status: string; latencyMs: number }> = []
    for (const service of ctx.mcpRegistry.services().all()) {
      if (!['online', 'gray', 'unhealthy'].includes(service.status)) continue
      const result = await ctx.mcpRegistry.probeService(service.id)
      checked.push({ type: 'mcp', id: service.id, name: service.name, status: result.status, latencyMs: result.latencyMs })
    }
    for (const nas of ctx.nasRegistry.list()) {
      if (!['online'].includes(nas.status)) continue
      const result = await ctx.nasRegistry.probe(nas.id)
      checked.push({ type: 'nas', id: nas.id, name: nas.name, status: result.status, latencyMs: result.latencyMs })
    }
    for (const entity of [...ctx.resourceCore.list('agent'), ...ctx.resourceCore.list('app')]) {
      checked.push({ type: entity.type, id: entity.id, name: entity.name, status: entity.status, latencyMs: 0 })
    }
    for (const model of ctx.modelGateway.models().all()) {
      checked.push({ type: 'model', id: model.id, name: model.displayName, status: model.status, latencyMs: 0 })
    }
    const abnormal = checked.filter((item) => item.status === 'down' || item.status === 'degraded' || item.status === 'unhealthy' || item.status === 'offline')
    changeLog(exchange, 'assets.healthcheck', 'asset', 'batch', '健康巡检', `巡检 ${checked.length} 项，异常 ${abnormal.length} 项`)
    return {
      checkedAt: new Date().toISOString(),
      checked: checked.length,
      abnormal: abnormal.length,
      items: checked,
      abnormalItems: abnormal,
    }
  })

  guarded('GET', '/api/assets/report', 'usage.read', (exchange) => {
    const days = Math.min(Math.max(Number(exchange.query.get('days') ?? 30) || 30, 1), 90)
    const fromIso = new Date(Date.now() - days * 86_400_000).toISOString()
    const { byResource, byPrincipal, byDay } = ctx.usage.breakdown(fromIso)
    const labelOfResource = (resource: string) => {
      const [kind, key] = [resource.slice(0, resource.indexOf(':')), resource.slice(resource.indexOf(':') + 1)]
      if (kind === 'mcp') return ctx.mcpRegistry.services().findOne((item) => item.slug === key)?.name ?? resource
      if (kind === 'model') return ctx.modelGateway.models().findOne((item) => item.slug === key)?.displayName ?? resource
      return resource
    }
    const labelOfPrincipal = (principal: string) => {
      if (principal.startsWith('org:')) return ctx.iam.orgs().get(principal.slice(4))?.name ?? principal
      return principal
    }
    return {
      days,
      totals: ctx.usage.totals({ from: fromIso }),
      topResources: byResource.slice(0, 20).map((row) => ({ ...row, label: labelOfResource(row.resource) })),
      byPrincipal: byPrincipal.map((row) => ({ ...row, label: labelOfPrincipal(row.principal) })),
      byDay,
    }
  })

  // -- IAM ----------------------------------------------------------------
  guarded('GET', '/api/iam/orgs/tree', 'iam.org.read', () => ctx.iam.orgTree())

  guarded('GET', '/api/iam/orgs', 'iam.org.read', () => ctx.iam.orgs().all())

  guarded('POST', '/api/iam/orgs', 'iam.org.write', (exchange) => {
    const input = body<{ name: string; parentId?: string | null; order?: number }>(exchange)
    const org = ctx.iam.createOrg(input)
    changeLog(exchange, 'iam.org.create', 'org', org.id, org.name)
    return org
  })

  guarded('PATCH', '/api/iam/orgs/:id', 'iam.org.write', (exchange) => {
    const input = body<{ name?: string; parentId?: string | null }>(exchange)
    if (input.name) {
      const org = ctx.iam.renameOrg(exchange.params['id']!, input.name)
      changeLog(exchange, 'iam.org.rename', 'org', org.id, org.name)
    }
    if (input.parentId !== undefined) {
      ctx.iam.moveOrg(exchange.params['id']!, input.parentId)
      changeLog(exchange, 'iam.org.move', 'org', exchange.params['id']!, input.parentId)
    }
    return ctx.iam.orgs().get(exchange.params['id']!)
  })

  guarded('DELETE', '/api/iam/orgs/:id', 'iam.org.write', (exchange) => {
    ctx.iam.deleteOrg(exchange.params['id']!)
    changeLog(exchange, 'iam.org.delete', 'org', exchange.params['id']!, '')
    return { deleted: true }
  })

  guarded('GET', '/api/iam/users', 'iam.user.read', (exchange) => {
    const orgId = exchange.query.get('orgId') ?? undefined
    const status = exchange.query.get('status') ?? undefined
    const q = exchange.query.get('q') ?? undefined
    const orgScope = orgId ? new Set(ctx.iam.orgSubtreeIds(orgId)) : undefined
    const users = ctx.iam.users().find((user) => {
      if (status && user.status !== status) return false
      if (orgScope && !orgScope.has(user.orgId)) return false
      if (q && !`${user.displayName}${user.username}${user.email}`.toLowerCase().includes(q.toLowerCase())) return false
      return true
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return {
      total: users.length,
      users: users.map((user) => decorateUser(ctx, user)),
    }
  })

  guarded('POST', '/api/iam/users', 'iam.user.write', (exchange) => {
    const input = body<{ username: string; displayName: string; orgId: string; title?: string; email?: string; phone?: string; roleIds?: string[]; password?: string }>(exchange)
    const { user, initialPassword } = ctx.iam.createUser(input)
    if (input.roleIds?.length) ctx.iam.assignRoles(user.id, input.roleIds)
    ctx.iam.activateUser(user.id)
    changeLog(exchange, 'iam.user.create', 'user', user.id, user.displayName)
    return { ...decorateUser(ctx, ctx.iam.users().get(user.id)!), ...(initialPassword ? { initialPassword } : {}) }
  })

  guarded('POST', '/api/iam/users/:id/reset-password', 'iam.user.write', (exchange) => {
    const { password } = body<{ password?: string }>(exchange)
    const { user, initialPassword } = ctx.iam.resetPassword(exchange.params['id']!, password)
    changeLog(exchange, 'iam.user.reset_password', 'user', user.id, user.displayName, password ? '设置为指定口令' : '重置为随机初始口令')
    return { id: user.id, username: user.username, initialPassword }
  })

  guarded('POST', '/api/iam/users/import', 'iam.user.write', (exchange) => {
    const { items } = body<{ items: Array<{ username: string; displayName: string; orgId: string; title?: string }> }>(exchange)
    const result = ctx.iam.importUsers(items ?? [])
    changeLog(exchange, 'iam.user.import', 'user', '', '', `新建 ${result.created.length}，跳过 ${result.skipped.length}`)
    return { created: result.created.map((user) => decorateUser(ctx, user)), skipped: result.skipped }
  })

  guarded('PATCH', '/api/iam/users/:id', 'iam.user.write', (exchange) => {
    const input = body<{ displayName?: string; email?: string; phone?: string; title?: string; orgId?: string; roleIds?: string[] }>(exchange)
    const { roleIds, ...patch } = input
    const user = ctx.iam.updateUser(exchange.params['id']!, patch)
    if (roleIds) ctx.iam.assignRoles(user.id, roleIds)
    changeLog(exchange, 'iam.user.update', 'user', user.id, user.displayName)
    return decorateUser(ctx, ctx.iam.users().get(user.id)!)
  })

  for (const [action, permission] of [
    ['activate', 'iam.user.write'],
    ['freeze', 'iam.user.freeze'],
    ['unfreeze', 'iam.user.freeze'],
    ['deactivate', 'iam.user.freeze'],
  ] as const) {
    guarded('POST', `/api/iam/users/:id/${action}`, permission, (exchange) => {
      const { reason } = body<{ reason?: string }>(exchange)
      const id = exchange.params['id']!
      const user = action === 'activate' ? ctx.iam.activateUser(id)
        : action === 'freeze' ? ctx.iam.freezeUser(id, reason ?? '')
          : action === 'unfreeze' ? ctx.iam.unfreezeUser(id)
            : ctx.iam.deactivateUser(id, reason ?? '')
      changeLog(exchange, `iam.user.${action}`, 'user', user.id, user.displayName, reason ?? '')
      return decorateUser(ctx, user)
    })
  }

  guarded('POST', '/api/iam/users/:id/bindings', 'iam.user.write', (exchange) => {
    const input = body<{ provider: 'dingtalk' | 'feishu' | 'wecom'; unionId: string; displayName?: string; verifyCode?: string }>(exchange)
    const user = ctx.iam.bindThirdParty(exchange.params['id']!, { ...input, displayName: input.displayName ?? input.unionId })
    changeLog(exchange, 'iam.user.bind', 'user', user.id, user.displayName, input.provider)
    return decorateUser(ctx, user)
  })

  guarded('DELETE', '/api/iam/users/:id/bindings/:provider', 'iam.user.write', (exchange) => {
    const { verifyCode } = body<{ verifyCode: string }>(exchange)
    const user = ctx.iam.unbindThirdParty(exchange.params['id']!, exchange.params['provider']! as 'dingtalk', verifyCode)
    changeLog(exchange, 'iam.user.unbind', 'user', user.id, user.displayName, exchange.params['provider'])
    return decorateUser(ctx, user)
  })

  guarded('GET', '/api/iam/roles', 'iam.org.read', () => ({
    roles: ctx.iam.roles().all(),
    catalog: PermissionCatalog,
  }))

  guarded('GET', '/api/iam/permissions', 'iam.org.read', () => {
    return { catalog: PermissionCatalog }
  })

  guarded('POST', '/api/iam/roles', 'iam.role.write', (exchange) => {
    const input = body<{ code: string; name: string; description?: string; permissions: string[] }>(exchange)
    const role = ctx.iam.createRole(input)
    changeLog(exchange, 'iam.role.create', 'role', role.id, role.name)
    return role
  })

  guarded('PATCH', '/api/iam/roles/:id', 'iam.role.write', (exchange) => {
    const input = body<{ name?: string; description?: string; permissions?: string[] }>(exchange)
    const role = ctx.iam.updateRole(exchange.params['id']!, input)
    changeLog(exchange, 'iam.role.update', 'role', role.id, role.name)
    return role
  })

  guarded('GET', '/api/iam/groups', 'iam.user.read', () => ({
    groups: ctx.iam.groups().all().map((group) => ({
      ...group,
      resolvedMembers: ctx.iam.resolveGroupMembers(group.id).map((user) => ({ id: user.id, displayName: user.displayName, title: user.title })),
    })),
  }))

  guarded('POST', '/api/iam/groups', 'iam.user.write', (exchange) => {
    const input = body<{ name: string; type: 'static' | 'dynamic'; rule?: { orgIds?: string[]; title?: string }; memberIds?: string[]; description?: string }>(exchange)
    const group = ctx.iam.createGroup(input)
    changeLog(exchange, 'iam.group.create', 'user_group', group.id, group.name)
    return group
  })

  guarded('PATCH', '/api/iam/groups/:id', 'iam.user.write', (exchange) => {
    const group = ctx.iam.updateGroup(exchange.params['id']!, body(exchange))
    changeLog(exchange, 'iam.group.update', 'user_group', group.id, group.name)
    return group
  })

  guarded('DELETE', '/api/iam/groups/:id', 'iam.user.write', (exchange) => {
    ctx.iam.deleteGroup(exchange.params['id']!)
    changeLog(exchange, 'iam.group.delete', 'user_group', exchange.params['id']!, '')
    return { deleted: true }
  })

  // 三方连接器
  guarded('GET', '/api/iam/connectors', 'iam.org.read', () => ({
    providers: ctx.iam.connectorProviders(),
    configs: ctx.iam.connectorConfigs().all().map(({ secretActual, ...config }) => {
      void secretActual
      return config
    }),
  }))

  guarded('PUT', '/api/iam/connectors/:provider', 'iam.connector.write', (exchange) => {
    const input = body<{ corpId: string; appKey: string; appSecret?: string; enabled?: boolean; syncOrgRoot?: string; intervalMinutes?: number; callbackUrl?: string; loginEnabled?: boolean; conflictStrategy?: 'third_party_wins' | 'platform_wins' | 'manual'; mode?: 'real' | 'mock'; apiBase?: string }>(exchange)
    const config = ctx.iam.upsertConnectorConfig({ provider: exchange.params['provider']! as 'dingtalk', ...input })
    changeLog(exchange, 'iam.connector.update', 'connector', config.id, config.provider)
    const { secretActual, ...safe } = config
    void secretActual
    return safe
  })

  guarded('POST', '/api/iam/connectors/:provider/test', 'iam.connector.write', async (exchange) => {
    return await ctx.iam.testConnector(exchange.params['provider']!)
  })

  guarded('POST', '/api/iam/connectors/:provider/sync', 'iam.connector.write', async (exchange) => {
    const info = caller(exchange)
    const result = await ctx.iam.syncConnector(exchange.params['provider']!, info.userId ?? info.principalId)
    changeLog(exchange, 'iam.connector.sync', 'connector', exchange.params['provider']!, exchange.params['provider']!, result.message)
    return result
  })

  guarded('GET', '/api/iam/conflicts', 'iam.org.read', (exchange) => ({
    conflicts: ctx.iam.conflicts().find((item) => item.status === (exchange.query.get('status') ?? 'pending')),
  }))

  guarded('POST', '/api/iam/conflicts/:id/resolve', 'iam.user.write', (exchange) => {
    const { keep } = body<{ keep: 'third_party' | 'platform' }>(exchange)
    const info = caller(exchange)
    const conflict = ctx.iam.resolveConflict(exchange.params['id']!, keep, info.userId ?? info.principalId)
    changeLog(exchange, 'iam.conflict.resolve', 'sync_conflict', conflict.id, '', `保留 ${keep}`)
    return conflict
  })

  // -- Authn --------------------------------------------------------------
  guarded('GET', '/api/authn/principals', 'authn.principal.read', () => ({
    principals: ctx.authn.principals().all().map((principal) => ({
      ...principal,
      activeTokens: ctx.authn.activeTokenCount(principal.id),
    })),
  }))

  /** 机器凭证可绑定的已注册资源（签发弹窗下拉/搜索用：选择后自动回填 refType/refId）。 */
  guarded('GET', '/api/authn/bindable-resources', 'authn.principal.read', () => ({
    agents: ctx.resourceCore.list('agent').map((agent) => ({ id: agent.id, name: agent.name, status: agent.status })),
    apps: ctx.resourceCore.list('app').map((app) => ({ id: app.id, name: app.name, status: app.status })),
  }))

  guarded('POST', '/api/authn/principals', 'authn.principal.write', (exchange) => {
    const input = body<{ name: string; refType?: 'agent' | 'app' | 'external'; refId?: string; scopes: string[] }>(exchange)
    const created = ctx.authn.createMachineCredential(input)
    changeLog(exchange, 'authn.principal.create', 'principal', created.principal.id, input.name, input.refId ? `绑定 ${input.refType}:${input.refId}` : '')
    return { principalId: created.principal.id, clientId: created.clientId, clientSecret: created.clientSecret, note: '密钥仅此一次返回' }
  })

  guarded('POST', '/api/authn/principals/:id/disable', 'authn.principal.write', (exchange) => {
    const { reason } = body<{ reason?: string }>(exchange)
    const principal = ctx.authn.disablePrincipal(exchange.params['id']!, reason ?? '手动禁用')
    changeLog(exchange, 'authn.principal.disable', 'principal', principal.id, principal.name, reason ?? '')
    return principal
  })

  guarded('GET', '/api/authn/tokens', 'authn.principal.read', (exchange) => {
    const principalId = exchange.query.get('principalId') ?? undefined
    const tokens = ctx.authn.tokens().find((token) => (principalId ? token.principalId === principalId : true))
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
    return {
      total: tokens.length,
      tokens: tokens.slice(0, 200).map((token) => {
        // 脱敏：refreshHash 为签名级敏感凭证哈希，sid/chainId 属会话内部标识，一律不外发
        const { refreshHash, sid, chainId, ...rest } = token
        void refreshHash; void sid; void chainId
        return {
          ...rest,
          principalName: ctx.authn.principals().get(token.principalId)?.name ?? '',
        }
      }),
    }
  })

  guarded('POST', '/api/authn/tokens', 'authn.token.issue', (exchange) => {
    const input = body<{ principalId: string; ttlHours?: number; reason?: string; audience?: string; scopes?: string[] }>(exchange)
    const principal = ctx.authn.principals().get(input.principalId)
    if (!principal) throw new Error(`身份不存在：${input.principalId}`)
    const { token, record } = ctx.authn.issueToken(input.principalId, {
      kind: 'access',
      ttlHours: input.ttlHours,
      scopes: input.scopes ?? principal.scopes,
      ...(input.audience !== undefined ? { audience: input.audience } : {}),
      issuedBy: `console:${caller(exchange).name}`,
    })
    changeLog(exchange, 'authn.token.issue', 'token', record.jti, record.jti, input.reason ?? '')
    return { token, jti: record.jti, expiresAt: record.expiresAt }
  })

  // 受众校验自检（令牌内省：验证 aud 收紧语义，供运维与联调使用）
  http.register('POST', '/api/authn/verify-audience', async (exchange) => {
    const info = caller(exchange)
    if (!info.permissions.includes('*') && !info.permissions.includes('authn.principal.read')) {
      exchange.fail(403, 'FORBIDDEN', '缺少权限点 authn.principal.read')
      return
    }
    const input = body<{ token: string; audience: string }>(exchange)
    if (!input.token || !input.audience) {
      exchange.fail(400, 'BAD_REQUEST', 'token 与 audience 必填')
      return
    }
    try {
      const verified = ctx.authn.verify(input.token, { audience: input.audience })
      exchange.ok({ valid: true, principalId: verified.principal.id, scopes: verified.scopes })
    } catch (error) {
      exchange.ok({ valid: false, reason: error instanceof Error ? error.message : String(error) })
    }
  })

  guarded('DELETE', '/api/authn/tokens/:jti', 'authn.token.revoke', (exchange) => {
    const { reason } = body<{ reason?: string }>(exchange)
    const record = ctx.authn.revokeToken(exchange.params['jti']!, reason ?? '控制台吊销')
    changeLog(exchange, 'authn.token.revoke', 'token', record.jti, record.jti, reason ?? '')
    return record
  })

  guarded('POST', '/api/authn/rotate-secret', 'authn.token.revoke', (exchange) => {
    const result = ctx.authn.rotateSigningSecret()
    changeLog(exchange, 'authn.secret.rotate', 'platform', 'signing-secret', '', `签名密钥轮换（旧密钥 ${result.graceMs / 3600_000}h 宽限期内仍可验签）`)
    return { rotated: true, graceHours: result.graceMs / 3600_000 }
  })

  // OIDC 客户端管理（模式 B：外部应用以平台为 IdP；管理员全局兜底面）
  guarded('GET', '/api/authn/oidc/clients', 'authn.oidc.read', () => ({
    clients: ctx.oidc.listClients().map((client) => ({
      ...client,
      status: client.status ?? 'active',
      clientType: client.clientType ?? 'confidential',
      discovery: {
        issuer: ctx.oidc.issuer(),
        authorization_endpoint: `${ctx.oidc.issuer()}/oauth/authorize`,
        token_endpoint: `${ctx.oidc.issuer()}/oauth/token`,
        userinfo_endpoint: `${ctx.oidc.issuer()}/oauth/userinfo`,
      },
    })),
  }))

  guarded('POST', '/api/authn/oidc/clients', 'authn.oidc.write', (exchange) => {
    const input = body<{ name: string; redirectUris: string[]; description?: string; consentRequired?: boolean; postLogoutUris?: string[]; clientType?: 'confidential' | 'public' }>(exchange)
    if (!input.name || !Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
      throw new Error('name 与 redirectUris（至少一个回调地址）必填')
    }
    for (const uri of input.redirectUris) {
      let parsed: URL
      try { parsed = new URL(uri) } catch { throw new Error(`回调地址非法：${uri}`) }
      const localhostOk = parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
      if (parsed.protocol !== 'https:' && !localhostOk) throw new Error(`回调地址必须为 https:// 或 http://localhost[:port]（收到：${uri}）`)
    }
    const created = ctx.oidc.createClient({
      name: input.name,
      redirectUris: input.redirectUris,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.consentRequired !== undefined ? { consentRequired: input.consentRequired } : {}),
      ...(input.postLogoutUris !== undefined ? { postLogoutUris: input.postLogoutUris } : {}),
      ...(input.clientType !== undefined ? { clientType: input.clientType } : {}),
    })
    changeLog(exchange, 'authn.oidc.client.create', 'oidc_client', created.client.id, created.client.name, input.clientType === 'public' ? 'public 客户端（免 secret）' : '')
    return { clientId: created.client.clientId, clientSecret: created.clientSecret, redirectUris: created.client.redirectUris, note: created.client.clientType === 'public' ? 'public 客户端无 secret（强制 PKCE）' : 'clientSecret 仅此一次返回' }
  })

  guarded('PATCH', '/api/authn/oidc/clients/:id', 'authn.oidc.write', (exchange) => {
    const input = body<{ name?: string; redirectUris?: string[]; description?: string; consentRequired?: boolean; postLogoutUris?: string[] }>(exchange)
    const updated = ctx.oidc.updateClient(exchange.params['id']!, input)
    changeLog(exchange, 'authn.oidc.client.update', 'oidc_client', updated.id, updated.name)
    return updated
  })

  guarded('POST', '/api/authn/oidc/clients/:id/rotate', 'authn.oidc.write', (exchange) => {
    const rotated = ctx.oidc.rotateSecret(exchange.params['id']!)
    changeLog(exchange, 'authn.oidc.client.rotate', 'oidc_client', rotated.client.id, rotated.client.name, '旧 secret 立即失效')
    return { clientId: rotated.client.clientId, clientSecret: rotated.clientSecret, note: '新 clientSecret 仅此一次返回，旧值立即失效' }
  })

  for (const [action, label] of [['disable', '禁用'], ['enable', '启用']] as const) {
    guarded('POST', `/api/authn/oidc/clients/:id/${action}`, 'authn.oidc.write', (exchange) => {
      const { reason } = body<{ reason?: string }>(exchange)
      const client = action === 'disable'
        ? ctx.oidc.disableClient(exchange.params['id']!, reason ?? '控制台手动禁用')
        : ctx.oidc.enableClient(exchange.params['id']!)
      changeLog(exchange, `authn.oidc.client.${action}`, 'oidc_client', client.id, client.name, reason ?? '')
      return client
    })
  }

  /** JWKS 签名密钥轮换：新 key 立即签名，旧 key 24h 验签宽限（在途令牌不掉线）。 */
  guarded('POST', '/api/authn/oidc/keys/rotate', 'authn.oidc.write', (exchange) => {
    const result = ctx.oidc.rotateKeys()
    changeLog(exchange, 'authn.oidc.keys.rotate', 'platform', 'oidc-keys', '', `新 kid=${result.kid}，旧 key ${result.graceHours}h 宽限`)
    return { rotated: true, kid: result.kid, graceHours: result.graceHours }
  })

  guarded('GET', '/api/authn/oidc/discovery', 'authn.principal.read', () => ctx.oidc.discovery())

  // -- MCP ----------------------------------------------------------------
  guarded('GET', '/api/mcp/services', 'mcp.service.read', () => ({
    services: ctx.mcpRegistry.services().all().map(maskServiceHeaders),
    overview: ctx.mcpRegistry.metricsOverview(),
  }))

  guarded('POST', '/api/mcp/services', 'mcp.service.write', (exchange) => {
    const input = body<{ name: string; slug?: string; description?: string; icon?: string; endpoint?: string; transport?: 'stdio' | 'sse' | 'http'; mode?: 'hosted' | 'external'; orgId: string; headers?: Record<string, string>; tools?: Array<{ name: string; description: string; riskLevel?: 'read' | 'write' | 'admin'; inputSchema?: Record<string, unknown> }> }>(exchange)
    const service = ctx.mcpRegistry.createService({
      ...input,
      owner: caller(exchange).name,
      ...(input.tools ? { tools: input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        riskLevel: tool.riskLevel ?? 'read',
        // 完整透传外部工具的 inputSchema（导入链路的关键信息），仅缺省时兜底空对象
        inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' && Object.keys(tool.inputSchema).length > 0
          ? tool.inputSchema
          : { type: 'object', properties: {}, additionalProperties: true },
      })) } : {}),
    })
    changeLog(exchange, 'mcp.service.create', 'mcp_service', service.id, service.name)
    return maskServiceHeaders(service)
  })

  /** mcpServers JSON 一键导入：解析 → 注册外部服务 → 自动发现工具 →（默认）验证上线。 */
  guarded('POST', '/api/mcp/import', 'mcp.service.write', async (exchange) => {
    const input = body<{ config: string | object; autoDeploy?: boolean }>(exchange)
    const rootOrg = ctx.iam.orgs().findOne((org) => org.parentId === null)
    if (!rootOrg) throw new Error('组织数据未初始化，无法导入')
    const result = await ctx.mcpRegistry.importServices({
      config: input.config,
      orgId: rootOrg.id,
      owner: caller(exchange).name,
      ...(input.autoDeploy !== undefined ? { autoDeploy: input.autoDeploy } : {}),
    })
    for (const item of result.results) {
      if (item.ok && item.serviceId) changeLog(exchange, 'mcp.service.import', 'mcp_service', item.serviceId, item.name, `tools=${item.tools ?? 0} reachable=${item.reachable}`)
    }
    return result
  })

  /** 外部服务工具同步：以远端 tools/list 为准刷新本地工具清单。 */
  guarded('POST', '/api/mcp/services/:id/sync-tools', 'mcp.service.write', async (exchange) => {
    const service = await ctx.mcpRegistry.syncTools(exchange.params['id']!)
    changeLog(exchange, 'mcp.service.syncTools', 'mcp_service', service.id, service.name, `tools=${service.tools.length}`)
    return maskServiceHeaders(service)
  })

  guarded('PATCH', '/api/mcp/services/:id', 'mcp.service.write', (exchange) => {
    const service = ctx.mcpRegistry.updateService(exchange.params['id']!, body(exchange))
    changeLog(exchange, 'mcp.service.update', 'mcp_service', service.id, service.name)
    return maskServiceHeaders(service)
  })

  guarded('POST', '/api/mcp/services/:id/verify', 'mcp.service.deploy', async (exchange) => {
    const service = await ctx.mcpRegistry.verifyService(exchange.params['id']!)
    changeLog(exchange, 'mcp.service.verify', 'mcp_service', service.id, service.name)
    return service
  })

  guarded('POST', '/api/mcp/services/:id/deploy', 'mcp.service.deploy', async (exchange) => {
    const input = body<{ grayPercent?: number; version?: string; changelog?: string; dryRun?: boolean }>(exchange)
    const id = exchange.params['id']!
    const impact = ctx.resourceCore.impact('mcp_service', id)
    if (input.dryRun) return { dryRun: true, impact }
    const service = await ctx.mcpRegistry.deployService(id, { ...input, actor: caller(exchange).name })
    changeLog(exchange, 'mcp.service.deploy', 'mcp_service', service.id, service.name, `v${service.currentVersion} gray=${service.grayPercent}%`)
    return service
  })

  guarded('POST', '/api/mcp/services/:id/rollback', 'mcp.service.deploy', async (exchange) => {
    const { targetVersion } = body<{ targetVersion: string }>(exchange)
    const service = await ctx.mcpRegistry.rollbackService(exchange.params['id']!, targetVersion, caller(exchange).name)
    changeLog(exchange, 'mcp.service.rollback', 'mcp_service', service.id, service.name, targetVersion)
    return service
  })

  guarded('POST', '/api/mcp/services/:id/offline', 'mcp.service.offline', (exchange) => {
    const { reason, viaApproval } = body<{ reason?: string; viaApproval?: boolean }>(exchange)
    const id = exchange.params['id']!
    if (viaApproval !== false) {
      const impact = ctx.resourceCore.impact('mcp_service', id)
      const approval = ctx.mcpRegistry.requestOfflineApproval(id, { id: caller(exchange).userId ?? caller(exchange).principalId, name: caller(exchange).name }, reason ?? '', impact.map((item) => `${item.name}（${item.type}）`))
      return { approval, note: '已创建 L4 审批单' }
    }
    const service = ctx.mcpRegistry.offlineService(id, caller(exchange).name, reason ?? '')
    changeLog(exchange, 'mcp.service.offline', 'mcp_service', service.id, service.name, reason ?? '')
    return service
  })

  guarded('POST', '/api/mcp/services/:id/health', 'mcp.service.deploy', async (exchange) => {
    return await ctx.mcpRegistry.healthCheck(exchange.params['id']!)
  })

  guarded('GET', '/api/mcp/services/:id/metrics', 'mcp.service.read', (exchange) => {
    return ctx.mcpRegistry.serviceMetrics(exchange.params['id']!)
  })

  guarded('GET', '/api/mcp/calls', 'mcp.service.read', (exchange) => {
    return ctx.mcpRegistry.callLog({
      serviceId: exchange.query.get('serviceId') ?? undefined,
      callerId: exchange.query.get('callerId') ?? undefined,
      status: exchange.query.get('status') ?? undefined,
      limit: Number(exchange.query.get('limit') ?? 100),
    })
  })

  guarded('GET', '/api/mcp/perm-groups', 'mcp.service.read', () => ({ groups: ctx.mcpRegistry.permGroups().all() }))

  guarded('POST', '/api/mcp/perm-groups', 'mcp.permgroup.write', (exchange) => {
    const input = body<{ name: string; description?: string; policies: Record<string, { allowedTools: '*' | string[]; constraints?: { readOnly?: boolean } }>; subjects: Array<{ type: 'user_group' | 'agent' | 'app'; id: string; name?: string }> }>(exchange)
    const group = ctx.mcpRegistry.createPermGroup({
      name: input.name,
      description: input.description,
      policies: Object.fromEntries(Object.entries(input.policies).map(([serviceId, policy]) => [
        serviceId,
        { allowedTools: policy.allowedTools, constraints: policy.constraints ?? {} },
      ])),
      subjects: input.subjects,
    })
    changeLog(exchange, 'mcp.permgroup.create', 'mcp_perm_group', group.id, group.name)
    return group
  })

  guarded('PATCH', '/api/mcp/perm-groups/:id', 'mcp.permgroup.write', (exchange) => {
    const group = ctx.mcpRegistry.updatePermGroup(exchange.params['id']!, body(exchange))
    changeLog(exchange, 'mcp.permgroup.update', 'mcp_perm_group', group.id, group.name)
    return group
  })

  guarded('DELETE', '/api/mcp/perm-groups/:id', 'mcp.permgroup.write', (exchange) => {
    ctx.mcpRegistry.deletePermGroup(exchange.params['id']!)
    changeLog(exchange, 'mcp.permgroup.delete', 'mcp_perm_group', exchange.params['id']!, '')
    return { deleted: true }
  })

  guarded('POST', '/api/mcp/invoke', 'mcp.invoke', async (exchange) => {
    const input = body<{ serviceId: string; tool: string; args?: Record<string, unknown> }>(exchange)
    const info = caller(exchange)
    return await ctx.mcpRegistry.invoke({
      type: info.kind === 'human' ? 'user' : info.kind === 'machine' ? 'app' : 'user',
      id: info.userId ?? info.principalId,
      name: info.name,
      ...(info.actChain.length > 0 ? { actChain: info.actChain } : {}),
      ...(info.actChain.length > 0 ? { onBehalfOf: info.actChain[0]!.name } : {}),
    }, input.serviceId, input.tool, input.args ?? {})
  })

  // -- Skill 市场 ---------------------------------------------------------
  guarded('GET', '/api/skills', 'skill.read', (exchange) => {
    if (exchange.query.get('mine') === '1') {
      const info = caller(exchange)
      return { skills: ctx.skillHub.skills().find((skill) => skill.authorId === (info.userId ?? info.principalId)) }
    }
    if (exchange.query.get('pending') === '1') {
      return { skills: ctx.skillHub.skills().find((skill) => ['pending_approval', 'scanning', 'rejected'].includes(skill.status)) }
    }
    const skills = ctx.skillHub.search({
      q: exchange.query.get('q') ?? undefined,
      category: exchange.query.get('category') ?? undefined,
      tag: exchange.query.get('tag') ?? undefined,
      sort: (exchange.query.get('sort') ?? 'downloads') as 'downloads' | 'rating' | 'updated',
    })
    return { skills, categories: ctx.skillHub.categories() }
  })

  guarded('GET', '/api/skills/:id', 'skill.read', (exchange) => {
    return ctx.skillHub.detail(exchange.params['id']!)
  })

  guarded('POST', '/api/skills', 'skill.submit', (exchange) => {
    const input = body<{ name: string; category?: string; tags?: string[]; summary?: string; description?: string; content: string; version?: string; changelog?: string; visibility?: 'all' | 'orgs' | 'groups'; applicableModels?: string[]; deps?: string[]; packageBase64?: string }>(exchange)
    const info = caller(exchange)
    const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
    const skill = ctx.skillHub.submit({
      ...input,
      authorId: info.userId ?? info.principalId,
      authorName: info.name,
      orgId: user?.orgId ?? 'org_unknown',
    })
    return { id: skill.id, status: skill.status, findings: skill.versions.at(-1)?.findings ?? [], hasPackage: Boolean(skill.versions.at(-1)?.packageBase64) }
  })

  guarded('POST', '/api/skills/:id/approve', 'skill.approve', (exchange) => {
    const input = body<{ version?: string; decision: 'approve' | 'reject'; level: 'domain' | 'security'; opinion: string }>(exchange)
    const info = caller(exchange)
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    const version = input.version ?? skill.currentVersion
    const result = input.decision === 'approve'
      ? ctx.skillHub.approve(skill.id, version, input.level, { id: info.userId ?? info.principalId, name: info.name }, input.opinion)
      : ctx.skillHub.reject(skill.id, version, { id: info.userId ?? info.principalId, name: info.name }, input.opinion)
    changeLog(exchange, `skill.approve.${input.decision}`, 'skill', skill.id, skill.name, `${input.level}: ${input.opinion}`)
    return result
  })

  guarded('POST', '/api/skills/:id/publish', 'skill.publish', async (exchange) => {
    const { version } = body<{ version?: string }>(exchange)
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    const result = await ctx.skillHub.publish(skill.id, version ?? skill.currentVersion, caller(exchange).name)
    changeLog(exchange, 'skill.publish', 'skill', skill.id, skill.name)
    return result
  })

  guarded('POST', '/api/skills/:id/deprecate', 'skill.publish', (exchange) => {
    const { reason, force } = body<{ reason?: string; force?: boolean }>(exchange)
    const result = ctx.skillHub.deprecate(exchange.params['id']!, caller(exchange).name, reason ?? '', force)
    changeLog(exchange, 'skill.deprecate', 'skill', result.skill.id, result.skill.name, reason ?? '')
    return result
  })

  guarded('POST', '/api/skills/:id/install', 'skill.install', (exchange) => {
    const { agentId, version } = body<{ agentId: string; version?: string }>(exchange)
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    const result = ctx.skillHub.install(skill.id, version ?? skill.currentVersion, agentId, caller(exchange).name)
    changeLog(exchange, 'skill.install', 'skill', skill.id, skill.name, `→ ${agentId}`)
    return result
  })

  guarded('POST', '/api/skills/:id/uninstall', 'skill.install', (exchange) => {
    const { agentId } = body<{ agentId: string }>(exchange)
    ctx.skillHub.uninstall(exchange.params['id']!, agentId)
    return { uninstalled: true }
  })

  guarded('POST', '/api/skills/:id/rate', 'skill.read', (exchange) => {
    const { stars } = body<{ stars: number }>(exchange)
    const info = caller(exchange)
    return ctx.skillHub.rate(exchange.params['id']!, info.userId ?? info.principalId, stars)
  })

  guarded('POST', '/api/skills/:id/download', 'skill.read', (exchange) => {
    const { version } = body<{ version?: string }>(exchange)
    const info = caller(exchange)
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    return ctx.skillHub.download(skill.id, version ?? skill.currentVersion, { id: info.userId ?? info.principalId, name: info.name })
  })

  /** skill.zip 包下载：与 NAS 上架产物同源（提交携带的原始包或 SKILL.md 现场打包）。 */
  guarded('GET', '/api/skills/:id/package', 'skill.read', (exchange) => {
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    const pkg = ctx.skillHub.packageOf(skill.id, exchange.query.get('version') ?? skill.currentVersion)
    // 中文 slug 文件名：ASCII 回退 + RFC 5987 UTF-8 形式（非 Latin1 字符直接进头会损坏响应）
    exchange.res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': pkg.buffer.length,
      'content-disposition': `attachment; filename="${pkg.filename.replace(/[^\x20-\x7e"]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(pkg.filename)}`,
      'cache-control': 'no-cache',
    })
    exchange.res.end(pkg.buffer)
  })

  // -- Skill 包存储配置（local / NAS 后端） --------------------------------
  guarded('GET', '/api/skill-storage', 'skill.read', () => {
    const config = ctx.nasRegistry.getSkillStorage()
    return {
      config,
      nasOptions: ctx.nasRegistry.list({ status: 'online' }).map((nas) => ({ id: nas.id, name: nas.name, slug: nas.slug, rootPath: nas.attrs['rootPath'] })),
    }
  })

  guarded('PUT', '/api/skill-storage', 'skill.storage.write', (exchange) => {
    const input = body<{ mode?: 'local' | 'nas'; nasId?: string; basePath?: string }>(exchange)
    const config = ctx.nasRegistry.setSkillStorage(input, caller(exchange).name)
    changeLog(exchange, 'skill.storage.update', 'skill_storage', config.id, 'Skill 包存储', `${config.mode}${config.nasId ? ` → ${config.nasId}:${config.basePath}` : ''}`)
    return config
  })

  // -- NAS 存储（FS 文件存储类资产） ----------------------------------------
  guarded('GET', '/api/nas', 'nas.read', (exchange) => ({
    items: ctx.nasRegistry.list({
      status: exchange.query.get('status') ?? undefined,
      q: exchange.query.get('q') ?? undefined,
    }).map((nas) => ({
      ...maskNasEntity(nas),
      health: ctx.nasRegistry.healthOf(nas.id),
      gatewayToolCount: ctx.nasRegistry.toolsOf(nas.id).length,
      availableTransitions: ctx.resourceCore.availableTransitions('nas', nas.id),
    })),
    schema: ctx.resourceCore.typeSpec('nas')?.schema,
    lifecycle: ctx.resourceCore.typeSpec('nas')?.lifecycle,
  }))

  guarded('GET', '/api/nas/:id', 'nas.read', (exchange) => {
    const nas = ctx.nasRegistry.get(exchange.params['id']!)
    if (!nas) throw new Error(`NAS 资产不存在：${exchange.params['id']}`)
    return {
      ...maskNasEntity(nas),
      health: ctx.nasRegistry.healthOf(nas.id),
      gatewayTools: ctx.nasRegistry.toolsOf(nas.id),
      availableTransitions: ctx.resourceCore.availableTransitions('nas', nas.id),
      audit: ctx.audit.query({ resourceType: 'nas', resourceId: nas.id, limit: 30 }).items,
    }
  })

  guarded('POST', '/api/nas', 'nas.write', (exchange) => {
    const input = body<{ name: string; slug?: string; attrs?: Record<string, unknown> }>(exchange)
    const info = caller(exchange)
    const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
    const nas = ctx.nasRegistry.register({
      ...input,
      ownerId: info.userId ?? info.principalId,
      orgId: user?.orgId ?? ctx.iam.orgs().all()[0]?.id ?? 'org_unknown',
    })
    changeLog(exchange, 'nas.create', 'nas', nas.id, nas.name)
    return maskNasEntity(nas)
  })

  guarded('PATCH', '/api/nas/:id', 'nas.write', (exchange) => {
    const input = body<{ name?: string; attrs?: Record<string, unknown> }>(exchange)
    const nas = ctx.nasRegistry.update(exchange.params['id']!, input)
    changeLog(exchange, 'nas.update', 'nas', nas.id, nas.name)
    return maskNasEntity(nas)
  })

  /** 删除 NAS 资产：仅终态（已归档）可删；被 Skill 包存储后端引用时拒绝。 */
  guarded('DELETE', '/api/nas/:id', 'nas.write', (exchange) => {
    const id = exchange.params['id']!
    const nas = ctx.nasRegistry.get(id)
    if (!nas) throw new Error(`NAS 资产不存在：${id}`)
    const storage = ctx.nasRegistry.getSkillStorage()
    if (storage.mode === 'nas' && storage.nasId === id) {
      throw new Error('该 NAS 正作为 Skill 包存储后端，请先在「Skill 包存储」切换为 local 或其他 NAS')
    }
    ctx.resourceCore.remove('nas', id)
    ctx.nasRegistry.purge(id)
    changeLog(exchange, 'nas.delete', 'nas', id, nas.name)
    return { deleted: true }
  })

  guarded('POST', '/api/nas/:id/transition', 'nas.write', async (exchange) => {
    const { action, note } = body<{ action: string; note?: string }>(exchange)
    const info = caller(exchange)
    const id = exchange.params['id']!
    if (action === 'online') {
      const nas = await ctx.nasRegistry.online(id, info.name)
      changeLog(exchange, 'nas.online', 'nas', id, nas.name)
      return maskNasEntity(nas)
    }
    if (action === 'offline') {
      if (!note?.trim()) throw new Error('下线必须填写原因（护栏要求）')
      const nas = ctx.nasRegistry.offline(id, info.name, note)
      changeLog(exchange, 'nas.offline', 'nas', id, nas.name, note)
      return maskNasEntity(nas)
    }
    if (action === 'archive') {
      const nas = ctx.nasRegistry.archive(id, info.name)
      changeLog(exchange, 'nas.archive', 'nas', id, nas.name)
      return maskNasEntity(nas)
    }
    throw new Error(`未知操作：${action}`)
  })

  guarded('POST', '/api/nas/:id/health', 'nas.read', async (exchange) => {
    return await ctx.nasRegistry.probe(exchange.params['id']!)
  })

  guarded('POST', '/api/nas/:id/sync-tools', 'nas.write', async (exchange) => {
    const tools = await ctx.nasRegistry.discoverTools(exchange.params['id']!)
    return { tools: tools.map((tool) => tool.name), count: tools.length }
  })

  /**
   * mcpServers JSON 一键纳管 NAS（synology-filestation 形态）：
   * {"mcpServers":{"synology-filestation":{"url":"http://gw:3000/mcp","headers":{"Authorization":"Bearer …","X-NAS-IP":"192.168.0.196"}}}}
   * 解析 url + 认证头 + 设备路由头 → 创建资产 → 探活 → 上线 → 工具发现。
   */
  guarded('POST', '/api/nas/import', 'nas.write', async (exchange) => {
    const input = body<{ config: string | object; name?: string; description?: string }>(exchange)
    const info = caller(exchange)
    const entries = parseNasMcpServersConfig(input.config)
    const results: Array<{ name: string; ok: boolean; nasId?: string; reachable?: boolean; tools?: number; status?: string; error?: string }> = []
    for (const entry of entries) {
      if (entry.error) {
        results.push({ name: entry.name, ok: false, error: entry.error })
        continue
      }
      try {
        const nas = ctx.nasRegistry.register({
          name: input.name && entries.length === 1 ? input.name : entry.name,
          attrs: {
            description: input.description ?? `mcpServers JSON 导入（网关 ${entry.url}）`,
            gatewayUrl: entry.url,
            accessToken: entry.token,
            nasIp: entry.nasIp,
            rootPath: '/',
            dataClass: 'internal',
            tags: ['mcp-import'],
          },
          ownerId: info.userId ?? info.principalId,
          orgId: ctx.iam.orgs().all()[0]?.id ?? 'org_unknown',
        })
        let reachable = false
        let tools = 0
        try {
          const health = await ctx.nasRegistry.probe(nas.id)
          reachable = health.status !== 'down'
        } catch { reachable = false }
        if (reachable) {
          tools = (await ctx.nasRegistry.discoverTools(nas.id).catch(() => [])).length
        }
        let status = nas.status
        if (reachable) {
          const onlined = await ctx.nasRegistry.online(nas.id, info.name)
          status = onlined.status
        }
        changeLog(exchange, 'nas.import', 'nas', nas.id, nas.name, `reachable=${reachable}`)
        results.push({ name: entry.name, ok: true, nasId: nas.id, reachable, tools, status, ...(reachable ? {} : { error: '网关不可达：资产保留草稿，请检查地址/令牌/网络后重试上线' }) })
      } catch (error) {
        results.push({ name: entry.name, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { imported: results.filter((item) => item.ok).length, results }
  })

  guarded('GET', '/api/nas/:id/fs', 'nas.read', async (exchange) => {
    const id = exchange.params['id']!
    const path = exchange.query.get('path')
    return path === null || path === '' ? await ctx.nasRegistry.listShares(id) : await ctx.nasRegistry.listFiles(id, path)
  })

  guarded('GET', '/api/nas/:id/fs/info', 'nas.read', async (exchange) => {
    const path = exchange.query.get('path')
    if (!path) throw new Error('缺少 path 查询参数')
    return await ctx.nasRegistry.getInfo(exchange.params['id']!, path)
  })

  guarded('POST', '/api/nas/:id/fs/search', 'nas.read', async (exchange) => {
    const { pattern, path } = body<{ pattern: string; path?: string }>(exchange)
    if (!pattern) throw new Error('缺少 pattern')
    return await ctx.nasRegistry.search(exchange.params['id']!, pattern, path ?? '/')
  })

  guarded('POST', '/api/nas/:id/fs/mkdir', 'nas.write', async (exchange) => {
    const { path } = body<{ path: string }>(exchange)
    const info = caller(exchange)
    const result = await ctx.nasRegistry.mkdir(exchange.params['id']!, path, { id: info.userId ?? info.principalId, name: info.name })
    return result
  })

  guarded('POST', '/api/nas/:id/fs/rename', 'nas.write', async (exchange) => {
    const { path, newName } = body<{ path: string; newName: string }>(exchange)
    const info = caller(exchange)
    return await ctx.nasRegistry.rename(exchange.params['id']!, path, newName, { id: info.userId ?? info.principalId, name: info.name })
  })

  guarded('POST', '/api/nas/:id/fs/delete', 'nas.write', async (exchange) => {
    const { paths } = body<{ paths: string[] }>(exchange)
    const info = caller(exchange)
    return await ctx.nasRegistry.delete(exchange.params['id']!, Array.isArray(paths) ? paths : [paths], { id: info.userId ?? info.principalId, name: info.name })
  })

  guarded('POST', '/api/nas/:id/fs/upload', 'nas.write', async (exchange) => {
    const input = body<{ localFile?: string; contentBase64?: string; destPath: string }>(exchange)
    const info = caller(exchange)
    if (input.localFile && input.contentBase64) throw new Error('localFile 与 contentBase64 二选一')
    const buffer = input.contentBase64 !== undefined ? Buffer.from(input.contentBase64, 'base64') : undefined
    return await ctx.nasRegistry.uploadFile(exchange.params['id']!, {
      ...(buffer !== undefined ? { buffer } : { localFile: input.localFile }),
      destPath: input.destPath,
      actor: { id: info.userId ?? info.principalId, name: info.name },
    })
  })

  guarded('POST', '/api/nas/:id/fs/download', 'nas.read', async (exchange) => {
    const { path } = body<{ path: string }>(exchange)
    const info = caller(exchange)
    return await ctx.nasRegistry.downloadFile(exchange.params['id']!, path, { id: info.userId ?? info.principalId, name: info.name })
  })

  // -- Agent --------------------------------------------------------------
  guarded('GET', '/api/agents', 'agent.read', () => ({
    agents: ctx.resourceCore.list('agent').map((agent) => ({
      ...agent,
      metrics: ctx.agentRegistry.metrics(agent.id),
      boundUserCount: ctx.agentRegistry.bindings().find((item) => item.agentId === agent.id).length,
      availableTransitions: ctx.resourceCore.availableTransitions('agent', agent.id),
    })),
    schema: ctx.resourceCore.typeSpec('agent')?.schema,
    lifecycle: ctx.resourceCore.typeSpec('agent')?.lifecycle,
  }))

  guarded('GET', '/api/agents/:id', 'agent.read', (exchange) => {
    const id = exchange.params['id']!
    const agent = ctx.resourceCore.get('agent', id)
    if (!agent) throw new Error(`Agent 不存在：${id}`)
    const principal = ctx.agentRegistry.machinePrincipal(id)
    return {
      ...agent,
      metrics: ctx.agentRegistry.metrics(id),
      boundUsers: ctx.agentRegistry.boundUsers(id),
      availableTransitions: ctx.resourceCore.availableTransitions('agent', id),
      credential: principal ? { principalId: principal.id, clientId: principal.clientId, status: principal.status, activeTokens: ctx.authn.activeTokenCount(principal.id) } : null,
      topology: enrichTopology(ctx.resourceCore.topology('agent', id, 2)),
      impact: ctx.resourceCore.impact('agent', id),
      audit: ctx.audit.query({ resourceType: 'agent', resourceId: id, limit: 30 }).items,
    }
  })

  guarded('POST', '/api/agents', 'agent.write', (exchange) => {
    const input = body<{ name: string; slug?: string; attrs?: Record<string, unknown> }>(exchange)
    const info = caller(exchange)
    const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
    const result = ctx.agentRegistry.register({
      ...input,
      ownerId: info.userId ?? info.principalId,
      ownerName: info.name,
      orgId: user?.orgId ?? ctx.iam.orgs().all()[0]?.id ?? 'org_unknown',
    })
    return { agent: result.agent, credential: result.credential ?? null }
  })

  guarded('PATCH', '/api/agents/:id', 'agent.write', (exchange) => {
    const input = body<{ name?: string; attrs?: Record<string, unknown> }>(exchange)
    const agent = ctx.resourceCore.update('agent', exchange.params['id']!, input)
    changeLog(exchange, 'agent.update', 'agent', agent.id, agent.name)
    return agent
  })

  guarded('POST', '/api/agents/:id/bindings', 'agent.write', (exchange) => {
    const { userId } = body<{ userId: string }>(exchange)
    const binding = ctx.agentRegistry.bindUser(exchange.params['id']!, userId, caller(exchange).name)
    changeLog(exchange, 'agent.bind_user', 'agent', binding.agentId, '', binding.userName)
    return binding
  })

  guarded('DELETE', '/api/agents/:id/bindings/:userId', 'agent.write', (exchange) => {
    ctx.agentRegistry.unbindUser(exchange.params['id']!, exchange.params['userId']!)
    return { unbound: true }
  })

  guarded('POST', '/api/agents/:id/transition', 'agent.approve', (exchange) => {
    const { action, note } = body<{ action: string; note?: string }>(exchange)
    const info = caller(exchange)
    const id = exchange.params['id']!
    if (action === 'online') {
      const approval = ctx.agentRegistry.requestOnline(id, { id: info.userId ?? info.principalId, name: info.name })
      return { approval, note: '上线为 L4 操作，已创建审批单' }
    }
    if (action === 'offline') {
      const approval = ctx.agentRegistry.requestOffline(id, { id: info.userId ?? info.principalId, name: info.name }, note ?? '')
      return { approval, note: '下线为 L4 操作，已创建审批单' }
    }
    if (action === 'submit_trial') return ctx.agentRegistry.trial(id, info.name, [])
    if (action === 'archive') return ctx.agentRegistry.archive(id, info.name)
    throw new Error(`未知操作：${action}`)
  })

  guarded('POST', '/api/agents/:id/obo-token', 'agent.write', (exchange) => {
    const info = caller(exchange)
    const header = String(exchange.headers['authorization'] ?? '').slice(7)
    const verified = ctx.authn.verify(header)
    if (verified.principal.type !== 'human') throw new Error('on-behalf-of 令牌必须由用户身份发起')
    const result = ctx.agentRegistry.issueOnBehalfOfToken(exchange.params['id']!, verified)
    changeLog(exchange, 'agent.obo_token', 'agent', exchange.params['id']!, '', `链路：${result.actChain.map((item) => (item as { name: string }).name).join(' → ')}`)
    return result
  })

  // -- App ----------------------------------------------------------------
  guarded('GET', '/api/apps', 'app.read', () => ({
    apps: ctx.resourceCore.list('app').map((app) => ({
      ...app,
      metrics: ctx.appRegistry.metrics(app.id),
      availableTransitions: ctx.resourceCore.availableTransitions('app', app.id),
    })),
    schema: ctx.resourceCore.typeSpec('app')?.schema,
    lifecycle: ctx.resourceCore.typeSpec('app')?.lifecycle,
  }))

  guarded('GET', '/api/apps/:id', 'app.read', (exchange) => {
    const id = exchange.params['id']!
    const app = ctx.resourceCore.get('app', id)
    if (!app) throw new Error(`应用不存在：${id}`)
    // SSO 配置块（不含 secret；供详情页「SSO 配置」tab 与门禁提示使用）
    const ssoClients = ctx.oidc.clientsForApp(id)
    const ssoClient = ssoClients[0]
    const { clientSecretHash, ...ssoSafe } = ssoClient ?? {}
    void clientSecretHash
    return {
      ...app,
      metrics: ctx.appRegistry.metrics(id),
      topology: enrichTopology(ctx.appRegistry.topology(id)),
      cost: ctx.appRegistry.costBreakdown(id),
      impact: ctx.resourceCore.impact('app', id),
      availableTransitions: ctx.resourceCore.availableTransitions('app', id),
      audit: ctx.audit.query({ resourceType: 'app', resourceId: id, limit: 30 }).items,
      sso: ssoClient
        ? {
          ...ssoSafe,
          status: ssoSafe.status ?? 'active',
          clientType: ssoSafe.clientType ?? 'confidential',
          refAppName: ctx.resourceCore.get('app', ssoSafe.refId ?? '')?.name ?? undefined,
          discovery: {
            issuer: ctx.oidc.issuer(),
            authorization_endpoint: `${ctx.oidc.issuer()}/oauth/authorize`,
            token_endpoint: `${ctx.oidc.issuer()}/oauth/token`,
            userinfo_endpoint: `${ctx.oidc.issuer()}/oauth/userinfo`,
          },
        }
        : null,
      ssoEnforceTypes: ((): string[] => {
        // 门禁形态提示（与 plugin-app 同源逻辑；动态 import 避免循环依赖）
        return String(process.env.APP_SSO_ENFORCE ?? 'web,h5').split(',').map((item) => item.trim()).filter(Boolean)
      })(),
    }
  })

  guarded('POST', '/api/apps', 'app.write', (exchange) => {
    const input = body<{ name: string; slug?: string; attrs?: Record<string, unknown>; agentIds?: string[] }>(exchange)
    const info = caller(exchange)
    const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
    const result = ctx.appRegistry.register({
      ...input,
      ownerId: info.userId ?? info.principalId,
      ownerName: info.name,
      orgId: user?.orgId ?? ctx.iam.orgs().all()[0]?.id ?? 'org_unknown',
    })
    return { app: result.app, credential: result.credential ?? null }
  })

  guarded('PATCH', '/api/apps/:id', 'app.write', (exchange) => {
    const app = ctx.appRegistry.updateApp(exchange.params['id']!, body(exchange))
    changeLog(exchange, 'app.update', 'app', app.id, app.name)
    return app
  })

  guarded('POST', '/api/apps/:id/transition', 'app.write', (exchange) => {
    const { action, note } = body<{ action: string; note?: string }>(exchange)
    const info = caller(exchange)
    const id = exchange.params['id']!
    if (action === 'online') {
      const approval = ctx.appRegistry.requestOnline(id, { id: info.userId ?? info.principalId, name: info.name })
      return { approval, note: '发布为 L4 操作，已创建审批单' }
    }
    if (action === 'offline') {
      const approval = ctx.appRegistry.requestOffline(id, { id: info.userId ?? info.principalId, name: info.name }, note ?? '')
      return { approval, note: '下架为 L4 操作，已创建审批单' }
    }
    if (action === 'submit_trial') return ctx.resourceCore.transition('app', id, 'submit_trial', info.name).entity
    if (action === 'retrial') return ctx.resourceCore.transition('app', id, 'retrial', info.name).entity
    if (action === 'archive') return ctx.appRegistry.archive(id, info.name)
    throw new Error(`未知操作：${action}`)
  })

  // -- 应用 ↔ SSO 打通（owner 自助签发；全库首例 owner-based 授权） ----------------
  const ssoApp = (exchange: HttpExchange): { id: string; name: string; ownerId: string } => {
    const app = ctx.resourceCore.get('app', exchange.params['id']!)
    if (!app) throw new Error(`应用不存在：${exchange.params['id']}`)
    return { id: app.id, name: app.name, ownerId: app.ownerId }
  }

  /** owner 校验（human 且 app.ownerId === userId，或持 authn.oidc.write）；机器一律 403。 */
  const requireSsoOwner = (exchange: HttpExchange): boolean => {
    const app = ssoApp(exchange)
    const info = caller(exchange)
    const isOwner = info.kind === 'human' && Boolean(info.userId) && app.ownerId === info.userId
    const isAdmin = info.permissions.includes('*') || info.permissions.includes('authn.oidc.write')
    if (info.kind !== 'human' || (!isOwner && !isAdmin)) {
      ctx.platformBus.emit('audit.authz.denied', {
        actorId: info.userId ?? info.principalId,
        actorName: info.name,
        point: `app.sso(owner:${app.id})`,
        path: exchange.path,
      })
      exchange.fail(403, 'FORBIDDEN', info.kind !== 'human'
        ? 'SSO 客户端管理仅限用户身份（owner 校验），机器身份不可操作'
        : `仅应用 owner 或持有 authn.oidc.write 的管理员可管理「${app.name}」的 SSO 客户端`)
      return false
    }
    return true
  }

  guarded('POST', '/api/apps/:id/sso-client', 'app.write', (exchange) => {
    if (!requireSsoOwner(exchange)) return
    const app = ssoApp(exchange)
    const input = body<{ redirectUris: string[]; clientType?: 'confidential' | 'public'; consentRequired?: boolean; postLogoutUris?: string[]; description?: string }>(exchange)
    const created = ctx.appRegistry.createSsoClient(app.id, input)
    changeLog(exchange, 'app.sso.create', 'oidc_client', created.client.id, created.client.name, `应用 ${app.name} 签发（${input.clientType ?? 'confidential'}）`)
    return {
      clientId: created.client.clientId,
      clientSecret: created.clientSecret,
      redirectUris: created.client.redirectUris,
      note: created.client.clientType === 'public' ? 'public 客户端无 secret（强制 PKCE、不发 refresh）' : 'clientSecret 仅此一次返回',
    }
  })

  guarded('PATCH', '/api/apps/:id/sso-client', 'app.write', (exchange) => {
    if (!requireSsoOwner(exchange)) return
    const app = ssoApp(exchange)
    const input = body<{ redirectUris?: string[]; description?: string; consentRequired?: boolean; postLogoutUris?: string[] }>(exchange)
    const updated = ctx.appRegistry.updateSsoClient(app.id, input)
    changeLog(exchange, 'app.sso.update', 'oidc_client', updated.id, updated.name)
    return updated
  })

  guarded('POST', '/api/apps/:id/sso-client/rotate', 'app.write', (exchange) => {
    if (!requireSsoOwner(exchange)) return
    const app = ssoApp(exchange)
    const rotated = ctx.appRegistry.rotateSsoSecret(app.id)
    changeLog(exchange, 'app.sso.rotate', 'oidc_client', rotated.client.id, rotated.client.name, '旧 secret 立即失效')
    return { clientId: rotated.client.clientId, clientSecret: rotated.clientSecret, note: '新 clientSecret 仅此一次返回，旧值立即失效' }
  })

  for (const action of ['disable', 'enable'] as const) {
    guarded('POST', `/api/apps/:id/sso-client/${action}`, 'app.write', (exchange) => {
      if (!requireSsoOwner(exchange)) return
      const app = ssoApp(exchange)
      const { reason } = body<{ reason?: string }>(exchange)
      const client = action === 'disable'
        ? ctx.appRegistry.disableSsoClient(app.id, reason ?? `owner 手动禁用`)
        : ctx.appRegistry.enableSsoClient(app.id)
      changeLog(exchange, `app.sso.${action}`, 'oidc_client', client.id, client.name, reason ?? '')
      return client
    })
  }

  // -- Audit / 审批 / 告警 --------------------------------------------------
  guarded('GET', '/api/audit/logs', 'audit.read', (exchange) => {
    return ctx.audit.query({
      type: (exchange.query.get('type') ?? undefined) as never,
      actorId: exchange.query.get('actorId') ?? undefined,
      resourceType: exchange.query.get('resourceType') ?? undefined,
      resourceId: exchange.query.get('resourceId') ?? undefined,
      result: exchange.query.get('result') ?? undefined,
      q: exchange.query.get('q') ?? undefined,
      since: exchange.query.get('since') ?? undefined,
      limit: Number(exchange.query.get('limit') ?? 100),
    })
  })

  guarded('GET', '/api/audit/summary', 'audit.read', () => ctx.audit.summary())

  guarded('GET', '/api/audit/alert-rules', 'audit.read', () => ({ rules: ctx.audit.alertRules().all() }))

  guarded('POST', '/api/audit/alert-rules', 'audit.rule.write', (exchange) => {
    const input = body<{ name: string; metric: string; threshold: number; windowMinutes?: number; severity?: 'critical' | 'warning' | 'info'; channels?: string[]; enabled?: boolean; description?: string }>(exchange)
    const rule = ctx.audit.createAlertRule({
      name: input.name,
      metric: input.metric,
      operator: 'gt',
      threshold: input.threshold,
      windowMinutes: input.windowMinutes ?? 10,
      severity: input.severity ?? 'warning',
      channels: input.channels ?? ['dingtalk'],
      enabled: input.enabled ?? true,
      ...(input.description !== undefined ? { description: input.description } : {}),
    })
    changeLog(exchange, 'audit.rule.create', 'alert_rule', rule.id, rule.name)
    return rule
  })

  guarded('PATCH', '/api/audit/alert-rules/:id', 'audit.rule.write', (exchange) => {
    const input = body<{ enabled?: boolean; threshold?: number; severity?: string; channels?: string[] }>(exchange)
    const rule = ctx.audit.alertRules().update(exchange.params['id']!, input as never)
    changeLog(exchange, 'audit.rule.update', 'alert_rule', rule.id, rule.name)
    return rule
  })

  guarded('GET', '/api/audit/alerts', 'audit.read', (exchange) => ({
    alerts: ctx.audit.alerts().find((item) => (exchange.query.get('unread') === '1' ? !item.read : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }))

  guarded('POST', '/api/audit/alerts/:id/read', 'audit.read', (exchange) => {
    ctx.audit.markAlertRead(exchange.params['id']!)
    return { read: true }
  })

  guarded('GET', '/api/audit/cost', 'audit.read', (exchange) => {
    return {
      groupBy: exchange.query.get('groupBy') ?? 'app',
      rows: ctx.audit.costReport((exchange.query.get('groupBy') ?? 'app') as 'app' | 'agent' | 'org' | 'date', exchange.query.get('from') ?? undefined, exchange.query.get('to') ?? undefined),
    }
  })

  // -- 租户（多租户最小集，v1.2 第 2 步） ------------------------------------
  guarded('GET', '/api/iam/tenants', 'iam.org.read', () => ({
    tenants: ctx.iam.tenants().all(),
  }))

  guarded('POST', '/api/iam/tenants', 'iam.org.write', (exchange) => {
    const input = body<{ name: string; plan?: 'trial' | 'standard' | 'enterprise' }>(exchange)
    const tenant = ctx.iam.createTenant(input)
    changeLog(exchange, 'iam.tenant.create', 'tenant', tenant.id, tenant.name)
    return tenant
  })

  // -- 计量（usage 管道，v1.2 第 2 步） --------------------------------------
  guarded('GET', '/api/usage/events', 'usage.read', (exchange) => {
    return ctx.usage.query({
      ...(exchange.query.get('tenant_id') ? { tenant_id: exchange.query.get('tenant_id')! } : {}),
      ...(exchange.query.get('principal') ? { principal: exchange.query.get('principal')! } : {}),
      ...(exchange.query.get('resource') ? { resource: exchange.query.get('resource')! } : {}),
      ...(exchange.query.get('from') ? { from: exchange.query.get('from')! } : {}),
      ...(exchange.query.get('to') ? { to: exchange.query.get('to')! } : {}),
      ...(exchange.query.get('limit') ? { limit: Number(exchange.query.get('limit')) } : {}),
    })
  })

  guarded('GET', '/api/usage/totals', 'usage.read', (exchange) => {
    return ctx.usage.totals({
      ...(exchange.query.get('tenant_id') ? { tenant_id: exchange.query.get('tenant_id')! } : {}),
      ...(exchange.query.get('principal') ? { principal: exchange.query.get('principal')! } : {}),
      ...(exchange.query.get('from') ? { from: exchange.query.get('from')! } : {}),
    })
  })

  guarded('POST', '/api/usage/record', 'usage.write', (exchange) => {
    const input = body<{ org: string; subject: string; principal: string; resource: string; meters: Array<{ key: string; value: number; unit: string }>; tenant_id?: string; trace_id?: string; idempotency_key?: string }>(exchange)
    const event = ctx.usage.record(input)
    changeLog(exchange, 'usage.record', 'usage_event', event.event_id, event.resource, `${event.meters.map((meter) => `${meter.key}=${meter.value}`).join(',')} charge=${event.pricing.charge_cents}分`)
    return event
  })

  guarded('GET', '/api/usage/price-book', 'usage.admin', () => ({
    entries: ctx.usage.priceBook().all(),
  }))

  guarded('PUT', '/api/usage/price-book', 'usage.admin', (exchange) => {
    const input = body<{ pattern: string; meter_key: string; list_cents_per_unit: number; cost_cents_per_unit: number; units_per_step: number; tax_rate?: number; currency?: string; rate_version?: string }>(exchange)
    const entry = ctx.usage.upsertPrice({ tax_rate: 0.06, currency: 'CNY', rate_version: 'v2026.08', ...input })
    changeLog(exchange, 'usage.price.upsert', 'price_entry', entry.id, entry.pattern)
    return entry
  })

  guarded('POST', '/api/usage/reconcile', 'usage.admin', (exchange) => {
    const since = exchange.query.get('from') ?? undefined
    const reconciliation = ctx.usage.reconcile(since)
    const drift = ctx.usage.capabilityDrift(since)
    changeLog(exchange, 'usage.reconcile', 'usage', 'reconcile', '', `mismatch=${reconciliation.mismatch} drift=${drift.drift.length}`)
    return { reconciliation, drift }
  })

  guarded('GET', '/api/usage/dead-letters', 'usage.admin', () => ({
    items: ctx.usage.deadLetters().all(),
  }))

  guarded('POST', '/api/usage/replay', 'usage.admin', (exchange) => {
    const { from } = body<{ from: string }>(exchange)
    return ctx.usage.replay(from)
  })

  guarded('POST', '/api/usage/dead-letters/retry', 'usage.admin', (exchange) => {
    const result = ctx.usage.retryDeadLetters()
    changeLog(exchange, 'usage.deadletter.retry', 'usage', 'dead-letters', '', `重投 ${result.retried} 条，剩余 ${result.remaining} 条`)
    return result
  })

  guarded('PUT', '/api/usage/capability-grants', 'usage.admin', (exchange) => {
    const input = body<{ principal: string; capabilities: string[]; source?: string }>(exchange)
    return ctx.usage.grantCapabilities(input.principal, input.capabilities, input.source ?? 'console')
  })

  // -- 第三方插件市场（v1.2 第 3/5/7 步） ------------------------------------

  // 开发者自助注册（独立身份域，M2）：Ed25519 公钥 + 密码
  http.register('POST', '/api/market/developers/register', async (exchange) => {
    const input = body<{ username: string; displayName: string; email: string; password: string; publicKey: string; company?: string; payoutAccount?: string }>(exchange)
    try {
      const result = ctx.market.registerDeveloper(input)
      const { passwordHash, passwordSalt, ...safe } = result.developer
      void passwordHash
      void passwordSalt
      exchange.ok({ developer: safe, token: result.token })
    } catch (error) {
      exchange.fail(400, 'DEVELOPER_REGISTER_FAILED', error instanceof Error ? error.message : String(error))
    }
  })

  http.register('POST', '/api/market/developers/login', async (exchange) => {
    const input = body<{ username: string; password: string }>(exchange)
    try {
      const result = ctx.market.loginDeveloper(input.username, input.password)
      exchange.ok({ developer: { id: result.developer.id, username: result.developer.username, displayName: result.developer.displayName }, token: result.token })
    } catch (error) {
      exchange.fail(401, 'DEVELOPER_LOGIN_FAILED', error instanceof Error ? error.message : String(error))
    }
  })

  /** 开发者身份解析：机器主体 refId=developerId（独立身份域，与 iam 员工域分离）。 */
  const developerCaller = (exchange: HttpExchange) => {
    const info = caller(exchange)
    if (info.permissions.includes('*')) return undefined // 管理员走管理路由
    const developer = ctx.market.developerOfPrincipal(info.principalId)
    if (!developer) throw new Error('当前令牌不是开发者身份（请用 /api/market/developers/login）')
    return developer
  }

  http.register('POST', '/api/market/submit', async (exchange) => {
    try {
      const developer = developerCaller(exchange)
      if (!developer) {
        exchange.fail(403, 'FORBIDDEN', '插件提交仅限开发者身份')
        return
      }
      const input = body<{ files: Record<string, string>; signature: string }>(exchange)
      const record = ctx.market.submit(developer, input.files ?? {}, input.signature ?? '')
      changeLog(exchange, 'market.plugin.submit', 'plugin_submission', record.id, `${record.pluginId}@${record.version}`)
      const { files, parsed, ...safe } = record
      void files
      void parsed
      exchange.ok(safe)
    } catch (error) {
      exchange.fail(400, 'MARKET_SUBMIT_FAILED', error instanceof Error ? error.message : String(error))
    }
  })

  guarded('GET', '/api/market/submissions/mine', 'market.developer', (exchange) => {
    const developer = developerCaller(exchange)
    return { submissions: ctx.market.submissions().find((item) => item.developerId === developer?.id) }
  })

  guarded('GET', '/api/market/submissions', 'market.approve', (exchange) => ({
    submissions: ctx.market.submissions().find((item) =>
      exchange.query.get('status') ? item.status === exchange.query.get('status') : true),
  }))

  guarded('POST', '/api/market/submissions/:id/approve', 'market.approve', (exchange) => {
    const info = caller(exchange)
    const { opinion } = body<{ opinion?: string }>(exchange)
    const record = ctx.market.approve(exchange.params['id']!, info.name, opinion ?? '审核通过')
    changeLog(exchange, 'market.plugin.approve', 'plugin_submission', record.id, `${record.pluginId}@${record.version}`)
    return record
  })

  guarded('POST', '/api/market/submissions/:id/reject', 'market.approve', (exchange) => {
    const info = caller(exchange)
    const { reason } = body<{ reason?: string }>(exchange)
    return ctx.market.reject(exchange.params['id']!, info.name, reason ?? '不通过')
  })

  guarded('GET', '/api/market/plugins', 'market.read', () => ({
    plugins: ctx.market.listed().map((item) => ({
      id: item.id, pluginId: item.pluginId, version: item.version, developer: item.developerName,
      capabilities: item.parsed.capabilities_request, permissions: item.parsed.permissions.requested,
      billing: item.parsed.billing, installs: item.installs, contentHash: item.contentHash,
    })),
  }))

  guarded('POST', '/api/market/plugins/:pluginId/install', 'market.install', (exchange) => {
    const info = caller(exchange)
    const input = body<{ orgId: string; tenantId?: string; approvedCapabilities: string[]; approvedPermissions?: string[] }>(exchange)
    const org = ctx.iam.orgs().get(input.orgId)
    if (!org) throw new Error(`组织不存在：${input.orgId}`)
    const tenantId = input.tenantId ?? org.tenantId ?? 't_default'
    const record = ctx.market.install({
      pluginId: exchange.params['pluginId']!,
      orgId: input.orgId,
      tenantId,
      approvedCapabilities: input.approvedCapabilities ?? [],
      approvedPermissions: input.approvedPermissions ?? [],
      installedBy: info.name,
    })
    changeLog(exchange, 'market.plugin.install', 'plugin_install', record.id, record.pluginId, `能力审批：${record.capabilities.join(',')}`)
    return record
  })

  guarded('GET', '/api/market/installed', 'market.read', (exchange) => ({
    installs: ctx.market.installs().find((item) => {
      const orgId = exchange.query.get('orgId')
      return orgId ? item.orgId === orgId : true
    }),
  }))

  guarded('POST', '/api/market/plugins/:pluginId/uninstall', 'market.install', (exchange) => {
    const info = caller(exchange)
    const { orgId } = body<{ orgId: string }>(exchange)
    const record = ctx.market.uninstall(exchange.params['pluginId']!, orgId, info.name)
    changeLog(exchange, 'market.plugin.uninstall', 'plugin_install', record.id, record.pluginId)
    return record
  })

  guarded('GET', '/api/market/subscriptions', 'market.read', () => ({
    subscriptions: ctx.market.subscriptions().all(),
  }))

  guarded('GET', '/api/market/prompts', 'market.read', (exchange) => {
    const orgId = exchange.query.get('orgId') ?? ''
    return { prompts: ctx.market.promptPacks(orgId) }
  })

  guarded('POST', '/api/market/prompts/use', 'market.read', (exchange) => {
    const info = caller(exchange)
    const input = body<{ orgId: string; pluginId: string; promptName: string }>(exchange)
    ctx.market.meterPromptUse(input.orgId, input.pluginId, input.promptName, info.kind === 'human' ? `user:${info.userId ?? info.principalId}` : `app:${info.principalId}`)
    return { metered: true }
  })

  // 沙箱边界自检：轻量代理 ctx + 总线 source 校验的强制语义（插件开发者联调用）
  guarded('POST', '/api/market/sandbox-check', 'market.read', (exchange) => {
    const input = body<{ pluginId?: string; capabilities?: string[] }>(exchange)
    const pluginId = input.pluginId ?? 'com.selftest.probe'
    const capabilities = input.capabilities ?? ['knowledgebase.read']
    const results: Record<string, string> = {}
    const pctx = createPluginContext(ctx, { pluginId, capabilities })
    try { pctx.platformBus.emit(`plugin:${pluginId}:probe`, { check: true }); results.emitOwnNamespace = 'ok' } catch (error) { results.emitOwnNamespace = `blocked:${error instanceof Error ? error.message : String(error)}` }
    try { pctx.platformBus.emit('iam.user.frozen', { check: true }); results.emitPlatformViaProxy = 'UNEXPECTEDLY_ALLOWED' } catch { results.emitPlatformViaProxy = 'blocked' }
    try { ctx.platformBus.emit('iam.user.frozen', { check: true }, { source: `plugin:${pluginId}` }); results.directEmitReserved = 'UNEXPECTEDLY_ALLOWED' } catch { results.directEmitReserved = 'blocked' }
    try { ctx.platformBus.emit(`plugin:${pluginId}:forged`, { check: true }); results.pluginEventWithoutSource = 'UNEXPECTEDLY_ALLOWED' } catch { results.pluginEventWithoutSource = 'blocked' }
    try { pctx.service('usage'); results.serviceWithoutCapability = 'UNEXPECTEDLY_ALLOWED' } catch { results.serviceWithoutCapability = 'blocked' }
    const pctxGranted = createPluginContext(ctx, { pluginId, capabilities: [...capabilities, 'usage.meter'] })
    try { pctxGranted.service('usage'); results.serviceWithCapability = 'ok' } catch (error) { results.serviceWithCapability = `blocked:${error instanceof Error ? error.message : String(error)}` }
    return { pluginId, capabilities, results }
  })

  // -- 钱包与计费（v1.2 第 5/8 步） -----------------------------------------
  guarded('GET', '/api/billing/wallets/:ownerType/:ownerId', 'billing.read', (exchange) => ({
    ownerType: exchange.params['ownerType'],
    ownerId: exchange.params['ownerId'],
    balanceCents: ctx.billing.balance(exchange.params['ownerType']! as 'org', exchange.params['ownerId']!),
    monthSpentCents: exchange.params['ownerType'] === 'org' ? ctx.billing.monthSpent(exchange.params['ownerId']!) : undefined,
  }))

  guarded('POST', '/api/billing/recharge', 'billing.write', (exchange) => {
    const info = caller(exchange)
    const input = body<{ ownerType?: 'org' | 'developer' | 'platform'; ownerId: string; tenantId?: string; amountCents: number; channelRef: string; idempotencyKey: string }>(exchange)
    const result = ctx.billing.recharge({
      ownerType: input.ownerType ?? 'org',
      ownerId: input.ownerId,
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
      amountCents: input.amountCents,
      channelRef: input.channelRef,
      idempotencyKey: input.idempotencyKey,
      actor: info.name,
    })
    changeLog(exchange, 'billing.recharge', 'wallet', `${input.ownerType ?? 'org'}:${input.ownerId}`, '', `+${input.amountCents} 分（${input.channelRef}）`)
    return result
  })

  guarded('GET', '/api/billing/journal', 'billing.read', (exchange) => ({
    entries: ctx.billing.journal({
      ...(exchange.query.get('ownerType') ? { ownerType: exchange.query.get('ownerType')! } : {}),
      ...(exchange.query.get('ownerId') ? { ownerId: exchange.query.get('ownerId')! } : {}),
      ...(exchange.query.get('tenantId') ? { tenantId: exchange.query.get('tenantId')! } : {}),
      ...(exchange.query.get('limit') ? { limit: Number(exchange.query.get('limit')) } : {}),
    }),
  }))

  guarded('POST', '/api/billing/verify', 'billing.read', () => ctx.billing.verifyIntegrity())

  guarded('PUT', '/api/billing/budgets/:orgId', 'billing.write', (exchange) => {
    const info = caller(exchange)
    const { monthlyCents } = body<{ monthlyCents: number }>(exchange)
    const record = ctx.billing.setBudget(exchange.params['orgId']!, monthlyCents, info.name)
    changeLog(exchange, 'billing.budget.set', 'budget', record.orgId, '', `${monthlyCents} 分/月`)
    return record
  })

  guarded('GET', '/api/billing/budgets/:orgId', 'billing.read', (exchange) => ({
    orgId: exchange.params['orgId'],
    budget: ctx.billing.budgets().findOne((item) => item.orgId === exchange.params['orgId']) ?? null,
    monthSpentCents: ctx.billing.monthSpent(exchange.params['orgId']!),
  }))

  guarded('POST', '/api/billing/settle', 'billing.admin', (exchange) => {
    const info = caller(exchange)
    const { period } = body<{ period: string }>(exchange)
    const result = ctx.billing.settle(period, info.name)
    changeLog(exchange, 'billing.ledger.settle', 'ledger', period, '', `分录 ${result.entries} 条，借=${result.debitCents} 贷=${result.creditCents}`)
    return result
  })

  guarded('GET', '/api/billing/ledger', 'billing.read', (exchange) => {
    const period = exchange.query.get('period') ?? undefined
    return { entries: ctx.billing.ledger(period), trial: period ? ctx.billing.trialBalance(period) : undefined }
  })

  guarded('POST', '/api/billing/ledger/reverse', 'billing.admin', (exchange) => {
    const info = caller(exchange)
    const { period, reason } = body<{ period: string; reason: string }>(exchange)
    const result = ctx.billing.reverse(period, reason, info.name)
    changeLog(exchange, 'billing.ledger.reverse', 'ledger', period, '', `红字冲正：${reason}`)
    return result
  })

  // -- 模型网关（v1.2 第 5 步：L1 模型转售） ---------------------------------
  guarded('GET', '/api/modelgw/models', 'modelgw.read', () => ({
    models: ctx.modelGateway.models().all().map((item) => ({ ...item, apiKey: item.apiKey.startsWith('env:') ? item.apiKey : '***' })),
  }))

  guarded('POST', '/api/modelgw/models', 'modelgw.admin', (exchange) => {
    const input = body<{ slug: string; displayName?: string; provider?: string; endpoint: string; apiKey?: string; listCentsPerKTokens: number; costCentsPerKTokens?: number; status?: 'online' | 'offline' }>(exchange)
    const model = ctx.modelGateway.upsertModel({
      slug: input.slug,
      displayName: input.displayName ?? input.slug,
      provider: input.provider ?? 'external',
      endpoint: input.endpoint,
      apiKey: input.apiKey ?? 'env:MODEL_API_KEY',
      listCentsPerKTokens: input.listCentsPerKTokens,
      costCentsPerKTokens: input.costCentsPerKTokens ?? Math.floor(input.listCentsPerKTokens / 2),
      status: input.status ?? 'online',
    })
    changeLog(exchange, 'modelgw.model.upsert', 'model', model.id, model.slug)
    return model
  })

  guarded('POST', '/api/modelgw/invoke', 'modelgw.invoke', async (exchange) => {
    const info = caller(exchange)
    const input = body<{ model: string; messages: Array<{ role: string; content: string }>; orgId?: string; maxTokens?: number; temperature?: number }>(exchange)
    // 默认计费组织：调用者所属组织（人）或凭证组织（机器）
    const orgId = input.orgId
      ?? (info.kind === 'human' && info.userId ? ctx.iam.users().get(info.userId)?.orgId : undefined)
    if (!orgId) throw new Error('未指定计费组织（orgId），且调用者无可归属组织')
    const subject = info.kind === 'human' ? `user:${info.userId ?? info.principalId}` : `app:${info.principalId}`
    return await ctx.modelGateway.invoke({
      model: input.model,
      messages: input.messages,
      orgId,
      subject,
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    })
  })

  guarded('GET', '/api/approvals', 'approval.read', () => ({
    approvals: ctx.audit.approvals().all().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }))

  guarded('POST', '/api/approvals/:id/decide', 'approval.decide', async (exchange) => {
    const { decision, opinion } = body<{ decision: 'approve' | 'reject'; opinion?: string }>(exchange)
    const info = caller(exchange)
    const record = await ctx.audit.decideApproval(exchange.params['id']!, decision, info.userId ?? info.principalId, info.name, opinion)
    return record
  })

  // -- 平台信息与工具桥 -----------------------------------------------------
  guarded('GET', '/api/platform/info', 'console.login', () => {
    const versionInfo = platformVersionInfo()
    const plugins = [
      'platform-core', 'resource-core', 'iam', 'authn', 'usage', 'billing', 'audit', 'market', 'modelgw', 'mcp', 'nas', 'skillhub', 'agent', 'app', 'connect', 'update', 'console',
    ]
    return {
      name: '榕器|企业AI资源治理平台',
      version: versionInfo.version,
      installMode: versionInfo.installMode,
      runtime: 'standalone-cordis（dsh 插件兼容）',
      plugins,
      collections: ctx.opsStorage.names(),
      tools: ctx.tools.schemas(),
      resourceTypes: ctx.resourceCore.typesSpecs().map((spec) => ({ type: spec.type, label: spec.label, plugin: spec.plugin })),
      events: ctx.platformBus.recent(10),
    }
  })

  /**
   * 工具身份注入：服务端以令牌解析的调用者身份为准，禁止调用方自填身份参数。
   * REST 工具桥与 /mcp 端点（平台 MCP Server）共用同一套注入规则。
   */
  const injectToolIdentity = (name: string, inputArgs: Record<string, unknown>, info: CallerInfo): Record<string, unknown> => {
    const args = { ...inputArgs }
    const principalId = info.userId ?? info.principalId
    if (name === 'mcp_invoke') {
      args.callerType = 'user'
      args.callerId = principalId
      args.callerName = info.name
    } else if (name === 'approval_decide' || name === 'skill_approve') {
      args.approverId = principalId
      args.approverName = info.name
    } else if (name === 'agent_offline' || name === 'mcp_offline' || name === 'iam_sync_run') {
      args.requesterId = principalId
      args.requesterName = info.name
      args.actor = info.name
    } else if (name === 'agent_bind_user' || name === 'skill_install' || name === 'skill_publish') {
      args.actor = info.name
    } else if (name.startsWith('nas_fs_')) {
      // NAS 写类工具的操作人不可自填（读类工具无身份参数）
      args.actorId = principalId
      args.actorName = info.name
    }
    return args
  }

  guarded('POST', '/api/tools/execute', 'console.login', async (exchange) => {
    const input = body<{ name: string; args?: Record<string, unknown> }>(exchange)
    if (!input.name) throw new Error('工具名必填')
    const info = caller(exchange)
    // 工具级权限校验：以工具声明的最小权限点为准，缺省仅要求登录
    const definition = ctx.tools.schemas().find((tool) => tool.name === input.name)
    const required = definition?.permission
    if (required && !info.permissions.includes('*') && !info.permissions.includes(required)) {
      ctx.platformBus.emit('audit.authz.denied', {
        actorId: info.userId ?? info.principalId,
        actorName: info.name,
        point: required,
        path: exchange.path,
      })
      exchange.fail(403, 'FORBIDDEN', `缺少权限点 ${required}，请联系管理员调整角色`, { permission: required })
      return
    }
    const args = injectToolIdentity(input.name, input.args ?? {}, info)
    const result = await ctx.tools.execute({ name: input.name, arguments: args })
    return result
  })

  // -- MCP Server 端点：平台即 MCP 服务（与 REST/CLI/dsh 插件同一套工具与权限体系） ------
  //
  // Streamable HTTP（JSON-RPC 2.0 over POST /mcp）：initialize（回 mcp-session-id，无状态
  // 服务端会话仅为客户端兼容）/ notifications/*（202）/ tools/list / tools/call / ping。
  // 每请求 Bearer 鉴权（人/机器令牌皆可），工具级权限点 + 身份注入与 REST 工具桥完全一致。
  // 不提供 GET SSE 长流（纯 JSON 响应形态合规）；外部 MCP 客户端接入示例：
  //   {"mcpServers":{"dsh-ops-platform":{"url":"http://<平台>:7300/mcp","headers":{"Authorization":"Bearer <平台令牌>"}}}}
  const mcpCallerFromToken = (exchange: HttpExchange): CallerInfo | undefined => {
    const header = String(exchange.headers['authorization'] ?? '')
    if (!header.startsWith('Bearer ')) {
      exchange.res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="dsh-ops-mcp"',
      })
      exchange.res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: '缺少 Bearer 令牌：/mcp 与 REST 共用同一套平台令牌' } }))
      return undefined
    }
    try {
      const verified = ctx.authn.verify(header.slice(7))
      return {
        kind: verified.principal.type,
        principalId: verified.principal.id,
        ...(verified.principal.type === 'human' && verified.principal.refId ? { userId: verified.principal.refId } : {}),
        name: verified.principal.name,
        permissions: verified.scopes,
        actChain: verified.actChain,
      } satisfies CallerInfo
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.res.writeHead(401, { 'content-type': 'application/json' })
      exchange.res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: `令牌无效：${message}` } }))
      return undefined
    }
  }

  const mcpReply = (exchange: HttpExchange, payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}): void => {
    exchange.res.writeHead(200, { 'content-type': 'application/json', ...extraHeaders })
    exchange.res.end(JSON.stringify(payload))
  }

  http.register('POST', '/mcp', async (exchange) => {
    const info = mcpCallerFromToken(exchange)
    if (!info) return
    const message = exchange.body
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      exchange.res.writeHead(400, { 'content-type': 'application/json' })
      exchange.res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '请求体必须是单个 JSON-RPC 2.0 消息（暂不支持批量）' } }))
      return
    }
    const id = (message as Record<string, unknown>).id
    // 通知类消息（无 id）：确认即止
    if (id === undefined || id === null) {
      exchange.res.writeHead(202)
      exchange.res.end()
      return
    }
    const method = String((message as Record<string, unknown>).method ?? '')
    const params = ((message as Record<string, unknown>).params ?? {}) as Record<string, unknown>
    const reply = (result: unknown, extraHeaders?: Record<string, string>) => mcpReply(exchange, { jsonrpc: '2.0', id, result }, extraHeaders)
    const replyError = (code: number, text: string) => mcpReply(exchange, { jsonrpc: '2.0', id, error: { code, message: text } })
    switch (method) {
      case 'initialize':
        return reply(
          {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'dsh-ops-platform', title: '榕器|企业AI资源治理平台 · MCP 网关', version: platformVersionInfo().version },
            instructions: '榕器|企业AI资源治理平台（IAM/MCP/Skill/Agent/应用/NAS/计量计费/审计）。工具权限与控制台账号一致：先用 nas_list / mcp_service_list / skill_search 等盘点资产，再按需调用写类工具。',
          },
          { 'mcp-session-id': `dshmcp-${Date.now().toString(36)}` },
        )
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({
          tools: ctx.tools.schemas().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
            ...(tool.permission !== undefined ? { annotations: { 'x-permission': tool.permission } } : {}),
          })),
        })
      case 'tools/call': {
        const name = String(params.name ?? '')
        const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>
        const definition = ctx.tools.schemas().find((tool) => tool.name === name)
        if (!definition) {
          return reply({ content: [{ type: 'text', text: `未知工具：${name}` }], isError: true })
        }
        if (definition.permission && !info.permissions.includes('*') && !info.permissions.includes(definition.permission)) {
          ctx.platformBus.emit('audit.authz.denied', {
            actorId: info.userId ?? info.principalId,
            actorName: info.name,
            point: definition.permission,
            path: '/mcp',
          })
          return reply({ content: [{ type: 'text', text: `缺少权限点 ${definition.permission}（调用方 ${info.name}），调用被拒绝` }], isError: true })
        }
        const result = await ctx.tools.execute({ name, arguments: injectToolIdentity(name, args, info) })
        return reply({
          content: result.content.length > 0 ? result.content : [{ type: 'text', text: JSON.stringify(result.value ?? null) }],
          isError: result.isError,
        })
      }
      default:
        return replyError(-32601, `方法不存在：${method}`)
    }
  })

  // Streamable HTTP：本端点为无会话纯 JSON 形态，GET（SSE 长流）不支持，DELETE（会话终止）恒成功
  http.register('GET', '/mcp', (exchange) => {
    exchange.res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
    exchange.res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: '本 MCP 端点为无会话纯 JSON 形态，不支持 GET SSE 长流' } }))
  })
  http.register('DELETE', '/mcp', (exchange) => {
    exchange.ok({})
  })

  // -- 静态 SPA -----------------------------------------------------------
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
  if (existsSync(publicDir)) {
    http.serveStatic('/', publicDir, '/index.html')
  }

  // -- 拓扑节点名称补全（skill 等非 resource-core 类型） ----------------------
  const enrichTopology = (node: any): any => ({
    ...node,
    name: node.type === 'skill'
      ? ctx.skillHub.skills().get(node.id)?.name ?? node.name
      : node.type === 'mcp_service'
        ? ctx.mcpRegistry.services().get(node.id)?.name ?? node.name
        : node.name,
    status: node.type === 'skill'
      ? ctx.skillHub.skills().get(node.id)?.status ?? node.status
      : node.status,
    children: node.children.map(enrichTopology),
  })
  // -- 种子数据 -----------------------------------------------------------
  void seedAll(ctx)
}

function decorateUser(ctx: Context, user: any) {
  const { passwordHash, passwordSalt, ...safe } = user
  void passwordHash
  void passwordSalt
  return {
    ...safe,
    orgName: ctx.iam.orgs().get(user.orgId)?.name ?? '',
    roles: user.roleIds.map((roleId: string) => ctx.iam.roles().get(roleId)).filter(Boolean),
  }
}

function summarize(payload: unknown): string {
  if (payload === null || payload === undefined) return ''
  if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    for (const key of ['name', 'title', 'reason', 'message', 'version', 'actorName']) {
      if (typeof record[key] === 'string') return String(record[key])
    }
    return JSON.stringify(payload).slice(0, 80)
  }
  return String(payload).slice(0, 80)
}

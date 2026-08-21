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
import type { HttpExchange } from '@dsh-ops/platform-core'
import { PermissionCatalog } from '@dsh-ops/plugin-iam'
import { seedAll } from './seed.ts'

export const name = 'console'
export const inject = [
  'httpServer', 'storage', 'platformBus', 'tools',
  'iam', 'authn', 'audit', 'mcpRegistry', 'skillHub', 'resourceCore', 'agentRegistry', 'appRegistry',
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
  '/api/auth/client-credentials',
  '/api/health',
])

export function apply(ctx: Context) {
  const http = ctx.httpServer

  // -- 鉴权中间件 ---------------------------------------------------------
  http.use((exchange) => {
    if (!exchange.path.startsWith('/api/') || PUBLIC_PATHS.has(exchange.path)) return
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

  http.register('POST', '/api/auth/sso', async (exchange) => {
    const { provider, code } = body<{ provider: string; code: string }>(exchange)
    try {
      const result = ctx.authn.loginByThirdParty(provider ?? 'dingtalk', code)
      const user = ctx.iam.users().get(result.userId)!
      exchange.ok({
        token: result.token,
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
      exchange.fail(401, 'SSO_FAILED', message)
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

  http.register('POST', '/api/auth/logout', (exchange) => {
    const header = String(exchange.headers['authorization'] ?? '')
    const token = header.slice(7)
    try {
      const verified = ctx.authn.verify(token)
      ctx.authn.revokeToken(verified.token.jti, '用户主动登出')
    } catch { /* 令牌已失效也允许登出 */ }
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
    const input = body<{ username: string; displayName: string; orgId: string; title?: string; email?: string; phone?: string; roleIds?: string[] }>(exchange)
    const user = ctx.iam.createUser(input)
    if (input.roleIds?.length) ctx.iam.assignRoles(user.id, input.roleIds)
    ctx.iam.activateUser(user.id)
    changeLog(exchange, 'iam.user.create', 'user', user.id, user.displayName)
    return decorateUser(ctx, ctx.iam.users().get(user.id)!)
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
    const input = body<{ corpId: string; appKey: string; appSecret?: string; enabled?: boolean; syncOrgRoot?: string; intervalMinutes?: number; callbackUrl?: string; loginEnabled?: boolean; conflictStrategy?: 'third_party_wins' | 'platform_wins' | 'manual' }>(exchange)
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

  guarded('POST', '/api/authn/principals', 'authn.principal.write', (exchange) => {
    const input = body<{ name: string; refType?: 'agent' | 'app' | 'external'; refId?: string; scopes: string[] }>(exchange)
    const created = ctx.authn.createMachineCredential(input)
    changeLog(exchange, 'authn.principal.create', 'principal', created.principal.id, input.name)
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
      tokens: tokens.slice(0, 200).map((token) => ({
        ...token,
        principalName: ctx.authn.principals().get(token.principalId)?.name ?? '',
      })),
    }
  })

  guarded('POST', '/api/authn/tokens', 'authn.token.issue', (exchange) => {
    const input = body<{ principalId: string; ttlHours?: number; reason?: string }>(exchange)
    const principal = ctx.authn.principals().get(input.principalId)
    if (!principal) throw new Error(`身份不存在：${input.principalId}`)
    const { token, record } = ctx.authn.issueToken(input.principalId, {
      kind: 'access',
      ttlHours: input.ttlHours,
      scopes: principal.scopes,
      issuedBy: `console:${caller(exchange).name}`,
    })
    changeLog(exchange, 'authn.token.issue', 'token', record.jti, record.jti, input.reason ?? '')
    return { token, jti: record.jti, expiresAt: record.expiresAt }
  })

  guarded('DELETE', '/api/authn/tokens/:jti', 'authn.token.revoke', (exchange) => {
    const { reason } = body<{ reason?: string }>(exchange)
    const record = ctx.authn.revokeToken(exchange.params['jti']!, reason ?? '控制台吊销')
    changeLog(exchange, 'authn.token.revoke', 'token', record.jti, record.jti, reason ?? '')
    return record
  })

  guarded('POST', '/api/authn/rotate-secret', 'authn.token.revoke', (exchange) => {
    ctx.authn.rotateSigningSecret()
    changeLog(exchange, 'authn.secret.rotate', 'platform', 'signing-secret', '', '签名密钥轮换，全部存量令牌失效')
    return { rotated: true }
  })

  // -- MCP ----------------------------------------------------------------
  guarded('GET', '/api/mcp/services', 'mcp.service.read', () => ({
    services: ctx.mcpRegistry.services().all(),
    overview: ctx.mcpRegistry.metricsOverview(),
  }))

  guarded('POST', '/api/mcp/services', 'mcp.service.write', (exchange) => {
    const input = body<{ name: string; slug?: string; description?: string; icon?: string; endpoint?: string; transport?: 'stdio' | 'sse' | 'http'; mode?: 'hosted' | 'external'; orgId: string; tools?: Array<{ name: string; description: string; riskLevel?: 'read' | 'write' | 'admin' }> }>(exchange)
    const service = ctx.mcpRegistry.createService({
      ...input,
      owner: caller(exchange).name,
      tools: input.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        riskLevel: tool.riskLevel ?? 'read',
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      })),
    })
    changeLog(exchange, 'mcp.service.create', 'mcp_service', service.id, service.name)
    return service
  })

  guarded('PATCH', '/api/mcp/services/:id', 'mcp.service.write', (exchange) => {
    const service = ctx.mcpRegistry.updateService(exchange.params['id']!, body(exchange))
    changeLog(exchange, 'mcp.service.update', 'mcp_service', service.id, service.name)
    return service
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
    const input = body<{ name: string; category?: string; tags?: string[]; summary?: string; description?: string; content: string; version?: string; changelog?: string; visibility?: 'all' | 'orgs' | 'groups'; applicableModels?: string[]; deps?: string[] }>(exchange)
    const info = caller(exchange)
    const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
    const skill = ctx.skillHub.submit({
      ...input,
      authorId: info.userId ?? info.principalId,
      authorName: info.name,
      orgId: user?.orgId ?? 'org_unknown',
    })
    return { id: skill.id, status: skill.status, findings: skill.versions.at(-1)?.findings ?? [] }
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

  guarded('POST', '/api/skills/:id/publish', 'skill.publish', (exchange) => {
    const { version } = body<{ version?: string }>(exchange)
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    const result = ctx.skillHub.publish(skill.id, version ?? skill.currentVersion, caller(exchange).name)
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
    return {
      ...app,
      metrics: ctx.appRegistry.metrics(id),
      topology: enrichTopology(ctx.appRegistry.topology(id)),
      cost: ctx.appRegistry.costBreakdown(id),
      impact: ctx.resourceCore.impact('app', id),
      availableTransitions: ctx.resourceCore.availableTransitions('app', id),
      audit: ctx.audit.query({ resourceType: 'app', resourceId: id, limit: 30 }).items,
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
    if (action === 'archive') return ctx.resourceCore.transition('app', id, 'archive', info.name).entity
    throw new Error(`未知操作：${action}`)
  })

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
    const plugins = [
      'platform-core', 'resource-core', 'iam', 'authn', 'audit', 'mcp', 'skillhub', 'agent', 'app', 'console',
    ]
    return {
      name: '企业 AI 资源统一管理平台',
      version: '1.0.0',
      runtime: 'standalone-cordis（dsh 插件兼容）',
      plugins,
      collections: ctx.storage.names(),
      tools: ctx.tools.schemas(),
      resourceTypes: ctx.resourceCore.typesSpecs().map((spec) => ({ type: spec.type, label: spec.label, plugin: spec.plugin })),
      events: ctx.platformBus.recent(10),
    }
  })

  guarded('POST', '/api/tools/execute', 'console.login', async (exchange) => {
    const input = body<{ name: string; args?: Record<string, unknown> }>(exchange)
    if (!input.name) throw new Error('工具名必填')
    const result = await ctx.tools.execute({ name: input.name, arguments: input.args ?? {} })
    return result
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

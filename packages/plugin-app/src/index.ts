/**
 * @dsh-ops/plugin-app —— AI 应用本体管理（方案 §六）。
 *
 * 复用 resource-core 底座与生命周期，差异部分以扩展 schema 实现：
 * 应用形态/访问入口/发布渠道/Agent 编排拓扑（应用 → Agent → MCP/Skill 一图穿透）。
 * 应用层指标：DAU/MAU、会话深度、留存；成本链路：应用 → Agent → MCP/模型 穿透归集。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import {
  PlatformEvents, newId,
  type Collection, type RecordBase, type ResourceTypeSpec, type TopologyNode,
} from '../../platform-core/src/index.ts'
import { OidcService } from '../../plugin-authn/src/oidc.ts'
import * as appTools from './tools.ts'
import { APP_TYPE_SPEC } from './schema.ts'

export interface AppUsageRecord extends RecordBase {
  appId: string
  date: string
  dau: number
  sessions: number
  avgDepth: number
  retention7: number
}

export class AppRegistryService extends Service {
  static readonly provide = 'appRegistry'

  constructor(ctx: Context) {
    super(ctx, 'appRegistry')
    ctx.resourceCore.registerType(APP_TYPE_SPEC)
  }

  usage(): Collection<AppUsageRecord> {
    return this.ctx.opsStorage.collection<AppUsageRecord>('app:usage')
  }

  register(input: {
    name: string
    slug?: string
    attrs?: Record<string, unknown>
    ownerId: string
    ownerName: string
    orgId: string
    agentIds?: string[]
    withCredential?: boolean
  }) {
    const agentIds = input.agentIds ?? (Array.isArray(input.attrs?.['agentIds']) ? input.attrs!['agentIds'] as string[] : [])
    for (const agentId of agentIds) {
      const agent = this.ctx.resourceCore.get('agent', agentId)
      if (!agent) throw new Error(`编排的 Agent 不存在：${agentId}`)
      if (agent.status !== 'online') throw new Error(`Agent「${agent.name}」未上线，不能被应用编排`)
    }
    const attrs = { ownerName: input.ownerName, ...(input.attrs ?? {}) }
    const app = this.ctx.resourceCore.create('app', { ...input, attrs })
    this.syncAgentDependencies(app.id, agentIds)
    let credential
    if (input.withCredential !== false) {
      credential = this.ctx.authn.createMachineCredential({
        name: `app:${(app as any).slug}`,
        refType: 'app',
        refId: app.id,
        scopes: ['mcp.invoke', 'agent.read', 'skill.read'],
      })
    }
    this.ctx.platformBus.emit(PlatformEvents.AppRegistered, { id: app.id, name: app.name, actor: input.ownerId, type: 'app', slug: app.slug })
    return { app, credential }
  }

  updateApp(appId: string, patch: { name?: string; attrs?: Record<string, unknown> }) {
    const updated = this.ctx.resourceCore.update('app', appId, patch)
    const agentIds = Array.isArray(updated.attrs['agentIds']) ? updated.attrs['agentIds'] as string[] : []
    this.syncAgentDependencies(appId, agentIds)
    this.ctx.platformBus.emit(PlatformEvents.AppUpdated, { id: appId, name: updated.name, actor: 'console' })
    return updated
  }

  /** 应用 → Agent 依赖图维护（编排拓扑数据源）。 */
  private syncAgentDependencies(appId: string, agentIds: string[]): void {
    const existing = this.ctx.resourceCore.dependencies().find((record) => record.fromType === 'app' && record.fromId === appId && record.kind === 'agent')
    const keep = new Set(agentIds)
    for (const record of existing) {
      if (!keep.has(record.toId)) {
        this.ctx.resourceCore.removeDependency({ fromType: 'app', fromId: appId, toType: 'agent', toId: record.toId })
      } else {
        keep.delete(record.toId)
      }
    }
    for (const agentId of keep) {
      this.ctx.resourceCore.addDependency({ fromType: 'app', fromId: appId, toType: 'agent', toId: agentId, kind: 'agent' })
    }
  }

  /** 依赖拓扑可视化：应用 → Agent → MCP/Skill 一图穿透，异常节点可标注。 */
  topology(appId: string): TopologyNode {
    return this.ctx.resourceCore.topology('app', appId, 3)
  }

  // -- 生命周期（同 Agent：L4 审批） --------------------------------------

  requestOnline(appId: string, requester: { id: string; name: string }) {
    const app = this.ctx.resourceCore.get('app', appId)
    if (!app) throw new Error(`应用不存在：${appId}`)
    const errors = this.ctx.resourceCore.validateAttrs('app', app.attrs, 'online')
    if (errors.length > 0) throw new Error(`上线条件不满足：${errors.join('；')}`)
    // 上线门禁（点 1，早反馈）：门禁形态（默认 web,h5）必须有 active SSO 客户端
    const ssoClientId = this.checkSsoGate(app)
    return this.ctx.audit.createApproval({
      kind: 'app.online',
      title: `AI 应用上线：${app.name}`,
      payload: { appId, requesterId: requester.id, ...(ssoClientId !== undefined ? { ssoClientId } : {}) },
      requesterId: requester.id,
      requesterName: requester.name,
    })
  }

  /** SSO 门禁校验：返回 active 客户端 clientId（供审批单快照），违规抛错并指路。 */
  private checkSsoGate(app: { id: string; name: string; attrs: Record<string, unknown> }): string | undefined {
    const enforce = AppRegistryService.ssoEnforceTypes()
    if (enforce.length === 0) return this.activeSsoClient(app.id)?.clientId
    const appType = String(app.attrs['appType'] ?? '')
    if (!enforce.includes(appType)) return this.activeSsoClient(app.id)?.clientId
    const active = this.activeSsoClient(app.id)
    if (!active) {
      throw new Error(`上线门禁：${appType} 形态应用上线前必须完成身份纳管——请在「AI 应用 → 应用详情 → SSO 配置」签发 OIDC 客户端（当前门禁形态：${enforce.join('/')}）`)
    }
    return active.clientId
  }

  requestOffline(appId: string, requester: { id: string; name: string }, reason: string) {
    const app = this.ctx.resourceCore.get('app', appId)
    if (!app) throw new Error(`应用不存在：${appId}`)
    if (!reason?.trim()) throw new Error('下架必须填写原因（护栏要求）')
    return this.ctx.audit.createApproval({
      kind: 'app.offline',
      title: `AI 应用下架：${app.name}`,
      payload: { appId, reason },
      requesterId: requester.id,
      requesterName: requester.name,
    })
  }

  online(appId: string, actor: string) {
    const result = this.ctx.resourceCore.transition('app', appId, 'online', actor)
    this.ctx.platformBus.emit(PlatformEvents.AppOnlined, { id: appId, name: result.entity.name, actor, type: 'app', slug: result.entity.slug })
    return result.entity
  }

  offline(appId: string, actor: string, reason: string) {
    const result = this.ctx.resourceCore.transition('app', appId, 'offline', actor, reason)
    this.ctx.platformBus.emit(PlatformEvents.AppOfflined, { id: appId, name: result.entity.name, actor, reason, type: 'app', slug: result.entity.slug })
    return result.entity
  }

  /** 归档（终态）：下架后的应用彻底退出运营；关联 SSO 客户端经 app.archived 事件联动禁用。 */
  archive(appId: string, actor: string) {
    const result = this.ctx.resourceCore.transition('app', appId, 'archive', actor)
    this.ctx.platformBus.emit(PlatformEvents.AppArchived, { id: appId, name: result.entity.name, actor, type: 'app', slug: result.entity.slug })
    return result.entity
  }

  // -- SSO 客户端（应用 ↔ 平台身份源打通；owner 自助签发） ----------------------

  /** 上线门禁覆盖的应用形态（APP_SSO_ENFORCE，默认 web,h5；空串可关闭门禁）。 */
  static ssoEnforceTypes(): string[] {
    return String(process.env.APP_SSO_ENFORCE ?? 'web,h5').split(',').map((item) => item.trim()).filter(Boolean)
  }

  /**
   * owner-based 授权（全库首例，非 permission-point 制）：
   * human 且 app.ownerId === userId，或持 authn.oidc.write（管理员兜底）；机器 principal 一律 403。
   */
  assertSsoManage(app: { id: string; name: string; ownerId: string }, caller: { kind: string; userId?: string; permissions: string[] }): void {
    if (caller.kind !== 'human' || !caller.userId) {
      throw new Error('SSO 客户端管理仅限用户身份（owner 校验），机器身份不可操作')
    }
    const isOwner = app.ownerId === caller.userId
    const hasAdmin = caller.permissions.includes('*') || caller.permissions.includes('authn.oidc.write')
    if (!isOwner && !hasAdmin) {
      throw new Error(`仅应用 owner 或持有 authn.oidc.write 的管理员可管理「${app.name}」的 SSO 客户端`)
    }
  }

  /** 回跳地址护栏：https 或 http://localhost[:port]（本机调试）。 */
  private static assertRedirectUris(uris: string[]): void {
    if (!Array.isArray(uris) || uris.length === 0) throw new Error('redirectUris 必填（至少一个回调地址）')
    for (const uri of uris) {
      let parsed: URL
      try { parsed = new URL(uri) } catch { throw new Error(`回调地址非法：${uri}`) }
      const localhostOk = parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
      if (parsed.protocol !== 'https:' && !localhostOk) {
        throw new Error(`回调地址必须为 https:// 或 http://localhost[:port]（收到：${uri}）`)
      }
    }
  }

  activeSsoClient(appId: string) {
    return this.ctx.oidc.clientsForApp(appId).find((client) => OidcService.isClientActive(client))
  }

  /** 签发应用关联 OIDC 客户端（name=应用名，回填 refType/refId）；secret 仅本次返回。 */
  createSsoClient(appId: string, input: {
    redirectUris: string[]
    clientType?: 'confidential' | 'public'
    consentRequired?: boolean
    postLogoutUris?: string[]
    description?: string
  }): { client: ReturnType<OidcService['clientsForApp']>[number]; clientSecret: string } {
    const app = this.ctx.resourceCore.get('app', appId)
    if (!app) throw new Error(`应用不存在：${appId}`)
    AppRegistryService.assertRedirectUris(input.redirectUris)
    const existing = this.ctx.oidc.clientsForApp(appId)
    if (existing.length > 0) throw new Error(`该应用已签发 SSO 客户端（${existing[0]!.clientId}），请直接管理或先禁用后重新签发`)
    const created = this.ctx.oidc.createClient({
      name: app.name,
      redirectUris: input.redirectUris,
      ...(input.clientType !== undefined ? { clientType: input.clientType } : {}),
      ...(input.consentRequired !== undefined ? { consentRequired: input.consentRequired } : {}),
      ...(input.postLogoutUris !== undefined ? { postLogoutUris: input.postLogoutUris } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      refType: 'app',
      refId: appId,
    })
    return created
  }

  updateSsoClient(appId: string, patch: { redirectUris?: string[]; description?: string; consentRequired?: boolean; postLogoutUris?: string[] }) {
    this.requireSsoClient(appId)
    if (patch.redirectUris !== undefined) AppRegistryService.assertRedirectUris(patch.redirectUris)
    return this.ctx.oidc.updateClient(this.requireSsoClient(appId).id, patch)
  }

  rotateSsoSecret(appId: string) {
    return this.ctx.oidc.rotateSecret(this.requireSsoClient(appId).id)
  }

  disableSsoClient(appId: string, reason: string) {
    return this.ctx.oidc.disableClient(this.requireSsoClient(appId).id, reason)
  }

  enableSsoClient(appId: string) {
    return this.ctx.oidc.enableClient(this.requireSsoClient(appId).id)
  }

  private requireSsoClient(appId: string) {
    const clients = this.ctx.oidc.clientsForApp(appId)
    if (clients.length === 0) throw new Error(`该应用尚未签发 SSO 客户端`)
    return clients[0]!
  }

  // -- 应用层指标 ---------------------------------------------------------

  recordUsage(appId: string, usage: { dau?: number; sessions?: number; avgDepth?: number }): void {
    const date = new Date().toISOString().slice(0, 10)
    const existing = this.usage().findOne((item) => item.appId === appId && item.date === date)
    if (existing) {
      this.usage().update(existing.id, {
        dau: Math.max(existing.dau, usage.dau ?? existing.dau),
        sessions: existing.sessions + (usage.sessions ?? 0),
        avgDepth: usage.avgDepth ?? existing.avgDepth,
      })
    } else {
      this.usage().insert({
        id: newId('apu'),
        appId,
        date,
        dau: usage.dau ?? 0,
        sessions: usage.sessions ?? 0,
        avgDepth: usage.avgDepth ?? 0,
        retention7: 0,
      })
    }
  }

  metrics(appId: string): {
    dau: number
    mau: number
    sessions: number
    avgDepth: number
    retention7: number
    series: Array<{ date: string; dau: number; sessions: number }>
  } {
    const rows = this.usage().find((item) => item.appId === appId).sort((a, b) => a.date.localeCompare(b.date))
    const today = rows.at(-1)
    const last30 = rows.slice(-30)
    const mauSet = new Set<string>()
    void mauSet
    return {
      dau: today?.dau ?? 0,
      mau: last30.reduce((sum, row) => sum + row.dau, 0),
      sessions: rows.reduce((sum, row) => sum + row.sessions, 0),
      avgDepth: Math.round((rows.reduce((sum, row) => sum + row.avgDepth, 0) / Math.max(1, rows.length)) * 10) / 10,
      retention7: today?.retention7 ?? 0,
      series: rows.slice(-14).map((row) => ({ date: row.date, dau: row.dau, sessions: row.sessions })),
    }
  }

  overview(): { total: number; online: number; trial: number } {
    const apps = this.ctx.resourceCore.list('app')
    return {
      total: apps.length,
      online: apps.filter((item) => item.status === 'online').length,
      trial: apps.filter((item) => item.status === 'trial').length,
    }
  }

  /** 成本穿透：应用 → Agent → MCP/模型。 */
  costBreakdown(appId: string): Array<{ agentName: string; llmTokens: number; toolCalls: number; costYuan: number }> {
    const rows: Array<{ agentName: string; llmTokens: number; toolCalls: number; costYuan: number }> = []
    const deps = this.ctx.resourceCore.dependencies().find((record) => record.fromType === 'app' && record.fromId === appId && record.kind === 'agent')
    for (const dep of deps) {
      const agent = this.ctx.resourceCore.get('agent', dep.toId)
      const costs = this.ctx.audit.costs().find((cost) => cost.agentId === dep.toId)
      rows.push({
        agentName: agent?.name ?? dep.toId,
        llmTokens: costs.reduce((sum, cost) => sum + cost.llmTokens, 0),
        toolCalls: costs.reduce((sum, cost) => sum + cost.toolCalls, 0),
        costYuan: Math.round(costs.reduce((sum, cost) => sum + cost.costYuan, 0) * 1000) / 1000,
      })
    }
    return rows.sort((a, b) => b.costYuan - a.costYuan)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    appRegistry: AppRegistryService
  }
}

export const name = 'app'
export const inject = ['opsStorage', 'platformBus', 'resourceCore', 'authn', 'oidc', 'audit']

export function apply(ctx: Context) {
  const registry = new AppRegistryService(ctx)
  ctx.plugin(appTools)
  ctx.effect(() => ctx.audit.registerExecutor('app.online', async (payload) => {
    // 上线门禁（点 2，兜底）：审批挂单期间客户端可能被禁用——执行前复核，失效则执行失败留痕
    const app = ctx.resourceCore.get('app', String(payload['appId']))
    if (app) {
      const enforce = AppRegistryService.ssoEnforceTypes()
      const appType = String(app.attrs['appType'] ?? '')
      if (enforce.includes(appType) && !registry.activeSsoClient(app.id)) {
        throw new Error(`执行期复核失败：审批期间 SSO 客户端已失效（${appType} 形态门禁），请重新签发后再发起上线`)
      }
    }
    return registry.online(String(payload['appId']), 'approval-center')
  }))
  ctx.effect(() => ctx.audit.registerExecutor('app.offline', async (payload) => {
    return registry.offline(String(payload['appId']), 'approval-center', String(payload['reason'] ?? '审批通过下架'))
  }))
}

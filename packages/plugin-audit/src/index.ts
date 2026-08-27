/**
 * @dsh-ops/plugin-audit —— 安全与审计（贯穿各模块，方案 §七）。
 *
 * - 四类审计日志：认证 / 授权 / 调用 / 变更，统一 schema、只追加。
 * - 告警规则引擎：阈值/异常模式声明式配置，事件驱动评估。
 * - 成本归集：按令牌链归集 Token 消耗，应用/组织维度穿透。
 * - 审批中心：全平台 L4 高危操作汇聚（Skill 上架、Agent 上线、下线/吊销/删除）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { PlatformEvents, newId, type Collection, type RecordBase } from '../../platform-core/src/index.ts'
import * as auditTools from './tools.ts'

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export type AuditType = 'auth' | 'authz' | 'invoke' | 'change'

export interface AuditLogRecord extends RecordBase {
  type: AuditType
  actorType: 'human' | 'machine' | 'system'
  actorId: string
  actorName: string
  action: string
  resourceType: string
  resourceId: string
  resourceName: string
  result: 'ok' | 'denied' | 'error'
  detail: string
  actChain?: Array<{ name: string; type: string }>
}

export interface AlertRuleRecord extends RecordBase {
  name: string
  /** mcp_error_rate | mcp_latency | token_burst | agent_anomaly | permission_denied */
  metric: string
  operator: 'gt'
  threshold: number
  windowMinutes: number
  severity: 'critical' | 'warning' | 'info'
  channels: string[]
  enabled: boolean
  description?: string
}

export interface AlertEventRecord extends RecordBase {
  ruleId?: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  message: string
  resourceType?: string
  resourceId?: string
  read: boolean
}

export interface CostRecord extends RecordBase {
  date: string
  appId?: string
  agentId?: string
  mcpServiceId?: string
  /** 连接器纳管资源归集维度（connector:<service> 的 service 段）。 */
  connectorService?: string
  llmTokens: number
  toolCalls: number
  costYuan: number
}

export interface ApprovalRecord extends RecordBase {
  kind: string
  title: string
  payload: Record<string, unknown>
  requesterId: string
  requesterName: string
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed'
  approverId?: string
  approverName?: string
  opinion?: string
  createdAt: string
  decidedAt?: string
  execution?: { result: string; error?: string; at: string }
}

export type ApprovalExecutor = (payload: Record<string, unknown>, approverId: string) => Promise<unknown>

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class AuditService extends Service {
  static readonly provide = 'audit'

  private executors = new Map<string, ApprovalExecutor>()
  private deniedCounter = new Map<string, number[]>()

  constructor(ctx: Context) {
    super(ctx, 'audit')

    // 事件驱动的审计埋点：各模块状态变更自动落审计日志
    const auditOf = (type: AuditType, action: string, result: AuditLogRecord['result'] = 'ok') =>
      (payload: unknown): void => {
        const p = payload as Record<string, any>
        this.record({
          type,
          actorType: p.actorType ?? 'system',
          actorId: p.actor ?? 'system',
          actorName: p.actorName ?? 'system',
          action,
          resourceType: p.type ?? action.split('.')[0],
          resourceId: p.id ?? p.jti ?? p.serviceId ?? '',
          resourceName: p.name ?? p.slug ?? p.title ?? '',
          result,
          detail: p.reason ?? p.note ?? JSON.stringify(payload).slice(0, 300),
        })
      }

    ctx.platformBus.on(PlatformEvents.TokenIssued, auditOf('auth', 'authn.token.issue'))
    ctx.platformBus.on(PlatformEvents.TokenRevoked, auditOf('auth', 'authn.token.revoke'))
    ctx.platformBus.on(PlatformEvents.UserFrozen, (payload) => {
      const p = payload as { userId: string; username: string; reason: string }
      this.record({
        type: 'change', actorType: 'system', actorId: 'iam-sync', actorName: 'IAM 联动',
        action: 'iam.user.freeze', resourceType: 'user', resourceId: p.userId, resourceName: p.username,
        result: 'ok', detail: p.reason,
      })
    })
    ctx.platformBus.on(PlatformEvents.McpDeployed, auditOf('change', 'mcp.service.deploy'))
    ctx.platformBus.on(PlatformEvents.McpOfflined, auditOf('change', 'mcp.service.offline'))
    ctx.platformBus.on(PlatformEvents.McpUnhealthy, (payload) => {
      const p = payload as { serviceId: string; name: string; consecutiveFails: number }
      this.record({
        type: 'invoke', actorType: 'system', actorId: 'health-probe', actorName: '健康探活',
        action: 'mcp.service.unhealthy', resourceType: 'mcp_service', resourceId: p.serviceId, resourceName: p.name,
        result: 'error', detail: `连续失败 ${p.consecutiveFails} 次，触发熔断`,
      })
      this.evaluateAlerts('mcp_unhealthy', p)
    })
    ctx.platformBus.on(PlatformEvents.McpInvoked, (payload) => {
      const p = payload as { ok: boolean; latencyMs: number; serviceId: string; name: string; callerName: string; errorRate?: number }
      this.record({
        type: 'invoke', actorType: p.callerType ?? 'machine', actorId: p.callerId ?? '', actorName: p.callerName ?? '',
        action: 'mcp.gateway.invoke', resourceType: 'mcp_service', resourceId: p.serviceId, resourceName: p.name,
        result: p.ok ? 'ok' : 'error',
        detail: `latency=${p.latencyMs}ms${p.ok ? '' : ' 调用失败'}`,
        actChain: p.actChain,
      })
    })
    // 连接器纳管（open-connector 融合）：invoke 日志透传 actChain + runId（runId 无独立字段，进 resourceId）
    ctx.platformBus.on(PlatformEvents.ConnectorInvoked, (payload) => {
      const p = payload as {
        ok?: boolean; service?: string; actionId?: string; runId?: string
        callerType?: string; callerId?: string; callerName?: string
        latencyMs?: number; error?: string; actChain?: Array<{ name: string; type: string }>
        auditPersisted?: boolean
      }
      this.record({
        type: 'invoke', actorType: p.callerType === 'user' ? 'human' : 'machine', actorId: p.callerId ?? '', actorName: p.callerName ?? '',
        action: 'connector.invoke', resourceType: 'connector_action', resourceId: p.runId ?? '', resourceName: `${p.service ?? ''}/${p.actionId ?? ''}`,
        result: p.ok ? 'ok' : 'error',
        detail: `run=${p.runId ?? ''} latency=${p.latencyMs ?? 0}ms${p.ok ? '' : ` 调用失败：${p.error ?? ''}`}${p.auditPersisted === false ? '（sidecar 审计未落库，平台已补记）' : ''}`,
        ...(p.actChain?.length ? { actChain: p.actChain } : {}),
      })
    })
    ctx.platformBus.on(PlatformEvents.ConnectorGatewayChanged, auditOf('change', 'connector.gateway.changed'))
    ctx.platformBus.on(PlatformEvents.ConnectorGatewayUnhealthy, (payload) => {
      const p = payload as { baseUrl?: string; consecutiveFails?: number; reason?: string }
      this.record({
        type: 'invoke', actorType: 'system', actorId: 'connector-probe', actorName: '连接器探活',
        action: 'connector.gateway.unhealthy', resourceType: 'connector_gateway', resourceId: 'gateway', resourceName: p.baseUrl ?? '',
        result: 'error', detail: `连续失败 ${p.consecutiveFails ?? 0} 次（fail-closed）：${p.reason ?? ''}`,
      })
    })
    ctx.platformBus.on(PlatformEvents.ConnectorConnected, auditOf('change', 'connector.connected'))
    ctx.platformBus.on(PlatformEvents.ConnectorDisconnected, auditOf('change', 'connector.disconnected'))
    ctx.platformBus.on(PlatformEvents.ConnectorPermGroupChanged, auditOf('change', 'connector.permgroup.changed'))
    ctx.platformBus.on(PlatformEvents.ConnectorGatewaySynced, (payload) => {
      const p = payload as { kind?: string; violations?: unknown[] }
      this.record({
        type: 'change', actorType: 'system', actorId: 'connector-patrol', actorName: '连接器巡检',
        action: 'connector.gateway.synced', resourceType: 'connector_gateway', resourceId: String(p.kind ?? ''), resourceName: '',
        result: (p.violations?.length ?? 0) > 0 ? 'error' : 'ok',
        detail: JSON.stringify(payload).slice(0, 300),
      })
    })
    ctx.platformBus.on(PlatformEvents.SkillPublished, auditOf('change', 'skill.publish'))
    ctx.platformBus.on(PlatformEvents.SkillDeprecated, auditOf('change', 'skill.deprecate'))
    ctx.platformBus.on(PlatformEvents.SkillInstalled, auditOf('change', 'skill.install'))
    ctx.platformBus.on(PlatformEvents.AgentRegistered, auditOf('change', 'agent.register'))
    ctx.platformBus.on(PlatformEvents.AgentOnlined, auditOf('change', 'agent.online'))
    ctx.platformBus.on(PlatformEvents.AgentOfflined, auditOf('change', 'agent.offline'))
    ctx.platformBus.on(PlatformEvents.AppOnlined, auditOf('change', 'app.online'))
    ctx.platformBus.on(PlatformEvents.AppOfflined, auditOf('change', 'app.offline'))
    ctx.platformBus.on(PlatformEvents.AppArchived, auditOf('change', 'app.archive'))
    ctx.platformBus.on(PlatformEvents.OidcAuthorizeGranted, (payload) => {
      const p = payload as { reqId: string; clientId: string; clientName: string; userId: string; userName: string; scope: string }
      this.record({
        type: 'auth', actorType: 'human', actorId: p.userId, actorName: p.userName,
        action: 'oidc.authorize.granted', resourceType: 'oidc_client', resourceId: p.clientId, resourceName: p.clientName,
        result: 'ok', detail: `授权通过（scope：${p.scope}，req：${p.reqId.slice(0, 8)}…）`,
      })
    })
    ctx.platformBus.on(PlatformEvents.OidcAuthorizeDenied, (payload) => {
      const p = payload as { reqId: string; clientId: string; clientName: string; userId: string; userName: string }
      this.record({
        type: 'auth', actorType: 'human', actorId: p.userId, actorName: p.userName,
        action: 'oidc.authorize.denied', resourceType: 'oidc_client', resourceId: p.clientId, resourceName: p.clientName,
        result: 'denied', detail: `用户拒绝授权（req：${p.reqId.slice(0, 8)}…）`,
      })
    })
    ctx.platformBus.on(PlatformEvents.UpdateAvailable, (payload) => {
      const p = payload as { currentVersion: string; latestVersion: string; behindBy: number }
      this.record({
        type: 'change', actorType: 'system', actorId: 'update-checker', actorName: '平台更新检查',
        action: 'platform.update.available', resourceType: 'platform', resourceId: 'self', resourceName: '平台升级',
        result: 'ok', detail: `上游新版本 ${p.currentVersion} → ${p.latestVersion}${p.behindBy > 0 ? `（落后 ${p.behindBy} 提交）` : ''}`,
      })
    })
    ctx.platformBus.on(PlatformEvents.UpdateApplied, (payload) => {
      const p = payload as { from: string; to: string; reason: string; actor: string }
      this.record({
        type: 'change', actorType: 'human', actorId: 'update-apply', actorName: p.actor,
        action: 'platform.update.applied', resourceType: 'platform', resourceId: 'self', resourceName: '平台升级',
        result: 'ok', detail: `${p.from} → ${p.to}，原因：${p.reason}`,
      })
    })
    ctx.platformBus.on(PlatformEvents.ApprovalCreated, auditOf('change', 'approval.create'))
    ctx.platformBus.on(PlatformEvents.ApprovalDecided, (payload) => {
      const p = payload as { approvalId: string; title: string; approved: boolean; approverName: string }
      this.record({
        type: 'authz', actorType: 'human', actorId: p.approverId ?? '', actorName: p.approverName ?? '',
        action: 'approval.decide', resourceType: 'approval', resourceId: p.approvalId, resourceName: p.title,
        result: 'ok', detail: p.approved ? '审批通过' : '审批驳回',
      })
    })
    ctx.platformBus.on('audit.authz.denied', (payload) => {
      const p = payload as { actorId: string; actorName: string; point: string; path: string }
      this.record({
        type: 'authz', actorType: 'human', actorId: p.actorId, actorName: p.actorName,
        action: 'console.authz.denied', resourceType: 'api', resourceId: p.path, resourceName: p.path,
        result: 'denied', detail: `缺少权限点 ${p.point}`,
      })
      const key = `denied:${p.actorId}`
      const now = Date.now()
      const times = (this.deniedCounter.get(key) ?? []).filter((t) => now - t < 10 * 60_000)
      times.push(now)
      this.deniedCounter.set(key, times)
      this.evaluateAlerts('permission_denied', { actorId: p.actorId, actorName: p.actorName, count: times.length, point: p.point })
    })
    ctx.platformBus.on(PlatformEvents.AlertFired, (payload) => {
      const p = payload as AlertEventRecord
      this.alerts().insert({
        id: p.id, ruleId: p.ruleId, severity: p.severity, title: p.title, message: p.message,
        ...(p.resourceType !== undefined ? { resourceType: p.resourceType } : {}),
        ...(p.resourceId !== undefined ? { resourceId: p.resourceId } : {}),
        read: false,
      })
    })

    // 计量管道消费（v1.2 第 2 步）：usage.recorded → 财务口径投影 + 真实成本归集。
    // 消费幂等由 usage 事件 idempotency_key 保障（at-least-once 投递 + 幂等消费）。
    ctx.usage.consume('audit', (event) => {
      ctx.usage.project('audit', event)
      const agentId = event.subject.startsWith('agent:') ? event.subject.slice(6) : undefined
      const appId = event.principal.startsWith('app:') ? event.principal.slice(4) : undefined
      const mcpServiceId = event.resource.startsWith('mcp:') ? event.resource.slice(4) : undefined
      const connectorService = event.resource.startsWith('connector:') ? event.resource.slice('connector:'.length) : undefined
      const tokens = event.meters
        .filter((meter) => meter.key === 'input_tokens' || meter.key === 'output_tokens' || meter.key === 'tokens')
        .reduce((sum, meter) => sum + meter.value, 0)
      this.addCost({
        date: event.occurred_at.slice(0, 10),
        ...(agentId !== undefined ? { agentId } : {}),
        ...(appId !== undefined ? { appId } : {}),
        ...(mcpServiceId !== undefined ? { mcpServiceId } : {}),
        ...(connectorService !== undefined ? { connectorService } : {}),
        llmTokens: event.resource.startsWith('model:') ? tokens : 0,
        toolCalls: event.resource.startsWith('mcp:') || connectorService !== undefined ? 1 : 0,
        costYuan: Math.round(event.pricing.charge_cents) / 100,
      })
    })
  }

  // -- 集合 ---------------------------------------------------------------

  logs(): Collection<AuditLogRecord> {
    return this.ctx.opsStorage.collection<AuditLogRecord>('audit:logs')
  }

  alertRules(): Collection<AlertRuleRecord> {
    return this.ctx.opsStorage.collection<AlertRuleRecord>('audit:alertRules')
  }

  alerts(): Collection<AlertEventRecord> {
    return this.ctx.opsStorage.collection<AlertEventRecord>('audit:alerts')
  }

  costs(): Collection<CostRecord> {
    return this.ctx.opsStorage.collection<CostRecord>('audit:costs')
  }

  approvals(): Collection<ApprovalRecord> {
    return this.ctx.opsStorage.collection<ApprovalRecord>('audit:approvals')
  }

  // -- 审计日志 -----------------------------------------------------------

  record(entry: Omit<AuditLogRecord, 'id' | 'createdAt' | 'updatedAt'>): AuditLogRecord {
    return this.logs().insert({ id: newId('log'), ...entry })
  }

  query(filter: {
    type?: AuditType
    actorId?: string
    resourceType?: string
    resourceId?: string
    result?: string
    q?: string
    since?: string
    limit?: number
  }): { total: number; items: AuditLogRecord[] } {
    const all = this.logs().find((log) => {
      if (filter.type && log.type !== filter.type) return false
      if (filter.actorId && log.actorId !== filter.actorId) return false
      if (filter.resourceType && log.resourceType !== filter.resourceType) return false
      if (filter.resourceId && log.resourceId !== filter.resourceId) return false
      if (filter.result && log.result !== filter.result) return false
      if (filter.since && log.createdAt < filter.since) return false
      if (filter.q && !`${log.action} ${log.actorName} ${log.resourceName} ${log.detail}`.toLowerCase().includes(filter.q.toLowerCase())) return false
      return true
    })
    const items = all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const limit = filter.limit ?? 100
    return { total: all.length, items: items.slice(0, limit) }
  }

  summary(): Record<string, number> {
    const result: Record<string, number> = { auth: 0, authz: 0, invoke: 0, change: 0, denied: 0, error: 0 }
    for (const log of this.logs().all()) {
      result[log.type] = (result[log.type] ?? 0) + 1
      if (log.result === 'denied') result.denied!++
      if (log.result === 'error') result.error!++
    }
    return result
  }

  // -- 告警 ---------------------------------------------------------------

  createAlertRule(input: Omit<AlertRuleRecord, 'id' | 'createdAt' | 'updatedAt'>): AlertRuleRecord {
    return this.alertRules().insert({ id: newId('rule'), ...input })
  }

  /** 告警评估入口：各事件源调用，匹配规则则触发告警。 */
  evaluateAlerts(metric: string, context: Record<string, unknown>): void {
    for (const rule of this.alertRules().find((item) => item.enabled && item.metric === metric)) {
      const value = Number(context[metric === 'permission_denied' ? 'count' : metric === 'mcp_unhealthy' ? 'consecutiveFails' : 'value'] ?? 0)
      if (!(value > rule.threshold)) continue
      this.fire({
        ruleId: rule.id,
        severity: rule.severity,
        title: `[${rule.name}] 触发`,
        message: `${rule.metric} = ${value}（阈值 ${rule.threshold}），上下文：${JSON.stringify(context).slice(0, 200)}`,
        ...(context.resourceType !== undefined ? { resourceType: String(context.resourceType) } : {}),
        ...(context.resourceId !== undefined ? { resourceId: String(context.resourceId) } : {}),
      })
    }
  }

  /** 直接触发告警（无规则的系统级告警）。 */
  fire(input: Omit<AlertEventRecord, 'id' | 'createdAt' | 'updatedAt' | 'read'>): void {
    this.ctx.platformBus.emit(PlatformEvents.AlertFired, {
      id: newId('alt'), read: false, ...input,
    })
  }

  markAlertRead(id: string): void {
    this.alerts().update(id, { read: true })
  }

  /** 一键全部已读：把全部未读告警置为已读，返回本次处理的条数。 */
  markAllAlertsRead(): number {
    const unread = this.alerts().find((alert) => !alert.read)
    for (const alert of unread) this.alerts().update(alert.id, { read: true })
    return unread.length
  }

  // -- 成本 ---------------------------------------------------------------

  addCost(input: Omit<CostRecord, 'id' | 'createdAt' | 'updatedAt'>): void {
    const existing = this.costs().findOne((cost) =>
      cost.date === input.date
      && (cost.appId ?? '') === (input.appId ?? '')
      && (cost.agentId ?? '') === (input.agentId ?? '')
      && (cost.mcpServiceId ?? '') === (input.mcpServiceId ?? '')
      && (cost.connectorService ?? '') === (input.connectorService ?? ''))
    if (existing) {
      this.costs().update(existing.id, {
        llmTokens: existing.llmTokens + input.llmTokens,
        toolCalls: existing.toolCalls + input.toolCalls,
        costYuan: Math.round((existing.costYuan + input.costYuan) * 1000) / 1000,
      })
    } else {
      this.costs().insert({ id: newId('cost'), ...input })
    }
  }

  costReport(groupBy: 'app' | 'agent' | 'org' | 'date', from?: string, to?: string): Array<{ key: string; llmTokens: number; toolCalls: number; costYuan: number }> {
    const buckets = new Map<string, { key: string; llmTokens: number; toolCalls: number; costYuan: number }>()
    for (const cost of this.costs().all()) {
      if (from && cost.date < from) continue
      if (to && cost.date > to) continue
      let key = cost.date
      if (groupBy === 'app') key = cost.appId ? this.ctx.resourceCore?.collection('app').get(cost.appId)?.name ?? cost.appId : '（未归集应用）'
      if (groupBy === 'agent') key = cost.agentId ? this.ctx.resourceCore?.collection('agent').get(cost.agentId)?.name ?? cost.agentId : '（未归集 Agent）'
      if (groupBy === 'org') {
        const entity = cost.agentId ? this.ctx.resourceCore?.collection('agent').get(cost.agentId) : undefined
        key = entity ? this.ctx.iam?.orgs().get(entity.orgId)?.name ?? entity.orgId : '（未归集组织）'
      }
      const bucket = buckets.get(key) ?? { key, llmTokens: 0, toolCalls: 0, costYuan: 0 }
      bucket.llmTokens += cost.llmTokens
      bucket.toolCalls += cost.toolCalls
      bucket.costYuan += cost.costYuan
      buckets.set(key, bucket)
    }
    return [...buckets.values()].map((bucket) => ({ ...bucket, costYuan: Math.round(bucket.costYuan * 1000) / 1000 }))
      .sort((a, b) => b.costYuan - a.costYuan)
  }

  // -- 审批中心 -----------------------------------------------------------

  /** 注册某类审批的执行器（审批通过后自动执行）。 */
  registerExecutor(kind: string, executor: ApprovalExecutor): () => void {
    this.executors.set(kind, executor)
    return () => this.executors.delete(kind)
  }

  createApproval(input: {
    kind: string
    title: string
    payload: Record<string, unknown>
    requesterId: string
    requesterName: string
  }): ApprovalRecord {
    const record = this.approvals().insert({
      id: newId('apr'),
      ...input,
      status: 'pending',
      createdAt: new Date().toISOString(),
    })
    this.ctx.platformBus.emit(PlatformEvents.ApprovalCreated, {
      approvalId: record.id, kind: record.kind, title: record.title,
      requesterId: record.requesterId, requesterName: record.requesterName,
    })
    return record
  }

  async decideApproval(id: string, decision: 'approve' | 'reject', approverId: string, approverName: string, opinion?: string): Promise<ApprovalRecord> {
    const approval = this.approvals().get(id)
    if (!approval) throw new Error(`审批单不存在：${id}`)
    if (approval.status !== 'pending') throw new Error(`审批单已处理（${approval.status}）`)
    if (decision === 'reject') {
      const updated = this.approvals().update(id, {
        status: 'rejected', approverId, approverName,
        ...(opinion !== undefined ? { opinion } : {}),
        decidedAt: new Date().toISOString(),
      })
      this.ctx.platformBus.emit(PlatformEvents.ApprovalDecided, {
        approvalId: id, title: approval.title, approved: false, approverId, approverName,
      })
      return updated
    }
    const executor = this.executors.get(approval.kind)
    let execution: ApprovalRecord['execution']
    if (executor) {
      try {
        const result = await executor(approval.payload, approverId)
        execution = { result: JSON.stringify(result ?? { ok: true }).slice(0, 500), at: new Date().toISOString() }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        execution = { result: '执行失败', error: message, at: new Date().toISOString() }
      }
    } else {
      execution = { result: '（无注册执行器，仅记录审批结果）', at: new Date().toISOString() }
    }
    const status: ApprovalRecord['status'] = execution.error ? 'failed' : 'executed'
    const updated = this.approvals().update(id, {
      status, approverId, approverName,
      ...(opinion !== undefined ? { opinion } : {}),
      decidedAt: new Date().toISOString(),
      execution,
    })
    this.ctx.platformBus.emit(PlatformEvents.ApprovalDecided, {
      approvalId: id, title: approval.title, approved: true, approverId, approverName,
    })
    return updated
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    audit: AuditService
  }
}

export const name = 'audit'
export const inject = ['opsStorage', 'platformBus', 'resourceCore', 'iam', 'usage']

export function apply(ctx: Context) {
  ctx.plugin(AuditService)
  ctx.plugin(auditTools)
}

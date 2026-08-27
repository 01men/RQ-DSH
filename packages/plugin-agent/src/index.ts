/**
 * @dsh-ops/plugin-agent —— Agent 本体管理（方案 §五）。
 *
 * 基于 resource-core 底座：属性表 schema + 生命周期状态机 + 依赖图全部复用，
 * 本插件只声明 Agent 差异 schema 与运营监测逻辑。
 * 注册即纳管：创建 Agent 颁发唯一 ID 与机器身份凭证（authn，含 usage.write，
 * Agent 可自推直连消耗的计量），上线走 L4 审批，下线联动吊销凭证、通知绑定用户、保留审计数据。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import {
  PlatformEvents, newId,
  type Collection, type RecordBase, type ResourceTypeSpec,
} from '../../platform-core/src/index.ts'
import * as agentTools from './tools.ts'
import { AGENT_TYPE_SPEC } from './schema.ts'

// ---------------------------------------------------------------------------
// 数据模型（Agent 专属扩展记录）
// ---------------------------------------------------------------------------

export interface AgentBindingRecord extends RecordBase {
  agentId: string
  userId: string
  userName: string
  boundAt: string
  boundBy: string
}

export interface AgentUsageRecord extends RecordBase {
  agentId: string
  date: string
  sessions: number
  calls: number
  okCalls: number
  tokens: number
  totalLatencyMs: number
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class AgentRegistryService extends Service {
  static readonly provide = 'agentRegistry'

  private usageCounter = new Map<string, number[]>()

  constructor(ctx: Context) {
    super(ctx, 'agentRegistry')
    ctx.resourceCore.registerType(AGENT_TYPE_SPEC)

    // 调用监测：MCP 网关以 Agent 为主体调用时自动归集运行指标
    ctx.platformBus.on(PlatformEvents.McpInvoked, (payload) => {
      const p = payload as { callerType: string; callerId: string; ok: boolean; tokens: number; latencyMs: number }
      if (p.callerType !== 'agent') return
      this.recordUsage(p.callerId, { calls: 1, okCalls: p.ok ? 1 : 0, tokens: p.tokens, latencyMs: p.latencyMs })
      // 行为监测：频次突增检测（10 分钟窗口超过 120 次）
      const nowMs = Date.now()
      const times = (this.usageCounter.get(p.callerId) ?? []).filter((t) => nowMs - t < 10 * 60_000)
      times.push(nowMs)
      this.usageCounter.set(p.callerId, times)
      if (times.length === 120) {
        const agent = ctx.resourceCore.collection('agent').get(p.callerId)
        ctx.audit.fire({
          severity: 'warning',
          title: `Agent「${agent?.name ?? p.callerId}」调用频次突增`,
          message: `10 分钟内调用 ${times.length} 次，超过异常阈值 120，请检查是否存在死循环或滥用。`,
          resourceType: 'agent',
          resourceId: p.callerId,
        })
      }
    })

    // Skill 弃用 → 通知引用 Agent 的负责人（存量引用告警）
    ctx.platformBus.on(PlatformEvents.SkillDeprecated, (payload) => {
      const p = payload as { skillId: string; name: string }
      for (const record of ctx.resourceCore.dependencies().find((item) => item.kind === 'skill' && item.toId === p.skillId)) {
        const agent = ctx.resourceCore.collection('agent').get(record.fromId)
        if (!agent) continue
        ctx.audit.fire({
          severity: 'info',
          title: `Agent「${agent.name}」引用的 Skill 已弃用`,
          message: `Skill「${p.name}」已弃用，请尽快迁移至替代版本，避免下次构建失败。`,
          resourceType: 'agent',
          resourceId: agent.id,
        })
      }
    })
  }

  bindings(): Collection<AgentBindingRecord> {
    return this.ctx.opsStorage.collection<AgentBindingRecord>('agent:bindings')
  }

  usage(): Collection<AgentUsageRecord> {
    return this.ctx.opsStorage.collection<AgentUsageRecord>('agent:usage')
  }

  // -- 注册 -------------------------------------------------------------

  register(input: {
    name: string
    slug?: string
    attrs?: Record<string, unknown>
    ownerId: string
    ownerName: string
    orgId: string
    withCredential?: boolean
  }): { agent: import('../../platform-core/src/index.ts').RecordBase & Record<string, unknown>; credential?: { principalId: string; clientId: string; clientSecret: string } } {
    const attrs = {
      ownerName: input.ownerName,
      ...(input.attrs ?? {}),
    }
    const agent = this.ctx.resourceCore.create('agent', { ...input, attrs })
    let credential
    if (input.withCredential !== false) {
      // usage.write：Agent 绕过平台网关直连外部资源时须自推计量（POST /api/usage/record）
      credential = this.ctx.authn.createMachineCredential({
        name: `agent:${(agent as any).slug}`,
        refType: 'agent',
        refId: agent.id,
        // connector.invoke：连接器纳管（open-connector 融合）与 mcp.invoke 同级的独立调用权限点
        scopes: ['mcp.invoke', 'skill.read', 'agent.read', 'usage.write', 'connector.invoke'],
      })
    }
    this.ctx.platformBus.emit(PlatformEvents.AgentRegistered, {
      id: agent.id, name: agent.name, slug: agent.slug, actor: input.ownerId, type: 'agent',
    })
    return { agent, credential }
  }

  machinePrincipal(agentId: string) {
    return this.ctx.authn.principals().findOne((item) => item.refType === 'agent' && item.refId === agentId)
  }

  /** 用户绑定：记录"哪些用户可使用该 Agent"，使用即授权留痕。 */
  bindUser(agentId: string, userId: string, actor: string): AgentBindingRecord {
    const agent = this.ctx.resourceCore.get('agent', agentId)
    if (!agent) throw new Error(`Agent 不存在：${agentId}`)
    const user = this.ctx.iam.users().get(userId)
    if (!user) throw new Error(`用户不存在：${userId}`)
    if (this.bindings().findOne((item) => item.agentId === agentId && item.userId === userId)) {
      throw new Error(`${user.displayName} 已绑定该 Agent`)
    }
    return this.bindings().insert({
      id: newId('agb'),
      agentId,
      userId,
      userName: user.displayName,
      boundAt: new Date().toISOString(),
      boundBy: actor,
    })
  }

  unbindUser(agentId: string, userId: string): boolean {
    const binding = this.bindings().findOne((item) => item.agentId === agentId && item.userId === userId)
    if (!binding) return false
    return this.bindings().remove(binding.id)
  }

  boundUsers(agentId: string): AgentBindingRecord[] {
    return this.bindings().find((item) => item.agentId === agentId)
  }

  /** on-behalf-of：用户通过 Agent 行事时签发身份透传令牌。 */
  issueOnBehalfOfToken(agentId: string, verifiedUser: import('../../plugin-authn/src/index.ts').VerifiedPrincipal): { token: string; actChain: unknown[] } {
    const principal = this.machinePrincipal(agentId)
    if (!principal) throw new Error('该 Agent 尚未注册机器身份，请先在注册时勾选颁发凭证')
    const { token, record } = this.ctx.authn.issueOnBehalfOf(verifiedUser, principal.id)
    return { token, actChain: record.actChain }
  }

  // -- 生命周期（L4 审批流）----------------------------------------------

  requestOnline(agentId: string, requester: { id: string; name: string }) {
    const agent = this.ctx.resourceCore.get('agent', agentId)
    if (!agent) throw new Error(`Agent 不存在：${agentId}`)
    const errors = this.ctx.resourceCore.validateAttrs('agent', agent.attrs, 'online')
    if (errors.length > 0) throw new Error(`上线条件不满足：${errors.join('；')}`)
    return this.ctx.audit.createApproval({
      kind: 'agent.online',
      title: `Agent 上线：${agent.name}`,
      payload: { agentId, requesterId: requester.id },
      requesterId: requester.id,
      requesterName: requester.name,
    })
  }

  requestOffline(agentId: string, requester: { id: string; name: string }, reason: string) {
    const agent = this.ctx.resourceCore.get('agent', agentId)
    if (!agent) throw new Error(`Agent 不存在：${agentId}`)
    if (!reason?.trim()) throw new Error('下线必须填写原因（护栏要求）')
    const impact = this.ctx.resourceCore.impact('agent', agentId)
    return this.ctx.audit.createApproval({
      kind: 'agent.offline',
      title: `Agent 下线：${agent.name}`,
      payload: { agentId, reason, impact: impact.map((item) => `${item.name}（${item.type}）`) },
      requesterId: requester.id,
      requesterName: requester.name,
    })
  }

  online(agentId: string, actor: string) {
    const result = this.ctx.resourceCore.transition('agent', agentId, 'online', actor)
    this.ctx.platformBus.emit(PlatformEvents.AgentOnlined, { id: agentId, name: result.entity.name, actor, type: 'agent', slug: result.entity.slug })
    return result.entity
  }

  offline(agentId: string, actor: string, reason: string) {
    const result = this.ctx.resourceCore.transition('agent', agentId, 'offline', actor, reason)
    this.ctx.platformBus.emit(PlatformEvents.AgentOfflined, { id: agentId, name: result.entity.name, actor, reason, type: 'agent', slug: result.entity.slug })
    // 下线联动：吊销机器凭证（authn 事件监听执行）、通知绑定用户
    const principal = this.machinePrincipal(agentId)
    if (principal) this.ctx.authn.disablePrincipal(principal.id, 'Agent 下线联动')
    for (const binding of this.boundUsers(agentId)) {
      this.ctx.audit.fire({
        severity: 'info',
        title: `你绑定的 Agent「${result.entity.name}」已下线`,
        message: `绑定关系保留，恢复上线后可继续使用。原因：${reason}`,
        resourceType: 'agent',
        resourceId: agentId,
      })
      void binding
    }
    return result.entity
  }

  archive(agentId: string, actor: string) {
    return this.ctx.resourceCore.transition('agent', agentId, 'archive', actor).entity
  }

  trial(agentId: string, actor: string, groups: string[]) {
    void groups
    return this.ctx.resourceCore.transition('agent', agentId, 'submit_trial', actor).entity
  }

  /** 删除后的关联清理：用户绑定、依赖边与机器凭证（禁用即吊销全部令牌）；用量记录与审计数据保留。 */
  purge(agentId: string): void {
    for (const binding of this.bindings().find((item) => item.agentId === agentId)) this.bindings().remove(binding.id)
    for (const record of this.ctx.resourceCore.dependencies().find((item) => item.fromId === agentId || item.toId === agentId)) {
      this.ctx.resourceCore.dependencies().remove(record.id)
    }
    const principal = this.machinePrincipal(agentId)
    if (principal && principal.status === 'active') this.ctx.authn.disablePrincipal(principal.id, 'Agent 删除联动')
  }

  // -- 监测 -------------------------------------------------------------

  recordUsage(agentId: string, usage: { sessions?: number; calls: number; okCalls: number; tokens: number; latencyMs: number }): void {
    const date = new Date().toISOString().slice(0, 10)
    const existing = this.usage().findOne((item) => item.agentId === agentId && item.date === date)
    if (existing) {
      this.usage().update(existing.id, {
        sessions: existing.sessions + (usage.sessions ?? 0),
        calls: existing.calls + usage.calls,
        okCalls: existing.okCalls + usage.okCalls,
        tokens: existing.tokens + usage.tokens,
        totalLatencyMs: existing.totalLatencyMs + usage.latencyMs,
      })
    } else {
      this.usage().insert({
        id: newId('agu'),
        agentId,
        date,
        sessions: usage.sessions ?? 0,
        calls: usage.calls,
        okCalls: usage.okCalls,
        tokens: usage.tokens,
        totalLatencyMs: usage.latencyMs,
      })
    }
    if (usage.tokens > 0) {
      this.ctx.audit.addCost({
        date,
        agentId,
        llmTokens: usage.tokens,
        toolCalls: usage.calls,
        costYuan: Math.round(usage.tokens * 0.0000015 * 1000) / 1000,
      })
    }
  }

  metrics(agentId: string): {
    sessions: number
    calls: number
    successRate: number
    tokens: number
    avgLatencyMs: number
    lastActiveAt: string
    series: Array<{ date: string; calls: number; tokens: number }>
  } {
    const rows = this.usage().find((item) => item.agentId === agentId).sort((a, b) => a.date.localeCompare(b.date))
    const calls = rows.reduce((sum, row) => sum + row.calls, 0)
    const okCalls = rows.reduce((sum, row) => sum + row.okCalls, 0)
    const tokens = rows.reduce((sum, row) => sum + row.tokens, 0)
    const latency = rows.reduce((sum, row) => sum + row.totalLatencyMs, 0)
    return {
      sessions: rows.reduce((sum, row) => sum + row.sessions, 0),
      calls,
      successRate: calls === 0 ? 1 : Math.round((okCalls / calls) * 1000) / 1000,
      tokens,
      avgLatencyMs: calls === 0 ? 0 : Math.round(latency / calls),
      lastActiveAt: rows.at(-1)?.updatedAt ?? '',
      series: rows.slice(-14).map((row) => ({ date: row.date, calls: row.calls, tokens: row.tokens })),
    }
  }

  overview(): { total: number; online: number; trial: number; draft: number; offline: number } {
    const agents = this.ctx.resourceCore.list('agent')
    return {
      total: agents.length,
      online: agents.filter((item) => item.status === 'online').length,
      trial: agents.filter((item) => item.status === 'trial').length,
      draft: agents.filter((item) => item.status === 'draft').length,
      offline: agents.filter((item) => ['offline', 'archived'].includes(item.status)).length,
    }
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentRegistry: AgentRegistryService
  }
}

export const name = 'agent'
export const inject = ['opsStorage', 'platformBus', 'resourceCore', 'authn', 'iam', 'audit']

export function apply(ctx: Context) {
  const registry = new AgentRegistryService(ctx)
  ctx.plugin(agentTools)
  // L4 审批执行器（闭包直持实例，避免插件注入自身服务的循环等待）
  ctx.effect(() => ctx.audit.registerExecutor('agent.online', async (payload) => {
    return registry.online(String(payload.agentId), 'approval-center')
  }))
  ctx.effect(() => ctx.audit.registerExecutor('agent.offline', async (payload) => {
    return registry.offline(String(payload.agentId), 'approval-center', String(payload.reason ?? '审批通过下线'))
  }))
  migrateAgentCredentialScopes(ctx)
  migrateAgentCredentialConnectorInvoke(ctx)
}

/** 一次性迁移：为存量 Agent 机器凭证补 connector.invoke（幂等标记，先例 agent-scopes-usage-write-v1）。 */
function migrateAgentCredentialConnectorInvoke(ctx: Context): void {
  const markers = ctx.opsStorage.collection<{ id: string; doneAt: string }>('agent:migrations')
  const MARK = 'agent-scopes-connector-invoke-v1'
  if (markers.get(MARK)) return
  let patched = 0
  for (const principal of ctx.authn.principals().find(
    (item) => item.type === 'machine' && item.refType === 'agent' && item.status === 'active' && !item.scopes.includes('connector.invoke'),
  )) {
    ctx.authn.principals().update(principal.id, { scopes: [...principal.scopes, 'connector.invoke'] })
    ctx.audit.record({
      type: 'change', actorType: 'system', actorId: 'agent-migration', actorName: '凭证范围迁移',
      action: 'agent.credential.connector-invoke-backfill', resourceType: 'agent',
      resourceId: principal.refId ?? '', resourceName: principal.name, result: 'ok',
      detail: '补入 connector.invoke（连接器纳管数据面对齐）',
    })
    patched++
  }
  markers.insert({ id: MARK, doneAt: new Date().toISOString() })
  if (patched > 0) ctx.logger('agent').info(`存量 Agent 凭证迁移完成：${patched} 条补入 connector.invoke`)
}

/** 一次性迁移：为存量 Agent 机器凭证补 usage.write（幂等标记，防止覆盖后续人工调整的 scopes）。 */
function migrateAgentCredentialScopes(ctx: Context): void {
  const markers = ctx.opsStorage.collection<{ id: string; doneAt: string }>('agent:migrations')
  const MARK = 'agent-scopes-usage-write-v1'
  if (markers.get(MARK)) return
  let patched = 0
  for (const principal of ctx.authn.principals().find(
    (item) => item.type === 'machine' && item.refType === 'agent' && item.status === 'active' && !item.scopes.includes('usage.write'),
  )) {
    ctx.authn.principals().update(principal.id, { scopes: [...principal.scopes, 'usage.write'] })
    ctx.audit.record({
      type: 'change', actorType: 'system', actorId: 'agent-migration', actorName: '凭证范围迁移',
      action: 'agent.credential.scopes-backfill', resourceType: 'agent',
      resourceId: principal.refId ?? '', resourceName: principal.name, result: 'ok',
      detail: '补入 usage.write（Agent 自推计量能力对齐）',
    })
    patched++
  }
  markers.insert({ id: MARK, doneAt: new Date().toISOString() })
  if (patched > 0) ctx.logger('agent').info(`存量 Agent 凭证迁移完成：${patched} 条补入 usage.write`)
}

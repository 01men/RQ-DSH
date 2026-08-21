/**
 * @dsh-ops/plugin-mcp —— MCP 部署服务管理（方案 §三）。
 *
 * 管理面（本插件）：服务注册登记、部署流程、版本/灰度/回滚、健康探活、
 *                   权限组（Tool 粒度 + 参数级约束）、调用运营监控。
 * 数据面（MCP 网关）：invoke() 统一鉴权、限流熔断、指标埋点、审计上报。
 * 演示环境内置 mock 执行传输层：确定性模拟延迟/成功率/Token 消耗。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { PlatformEvents, newId, sha256Hex, type Collection, type RecordBase } from '@dsh-ops/platform-core'
import * as mcpTools from './tools.ts'

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export interface McpToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  riskLevel: 'read' | 'write' | 'admin'
}

export interface McpVersion {
  version: string
  changelog: string
  publishedAt: string
  status: 'current' | 'previous' | 'rolled-back'
}

export interface McpServiceRecord extends RecordBase {
  name: string
  slug: string
  description: string
  icon: string
  endpoint: string
  transport: 'stdio' | 'sse' | 'http'
  mode: 'hosted' | 'external'
  orgId: string
  owner: string
  status: 'draft' | 'verifying' | 'online' | 'gray' | 'unhealthy' | 'offline'
  grayPercent: number
  currentVersion: string
  versions: McpVersion[]
  tools: McpToolSpec[]
  health: {
    lastProbeAt?: string
    status: 'unknown' | 'healthy' | 'degraded' | 'down'
    latencyMs?: number
    consecutiveFails: number
    breakerOpen: boolean
  }
  /** 模拟稳定性 0-1（演示数据用）。 */
  stability: number
  rateLimitPerMin: number
}

export interface ToolPolicy {
  allowedTools: '*' | string[]
  constraints: { readOnly?: boolean; denyParams?: string[] }
}

export interface McpPermGroupRecord extends RecordBase {
  name: string
  description: string
  /** serviceId → 工具策略。 */
  policies: Record<string, ToolPolicy>
  subjects: Array<{ type: 'user_group' | 'agent' | 'app'; id: string; name?: string }>
}

export interface McpCallRecord {
  id: string
  at: string
  serviceId: string
  serviceName: string
  tool: string
  callerType: 'user' | 'agent' | 'app'
  callerId: string
  callerName: string
  onBehalfOf?: string
  actChain?: Array<{ name: string; type: string }>
  version: string
  ok: boolean
  status: 'ok' | 'error' | 'denied' | 'rate_limited' | 'breaker_open'
  latencyMs: number
  tokens: number
  error?: string
}

export interface InvokeCaller {
  type: 'user' | 'agent' | 'app'
  id: string
  name: string
  onBehalfOf?: string
  actChain?: Array<{ name: string; type: string }>
}

export interface InvokeResult {
  ok: boolean
  status: McpCallRecord['status']
  latencyMs: number
  version: string
  result?: unknown
  error?: string
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class McpService extends Service {
  static readonly provide = 'mcpRegistry'

  private probeTimer: ReturnType<typeof setInterval> | undefined
  private rateBuckets = new Map<string, number[]>()

  constructor(ctx: Context) {
    super(ctx, 'mcpRegistry')
    ctx.effect(() => () => {
      if (this.probeTimer) clearInterval(this.probeTimer)
    })
    // 健康探活：30s 一轮，连续失败 3 次熔断
    this.probeTimer = setInterval(() => {
      void this.probeAll()
    }, 30_000)
  }

  services(): Collection<McpServiceRecord> {
    return this.ctx.storage.collection<McpServiceRecord>('mcp:services')
  }

  permGroups(): Collection<McpPermGroupRecord> {
    return this.ctx.storage.collection<McpPermGroupRecord>('mcp:permGroups')
  }

  calls(): Collection<McpCallRecord> {
    return this.ctx.storage.collection<McpCallRecord>('mcp:calls')
  }

  // -- 注册与部署 ---------------------------------------------------------

  createService(input: {
    name: string
    slug?: string
    description?: string
    icon?: string
    endpoint?: string
    transport?: McpServiceRecord['transport']
    mode?: McpServiceRecord['mode']
    orgId: string
    owner: string
    tools?: McpToolSpec[]
    stability?: number
  }): McpServiceRecord {
    if (!input.name?.trim()) throw new Error('服务名称不能为空')
    const slug = input.slug ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (this.services().findOne((item) => item.slug === slug)) throw new Error(`服务标识已存在：${slug}`)
    if (input.mode !== 'external' && !input.endpoint) input.endpoint = `mcp+${input.transport ?? 'http'}://platform-hosted/${slug}`
    const toolSpecs = input.tools?.length ? input.tools : defaultToolsFor(slug)
    return this.services().insert({
      id: newId('mcp'),
      name: input.name,
      slug,
      description: input.description ?? '',
      icon: input.icon ?? 'mcp',
      endpoint: input.endpoint ?? '',
      transport: input.transport ?? 'http',
      mode: input.mode ?? 'hosted',
      orgId: input.orgId,
      owner: input.owner,
      status: 'draft',
      grayPercent: 0,
      currentVersion: '0.1.0',
      versions: [],
      tools: toolSpecs,
      health: { status: 'unknown', consecutiveFails: 0, breakerOpen: false },
      stability: input.stability ?? 0.97,
      rateLimitPerMin: 60,
    })
  }

  updateService(id: string, patch: Partial<Pick<McpServiceRecord, 'name' | 'description' | 'icon' | 'endpoint' | 'tools' | 'rateLimitPerMin'>>): McpServiceRecord {
    const service = this.requireService(id)
    if (service.status === 'online' && patch.tools) {
      throw new Error('在线服务修改 Tool Schema 需先灰度新版本（版本不可变原则）')
    }
    return this.services().update(id, patch)
  }

  /** 测试环境验证：校验 endpoint 可达（演示为模拟探测）。 */
  async verifyService(id: string): Promise<McpServiceRecord> {
    const service = this.requireService(id)
    if (service.status !== 'draft') throw new Error('仅草稿状态可执行测试验证')
    this.services().update(id, { status: 'verifying' })
    await sleep(300)
    // 测试环境恒可达（运行期健康由探活负责）
    const latency = 60 + Math.floor(Math.random() * 200)
    return this.services().update(id, { health: { lastProbeAt: now(), status: 'healthy', latencyMs: latency, consecutiveFails: 0, breakerOpen: false } })
  }

  /** 发布上线（可选灰度比例），记录版本。 */
  async deployService(id: string, options: { grayPercent?: number; version?: string; changelog?: string; actor: string }): Promise<McpServiceRecord> {
    const service = this.requireService(id)
    if (!['draft', 'verifying', 'gray', 'online', 'unhealthy'].includes(service.status)) {
      throw new Error(`当前状态 ${service.status} 不允许发布`)
    }
    const version = options.version ?? bumpVersion(service.currentVersion)
    const gray = Math.min(100, Math.max(0, options.grayPercent ?? 100))
    await sleep(200)
    const updated = this.services().update(id, {
      status: gray >= 100 ? 'online' : 'gray',
      grayPercent: gray,
      currentVersion: version,
      versions: [
        ...service.versions.map((item) => ({ ...item, status: item.status === 'current' ? 'previous' : item.status })),
        { version, changelog: options.changelog ?? '例行更新', publishedAt: now(), status: 'current' },
      ],
      health: { ...service.health, status: 'healthy', consecutiveFails: 0, breakerOpen: false },
    })
    this.ctx.platformBus.emit(PlatformEvents.McpDeployed, {
      serviceId: id, name: updated.name, version, grayPercent: gray, actor: options.actor, type: 'mcp_service', slug: updated.slug,
    })
    return updated
  }

  async rollbackService(id: string, targetVersion: string, actor: string): Promise<McpServiceRecord> {
    const service = this.requireService(id)
    const target = service.versions.find((item) => item.version === targetVersion)
    if (!target) throw new Error(`目标版本不存在：${targetVersion}`)
    const updated = this.services().update(id, {
      currentVersion: targetVersion,
      versions: service.versions.map((item) => ({
        ...item,
        status: item.version === targetVersion ? 'current' : item.status === 'current' ? 'rolled-back' : item.status,
      })),
    })
    this.ctx.platformBus.emit(PlatformEvents.McpDeployed, {
      serviceId: id, name: updated.name, version: targetVersion, rollback: true, actor, type: 'mcp_service', slug: updated.slug,
    })
    return updated
  }

  offlineService(id: string, actor: string, reason: string): McpServiceRecord {
    const service = this.requireService(id)
    if (service.status === 'offline') throw new Error('服务已是下线状态')
    const updated = this.services().update(id, { status: 'offline', grayPercent: 0 })
    this.ctx.platformBus.emit(PlatformEvents.McpOfflined, { serviceId: id, name: updated.name, actor, reason, type: 'mcp_service', slug: updated.slug })
    return updated
  }

  /** L4 下线走审批：创建审批单，通过后自动执行。 */
  requestOfflineApproval(id: string, requester: { id: string; name: string }, reason: string, impactPreview: string[]) {
    return this.ctx.audit.createApproval({
      kind: 'mcp.offline',
      title: `下线 MCP 服务：${this.requireService(id).name}`,
      payload: { serviceId: id, reason, impactPreview },
      requesterId: requester.id,
      requesterName: requester.name,
    })
  }

  // -- 健康探活 -----------------------------------------------------------

  async probeService(id: string): Promise<{ status: string; latencyMs: number }> {
    const service = this.requireService(id)
    if (service.status === 'offline' || service.status === 'draft') {
      return { status: 'unknown', latencyMs: 0 }
    }
    const latency = probeLatency(service)
    const ok = latency > 0
    const fails = ok ? 0 : service.health.consecutiveFails + 1
    const breakerOpen = fails >= 3
    const status = ok ? (latency > 800 ? 'degraded' : 'healthy') : 'down'
    const update: McpServiceRecord = this.services().update(id, {
      health: { lastProbeAt: now(), status, latencyMs: Math.max(0, latency), consecutiveFails: fails, breakerOpen },
      ...(breakerOpen && service.status !== 'unhealthy' ? { status: 'unhealthy' } : {}),
      ...(ok && service.status === 'unhealthy' ? { status: service.grayPercent >= 100 ? 'online' : 'gray' } : {}),
    })
    if (breakerOpen && service.status !== 'unhealthy') {
      this.ctx.platformBus.emit(PlatformEvents.McpUnhealthy, {
        serviceId: id, name: service.name, consecutiveFails: fails, latencyMs: latency,
      })
    }
    return { status: update.health.status, latencyMs: latency }
  }

  private async probeAll(): Promise<void> {
    for (const service of this.services().all()) {
      if (service.status === 'offline' || service.status === 'draft') continue
      try {
        await this.probeService(service.id)
      } catch (error) {
        this.ctx.logger('mcp').warn('探活失败', service.id, error)
      }
    }
  }

  async healthCheck(id: string): Promise<{ status: string; latencyMs: number }> {
    return this.probeService(id)
  }

  // -- 权限组 -------------------------------------------------------------

  createPermGroup(input: {
    name: string
    description?: string
    policies: Record<string, ToolPolicy>
    subjects: McpPermGroupRecord['subjects']
  }): McpPermGroupRecord {
    if (!input.name?.trim()) throw new Error('权限组名称不能为空')
    if (this.permGroups().findOne((group) => group.name === input.name)) throw new Error(`权限组已存在：${input.name}`)
    for (const serviceId of Object.keys(input.policies)) {
      this.requireService(serviceId)
    }
    return this.permGroups().insert({
      id: newId('mpg'),
      name: input.name,
      description: input.description ?? '',
      policies: input.policies,
      subjects: input.subjects,
    })
  }

  updatePermGroup(id: string, patch: Partial<Pick<McpPermGroupRecord, 'name' | 'description' | 'policies' | 'subjects'>>): McpPermGroupRecord {
    return this.permGroups().update(id, patch)
  }

  deletePermGroup(id: string): boolean {
    return this.permGroups().remove(id)
  }

  /** 授予主体访问：加入权限组。 */
  grantSubject(groupId: string, subject: McpPermGroupRecord['subjects'][number]): McpPermGroupRecord {
    const group = this.permGroups().get(groupId)
    if (!group) throw new Error(`权限组不存在：${groupId}`)
    if (group.subjects.some((item) => item.type === subject.type && item.id === subject.id)) return group
    return this.permGroups().update(groupId, { subjects: [...group.subjects, subject] })
  }

  /** 授权检查：返回可用的策略上下文或拒绝原因。 */
  authorize(caller: InvokeCaller, serviceId: string, toolName: string): { ok: true; readOnly: boolean } | { ok: false; reason: string } {
    const service = this.requireService(serviceId)
    const tool = service.tools.find((item) => item.name === toolName)
    if (!tool) return { ok: false, reason: `服务 ${service.name} 不存在工具 ${toolName}` }
    const grants: ToolPolicy[] = []
    for (const group of this.permGroups().all()) {
      const policy = group.policies[serviceId]
      if (!policy) continue
      const hit = group.subjects.some((subject) => {
        if (subject.type === 'user_group' && caller.type === 'user') {
          return this.ctx.iam.resolveGroupMembers(subject.id).some((user) => user.id === caller.id)
        }
        return subject.type === caller.type && subject.id === caller.id
      })
      if (hit) grants.push(policy)
    }
    if (grants.length === 0) {
      return { ok: false, reason: `主体 ${caller.name} 未被任何 MCP 权限组授权访问 ${service.name}` }
    }
    for (const policy of grants) {
      const allowed = policy.allowedTools === '*' || policy.allowedTools.includes(toolName)
      if (!allowed) continue
      if (policy.constraints.readOnly && tool.riskLevel !== 'read') {
        return { ok: false, reason: `权限组约束为只读模式，工具 ${toolName}（${tool.riskLevel}）被拒绝` }
      }
      return { ok: true, readOnly: Boolean(policy.constraints.readOnly) }
    }
    return { ok: false, reason: `工具 ${toolName} 不在授权列表中` }
  }

  // -- 调用网关 -----------------------------------------------------------

  async invoke(caller: InvokeCaller, serviceId: string, toolName: string, args: Record<string, unknown> = {}): Promise<InvokeResult> {
    const service = this.services().get(serviceId)
    if (!service) throw new Error(`MCP 服务不存在：${serviceId}`)
    const started = Date.now()

    const fail = (status: McpCallRecord['status'], error: string): InvokeResult => {
      this.recordCall(service, toolName, caller, { ok: false, status, latencyMs: Date.now() - started, version: service.currentVersion, error })
      return { ok: false, status, latencyMs: Date.now() - started, version: service.currentVersion, error }
    }

    if (service.status === 'offline') return fail('denied', '服务已下线')
    if (service.status === 'draft' || service.status === 'verifying') return fail('denied', '服务尚未发布')
    if (service.health.breakerOpen) return fail('breaker_open', '熔断器开启：服务连续失败，暂拒绝调用')

    // 限流：每服务每分钟令牌桶
    const key = `${serviceId}:${caller.type}:${caller.id}`
    const nowMs = Date.now()
    const bucket = (this.rateBuckets.get(key) ?? []).filter((t) => nowMs - t < 60_000)
    if (bucket.length >= service.rateLimitPerMin) {
      this.rateBuckets.set(key, bucket)
      return fail('rate_limited', `触发限流：${service.rateLimitPerMin} 次/分钟`)
    }
    bucket.push(nowMs)
    this.rateBuckets.set(key, bucket)

    const auth = this.authorize(caller, serviceId, toolName)
    if (!auth.ok) {
      this.recordCall(service, toolName, caller, { ok: false, status: 'denied', latencyMs: Date.now() - started, version: service.currentVersion, error: auth.reason })
      return { ok: false, status: 'denied', latencyMs: Date.now() - started, version: service.currentVersion, error: auth.reason }
    }

    // 灰度路由：未命中灰度比例的调用走稳定版本
    const hash = Number.parseInt(sha256Hex(`${caller.id}:${serviceId}`).slice(0, 8), 16) % 100
    const version = service.grayPercent < 100 && hash >= service.grayPercent
      ? (service.versions.find((item) => item.status === 'previous')?.version ?? service.currentVersion)
      : service.currentVersion

    // 模拟执行传输层
    await sleep(simulateLatency(service))
    const success = Math.random() < service.stability
    if (!success) {
      return fail('error', 'MCP 服务执行超时/内部错误')
    }

    const tokens = 200 + (Number.parseInt(sha256Hex(JSON.stringify(args)).slice(0, 6), 16) % 1800)
    const result = mockToolResult(service, toolName, args)
    const latencyMs = Date.now() - started
    this.recordCall(service, toolName, caller, { ok: true, status: 'ok', latencyMs, version, tokens })
    return { ok: true, status: 'ok', latencyMs, version, result }
  }

  private recordCall(service: McpServiceRecord, tool: string, caller: InvokeCaller, outcome: {
    ok: boolean
    status: McpCallRecord['status']
    latencyMs: number
    version: string
    error?: string
    tokens?: number
  }): void {
    const record: McpCallRecord = {
      id: newId('call'),
      at: now(),
      serviceId: service.id,
      serviceName: service.name,
      tool,
      callerType: caller.type,
      callerId: caller.id,
      callerName: caller.name,
      ...(caller.onBehalfOf !== undefined ? { onBehalfOf: caller.onBehalfOf } : {}),
      ...(caller.actChain !== undefined ? { actChain: caller.actChain } : {}),
      version: outcome.version,
      ok: outcome.ok,
      status: outcome.status,
      latencyMs: outcome.latencyMs,
      tokens: outcome.tokens ?? 0,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    }
    this.calls().insert(record)
    // 调用环上限 5000 条，防膨胀
    const all = this.calls().all()
    if (all.length > 5000) {
      for (const item of all.slice(0, all.length - 5000)) this.calls().remove(item.id)
    }
    this.ctx.platformBus.emit(PlatformEvents.McpInvoked, {
      serviceId: service.id, name: service.name, tool,
      callerType: caller.type, callerId: caller.id, callerName: caller.name,
      ok: outcome.ok, latencyMs: outcome.latencyMs, tokens: record.tokens,
      actChain: caller.actChain,
    })
    if (record.tokens > 0) {
      this.ctx.audit.addCost({
        date: now().slice(0, 10),
        mcpServiceId: service.id,
        llmTokens: 0,
        toolCalls: 1,
        costYuan: round3(record.tokens * 0.000002),
      })
    }
  }

  // -- 监控指标 -----------------------------------------------------------

  metricsOverview(): {
    totalCalls: number
    successRate: number
    p95Latency: number
    tokens: number
    onlineServices: number
    unhealthyServices: number
  } {
    const calls = this.calls().all()
    const okCalls = calls.filter((call) => call.ok)
    const latencies = calls.map((call) => call.latencyMs).sort((a, b) => a - b)
    const services = this.services().all()
    return {
      totalCalls: calls.length,
      successRate: calls.length === 0 ? 1 : round3(okCalls.length / calls.length),
      p95Latency: latencies.length === 0 ? 0 : latencies[Math.floor(latencies.length * 0.95)]!,
      tokens: calls.reduce((sum, call) => sum + call.tokens, 0),
      onlineServices: services.filter((item) => ['online', 'gray'].includes(item.status)).length,
      unhealthyServices: services.filter((item) => item.status === 'unhealthy').length,
    }
  }

  serviceMetrics(serviceId: string): {
    calls: number
    okCalls: number
    successRate: number
    p95Latency: number
    tokens: number
    callers: Array<{ callerName: string; callerType: string; calls: number }>
    toolStats: Array<{ tool: string; calls: number; ok: number; avgLatency: number }>
    series: Array<{ minute: string; calls: number; errors: number; avgLatency: number }>
  } {
    const calls = this.calls().find((call) => call.serviceId === serviceId)
    const okCalls = calls.filter((call) => call.ok)
    const latencies = calls.map((call) => call.latencyMs).sort((a, b) => a - b)
    const byCaller = new Map<string, { callerName: string; callerType: string; calls: number }>()
    for (const call of calls) {
      const key = `${call.callerType}:${call.callerId}`
      const bucket = byCaller.get(key) ?? { callerName: call.callerName, callerType: call.callerType, calls: 0 }
      bucket.calls++
      byCaller.set(key, bucket)
    }
    const byTool = new Map<string, { tool: string; calls: number; ok: number; totalLatency: number }>()
    for (const call of calls) {
      const bucket = byTool.get(call.tool) ?? { tool: call.tool, calls: 0, ok: 0, totalLatency: 0 }
      bucket.calls++
      if (call.ok) bucket.ok++
      bucket.totalLatency += call.latencyMs
      byTool.set(call.tool, bucket)
    }
    // 近 60 分钟分钟级序列
    const series = new Map<string, { calls: number; errors: number; totalLatency: number }>()
    const nowMs = Date.now()
    for (let i = 59; i >= 0; i--) {
      const minute = new Date(nowMs - i * 60_000).toISOString().slice(0, 16)
      series.set(minute, { calls: 0, errors: 0, totalLatency: 0 })
    }
    for (const call of calls) {
      const minute = call.at.slice(0, 16)
      const bucket = series.get(minute)
      if (!bucket) continue
      bucket.calls++
      if (!call.ok) bucket.errors++
      bucket.totalLatency += call.latencyMs
    }
    return {
      calls: calls.length,
      okCalls: okCalls.length,
      successRate: calls.length === 0 ? 1 : round3(okCalls.length / calls.length),
      p95Latency: latencies.length === 0 ? 0 : latencies[Math.floor(latencies.length * 0.95)]!,
      tokens: calls.reduce((sum, call) => sum + call.tokens, 0),
      callers: [...byCaller.values()].sort((a, b) => b.calls - a.calls),
      toolStats: [...byTool.values()].map((bucket) => ({
        tool: bucket.tool, calls: bucket.calls, ok: bucket.ok,
        avgLatency: bucket.calls === 0 ? 0 : Math.round(bucket.totalLatency / bucket.calls),
      })).sort((a, b) => b.calls - a.calls),
      series: [...series.entries()].map(([minute, bucket]) => ({
        minute, calls: bucket.calls, errors: bucket.errors,
        avgLatency: bucket.calls === 0 ? 0 : Math.round(bucket.totalLatency / bucket.calls),
      })),
    }
  }

  callLog(filter: { serviceId?: string; callerId?: string; status?: string; limit?: number }): { total: number; items: McpCallRecord[] } {
    const all = this.calls().find((call) => {
      if (filter.serviceId && call.serviceId !== filter.serviceId) return false
      if (filter.callerId && call.callerId !== filter.callerId) return false
      if (filter.status && call.status !== filter.status) return false
      return true
    }).sort((a, b) => b.at.localeCompare(a.at))
    return { total: all.length, items: all.slice(0, filter.limit ?? 100) }
  }

  private requireService(id: string): McpServiceRecord {
    const service = this.services().get(id)
    if (!service) throw new Error(`MCP 服务不存在：${id}`)
    return service
  }
}

// ---------------------------------------------------------------------------
// 模拟传输层辅助（确定性伪随机）
// ---------------------------------------------------------------------------

function probeLatency(service: McpServiceRecord): number {
  const seed = Number.parseInt(sha256Hex(`${service.id}:${Math.floor(Date.now() / 30_000)}`).slice(0, 8), 16) % 1000
  if (seed > service.stability * 1000) return -1
  return 40 + (seed % 400)
}

function simulateLatency(service: McpServiceRecord): number {
  return 30 + Math.floor(Math.random() * 220)
}

function mockToolResult(service: McpServiceRecord, tool: string, args: Record<string, unknown>): unknown {
  const digest = sha256Hex(`${service.slug}:${tool}:${JSON.stringify(args)}`).slice(0, 8)
  if (/search|query|find|list/i.test(tool)) {
    return {
      matched: Number.parseInt(digest.slice(0, 4), 16) % 20 + 1,
      items: Array.from({ length: 3 }, (_, index) => ({
        id: `${digest}-${index}`,
        title: `${tool} 结果 #${index + 1}`,
        score: round3(0.75 + ((Number.parseInt(digest.slice(index, index + 2), 16) % 25) / 100)),
      })),
    }
  }
  if (/write|create|update|send|exec/i.test(tool)) {
    return { acknowledged: true, affected: Number.parseInt(digest.slice(0, 2), 16) % 5 + 1, receipt: `rcpt-${digest}` }
  }
  return { status: 'success', tool, digest, echo: args }
}

function defaultToolsFor(slug: string): McpToolSpec[] {
  return [
    { name: `${slug}_search`, description: `检索 ${slug} 数据`, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, riskLevel: 'read' },
    { name: `${slug}_fetch`, description: `按 ID 获取 ${slug} 详情`, inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, riskLevel: 'read' },
    { name: `${slug}_write`, description: `写入 ${slug} 数据`, inputSchema: { type: 'object', properties: { payload: { type: 'object' } } }, riskLevel: 'write' },
  ]
}

function bumpVersion(version: string): string {
  const parts = version.split('.').map(Number)
  parts[2] = (parts[2] ?? 0) + 1
  return parts.join('.')
}

function now(): string {
  return new Date().toISOString()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpRegistry: McpService
  }
}

export const name = 'mcp'
export const inject = ['storage', 'platformBus', 'iam', 'audit']

export function apply(ctx: Context) {
  const registry = new McpService(ctx)
  ctx.plugin(mcpTools)
  // L4 审批执行器：mcp.offline 审批通过后自动执行下线
  ctx.effect(() => ctx.audit.registerExecutor('mcp.offline', async (payload) => {
    const serviceId = String(payload.serviceId)
    const reason = String(payload.reason ?? '审批通过下线')
    return registry.offlineService(serviceId, 'approval-center', reason)
  }))
}

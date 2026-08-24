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
import { PlatformEvents, newId, sha256Hex, type Collection, type RecordBase } from '../../platform-core/src/index.ts'
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
  /** 外部服务自定义请求头（如 Authorization），调用/探活/工具发现时透传。 */
  headers?: Record<string, string>
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
  /** 执行层：real=真实 HTTP 传输；demo=确定性模拟（显式降级，SLO/计费不统计）。 */
  exec: 'real' | 'demo'
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
  /** 该调用走真实传输还是演示模拟（SLO/计费报表只统计 real）。 */
  exec: 'real' | 'demo'
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

/** mcpServers 配置的单个服务条目（解析结果）。 */
export interface McpConfigEntry {
  name: string
  url: string
  transport: 'http' | 'sse'
  headers?: Record<string, string>
  description?: string
  /** 条目不可导入的原因（如 stdio 形态、url 缺失）。 */
  error?: string
}

/** 单条导入结果。 */
export interface McpImportResult {
  name: string
  ok: boolean
  slug?: string
  serviceId?: string
  tools?: number
  reachable?: boolean
  status?: string
  error?: string
}

/**
 * 解析 mcpServers JSON（Claude Desktop / Cursor / Cherry Studio 等工具通行的形态）。
 * 支持三种输入：标准 {"mcpServers": {...}} 包装、裸 {名称: {url, ...}} 映射、单个 {url, type} 对象。
 * http / streamableHttp / streamable-http 归一为 http；stdio/command 形态标记为不可导入。
 */
export function parseMcpServersConfig(raw: string | object): McpConfigEntry[] {
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
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('配置须为 JSON 对象，形如 {"mcpServers": {"服务名": {"type": "streamableHttp", "url": "https://…"}}}')
  }
  const obj = config as Record<string, unknown>
  let map: Record<string, unknown> | undefined
  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    map = obj.mcpServers as Record<string, unknown>
  } else if (typeof obj.url === 'string') {
    const host = (() => { try { return new URL(obj.url).hostname } catch { return 'mcp' } })()
    map = { [host]: obj }
  } else {
    const values = Object.values(obj)
    if (values.length > 0 && values.every((value) => value && typeof value === 'object' && !Array.isArray(value)
      && (typeof (value as Record<string, unknown>).url === 'string' || typeof (value as Record<string, unknown>).command === 'string'))) {
      map = obj
    }
  }
  if (!map || Object.keys(map).length === 0) {
    throw new Error('未识别出任何服务条目：需要 {"mcpServers": {"服务名": {"type": "...", "url": "..."}}} 形态')
  }
  return Object.entries(map).map(([name, server]) => normalizeServerEntry(name, server))
}

function normalizeServerEntry(name: string, server: unknown): McpConfigEntry {
  const record = (server && typeof server === 'object' ? server : {}) as Record<string, unknown>
  const type = String(record.type ?? '').toLowerCase()
  const url = typeof record.url === 'string' ? record.url.trim() : ''
  const headers = normalizeConfigHeaders(record.headers)
  const base = {
    name,
    url,
    transport: 'http' as const,
    ...(headers ? { headers } : {}),
    ...(typeof record.description === 'string' && record.description ? { description: record.description } : {}),
  }
  if (!url) {
    const localProcess = type === 'stdio' || type === 'command' || typeof record.command === 'string'
    return { ...base, error: localProcess
      ? 'stdio/command 形态需在本地拉起进程，平台仅支持 http(streamableHttp)/sse 远程地址接入'
      : '缺少 url 字段' }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ...base, error: `url 不是合法地址：${url}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ...base, error: `仅支持 http(s) 地址，收到 ${parsed.protocol}` }
  }
  return { ...base, transport: type === 'sse' ? 'sse' : 'http' }
}

function normalizeConfigHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = String(val)
  }
  return Object.keys(out).length ? out : undefined
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class McpService extends Service {
  static readonly provide = 'mcpRegistry'

  private probeTimer: ReturnType<typeof setInterval> | undefined
  private rateBuckets = new Map<string, number[]>()
  /** 远端 streamable HTTP 会话缓存：endpoint → { sessionId（'' 表示无状态服务）, 过期时间 }。 */
  private mcpSessions = new Map<string, { sessionId: string; expiresAt: number }>()

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
    return this.ctx.opsStorage.collection<McpServiceRecord>('mcp:services')
  }

  permGroups(): Collection<McpPermGroupRecord> {
    return this.ctx.opsStorage.collection<McpPermGroupRecord>('mcp:permGroups')
  }

  calls(): Collection<McpCallRecord> {
    return this.ctx.opsStorage.collection<McpCallRecord>('mcp:calls')
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
    headers?: Record<string, string>
    stability?: number
    /** 显式声明 demo 才使用模拟执行层；缺省一律 real（生态设计 v1.2 第 0 步）。 */
    exec?: 'real' | 'demo'
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
      ...(input.headers ? { headers: input.headers } : {}),
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
      exec: input.exec ?? 'real',
    })
  }

  updateService(id: string, patch: Partial<Pick<McpServiceRecord, 'name' | 'description' | 'icon' | 'endpoint' | 'tools' | 'headers' | 'rateLimitPerMin'>>): McpServiceRecord {
    const service = this.requireService(id)
    if (service.status === 'online' && patch.tools) {
      throw new Error('在线服务修改 Tool Schema 需先灰度新版本（版本不可变原则）')
    }
    return this.services().update(id, patch)
  }

  /** 连接远端 MCP 服务拉取工具清单（initialize → tools/list）；导入与同步共用。 */
  async listRemoteTools(endpoint: string, headers?: Record<string, string>): Promise<McpToolSpec[]> {
    const sessionId = await this.ensureSession(endpoint, headers)
    const { payload } = await this.mcpRequest(endpoint, headers, {
      jsonrpc: '2.0',
      id: `dsh-list-${Date.now()}`,
      method: 'tools/list',
      params: {},
    }, REAL_TRANSPORT_TIMEOUT_MS, sessionId)
    if (payload?.error) throw new Error(`tools/list 失败：${payload.error.message ?? '未知错误'}`)
    const tools = Array.isArray(payload?.result?.tools) ? payload.result.tools : []
    return tools
      .map((tool: { name?: unknown; description?: unknown; inputSchema?: unknown }) => ({
        name: String(tool.name ?? ''),
        description: String(tool.description ?? ''),
        inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
          ? tool.inputSchema as Record<string, unknown>
          : { type: 'object', properties: {} },
        riskLevel: 'read' as const,
      }))
      .filter((tool: McpToolSpec) => tool.name)
  }

  /**
   * 外部服务工具同步：以远端 tools/list 为准刷新本地清单。
   * 绕过 updateService 的版本不可变校验——外部服务的工具清单是远端事实的镜像同步，
   * 不是平台侧的版本变更（版本流程仍约束托管服务）。
   */
  async syncTools(serviceId: string): Promise<McpServiceRecord> {
    const service = this.requireService(serviceId)
    if (service.mode !== 'external') throw new Error('仅外部注册服务支持工具同步')
    if (service.exec !== 'real') throw new Error('演示传输层服务不支持工具同步')
    const tools = await this.listRemoteTools(service.endpoint, service.headers)
    if (!tools.length) throw new Error('远端服务未返回任何工具')
    const updated = this.services().update(serviceId, { tools })
    this.noteBusinessSuccess(updated)
    return updated
  }

  /**
   * mcpServers JSON 一键导入（Claude Desktop / Cursor / Cherry Studio 等工具通行的配置形态）：
   * 解析 → 注册外部服务（exec=real）→ initialize+tools/list 自动发现工具 →（可选）验证并上线。
   * 单条目失败不阻断其余条目；远端不可达时保留草稿并回传原因。
   */
  async importServices(input: { config: string | object; orgId: string; owner: string; autoDeploy?: boolean }): Promise<{
    imported: number
    results: McpImportResult[]
  }> {
    const entries = parseMcpServersConfig(input.config)
    const results: McpImportResult[] = []
    for (const entry of entries) {
      if (entry.error) {
        results.push({ name: entry.name, ok: false, error: entry.error })
        continue
      }
      try {
        const service = this.createService({
          name: entry.name,
          endpoint: entry.url,
          transport: entry.transport,
          mode: 'external',
          exec: 'real',
          orgId: input.orgId,
          owner: input.owner,
          ...(entry.headers ? { headers: entry.headers } : {}),
          ...(entry.description ? { description: entry.description } : {}),
          tools: [],
        })
        let tools: McpToolSpec[] = []
        let reachable = false
        let message = ''
        try {
          tools = await this.listRemoteTools(service.endpoint, service.headers)
          reachable = true
        } catch (error) {
          message = `工具自动发现失败：${error instanceof Error ? error.message : String(error)}`
        }
        this.services().update(service.id, {
          // 不可达时清空默认三件套，避免伪工具清单进入权限组
          ...(reachable ? { tools } : { tools: [] as McpToolSpec[] }),
          health: { lastProbeAt: now(), status: reachable ? 'healthy' : 'unknown', latencyMs: 0, consecutiveFails: 0, breakerOpen: false },
        })
        let status = service.status
        if (reachable && input.autoDeploy !== false) {
          try {
            await this.verifyService(service.id)
            const deployed = await this.deployService(service.id, { grayPercent: 100, changelog: 'mcpServers 配置导入自动发布', actor: input.owner })
            status = deployed.status
          } catch (error) {
            message = `${message ? `${message}；` : ''}自动发布失败：${error instanceof Error ? error.message : String(error)}`
          }
        }
        results.push({
          name: entry.name, ok: true, slug: service.slug, serviceId: service.id,
          tools: tools.length, reachable, status,
          ...(message ? { error: message } : {}),
        })
      } catch (error) {
        results.push({ name: entry.name, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { imported: results.filter((item) => item.ok).length, results }
  }

  /** 测试环境验证：real 服务做真实 initialize 探测；demo 服务模拟探测。 */
  async verifyService(id: string): Promise<McpServiceRecord> {
    const service = this.requireService(id)
    if (service.status !== 'draft') throw new Error('仅草稿状态可执行测试验证')
    this.services().update(id, { status: 'verifying' })
    const latency = service.exec === 'real' ? await this.realProbe(service) : 200
    if (latency < 0) {
      this.services().update(id, { status: 'draft' })
      throw new Error(`测试验证失败：endpoint ${service.endpoint} 不可达`)
    }
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
    if (target.status === 'current') throw new Error(`目标版本 ${targetVersion} 即当前版本，无需回滚`)
    if (target.status === 'rolled-back') throw new Error(`目标版本 ${targetVersion} 已被回滚过，不允许作为回滚目标（版本不可变原则）`)
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
    // real：真实 HTTP 探测（POST initialize，测往返与延迟）；demo（含存量无标记）：确定性模拟
    let latency: number
    if (service.exec === 'real') {
      latency = await this.realProbe(service)
    } else {
      latency = probeLatency(service)
    }
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

  /** 业务失败计入熔断：真实调用失败与探活失败共用连续失败计数（连续 3 次开熔断）。 */
  private noteBusinessFailure(service: McpServiceRecord, reason: string): void {
    const fails = service.health.consecutiveFails + 1
    const breakerOpen = fails >= 3
    this.services().update(service.id, {
      health: { ...service.health, lastProbeAt: now(), status: breakerOpen ? 'down' : 'degraded', consecutiveFails: fails, breakerOpen },
      ...(breakerOpen && service.status !== 'unhealthy' ? { status: 'unhealthy' } : {}),
    })
    if (breakerOpen && service.status !== 'unhealthy') {
      this.ctx.platformBus.emit(PlatformEvents.McpUnhealthy, {
        serviceId: service.id, name: service.name, consecutiveFails: fails, latencyMs: 0,
        reason: `业务调用连续失败 ${fails} 次：${reason}`,
      })
    }
  }

  /** 业务成功即半闭合：清零失败计数、解除熔断（下次探活仍会复核）。 */
  private noteBusinessSuccess(service: McpServiceRecord): void {
    if (service.health.consecutiveFails === 0 && !service.health.breakerOpen) return
    this.services().update(service.id, {
      health: { ...service.health, status: 'healthy', consecutiveFails: 0, breakerOpen: false },
      ...(service.status === 'unhealthy' ? { status: service.grayPercent >= 100 ? 'online' : 'gray' } : {}),
    })
  }

  async healthCheck(id: string): Promise<{ status: string; latencyMs: number }> {
    return this.probeService(id)
  }

  /** 真实探活：MCP initialize 握手，返回延迟（ms）；失败返回 -1。 */
  private async realProbe(service: McpServiceRecord): Promise<number> {
    const started = Date.now()
    try {
      const { payload } = await this.mcpRequest(service.endpoint, service.headers, {
        jsonrpc: '2.0',
        id: `probe-${Date.now()}`,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-ops-probe', version: '1.0' } },
      }, REAL_PROBE_TIMEOUT_MS)
      if (payload?.error) return -1
      return Date.now() - started
    } catch {
      return -1
    }
  }

  /**
   * MCP streamable HTTP 请求基座：单 POST JSON-RPC，兼容两种响应形态——纯 JSON 与
   * SSE 流（text/event-stream，取首个 data 帧）；透传服务自定义头（如 Authorization），
   * 回传服务端下发的 Mcp-Session-Id 供有状态服务复用。
   */
  private async mcpRequest(endpoint: string, headers: Record<string, string> | undefined, message: Record<string, unknown>, timeoutMs: number, sessionId?: string): Promise<{ payload: any; sessionId?: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          ...(headers ?? {}),
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`MCP 服务 HTTP ${response.status}：${(await response.text().catch(() => '')).slice(0, 200)}`)
      }
      const sessionIdHeader = response.headers.get('mcp-session-id') ?? undefined
      const contentType = String(response.headers.get('content-type') ?? '')
      const text = await response.text()
      if (contentType.includes('text/event-stream')) {
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) continue
          const frame = line.slice(5).trim()
          if (!frame || frame === '[DONE]') continue
          try { return { payload: JSON.parse(frame), sessionId: sessionIdHeader } } catch { /* 跳过非 JSON 帧 */ }
        }
        throw new Error('MCP 服务 SSE 响应中未找到 JSON-RPC 帧')
      }
      if (!text) return { payload: null, sessionId: sessionIdHeader } // 202 Accepted 等空体响应（通知类消息）
      try {
        return { payload: JSON.parse(text), sessionId: sessionIdHeader }
      } catch {
        throw new Error(`MCP 服务响应不是合法 JSON：${text.slice(0, 200)}`)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 确立远端会话：initialize 握手并缓存 sessionId（无状态服务缓存 ''，避免每次重复握手）。 */
  private async ensureSession(endpoint: string, headers?: Record<string, string>): Promise<string | undefined> {
    const cached = this.mcpSessions.get(endpoint)
    if (cached && cached.expiresAt > Date.now()) return cached.sessionId || undefined
    const { payload, sessionId } = await this.mcpRequest(endpoint, headers, {
      jsonrpc: '2.0',
      id: `dsh-init-${Date.now()}`,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-ops-gateway', version: '1.0' } },
    }, REAL_PROBE_TIMEOUT_MS)
    if (payload?.error) throw new Error(`initialize 失败：${payload.error.message ?? '未知错误'}`)
    const effective = sessionId ?? ''
    this.mcpSessions.set(endpoint, { sessionId: effective, expiresAt: Date.now() + MCP_SESSION_TTL_MS })
    if (effective) {
      // 有状态服务要求补发 initialized 通知；无状态服务忽略即可，失败不阻断。
      await this.mcpRequest(endpoint, headers, { jsonrpc: '2.0', method: 'notifications/initialized' }, REAL_PROBE_TIMEOUT_MS, effective).catch(() => undefined)
    }
    return effective || undefined
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

    // 执行传输层：real = 真实 HTTP JSON-RPC；demo = 确定性模拟（显式降级，恒成功、结果可复现）。
    // 存量演示数据（无 exec 字段）按 demo 兜底——新建服务缺省一律 real。
    let tokens = 0
    let result: unknown
    if (service.exec !== 'real') {
      await sleep(simulateLatency(service, toolName))
      tokens = 200 + (Number.parseInt(sha256Hex(JSON.stringify(args)).slice(0, 6), 16) % 1800)
      result = mockToolResult(service, toolName, args)
    } else {
      const transportResult = await this.realTransport(service, toolName, args)
      if (!transportResult.ok) {
        // 业务失败计入熔断（评审修复：熔断不能只依赖 30s 探活，真实调用失败同样累计）
        this.noteBusinessFailure(service, transportResult.error ?? 'MCP 服务调用失败')
        return fail('error', transportResult.error ?? 'MCP 服务调用失败')
      }
      this.noteBusinessSuccess(service)
      result = transportResult.result
      tokens = transportResult.tokens
    }
    const latencyMs = Date.now() - started
    this.recordCall(service, toolName, caller, { ok: true, status: 'ok', latencyMs, version, tokens })
    return { ok: true, status: 'ok', latencyMs, version, result }
  }

  /**
   * 真实执行传输层：MCP streamable HTTP 的 JSON-RPC tools/call。
   * 有状态服务先经 ensureSession 取会话头；会话失效（服务端报未初始化类错误）自动重握手一次。
   * 真实延迟/错误全量计量；token 消耗从响应 usage 字段读取（缺省 0，不伪造）。
   */
  private async realTransport(service: McpServiceRecord, toolName: string, args: Record<string, unknown>): Promise<{ ok: true; result: unknown; tokens: number } | { ok: false; error: string }> {
    const call = (sessionId?: string) => this.mcpRequest(service.endpoint, service.headers, {
      jsonrpc: '2.0',
      id: `dsh-${Date.now()}`,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }, REAL_TRANSPORT_TIMEOUT_MS, sessionId)
    try {
      let sessionId: string | undefined
      try {
        sessionId = await this.ensureSession(service.endpoint, service.headers)
      } catch { /* 握手失败不阻断：部分服务允许无会话直接调用 */ }
      let { payload } = await call(sessionId)
      if (payload?.error && sessionId && /session|initialized/i.test(String(payload.error.message ?? ''))) {
        this.mcpSessions.delete(service.endpoint)
        sessionId = await this.ensureSession(service.endpoint, service.headers).catch(() => undefined)
        ;({ payload } = await call(sessionId))
      }
      if (payload?.error) {
        return { ok: false, error: `MCP 服务返回错误：${payload.error.message ?? JSON.stringify(payload.error).slice(0, 200)}` }
      }
      const result = payload?.result
      if (result?.isError) {
        return { ok: false, error: 'MCP 工具执行返回错误（isError=true）' }
      }
      return { ok: true, result: result?.content ?? result ?? null, tokens: result?.usage?.totalTokens ?? 0 }
    } catch (error) {
      const message = error instanceof Error ? (error.name === 'AbortError' ? `MCP 服务调用超时（${REAL_TRANSPORT_TIMEOUT_MS}ms）` : error.message) : String(error)
      return { ok: false, error: message }
    }
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
      exec: service.exec,
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
    // 计量管道（v1.2 第 2 步）：real 传输调用进入 usage 事件（demo 演示流量不计费不计 SLO）
    if (service.exec === 'real') {
      try {
        this.ctx.usage.record({
          org: service.orgId,
          subject: `${caller.type}:${caller.id}`,
          principal: `org:${service.orgId}`,
          resource: `mcp:${service.slug}`,
          meters: [
            { key: 'calls', value: 1, unit: 'call' },
            ...(record.tokens > 0 ? [{ key: 'tokens', value: record.tokens, unit: 'token' }] : []),
          ],
          idempotency_key: `mcp:${record.id}`,
        })
      } catch (error) {
        this.ctx.logger('mcp').warn('usage 计量登记失败', error)
      }
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
// 传输层辅助（real = 真实 HTTP；demo = 确定性伪随机，仅演示）
// ---------------------------------------------------------------------------

/** real 调用超时（ms）。 */
const REAL_TRANSPORT_TIMEOUT_MS = 10_000
/** real 探活超时（ms）。 */
const REAL_PROBE_TIMEOUT_MS = 5_000
/** 远端 MCP 会话缓存时长（ms）：到期或服务端报会话失效时重新握手。 */
const MCP_SESSION_TTL_MS = 5 * 60_000

function probeLatency(service: McpServiceRecord): number {
  // demo 探活确定性健康：失败/降级路径由 real 探活（真实 HTTP）呈现，不伪造波动。
  return 40 + (Number.parseInt(sha256Hex(service.id).slice(0, 4), 16) % 360)
}

function simulateLatency(service: McpServiceRecord, tool: string): number {
  return 30 + (Number.parseInt(sha256Hex(`${service.slug}:${tool}`).slice(0, 4), 16) % 220)
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
export const inject = ['opsStorage', 'platformBus', 'iam', 'audit', 'usage']

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
